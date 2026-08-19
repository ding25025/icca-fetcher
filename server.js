#!/usr/bin/env node
'use strict';

/**
 * ICCA 環狀資料表 — 常駐 HTTP 服務
 * -------------------------------------------------
 * 把 ring.js 的邏輯包成一支長駐服務，給 Rhapsody 的 HTTP Client
 * communication point 定時來呼叫。相較於每次 spawn 一個 node：
 *   - Node 行程常駐，mssql 連線池保持溫熱（不用每次重連 26 張表的 DB）
 *   - 回應直接是 JSON，Rhapsody 接到就能往下走 filter / mapper
 *   - 錯誤用 HTTP 狀態碼表達，Rhapsody 好判斷
 *
 * 本檔只是薄薄一層 HTTP 外殼，實際邏輯全部重用 ring.js 匯出的函式，
 * 不重寫任何環狀 / 時區 / 過濾的判斷。
 *
 * 端點（皆為 GET）：
 *   /health                 探活，不碰資料庫（含各資料最後一次成功寫入的時間）
 *   /icca/head              目前寫入頭是哪一張表
 *   /icca/order             26 張表由新到舊的順序與各表狀態
 *   /icca/latest            從 head 跨表撈最新 N 筆（原始列，ring.js）
 *   /icca/at                某個時間點落在哪一張表（可加 &fetch=1 順便撈）
 *   /icca/vitals            生命徵象，一床一筆（vitals.js）
 *   /icca/neuro             神經評估，一位病人一筆（neuro.js）
 *   /icca/push/vitals       撈一輪並直接寫進中介資料庫，回寫入統計
 *   /icca/push/neuro        同上（神經評估）
 *
 * 設定檔有 "sink" 區塊且 enabled 時，資料改成直接寫進中介資料庫，不必有人來拉。
 * 觸發有兩種，擇一即可：
 *   - sink.schedule：服務自己定時跑（見 startSchedule），什麼都不必再接
 *   - /icca/push/*：由外部排程器（工作排程器、Rhapsody Timer…）打一下就跑一輪
 * 上面的 /icca/vitals 與 /icca/neuro 沒有變，還是回 JSON、不寫資料庫。
 *
 * ring 端點（head/order/latest/at）的查詢參數：
 *   site, n(=latestN), direction, param, patient, device, from, to, tzOffset,
 *   at, by, fetch, pretty
 * vitals / neuro 的查詢參數見各自的 epVitals / epNeuro。
 *
 * 設定：沿用 databases.config.json（或 ring.config.json）。
 *   另可在設定檔加一個 "server" 區塊，或用環境變數覆寫：
 *     ICCA_CONFIG   設定檔路徑（預設 databases.config.json）
 *     ICCA_HOST     監聽位址（預設 127.0.0.1，只給本機的 Rhapsody 用）
 *     ICCA_PORT     監聽埠（預設 8770）
 *     ICCA_TOKEN    若設定，呼叫需帶 X-API-Key 或 ?token=
 *     ICCA_STATE    執行狀態檔路徑（預設 .sink-state.json，見 state.js）
 *     DB_PASSWORD   資料庫密碼（設定檔用 "env:DB_PASSWORD" 參照）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const sql = require('mssql');
const ring = require('./ring.js');
const vitals = require('./vitals.js');
const neuro = require('./neuro.js');
const sink = require('./sink.js');
const state = require('./state.js'); // 記錄每一種資料最後一次成功寫入的時間

// vitals / neuro 原本是「跑一次就結束」的命令列工具，連完就把池關掉。
// 常駐服務要的是相反：同一個 server/database 只連一次，之後每次呼叫都用溫熱的連線。
vitals.keepPools();

// ---------- 設定 ----------
const CONFIG_PATH = process.env.ICCA_CONFIG || 'databases.config.json';
const HOST = process.env.ICCA_HOST || '127.0.0.1';
const PORT = Number(process.env.ICCA_PORT) || 8770;

function readJson(p) {
  const abs = path.resolve(process.cwd(), p);
  if (!fs.existsSync(abs)) throw new Error(`找不到設定檔：${abs}`);
  return JSON.parse(fs.readFileSync(abs, 'utf8'));
}

// 密碼 / 帳號可寫成 "env:變數名"（與 ring.js 一致；該函式未匯出，這裡重述一份）
function resolveSecret(value) {
  if (typeof value === 'string' && value.startsWith('env:')) {
    const key = value.slice(4);
    const v = process.env[key];
    if (v === undefined) throw new Error(`環境變數 ${key} 未設定`);
    return v;
  }
  return value;
}

// 啟動時讀一次設定；改設定檔後重啟服務即可
const CFG = readJson(CONFIG_PATH);
const SRV = CFG.server || {};
const TOKEN = process.env.ICCA_TOKEN || SRV.token || null;
const SINK = sink.mergeSettings(CFG);
const SINK_ON = sink.wanted(SINK);
// 啟用了就在啟動時檢查連線設定齊不齊。服務現在的本業就是寫進中介資料庫，
// 設錯了不該讓它裝作健康——寧可起不來，也不要每 5 分鐘失敗一次而沒人看見。
if (SINK_ON) sink.assertConfigured(SINK);

// ---------- 溫熱連線池（每個站台各一個，重複使用）----------
// Map 裡放的是「建池的 Promise」而不是建好的池：同時打進來的請求會等同一個 Promise，
// 不會各自建一個然後互相蓋掉，留下沒人關、也沒人用的連線掛在 SQL Server 上。
const pools = new Map(); // siteKey -> Promise<{ pool, ring, site, all }>

function createContext(resolved, key) {
  const conn = { ...resolved.connection };
  if (conn.password) conn.password = resolveSecret(conn.password);
  if (conn.user) conn.user = resolveSecret(conn.user);
  if (CFG.queryTimeoutMs) conn.requestTimeout = CFG.queryTimeoutMs;

  const pool = new sql.ConnectionPool(conn);
  let entry = null; // 這個池在 Map 裡對應的值，給 error handler 認自己用

  // 池子若整體出錯就丟棄，下次呼叫重建，不要抱著壞掉的池。
  // 只在「Map 裡放的還是我」時才刪：舊池斷線重建後才吐出來的 error，
  // 否則會把已經接手的新池誤殺，害下一個請求又要重連一次。
  pool.on('error', () => {
    if (entry && pools.get(key) === entry) pools.delete(key);
    pool.close().catch(() => {});
  });

  entry = pool.connect().then(() => ({
    pool,
    ring: resolved.ring,
    site: key,
    all: resolved.source ? resolved.source.all : [],
  }));
  return entry;
}

async function getContext(siteName) {
  const resolved = ring.resolveConfig(CFG, siteName);
  const key = (resolved.source && resolved.source.name) || '__single__';

  // 迴圈是為了「等到的池已經斷線」這種情況：收掉它，下一圈重建。
  // 上限純粹是防呆，正常情況第一或第二圈就回去了。
  for (let round = 0; round < 5; round++) {
    const pending = pools.get(key);

    if (!pending) {
      // 沒人建過 → 我來建。這裡到 set 之間沒有 await，單執行緒下不會有人插隊。
      const entry = createContext(resolved, key);
      pools.set(key, entry);
      try {
        return await entry;
      } catch (e) {
        if (pools.get(key) === entry) pools.delete(key);
        throw e;
      }
    }

    let ctx = null;
    try { ctx = await pending; } catch (_) {}
    // 等的過程中別人可能已經換上新的一份 → 重來一圈去拿那份，別動它
    if (pools.get(key) !== pending) continue;
    if (ctx && ctx.pool.connected) return ctx;

    // 壞掉的由我收：先從 Map 拿掉（後面不 await，避免留下空窗讓別人也來收一次）
    pools.delete(key);
    if (ctx) ctx.pool.close().catch(() => {});
  }

  throw httpError(503, '連線池反覆重建中，稍後再試');
}

// ---------- 每次請求都重新掃描（head 會輪動），回傳共用的中間結果 ----------
async function runScan(ctx, q) {
  const r = ctx.ring;
  const tables = ring.buildTableNames(r);
  const stats = await ring.scanRing(ctx.pool, tables, r);

  const head = ring.findHead(stats);
  if (!head) throw httpError(503, '所有資料表都沒有可用的時間資料，無法判斷寫入頭');

  const detected = ring.detectOffsetHours(head.maxTime);
  const tzOverride = numOrNull(q.tzOffset);
  const cfgTz = Number.isFinite(CFG.dbTimeOffsetHours) ? CFG.dbTimeOffsetHours : null;
  const offsetHours = tzOverride != null ? tzOverride : (cfgTz != null ? cfgTz : detected.hours);

  const direction = q.direction || CFG.direction || 'newToOld';
  const ordered = ring.orderFromHead(stats, head.index, direction);
  const orderedNewToOld = direction === 'oldToNew' ? [...ordered].reverse() : ordered;

  return { r, stats, head, detected, offsetHours, direction, ordered, orderedNewToOld };
}

// 從查詢參數組出過濾條件（設定檔 ring.filter 為底，query 覆寫）
function buildFilter(ctx, q, offsetHours) {
  const filter = { ...(ctx.ring.filter || {}) };
  if (q.param != null) filter.parameterId = q.param;
  if (q.patient != null) filter.patientIdentifier = q.patient;
  if (q.device != null) filter.deviceInstanceId = q.device;
  if (q.from != null) filter.timeFrom = q.from;
  if (q.to != null) filter.timeTo = q.to;
  // --from/--to 是 DB 時鐘的字面值，用 ring.js 同一套規則解讀
  if (filter.timeFrom) filter.timeFrom = ring.parseTimeInput(filter.timeFrom, offsetHours);
  if (filter.timeTo) filter.timeTo = ring.parseTimeInput(filter.timeTo, offsetHours);
  return filter;
}

// ---------- 各端點 ----------
async function epHead(ctx, q) {
  const s = await runScan(ctx, q);
  return {
    site: ctx.site,
    headTable: s.head.table,
    headIndex: s.head.index,
    headColumn: ring.headColumnOf(s.r),
    lastRecordTime: ring.fmtDb(s.head.maxTime),
    tzOffsetHours: s.offsetHours,
    clockSkewMinutes: s.detected.skewMinutes,
    totalRows: s.stats.reduce((a, x) => a + (x.count || 0), 0),
  };
}

async function epOrder(ctx, q) {
  const s = await runScan(ctx, q);
  const n = s.stats.length;
  return s.ordered.map((x, rank) => ({
    rank,
    table: x.table,
    index: x.index,
    maxTime: ring.fmtDb(x.maxTime),
    minTime: ring.fmtDb(x.minTime),
    maxAltTime: ring.fmtDb(x.maxAltTime),
    count: x.count,
    isHead: x.index === s.head.index,
    isNextToOverwrite: x.index === (s.head.index + 1) % n,
    error: x.error,
  }));
}

async function epLatest(ctx, q) {
  const s = await runScan(ctx, q);
  const latestN = numOrNull(q.n) || CFG.latestN || 100;
  const filter = buildFilter(ctx, q, s.offsetHours);
  let rows = await ring.fetchLatest(ctx.pool, s.orderedNewToOld, s.r, latestN, filter);
  if (s.direction === 'oldToNew') rows = rows.reverse();
  return rows;
}

async function epAt(ctx, q) {
  const s = await runScan(ctx, q);
  const r = s.r;
  const axis = q.by === 'measure' || q.by === 'measurement' ? 'measure' : 'store';
  const axisCol = axis === 'measure' ? r.timeColumn : ring.headColumnOf(r);
  const target = ring.parseTimeInput(q.at, s.offsetHours);
  const targetMs = target.getTime();

  const loc = ring.locateByTime(s.stats, targetMs, axis);
  const period = ring.estimateRotation(s.orderedNewToOld, axis);
  const rankOf = (x) => s.orderedNewToOld.findIndex((y) => y.index === x.index);

  const out = {
    site: ctx.site,
    targetTime: ring.fmtDb(target),
    tzOffsetHours: s.offsetHours,
    axis: axisCol,
    status: loc.status,
    table: loc.table ? loc.table.table : null,
    index: loc.table ? loc.table.index : null,
    rank: loc.table ? rankOf(loc.table) : null,
    rangeMin: loc.table ? ring.fmtDb(ring.rangeOf(loc.table, axis).min) : null,
    rangeMax: loc.table ? ring.fmtDb(ring.rangeOf(loc.table, axis).max) : null,
    count: loc.table ? loc.table.count : null,
    rotationMinutes: period ? Number((period / 60000).toFixed(1)) : null,
    coverage: loc.coverage
      ? {
          oldest: ring.fmtDb(loc.coverage.oldest),
          newest: ring.fmtDb(loc.coverage.newest),
          hours: Number(((loc.coverage.newest - loc.coverage.oldest) / 3600e3).toFixed(1)),
        }
      : null,
    overlaps: (loc.overlaps || []).map((x) => x.table),
  };

  if (truthy(q.fetch) && loc.status === 'ok') {
    const latestN = numOrNull(q.n) || CFG.latestN || 100;
    const filter = buildFilter(ctx, q, s.offsetHours);
    out.rows = await ring.fetchAround(ctx.pool, loc.table, r, latestN, filter, axis, targetMs);
  }
  return out;
}

// ---------- vitals / neuro ----------
// 這兩支各自管自己的設定與連線（都在 vitals.js 的池裡），不需要 ring 的 ctx。

// 同一個端點被重複觸發時排隊跑：兩輪同時跑會互相蓋掉表號錨點檔與病人快取，
// 而且對 DB 的壓力憑空翻倍。Rhapsody 若因為逾時重送，第二個請求會等第一個跑完。
const chains = new Map();
function serialize(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.then(fn, fn); // 前一輪失敗也照跑
  chains.set(key, next.catch(() => {})); // 鏈上只留成功/失敗的時間點，不留 rejection
  return next;
}

// 查詢參數對應 vitals.js 的命令列旗標，語意完全一樣：
//   window(w) 時間窗分鐘、site 只跑哪幾站、param 指定 parameterId、discover 從 primary 查、
//   utc 不換算時區、noPatients 不查病歷號、keepUnmatched 保留沒對到病人的床、
//   allRows 不降頻、noAperiodic 不撈 NBP、withSummary 包成 { summary, rows }
async function epVitals(_ctx, q) {
  const res = await serialize('vitals', () =>
    vitals.collect({
      config: CONFIG_PATH,
      window: numOrNull(q.window != null ? q.window : q.w),
      site: q.site || null,
      param: q.param != null ? q.param : null,
      discover: truthy(q.discover),
      utc: truthy(q.utc),
      noPatients: truthy(q.noPatients),
      keepUnmatched: truthy(q.keepUnmatched),
      allRows: truthy(q.allRows),
      noAperiodic: truthy(q.noAperiodic),
      patientDb: q.patientsDb || null,
    })
  );
  // 全部站台都失敗時一定要回錯誤：空陣列配 200 會讓 Rhapsody 當成「這次沒有資料」，
  // 一路往下送到下游，等有人發現時已經斷了好幾個小時。這對應 CLI 的 exitCode=1。
  failIfAllDown(res.failures, res.sites.length, res.summary, (s) => s.site);

  return truthy(q.withSummary) || res.settings.includeSummary === true
    ? { summary: res.summary, rows: res.rows }
    : res.rows;
}

// 查詢參數對應 neuro.js 的命令列旗標：
//   window(w) 時間窗分鐘（不給就用 neuro.js 的預設 6）、utc 不換算時區、withSummary 包成 { summary, rows }
async function epNeuro(_ctx, q) {
  const res = await serialize('neuro', () =>
    neuro.collect({
      config: CONFIG_PATH,
      window: numOrNull(q.window != null ? q.window : q.w),
      utc: truthy(q.utc),
      primaryDb: q.primaryDb || null,
    })
  );
  failIfAllDown(res.failures, res.groups, res.summary, (s) => s.db);

  return truthy(q.withSummary) || res.settings.includeSummary === true
    ? { summary: res.summary, rows: res.rows }
    : res.rows;
}

// ---------- 寫進中介資料庫 ----------
// 撈一輪 → 攤平 → MERGE 進 sink 的表。撈的那一段跟 /icca/vitals 完全是同一段程式，
// 差別只在結果不是回給呼叫端，而是直接寫進資料庫。

/** 時間窗預設跟排程間隔對齊，再加一點餘裕（windowSlackMinutes），寧可重疊也不要漏 */
function pushWindow(kind, q) {
  const explicit = numOrNull(q && (q.window != null ? q.window : q.w));
  if (explicit) return explicit;
  const sc = SINK.schedule || {};
  const every = kind === 'vitals' ? sc.vitalsMinutes : sc.neuroMinutes;
  if (!every) return null; // 交給 vitals.js / neuro.js 自己的預設值
  return every + (sc.windowSlackMinutes != null ? sc.windowSlackMinutes : 1);
}

