import { test, expect, deferred, openHarness, stateFor, deliveryRowsFor, holdDeliveryStore, releaseDeliveryStore, startCheckIn, finishOperation } from './support/preview-badge-browser-support.mjs';
import { installFou1452SupabaseAuthStub } from './support/fou-1452-supabase-auth-stub.mjs';

const A = { email: 'alpha.badge-hybrid@example.test', password: 'Synthetic-Badge-Password1!' };
const B = { email: 'bravo.badge-hybrid@example.test', password: 'Synthetic-Badge-Password2!' };
const RUNTIME = /\/src\/static\/badge-preview-state\.mjs(?:\?.*)?$/;
async function register(page, account = A) {
  return page.evaluate(async account => {
    const { api } = window.__previewBadgeTest;
    const result = await api.supabase.auth.signUp(account);
    if (result.error) throw result.error;
    return (await api.getLocalOrSessionUser()).userId;
  }, account);
}
async function replaceSession(page, sameActor) {
  await page.evaluate(async ({ sameActor, A, B }) => {
    const { api } = window.__previewBadgeTest;
    const out = await api.supabase.auth.signOut();
    if (out.error) throw out.error;
    const next = sameActor ? await api.supabase.auth.signInWithPassword(A) : await api.supabase.auth.signUp(B);
    if (next.error) throw next.error;
    await api.getLocalOrSessionUser();
  }, { sameActor, A, B });
}

test('real SDK preview counts every canonical user check without live database calls', async ({ page, context }, testInfo) => {
  const auth = await installFou1452SupabaseAuthStub(context);
  await openHarness(page); const owner = await register(page);
  let marker = auth.requests.length;
  await startCheckIn(page, owner); expect((await finishOperation(page)).ok).toBe(true);
  const locked = auth.requests.slice(marker).map(({ method, endpoint }) => method + ' ' + endpoint);
  expect(locked).toEqual(['GET /user', 'GET /user', 'GET /user']);
  marker = auth.requests.length;
  const collection = await page.evaluate(owner => window.__previewBadgeTest.api.getBadgeCollection({ expectedUserId: owner }), owner);
  expect(collection.items.length).toBeGreaterThan(20);
  const read = auth.requests.slice(marker).map(({ method, endpoint }) => method + ' ' + endpoint);
  // History is one snapshot with capture, post-import and post-snapshot
  // verification. It does not open the delivery database or reread history.
  expect(read).toEqual(['GET /user', 'GET /user', 'GET /user']);
  marker = auth.requests.length;
  await page.evaluate(owner => window.__previewBadgeTest.api.claimBadgeCelebrations({ expectedUserId: owner, claimToken: 'claim' }), owner);
  const coldDelivery = auth.requests.slice(marker).map(({ method, endpoint }) => method + ' ' + endpoint);
  // Preserve capture, badge import and lock fences, then verify after the
  // delivery import, database open and transaction commit. A warm module or
  // connection is not permission to skip canonical identity verification.
  const deliveryChecks = ['GET /user', 'GET /user', 'GET /user', 'GET /user', 'GET /user', 'GET /user'];
  expect(coldDelivery).toEqual(deliveryChecks);
  marker = auth.requests.length;
  await page.evaluate(owner => window.__previewBadgeTest.api.claimBadgeCelebrations({ expectedUserId: owner, claimToken: 'claim' }), owner);
  const warmDelivery = auth.requests.slice(marker).map(({ method, endpoint }) => method + ' ' + endpoint);
  expect(warmDelivery).toEqual(deliveryChecks);
  await testInfo.attach('canonical-auth-traffic', { contentType: 'application/json', body: JSON.stringify({ locked, collection: read, coldDelivery, warmDelivery }) });
});

for (const sameActor of [false, true]) test(`real SDK ${sameActor ? 'same-actor replacement session' : 'actor switch'} during import cannot commit`, async ({ page, context }) => {
  await installFou1452SupabaseAuthStub(context);
  const entered = deferred(); const release = deferred();
  await page.route(RUNTIME, async route => { entered.resolve(); await release.promise; await route.fallback(); });
  await openHarness(page); const owner = await register(page);
  await startCheckIn(page, owner); await entered.promise;
  await replaceSession(page, sameActor); release.resolve();
  expect((await finishOperation(page)).error).toBe('The signed-in account changed. Try again.');
  expect(await stateFor(page, owner)).toBeNull();
});

test('real SDK session replacement while a badge lock is queued cannot commit', async ({ page, context }) => {
  await installFou1452SupabaseAuthStub(context);
  await openHarness(page); const owner = await register(page);
  await page.evaluate(owner => {
    window.badgeLockReady = new Promise(ready => {
      window.badgeLockHolding = navigator.locks.request('dominion:badges:' + owner, () => new Promise(release => {
        window.releaseBadgeLock = release; ready();
      }));
    });
  }, owner);
  await page.evaluate(() => window.badgeLockReady); await startCheckIn(page, owner);
  // Auth owns its own Web Lock; only this exact badge key is relevant.
  await expect.poll(() => page.evaluate(async owner => (await navigator.locks.query()).pending.filter(lock => lock.name === 'dominion:badges:' + owner).length, owner)).toBe(1);
  await replaceSession(page, true); await page.evaluate(() => window.releaseBadgeLock());
  expect((await finishOperation(page)).error).toBe('The signed-in account changed. Try again.');
  expect(await stateFor(page, owner)).toBeNull();
});

