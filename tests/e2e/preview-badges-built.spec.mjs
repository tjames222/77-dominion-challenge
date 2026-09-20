import { test, expect, HARNESS, RUNTIME, deferred, openHarness, signInMock, stateFor, startCheckIn, finishOperation } from './support/preview-badge-browser-support.mjs';
import { fixtureFor, FIXED_NOW, FIXED_USER_ID } from './support/fixtures.mjs';
import { randomUUID } from 'node:crypto';
import { DEFAULT_OWNERSHIP_REWARD_DEFINITIONS } from '../../src/static/reward-catalog.mjs';

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

// These cases exercise the real compiled preview API through the existing
// test-only harness. Ownership is seeded explicitly; zero points must not
// erase an earned snapshot or silently manufacture new owned rewards.
const PREVIEW_REWARD = DEFAULT_OWNERSHIP_REWARD_DEFINITIONS.find(item => item.key === 'dominion_night_theme');
const PREVIEW_REWARD_OWNED_AT = '2026-02-10T18:00:00.000Z';
async function seedOwnedPreviewReward(page, owner) {
  const ownedAt = PREVIEW_REWARD_OWNED_AT;
  await page.evaluate(({ owner, reward, ownedAt }) => {
    const write = (key, value) => window.__previewBadgeTest.writePreviewUserValue(localStorage, owner, key, value);
    write('dominion:gameStats', { totalPoints: 0, challengePoints: 0, dailyStandardsPoints: 0 });
    write('dominion:mockSharingReward', null);
    write('dominion:mockChallengeThresholdsVersion', 4);
    write('dominion:mockChallengeStates', []);
    write('dominion:mockRewardEntitlements', [{ key: reward.key, ownedAt, celebrationSeenAt: null,
      celebrationSourceType: 'point_threshold', celebrationMilestonePoints: reward.pointsRequired }]);
    write('dominion:rewardCelebrationLeases', {});
  }, { owner, reward: PREVIEW_REWARD, ownedAt });
  return ownedAt;
}
async function previewRewardState(page, owner) {
  return page.evaluate(owner => {
    const peek = key => window.__previewBadgeTest.peekPreviewUserValue(localStorage, owner, key, null);
    return { ownership: peek('dominion:mockRewardEntitlements'), leases: peek('dominion:rewardCelebrationLeases') };
  }, owner);
}
async function claimPreviewReward(page, owner, claimToken, startAt = 0) {
  return page.evaluate(async ({ owner, claimToken, startAt }) => {
    if (startAt > Date.now()) await new Promise(resolve => setTimeout(resolve, startAt - Date.now()));
    return window.__previewBadgeTest.api.claimRewardCelebrations({ expectedUserId: owner, claimToken });
  }, { owner, claimToken, startAt });
}
async function ackPreviewReward(page, owner, claimToken) {
  return page.evaluate(({ owner, claimToken, key }) => window.__previewBadgeTest.api.acknowledgeRewardCelebrations({
    expectedUserId: owner, claimToken, rewardKeys: [key],
  }), { owner, claimToken, key: PREVIEW_REWARD.key });
}

test('reward preview: same-actor tabs exclusively claim an owned unseen reward with distinct UUID tokens', async ({ page, context, traffic }) => {
  await openHarness(page); const owner = await signInMock(page);
  const other = await context.newPage(); await openHarness(other);
  // Native scheduling and real storage, not a substituted claim/reducer or
  // synthetic stale getItem response. Each Playwright repeat has a fresh
  // context: never reset an already-claimed canonical store between rounds.
  // A passing run is coverage evidence, not a proof of cross-process atomicity.
  const ownedAt = await seedOwnedPreviewReward(page, owner);
  await expect.poll(async () => (await previewRewardState(other, owner)).ownership?.[0]?.ownedAt).toBe(ownedAt);
  await expect.poll(async () => (await previewRewardState(other, owner)).leases).toEqual({});
  const tokens = [randomUUID(), randomUUID()];
  const startAt = Date.now() + 100;
  const claims = await Promise.all([
    claimPreviewReward(page, owner, tokens[0], startAt),
    claimPreviewReward(other, owner, tokens[1], startAt),
  ]);
  const winners = claims.filter(result => result.claimedUnlocks.length);
  if (winners.length !== 1) {
    await test.info().attach('reward-claim-race.json', { contentType: 'application/json', body: JSON.stringify({
      tokens, claims, state: [await previewRewardState(page, owner), await previewRewardState(other, owner)],
    }, null, 2) });
  }
  expect(winners, 'exactly one claim holder').toHaveLength(1);
  expect(winners[0].claimedUnlocks.map(reward => reward.key)).toEqual([PREVIEW_REWARD.key]);
  expect(winners[0].claimedUnlocks[0].ownedAt).toBe(ownedAt);
  expect(winners[0].claimedUnlocks[0].celebrationSeenAt).toBeNull();
  expect((await previewRewardState(page, owner)).ownership[0].ownedAt).toBe(ownedAt);
  expect(traffic.provider).toEqual([]); await other.close();
});

