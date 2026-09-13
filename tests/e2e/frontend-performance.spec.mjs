import { test, expect } from './support/app-test.mjs';
import { ROUTE_BY_ID } from './support/routes.mjs';

for (const theme of ['dark', 'light', 'dominion-night', 'dominion-platinum']) {
  test(`landing loads only responsive ${theme} artwork and preserves the original fallback`, async ({ page, app }) => {
    const requested = [];
    page.on('request', (request) => {
      if (request.resourceType() === 'image') requested.push(request.url());
    });
    // The screenshot helper intentionally forces every lazy image to eager.
    // Use normal navigation here to measure the application's native behavior.
    await app.seed(theme.startsWith('dominion-') ? 'member' : 'guest', theme);
    await page.goto(ROUTE_BY_ID.landing.path, { waitUntil: 'networkidle' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const variant = theme === 'light' ? 'light' : 'dark';
    const active = page.locator(`.hero-artwork-${variant} img`);
    const inactive = page.locator(`.hero-artwork-${variant === 'light' ? 'dark' : 'light'}`);
    await active.scrollIntoViewIfNeeded();
    await expect(active).toBeVisible();
    await expect(inactive).toBeHidden();
    await expect(page.getByRole('img', { name: '77 Days. No Excuses. Only Faithfulness.' })).toHaveCount(1);
    await expect.poll(() => active.evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
    const dimensions = await active.evaluate((image) => ({
      width: image.getAttribute('width'), height: image.getAttribute('height'),
      current: image.currentSrc, ratio: image.getBoundingClientRect().width / image.getBoundingClientRect().height,
    }));
    expect(dimensions.width).toBe('1536');
    expect(dimensions.height).toBe('1024');
    expect(dimensions.ratio).toBeCloseTo(1.5, 2);
    expect(dimensions.current).toMatch(new RegExp(`/hero-${variant}-(?:480|768|1200|1536)(?:-[\\w-]+)?\\.webp$`));
    expect(requested.filter((url) => /\/hero-(?:dark|light)-/.test(url))).toEqual([dimensions.current]);
    expect(requested.filter((url) => /r2\.dev\//.test(url))).toEqual([]);

    const next = variant === 'light' ? 'dark' : 'light';
    await page.evaluate((value) => window.DominionThemeRuntime.setTheme(value), next);
    const switched = page.locator(`.hero-artwork-${next} img`);
    await expect(switched).toBeVisible();
    await expect.poll(() => switched.evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
    expect(await switched.evaluate((image) => image.currentSrc)).toContain(`/hero-${next}-`);
    await expect(page.locator(`.hero-artwork-${variant}`)).toBeHidden();

    // An engine that does not support WebP selects the unchanged original PNG.
    const fallback = await switched.getAttribute('src');
    await page.locator(`.hero-artwork-${next} source`).evaluate((source) => { source.type = 'image/unsupported-test'; });
    await expect.poll(() => switched.evaluate((image) => image.currentSrc)).toBe(fallback);
    app.assertNoRuntimeErrors();
  });
}

test('Community brand position is stable when authenticated menu actions hydrate', async ({ page, app }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await app.seed('member');
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  await page.route(/\/menu(?:-[\w-]+)?\.js(?:\?|$)/, async (route) => { await blocked; await route.continue(); });
  let before;
  try {
    await page.goto(ROUTE_BY_ID.community.path, { waitUntil: 'commit' });
    const brand = page.locator('.topbar > .brand-name');
    await expect(brand).toBeVisible();
    await expect(brand).toHaveCSS('font-weight', '900');
    await page.evaluate(async () => { await document.fonts.load('900 16px "Inter"'); });
    before = await brand.evaluate((node) => node.getBoundingClientRect().x);
    expect(before).toBeLessThan(600);
  } finally { release(); }
  await expect(page.locator('.shared-header-share')).toBeVisible();
  expect(await page.locator('.topbar > .brand-name').evaluate((node) => node.getBoundingClientRect().x)).toBeCloseTo(before, 1);
  app.assertNoRuntimeErrors();
});

test('phone Rewards progress reserves the same rows before and after data hydration', async ({ page, app }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await app.seed('member');
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  await page.route(/\/(?:badges-rewards|badgesRewards)(?:-[\w-]+)?\.js(?:\?|$)/, async (route) => { await blocked; await route.continue(); });
  const geometry = () => page.locator('.game-level-progress-panel').evaluate((panel) => ({
    heading: panel.querySelector('.game-level-progress-heading').getBoundingClientRect().height,
    copy: panel.querySelector('.game-momentum-message').getBoundingClientRect().height,
    trackOffset: panel.querySelector('.game-level-progress-track').getBoundingClientRect().top - panel.getBoundingClientRect().top,
  }));
  let before;
  try {
    await page.goto(ROUTE_BY_ID.badgesRewards.path, { waitUntil: 'commit' });
    await expect(page.locator('.game-level-progress-heading')).toHaveCSS('display', 'grid');
    await page.evaluate(async () => { await document.fonts.load('400 16px "Inter"'); await document.fonts.load('900 16px "Inter"'); });
    before = await geometry();
    expect(before.copy).toBeGreaterThan(40);
  } finally { release(); }
  await expect(page.locator(ROUTE_BY_ID.badgesRewards.ready)).toBeVisible();
  expect(await geometry()).toEqual(before);
  app.assertNoRuntimeErrors();
});

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
