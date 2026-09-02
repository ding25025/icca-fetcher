#!/usr/bin/env node
'use strict';

/**
 * 執行狀態 — 記錄「最後一次成功寫進中介資料庫是什麼時候」
 * -------------------------------------------------
 * 為什麼要這個檔：撈取的時間窗是相對的（每一輪只看「現在往回 N 分鐘」，
 * 見 server.js 的 pushWindow），跑完就忘。服務停掉一小時再起來，只會補最近
 * 幾分鐘，中間那段沒有任何地方記得，也就沒人知道缺口在哪、要下多大的窗去補。
 *
 * 這支只做一件事：每一輪成功之後把時間寫下來，讓維護的人（或 /health）
 * 一眼看出「上次成功是幾點、離現在多久、現在該用多少 --window 去補」。
 *
 * 它「只記錄，不自動補」——排程行為完全沒變，開多大的窗還是人決定。
 * 要補就照 suggestWindowMinutes 打一次：
 *   node vitals.js --window <分鐘> --to-db
 *   curl "http://127.0.0.1:8770/icca/push/vitals?window=<分鐘>"
 *
 * 補得回來的上限是 24 小時（MAX_BACKFILL_HOURS）：vitals 的來源是 26 張環狀表、
 * 一張約一小時，再往前就被覆蓋了；neuro 雖然是一般表，也照同一個上限走，
 * 一次撈太大的窗會壓到正式機。超過上限的缺口補不回來，report() 會標出來。
 *
 * 寫檔失敗一律不影響撈取——這只是給人看的紀錄，不是資料流的一部分。
 */

const fs = require('fs');
const path = require('path');

// 跟 .ring-anchors.json 一樣放在工作目錄下，已在 .gitignore
const STATE_FILE = process.env.ICCA_STATE || '.sink-state.json';

// 最多補 24 小時：環狀表大約只留這麼久，也不想一次對 DB 開太大的窗
const MAX_BACKFILL_HOURS = Number(process.env.ICCA_MAX_BACKFILL_HOURS) || 24;

