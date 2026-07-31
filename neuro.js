#!/usr/bin/env node
'use strict';

/**
 * 神經評估抓取工具（每小時撈有異動的病歷紀錄）
 * -------------------------------------------------
 * 跟 vitals.js 是姊妹功能，但走的是「病歷紀錄」而非「儀器資料」，管線完全不同：
 *
 *   1. primary（CISPrimaryDB）：跑 sql/neuro-interventions.sql，撈出神經評估項目的
 *      interventionId + terseLabel（昏迷指數、瞳孔、肌力…）。等同 vitals 的 --discover。
 *   2. primary：跑 sql/neuro-encounters.sql，列出目前在床病人的 ptEncounterId，以及
 *      每個病人的病歷資料實際落在哪個 charting 資料庫（HostDb 的 dbSqlInstance / dbName），
 *      順便帶病歷號、住院帳號、床號。
 *   3. 依 (dbSqlInstance, dbName) 分組，每個 CISChartingDBxxxx 連一次，查
 *      dbo.PtIntervention：interventionId 在清單內、ptEncounterId 在該組內、
 *      且 storeTime 落在近一小時（有異動）。
 *   4. 合併 → 併 terseLabel → 時間換算 +8 → 依病人收成一筆（病歷號 + 床號 + records[]）
 *      → 輸出單一 JSON 陣列 neuro_{ts}.json（依床號排序）。
 *
 * 關鍵差異：
 *   - 病歷資料不是環狀表，是照 HostDb 分片到多個 CISChartingDB。定位靠 HostDb，不掃表。
 *   - 對應鑰匙是 ptEncounterId（病人主鍵），不是床號。
 *   - 「有異動」用 storeTime（寫入時間）＞ 近一小時，時間一律用 DB 端 GETUTCDATE()。
 *
 * charting 分片連線沿用 primary 的帳密與 options，只換 server=dbSqlInstance、
 * database=dbName（dbSqlInstance 帶 \ 具名執行個體時自動拆成 instanceName）。
 * 某個分片連不上只警告並略過那一組，其餘照常輸出。
 *
 * 設定沿用 databases.config.json；要調整就加一個 "neuro" 區塊覆寫（見 DEFAULTS），
 * 不影響 index.js / vitals.js。
 *
 * 用法：
 *   node neuro.js                 使用 databases.config.json，撈近 60 分鐘
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
    else if (t === '--with-summary') a.withSummary = true;
    else if (t === '--help' || t === '-h') a.help = true;
  }
  return a;
}

function printHelp() {
  console.log(`
神經評估抓取工具（每小時撈有異動的病歷紀錄）

  node neuro.js [選項]

選項：
  -c, --config <檔案>   設定檔（預設 databases.config.json）
  -o, --out <檔案>      輸出 JSON 檔（預設 neuro_{ts}.json，到分鐘）
                        檔名裡寫 {ts} 會換成時間戳，例如 neuro_{ts}.json
  -w, --window <分鐘>   撈 storeTime 落在最近幾分鐘的（預設 60，即近一小時）
      --ids-file <檔>   用自己的 interventionId 清單（GUID，逗號/換行分隔，可帶標籤），
                        指定後就不跑 sql/neuro-interventions.sql
      --primary-db <名> primary 要連哪個資料庫（預設讀 SQL 裡的 USE，再試 CISPrimaryDB）
      --utc             時間保留 DB 原始的 UTC 值（預設已換算成本地 +8）
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
  // 「有異動」的時間窗（分鐘）；storeTime >= 近 windowMinutes 分鐘。預設 60＝近一小時。
  windowMinutes: 60,
  timesInUtc: false,
  displayTimezoneOffsetHours: 8,
  interventionSqlFile: 'sql/neuro-interventions.sql',
  encountersSqlFile: 'sql/neuro-encounters.sql',
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
function resolveSecret(value) {
  if (typeof value === 'string' && value.startsWith('env:')) {
    const key = value.slice(4);
    const v = process.env[key];
    if (v === undefined) throw new Error(`環境變數 ${key} 未設定`);
    return v;
  }
  return value;
}

async function connect(connection, queryTimeoutMs) {
  const conn = { ...connection };
  if (conn.password) conn.password = resolveSecret(conn.password);
  if (conn.user) conn.user = resolveSecret(conn.user);
  if (queryTimeoutMs) conn.requestTimeout = queryTimeoutMs;
  const pool = new sql.ConnectionPool(conn);
  await pool.connect();
  return pool;
}

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
function buildNeuroQuery(interventionIds, encounterIds, cfg) {
  const table = safeIdent(cfg.table || 'PtIntervention', 'table');
  const iParams = interventionIds.map((_, i) => `@i${i}`).join(', ');
  const eParams = encounterIds.map((_, i) => `@e${i}`).join(', ');
  return `
SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT ${Number(cfg.lockTimeoutMs) || 3000};
SET NOCOUNT ON;

SELECT
     ptEncounterId
    ,interventionId
    ,terseForm
    ,storeTime
    ,addTime
    ,chartTime
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
const TIME_FIELDS = ['storeTime', 'addTime', 'chartTime'];

/** ICCA 存 UTC，就地加時差並格式化成 "2026-07-27 11:24:00"。要保留 UTC 就 --utc。 */
function shiftTimes(row, offsetHours) {
  const out = { ...row };
  for (const f of TIME_FIELDS) {
    if (out[f] == null) continue;
    out[f] = ring.fmtDb(new Date(new Date(out[f]).getTime() + offsetHours * 3600e3));
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
      if (pool) { try { await pool.close(); } catch (_) {} }
    }
  }
  return { database: null, errors };
}

