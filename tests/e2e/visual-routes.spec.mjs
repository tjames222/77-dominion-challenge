import {
  expectNoHorizontalOverflow,
  expectStableScreenshot,
  expect,
  test,
} from './support/app-test.mjs';
import { PRODUCTION_ROUTES, ROUTE_BY_ID } from './support/routes.mjs';
import { seedBadgeGallery } from './support/badge-gallery-fixtures.mjs';

const dashboardRoute = PRODUCTION_ROUTES.find((route) => route.id === 'dashboard');

for (const platinum of [false, true]) {
  test(`earned badge grid and detail visual contract${platinum ? ': Platinum' : ''}`, async ({ page, app }, testInfo) => {
    test.skip(platinum && testInfo.project.metadata.theme !== 'dark', 'One Platinum case per breakpoint');
    const theme = platinum ? 'dominion-platinum' : testInfo.project.metadata.theme;
    await seedBadgeGallery(page, app, { theme });
    await page.goto('/badges-rewards', { waitUntil: 'networkidle' });
    await app.stable();
    await page.getByRole('tab', { name: 'Badges', exact: true }).click();
    await expect(page.locator('.badge-gallery-tile')).toHaveCount(3);
    await page.locator('#badgesGallery').scrollIntoViewIfNeeded();
    await expectStableScreenshot(page, app, `earned-badge-grid${platinum ? '-platinum' : ''}.png`, { fullPage: false });
    await page.locator('[data-badge-key="perfect_week"]').click();
    await expect(page.getByRole('dialog', { name: 'Seven for Seven' })).toBeVisible();
    await expectStableScreenshot(page, app, `earned-badge-detail${platinum ? '-platinum' : ''}.png`, { fullPage: false });
    app.assertNoRuntimeErrors();
  });
}

test.describe('all-route visual matrix', () => {
  for (const route of PRODUCTION_ROUTES) {
    test(route.id + ' visual contract', async ({ page, app }, testInfo) => {
      const theme = testInfo.project.metadata.theme;
      await app.open(route, { theme });
      await expectNoHorizontalOverflow(page);
      if (route.id === 'admin') {
        // Root overflow can remain clipped while a negative header margin
        // enlarges the body's full-page capture beyond the configured viewport.
        const viewportWidth = page.viewportSize().width;
        const bounds = await page.evaluate(() => {
          const header = document.querySelector('.admin-shell > .topbar').getBoundingClientRect();
          return { bodyWidth: document.body.scrollWidth, left: header.left, right: header.right };
        });
        expect(bounds.bodyWidth, 'Admin body must fit the configured viewport').toBeLessThanOrEqual(viewportWidth);
        expect(bounds.left, 'Admin header must not extend past the left edge').toBeGreaterThanOrEqual(0);
        expect(bounds.right, 'Admin header must not extend past the right edge').toBeLessThanOrEqual(viewportWidth);
      }
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
for (const state of [
  { tab: 'Rewards', scrollY: 0, name: 'rewards-top' },
  { tab: 'Badges', scrollY: 300, name: 'badges-sticky' },
]) {
  test(`rewards navigation overlay visual contract: ${state.name}`, async ({ page, app }, testInfo) => {
    await app.open(ROUTE_BY_ID.badgesRewards, { theme: testInfo.project.metadata.theme });
    await page.getByRole('tab', { name: state.tab, exact: true }).click();
    await page.evaluate((y) => window.scrollTo(0, y), state.scrollY);
    await page.locator('.global-menu-button').evaluate((button) => button.focus({ preventScroll: true }));
    await page.keyboard.press('Enter');
    await page.getByRole('navigation', { name: 'Global navigation' }).waitFor({ state: 'visible' });
    await expectStableScreenshot(page, app, `global-navigation-${state.name}.png`, { fullPage: false });
    app.assertNoRuntimeErrors();
  });
}
