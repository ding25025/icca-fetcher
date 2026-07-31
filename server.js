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
 *   /health                 探活，不碰資料庫
 *   /icca/head              目前寫入頭是哪一張表
 *   /icca/order             26 張表由新到舊的順序與各表狀態
 *   /icca/latest            從 head 跨表撈最新 N 筆（Rhapsody 定時撈這個）
 *   /icca/at                某個時間點落在哪一張表（可加 &fetch=1 順便撈）
 *
 * 共用查詢參數：
 *   site, n(=latestN), direction, param, patient, device, from, to, tzOffset,
 *   at, by, fetch, pretty
 *
 * 設定：沿用 databases.config.json（或 ring.config.json）。
 *   另可在設定檔加一個 "server" 區塊，或用環境變數覆寫：
 *     ICCA_CONFIG   設定檔路徑（預設 databases.config.json）
 *     ICCA_HOST     監聽位址（預設 127.0.0.1，只給本機的 Rhapsody 用）
 *     ICCA_PORT     監聽埠（預設 8770）
 *     ICCA_TOKEN    若設定，呼叫需帶 X-API-Key 或 ?token=
 *     DB_PASSWORD   資料庫密碼（設定檔用 "env:DB_PASSWORD" 參照）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const sql = require('mssql');
const ring = require('./ring.js');

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

const ROUTES = {
  '/icca/head': epHead,
  '/icca/order': epOrder,
  '/icca/latest': epLatest,
  '/icca/at': epAt,
};

// ---------- 小工具 ----------
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
  if (u.pathname === '/health') {
    return send(res, 200, {
      status: 'ok',
      uptimeSec: Math.round(process.uptime()),
      pools: [...pools.keys()],
      config: CONFIG_PATH,
    }, pretty);
  }

  // token 驗證（有設定才檢查）
  if (TOKEN) {
    const given = req.headers['x-api-key'] || q.token;
    if (given !== TOKEN) return send(res, 401, { error: 'unauthorized' }, pretty);
  }

  const handler = ROUTES[u.pathname];
  if (!handler) return send(res, 404, { error: 'not found', paths: Object.keys(ROUTES).concat('/health') }, pretty);

  try {
    const ctx = await getContext(q.site);
    const out = await handler(ctx, q);
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

server.listen(PORT, HOST, () => {
  console.log(`ICCA 服務已啟動：http://${HOST}:${PORT}`);
  console.log(`  設定檔：${CONFIG_PATH}`);
  console.log(`  端點：/health /icca/head /icca/order /icca/latest /icca/at`);
  console.log(`  存取控制：${TOKEN ? '需要 X-API-Key / ?token=' : '未設 token（僅綁 ' + HOST + '）'}`);
});

// 收到終止訊號時優雅關閉（Windows 服務停止 / Ctrl+C）
function shutdown() {
  console.log('關閉中...');
  server.close(() => {
    // pools 裡放的是 Promise（見 getContext），要先等它 resolve 才拿得到池
    Promise.all(
      [...pools.values()].map((p) => Promise.resolve(p).then((c) => c.pool.close()).catch(() => {}))
    ).finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
