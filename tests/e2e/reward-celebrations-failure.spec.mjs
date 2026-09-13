import { test, expect } from './support/app-test.mjs';
import { injectApiFunctionFailure } from './support/network-states.mjs';
import { DEFAULT_OWNERSHIP_REWARD_DEFINITIONS } from '../../src/static/reward-catalog.mjs';

// Source-level failure injection is intentionally separate from the compiled
// bundle matrix, which exercises only shipped routes and persisted fixtures.
test('a failed permanent reward lookup cannot block day, badge or challenge celebrations', async ({ page, app }) => {
  await injectApiFunctionFailure(page, 'claimRewardCelebrations', 'Simulated reward service outage');
  await app.seed('rewardsUnlocked');
  await page.addInitScript((owned) => {
    localStorage.setItem('dominion:mockRewardEntitlements', JSON.stringify(owned));
    localStorage.setItem('dominion:mockChallengeThresholdsVersion', '4');
    localStorage.setItem('dominion:gameStats', JSON.stringify({ totalPoints: 49, challengePoints: 49, dailyStandardsPoints: 49 }));
    localStorage.setItem('dominion:mockChallengeStates', JSON.stringify([{ key: 'seven_day_reset', status: 'available', unlockedAt: '2026-02-01Z', celebrationSeenAt: '2026-02-01Z' }]));
  }, DEFAULT_OWNERSHIP_REWARD_DEFINITIONS.filter((item) => item.key !== 'dominion_night_theme').map((item) => ({ key: item.key, ownedAt: '2026-02-01Z', celebrationSeenAt: '2026-02-01Z' })));
  await page.goto('/dashboard.html'); await app.stable();
  await page.evaluate(() => {
    const rows = JSON.parse(localStorage.getItem('dominion:mockChallengeStates'));
    rows[0].celebrationSeenAt = null;
    localStorage.setItem('dominion:mockChallengeStates', JSON.stringify(rows));
  });
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
