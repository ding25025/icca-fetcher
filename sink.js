#!/usr/bin/env node
'use strict';

/**
 * 撈完直接寫進中介資料庫（sink）
 * -------------------------------------------------
 * 原本的流程是「產 JSON → Rhapsody 轉格式 → POST 給廠商」，現在改成
 * vitals.js / neuro.js 撈完之後直接把資料寫進中介資料庫，中間不落檔、不轉 JSON。
 *
 * 兩張表，各對應一支工具，都是「一筆紀錄一列」（把 records[] 攤平）。
 * 欄位、型別與去重規則以 docs/interim-db-schema.html（對外的介接規格）為準：
 *   CDSUnvalidatedData  生命徵象               唯一鍵：lifetimeNumber + terseLabel + propName + chartTime
 *   CISData             神經評估與其他臨床紀錄   識別鍵：ptEncounterId + interventionId + chartTime
 *
 * 兩張表都沒有床號欄位（同一床會換病人、病人也會轉床），一律以病歷號認人；
 * 查不到病歷號的列整列不寫（見 writeRows 的 required）。
 *
 * 【只新增，不更新】寫進去的列不會被改、也不會被刪。三個理由——ICCA 那邊出事時
 * 直接重跑補資料就好，不必先想「這一輪會蓋掉什麼」；原地更新會把改動前的內容洗掉，
 * 事後查不出當初寫進來的到底是什麼；而且 UPDATE 要拿鎖、要動索引，是這張表最貴的
 * 寫入（舊版每輪的 MERGE 就慢在這裡）。
 *
 * 那重複怎麼辦：排程的時間窗一定會重疊（每 5 分鐘跑一次、窗開 6 分鐘），補資料時
 * 更是整段重撈。兩張表擋重複的方式不一樣，因為來源的性質不同：
 *
 *   CDSUnvalidatedData（dedupe: 'key'）
 *     來源的 CDS 是直接跑轉的環狀表，只寫不改，同一筆量測的內容不會變，所以
 *     「唯一鍵已經在表裡就不寫」（INSERT … WHERE NOT EXISTS）。一組唯一鍵永遠
 *     只有一列，下游讀到什麼就是什麼，不必挑版本——這是規格 §4 對外的承諾。
 *
 *   CISData（dedupe: 'hash'）
 *     護理師可以回頭改紀錄，改過的要多一列、舊的原封不動留著（規格 §3），所以識別鍵
 *     底下本來就會有多列，不能拿它當去重的依據。改看**內容**：每一列帶一個 SHA-1
 *     內容雜湊 rowHash，「表裡已經有一模一樣的內容就不寫」。時間窗重疊而重複撈到的
 *     完全一樣 → 不寫；護理師改過、或那筆被作廢（isDeleted 變 1）→ 內容不同 → 多一列。
 *     取現值就是同一組識別鍵裡 storeTime 最大的那一列（規格 §4 的範例 SQL）。
 *
 * 下游怎麼讀：水位線一律用 storeTime（ICCA 端的寫入時間），不是 insertedAt——
 * 同一批寫進來的列 insertedAt 完全相同，當水位線會在批次邊界重複讀或漏讀。
 * 兩張表都沒有流水號欄位，理由見規格 §4。
 *
 * 寫入方式：開一個交易 → 建 #stage 暫存表 → 分批 INSERT → 一次進正式表。
 * 分批是因為 SQL Server 單次請求最多 2100 個參數，一列 7~8 欄，所以一批約 250 列。
 *
 * 時間欄位一律以「字串字面值」綁參數再 CONVERT(欄位型別, …, 120)。
 * 直接綁 Date 物件會被 tedious 依 useUTC 再換算一次，變成又差 8 小時；
 * 走字面值就沒有這個問題——JSON 裡看到幾點，資料庫裡就是幾點。
 *
 * 設定放在自己的檔案 sink.config.json（預設檔名，見 SINK_CONFIG_FILE），跟
 * databases.config.json 分開——那個檔的 databases[] 是**資料來源**清單，
 * vitals.js 會照資料庫名稱自動分類（CDSUnvalidatedData* 當 CDS、其餘當 primary），
 * 中介庫放進去會被當成一台 primary。要換檔名就設環境變數 SINK_CONFIG 或加 --sink-config。
 * 舊設定（databases.config.json 裡的 "sink" 區塊）仍然讀得到，但獨立檔優先。
 *
 * 單獨執行（維護用，不撈資料）：
 *   node sink.js --ddl      印出建表 SQL，可交給院內 DBA 先建好
 *   node sink.js --init     直接連線建表（缺什麼建什麼，已存在的不動）
 *   node sink.js --check    連線並回報兩張表存在與否、目前筆數與最新一筆時間
 *   以上都吃 --sink-config <檔案>
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sql = require('mssql');
const ring = require('./ring.js');

// vitals.js 會 require 這個檔，這裡不能在載入時反向 require 回去（循環相依會拿到空物件）。
// 改成用到才要，require 有快取，那時 vitals.js 的 module.exports 已經指派完成。
let _V = null;
const V = () => (_V || (_V = require('./vitals.js')));

/** sink 的預設值。要調整就在 databases.config.json 加一個 "sink" 區塊覆寫。 */
const DEFAULTS = {
  // 沒設成 true 就完全不碰中介資料庫（命令列仍可用 --to-db 臨時打開）
  enabled: false,
  // 中介資料庫的連線；格式與 databases[].connection 完全一樣，密碼一樣支援 "env:變數名"
  connection: null,
  schema: 'dbo',
  vitalsTable: 'CDSUnvalidatedData',
  neuroTable: 'CISData',
  // 第一次執行時自動建表與索引（已存在的不動）。庫是院方的，開著沒有協調成本；
  // 正式環境改由院內 DBA 先建好的話就可以關掉。
  ensureTables: true,
  // 寫進資料庫之後還要不要照舊落一份 JSON 檔（預設不要，這就是這次改流程的目的）
  alsoWriteFile: false,
  // 一批幾列；0 = 依欄位數自動算（維持在 2100 個參數的上限內）
  batchRows: 0,
  queryTimeoutMs: 60000,
  // server.js 內建排程（不設就不啟用，見 server.js 的 startSchedule）
  schedule: null,
};

