import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createPreviewBadgeBoundary } from './preview-badge-boundary.mjs';
import * as runtime from './badge-preview-state.mjs';

const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };
const tick = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };
function fixture() {
  let owner = { actorId: 'A', sessionIdentity: 'A:s1', token: 'token1', epoch: 0 };
  let loader = async () => runtime; let lockGate = null; let captures = 0; let loads = 0;
  const keys = []; let tail = Promise.resolve();
  const boundary = createPreviewBadgeBoundary({
    captureOwner: async (id) => { captures += 1; if (id !== owner.actorId) throw new Error('The signed-in account changed. Try again.'); return owner; },
    loadRuntime: () => { loads += 1; return loader(); },
    requestLock: (key, work) => {
      keys.push(key);
      const result = tail.then(async () => { if (lockGate) await lockGate; return work(); });
      tail = result.catch(() => {}); return result;
    },
  });
  return { boundary, keys, counts: () => ({ captures, loads }), owner: (change) => { owner = { ...owner, ...change }; },
    mutateOwner: (change) => Object.assign(owner, change), loader: (fn) => { loader = fn; }, lockGate: (value) => { lockGate = value; } };
}

test('module loading precedes serialized state access and every caller gets fresh ownership checks', async () => {
  const f = fixture(); let writes = 0;
  await Promise.all([f.boundary.run('A', (module) => { assert.equal(module, runtime); return ++writes; }), f.boundary.run('A', () => ++writes)]);
  assert.equal(writes, 2); assert.deepEqual(f.keys, ['dominion:badges:A', 'dominion:badges:A']);
  assert.deepEqual(f.counts(), { captures: 6, loads: 2 });
  await f.boundary.run('A', () => 'read', { lock: false });
  assert.deepEqual(f.counts(), { captures: 8, loads: 3 }); assert.equal(f.keys.length, 2);
});

for (const phase of ['import', 'lock']) for (const change of [
  { actorId: 'B' }, { sessionIdentity: 'A:s2' }, { token: 'lower-assurance' }, { epoch: 1 },
]) test(`changed ${Object.keys(change)[0]} during ${phase} cannot touch preview state`, async () => {
  const f = fixture(); const hold = deferred(); let writes = 0;
  if (phase === 'import') f.loader(() => hold.promise); else f.lockGate(hold.promise);
  const pending = f.boundary.run('A', () => ++writes);
  const rejected = assert.rejects(pending, /account changed/);
  await tick(); f.owner(change); hold.resolve(runtime); await rejected; assert.equal(writes, 0);
});

test('capture is immutable and an actor round trip cannot reactivate an older operation', async () => {
  const f = fixture(); const hold = deferred(); f.loader(() => hold.promise);
  const pending = f.boundary.run('A', () => assert.fail('stale write')); const rejected = assert.rejects(pending, /account changed/);
  await tick(); f.mutateOwner({ actorId: 'B', epoch: 1 }); f.mutateOwner({ actorId: 'A', epoch: 2 }); hold.resolve(runtime); await rejected;
});

test('failed imports reserve no lock, mutate nothing, expose fixed copy and can be explicitly retried', async () => {
  const f = fixture(); let writes = 0; f.loader(async () => { throw new Error('PRIVATE_PROVIDER_URL'); });
  await assert.rejects(f.boundary.run('A', () => ++writes), (error) => /temporarily unavailable/.test(error.message) && !error.message.includes('PRIVATE'));
  assert.equal(writes, 0); assert.equal(f.keys.length, 0);
  f.loader(async () => runtime); await f.boundary.run('A', () => ++writes); assert.equal(writes, 1); assert.equal(f.counts().loads, 2);
});

