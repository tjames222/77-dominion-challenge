import { test, expect } from '@playwright/test';
import { installFeedbackStub } from './support/feedback-supabase-stub.mjs';
import { buildMockRewardCatalogV2 } from '../../src/static/preview-reward-catalog.mjs';
import { instanceActivationFixture } from '../fixtures/challenge-instance.mjs';
import { isInstanceDate } from '../../src/static/challenge-instance-contract.mjs';
import { analyzeAccessibility, assertNoBlockingAxeViolations } from './support/quality-gates.mjs';

const json = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json',
  headers: { 'Cache-Control': 'private, no-store' }, body: JSON.stringify(value) });
async function fixture(context, { active = false, theme = 'dark', failOnce = false, commitBeforeError = false } = {}) {
  const auth = await installFeedbackStub(context, { active: false, memberPages: true });
  await context.addInitScript(value => localStorage.setItem('dominion:theme', value), theme);
  const today = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.parse(`${today}T00:00:00Z`) - 90 * 86400000).toISOString().slice(0, 10);
  let activation = instanceActivationFixture();
  Object.assign(activation, { actorId: auth.A, serverDate: today, status: active ? 'active' : 'completed', startDate: start,
    canParticipate: active, canMutateDailyStandards: active, canEditStartDate: false });
  Object.assign(activation.currentInstance, { startDate: start, calendarDay: 91, status: activation.status,
    submittedCount: active ? 76 : 77, completedAt: active ? null : `${today}T11:00:00Z`,
    completionEventId: active ? null : 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
  activation.originalRepeat = { challengeKey: 'original_77', targetCount: 77, available: !active, canStart: !active, reason: active ? 'active_instance_exists' : null };
  const requests = []; const receipts = new Map(); let fail = failOnce; let hold = null;
  let grantRecords = [{ key: 'seven_day_reset', status: 'available', unlockedAt: `${today}T10:00:00Z`, startedAt: null, completedAt: null, celebrationSeenAt: `${today}T10:00:00Z` }];
  const catalog = () => buildMockRewardCatalogV2({ actorId: auth.A, revision: activation.revision, snapshotVersion: 'a'.repeat(64),
    currentInstance: activation.currentInstance, originalRepeat: activation.originalRepeat, totalPoints: 420, trustedDailyStandardPoints: 420,
    challengeRecords: grantRecords, now: `${today}T12:00:00Z` }).catalog;
  await context.route(/\/__admin_fixture__\/rest\/v1\/rpc\/(?:get_reward_catalog_v2|get_challenge_activation_v2|start_challenge_instance_v2|get_badge_collection|claim_challenge_unlocks|get_theme_preference|set_theme_preference)$/, async route => {
    const name = new URL(route.request().url()).pathname.split('/').at(-1); const body = route.request().postDataJSON();
    if (name === 'get_reward_catalog_v2') return json(route, catalog());
    if (name === 'get_challenge_activation_v2') return json(route, activation);
    if (name === 'get_badge_collection') return json(route, { catalogVersion: 1, scopeKey: activation.currentInstance.scopeKey, items: [] });
    if (name === 'claim_challenge_unlocks') return json(route, { claimedKeys: [], progression: { challenges: [] } });
    if (name === 'get_theme_preference' || name === 'set_theme_preference') return json(route, { theme_key: theme });
    requests.push(body);
    expect(body.target_expected_actor_id).toBe(auth.A);
    const prior = receipts.get(body.target_request_id);
    if (prior) {
      expect(body).toEqual(prior.request);
      return json(route, { ...prior.result, replayed: true });
    }
    expect(body.target_expected_instance_id).toBe(activation.currentInstance.id);
    expect(body.target_expected_revision).toBe(activation.revision);
    expect(body.target_request_id).toMatch(/^[a-f0-9-]{36}$/);
    // Match the production SQL boundary; never turn a null browser date into
    // today here, which previously concealed an unusable production Start.
    if (!isInstanceDate(body.target_start_date) || body.target_start_date < activation.serverDate) {
      return json(route, { message: 'Choose today or a future start date.', code: '22023' }, 400);
    }
    expect(body.target_time_zone).toBe(activation.timeZone);
    if (hold) await hold;
    if (fail && !commitBeforeError) { fail = false; return json(route, { message: 'Synthetic start response unavailable. Try again.' }, 503); }
    const key = body.target_challenge_key; const id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    activation = { ...activation, revision: activation.revision + 1, status: 'active', startDate: today,
      canParticipate: true, canMutateDailyStandards: true, originalRepeat: { ...activation.originalRepeat, canStart: false, reason: 'active_instance_exists' },
      currentInstance: { ...activation.currentInstance, id, scopeKey: `instance:${id}`, challengeKey: key, title: key === 'original_77' ? '77-Day Dominion Challenge' : '7-Day Reset',
        status: 'active', startDate: today, targetCount: key === 'original_77' ? 77 : 7, submittedCount: 0, calendarDay: 1,
        completedAt: null, completionEventId: null, provenance: 'live' } };
    if (key === 'seven_day_reset') grantRecords = grantRecords.map(row => ({ ...row, status: 'active', startedAt: `${today}T12:00:00Z` }));
    const result = { schemaVersion: 2, actorId: auth.A, instanceId: id, activation: structuredClone(activation), replayed: false };
    receipts.set(body.target_request_id, { request: structuredClone(body), result });
    if (fail) { fail = false; return json(route, { message: 'Synthetic start response unavailable. Try again.' }, 503); }
    return json(route, result);
  });
  return { requests, originalId: activation.currentInstance.id, originalRevision: activation.revision, serverDate: today,
    advanceDate() {
      activation = { ...activation, serverDate: new Date(Date.parse(`${activation.serverDate}T00:00:00Z`) + 86400000).toISOString().slice(0, 10),
        currentInstance: { ...activation.currentInstance, calendarDay: activation.currentInstance.calendarDay + 1 } };
    },
    hold() { let release; hold = new Promise(resolve => { release = resolve; }); return () => { release(); hold = null; }; } };
}
test.beforeEach(async ({ context, page, baseURL }) => {
  const external = []; const errors = [];
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== baseURL) { external.push(route.request().url()); return route.abort(); }
    return route.fallback();
  });
  await context.routeWebSocket(/.*/, socket => { external.push('WebSocket'); socket.close(); });
  page.on('pageerror', error => errors.push(error.message)); page.__rewardChecks = { external, errors };
});
test.afterEach(async ({ page }) => {
  expect(page.__rewardChecks.external).toEqual([]); expect(page.__rewardChecks.errors).toEqual([]);
});
async function ready(page) {
  await page.goto('/badges-rewards.html');
  await expect(page.locator('#rewardsList')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#badgesRewardsError')).toBeHidden();
}
for (const theme of ['light', 'dark', 'dominion-night', 'dominion-platinum']) {
  test(`${theme}: point and completion requirements stay distinct, readable and accessible`, async ({ context, page }) => {
    const state = await fixture(context, { active: true, theme }); await ready(page);
    const prayer = page.locator('[data-reward-key="twenty_one_day_prayer"]');
    await expect(prayer).toContainText('Complete 7-Day Reset to unlock');
    await expect(prayer.getByRole('progressbar')).toHaveCount(0);
    await expect(prayer.locator('[data-start-reward]')).toHaveCount(0);
    const reset = page.locator('[data-reward-key="seven_day_reset"]');
    await expect(reset).toContainText('Finish your current challenge');
    await expect(reset.locator('[data-start-reward]')).toHaveCount(0);
    await expect(page.locator('#rewardNextTitle')).toHaveText('Big God Energy T-Shirt Discount');
    await prayer.getByRole('button', { name: 'View progress for 21-Day Prayer Track' }).click();
    await expect(page.locator('#rewardDetailDialog')).toContainText('Complete 7-Day Reset to unlock');
    await expect(page.locator('#rewardDetailDialog').getByRole('progressbar')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(prayer.getByRole('button', { name: 'View progress for 21-Day Prayer Track' })).toBeFocused();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    // Focus restoration scrolls the sticky navigation and reveal section.
    // WebKit can report no running animations before the composited reveal
    // opacity has settled. Require the actual section styles as well; never
    // exempt contrast findings or disable motion to conceal a transient UI.
    await expect.poll(() => page.evaluate(() => document.getAnimations().filter(animation =>
      animation.playState === 'running' && Number.isFinite(animation.effect?.getTiming().iterations)).length)).toBe(0);
    const catalogSection = page.locator('.rewards-catalog-section');
    await expect(catalogSection).toHaveClass(/is-visible/);
    await expect(catalogSection).toHaveCSS('opacity', '1');
    await expect(catalogSection).toHaveCSS('filter', 'blur(0px)');
    const dimensions = await page.evaluate(() => ({ body: document.documentElement.scrollWidth, viewport: innerWidth }));
    expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport + 1);
    assertNoBlockingAxeViolations(await analyzeAccessibility(page)); expect(state.requests).toEqual([]);
  });
}
for (const key of ['original_77', 'seven_day_reset']) {
  test(`${key}: explicit Start sends captured run/CAS and moves keyboard focus to Daily Actions`, async ({ context, page }) => {
    const state = await fixture(context); await ready(page);
    const button = page.locator(`[data-start-reward="${key}"]`); await button.focus(); await page.keyboard.press('Enter');
    await expect(page.locator('#rewardsCatalogFeedback')).toContainText('Challenge started.');
    await expect(page.getByRole('link', { name: 'Open today’s Daily Actions' })).toBeFocused();
    expect(state.requests).toHaveLength(1);
    expect(state.requests[0]).toMatchObject({ target_challenge_key: key, target_expected_instance_id: state.originalId,
      target_expected_revision: state.originalRevision, target_start_date: state.serverDate, target_time_zone: 'UTC' });
    await expect(page.locator('[data-start-reward]')).toHaveCount(0);
  });
}
test('uncertain Start retry reuses its date and UUID after a lost commit response across midnight', async ({ context, page }) => {
  const state = await fixture(context, { failOnce: true, commitBeforeError: true }); await ready(page);
  const release = state.hold(); const button = page.locator('[data-start-reward="seven_day_reset"]'); await button.click();
  await expect(page.locator('[data-start-reward="original_77"]')).toBeDisabled();
  await expect(button).toBeDisabled(); release();
  await expect(page.locator('#rewardsCatalogFeedback')).toContainText('Synthetic start response unavailable');
  state.advanceDate();
  await expect(button).toBeFocused(); await page.keyboard.press('Enter');
  await expect(page.getByRole('link', { name: 'Open today’s Daily Actions' })).toBeFocused();
  expect(state.requests).toHaveLength(2); expect(state.requests[1]).toEqual(state.requests[0]);
});
