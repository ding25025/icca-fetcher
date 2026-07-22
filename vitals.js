#!/usr/bin/env node
'use strict';

/**
 * 生命徵象抓取工具（多站台 + 環狀表定位）
 * -------------------------------------------------
 * 設定只有一份：databases.config.json。程式會從 databases[] 自動分辨
 *   資料庫名稱是 CDSUnvalidatedData* → CDS，要撈儀器資料的站台
 *   其餘                            → primary，--discover 查 parameterId 用
 * 連線資訊（IP / 帳密）不必再抄一份到別的檔案。
 *
 * 重點：不要查 dbo.UnvalidatedDevicePeriodicData 這個 view。
 *   view 是 26 張表的 UNION，撈近 5 分鐘的資料也得掃過全部 26 張。
 *   這支工具先用 MAX(storeTime) 找出目前的寫入頭，只查那一張（跨小時交界時會
 *   自動多帶前一張），資料量與掃描範圍差好幾個數量級。
 *
 * 時間一律用 DB 端的 GETUTCDATE() 算，完全不碰用戶端時鐘，所以不會有時區問題。
 * （ICCA 的 measurementTime / storeTime 存的是 UTC。）
 *
 * 其它設定都有預設值（見 DEFAULTS），要調整就在 databases.config.json 加一個
 * "vitals" 區塊覆寫需要的項目，不影響 index.js。
 *
 * 用法：
 *   node vitals.js                       使用 databases.config.json
 *   node vitals.js --window 15           改抓近 15 分鐘
 *   node vitals.js --site cds1,cds2      只跑指定站台
 *   node vitals.js --discover            從 primary 動態查出 parameterId 清單
 *   node vitals.js --utc                 時間保留 UTC（預設已 +8）
 *   node vitals.js --pretty
 */

const fs = require('fs');
const path = require('path');
const sql = require('mssql');
const ring = require('./ring.js');

// ---------- 命令列參數 ----------
function parseArgs(argv) {
  const a = { config: 'databases.config.json', out: null, pretty: false, window: null, site: null, discover: false, local: false, param: null, paramsFile: null };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--config' || t === '-c') a.config = argv[++i];
    else if (t === '--out' || t === '-o') a.out = argv[++i];
    else if (t === '--pretty' || t === '-p') a.pretty = true;
    else if (t === '--window' || t === '-w') a.window = Number(argv[++i]);
    else if (t === '--site' || t === '-s') a.site = argv[++i];
    else if (t === '--param') a.param = argv[++i];
    else if (t === '--params-file' || t === '--params') a.paramsFile = argv[++i];
    else if (t === '--discover') a.discover = true;
    else if (t === '--utc') a.utc = true;
    else if (t === '--all-rows') a.allRows = true;
    else if (t === '--local') a.local = true; // 保留舊旗標，現在是預設行為
    else if (t === '--dry-run' || t === '-n') a.dryRun = true;
    else if (t === '--convert') a.convert = argv[++i];
    else if (t === '--with-summary') a.withSummary = true;
    else if (t === '--help' || t === '-h') a.help = true;
  }
  return a;
}

function printHelp() {
  console.log(`
生命徵象抓取工具（多站台）

  node vitals.js [選項]

選項：
  -c, --config <檔案>   設定檔（預設 databases.config.json）
  -o, --out <檔案>      輸出 JSON 檔
  -w, --window <分鐘>   撈最近幾分鐘（預設 5）
  -s, --site <名稱>     只跑指定站台，逗號分隔，例如 cds1,cds2
      --params <檔案>   讀取你自己撈出的 parameterId 清單（JSON / CSV / 純數字都吃）
      --param <ids>     直接指定 parameterId，逗號分隔
      --discover        先連 primary 查出 parameterId 清單（跑 sql/parameters.sql）
      --utc             時間保留 DB 原始的 UTC 值（預設已換算成本地 +8）
      --all-rows        不降頻，每筆都撈（預設每床每分鐘每參數只留最新一筆）
      --with-summary    輸出包成 { summary, rows }（預設是單純的資料陣列）
  -n, --dry-run        只檢查設定，不連資料庫（換機器時先跑這個）
      --convert <檔案>  把 parameterId 清單轉成 JSON 後結束，不連資料庫
  -p, --pretty         美化縮排輸出
  -h, --help           顯示說明

設定：
  站台直接從 databases.config.json 的 databases[] 認出來——資料庫名稱是
  CDSUnvalidatedData* 的當成要撈的 CDS，其餘當成 primary。連線資訊只有那一份。
  其它項目（windowMinutes、ring、parameterIdsFile…）都有預設值，要改就在
  databases.config.json 加一個 "vitals" 區塊，index.js 不受影響。

parameterId 來源優先序：
  --param  >  --params / parameterIdsFile  >  站台 parameterIds  >  vitals.parameterIds
  --discover 會蓋掉以上全部。實際採用哪個來源會印在執行訊息裡。
`);
}

