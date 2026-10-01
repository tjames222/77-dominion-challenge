import { test, expect, HARNESS, RUNTIME, DELIVERY_DATABASE, deferred, openHarness, signInMock, activateFixtureChallenge, stateFor, deliveryRowsFor, holdDeliveryStore, releaseDeliveryStore, startCheckIn, finishOperation } from './support/preview-badge-browser-support.mjs';
import { fixtureFor, FIXED_NOW, FIXED_USER_ID } from './support/fixtures.mjs';
import { randomUUID } from 'node:crypto';
import { DEFAULT_OWNERSHIP_REWARD_DEFINITIONS } from '../../src/static/reward-catalog.mjs';

test('compiled public and Security entries do not fetch the optional preview runtime or ship the harness', async ({ page, traffic }) => {
  const optionalRuntime = /\/assets\/(?:badge-preview-state|preview-delivery-ledger)-[^/]+\.js(?:\?.*)?$/;
  const runtime = []; page.on('request', request => { if (optionalRuntime.test(request.url())) runtime.push(request.url()); });
  await page.route(optionalRuntime, route => route.abort());
  for (const route of ['/index.html', '/account-security.html', '/login.html']) {
    await page.goto(route, { waitUntil: 'networkidle' });
    expect(await page.evaluate(() => '__previewBadgeTest' in window)).toBe(false);
  }
  expect(runtime).toEqual([]); expect(traffic.provider).toEqual([]);
});

test('compiled preview commits a check-in, points and badge evidence in one authoritative storage write', async ({ page }) => {
  await openHarness(page); const owner = await signInMock(page);
  const result = await page.evaluate(async ({ owner, fixedNow }) => {
    const { api } = window.__previewBadgeTest; const NativeDate = Date; const at = Date.parse(fixedNow);
    globalThis.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [at])); } static now() { return at; } };
    const key = 'dominion:challengeAggregateV2:' + owner; const original = Storage.prototype.setItem; const writes = [];
    try {
      const bootstrap = await api.getDailyActionBootstrap({ expectedUserId: owner, timeZone: 'UTC' });
      const expectedInstanceId = bootstrap.instanceId;
      await api.mutateDailyStandardDraft({ date: '2026-02-14', actionId: 'walk', completed: true,
        expectedVersion: bootstrap.draft.version, expectedUserId: owner, expectedInstanceId });
      const before = JSON.parse(localStorage.getItem(key));
      Storage.prototype.setItem = function (name, value) {
        if (name === key) writes.push(JSON.parse(value));
        return original.call(this, name, value);
      };
      await api.postCheckIn({ date: '2026-02-14', completed: ['walk'], timeZone: 'UTC' }, { expectedUserId: owner, expectedInstanceId });
      return { before, writes, after: JSON.parse(localStorage.getItem(key)) };
    } finally { Storage.prototype.setItem = original; globalThis.Date = NativeDate; }
  }, { owner, fixedNow: FIXED_NOW });
  expect(result.writes).toHaveLength(1); expect(result.writes[0]).toEqual(result.after);
  expect(result.after.generation).toBe(result.before.generation + 1);
  expect(result.after.runtime.checkIns).toHaveLength(1);
  expect(result.after.runtime.lifetimePoints).toBe(result.before.runtime.lifetimePoints + 1);
  expect(result.after.runtime.trustedDailyStandardPoints).toBe(result.before.runtime.trustedDailyStandardPoints + 1);
  const badgeState = result.after.values['dominion:badgeState:v1'];
  expect(badgeState.checkIns[0].sourceId).toBe(result.after.runtime.checkIns[0].id);
  expect(badgeState.checkIns[0].instanceId).toBe(result.after.runtime.currentInstanceId);
  expect(badgeState.awards.map(award => award.key)).toEqual(['faithful_start', 'honest_partial']);
});

