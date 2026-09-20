import { test, expect, expectNoHorizontalOverflow } from './support/app-test.mjs';
import { ROUTE_BY_ID } from './support/routes.mjs';
import { DEFAULT_OWNERSHIP_REWARD_DEFINITIONS } from '../../src/static/reward-catalog.mjs';
import { DEFAULT_CHALLENGE_DEFINITIONS } from '../../src/static/challenge-progression.mjs';
import { analyzeAccessibility, assertNoBlockingAxeViolations } from './support/quality-gates.mjs';
import { FIXED_NOW } from './support/fixtures.mjs';

const themes = ['light', 'dark', 'dominion-night', 'dominion-platinum'];
async function seedRewards(page, app, { unseen = ['dominion_night_theme'], missing = [], theme = 'dark', points = 1200 } = {}) {
  await app.seed('rewardsUnlocked', theme);
  await page.addInitScript(({ ownership, challenges, totalPoints }) => {
    if (sessionStorage.getItem('reward-celebration-fixture')) return;
    sessionStorage.setItem('reward-celebration-fixture', 'true');
    localStorage.setItem('dominion:mockChallengeThresholdsVersion', '4');
    localStorage.setItem('dominion:mockRewardEntitlements', JSON.stringify(ownership));
    localStorage.setItem('dominion:mockChallengeStates', JSON.stringify(challenges));
    const stats = JSON.parse(localStorage.getItem('dominion:gameStats'));
    localStorage.setItem('dominion:gameStats', JSON.stringify({ ...stats, totalPoints, challengePoints: totalPoints, dailyStandardsPoints: totalPoints }));
  }, {
    ownership: DEFAULT_OWNERSHIP_REWARD_DEFINITIONS.filter((item) => !missing.includes(item.key)).map((item) => ({ key: item.key, ownedAt: '2026-02-10T18:00:00Z',
      celebrationSeenAt: unseen.includes(item.key) ? null : '2026-02-10T18:01:00Z',
      celebrationMilestonePoints: item.pointsRequired, celebrationSourceType: 'point_threshold',
    })),
    challenges: DEFAULT_CHALLENGE_DEFINITIONS.map((item) => ({ key: item.key, status: 'available', unlockPoints: item.pointsRequired,
      unlockedAt: '2026-02-10T18:00:00Z', celebrationSeenAt: '2026-02-10T18:01:00Z' })),
    totalPoints: points,
  });
}
const stage = (page) => page.locator('#permanentRewardCelebration');
const ownedRecords = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('dominion:mockRewardEntitlements') || '[]'));

for (const theme of themes) {
  for (const width of [390, 1440]) {
    test(`${theme} at ${width}px: durable reward dialog, touch targets, focus and contrast`, async ({ page, app }) => {
      await page.setViewportSize({ width, height: 844 });
      await seedRewards(page, app, { theme });
      await page.goto(ROUTE_BY_ID.dashboard.path);
      await expect(stage(page)).toBeVisible(); await app.stable();
      if (theme === 'dominion-night' && width === 390) {
        await page.screenshot({ path: test.info().outputPath('reward-celebration-review.png') });
      }
      await expect(stage(page)).toContainText('Reward unlocked');
      await expect(stage(page).getByRole('dialog')).toHaveAccessibleName('Reward unlocked Dominion Night');
      await expect(stage(page)).toContainText('56-point milestone');
      await expect(stage(page).getByRole('link', { name: 'View Reward', exact: true })).toBeFocused();
      await expect(page.locator('main')).toHaveAttribute('inert', '');
      await stage(page).getByRole('heading', { name: 'Dominion Night', exact: true }).click();
      await expect(stage(page)).toBeVisible();
      const sizes = await stage(page).locator('button,a').evaluateAll((nodes) => nodes.map((node) => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })));
      expect(sizes.every((size) => size.width >= 44 && size.height >= 44)).toBe(true);
      await stage(page).getByRole('button', { name: 'Continue' }).focus(); await page.keyboard.press('Tab');
      await expect(stage(page).getByRole('button', { name: 'Close reward celebration' })).toBeFocused();
      assertNoBlockingAxeViolations(await analyzeAccessibility(page));
      await expectNoHorizontalOverflow(page);
      await page.keyboard.press('Escape'); await expect(stage(page)).toHaveCount(0);
      await expect.poll(async () => (await ownedRecords(page)).find((record) => record.key === 'dominion_night_theme').celebrationSeenAt).toBeTruthy();
      await app.stable(); await expect(page.locator('body')).not.toHaveAttribute('data-dialog-open', '');
      await page.reload(); await app.stable(); await expect(stage(page)).toHaveCount(0);
      app.assertNoRuntimeErrors();
    });
  }
}

