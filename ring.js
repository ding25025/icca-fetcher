#!/usr/bin/env node
'use strict';

/**
 * 環狀資料表（Ring Buffer）工具
 * -------------------------------------------------
 * 針對 UnvalidatedDevicePeriodicData_00 ~ _25 這種「循環寫入」的資料表：
 *   資料輪流寫進 N 張表，寫到最後一張再繞回第一張，
 *   所以「最新的那張表」會一直輪動。
 *
 * 做法：對每張表跑 SELECT MAX(headColumn), COUNT(*)，
 *   時間最新的那張就是目前的「寫入頭 (head)」；
 *   從 head 往回繞（head, head-1, ... 繞過 _00 再接 _25）即可排出由新到舊的順序。
 *
 * 兩個時間欄的分工：
 *   headColumn  (storeTime)       寫入資料庫的時間 → 決定環狀輪動位置、判斷 head
 *   timeColumn  (measurementTime) 儀器量測的時間   → 排序資料、--from/--to 過濾
 *   後補上傳的資料（isTrendUpload）量測時間會比寫入時間舊很多，
 *   用 measurementTime 判斷 head 有機會指錯表，所以兩者要分開。
 *
 * 五種模式（設定檔的 "mode"）：
 *   "head"     只找出目前的寫入頭是哪一張表
 *   "order"    列出 26 張表由新到舊（或舊到新）的順序與各表狀態
 *   "latest"   從 head 開始跨表撈出「最新 N 筆」資料，輸出成 JSON
 *   "byParam"  每個 parameterId 各自撈滿最新 N 筆（避免某個參數把額度吃光）
 *   "params"   列出資料表裡有哪些 parameterId / label / units 與筆數
 *
 * 用法：
 *   node ring.js                          使用 ring.config.json
 *   node ring.js --config my.json         指定設定檔
 *   node ring.js --mode head              覆寫模式
 *   node ring.js --param 4102,4103        只撈這些 parameterId
 *   node ring.js --mode params --all      掃描全部 26 張表列出參數清單
 *   node ring.js --out result.json        覆寫輸出檔
 *   node ring.js --pretty
 */

const fs = require('fs');
const path = require('path');
const sql = require('mssql');

// ---------- 命令列參數 ----------
function parseArgs(argv) {
  const a = {
    config: 'ring.config.json',
    out: null,
    mode: null,
    pretty: false,
    param: null,
    patient: null,
    device: null,
    from: null,
    to: null,
    limit: null,
    allTables: false,
    at: null,
    by: null,
    fetch: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--config' || t === '-c') a.config = argv[++i];
    else if (t === '--out' || t === '-o') a.out = argv[++i];
    else if (t === '--mode' || t === '-m') a.mode = argv[++i];
    else if (t === '--pretty' || t === '-p') a.pretty = true;
    else if (t === '--param' || t === '--parameter-id') a.param = argv[++i];
    else if (t === '--patient') a.patient = argv[++i];
    else if (t === '--device') a.device = argv[++i];
    else if (t === '--from') a.from = argv[++i];
    else if (t === '--to') a.to = argv[++i];
    else if (t === '--limit' || t === '-n') a.limit = Number(argv[++i]);
    else if (t === '--all' || t === '--all-tables') a.allTables = true;
    else if (t === '--at') a.at = argv[++i];
    else if (t === '--by') a.by = argv[++i];
    else if (t === '--fetch') a.fetch = true;
    else if (t === '--tz-offset') a.tzOffset = Number(argv[++i]);
    else if (t === '--help' || t === '-h') a.help = true;
  }
  return a;
}

function printHelp() {
  console.log(`
環狀資料表工具

  node ring.js [選項]

選項：
  -c, --config <檔案>   設定檔（預設 ring.config.json）
  -m, --mode <模式>     head | order | at | latest | byParam | params（覆寫設定檔）
  -o, --out <檔案>      輸出 JSON 檔
  -n, --limit <筆數>    覆寫 latestN
      --at <時間>       at 模式：要查哪個時間點，預設 now
      --by <軸>         at 模式比對哪個時間軸：store（預設）| measure
      --fetch           at 模式順便把該表的資料撈出來
      --tz-offset <時>  DB 時鐘比本機快幾小時（不給則自動偵測，台灣多半是 8）
      --param <ids>     只撈這些 parameterId，逗號分隔，例如 4102,4103
      --patient <id>    只撈這個 patientIdentifier
      --device <id>     只撈這個 deviceInstanceId
      --from <時間>     measurementTime >= 此時間（ISO 字串）
      --to <時間>       measurementTime <  此時間（ISO 字串）
      --all             params 模式掃描全部資料表（預設只掃 head）
  -p, --pretty         美化縮排輸出
  -h, --help           顯示說明

範例：
  node ring.js --mode at --pretty                        現在時間對應哪張表
  node ring.js --mode at --at "2026-07-22 03:00" -p      指定時間點對應哪張表
  node ring.js --mode at --at 03:00 --fetch --param 4102 定位後順便撈該表的資料
  node ring.js --mode params --pretty                    先看有哪些 parameterId
  node ring.js --mode latest --param 4102 -n 500 -p      撈某個參數最新 500 筆
  node ring.js --mode byParam --param 4102,4103 -n 200   兩個參數各撈 200 筆
`);
}

