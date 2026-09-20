import { test, expect } from '@playwright/test';
import { installMfaSupabaseStub } from './support/mfa-supabase-auth-stub.mjs';

async function observeNavigationErrors(page, testInfo) {
  // WebKit may report a JavaScript fetch diagnostic as Playwright pageerror
  // without dispatching window.error/unhandledrejection. Keep all three and
  // the initiating document in the artifact; do not filter any page errors.
  const events = [];
  const record = (kind, value = {}) => events.push({ time: Date.now(), kind, ...value });
  page.on('pageerror', error => record('pageerror', { name: error.name, message: error.message, stack: error.stack }));
  page.on('request', request => {
    if (request.isNavigationRequest() || request.url().includes('get_site_admin_context')) record('request', { path: new URL(request.url()).pathname, method: request.method(), navigation: request.isNavigationRequest() });
  });
  page.on('requestfailed', request => {
    if (request.url().includes('get_site_admin_context')) record('requestfailed', { path: new URL(request.url()).pathname, failure: request.failure()?.errorText });
  });
  page.on('response', response => {
    if (response.url().includes('get_site_admin_context')) record('response', { path: new URL(response.url()).pathname, status: response.status() });
  });
  await page.exposeFunction('__recordAuthNavigation', value => record('window', value));
  await page.addInitScript(() => {
    const note = (event, extra = {}) => { void window.__recordAuthNavigation({ at: Date.now(), event, path: location.pathname, state: document.visibilityState, ...extra }).catch(() => {}); };
    for (const event of ['beforeunload', 'pagehide', 'pageshow']) window.addEventListener(event, () => note(event));
    window.addEventListener('error', event => note('error', { message: event.message, name: event.error?.name }));
    window.addEventListener('unhandledrejection', event => note('unhandledrejection', { message: event.reason?.message, name: event.reason?.name }));
    const nativeFetch = window.fetch;
    window.fetch = function(input, init) {
      if (String(input).includes('get_site_admin_context')) note('admin-fetch', { aborted: Boolean(init?.signal?.aborted) });
      if (/\/(get_reward_catalog|get_theme_preference|set_theme_preference)(?:\?|$)/.test(String(input))) {
        note('theme-fetch', { endpoint: new URL(String(input), location.href).pathname, aborted: Boolean(init?.signal?.aborted) });
      }
      // Return the original promise, without catching application rejections.
      return nativeFetch.call(this, input, init);
    };
  });
  return {
    events,
    attach: async () => testInfo.attach('auth-navigation-events', { body: JSON.stringify(events, null, 2), contentType: 'application/json' }),
  };
}

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

test('shared menu reports logout outage without navigation or an unhandled rejection', async ({ context, page }, testInfo) => {
  const diagnostics = await observeNavigationErrors(page, testInfo);
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
  await diagnostics.attach();
  expect(diagnostics.events.some(event => event.event === 'admin-fetch' && event.path === '/support.html')).toBe(true);
  expect(diagnostics.events.filter(event => event.event === 'admin-fetch' && event.path === '/login.html')).toEqual([]);
  expect(diagnostics.events.filter(event => event.event === 'theme-fetch' && event.path === '/login.html')).toEqual([]);
  expect(diagnostics.events.some(event => event.event === 'theme-fetch' && event.path === '/support.html')).toBe(true);
  expect(diagnostics.events.filter(event => ['error', 'unhandledrejection'].includes(event.event))).toEqual([]);
  expect(pageErrors).toEqual([]);
});

for (const route of ['login', 'register', 'forgot-password', 'reset-password']) {
  test(`authenticated ${route} entry omits Admin readiness on load, menu open, and refocus`, async ({ context, page }) => {
    const auth = await installMfaSupabaseStub(context, { enrolled: false });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await login(page, './support.html');
    await expect(page).toHaveURL(/\/support\.html$/);
    await page.waitForLoadState('networkidle');
    const adminRequests = () => auth.requests.filter(request => request.path === '/rest/v1/rpc/get_site_admin_context');
    // A real SDK-authenticated member still asks for canonical readiness on
    // Support. Route admission is not a global disable or a role fallback.
    expect(adminRequests().some(request => request.aal === 'aal1')).toBe(true);
    const before = adminRequests().length;
    const themeRequests = () => auth.requests.filter(request => ['/rest/v1/rpc/get_reward_catalog', '/rest/v1/rpc/get_theme_preference'].includes(request.path));
    const themesBefore = themeRequests().length;
    await page.goto(`/${route}.html`);
    await expect(page).toHaveURL(new RegExp(`/${route}\\.html$`));
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Open menu', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Log Out', exact: true })).toBeVisible();
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForLoadState('networkidle');
    expect(adminRequests().slice(before)).toEqual([]);
    expect(themeRequests().length).toBeGreaterThan(themesBefore, 'Authenticated same-route theme hydration is preserved.');
    await expect(page.locator('[data-admin-menu-item]')).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });
}

test('delayed Login profile validation pauses optional theme work and failure resumes a retryable same-document session', async ({ context, page }, testInfo) => {
  const diagnostics = await observeNavigationErrors(page, testInfo);
  const auth = await installMfaSupabaseStub(context, { enrolled: false });
  const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
  let release; const gate = new Promise(resolve => { release = resolve; });
  let first = true;
  await page.route('**/__mfa_fixture__/rest/v1/profiles*', async route => {
    if (!first) return route.fallback();
    first = false;
    await gate;
    // The SDK retries transient 503 reads. A non-transient validation failure
    // makes this attempt actually return to its form instead of auto-succeeding.
    return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ code: '42501', message: 'Synthetic profile validation unavailable' }) });
  });
  page.on('dialog', dialog => dialog.dismiss());
  try {
    const profile = page.waitForRequest('**/__mfa_fixture__/rest/v1/profiles*');
    await login(page, './support.html');
    await profile;
    await expect(page.getByRole('button', { name: 'Working...', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Open menu', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Log Out', exact: true })).toBeVisible();
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
    expect(auth.requests.filter(request => /\/(get_reward_catalog|get_theme_preference)$/.test(request.path))).toEqual([]);
    expect(auth.requests.filter(request => request.path === '/auth/v1/user').length).toBeGreaterThanOrEqual(4);
    await page.getByRole('button', { name: 'Close menu', exact: true }).click();
    const resumedTheme = page.waitForResponse('**/__mfa_fixture__/rest/v1/rpc/get_theme_preference');
    release();
    await expect(page.getByRole('button', { name: 'Go to dashboard', exact: true })).toBeEnabled();
    await resumedTheme;
    await page.waitForLoadState('networkidle');
    expect(auth.requests.some(request => request.path === '/rest/v1/rpc/get_theme_preference')).toBe(true);
    const beforeRetry = diagnostics.events.filter(event => event.event === 'theme-fetch' && event.path === '/login.html').length;
    await page.getByRole('button', { name: 'Go to dashboard', exact: true }).click();
    await expect(page).toHaveURL(/\/support\.html$/);
    await page.waitForLoadState('networkidle');
    expect(diagnostics.events.filter(event => event.event === 'theme-fetch' && event.path === '/login.html')).toHaveLength(beforeRetry);
    expect(diagnostics.events.filter(event => ['error', 'unhandledrejection'].includes(event.event))).toEqual([]);
    expect(pageErrors).toEqual([]);
  } finally { release(); await diagnostics.attach(); }
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
