'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateHealth } = require('./health');

const good = () => ({
  sourceCount: 1, oldestSuccessAt: '2026-09-09 10:00:00', oldestAgeMinutes: 5,
  failedSources: [], sources: { cds1: { lastSuccessAt: '2026-09-09 10:00:00' } },
});
function check(report = good(), overrides = {}) {
  return evaluateHealth({ sinkOn: true, schedule: { vitalsMinutes: 5 },
    lastWrite: { vitals: report }, uptimeSec: 600, ...overrides });
}

test('healthy writes and disabled sink return 200', () => {
  assert.equal(check().status, 'ok');
  assert.equal(check({}, { sinkOn: false }).httpStatus, 200);
});
test('staleness uses three intervals, including threshold boundary', () => {
  assert.equal(check({ ...good(), oldestAgeMinutes: 15 }).status, 'ok');
  const result = check({ ...good(), oldestAgeMinutes: 16 });
  assert.equal(result.httpStatus, 503);
  assert.deepEqual(result.checks.vitals.reasons, ['stale']);
});
test('partial and whole-run failures are unhealthy even during startup', () => {
  for (const report of [
    { ...good(), failedSources: ['cds2'] },
    { lastError: 'database offline' },
    { ...good(), sources: { cds1: { lastError: 'write failed' } } },
  ]) assert.equal(check(report, { uptimeSec: 1 }).httpStatus, 503);
});
test('missing success gets startup grace, but stale history does not', () => {
  assert.equal(check({}, { uptimeSec: 119 }).status, 'starting');
  assert.equal(check({}, { uptimeSec: 120 }).httpStatus, 503);
  assert.equal(check({ ...good(), oldestAgeMinutes: 50 }, { uptimeSec: 1 }).httpStatus, 503);
  assert.equal(check({ ...good(), sources: { cds2: { lastSuccessAt: null } } }).httpStatus, 503);
});
test('unrecoverable gap stays unhealthy even with a larger stale threshold', () => {
  const result = check({ ...good(), gapBeyondBackfill: true });
  assert.ok(result.checks.vitals.reasons.includes('gap_beyond_backfill'));
  assert.equal(result.httpStatus, 503);
});
test('external scheduling can be explicitly monitored before its first write', () => {
  assert.deepEqual(check({}, { schedule: {} }).checks, {});
  assert.equal(check({}, { schedule: {}, settings: { staleMinutes: { vitals: 30 } } }).httpStatus, 503);
  assert.equal(check({ ...good(), oldestAgeMinutes: 16 }, { schedule: {} }).httpStatus, 503);
});
test('manual-only kinds can be excluded and thresholds/grace configured', () => {
  assert.equal(check({ lastError: 'old manual error' }, {
    settings: { staleMinutes: { vitals: false } },
  }).status, 'ok');
  assert.equal(check({ ...good(), oldestAgeMinutes: 20 }, {
    settings: { staleMinutes: { vitals: 30 } },
  }).status, 'ok');
  assert.equal(check({}, { uptimeSec: 180, settings: { startupGraceMinutes: 5 } }).status, 'starting');
});
test('recovery returns health to ok and independent kinds affect overall status', () => {
  assert.equal(check({ lastError: 'offline' }).status, 'degraded');
  assert.equal(check(good()).status, 'ok');
  const result = check(good(), { schedule: { vitalsMinutes: 5, neuroMinutes: 5 } });
  assert.equal(result.checks.vitals.status, 'ok');
  assert.equal(result.checks.neuro.status, 'degraded');
  assert.equal(result.httpStatus, 503);
});
