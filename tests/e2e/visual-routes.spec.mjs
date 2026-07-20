import {
  expectNoHorizontalOverflow,
  expectStableScreenshot,
  test,
} from './support/app-test.mjs';
import { PRODUCTION_ROUTES } from './support/routes.mjs';

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
});