test('compiled preview completes 77 partial submissions, preserves history on repeat and rejects same-date scoring', async ({ page }) => {
  await openHarness(page); const owner = await signInMock(page);
  const result = await page.evaluate(async ({ owner, fixedNow }) => {
    const { api } = window.__previewBadgeTest; const NativeDate = Date;
    let at = Date.parse(fixedNow);
    globalThis.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [at])); } static now() { return at; } };
    const key = 'dominion:challengeAggregateV2:' + owner;
    const read = () => JSON.parse(localStorage.getItem(key));
    const submit = async () => {
      const date = new Date().toISOString().slice(0, 10);
      const bootstrap = await api.getDailyActionBootstrap({ expectedUserId: owner, timeZone: 'UTC' });
      const expectedInstanceId = bootstrap.instanceId;
      await api.mutateDailyStandardDraft({ date, actionId: 'walk', completed: true,
        expectedVersion: bootstrap.draft.version, expectedUserId: owner, expectedInstanceId });
      return api.postCheckIn({ date, completed: ['walk'], timeZone: 'UTC' }, { expectedUserId: owner, expectedInstanceId });
    };
    try {
      for (let index = 0; index < 77; index += 1) { if (index) at += 86400000; await submit(); }
      const completed = read();
      const catalog = await api.getAllRewardCatalog({ expectedUserId: owner });
      const activation = await api.getChallengeActivation({ expectedUserId: owner });
      if (activation?.schemaVersion !== 2 || activation.contractValid !== true || activation.actorId !== owner
        || activation.currentInstance?.id !== catalog.currentInstance?.id || activation.revision !== catalog.revision
        || activation.currentInstance?.status !== 'completed' || activation.reviewRequired
        || activation.timeZone !== catalog.currentInstance?.timeZone
        || activation.timeZone !== activation.currentInstance?.timeZone
        || !/^\d{4}-\d{2}-\d{2}$/.test(activation.serverDate || '')) {
        throw new Error('The preview challenge start context was not verified.');
      }
      const options = { expectedUserId: owner, expectedInstanceId: catalog.currentInstance.id,
        expectedRevision: catalog.revision, startDate: activation.serverDate,
        timeZone: activation.timeZone, requestId: crypto.randomUUID() };
      const first = await api.startChallenge('original_77', options);
      const afterStart = read(); const replay = await api.startChallenge('original_77', options); const afterReplay = read();
      let sameDayError;
      try { await submit(); } catch (error) { sameDayError = error.message; }
      const afterBlocked = read();
      at += 86400000; await submit(); const afterNextDay = read();
      return { completed, repeat: catalog.originalRepeat, first, replay, afterStart, afterReplay, sameDayError, afterBlocked, afterNextDay };
    } finally { globalThis.Date = NativeDate; }
  }, { owner, fixedNow: FIXED_NOW });
  expect(result.completed.runtime.checkIns).toHaveLength(77);
  expect(result.completed.runtime.runs).toHaveLength(1);
  expect(result.completed.runtime.runs[0]).toMatchObject({ status: 'completed', submittedCount: 77, targetCount: 77 });
  expect(result.completed.runtime.completionEvents).toHaveLength(1);
  const finishers = result.completed.values['dominion:badgeState:v1'].awards.filter(award => award.key === 'original_77_completed');
  expect(finishers).toHaveLength(1);
  expect(result.repeat).toMatchObject({ available: true, canStart: true });
  expect(result.replay.replayed).toBe(true); expect(result.replay.instanceId).toBe(result.first.instanceId);
  expect(result.afterStart.runtime).toEqual(result.afterReplay.runtime);
  expect(result.afterReplay.runtime.runs).toHaveLength(2);
  expect(result.afterReplay.runtime.runs[0]).toEqual(result.completed.runtime.runs[0]);
  expect(result.afterReplay.values['dominion:badgeState:v1'].awards).toEqual(result.completed.values['dominion:badgeState:v1'].awards);
  expect(result.sameDayError).toBeTruthy();
  expect(result.afterBlocked.runtime.checkIns).toHaveLength(77);
  expect(result.afterBlocked.runtime.lifetimePoints).toBe(77);
  expect(result.afterNextDay.runtime.checkIns).toHaveLength(78);
  expect(result.afterNextDay.runtime.lifetimePoints).toBe(78);
  expect(result.afterNextDay.runtime.runs[1]).toMatchObject({ status: 'active', submittedCount: 1, targetCount: 77 });
});