/**
 * 生命徵象相關的預設值。全部寫在程式裡，所以 databases.config.json 不必動；
 * 要調整就在該檔加一個 "vitals" 區塊覆寫需要的項目即可。
 */
const DEFAULTS = {
  output: 'icca-vitals.json',
  queryTimeoutMs: 60000,
  lockTimeoutMs: 3000,
  windowMinutes: 5,
  timesInUtc: false,
  // 表號錨點快取檔；刪掉只會讓下次重新完整掃描
  anchorCacheFile: '.ring-anchors.json',
  // 一張表涵蓋幾小時（用來從錨點推算表號）
  hoursPerTable: 1,
  // 每床每分鐘每個參數只留最新一筆；設 false 則原始逐筆全撈
  perMinute: true,
  displayTimezoneOffsetHours: 8,
  parameterIdsFile: 'sql/parameter-ids.txt',
  parameterSqlFile: 'sql/parameters.sql',
  discoverParameters: false,
  defaultPrimary: null,
  // CDS 資料庫的判斷方式（用來從 databases[] 裡自動分辨 cds 與 primary）
  cdsDatabasePattern: '^CDSUnvalidatedData',
  ring: {
    tablePrefix: 'UnvalidatedDevicePeriodicData_',
    start: 0,
    count: 26,
    pad: 2,
    headColumn: 'storeTime',
    timeColumn: 'measurementTime',
    orderColumn: 'measurementTime',
  },
};

function loadConfig(configPath) {
  const abs = path.resolve(process.cwd(), configPath);
  if (!fs.existsSync(abs)) throw new Error(`找不到設定檔：${abs}`);
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    throw new Error(`設定檔 ${configPath} JSON 格式錯誤：${e.message}`);
  }
  if (!Array.isArray(cfg.databases) && !Array.isArray(cfg.sites)) {
    throw new Error(`${configPath} 裡找不到 "databases" 或 "sites" 陣列`);
  }
  return cfg;
}

/** 把 databases.config.json 的 vitals 區塊疊到預設值上 */
function mergeSettings(cfg) {
  const v = { ...DEFAULTS, ...(cfg.vitals || {}) };
  v.ring = { ...DEFAULTS.ring, ...((cfg.vitals || {}).ring || {}) };
  return v;
}

/**
 * 從 databases.config.json 的 databases[] 自動分出站台：
 *   database 名稱符合 cdsDatabasePattern 的是 CDS（要撈資料的）
 *   其餘視為 primary（--discover 時查 parameterId 用）
 * 已經寫好 sites[] 的設定檔則直接沿用，不做推測。
 */
function deriveSites(cfg, settings) {
  if (Array.isArray(cfg.sites) && cfg.sites.length) {
    return { sites: cfg.sites, primaries: [], derived: false };
  }
  const re = new RegExp(settings.cdsDatabasePattern, 'i');
  const sites = [];
  const primaries = [];
  for (const d of cfg.databases || []) {
    if (!d || !d.name || !d.connection) continue;
    if (re.test(String(d.connection.database || ''))) {
      sites.push({ name: d.name, enabled: d.enabled !== false, cds: d.name });
    } else {
      primaries.push(d.name);
    }
  }
  if (!sites.length) {
    throw new Error(
      `${cfg.databases ? 'databases[]' : '設定檔'} 裡沒有符合 /${settings.cdsDatabasePattern}/i 的 CDS 資料庫；` +
        '可在 vitals 區塊調整 cdsDatabasePattern，或自行寫 sites[]'
    );
  }
  return { sites, primaries, derived: true };
}

function resolveSecret(value) {
  if (typeof value === 'string' && value.startsWith('env:')) {
    const key = value.slice(4);
    const v = process.env[key];
    if (v === undefined) throw new Error(`環境變數 ${key} 未設定`);
    return v;
  }
  return value;
}

function safeIdent(name, label) {
  if (!/^[A-Za-z0-9_]+$/.test(String(name))) throw new Error(`${label} 含有不允許的字元：${name}`);
  return name;
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

// ---------- 匯入自行撈出的 parameterId ----------

const ID_KEYS = ['cdsparameterid', 'parameterid', 'paramid', 'id'];
const LABEL_KEYS = ['terselabel', 'label', 'param', 'paramname', 'displaylabel'];
const PROP_KEYS = ['propname', 'prop', 'property', 'attribute', 'attributename'];
const norm = (k) => String(k).toLowerCase().replace(/[\s_\-.]/g, '');
const isInt = (c) => /^-?\d+$/.test(String(c).trim());

function pickKey(keys, wanted) {
  for (const w of wanted) {
    const hit = keys.find((k) => norm(k) === w);
    if (hit) return hit;
  }
  return null;
}

/**
 * 收下一筆。out = { ids, labels, props }
 * 同一個 id 出現多次只留第一次的標籤（例如 -268367660 同時掛在 ABP diastolic 與 systolic 下）。
 */
function collect(out, id, label, prop) {
  const n = typeof id === 'number' ? id : Number(String(id).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n)) return;
  if (!out.ids.includes(n)) out.ids.push(n);
  if (label && !out.labels[n]) out.labels[n] = String(label).trim();
  if (prop && !out.props[n]) out.props[n] = String(prop).trim();
}