/** sink 設定檔的預設檔名。跟 databases.config.json 一樣含明文密碼，不進版控。 */
const SINK_CONFIG_FILE = 'sink.config.json';

/**
 * 讀 sink 的設定檔。
 * 檔案內容可以直接是設定本身，也可以包一層 "sink"（兩種都收，少一個踩雷點）。
 * 沒指定檔名又找不到預設檔時回 null——「沒設定」就是不寫資料庫，不是錯誤；
 * 但明講了檔名還找不到就要報錯，不然會安靜地照預設值跑一遍。
 */
function loadSinkFile(file) {
  const named = file || process.env.SINK_CONFIG || null;
  const abs = path.resolve(process.cwd(), named || SINK_CONFIG_FILE);
  if (!fs.existsSync(abs)) {
    if (named) throw new Error(`找不到 sink 設定檔：${abs}`);
    return null;
  }
  const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const s = raw && raw.sink ? raw.sink : raw;
  return { ...s, configFile: abs };
}

/**
 * DEFAULTS ← databases.config.json 的 "sink" 區塊（舊寫法，仍支援）← sink.config.json。
 * 獨立檔優先：中介庫是「寫進去的那一台」，跟資料來源清單分開放。
 */
function mergeSettings(cfg, sinkConfigFile) {
  const s = { ...DEFAULTS, ...((cfg && cfg.sink) || {}), ...(loadSinkFile(sinkConfigFile) || {}) };
  if (s.schedule) s.schedule = { vitalsMinutes: null, neuroMinutes: null, windowSlackMinutes: 1, ...s.schedule };
  return s;
}

/** enabled 或命令列的 --to-db 都算數；--no-db 一律優先 */
function wanted(settings, args = {}) {
  if (args.noDb) return false;
  return args.toDb === true || settings.enabled === true;
}

/**
 * 設定有沒有齊。要在撈資料之前就叫，不然是撈完整整一輪、要寫的那一刻才發現連線沒設，
 * 白跑一趟不說，排程模式下每一輪都會白跑一次。
 */
function assertConfigured(settings) {
  const c = settings.connection;
  if (!c || !c.server || !c.database) {
    throw new Error(
      '要寫進資料庫，但 sink 設定的 connection 不完整（至少要有 server 與 database）。' +
        `\n  設定檔：${settings.configFile || SINK_CONFIG_FILE}，範例見 sink.config.example.json；不想寫資料庫就加 --no-db。`
    );
  }
  return true;
}

// ---------- 兩張表的定義 ----------
// key: true 的欄位組成規格上的「唯一鍵／識別鍵」——這一筆臨床上是哪一筆。
// 一律 NOT NULL：文字欄位的 null 會正規化成空字串（propName 的空字串本來就是有意義的值），
// 下游照鑰匙分組時不必處理 NULL 不等於 NULL 的問題。
// 兩張表都是 append-only（只有 insertedAt 一個稽核欄，列寫進去就不會再被動到），
// 差別在 dedupe——「什麼叫做同一筆、不必再寫」：
//   dedupe: 'key'   鑰匙已經在表裡就不寫。一組鑰匙永遠只有一列，所以鑰匙就是主鍵。
//   dedupe: 'hash'  內容一模一樣就不寫。同一組識別鍵底下要放得下多個版本，所以
//                   不能建主鍵，改成叢集索引（識別鍵 + storeTime 分先後）＋ rowHash 索引。
// 欄位的 default 是建表時掛的預設值（來源沒給值時 DB 自己補）。