function loadConfig(configPath) {
  const abs = path.resolve(process.cwd(), configPath);
  if (!fs.existsSync(abs)) throw new Error(`找不到設定檔：${abs}`);
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    throw new Error(`設定檔 JSON 格式錯誤：${e.message}`);
  }
  if (!cfg.connection) throw new Error('設定檔缺少 "connection"');
  if (!cfg.ring) throw new Error('設定檔缺少 "ring"');
  return cfg;
}

// 密碼 / 帳號可寫成 "env:變數名" 從環境變數讀取
function resolveSecret(value) {
  if (typeof value === 'string' && value.startsWith('env:')) {
    const key = value.slice(4);
    const v = process.env[key];
    if (v === undefined) throw new Error(`環境變數 ${key} 未設定`);
    return v;
  }
  return value;
}

// 防注入：識別字（表名/欄名）只允許英數與底線
function safeIdent(name, label) {
  if (!/^[A-Za-z0-9_]+$/.test(String(name))) {
    throw new Error(`${label} 含有不允許的字元：${name}`);
  }
  return name;
}

// 依 ring 設定產生 26 張表名
function buildTableNames(ring) {
  const { tablePrefix, start = 0, count, pad = 2 } = ring;
  if (!tablePrefix) throw new Error('ring.tablePrefix 未設定');
  if (!count || count < 1) throw new Error('ring.count 必須 >= 1');
  safeIdent(tablePrefix, 'tablePrefix');
  const names = [];
  for (let i = 0; i < count; i++) {
    const num = String(start + i).padStart(pad, '0');
    names.push({ index: i, table: `${tablePrefix}${num}` });
  }
  return names;
}

// ---------- 過濾條件（全部走參數化查詢） ----------

// 把 4102 / "4102,4103" / [4102, 4103] 統一成陣列
function toList(v) {
  if (v == null || v === '') return [];
  const arr = Array.isArray(v) ? v : String(v).split(',');
  return arr.map((x) => (typeof x === 'string' ? x.trim() : x)).filter((x) => x !== '' && x != null);
}

// parameterId 在 ICCA 通常是整數，但保留字串型別的可能
function bindValue(request, name, value) {
  if (typeof value === 'number' || /^-?\d+$/.test(String(value))) {
    request.input(name, sql.Int, Number(value));
  } else {
    request.input(name, sql.NVarChar(200), String(value));
  }
  return `@${name}`;
}

/**
 * 產生 WHERE 子句。回傳 { sql, apply(request) }
 * sql 內只含 @參數 佔位符與白名單過的欄名，值一律由 apply() 綁定。
 */
function buildWhere(ring, filter) {
  const parts = [];
  const binders = [];

  const paramCol = safeIdent(ring.parameterColumn || 'parameterId', 'parameterColumn');
  const ids = toList(filter.parameterId);
  if (ids.length) {
    parts.push(
      `[${paramCol}] IN (${ids.map((_, i) => `@pid${i}`).join(', ')})`
    );
    binders.push((req) => ids.forEach((v, i) => bindValue(req, `pid${i}`, v)));
  }

  const patients = toList(filter.patientIdentifier);
  if (patients.length) {
    const col = safeIdent(ring.patientColumn || 'patientIdentifier', 'patientColumn');
    parts.push(`[${col}] IN (${patients.map((_, i) => `@pat${i}`).join(', ')})`);
    binders.push((req) => patients.forEach((v, i) => bindValue(req, `pat${i}`, v)));
  }

  const devices = toList(filter.deviceInstanceId);
  if (devices.length) {
    const col = safeIdent(ring.deviceColumn || 'deviceInstanceId', 'deviceColumn');
    parts.push(`[${col}] IN (${devices.map((_, i) => `@dev${i}`).join(', ')})`);
    binders.push((req) => devices.forEach((v, i) => bindValue(req, `dev${i}`, v)));
  }

  const timeCol = safeIdent(ring.timeColumn, 'timeColumn');
  if (filter.timeFrom) {
    const d = new Date(filter.timeFrom);
    if (isNaN(d)) throw new Error(`timeFrom 不是合法時間：${filter.timeFrom}`);
    parts.push(`[${timeCol}] >= @tFrom`);
    binders.push((req) => req.input('tFrom', sql.DateTime2, d));
  }
  if (filter.timeTo) {
    const d = new Date(filter.timeTo);
    if (isNaN(d)) throw new Error(`timeTo 不是合法時間：${filter.timeTo}`);
    parts.push(`[${timeCol}] < @tTo`);
    binders.push((req) => req.input('tTo', sql.DateTime2, d));
  }

  return {
    sql: parts.length ? ` WHERE ${parts.join(' AND ')}` : '',
    active: parts.length > 0,
    apply(request) {
      binders.forEach((b) => b(request));
      return request;
    },
  };
}

