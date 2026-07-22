#!/usr/bin/env node
'use strict';

/**
 * ICCA 多資料庫抓取工具
 * -------------------------------------------------
 * 同時（平行）連線多個 SQL Server，各自跑自訂 SQL，
 * 把結果合併成「單一 JSON 陣列」，每一筆標記來源資料庫，
 * 最後寫出成一個 JSON 檔。
 *
 * 用法：
 *   node index.js                       使用 databases.config.json
 *   node index.js --config my.json      指定其他設定檔
 *   node index.js --out result.json     覆寫輸出檔名
 *   node index.js --pretty              輸出縮排美化的 JSON
 */

const fs = require('fs');
const path = require('path');
const sql = require('mssql');

// ---------- 解析命令列參數 ----------
function parseArgs(argv) {
  const args = { config: 'databases.config.json', out: null, pretty: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config' || a === '-c') args.config = argv[++i];
    else if (a === '--out' || a === '-o') args.out = argv[++i];
    else if (a === '--pretty' || a === '-p') args.pretty = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function printHelp() {
  console.log(`
ICCA 多資料庫抓取工具

  node index.js [選項]

選項：
  -c, --config <檔案>   指定設定檔（預設 databases.config.json）
  -o, --out <檔案>      指定輸出 JSON 檔（覆寫設定檔中的 output）
  -p, --pretty         輸出縮排美化的 JSON
  -h, --help           顯示此說明
`);
}

// ---------- 讀取設定檔 ----------
function loadConfig(configPath) {
  const abs = path.resolve(process.cwd(), configPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`找不到設定檔：${abs}`);
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    throw new Error(`設定檔 JSON 格式錯誤：${e.message}`);
  }
  if (!Array.isArray(cfg.databases) || cfg.databases.length === 0) {
    throw new Error('設定檔中的 "databases" 必須是非空陣列');
  }
  return cfg;
}

// 支援密碼從環境變數讀取：值寫成 "env:MY_PASSWORD" 時，改讀 process.env.MY_PASSWORD
function resolveSecret(value) {
  if (typeof value === 'string' && value.startsWith('env:')) {
    const key = value.slice(4);
    const v = process.env[key];
    if (v === undefined) {
      throw new Error(`環境變數 ${key} 未設定`);
    }
    return v;
  }
  return value;
}

// ---------- 查詢單一資料庫 ----------
async function queryOne(dbConf, queryTimeoutMs) {
  const conn = { ...dbConf.connection };
  if (conn.password) conn.password = resolveSecret(conn.password);
  if (conn.user) conn.user = resolveSecret(conn.user);
  if (typeof queryTimeoutMs === 'number') conn.requestTimeout = queryTimeoutMs;

  // 每個資料庫用獨立的連線池，彼此不干擾
  const pool = new sql.ConnectionPool(conn);
  try {
    await pool.connect();
    const result = await pool.request().query(dbConf.query);
    const rows = result.recordset || [];
    // 為每一筆標記來源資料庫
    const tagged = rows.map((row) => ({ _source: dbConf.name, ...row }));
    return { name: dbConf.name, ok: true, count: tagged.length, rows: tagged };
  } finally {
    // 無論成功失敗都關閉連線池
    try { await pool.close(); } catch (_) { /* 忽略關閉錯誤 */ }
  }
}

// ---------- 主流程 ----------
async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  const cfg = loadConfig(args.config);
  const outFile = args.out || cfg.output || 'icca-data.json';
  const queryTimeoutMs = cfg.queryTimeoutMs || 60000;

  const targets = cfg.databases.filter((d) => d.enabled !== false);
  if (targets.length === 0) {
    throw new Error('沒有任何 enabled 的資料庫可查詢');
  }

  console.log(`開始平行查詢 ${targets.length} 個資料庫...`);
  const started = Date.now();

  // 平行執行；用 allSettled 讓單一資料庫失敗不會中斷其它查詢
  const settled = await Promise.allSettled(
    targets.map((d) => queryOne(d, queryTimeoutMs))
  );

  const merged = [];
  const summary = [];
  let failures = 0;

  settled.forEach((s, i) => {
    const name = targets[i].name;
    if (s.status === 'fulfilled') {
      merged.push(...s.value.rows);
      summary.push({ database: name, ok: true, count: s.value.count });
      console.log(`  ✓ ${name}：${s.value.count} 筆`);
    } else {
      failures++;
      const msg = s.reason && s.reason.message ? s.reason.message : String(s.reason);
      summary.push({ database: name, ok: false, error: msg });
      console.error(`  ✗ ${name}：查詢失敗 - ${msg}`);
    }
  });

  // 寫出合併後的單一 JSON 陣列
  const json = args.pretty ? JSON.stringify(merged, null, 2) : JSON.stringify(merged);
  const outAbs = path.resolve(process.cwd(), outFile);
  fs.writeFileSync(outAbs, json, 'utf8');

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log('----------------------------------------');
  console.log(`合併總筆數：${merged.length}`);
  console.log(`成功：${targets.length - failures} / ${targets.length}，耗時 ${secs}s`);
  console.log(`已輸出：${outAbs}`);

  // 若全部失敗則以非零結束碼退出，方便排程或 CI 判斷
  if (failures === targets.length) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\n發生錯誤：${err.message}`);
  process.exitCode = 1;
});
