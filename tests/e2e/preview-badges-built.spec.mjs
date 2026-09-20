import { test, expect, HARNESS, RUNTIME, deferred, openHarness, signInMock, stateFor, startCheckIn, finishOperation } from './support/preview-badge-browser-support.mjs';
import { fixtureFor, FIXED_NOW, FIXED_USER_ID } from './support/fixtures.mjs';

test('compiled public and Security entries do not fetch the optional preview runtime or ship the harness', async ({ page, traffic }) => {
  const runtime = []; page.on('request', request => { if (RUNTIME.test(request.url())) runtime.push(request.url()); });
  for (const route of ['/index.html', '/account-security.html', '/login.html']) {
    await page.goto(route, { waitUntil: 'networkidle' });
    expect(await page.evaluate(() => '__previewBadgeTest' in window)).toBe(false);
  }
  expect(runtime).toEqual([]); expect(traffic.provider).toEqual([]);
});

for (const roundTrip of [false, true]) test(`delayed compiled import cannot write after an account ${roundTrip ? 'round trip' : 'change'}`, async ({ page }) => {
  const entered = deferred(); const release = deferred();
  await page.route(RUNTIME, async route => { entered.resolve(); await release.promise; await route.fallback(); });
  await openHarness(page); const owner = await signInMock(page);
  await startCheckIn(page, owner); await entered.promise;
  expect(await stateFor(page, owner)).toBeNull();
  await signInMock(page, 'bravo.badges@example.test');
  if (roundTrip) expect(await signInMock(page)).toBe(owner);
  release.resolve();
  expect(await finishOperation(page)).toEqual({ ok: false, error: 'The signed-in account changed. Try again.' });
  expect(await stateFor(page, owner)).toBeNull();
});

test('failed compiled import grants nothing and recovers only after explicit reload and retry', async ({ page }) => {
  await page.route(RUNTIME, route => route.fulfill({ status: 503, contentType: 'text/plain', headers: { 'cache-control': 'no-store' }, body: 'PRIVATE_PROVIDER_MESSAGE' }));
  await openHarness(page); const owner = await signInMock(page);
  await startCheckIn(page, owner);
  expect(await finishOperation(page)).toEqual({ ok: false, error: 'Badge history is temporarily unavailable. Reload and try again.' });
  expect(await stateFor(page, owner)).toBeNull();
  expect(await page.evaluate(async () => (await navigator.locks.query()).held)).toEqual([]);
  // Exercise the exact recovery copy, including WebKit's native module map.
  // Reload must not automatically retry or replay the old private operation.
  await page.unroute(RUNTIME);
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(window.__previewBadgeTest))).toBe(true);
  expect(await stateFor(page, owner)).toBeNull();
  await startCheckIn(page, owner);
  expect((await finishOperation(page)).ok).toBe(true);
  expect((await stateFor(page, owner)).checkIns).toHaveLength(1);
});

test('queued browser lock rechecks ownership before reading or writing private state', async ({ page }) => {
  await openHarness(page); const owner = await signInMock(page);
  await page.evaluate(owner => {
    window.badgeLockReady = new Promise(ready => {
      window.badgeLockHolding = navigator.locks.request('dominion:badges:' + owner, () => new Promise(release => {
        window.releaseBadgeLock = release; ready();
      }));
    });
  }, owner);
  await page.evaluate(() => window.badgeLockReady);
  await startCheckIn(page, owner);
  await expect.poll(() => page.evaluate(async () => (await navigator.locks.query()).pending.length)).toBe(1);
  await signInMock(page, 'bravo.badges@example.test');
  await page.evaluate(() => window.releaseBadgeLock());
  expect((await finishOperation(page)).error).toBe('The signed-in account changed. Try again.');
  expect(await stateFor(page, owner)).toBeNull();
});

