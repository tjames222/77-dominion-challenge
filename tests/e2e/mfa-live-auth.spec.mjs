import { test, expect } from '@playwright/test';
import { installMfaSupabaseStub } from './support/mfa-supabase-auth-stub.mjs';

async function login(page, returnTo = '') {
  await page.goto(`/login.html${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}`);
  await page.getByLabel('Email', { exact: true }).fill('mfa.synthetic@example.test');
  await page.getByLabel('Password', { exact: true }).fill('Synthetic-Only-Password!');
  await page.getByRole('button', { name: 'Go to dashboard', exact: true }).click();
}
async function fakeDestination(context, path) {
  await context.route((url) => url.pathname === path, async (route) => {
    if (!route.request().isNavigationRequest()) return route.continue();
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en"><title>Safe continuation fixture</title><h1>Safe continuation fixture</h1></html>' });
  });
}
async function verify(page) {
  await page.getByLabel('Six-digit code', { exact: true }).fill('654321');
  await page.getByRole('button', { name: 'Verify code', exact: true }).click();
  await expect(page.locator('#securitySuccess')).toBeVisible();
}

test('Account Security challenge has no menu hydration or private reads on load and refocus', async ({ context, page }) => {
  const auth = await installMfaSupabaseStub(context);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await login(page, './support.html');
  await expect(page.locator('#securityVerifyForm')).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(auth.privateRequests()).toEqual([]);
  await expect(page.locator('.global-menu, .global-menu-button, .shared-header-share, .shared-header-streak, .site-training-layer')).toHaveCount(0);
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#securityVerifyForm')).toBeVisible();
  expect(auth.privateRequests()).toEqual([]);
  expect(errors).toEqual([]);
});

for (const enrolled of [false, true]) {
  test(`provider sign-out outage remains retryable and clears MFA secrets (${enrolled ? 'existing challenge' : 'new enrollment'})`, async ({ context, page }) => {
    const auth = await installMfaSupabaseStub(context, { enrolled });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await login(page, './account-security.html');
    if (enrolled) await expect(page.locator('#securityVerifyForm')).toBeVisible();
    else {
      await page.getByRole('button', { name: 'Set up authenticator' }).click();
      await expect(page.locator('#securityKey')).toHaveValue('JBSWY3DPEHPK3PXP');
    }
    await page.getByLabel('Six-digit code', { exact: true }).fill('654321');
    auth.setLogoutOutage();
    await page.getByRole('button', { name: enrolled ? 'Sign out instead' : 'Sign out', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Sign out could not be confirmed. Retry signing out before leaving this device.');
    await expect(page).toHaveURL(/account-security\.html/);
    await expect(page.locator('#securityKey')).toHaveValue('');
    await expect(page.locator('#securityQr')).not.toHaveAttribute('src');
    await expect(page.locator('#securityCode')).toHaveValue('');
    await expect(page.locator('#securitySuccess')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeEnabled();
    expect(await page.evaluate(() => Boolean(JSON.parse(localStorage.getItem('sb-127-auth-token') || 'null')?.access_token))).toBe(true);
    const exposed = await page.evaluate(() => [document.body.textContent, JSON.stringify({ ...localStorage, ...sessionStorage })].join(' '));
    expect(exposed).not.toMatch(/JBSWY3DPEHPK3PXP|SYNTHETIC_PRIVATE_LOGOUT_RESPONSE/);
    auth.setLogoutOutage(false);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page).toHaveURL(/\/login\.html$/);
    expect(await page.evaluate(() => localStorage.getItem('sb-127-auth-token'))).toBeNull();
    expect(pageErrors).toEqual([]);
  });
}

test('shared menu reports logout outage without navigation or an unhandled rejection', async ({ context, page }) => {
  const auth = await installMfaSupabaseStub(context, { enrolled: false });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await login(page, './support.html');
  await expect(page).toHaveURL(/\/support\.html$/);
  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  auth.setLogoutOutage();
  const logout = page.getByRole('button', { name: 'Log Out', exact: true });
  await logout.click();
  await expect(page.locator('.global-menu-logout-feedback')).toHaveText('Sign out could not be confirmed. Retry signing out before leaving this device.');
  await expect(logout).toBeEnabled();
  await expect(logout).toBeFocused();
  await expect(page).toHaveURL(/\/support\.html$/);
  expect(await page.evaluate(() => Boolean(JSON.parse(localStorage.getItem('sb-127-auth-token') || 'null')?.access_token))).toBe(true);
  auth.setLogoutOutage(false);
  await logout.click();
  await expect(page).toHaveURL(/\/index\.html$/);
  expect(await page.evaluate(() => localStorage.getItem('sb-127-auth-token'))).toBeNull();
  expect(pageErrors).toEqual([]);
});

for (const outage of [false, true]) {
  test(`shared menu cancels pending Admin readiness without an unhandled rejection during ${outage ? 'failed' : 'successful'} logout`, async ({ context, page }) => {
    const auth = await installMfaSupabaseStub(context, { enrolled: false });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await login(page, './support.html');
    await expect(page).toHaveURL(/\/support\.html$/);
    await page.waitForLoadState('networkidle');
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/rest/v1/rpc/get_site_admin_context', async route => {
      await gate;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        schemaVersion: 1, actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        role: 'member', adminReady: false, permissions: [],
      }) });
    });
    try {
      const pending = page.waitForRequest('**/rest/v1/rpc/get_site_admin_context');
      await page.getByRole('button', { name: 'Open menu', exact: true }).click();
      await pending;
      auth.setLogoutOutage(outage);
      await page.getByRole('button', { name: 'Log Out', exact: true }).click();
      if (outage) {
        await expect(page.locator('.global-menu-logout-feedback')).toHaveText('Sign out could not be confirmed. Retry signing out before leaving this device.');
        await expect(page).toHaveURL(/\/support\.html$/);
      } else {
        await expect(page).toHaveURL(/\/index\.html$/);
        expect(await page.evaluate(() => localStorage.getItem('sb-127-auth-token'))).toBeNull();
      }
      release();
      await page.waitForLoadState('networkidle');
      await expect(page.locator('[data-admin-menu-item]')).toHaveCount(0);
      expect(pageErrors).toEqual([]);
    } finally { release(); }
  });
}

