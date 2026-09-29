import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { createSiteTrainingApiLoader } from './site-training-api-loader.mjs';
import { createSiteTrainingApi } from './site-training-api.mjs';
import { createInflightActorReads } from './inflight-actor-reads.mjs';
import { createSiteTrainingPageProgress, applySiteTrainingTransition } from './site-training-state.mjs';

const page = { id: 'dashboard', route: '/dashboard.html', contentVersion: 1, steps: [{ id: 'one' }, { id: 'two' }] };
const requestId = '11111111-1111-4111-8111-111111111111';
const args = () => ({ page, expectedUserId: 'A', requestId, action: 'start', expectedRevision: 0 });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture({ load, response, readOwner: ownerHook, client, preview = false, timeoutMs } = {}) {
  let epoch = 0, loads = 0, ownerReads = 0;
  let owner = { actorId: 'A', sessionIdentity: 'A:session-1', bearer: 'token-A', preview };
  const calls = [], auth = [], invalidations = [], store = new Map();
  const reads = createInflightActorReads();
  const dependencies = {
    isLocalDemoMode: () => preview,
    requireHybridPreviewUser: async () => null,
    getMockUserId: () => owner?.actorId || '',
    requireUser: async expected => { auth.push(expected); return { id: expected }; },
    requireSupabase: () => client || ({ rpc(name, values) {
      const call = { name, values, header: null }; calls.push(call);
      return { setHeader(key, value) {
        call.header = [key, value];
        if (response) return response(name, values);
        const state = createSiteTrainingPageProgress(page, values.target_expected_actor_id);
        return Promise.resolve({ data: name === 'get_site_training_state' ? state : {
          ...applySiteTrainingTransition(state, 'start'), transition: { action: 'start', applied: true, scope: 'page' },
        }, error: null });
      } };
    } }),
    inflightActorReads: reads,
    invalidateReadsAroundMutation: async (work, key) => {
      invalidations.push(['before', key]); reads.invalidate(key);
      try { return await work(); } finally { invalidations.push(['after', key]); reads.invalidate(key); }
    },
    storage: {},
    peekPreviewUserValue: (_storage, id, key, fallback) => structuredClone(store.get(`${id}:${key}`) ?? fallback),
    readMockUserValue: (key, fallback, id) => structuredClone(store.get(`${id}:${key}`) ?? fallback),
    writeMockUserValue: (key, value, id) => store.set(`${id}:${key}`, structuredClone(value)),
    readJson: (key, fallback) => structuredClone(store.get(key) ?? fallback),
    writeJson: (key, value) => store.set(key, structuredClone(value)),
  };
  const invoke = createSiteTrainingApiLoader({
    dependencies, timeoutMs,
    readEpoch: () => epoch,
    readOwner: async () => { ownerReads += 1; if (ownerHook) await ownerHook(ownerReads); return owner && { ...owner }; },
    load: async () => { loads += 1; return load ? load() : { createSiteTrainingApi }; },
  });
  return { invoke, calls, auth, invalidations, store, reads, dependencies,
    loads: () => loads, ownerReads: () => ownerReads,
    change(next, { notify = true } = {}) { owner = next; if (notify) epoch += 1; },
    owner: () => owner && { ...owner }, invalidate() { epoch += 1; },
  };
}

test('construction and module factory perform no I/O, and loader caches only public code', async () => {
  const f = fixture();
  assert.equal(f.loads(), 0); assert.equal(f.ownerReads(), 0); assert.equal(f.calls.length, 0);
  createSiteTrainingApi(f.dependencies);
  assert.equal(f.ownerReads(), 0); assert.equal(f.calls.length, 0); assert.equal(f.store.size, 0);
  const first = await f.invoke('getSiteTrainingState', args());
  const second = await f.invoke('getSiteTrainingState', args());
  assert.equal(first.actorId, 'A'); assert.equal(second.actorId, 'A');
  assert.equal(f.loads(), 1); assert.equal(f.calls.length, 2, 'Settled private responses are never cached.');
  assert.ok(f.calls.every(call => call.header[1] === 'Bearer token-A'));
});

for (const operation of ['getSiteTrainingState', 'claimSiteTraining', 'transitionSiteTraining']) {
  for (const change of ['A-B-A', 'same-user-session', 'same-session-bearer', 'sign-out', 'pagehide']) {
    test(`${operation} rejects ${change} while its public module import is pending`, async () => {
      const gate = deferred(); const f = fixture({ load: () => gate.promise });
      const original = f.owner();
      const result = f.invoke(operation, args());
      const rejected = assert.rejects(result, { code: 'SITE_TRAINING_ACTOR_CHANGED' });
      await tick(); assert.equal(f.loads(), 1);
      if (change === 'A-B-A') { f.change({ ...original, actorId: 'B' }); f.change(original); }
      else if (change === 'same-user-session') f.change({ ...original, sessionIdentity: 'A:session-2' }, { notify: false });
      else if (change === 'same-session-bearer') f.change({ ...original, bearer: 'token-refreshed' }, { notify: false });
      else if (change === 'sign-out') f.change(null);
      else f.invalidate();
      gate.resolve({ createSiteTrainingApi });
      await rejected;
      assert.equal(f.calls.length, 0); assert.equal(f.auth.length, 0); assert.equal(f.store.size, 0);
    });
  }
}

