import { test, expect, expectNoHorizontalOverflow } from './support/app-test.mjs';
import { ROUTE_BY_ID } from './support/routes.mjs';
import AxeBuilder from '@axe-core/playwright';

test('admin direct load and refresh never hydrate member Share or Streak controls', async ({ page, app }) => {
  await app.open({ ...ROUTE_BY_ID.admin, path: '/admin.html?admin-preview=ready' });
  await expect(page.locator('#adminUsersRows tr')).toHaveCount(25);
  await expect(page.locator('.shared-header-share, .shared-header-streak')).toHaveCount(0);
  await page.reload(); await expect(page.locator('#adminUsersRows tr')).toHaveCount(25);
  await expect(page.locator('.shared-header-share, .shared-header-streak')).toHaveCount(0);
  app.assertNoRuntimeErrors();
});

for (const theme of ['light', 'dark', 'dominion-night', 'dominion-platinum']) {
  for (const width of [390, 1440]) {
    test(`synthetic admin preview is labeled and usable: ${theme} ${width}`, async ({ page, app }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await app.open({ ...ROUTE_BY_ID.admin, path: '/admin.html?admin-preview=ready' }, { theme });
      await expect(page.locator('#adminPreview')).toBeVisible(); await expect(page.locator('#adminUsersRows tr')).toHaveCount(25);
      await expectNoHorizontalOverflow(page);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`admin-${theme}-${width}.png`), fullPage: false });
      await page.locator('#adminNextPage').click(); await expect(page.locator('#adminUsersRows tr')).toHaveCount(3);
      await page.getByRole('tab', { name: 'Audit', exact: true }).click(); await expect(page.locator('#adminAuditRows tr')).toHaveCount(25);
      await page.locator('#adminAuditRows button').first().click(); await expect(page.locator('#adminDetailBody')).toContainText('preview');
      await page.locator('#adminDetailClose').click();
      await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; }); await expectNoHorizontalOverflow(page);
      app.assertNoRuntimeErrors();
    });
  }
}
test('default preview member has no Admin link and cannot read records', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.admin); await expect(page.locator('#adminGateMessage')).toContainText('does not have');
  await page.getByRole('button', { name: 'Open menu', exact: true }).click(); await expect(page.locator('[data-admin-menu-item]')).toHaveCount(0);
  await expect(page.locator('#adminUsersRows tr')).toHaveCount(0); app.assertNoRuntimeErrors();
});
test('preview account storage changes clear filters, rows, detail and Admin link', async ({ page, app }) => {
  await app.open({ ...ROUTE_BY_ID.admin, path: '/admin.html?admin-preview=ready' }); await expect(page.locator('#adminUsersRows tr')).toHaveCount(25);
  await page.locator('#adminUsersRows button').first().click(); await expect(page.locator('#adminDetailBody')).toContainText('member28@example.invalid');
  await page.evaluate(() => { localStorage.removeItem('dominion:user'); window.dispatchEvent(new StorageEvent('storage', { key: 'dominion:user', newValue: null })); });
  await expect(page.locator('#adminWorkspace')).toBeHidden(); await expect(page.locator('#adminDetail')).not.toBeVisible();
  await expect(page.locator('[data-admin-menu-item]')).toHaveCount(0); expect(await page.content()).not.toContain('member28@example.invalid');
});
