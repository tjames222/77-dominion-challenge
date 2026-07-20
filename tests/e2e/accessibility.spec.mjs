import { test } from './support/app-test.mjs';
import { PRODUCTION_ROUTES, ROUTE_BY_ID } from './support/routes.mjs';
import {
  analyzeAccessibility,
  assertNoBlockingAxeViolations,
} from './support/quality-gates.mjs';

test.describe('WCAG route gate', () => {
  for (const route of PRODUCTION_ROUTES) {
    test(route.id + ' has no serious or critical automated violations', async ({ page, app }) => {
      await app.open(route);
      const results = await analyzeAccessibility(page);
      assertNoBlockingAxeViolations(results);
    });
  }
});

test('open navigation has no serious or critical automated violations', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.dashboard);
  await page.getByRole('button', { name: 'Open menu' }).click();
  const results = await analyzeAccessibility(page);
  assertNoBlockingAxeViolations(results);
});

test('community form tabs have no serious or critical automated violations', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.community);
  await page.getByRole('tab', { name: 'My Journey' }).click();
  const results = await analyzeAccessibility(page);
  assertNoBlockingAxeViolations(results);
});
