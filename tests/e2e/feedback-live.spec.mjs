import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { installFeedbackStub } from './support/feedback-supabase-stub.mjs';
import { FEEDBACK_ROUTES } from '../../src/static/feedback-route.mjs';
const widget = page => page.locator('[data-feedback-widget]');
const dialog = page => page.getByRole('dialog', { name: 'Send Feedback', exact: true });
const optional = /\/(?:feedback-(?:client|contract|context|dialog|widget))(?:-[\w-]+)?\.(?:mjs|js|css)(?:\?|$)/;
async function repeatSessionNotice(page, auth) {
  await page.waitForLoadState('networkidle');
  const before = auth.calls.filter(call => call.name === 'get_member_access_context').length;
  await page.evaluate(value => { const channel = new BroadcastChannel('sb-127-auth-token'); channel.postMessage({ event: 'SIGNED_IN', session: value }); channel.close(); }, auth.firstSession);
  await expect.poll(() => auth.calls.filter(call => call.name === 'get_member_access_context').length).toBeGreaterThan(before);
}
async function ready(page) {
  await page.goto('/profile.html'); await expect(widget(page)).toHaveCount(1);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await expect(widget(page)).toBeVisible();
}
async function reachableBottom(page) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  // The fixture can finish page hydration after feedback becomes eligible.
  // Model a user reaching the current bottom, not a smooth scroll to a stale
  // document height. Do not require network-idle: member pages can refresh.
  await expect.poll(async () => page.evaluate(async () => {
    window.scrollTo({ top: document.body.scrollHeight, left: 0, behavior: 'instant' });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return Math.abs(document.documentElement.scrollHeight - (window.scrollY + window.innerHeight)) <= 1;
  })).toBe(true);
  await expect(widget(page)).toBeVisible();
}
async function fill(page) {
  await page.getByRole('combobox', { name: 'Feedback type', exact: true }).selectOption('bug');
  await page.getByLabel('What happened or what would you like to change?', { exact: false }).fill('  My explicit feedback\n');
  await page.getByLabel('Expected or desired behavior', { exact: false }).fill('Original expected behavior');
  await page.getByRole('combobox', { name: 'Impact', exact: true }).selectOption('minor');
}
async function contactGeometry(page) {
  const check = page.getByRole('checkbox', { name: 'You may contact me about this feedback.', exact: true });
  const label = page.getByText('You may contact me about this feedback.', { exact: true });
  await label.scrollIntoViewIfNeeded();
  const control = await check.boundingBox(), text = await label.boundingBox(), panel = await dialog(page).boundingBox();
  expect(control.width).toBeGreaterThanOrEqual(16); expect(control.width).toBeLessThanOrEqual(24);
  expect(text.x).toBeGreaterThan(control.x + control.width);
  expect(text.x + text.width).toBeLessThanOrEqual(panel.x + panel.width - 8);
  expect(await page.locator('.feedback-form').evaluate(form => form.scrollWidth <= form.clientWidth + 1)).toBe(true);
}
test.beforeEach(async ({ context, page, baseURL }) => {
  const external = [], errors = [];
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== baseURL) { external.push(route.request().url()); return route.abort(); }
    return route.fallback();
  });
  await context.routeWebSocket(/.*/, ws => { external.push('websocket'); ws.close(); });
  page.on('pageerror', error => errors.push(error.message));
  page.__feedbackChecks = { external, errors };
});
test.afterEach(async ({ page }) => { expect(page.__feedbackChecks.external).toEqual([]); expect(page.__feedbackChecks.errors).toEqual([]); });
test('active EA saves exact explicit input and allowlisted context without collecting surrounding content', async ({ context, page }) => {
  const auth = await installFeedbackStub(context); await ready(page);
  await page.evaluate(() => { const text = document.createElement('textarea'); text.value = 'PRIVATE PAGE SENTINEL'; document.body.append(text); sessionStorage.setItem('private-sentinel', 'PRIVATE STORAGE SENTINEL'); });
  await widget(page).click(); await fill(page);
  await repeatSessionNotice(page, auth);
  await expect(page.getByLabel('What happened or what would you like to change?', { exact: false })).toHaveValue('  My explicit feedback\n');
  await page.getByRole('button', { name: 'Send feedback', exact: true }).click();
  await expect(dialog(page)).toContainText('Your feedback is saved.');
  expect(auth.writes()).toHaveLength(1); const body = auth.writes()[0].body;
  expect(body.target_input).toEqual({ type: 'bug', description: '  My explicit feedback\n', expectedBehavior: 'Original expected behavior', impact: 'minor', contactAllowed: false });
  expect(Object.keys(body.target_context).sort()).toEqual(['browser', 'buildSha', 'platform', 'route', 'theme', 'viewport']);
  expect(body.target_context.route).toBe('profile.html'); expect(body.target_context.buildSha).toBe('a'.repeat(40));
  expect(JSON.stringify(body)).not.toMatch(/PRIVATE PAGE|PRIVATE STORAGE|userAgent|email|url|referrer/);
  await page.getByRole('button', { name: 'Close', exact: true }).click(); await expect(widget(page)).toBeFocused();
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('My explicit feedback');
});
for (const options of [{ active: false }, { malformed: true }, { aal: 'aal1' }]) test(`feedback stays hidden for ${JSON.stringify(options)}`, async ({ context, page }) => {
  const auth = await installFeedbackStub(context, options);
  await context.addInitScript(() => localStorage.setItem('dominion:earlyAccessActive', 'true'));
  await page.goto('/profile.html');
  if (options.aal === 'aal1') await expect(page.getByRole('heading', { name: 'Verify your login', exact: true })).toBeVisible();
  else { await expect(page.locator('.global-menu-button')).toBeVisible(); await expect.poll(() => auth.calls.length).toBeGreaterThan(0); }
  await expect(widget(page)).toHaveCount(0); expect(auth.writes()).toEqual([]);
});
test('public, login, Security, Admin and invite routes never load or submit feedback', async ({ context, page }) => {
  const auth = await installFeedbackStub(context); const requested = [];
  page.on('request', request => { if (optional.test(request.url())) requested.push(request.url()); });
  for (const route of ['/index.html', '/support.html', '/login.html', '/account-security.html', '/admin.html', '/invite.html']) {
    await page.goto(route); await page.waitForLoadState('networkidle'); await expect(widget(page)).toHaveCount(0);
  }
  // Signed-in navigation may use the shared, read-only access RPC to choose
  // its destination. It must not load feedback code or submit anything.
  expect(requested).toEqual([]); expect(auth.writes()).toEqual([]);
  for (const call of auth.calls) {
    expect(call.name).toBe('get_member_access_context'); expect(call.method).toBe('POST');
    expect(call.body).toEqual({ target_expected_actor_id: auth.A });
  }
});