const VITALS_SPEC = {
  name: 'vitals',
  tableKey: 'vitalsTable',
  // 一組唯一鍵只有一列：來源的 CDS 只寫不改，同一筆量測的內容不會變（規格 §2、§4）。
  // 儀器讀值也不會被作廢，所以這張表沒有 isDeleted。
  dedupe: 'key',
  // 同一輪裡同一組唯一鍵出現兩次時（同一床出現在兩台 CDS）留哪一筆
  pickOrder: '[storeTime] DESC',
  columns: [
    // 病歷號是鑰匙的第一欄，也是唯一的病人識別（床號不寫進表）。
    // required：查不到病歷號的列整列不寫——見 writeRows。
    { name: 'lifetimeNumber', type: 'NVARCHAR(32)', kind: 'text', key: true, required: true },
    { name: 'terseLabel', type: 'NVARCHAR(32)', kind: 'text', key: true },
    // 細項（systolic/diastolic/mean）。單值項目（HR、CVP）是空字串而不是 NULL——它是鑰匙的一部分。
    { name: 'propName', type: 'NVARCHAR(64)', kind: 'text', key: true },
    // 臨床時間＝儀器量測到的那一刻。ICCA 來源端這一欄叫 measurementTime，
    // vitals.js 撈的時候（fetchVitals 的 SELECT）就改名成 chartTime，跟 dbo.CISData 對齊。
    { name: 'chartTime', type: 'DATETIME', kind: 'time', key: true },
    { name: 'numericValue', type: 'FLOAT', kind: 'float' },
    // 非數值的量測值（儀器送出的模式、狀態字串）。數值型的項目這一欄是 NULL，
    // 值在 numericValue；下游兩欄都要讀（規格 §2）。
    { name: 'textValue', type: 'NVARCHAR(256)', kind: 'text' },
    { name: 'storeTime', type: 'DATETIME', kind: 'time' },
  ],
  // 只建下游真的會用的那一條：增量讀取（WHERE storeTime > @last ORDER BY storeTime，規格 §4）。
  // 「某病人某段時間」的查詢靠主鍵開頭的 lifetimeNumber 就能 seek；每天 50 萬列的表，
  // 沒人查的索引就是純粹的寫入成本。要加隨時可以加。
  indexes: [{ name: 'IX_{T}_storeTime', cols: '[storeTime]' }],
};

const NEURO_SPEC = {
  name: 'neuro',
  tableKey: 'neuroTable',
  // 護理師可以回頭改紀錄，改過的要多一列、舊的留著（規格 §3），所以識別鍵底下會有多列，
  // 去重看內容雜湊而不是鑰匙。
  dedupe: 'hash',
  // 同一批裡出現內容完全一樣的兩列時留哪一筆（內容都一樣，留誰都行，取個穩定的順序）
  pickOrder: '[storeTime] DESC',
  columns: [
    // 病人的自然鍵用 ptEncounterId 而不是病歷號或床號：病歷號可能沒填，
    // 床號則會因為轉床而變動，兩者都認不出「這是同一筆紀錄的新版本」。
    { name: 'ptEncounterId', type: 'NVARCHAR(36)', kind: 'text', key: true },
    { name: 'interventionId', type: 'NVARCHAR(36)', kind: 'text', key: true },
    { name: 'chartTime', type: 'DATETIME', kind: 'time', key: true },
    // 病歷號不進自然鍵（同一位病人的鑰匙是 ptEncounterId），但一律要有值：
    // 查不到病歷號的列整列不寫——見 writeRows。床號不寫進表（轉床會變動）。
    { name: 'lifetimeNumber', type: 'NVARCHAR(32)', kind: 'text', notNull: true, required: true },
    // 項目名。長度照規格 §3 的 32——項目是開放清單，真的出現更長的標籤會被截斷，
    // 但不會默默發生：valuesOf 會計數，每一輪的結果訊息就印「⚠ 過長截斷 N」。
    // 看到那個警告就表示規格的 32 不夠，要回頭談欄位放寬。
    { name: 'terseLabel', type: 'NVARCHAR(32)', kind: 'text' },
    // terseForm 是不帶單位的原始值（E4V5M6、37.2）；verboseForm 是含單位／完整敘述的版本
    { name: 'terseForm', type: 'NVARCHAR(32)', kind: 'text' },
    { name: 'verboseForm', type: 'NVARCHAR(256)', kind: 'text' },
    // 護理師回頭改過的紀錄 storeTime 會變新——版本的先後、下游的水位線都看它
    { name: 'storeTime', type: 'DATETIME', kind: 'time' },
    // 作廢註記：ICCA 那筆被刪除／作廢時來源就是 1（neuro.js 的 Query 3 有撈）。
    // 列本身留著，下游要看得到「這筆沒了」這個變化——不要在查詢時就過濾掉（規格 §4）。
    // 來源沒給值時當成沒作廢（0），跟建表的預設值一致。
    { name: 'isDeleted', type: 'BIT', kind: 'bit', notNull: true, default: '(0)' },
  ],
  indexes: [
    // 下游的增量讀取（WHERE storeTime > @last，規格 §4）
    { name: 'IX_{T}_storeTime', cols: '[storeTime]' },
    // 寫入時「這個內容已經在表裡了嗎」的那一次查詢走這條
    { name: 'IX_{T}_rowHash', cols: '[rowHash]' },
  ],
};

