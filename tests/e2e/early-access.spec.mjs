import { test, expect } from './support/app-test.mjs';
import { ROUTE_BY_ID } from './support/routes.mjs';
import { analyzeAccessibility, assertNoBlockingAxeViolations } from './support/quality-gates.mjs';

const receipts = (page) => page.evaluate(() => Object.keys(localStorage)
  .filter((key) => key.startsWith('dominion:preview:early-access:'))
  .map((key) => [key, JSON.parse(localStorage.getItem(key))]));
async function fill(page, name = 'Sam Example', email = 'sam@example.com') {
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Email', { exact: true }).fill(email);
}

test('Get Early Access opens a branded anonymous request form and saves one preview receipt', async ({ page, app }) => {
  const external = [];
  page.on('request', (request) => { if (/supabase\.co|stripe\.com/.test(request.url())) external.push(request.url()); });
  await app.open(ROUTE_BY_ID.membership, { state: 'guest' });
  await page.getByRole('link', { name: 'Get Early Access', exact: true }).click();
  await expect(page).toHaveURL(/#early-access$/);
  await expect(page.locator('#earlyAccessForm')).toBeVisible();
  await fill(page);
  await page.getByRole('button', { name: 'Request early access', exact: true }).click();
  await expect(page.locator('#earlyAccessStatus')).toContainText('Preview request saved in this browser only');
  await expect(page.locator('#earlyAccessForm')).toBeHidden();
  await expect(page.locator('#earlyAccessStatus')).toBeFocused();
  const first = await receipts(page);
  expect(first).toHaveLength(1);
  expect(first[0][0]).toMatch(/:[a-f0-9]{64}$/);
  expect(Object.keys(first[0][1]).sort()).toEqual(['createdAt', 'status']);
  expect(JSON.stringify(first)).not.toContain('sam@example.com');
  await page.reload();
  await fill(page, 'Sam Again', 'SAM@example.com');
  await page.getByRole('button', { name: 'Request early access', exact: true }).click();
  await expect(page.locator('#earlyAccessStatus')).toContainText('Preview request saved');
  expect(await receipts(page)).toEqual(first);
  expect(external).toEqual([]);
});

test('authenticated name and email prefill and account switching clears prior entered details', async ({ page, context, app }) => {
  await app.open(ROUTE_BY_ID.membership, { state: 'member' });
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Jordan Test');
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('qa.member@example.test');
  await expect(page.getByLabel('Email', { exact: true })).toHaveAttribute('readonly', '');
  await page.getByLabel('Name', { exact: true }).fill('Private first-account draft');
  const other = await context.newPage();
  await other.goto('/index.html');
  await other.evaluate(async () => {
    const api = await import('/src/static/api.js');
    api.saveLocalMockUser({ name: 'Second Account', email: 'second@example.test' });
  });
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Second Account');
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('second@example.test');
  await other.evaluate(async () => { const api = await import('/src/static/api.js'); await api.clearAuthSession(); });
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Email', { exact: true })).not.toHaveAttribute('readonly', '');
  expect(await receipts(page)).toEqual([]);
  await other.close();
});

test('validation and failed submission preserve the entered information for a clean retry', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.membership, { state: 'guest' });
  await fill(page, 'Sam Example', 'invalid');
  await page.getByRole('button', { name: 'Request early access', exact: true }).click();
  expect(await receipts(page)).toEqual([]);
  await page.getByLabel('Email', { exact: true }).fill('sam@example.com');
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    window.restoreEarlyAccessStorage = () => { Storage.prototype.setItem = original; };
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('dominion:preview:early-access:')) throw new Error('Fixture storage unavailable');
      return original.call(this, key, value);
    };
  });
  await page.getByRole('button', { name: 'Request early access', exact: true }).click();
  await expect(page.locator('#earlyAccessError')).toContainText('Your details are still here');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Sam Example');
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('sam@example.com');
  await expect(page.getByRole('button', { name: 'Request early access', exact: true })).toBeEnabled();
  await page.evaluate(() => window.restoreEarlyAccessStorage());
  await page.getByRole('button', { name: 'Request early access', exact: true }).click();
  await expect(page.locator('#earlyAccessStatus')).toContainText('Preview request saved');
  expect(await receipts(page)).toHaveLength(1);
});