async function pushVitals(q = {}) {
  if (!SINK_ON) throw httpError(400, '設定檔沒有啟用 sink（databases.config.json 的 "sink" 區塊，enabled: true）');
  // 開始撈的時間就是「補的時候要從這裡開始」的那個點，先記下來（見 state.js）
  const startedAtMs = Date.now();
  try {
    const res = await serialize('vitals', () =>
      vitals.collect({ config: CONFIG_PATH, window: pushWindow('vitals', q), site: q.site || null })
    );
    failIfAllDown(res.failures, res.sites.length, res.summary, (s) => s.site);
    const stats = await sink.writeVitals(res.rows, SINK);
    // ?site= 只跑部分站台，那不是完整的一輪，記了會讓水位線假性前進，所以跳過
    if (!q.site) state.recordSuccess('vitals', { startedAtMs, stats });
    return { kind: 'vitals', beds: res.rows.length, fetched: res.total, ...stats };
  } catch (e) {
    state.recordFailure('vitals', e.message);
    throw e;
  }
}

async function pushNeuro(q = {}) {
  if (!SINK_ON) throw httpError(400, '設定檔沒有啟用 sink（databases.config.json 的 "sink" 區塊，enabled: true）');
  const startedAtMs = Date.now();
  try {
    const res = await serialize('neuro', () =>
      neuro.collect({ config: CONFIG_PATH, window: pushWindow('neuro', q) })
    );
    failIfAllDown(res.failures, res.groups, res.summary, (s) => s.db);
    const stats = await sink.writeNeuro(res.rows, SINK);
    state.recordSuccess('neuro', { startedAtMs, stats });
    return { kind: 'neuro', patients: res.rows.length, fetched: res.total, ...stats };
  } catch (e) {
    state.recordFailure('neuro', e.message);
    throw e;
  }
}