// ---------- 掃描所有表的 MAX(時間) 與 COUNT ----------
// 注意：判斷 head 一律用「未過濾」的全表時間，否則過濾後空表會誤判寫入位置
async function scanRing(pool, tables, ring) {
  // headColumn 決定「這張表最後被寫入的時間」，用來定位寫入頭
  const headCol = safeIdent(headColumnOf(ring), 'headColumn');
  // timeColumn 是臨床量測時間，兩者不同時一起撈回來，方便交叉比對
  const timeCol = safeIdent(ring.timeColumn, 'timeColumn');
  const alt =
    headCol !== timeCol
      ? `, MAX([${timeCol}]) AS maxAltTime, MIN([${timeCol}]) AS minAltTime`
      : '';

  const stats = [];
  for (const t of tables) {
    const table = safeIdent(t.table, 'table');
    try {
      const r = await pool
        .request()
        .query(
          `SELECT MAX([${headCol}]) AS maxTime, MIN([${headCol}]) AS minTime, COUNT(*) AS cnt${alt} FROM [${table}]`
        );
      const row = r.recordset[0] || {};
      stats.push({
        index: t.index,
        table,
        maxTime: row.maxTime || null,
        minTime: row.minTime || null,
        maxAltTime: alt ? row.maxAltTime || null : null,
        minAltTime: alt ? row.minAltTime || null : null,
        count: Number(row.cnt) || 0,
        error: null,
      });
    } catch (e) {
      stats.push({
        index: t.index,
        table,
        maxTime: null,
        minTime: null,
        maxAltTime: null,
        minAltTime: null,
        count: 0,
        error: e.message,
      });
    }
  }
  return stats;
}

// ---------- 用時間點反查資料表 ----------

/**
 * 時區處理
 * -------------------------------------------------
 * mssql/tedious 預設 useUTC:true，會把 DB 裡沒有時區資訊的 datetime「當成 UTC」讀回來：
 * 資料表裡的 11:00 → JS Date 的 epoch 是 11:00Z。
 * 所以整個程式一律活在「DB 時鐘」這個座標系：DB 的字面值直接當 UTC 用。
 *
 * 唯一需要換算的是「現在幾點」——本機時鐘可能跟 DB 時鐘差好幾個時區
 * （台灣 UTC+8、DB 存本地時間時，DB 時鐘會比本機 epoch 快 8 小時）。
 * dbTimeOffsetHours 就是這個差值，沒設定時會自動從 head 的最後寫入時間推出來。
 */

// 把 DB 時間印成 SSMS 看得懂的樣子（就是資料表裡的字面值）
function fmtDb(v) {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d) ? null : d.toISOString().replace('T', ' ').slice(0, 19);
}

// 現在時間，換算成 DB 時鐘
function dbNow(offsetHours = 0, now = new Date()) {
  return new Date(now.getTime() + offsetHours * 3600e3);
}

/**
 * 自動偵測 DB 時鐘與本機的差距。
 * head 的最後寫入時間 ≈ 現在，兩者的差就是位移；時區位移一定落在整點附近，
 * 殘差太大代表不是時區問題（例如資料早就停止寫入了）。
 */
function detectOffsetHours(headMaxTime, now = new Date()) {
  if (!headMaxTime) return { hours: 0, confident: false, skewMinutes: null };
  const skewMinutes = (new Date(headMaxTime).getTime() - now.getTime()) / 60000;
  const hours = Math.round(skewMinutes / 60) || 0; // || 0 是為了把 -0 正規化成 0
  const residual = Math.abs(skewMinutes - hours * 60);
  return { hours, confident: residual <= 20, skewMinutes: Math.round(skewMinutes) || 0 };
}

/**
 * "now" / "03:00" / "2026-07-22 03:00" / ISO 字串 都可以。
 * 沒帶時區的輸入一律視為「DB 時鐘」的時間，也就是你在 SSMS 裡看到的那個數字。
 * 帶了 Z 或 +08:00 的 ISO 字串則尊重它自己的時區。
 */