test('reload before acknowledgement recovers the same unseen reward; backdrop dismisses once', async ({ page, app }) => {
  await seedRewards(page, app); await page.goto(ROUTE_BY_ID.dashboard.path);
  await expect(stage(page)).toBeVisible();
  expect((await ownedRecords(page)).find((item) => item.key === 'dominion_night_theme').celebrationSeenAt).toBeNull();
  await page.reload(); await expect(stage(page)).toBeVisible();
  await stage(page).click({ position: { x: 3, y: 3 } }); await expect(stage(page)).toHaveCount(0);
  await page.reload(); await app.stable(); await expect(stage(page)).toHaveCount(0);
  app.assertNoRuntimeErrors();
});

test('multiple historical rewards consolidate, include all permanent types and do not acknowledge on collection view', async ({ page, app }) => {
  await seedRewards(page, app, { unseen: DEFAULT_OWNERSHIP_REWARD_DEFINITIONS.map((item) => item.key) });
  await page.goto(ROUTE_BY_ID.badgesRewards.path); await app.stable();
  expect((await ownedRecords(page)).every((item) => !item.celebrationSeenAt)).toBe(true);
  await page.goto(ROUTE_BY_ID.dashboard.path); await expect(stage(page)).toBeVisible();
  await expect(stage(page)).toContainText('5 rewards are yours');
  await expect(stage(page).getByRole('link', { name: 'View Rewards', exact: true })).toHaveAttribute('href', './badges-rewards.html#rewards');
  await stage(page).getByRole('button', { name: 'Continue' }).click();
  await expect(stage(page)).toHaveCount(0);
  await expect.poll(async () => (await ownedRecords(page)).every((item) => item.celebrationSeenAt)).toBe(true);
  await page.reload(); await app.stable(); await expect(stage(page)).toHaveCount(0);
});

