import { test, expect } from './support/app-test.mjs';
import { ROUTE_BY_ID } from './support/routes.mjs';

test('the preview notice arrives in Community HTML before hydration can move the page', async ({ request }) => {
  const response = await request.get('/community.html');
  const html = await response.text();
  expect(html).toMatch(/class="community-feedback active" id="communityFeedback"[^>]*>Preview mode:/);
});

for (const route of [ROUTE_BY_ID.landing, ROUTE_BY_ID.login, ROUTE_BY_ID.dashboard, ROUTE_BY_ID.badgesRewards]) {
  test(`${route.id} loads only the everyday font and defers the share UI`, async ({ page, app }) => {
    const requests = [];
    page.on('request', (request) => requests.push(request.url()));
    await app.open(route);
    expect(requests.some((url) => /\/InterLatinUI(?:-[\w-]+)?\.woff2/.test(url))).toBe(true);
    expect(requests.filter((url) => /\/InterVariable(?:-[\w-]+)?\.woff2/.test(url))).toEqual([]);
    expect(requests.filter((url) => /\/share-composer(?!-loader)(?:-[\w-]+)?\.(?:js|css)(?:\?|$)/.test(url))).toEqual([]);
    await expect(page.locator('#shareComposerDialog')).toHaveCount(0);
    const bodyTrigger = page.locator('.share-entry-button').first();
    let triggerBefore = null;
    if (await bodyTrigger.count()) {
      triggerBefore = await bodyTrigger.evaluate((button) => ({
        height: button.getBoundingClientRect().height,
        radius: getComputedStyle(button).borderRadius,
        weight: getComputedStyle(button).fontWeight,
      }));
      expect(triggerBefore.height).toBeGreaterThanOrEqual(44);
      expect(triggerBefore.radius).toBe('999px');
      expect(triggerBefore.weight).toBe('900');
    }
    const share = page.locator('.shared-header-share');
    if (await share.count()) {
      await share.click();
      await expect(page.getByRole('dialog', { name: 'Choose what you want to send' })).toBeVisible();
      expect(requests.some((url) => /\/share-composer(?!-loader)(?:-[\w-]+)?\.(?:js|css)(?:\?|$)/.test(url))).toBe(true);
      await page.keyboard.press('Escape');
      await expect(share).toBeFocused();
      if (triggerBefore) {
        expect(await bodyTrigger.evaluate((button) => ({
          height: button.getBoundingClientRect().height,
          radius: getComputedStyle(button).borderRadius,
          weight: getComputedStyle(button).fontWeight,
        }))).toEqual(triggerBefore);
      }
    }
    app.assertNoRuntimeErrors();
  });
}

test('extended-language text loads the original font only when needed', async ({ page, app }) => {
  const fonts = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'font') fonts.push(request.url());
  });
  await app.open(ROUTE_BY_ID.landing);
  expect(fonts.some((url) => /InterVariable/.test(url))).toBe(false);
  await page.evaluate(async () => {
    const text = document.createElement('p');
    text.textContent = 'Ānne · Ελληνικά · Кириллица';
    document.querySelector('main').append(text);
    await document.fonts.load('400 16px "Inter"', text.textContent);
    await document.fonts.ready;
  });
  expect(fonts.some((url) => /InterVariable/.test(url))).toBe(true);
  app.assertNoRuntimeErrors();
});

test('a delayed share chunk exposes an accessible busy state without an unstyled dialog', async ({ page, app }) => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  await page.route(/\/share-composer(?!-loader)(?:-[\w-]+)?\.js(?:\?|$)/, async (route) => {
    await blocked;
    await route.continue();
  });
  await app.open(ROUTE_BY_ID.dashboard);
  const share = page.locator('.shared-header-share');
  try {
    await share.click();
    await expect(share).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByRole('status').filter({ hasText: 'Loading sharing options' })).toHaveCount(1);
    await expect(page.locator('#shareComposerDialog')).toHaveCount(0);
  } finally { release(); }
  await expect(page.getByRole('dialog', { name: 'Choose what you want to send' })).toBeVisible();
  await expect(share).not.toHaveAttribute('aria-busy');
  app.assertNoRuntimeErrors();
});

test('sign-out while the share chunk loads cannot reopen the prior account UI', async ({ page, app }) => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  await page.route(/\/share-composer(?!-loader)(?:-[\w-]+)?\.js(?:\?|$)/, async (route) => {
    await blocked;
    await route.continue();
  });
  await app.open(ROUTE_BY_ID.dashboard);
  try {
    await page.locator('.shared-header-share').click();
    await expect(page.locator('.shared-header-share')).toHaveAttribute('aria-busy', 'true');
    await page.evaluate(() => {
      const oldValue = localStorage.getItem('dominion:user');
      localStorage.removeItem('dominion:user');
      window.dispatchEvent(new StorageEvent('storage', { key: 'dominion:user', oldValue, newValue: null }));
    });
    await expect(page.locator('.shared-header-share')).toHaveCount(0);
  } finally { release(); }
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('dialog', { name: 'Choose what you want to send' })).toBeHidden();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  app.assertNoRuntimeErrors();
});
