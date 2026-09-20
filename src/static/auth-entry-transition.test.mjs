import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { createAuthEntryTransition } from './auth-entry-transition.mjs';

const flush = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

test('a form reservation pauses immediately and only its owner can resume it', () => {
  const entry = createAuthEntryTransition(); const firstSignal = entry.capture();
  const first = entry.begin(); const second = entry.begin();
  assert.equal(firstSignal.aborted, true);
  assert.equal(entry.capture(), null);
  first(); first();
  assert.equal(entry.capture(), null, 'An old completion cannot release a newer attempt.');
  second();
  assert.ok(entry.isCurrent(entry.capture()));
  assert.equal(entry.isCurrent(firstSignal), false);
});

test('failed/no-session attempts resume fresh work; committed navigation waits for persisted restoration', () => {
  const entry = createAuthEntryTransition(); const notifications = [];
  entry.subscribe(paused => notifications.push(paused));
  const complete = entry.begin(); complete();
  assert.deepEqual(notifications, [true, false]);
  const queued = entry.capture();
  const oldCompletion = entry.begin(); entry.suspend();
  oldCompletion();
  assert.equal(entry.capture(), null);
  entry.restore(); const restored = entry.capture();
  oldCompletion();
  assert.ok(entry.isCurrent(restored));
  assert.equal(entry.isCurrent(queued), false);
});

const api = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
for (const [name, next, invoke] of [
  ['getRewardCatalog', 'getAllRewardCatalog', (read, options) => read(options)],
  ['getThemePreference', 'setThemePreference', (read, options) => read(options)],
  ['setThemePreference', 'ensureProfile', (read, options) => read('dark', options)],
]) {
  const source = api.slice(api.indexOf('export async function ' + name), api.indexOf('export async function ' + next)).replace(/^export /, '');
  const fixture = () => {
    const requests = []; let checks = 0;
    const scope = {
      isLocalDemoMode: () => false,
      requireUser: async expected => { checks += 1; assert.equal(expected, 'A'); return { id: 'A' }; },
      requireSupabase: () => ({ rpc: () => {
        const held = deferred();
        held.promise.abortSignal = signal => { held.signal = signal; return held.promise; };
        requests.push(held); return held.promise;
      } }),
      normalizeRewardCatalog: value => value,
      normalizeThemePreference: value => value,
    };
    runInNewContext(source + '\nglobalThis.read = ' + name + ';', scope);
    return { read: options => invoke(scope.read, { expectedUserId: 'A', ...options }), requests, checks: () => checks };
  };

  test(name + ': cancelled delayed response cannot start a post-RPC user check or cancel another consumer', async () => {
    const f = fixture(); const owner = new AbortController();
    const cancelled = f.read({ signal: owner.signal });
    const rejection = assert.rejects(cancelled, { name: 'AbortError' });
    const active = f.read(); await flush();
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[0].signal, owner.signal);
    assert.equal(f.requests[1].signal, undefined);
    owner.abort();
    // Even a transport that ignores abort and delivers a late result is fenced.
    for (const request of f.requests) request.resolve({ data: { themeKey: 'dark' }, error: null });
    await rejection;
    assert.equal((await active).themeKey, 'dark');
    assert.equal(f.checks(), 3, 'Two prechecks and only the active caller\'s canonical postcheck.');
  });

  test(name + ': queued cancelled work never starts authentication or an RPC', async () => {
    const f = fixture(); const owner = new AbortController(); owner.abort();
    await assert.rejects(f.read({ signal: owner.signal }), { name: 'AbortError' });
    assert.equal(f.checks(), 0); assert.equal(f.requests.length, 0);
  });
}