/**
 * 解析你自己撈出來的 parameterId 清單。刻意吃得很雜，因為從 SSMS 匯出的形式很多：
 *   [147842, 150456]                                    JSON 數字陣列
 *   [{"terseLabel":"HR","cdsParameterId":147842}, ...]   JSON 物件陣列（結果另存 JSON）
 *   terseLabel<TAB>propName<TAB>cdsParameterId           SSMS「連同標頭複製」
 *   ABP | diastolic | 150034                             管線分隔，沒有標頭
 *   147842,150456,-268367660                             純數字，逗號或換行分隔
 * terseLabel / propName 有出現時會一起收下來，之後放進每筆資料的 _paramLabel / _paramProp。
 */
function parseParameterList(text) {
  const s = String(text).replace(/^﻿/, '').trim();
  const out = { ids: [], labels: {}, props: {} };
  if (!s) return out;

  // --- JSON ---
  if (s[0] === '[' || s[0] === '{') {
    let data;
    try {
      data = JSON.parse(s);
    } catch (e) {
      throw new Error(`parameterId 檔看起來是 JSON 但格式錯誤：${e.message}`);
    }
    // 物件包陣列時（例如 { "rows": [...] }）取第一個陣列
    if (!Array.isArray(data) && data && typeof data === 'object') {
      data = Object.values(data).find(Array.isArray) || [];
    }
    for (const item of data) {
      if (item == null) continue;
      if (typeof item === 'object') {
        const keys = Object.keys(item);
        const idKey = pickKey(keys, ID_KEYS);
        if (!idKey) continue;
        const labelKey = pickKey(keys, LABEL_KEYS);
        const propKey = pickKey(keys, PROP_KEYS);
        collect(out, item[idKey], labelKey ? item[labelKey] : null, propKey ? item[propKey] : null);
      } else {
        collect(out, item, null, null);
      }
    }
    return out;
  }

  // --- 分隔文字 ---
  // 濾掉 SSMS「結果到文字」會夾帶的分隔線（-----、----+----、----|----）
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^[-+|\s]+$/.test(l));
  const delim =
    lines.some((l) => l.includes('\t')) ? '\t'
    : lines.some((l) => l.includes('|')) ? '|'
    : lines.some((l) => l.includes(',')) ? ','
    : /\s+/;
  // 這裡不濾掉空欄位，否則有空值的列會整排錯位
  const split = (l) => l.split(delim).map((c) => c.trim());

  const first = split(lines[0]).filter((c) => c !== '');
  const idCol = pickKey(first, ID_KEYS);

  if (idCol) {
    // 有標頭：照欄名取值
    const labelCol = pickKey(first, LABEL_KEYS);
    const propCol = pickKey(first, PROP_KEYS);
    const idIdx = first.indexOf(idCol);
    const labelIdx = labelCol ? first.indexOf(labelCol) : -1;
    const propIdx = propCol ? first.indexOf(propCol) : -1;
    for (const line of lines.slice(1)) {
      const cols = split(line);
      if (cols.length <= idIdx) continue;
      collect(out, cols[idIdx], labelIdx >= 0 ? cols[labelIdx] : null, propIdx >= 0 ? cols[propIdx] : null);
    }
    return out;
  }

  // 沒標頭但欄數一致 → 從內容推欄位（例如 "ABP | diastolic | 150034"）
  const rows = lines.map(split);
  const width = rows[0].length;
  if (width >= 2 && rows.every((r) => r.length === width)) {
    const intRatio = [];
    for (let c = 0; c < width; c++) intRatio[c] = rows.filter((r) => isInt(r[c])).length / rows.length;

    // 非數字欄由左到右當作 label、prop
    const textCols = [];
    for (let c = 0; c < width; c++) if (intRatio[c] === 0) textCols.push(c);

    // 只有在確實存在文字欄時才當成表格。全部都是數字的話那是純清單
    // （例如 "147842,150456"），每個欄位都是 id，不能只取一欄。
    if (textCols.length) {
      // id 欄 = 幾乎全是整數的欄位；同分取最右邊（cdsParameterId 慣例在最後一欄）
      let idIdx = -1;
      for (let c = 0; c < width; c++) {
        if (intRatio[c] >= 0.9 && (idIdx < 0 || intRatio[c] >= intRatio[idIdx])) idIdx = c;
      }
      if (idIdx >= 0) {
        const [labelIdx = -1, propIdx = -1] = textCols;
        for (const r of rows) {
          collect(out, r[idIdx], labelIdx >= 0 ? r[labelIdx] : null, propIdx >= 0 ? r[propIdx] : null);
        }
        return out;
      }
    }
  }

  // 真的看不出結構：把所有像整數的 token 撿起來
  for (const r of rows) for (const cell of r) collect(out, cell, null, null);
  return out;
}