function parseTimeInput(input, offsetHours = 0, now = new Date()) {
  const ref = dbNow(offsetHours, now);
  if (input == null || input === '' || input === 'now') return ref;

  const s = String(input).trim();

  // 只給 HH:MM 時，視為「今天的這個時間」；若比現在晚，當作昨天的
  const hhmm = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (hhmm) {
    const d = new Date(ref);
    d.setUTCHours(Number(hhmm[1]), Number(hhmm[2]), 0, 0);
    if (d > ref) d.setUTCDate(d.getUTCDate() - 1);
    return d;
  }

  // YYYY-MM-DD[ T]HH:MM[:SS] 且沒帶時區 → 當成 DB 時鐘的字面值
  const naive = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (naive) {
    const [, y, mo, da, h, mi, se] = naive;
    return new Date(Date.UTC(+y, +mo - 1, +da, +h, +mi, +(se || 0)));
  }
  // 只給日期
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (dateOnly) {
    const [, y, mo, da] = dateOnly;
    return new Date(Date.UTC(+y, +mo - 1, +da));
  }

  const d = new Date(s); // 帶時區的 ISO 字串
  if (isNaN(d)) throw new Error(`看不懂的時間格式：${input}（可用 now / HH:MM / YYYY-MM-DD HH:MM / ISO）`);
  return d;
}

// 依比對軸取出該表的時間範圍
function rangeOf(s, axis) {
  return axis === 'measure'
    ? { min: s.minAltTime || s.minTime, max: s.maxAltTime || s.maxTime }
    : { min: s.minTime, max: s.maxTime };
}

/**
 * 估算「一張表代表多久」：取相鄰兩張表 max 時間差的中位數。
 * 用中位數而非平均，才不會被「head 只寫到一半」或空表拉歪。
 */
function estimateRotation(orderedNewToOld, axis = 'store') {
  const deltas = [];
  for (let i = 0; i + 1 < orderedNewToOld.length; i++) {
    const a = rangeOf(orderedNewToOld[i], axis).max;
    const b = rangeOf(orderedNewToOld[i + 1], axis).max;
    if (!a || !b) continue;
    const d = new Date(a).getTime() - new Date(b).getTime();
    if (d > 0) deltas.push(d);
  }
  if (!deltas.length) return null;
  deltas.sort((x, y) => x - y);
  return deltas[Math.floor(deltas.length / 2)];
}

/**
 * 找出某個時間點落在哪一張表。
 * 直接比對各表的 [min, max] 實際區間，不靠「一張表一小時」的假設。
 */
function locateByTime(stats, targetMs, axis = 'store') {
  const usable = stats.filter((s) => !s.error && s.count > 0 && rangeOf(s, axis).min && rangeOf(s, axis).max);
  if (!usable.length) return { status: 'noData', table: null };

  let oldest = Infinity;
  let newest = -Infinity;
  for (const s of usable) {
    const { min, max } = rangeOf(s, axis);
    oldest = Math.min(oldest, new Date(min).getTime());
    newest = Math.max(newest, new Date(max).getTime());
  }
  const coverage = { oldest: new Date(oldest), newest: new Date(newest) };

  // 命中：時間點落在某張表的區間內。理論上只會有一張，但實務上可能有邊界重疊
  const hits = usable.filter((s) => {
    const { min, max } = rangeOf(s, axis);
    return targetMs >= new Date(min).getTime() && targetMs <= new Date(max).getTime();
  });

  if (hits.length) {
    // 多張命中時，取「離區間中點最近」的那張當主要答案
    const score = (s) => {
      const { min, max } = rangeOf(s, axis);
      const mid = (new Date(min).getTime() + new Date(max).getTime()) / 2;
      return Math.abs(targetMs - mid);
    };
    const sorted = [...hits].sort((a, b) => score(a) - score(b));
    return { status: 'ok', table: sorted[0], overlaps: sorted.slice(1), coverage };
  }

  if (targetMs > newest) {
    return { status: 'pending', table: null, coverage }; // 還沒寫進來（通常是 head 正在寫的那一小段）
  }
  if (targetMs < oldest) {
    return { status: 'overwritten', table: null, coverage }; // 已經被繞回來的新資料蓋掉
  }
  // 落在涵蓋範圍內但沒有任何表命中 → 該時段沒有資料（儀器沒上傳 / 系統停機）
  return { status: 'gap', table: null, coverage };
}

// 判斷 head 用的欄位：預設沿用 timeColumn，設了 headColumn 就以它為準
function headColumnOf(ring) {
  return ring.headColumn || ring.timeColumn;
}

