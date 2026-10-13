import { adminReadError } from './admin-read-client.mjs';

export const CLEANUP_COUNTERS = Object.freeze({
  expiredPending: ['Expired pending uploads', 'Pending uploads whose expiry has passed.'],
  ready: ['Ready for cleanup', 'Cleanup records whose retry and lease times have passed.'],
  leased: ['Active service leases', 'Cleanup records currently leased to the service.'],
  staleLeases: ['Expired service leases', 'Cleanup records with an expired service lease.'],
  backingOff: ['Waiting to retry', 'Cleanup records with a future retry time.'],
  failuresLastHour: ['Objects failed in the last hour', 'Objects with a recorded failure in the last hour, not the number of failure events.'],
});
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => typeof value === 'string' && value.length <= 40
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
const nullableTime = value => value === null || timestamp(value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_STATES = new Set(['starting', 'connecting', 'sending', 'running', 'succeeded', 'failed', 'unknown']);
// PostgreSQL preserves microseconds. Date.parse alone truncates them and could
// disagree with the server at the exact 15-minute or future-time boundary.
const micros = value => {
  const fraction = value.match(/\.(\d{1,6})(?=Z|[+-])/);
  return BigInt(Date.parse(value.replace(/\.\d{1,6}(?=Z|[+-])/, ''))) * 1000n
    + BigInt((fraction?.[1] || '').padEnd(6, '0'));
};

// Explicit projection: no object identifiers, raw errors, commands or other
// provider fields are retained, rendered, persisted or included in diagnostics.
export function normalizeAdminCleanupHealth(value, expectedActorId) {
  if (!object(value) || value.schemaVersion !== 1 || typeof value.actorId !== 'string' || !UUID.test(value.actorId)
    || value.actorId !== expectedActorId || !timestamp(value.observedAt) || value.counterLimit !== 1000
    || !object(value.counters) || !nullableTime(value.oldestEligibleAt)) throw adminReadError();
  const counters = {};
  for (const key of Object.keys(CLEANUP_COUNTERS)) {
    const item = value.counters[key];
    if (!object(item) || !Number.isInteger(item.count) || item.count < 0 || item.count > 1000
      || typeof item.hasMore !== 'boolean' || (item.hasMore && item.count !== 1000)) throw adminReadError();
    counters[key] = { count: item.count, hasMore: item.hasMore };
  }
  if ((counters.ready.count === 0) !== (value.oldestEligibleAt === null)
    || (value.oldestEligibleAt !== null && micros(value.oldestEligibleAt) > micros(value.observedAt))) throw adminReadError();
  const cron = value.cron;
  if (!object(cron) || typeof cron.extensionAvailable !== 'boolean' || typeof cron.catalogAvailable !== 'boolean'
    || !['unavailable', 'missing', 'present', 'ambiguous'].includes(cron.jobState)
    || (cron.jobState === 'present' ? typeof cron.active !== 'boolean' || typeof cron.scheduleMatches !== 'boolean'
      : cron.active !== null || cron.scheduleMatches !== null)
    || !['unavailable', 'complete', 'bounded'].includes(cron.historyCoverage) || cron.historyLimit !== 1000
    || cron.lastRunsOrder !== 'run-id-desc' || cron.staleAfterSeconds !== 900
    || !['unknown', 'fresh', 'stale'].includes(cron.freshness) || cron.transportEvidence !== 'enqueue-only'
    || !Array.isArray(cron.lastRuns) || cron.lastRuns.length > 2
    || (cron.historyCoverage !== 'complete' && cron.freshness !== 'unknown')
    || (cron.historyCoverage === 'unavailable' && cron.lastRuns.length !== 0)
    || (!cron.extensionAvailable && (cron.catalogAvailable || cron.jobState !== 'unavailable'))
    || (cron.catalogAvailable === (cron.jobState === 'unavailable'))
    || (cron.jobState !== 'present' && cron.historyCoverage !== 'unavailable')) throw adminReadError();
  const lastRuns = cron.lastRuns.map(run => {
    if (!object(run) || !RUN_STATES.has(run.status) || !nullableTime(run.startedAt) || !nullableTime(run.endedAt)) throw adminReadError();
    return { status: run.status, startedAt: run.startedAt, endedAt: run.endedAt };
  });
  const firstStarted = lastRuns[0]?.startedAt;
  const age = firstStarted === null || firstStarted === undefined ? null : micros(value.observedAt) - micros(firstStarted);
  const expectedFreshness = cron.historyCoverage !== 'complete' ? 'unknown' : !lastRuns.length ? 'stale'
    : age === null || age < 0n ? 'unknown' : age <= 900000000n ? 'fresh' : 'stale';
  if (cron.freshness !== expectedFreshness) throw adminReadError();
  return { schemaVersion: 1, actorId: value.actorId, observedAt: value.observedAt, counterLimit: 1000,
    counters, oldestEligibleAt: value.oldestEligibleAt,
    cron: { extensionAvailable: cron.extensionAvailable, catalogAvailable: cron.catalogAvailable, jobState: cron.jobState,
      active: cron.active, scheduleMatches: cron.scheduleMatches, historyCoverage: cron.historyCoverage, historyLimit: 1000,
      lastRunsOrder: 'run-id-desc', freshness: cron.freshness, staleAfterSeconds: 900, lastRuns, transportEvidence: 'enqueue-only' } };
}

export function cleanupTimestamp(value) {
  return value === null ? 'Not recorded' : `${new Date(value).toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

export function cleanupCronSummary(cron) {
  const job = { unavailable: 'Unknown — scheduler metadata unavailable', missing: 'Missing cleanup schedule',
    ambiguous: 'Unknown — multiple cleanup schedules', present: cron.active ? 'Enabled' : 'Disabled' }[cron.jobState];
  const schedule = cron.scheduleMatches === null ? 'Unknown' : cron.scheduleMatches ? 'Matches the expected schedule' : 'Does not match the expected schedule';
  const freshness = { unknown: 'Unknown', fresh: 'Newest allocated run started within 15 minutes',
    stale: cron.lastRuns.length ? 'Newest allocated run started more than 15 minutes ago' : 'No recorded dispatch runs' }[cron.freshness];
  const coverage = { unavailable: 'History unavailable.', complete: 'All retained scheduler history was checked.',
    bounded: 'Only the newest 1000 global scheduler records were checked. Earlier cleanup runs may be omitted; freshness is unknown.' }[cron.historyCoverage];
  return { job, schedule, freshness, coverage };
}
