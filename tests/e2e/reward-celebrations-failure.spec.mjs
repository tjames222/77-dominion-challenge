import { test, expect } from './support/app-test.mjs';
import { injectApiFunctionFailure } from './support/network-states.mjs';
import { DEFAULT_OWNERSHIP_REWARD_DEFINITIONS } from '../../src/static/reward-catalog.mjs';
import { FIXED_USER_ID } from './support/fixtures.mjs';

// Source-level failure injection is intentionally separate from the compiled
// bundle matrix, which exercises only shipped routes and persisted fixtures.
test('a failed permanent reward lookup cannot block day, badge or challenge celebrations', async ({ page, app }) => {
  await injectApiFunctionFailure(page, 'claimRewardCelebrations', 'Simulated reward service outage');
  await app.seed('rewardsUnlocked');
  await page.addInitScript((owned) => {
    localStorage.setItem('dominion:mockRewardEntitlements', JSON.stringify(owned));
    localStorage.setItem('dominion:mockChallengeThresholdsVersion', '4');
    const stats = JSON.parse(localStorage.getItem('dominion:gameStats') || '{}');
    localStorage.setItem('dominion:gameStats', JSON.stringify({ ...stats, totalPoints: 105, challengePoints: 105, dailyStandardsPoints: 105 }));
    localStorage.setItem('dominion:mockChallengeStates', JSON.stringify([{ key: 'seven_day_reset', status: 'available', unlockedAt: '2026-02-01T00:00:00.000Z', celebrationSeenAt: '2026-02-01T00:00:00.000Z' }]));
  }, DEFAULT_OWNERSHIP_REWARD_DEFINITIONS.filter((item) => item.key !== 'dominion_night_theme').map((item) => ({ key: item.key, ownedAt: '2026-02-01T00:00:00.000Z', celebrationSeenAt: '2026-02-01T00:00:00.000Z' })));
  await page.goto('/dashboard.html'); await app.stable();
  // Stage the concurrent unlock after boot recovery, not while it can consume
  // the newly unseen fixture before the Check-In starts.
  await expect(page.locator('.dashboard-brand-panel')).toHaveClass(/\b(?:pending-reveal|is-visible)\b/);
  await page.evaluate(owner => {
    const key = 'dominion:challengeAggregateV2:' + owner;
    const aggregate = JSON.parse(localStorage.getItem(key));
    if (aggregate?.schemaVersion !== 2 || aggregate.actorId !== owner) throw new Error('Expected owner-bound V2 reward fixture.');
    const rows = aggregate.values['dominion:mockChallengeStates'];
    rows[0].celebrationSeenAt = null;
    aggregate.generation += 1;
    aggregate.updatedAt = new Date().toISOString();
    localStorage.setItem(key, JSON.stringify(aggregate));
  }, FIXED_USER_ID);
  await page.locator('#selectAllActionsButton').click(); await page.locator('#checkInButton').click();
  await expect(page.locator('#rewardToast')).toBeVisible(); await page.keyboard.press('Escape');
  const active = () => page.evaluate(() => ['badgeCelebration', 'challengeUnlockCelebration'].find((id) => {
    const node = document.getElementById(id); return node && !node.closest('[hidden]') && node.getBoundingClientRect().width > 0;
  }) || '');
  let badges = 0;
  for (let index = 0; index < 15; index += 1) {
    await expect.poll(active).not.toBe('');
    if (await active() === 'challengeUnlockCelebration') break;
    badges += 1; await page.keyboard.press('Escape'); await expect(page.locator('#badgeCelebration')).not.toBeVisible();
  }
  expect(badges).toBeGreaterThan(0);
  await expect(page.locator('#challengeUnlockCelebration')).toBeVisible();
  await expect(page.locator('#permanentRewardCelebration')).toHaveCount(0);
  await expect(page.locator('#checkInStatus')).not.toContainText('Unable to');
  app.assertNoRuntimeErrors();
});
