import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { normalizeChallengeActivation } from './challenge-activation.mjs';
import { normalizeDailyStandardDraft } from './daily-standard-draft.mjs';
import { naturalizeDailyActionError } from './customer-copy.mjs';
import { authSessionIdentity } from './mfa-auth.mjs';
import { instanceBootstrapFixture, INSTANCE_ACTOR as actorId, INSTANCE_ID as instanceId } from '../../tests/fixtures/challenge-instance.mjs';

const sessionA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sessionB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const api = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
const source = api.slice(api.indexOf('const rpcDraft ='), api.indexOf('export async function getDailyStandardDraft('));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const session = (id = sessionA, refresh = 0) => ({ user: { id: actorId },
  access_token: `fixture.${Buffer.from(JSON.stringify({ sub: actorId, session_id: id, refresh })).toString('base64url')}.signature` });
const receipt = () => instanceBootstrapFixture().draft;
const operations = [
  { kind: 'read', name: 'get_daily_standard_draft_v2', mutation: false, parameters: { target_entry_date: '2026-09-30' } },
  { kind: 'action', name: 'mutate_daily_standard_draft_v2', mutation: true,
    parameters: { target_entry_date: '2026-09-30', target_action_id: 'bible', target_completed: true, target_expected_version: 0 } },
  { kind: 'workout', name: 'set_daily_standard_workout_difficulty_v2', mutation: true,
    parameters: { target_entry_date: '2026-09-30', target_workout_id: 'one', target_difficulty: 'hard', target_expected_version: 0 } },
];

function fixture(operation) {
  let current = session(); let needsMfa = false; let invalidations = 0; let bootstrapCalls = 0;
  let respond = async () => ({ data: receipt(), error: null });
  let bootstrap = async () => undefined; let userRead = async () => current?.user;
  const requests = [];
  const globals = {
    isLocalDemoMode: () => false, previewBadgeEpoch: 0,
    getAuthSession: async () => current,
    authSessionIdentity, sessionRequiresMfa: async () => needsMfa,
    requireCapturedChallengeInstance: value => assert.equal(value, instanceId),
    requireUser: async expected => {
      const actor = await userRead();
      if (!actor || (expected && actor.id !== expected)) throw new Error('The signed-in account changed. Try again.');
      return actor;
    },
    requireSupabase: () => ({ auth: {}, rpc: async (name, args) => {
      requests.push({ name, args: structuredClone(args) }); return respond();
    } }),
    bootstrapDailyStandardTimeZone: async (_client, id) => {
      assert.equal(id, actorId); bootstrapCalls++; await bootstrap();
    },
    invalidateDailyActionBootstrap: () => { invalidations++; },
    normalizeChallengeActivation, normalizeDailyStandardDraft, naturalizeDailyActionError,
  };
  runInNewContext(`${source}\nglobalThis.callDraft = rpcDraft;`, globals);
  return {
    run: () => globals.callDraft(operation.name, operation.parameters,
      { expectedUserId: actorId, expectedInstanceId: instanceId, mutation: operation.mutation }),
    requests, invalidations: () => invalidations, bootstrapCalls: () => bootstrapCalls,
    response(value) { respond = value; }, bootstrap(value) { bootstrap = value; }, userResponse(value) { userRead = value; },
    replaceSession(notify = true) { current = session(sessionB); if (notify) globals.previewBadgeEpoch++; },
    refreshToken() { current.access_token = session(sessionA, 1).access_token; },
    roundTrip() { globals.previewBadgeEpoch += 2; current = session(); },
    signOut() { current = null; globals.previewBadgeEpoch++; },
    downgradeMfa() { needsMfa = true; },
  };
}

const replacements = [
  ['notified same-user session replacement', f => f.replaceSession()],
  ['silent same-user session replacement', f => f.replaceSession(false)],
  ['in-place bearer replacement', f => f.refreshToken()],
  ['A to B to A auth epoch change', f => f.roundTrip()],
  ['sign-out', f => f.signOut()],
  ['MFA assurance downgrade', f => f.downgradeMfa()],
];