test('same-actor tabs serialize duplicate events, exclusive claims, wrong-token and repeated acknowledgments', async ({ page, context, traffic }) => {
  await openHarness(page); const owner = await signInMock(page);
  const other = await context.newPage(); await openHarness(other);
  await Promise.all([startCheckIn(page, owner, ['workoutTwo']), startCheckIn(other, owner, ['workoutTwo'])]);
  expect((await finishOperation(page)).ok).toBe(true); expect((await finishOperation(other)).ok).toBe(true);
  const state = await stateFor(page, owner);
  expect(state.checkIns).toHaveLength(1);
  expect(state.awards.map(award => award.key)).toEqual(['faithful_start', 'honest_partial', 'hard_path']);
  const claim = (tab, token) => tab.evaluate(({ owner, token }) => window.__previewBadgeTest.api.claimBadgeCelebrations({ expectedUserId: owner, claimToken: token }), { owner, token });
  const claims = await Promise.all([claim(page, 'one'), claim(other, 'two')]);
  expect(claims.filter(result => result.badges.length)).toHaveLength(1);
  const winner = claims.find(result => result.badges.length); const ids = winner.badges.map(badge => badge.awardId);
  expect(new Set(ids).size).toBe(3);
  const ack = (tab, claimToken) => tab.evaluate(async ({ owner, ids, claimToken }) => {
    try { return { ids: await window.__previewBadgeTest.api.acknowledgeBadgeCelebrations({ expectedUserId: owner, claimToken, awardIds: ids }) }; }
    catch (error) { return { error: error.message }; }
  }, { owner, ids, claimToken });
  expect(await ack(page, 'wrong')).toEqual({ error: 'Badge acknowledgment is still pending.' });
  expect((await stateFor(page, owner)).awards.every(award => !award.celebrationSeenAt)).toBe(true);
  expect(await Promise.all([ack(page, winner.claimToken), ack(other, winner.claimToken)])).toEqual([{ ids }, { ids }]);
  expect((await claim(other, 'later')).badges).toEqual([]);
  expect(traffic.provider).toEqual([]); await other.close();
});

test('late collection import rejects changed owner without writing a badge cache', async ({ page }) => {
  const entered = deferred(); const release = deferred();
  await page.route(RUNTIME, async route => { entered.resolve(); await release.promise; await route.fallback(); });
  await openHarness(page); const owner = await signInMock(page);
  await page.evaluate(owner => {
    window.pendingBadgeOperation = window.__previewBadgeTest.api.getBadgeCollection({ expectedUserId: owner })
      .then(value => ({ ok: true, value }), error => ({ ok: false, error: error.message }));
  }, owner);
  await entered.promise; await signInMock(page, 'bravo.badges@example.test'); release.resolve();
  expect((await finishOperation(page)).error).toBe('The signed-in account changed. Try again.');
  expect(await stateFor(page, owner)).toBeNull();
});

test('compiled Dashboard preserves canonical celebration copy, presentation and acknowledgment', async ({ page }) => {
  const storage = fixtureFor('member', 'dark');
  await page.addInitScript(({ storage, fixedNow }) => {
    if (!sessionStorage.getItem('badge-dashboard-seeded')) {
      for (const [key, value] of Object.entries(storage.json)) localStorage.setItem(key, JSON.stringify(value));
      for (const [key, value] of Object.entries(storage.raw)) if (value != null) localStorage.setItem(key, String(value));
      sessionStorage.setItem('badge-dashboard-seeded', 'true');
    }
    const NativeDate = Date; const now = Date.parse(fixedNow);
    globalThis.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
  }, { storage, fixedNow: FIXED_NOW });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/dashboard.html');
  await page.locator('#selectAllActionsButton').click(); await page.locator('#checkInButton').click();
  await expect(page.locator('#rewardToast')).toBeVisible();
  await page.locator('#rewardToast [data-dismiss-celebration]').click();
  await expect(page.locator('#badgeCelebration')).toBeVisible();
  await expect(page.locator('#badgeCelebrationTitle')).toHaveText('Seven for Seven');
  await expect(page.locator('#badgeCelebrationCopy')).toHaveText('You posted 7 of the seven Daily Actions.');
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(owner => {
    const state = JSON.parse(localStorage.getItem('dominion:previewUserStateByOwner') || '{}');
    return Boolean(state[owner]?.['dominion:badgeState:v1']?.awards?.find(award => award.key === 'iron_standard')?.celebrationSeenAt);
  }, FIXED_USER_ID)).toBe(true);
  await page.reload(); await expect(page.locator('#badgeCelebration')).toBeHidden();
});
