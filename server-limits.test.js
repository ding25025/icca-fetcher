'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
const rows = () => ({ failures: 0, sites: ['cds1'], settings: {}, rows: [], total: 0,
  summary: [{ site: 'cds1', ok: true }], bySite: { cds1: [] } });

// Exercise the real HTTP handler without opening a port or connecting to production DBs.
function harness({ collect, write = async () => ({}), jobTimeoutMs = 1000, maxQueuedRequests = 1,
  ring = {}, sql = {}, extraConfig = {} }) {
  let handler;
  const failures = [];
  const config = { ...extraConfig, server: { jobTimeoutMs, maxQueuedRequests, queueTimeoutMs: 500 } };
  const mocks = {
    http: { createServer: (fn) => { handler = fn; return { listen() {} }; } },
    fs: { existsSync: () => true, readFileSync: () => JSON.stringify(config) },
    mssql: sql,
    './ring.js': ring,
    './vitals.js': { keepPools() {}, collect },
    './neuro.js': {},
    './sink.js': { mergeSettings: () => ({}), wanted: () => true, assertConfigured() {}, writeVitals: write },
    './state.js': { MAX_BACKFILL_HOURS: 24, report: () => ({}), filePath: () => 'test-state',
      recordFailure: (kind, message) => failures.push({ kind, message }), recordSourceFailure() {},
      recordSourceSuccess() {}, pruneSources() {} },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8'), {
    require: (name) => Object.hasOwn(mocks, name) ? mocks[name] : require(name),
    process: { env: {}, cwd: () => __dirname, uptime: () => 1000, on() {} },
    console: { log() {}, warn() {}, error() {} }, URL, URLSearchParams, AbortController,
    setTimeout, clearTimeout, setInterval, clearInterval,
  }, { filename: 'server.js' });
  function call(url) {
    const done = deferred();
    const res = new EventEmitter();
    res.headers = {};
    res.setHeader = (name, value) => { res.headers[name] = value; };
    res.writeHead = (status, headers) => { res.status = status; Object.assign(res.headers, headers); };
    res.end = (body) => { res.writableEnded = true; done.resolve({ status: res.status, body: JSON.parse(body), headers: res.headers }); };
    handler({ method: 'GET', url, headers: {} }, res).catch(done.resolve);
    return done.promise;
  }
  return { call, failures };
}

test('ring sites run independently while default and case aliases share the same slot', async () => {
  const hold = deferred();
  const entered = deferred();
  const realRing = require('./ring');
  const ring = { ...realRing, scanRing: async (pool) => {
    if (pool.config.server === 'cds1') { entered.resolve(); await hold.promise; }
    return [];
  } };
  class Pool extends EventEmitter {
    constructor(config) { super(); this.config = config; this.connected = true; }
    async connect() { return this; }
    async close() {}
  }
  const app = harness({ ring, sql: { ConnectionPool: Pool }, maxQueuedRequests: '0',
    extraConfig: { databases: ['cds1', 'cds2'].map((name) => ({ name,
      connection: { server: name, database: 'CDSUnvalidatedDataDB' } })) } });
  const first = app.call('/icca/head');
  await entered.promise;
  for (const endpoint of ['head', 'order', 'latest', 'at']) {
    const blocked = await app.call(`/icca/${endpoint}?site=CDS1`);
    assert.equal(blocked.status, 503);
    assert.match(blocked.body.error, /工作忙碌/);
  }
  const other = await app.call('/icca/head?site=cds2');
  // Empty fixture data reaches the handler's scan error, not admission rejection.
  assert.match(other.body.error, /無法判斷寫入頭/);
  const unknown = await app.call('/icca/head?site=unknown');
  assert.match(unknown.body.error, /找不到站台/);
  hold.resolve();
  await first;
  const recovered = await app.call('/icca/head?site=cds1');
  assert.match(recovered.body.error, /無法判斷寫入頭/);
});

test('HTTP reads cannot overtake an in-progress push write; overload is 503; health bypasses queue', async () => {
  const writing = deferred();
  const release = deferred();
  let collections = 0;
  const app = harness({ collect: async () => { collections++; return rows(); },
    write: async () => { writing.resolve(); await release.promise; return {}; } });
  const push = app.call('/icca/push/vitals');
  await writing.promise;
  const queued = app.call('/icca/vitals');
  const full = await app.call('/icca/vitals');
  assert.equal(full.status, 503);
  assert.equal(full.headers['Retry-After'], '30');
  assert.equal((await app.call('/health')).status, 200);
  assert.equal(collections, 1);
  release.resolve();
  assert.equal((await push).status, 200);
  assert.equal((await queued).status, 200);
  assert.equal(collections, 2);
});

test('HTTP deadline returns 504, records push failure, and late collection cannot write', async () => {
  const hold = deferred();
  let writes = 0;
  const app = harness({ collect: () => hold.promise, jobTimeoutMs: 20, maxQueuedRequests: 0,
    write: async () => { writes++; return {}; } });
  const result = await app.call('/icca/push/vitals');
  assert.equal(result.status, 504);
  assert.ok(app.failures.some((x) => x.kind === 'vitals'));
  assert.equal((await app.call('/icca/vitals')).status, 503);
  hold.resolve(rows());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes, 0);
  assert.equal((await app.call('/icca/vitals')).status, 200);
});