test('accepted EA has free access and retained beta pricing without Stripe requests or paid labels', async ({ context, page }, testInfo) => {
  const auth = await installFeedbackStub(context);
  await ready(page);
  await expect(page.locator('#profileBillingTitle')).toHaveText('Early access active');
  await expect(page.locator('#profileBillingCopy')).toContainText('free until beta begins');
  await expect(page.locator('#profileBillingCopy')).toContainText('$3.50/month');
  await expect(page.locator('#profileBillingCopy')).toContainText('cancel and return');
  await page.locator('#profileBillingCopy').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('early-access-profile.png') });
  await page.goto('/billing.html');
  await expect(page.locator('#billingStatusTitle')).toHaveText('This account has early access.');
  await expect(page.locator('#billingStatusCopy')).toContainText('You do not have a paid subscription through early access.');
  await expect(page.locator('#billingStatusCopy')).toContainText('$3.50/month');
  await expect(page.locator('#subscriptionButton')).toBeHidden();
  await expect(page.locator('#manageBillingButton')).toBeHidden();
  await page.locator('#billingStatusCopy').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('early-access-billing.png') });
  expect(auth.requests.filter(request => /subscriptions|checkout|portal|cancel-membership/.test(request.path))).toEqual([]);
});
test('uncertain receipt retry retains one intent across close, focus refresh and later EA lapse', async ({ context, page }) => {
  const auth = await installFeedbackStub(context); auth.mode('lost'); await ready(page); await widget(page).click(); await fill(page);
  await page.getByRole('button', { name: 'Send feedback', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry same submission' })).toBeVisible();
  await repeatSessionNotice(page, auth);
  await expect(page.getByRole('button', { name: 'Retry same submission' })).toBeVisible();
  await page.getByRole('button', { name: 'Close for now' }).click(); auth.active(false);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(widget(page)).toHaveAccessibleName('Retry feedback submission'); await widget(page).click();
  await expect(page.getByLabel('What happened or what would you like to change?', { exact: false })).toHaveValue('  My explicit feedback\n');
  await page.getByRole('button', { name: 'Retry same submission' }).click(); await expect(dialog(page)).toContainText('Your feedback is saved.');
  expect(auth.writes()).toHaveLength(2); expect(auth.writes()[0].body).toEqual(auth.writes()[1].body); expect(auth.receipts.size).toBe(1);
  await page.getByRole('button', { name: 'Close', exact: true }).click(); await expect(widget(page)).toBeHidden();
});
test('same-user replacement session synchronously scrubs held submission and late receipt cannot publish', async ({ context, page }) => {
  const auth = await installFeedbackStub(context); await ready(page); await widget(page).click(); await fill(page);
  const release = auth.hold();
  try {
    await page.getByRole('button', { name: 'Send feedback', exact: true }).click(); await expect.poll(() => auth.writes().length).toBe(1);
    const next = auth.replacement();
    const result = await page.evaluate(session => {
      localStorage.setItem('sb-127-auth-token', JSON.stringify(session));
      window.dispatchEvent(new StorageEvent('storage', { key: 'sb-127-auth-token', newValue: JSON.stringify(session) }));
      return { widget: Boolean(document.querySelector('[data-feedback-widget]')), form: Boolean(document.querySelector('.feedback-form')) };
    }, next);
    expect(result).toEqual({ widget: false, form: false }); release();
    await expect(page.locator('.feedback-form')).toHaveCount(0); await expect(page.locator('body')).not.toContainText('Your feedback is saved.');
  } finally { release(); }
});
test('all fourteen routes provide reachable bottom placement and hide rather than cover an action', async ({ context, page }) => {
  await installFeedbackStub(context, { memberPages: true });
  for (const route of FEEDBACK_ROUTES) await test.step(route, async () => {
    await page.goto(`/${route}`); await expect(widget(page)).toHaveCount(1);
    await reachableBottom(page);
    const box = await widget(page).boundingBox(); expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize().height + 1);
    await page.evaluate(rect => {
      const button = document.createElement('button'); button.id = 'synthetic-overlap-action'; button.textContent = 'Private synthetic action';
      Object.assign(button.style, { position: 'fixed', left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px`, zIndex: '1' });
      document.body.append(button);
    }, box);
    await expect(widget(page)).toBeHidden();
    await page.locator('#synthetic-overlap-action').click();
    await page.evaluate(rect => Object.assign(document.getElementById('synthetic-overlap-action').style,
      { top: `${rect.y + 8}px`, height: '16px' }), box);
    await expect(widget(page)).toBeHidden();
    await page.locator('#synthetic-overlap-action').click();
    await page.evaluate(() => document.getElementById('synthetic-overlap-action').remove());
    await reachableBottom(page);
  });
});
for (const theme of ['light', 'dark', 'dominion-night', 'dominion-platinum']) test(`${theme} native dialog focus, accessible form and viewport bounds`, async ({ context, page }, testInfo) => {
  await installFeedbackStub(context); await ready(page);
  await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
  const box = await widget(page).boundingBox(); const size = page.viewportSize();
  expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.x + box.width).toBeLessThanOrEqual(size.width); expect(box.y + box.height).toBeLessThanOrEqual(size.height);
  await widget(page).click(); await expect(page.getByRole('combobox', { name: 'Feedback type', exact: true })).toBeFocused();
  const panel = await dialog(page).boundingBox(); expect(panel.x).toBeGreaterThanOrEqual(0); expect(panel.x + panel.width).toBeLessThanOrEqual(size.width + 1);
  await contactGeometry(page);
  await page.getByRole('button', { name: 'Send feedback', exact: true }).scrollIntoViewIfNeeded();
  const action = await page.getByRole('button', { name: 'Send feedback', exact: true }).boundingBox();
  expect(action.y + action.height).toBeLessThanOrEqual(size.height + 1);
  expect((await new AxeBuilder({ page }).include('.app-dialog-layer[data-pattern="feedback"]').analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath(`${theme}-feedback.png`) });
  await page.keyboard.press('Escape'); await expect(widget(page)).toBeFocused();
});
test('tablet contact permission remains fully readable and operable without inner overflow', async ({ context, page }, testInfo) => {
  await page.setViewportSize({ width: 768, height: 1024 }); await installFeedbackStub(context); await ready(page); await widget(page).click();
  await contactGeometry(page);
  await page.getByText('You may contact me about this feedback.', { exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'You may contact me about this feedback.', exact: true })).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath('tablet-feedback.png') });
  await page.keyboard.press('Escape'); await expect(widget(page)).toBeFocused();
});
