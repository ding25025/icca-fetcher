#!/usr/bin/env node
'use strict';

/**
 * 神經評估抓取工具（每 5 分鐘撈有異動的病歷紀錄）
 * -------------------------------------------------
 * 跟 vitals.js 是姊妹功能，但走的是「病歷紀錄」而非「儀器資料」，管線完全不同：
 *
 *   1. primary（CISPrimaryDB）：跑 sql/neuro-interventions.sql，撈出神經評估項目的
 *      interventionId + terseLabel（昏迷指數、瞳孔、肌力…）。等同 vitals 的 --discover。
 *   2. primary：跑 sql/neuro-encounters.sql，列出目前在床病人的 ptEncounterId，以及
 *      每個病人的病歷資料實際落在哪個 charting 資料庫（HostDb 的 dbSqlInstance / dbName），
 *      順便帶病歷號、床號。
 *   3. 依 (dbSqlInstance, dbName) 分組，每個 CISChartingDBxxxx 連一次，查
 *      dbo.PtIntervention：interventionId 在清單內、ptEncounterId 在該組內、
 *      且 storeTime 落在時間窗內（有異動）。
 *   4. 同一條連線再跑 sql/orders.sql，撈鎮靜／止痛／肌肉鬆弛／升壓藥物的醫囑紀錄
 *      （StdOrderRequest → PtDescriptor → PtIntervention）。這段不看第 1 段的
 *      interventionId 清單，改用藥名比對，terseLabel 取 StdOrderRequest.terseForm。
 *      沒有開關，跟第 3 段一樣一定會撈。醫囑失敗不會拖垮第 3 段：那一組仍然算
 *      成功、病歷紀錄照常輸出，只多印一行警告並記進 summary 的 orderError。
 *   5. 合併 → 併 terseLabel → 時間換算 +8 → 依病人收成一筆（病歷號 + 床號 + records[]）
 *      → 輸出單一 JSON 陣列 neuro_{ts}.json（依床號排序）。設定檔有 "sink" 區塊時
 *      改成直接寫進中介資料庫（一筆紀錄一列），不落檔——見 sink.js。
 *
 * 關鍵差異：
 *   - 病歷資料不是環狀表，是照 HostDb 分片到多個 CISChartingDB。定位靠 HostDb，不掃表。
 *   - 對應鑰匙是 ptEncounterId（病人主鍵），不是床號。
 *   - 「有異動」用 storeTime（寫入時間）落在時間窗內，時間一律用 DB 端 GETUTCDATE()。
 *     跟 vitals 一樣每 5 分鐘一輪、窗開 6 分鐘，**有新資料才寫、沒有就不寫**。
 *     護理師事後補填或修改的紀錄 storeTime 會變新，所以照樣撈得到。
 *
 * charting 分片連線沿用 primary 的帳密與 options，只換 server=dbSqlInstance、
 * database=dbName（dbSqlInstance 帶 \ 具名執行個體時自動拆成 instanceName）。
 * 某個分片連不上只警告並略過那一組，其餘照常輸出。
 *
 * 設定沿用 databases.config.json；要調整就加一個 "neuro" 區塊覆寫（見 DEFAULTS），
 * 不影響 index.js / vitals.js。
 *
 * 用法：
 *   node neuro.js                 使用 databases.config.json，撈近 6 分鐘
 *   node neuro.js --window 120    改抓近 120 分鐘
 *   node neuro.js --ids-file <檔> 用自己的 interventionId 清單，不跑 Query 1
 *   node neuro.js --utc           時間保留 UTC（預設已 +8）
 *   node neuro.js --dry-run       只檢查設定，不連資料庫
 *   node neuro.js --pretty
 */

const fs = require('fs');
const path = require('path');
const sql = require('mssql');
const ring = require('./ring.js');
// vitals.js 匯出的純函式直接沿用，行為與 vitals 一致
const V = require('./vitals.js');
const sink = require('./sink.js'); // 撈完直接寫進中介資料庫（設定檔的 "sink" 區塊）
const state = require('./state.js'); // 記錄最後一次成功寫入的時間