test('the epoch is captured before the first session read, including A-B-A during that await', async () => {
  const gate = deferred(); const f = fixture({ readOwner: count => count === 1 ? gate.promise : undefined });
  const original = f.owner();
  const result = f.invoke('claimSiteTraining', args());
  const rejected = assert.rejects(result, { code: 'SITE_TRAINING_ACTOR_CHANGED' });
  f.change({ ...original, actorId: 'B' }); f.change(original); gate.resolve();
  await rejected; assert.equal(f.loads(), 0); assert.equal(f.calls.length, 0);
});

test('missing or mismatched actor fails before module loading or private access', async () => {
  const f = fixture();
  await assert.rejects(f.invoke('getSiteTrainingState', {}), /captured signed-in account/);
  await assert.rejects(f.invoke('getSiteTrainingState', { ...args(), expectedUserId: 'B' }), { code: 'SITE_TRAINING_ACTOR_CHANGED' });
  assert.equal(f.loads(), 0); assert.equal(f.calls.length, 0);
});

test('same-user session replacement during the authoritative user check cannot start the RPC', async () => {
  const gate = deferred(); const entered = deferred(); const f = fixture();
  f.dependencies.requireUser = async () => { entered.resolve(); await gate.promise; return { id: 'A' }; };
  const result = f.invoke('claimSiteTraining', args());
  const rejected = assert.rejects(result, { code: 'SITE_TRAINING_ACTOR_CHANGED' });
  await entered.promise;
  f.change({ ...f.owner(), sessionIdentity: 'A:session-2' }, { notify: false });
  gate.resolve(); await rejected; assert.equal(f.calls.length, 0);
});

test('synchronous invalidation during factory construction cannot invoke the service', async () => {
  let dispatched = 0;
  const f = fixture({ load: async () => ({ createSiteTrainingApi() {
    f.invalidate(); return { claimSiteTraining() { dispatched += 1; } };
  } }) });
  await assert.rejects(f.invoke('claimSiteTraining', args()), { code: 'SITE_TRAINING_ACTOR_CHANGED' });
  assert.equal(dispatched, 0); assert.equal(f.calls.length, 0);
});

test('input and default request ID are captured before loading; no delayed caller mutation', async () => {
  const gate = deferred(); const f = fixture({ load: () => gate.promise });
  const input = { ...args(), page: structuredClone(page) }; delete input.requestId;
  const result = f.invoke('claimSiteTraining', input);
  input.expectedUserId = 'B'; input.page.id = 'other'; input.requestId = 'replacement'; input.expectedRevision = 5;
  gate.resolve({ createSiteTrainingApi });
  await result;
  assert.match(f.calls[0].values.target_request_id, /^[a-f0-9-]{36}$/);
  assert.equal(f.calls[0].values.target_expected_actor_id, 'A');
  assert.equal(f.calls[0].values.target_page_id, 'dashboard');
  assert.equal(f.calls[0].values.target_expected_revision, 0);
});

test('import rejection is sticky, safely described, and never dispatches or retries a mutation', async () => {
  const f = fixture({ load: async () => { throw new Error('private provider sentinel'); } });
  for (let attempt = 0; attempt < 2; attempt += 1) await assert.rejects(f.invoke('claimSiteTraining', args()), error =>
    error.code === 'SITE_TRAINING_RELOAD_REQUIRED' && !JSON.stringify(error).includes('sentinel') && !error.message.includes('sentinel'));
  assert.equal(f.loads(), 1); assert.equal(f.calls.length, 0);
});

test('a timed-out public import cannot resume a late operation or silently reload', async () => {
  const gate = deferred(); const f = fixture({ load: () => gate.promise, timeoutMs: 5 });
  await assert.rejects(f.invoke('claimSiteTraining', args()), { code: 'SITE_TRAINING_RELOAD_REQUIRED' });
  gate.resolve({ createSiteTrainingApi }); await tick();
  await assert.rejects(f.invoke('claimSiteTraining', args()), { code: 'SITE_TRAINING_RELOAD_REQUIRED' });
  assert.equal(f.loads(), 1); assert.equal(f.calls.length, 0);
});

