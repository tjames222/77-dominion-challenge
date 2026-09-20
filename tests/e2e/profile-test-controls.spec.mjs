import { expect, expectNoHorizontalOverflow, test } from './support/app-test.mjs';
import { ROUTE_BY_ID } from './support/routes.mjs';
import { expectNoProfileTestControls } from './support/profile-test-controls.mjs';

for (const theme of ['light', 'dark', 'dominion-night', 'dominion-platinum']) {
  for (const width of [390, 1440]) {
    test(`local Profile has no testing controls at ${width}px in ${theme}`, async ({ page, app }) => {
      await page.setViewportSize({ width, height: 900 });
      await app.open(ROUTE_BY_ID.profile, { state: 'rewardsUnlocked', theme });
      // A synthetic fixture, not a user-accessible toggle. Preserve simulator
      // coverage without recreating any Profile control or production override.
      const fixture = await page.evaluate(async () => {
        const { writePreviewUserValue } = await import('/src/static/preview-user-state.mjs');
        const { PREVIEW_CHALLENGE_STORAGE_KEY } = await import('/src/static/preview-challenge.mjs');
        const state = { enabled: true, anchorDate: '2026-02-01', day: 14 };
        writePreviewUserValue(localStorage, localStorage.getItem('dominion:mockUserId'), PREVIEW_CHALLENGE_STORAGE_KEY, state);
        return state;
      });
      await page.reload({ waitUntil: 'networkidle' });
      await expectNoProfileTestControls(page);
      await expectNoHorizontalOverflow(page);
      await page.locator('#profileNameInput').fill('Synthetic Profile Member');
      await page.getByRole('button', { name: 'Save profile', exact: true }).click();
      await expect(page.locator('#profileFeedback')).toHaveText('Profile saved.');
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('dominion:previewChallengeSimulation')))).toEqual(fixture);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      app.assertNoRuntimeErrors();
    });
  }
}