// ---------- 命令列參數 ----------
function parseArgs(argv) {
  const a = { config: 'databases.config.json', out: null, pretty: false, window: null };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--config' || t === '-c') a.config = argv[++i];
    else if (t === '--out' || t === '-o') a.out = argv[++i];
    else if (t === '--pretty' || t === '-p') a.pretty = true;
    else if (t === '--window' || t === '-w') a.window = Number(argv[++i]);
    else if (t === '--ids-file' || t === '--ids') a.idsFile = argv[++i];
    else if (t === '--primary-db') a.primaryDb = argv[++i];
    else if (t === '--utc') a.utc = true;
    else if (t === '--dry-run' || t === '-n') a.dryRun = true;
    else if (t === '--to-db') a.toDb = true;
    else if (t === '--no-db') a.noDb = true;
    else if (t === '--with-summary') a.withSummary = true;
    else if (t === '--help' || t === '-h') a.help = true;
  }
  return a;
}

function printHelp() {
  console.log(`
神經評估抓取工具（每 5 分鐘撈有異動的病歷紀錄）

  node neuro.js [選項]

選項：
  -c, --config <檔案>   設定檔（預設 databases.config.json）
  -o, --out <檔案>      輸出 JSON 檔（預設 neuro_{ts}.json，到分鐘）
                        檔名裡寫 {ts} 會換成時間戳，例如 neuro_{ts}.json
  -w, --window <分鐘>   撈 storeTime 落在最近幾分鐘的（預設 6＝5 分鐘一輪多留 1 分鐘）
      --ids-file <檔>   用自己的 interventionId 清單（GUID，逗號/換行分隔，可帶標籤），
                        指定後就不跑 sql/neuro-interventions.sql
      --primary-db <名> primary 要連哪個資料庫（預設讀 SQL 裡的 USE，再試 CISPrimaryDB）
      --utc             時間保留 DB 原始的 UTC 值（預設已換算成本地 +8）
      --to-db           撈完直接寫進中介資料庫（設定檔的 sink 區塊），不落 JSON 檔
      --no-db           這一次不要寫資料庫（sink.enabled 為 true 時用來臨時關掉）
      --with-summary    輸出包成 { summary, rows }（預設是單純的資料陣列）
  -n, --dry-run         只檢查設定，不連資料庫
  -p, --pretty          美化縮排輸出
  -h, --help            顯示說明

設定：
  連線沿用 databases.config.json 的 databases[]。名稱不符合 CDSUnvalidatedData* 的
  當成 primary（查 interventionId 與在床病人用）。charting 分片的連線由 HostDb 動態
  給出（dbSqlInstance / dbName），沿用 primary 的帳密。其它項目都有預設值，要改就在
  databases.config.json 加一個 "neuro" 區塊。
`);
}

/** 神經評估相關的預設值。要調整就在 databases.config.json 加 "neuro" 區塊覆寫。 */
const DEFAULTS = {
  output: 'neuro_{ts}.json',
  queryTimeoutMs: 60000,
  lockTimeoutMs: 3000,
  // 「有異動」的時間窗（分鐘）；storeTime >= 近 windowMinutes 分鐘。
  // 預設 6：跟 vitals 一樣每 5 分鐘跑一輪，窗比間隔多 1 分鐘（重疊的部分寫入時會被擋掉，
  // 漏掉的下一輪不會自己補回來，兩種風險不對等）。有新資料才寫，沒有就不寫。
  windowMinutes: 6,
  timesInUtc: false,
  displayTimezoneOffsetHours: 8,
  interventionSqlFile: 'sql/neuro-interventions.sql',
  encountersSqlFile: 'sql/neuro-encounters.sql',
  // 藥物醫囑（鎮靜／止痛／肌肉鬆弛／升壓）。沒有開關，每一輪都跟表單紀錄一起撈。
  orderSqlFile: 'sql/orders.sql',
  // primary 連哪個資料庫：沒指定、SQL 也沒寫 USE 時，最後試這些常見名稱。
  patientDatabaseFallbacks: ['CISPrimaryDB'],
  // 病歷紀錄表（照 HostDb 分片，各 charting DB 都有這張）
  table: 'PtIntervention',
  // 一次 IN 幾個 ptEncounterId（避免超過 SQL 參數上限；interventionId + 這個要 < 2100）
  encounterChunk: 1000,
  // 用來從 databases[] 認出 primary（非 CDS 的就是 primary）
  cdsDatabasePattern: '^CDSUnvalidatedData',
  // primary 名字；沒寫就用 databases[] 裡第一個非 CDS 的
  primary: null,
};

