import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { normalizeChallengeActivationMutation, isSupportedChallengeActivationDate } from './challenge-activation.mjs';
import { authSessionIdentity } from './mfa-auth.mjs';
import { instanceActivationFixture, INSTANCE_ACTOR as actorId, INSTANCE_ID as priorId } from '../../tests/fixtures/challenge-instance.mjs';

const nextId = '33333333-3333-4333-8333-333333333333';
const requestId = '44444444-4444-4444-8444-444444444444';
const sessionA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sessionB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const api = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
const source = api.slice(api.indexOf('export async function startChallenge('), api.indexOf('export async function getDashboard(')).replace(/^export /, '');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const session = (id = sessionA, refresh = 0) => ({ user: { id: actorId },
  access_token: `fixture.${Buffer.from(JSON.stringify({ sub: actorId, session_id: id, refresh })).toString('base64url')}.signature` });
const receipt = (replayed = false) => {
  const activation = instanceActivationFixture();
  Object.assign(activation, { revision: 4, startDate: '2026-09-30' });
  Object.assign(activation.currentInstance, { id: nextId, challengeKey: 'seven_day_reset', title: '7-Day Reset',
    scopeKey: `instance:${nextId}`, startDate: '2026-09-30', targetCount: 7, submittedCount: 0, calendarDay: 1 });
  return { schemaVersion: 2, actorId, instanceId: nextId, replayed, activation };
};

function fixture() {
  let current = session(); let needsMfa = false; let invalidations = 0;
  let respond = async () => ({ data: receipt(), error: null });
  let userRead = async () => current?.user;
  const requests = [];
  const globals = {
    BUILD_SUPPORTS_LOCAL_DEMO: true, isLocalDemoMode: () => false, previewBadgeEpoch: 0,
    getAuthSession: async () => current,
    authSessionIdentity, sessionRequiresMfa: async () => needsMfa,
    requireCapturedChallengeInstance: value => assert.equal(value, priorId),
    requireUser: async expected => {
      const actor = await userRead();
      if (!actor || (expected && actor.id !== expected)) throw new Error('The signed-in account changed. Try again.');
      return actor;
    },
    requireSupabase: () => ({ auth: {}, rpc: async (name, args) => {
      requests.push({ name, args: structuredClone(args) }); return respond();
    } }),
    invalidateDailyActionBootstrap: () => { invalidations++; },
    invalidateReadsAroundMutation: async work => work(),
    normalizeChallengeActivationMutation, isSupportedChallengeActivationDate,
  };
  runInNewContext(`${source}\nglobalThis.start = startChallenge;`, globals);
  const args = { expectedUserId: actorId, expectedInstanceId: priorId, expectedRevision: 3,
    startDate: '2026-09-30', timeZone: 'UTC', requestId };
  return {
    start: () => globals.start('seven_day_reset', args), requests, args,
    invalidations: () => invalidations,
    response(value) { respond = value; },
    userResponse(value) { userRead = value; },
    replaceSession(id = sessionB, notify = true) { current = session(id); if (notify) globals.previewBadgeEpoch++; },
    refreshToken() { current.access_token = session(sessionA, 1).access_token; },
    roundTrip() { globals.previewBadgeEpoch += 2; current = session(); },
    signOut() { current = null; globals.previewBadgeEpoch++; },
    downgradeMfa() { needsMfa = true; },
  };
}

test('Start sends the captured request and accepts only the matching new run receipt', async () => {
  const f = fixture(); const result = await f.start();
  assert.equal(result.activation.currentInstance.id, nextId);
  assert.equal(result.activation.currentInstance.challengeKey, 'seven_day_reset');
  assert.equal(result.activation.revision, 4); assert.equal(result.replayed, false);
  assert.equal(f.requests.length, 1); assert.equal(f.invalidations(), 2);
  assert.deepEqual(f.requests[0], { name: 'start_challenge_instance_v2', args: {
    target_challenge_key: 'seven_day_reset', target_start_date: '2026-09-30', target_time_zone: 'UTC',
    target_request_id: requestId, target_expected_actor_id: actorId,
    target_expected_instance_id: priorId, target_expected_revision: 3,
  } });
});

test('an uncertain Start retry preserves the exact request and accepts its stored replay receipt', async () => {
  const f = fixture(); let calls = 0;
  f.response(async () => ++calls === 1 ? { data: null, error: new Error('temporary transport failure') }
    : { data: receipt(true), error: null });
  await assert.rejects(f.start(), /temporary transport/);
  const result = await f.start();
  assert.equal(result.replayed, true); assert.equal(result.instanceId, nextId);
  assert.deepEqual(f.requests[1], f.requests[0]); assert.equal(f.invalidations(), 4);
});

test('missing or invalid Start dates never dispatch a production mutation', async () => {
  for (const date of [null, undefined, '', '2026-02-30']) {
    const f = fixture(); f.args.startDate = date;
    await assert.rejects(f.start(), /valid start date/); assert.equal(f.requests.length, 0);
  }
});

for (const [name, change] of [
  ['same-user logout and reauthentication', f => f.replaceSession()],
  ['silent same-user immutable session replacement', f => f.replaceSession(sessionB, false)],
  ['same-session token replacement in the original session object', f => f.refreshToken()],
  ['same-session A to B to A epoch change', f => f.roundTrip()],
  ['sign-out', f => f.signOut()],
  ['MFA assurance downgrade', f => f.downgradeMfa()],
]) test(`a pending Start cannot publish after ${name}`, async () => {
  const f = fixture(); const dispatched = deferred(); const response = deferred();
  f.response(() => { dispatched.resolve(); return response.promise; });
  const pending = f.start();
  const rejected = assert.rejects(pending, /account changed|verification/);
  await dispatched.promise; change(f); response.resolve({ data: receipt(), error: null });
  await rejected; assert.equal(f.requests.length, 1); assert.equal(f.invalidations(), 2);
});

test('silent same-user replacement during initial actor verification never dispatches Start', async () => {
  const f = fixture(); const verifying = deferred(); const actor = deferred();
  f.userResponse(() => { verifying.resolve(); return actor.promise; });
  const pending = f.start(); const rejected = assert.rejects(pending, /account changed/);
  await verifying.promise; f.replaceSession(sessionB, false); actor.resolve({ id: actorId });
  await rejected; assert.equal(f.requests.length, 0); assert.equal(f.invalidations(), 0);
});

for (const [name, mutate] of [
  ['wrong challenge', value => { value.activation.currentInstance.challengeKey = 'twenty_one_day_prayer'; }],
  ['prior run', value => { value.instanceId = priorId; value.activation.currentInstance.id = priorId; value.activation.currentInstance.scopeKey = `instance:${priorId}`; }],
  ['stale revision', value => { value.activation.revision = 3; }],
  ['unrelated later revision', value => { value.activation.revision = 5; }],
  ['mismatched outer instance', value => { value.instanceId = requestId; }],
  ['wrong actor', value => { value.actorId = requestId; }],
  ['untyped replay flag', value => { value.replayed = 'true'; }],
  ['legacy response version', value => { value.schemaVersion = 1; }],
]) test(`Start rejects a ${name} in both a new and replayed response`, async () => {
  for (const replayed of [false, true]) {
    const f = fixture(); const value = receipt(replayed); mutate(value);
    f.response(async () => ({ data: value, error: null }));
    await assert.rejects(f.start(), /could not be verified/);
    assert.equal(f.requests.length, 1); assert.equal(f.invalidations(), 2);
  }
});