function loadParameterFile(file) {
  const abs = path.resolve(process.cwd(), file);
  if (!fs.existsSync(abs)) throw new Error(`找不到 parameterId 檔：${abs}`);
  const got = parseParameterList(fs.readFileSync(abs, 'utf8'));
  if (!got.ids.length) throw new Error(`${abs} 裡沒有解析到任何 parameterId`);
  return got;
}

// ---------- 連線來源 ----------

/**
 * 連線資訊只有一份，就是 databases.config.json 的 databases[]，
 * 這裡用 name 索引起來。IP 與密碼都不必再抄一次。
 *
 * 名字來源（後者覆蓋前者）：
 *   1. cfg.databases[].name
 *   2. cfg.connectionsFrom 指向的另一個檔案（設定檔拆開放時才需要）
 *   3. cfg.vitals.connections（要臨時覆寫某個名字時用）
 */
function buildConnectionRegistry(cfg, settings = {}) {
  const reg = new Map();
  const add = (list) => {
    for (const d of list || []) if (d && d.name && d.connection) reg.set(d.name, d.connection);
  };

  add(cfg.databases);

  if (cfg.connectionsFrom) {
    const abs = path.resolve(process.cwd(), cfg.connectionsFrom);
    if (!fs.existsSync(abs)) throw new Error(`找不到連線設定檔：${abs}`);
    try {
      add(JSON.parse(fs.readFileSync(abs, 'utf8')).databases);
    } catch (e) {
      throw new Error(`連線設定檔 ${cfg.connectionsFrom} JSON 格式錯誤：${e.message}`);
    }
  }

  for (const [name, conn] of Object.entries(settings.connections || {})) reg.set(name, conn);
  return reg;
}

/** 連線可以寫成名字（查 registry）或直接寫完整的連線物件 */
function resolveConn(value, reg, what, siteName) {
  if (!value) return null;
  if (typeof value !== 'string') return value;
  const conn = reg.get(value);
  if (!conn) {
    const known = [...reg.keys()].join(', ') || '（空）';
    throw new Error(`站台 ${siteName} 的 ${what} 指向 "${value}"，但連線清單裡沒有這個名字。可用的有：${known}`);
  }
  return conn;
}

// 同一台 primary 只查一次，多個 CDS 共用結果
const primaryCache = new Map();
function discoverOnce(key, fn) {
  if (!primaryCache.has(key)) primaryCache.set(key, fn());
  return primaryCache.get(key);
}

// ---------- 從 primary 動態查出要撈哪些 parameterId ----------
async function discoverParameterIds(pool, sqlText) {
  const r = await pool.request().query(sqlText);
  const out = { ids: [], labels: {}, props: {} };
  // 欄名沿用 parameters.sql：terseLabel / propName / cdsParameterId
  for (const row of r.recordset || []) {
    collect(out, row.cdsParameterId, row.terseLabel, row.propName);
  }
  return out;
}

// ---------- 表號錨點快取 ----------
// 記住「某張表對應某個 DB 時刻」，下次就能用算的，不必再掃 26 張表。
// 這是純快取，刪掉只會讓下一次退回完整掃描，不影響正確性。

function loadAnchors(file) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), file), 'utf8'));
  } catch (_) {
    return {};
  }
}

function saveAnchors(file, anchors) {
  try {
    fs.writeFileSync(path.resolve(process.cwd(), file), JSON.stringify(anchors, null, 2), 'utf8');
  } catch (e) {
    console.warn(`  ⚠ 無法寫入表號快取 ${file}：${e.message}（不影響結果，只是下次要重新掃描）`);
  }
}

/**
 * 找出目前的 head。
 *
 * 快路徑：用快取的錨點推算表號，只查那一張（外加前一張供跨時段用）。
 *         1 次查詢，而不是 26 次。
 * 慢路徑：沒有錨點、或推算結果對不上時，做完整掃描並重新記下錨點。
 *
 * 回傳 { head, stats, scanned }。stats 只含查過的表——夠 tablesForWindow 用即可。
 */