// 找出寫入頭：指定欄位的 MAX 最新的那張表
function findHead(stats, field = 'maxTime') {
  let head = null;
  for (const s of stats) {
    if (s[field] == null) continue;
    const ts = new Date(s[field]).getTime();
    if (head == null || ts > head._ts) {
      head = { ...s, _ts: ts };
    }
  }
  return head; // 可能為 null（全部都空）
}

// 從 head 往回繞排出順序。newToOld：head, head-1, ... 繞一圈
function orderFromHead(stats, headIndex, direction) {
  const n = stats.length;
  const byIndex = new Map(stats.map((s) => [s.index, s]));
  const ordered = [];
  for (let k = 0; k < n; k++) {
    // head, head-1, head-2 ... 依環狀往回
    const idx = ((headIndex - k) % n + n) % n;
    ordered.push(byIndex.get(idx));
  }
  return direction === 'oldToNew' ? ordered.reverse() : ordered; // 預設 newToOld
}

// ---------- 撈最新 N 筆（從 head 跨表往回取）----------
async function fetchLatest(pool, orderedNewToOld, ring, latestN, filter) {
  const orderCol = safeIdent(ring.orderColumn || ring.timeColumn, 'orderColumn');
  const selectClause = ring.select && ring.select.trim() ? ring.select : '*';
  const where = buildWhere(ring, filter);
  const rows = [];

  for (const s of orderedNewToOld) {
    if (rows.length >= latestN) break;
    if (s.count === 0 || s.error) continue;
    const remaining = latestN - rows.length;
    const table = safeIdent(s.table, 'table');

    const req = pool.request().input('n', sql.Int, remaining);
    where.apply(req);
    const r = await req.query(
      `SELECT TOP (@n) ${selectClause} FROM [${table}]${where.sql} ORDER BY [${orderCol}] DESC`
    );

    if (r.recordset.length) {
      console.log(`  ${table}：+${r.recordset.length} 筆（累計 ${rows.length + r.recordset.length}）`);
    }
    for (const row of r.recordset) {
      rows.push({ _sourceTable: table, ...row });
    }
  }
  return rows;
}

// ---------- 從指定的單一資料表撈「該時間點之前」的資料 ----------
async function fetchAround(pool, stat, ring, limit, filter, axis, targetMs) {
  const orderCol = safeIdent(ring.orderColumn || ring.timeColumn, 'orderColumn');
  const axisCol = safeIdent(axis === 'measure' ? ring.timeColumn : headColumnOf(ring), 'axisColumn');
  const selectClause = ring.select && ring.select.trim() ? ring.select : '*';
  const where = buildWhere(ring, filter);
  const table = safeIdent(stat.table, 'table');

  const req = pool.request().input('n', sql.Int, limit).input('at', sql.DateTime2, new Date(targetMs));
  where.apply(req);
  const clause = where.sql ? `${where.sql} AND [${axisCol}] <= @at` : ` WHERE [${axisCol}] <= @at`;
  const r = await req.query(
    `SELECT TOP (@n) ${selectClause} FROM [${table}]${clause} ORDER BY [${orderCol}] DESC`
  );
  return r.recordset.map((row) => ({ _sourceTable: table, ...row }));
}

// ---------- 每個 parameterId 各撈滿 N 筆 ----------
async function fetchByParam(pool, orderedNewToOld, ring, latestN, filter) {
  const ids = toList(filter.parameterId);
  if (!ids.length) {
    throw new Error('byParam 模式需要指定 parameterId（--param 或設定檔 ring.filter.parameterId）');
  }
  const result = {};
  for (const id of ids) {
    // 每個參數各自跑一次 fetchLatest，額度不互搶
    const rows = await fetchLatest(pool, orderedNewToOld, ring, latestN, { ...filter, parameterId: id });
    result[id] = rows;
    console.log(`  parameterId ${id}：共 ${rows.length} 筆`);
  }
  return result;
}

