'use strict';

// Health polling evaluates recorded writes without connecting to a database.
function evaluateHealth({ sinkOn, schedule = {}, settings = {}, lastWrite, uptimeSec }) {
  if (!sinkOn) return { status: 'ok', httpStatus: 200, checks: {} };
  const positive = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0
    ? Number(value) : fallback;
  const graceMinutes = positive(settings.startupGraceMinutes, 2);
  const checks = {};
  for (const kind of ['vitals', 'neuro']) {
    const report = lastWrite?.[kind] || {};
    const interval = positive(schedule[`${kind}Minutes`], 0);
    const configured = settings.staleMinutes?.[kind];
    // Explicit false opts manual-only kinds out of freshness monitoring.
    const observed = report.sourceCount > 0 || Boolean(report.lastError);
    if (configured === false || (!interval && !observed && configured == null)) continue;
    const staleMinutes = positive(configured, interval ? interval * 3 : 15);
    const reasons = [];
    const sources = Object.entries(report.sources || {});
    const failedSources = [...new Set([
      ...(report.failedSources || []),
      ...sources.filter(([, s]) => s.lastError).map(([name]) => name),
    ])];
    if (report.lastError || failedSources.length) reasons.push('write_failed');
    if (report.gapBeyondBackfill) reasons.push('gap_beyond_backfill');
    if (report.oldestAgeMinutes != null && report.oldestAgeMinutes > staleMinutes) reasons.push('stale');
    const missingSuccess = !report.oldestSuccessAt || sources.some(([, s]) => !s.lastSuccessAt);
    const warming = missingSuccess && uptimeSec < graceMinutes * 60;
    if (missingSuccess && !warming) reasons.push('no_success');
    checks[kind] = {
      status: reasons.length ? 'degraded' : warming ? 'starting' : 'ok',
      staleMinutes, reasons, failedSources,
    };
  }
  const values = Object.values(checks);
  const status = values.some((c) => c.status === 'degraded') ? 'degraded'
    : values.some((c) => c.status === 'starting') ? 'starting' : 'ok';
  return { status, httpStatus: status === 'degraded' ? 503 : 200, checks };
}

module.exports = { evaluateHealth };