function mergeSettings(cfg) {
  return { ...DEFAULTS, ...(cfg.neuro || {}) };
}

// ---------- 連線 ----------
// 連線池的建立 / 釋放沿用 vitals.js 那一份（"env:" 密碼、CLI 用完就關、
// server.js 呼叫 keepPools() 後改成重複使用），兩支工具共用同一組池。
const connect = V.connect;
const release = V.release;

function safeIdent(name, label) {
  if (!/^[A-Za-z0-9_]+$/.test(String(name))) throw new Error(`${label} 含有不允許的字元：${name}`);
  return name;
}

/**
 * 從 primary 連線範本組出某個 charting 分片的連線。
 * 帳密、options 沿用 primary，只換 server / database。
 * dbSqlInstance 帶反斜線（HOST\INSTANCE）時拆成 server + options.instanceName，
 * 並拿掉 port（具名執行個體由 SQL Browser 解析）。
 */
function buildChartingConn(template, dbSqlInstance, dbName) {
  const conn = { ...template, database: dbName };
  const s = String(dbSqlInstance || '').trim();
  if (s.includes('\\')) {
    const [host, instance] = s.split('\\');
    conn.server = host;
    conn.options = { ...(template.options || {}), instanceName: instance };
    delete conn.port;
  } else {
    conn.server = s;
  }
  return conn;
}

// ---------- interventionId 清單（terseLabel 對照） ----------

const GUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
const upper = (g) => String(g).trim().toUpperCase();

/** 把 Query 1 回來的列變成 { ids:[原字串GUID], labels:{大寫GUID: terseLabel} } */
function indexInterventions(rows) {
  const out = { ids: [], labels: {} };
  for (const r of rows || []) {
    const id = r.interventionId;
    if (!id) continue;
    const key = upper(id);
    if (!out.labels[key]) {
      out.ids.push(String(id).trim());
      out.labels[key] = r.terseLabel != null ? String(r.terseLabel).trim() : null;
    }
  }
  return out;
}

/**
 * --ids-file：吃自己撈出來的 interventionId。每行一個 GUID，後面可接標籤，
 * 例如「C7A13D3D-... , 昏迷指數」或純 GUID。逗號 / Tab / 直線 / 空白都當分隔。
 */
function loadIdsFile(file) {
  const abs = path.resolve(process.cwd(), file);
  if (!fs.existsSync(abs)) throw new Error(`找不到 interventionId 檔：${abs}`);
  const out = { ids: [], labels: {} };
  const text = fs.readFileSync(abs, 'utf8').replace(/^﻿/, '');
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l.startsWith('--') || l.startsWith('#')) continue;
    const m = l.match(GUID_RE);
    if (!m) continue;
    const id = m[0];
    const key = upper(id);
    if (out.labels[key] !== undefined) continue;
    // GUID 以外、去掉分隔字元後剩下的當標籤
    const label = l.replace(id, '').replace(/[,\t|]+/g, ' ').trim() || null;
    out.ids.push(id);
    out.labels[key] = label;
  }
  if (!out.ids.length) throw new Error(`${abs} 裡沒有解析到任何 interventionId（GUID）`);
  return out;
}

// ---------- 在床病人 + HostDb 分組 ----------
/**
 * 把 neuro-encounters.sql 回來的列整理成：
 *   groups   Map<instance\x00db, { dbSqlInstance, dbName, encounterIds:[] }>
 *   patients Map<大寫ptEncounterId, { lifetimeNumber, bed }>
 */