test('missing actor or Web Locks fails before a runtime load', async () => {
  let loads = 0; const boundary = createPreviewBadgeBoundary({ captureOwner: async () => ({ actorId: 'A', sessionIdentity: 'preview:A' }),
    loadRuntime: () => { loads += 1; return runtime; }, requestLock: null });
  await assert.rejects(boundary.run('', () => {}), /account changed/);
  await assert.rejects(boundary.run('A', () => {}), /safely synchronize/);
  assert.equal(loads, 0);
});

test('concurrent committed events, claim leases and acknowledgments remain serialized and idempotent', async () => {
  const f = fixture(); let stored = null;
  const operate = (fn) => f.boundary.run('A', (module) => {
    const state = module.normalizePreviewBadgeState(stored); const result = fn(module, state); stored = structuredClone(state); return result;
  });
  const event = { source: 'check_in', sourceId: 'one', localDate: '2026-02-01', occurredAt: '2026-02-01T12:00:00Z', challengeDay: 1, completed: ['walk'] };
  const awards = await Promise.all([operate((m, s) => m.recordPreviewBadgeEvent(s, event)), operate((m, s) => m.recordPreviewBadgeEvent(s, event))]);
  assert.equal(stored.checkIns.length, 1); assert.equal(awards.filter((batch) => batch.length).length, 1);
  const claims = await Promise.all(['one', 'two'].map((token) => operate((m, s) => ({ token, awards: m.claimPreviewBadgeCelebrations(s, token, 0) }))));
  const claimant = claims.find((claim) => claim.awards.length); assert.equal(claims.filter((claim) => claim.awards.length).length, 1);
  const ids = claimant.awards.map((award) => award.awardId);
  assert.deepEqual(await operate((m, s) => m.acknowledgePreviewBadgeCelebrations(s, 'wrong', ids, 1)), []);
  const acknowledged = await Promise.all([operate((m, s) => m.acknowledgePreviewBadgeCelebrations(s, claimant.token, ids, 2)),
    operate((m, s) => m.acknowledgePreviewBadgeCelebrations(s, claimant.token, ids, 2))]);
  assert.deepEqual(acknowledged, [ids, ids]);
  assert.deepEqual(await operate((m, s) => m.claimPreviewBadgeCelebrations(s, 'later', 130000)), []);
});

const api = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
const authRuntime = readFileSync(new URL('./auth-runtime-core.mjs', import.meta.url), 'utf8');
const captureSource = api.slice(api.indexOf('async function capturePreviewBadgeOwner('), api.indexOf('\nlet previewBadgeBoundary;'));
function ownerFixture(liveAuth) {
  const context = { previewBadgeEpoch: 0, usesSupabaseAuthentication: () => liveAuth,
    supabase: { auth: {} }, session: { identity: 'A:s1', access_token: 'one' }, checks: 0, sessionReads: 0, assuranceReads: 0,
    getAuthSession: async () => { context.sessionReads += 1; return context.session; },
    getLocalOrSessionUser: async () => { context.checks += 1; if (context.onUser) await context.onUser(); return { userId: 'A', authenticated: true }; },
    sessionRequiresMfa: async () => { context.assuranceReads += 1; return context.needsMfa || false; },
    authSessionIdentity: (session) => session?.identity || '',
  };
  runInNewContext(captureSource + '\nglobalThis.capture = capturePreviewBadgeOwner;', context);
  return context;
}
test('actual API owner capture keeps pure mocks completely free of Supabase calls', async () => {
  const f = ownerFixture(false); const owner = await f.capture('A');
  assert.equal(owner.sessionIdentity, 'preview:A'); assert.equal(owner.token, '');
  assert.equal(f.checks, 1); assert.equal(f.sessionReads, 0); assert.equal(f.assuranceReads, 0);
});
test('actual hybrid owner capture rechecks assurance and exact bearer after canonical user lookup', async () => {
  for (const change of ['mfa', 'token', 'session', 'epoch']) {
    const f = ownerFixture(true);
    f.onUser = () => {
      if (change === 'mfa') f.needsMfa = true;
      if (change === 'token') f.session = { ...f.session, access_token: 'two' };
      if (change === 'session') f.session = { ...f.session, identity: 'A:s2' };
      if (change === 'epoch') f.previewBadgeEpoch += 1;
    };
    await assert.rejects(f.capture('A'), /account changed/); assert.equal(f.checks, 1); assert.equal(f.assuranceReads, 1);
  }
});
test('shared runtime owns identity invalidation, never invalidates for ordinary cross-tab badge writes', () => {
  const start = authRuntime.indexOf("globalThis.window?.addEventListener('storage'");
  const source = authRuntime.slice(start, authRuntime.indexOf('\n});', start) + 4); let listener;
  const context = { previewBadgeEpoch: 0, PREVIEW_AUTH_OWNER_STORAGE_KEY: 'dominion:previewAuthOwnerId',
    inflightActorReads: { invalidate() {} }, window: { addEventListener: (_event, fn) => { listener = fn; } } };
  runInNewContext(source, context);
  listener({ key: 'dominion:previewUserState' }); assert.equal(context.previewBadgeEpoch, 0);
  listener({ key: 'dominion:user' }); listener({ key: 'sb-127-auth-token' }); listener({ key: null }); assert.equal(context.previewBadgeEpoch, 3);
  for (const name of ['clearAuthSession', 'saveLocalMockUser']) {
    const source = api.slice(api.indexOf(`export ${name === 'clearAuthSession' ? 'async ' : ''}function ${name}`));
    assert.match(source.slice(0, source.indexOf('\n}')), /invalidatePreviewBadgeOwner\(\)/);
  }
  assert.match(authRuntime, /function invalidatePreviewBadgeOwner\(\) \{ previewBadgeEpoch \+= 1; \}/);
});

