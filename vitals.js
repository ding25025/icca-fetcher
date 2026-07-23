#!/usr/bin/env node
'use strict';

/**
 * 生命徵象抓取工具（多站台 + 環狀表定位）
 * -------------------------------------------------
 * 設定只有一份：databases.config.json。程式會從 databases[] 自動分辨
 *   資料庫名稱是 CDSUnvalidatedData* → CDS，要撈儀器資料的站台
 *   其餘                            → primary，查病人（與 --discover 的 parameterId）用
 * 連線資訊（IP / 帳密）不必再抄一份到別的檔案。
 *
 * CDS 只有床與儀器，病人在 primary。兩邊共同的鑰匙是床號（CDS 的 UdsBed.label 對
 * primary 的 Bed.displayLabel），所以每次執行會順便連 primary 跑 sql/patients.sql，
 * 把病歷號（lifetimeNumber）與住院帳號（encounterNumber）併進每一筆，
 * 沒對到病人的床（空床、測試機）預設不輸出。
 * 床號比對前會去空白、轉大寫，兩邊大小寫不一致也接得起來。
 * primary 出問題時只警告，儀器資料照樣輸出（病人欄位留 null）；--no-patients 可整個關掉。
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
  const a = { config: 'databases.config.json', out: null, pretty: false, window: null, site: null, discover: false, param: null, paramsFile: null };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--config' || t === '-c') a.config = argv[++i];
    else if (t === '--no-patients') a.noPatients = true;
    else if (t === '--keep-unmatched') a.keepUnmatched = true;
    else if (t === '--no-aperiodic') a.noAperiodic = true;
    else if (t === '--patients-sql') a.patientSqlFile = argv[++i];
    else if (t === '--patients-db') a.patientDb = argv[++i];
    else if (t === '--check-patients') a.checkPatients = true;
    else if (t === '--out' || t === '-o') a.out = argv[++i];
    else if (t === '--pretty' || t === '-p') a.pretty = true;
    else if (t === '--window' || t === '-w') a.window = Number(argv[++i]);
    else if (t === '--site' || t === '-s') a.site = argv[++i];
    else if (t === '--param') a.param = argv[++i];
    else if (t === '--params-file' || t === '--params') a.paramsFile = argv[++i];
    else if (t === '--discover') a.discover = true;
    else if (t === '--utc') a.utc = true;
    else if (t === '--all-rows') a.allRows = true;
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
  -o, --out <檔案>      輸出 JSON 檔（預設 vitals_yyyyMMddHHmm.json，到分鐘）
                        檔名裡寫 {ts} 會換成時間戳，例如 icu_{ts}.json
  -w, --window <分鐘>   撈最近幾分鐘（預設 5）
  -s, --site <名稱>     只跑指定站台，逗號分隔，例如 cds1,cds2
      --params <檔案>   讀取你自己撈出的 parameterId 清單（JSON / CSV / 純數字都吃）
      --param <ids>     直接指定 parameterId，逗號分隔
      --discover        先連 primary 查出 parameterId 清單（跑 sql/parameters.sql）
      --utc             時間保留 DB 原始的 UTC 值（預設已換算成本地 +8）
      --all-rows        不降頻，每筆都撈（預設每床每分鐘每參數只留最新一筆）
      --no-aperiodic    只撈週期性資料，不撈 NBP 這類間歇量測
      --no-patients     不去 primary 查病人，輸出就不會有病歷號
      --keep-unmatched  連沒對到病人的床也輸出（預設只留對得到病人的）
      --patients-sql <檔案>  換一份查病人的 SQL（預設 sql/patients.sql）
      --patients-db <資料庫> 病人資料在哪個資料庫（預設讀 SQL 檔裡的 USE）
      --check-patients  診斷病歷號為什麼是 null（只讀，不輸出檔案）
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

病人資料：
  預設會連 primary 跑 sql/patients.sql，用「床號」把病歷號（lifetimeNumber）、
  住院帳號（encounterNumber）併進每一筆，沒對到病人的床不輸出
  （要保留就加 --keep-unmatched）。床號是 CDS 的 UdsBed.label 對 primary 的
  Bed.displayLabel，比對前會去空白、轉大寫。
  primary 查不到或連不上時仍會輸出儀器資料，病人欄位留 null。
  要連哪個資料庫：--patients-db > vitals.patientDatabase > SQL 檔裡的 USE > primary 的設定。
  病歷號整排 null 時跑 --check-patients，它會指出是連錯資料庫、沒有在床病人、
  還是兩邊的床號寫法不一樣。
`);
}

/**
 * 生命徵象相關的預設值。全部寫在程式裡，所以 databases.config.json 不必動；
 * 要調整就在該檔加一個 "vitals" 區塊覆寫需要的項目即可。
 */