const SPECS = { vitals: VITALS_SPEC, neuro: NEURO_SPEC };

/**
 * 內容雜湊欄。SHA-1 取滿 20 bytes，撞到的機率遠低於這張表其它任何一種出錯方式。
 * 只有 dedupe: 'hash' 的表有這一欄——它就是「這個內容已經寫過了嗎」的答案。
 */
const HASH_COL = { name: 'rowHash', type: 'BINARY(20)', kind: 'binary', notNull: true };

/** 實際寫進表裡的欄位（spec 的欄位，dedupe: 'hash' 的話再加 rowHash）。不含 insertedAt。 */
const colsOf = (spec) => (spec.dedupe === 'hash' ? [...spec.columns, HASH_COL] : spec.columns);

/** 鑰匙裡的時間欄（兩張表都叫 chartTime；ICCA 來源端的 vitals 叫 measurementTime） */
const timeKeyOf = (spec) => spec.columns.find((c) => c.key && c.kind === 'time').name;

// ---------- 建表 ----------
function safeIdent(name, label) {
  if (!/^[A-Za-z0-9_]+$/.test(String(name))) throw new Error(`${label} 含有不允許的字元：${name}`);
  return String(name);
}

function tableOf(spec, settings) {
  const schema = safeIdent(settings.schema || 'dbo', 'sink.schema');
  const table = safeIdent(settings[spec.tableKey], `sink.${spec.tableKey}`);
  return { schema, table, full: `[${schema}].[${table}]` };
}

/**
 * 建表 SQL。兩張表都沒有流水號欄位、也沒有 updatedAt／changedAt（規格 §4）：
 * 列寫進去就不會再被動到，稽核欄只有 insertedAt——那是拿來核對拋轉有沒有斷掉的（規格 §5），
 * 不是水位線，水位線是 storeTime。
 *
 * 叢集索引怎麼擺看 dedupe：
 *   'key'   一組鑰匙只有一列 → 鑰匙就是主鍵，去重的 NOT EXISTS 直接走它 seek
 *   'hash'  一組識別鍵有多列（版本）→ 不能建主鍵，改成一般叢集索引，
 *           識別鍵後面帶 storeTime，「取最新版本」與「某筆的完整歷史」都是一次 seek
 */
function ddlFor(spec, settings) {
  const { schema, table, full } = tableOf(spec, settings);
  const cols = colsOf(spec)
    .map(
      (c) =>
        `  [${c.name}] ${c.type} ${c.key || c.notNull ? 'NOT NULL' : 'NULL'}` +
        (c.default ? ` CONSTRAINT [DF_${table}_${c.name}] DEFAULT ${c.default}` : '') +
        ','
    )
    .join('\n');
  const keyCols = spec.columns.filter((c) => c.key).map((c) => `[${c.name}]`).join(', ');
  const byHash = spec.dedupe === 'hash';

  const create = `CREATE TABLE ${full} (
${cols}
  [insertedAt] DATETIME NOT NULL CONSTRAINT [DF_${table}_insertedAt] DEFAULT (SYSDATETIME())${
    byHash ? '' : `,\n  CONSTRAINT [PK_${table}] PRIMARY KEY CLUSTERED (${keyCols})`
  }
);`;

  const indexes = [
    ...(byHash ? [{ name: 'CX_{T}', cols: `${keyCols}, [storeTime]`, clustered: true }] : []),
    ...spec.indexes,
  ].map(
    (ix) =>
      `CREATE ${ix.clustered ? '' : 'NON'}CLUSTERED INDEX [${ix.name.replace('{T}', table)}] ON ${full} (${ix.cols});`
  );

  return { schema, table, full, create, indexes };
}