// ---------- 列出有哪些 parameterId ----------
async function fetchParamCatalog(pool, targets, ring, filter) {
  const paramCol = safeIdent(ring.parameterColumn || 'parameterId', 'parameterColumn');
  const timeCol = safeIdent(ring.timeColumn, 'timeColumn');
  const where = buildWhere(ring, { ...filter, parameterId: null }); // 目錄模式不自我過濾 parameterId
  const acc = new Map();

  for (const s of targets) {
    if (s.count === 0 || s.error) continue;
    const table = safeIdent(s.table, 'table');
    const req = pool.request();
    where.apply(req);
    const r = await req.query(
      `SELECT [${paramCol}] AS parameterId, [label] AS label, [units] AS units,
              COUNT(*) AS cnt, MIN([${timeCol}]) AS minTime, MAX([${timeCol}]) AS maxTime
         FROM [${table}]${where.sql}
        GROUP BY [${paramCol}], [label], [units]`
    );
    for (const row of r.recordset) {
      const key = `${row.parameterId}|${row.label}|${row.units}`;
      const prev = acc.get(key);
      if (!prev) {
        acc.set(key, {
          parameterId: row.parameterId,
          label: row.label,
          units: row.units,
          count: Number(row.cnt) || 0,
          minTime: row.minTime || null,
          maxTime: row.maxTime || null,
          tables: [table],
        });
      } else {
        prev.count += Number(row.cnt) || 0;
        if (row.minTime && (!prev.minTime || new Date(row.minTime) < new Date(prev.minTime))) prev.minTime = row.minTime;
        if (row.maxTime && (!prev.maxTime || new Date(row.maxTime) > new Date(prev.maxTime))) prev.maxTime = row.maxTime;
        prev.tables.push(table);
      }
    }
    console.log(`  ${table}：${r.recordset.length} 種參數`);
  }

  return [...acc.values()]
    .sort((a, b) => b.count - a.count)
    .map((p) => ({ ...p, minTime: fmtDb(p.minTime), maxTime: fmtDb(p.maxTime) }));
}

