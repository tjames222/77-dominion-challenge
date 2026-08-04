import {
  expectNoHorizontalOverflow,
  expectStableScreenshot,
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
