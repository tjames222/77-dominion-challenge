import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { createClient } from '@supabase/supabase-js';
import { authSessionIdentity } from './mfa-auth.mjs';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
const session = (actor = A, id = FIRST, revision = 0) => ({ user: { id: actor },
  access_token: `fixture.${Buffer.from(JSON.stringify({ sub: actor, session_id: id, revision })).toString('base64url')}.signature` });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const api = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
const claimSource = api.slice(api.indexOf('export async function claimChallengeUnlocks('), api.indexOf('export async function startChallenge(')).replace(/^export /, '');
const userSource = api.slice(api.indexOf('const requireUser = async'), api.indexOf('export { isMissingProfilePhotoSchemaError }'));
const completeCatalog = () => ({ actorId: A, totalPoints: 420, items: [
  { key: 'seven_day_reset', stateModel: 'challenge_lifecycle' }, { key: 'theme', stateModel: 'ownership' },
] });

function fixture({ sdk, response, userHook, sessionHook, catalogHook, initialSession = session() } = {}) {
  let current = initialSession; let epoch = 0; let sessionReads = 0;
  const requests = [], authRequests = [], catalogRequests = [];
  const client = { auth: { async getUser() {
    authRequests.push('/auth/v1/user');
    const captured = current?.user && { ...current.user };
    if (userHook) await userHook(authRequests.length);
    return { data: { user: captured || null }, error: null };
  } }, rpc(name, args) {
    if (sdk) return sdk.rpc(name, args);
    return { setHeader(key, value) {
      assert.equal(name, 'claim_challenge_unlocks');
      assert.deepEqual(Object.keys(args), [], 'The published function accepts no named arguments.');
      assert.equal(key, 'Authorization');
      requests.push({ name, args: JSON.parse(JSON.stringify(args)), authorization: value });
      return response ? response() : Promise.resolve({ data: { claimedKeys: ['seven_day_reset'] }, error: null });
    } };
  } };
  const globals = {
    BUILD_SUPPORTS_LOCAL_DEMO: false, authSessionIdentity,
    requireSupabase: () => client,
    getAuthSession: async () => {
      sessionReads += 1; if (sessionHook) await sessionHook(sessionReads);
      return current;
    },
    getAllRewardCatalog: async args => {
      catalogRequests.push(args); if (catalogHook) await catalogHook();
      return completeCatalog();
    },
  };
  Object.defineProperty(globals, 'previewBadgeEpoch', { get: () => epoch });
  runInNewContext(`${userSource}\n${claimSource}\nglobalThis.claim = claimChallengeUnlocks;`, globals);
  return { claim: (expectedUserId = A) => globals.claim({ expectedUserId }), requests, authRequests, catalogRequests,
    current: () => current,
    replace(next, notify = true) { current = next; if (notify) epoch += 1; },
    token() { current.access_token = session(current.user.id, FIRST, 1).access_token; },
    roundTrip() { epoch += 2; current = session(); }, invalidate() { epoch += 1; },
  };
}

test('the repository publishes only the zero-argument challenge claim signature', () => {
  const directory = new URL('../../supabase/migrations/', import.meta.url);
  const declarations = readdirSync(directory).filter(name => name.endsWith('.sql')).flatMap(name =>
    [...readFileSync(new URL(name, directory), 'utf8').matchAll(/create\s+(?:or\s+replace\s+)?function\s+public\.claim_challenge_unlocks\s*\(([^)]*)\)/gi)]
      .map(match => ({ name, args: match[1].trim() })));
  assert.ok(declarations.length > 0);
  assert.ok(declarations.every(value => value.args === ''), JSON.stringify(declarations));
});

test('claim sends an empty body and captured bearer, retaining two native user validations and one catalog traversal', async () => {
  const f = fixture(); const result = await f.claim();
  assert.deepEqual(f.requests, [{ name: 'claim_challenge_unlocks', args: {}, authorization: `Bearer ${session().access_token}` }]);
  assert.deepEqual(f.authRequests, ['/auth/v1/user', '/auth/v1/user']);
  assert.equal(f.catalogRequests.length, 1); assert.equal(f.catalogRequests[0].expectedUserId, A);
  assert.equal(result.claimedUnlocks.length, 1); assert.equal(result.claimedUnlocks[0].key, 'seven_day_reset');
  assert.equal(result.catalog.totalPoints, 420);
});

for (const [name, initialSession] of [['missing session', null], ['missing token', { user: { id: A }, access_token: '' }],
  ['malformed token', { user: { id: A }, access_token: 'invalid' }], ['mismatched token actor', { ...session(B), user: { id: A } }]]) {
  test(`${name} cannot dispatch`, async () => {
    const f = fixture({ initialSession });
    await assert.rejects(f.claim(), /account changed|log in/);
    assert.equal(f.requests.length, 0); assert.equal(f.catalogRequests.length, 0);
  });
}

