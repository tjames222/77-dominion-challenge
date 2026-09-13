import AxeBuilder from '@axe-core/playwright';
import { test, expect, expectNoHorizontalOverflow } from './support/app-test.mjs';
import { ROUTE_BY_ID } from './support/routes.mjs';

const syntheticKey = 'JBSWY3DPEHPK3PXP';

test('security direct load and refresh do not expose member-data Share or App Streak controls', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.accountSecurity);
  for (const phase of ['direct load', 'refresh']) {
    await expect(page.locator('#securityCard')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('.shared-header-share, .shared-header-streak'), phase).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Set up authenticator' })).toBeEnabled();
    if (phase === 'direct load') await page.reload({ waitUntil: 'networkidle' });
  }
  app.assertNoRuntimeErrors();
});

async function expectNoSecretPersistence(page) {
  const stored = await page.evaluate(() => ({
    local: JSON.stringify({ ...localStorage }), session: JSON.stringify({ ...sessionStorage }),
    url: location.href, html: document.documentElement.outerHTML,
  }));
  for (const field of ['local', 'session', 'url', 'html']) expect(stored[field]).not.toContain(syntheticKey);
}

for (const theme of ['light', 'dark', 'dominion-night', 'dominion-platinum']) {
  for (const width of [390, 1440]) {
    test(`authenticator setup, retry and verified cleanup: ${theme} ${width}px`, async ({ page, app }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      const hosted = [];
      page.on('request', (request) => { if (/supabase\.(?:co|in)/.test(request.url())) hosted.push(request.url()); });
      await app.open(ROUTE_BY_ID.accountSecurity, { theme });
      await expect(page.getByLabel('Preview simulation')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Set up authenticator' })).toBeEnabled();
      await page.getByRole('button', { name: 'Set up authenticator' }).click();
      await expect(page.locator('#securityKey')).toHaveValue(syntheticKey);
      await expect(page.locator('#securityQr')).toHaveJSProperty('naturalWidth', 240);
      await expect(page.getByRole('heading', { name: 'On the same phone?' })).toBeVisible();
      await expectNoSecretPersistence(page);
      await expectNoHorizontalOverflow(page);
      const axe = await new AxeBuilder({ page }).analyze();
      expect(axe.violations).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`mfa-setup-${theme}-${width}.png`), fullPage: true });

      await page.getByLabel('Six-digit code', { exact: true }).fill('999999');
      await page.getByRole('button', { name: 'Verify code', exact: true }).click();
      await expect(page.getByRole('status')).toContainText('current six-digit code');
      await expect(page.getByLabel('Six-digit code', { exact: true })).toHaveValue('');
      await expect(page.getByLabel('Six-digit code', { exact: true })).toBeFocused();
      await expect(page.locator('#securitySuccess')).toBeHidden();
      await page.getByLabel('Six-digit code', { exact: true }).fill('012345');
      await page.getByRole('button', { name: 'Verify code', exact: true }).click();
      await expect(page.locator('#securitySuccess')).toBeVisible();
      await expect(page.getByRole('status')).toContainText('live account is unchanged');
      await expect(page.locator('#securityKey')).toHaveValue('');
      await expect(page.locator('#securityQr')).not.toHaveAttribute('src');
      await expect(page.getByLabel('Six-digit code', { exact: true })).toHaveValue('');
      await expectNoSecretPersistence(page);
      expect(hosted).toEqual([]);
      app.assertNoRuntimeErrors();
    });
  }
}

test('manual key supports explicit copy and cancellation leaves no secret behind', async ({ page, app }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value) => { window.__copiedSyntheticMfaKey = value; } } });
  });
  await app.open(ROUTE_BY_ID.accountSecurity);
  await page.getByRole('button', { name: 'Set up authenticator' }).click();
  await expect(page.locator('#securityKey')).toHaveValue(syntheticKey);
  expect(await page.evaluate(() => window.__copiedSyntheticMfaKey)).toBeUndefined();
  await page.getByRole('button', { name: 'Copy setup key' }).click();
  await expect(page.getByRole('status')).toContainText('Setup key copied');
  expect(await page.evaluate(() => window.__copiedSyntheticMfaKey)).toBe(syntheticKey);
  await page.getByRole('button', { name: 'Cancel setup' }).click();
  await expect(page.locator('#securityKey')).toHaveValue('');
  await expect(page.locator('#securityQr')).not.toHaveAttribute('src');
  await expect(page.getByRole('button', { name: 'Set up authenticator' })).toBeFocused();
  await expectNoSecretPersistence(page);
});