function indexEncounters(rows) {
  const groups = new Map();
  const patients = new Map();
  for (const r of rows || []) {
    const enc = r.ptEncounterId;
    if (!enc) continue;
    const encKey = upper(enc);
    if (!patients.has(encKey)) {
      patients.set(encKey, {
        lifetimeNumber: r.lifetimeNumber != null ? r.lifetimeNumber : null,
        bed: r.bed != null ? r.bed : null,
      });
    }
    const dbSqlInstance = r.dbSqlInstance != null ? String(r.dbSqlInstance).trim() : '';
    const dbName = r.dbName != null ? String(r.dbName).trim() : '';
    if (!dbName) continue; // 沒有 HostDb 就無從連線，略過（理論上不會發生）
    const gk = `${dbSqlInstance} ${dbName}`;
    let g = groups.get(gk);
    if (!g) {
      g = { dbSqlInstance, dbName, encounterIds: [], seen: new Set() };
      groups.set(gk, g);
    }
    if (!g.seen.has(encKey)) {
      g.seen.add(encKey);
      g.encounterIds.push(String(enc).trim());
    }
  }
  return { groups: [...groups.values()], patients };
}

// ---------- 從某個 charting 分片撈 PtIntervention ----------
/**
 * 兩段 charting 查詢共用的批次前綴：唯讀、死結時先讓別人、鎖等待上限照設定走。
 * 撈的是正式機的病歷表，寧可自己逾時退開也不要卡住臨床端。
 */
function batchPrelude(cfg) {
  return `SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT ${Number((cfg || {}).lockTimeoutMs) || 3000};
SET NOCOUNT ON;`;
}

function buildNeuroQuery(interventionIds, encounterIds, cfg) {
  const table = safeIdent(cfg.table || 'PtIntervention', 'table');
  const iParams = interventionIds.map((_, i) => `@i${i}`).join(', ');
  const eParams = encounterIds.map((_, i) => `@e${i}`).join(', ');
  return `
${batchPrelude(cfg)}

SELECT
     ptEncounterId
    ,interventionId
    ,terseForm
    ,verboseForm
    ,storeTime
    ,chartTime
    ,isDeleted
FROM dbo.[${table}] WITH (NOLOCK)
WHERE storeTime >= DATEADD(MINUTE, -@win, GETUTCDATE())
  AND interventionId IN (${iParams})
  AND ptEncounterId  IN (${eParams})
ORDER BY ptEncounterId, storeTime DESC`;
}

/**
 * ptEncounterId 可能整病房一大串，超過 SQL 參數上限會炸，所以切塊查再合併。
 * interventionId 每塊都帶（數量少），win 用 DB 端 GETUTCDATE() 算。
 */
async function fetchNeuro(pool, { interventionIds, encounterIds, windowMinutes, settings }) {
  const chunk = Number(settings.encounterChunk) || 1000;
  const out = [];
  for (let off = 0; off < encounterIds.length; off += chunk) {
    const enc = encounterIds.slice(off, off + chunk);
    const q = buildNeuroQuery(interventionIds, enc, settings);
    const req = pool.request().input('win', sql.Int, windowMinutes);
    interventionIds.forEach((v, i) => req.input(`i${i}`, sql.UniqueIdentifier, v));
    enc.forEach((v, i) => req.input(`e${i}`, sql.UniqueIdentifier, v));
    const r = await req.query(q);
    out.push(...(r.recordset || []));
  }
  return out;
}

// ---------- 時間換算 ----------
const TIME_FIELDS = ['storeTime', 'chartTime'];

/** ICCA 存 UTC，就地加時差並格式化成 "2026-07-27 11:24:00"。要保留 UTC 就 --utc。 */
function shiftTimes(row, offsetHours) {
  const out = { ...row };
  for (const f of TIME_FIELDS) {
    if (out[f] == null) continue;
    out[f] = ring.fmtDb(new Date(new Date(out[f]).getTime() + offsetHours * 3600e3));
  }
  return out;
}

// ---------- 從同一個 charting 分片撈藥物醫囑 ----------
/**
 * sql/orders.sql 裡的這個標記會被換成該組的 ptEncounterId 參數（@oe0, @oe1, …）。
 * 標記在 prepare() 讀檔時就檢查，不是等到連上分片才發現——不然一個字打錯，
 * 所有分片會在同一秒一起炸。
 */