// ---------- 主流程 ----------
async function main() {
  const args = parseArgs(process.argv);
  if (args.help) return printHelp();

  const cfg = loadConfig(args.config);
  const ring = cfg.ring;
  const mode = args.mode || cfg.mode || 'head';
  const outFile = args.out || cfg.output || 'ring-result.json';
  const direction = cfg.direction || 'newToOld';
  const latestN = args.limit || cfg.latestN || 100;
  // DB 時鐘比本機快幾小時。null = 自動偵測
  const tzOffsetOverride =
    Number.isFinite(args.tzOffset) ? args.tzOffset
    : Number.isFinite(cfg.dbTimeOffsetHours) ? cfg.dbTimeOffsetHours
    : null;

  // 過濾條件：設定檔 ring.filter 為底，命令列參數覆寫
  const filter = { ...(ring.filter || {}) };
  if (args.param != null) filter.parameterId = args.param;
  if (args.patient != null) filter.patientIdentifier = args.patient;
  if (args.device != null) filter.deviceInstanceId = args.device;
  if (args.from != null) filter.timeFrom = args.from;
  if (args.to != null) filter.timeTo = args.to;

  const conn = { ...cfg.connection };
  if (conn.password) conn.password = resolveSecret(conn.password);
  if (conn.user) conn.user = resolveSecret(conn.user);
  if (cfg.queryTimeoutMs) conn.requestTimeout = cfg.queryTimeoutMs;

  const tables = buildTableNames(ring);
  console.log(`連線中，準備掃描 ${tables.length} 張環狀資料表...`);

  const activeFilters = [];
  if (toList(filter.parameterId).length) activeFilters.push(`parameterId=${toList(filter.parameterId).join(',')}`);
  if (toList(filter.patientIdentifier).length) activeFilters.push(`patient=${toList(filter.patientIdentifier).join(',')}`);
  if (toList(filter.deviceInstanceId).length) activeFilters.push(`device=${toList(filter.deviceInstanceId).join(',')}`);
  if (filter.timeFrom) activeFilters.push(`from=${filter.timeFrom}`);
  if (filter.timeTo) activeFilters.push(`to=${filter.timeTo}`);
  if (activeFilters.length) console.log(`過濾條件：${activeFilters.join('　')}`);

  const pool = new sql.ConnectionPool(conn);
  let output;
  try {
    await pool.connect();
    const stats = await scanRing(pool, tables, ring);

    const errored = stats.filter((s) => s.error);
    if (errored.length) {
      errored.forEach((s) => console.error(`  ⚠ ${s.table} 掃描失敗：${s.error}`));
    }

    const headCol = headColumnOf(ring);
    const head = findHead(stats);
    if (!head) throw new Error('所有資料表都沒有可用的時間資料，無法判斷寫入頭');

    console.log(`目前寫入頭 (head)：${head.table}（依 ${headCol}）`);
    console.log(`  最後寫入時間：${fmtDb(head.maxTime)}（共 ${head.count} 筆）`);

    // --- DB 時鐘與本機時鐘的差 ---
    // 沒指定就自動偵測：head 的最後寫入時間 ≈ 現在，兩者的差就是時區位移
    const detected = detectOffsetHours(head.maxTime);
    const offsetHours = tzOffsetOverride != null ? tzOffsetOverride : detected.hours;
    if (tzOffsetOverride != null) {
      console.log(`  時區位移：+${offsetHours} 小時（手動指定）`);
      if (detected.confident && detected.hours !== tzOffsetOverride) {
        console.warn(`  ⚠ 但實測 head 與本機差 ${detected.hours} 小時，指定值可能有誤`);
      }
    } else if (offsetHours !== 0) {
      console.log(
        `  時區位移：DB 時鐘比本機快 ${offsetHours} 小時（自動偵測，實測差 ${detected.skewMinutes} 分）`
      );
      if (!detected.confident) {
        console.warn(
          '  ⚠ 差距不落在整點附近，可能不是時區問題而是資料已停止寫入；' +
            '可用 --tz-offset 0 關掉自動校正'
        );
      }
    }

    // headColumn 與 timeColumn 不同時，順手比對兩者算出來的 head 是否一致。
    // 不一致通常代表有後補上傳（isTrendUpload）的資料，量測時間比寫入時間舊很多。
    if (headCol !== ring.timeColumn) {
      const altHead = findHead(stats, 'maxAltTime');
      if (altHead && altHead.index !== head.index) {
        console.warn(
          `  ⚠ 依 ${ring.timeColumn} 判斷會得到 ${altHead.table}，與 ${headCol} 的結果不同；` +
            `以 ${headCol} 為準（寫入順序才是環狀輪動的依據）`
        );
      } else if (altHead) {
        console.log(`  （${ring.timeColumn} 判斷結果一致）`);
      }
    }

    // 使用者輸入的 --from/--to 也是 DB 時鐘的字面值，要用同一套規則解讀
    if (filter.timeFrom) filter.timeFrom = parseTimeInput(filter.timeFrom, offsetHours);
    if (filter.timeTo) filter.timeTo = parseTimeInput(filter.timeTo, offsetHours);

    const ordered = orderFromHead(stats, head.index, direction);
    // 撈資料一律先取 newToOld 順序，輸出再依 direction 調整
    const orderedNewToOld = direction === 'oldToNew' ? [...ordered].reverse() : ordered;

    if (mode === 'head') {
      output = {
        headTable: head.table,
        headIndex: head.index,
        headColumn: headCol,
        lastRecordTime: fmtDb(head.maxTime),
        tzOffsetHours: offsetHours,
        clockSkewMinutes: detected.skewMinutes,
        totalRows: stats.reduce((a, s) => a + s.count, 0),
      };
    } else if (mode === 'order') {
      output = ordered.map((s, rank) => ({
        rank,
        table: s.table,
        index: s.index,
        maxTime: fmtDb(s.maxTime),   // headColumn（寫入時間）
        minTime: fmtDb(s.minTime),
        maxAltTime: fmtDb(s.maxAltTime), // timeColumn（量測時間），headColumn 相同時為 null
        count: s.count,
        isHead: s.index === head.index,
        // head+1 是最舊、也是下一個要被覆蓋的表，讀到的內容可能新舊混雜
        isNextToOverwrite: s.index === (head.index + 1) % stats.length,
        error: s.error,
      }));
      console.log(`已排出 ${direction} 順序（rank 0 = ${ordered[0].table}）`);
    } else if (mode === 'at') {
      const axis = args.by === 'measure' || args.by === 'measurement' ? 'measure' : 'store';
      const axisCol = axis === 'measure' ? ring.timeColumn : headCol;
      const target = parseTimeInput(args.at, offsetHours);
      const targetMs = target.getTime();

      const loc = locateByTime(stats, targetMs, axis);
      const period = estimateRotation(orderedNewToOld, axis);
      const rankOf = (s) => orderedNewToOld.findIndex((x) => x.index === s.index);

      console.log(`查詢時間：${fmtDb(target)}（DB 時鐘，比對 ${axisCol}）`);
      if (period) {
        console.log(`一張表約 ${(period / 60000).toFixed(1)} 分鐘（相鄰表時間差中位數）`);
      }

      // 「算出來的」：用輪動週期從 head 往回推
      let predicted = null;
      if (period) {
        const steps = Math.round((new Date(head.maxTime).getTime() - targetMs) / period);
        const idx = ((head.index - steps) % stats.length + stats.length) % stats.length;
        predicted = { table: stats.find((s) => s.index === idx).table, index: idx, stepsBack: steps };
      }

      output = {
        targetTime: fmtDb(target),
        tzOffsetHours: offsetHours,
        axis: axisCol,
        status: loc.status,
        table: loc.table ? loc.table.table : null,
        index: loc.table ? loc.table.index : null,
        rank: loc.table ? rankOf(loc.table) : null,
        rangeMin: loc.table ? fmtDb(rangeOf(loc.table, axis).min) : null,
        rangeMax: loc.table ? fmtDb(rangeOf(loc.table, axis).max) : null,
        count: loc.table ? loc.table.count : null,
        rotationMinutes: period ? Number((period / 60000).toFixed(1)) : null,
        predicted,
        matchesPrediction: predicted && loc.table ? predicted.index === loc.table.index : null,
        coverage: loc.coverage
          ? {
              oldest: fmtDb(loc.coverage.oldest),
              newest: fmtDb(loc.coverage.newest),
              hours: Number(((loc.coverage.newest - loc.coverage.oldest) / 3600e3).toFixed(1)),
            }
          : null,
        overlaps: (loc.overlaps || []).map((s) => s.table),
      };

      if (loc.status === 'ok') {
        const rank = rankOf(loc.table);
        console.log(`→ ${loc.table.table}（rank ${rank}，共 ${loc.table.count} 筆）`);
        console.log(`  區間：${output.rangeMin} ~ ${output.rangeMax}`);
        if (output.overlaps.length) console.log(`  ⚠ 區間與其它表重疊：${output.overlaps.join(', ')}`);
        if (rank === stats.length - 1) {
          console.log('  ⚠ 這是最舊的表，隨時可能被覆蓋，建議盡快撈');
        }
        if (predicted && !output.matchesPrediction) {
          console.log(
            `  註：用固定週期推算會得到 ${predicted.table}，與實際區間不符 → 輪動不是等時距，別用算的`
          );
        }
      } else if (loc.status === 'overwritten') {
        console.warn(`→ 查無此時間：已被覆蓋（目前最舊只到 ${output.coverage.oldest}）`);
      } else if (loc.status === 'pending') {
        console.warn(`→ 查無此時間：還沒寫進資料庫（目前最新到 ${output.coverage.newest}）`);
      } else if (loc.status === 'gap') {
        console.warn('→ 查無此時間：落在保留範圍內但該時段沒有資料（儀器未上傳或系統停機）');
      } else {
        console.warn('→ 所有資料表都是空的');
      }
      if (output.coverage) {
        console.log(`目前可撈範圍：${output.coverage.oldest} ~ ${output.coverage.newest}（約 ${output.coverage.hours} 小時）`);
      }

      if (args.fetch && loc.status === 'ok') {
        output.rows = await fetchAround(pool, loc.table, ring, latestN, filter, axis, targetMs);
        console.log(`已撈出該表 ${fmtDb(target)} 之前的 ${output.rows.length} 筆`);
      }
    } else if (mode === 'latest') {
      let rows = await fetchLatest(pool, orderedNewToOld, ring, latestN, filter);
      if (direction === 'oldToNew') rows = rows.reverse();
      output = rows;
      console.log(`已跨表撈出最新 ${rows.length} 筆（目標 ${latestN}）`);
    } else if (mode === 'byParam') {
      const grouped = await fetchByParam(pool, orderedNewToOld, ring, latestN, filter);
      if (direction === 'oldToNew') {
        for (const k of Object.keys(grouped)) grouped[k].reverse();
      }
      output = grouped;
      const total = Object.values(grouped).reduce((a, r) => a + r.length, 0);
      console.log(`已依 parameterId 分組撈出 ${total} 筆`);
    } else if (mode === 'params') {
      // 預設只掃 head（快）；--all 才掃全部 26 張表
      const targets = args.allTables ? ordered : [head];
      console.log(`列出參數清單（掃描 ${targets.length} 張表${args.allTables ? '' : '，加 --all 可掃全部'}）...`);
      output = await fetchParamCatalog(pool, targets, ring, filter);
      console.log(`共 ${output.length} 種 parameterId`);
    } else {
      throw new Error(`未知的 mode：${mode}（可用 head / order / at / latest / byParam / params）`);
    }
  } finally {
    try { await pool.close(); } catch (_) {}
  }

  const json = args.pretty ? JSON.stringify(output, null, 2) : JSON.stringify(output);
  const outAbs = path.resolve(process.cwd(), outFile);
  fs.writeFileSync(outAbs, json, 'utf8');
  console.log('----------------------------------------');
  console.log(`已輸出：${outAbs}`);
}

// 直接執行才跑主流程；被 require 時只匯出函式（方便測試）
if (require.main === module) {
  main().catch((err) => {
    console.error(`\n發生錯誤：${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildTableNames,
  buildWhere,
  dbNow,
  detectOffsetHours,
  estimateRotation,
  fmtDb,
  fetchAround,
  fetchLatest,
  findHead,
  headColumnOf,
  locateByTime,
  orderFromHead,
  parseTimeInput,
  rangeOf,
  scanRing,
  toList,
};
