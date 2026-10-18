import { test, expect } from './support/app-test.mjs';
import { injectApiFunctionFailure } from './support/network-states.mjs';
import { observePostRevealCountdown } from './support/dashboard-countdown-ready.mjs';
import { DEFAULT_OWNERSHIP_REWARD_DEFINITIONS } from '../../src/static/reward-catalog.mjs';
import { FIXED_USER_ID } from './support/fixtures.mjs';

async function observeBootRecovery(page, { deferred }) {
  await page.addInitScript(held => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const state = { held, gate, release, entered: false, completed: false, challengePresentations: 0 };
    globalThis.__DOMINION_E2E_BOOT_RECOVERY__ = state;
    let visible = false;
    new MutationObserver(() => {
      const stage = document.getElementById('challengeUnlockCelebration');
      const next = Boolean(stage && !stage.hidden);
      if (next && !visible) state.challengePresentations += 1;
      visible = next;
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  }, deferred);
  await page.route(url => url.pathname.endsWith('/src/static/dashboard.js'), async route => {
    const response = await route.fetch();
    const source = await response.text();
    const recovery = 'await recoverPendingCelebrations();\n  startCountdownCard();';
    const boot = 'bootDashboard().catch((error) => {';
    expect(source.split(recovery)).toHaveLength(2);
    expect(source.split(boot)).toHaveLength(2);
    const injected = source.replace(recovery,
      'globalThis.__DOMINION_E2E_BOOT_RECOVERY__.entered = true;\n'
      + '  if (globalThis.__DOMINION_E2E_BOOT_RECOVERY__.held) await globalThis.__DOMINION_E2E_BOOT_RECOVERY__.gate;\n'
      + '  ' + recovery).replace(boot,
      'bootDashboard().then(() => { globalThis.__DOMINION_E2E_BOOT_RECOVERY__.completed = true; }).catch((error) => {');
    await route.fulfill({ response, body: injected });
  });
}

// Source-level failure injection is intentionally separate from the compiled
// bundle matrix, which exercises only shipped routes and persisted fixtures.
for (const deferred of [false, true]) test(`a failed permanent reward lookup cannot block day, badge or challenge celebrations${deferred ? ' after delayed boot recovery' : ''}`, async ({ page, app }) => {
  await injectApiFunctionFailure(page, 'claimRewardCelebrations', 'Simulated reward service outage');
  await observeBootRecovery(page, { deferred });
  await app.seed('rewardsUnlocked');
  await page.addInitScript((owned) => {
    localStorage.setItem('dominion:mockRewardEntitlements', JSON.stringify(owned));
    localStorage.setItem('dominion:mockChallengeThresholdsVersion', '4');
    const stats = JSON.parse(localStorage.getItem('dominion:gameStats') || '{}');
    localStorage.setItem('dominion:gameStats', JSON.stringify({ ...stats, totalPoints: 105, challengePoints: 105, dailyStandardsPoints: 105 }));
    localStorage.setItem('dominion:mockChallengeStates', JSON.stringify([{ key: 'seven_day_reset', status: 'available', unlockedAt: '2026-02-01T00:00:00.000Z', celebrationSeenAt: '2026-02-01T00:00:00.000Z' }]));
  }, DEFAULT_OWNERSHIP_REWARD_DEFINITIONS.filter((item) => item.key !== 'dominion_night_theme').map((item) => ({ key: item.key, ownedAt: '2026-02-01T00:00:00.000Z', celebrationSeenAt: '2026-02-01T00:00:00.000Z' })));
  await page.goto('/dashboard.html'); await app.stable();
  // Reveal is deliberately earlier than recovery. Hold that exact boundary
  // in one case so this cannot regress to treating visibility as boot completion.
  await expect(page.locator('.dashboard-brand-panel')).toHaveClass(/\b(?:pending-reveal|is-visible)\b/);
  const countdownUpdated = await observePostRevealCountdown(page);
  if (deferred) {
    await expect.poll(() => page.evaluate(() => globalThis.__DOMINION_E2E_BOOT_RECOVERY__.entered)).toBe(true);
    expect(await page.evaluate(() => globalThis.__DOMINION_E2E_BOOT_RECOVERY__.completed)).toBe(false);
    // Flush already scheduled frames, without advancing time or releasing the
    // held recovery. Visibility alone cannot satisfy the countdown barrier.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await countdownUpdated()).toBe(false);
    await expect(page.locator('#challengeUnlockCelebration')).not.toBeVisible();
    await page.evaluate(() => globalThis.__DOMINION_E2E_BOOT_RECOVERY__.release());
  }
  // Observe the entire original boot promise, including its awaited recovery
  // and following countdown/foreground setup, before changing fixture state.
  await expect.poll(countdownUpdated).toBe(true);
  await expect.poll(() => page.evaluate(() => globalThis.__DOMINION_E2E_BOOT_RECOVERY__.completed)).toBe(true);
  expect(await page.evaluate(() => globalThis.__DOMINION_E2E_BOOT_RECOVERY__.challengePresentations)).toBe(0);
  await expect(page.locator('#challengeUnlockCelebration')).not.toBeVisible();
  // Stage only the concurrent post-check-in unlock, not a boot-time recovery.
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
  expect(await page.evaluate(() => globalThis.__DOMINION_E2E_BOOT_RECOVERY__.challengePresentations)).toBe(1);
  await expect(page.locator('#permanentRewardCelebration')).toHaveCount(0);
  await expect(page.locator('#checkInStatus')).not.toContainText('Unable to');
  app.assertNoRuntimeErrors();
});