const ENCOUNTER_IDS_MARKER = '/*__ENCOUNTER_IDS__*/';

function assertOrderSql(orderSql, where) {
  if (!String(orderSql).includes(ENCOUNTER_IDS_MARKER)) {
    throw new Error(
      `${where} 裡找不到 ${ENCOUNTER_IDS_MARKER}：` +
        `neuro.js 要靠這個標記把該組的 ptEncounterId 塞進 IN (...)`
    );
  }
}

function buildOrderQuery(orderSql, encounterIds, cfg) {
  assertOrderSql(orderSql, 'order SQL');
  const params = encounterIds.map((_, i) => `@oe${i}`).join(', ');
  // split/join 而不是 replace：replace 只換第一個，標記寫了兩次會留下沒展開的那個
  const body = V.stripBatchDirectives(orderSql).split(ENCOUNTER_IDS_MARKER).join(params);
  return `${batchPrelude(cfg)}\n\n${body}`;
}

async function fetchOrders(pool, { orderSql, encounterIds, windowMinutes, settings }) {
  const chunk = Number(settings.encounterChunk) || 1000;
  const out = [];
  for (let off = 0; off < encounterIds.length; off += chunk) {
    const enc = encounterIds.slice(off, off + chunk);
    const req = pool.request().input('win', sql.Int, windowMinutes);
    enc.forEach((v, i) => req.input(`oe${i}`, sql.UniqueIdentifier, v));
    const r = await req.query(buildOrderQuery(orderSql, enc, settings));
    out.push(...(r.recordset || []));
  }
  return out;
}

// ---------- primary 階段：解析要連的資料庫並跑 Query 1 / Query 2 ----------
/**
 * interventionId 清單與在床病人都在 primary。依候選資料庫依序試，第一個兩段都成功的採用。
 * 回傳 { database, interventions, encounters }。interventions 在 --ids-file 時為 null。
 */
async function runPrimary(primary, candidates, { intSql, encSql, wantInterventions }, timeout) {
  const errors = [];
  for (const database of candidates) {
    let pool;
    try {
      pool = await connect({ ...primary, database }, timeout);
      const encRows = (await pool.request().query(V.stripBatchDirectives(encSql))).recordset || [];
      let interventions = null;
      if (wantInterventions) {
        const intRows = (await pool.request().query(V.stripBatchDirectives(intSql))).recordset || [];
        interventions = indexInterventions(intRows);
      }
      return { database, encounters: indexEncounters(encRows), interventions, errors };
    } catch (e) {
      errors.push({ database, message: e.message });
    } finally {
      await release(pool);
    }
  }
  return { database: null, errors };
}

// ---------- 單一 charting 分片 ----------
async function runGroup(group, { interventionIds, orderSql, windowMinutes, template, settings, timeout }) {
  const { dbSqlInstance, dbName, encounterIds } = group;
  const conn = buildChartingConn(template, dbSqlInstance, dbName);
  const pool = await connect(conn, timeout);
  try {
    const rows = await fetchNeuro(pool, { interventionIds, encounterIds, windowMinutes, settings });
    // 醫囑撈失敗不能把整組拖下水：上面那批表單紀錄已經在手上了，跟著丟掉等於
    // 這個分片這一輪什麼都沒寫。錯誤往上帶，由 collect 印出來、記進 summary。
    let orderError = null;
    try {
      rows.push(...(await fetchOrders(pool, { orderSql, encounterIds, windowMinutes, settings })));
    } catch (e) {
      orderError = e && e.message ? e.message : String(e);
    }
    return { dbSqlInstance, dbName, encounters: encounterIds.length, count: rows.length, rows, orderError };
  } finally {
    await release(pool);
  }
}

// ---------- 撈一輪（命令列與 server.js 共用）----------

/**
 * 把設定攤開：連線、SQL 檔、時間窗都在這裡解析完，連一次線都還沒連。
 * --dry-run 與實際執行看到的是同一份結果，不會有「檢查過了但跑起來不一樣」。
 */
