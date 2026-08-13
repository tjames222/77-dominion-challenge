import { expect, test } from './support/app-test.mjs';
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

test('Dashboard exposes one accessible header Share action without a local duplicate', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.dashboard);
  await expect(page.getByRole('button', { name: 'Share my progress' })).toHaveCount(0);
  const headerShare = page.locator('.shared-header-share');
  await expect(headerShare).toHaveCount(1);
  await expect(headerShare).toHaveAccessibleName('Share');
  const results = await analyzeAccessibility(page);
  assertNoBlockingAxeViolations(results);
});

test('Private Journal destination has no serious or critical automated violations', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.community);
  await page.getByRole('link', { name: 'Private Journal', exact: true }).click();
  await expect(page).toHaveURL(/\/private-journal\.html$/);
  const results = await analyzeAccessibility(page);
  assertNoBlockingAxeViolations(results);
});

for (const theme of ['light', 'dark', 'dominion-night', 'dominion-platinum']) {
  test('Dashboard has no blocking violations in ' + theme, async ({ page, app }) => {
    await app.open(ROUTE_BY_ID.dashboard, { theme });
    const results = await analyzeAccessibility(page);
    assertNoBlockingAxeViolations(results);
  });
}