test('View Reward focuses matching details without activating a theme, redeeming or downloading', async ({ page, app }) => {
  await seedRewards(page, app); await page.goto(ROUTE_BY_ID.dashboard.path); await expect(stage(page)).toBeVisible();
  await stage(page).getByRole('link', { name: 'View Reward', exact: true }).click();
  await expect(page).toHaveURL(/badges-rewards(?:\.html)?\?reward=dominion_night_theme#rewards$/);
  const detail = page.getByRole('dialog', { name: 'Dominion Night', exact: true });
  await expect(detail).toBeVisible(); await expect(page.locator('#rewards-tab')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(detail.getByRole('button', { name: /Claim|Download|Start/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-reward-key="dominion_night_theme"] [data-view-reward]')).toBeFocused();
  app.assertNoRuntimeErrors();
});

test('unknown reward links fail safely without any automatic action', async ({ page, app }) => {
  await seedRewards(page, app, { unseen: [] });
  await page.goto('/badges-rewards.html?reward=does_not_exist#rewards'); await app.stable();
  await expect(page.locator('#rewardDetailDialog')).not.toBeVisible();
  await expect(page.locator('#rewardsList')).toBeVisible(); app.assertNoRuntimeErrors();
});

for (const [query, opensDetail] of [
  ['reward=dominion%5Fnight%5Ftheme', true],
  ['reward=dominion_night_theme&reward=does_not_exist', true],
  ['reward=does_not_exist&reward=dominion_night_theme', false],
  ['reward=%3Cscript%3E&reward=dominion_night_theme', false],
  ['reward=__proto__', false],
  ['reward=constructor', false],
]) {
  test(`reward deep link preserves exact first decoded key: ${query}`, async ({ page, app }) => {
    await seedRewards(page, app, { unseen: [] });
    await page.goto(`/badges-rewards.html?${query}#rewards`); await app.stable();
    const detail = page.getByRole('dialog', { name: 'Dominion Night', exact: true });
    if (opensDetail) {
      await expect(detail).toBeVisible();
      await expect(detail.getByRole('button', { name: /Claim|Download|Start/ })).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-reward-key="dominion_night_theme"] [data-view-reward]')).toBeFocused();
    } else await expect(page.locator('#rewardDetailDialog')).not.toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    app.assertNoRuntimeErrors();
  });
}

for (const reward of DEFAULT_OWNERSHIP_REWARD_DEFINITIONS) {
  test(`${reward.rewardType} ${reward.key}: exact artwork/icon, title, description and no automatic fulfillment`, async ({ page, app }) => {
    await seedRewards(page, app, { unseen: [reward.key] }); await page.goto(ROUTE_BY_ID.dashboard.path);
    await expect(stage(page)).toBeVisible();
    await expect(stage(page).getByRole('heading', { name: reward.title, exact: true })).toBeVisible();
    await expect(stage(page)).toContainText(reward.description);
    await expect(stage(page)).toContainText(`${reward.pointsRequired}-point milestone`);
    await expect(stage(page).locator(`.icon-${reward.icon}`)).toHaveCount(1);
    await expect(stage(page).getByRole('button', { name: /Claim|Download|Start|Select/ })).toHaveCount(0);
    await stage(page).getByRole('button', { name: 'Close reward celebration' }).click();
    await expect(stage(page)).toHaveCount(0); app.assertNoRuntimeErrors();
  });
}

test('offline dismissal is stored, then acknowledged without replay after reconnect', async ({ page, context, app }) => {
  await seedRewards(page, app); await page.goto(ROUTE_BY_ID.dashboard.path); await expect(stage(page)).toBeVisible();
  await context.setOffline(true);
  await stage(page).getByRole('button', { name: 'Continue' }).click(); await expect(stage(page)).toHaveCount(0);
  expect((await ownedRecords(page)).find((item) => item.key === 'dominion_night_theme').celebrationSeenAt).toBeNull();
  await context.setOffline(false);
  await expect.poll(async () => (await ownedRecords(page)).find((item) => item.key === 'dominion_night_theme').celebrationSeenAt).toBeTruthy();
  await expect(stage(page)).toHaveCount(0);
});

test('200% text remains readable and controls remain reachable in a small viewport', async ({ page, app }) => {
  await page.setViewportSize({ width: 320, height: 568 }); await seedRewards(page, app);
  await page.goto(ROUTE_BY_ID.dashboard.path); await expect(stage(page)).toBeVisible();
  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
  const continueButton = stage(page).getByRole('button', { name: 'Continue' });
  await continueButton.scrollIntoViewIfNeeded(); await expect(continueButton).toBeInViewport();
  await expectNoHorizontalOverflow(page); await continueButton.click(); await expect(stage(page)).toHaveCount(0);
});

test('switching accounts clears the active reward without acknowledging another account', async ({ page, app }) => {
  await seedRewards(page, app); await page.goto(ROUTE_BY_ID.dashboard.path); await expect(stage(page)).toBeVisible();
  await page.evaluate(() => {
    const user = { name: 'Other Member', email: 'other.member@example.test', authenticated: true };
    localStorage.setItem('dominion:user', JSON.stringify(user));
    window.dispatchEvent(new StorageEvent('storage', { key: 'dominion:user', newValue: JSON.stringify(user) }));
  });
  await expect(stage(page)).toHaveCount(0);
  expect((await ownedRecords(page)).find((item) => item.key === 'dominion_night_theme').celebrationSeenAt).toBeNull();
});

test('a duplicated tab cannot share an active reward delivery token', async ({ page, context, app }) => {
  await seedRewards(page, app); await page.goto(ROUTE_BY_ID.dashboard.path); await expect(stage(page)).toBeVisible();
  // The mock server clock must match in both documents. A real server already
  // owns its clock; an unseeded popup would otherwise jump past the lease.
  await context.addInitScript((now) => {
    const NativeDate = Date;
    globalThis.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return NativeDate.parse(now); }
    };
  }, FIXED_NOW);
  const popupPromise = page.waitForEvent('popup');
  await page.evaluate(() => window.open('/dashboard.html', '_blank'));
  const second = await popupPromise;
  await second.waitForLoadState('networkidle');
  await expect(stage(second)).toHaveCount(0);
  await expect(stage(page)).toBeVisible();
  await second.close();
});

test('check-in queues day complete, every badge, permanent reward, then a concurrent challenge without overlap', async ({ page, app }) => {
  await seedRewards(page, app, { unseen: [], missing: ['dominion_night_theme'], points: 49 });
  await page.goto(ROUTE_BY_ID.dashboard.path); await app.stable(); await expect(stage(page)).toHaveCount(0);
  await page.evaluate(() => {
    const records = JSON.parse(localStorage.getItem('dominion:mockChallengeStates'));
    records.find((item) => item.key === 'seven_day_reset').celebrationSeenAt = null;
    localStorage.setItem('dominion:mockChallengeStates', JSON.stringify(records));
    const active = () => ['rewardToast','badgeCelebration','permanentRewardCelebration','challengeUnlockCelebration']
      .filter((id) => {
        const node = document.getElementById(id);
        return node && !node.closest('[hidden]') && node.getBoundingClientRect().width > 0 && getComputedStyle(node).visibility !== 'hidden';
      });
    window.__rewardQueueMaxOverlap = 0;
    new MutationObserver(() => { window.__rewardQueueMaxOverlap = Math.max(window.__rewardQueueMaxOverlap, active().length); })
      .observe(document.body, { childList: true, subtree: true, attributes: true });
  });
  await page.locator('#selectAllActionsButton').click(); await page.locator('#checkInButton').click();
  await expect(page.locator('#rewardToast')).toBeVisible();
  await expect(stage(page)).toHaveCount(0); await expect(page.locator('#challengeUnlockCelebration')).not.toBeVisible();
  await page.keyboard.press('Escape');
  let badgeCount = 0;
  const activeKind = () => page.evaluate(() => ['badgeCelebration','permanentRewardCelebration','challengeUnlockCelebration'].find((id) => {
    const node = document.getElementById(id); return node && !node.closest('[hidden]') && node.getBoundingClientRect().width > 0;
  }) || '');
  for (let index = 0; index < 15; index += 1) {
    await expect.poll(activeKind).not.toBe('');
    const kind = await activeKind();
    if (kind !== 'badgeCelebration') { expect(kind).toBe('permanentRewardCelebration'); break; }
    badgeCount += 1; await page.keyboard.press('Escape');
    await expect(page.locator('#badgeCelebration')).not.toBeVisible();
  }
  expect(badgeCount).toBeGreaterThan(0);
  await expect(stage(page)).toContainText('Dominion Night');
  await expect(page.locator('#challengeUnlockCelebration')).not.toBeVisible();
  await stage(page).getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('#challengeUnlockCelebration')).toBeVisible();
  await expect(page.locator('#challengeUnlockCelebration')).toContainText('7-Day Reset');
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.__rewardQueueMaxOverlap)).toBe(1);
  app.assertNoRuntimeErrors();
});

test('a remote owned grant is recovered on a storage/foreground refresh without a local point guess', async ({ page, app }) => {
  await seedRewards(page, app, { unseen: [], missing: ['dominion_night_theme'], points: 0 });
  await page.goto(ROUTE_BY_ID.dashboard.path); await app.stable(); await expect(stage(page)).toHaveCount(0);
  await page.evaluate(() => {
    const key = 'dominion:mockRewardEntitlements';
    const records = JSON.parse(localStorage.getItem(key));
    records.push({ key: 'dominion_night_theme', ownedAt: new Date().toISOString(), celebrationSeenAt: null });
    localStorage.setItem(key, JSON.stringify(records));
    window.dispatchEvent(new StorageEvent('storage', { key }));
  });
  await expect(stage(page)).toContainText('Dominion Night');
  await expect(stage(page).locator('.permanent-reward-celebration__milestone')).toHaveCount(0);
  await stage(page).getByRole('button', { name: 'Continue' }).click(); await expect(stage(page)).toHaveCount(0);
});