test('a captured caller different from the verified account cannot dispatch', async () => {
  const f = fixture(); await assert.rejects(f.claim(B), /account changed/);
  assert.equal(f.requests.length, 0);
});

test('omitting expectedUserId retains the optional contract while binding the captured session actor', async () => {
  const f = fixture(); await f.claim('');
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].authorization, `Bearer ${session().access_token}`);
  assert.deepEqual(f.authRequests, ['/auth/v1/user', '/auth/v1/user']);
});

const changes = [
  ['A to B', f => f.replace(session(B))],
  ['silent same-owner new session', f => f.replace(session(A, SECOND), false)],
  ['same-session token mutation', f => f.token()],
  ['A to B to A', f => f.roundTrip()],
  ['sign out', f => f.replace(null)],
  ['lifecycle invalidation', f => f.invalidate()],
];
for (const [name, change] of changes) {
  test(`${name} during initial native user validation dispatches zero claims`, async () => {
    const entered = deferred(); const gate = deferred();
    const f = fixture({ userHook: count => { if (count === 1) { entered.resolve(); return gate.promise; } } });
    const pending = f.claim(); const rejected = assert.rejects(pending, /account changed|log in/);
    await entered.promise; change(f); gate.resolve(); await rejected;
    assert.equal(f.requests.length, 0); assert.equal(f.catalogRequests.length, 0);
  });
  test(`${name} after dispatch cannot publish or retry the claim`, async () => {
    const entered = deferred(); const gate = deferred();
    const f = fixture({ response: () => { entered.resolve(); return gate.promise; } });
    const pending = f.claim(); const rejected = assert.rejects(pending, /account changed|log in/);
    await entered.promise; change(f); gate.resolve({ data: { claimedKeys: ['seven_day_reset'] } }); await rejected;
    assert.equal(f.requests.length, 1); assert.equal(f.catalogRequests.length, 0);
    await tick(); assert.equal(f.requests.length, 1);
  });
}

test('the epoch is captured before the first session await, including A to B to A', async () => {
  const entered = deferred(); const gate = deferred();
  const f = fixture({ sessionHook: count => { if (count === 1) { entered.resolve(); return gate.promise; } } });
  const pending = f.claim(); const rejected = assert.rejects(pending, /account changed/);
  await entered.promise; f.roundTrip(); gate.resolve(); await rejected;
  assert.equal(f.requests.length, 0);
});

test('a silent session replacement during the final pre-dispatch session check sends nothing', async () => {
  const entered = deferred(); const gate = deferred();
  const f = fixture({ sessionHook: count => { if (count === 2) { entered.resolve(); return gate.promise; } } });
  const pending = f.claim(); const rejected = assert.rejects(pending, /account changed/);
  await entered.promise; f.replace(session(A, SECOND), false); gate.resolve(); await rejected;
  assert.equal(f.requests.length, 0);
});

for (const [name, change] of changes) test(`${name} while the post-claim catalog is pending cannot publish it`, async () => {
  const entered = deferred(); const gate = deferred();
  const f = fixture({ catalogHook: () => { entered.resolve(); return gate.promise; } });
  const pending = f.claim(); const rejected = assert.rejects(pending, /account changed/);
  await entered.promise; change(f); gate.resolve(); await rejected;
  assert.equal(f.requests.length, 1); assert.equal(f.catalogRequests.length, 1);
});

for (const transportFailure of [false, true]) test(`${transportFailure ? 'uncertain transport' : 'RPC'} failure never retries or reads a catalog`, async () => {
  const failure = new Error('synthetic failure');
  const f = fixture({ response: async () => { if (transportFailure) throw failure; return { error: failure }; } });
  await assert.rejects(f.claim(), error => error === failure); await tick();
  assert.equal(f.requests.length, 1); assert.equal(f.catalogRequests.length, 0);
});

test('actual installed SDK keeps zero arguments and the captured bearer during delayed replacement token lookup', async () => {
  const entered = deferred(); const gate = deferred(); const sent = []; let armed = false;
  const sdk = createClient('https://claim-fixture.invalid', 'public-synthetic-fixture-key', {
    accessToken: async () => { if (!armed) return session().access_token; entered.resolve(); return gate.promise; },
    global: { fetch: async (url, init) => {
      sent.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ claimedKeys: ['seven_day_reset'] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    } },
  });
  // Realtime initialization reads a token but makes no network request. Hold
  // only the later fetchWithAuth lookup, as in the training transport proof.
  await tick(); armed = true;
  const f = fixture({ sdk }); const pending = f.claim();
  const rejected = assert.rejects(pending, /account changed/);
  await entered.promise; f.replace(session(B)); gate.resolve(session(B).access_token); await rejected;
  assert.equal(sent.length, 1); assert.deepEqual(sent[0].body, {});
  assert.equal(sent[0].headers.get('authorization'), `Bearer ${session().access_token}`);
  assert.equal(sent[0].url, 'https://claim-fixture.invalid/rest/v1/rpc/claim_challenge_unlocks');
  assert.equal(f.catalogRequests.length, 0);
});