async function locateHead(pool, ringCfg, anchor, windowMinutes) {
  const perHours = ringCfg.hoursPerTable || 1;
  const allTables = ring.buildTableNames(ringCfg);

  // 時間窗超過一個時段就會跨到更前面的表，這種情況直接完整掃描比較單純
  const windowFits = windowMinutes <= perHours * 60;

  if (anchor && windowFits) {
    const guess = ring.predictIndex(anchor, new Date(Date.now() + (anchor.clockOffsetMs || 0)), ringCfg);
    if (guess != null) {
      // 推算的那張 + 前一張，一次查詢就拿到（scanRing 內部用 UNION ALL）
      const prev = (guess - 1 + ringCfg.count) % ringCfg.count;
      const subset = [guess, prev].map((i) => ({ index: i, table: ring.tableNameFor(i, ringCfg) }));
      const partial = await ring.scanRing(pool, subset, ringCfg);
      const dbNow = ring.dbNowOf(partial);
      const cand = partial.find((s) => s.index === guess);
      if (ring.isPlausibleHead(cand, dbNow, ringCfg)) {
        // 已經是由新到舊，直接用；不能丟給 orderFromHead，它會把子集長度當成環的大小
        const ordered = [cand, partial.find((s) => s.index === prev)].filter(Boolean);
        return { head: cand, ordered, scanned: false, dbNow };
      }
    }
  }

  // 退回完整掃描
  const stats = await ring.scanRing(pool, allTables, ringCfg);
  const head = ring.findHead(stats);
  return {
    head,
    ordered: head ? ring.orderFromHead(stats, head.index, 'newToOld') : [],
    scanned: true,
    dbNow: ring.dbNowOf(stats),
  };
}

// ---------- 挑出「這段時間窗」需要查的資料表 ----------
/**
 * 從 head 往回走，把區間與 [windowStart, ∞) 有交集的表都收進來。
 * 跨小時交界時（例如 11:02 要撈近 5 分鐘）會自動多帶前一張，
 * 否則 10:57~11:00 那幾筆會漏掉。
 */
function tablesForWindow(orderedNewToOld, windowStartMs) {
  const picked = [];
  for (const s of orderedNewToOld) {
    if (s.error || !s.maxTime) continue;
    if (new Date(s.maxTime).getTime() < windowStartMs) break; // 再往回都更舊，不用看了
    picked.push(s);
  }
  return picked.length ? picked : orderedNewToOld.filter((s) => !s.error && s.maxTime).slice(0, 1);
}

// ---------- 從指定的環狀表撈生命徵象 ----------
async function fetchVitals(pool, table, parameterIds, windowMinutes, cfg) {
  const t = safeIdent(table, 'table');
  const idParams = parameterIds.map((_, i) => `@p${i}`).join(', ');

  const req = pool.request().input('win', sql.Int, windowMinutes);
  parameterIds.forEach((v, i) => req.input(`p${i}`, sql.Int, v));

  const COLS = 'bed, parameterId, numericValue, textValue, units, measurementTime, storeTime';

  // 每床每分鐘每個參數只留最新一筆。監視器可能每幾秒送一次，降頻後資料量差很多。
  // 在 SQL 端做掉，網路傳輸與 JSON 大小一起省；要原始逐筆就關掉 perMinute。
  const perMinute = cfg.perMinute !== false;
  const rank = perMinute
    ? `,
    ROW_NUMBER() OVER (
      PARTITION BY d.bedId, p.parameterId,
                   DATEADD(MINUTE, DATEDIFF(MINUTE, 0, p.measurementTime), 0)
      ORDER BY p.measurementTime DESC, p.storeTime DESC
    ) AS _rn`
    : '';

  const inner = `
SELECT
    b.label            AS bed,
    p.parameterId,
    p.numericValue,
    p.textValue,
    p.units,
    p.measurementTime,
    p.storeTime${rank}
FROM       dbo.[${t}]         p WITH (NOLOCK)
INNER JOIN dbo.DeviceInstance d WITH (NOLOCK) ON d.deviceInstanceId = p.deviceInstanceId
INNER JOIN dbo.UdsBed         b WITH (NOLOCK) ON b.bedId            = d.bedId
WHERE p.measurementTime >= DATEADD(MINUTE, -@win, GETUTCDATE())
  AND p.parameterId IN (${idParams})`;

  const body = perMinute
    ? `WITH ranked AS (${inner}
)
SELECT ${COLS} FROM ranked WHERE _rn = 1
ORDER BY parameterId, measurementTime DESC`
    : `${inner}
ORDER BY p.parameterId, p.measurementTime DESC`;

  // 時間基準用 DB 的 GETUTCDATE()，不碰用戶端時鐘
  const q = `
SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT ${Number(cfg.lockTimeoutMs) || 3000};
SET NOCOUNT ON;

${body}`;

  const r = await req.query(q);
  return (r.recordset || []).map((row) => ({ _sourceTable: t, ...row }));
}

/**
 * 跨表去重。
 *
 * 環狀表在交界處會重疊 30~40 秒（前一張還在收尾、下一張已經開始寫），
 * 所以時間窗跨表時同一床同一參數同一分鐘會在兩張表各出現一次。
 * SQL 的降頻是各表獨立做的，管不到這件事，只能在合併後補一次。
 */
function dedupePerMinute(rows) {
  const kept = new Map();
  for (const r of rows) {
    if (!r.measurementTime) continue;
    const t = new Date(r.measurementTime);
    const minute = Math.floor(t.getTime() / 60000);
    const key = `${r.bed}|${r.parameterId}|${minute}`;
    const prev = kept.get(key);
    if (!prev || t > new Date(prev.measurementTime)) kept.set(key, r);
  }
  // 沒有 measurementTime 的資料（理論上不該有）原樣保留，不要默默吃掉
  const orphans = rows.filter((r) => !r.measurementTime);
  return [...kept.values(), ...orphans];
}