/** 完整的建表腳本（--ddl 印的、也是 ensureTables 實際跑的內容） */
function ddlScript(settings) {
  const parts = [];
  for (const spec of [VITALS_SPEC, NEURO_SPEC]) {
    const d = ddlFor(spec, settings);
    parts.push(
      `-- ${spec.name}：${d.full}`,
      `IF OBJECT_ID(N'${d.full}', N'U') IS NULL`,
      'BEGIN',
      d.create.split('\n').map((l) => '  ' + l).join('\n'),
      ...d.indexes.map((s) => '  ' + s),
      'END',
      'GO',
      ''
    );
  }
  return parts.join('\n');
}

/** 缺表就建（已存在的完全不動）。DDL 不放在寫入的交易裡，免得長時間佔著結構鎖。 */
async function ensureTable(pool, spec, settings) {
  const d = ddlFor(spec, settings);
  // 用 sp_executesql 而不是直接寫 CREATE TABLE：DDL 在 IF 區塊裡會在編譯期就被檢查，
  // 表已經存在時「索引重複」之類的錯誤會在還沒執行到 IF 之前就冒出來。
  const quoted = (s) => `EXEC sp_executesql N'${s.replace(/'/g, "''")}';`;
  await pool.request().batch(
    `SET NOCOUNT ON;
IF OBJECT_ID(N'${d.full}', N'U') IS NULL
BEGIN
  ${[d.create, ...d.indexes].map(quoted).join('\n  ')}
END`
  );
  return d;
}

// ---------- 值的正規化 ----------

/**
 * 時間一律轉成 DB 字面值字串（"2026-08-06 11:24:00"）再綁參數。
 * 撈回來的值有兩種形態：已經換算過時區的字串（預設），或 --utc 時的原始 Date。
 * 兩種都會變成同一種字面值，寫進去的時間跟 JSON 裡看到的完全一致。
 */
function toLiteral(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string') return v.trim().slice(0, 23).replace('T', ' ');
  return ring.fmtDb(v);
}

function maxLen(type) {
  const m = /\((\d+)\)/.exec(type);
  return m ? Number(m[1]) : null;
}

/** 一列的值照 spec.columns 的順序攤成陣列，順便回報被截斷的欄位數 */
function valuesOf(spec, row, stats) {
  return spec.columns.map((c) => {
    const raw = row[c.name];
    if (c.kind === 'time') return toLiteral(raw);
    if (c.kind === 'float') {
      const n = Number(raw);
      return raw == null || raw === '' || !Number.isFinite(n) ? null : n;
    }
    // 位元：來源可能給 true/false、1/0、'1'/'0'。沒值時 notNull 的欄位當 0
    // （「沒說作廢就是沒作廢」，跟建表的預設值一致），可為 null 的就留 null。
    if (c.kind === 'bit') {
      if (raw == null || raw === '') return c.notNull ? 0 : null;
      return raw === '0' || raw === 0 || raw === false ? 0 : 1;
    }
    // 文字：鑰匙欄位的 null 要正規化成空字串，否則去重時（NOT EXISTS／MERGE）永遠比不中；
    // notNull 的欄位同理，不然整批會因為 NOT NULL 而寫不進去
    if (raw == null) return c.key || c.notNull ? '' : null;
    let s = String(raw);
    const lim = maxLen(c.type);
    if (lim && s.length > lim) {
      s = s.slice(0, lim);
      stats.truncated++;
    }
    return s;
  });
}

/**
 * 內容雜湊。輸入是「已經正規化過的值」（valuesOf 的結果），所以雜湊看到的東西
 * 跟真正寫進表裡的完全一致——截斷過的字串、補成空字串的 null、0/1 的位元都一樣。
 *
 * 格式刻意做成 SQL 端也算得出來的樣子（見 sql/sink-migrate.sql 補算既有列的那一段）：
 *   欄位值以 U+001F 相接 → 以 UTF-16LE 編碼 → SHA-1
 *   null 一律當空字串；時間取到秒（19 個字），對上 CONVERT(NVARCHAR(19), col, 120)
 * 這一段動到就等於「所有既有的列都算不出同一個雜湊」，等同全部重寫一次，不要隨手改。
 */
const HASH_SEP = ''; // NCHAR(31)，資料裡不會出現的分隔字元
function rowHashOf(spec, values) {
  const parts = spec.columns.map((c, i) => {
    const v = values[i];
    if (v == null) return '';
    return c.kind === 'time' ? String(v).slice(0, 19) : String(v);
  });
  return crypto.createHash('sha1').update(parts.join(HASH_SEP), 'utf16le').digest();
}

/** 一列要綁進 SQL 的值，順序對齊 colsOf(spec)（dedupe: 'hash' 時最後多一個 rowHash） */
function cellsOf(spec, row, stats) {
  const values = valuesOf(spec, row, stats);
  return spec.dedupe === 'hash' ? [...values, rowHashOf(spec, values)] : values;
}