/**
 * 服務自己定時跑（sink.schedule）。設定了才啟用：
 *   "schedule": { "vitalsMinutes": 5, "neuroMinutes": 5 }（sink.config.json）
 * 這樣連外部排程器都不必——Node 常駐、連線池溫熱，時間到就撈一輪寫進去。
 *
 * 上一輪還沒跑完就跳過這一輪，不排隊：排隊只會越積越多，而且下一輪本來就會
 * 把漏掉的時間窗一起帶到（窗開得比間隔大）。
 */
function startSchedule() {
  const sc = SINK.schedule;
  if (!SINK_ON || !sc) return [];
  const jobs = [
    { name: 'vitals', minutes: sc.vitalsMinutes, run: pushVitals },
    { name: 'neuro', minutes: sc.neuroMinutes, run: pushNeuro },
  ].filter((j) => Number(j.minutes) > 0);

  return jobs.map((j) => {
    let busy = false;
    const tick = async () => {
      if (busy) return console.warn(`${new Date().toISOString()} ⚠ 上一輪 ${j.name} 還沒結束，這一輪跳過`);
      busy = true;
      const started = Date.now();
      try {
        const stats = await j.run();
        console.log(`${new Date().toISOString()} [排程 ${j.name}] ${sink.describe(stats)}`);
      } catch (e) {
        console.error(`${new Date().toISOString()} [排程 ${j.name}] ✗ ${e.message}（${Date.now() - started}ms）`);
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(tick, j.minutes * 60000);
    setTimeout(tick, 1000).unref(); // 啟動一秒後先跑一輪，不必等第一個間隔才知道通不通
    return { name: j.name, minutes: j.minutes, timer };
  });
}

/**
 * 一個都沒成功 → 502，錯誤訊息帶上各來源的原因，呼叫端走 error 路徑。
 * 只有部分失敗時照常回 200（資料還是有用），但把情況寫進服務 log；
 * 呼叫端要逐站狀態就加 &withSummary=1。
 */
function failIfAllDown(failures, total, summary, nameOf) {
  if (!total || failures < total) {
    if (failures) console.warn(`  ⚠ ${failures}/${total} 個來源失敗，仍回傳其餘資料`);
    return;
  }
  const why = summary
    .filter((s) => !s.ok)
    .map((s) => `${nameOf(s)}：${s.error}`)
    .join('；');
  throw httpError(502, `全部 ${total} 個來源都失敗（${why}）`);
}

// ring: true 的端點要先拿到環狀表的連線（getContext），vitals / neuro 自己連
const ROUTES = {
  '/icca/head': { fn: epHead, ring: true },
  '/icca/order': { fn: epOrder, ring: true },
  '/icca/latest': { fn: epLatest, ring: true },
  '/icca/at': { fn: epAt, ring: true },
  '/icca/vitals': { fn: epVitals, ring: false },
  '/icca/neuro': { fn: epNeuro, ring: false },
  // 撈一輪直接寫進中介資料庫，回的是寫入統計而不是資料本身
  '/icca/push/vitals': { fn: (_c, q) => pushVitals(q), ring: false },
  '/icca/push/neuro': { fn: (_c, q) => pushNeuro(q), ring: false },
};

// ---------- 小工具 ----------
/** 狀態檔摘要。補撈的餘裕跟排程用的是同一個 windowSlackMinutes */
function stateReport() {
  const sc = SINK.schedule || {};
  return state.report(['vitals', 'neuro'], {
    slackMinutes: sc.windowSlackMinutes != null ? sc.windowSlackMinutes : 1,
  });
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function truthy(v) {
  return v === '1' || v === 'true' || v === 'yes' || v === '';
}
// query string 可能帶 ?token=，log 會被 NSSM 寫成檔案，不能原樣印出去
function safeSearch(u) {
  if (!u.search) return '';
  const p = new URLSearchParams(u.search);
  if (p.has('token')) p.set('token', '***');
  const s = p.toString();
  return s ? `?${s}` : '';
}
function send(res, status, obj, pretty) {
  const body = pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

// ---------- HTTP 伺服器 ----------
const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let u;
  try {
    u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (_) {
    return send(res, 400, { error: 'bad request' });
  }
  const q = Object.fromEntries(u.searchParams.entries());
  const pretty = truthy(q.pretty);

  // 只接受 GET
  if (req.method !== 'GET') {
    return send(res, 405, { error: 'method not allowed' }, pretty);
  }

  // 健康檢查：不碰資料庫，也不需要 token
  // lastWrite 是從狀態檔讀的（不連 DB），發現問題時第一個看這裡：
  // 上次成功幾點、離現在多久、要補的話該下多大的 --window
  if (u.pathname === '/health') {
    return send(res, 200, {
      status: 'ok',
      uptimeSec: Math.round(process.uptime()),
      pools: [...pools.keys()],
      config: CONFIG_PATH,
      stateFile: SINK_ON ? state.filePath() : null,
      lastWrite: SINK_ON ? stateReport() : null,
    }, pretty);
  }

  // token 驗證（有設定才檢查）
  if (TOKEN) {
    const given = req.headers['x-api-key'] || q.token;
    if (given !== TOKEN) return send(res, 401, { error: 'unauthorized' }, pretty);
  }

  const route = ROUTES[u.pathname];
  if (!route) return send(res, 404, { error: 'not found', paths: Object.keys(ROUTES).concat('/health') }, pretty);

  try {
    const ctx = route.ring ? await getContext(q.site) : null;
    const out = await route.fn(ctx, q);
    const ms = Date.now() - started;
    console.log(`${new Date().toISOString()} ${req.method} ${u.pathname}${safeSearch(u)} -> 200 ${ms}ms`);
    return send(res, 200, out, pretty);
  } catch (err) {
    const status = err.status || 500;
    const ms = Date.now() - started;
    console.error(`${new Date().toISOString()} ${req.method} ${u.pathname}${safeSearch(u)} -> ${status} ${ms}ms：${err.message}`);
    return send(res, status, { error: err.message }, pretty);
  }
});

let schedule = [];
server.listen(PORT, HOST, () => {
  console.log(`ICCA 服務已啟動：http://${HOST}:${PORT}`);
  console.log(`  設定檔：${CONFIG_PATH}（資料來源）`);
  if (SINK.configFile) console.log(`        ${SINK.configFile}（中介資料庫）`);
  console.log(`  端點：/health ${Object.keys(ROUTES).join(' ')}`);
  console.log(`  存取控制：${TOKEN ? '需要 X-API-Key / ?token=' : '未設 token（僅綁 ' + HOST + '）'}`);
  console.log(`  寫入資料庫：${SINK_ON ? sink.describeTarget(SINK) : '未啟用（沒有 sink.config.json 或 enabled 不是 true）'}`);

  if (SINK_ON) {
    // 重啟之後最想知道的就是「停了多久、缺口多大」，不必等人去打 /health
    const r = stateReport();
    for (const kind of Object.keys(r)) console.log(`  ${state.describe(kind, r[kind])}`);
  }

  schedule = startSchedule();
  if (schedule.length) {
    console.log(`  內建排程：${schedule.map((j) => `${j.name} 每 ${j.minutes} 分鐘`).join('、')}`);
  } else if (SINK_ON) {
    console.log(`  內建排程：未設定（用 /icca/push/vitals、/icca/push/neuro 由外部觸發）`);
  }
});

// 收到終止訊號時優雅關閉（Windows 服務停止 / Ctrl+C）
function shutdown() {
  console.log('關閉中...');
  for (const j of schedule) clearInterval(j.timer);
  server.close(() => {
    // pools 裡放的是 Promise（見 getContext），要先等它 resolve 才拿得到池
    Promise.all(
      [...pools.values()]
        .map((p) => Promise.resolve(p).then((c) => c.pool.close()).catch(() => {}))
        .concat(vitals.closePools()) // vitals / neuro 共用的那組池
    ).finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