test('reward preview: wrong-token acknowledgment cannot dismiss and confirmed acknowledgment is idempotent', async ({ page, traffic }) => {
  await openHarness(page); const owner = await signInMock(page);
  const ownedAt = await seedOwnedPreviewReward(page, owner);
  const token = randomUUID(); const claimed = await claimPreviewReward(page, owner, token);
  expect(claimed.claimedUnlocks.map(reward => reward.key)).toEqual([PREVIEW_REWARD.key]);
  expect(await ackPreviewReward(page, owner, randomUUID())).toEqual({ acknowledgedKeys: [] });
  expect((await previewRewardState(page, owner)).ownership[0]).toMatchObject({ ownedAt, celebrationSeenAt: null });
  expect(await ackPreviewReward(page, owner, token)).toEqual({ acknowledgedKeys: [PREVIEW_REWARD.key] });
  const confirmed = await previewRewardState(page, owner);
  expect(confirmed.ownership[0].ownedAt).toBe(ownedAt);
  expect(confirmed.ownership[0].celebrationSeenAt).toBeTruthy();
  expect(await ackPreviewReward(page, owner, token)).toEqual({ acknowledgedKeys: [PREVIEW_REWARD.key] });
  expect(await previewRewardState(page, owner)).toEqual(confirmed);
  expect((await claimPreviewReward(page, owner, randomUUID())).claimedUnlocks).toEqual([]);
  expect(traffic.provider).toEqual([]);
});

for (const operation of ['claim', 'acknowledge']) test(`reward preview: a pending ${operation} rejects an account switch without mutating the original ownership`, async ({ page, traffic }) => {
  await openHarness(page); const owner = await signInMock(page);
  await seedOwnedPreviewReward(page, owner);
  const token = randomUUID();
  if (operation === 'acknowledge') await claimPreviewReward(page, owner, token);
  const before = await previewRewardState(page, owner);
  const result = await page.evaluate(async ({ owner, token, operation, key }) => {
    const api = window.__previewBadgeTest.api;
    const pending = operation === 'claim'
      ? api.claimRewardCelebrations({ expectedUserId: owner, claimToken: token })
      : api.acknowledgeRewardCelebrations({ expectedUserId: owner, claimToken: token, rewardKeys: [key] });
    // Preserve the real first-await ordering. This changes the actor before
    // canonical preview ownership is read, without mocking the operation.
    const nextOwner = api.saveLocalMockUser({ name: 'Other Preview Member', email: 'bravo.rewards@example.test' }).userId;
    try { return { nextOwner, value: await pending }; }
    catch (error) { return { nextOwner, error: error.message }; }
  }, { owner, token, operation, key: PREVIEW_REWARD.key });
  expect(result.nextOwner).not.toBe(owner);
  expect(result.error).toBe('The signed-in account changed. Try again.');
  expect(await previewRewardState(page, owner)).toEqual(before);
  expect((await claimPreviewReward(page, result.nextOwner, randomUUID())).claimedUnlocks).toEqual([]);
  expect(await previewRewardState(page, owner)).toEqual(before);
  expect(traffic.provider).toEqual([]);
});
