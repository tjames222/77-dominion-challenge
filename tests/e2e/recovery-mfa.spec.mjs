import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { installRecoveryStub } from './support/recovery-auth-stub.mjs';

const externalRequests = new WeakMap();
test.beforeEach(async ({ context, baseURL }) => {
  const unexpected = []; externalRequests.set(context, unexpected);
  await context.route(url => ['http:', 'https:'].includes(url.protocol) && url.origin !== new URL(baseURL).origin, async route => {
    unexpected.push({ origin: new URL(route.request().url()).origin, method: route.request().method() });
    await route.abort('blockedbyclient');
  });
});
test.afterEach(async ({ context }) => { expect(externalRequests.get(context)).toEqual([]); });

async function openRecovery(page, auth) {
  await page.goto(auth.recoveryUrl());
  await expect(page).toHaveURL(/\/reset-password\.html$/);
}
async function verify(page, code = '654321') {
  await page.getByLabel('Six-digit code', { exact: true }).fill(code);
  await page.getByRole('button', { name: 'Verify authenticator', exact: true }).click();
}

test('existing authenticator unlocks same-page password recovery with private derived authorization', async ({ context, page, baseURL }, testInfo) => {
  const auth = await installRecoveryStub(context, { baseURL });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await openRecovery(page, auth);
  await expect(page.locator('#passwordRecoveryMfaForm')).toBeVisible();
  await expect(page.locator('#passwordResetForm')).toBeHidden();
  await expect(page.getByLabel('Six-digit code', { exact: true })).toBeFocused();
  // Visibility/focus can precede the real 680ms reveal transition. Measure the
  // rendered card, not an intermediate translucent frame; keep every axe rule.
  await expect(page.locator('.auth-card')).toHaveClass(/is-visible/);
  await expect(page.locator('.auth-card')).toHaveCSS('opacity', '1');
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('recovery-authenticator.png'), fullPage: true });
  await verify(page);
  await expect(page.getByLabel('New password', { exact: true })).toBeEnabled();
  await expect(page.locator('#passwordRecoveryMfa')).toBeHidden();
  await expect(page.getByLabel('Six-digit code', { exact: true })).toHaveValue('');
  await auth.assertAnchorUnchanged(page, expect);
  await page.getByLabel('New password', { exact: true }).fill('Synthetic-New-Password-Only!');
  await page.getByLabel('Confirm new password', { exact: true }).fill('Synthetic-New-Password-Only!');
  await page.getByRole('button', { name: 'Save new password', exact: true }).click();
  await expect(page.locator('#passwordResetComplete')).toBeVisible();
  await expect(page.locator('#passwordResetFeedback')).toContainText('Password changed');
  expect(auth.requests.filter(r => r.path === '/auth/v1/user' && r.method === 'PUT')).toEqual([
    { path: '/auth/v1/user', method: 'PUT', aal: 'aal2', actor: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', owner: 'derived' },
  ]);
  expect(auth.requests.filter(r => r.path === '/auth/v1/logout').every(r => r.owner === 'derived')).toBe(true);
  await auth.assertAnchorUnchanged(page, expect);
  expect(errors).toEqual([]);
  await page.getByRole('link', { name: 'Log in with your new password', exact: true }).click();
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('button', { name: 'Go to dashboard', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/login\.html(?:\?.*)?$/);
});

test('a rejected code is clearly retryable and uses a fresh challenge', async ({ context, page, baseURL }) => {
  const auth = await installRecoveryStub(context, { baseURL });
  await openRecovery(page, auth);
  await verify(page, '000000');
  await expect(page.locator('#passwordResetFeedback')).toContainText('not accepted');
  await expect(page.getByRole('button', { name: 'Verify authenticator', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Six-digit code', { exact: true })).toHaveValue('');
  await verify(page);
  await expect(page.getByLabel('New password', { exact: true })).toBeEnabled();
  expect(auth.requests.filter(r => r.path.endsWith('/challenge'))).toHaveLength(2);
  expect(auth.requests.filter(r => r.method === 'PUT')).toHaveLength(0);
});

test('another account response cannot unlock recovery', async ({ context, page, baseURL }) => {
  const auth = await installRecoveryStub(context, { baseURL, wrongActor: true });
  await openRecovery(page, auth);
  await verify(page);
  await expect(page.locator('#passwordRecoveryMfa')).toBeHidden();
  await expect(page.getByLabel('New password', { exact: true })).toBeDisabled();
  await expect(page.locator('#passwordResetFeedback')).not.toContainText('Choose a new password');
  expect(auth.requests.filter(r => r.method === 'PUT')).toHaveLength(0);
  await auth.assertAnchorUnchanged(page, expect);
});

test('an account replacement during verification retires the page without touching the replacement', async ({ context, page, baseURL }) => {
  const auth = await installRecoveryStub(context, { baseURL });
  await openRecovery(page, auth);
  const release = auth.holdVerification();
  try {
    const pending = page.waitForRequest(request => new URL(request.url()).pathname.endsWith('/verify'));
    await verify(page);
    await pending;
    await auth.replaceAccount(page);
    release();
    await expect(page.getByLabel('New password', { exact: true })).toBeDisabled();
    await expect(page.locator('#passwordRecoveryMfa')).toBeHidden();
    await page.waitForLoadState('networkidle');
    expect(auth.requests.filter(r => r.method === 'PUT' || r.path.endsWith('/logout'))).toEqual([]);
  } finally { release(); }
});

test('recovery without an enrolled authenticator preserves the existing password flow', async ({ context, page, baseURL }) => {
  const auth = await installRecoveryStub(context, { baseURL, enrolled: false });
  await openRecovery(page, auth);
  await expect(page.getByLabel('New password', { exact: true })).toBeEnabled();
  await expect(page.locator('#passwordRecoveryMfa')).toBeHidden();
  expect(auth.requests.filter(r => r.path.includes('/factors'))).toEqual([]);
});