function prepare(args) {
  const cfg = V.loadConfig(args.config);
  const settings = mergeSettings(cfg);
  const offset = settings.displayTimezoneOffsetHours != null ? settings.displayTimezoneOffsetHours : 8;
  const registry = V.buildConnectionRegistry(cfg);
  const windowMinutes = args.window || settings.windowMinutes || DEFAULTS.windowMinutes;
  const timeout = settings.queryTimeoutMs || 60000;

  // primary：名稱不符合 CDS pattern 的當 primary
  const cdsRe = new RegExp(settings.cdsDatabasePattern, 'i');
  const primaries = (cfg.databases || []).filter(
    (d) => d && d.name && d.connection && !cdsRe.test(String(d.connection.database || ''))
  );
  const primaryRef = settings.primary || (primaries[0] && primaries[0].name);
  if (!primaryRef) throw new Error('找不到可用的 primary（databases[] 裡沒有非 CDS 的資料庫，或 neuro.primary 沒設）');
  const primary = V.resolveConn(primaryRef, registry, 'primary', 'primary');

  // SQL 檔
  const intAbs = path.resolve(process.cwd(), settings.interventionSqlFile);
  const encAbs = path.resolve(process.cwd(), settings.encountersSqlFile);
  const orderAbs = path.resolve(process.cwd(), settings.orderSqlFile);
  if (!fs.existsSync(encAbs)) throw new Error(`找不到在床病人 SQL：${encAbs}`);
  const encSql = fs.readFileSync(encAbs, 'utf8');

  // interventionId 來源：--ids-file 優先，否則跑 Query 1
  let idsFromFile = null;
  if (args.idsFile) {
    idsFromFile = loadIdsFile(args.idsFile);
  } else if (!fs.existsSync(intAbs)) {
    throw new Error(`找不到 interventionId SQL：${intAbs}（或用 --ids-file 指定清單）`);
  }
  const intSql = args.idsFile ? '' : fs.readFileSync(intAbs, 'utf8');
  if (!fs.existsSync(orderAbs)) throw new Error(`找不到藥物醫囑 SQL：${orderAbs}`);
  const orderSql = fs.readFileSync(orderAbs, 'utf8');
  assertOrderSql(orderSql, orderAbs);

  // primary 連哪個資料庫：沿用 vitals 的候選邏輯（USE > 設定 > primary.database > fallback）
  const candidates = V.patientDatabaseCandidates(encSql, primary, {}, settings, args.primaryDb);

  return { settings, offset, windowMinutes, timeout, primaryRef, primary, intSql, encSql, orderSql, idsFromFile, candidates };
}

/**
 * 撈一輪並回傳結果。不讀命令列、不寫檔，所以 server.js 可以直接呼叫。
 * 回傳 { settings, offset, summary, rows, total, groups, failures }，
 * rows 是一位病人一筆（{ lifetimeNumber, bed, records: [...] }），依床號自然排序。
 */