test('compiled preview read-only refreshes across tabs never rewrite unchanged aggregate state', async ({ page, context }) => {
  await openHarness(page); const owner = await signInMock(page);
  await startCheckIn(page, owner); expect((await finishOperation(page)).ok).toBe(true);
  const other = await context.newPage(); await openHarness(other);
  const observe = tab => tab.evaluate(owner => {
    const key = 'dominion:challengeAggregateV2:' + owner; const original = Storage.prototype.setItem;
    window.aggregateReadWrites = 0; window.aggregateReadBefore = localStorage.getItem(key);
    Storage.prototype.setItem = function (name, value) {
      if (name === key) window.aggregateReadWrites += 1;
      return original.call(this, name, value);
    };
    window.restoreAggregateReadObserver = () => { Storage.prototype.setItem = original; };
  }, owner);
  await Promise.all([observe(page), observe(other)]);
  const read = tab => tab.evaluate(async owner => {
    const { api } = window.__previewBadgeTest;
    for (let index = 0; index < 3; index += 1) {
      await api.getDashboard(); await api.getBadgeCollection({ expectedUserId: owner });
      await api.getAllRewardCatalog({ expectedUserId: owner });
    }
    return { writes: window.aggregateReadWrites,
      unchanged: localStorage.getItem('dominion:challengeAggregateV2:' + owner) === window.aggregateReadBefore };
  }, owner);
  try { expect(await Promise.all([read(page), read(other)])).toEqual([{ writes: 0, unchanged: true }, { writes: 0, unchanged: true }]); }
  finally { await Promise.all([page.evaluate(() => window.restoreAggregateReadObserver()), other.evaluate(() => window.restoreAggregateReadObserver())]); await other.close(); }
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

test('canonical check-in denies a not-started owner and an active owner without access', async ({ page }) => {
  await openHarness(page);
  const owner = await page.evaluate(subscription => {
    const { api, writePreviewUserValue } = window.__previewBadgeTest;
    const owner = api.saveLocalMockUser({ name: 'Denied Badge Member', email: 'denied.badges@example.test' }).userId;
    writePreviewUserValue(localStorage, owner, 'dominion:mockSubscription', subscription);
    return owner;
  }, fixtureFor('member').json['dominion:mockSubscription']);
  const activation = () => page.evaluate(owner => window.__previewBadgeTest.api.getChallengeActivation({ expectedUserId: owner }), owner);
  expect((await activation()).status).toBe('not_started');
  await startCheckIn(page, owner);
  expect((await finishOperation(page)).ok).toBe(false);
  expect((await stateFor(page, owner))?.checkIns || []).toEqual([]);
  expect((await stateFor(page, owner))?.awards || []).toEqual([]);

  await activateFixtureChallenge(page, owner);
  await page.evaluate(owner => window.__previewBadgeTest.writePreviewUserValue(localStorage, owner, 'dominion:mockSubscription', null), owner);
  const withoutAccess = await activation();
  expect(withoutAccess.status).toBe('active');
  expect(withoutAccess.canMutateDailyStandards).toBe(false);
  await startCheckIn(page, owner);
  expect((await finishOperation(page)).ok).toBe(false);
  expect((await stateFor(page, owner))?.checkIns || []).toEqual([]);
  expect((await stateFor(page, owner))?.awards || []).toEqual([]);
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
  const outcomes = await Promise.all([finishOperation(page), finishOperation(other)]);
  expect(outcomes.filter(result => result.ok)).toHaveLength(1);
  expect(outcomes.filter(result => !result.ok)).toHaveLength(1);
  const state = await stateFor(page, owner);
  expect(state.checkIns).toHaveLength(1);
  expect(state.awards.map(award => award.key)).toEqual(['faithful_start', 'honest_partial', 'hard_path']);
  const claim = (tab, token) => tab.evaluate(({ owner, token }) => window.__previewBadgeTest.api.claimBadgeCelebrations({ expectedUserId: owner, claimToken: token }), { owner, token });
  const claims = await Promise.all([claim(page, 'one'), claim(other, 'two')]);
  expect(claims.filter(result => result.badges.length)).toHaveLength(1);
  const winner = claims.find(result => result.badges.length); const ids = winner.badges.map(badge => badge.awardId);
  expect(new Set(ids).size).toBe(3);
  expect((await deliveryRowsFor(page, owner, 'badge')).map(receipt => receipt.itemId).sort()).toEqual([...ids].sort());
  const ack = (tab, claimToken) => tab.evaluate(async ({ owner, ids, claimToken }) => {
    try { return { ids: await window.__previewBadgeTest.api.acknowledgeBadgeCelebrations({ expectedUserId: owner, claimToken, awardIds: ids }) }; }
    catch (error) { return { error: error.message }; }
  }, { owner, ids, claimToken });
  expect(await ack(page, 'wrong')).toEqual({ error: 'Badge acknowledgment is still pending.' });
  expect((await deliveryRowsFor(page, owner, 'badge')).every(receipt => !receipt.seenAt)).toBe(true);
  expect(await Promise.all([ack(page, winner.claimToken), ack(other, winner.claimToken)])).toEqual([{ ids }, { ids }]);
  expect((await deliveryRowsFor(page, owner, 'badge')).filter(receipt => ids.includes(receipt.itemId)).every(receipt => receipt.seenAt)).toBe(true);
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
  storage.json['dominion:mockRewardEntitlements'] = DEFAULT_OWNERSHIP_REWARD_DEFINITIONS.map(reward => ({
    key: reward.key, ownedAt: '2026-02-10T18:00:00.000Z', celebrationSeenAt: '2026-02-11T18:00:00.000Z',
  }));
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
  await expect.poll(async () => Boolean((await deliveryRowsFor(page, FIXED_USER_ID, 'badge'))
    .find(receipt => receipt.itemId.startsWith('preview:iron_standard:'))?.seenAt)).toBe(true);
  await page.reload(); await expect(page.locator('#badgeCelebration')).toBeHidden();
});

// These cases exercise the real compiled preview API through the existing
// test-only harness. Ownership is seeded explicitly; zero points must not
// erase an earned snapshot or silently manufacture new owned rewards.
const PREVIEW_REWARD = DEFAULT_OWNERSHIP_REWARD_DEFINITIONS.find(item => item.key === 'dominion_night_theme');
const PREVIEW_REWARD_OWNED_AT = '2026-02-10T18:00:00.000Z';
const DELIVERY_UNAVAILABLE = 'Preview delivery is temporarily unavailable. Reload and try again.';
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
async function previewRewardLegacyState(page, owner) {
  return page.evaluate(owner => {
    const aggregate = JSON.parse(localStorage.getItem('dominion:challengeAggregateV2:' + owner) || 'null');
    const peek = key => aggregate && Object.hasOwn(aggregate.values, key) ? aggregate.values[key]
      : window.__previewBadgeTest.peekPreviewUserValue(localStorage, owner, key, null);
    return { ownership: peek('dominion:mockRewardEntitlements'), leases: peek('dominion:rewardCelebrationLeases') };
  }, owner);
}
async function previewRewardState(page, owner) {
  return { ...await previewRewardLegacyState(page, owner), receipts: await deliveryRowsFor(page, owner, 'reward') };
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
  await expect.poll(async () => (await previewRewardLegacyState(other, owner)).ownership?.[0]?.ownedAt).toBe(ownedAt);
  await expect.poll(async () => (await previewRewardLegacyState(other, owner)).leases).toEqual({});
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
  expect((await deliveryRowsFor(page, owner, 'reward')).find(receipt => receipt.itemId === PREVIEW_REWARD.key))
    .toMatchObject({ claimToken: winners[0].claimToken, seenAt: null });
  expect((await previewRewardState(page, owner)).ownership[0].ownedAt).toBe(ownedAt);
  expect(traffic.provider).toEqual([]); await other.close();
});

test('reward preview: wrong-token acknowledgment cannot dismiss and confirmed acknowledgment is idempotent', async ({ page, traffic }) => {
  await openHarness(page); const owner = await signInMock(page);
  const ownedAt = await seedOwnedPreviewReward(page, owner);
  const token = randomUUID(); const claimed = await claimPreviewReward(page, owner, token);
  expect(claimed.claimedUnlocks.map(reward => reward.key)).toEqual([PREVIEW_REWARD.key]);
  expect(await ackPreviewReward(page, owner, randomUUID())).toEqual({ acknowledgedKeys: [] });
  expect((await previewRewardState(page, owner)).ownership[0].ownedAt).toBe(ownedAt);
  expect((await deliveryRowsFor(page, owner, 'reward')).find(receipt => receipt.itemId === PREVIEW_REWARD.key)?.seenAt).toBeNull();
  expect(await ackPreviewReward(page, owner, token)).toEqual({ acknowledgedKeys: [PREVIEW_REWARD.key] });
  const confirmed = await previewRewardState(page, owner);
  expect(confirmed.ownership[0].ownedAt).toBe(ownedAt);
  expect(confirmed.receipts.find(receipt => receipt.itemId === PREVIEW_REWARD.key)?.seenAt).toBeTruthy();
  expect(await page.evaluate(async ({ owner, key }) => (await window.__previewBadgeTest.api.getRewardCatalog({ expectedUserId: owner }))
    .items.find(item => item.key === key)?.celebrationSeenAt, { owner, key: PREVIEW_REWARD.key }))
    .toBe(confirmed.receipts.find(receipt => receipt.itemId === PREVIEW_REWARD.key).seenAt);
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

async function restoreBadgeCandidate(page, owner, state) {
  await page.evaluate(({ owner, state }) => {
    const write = window.__previewBadgeTest.writePreviewUserValue;
    write(localStorage, owner, 'dominion:badgeState:v1', state);
    write(localStorage, owner, 'dominion:badges', state.awards);
    const key = 'dominion:challengeAggregateV2:' + owner;
    const aggregate = JSON.parse(localStorage.getItem(key) || 'null');
    if (aggregate) {
      aggregate.values['dominion:badgeState:v1'] = state;
      aggregate.values['dominion:badges'] = state.awards;
      localStorage.setItem(key, JSON.stringify(aggregate));
    }
  }, { owner, state });
}
async function restoreRewardCandidate(page, owner, state) {
  await page.evaluate(({ owner, state }) => {
    const write = window.__previewBadgeTest.writePreviewUserValue;
    write(localStorage, owner, 'dominion:mockRewardEntitlements', state.ownership);
    write(localStorage, owner, 'dominion:rewardCelebrationLeases', state.leases);
    const key = 'dominion:challengeAggregateV2:' + owner;
    const aggregate = JSON.parse(localStorage.getItem(key) || 'null');
    if (aggregate) {
      aggregate.values['dominion:mockRewardEntitlements'] = state.ownership;
      aggregate.values['dominion:rewardCelebrationLeases'] = state.leases;
      localStorage.setItem(key, JSON.stringify(aggregate));
    }
  }, { owner, state });
}
const claimPreviewBadge = (page, owner, claimToken) => page.evaluate(({ owner, claimToken }) => (
  window.__previewBadgeTest.api.claimBadgeCelebrations({ expectedUserId: owner, claimToken })
), { owner, claimToken });
const acknowledgePreviewBadge = (page, owner, claimToken, awardIds) => page.evaluate(({ owner, claimToken, awardIds }) => (
  window.__previewBadgeTest.api.acknowledgeBadgeCelebrations({ expectedUserId: owner, claimToken, awardIds })
), { owner, claimToken, awardIds });

test('delivery ledger: stale badge candidates cannot replace a lease or replay an acknowledged award after reload', async ({ page, context }) => {
  await openHarness(page); const owner = await signInMock(page);
  await startCheckIn(page, owner); expect((await finishOperation(page)).ok).toBe(true);
  const stale = await stateFor(page, owner);
  const other = await context.newPage(); await openHarness(other);
  const token = randomUUID(); const first = await claimPreviewBadge(page, owner, token);
  expect(first.badges.map(badge => badge.key)).toEqual(['faithful_start', 'honest_partial']);
  const ids = first.badges.map(badge => badge.awardId);
  await restoreBadgeCandidate(other, owner, stale);
  expect((await claimPreviewBadge(other, owner, randomUUID())).badges).toEqual([]);
  expect((await claimPreviewBadge(other, owner, token)).badges.map(badge => badge.awardId)).toEqual(ids);
  await expect(acknowledgePreviewBadge(other, owner, randomUUID(), ids)).rejects.toThrow('Badge acknowledgment is still pending.');
  expect(await acknowledgePreviewBadge(page, owner, token, ids)).toEqual(ids);
  const confirmed = await deliveryRowsFor(page, owner, 'badge');
  expect(confirmed).toHaveLength(ids.length);
  expect(confirmed.every(receipt => receipt.seenAt)).toBe(true);
  await restoreBadgeCandidate(other, owner, stale);
  await page.reload(); await openHarness(other);
  expect((await claimPreviewBadge(other, owner, randomUUID())).badges).toEqual([]);
  expect(await acknowledgePreviewBadge(other, owner, token, ids)).toEqual(ids);
  expect(await deliveryRowsFor(other, owner, 'badge')).toEqual(confirmed);
  const collection = await other.evaluate(owner => window.__previewBadgeTest.api.getBadgeCollection({ expectedUserId: owner }), owner);
  expect(collection.earnedBadges.map(badge => badge.awardId).sort()).toEqual([...ids].sort());
  await other.close();
});

test('delivery ledger: stale reward catalogs cannot replace a lease or resurrect seen state after reload', async ({ page, context }) => {
  await openHarness(page); const owner = await signInMock(page); await seedOwnedPreviewReward(page, owner);
  const stale = await previewRewardLegacyState(page, owner);
  const other = await context.newPage(); await openHarness(other);
  const token = randomUUID();
  expect((await claimPreviewReward(page, owner, token)).claimedUnlocks.map(item => item.key)).toEqual([PREVIEW_REWARD.key]);
  await restoreRewardCandidate(other, owner, stale);
  expect((await claimPreviewReward(other, owner, randomUUID())).claimedUnlocks).toEqual([]);
  expect((await claimPreviewReward(other, owner, token)).claimedUnlocks.map(item => item.key)).toEqual([PREVIEW_REWARD.key]);
  expect(await ackPreviewReward(other, owner, token)).toEqual({ acknowledgedKeys: [PREVIEW_REWARD.key] });
  const confirmed = await deliveryRowsFor(page, owner, 'reward');
  await restoreRewardCandidate(page, owner, stale);
  await page.reload(); await openHarness(other);
  const catalog = await other.evaluate(owner => window.__previewBadgeTest.api.getRewardCatalog({ expectedUserId: owner }), owner);
  expect(catalog.items.find(item => item.key === PREVIEW_REWARD.key)).toMatchObject({
    ownedAt: PREVIEW_REWARD_OWNED_AT, celebrationSeenAt: confirmed[0].seenAt,
  });
  expect((await claimPreviewReward(other, owner, randomUUID())).claimedUnlocks).toEqual([]);
  expect(await ackPreviewReward(page, owner, token)).toEqual({ acknowledgedKeys: [PREVIEW_REWARD.key] });
  expect(await deliveryRowsFor(other, owner, 'reward')).toEqual(confirmed);
  await other.close();
});

test('delivery ledger: reward acknowledgment racing a different-token claim remains exclusive', async ({ page, context }) => {
  await openHarness(page); const owner = await signInMock(page); await seedOwnedPreviewReward(page, owner);
  const other = await context.newPage(); await openHarness(other);
  const token = randomUUID(); await claimPreviewReward(page, owner, token);
  const [acknowledged, competing] = await Promise.all([
    ackPreviewReward(page, owner, token), claimPreviewReward(other, owner, randomUUID()),
  ]);
  expect(acknowledged).toEqual({ acknowledgedKeys: [PREVIEW_REWARD.key] });
  expect(competing.claimedUnlocks).toEqual([]);
  const receipt = (await deliveryRowsFor(other, owner, 'reward')).find(row => row.itemId === PREVIEW_REWARD.key);
  expect(receipt.seenAt).toBeTruthy();
  expect((await claimPreviewReward(other, owner, randomUUID())).claimedUnlocks).toEqual([]);
  await other.close();
});

test('delivery ledger: initialized empty delivery fields ignore later stale legacy receipts and arbitrary acknowledgment keys', async ({ page }) => {
  await openHarness(page); const owner = await signInMock(page); await seedOwnedPreviewReward(page, owner);
  await page.evaluate(owner => window.__previewBadgeTest.api.getRewardCatalog({ expectedUserId: owner }), owner);
  const empty = await deliveryRowsFor(page, owner, 'reward');
  expect(empty).toHaveLength(1);
  expect(empty[0]).toMatchObject({ itemId: PREVIEW_REWARD.key, seenAt: null, claimToken: null, leaseUntil: null });
  const stale = await previewRewardLegacyState(page, owner);
  stale.ownership[0].celebrationSeenAt = '2026-02-11T18:00:00.000Z';
  stale.leases = { [PREVIEW_REWARD.key]: { claimToken: randomUUID(), leaseUntil: Date.now() + 900_000 } };
  await restoreRewardCandidate(page, owner, stale);
  const token = randomUUID();
  expect(await page.evaluate(({ owner, token }) => window.__previewBadgeTest.api.acknowledgeRewardCelebrations({
    expectedUserId: owner, claimToken: token, rewardKeys: ['unearned_unknown_reward'],
  }), { owner, token })).toEqual({ acknowledgedKeys: [] });
  expect(await deliveryRowsFor(page, owner, 'reward')).toEqual(empty);
  expect((await claimPreviewReward(page, owner, token)).claimedUnlocks.map(item => item.key)).toEqual([PREVIEW_REWARD.key]);
});

test('delivery ledger: legitimate already-seen reward and legacy badge sentinel never replay', async ({ page }) => {
  await openHarness(page); const owner = await signInMock(page); await seedOwnedPreviewReward(page, owner);
  const legacy = await previewRewardLegacyState(page, owner);
  legacy.ownership[0].celebrationSeenAt = '2026-02-11T18:00:00.000Z';
  await restoreRewardCandidate(page, owner, legacy);
  await page.evaluate(owner => window.__previewBadgeTest.writePreviewUserValue(localStorage, owner, 'dominion:badges', [
    { key: 'faithful_start', name: 'Legacy award', scopeKey: 'lifetime' },
  ]), owner);
  expect((await claimPreviewReward(page, owner, randomUUID())).claimedUnlocks).toEqual([]);
  expect((await claimPreviewBadge(page, owner, randomUUID())).badges).toEqual([]);
  expect((await deliveryRowsFor(page, owner, 'reward'))[0].seenAt).toBe(legacy.ownership[0].celebrationSeenAt);
  const badges = await deliveryRowsFor(page, owner, 'badge');
  expect(badges).toHaveLength(1); expect(badges[0].seenAt).toBe('legacy');
  legacy.ownership[0].celebrationSeenAt = null; await restoreRewardCandidate(page, owner, legacy);
  expect((await claimPreviewReward(page, owner, randomUUID())).claimedUnlocks).toEqual([]);
});

test('delivery ledger: compatibility unlock selection honors canonical seen before stale catalog fields', async ({ page }) => {
  await openHarness(page); const owner = await signInMock(page); await seedOwnedPreviewReward(page, owner);
  const stale = await previewRewardLegacyState(page, owner);
  const token = randomUUID(); await claimPreviewReward(page, owner, token); await ackPreviewReward(page, owner, token);
  const confirmed = await deliveryRowsFor(page, owner, 'reward');
  await restoreRewardCandidate(page, owner, stale);
  const result = await page.evaluate(owner => window.__previewBadgeTest.api.claimRewardEntitlementUnlocks({ expectedUserId: owner }), owner);
  expect(result.claimedUnlocks).toEqual([]);
  expect(result.catalog.items.find(item => item.key === PREVIEW_REWARD.key)?.celebrationSeenAt).toBe(confirmed[0].seenAt);
  expect(await deliveryRowsFor(page, owner, 'reward')).toEqual(confirmed);
});

test('delivery ledger: known seen retries survive omitted legacy sources without creating arbitrary receipts or ownership', async ({ page }) => {
  await openHarness(page); const owner = await signInMock(page); await seedOwnedPreviewReward(page, owner);
  await startCheckIn(page, owner); expect((await finishOperation(page)).ok).toBe(true);
  const badgeToken = randomUUID(); const rewardToken = randomUUID();
  const badgeClaim = await claimPreviewBadge(page, owner, badgeToken);
  const ids = badgeClaim.badges.map(badge => badge.awardId);
  expect(ids.length).toBeGreaterThan(0);
  await acknowledgePreviewBadge(page, owner, badgeToken, ids);
  await claimPreviewReward(page, owner, rewardToken); await ackPreviewReward(page, owner, rewardToken);
  const confirmed = await deliveryRowsFor(page, owner);
  await restoreBadgeCandidate(page, owner, { schemaVersion: 1, awards: [], checkIns: [], visits: [] });
  await restoreRewardCandidate(page, owner, { ownership: [], leases: {} });
  expect(await acknowledgePreviewBadge(page, owner, badgeToken, ids)).toEqual(ids);
  expect(await ackPreviewReward(page, owner, rewardToken)).toEqual({ acknowledgedKeys: [PREVIEW_REWARD.key] });
  await expect(acknowledgePreviewBadge(page, owner, badgeToken, ['not-an-earned-award'])).rejects.toThrow('Badge acknowledgment is still pending.');
  expect(await page.evaluate(({ owner, token }) => window.__previewBadgeTest.api.acknowledgeRewardCelebrations({
    expectedUserId: owner, claimToken: token, rewardKeys: ['not_an_owned_reward'],
  }), { owner, token: rewardToken })).toEqual({ acknowledgedKeys: [] });
  expect(await deliveryRowsFor(page, owner)).toEqual(confirmed);
  expect(await page.evaluate(owner => window.__previewBadgeTest.api.getEarnedBadges({ expectedUserId: owner }), owner)).toEqual([]);
  const catalog = await page.evaluate(owner => window.__previewBadgeTest.api.getRewardCatalog({ expectedUserId: owner }), owner);
  // Omitting the mutable candidate cannot erase the separately preserved
  // typed historical grant. Its receipt still cannot mint unrelated ownership.
  expect(catalog.items.find(item => item.key === PREVIEW_REWARD.key)).toMatchObject({
    status: 'owned', ownedAt: PREVIEW_REWARD_OWNED_AT,
    grantProvenance: { type: 'legacy_preserved', catalogVersion: 1 },
  });
  expect((await claimPreviewBadge(page, owner, randomUUID())).badges).toEqual([]);
  expect((await claimPreviewReward(page, owner, randomUUID())).claimedUnlocks).toEqual([]);
  expect(await deliveryRowsFor(page, owner)).toEqual(confirmed);
});

test('delivery ledger: an unknown seen legacy ownership record is not an admissible acknowledgment receipt', async ({ page }) => {
  await openHarness(page); const owner = await signInMock(page); await seedOwnedPreviewReward(page, owner);
  const legacy = await previewRewardLegacyState(page, owner);
  const omittedKey = 'unknown_omitted_catalog_reward';
  legacy.ownership.push({ key: omittedKey, ownedAt: PREVIEW_REWARD_OWNED_AT, celebrationSeenAt: '2026-02-11T18:00:00.000Z' });
  await restoreRewardCandidate(page, owner, legacy);
  const result = await page.evaluate(({ owner, token, omittedKey }) => window.__previewBadgeTest.api.acknowledgeRewardCelebrations({
    expectedUserId: owner, claimToken: token, rewardKeys: [omittedKey],
  }), { owner, token: randomUUID(), omittedKey });
  expect(result).toEqual({ acknowledgedKeys: [] });
  expect((await deliveryRowsFor(page, owner, 'reward')).map(row => row.itemId)).toEqual([PREVIEW_REWARD.key]);
  const catalog = await page.evaluate(owner => window.__previewBadgeTest.api.getRewardCatalog({ expectedUserId: owner }), owner);
  expect(catalog.items.some(item => item.key === omittedKey)).toBe(false);
});

test('delivery ledger: initialized empty badge receipts override later legacy seen and lease fields', async ({ page }) => {
  await openHarness(page); const owner = await signInMock(page);
  await startCheckIn(page, owner); expect((await finishOperation(page)).ok).toBe(true);
  const candidate = await stateFor(page, owner);
  await expect(acknowledgePreviewBadge(page, owner, 'never-claimed', candidate.awards.map(award => award.awardId)))
    .rejects.toThrow('Badge acknowledgment is still pending.');
  const empty = await deliveryRowsFor(page, owner, 'badge');
  expect(empty).toHaveLength(candidate.awards.length);
  expect(empty.every(row => row.seenAt === null && row.claimToken === null && row.leaseUntil === null)).toBe(true);
  for (const award of candidate.awards) {
    award.celebrationSeenAt = '2026-02-15T18:00:00.000Z';
    award.celebrationClaimToken = 'stale-legacy-token';
    award.celebrationClaimUntil = new Date(Date.now() + 900_000).toISOString();
  }
  await restoreBadgeCandidate(page, owner, candidate);
  const token = randomUUID(); const claimed = await claimPreviewBadge(page, owner, token);
  expect(claimed.badges.map(badge => badge.awardId).sort()).toEqual(candidate.awards.map(badge => badge.awardId).sort());
  expect((await deliveryRowsFor(page, owner, 'badge')).every(row => row.claimToken === token && row.seenAt === null)).toBe(true);
});

test('delivery ledger: two native first imports preserve one legitimate seen reward receipt', async ({ page, context }) => {
  await openHarness(page); const owner = await signInMock(page); await seedOwnedPreviewReward(page, owner);
  const seed = await previewRewardLegacyState(page, owner);
  seed.ownership[0].celebrationSeenAt = '2026-02-11T18:00:00.000Z';
  await restoreRewardCandidate(page, owner, seed);
  const other = await context.newPage(); await openHarness(other);
  const read = tab => tab.evaluate(owner => window.__previewBadgeTest.api.getRewardCatalog({ expectedUserId: owner }), owner);
  const catalogs = await Promise.all([read(page), read(other)]);
  for (const catalog of catalogs) expect(catalog.items.find(item => item.key === PREVIEW_REWARD.key)?.celebrationSeenAt)
    .toBe(seed.ownership[0].celebrationSeenAt);
  const receipts = await deliveryRowsFor(other, owner, 'reward');
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({ itemId: PREVIEW_REWARD.key, seenAt: seed.ownership[0].celebrationSeenAt, claimToken: null, leaseUntil: null });
  expect((await claimPreviewReward(other, owner, randomUUID())).claimedUnlocks).toEqual([]);
  await other.close();
});

test('delivery ledger: native transaction abort rolls back claim receipts and permits an explicit retry', async ({ page }) => {
  await openHarness(page); const owner = await signInMock(page); await seedOwnedPreviewReward(page, owner);
  await page.evaluate(owner => window.__previewBadgeTest.api.getRewardCatalog({ expectedUserId: owner }), owner);
  const before = await deliveryRowsFor(page, owner, 'reward');
  const token = randomUUID();
  const result = await page.evaluate(async ({ owner, token }) => {
    const original = IDBObjectStore.prototype.put; let aborted = 0;
    IDBObjectStore.prototype.put = function (...args) {
      const request = original.apply(this, args);
      if (this.name === 'deliveries' && args[0]?.kind === 'reward' && args[0]?.claimToken === token) {
        aborted += 1; this.transaction.abort();
      }
      return request;
    };
    try {
      const value = await window.__previewBadgeTest.api.claimRewardCelebrations({ expectedUserId: owner, claimToken: token });
      return { value, aborted };
    } catch (error) { return { error: error.message, aborted }; }
    finally { IDBObjectStore.prototype.put = original; }
  }, { owner, token });
  expect(result.aborted).toBe(1); expect(result.value).toBeUndefined();
  expect(result.error).toBe(DELIVERY_UNAVAILABLE);
  expect(await deliveryRowsFor(page, owner, 'reward')).toEqual(before);
  expect((await claimPreviewReward(page, owner, token)).claimedUnlocks.map(item => item.key)).toEqual([PREVIEW_REWARD.key]);
});

test('delivery ledger: denied native open cannot fall back to localStorage delivery', async ({ page }) => {
  await openHarness(page); const owner = await signInMock(page); await seedOwnedPreviewReward(page, owner);
  await startCheckIn(page, owner); expect((await finishOperation(page)).ok).toBe(true);
  const expectedAwardIds = (await stateFor(page, owner)).awards.map(award => award.awardId).sort();
  const before = await previewRewardLegacyState(page, owner);
  const result = await page.evaluate(async ({ owner, database, token }) => {
    const original = IDBFactory.prototype.open; let denied = 0;
    IDBFactory.prototype.open = function (...args) {
      if (args[0] === database) { denied += 1; throw new DOMException('SYNTHETIC_STORAGE_DENIED', 'SecurityError'); }
      return original.apply(this, args);
    };
    try {
      const api = window.__previewBadgeTest.api;
      const capture = promise => promise.then(value => ({ value }), error => ({ error: error.message }));
      const reward = await capture(api.claimRewardCelebrations({ expectedUserId: owner, claimToken: token }));
      const badge = await capture(api.claimBadgeCelebrations({ expectedUserId: owner, claimToken: token }));
      const earned = await api.getEarnedBadges({ expectedUserId: owner });
      const collection = await api.getBadgeCollection({ expectedUserId: owner });
      return { reward, badge, denied, earnedIds: earned.map(item => item.awardId).sort(),
        collectionIds: collection.earnedBadges.map(item => item.awardId).sort() };
    }
    finally { IDBFactory.prototype.open = original; }
  }, { owner, database: DELIVERY_DATABASE, token: randomUUID() });
  expect(result.denied).toBe(2);
  expect(result.reward).toEqual({ error: DELIVERY_UNAVAILABLE });
  expect(result.badge).toEqual({ error: DELIVERY_UNAVAILABLE });
  expect(result.earnedIds).toEqual(expectedAwardIds); expect(result.collectionIds).toEqual(expectedAwardIds);
  expect(await previewRewardLegacyState(page, owner)).toEqual(before);
  expect(await deliveryRowsFor(page, owner, 'reward')).toEqual([]);
});

test('delivery ledger: an existing wrong-keyPath database fails closed without reset or successful claims', async ({ page }) => {
  await openHarness(page); const owner = await signInMock(page); await seedOwnedPreviewReward(page, owner);
  const sentinel = { itemId: 'synthetic-schema-sentinel', retained: true };
  await page.evaluate(({ database, sentinel }) => new Promise((resolve, reject) => {
    const request = indexedDB.open(database, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('deliveries', { keyPath: 'itemId' }).add(sentinel);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => { request.result.close(); resolve(); };
  }), { database: DELIVERY_DATABASE, sentinel });
  const result = await page.evaluate(async ({ owner, token }) => {
    try { return { value: await window.__previewBadgeTest.api.claimRewardCelebrations({ expectedUserId: owner, claimToken: token }) }; }
    catch (error) { return { error: error.message }; }
  }, { owner, token: randomUUID() });
  expect(result.value).toBeUndefined(); expect(result.error).toBe(DELIVERY_UNAVAILABLE);
  const retained = await page.evaluate(database => new Promise((resolve, reject) => {
    const request = indexedDB.open(database, 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result; const transaction = db.transaction('deliveries', 'readonly');
      const store = transaction.objectStore('deliveries'); const read = store.getAll();
      const shape = { keyPath: store.keyPath, autoIncrement: store.autoIncrement, version: db.version };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
      transaction.oncomplete = () => { db.close(); resolve({ ...shape, rows: read.result }); };
    };
  }), DELIVERY_DATABASE);
  expect(retained).toEqual({ keyPath: 'itemId', autoIncrement: false, version: 1, rows: [sentinel] });
});

test('delivery ledger: an account switch while the native transaction queues cannot write a claim', async ({ page }) => {
  await openHarness(page); const owner = await signInMock(page); await seedOwnedPreviewReward(page, owner);
  await page.evaluate(owner => window.__previewBadgeTest.api.getRewardCatalog({ expectedUserId: owner }), owner);
  const before = await deliveryRowsFor(page, owner, 'reward');
  await holdDeliveryStore(page);
  try {
    await page.evaluate(({ owner, token }) => {
      window.pendingDeliveryOperation = window.__previewBadgeTest.api.claimRewardCelebrations({ expectedUserId: owner, claimToken: token })
        .then(value => ({ value }), error => ({ error: error.message }));
    }, { owner, token: randomUUID() });
    await expect.poll(() => page.evaluate(() => window.queuedDeliveryTransactions)).toBe(1);
    await signInMock(page, 'other.queued-delivery@example.test');
  } finally { await releaseDeliveryStore(page); }
  expect(await page.evaluate(() => window.pendingDeliveryOperation)).toEqual({ error: 'The signed-in account changed. Try again.' });
  expect(await deliveryRowsFor(page, owner, 'reward')).toEqual(before);
});
