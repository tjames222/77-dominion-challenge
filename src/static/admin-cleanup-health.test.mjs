import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { normalizeAdminCleanupHealth, cleanupCronSummary } from './admin-cleanup-health.mjs';
import { previewCleanupHealth } from './admin-cleanup-health-preview.mjs';
import { requestAdminRead } from './admin-read-transport.mjs';
import { createAdminReadClient, withAdminReadDeadline } from './admin-read-client.mjs';
const actor = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const valid = () => ({ schemaVersion: 1, actorId: actor, observedAt: '2026-10-13T12:00:00Z', ...previewCleanupHealth('2026-10-13T12:00:00Z') });

test('cleanup DTO projects only bounded aggregate and scheduler metadata', () => {
  const raw = valid(); raw.objectId = 'PRIVATE_OBJECT'; raw.cron.command = 'PRIVATE_COMMAND'; raw.cron.lastRuns[0].error = 'PRIVATE_ERROR';
  raw.counters.ready.objects = ['PRIVATE_PATH'];
  const value = normalizeAdminCleanupHealth(raw, actor);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE/); assert.equal(value.counters.ready.count, 3);
  assert.equal(value.cron.transportEvidence, 'enqueue-only'); assert.equal(value.cron.lastRunsOrder, 'run-id-desc');
});
for (const [name, mutate] of Object.entries({
  schema: value => { value.schemaVersion = 2; }, actor: value => { value.actorId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; },
  observed: value => { value.observedAt = 'yesterday'; }, limit: value => { value.counterLimit = 999; },
  missingCounter: value => { delete value.counters.ready; }, negative: value => { value.counters.ready.count = -1; },
  fraction: value => { value.counters.ready.count = 1.5; }, oversize: value => { value.counters.ready.count = 1001; },
  coerced: value => { value.counters.ready.count = '3'; }, malformedMore: value => { value.counters.ready.hasMore = 1; },
  falseCap: value => { value.counters.ready.hasMore = true; }, missingOldest: value => { value.oldestEligibleAt = null; },
  futureOldest: value => { value.oldestEligibleAt = '2027-01-01T00:00:00Z'; },
  falseOldest: value => { value.counters.ready.count = 0; },
  runOverflow: value => { value.cron.lastRuns.push(...value.cron.lastRuns, ...value.cron.lastRuns); },
  runStatus: value => { value.cron.lastRuns[0].status = 'deleted'; }, runTime: value => { value.cron.lastRuns[0].startedAt = 'bad'; },
  historyLimit: value => { value.cron.historyLimit = 1001; }, falseFreshness: value => { value.cron.historyCoverage = 'bounded'; },
  absentHistoryRuns: value => { value.cron.historyCoverage = 'unavailable'; value.cron.freshness = 'unknown'; },
  wrongOrder: value => { value.cron.lastRunsOrder = 'latest-time'; }, wrongEvidence: value => { value.cron.transportEvidence = 'deleted'; },
  missingActive: value => { value.cron.active = null; }, falseCatalog: value => { value.cron.catalogAvailable = false; },
  falseExtension: value => { value.cron.extensionAvailable = false; }, missingJobState: value => { value.cron.jobState = 'missing'; },
  falseStale: value => { value.cron.freshness = 'stale'; }, falseEmptyFresh: value => { value.cron.lastRuns = []; },
  falseUnavailableCatalog: value => { value.cron.jobState = 'unavailable'; value.cron.active = null; value.cron.scheduleMatches = null; value.cron.historyCoverage = 'unavailable'; value.cron.freshness = 'unknown'; value.cron.lastRuns = []; },
  falseMissingComplete: value => { value.cron.jobState = 'missing'; value.cron.active = null; value.cron.scheduleMatches = null; },
})) test(`cleanup DTO rejects ${name} without a false health report`, () => {
  const raw = valid(); mutate(raw); assert.throws(() => normalizeAdminCleanupHealth(raw, actor), { code: 'ADMIN_UNAVAILABLE' });
});
test('exact zero, exact 1000, capped 1000+, unknown and bounded history stay distinct', () => {
  const raw = valid(); raw.counters.ready = { count: 0, hasMore: false }; raw.oldestEligibleAt = null;
  raw.counters.leased = { count: 1000, hasMore: false }; raw.counters.backingOff = { count: 1000, hasMore: true };
  raw.cron.historyCoverage = 'bounded'; raw.cron.freshness = 'unknown';
  const value = normalizeAdminCleanupHealth(raw, actor); assert.equal(value.counters.ready.count, 0);
  assert.equal(value.counters.leased.hasMore, false); assert.equal(value.counters.backingOff.hasMore, true);
  assert.equal(cleanupCronSummary(value.cron).freshness, 'Unknown'); assert.match(cleanupCronSummary(value.cron).coverage, /may be omitted/);
});
test('retained Cron timestamp irregularities are metadata, not trusted chronological ordering', () => {
  const raw = valid(); raw.cron.freshness = 'unknown'; raw.cron.lastRuns[0] = { status: 'unknown', startedAt: '2027-01-01T00:00:00Z', endedAt: '2020-01-01T00:00:00Z' };
  assert.deepEqual(normalizeAdminCleanupHealth(raw, actor).cron.lastRuns, raw.cron.lastRuns);
  raw.cron.lastRuns[0] = { status: 'running', startedAt: null, endedAt: null };
  assert.equal(normalizeAdminCleanupHealth(raw, actor).cron.lastRuns[0].startedAt, null);
});
test('Cron freshness describes only the newest allocated run, not latest wall-clock dispatch', () => {
  const raw = valid(); raw.cron.lastRuns[0].startedAt = '2026-10-13T10:00:00Z'; raw.cron.freshness = 'stale';
  raw.cron.lastRuns.push({ status: 'succeeded', startedAt: '2026-10-13T11:59:00Z', endedAt: '2026-10-13T11:59:01Z' });
  const value = normalizeAdminCleanupHealth(raw, actor);
  assert.equal(cleanupCronSummary(value.cron).freshness, 'Newest allocated run started more than 15 minutes ago');
  raw.cron.lastRuns = []; assert.equal(cleanupCronSummary(normalizeAdminCleanupHealth(raw, actor).cron).freshness, 'No recorded dispatch runs');
});
for (const [startedAt, freshness] of [['2026-10-13T11:45:00.000000Z', 'fresh'], ['2026-10-13T11:45:00.000001Z', 'fresh'],
  ['2026-10-13T11:44:59.999999Z', 'stale'], ['2026-10-13T12:00:00.000000Z', 'fresh'], ['2026-10-13T12:00:00.000001Z', 'unknown'],
  ['2026-10-13T04:44:59.999999-07:00', 'stale']]) test(`microsecond freshness agrees with SQL for ${startedAt}`, () => {
  const raw = valid(); raw.observedAt = '2026-10-13T12:00:00.000000Z'; raw.cron.lastRuns[0].startedAt = startedAt; raw.cron.freshness = freshness;
  assert.equal(normalizeAdminCleanupHealth(raw, actor).cron.freshness, freshness);
  raw.cron.freshness = freshness === 'fresh' ? 'stale' : 'fresh';
  assert.throws(() => normalizeAdminCleanupHealth(raw, actor), { code: 'ADMIN_UNAVAILABLE' });
});
test('oldest eligible timestamp cannot be even one microsecond after observation', () => {
  const raw = valid(); raw.observedAt = '2026-10-13T12:00:00.000001Z'; raw.oldestEligibleAt = '2026-10-13T05:00:00.000001-07:00';
  assert.equal(normalizeAdminCleanupHealth(raw, actor).oldestEligibleAt, raw.oldestEligibleAt);
  raw.oldestEligibleAt = '2026-10-13T05:00:00.000002-07:00';
  assert.throws(() => normalizeAdminCleanupHealth(raw, actor), { code: 'ADMIN_UNAVAILABLE' });
});
for (const state of ['unavailable', 'missing', 'ambiguous', 'disabled', 'empty', 'bounded-empty']) test(`valid ${state} scheduler metadata remains distinct from a healthy cleanup claim`, () => {
  const raw = valid();
  if (['unavailable', 'missing', 'ambiguous'].includes(state)) Object.assign(raw.cron, {
    extensionAvailable: state !== 'unavailable', catalogAvailable: state !== 'unavailable', jobState: state,
    active: null, scheduleMatches: null, historyCoverage: 'unavailable', freshness: 'unknown', lastRuns: [],
  });
  else if (state === 'disabled') Object.assign(raw.cron, { active: false, scheduleMatches: false });
  else Object.assign(raw.cron, { historyCoverage: state === 'empty' ? 'complete' : 'bounded', freshness: state === 'empty' ? 'stale' : 'unknown', lastRuns: [] });
  const summary = cleanupCronSummary(normalizeAdminCleanupHealth(raw, actor).cron);
  assert.doesNotMatch(JSON.stringify(summary), /healthy|deleted|completed/i);
  if (state === 'disabled') { assert.equal(summary.job, 'Disabled'); assert.equal(summary.schedule, 'Does not match the expected schedule'); }
  else if (state === 'empty') assert.equal(summary.freshness, 'No recorded dispatch runs');
  else assert.equal(summary.freshness, 'Unknown');
});
test('cleanup-only read transport fixes the body cap at 64KiB for ASCII and UTF-8, caller cannot enlarge it', async () => {
  for (const char of ['x', '界']) for (const extra of [0, 1]) {
    const repeats = Math.floor((65536 - 2) / new TextEncoder().encode(char).length);
    const raw = `"${char.repeat(repeats)}${'x'.repeat(65536 - 2 - repeats * new TextEncoder().encode(char).length + extra)}"`;
    const pending = requestAdminRead({ name: 'site_admin_get_cleanup_health', baseUrl: 'https://provider.invalid', apiKey: 'synthetic', token: 'exact',
      args: { target_expected_actor_id: actor }, maxBytes: 999999, maxChars: 999999,
      fetcher: async (url, options) => {
        assert.equal(url, 'https://provider.invalid/rest/v1/rpc/site_admin_get_cleanup_health');
        assert.equal(options.cache, 'no-store'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
        assert.equal(options.headers.Authorization, 'Bearer exact'); assert.deepEqual(JSON.parse(options.body), { target_expected_actor_id: actor });
        return new Response(raw, { headers: { 'content-type': 'application/json' } });
      } });
    if (extra) await assert.rejects(pending, { code: 'ADMIN_UNAVAILABLE' }); else assert.equal(await pending, raw.slice(1, -1));
  }
});
test('cleanup allowlisted read pins expected actor and fences A-B-A even when abort is ignored', async () => {
  let current = actor; let listener; let resolve; let requested = false;
  const held = new Promise(yes => { resolve = yes; });
  const client = createAdminReadClient({ getSession: async () => ({ user: { id: current }, access_token: current }),
    getUser: async () => ({ id: current }), sessionIdentity: session => session.access_token,
    subscribe: callback => { listener = callback; }, request: async (name, args) => {
      requested = true; assert.equal(name, 'site_admin_get_cleanup_health'); assert.equal(args.target_expected_actor_id, actor); return held;
    } });
  const pending = client.read('site_admin_get_cleanup_health', { target_expected_actor_id: 'wrong' }, { expectedUserId: actor });
  const rejected = assert.rejects(pending, { code: 'ADMIN_CHANGED' });
  while (!requested) await Promise.resolve();
  for (const id of ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', actor]) { current = id; listener({ event: 'SIGNED_IN', sessionIdentity: id }); }
  resolve(valid()); await rejected; client.destroy();
});
test('actual cleanup API wrapper bounds deferred client loading and never dispatches after deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
  const read = source.slice(source.indexOf('const readSiteAdmin ='), source.indexOf('export const getSiteAdminContext'));
  const cleanup = source.match(/export const getSiteAdminCleanupHealth =[^\n]+/)[0].replace('export ', '');
  let release; let calls = 0; const held = new Promise(yes => { release = yes; });
  const invoke = new Function('getAdminReadClient', 'withAdminReadDeadline', `${read}\n${cleanup}\nreturn getSiteAdminCleanupHealth;`)(
    async () => { await held; return { read(name, args, options) { calls++; assert.equal(name, 'site_admin_get_cleanup_health'); assert.deepEqual(args, {}); assert.equal(options.expectedUserId, actor); return valid(); } }; }, withAdminReadDeadline);
  const pending = invoke({ expectedUserId: actor }); const rejected = assert.rejects(pending, { code: 'ADMIN_UNAVAILABLE' });
  t.mock.timers.tick(10000); await rejected; release();
  for (let index = 0; index < 12; index++) await Promise.resolve();
  assert.equal(calls, 0); assert.equal((await invoke({ expectedUserId: actor })).actorId, actor); assert.equal(calls, 1);
});