const DEFAULTS = {
  // {ts} 會換成執行當下的時間戳（yyyyMMddHHmm，到分鐘），例如 vitals_202607231111.json。
  // 每跑一次就是一個新檔，排程跑出來的結果不會互相覆蓋。要固定檔名就寫死不含 {ts} 的名字。
  output: 'vitals_{ts}.json',
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
  // 病人資料（primary）：用床號把病歷號接到儀器資料上
  includePatients: true,
  // 只輸出對得到病人的床；設 false（或 --keep-unmatched）則空床的資料也一起輸出。
  // primary 查失敗時一律不濾，否則會產出空檔案。
  onlyMatchedBeds: true,
  // 非週期性資料（NBP 這類間歇量測）。不是環狀表，單純一張，直接照時間窗撈。
  // 欄位與週期表一樣，撈回來併進同一個陣列。
  aperiodic: {
    enabled: true,
    table: 'UnvalidatedDeviceAperiodicData',
  },
  patientSqlFile: 'sql/patients.sql',
  // 沒指定 patientDatabase、SQL 檔也沒寫 USE 時，最後再試這些常見名稱。
  // ICCA 的病人資料慣例上在 CISPrimaryDB，但 databases[] 裡的 primary 常寫成別的用途。
  patientDatabaseFallbacks: ['CISPrimaryDB'],
  defaultPrimary: null,
  // CDS 資料庫的判斷方式（用來從 databases[] 裡自動分辨 cds 與 primary）
  cdsDatabasePattern: '^CDSUnvalidatedData',
  // 只放定位 head 用得到的：表名怎麼組（tablePrefix/start/count/pad）、
  // 哪一欄代表最後寫入（headColumn）、哪一欄是量測時間（timeColumn）。
  // 撈資料的排序寫死在 fetchVitals 裡，不必再開一個 orderColumn。
  ring: {
    tablePrefix: 'UnvalidatedDevicePeriodicData_',
    start: 0,
    count: 26,
    pad: 2,
    headColumn: 'storeTime',
    timeColumn: 'measurementTime',
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
  // 巢狀區塊要逐層疊，否則只寫其中一個鍵會把其餘預設值蓋掉
  v.aperiodic = { ...DEFAULTS.aperiodic, ...((cfg.vitals || {}).aperiodic || {}) };
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
 * terseLabel / propName 有出現時會一起收下來，之後原名放進每筆資料裡。
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
 * 這裡用 name 索引起來，站台才能用名字互相引用。IP 與密碼都不必再抄一次。
 */
function buildConnectionRegistry(cfg) {
  const reg = new Map();
  for (const d of cfg.databases || []) if (d && d.name && d.connection) reg.set(d.name, d.connection);
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

// ---------- 從 primary 撈目前在床的病人 ----------

/**
 * 把 SSMS 習慣寫的 USE / GO 拿掉。
 * mssql 一次送的是單一批次，GO 只是 SSMS 的分批指令，留著會變成語法錯誤；
 * USE 則改由 databaseFromSql() 讀出來當連線的資料庫（見下面）。
 * 直接把 sql 檔從 SSMS 貼過來也能跑。
 */
function stripBatchDirectives(sqlText) {
  return String(sqlText)
    .replace(/^﻿/, '')
    .replace(/^[ \t]*USE[ \t]+[^\r\n;]+;?[ \t]*$/gim, '')
    .replace(/^[ \t]*GO[ \t]*;?[ \t]*$/gim, '');
}

/**
 * 讀出 SQL 檔裡的 USE <資料庫>。
 *
 * 這行不能只是丟掉：primary 那筆連線設定寫的資料庫（例如 ICCA_DB01）不一定就是病人資料
 * 所在的 CISPrimaryDB，直接照設定連過去會變成「找不到 dbo.PtLocationStay」，
 * 然後病歷號整排 null。你在 SSMS 寫的 USE 就是答案，照著連即可。
 */
function databaseFromSql(sqlText) {
  const m = String(sqlText).match(/^[ \t]*USE[ \t]+\[?([^\]\r\n;]+?)\]?[ \t]*;?[ \t]*$/im);
  return m ? m[1].trim() : null;
}

/**
 * 床號正規化。兩邊的床號是各自維護的字串（primary 的 Bed.displayLabel、
 * CDS 的 UdsBed.label），大小寫或前後空白不一樣就會對不上，所以比對前統一：
 * 去頭尾空白、內部連續空白縮成一個、轉大寫。全形空白也一併處理。
 */
function normBed(v) {
  return String(v == null ? '' : v)
    .replace(/[\s　]+/g, ' ')
    .trim()
    .toUpperCase();
}

/**
 * 把查回來的列變成 Map<床號, { lifetimeNumber, encounterNumber }>。
 *
 * 鑰匙是床號：primary 的 Bed.displayLabel 對 CDS 的 UdsBed.label。
 * 欄名就照 patients.sql 的 bed / lifetimeNumber / encounterNumber。
 *
 * 回傳 { byBed, duplicates }。床號不像 bedId 保證唯一——不同單位可能有同名的床，
 * 撞在一起會把病歷號接到別人身上，所以重複的要回報出來，不能默默吃掉。
 */
function indexPatientsByBed(rows) {
  const byBed = new Map();
  const duplicates = new Set();
  for (const row of rows || []) {
    const key = normBed(row.bed);
    if (!key) continue;
    const rec = {
      lifetimeNumber: row.lifetimeNumber != null ? row.lifetimeNumber : null,
      encounterNumber: row.encounterNumber != null ? row.encounterNumber : null,
    };
    const prev = byBed.get(key);
    if (prev) {
      // 同一個床號兩位病人＝真的撞號（或 SQL 沒濾乾淨），記下來給呼叫端警告
      if (prev.lifetimeNumber !== rec.lifetimeNumber) duplicates.add(key);
      // 沒有病歷號的那筆不要蓋掉有的，否則欄位明明查得到卻是 null
      if (prev.lifetimeNumber != null || rec.lifetimeNumber == null) continue;
    }
    byBed.set(key, rec);
  }
  return { byBed, duplicates: [...duplicates] };
}

/** 給測試與外部呼叫用：連線跑一次 SQL 再索引起來（只回 Map） */
async function fetchPatients(pool, sqlText) {
  const r = await pool.request().query(stripBatchDirectives(sqlText));
  return indexPatientsByBed(r.recordset || []).byBed;
}

/**
 * 病人資料要連哪個資料庫，由高到低：
 *   --patients-db > 站台 patientDatabase > vitals.patientDatabase
 *   > SQL 檔裡的 USE > primary 連線設定本身的 database > patientDatabaseFallbacks
 *
 * 沒有明講時會依序試，第一個成功的就採用（並印出來，方便你回頭寫進設定）。
 * 會有 fallback 是因為 databases[] 裡那筆 primary 的 database 常常是給別的用途寫的
 * （例如 index.js 的範例查詢），未必是病人資料所在的 CISPrimaryDB；連錯的症狀就是
 * 「找不到 dbo.PtLocationStay」→ 病歷號整排 null。
 */
function patientDatabaseCandidates(sqlText, primary, site, settings, cliDb) {
  const pinned = cliDb || site.patientDatabase || settings.patientDatabase;
  if (pinned) return [pinned];
  const fallbacks = settings.patientDatabaseFallbacks || DEFAULTS.patientDatabaseFallbacks || [];
  const list = [databaseFromSql(sqlText), primary.database, ...fallbacks];
  return [...new Set(list.filter(Boolean))];
}

/**
 * 病人查詢要用的東西：SQL 內容、primary 連線、候選資料庫。
 * 正常執行（loadPatients）與診斷（--check-patients）共用同一份判斷，兩邊才不會走鐘。
 * 缺東西時回傳 { error }，由呼叫端決定是要警告後略過，還是直接中止。
 */
function resolvePatientQuery(site, settings, args, registry, siteName) {
  const sqlFile = args.patientSqlFile || site.patientSqlFile || settings.patientSqlFile;
  if (!sqlFile) return { error: '沒有設定 patientSqlFile' };
  const abs = path.resolve(process.cwd(), sqlFile);
  if (!fs.existsSync(abs)) return { error: `找不到病人 SQL ${abs}` };

  const primaryRef = site.primary || settings.defaultPrimary;
  if (!primaryRef) return { error: '沒有可用的 primary（站台 primary 或 defaultPrimary）' };
  const primary = resolveConn(primaryRef, registry, 'primary', siteName);
  const sqlText = fs.readFileSync(abs, 'utf8');

  return {
    sqlFile,
    sqlText,
    primary,
    key: typeof primaryRef === 'string' ? primaryRef : `${primary.server}/${primary.database}`,
    candidates: patientDatabaseCandidates(sqlText, primary, site, settings, args.patientDb),
  };
}

/**
 * 依序試候選資料庫，第一個查成功的就回傳。
 * 會有這個迴圈是因為連錯資料庫（找不到 dbo.PtLocationStay）是最常見的失敗，
 * 換下一個候選再試就好。回傳 { database, rows, errors }，database 是 null 代表全滅。
 */
async function runPatientSql(primary, candidates, sqlText, timeout) {
  const errors = [];
  for (const database of candidates) {
    let pool;
    try {
      pool = await connect({ ...primary, database }, timeout);
      const r = await pool.request().query(stripBatchDirectives(sqlText));
      return { database, rows: r.recordset || [], errors };
    } catch (e) {
      errors.push({ database, message: e.message });
    } finally {
      if (pool) { try { await pool.close(); } catch (_) {} }
    }
  }
  return { database: null, rows: null, errors };
}

/**
 * 查病人是「有就加分」的事：primary 連不上、SQL 檔不見、查詢失敗，都只警告，
 * 儀器資料照樣輸出，病人欄位留 null。不要讓 primary 拖垮整個排程。
 * 多個 CDS 共用同一台 primary 時只查一次（primaryCache）。
 */
async function loadPatients(site, settings, args, registry, siteName, timeout) {
  const q = resolvePatientQuery(site, settings, args, registry, siteName);
  if (q.error) {
    console.warn(`  [${siteName}] ${q.error}，這次不帶病歷號`);
    return null;
  }

  // 失敗在快取的函式裡面就吃掉，讓它一律 resolve；否則被共用的 promise 一旦 reject，
  // 還沒接上 handler 的站台會冒出 unhandled rejection。
  return discoverOnce(`patients:${q.key}:${q.candidates.join('|')}`, async () => {
    const { database, rows, errors } = await runPatientSql(q.primary, q.candidates, q.sqlText, timeout);
    if (!database) {
      console.warn(
        `  ⚠ [primary ${q.key}] 查病人資料失敗，病歷號會是 null（儀器資料照常輸出）\n` +
          errors.map((e) => `      ${e.database}：${e.message}`).join('\n') +
          `\n      診斷：node vitals.js --check-patients`
      );
      return null;
    }

    const { byBed, duplicates } = indexPatientsByBed(rows);
    const noMrn = [...byBed.values()].filter((p) => p.lifetimeNumber == null).length;
    console.log(
      `  [primary ${q.key}→${database}] 線上病人：${byBed.size} 床` +
        (noMrn ? `（其中 ${noMrn} 床沒有病歷號）` : '') +
        `（${q.sqlFile}）`
    );
    if (!byBed.size) {
      console.warn(`  ⚠ ${database} 查得到但沒有任何在床病人，病歷號會是 null。用 --check-patients 看細節`);
    }
    // 床號不像 bedId 保證唯一，撞號會把病歷號接到別人身上，一定要講出來
    if (duplicates.length) {
      console.warn(
        `  ⚠ [primary ${q.key}] 有 ${duplicates.length} 個床號對到多位病人：${duplicates.slice(0, 5).join(', ')}` +
          (duplicates.length > 5 ? ' …' : '') +
          `\n      這些床只會接到其中一位，patients.sql 需要再限定單位（clinicalUnit）`
      );
    }
    return byBed;
  });
}

// ---------- 病人資料自我檢查（--check-patients）----------
/**
 * 病歷號整排 null 有三種完全不同的成因，靠正常執行的訊息分不出來：
 *   1. primary 連錯資料庫 → 找不到 dbo.PtLocationStay，查詢整個失敗
 *   2. 查得到但沒有在床病人 → 0 列
 *   3. 查得到、也有病人，但床號跟 CDS 的寫法不一樣 → 對不起來
 * 這裡把三段各自跑一次並印出實際數字與樣本，直接指出是哪一種。只讀資料，不寫任何東西。
 */
async function checkPatients(sites, settings, args, registry) {
  const timeout = settings.queryTimeoutMs || 60000;
  console.log(`\n[病人資料自我檢查]\n`);

  // --- 1. primary ---
  const q = resolvePatientQuery({}, settings, args, registry, 'primary');
  if (q.error) return console.error(`✗ ${q.error}`);

  console.log(`1. primary：${q.key} → ${q.primary.server}:${q.primary.port || 1433}`);
  console.log(`   SQL：${q.sqlFile}`);
  console.log(
    `   候選資料庫：${q.candidates.join(' → ')}` + (databaseFromSql(q.sqlText) ? '（第一個來自 SQL 裡的 USE）' : '')
  );

  const { database: usedDb, rows, errors } = await runPatientSql(q.primary, q.candidates, q.sqlText, timeout);
  for (const e of errors) console.log(`   ✗ ${e.database}：${e.message}`);
  if (!usedDb) {
    console.log(`\n結論：primary 這一段就沒過。若錯誤是「無效的物件名稱 dbo.PtLocationStay」，`);
    console.log(`      表示連到的不是病人資料所在的資料庫——在 SQL 檔開頭寫 USE <資料庫>，`);
    console.log(`      或在 vitals 區塊加 "patientDatabase": "<資料庫>"，也可以直接 --patients-db <資料庫>。`);
    return;
  }
  console.log(`   ✓ ${usedDb}：查詢成功，${rows.length} 列`);

  // --- 2. 查回來的內容 ---
  const { byBed: patients, duplicates } = indexPatientsByBed(rows);
  const sample = rows.slice(0, 3);
  const vals = [...patients.values()];
  const nulls = (k) => vals.filter((v) => v[k] == null).length;
  console.log(`\n2. 查回來的病人：${patients.size} 個不同的床號`);
  if (!patients.size) {
    console.log(`   ⚠ 一列都沒有（或每一列的床號都是空的）。SQL 的條件是 endDate IS NULL，`);
    console.log(`     這台 primary 現在可能真的沒有在床病人，或者床位資料在另一個資料庫。`);
    return;
  }
  console.log(`   空值：lifetimeNumber ${nulls('lifetimeNumber')} / encounterNumber ${nulls('encounterNumber')}（共 ${patients.size}）`);
  if (duplicates.length) {
    console.log(`   ⚠ 有 ${duplicates.length} 個床號對到多位病人：${duplicates.slice(0, 5).join(', ')}`);
    console.log(`     床號不像 bedId 保證唯一，這些床會接到其中一位，patients.sql 需要再限定單位`);
  }
  console.log(`   前幾列：`);
  for (const row of sample) {
    console.log(`     bed=${row.bed}  lifetimeNumber=${row.lifetimeNumber}  encounterNumber=${row.encounterNumber}`);
  }
  const ptKeys = [...patients.keys()];

  // --- 3. 跟各站 CDS 的床號對一次 ---
  console.log(`\n3. 跟 CDS 的床號對照（UdsBed.label 對 Bed.displayLabel）`);
  let anyMatch = 0;
  for (const site of sites) {
    const conn = resolveConn(site.cds, registry, 'cds', site.name);
    let pool;
    try {
      pool = await connect(conn, timeout);
      const r = await pool.request().query(
        'SET LOCK_TIMEOUT 3000; SELECT label FROM dbo.UdsBed WITH (NOLOCK)'
      );
      const beds = (r.recordset || []).map((b) => b.label);
      const hit = beds.filter((label) => patients.has(normBed(label)));
      anyMatch += hit.length;
      console.log(
        `   ${site.name}：UdsBed ${beds.length} 床，其中 ${hit.length} 床對得上 primary` +
          (hit.length ? `（例：${hit.slice(0, 3).join('、')}）` : '')
      );
      if (!hit.length && beds.length) {
        console.log(`     CDS 的床號例：${beds.slice(0, 5).join(', ')}`);
      }
    } catch (e) {
      console.log(`   ${site.name}：✗ ${e.message}`);
    } finally {
      if (pool) { try { await pool.close(); } catch (_) {} }
    }
  }

  console.log(`\n結論：`);
  if (anyMatch) {
    console.log(`  ✓ 三段都通（primary=${usedDb}）。正常執行就會帶出病歷號；`);
    console.log(`    把 "patientDatabase": "${usedDb}" 寫進 databases.config.json 的 vitals 區塊可以省掉試連。`);
  } else {
    console.log(`  ✗ primary 查得到病人，但沒有任何一床的床號對得上 CDS。`);
    console.log(`    primary 的床號例：${ptKeys.slice(0, 5).join(', ')}`);
    console.log(`    比對前已經去空白、轉大寫，還是對不上就是寫法本身不同（前綴、補零、全形），`);
    console.log(`    要在 patients.sql 裡把 displayLabel 調成跟 CDS 的 UdsBed.label 一致。`);
  }
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

  // bed（UdsBed.label）就是接 primary 病人資料的鑰匙，本來就要輸出，不必再多撈 bedId
  const COLS = 'bed, parameterId, numericValue, measurementTime, storeTime';

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

// ---------- 非週期性資料（UnvalidatedDeviceAperiodicData）----------
/**
 * NBP、心輸出量這類「間歇量測」不在週期表裡，是另外一張非週期表。
 *
 * 它不是環狀表，就單純一張，所以不必定位寫入頭，直接照時間窗撈即可。
 * 欄位名稱與週期表完全一樣（bed / parameterId / numericValue / measurementTime /
 * storeTime），所以直接沿用 fetchVitals，撈回來併進同一個陣列，
 * 下游（病人對應、時區換算、輸出）完全共用。
 *
 * 唯一的差別是不降頻：這種資料本來就稀疏（NBP 可能 15 分鐘才一筆），每一筆都要留。
 */
async function collectAperiodic(pool, { table, parameterIds, windowMinutes, settings, name }) {
  const rows = await fetchVitals(pool, table, parameterIds, windowMinutes, { ...settings, perMinute: false });
  console.log(`  [${name}] 非週期性（${table}）：${rows.length} 筆`);
  return rows;
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

/**
 * 檔名用的時間戳：yyyyMMddHHmm（到分鐘），例如 202607231111。
 * 跟輸出內容用同一個時區偏移（預設 +8），所以在 UTC 的機器上跑，
 * 檔名也不會跟檔案裡的時間差 8 小時。
 */
function fileStamp(offsetHours = 8, now = new Date()) {
  const d = new Date(now.getTime() + offsetHours * 3600e3);
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}`
  );
}

/** 輸出檔名裡的 {ts} 換成時間戳；沒有 {ts} 的名字原樣使用（固定檔名） */
function resolveOutputName(name, offsetHours) {
  return String(name).replace(/\{ts\}/g, fileStamp(offsetHours));
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
    const found = await discoverOnce(`params:${key}`, async () => {
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

  // 1.5 病人資料先發出去，跟 CDS 的查詢並行跑，最後再用床號併起來。
  //     這裡刻意不 await，不然 primary 慢的時候會白等。
  const wantPatients = !args.noPatients && settings.includePatients !== false;
  const patientsPromise = wantPatients
    ? loadPatients(site, settings, args, registry, name, timeout).catch((e) => {
        // 連 primary 都解不開名字這種設定問題也不該擋掉儀器資料
        console.warn(`  [${name}] 病人資料取不到：${e.message}（儀器資料照常輸出）`);
        return null;
      })
    : Promise.resolve(null);

  // 2. 連 CDS，定位目前的寫入頭
  const cdsConn = resolveConn(site.cds, registry, 'cds', name);
  if (!cdsConn) throw new Error(`站台 ${name} 沒有設定 cds 連線`);
  const pool = await connect(cdsConn, timeout);
  try {
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
    const periodicCount = rows.length;

    // 3.5 非週期性資料（NBP 這類間歇量測）併進同一個陣列。
    // 欄位名稱與週期表一樣，所以下游（病人對應、時區換算、輸出）完全共用。
    // 這一段失敗只警告：週期性資料才是主體，不該被它拖垮整站。
    const apCfg = { ...(settings.aperiodic || {}), ...(site.aperiodic || {}) };
    let aperiodicCount = 0;
    if (apCfg.enabled !== false && !args.noAperiodic) {
      try {
        const got = await collectAperiodic(pool, {
          table: apCfg.table || DEFAULTS.aperiodic.table,
          parameterIds,
          windowMinutes,
          settings,
          name,
        });
        aperiodicCount = got.length;
        rows.push(...got);
      } catch (e) {
        console.warn(`  ⚠ [${name}] 非週期性資料撈取失敗：${e.message}（週期性資料照常輸出）`);
      }
    }

    // 4. 併上病人資料（primary）＋站台標記＋本地時間
    const patients = await patientsPromise;
    const matchedBeds = new Set();
    const unmatchedBeds = new Set();
    let dropped = 0;

    if (patients) {
      for (const r of rows) {
        const key = normBed(r.bed);
        (patients.has(key) ? matchedBeds : unmatchedBeds).add(key);
      }
    }

    // 沒對到病人的床不輸出（空床、測試機、還沒收床的儀器都會落在這裡）。
    // 但 primary 查失敗時（patients 是 null）不能濾——那時每一床都「對不到」，
    // 一濾就變成空檔案，一次 primary 故障會看起來像全院沒資料。
    const dropUnmatched = patients && !args.keepUnmatched && settings.onlyMatchedBeds !== false;
    if (dropUnmatched) {
      const before = rows.length;
      rows = rows.filter((r) => patients.has(normBed(r.bed)));
      dropped = before - rows.length;
    }

    const offset = settings.displayTimezoneOffsetHours != null ? settings.displayTimezoneOffsetHours : 8;
    rows = rows.map((r) => {
      // 用床號對 primary：CDS 的 UdsBed.label 對 Bed.displayLabel（bed 本身照樣輸出）
      const pt = patients ? patients.get(normBed(r.bed)) : null;
      // terseLabel 是臨床項目（HR、ABP、體溫…），propName 是細項（systolic/diastolic/mean）
      // 兩者來自 parameterId 清單，欄名沿用 CdsParameterMap 的原始欄名
      const base = {
        _site: name,
        // 有要查病人才放這兩欄；--no-patients 時整組不出現，不留一排 null
        ...(wantPatients
          ? {
              lifetimeNumber: pt ? pt.lifetimeNumber : null, // 病歷號
              encounterNumber: pt ? pt.encounterNumber : null, // 住院帳號
            }
          : {}),
        terseLabel: labels[r.parameterId] || null,
        propName: props[r.parameterId] || null,
        ...r,
      };
      // 預設把時間換算成本地時區；--utc 則保留 DB 原始的 UTC 值
      return args.utc || settings.timesInUtc ? base : shiftTimes(base, offset);
    });

    if (patients) {
      console.log(
        `  [${name}] 病人對應：${matchedBeds.size} 床接上病歷號` +
          (dropped ? `，捨棄 ${unmatchedBeds.size} 床 / ${dropped} 筆沒對到病人的資料` : '') +
          (!dropUnmatched && unmatchedBeds.size ? `，${unmatchedBeds.size} 床沒對到（保留輸出）` : '')
      );
      // 一床都對不上通常不是「病人沒躺床」，是兩邊床號的寫法不一樣（前綴、補零、全形）。
      // 這時 rows 已經被濾空，所以樣本要從 unmatchedBeds 拿。
      if (!matchedBeds.size && patients.size) {
        const cdsSample = [...unmatchedBeds].slice(0, 5).join(', ');
        const ptSample = [...patients.keys()].slice(0, 5).join(', ');
        console.warn(
          `  ⚠ [${name}] 一床都對不上，這站等於沒有資料——CDS 的床號例：${cdsSample}；primary 的床號例：${ptSample}\n` +
            `      兩邊寫法不同的話要調整 patients.sql，先跑 node vitals.js --check-patients`
        );
      }
    }

    return {
      name,
      ok: true,
      headTable: head.table,
      tablesQueried: targets.map((s) => s.table),
      dbTimeUtc: ring.fmtDb(head.maxTime),
      count: rows.length,
      periodicRows: periodicCount,
      aperiodicRows: aperiodicCount,
      patientBeds: patients ? matchedBeds.size : null,
      unmatchedBeds: patients ? unmatchedBeds.size : null,
      droppedRows: patients ? dropped : null,
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
  // 檔名裡的 {ts} 在這裡就換掉，dry-run 印出來的與實際寫出的是同一個名字
  const outFile = resolveOutputName(
    args.out || settings.output,
    settings.displayTimezoneOffsetHours != null ? settings.displayTimezoneOffsetHours : 8
  );
  const registry = buildConnectionRegistry(cfg);
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

  // --check-patients：專門診斷病歷號為什麼是 null，只讀資料、不輸出檔案
  if (args.checkPatients) return checkPatients(sites, settings, args, registry);

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

    // 病人資料
    const wantPatients = !args.noPatients && settings.includePatients !== false;
    const ptFile = args.patientSqlFile || settings.patientSqlFile;
    if (!wantPatients) {
      console.log(`\n病人資料：不查（--no-patients / includePatients=false）`);
    } else if (!ptFile) {
      console.log(`\n病人資料：沒有設定 patientSqlFile，不會帶病歷號`);
    } else if (!fs.existsSync(path.resolve(process.cwd(), ptFile))) {
      console.log(`\n病人資料：⚠ 找不到 ${ptFile}，實際執行時會略過病歷號`);
    } else {
      const primaryRef = settings.defaultPrimary;
      if (!primaryRef) {
        console.log(`\n病人資料：⚠ 沒有可用的 primary，實際執行時會略過病歷號`);
      } else {
        const pc = resolveConn(primaryRef, registry, 'primary', 'primary');
        const ptSql = fs.readFileSync(path.resolve(process.cwd(), ptFile), 'utf8');
        const cands = patientDatabaseCandidates(ptSql, pc, {}, settings, args.patientDb);
        console.log(`\n病人資料：${ptFile} → primary ${primaryRef}（${pc.server}:${pc.port || 1433}），用床號對應`);
        console.log(
          `          資料庫：${cands.join(' → ')}` +
            (cands.length > 1 ? '（依序試，第一個成功的採用；--check-patients 可先確認）' : '')
        );
      }
    }

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
        periodicRows: s.value.periodicRows,
        aperiodicRows: s.value.aperiodicRows,
        patientBeds: s.value.patientBeds,
        unmatchedBeds: s.value.unmatchedBeds,
        droppedRows: s.value.droppedRows,
        scanMs: s.value.scanMs,
        fetchMs: s.value.fetchMs,
      });
      console.log(
        `  ✓ ${name}：${s.value.count} 筆` +
          (s.value.aperiodicRows ? `（含非週期 ${s.value.aperiodicRows} 筆）` : '') +
          `（${s.value.headTable}，掃描 ${s.value.scanMs}ms + 撈取 ${s.value.fetchMs}ms）`
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
  fetchPatients,
  indexPatientsByBed,
  stripBatchDirectives,
  databaseFromSql,
  patientDatabaseCandidates,
  fetchVitals,
  fileStamp,
  resolveOutputName,
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
