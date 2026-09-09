'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WorkLimits, checkpoint, request } = require('./work-limits');
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('bounded FIFO queue, no overlap, independent kinds', async () => {
  const limits = new WorkLimits({ maxQueued: 1, jobTimeoutMs: 1000 });
  const hold = deferred();
  const order = [];
  const first = limits.run('vitals', async () => { order.push(1); await hold.promise; order.push(2); });
  const second = limits.run('vitals', () => order.push(3));
  await assert.rejects(limits.run('vitals', () => assert.fail()), { status: 503 });
  assert.equal(await limits.run('neuro', () => 42), 42);
  assert.deepEqual(order, [1]);
  hold.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, [1, 2, 3]);
});

test('waiting expiration removes work without executing it', async () => {
  const limits = new WorkLimits({ queueTimeoutMs: 15, jobTimeoutMs: 1000 });
  const hold = deferred();
  const first = limits.run('vitals', () => hold.promise);
  await assert.rejects(limits.run('vitals', () => assert.fail()), { status: 503 });
  hold.resolve();
  await first;
  assert.equal(await limits.run('vitals', () => 'next'), 'next');
});

test('disconnected waiting request is removed; active work is not aborted', async () => {
  const limits = new WorkLimits({ maxQueued: 1, jobTimeoutMs: 1000 });
  const hold = deferred();
  const controller = new AbortController();
  const first = limits.run('vitals', () => hold.promise, { signal: controller.signal });
  const queued = limits.run('vitals', () => assert.fail(), { signal: controller.signal });
  const rejection = assert.rejects(queued, /disconnected/);
  controller.abort(new Error('disconnected'));
  await rejection;
  const next = limits.run('vitals', () => 3);
  hold.resolve(2);
  assert.equal(await first, 2);
  assert.equal(await next, 3);
});

test('timeout cancels SQL and keeps slot until real cleanup finishes', async () => {
  const limits = new WorkLimits({ jobTimeoutMs: 20 });
  const cleanup = deferred();
  const sqlDone = deferred();
  let cancelled = 0;
  let marked = 0;
  const parent = { request: () => ({
    query: () => sqlDone.promise, batch: () => sqlDone.promise,
    cancel: () => { cancelled++; },
  }) };
  const first = limits.run('vitals', async () => {
    try { await request(parent).query('SELECT 1'); }
    finally { await cleanup.promise; }
  }, { onTimeout: () => marked++ });
  assert.equal(limits.isBusy('vitals'), true);
  assert.equal(limits.isBusy('neuro'), false);
  await assert.rejects(first, { status: 504 });
  assert.equal(limits.isBusy('vitals'), true);
  assert.equal(cancelled, 1);
  assert.equal(marked, 1);
  await assert.rejects(limits.run('vitals', () => assert.fail(), { noQueue: true }), { status: 503 });
  sqlDone.resolve({});
  cleanup.resolve();
  await tick();
  assert.equal(limits.isBusy('vitals'), false);
  assert.equal(await limits.run('vitals', () => 'recovered'), 'recovered');
});

test('deadline prevents later writes even if an earlier operation catches cancellation', async () => {
  const limits = new WorkLimits({ jobTimeoutMs: 15 });
  const hold = deferred();
  let blocked = false;
  const first = limits.run('vitals', async () => {
    await hold.promise;
    try { checkpoint(); } catch (_) { blocked = true; }
    request({ request: () => assert.fail('must not start SQL after deadline') });
  });
  await assert.rejects(first, { status: 504 });
  hold.resolve();
  await tick();
  assert.equal(blocked, true);
});

test('normal completion clears deadline and request cancel listener', async () => {
  const limits = new WorkLimits({ jobTimeoutMs: 20 });
  let cancelled = 0;
  const parent = { request: () => ({ query: async () => 1, batch: async () => 2, cancel: () => cancelled++ }) };
  assert.equal(await limits.run('ring', () => request(parent).query('SELECT')), 1);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(cancelled, 0);
  assert.equal(await request(parent).batch('SELECT'), 2);
});