const bindType = (c) => {
  if (c.kind === 'float') return sql.Float;
  if (c.kind === 'bit') return sql.Bit;
  if (c.kind === 'binary') return sql.VarBinary(maxLen(c.type) || 20);
  // 時間也走文字（字面值 + CONVERT，見 cellExpr），所以剩下的一律 NVarChar
  return sql.NVarChar(c.kind === 'time' ? 30 : maxLen(c.type) || 200);
};
// 時間走字面值 + 明確的 style 120（yyyy-mm-dd hh:mi:ss），不受伺服器語系與 DATEFORMAT 影響。
// 轉成欄位自己宣告的型別（兩張表現在都是 DATETIME，規格 §1）。
const cellExpr = (c, p) => (c.kind === 'time' ? `CONVERT(${c.type}, ${p}, 120)` : p);

function batchSizeFor(spec, settings) {
  if (settings.batchRows > 0) return settings.batchRows;
  return Math.max(1, Math.min(1000, Math.floor(2000 / colsOf(spec).length)));
}

/** 一批的 INSERT（多列 VALUES），參數名帶列序號避免撞名 */
async function insertBatch(reqFactory, target, spec, chunk, stats) {
  const req = reqFactory();
  const all = colsOf(spec);
  const tuples = chunk.map((row, i) => {
    const vals = cellsOf(spec, row, stats);
    return (
      '(' +
      all
        .map((c, j) => {
          const p = `${c.name}_${i}`;
          req.input(p, bindType(c), vals[j]);
          return cellExpr(c, `@${p}`);
        })
        .join(', ') +
      ')'
    );
  });
  const cols = all.map((c) => `[${c.name}]`).join(', ');
  await req.query(`SET NOCOUNT ON;\nINSERT INTO ${target} (${cols}) VALUES\n  ${tuples.join(',\n  ')};`);
}

/**
 * 只新增：#stage → 正式表。兩張表都走這一條，差別只在「什麼算同一筆」：
 *   dedupe: 'key'   鑰匙已經在表裡就不寫 → 一組鑰匙永遠只有一列（規格 §4 對 CDS 的承諾）
 *   dedupe: 'hash'  內容一模一樣就不寫 → 改過的內容雜湊不同，會多一列，舊的原封不動留著
 *
 * 兩種情況下，已經寫進去的列都一個字都不會被動到；同一段時間重跑幾次結果都一樣。
 *
 * 來源要先用 ROW_NUMBER 去掉同一批裡重複的（同一床出現在兩台 CDS、或同一筆紀錄被撈兩次），
 * 不然一次 INSERT 裡就有兩列一樣的東西，key 模式會直接撞上主鍵。
 *
 * NOT EXISTS 那裡加 UPDLOCK, HOLDLOCK：查完到寫進去之間把那個範圍鎖住，
 * 免得兩輪同時跑時兩邊都查到「不存在」，結果寫進去兩列。
 */
function appendSql(spec, target, stage) {
  const all = colsOf(spec);
  const cols = all.map((c) => `[${c.name}]`).join(', ');
  // 判斷「同一筆」看哪些欄位：內容雜湊，或鑰匙
  const by = spec.dedupe === 'hash' ? [HASH_COL] : spec.columns.filter((c) => c.key);
  const part = by.map((c) => `[${c.name}]`).join(', ');
  const on = by.map((c) => `t.[${c.name}] = s.[${c.name}]`).join(' AND ');
  return `SET NOCOUNT ON;
WITH src AS (
  SELECT ${cols},
         ROW_NUMBER() OVER (PARTITION BY ${part} ORDER BY ${spec.pickOrder}) AS _rn
  FROM ${stage}
)
INSERT INTO ${target} (${cols})
SELECT ${cols}
FROM   src AS s
WHERE  s._rn = 1
  AND  NOT EXISTS (
         SELECT 1 FROM ${target} AS t WITH (UPDLOCK, HOLDLOCK)
         WHERE ${on}
       );
SELECT @@ROWCOUNT AS n;`;
}

// ---------- 寫入 ----------

/**
 * 把攤平後的列寫進中介資料庫。
 * 回傳 { total, written, skipped, truncated, table, ms }。
 * skipped 是鑰匙缺值（例如沒有 chartTime）或**沒有病歷號**而不寫的列——
 * 前者沒有辦法去重，寧可算漏也不要每輪都重複寫一份；後者是約定：認不出是誰的資料不進表。
 * 沒有 updated：兩張表都只新增，寫進去的列不會被改。
 */
