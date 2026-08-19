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

/** 讀不到、或內容壞掉都回空物件——狀態檔是輔助，不該讓服務起不來 */
function read() {
  try {
    const raw = fs.readFileSync(filePath(), 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
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
 * 記一輪成功。
 *
 * startedAtMs 是「這一輪開始撈的時間」而不是寫完的時間，因為要補的時候是從
 * 這個點往後撈才不會漏：撈取到寫入之間可能隔了幾十秒，那段時間新進來的資料
 * 這一輪沒看到。從開始的時間補，最多只是重疊——重複的列寫入時會被擋掉。
 */
function recordSuccess(kind, { startedAtMs, stats = {} } = {}) {
  const started = startedAtMs || Date.now();
  update(kind, {
    startedAt: fmtLocal(started),      // ← 要補就從這個時間開始
    startedAtMs: started,
    finishedAt: fmtLocal(Date.now()),  // 這一輪寫完的時間，看跑多久用
    rows: stats.total != null ? stats.total : null,
    written: stats.written != null ? stats.written : null,
    table: stats.table || null,
    lastError: null,
    lastErrorAt: null,
  });
}

/** 記一輪失敗。失敗不動 startedAt——水位線只有成功才前進，缺口才看得出來 */
function recordFailure(kind, message) {
  update(kind, { lastError: String(message || '').slice(0, 500), lastErrorAt: fmtLocal(Date.now()) });
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
    if (!s || !s.startedAtMs) {
      out[kind] = { lastSuccessAt: null, note: '還沒有成功紀錄（服務剛部署，或從來沒寫成功過）' };
      continue;
    }
    const ageMinutes = Math.max(0, Math.round((now - s.startedAtMs) / 60000));
    const beyond = ageMinutes > maxMinutes;
    out[kind] = {
      lastSuccessAt: s.startedAt,
      finishedAt: s.finishedAt,
      ageMinutes,
      rows: s.rows,
      written: s.written,
      // 要補的話下這個 --window（已含餘裕），超過上限就封在 24 小時
      suggestWindowMinutes: Math.min(ageMinutes + slackMinutes, maxMinutes),
      maxBackfillHours: MAX_BACKFILL_HOURS,
      // true = 缺口比 24 小時還久，超出的部分補不回來（環狀表已被覆蓋）
      gapBeyondBackfill: beyond,
      lastError: s.lastError || null,
      lastErrorAt: s.lastErrorAt || null,
    };
    if (beyond) {
      out[kind].note = `距上次成功已 ${Math.round(ageMinutes / 60)} 小時，超過 ${MAX_BACKFILL_HOURS} 小時的部分補不回來`;
    }
  }
  return out;
}

/** 啟動 log 用的一行字 */
function describe(kind, r) {
  if (!r || !r.lastSuccessAt) return `${kind}：尚無成功紀錄`;
  const gap = r.gapBeyondBackfill ? '⚠ ' : '';
  return `${gap}${kind}：上次成功 ${r.lastSuccessAt}（${r.ageMinutes} 分鐘前${
    r.ageMinutes > 60 ? `，要補就下 --window ${r.suggestWindowMinutes}` : ''
  }）`;
}

module.exports = {
  STATE_FILE,
  MAX_BACKFILL_HOURS,
  filePath,
  read,
  recordSuccess,
  recordFailure,
  report,
  describe,
  fmtLocal,
};