// 會被換算的時間欄位
const TIME_FIELDS = ['measurementTime', 'storeTime'];

/**
 * ICCA 存的是 UTC，直接輸出的話台灣看起來會少 8 小時。
 * 這裡把時間欄位就地加上時差並格式化成 "2026-07-22 11:24:00"，
 * 讓匯出的 JSON 直接就是本地時間，不必再自己換算。
 * 要保留原始 UTC 值就加 --utc。
 */
function shiftTimes(row, offsetHours) {
  const out = { ...row };
  for (const f of TIME_FIELDS) {
    if (out[f] == null) continue;
    out[f] = ring.fmtDb(new Date(new Date(out[f]).getTime() + offsetHours * 3600e3));
  }
  return out;
}

// ---------- 單一站台 ----------
async function runSite(site, settings, args, registry, anchors) {
  const name = site.name;
  const windowMinutes = args.window || settings.windowMinutes || 5;
  const timeout = settings.queryTimeoutMs || 60000;
  // 排程高頻執行：關掉 COUNT(*)，掃描只留有索引的 MAX/MIN
  const ringCfg = { withCounts: false, hoursPerTable: settings.hoursPerTable, ...(settings.ring || {}), ...(site.ring || {}) };

  // parameterId 的來源，由高到低：
  //   --param 直接指定 > --params-file / 設定檔 parameterIdsFile > 站台 parameterIds > 全域 parameterIds
  // --discover 會蓋掉以上全部（下面第 1 步）
  let parameterIds = [];
  let labels = {};
  let props = {};
  let source;

  const idFile = args.paramsFile || site.parameterIdsFile || settings.parameterIdsFile;
  if (args.param) {
    const got = parseParameterList(args.param);
    parameterIds = got.ids;
    labels = got.labels;
    props = got.props;
    source = '--param';
  } else if (idFile) {
    const got = loadParameterFile(idFile);
    parameterIds = got.ids;
    labels = got.labels;
    props = got.props;
    source = idFile;
  } else {
    parameterIds = site.parameterIds || settings.parameterIds || [];
    source = site.parameterIds ? '站台設定' : '設定檔 parameterIds';
  }

  // 1. 需要的話，先連 primary 查出 parameterId 清單（會蓋掉上面的來源）
  if (args.discover || settings.discoverParameters) {
    const sqlFile = site.parameterSqlFile || settings.parameterSqlFile;
    if (!sqlFile) throw new Error('--discover 需要設定 parameterSqlFile');
    const abs = path.resolve(process.cwd(), sqlFile);
    if (!fs.existsSync(abs)) throw new Error(`找不到 SQL 檔：${abs}`);
    const primaryRef = site.primary || settings.defaultPrimary;
    const primary = resolveConn(primaryRef, registry, 'primary', name);
    if (!primary) throw new Error(`站台 ${name} 沒有設定 primary（站台的 primary 或全域 defaultPrimary）`);
    const sqlText = fs.readFileSync(abs, 'utf8').replace(/^﻿/, '');

    // 多個 CDS 共用同一台 primary 時只查一次
    const key = typeof primaryRef === 'string' ? primaryRef : `${primary.server}/${primary.database}`;
    const found = await discoverOnce(key, async () => {
      const pool = await connect(primary, timeout);
      try {
        return await discoverParameterIds(pool, sqlText);
      } finally {
        try { await pool.close(); } catch (_) {}
      }
    });

    if (found.ids.length) {
      parameterIds = found.ids;
      labels = found.labels;
      props = found.props;
      source = `primary ${key}`;
    } else {
      console.warn(`  [${name}] primary 沒查到 parameterId，沿用 ${source}`);
    }
  }

  if (!parameterIds.length) throw new Error(`站台 ${name} 沒有任何 parameterId 可撈`);
  console.log(`  [${name}] parameterId：${parameterIds.length} 個（來源：${source}）`);

  // 2. 連 CDS，定位目前的寫入頭
  const cdsConn = resolveConn(site.cds, registry, 'cds', name);
  if (!cdsConn) throw new Error(`站台 ${name} 沒有設定 cds 連線`);
  const pool = await connect(cdsConn, timeout);
  try {
    const tables = ring.buildTableNames(ringCfg);
    const tScan = Date.now();
    const anchorKey = `${cdsConn.server}/${cdsConn.database}`;
    const located = await locateHead(pool, ringCfg, anchors[anchorKey], windowMinutes);
    const scanMs = Date.now() - tScan;
    const { head, ordered, scanned } = located;
    if (!head) throw new Error('所有環狀表都沒有資料，無法判斷寫入頭');

    // 完整掃描過就更新錨點，下次才用得到快路徑
    if (scanned && located.dbNow) {
      anchors[anchorKey] = {
        index: head.index,
        time: ring.fmtDb(located.dbNow),
        // DB 時鐘與本機的差，推算時要補回來
        clockOffsetMs: new Date(located.dbNow).getTime() - Date.now(),
        learnedAt: ring.fmtDb(located.dbNow),
      };
    }

    // 時間窗的起點用 DB 的時間算（head 最後寫入時間 ≈ DB 的現在）
    const windowStartMs = new Date(head.maxTime).getTime() - windowMinutes * 60000;
    const targets = tablesForWindow(ordered, windowStartMs);

    console.log(
      `  [${name}] head=${head.table}（${ring.fmtDb(head.maxTime)} UTC，掃描 ${scanMs}ms），` +
        `近 ${windowMinutes} 分鐘需查 ${targets.length} 張表：${targets.map((s) => s.table).join(', ')}` +
        (scanned ? '（完整掃描）' : '（用算的）')
    );

    // 3. 逐表撈資料
    const fetchCfg = { ...settings, perMinute: args.allRows ? false : settings.perMinute !== false };
    const tFetch = Date.now();
    let rows = [];
    for (const t of targets) {
      const got = await fetchVitals(pool, t.table, parameterIds, windowMinutes, fetchCfg);
      rows.push(...got);
    }
    const fetchMs = Date.now() - tFetch;

    // 跨表時交界重疊會產生重複，合併後補一次去重
    const beforeDedupe = rows.length;
    if (fetchCfg.perMinute && targets.length > 1) {
      rows = dedupePerMinute(rows);
      if (rows.length !== beforeDedupe) {
        console.log(`  [${name}] 跨表去重：${beforeDedupe} → ${rows.length} 筆`);
      }
    }

    // 補上站台標記與（可選的）本地時間
    const offset = settings.displayTimezoneOffsetHours != null ? settings.displayTimezoneOffsetHours : 8;
    rows = rows.map((r) => {
      // terseLabel 是臨床項目（HR、ABP、體溫…），propName 是細項（systolic/diastolic/mean）
      // 兩者來自 parameterId 清單，欄名沿用 CdsParameterMap 的原始欄名
      const base = {
        _site: name,
        terseLabel: labels[r.parameterId] || null,
        propName: props[r.parameterId] || null,
        ...r,
      };
      // 預設把時間換算成本地時區；--utc 則保留 DB 原始的 UTC 值
      return args.utc || settings.timesInUtc ? base : shiftTimes(base, offset);
    });

    return {
      name,
      ok: true,
      headTable: head.table,
      tablesQueried: targets.map((s) => s.table),
      dbTimeUtc: ring.fmtDb(head.maxTime),
      parameterCount: parameterIds.length,
      count: rows.length,
      scanMs,
      fetchMs,
      rows,
    };
  } finally {
    try { await pool.close(); } catch (_) {}
  }
}