test('canonical Auth rejection after a loaded runtime never touches badge state', async ({ page, context }) => {
  const auth = await installFou1452SupabaseAuthStub(context);
  const entered = deferred(); const release = deferred();
  await page.route(RUNTIME, async route => { entered.resolve(); await release.promise; await route.fallback(); });
  await openHarness(page); const owner = await register(page);
  await startCheckIn(page, owner); await entered.promise;
  auth.invalidateUser(A.email); release.resolve();
  expect((await finishOperation(page)).error).toBe('The signed-in account changed. Try again.');
  expect(await stateFor(page, owner)).toBeNull();
});

test('collection rejects a registered replacement session while verifying its earned snapshot', async ({ page, context }) => {
  await installFou1452SupabaseAuthStub(context);
  await openHarness(page); const owner = await register(page);
  await page.evaluate(owner => window.__previewBadgeTest.writePreviewUserValue(localStorage, owner, 'dominion:badgeState:v1', {
    schemaVersion: 1, checkIns: [], visits: [],
    awards: [{ key: 'faithful_start', name: 'Old-session award', scopeKey: 'lifetime', awardId: 'old-award', legacy: true }],
  }), owner);
  const entered = deferred(); const release = deferred(); let reads = 0;
  await page.route(/\/__fou_1452_supabase__\/auth\/v1\/user$/, async route => {
    reads += 1;
    // Hold the final canonical verification of the single historical snapshot.
    if (reads === 3) { entered.resolve(); await release.promise; }
    await route.fallback();
  });
  await page.evaluate(owner => {
    window.pendingBadgeOperation = window.__previewBadgeTest.api.getBadgeCollection({ expectedUserId: owner })
      .then(value => ({ ok: true, value }), error => ({ ok: false, error: error.message }));
  }, owner);
  await entered.promise;
  await page.evaluate(async ({ account, owner }) => {
    const { createClient, writePreviewUserValue } = window.__previewBadgeTest;
    // A separate real SDK client obtains a registered session, using its own
    // SDK lock. No token is fabricated or accepted outside the faithful stub.
    const secondary = createClient(location.origin + '/__fou_1452_supabase__', 'sb_publishable_fou_1452_browser_fixture', {
      auth: { storageKey: 'preview-badge-test-secondary', persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await secondary.auth.signInWithPassword(account);
    if (error) throw error;
    // Model the storage arrival of a replacement session before its optional
    // observer notification. Canonical post-await session checks must catch it.
    localStorage.setItem('sb-127-auth-token', JSON.stringify(data.session));
    writePreviewUserValue(localStorage, owner, 'dominion:badgeState:v1', { schemaVersion: 1, awards: [], checkIns: [], visits: [] });
  }, { account: A, owner });
  release.resolve();
  expect((await finishOperation(page)).error).toBe('The signed-in account changed. Try again.');
  expect(reads).toBe(3);
  expect((await stateFor(page, owner)).awards).toEqual([]);
});

for (const sameActor of [false, true]) test(`real SDK ${sameActor ? 'replacement session' : 'actor switch'} during a queued native delivery transaction cannot commit`, async ({ page, context }) => {
  await installFou1452SupabaseAuthStub(context);
  await openHarness(page); const owner = await register(page);
  await startCheckIn(page, owner); expect((await finishOperation(page)).ok).toBe(true);
  const ids = (await stateFor(page, owner)).awards.map(award => award.awardId);
  expect(await page.evaluate(({ owner, ids }) => window.__previewBadgeTest.api.acknowledgeBadgeCelebrations({
    expectedUserId: owner, claimToken: 'never-claimed', awardIds: ids,
  }).then(() => 'unexpected success', error => error.message), { owner, ids })).toBe('Badge acknowledgment is still pending.');
  const before = await deliveryRowsFor(page, owner, 'badge');
  expect(before.length).toBeGreaterThan(0);
  await holdDeliveryStore(page);
  try {
    await page.evaluate(owner => {
      window.pendingDeliveryOperation = window.__previewBadgeTest.api.claimBadgeCelebrations({ expectedUserId: owner, claimToken: 'queued-native-claim' })
        .then(value => ({ value }), error => ({ error: error.message }));
    }, owner);
    await expect.poll(() => page.evaluate(() => window.queuedDeliveryTransactions)).toBe(1);
    await replaceSession(page, sameActor);
  } finally { await releaseDeliveryStore(page); }
  expect(await page.evaluate(() => window.pendingDeliveryOperation)).toEqual({ error: 'The signed-in account changed. Try again.' });
  expect(await deliveryRowsFor(page, owner, 'badge')).toEqual(before);
});