// ---------- 單一 charting 分片 ----------
async function runGroup(group, { interventionIds, windowMinutes, template, settings, timeout }) {
  const { dbSqlInstance, dbName, encounterIds } = group;
  const conn = buildChartingConn(template, dbSqlInstance, dbName);
  const pool = await connect(conn, timeout);
  try {
    const rows = await fetchNeuro(pool, { interventionIds, encounterIds, windowMinutes, settings });
    return { dbSqlInstance, dbName, encounters: encounterIds.length, count: rows.length, rows };
  } finally {
    try { await pool.close(); } catch (_) {}
  }
}

// ---------- 主流程 ----------
async function main() {
  const args = parseArgs(process.argv);
  if (args.help) return printHelp();

  const cfg = V.loadConfig(args.config);
  const settings = mergeSettings(cfg);
  const offset = settings.displayTimezoneOffsetHours != null ? settings.displayTimezoneOffsetHours : 8;
  const outFile = V.resolveOutputName(args.out || settings.output, offset);
  const registry = V.buildConnectionRegistry(cfg);
  const windowMinutes = args.window || settings.windowMinutes || 60;
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

  // primary 連哪個資料庫：沿用 vitals 的候選邏輯（USE > 設定 > primary.database > fallback）
  const candidates = V.patientDatabaseCandidates(encSql, primary, {}, settings, args.primaryDb);

  // --dry-run：攤開設定，不連線
  if (args.dryRun) {
    console.log(`\n[dry-run] 不會連線，只檢查設定\n`);
    console.log(`primary：${primaryRef}（${primary.server}:${primary.port || 1433}）`);
    console.log(`  候選資料庫：${candidates.join(' → ')}`);
    console.log(`interventionId 來源：${args.idsFile ? args.idsFile + `（${idsFromFile.ids.length} 個）` : settings.interventionSqlFile + '（連線時跑 Query 1）'}`);
    console.log(`在床病人 SQL：${settings.encountersSqlFile}`);
    console.log(`病歷紀錄表：dbo.${settings.table}（依 HostDb 分片，連線時才知道有幾個）`);
    console.log(`時間窗：storeTime 近 ${windowMinutes} 分鐘（用 DB 端 GETUTCDATE()）`);
    console.log(`輸出：${path.resolve(process.cwd(), outFile)}`);
    console.log(`\n設定檢查完成。拿掉 --dry-run 即會實際連線。`);
    return;
  }

  const started = Date.now();

  // 1+2. primary：interventionId 清單 + 在床病人 + HostDb 分組
  console.log(`連 primary（${primaryRef}）查 interventionId 與在床病人...`);
  const pr = await runPrimary(
    primary,
    candidates,
    { intSql, encSql, wantInterventions: !args.idsFile },
    timeout
  );
  if (!pr.database) {
    console.error(`✗ primary 查詢失敗，候選資料庫都不通：`);
    for (const e of pr.errors) console.error(`    ${e.database}：${e.message}`);
    console.error(`  若錯誤是「無效的物件名稱 dbo.PtLocationStay」，表示連錯資料庫，`);
    console.error(`  在 SQL 檔開頭寫 USE <資料庫> 或用 --primary-db <資料庫>。`);
    process.exitCode = 1;
    return;
  }

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
      runGroup(g, { interventionIds, windowMinutes, template: primary, settings, timeout })
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
      const { rows, count, encounters } = s.value;
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
          byPatient.set(encKey, p);
        }
        const rec = {
          interventionId: r.interventionId,
          terseLabel: labelOf(r.interventionId),
          terseForm: r.terseForm,
          storeTime: r.storeTime,
          addTime: r.addTime,
          chartTime: r.chartTime,
        };
        p.records.push(useUtc ? rec : shiftTimes(rec, offset));
      }
      summary.push({ db: g.dbName, instance: g.dbSqlInstance, ok: true, encounters, count });
      console.log(`  ✓ ${g.dbName}：${count} 筆（${encounters} 位病人）`);
    } else {
      failures++;
      const msg = s.reason && s.reason.message ? s.reason.message : String(s.reason);
      summary.push({ db: g.dbName, instance: g.dbSqlInstance, ok: false, error: msg });
      console.error(`  ✗ ${g.dbName}（${g.dbSqlInstance}）：${msg}`);
    }
  });

  // 病人依床號排序（沒床的排最後），跨分片合併後才看得出病房順序
  const merged = [...byPatient.values()].sort((a, b) => {
    if (a.bed == null) return b.bed == null ? 0 : 1;
    if (b.bed == null) return -1;
    return String(a.bed).localeCompare(String(b.bed));
  });

  const withSummary = args.withSummary || settings.includeSummary === true;
  const payload = withSummary ? { summary, rows: merged } : merged;
  const json = args.pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
  const outAbs = path.resolve(process.cwd(), outFile);
  fs.writeFileSync(outAbs, json, 'utf8');

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log('----------------------------------------');
  console.log(`合併總筆數：${total} 筆，${merged.length} 位病人`);
  console.log(`成功：${groups.length - failures} / ${groups.length} 個 charting 資料庫，耗時 ${secs}s`);
  console.log(`已輸出：${outAbs}`);

  if (groups.length && failures === groups.length) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`\n發生錯誤：${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  __main: main,
  indexInterventions,
  loadIdsFile,
  indexEncounters,
  buildChartingConn,
  buildNeuroQuery,
  fetchNeuro,
  shiftTimes,
  mergeSettings,
  DEFAULTS,
};