// ---------- 主流程 ----------
async function main() {
  const args = parseArgs(process.argv);
  if (args.help) return printHelp();

  // --convert：把任何格式的 parameterId 清單轉成 JSON 就結束，不碰資料庫
  if (args.convert) {
    const got = loadParameterFile(args.convert);
    const rows = got.ids.map((id) => {
      const r = { cdsParameterId: id };
      if (got.labels[id]) r.terseLabel = got.labels[id];
      if (got.props[id]) r.propName = got.props[id];
      return r;
    });
    const outAbs = path.resolve(
      process.cwd(),
      args.out || args.convert.replace(/\.[^.\\/]+$/, '') + '.json'
    );
    // 這是給人看、給設定檔引用的檔案，一律縮排
    fs.writeFileSync(outAbs, JSON.stringify(rows, null, 2) + '\n', 'utf8');
    const labelled = rows.filter((r) => r.terseLabel).length;
    console.log(`${args.convert} → ${outAbs}`);
    console.log(`  ${rows.length} 個 parameterId，${labelled} 個有標籤，${new Set(Object.values(got.labels)).size} 個項目`);
    return;
  }

  const cfg = loadConfig(args.config);
  const settings = mergeSettings(cfg);
  const outFile = args.out || settings.output;
  const registry = buildConnectionRegistry(cfg, settings);
  const anchors = loadAnchors(settings.anchorCacheFile);

  const { sites: allSites, primaries, derived } = deriveSites(cfg, settings);
  // 沒指定 defaultPrimary 時，用推出來的第一個非 CDS 資料庫
  if (!settings.defaultPrimary && primaries.length) settings.defaultPrimary = primaries[0];

  if (derived) {
    console.log(
      `從 ${args.config} 認出 ${allSites.length} 個 CDS：${allSites.map((s) => s.name).join(', ')}` +
        (primaries.length ? `　primary：${primaries.join(', ')}` : '')
    );
  }

  let sites = allSites.filter((s) => s.enabled !== false);
  if (args.site) {
    const want = args.site.split(',').map((s) => s.trim().toLowerCase());
    sites = sites.filter((s) => want.includes(String(s.name).toLowerCase()));
  }
  if (!sites.length) throw new Error('沒有任何 enabled 的站台');

  // --dry-run：把設定攤開檢查一遍就結束，完全不連資料庫
  if (args.dryRun) {
    console.log(`\n[dry-run] 不會連線，只檢查設定\n`);
    let ids = [];
    const idFile = args.paramsFile || settings.parameterIdsFile;
    if (args.param) {
      ids = parseParameterList(args.param).ids;
      console.log(`parameterId：${ids.length} 個（來源：--param）`);
    } else if (idFile && fs.existsSync(path.resolve(process.cwd(), idFile))) {
      const got = loadParameterFile(idFile);
      ids = got.ids;
      const byLabel = {};
      for (const id of ids) (byLabel[got.labels[id] || '(無標籤)'] ||= []).push(id);
      console.log(`parameterId：${ids.length} 個（來源：${idFile}）`);
      for (const [k, v] of Object.entries(byLabel)) console.log(`  ${k.padEnd(12)} ${String(v.length).padStart(2)} 個`);
    } else {
      ids = settings.parameterIds || [];
      console.log(`parameterId：${ids.length} 個（來源：vitals.parameterIds）` + (idFile ? `　⚠ 找不到 ${idFile}` : ''));
    }
    if (!ids.length) console.warn('⚠ 沒有任何 parameterId，實際執行會失敗');

    console.log(`\n時間窗：近 ${args.window || settings.windowMinutes} 分鐘（用 DB 端 GETUTCDATE()）`);
    console.log(`環狀表：${settings.ring.tablePrefix}${String(settings.ring.start).padStart(settings.ring.pad, '0')} ~ 共 ${settings.ring.count} 張，head 依 ${settings.ring.headColumn}`);
    console.log(`\n要查的站台：`);
    for (const s of sites) {
      const c = resolveConn(s.cds, registry, 'cds', s.name); // 名字解不開會在這裡就報錯
      const pw = String(c.password || '').startsWith('env:') ? `env:${String(c.password).slice(4)}` : '（設定檔內）';
      const envMissing = String(c.password || '').startsWith('env:') && !process.env[String(c.password).slice(4)];
      console.log(
        `  ${s.name.padEnd(6)} ${String(c.server).padEnd(14)}:${c.port || 1433}  ${c.database}  密碼=${pw}` +
          (envMissing ? '  ⚠ 環境變數未設定' : '')
      );
    }
    console.log(`\n輸出：${path.resolve(process.cwd(), outFile)}`);
    console.log('\n設定檢查完成。拿掉 --dry-run 即會實際連線。');
    return;
  }

  console.log(`開始平行查詢 ${sites.length} 個站台...`);
  const started = Date.now();

  const settled = await Promise.allSettled(sites.map((s) => runSite(s, settings, args, registry, anchors)));

  const merged = [];
  const summary = [];
  let failures = 0;

  settled.forEach((s, i) => {
    const name = sites[i].name;
    if (s.status === 'fulfilled') {
      merged.push(...s.value.rows);
      summary.push({
        site: name,
        ok: true,
        headTable: s.value.headTable,
        tablesQueried: s.value.tablesQueried,
        dbTimeUtc: s.value.dbTimeUtc,
        count: s.value.count,
        scanMs: s.value.scanMs,
        fetchMs: s.value.fetchMs,
      });
      console.log(
        `  ✓ ${name}：${s.value.count} 筆（${s.value.headTable}，掃描 ${s.value.scanMs}ms + 撈取 ${s.value.fetchMs}ms）`
      );
    } else {
      failures++;
      const msg = s.reason && s.reason.message ? s.reason.message : String(s.reason);
      summary.push({ site: name, ok: false, error: msg });
      console.error(`  ✗ ${name}：${msg}`);
    }
  });

  // 預設輸出單一 JSON 陣列（與 index.js 一致），每筆自帶 _site / _sourceTable。
  // 需要各站狀態時加 --with-summary，會包成 { summary, rows }。
  const withSummary = args.withSummary || settings.includeSummary === true;
  saveAnchors(settings.anchorCacheFile, anchors);

  const payload = withSummary ? { summary, rows: merged } : merged;
  const json = args.pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
  const outAbs = path.resolve(process.cwd(), outFile);
  fs.writeFileSync(outAbs, json, 'utf8');

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log('----------------------------------------');
  console.log(`合併總筆數：${merged.length}`);
  console.log(`成功：${sites.length - failures} / ${sites.length}，耗時 ${secs}s`);
  console.log(`已輸出：${outAbs}`);

  if (failures === sites.length) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`\n發生錯誤：${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  __main: main, // 測試用：注入假的 mssql 後可直接跑主流程
  discoverParameterIds,
  fetchVitals,
  loadParameterFile,
  parseParameterList,
  DEFAULTS,
  buildConnectionRegistry,
  deriveSites,
  loadConfig,
  mergeSettings,
  resolveConn,
  tablesForWindow,
  dedupePerMinute,
  shiftTimes,
};