test('loading blocks accidental resubmission and rejects an actor switch before storage', async ({ page, context, app }) => {
  await app.open(ROUTE_BY_ID.membership, { state: 'guest' });
  await fill(page);
  await page.evaluate(() => {
    const original = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = async (...args) => {
      await new Promise((resolve) => { window.releaseEarlyAccessDigest = resolve; });
      return original(...args);
    };
  });
  await page.getByRole('button', { name: 'Request early access', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sending request…', exact: true })).toBeDisabled();
  await expect(page.locator('#earlyAccessForm')).toHaveAttribute('aria-busy', 'true');
  const other = await context.newPage();
  await other.goto('/index.html');
  await other.evaluate(async () => {
    const api = await import('/src/static/api.js');
    api.saveLocalMockUser({ name: 'New Account', email: 'new@example.test' });
  });
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('new@example.test');
  await page.evaluate(() => window.releaseEarlyAccessDigest());
  await expect(page.locator('#earlyAccessStatus')).toHaveText('');
  expect(await receipts(page)).toEqual([]);
  await other.close();
});

test('early-access controls are accessible, responsive, and usable in forced colors', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.membership, { state: 'guest' });
  await page.locator('#early-access').scrollIntoViewIfNeeded();
  const result = await analyzeAccessibility(page);
  assertNoBlockingAxeViolations(result);
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const metrics = await page.getByLabel('Email', { exact: true }).evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      width: element.getBoundingClientRect().width,
      font: Number.parseFloat(getComputedStyle(element).fontSize),
      overflow: document.documentElement.scrollWidth > innerWidth,
    }));
    expect(metrics.height).toBeGreaterThanOrEqual(44);
    expect(metrics.width).toBeGreaterThan(200);
    expect(metrics.font).toBeGreaterThanOrEqual(16);
    expect(metrics.overflow).toBe(false);
    await page.locator('#early-access').screenshot({ path: test.info().outputPath(`early-access-${width}.png`) });
  }
  await page.emulateMedia({ forcedColors: 'active' });
  await page.getByLabel('Name', { exact: true }).focus();
  await page.keyboard.type('Keyboard Member');
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Email', { exact: true })).toBeFocused();
});

test('page exit scrubs personal drafts and BFCache restoration rechecks the current account', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.membership, { state: 'member' });
  await page.getByLabel('Name', { exact: true }).fill('Private cached draft');
  const scrubbed = await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    const form = document.getElementById('earlyAccessForm');
    return { hidden: form.hidden, name: form.elements.name.value, email: form.elements.email.value,
      busy: form.getAttribute('aria-busy'), status: document.getElementById('earlyAccessStatus').textContent,
      error: document.getElementById('earlyAccessError').textContent };
  });
  expect(scrubbed).toEqual({ hidden: true, name: '', email: '', busy: 'false', status: '', error: '' });
  await page.evaluate(async () => {
    const api = await import('/src/static/api.js');
    api.saveLocalMockUser({ name: 'Restored Account', email: 'restored@example.test' });
    window.dispatchEvent(new StorageEvent('storage', { key: 'dominion:user' }));
  });
  await expect(page.locator('#earlyAccessForm')).toBeHidden();
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('');
  await Promise.all([
    page.waitForEvent('load'),
    page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))),
  ]);
  await expect(page.locator('#earlyAccessForm')).toBeVisible();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Restored Account');
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('restored@example.test');
});

test('late submission results cannot repopulate a page after its lifecycle has ended', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.membership, { state: 'guest' });
  await fill(page);
  await page.evaluate(() => {
    const original = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = async (...args) => {
      await new Promise((resolve) => { window.releaseEarlyAccessDigest = resolve; });
      return original(...args);
    };
  });
  await page.getByRole('button', { name: 'Request early access', exact: true }).click();
  await expect(page.locator('#earlyAccessForm')).toHaveAttribute('aria-busy', 'true');
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.releaseEarlyAccessDigest();
  });
  // A request already sent may finish; its response must not restore cached UI.
  await expect.poll(async () => (await receipts(page)).length).toBe(1);
  await expect(page.locator('#earlyAccessForm')).toBeHidden();
  await expect(page.locator('#earlyAccessForm')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#earlyAccessStatus')).toHaveText('');
  await expect(page.locator('#earlyAccessError')).toHaveText('');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('');
});

test('without JavaScript no request can send personal details in a URL', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(baseURL + '/membership.html');
  await expect(page.locator('#earlyAccessForm')).toBeHidden();
  await expect(page.locator('#earlyAccessForm')).toHaveAttribute('method', 'post');
  await expect(page.getByText('Please enable JavaScript to submit the request form.', { exact: true })).toBeVisible();
  await context.close();
});