async function writeRows(kind, rows, settings) {
  const spec = SPECS[kind];
  if (!spec) throw new Error(`未知的 sink 種類：${kind}`);
  assertConfigured(settings);

  const started = Date.now();
  const stats = { total: rows.length, written: 0, skipped: 0, truncated: 0 };

  // 鑰匙裡的時間欄位沒值、或 required 欄位（病歷號）沒值的列先挑掉。
  // required 只認 null / undefined / 空字串——propName 的空字串是有意義的值，不在此列。
  const keyTimes = spec.columns.filter((c) => c.key && c.kind === 'time');
  const required = spec.columns.filter((c) => c.required);
  const usable = rows.filter(
    (r) =>
      keyTimes.every((c) => toLiteral(r[c.name]) != null) &&
      required.every((c) => r[c.name] != null && String(r[c.name]).trim() !== '')
  );
  stats.skipped = rows.length - usable.length;

  const { full } = tableOf(spec, settings);
  stats.table = full;
  if (!usable.length) {
    stats.ms = Date.now() - started;
    return stats;
  }

  const timeout = settings.queryTimeoutMs || 60000;
  const pool = await V().connect(settings.connection, timeout);
  try {
    if (settings.ensureTables !== false) await ensureTable(pool, spec, settings);

    const size = batchSizeFor(spec, settings);
    const chunks = [];
    for (let i = 0; i < usable.length; i += size) chunks.push(usable.slice(i, i + size));

    // 交易會把後面這幾個請求釘在同一條連線上，#stage 才活得過整段流程
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const stage = '#stage';
      const stageCols = colsOf(spec).map((c) => `  [${c.name}] ${c.type} NULL`).join(',\n');
      // ⚠ 這一句一定要用 batch() 不能用 query()。
      // query() 走 tedious 的 execSql，會被包進 sp_executesql 執行；在 sp_executesql
      // 裡建的區域暫存表，作用域只到那一次呼叫結束——回來之後 #stage 就不存在了，
      // 後面的 INSERT 會拿到 "Invalid object name '#stage'"。
      // batch() 走 execSqlBatch，直接送批次，暫存表才活在整個連線工作階段裡。
      // 後面帶參數的 INSERT 照樣用 query()：它們是「讀得到外層暫存表」的那一邊，沒問題。
      await new sql.Request(tx).batch(`SET NOCOUNT ON;\nCREATE TABLE ${stage} (\n${stageCols}\n);`);
      for (const c of chunks) await insertBatch(() => new sql.Request(tx), stage, spec, c, stats);

      // 已經在表裡的（同鑰匙或同內容）不會被寫，也不會被更新
      const r = await new sql.Request(tx).query(appendSql(spec, full, stage));
      stats.written = Number((r.recordset || [])[0]?.n) || 0;
      await tx.commit();
    } catch (e) {
      await tx.rollback().catch(() => {});
      throw e;
    }
  } finally {
    await V().release(pool);
  }

  stats.ms = Date.now() - started;
  return stats;
}

// ---------- 攤平：一床/一人一筆 → 一筆紀錄一列 ----------

/**
 * vitals.js 的 rows（{ bed, lifetimeNumber, records[] }）攤平成 CDSUnvalidatedData 的列。
 * 床號不寫進表（同一床會換病人、病人也會轉床），一律以病歷號認人。
 * 欄名一路都對得上（vitals.js 撈的時候就把 ICCA 的 measurementTime 改名成 chartTime），
 * 所以這裡只是把 records[] 攤平、把病歷號帶到每一列上。
 */
function flattenVitals(rows) {
  const out = [];
  for (const g of rows || []) {
    for (const r of g.records || []) {
      out.push({
        lifetimeNumber: g.lifetimeNumber != null ? g.lifetimeNumber : null,
        terseLabel: r.terseLabel,
        propName: r.propName,
        chartTime: r.chartTime,
        numericValue: r.numericValue,
        // 數值型的量測沒有這一欄（vitals.js 是 null 就不輸出），寫進表時補成 NULL
        textValue: r.textValue != null ? r.textValue : null,
        storeTime: r.storeTime,
      });
    }
  }
  return out;
}

/**
 * neuro.js 的 rows（{ lifetimeNumber, bed, records[] }）攤平成 CISData 的列。
 * ptEncounterId 不在 JSON 輸出裡（collect() 把它掛成不可列舉的 _encounterId），
 * 這裡取出來當去重的鑰匙；真的沒有時退回病歷號，至少不會整床塌在一起。
 */
function flattenNeuro(rows) {
  const out = [];
  for (const g of rows || []) {
    const enc = g._encounterId || g.lifetimeNumber || '';
    for (const r of g.records || []) {
      out.push({
        ptEncounterId: enc,
        interventionId: r.interventionId,
        chartTime: r.chartTime,
        lifetimeNumber: g.lifetimeNumber != null ? g.lifetimeNumber : null,
        terseLabel: r.terseLabel,
        terseForm: r.terseForm,
        verboseForm: r.verboseForm,
        storeTime: r.storeTime,
        isDeleted: r.isDeleted,
      });
    }
  }
  return out;
}

