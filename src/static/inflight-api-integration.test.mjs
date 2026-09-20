import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { createInflightActorReads } from './inflight-actor-reads.mjs';
import { authSessionIdentity } from './mfa-auth.mjs';

const api = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
const extract = (name, next) => api.slice(api.indexOf(`export async function ${name}`),
  api.indexOf(`export async function ${next}`)).replace(/^export /, '');

function activationFixture() {
  const scope = createInflightActorReads();
  let actor = 'A'; let calls = 0; let authChecks = 0; let resolve;
  const response = new Promise((yes) => { resolve = yes; });
  const globals = { inflightActorReads: scope,
    requireCapturedActivationActor: (id) => { assert.ok(id); return id; },
    isLocalDemoMode: () => false,
    requireSupabase: () => ({ rpc: async (name, parameters) => {
      assert.equal(name, 'get_challenge_activation');
      assert.equal(parameters.target_expected_actor_id, 'A');
      calls += 1; return response;
    } }),
    requireUser: async (expected) => {
      authChecks += 1;
      if (actor !== expected) throw new Error('account changed');
      return { id: actor };
    },
    normalizeChallengeActivation: (data) => data,
    challengeActivationReadError: (error) => ({ error }),
  };
  runInNewContext(extract('getChallengeActivation', 'activateSoloChallenge')
    + '\nglobalThis.read = getChallengeActivation;', globals);
  return { read: globals.read, scope, resolve, calls: () => calls,
    checks: () => authChecks, setActor: (id) => { actor = id; } };
}

test('concurrent real-wire activation consumers issue one RPC with pre/post actor verification', async () => {
  const fixture = activationFixture();
  const first = fixture.read({ expectedUserId: 'A' });
  const second = fixture.read({ expectedUserId: 'A' });
  fixture.resolve({ data: { status: 'active' }, error: null });
  assert.deepEqual(await first, { status: 'active' });
  assert.deepEqual(await second, { status: 'active' });
  assert.equal(fixture.calls(), 1);
  assert.equal(fixture.checks(), 2, 'Authorization itself is still checked before and after the RPC.');
});

test('a late response is rejected if the authenticated user differs even without an auth event', async () => {
  const fixture = activationFixture();
  const result = fixture.read({ expectedUserId: 'A' });
  const rejected = assert.rejects(result, /account changed/);
  await Promise.resolve(); await Promise.resolve();
  fixture.setActor('B');
  fixture.resolve({ data: { private: 'A' }, error: null });
  await rejected;
});

test('training coalescing uses every server argument and retains expected-actor verification', () => {
  const source = extract('getSiteTrainingState', 'claimSiteTraining');
  assert.match(source, /query: 'get_site_training_state', version: 1/);
  assert.match(source, /args: \[page\.id, page\.contentVersion, program\?\.id \|\| null, program\?\.version \|\| null\]/);
  assert.match(source, /await requireUser\(actorId\);[\s\S]*client\.rpc\('get_site_training_state'[\s\S]*await requireUser\(actorId\)/);
});

test('auth loss, cross-tab changes and mutation settlement invalidate without caching authorization', () => {
  assert.match(api, /clearAuthSession\(\{ redirectToLanding = false \} = \{\}\) \{\s+if \(redirectToLanding\) logoutNavigationPending = true;\s+try \{\s+cancelAdminReads\(\);\s+inflightActorReads\.invalidate\(\)/);
  assert.match(api, /inflightActorReads\.observeAuth\(event, session\?\.user\?\.id \|\| '', authSessionIdentity\(session\)\)/);
  assert.match(api, /addEventListener\('storage',[\s\S]*inflightActorReads\.invalidate\(\)/);
  assert.match(api, /finally \{\s+inflightActorReads\.invalidate\(query\)/);
  for (const endpoint of ['activate_solo_challenge', 'activate_group_challenge', 'set_challenge_start_date',
    'create_crew_and_activate_group', 'delete_crew', 'leave_crew', 'confirm_crew_invite']) {
    assert.ok(api.includes(`invalidateReadsAroundMutation(() => client.rpc('${endpoint}'`), endpoint);
  }
  for (const name of ['requireUser', 'getAuthSession', 'getThemePreference', 'recordAppVisit']) {
    const offset = api.indexOf(name === 'requireUser' ? 'const requireUser = ' : `export async function ${name}`);
    const section = api.slice(offset, api.indexOf('\n}', offset) + 2);
    assert.doesNotMatch(section, /inflightActorReads\.run/);
  }
});

test('the real synchronous API observer forwards immutable sessions without calling Auth', async () => {
  const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const session = (id) => ({ user: { id: actorId }, access_token: `header.${Buffer.from(JSON.stringify({ sub: actorId, session_id: id })).toString('base64url')}.signature` });
  const scope = createInflightActorReads(); let observer;
  const start = api.indexOf('supabase?.auth.onAuthStateChange((event, session) => {');
  assert.ok(start >= 0);
  const callback = api.slice(start, api.indexOf('\n});', start) + 4);
  runInNewContext(callback, { inflightActorReads: scope, authSessionIdentity, previewBadgeEpoch: 0, previewBadgeObservedSession: undefined,
    supabase: { auth: new Proxy({ onAuthStateChange: (fn) => { observer = fn; } }, {
      get(target, name) { if (!(name in target)) throw new Error(`Auth method ${String(name)} must not run inside the observer`); return target[name]; },
    }) },
  });
  const firstSession = session('11111111-1111-4111-8111-111111111111');
  observer('INITIAL_SESSION', firstSession);
  let resolve; let calls = 0;
  const pending = new Promise((yes) => { resolve = yes; });
  const key = { actorId, query: 'get_site_training_state', version: 1, args: ['dashboard', 1] };
  const old = scope.run(key, () => { calls += 1; return pending; });
  const rejected = assert.rejects(old, { code: 'STALE_ACTOR_READ' });
  await Promise.resolve();
  observer('SIGNED_IN', session('22222222-2222-4222-8222-222222222222'));
  const replacement = scope.run(key, async () => { calls += 1; return { source: 'replacement' }; });
  resolve({ source: 'old session' });
  await rejected; assert.deepEqual(await replacement, { source: 'replacement' }); assert.equal(calls, 2);
});