async function collect(opts = {}, prep = null) {
  const args = { config: 'databases.config.json', ...opts };
  const p = prep || prepare(args);
  const { settings, offset, windowMinutes, timeout, primaryRef, primary, intSql, encSql, orderSql, candidates } = p;

  // 1+2. primary：interventionId 清單 + 在床病人 + HostDb 分組
  console.log(`連 primary（${primaryRef}）查 interventionId 與在床病人...`);
  const pr = await runPrimary(
    primary,
    candidates,
    { intSql, encSql, wantInterventions: !args.idsFile },
    timeout
  );
  if (!pr.database) {
    const err = new Error(
      `primary 查詢失敗，候選資料庫都不通：` +
        pr.errors.map((e) => `\n    ${e.database}：${e.message}`).join('')
    );
    err.hint =
      '若錯誤是「無效的物件名稱 dbo.PtLocationStay」，表示連錯資料庫，\n' +
      '  在 SQL 檔開頭寫 USE <資料庫> 或用 --primary-db <資料庫>。';
    throw err;
  }

  const idsFromFile = p.idsFromFile;

  const interventions = args.idsFile ? idsFromFile : pr.interventions;
  const interventionIds = interventions.ids;
  if (!interventionIds.length) throw new Error('沒有任何 interventionId 可撈（Query 1 沒回結果，或 --ids-file 是空的）');

  const { groups, patients } = pr.encounters;
  console.log(
    `  [primary ${primaryRef}→${pr.database}] interventionId ${interventionIds.length} 個，` +
      `在床病人 ${patients.size} 人，分布在 ${groups.length} 個 charting 資料庫`
  );
  if (!groups.length) {
    console.warn('  ⚠ 目前沒有在床病人，輸出會是空陣列');
  }

  // 3. 各 charting 分片平行撈（沿用 primary 帳密，只換 server/database）
  const settled = await Promise.allSettled(
    groups.map((g) =>
      runGroup(g, { interventionIds, orderSql, windowMinutes, template: primary, settings, timeout })
    )
  );

  // 4. 合併 + 併 terseLabel / 病歷號 + 時區換算
  const labelOf = (id) => interventions.labels[upper(id)] || null;
  const useUtc = args.utc || settings.timesInUtc;
  // 同一個病人（ptEncounterId）的紀錄收在一起：{ lifetimeNumber, bed, records:[] }
  const byPatient = new Map();
  const summary = [];
  let failures = 0;
  let total = 0;

  settled.forEach((s, i) => {
    const g = groups[i];
    if (s.status === 'fulfilled') {
      const { rows, count, encounters, orderError } = s.value;
      total += rows.length;
      for (const r of rows) {
        const encKey = upper(r.ptEncounterId);
        const pt = patients.get(encKey) || {};
        let p = byPatient.get(encKey);
        if (!p) {
          p = {
            lifetimeNumber: pt.lifetimeNumber != null ? pt.lifetimeNumber : null, // 病歷號
            bed: pt.bed != null ? pt.bed : null,
            records: [],
          };
          // 寫進 sink 時要一個穩定的病人鑰匙：病歷號可能沒填、床號會因轉床而變，
          // 只有 ptEncounterId 從頭到尾不動。掛成不可列舉的屬性，JSON.stringify
          // 看不到它，輸出格式跟以前一模一樣。
          Object.defineProperty(p, '_encounterId', { value: encKey, enumerable: false });
          byPatient.set(encKey, p);
        }
        const rec = {
          interventionId: r.interventionId,
          terseLabel: r.terseLabel != null ? String(r.terseLabel).trim() : labelOf(r.interventionId),
          terseForm: r.terseForm,
          verboseForm: r.verboseForm,
          storeTime: r.storeTime,
          chartTime: r.chartTime,
          // 作廢註記：ICCA 那筆被刪除／作廢時是 1。**不在這裡過濾掉**——
          // 下游要看得到「這筆沒了」這個變化，過濾是呈現時才做的事（規格 §4）。
          isDeleted: r.isDeleted ? 1 : 0,
        };
        p.records.push(useUtc ? rec : shiftTimes(rec, offset));
      }
      summary.push({ db: g.dbName, instance: g.dbSqlInstance, ok: true, encounters, count, orderError });
      console.log(`  ✓ ${g.dbName}：${count} 筆（${encounters} 位病人）`);
      // 分片本身算成功（表單紀錄有撈到），但這一輪的醫囑是空的，要看得見
      if (orderError) console.warn(`    ⚠ ${g.dbName} 藥物醫囑沒撈到：${orderError}`);
    } else {
      failures++;
      const msg = s.reason && s.reason.message ? s.reason.message : String(s.reason);
      summary.push({ db: g.dbName, instance: g.dbSqlInstance, ok: false, error: msg });
      console.error(`  ✗ ${g.dbName}（${g.dbSqlInstance}）：${msg}`);
    }
  });

  // 病人依床號排序（沒床的排最後），跨分片合併後才看得出病房順序。
  // 用 vitals.js 那支自然排序，ICU-10 才不會排到 ICU-2 前面，兩支輸出順序也一致。
  const merged = [...byPatient.values()].sort((a, b) => V.compareBeds(a.bed, b.bed));

  return { settings, offset, summary, rows: merged, total, groups: groups.length, failures, primaryDatabase: pr.database };
}

