import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { buildMockLegacyChallengeActivation, createChallengeActivationState, normalizeChallengeActivation } from './challenge-activation.mjs';
import { emptyOriginal77Progress } from './original-77-progress.mjs';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const startDate = '2026-01-01';
const activation = (count = 76, completionState = 'in_progress') => buildMockLegacyChallengeActivation({
  actorId: userId, startDate, timeZone: 'UTC', hasCheckIns: true, now: new Date('2026-03-19T12:00:00Z'),
  originalProgress: { ...emptyOriginal77Progress(userId, startDate), submittedCount: count, completionState },
});
const api = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
const dashboard = readFileSync(new URL('./dashboard.js', import.meta.url), 'utf8');
const header = readFileSync(new URL('./shared-header-actions.js', import.meta.url), 'utf8');
function postFixture(data, error = null) {
  let actor = userId; let calls = 0; let invalidations = 0;
  let sid = 'session-a'; let needsMfa = false;
  let respond = async () => ({ data, error });
  const globals = {
    previewBadgeEpoch: 0,
    getAuthSession: async () => ({ user: { id: actor }, sid, access_token: `${actor}:${sid}` }),
    authSessionIdentity: (session) => `${session.user.id}:${session.sid}`,
    sessionRequiresMfa: async () => needsMfa,
    requireSupabase: () => ({ rpc: async (name, args) => {
      assert.equal(name, 'submit_daily_check_in'); assert.equal(args.target_expected_actor_id, userId); calls += 1; return respond();
    } }),
    requireUser: async (expected) => { if (expected !== actor) throw new Error('account changed'); return { id: actor }; },
    invalidateDailyActionBootstrap: () => { invalidations += 1; },
    invalidateReadsAroundMutation: async (work) => work(),
    normalizeChallengeActivation, readJson: () => ({ name: 'You' }),
    mapFeedItem: (row) => ({ id: row.id, day: row.challenge_day }),
    isDuplicateCheckInError: () => false,
  };
  const source = api.slice(api.indexOf('export async function postCheckIn'), api.indexOf('export async function getCommunityFeed')).replace(/^export /, '');
  runInNewContext(`${source}\nglobalThis.post = postCheckIn;`, globals);
  return { post: () => globals.post({ date: '2026-03-19', day: 78, status: 'partial', completed: ['walk'], completedCount: 1 }, { expectedUserId: userId }),
    calls: () => calls, invalidations: () => invalidations, setActor: (value) => { actor = value; }, response: (value) => { respond = value; },
    replaceSession(value = 'session-b', notify = true) { sid = value; if (notify) globals.previewBadgeEpoch += 1; },
    setMfa(value) { needsMfa = value; },
  };
}
test('submission preserves actor-bound post-write activation without another progress RPC', async () => {
  const data = { id: 'source', challenge_day: 78, activation: activation() };
  const f = postFixture(data); const result = await f.post();
  assert.equal(result.id, 'source'); assert.equal(result.day, 78);
  assert.equal(result.activation.originalProgress.submittedCount, 76);
  assert.equal(result.activation.originalProgress.userId, userId);
  assert.equal(f.calls(), 1); assert.equal(f.invalidations(), 2);
});
test('confirmed submission with malformed progress remains a success carrying closed presentation state', async () => {
  for (const value of [null, {}, { ...activation(), originalProgress: { ...activation().originalProgress, userId: 'other' } }]) {
    const f = postFixture({ id: 'committed-source', activation: value });
    const result = await f.post(); assert.equal(result.id, 'committed-source');
    assert.equal(result.activation.contractValid, false); assert.equal(result.activation.canMutateDailyStandards, false);
    assert.equal(result.activation.originalProgress, null); assert.equal(f.calls(), 1);
  }
});
test('late post-response account changes never publish private activation and retain committed classification', async () => {
  const f = postFixture(null); let release;
  f.response(() => new Promise((resolve) => { release = resolve; }));
  const pending = f.post(); const rejected = assert.rejects(pending, (error) => error.checkInCommitted === true && /account changed/.test(error.message));
  for (let i = 0; i < 10 && !release; i += 1) await Promise.resolve();
  f.setActor('other'); release({ data: { id: 'posted', activation: activation() }, error: null });
  await rejected;
});
for (const [name, change] of [
  ['same owner new immutable session', (f) => f.replaceSession()],
  ['same owner new session without notification', (f) => f.replaceSession('session-b', false)],
  ['A to B to A epoch change', (f) => { f.setActor('B'); f.replaceSession(); f.setActor(userId); f.replaceSession('session-a'); }],
  ['MFA assurance downgrade', (f) => f.setMfa(true)],
]) test(`successful submission never publishes a stale private result after ${name}`, async () => {
  const f = postFixture(null); let release;
  f.response(() => new Promise((resolve) => { release = resolve; }));
  const pending = f.post(); const rejected = assert.rejects(pending, (error) => error.checkInCommitted === true);
  for (let i = 0; i < 10 && !release; i += 1) await Promise.resolve();
  assert.ok(release); change(f); release({ data: { id: 'posted', activation: activation() }, error: null });
  await rejected; assert.equal(f.calls(), 1);
});
test('postcommit publication advances the whole-dashboard fence and never opens malformed progress', () => {
  const source = dashboard.slice(dashboard.indexOf('function applyPostedChallengeActivation'), dashboard.indexOf('function clearDashboardUserState'));
  const owner = { userId, epoch: 1 };
  const globals = { isCurrentMutationOwner: (value) => value === owner, createChallengeActivationState,
    dashboardHydrationRequestId: 10, BROWSER_TIME_ZONE: 'UTC', challengeActivation: activation(), userTimeZone: 'UTC', startDate };
  runInNewContext(`${source}\nglobalThis.apply = applyPostedChallengeActivation;`, globals);
  assert.equal(globals.apply(activation(), owner), true);
  assert.equal(globals.dashboardHydrationRequestId, 11);
  assert.equal(globals.apply({}, owner), false);
  assert.equal(globals.dashboardHydrationRequestId, 12);
  assert.equal(globals.challengeActivation.canMutateDailyStandards, false);
  assert.equal(globals.apply(activation(), { ...owner, epoch: 2 }), false);
  assert.equal(globals.dashboardHydrationRequestId, 12);
  assert.match(dashboard, /if \(requestId !== dashboardHydrationRequestId\) return/);
  assert.doesNotMatch(dashboard, /finishCelebrated|hasFinalBadge|rawChallengeDay\(\) > TOTAL_DAYS/);
});
test('completed and pending historical counts remain visible with participation and mutations closed', () => {
  const start = dashboard.indexOf('  const submittedCount = challengeActivation.originalProgress?.submittedCount;');
  const end = dashboard.indexOf('  const todayPercent', start);
  for (const completionState of ['live_completed', 'historical_provenance_pending']) {
    const globals = { challengeActivation: { originalProgress: { submittedCount: 77, completionState }, canParticipate: false }, TOTAL_DAYS: 77 };
    runInNewContext(`${dashboard.slice(start, end)}\nglobalThis.percent = challengePercent;`, globals);
    assert.equal(globals.percent, 100);
  }
  assert.match(dashboard, /\$\{submittedCount\} of 77 check-ins/);
  assert.match(dashboard, /scorecardCalendarDay\.textContent[\s\S]*Calendar day \$\{currentDay\(\)\}/);
});
test('only current-owner normalized completed or historical progress retains Share after participation closes', () => {
  const start = header.indexOf('    const shareAvailable ='); const end = header.indexOf('    shareButton.disabled', start);
  const share = (value) => runInNewContext(`${header.slice(start, end)}\nshareAvailable`, { activation: value, currentUser: { userId } });
  for (const completionState of ['live_completed', 'historical_provenance_pending']) {
    const value = { readState: 'ready', contractValid: true, canParticipate: false, originalProgress: { userId, submittedCount: 77, completionState } };
    assert.equal(share(value), true);
    assert.equal(share({ ...value, originalProgress: { ...value.originalProgress, userId: 'other' } }), false);
    assert.equal(share({ ...value, contractValid: false }), false);
    assert.equal(share({ ...value, originalProgress: { ...value.originalProgress, completionState: 'invalid_evidence' } }), false);
  }
});