test('menu-owned cancellation preserves direct theme state, pending gate, and same-actor cache', async () => {
  const held = []; let finished = 0; let runtimeEntitlements = []; let runtimePending = true;
  const source = readFileSync(new URL('./theme-entitlement-state.js', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?from '[^']+';\n/gm, '').replace(/^export /gm, '');
  const read = async ({ signal }) => {
    const pending = deferred(); held.push({ ...pending, signal });
    const outcome = await pending.promise; signal?.throwIfAborted();
    if (outcome === 'outage') throw new Error('Synthetic theme outage');
    return { themeKey: 'dark', items: [] };
  };
  const scope = {
    getLocalOrSessionUser: async () => ({ authenticated: true, userId: 'A' }),
    getRewardCatalog: read, getThemePreference: read,
    setThemePreference: async () => { throw new Error('Unexpected preference migration'); },
    deriveAuthorizedThemeIds: () => ['synthetic-earned-theme'], getThemeRegistry: () => [], readPreferredTheme: () => 'dark',
    setThemeEntitlements(value, options) { runtimeEntitlements = [...value]; if (!options?.deferPending) runtimePending = false; },
    setTheme() {}, finishProtectedThemeHydration() { finished += 1; runtimePending = false; },
  };
  runInNewContext(source + '\nglobalThis.hydrate = hydrateThemeEntitlementState;', scope);
  const owner = new AbortController();
  const optional = scope.hydrate({ signal: owner.signal });
  const coalesced = scope.hydrate({ signal: owner.signal });
  const direct = scope.hydrate(); await flush();
  assert.equal(held.length, 4, 'Independent owners have separate RPC pairs.');
  assert.equal(runtimePending, true);
  owner.abort();
  for (const pending of held.filter(item => item.signal)) pending.resolve();
  const cancelledResult = await optional;
  assert.equal(cancelledResult.error.name, 'AbortError');
  assert.equal(await coalesced, cancelledResult, 'One optional owner retains its own same-actor in-flight cache.');
  assert.equal(runtimePending, true, 'Cancellation cannot release the direct consumer\'s protected-theme gate.');
  assert.deepEqual(runtimeEntitlements, []);
  for (const pending of held.filter(item => !item.signal)) pending.resolve();
  const directResult = await direct; assert.equal(directResult.authenticated, true);
  assert.equal(runtimePending, false);
  assert.equal(await scope.hydrate(), directResult);
  assert.equal(held.length, 4, 'The unsignalled same-actor cache is unchanged.');
  const laterOwner = new AbortController();
  const laterOptional = scope.hydrate({ signal: laterOwner.signal }); await flush();
  assert.deepEqual(runtimeEntitlements, ['synthetic-earned-theme'], 'An optional start cannot erase established direct state.');
  laterOwner.abort();
  for (const pending of held.slice(4)) pending.resolve();
  assert.equal((await laterOptional).error.name, 'AbortError');
  assert.deepEqual(runtimeEntitlements, ['synthetic-earned-theme']);
  assert.equal(runtimePending, false);
  assert.equal(await scope.hydrate(), directResult);
  const retryOwner = new AbortController(); const beforeFailure = finished;
  const failure = scope.hydrate({ signal: retryOwner.signal }); await flush();
  for (const pending of held.slice(6)) pending.resolve('outage');
  assert.equal((await failure).error.message, 'Synthetic theme outage');
  assert.equal(finished, beforeFailure, 'Optional failure cannot alter the completed direct gate.');
  assert.deepEqual(runtimeEntitlements, ['synthetic-earned-theme']);
  assert.equal(runtimePending, false);
  assert.equal(await scope.hydrate(), directResult);
  const retry = scope.hydrate({ signal: retryOwner.signal }); await flush();
  assert.equal(held.length, 10, 'Failure releases only the optional cache for retry.');
  for (const pending of held.slice(8)) pending.resolve();
  assert.equal((await retry).authenticated, true);
});

for (const directCompletesFirst of [false, true]) {
  for (const optionalPreference of ['old-optional-theme', null]) {
    test(`optional success cannot publish or migrate over a ${directCompletesFirst ? 'completed' : 'pending'} direct owner (${optionalPreference || 'missing preference'})`, async () => {
      const held = []; const migrations = []; const publications = [];
      let runtimeEntitlements = []; let runtimeTheme = 'initial'; let runtimePending = true;
      const source = readFileSync(new URL('./theme-entitlement-state.js', import.meta.url), 'utf8')
        .replace(/^import[\s\S]*?from '[^']+';\n/gm, '').replace(/^export /gm, '');
      const read = async ({ signal }) => {
        const pending = deferred(); held.push({ ...pending, signal });
        await pending.promise;
        return { themeKey: signal ? optionalPreference : 'new-direct-theme', owner: signal ? 'optional' : 'direct' };
      };
      const scope = {
        getLocalOrSessionUser: async () => ({ authenticated: true, userId: 'A' }),
        getRewardCatalog: read, getThemePreference: read,
        setThemePreference: async theme => { migrations.push(theme); },
        deriveAuthorizedThemeIds: catalog => [catalog.owner + '-entitlement'],
        getThemeRegistry: () => [], readPreferredTheme: () => 'dark',
        setThemeEntitlements(value, options) { runtimeEntitlements = [...value]; if (!options?.deferPending) runtimePending = false; },
        setTheme(value) { publications.push(value); runtimeTheme = value; },
        finishProtectedThemeHydration() { runtimePending = false; },
      };
      runInNewContext(source + '\nglobalThis.hydrate = hydrateThemeEntitlementState;', scope);
      const optional = scope.hydrate({ signal: new AbortController().signal }); await flush();
      const direct = scope.hydrate(); await flush();
      assert.equal(held.length, 4);
      let directResult;
      if (directCompletesFirst) {
        for (const request of held.filter(item => !item.signal)) request.resolve();
        directResult = await direct;
        assert.equal(runtimeTheme, 'new-direct-theme');
      }
      for (const request of held.filter(item => item.signal)) request.resolve();
      const optionalResult = await optional;
      assert.equal(optionalResult.authenticated, true, 'The optional caller still receives its verified response.');
      assert.equal(optionalResult.catalog.owner, 'optional');
      assert.deepEqual(migrations, [], 'An older missing preference cannot initiate a fallback write over the direct owner.');
      assert.deepEqual(publications, directCompletesFirst ? ['new-direct-theme'] : []);
      assert.equal(runtimeTheme, directCompletesFirst ? 'new-direct-theme' : 'initial');
      assert.deepEqual(runtimeEntitlements, directCompletesFirst ? ['direct-entitlement'] : []);
      assert.equal(runtimePending, !directCompletesFirst);
      if (!directCompletesFirst) {
        for (const request of held.filter(item => !item.signal)) request.resolve();
        directResult = await direct;
      }
      assert.equal(await scope.hydrate(), directResult, 'The direct owner retains the canonical same-actor cache.');
      assert.equal(runtimeTheme, 'new-direct-theme');
      assert.deepEqual(runtimeEntitlements, ['direct-entitlement']);
      assert.equal(runtimePending, false);
      assert.equal(held.length, 4);
    });
  }
}