test('concurrent reads preserve the existing complete coalescing key and independent response copies', async () => {
  const gate = deferred(); const f = fixture({ response: () => gate.promise });
  const first = f.invoke('getSiteTrainingState', args());
  const second = f.invoke('getSiteTrainingState', args());
  await tick(); assert.equal(f.calls.length, 1);
  gate.resolve({ data: createSiteTrainingPageProgress(page, 'A'), error: null });
  const [a, b] = await Promise.all([first, second]);
  a.page.status = 'changed'; assert.equal(b.page.status, 'not_started');
  assert.equal(f.auth.length, 2, 'Original pre/post authoritative checks remain coalesced with the read.');
});

for (const operation of ['getSiteTrainingState', 'claimSiteTraining']) {
  test(`${operation} never publishes a stale response after replacement or retries the operation`, async () => {
    const gate = deferred(); const f = fixture({ response: () => gate.promise });
    const result = f.invoke(operation, args());
    const rejected = assert.rejects(result, { code: 'SITE_TRAINING_ACTOR_CHANGED' });
    await tick(); assert.equal(f.calls.length, 1);
    f.change({ ...f.owner(), actorId: 'B', bearer: 'token-B' });
    gate.resolve({ data: createSiteTrainingPageProgress(page, 'A'), error: null });
    await rejected; assert.equal(f.calls.length, 1);
    if (operation === 'claimSiteTraining') assert.deepEqual(f.invalidations, [
      ['before', 'get_site_training_state'], ['after', 'get_site_training_state'],
    ]);
  });
}

test('unknown mutation outcome is surfaced once, with existing invalidation and no auto-retry', async () => {
  const f = fixture({ response: async () => { throw new Error('connection lost'); } });
  await assert.rejects(f.invoke('claimSiteTraining', args()), /connection lost/);
  await tick(); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.invalidations, [['before', 'get_site_training_state'], ['after', 'get_site_training_state']]);
});

test('per-call preview factories preserve shared request replay and do not mutate read-only state', async () => {
  const f = fixture({ preview: true });
  await f.invoke('getSiteTrainingState', args()); assert.equal(f.store.size, 0);
  const first = await f.invoke('claimSiteTraining', args());
  const replay = await f.invoke('claimSiteTraining', args());
  assert.deepEqual(replay, first); assert.equal(replay.page.revision, 1);
  await assert.rejects(f.invoke('transitionSiteTraining', { ...args(), action: 'stop' }), { code: '23505' });
  const stopped = await f.invoke('transitionSiteTraining', { ...args(), requestId: '22222222-2222-4222-8222-222222222222', action: 'stop', expectedRevision: 1 });
  assert.equal(stopped.page.revision, 2); assert.equal(stopped.page.status, 'stopped');
  assert.equal(f.loads(), 1); assert.equal(f.calls.length, 0);
});

test('actual installed SDK keeps captured Authorization while its internal token lookup resolves as replacement', async () => {
  const gate = deferred(); const entered = deferred(); const sent = [];
  let armed = false;
  const client = createClient('https://training-fixture.invalid', 'public-fixture-key', {
    accessToken: async () => { if (!armed) return 'token-A'; entered.resolve(); return gate.promise; },
    global: { fetch: async (url, init) => {
      sent.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
    } },
  });
  // The client also initializes its Realtime token without sending a request.
  // Hold only the subsequent fetchWithAuth lookup for the training RPC.
  await tick(); armed = true;
  const f = fixture({ client });
  const result = f.invoke('claimSiteTraining', args());
  const rejected = assert.rejects(result, { code: 'SITE_TRAINING_ACTOR_CHANGED' });
  await entered.promise;
  f.change({ ...f.owner(), actorId: 'B', sessionIdentity: 'B:session-2', bearer: 'token-B' });
  gate.resolve('token-B');
  await rejected;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].headers.get('authorization'), 'Bearer token-A');
  assert.equal(sent[0].body.target_expected_actor_id, 'A');
  assert.equal(sent[0].body.target_request_id, requestId);
  assert.equal(sent[0].url, 'https://training-fixture.invalid/rest/v1/rpc/claim_site_training');
});

test('production facade delegates only training operations and uses the existing eager epoch/session runtime', () => {
  const api = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
  const source = api.slice(api.indexOf('const invokeSiteTraining = '), api.indexOf('let dailyActionBootstrapClient'));
  assert.match(source, /readEpoch: \(\) => previewBadgeEpoch/);
  assert.match(source, /await getAuthSession\(\)/);
  assert.match(source, /sessionIdentity: authSessionIdentity\(session\)/);
  assert.match(source, /bearer: session\?\.access_token/);
  assert.match(api, /addEventListener\('pagehide', \(\) => \{ invalidatePreviewBadgeOwner\(\)/);
  assert.doesNotMatch(source, /createClient|onAuthStateChange|\.rpc\(/);
  const domain = readFileSync(new URL('./site-training-api.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(domain, /from ['"]\.\/api(?:\.js)?['"]|createClient/);
});