for (const [target, destination] of [['./invite.html', '/invite.html'], ['./community.html?intent=challenge-start', '/community.html']]) {
  test(`live SDK login challenges before private hydration and preserves ${destination}`, async ({ context, page }) => {
    const auth = await installMfaSupabaseStub(context);
    await fakeDestination(context, destination);
    await login(page, target);
    await expect(page).toHaveURL(/account-security\.html\?mode=challenge/);
    await expect(page.locator('#securityVerifyForm')).toBeVisible();
    await expect(page.locator('#securitySetup')).toBeHidden();
    await expect(page.locator('#securityPreview')).toBeHidden();
    expect(auth.privateRequests()).toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem('dominion:user'))).toBeNull();
    // Returning to Login with a pending enrolled session also cannot hydrate
    // private menu/theme data or skip the existing authenticator.
    await page.goto(`/login.html?returnTo=${encodeURIComponent(target)}`);
    await expect(page).toHaveURL(/account-security\.html\?mode=challenge/);
    expect(auth.privateRequests()).toEqual([]);
    await page.getByLabel('Six-digit code', { exact: true }).fill('012345');
    await page.getByRole('button', { name: 'Verify code', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('current six-digit code');
    await expect(page.locator('#securitySuccess')).toBeHidden();
    expect(auth.privateRequests()).toEqual([]);
    await verify(page);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${destination.replace('.', '\\.')}${destination.includes('community') ? '\\?intent=challenge-start' : ''}$`));
    expect(auth.privateRequests().every((request) => request.aal === 'aal2')).toBe(true);
    expect(page.url()).not.toMatch(/access_token|refresh_token|secret|code=/);
  });
}

test('normal password login without an enrolled factor preserves billing routing', async ({ context, page }) => {
  const auth = await installMfaSupabaseStub(context, { enrolled: false });
  await fakeDestination(context, '/billing.html');
  await login(page);
  await expect(page).toHaveURL(/\/billing\.html$/);
  expect(auth.requests.some((request) => request.path === '/rest/v1/profiles')).toBe(true);
  expect(auth.requests.some((request) => request.path === '/rest/v1/entitlements')).toBe(true);
  expect(auth.requests.some((request) => request.path.includes('/factors/'))).toBe(false);
});

test('enrolled login completes MFA before default billing routing', async ({ context, page }) => {
  const auth = await installMfaSupabaseStub(context);
  await fakeDestination(context, '/billing.html');
  await login(page);
  await expect(page.locator('#securityVerifyForm')).toBeVisible();
  expect(auth.privateRequests()).toEqual([]);
  await verify(page);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page).toHaveURL(/\/billing\.html$/);
  expect(auth.privateRequests().every((request) => request.aal === 'aal2')).toBe(true);
});

test('live enrollment is user-initiated and clears setup data only after provider confirmation', async ({ context, page }) => {
  const auth = await installMfaSupabaseStub(context, { enrolled: false });
  await login(page, './account-security.html');
  await expect(page.getByRole('button', { name: 'Set up authenticator' })).toBeEnabled();
  expect(auth.requests.some((request) => request.path === '/auth/v1/factors')).toBe(false);
  await page.getByRole('button', { name: 'Set up authenticator' }).click();
  await expect(page.locator('#securityKey')).toHaveValue('JBSWY3DPEHPK3PXP');
  await expect(page.locator('#securityPreview')).toBeHidden();
  await verify(page);
  await expect(page.locator('#securityKey')).toHaveValue('');
  await expect(page.locator('#securityQr')).not.toHaveAttribute('src');
  expect(auth.requests.filter((request) => request.path === '/auth/v1/factors' && request.method === 'POST')).toHaveLength(1);
  expect(auth.requests.some((request) => request.method === 'DELETE')).toBe(false);
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(stored).not.toContain('JBSWY3DPEHPK3PXP');
});

test('explicit step-up asks for a fresh code even on an already AAL2 session', async ({ context, page }) => {
  const auth = await installMfaSupabaseStub(context);
  await login(page);
  await verify(page);
  const previous = auth.requests.filter((request) => request.path.endsWith('/verify')).length;
  await page.goto('/account-security.html?mode=step-up&returnTo=%2Fprofile.html');
  await expect(page.getByRole('heading', { name: 'Verify it’s you', exact: true })).toBeVisible();
  await expect(page.locator('#securitySuccess')).toBeHidden();
  await verify(page);
  expect(auth.requests.filter((request) => request.path.endsWith('/verify'))).toHaveLength(previous + 1);
});

test('lost enrollment response clears the key and retries the now-verified factor from AAL1', async ({ context, page }) => {
  const auth = await installMfaSupabaseStub(context, { enrolled: false });
  await login(page, './account-security.html');
  await page.getByRole('button', { name: 'Set up authenticator' }).click();
  await expect(page.locator('#securityKey')).toHaveValue('JBSWY3DPEHPK3PXP');
  auth.loseNextVerificationResponse();
  await page.getByLabel('Six-digit code', { exact: true }).fill('654321');
  await page.getByRole('button', { name: 'Verify code', exact: true }).click();
  await expect(page.locator('#securityKey')).toHaveValue('');
  await expect(page.locator('#securityQr')).not.toHaveAttribute('src');
  await expect(page.locator('#securitySuccess')).toBeHidden();
  await expect(page.locator('#securityVerifyForm')).toBeVisible();
  await expect(page.locator('#securitySetup')).toBeHidden();
  await verify(page);
  expect(auth.requests.filter((request) => request.path === '/auth/v1/factors')).toHaveLength(1);
  expect(auth.requests.some((request) => request.method === 'DELETE')).toBe(false);
});

test('same-session SIGNED_IN and phone refocus retain setup; a new immutable session clears it', async ({ context, page }) => {
  const auth = await installMfaSupabaseStub(context, { enrolled: false });
  await login(page, './account-security.html');
  await page.getByRole('button', { name: 'Set up authenticator' }).click();
  await expect(page.locator('#securityKey')).toHaveValue('JBSWY3DPEHPK3PXP');
  const other = await context.newPage();
  // The synthetic provider deliberately confirms the same session_id while
  // rotating the access token. The actual SDK broadcasts SIGNED_IN across tabs.
  await login(other, './account-security.html');
  await expect(other.getByRole('button', { name: 'Set up authenticator' })).toBeEnabled();
  await page.bringToFront();
  await expect(page.locator('#securityKey')).toHaveValue('JBSWY3DPEHPK3PXP');
  await expect(page.locator('#securityVerifyForm')).toBeVisible();
  auth.rotateSession();
  await login(other, './account-security.html');
  await expect(other.getByRole('button', { name: 'Set up authenticator' })).toBeEnabled();
  await page.bringToFront();
  await expect(page.locator('#securityKey')).toHaveValue('');
  await expect(page.locator('#securityQr')).not.toHaveAttribute('src');
  await expect(page.locator('#securityVerifyForm')).toBeHidden();
  await expect(page.getByRole('status')).toContainText('signed-in account changed');
  await other.close();
});

for (const action of ['Cancel setup', 'Sign out']) {
  test(`${action} during pending verification clears secrets and prevents late session promotion`, async ({ context, page }) => {
    const auth = await installMfaSupabaseStub(context, { enrolled: false });
    await login(page, './account-security.html');
    await page.getByRole('button', { name: 'Set up authenticator' }).click();
    await expect(page.locator('#securityKey')).toHaveValue('JBSWY3DPEHPK3PXP');
    const release = auth.holdVerification();
    await page.getByLabel('Six-digit code', { exact: true }).fill('654321');
    await page.getByRole('button', { name: 'Verify code', exact: true }).click();
    await expect.poll(() => auth.requests.filter((request) => request.path.endsWith('/verify')).length).toBe(1);
    await page.getByRole('button', { name: action, exact: true }).click();
    if (action === 'Sign out') await expect(page).toHaveURL(/\/login\.html$/);
    else {
      await expect(page.locator('#securityKey')).toHaveValue('');
      await expect(page.locator('#securityQr')).not.toHaveAttribute('src');
      await expect(page.locator('#securitySuccess')).toBeHidden();
      await expect(page.getByRole('button', { name: 'Set up authenticator' })).toBeEnabled();
    }
    release();
    const assurance = await page.evaluate(() => {
      const stored = JSON.parse(localStorage.getItem('sb-127-auth-token') || 'null');
      if (!stored?.access_token) return null;
      return JSON.parse(atob(stored.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).aal;
    });
    expect(assurance).toBe(action === 'Sign out' ? null : 'aal1');
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
    expect(stored).not.toContain('JBSWY3DPEHPK3PXP');
    expect(auth.requests.some((request) => request.method === 'DELETE')).toBe(false);
  });
}