// ---------- 主流程 ----------
async function main() {
  const args = parseArgs(process.argv);
  if (args.help) return printHelp();

  const p = prepare(args);
  const outFile = V.resolveOutputName(args.out || p.settings.output, p.offset);

  // 中介資料庫（sink）：有設定就直接寫進去，不再落 JSON 檔
  const sinkSettings = sink.mergeSettings(V.loadConfig(args.config));
  const toDb = sink.wanted(sinkSettings, args);
  if (toDb) sink.assertConfigured(sinkSettings); // 連線沒設好就別讓它撈完一輪才發現
  const wantFile = !toDb || !!args.out || sinkSettings.alsoWriteFile === true;

  // --dry-run：攤開設定，不連線
  if (args.dryRun) {
    console.log(`\n[dry-run] 不會連線，只檢查設定\n`);
    console.log(`primary：${p.primaryRef}（${p.primary.server}:${p.primary.port || 1433}）`);
    console.log(`  候選資料庫：${p.candidates.join(' → ')}`);
    console.log(`interventionId 來源：${args.idsFile ? args.idsFile + `（${p.idsFromFile.ids.length} 個）` : p.settings.interventionSqlFile + '（連線時跑 Query 1）'}`);
    console.log(`在床病人 SQL：${p.settings.encountersSqlFile}`);
    console.log(`病歷紀錄表：dbo.${p.settings.table}（依 HostDb 分片，連線時才知道有幾個）`);
    console.log(`藥物醫囑 SQL：${p.settings.orderSqlFile}（每輪必撈，跟病歷紀錄同一條連線）`);
    console.log(`時間窗：storeTime 近 ${p.windowMinutes} 分鐘（用 DB 端 GETUTCDATE()）`);
    if (toDb) {
      console.log(`寫入資料庫：${sink.describeTarget(sinkSettings)}`);
      console.log(`狀態檔：${state.filePath()}`);
      console.log(`        ${state.describe('neuro', state.report(['neuro']).neuro)}`);
    }
    console.log(`輸出：${wantFile ? path.resolve(process.cwd(), outFile) : '不落檔（資料直接寫進上面那個資料庫）'}`);
    console.log(`\n設定檢查完成。拿掉 --dry-run 即會實際連線。`);
    return;
  }

  const started = Date.now();
  const res = await collect(args, p);

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log('----------------------------------------');
  console.log(`合併總筆數：${res.total} 筆，${res.rows.length} 位病人`);
  console.log(`成功：${res.groups - res.failures} / ${res.groups} 個 charting 資料庫，耗時 ${secs}s`);

  // 分片全滅時不要寫：那是 0 筆，寫進去只會讓下游把故障看成「這一輪沒有異動」
  if (toDb && !(res.groups && res.failures === res.groups)) {
    const stats = await sink.writeNeuro(res.rows, sinkSettings);
    console.log(`已寫入 ${sink.describe(stats)}`);
    // 記下「最後一次成功寫入」，之後要補撈才知道從幾點開始（見 state.js）
    state.recordSuccess('neuro', { startedAtMs: started, stats });
  }

  if (wantFile) {
    const withSummary = args.withSummary || res.settings.includeSummary === true;
    const payload = withSummary ? { summary: res.summary, rows: res.rows } : res.rows;
    const json = args.pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
    const outAbs = path.resolve(process.cwd(), outFile);
    fs.writeFileSync(outAbs, json, 'utf8');
    console.log(`已輸出：${outAbs}`);
  }

  if (res.groups && res.failures === res.groups) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`\n發生錯誤：${err.message}`);
    if (err.hint) console.error(`  ${err.hint}`);
    process.exitCode = 1;
  });
}

module.exports = {
  __main: main,
  collect, // server.js 用：撈一輪回傳結果，不寫檔
  prepare,
  indexInterventions,
  loadIdsFile,
  indexEncounters,
  buildChartingConn,
  buildNeuroQuery,
  fetchNeuro,
  batchPrelude,
  buildOrderQuery,
  fetchOrders,
  shiftTimes,
  mergeSettings,
  DEFAULTS,
};
