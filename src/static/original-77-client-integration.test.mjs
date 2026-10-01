import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { createChallengeActivationState, normalizeChallengeActivation } from './challenge-activation.mjs';
import { authSessionIdentity } from './mfa-auth.mjs';
import { instanceActivationFixture, INSTANCE_ACTOR as userId, INSTANCE_ID as instanceId } from '../../tests/fixtures/challenge-instance.mjs';

const startDate = '2026-07-01';
const activation = () => normalizeChallengeActivation(instanceActivationFixture(), { expectedUserId: userId });
const committed = (overrides = {}) => ({ schemaVersion: 2, actorId: userId, instanceId,
  id: '33333333-3333-4333-8333-333333333333', entry_date: '2026-09-30', challenge_day: 92,
  status: 'partial', completed_count: 1, points_awarded: 1, created_at: '2026-09-30T12:00:00Z',
  activation: instanceActivationFixture(), ...overrides });
const api = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
const dashboard = readFileSync(new URL('./dashboard.js', import.meta.url), 'utf8');
const header = readFileSync(new URL('./shared-header-actions.js', import.meta.url), 'utf8');
function postFixture(data, error = null) {
  let actor = userId; let calls = 0; let invalidations = 0;
  let sid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; let needsMfa = false;
  const session = (refresh = 0) => ({ user: { id: actor },
    access_token: `fixture.${Buffer.from(JSON.stringify({ sub: actor, session_id: sid, refresh })).toString('base64url')}.signature` });
  let currentSession = session();
  let respond = async () => ({ data, error });
  const globals = {
    isLocalDemoMode: () => false,
    previewBadgeEpoch: 0,
    getAuthSession: async () => currentSession,
    authSessionIdentity,
    sessionRequiresMfa: async () => needsMfa,
    requireCapturedChallengeInstance: value => { assert.equal(value, instanceId); },
    requireSupabase: () => ({ rpc: async (name, args) => {
      assert.equal(name, 'submit_daily_check_in_v2'); assert.equal(args.target_expected_actor_id, userId);
      assert.equal(args.target_expected_instance_id, instanceId); calls += 1; return respond();
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
  return { post: () => globals.post({ date: '2026-09-30', day: 92, status: 'partial', completed: ['walk'], completedCount: 1 }, { expectedUserId: userId, expectedInstanceId: instanceId }),
    calls: () => calls, invalidations: () => invalidations,
    setActor: (value) => { actor = value; currentSession = session(); }, response: (value) => { respond = value; },
    replaceSession(value = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', notify = true) {
      sid = value; currentSession = session(); if (notify) globals.previewBadgeEpoch += 1;
    },
    replaceTokenInPlace() { currentSession.access_token = session(1).access_token; },
    removeToken() { delete currentSession.access_token; },
    setMfa(value) { needsMfa = value; },
  };
}
test('submission preserves actor-bound post-write activation without another progress RPC', async () => {
  const data = committed();
  const f = postFixture(data); const result = await f.post();
  assert.equal(result.id, data.id); assert.equal(result.day, 92);
  assert.equal(result.activation.currentInstance.submittedCount, 76);
  assert.equal(result.activation.actorId, userId);
  assert.equal(f.calls(), 1); assert.equal(f.invalidations(), 2);
});
test('submission without an access token fails before dispatch', async () => {
  const f = postFixture(committed()); f.removeToken();
  await assert.rejects(f.post(), error => /account changed/.test(error.message) && error.checkInCommitted !== true);
  assert.equal(f.calls(), 0); assert.equal(f.invalidations(), 0);
});
test('confirmed submission with malformed progress retains committed classification and closes presentation', async () => {
  for (const value of [null, {}, { ...activation(), actorId: 'other' }]) {
    const f = postFixture(committed({ activation: value }));
    await assert.rejects(f.post(), error => error.checkInCommitted === true);
    assert.equal(f.calls(), 1);
  }
});
test('confirmed submission never fabricates missing feed or instance evidence', async () => {
  for (const patch of [{ id: null }, { instanceId: null }, { actorId: 'other' }, { schemaVersion: 1 },
    { entry_date: '2026-09-29' }, { challenge_day: 91 }, { completed_count: 0 }, { points_awarded: -1 },
    { created_at: null }, { status: 'scheduled' }]) {
    await assert.rejects(postFixture(committed(patch)).post(), error => error.checkInCommitted === true);
  }
});
test('late post-response account changes never publish private activation and retain committed classification', async () => {
  const f = postFixture(null); let release;
  f.response(() => new Promise((resolve) => { release = resolve; }));
  const pending = f.post(); const rejected = assert.rejects(pending, (error) => error.checkInCommitted === true && /account changed/.test(error.message));
  for (let i = 0; i < 10 && !release; i += 1) await Promise.resolve();
  f.setActor('other'); release({ data: committed(), error: null });
  await rejected;
});
for (const [name, change] of [
  ['same owner new immutable session', (f) => f.replaceSession()],
  ['same owner new session without notification', (f) => f.replaceSession('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', false)],
  ['silent in-place bearer mutation with the same actor and session identity', (f) => f.replaceTokenInPlace()],
  ['A to B to A epoch change', (f) => { f.setActor('B'); f.replaceSession(); f.setActor(userId); f.replaceSession('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'); }],
  ['MFA assurance downgrade', (f) => f.setMfa(true)],
]) test(`successful submission never publishes a stale private result after ${name}`, async () => {
  const f = postFixture(null); let release;
  f.response(() => new Promise((resolve) => { release = resolve; }));
  const pending = f.post(); const rejected = assert.rejects(pending, (error) => error.checkInCommitted === true && /account changed|verification/.test(error.message));
  for (let i = 0; i < 10 && !release; i += 1) await Promise.resolve();
  assert.ok(release); change(f); release({ data: committed(), error: null });
  await rejected; assert.equal(f.calls(), 1);
});
test('postcommit publication advances the whole-dashboard fence and never opens malformed progress', () => {
  const source = dashboard.slice(dashboard.indexOf('function applyPostedChallengeActivation'), dashboard.indexOf('function clearDashboardUserState'));
  const owner = { userId, epoch: 1, instanceId };
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
test('completed live and historical runs remain visible with their configured targets', () => {
  const start = dashboard.indexOf('  const submittedCount = currentInstance?.submittedCount');
  const end = dashboard.indexOf('  const todayPercent', start);
  for (const targetCount of [7, 21, 30, 40, 77, 365]) {
    const globals = { currentInstance: { submittedCount: targetCount, targetCount }, finished: true, challengeActivation: {} };
    runInNewContext(`${dashboard.slice(start, end)}\nglobalThis.percent = challengePercent;`, globals);
    assert.equal(globals.percent, 100);
  }
  assert.match(dashboard, /\$\{submittedCount\} of \$\{targetCount\} check-ins/);
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
