import {
  expectNoHorizontalOverflow,
  expectStableScreenshot,
  expect,
  test,
} from './support/app-test.mjs';
import { PRODUCTION_ROUTES } from './support/routes.mjs';

const dashboardRoute = PRODUCTION_ROUTES.find((route) => route.id === 'dashboard');

test.describe('all-route visual matrix', () => {
  for (const route of PRODUCTION_ROUTES) {
    test(route.id + ' visual contract', async ({ page, app }, testInfo) => {
      const theme = testInfo.project.metadata.theme;
      await app.open(route, { theme });
      await expectNoHorizontalOverflow(page);
      await expectStableScreenshot(page, app, route.id + '.png');
      app.assertNoRuntimeErrors();
    });
  }

  test('open global navigation visual contract', async ({ page, app }, testInfo) => {
    const theme = testInfo.project.metadata.theme;
    await app.open(dashboardRoute, { theme });
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('navigation', { name: 'Global navigation' }).waitFor({ state: 'visible' });
    await expectStableScreenshot(page, app, 'global-navigation-open.png', { fullPage: false });
    app.assertNoRuntimeErrors();
  });
});

test.describe('mobile shared composer visual matrix', () => {
  for (const routeId of ['dashboard', 'badgesRewards', 'privateJournal']) {
    test(`${routeId} branded Share composer`, async ({ page, app }, testInfo) => {
      test.skip(testInfo.project.metadata.breakpoint !== 'mobile', 'Mobile dialog baseline');
      const route = PRODUCTION_ROUTES.find((candidate) => candidate.id === routeId);
      await app.open(route, { theme: testInfo.project.metadata.theme });
      await page.locator('.shared-header-share').click();
      await expect(page.locator('[data-share-method="copy_link"]')).toBeEnabled();
      await expectStableScreenshot(page, app, `${routeId}-share-composer.png`, { fullPage: false });
      app.assertNoRuntimeErrors();
    });

    test(`${routeId} Platinum Share composer`, async ({ page, app }, testInfo) => {
      test.skip(testInfo.project.name !== 'visual-mobile-dark', 'One dedicated Platinum mobile baseline');
      const route = PRODUCTION_ROUTES.find((candidate) => candidate.id === routeId);
      await app.open(route, { state: 'rewardsUnlocked', theme: 'dominion-platinum' });
      await page.locator('.shared-header-share').click();
      await expect(page.locator('[data-share-method="copy_link"]')).toBeEnabled();
      await expectStableScreenshot(page, app, `${routeId}-share-composer-platinum.png`, { fullPage: false });
      app.assertNoRuntimeErrors();
    });
  }
});