test('setup key remains while switching to an authenticator, but pagehide clears it', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.accountSecurity);
  await page.getByRole('button', { name: 'Set up authenticator' }).click();
  await expect(page.locator('#securityKey')).toHaveValue(syntheticKey);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('#securityKey')).toHaveValue(syntheticKey);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await expect(page.locator('#securityKey')).toHaveValue('');
  await expect(page.locator('#securityQr')).not.toHaveAttribute('src');
});

test('cross-tab account change clears setup and prevents stale verification', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.accountSecurity);
  await page.getByRole('button', { name: 'Set up authenticator' }).click();
  await expect(page.locator('#securityKey')).toHaveValue(syntheticKey);
  await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'dominion:user', newValue: null })));
  await expect(page.locator('#securityKey')).toHaveValue('');
  await expect(page.locator('#securityVerifyForm')).toBeHidden();
  await expect(page.getByRole('status')).toContainText('preview account changed');
});

for (const mode of ['challenge', 'step-up']) {
  test(`${mode} requires an existing-factor code and never presents a new setup key`, async ({ page, app }) => {
    await app.open({ ...ROUTE_BY_ID.accountSecurity, path: `/account-security.html?mode=${mode}&returnTo=%2Fprofile.html` });
    await expect(page.locator('#securityVerifyForm')).toBeVisible();
    await expect(page.locator('#securitySetup')).toBeHidden();
    await expect(page.locator('#securityEnrollment')).toBeHidden();
    await expect(page.locator('#securitySuccess')).toBeHidden();
    await page.getByLabel('Six-digit code', { exact: true }).fill('012345');
    await page.getByRole('button', { name: 'Verify code', exact: true }).click();
    await expect(page.locator('#securitySuccess')).toBeVisible();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page).toHaveURL(/\/profile(?:\.html)?$/);
  });
}

test('200 percent text zoom and narrow layout keep all setup controls reachable', async ({ page, app }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await app.open(ROUTE_BY_ID.accountSecurity);
  await page.getByRole('button', { name: 'Set up authenticator' }).click();
  await expect(page.locator('#securityKey')).toHaveValue(syntheticKey);
  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
  await expectNoHorizontalOverflow(page);
  const code = page.getByLabel('Six-digit code', { exact: true });
  await code.scrollIntoViewIfNeeded();
  await code.fill('012345');
  await page.getByRole('button', { name: 'Verify code', exact: true }).click();
  await expect(page.locator('#securitySuccess')).toBeVisible();
  const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
  expect(viewport).not.toMatch(/user-scalable=no|maximum-scale=1/);
});

test('members without billing access can open setup from its direct route', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.accountSecurity, { state: 'memberLocked' });
  await expect(page.getByRole('button', { name: 'Set up authenticator' })).toBeEnabled();
  await expect(page).toHaveURL(/account-security/);
});

test('Profile exposes the account security setup entry point', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.profile);
  await page.getByRole('link', { name: 'Account security', exact: true }).click();
  await expect(page).toHaveURL(/account-security\.html$/);
  await expect(page.getByRole('button', { name: 'Set up authenticator' })).toBeEnabled();
});

test('delayed QR module cannot reveal an enrollment key after leaving the page', async ({ page, app }) => {
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const requested = new Promise((resolve) => { entered = resolve; });
  await page.route('**/qrcode.js*', async (route) => { entered(); await gate; await route.continue(); });
  await app.open(ROUTE_BY_ID.accountSecurity);
  await page.getByRole('button', { name: 'Set up authenticator' }).click();
  await requested;
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  release();
  await expect(page.locator('#securityKey')).toHaveValue('');
  await expect(page.locator('#securityQr')).not.toHaveAttribute('src');
  await expect(page.locator('#securityEnrollment')).toBeHidden();
});