const writeVitals = (rows, settings) => writeRows('vitals', flattenVitals(rows), settings);
const writeNeuro = (rows, settings) => writeRows('neuro', flattenNeuro(rows), settings);

/** 給命令列與 server.js 共用的一行結果訊息 */
function describe(stats) {
  const bits = [`${stats.table}：${stats.written} 筆寫入`];
  const dup = stats.total - stats.skipped - stats.written;
  if (dup > 0) bits.push(`重複略過 ${dup}`);
  if (stats.skipped) bits.push(`⚠ 缺鑰匙欄位或病歷號略過 ${stats.skipped}`);
  if (stats.truncated) bits.push(`⚠ 過長截斷 ${stats.truncated}`);
  return bits.join('，') + `（共 ${stats.total} 筆，${(stats.ms / 1000).toFixed(1)}s）`;
}

/** --dry-run 用：中介資料庫是哪一台、哪兩張表 */
function describeTarget(settings) {
  const c = settings.connection || {};
  return (
    `${c.server || '(未設定)'}:${c.port || 1433}/${c.database || '(未設定)'}` +
    `　表：${tableOf(VITALS_SPEC, settings).full}、${tableOf(NEURO_SPEC, settings).full}`
  );
}

// ---------- 維護用命令列 ----------
async function main() {
  const argv = process.argv.slice(2);
  const flagValue = (...names) => {
    const i = argv.findIndex((t) => names.includes(t));
    return i >= 0 ? argv[i + 1] : null;
  };
  const configPath = flagValue('--config', '-c') || 'databases.config.json';
  const sinkPath = flagValue('--sink-config');

  // databases.config.json 只是為了讀舊寫法的 "sink" 區塊，沒有也無所謂——
  // 設定本來就該在 sink.config.json。
  const cfg = fs.existsSync(path.resolve(process.cwd(), configPath))
    ? JSON.parse(fs.readFileSync(path.resolve(process.cwd(), configPath), 'utf8'))
    : null;
  const settings = mergeSettings(cfg, sinkPath);

  if (argv.includes('--ddl')) {
    console.log(ddlScript(settings));
    return;
  }

  if (!settings.connection) {
    throw new Error(
      `沒有中介資料庫的連線資訊（connection）。設定放在 ${sinkPath || process.env.SINK_CONFIG || SINK_CONFIG_FILE}` +
        `，範例見 sink.config.example.json。`
    );
  }
  console.log(`設定：${settings.configFile || `${configPath} 的 "sink" 區塊`}`);
  const pool = await V().connect(settings.connection, settings.queryTimeoutMs || 60000);
  try {
    if (argv.includes('--init')) {
      for (const spec of [VITALS_SPEC, NEURO_SPEC]) {
        await ensureTable(pool, spec, settings);
        console.log(`✓ ${tableOf(spec, settings).full}`);
      }
      console.log('建表完成（已存在的沒有更動）。');
      return;
    }

    // 預設 --check：兩張表在不在、幾筆、最新一筆是什麼時候
    console.log(`目標：${describeTarget(settings)}\n`);
    for (const spec of [VITALS_SPEC, NEURO_SPEC]) {
      const { full } = tableOf(spec, settings);
      const timeCol = timeKeyOf(spec);
      const r = await pool
        .request()
        .query(
          `IF OBJECT_ID(N'${full}', N'U') IS NULL SELECT 0 AS ok, 0 AS n, NULL AS newest
           ELSE SELECT 1 AS ok, COUNT(*) AS n, MAX([${timeCol}]) AS newest FROM ${full} WITH (NOLOCK);`
        );
      const row = (r.recordset || [])[0] || {};
      if (!row.ok) console.log(`  ✗ ${full}：不存在（node sink.js --init 可建立）`);
      else console.log(`  ✓ ${full}：${row.n} 筆，最新 ${ring.fmtDb(row.newest) || '（空表）'}`);
    }
  } finally {
    await V().release(pool);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`\n發生錯誤：${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULTS,
  SINK_CONFIG_FILE,
  loadSinkFile,
  mergeSettings,
  wanted,
  assertConfigured,
  writeVitals,
  writeNeuro,
  writeRows,
  flattenVitals,
  flattenNeuro,
  ddlScript,
  ddlFor,
  ensureTable,
  appendSql,
  rowHashOf,
  valuesOf,
  tableOf,
  describe,
  describeTarget,
  toLiteral,
  VITALS_SPEC,
  NEURO_SPEC,
};