for (const operation of operations) {
  test(`${operation.kind}: exact captured actor, instance and date survive a verified response`, async () => {
    const f = fixture(operation); const result = await f.run();
    assert.deepEqual(result, normalizeDailyStandardDraft(receipt()));
    assert.deepEqual(f.requests, [{ name: operation.name, args: { ...operation.parameters,
      target_expected_actor_id: actorId, target_expected_instance_id: instanceId } }]);
    assert.equal(f.bootstrapCalls(), 1); assert.equal(f.invalidations(), operation.mutation ? 2 : 0);
  });

  for (const [name, change] of replacements) {
    test(`${operation.kind}: ${name} during timezone bootstrap prevents dispatch`, async () => {
      const f = fixture(operation); const bootstrapping = deferred(); const initialized = deferred();
      f.bootstrap(() => { bootstrapping.resolve(); return initialized.promise; });
      const pending = f.run(); const rejected = assert.rejects(pending, /account changed|verification/);
      await bootstrapping.promise; change(f); initialized.resolve();
      await rejected; assert.equal(f.requests.length, 0); assert.ok(f.invalidations() > 0);
    });

    test(`${operation.kind}: late response after ${name} is never published`, async () => {
      const f = fixture(operation); const dispatched = deferred(); const response = deferred();
      f.response(() => { dispatched.resolve(); return response.promise; });
      const pending = f.run(); const rejected = assert.rejects(pending, /account changed|verification/);
      await dispatched.promise; change(f); response.resolve({ data: receipt(), error: null });
      await rejected; assert.equal(f.requests.length, 1); assert.ok(f.invalidations() > 0);
    });
  }

  test(`${operation.kind}: silent replacement during initial user verification never initializes or dispatches`, async () => {
    const f = fixture(operation); const verifying = deferred(); const user = deferred();
    f.userResponse(() => { verifying.resolve(); return user.promise; });
    const pending = f.run(); const rejected = assert.rejects(pending, /account changed/);
    await verifying.promise; f.replaceSession(false); user.resolve({ id: actorId });
    await rejected; assert.equal(f.bootstrapCalls(), 0); assert.equal(f.requests.length, 0);
  });

  for (const [name, change] of [
    ['silent same-user replacement', f => f.replaceSession(false)],
    ['MFA downgrade', f => f.downgradeMfa()],
  ]) test(`${operation.kind}: a rejected timezone bootstrap after ${name} cannot publish its old error`, async () => {
    const f = fixture(operation); const bootstrapping = deferred(); const failed = deferred();
    f.bootstrap(async () => { bootstrapping.resolve(); await failed.promise; throw new Error('OLD_BOOTSTRAP_ERROR'); });
    const pending = f.run(); const rejected = assert.rejects(pending, /account changed|verification/);
    await bootstrapping.promise; change(f); failed.resolve();
    await rejected; assert.equal(f.bootstrapCalls(), 1); assert.equal(f.requests.length, 0); assert.ok(f.invalidations() > 0);
  });

  test(`${operation.kind}: unchanged-session bootstrap rejection keeps its diagnostic and never dispatches`, async () => {
    const f = fixture(operation);
    f.bootstrap(async () => { throw new Error('Daily Standards timezone is unavailable.'); });
    await assert.rejects(f.run(), /Daily Actions timezone is unavailable/);
    assert.equal(f.bootstrapCalls(), 1); assert.equal(f.requests.length, 0); assert.ok(f.invalidations() > 0);
  });

  for (const throws of [false, true]) test(`${operation.kind}: ${throws ? 'thrown transport' : 'RPC'} errors cannot escape an old session`, async () => {
    const f = fixture(operation); const dispatched = deferred(); const response = deferred();
    f.response(async () => { dispatched.resolve(); await response.promise;
      if (throws) throw new Error('OLD_SESSION_ERROR');
      return { data: null, error: new Error('OLD_SESSION_ERROR') };
    });
    const pending = f.run(); const rejected = assert.rejects(pending, /account changed/);
    await dispatched.promise; f.replaceSession(false); response.resolve();
    await rejected; assert.equal(f.requests.length, 1); assert.ok(f.invalidations() > 0);
  });

  test(`${operation.kind}: an unchanged-session RPC error retains its useful diagnostic`, async () => {
    const f = fixture(operation);
    f.response(async () => ({ data: null, error: new Error('Daily Standards date is locked.') }));
    await assert.rejects(f.run(), /Daily Actions date is locked/);
    assert.equal(f.requests.length, 1); assert.ok(f.invalidations() > 0);
  });

  for (const [name, mutate] of [
    ['different actor', value => { value.actorId = sessionB; }],
    ['different instance', value => { value.instanceId = sessionB; }],
    ['different date', value => { value.entry_date = '2026-09-29'; }],
    ['untyped version', value => { value.version = '1'; }],
    ['legacy schema', value => { value.schemaVersion = 1; }],
  ]) test(`${operation.kind}: valid session cannot accept ${name} receipt`, async () => {
    const f = fixture(operation); const value = receipt(); mutate(value);
    f.response(async () => ({ data: value, error: null }));
    await assert.rejects(f.run(), /challenge changed/);
    assert.equal(f.requests.length, 1); assert.ok(f.invalidations() > 0);
  });
}