test('actual collection cannot rebind an older earned snapshot after an actor/session round trip', async () => {
  const source = api.slice(api.indexOf('export async function getBadgeCollection('), api.indexOf('\nasync function queryLeaderboard(')).replaceAll('export ', '');
  for (const replacement of ['actor', 'session-round-trip']) {
    let currentOwner = { actorId: 'A', sessionIdentity: 'A:old', token: 'old', epoch: 0 };
    let actorChecks = 0; let collectionReads = 0;
    const state = { schemaVersion: 1, awards: [{ key: 'faithful_start', name: 'Old-session award' }], checkIns: [], visits: [] };
    const boundary = createPreviewBadgeBoundary({
      captureOwner: async () => currentOwner,
      loadRuntime: async () => ({
        ...runtime,
        previewBadgeCollection: (...args) => { collectionReads += 1; return runtime.previewBadgeCollection(...args); },
      }),
    });
    const context = {
      isLocalDemoMode: () => true, requireHybridPreviewUser: async () => {},
      requireMockRewardActor: () => {
        actorChecks += 1;
        if (actorChecks === 3) queueMicrotask(() => {
          currentOwner = { actorId: replacement === 'actor' ? 'B' : 'A', sessionIdentity: replacement === 'actor' ? 'B:new' : 'A:new', token: 'new', epoch: 2 };
          state.awards = [];
        });
        return 'A';
      },
      getPreviewBadgeBoundary: () => boundary, PREVIEW_BADGE_STATE_KEY: 'dominion:badgeState:v1',
      readMockUserValue: () => state, mapBadge: value => ({ ...value }), normalizeEarnedBadges: value => value,
      readMockChallengeActivation: () => ({ timeZone: 'UTC' }), dateKeyForTimeZone: () => '2026-02-14',
    };
    runInNewContext(source + '\nglobalThis.collection = getBadgeCollection;', context);
    await assert.rejects(context.collection({ expectedUserId: 'A' }), /account changed/);
    assert.equal(actorChecks, 3, 'replacement runs immediately after the final earned-read actor check');
    assert.equal(collectionReads, 0, 'no collection facts read or mixed-session payload published');
  }
});