/** 本機時鐘的 "2026-08-18 14:35:02"（ring.fmtDb 印的是 UTC，這裡要人看的當地時間） */
function fmtLocal(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function filePath() {
  return path.resolve(process.cwd(), STATE_FILE);
}

// 升級前的狀態檔只有一個全域水位（沒有 sources）。讀進來時就地換成一個來源條目，
// 這樣 report() 只要處理一種形狀，升級當下的缺口也不會憑空消失。
// 這個假來源不會再前進，24 小時後由 pruneSources 自然淘汰。
const LEGACY_SOURCE = '(升級前的全域水位)';

/** 讀不到、或內容壞掉都回空物件——狀態檔是輔助，不該讓服務起不來 */
function read() {
  try {
    const raw = fs.readFileSync(filePath(), 'utf8');
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return {};
    for (const [kind, s] of Object.entries(obj)) {
      if (!s || typeof s !== 'object' || s.sources || !s.startedAtMs) continue;
      obj[kind] = { ...s, sources: { [LEGACY_SOURCE]: {
        startedAt: s.startedAt, startedAtMs: s.startedAtMs, finishedAt: s.finishedAt,
        rows: s.rows, written: s.written, table: s.table,
        lastError: s.lastError || null, lastErrorAt: s.lastErrorAt || null,
      } } };
    }
    return obj;
  } catch (_) {
    return {};
  }
}

/**
 * 先寫暫存檔再 rename：直接覆寫的話，寫到一半斷電會留下一個半截的 JSON，
 * 下次讀就整份狀態都沒了。rename 在同一個磁碟上是原子操作。
 */
function write(obj) {
  const file = filePath();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/** 同一支程式裡兩個排程輪流寫同一個檔，讀-改-寫全用同步呼叫才不會互相蓋掉 */
function update(kind, patch) {
  try {
    const all = read();
    all[kind] = { ...(all[kind] || {}), ...patch };
    write(all);
  } catch (e) {
    console.warn(`⚠ 寫入狀態檔失敗（不影響撈取）：${e.message}`);
  }
}

/**
 * 記一輪失敗。用在 collect() 還沒產出 summary 就掛掉的情況——那時候沒有來源可以
 * 歸咎，錯誤記在根節點，report() 會把它放在該類資料的最外層。
 * 失敗不動任何 startedAt：水位線只有成功才前進，缺口才看得出來。
 */
function recordFailure(kind, message) {
  update(kind, { lastError: String(message || '').slice(0, 500), lastErrorAt: fmtLocal(Date.now()) });
}

/**
 * 記錄單一來源的成功水位。vitals 的 source 是 cds1、cds2…；neuro 的 source
 * 是 "SQL instance\\database"。來源要各自記，否則某一站失敗、其他站成功時，
 * 全域水位會被推進而掩蓋那一站的缺口。
 */
function recordSourceSuccess(kind, source, { startedAtMs, stats = {} } = {}) {
  const started = startedAtMs || Date.now();
  const key = String(source || '').trim();
  if (!key) return;
  try {
    const all = read();
    const parent = all[kind] || {};
    const sources = { ...(parent.sources || {}) };
    sources[key] = {
      startedAt: fmtLocal(started),
      startedAtMs: started,
      finishedAt: fmtLocal(Date.now()),
      rows: stats.total != null ? stats.total : null,
      written: stats.written != null ? stats.written : null,
      table: stats.table || null,
      lastError: null,
      lastErrorAt: null,
    };
    // 水位一律以 sources 為準；根節點只留整輪錯誤（成功就清掉）與升級前的殘留欄位
    const next = { ...parent, sources, lastError: null, lastErrorAt: null };
    for (const k of ['startedAt', 'startedAtMs', 'finishedAt', 'rows', 'written', 'table']) delete next[k];
    all[kind] = next;
    write(all);
  } catch (e) {
    console.warn(`⚠ 寫入狀態檔失敗（不影響撈取）：${e.message}`);
  }
}

/** 單一來源失敗不推進它的 startedAt，下一次才能依原水位補撈。 */
function recordSourceFailure(kind, source, message) {
  const key = String(source || '').trim();
  if (!key) return;
  try {
    const all = read();
    const parent = all[kind] || {};
    const sources = { ...(parent.sources || {}) };
    sources[key] = {
      ...(sources[key] || {}),
      lastError: String(message || '').slice(0, 500),
      lastErrorAt: fmtLocal(Date.now()),
    };
    all[kind] = { ...parent, sources };
    write(all);
  } catch (e) {
    console.warn(`⚠ 寫入狀態檔失敗（不影響撈取）：${e.message}`);
  }
}

/**
 * 清掉這一輪沒出現的來源。Charting DB 會隨病人分布消失、CDS 站台也可能改名，
 * 舊鑰匙留著會讓 failedSources 一直掛著一個回不來的名字，oldestSuccessAt 也被
 * 它拖到很舊。但「暫時沒病人」的來源要留住水位，所以只清兩種：
 *   1. 從來沒成功過的（沒有水位可留）
 *   2. 距上次成功已超過補撈上限的（那段缺口本來就補不回來了）
 * activeKeys 要是「這一輪真的跑過的來源」——只跑單一站台的那種呼叫不可以呼叫它。
 */
function pruneSources(kind, activeKeys, { now = Date.now() } = {}) {
  const active = new Set((activeKeys || []).map((k) => String(k || '').trim()).filter(Boolean));
  try {
    const all = read();
    const parent = all[kind];
    if (!parent || !parent.sources) return [];
    const sources = {};
    const dropped = [];
    for (const [name, s] of Object.entries(parent.sources)) {
      const ageMinutes = s && s.startedAtMs ? (now - s.startedAtMs) / 60000 : Infinity;
      if (active.has(name) || ageMinutes <= MAX_BACKFILL_HOURS * 60) sources[name] = s;
      else dropped.push(name);
    }
    if (!dropped.length) return [];
    all[kind] = { ...parent, sources };
    write(all);
    console.warn(`  狀態檔：${kind} 移除已不存在的來源 ${dropped.join('、')}（這一輪沒出現，缺口也超過 ${MAX_BACKFILL_HOURS} 小時補不回來）`);
    return dropped;
  } catch (e) {
    console.warn(`⚠ 寫入狀態檔失敗（不影響撈取）：${e.message}`);
    return [];
  }
}

function sourceReport(s, slackMinutes, now, maxMinutes) {
  if (!s || !s.startedAtMs) {
    return {
      lastSuccessAt: null,
      lastError: s && s.lastError || null,
      lastErrorAt: s && s.lastErrorAt || null,
      note: '尚無成功紀錄',
    };
  }
  const ageMinutes = Math.max(0, Math.round((now - s.startedAtMs) / 60000));
  const beyond = ageMinutes > maxMinutes;
  const out = {
    lastSuccessAt: s.startedAt,
    finishedAt: s.finishedAt,
    ageMinutes,
    rows: s.rows,
    written: s.written,
    suggestWindowMinutes: Math.min(ageMinutes + slackMinutes, maxMinutes),
    maxBackfillHours: MAX_BACKFILL_HOURS,
    gapBeyondBackfill: beyond,
    lastError: s.lastError || null,
    lastErrorAt: s.lastErrorAt || null,
  };
  if (beyond) out.note = `距上次成功已 ${Math.round(ageMinutes / 60)} 小時，超過 ${MAX_BACKFILL_HOURS} 小時的部分補不回來`;
  return out;
}

/**
 * 給 /health 與啟動 log 用的摘要：每一種資料距離上次成功多久、現在該下多大的窗。
 * slackMinutes 是補撈時多留的餘裕，跟排程的 windowSlackMinutes 同一個意思。
 */
function report(kinds = ['vitals', 'neuro'], { slackMinutes = 1, now = Date.now() } = {}) {
  const all = read();
  const maxMinutes = MAX_BACKFILL_HOURS * 60;
  const out = {};

  for (const kind of kinds) {
    const s = all[kind];
    const names = s && s.sources ? Object.keys(s.sources) : [];
    if (!names.length) {
      out[kind] = {
        lastSuccessAt: null,
        note: '還沒有成功紀錄（服務剛部署，或從來沒寫成功過）',
        lastError: (s && s.lastError) || null,
        lastErrorAt: (s && s.lastErrorAt) || null,
      };
      continue;
    }
    const sources = {};
    for (const name of names) sources[name] = sourceReport(s.sources[name], slackMinutes, now, maxMinutes);

    // 最舊的那一個來源決定整體的新鮮度：一次補齊所有來源就是下它的窗
    const oldest = Object.entries(sources)
      .filter(([, x]) => x.ageMinutes != null)
      .sort((a, b) => b[1].ageMinutes - a[1].ageMinutes)[0];
    out[kind] = {
      sourceCount: names.length,
      failedSources: Object.entries(sources).filter(([, x]) => x.lastError).map(([name]) => name),
      oldestSource: oldest ? oldest[0] : null,
      oldestSuccessAt: oldest ? oldest[1].lastSuccessAt : null,
      oldestAgeMinutes: oldest ? oldest[1].ageMinutes : null,
      // 要一次補齊所有來源就下這個 window（已含餘裕，超過上限封在 24 小時）
      suggestWindowMinutes: oldest ? oldest[1].suggestWindowMinutes : null,
      maxBackfillHours: MAX_BACKFILL_HOURS,
      gapBeyondBackfill: Object.values(sources).some((x) => x.gapBeyondBackfill),
      // 整輪級的錯誤：collect() 還沒產出來源清單就掛掉的那種
      lastError: s.lastError || null,
      lastErrorAt: s.lastErrorAt || null,
      sources,
    };
  }
  return out;
}

/** 啟動 log 用的一行字：停了多久、該下多大的窗、誰沒進來 */
function describe(kind, r) {
  if (!r || !r.oldestSuccessAt) {
    const why = r && r.lastError ? `：${r.lastError}` : '';
    return `${kind}：尚無成功紀錄${why}`;
  }
  const failed = r.failedSources || [];
  const gap = r.gapBeyondBackfill ? '⚠ ' : '';
  return `${gap}${kind}：${r.sourceCount} 個來源，最舊的 ${r.oldestSource} 上次成功 ${r.oldestSuccessAt}` +
    `（${r.oldestAgeMinutes} 分鐘前，要一次補齊就下 --window ${r.suggestWindowMinutes}）` +
    (failed.length ? `，⚠ ${failed.length} 個來源有錯：${failed.join('、')}` : '') +
    (r.lastError ? `，⚠ 最近整輪失敗：${r.lastError}` : '');
}

module.exports = {
  STATE_FILE,
  MAX_BACKFILL_HOURS,
  filePath,
  read,
  recordFailure,
  recordSourceSuccess,
  recordSourceFailure,
  pruneSources,
  report,
  describe,
  fmtLocal,
};
