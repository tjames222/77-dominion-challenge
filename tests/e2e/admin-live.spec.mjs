import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { installAdminStub } from './support/admin-supabase-stub.mjs';

async function ready(page) { await page.goto('/admin.html'); await expect(page.locator('#adminUsersRows tr')).toHaveCount(25); }
async function noStoredPayload(page) {
  const value = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(value).not.toMatch(/member28@example.invalid|Preview Member 28|staff_access_review|activationSnapshot/);
}
for (const [name, options] of [['member and crew admin metadata', { role: 'member' }], ['AAL1 admin', { aal: 'aal1' }]]) {
  test(`${name} never loads private rows or accepts preview URL bypass`, async ({ context, page }) => {
    const auth = await installAdminStub(context, options);
    await page.goto('/admin.html?admin-preview=ready');
    await expect(page.locator('#adminGateTitle')).not.toHaveText('Checking access');
    await expect(page.locator('#adminWorkspace')).toBeHidden();
    await page.getByRole('button', { name: 'Open menu', exact: true }).click();
    await expect(page.locator('[data-admin-menu-item]')).toHaveCount(0);
    expect(auth.reads()).toHaveLength(0);
    expect(await page.content()).not.toContain('member28@example.invalid');
    if (options.aal) {
      const link = new URL(await page.locator('#adminMfa').getAttribute('href'), page.url());
      expect(link.pathname).toBe('/account-security.html'); expect(link.searchParams.get('mode')).toBe('challenge'); expect(link.searchParams.get('returnTo')).toBe('./admin.html');
    }
    await expect(page.locator('#adminPreview')).toBeHidden();
  });
}
test('anonymous direct URL has only a generic login gate', async ({ page }) => {
  await page.goto('/admin.html?admin-preview=ready');
  await expect(page.locator('#adminLogin')).toBeVisible(); await expect(page.locator('#adminWorkspace')).toBeHidden();
  expect(await page.content()).not.toContain('member28@example.invalid');
});
test('server pagination, filters, snapshots and audit detail work without membership access', async ({ context, page }) => {
  const auth = await installAdminStub(context); await ready(page);
  await expect(page.locator('#adminPreview')).toBeHidden();
  await page.locator('#adminNextPage').click(); await expect(page.locator('#adminUsersRows tr')).toHaveCount(3);
  await expect(page.locator('#adminPageLabel')).toHaveText('Page 2');
  await page.locator('#adminPreviousPage').click(); await expect(page.locator('#adminUsersRows tr')).toHaveCount(25);
  await page.getByLabel('Name or email prefix').fill('member28'); await expect(page.locator('#adminUsersRows tr')).toHaveCount(0);
  await page.locator('#adminUsersFilters button').click(); await expect(page.locator('#adminUsersRows tr')).toHaveCount(1);
  const button = page.locator('#adminUsersRows button'); await button.click();
  await expect(page.locator('#adminDetailBody')).toContainText('member28@example.invalid');
  await expect(page.locator('#adminDetailBody')).toContainText('not current effective access');
  await page.keyboard.press('Escape'); await expect(button).toBeFocused();
  await page.getByRole('tab', { name: 'Audit', exact: true }).click(); await expect(page.locator('#adminAuditRows tr')).toHaveCount(25);
  await page.locator('#adminAuditRows button').first().click(); await expect(page.locator('#adminDetailBody')).toContainText('staff_access_review');
  await page.keyboard.press('Escape');
  await page.getByRole('combobox', { name: 'Outcome', exact: true }).selectOption('failure'); await page.locator('#adminAuditFilters button').click();
  await expect(page.locator('#adminAuditRows tr')).toHaveCount(10);
  expect(auth.reads().every((item) => item.actor === auth.A && item.aal === 'aal2' && item.method === 'POST')).toBe(true);
  await noStoredPayload(page);
});
test('denied role or network failure clears rendered private records and closes details', async ({ context, page }) => {
  const auth = await installAdminStub(context); await ready(page);
  auth.fail(); await page.locator('#adminRefresh').click(); await expect(page.locator('#adminUsersRows tr')).toHaveCount(0);
  await expect(page.locator('#adminStatus')).toContainText('temporarily unavailable'); expect(await page.content()).not.toContain('PRIVATE RAW ERROR');
  auth.fail(false); await page.locator('#adminRefresh').click(); await expect(page.locator('#adminUsersRows tr')).toHaveCount(25);
  auth.role('member'); await page.locator('#adminUsersRows button').first().click();
  await expect(page.locator('#adminWorkspace')).toBeHidden(); await expect(page.locator('#adminDetail')).not.toBeVisible();
  expect(await page.content()).not.toContain('member28@example.invalid'); await noStoredPayload(page);
});
test('audit-only permission never loads account summaries', async ({ context, page }) => {
  const auth = await installAdminStub(context); auth.permissions(['audit.read']);
  await page.goto('/admin.html'); await expect(page.locator('#adminAuditRows tr')).toHaveCount(25);
  await expect(page.getByRole('tab', { name: 'Users', exact: true })).toBeHidden();
  expect(auth.reads().every((item) => item.path.includes('audit'))).toBe(true);
  expect(await page.content()).not.toContain('member28@example.invalid');
});
test('same-session assurance downgrade clears records before a fresh MFA decision', async ({ context, page }) => {
  const auth = await installAdminStub(context); await ready(page);
  const session = auth.session(auth.A, 'aal1');
  await page.evaluate((value) => {
    localStorage.setItem('sb-127-auth-token', JSON.stringify(value));
    const channel = new BroadcastChannel('sb-127-auth-token');
    channel.postMessage({ event: 'TOKEN_REFRESHED', session: value }); channel.close();
  }, session);
  await expect(page.locator('#adminWorkspace')).toBeHidden();
  await expect(page.locator('#adminUsersRows tr')).toHaveCount(0);
  await page.locator('#adminRetryAccess').click(); await expect(page.locator('#adminMfa')).toBeVisible();
  expect(await page.content()).not.toContain('member28@example.invalid');
});
test('pagehide scrubs filters, modal and pending response; persisted pageshow revalidates', async ({ context, page }) => {
  const auth = await installAdminStub(context); await ready(page);
  await page.getByLabel('Name or email prefix').fill('private-prefix');
  await page.getByLabel('Name or email prefix').fill(''); await page.locator('#adminUsersFilters button').click(); await expect(page.locator('#adminUsersRows tr')).toHaveCount(25);
  const release = auth.hold(); await page.locator('#adminUsersRows button').first().click(); await expect(page.locator('#adminDetail')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  release(); await expect(page.locator('#adminWorkspace')).toBeHidden(); await expect(page.locator('#adminDetail')).not.toBeVisible();
  await expect(page.getByLabel('Name or email prefix')).toHaveValue('');
  auth.role('member'); await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(page.locator('#adminGateMessage')).toContainText('does not have'); expect(await page.content()).not.toContain('member28@example.invalid');
});
test('wrong-actor response is rejected and explicit logout scrubs before navigation', async ({ context, page }) => {
  const auth = await installAdminStub(context); await ready(page);
  auth.corrupt(); await page.locator('#adminRefresh').click(); await expect(page.locator('#adminUsersRows tr')).toHaveCount(0);
  auth.corrupt(false); await page.locator('#adminRefresh').click(); await expect(page.locator('#adminUsersRows tr')).toHaveCount(25);
  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  await expect(page.locator('[data-admin-menu-item]')).toBeVisible();
  await page.getByRole('button', { name: 'Log Out', exact: true }).click(); await expect(page).toHaveURL(/index\.html$/);
  await noStoredPayload(page);
});
for (const replacement of ['A→B→A', 'same actor, new immutable session']) {
  test(`${replacement} clears old records and rejects a delayed previous-session response`, async ({ context, page }) => {
    const auth = await installAdminStub(context); await ready(page);
    const count = auth.reads().length; const release = auth.hold();
    await page.locator('#adminRefresh').click(); await expect.poll(() => auth.reads().length).toBe(count + 1);
    const finalSession = replacement === 'A→B→A' ? auth.firstSession : auth.session(auth.A, 'aal2', '22222222-2222-4222-8222-222222222222');
    const transitions = replacement === 'A→B→A' ? [auth.session(auth.B), finalSession] : [finalSession];
    // Model the SDK's cross-tab storage write and sanitized auth notification.
    // Sessions are issued only by this local HTTP provider; production code
    // still performs getUser and the guarded expected-actor RPC on every read.
    await page.evaluate(async (sessions) => {
      const channel = new BroadcastChannel('sb-127-auth-token');
      for (const session of sessions) {
        localStorage.setItem('sb-127-auth-token', JSON.stringify(session));
        window.dispatchEvent(new StorageEvent('storage', { key: 'sb-127-auth-token', newValue: JSON.stringify(session) }));
        channel.postMessage({ event: 'SIGNED_IN', session });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      channel.close();
    }, transitions);
    release(); await expect(page.locator('#adminWorkspace')).toBeHidden();
    expect(await page.content()).not.toContain('STALE PREVIOUS SESSION SNAPSHOT');
    await page.locator('#adminRetryAccess').click(); await expect(page.locator('#adminUsersRows tr')).toHaveCount(25);
    expect(await page.content()).not.toContain('STALE PREVIOUS SESSION SNAPSHOT'); await noStoredPayload(page);
  });
}
for (const theme of ['light', 'dark', 'dominion-night', 'dominion-platinum']) {
  test(`read-only records remain accessible in ${theme}`, async ({ context, page }, testInfo) => {
    await installAdminStub(context); await ready(page);
    // Visual-only theme override: no entitlement decision is inferred or stored.
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    for (const select of await page.locator('#adminUsersFilters select').all()) expect((await select.boundingBox()).height).toBeGreaterThanOrEqual(48);
    const detailButton = page.locator('#adminUsersRows button').first();
    expect((await detailButton.boundingBox()).height).toBeLessThan(60);
    const axe = await new AxeBuilder({ page }).analyze(); expect(axe.violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`${theme}-users.png`), fullPage: false });
    await page.getByRole('tab', { name: 'Users', exact: true }).focus(); await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Audit', exact: true })).toBeFocused();
    await expect(page.locator('#adminAuditRows tr')).toHaveCount(25);
    await page.locator('#adminAuditRows button').first().click(); await expect(page.locator('#adminDetailBody')).toContainText('staff_access_review');
    const modalAxe = await new AxeBuilder({ page }).analyze(); expect(modalAxe.violations).toEqual([]);
    await page.locator('#adminDetail').evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await expect(page.locator('#adminDetailClose')).toBeInViewport();
    await page.locator('#adminDetail').evaluate((node) => { node.scrollTop = 0; });
    await page.screenshot({ path: testInfo.outputPath(`${theme}-audit-detail.png`), fullPage: false });
    await page.keyboard.press('Escape');
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await noStoredPayload(page);
  });
}
