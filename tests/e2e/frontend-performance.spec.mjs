import { test, expect } from './support/app-test.mjs';
import { ROUTE_BY_ID } from './support/routes.mjs';
import AxeBuilder from '@axe-core/playwright';
import { fixtureFor, FIXED_USER_ID, FIXED_NOW } from './support/fixtures.mjs';
import { createSoloTrainingLaunch, SOLO_TRAINING_LAUNCH_STORAGE_KEY, SOLO_TRAINING_LAUNCH_EVENT } from '../../src/static/challenge-start-flow.mjs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { resolveTrainingModulePreloads } from '../../vite.config.mjs';

const EXPECTED_ABORT_ERRORS = [
  /Failed to load resource: net::ERR_FAILED/,
  /Failed to load resource: (?:The operation couldn’t be completed|Load failed|cancelled)/,
  /Failed to load resource: the server responded with a status of 503/,
];

test('real HTTP 503 training module failure recovers after reload without a failed JavaScript preload', async ({ page, app }) => {
  // Build the actual loader/UI in memory so this regression also runs with the
  // development test server. This is a real loopback HTTP failure, not browser
  // interception (WebKit also caches failed modulepreloads outside Playwright).
  const artifact = await build({
    configFile: false,
    root: fileURLToPath(new URL('../..', import.meta.url)),
    base: './',
    logLevel: 'silent',
    build: {
      write: false,
      modulePreload: { resolveDependencies: resolveTrainingModulePreloads },
      rollupOptions: {
        input: { loader: fileURLToPath(new URL('../../src/static/site-training-ui-loader.mjs', import.meta.url)) },
        preserveEntrySignatures: 'strict',
        output: { entryFileNames: 'loader.js' },
      },
    },
  });
  const assets = new Map(artifact.output.map((asset) => [`/${asset.fileName}`, asset.type === 'chunk' ? asset.code : asset.source]));
  let failing = true;
  let attempts = 0;
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (/\/site-training-ui(?:-[\w-]+)?\.js$/.test(pathname)) {
      attempts += 1;
      if (failing) { response.writeHead(503); response.end('Temporarily unavailable'); return; }
    }
    if (assets.has(pathname)) {
      response.setHeader('Content-Type', pathname.endsWith('.css') ? 'text/css' : 'text/javascript');
      response.end(assets.get(pathname));
    } else if (pathname === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>Training load recovery</title><script type="module">import { loadSiteTrainingUi } from "/loader.js"; window.loadTraining = loadSiteTrainingUi;</script>');
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const first = await page.evaluate(async () => {
      try { await window.loadTraining(); return null; } catch (error) { return { code: error.code, message: error.message }; }
    });
    expect(first).toEqual({ code: 'SITE_TRAINING_RELOAD_REQUIRED', message: 'Training could not load. Save any unfinished work, then reload this page to try again.' });
    expect(attempts).toBe(1);
    await expect(page.locator('link[rel="modulepreload"][href*="site-training-ui"]')).toHaveCount(0);
    failing = false;
    expect(await page.evaluate(() => window.loadTraining().then(() => true, () => false))).toBe(false);
    expect(attempts).toBe(1, 'A new application promise is not an in-document browser retry.');
    await page.reload();
    expect(await page.evaluate(async () => typeof (await window.loadTraining()).createSiteTrainingCoachmark)).toBe('function');
    expect(attempts).toBe(2);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--site-training-styles-ready').trim())).toBe('1');
    app.assertNoRuntimeErrors(EXPECTED_ABORT_ERRORS);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

for (const scenario of [
  { theme: 'dark', scope: 'page', chunk: 'js' },
  { theme: 'light', scope: 'solo', chunk: 'js' },
  { theme: 'dominion-night', scope: 'page', chunk: 'css' },
  { theme: 'dominion-platinum', scope: 'solo', chunk: 'css' },
]) {
  test(`failed training ${scenario.chunk} requires consented reload: ${scenario.scope} / ${scenario.theme}`, async ({ page, app }) => {
    const chunkPattern = scenario.chunk === 'js'
      ? /\/site-training-ui(?:-[\w-]+)?\.js(?:\?|$)/
      : /\/(?:site-training-ui-[\w-]+|site-training)\.css(?:\?|$)/;
    let attempts = 0;
    let navigations = 0;
    page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations += 1; });
    await page.route(chunkPattern, async (route) => {
      // Axe reads inaccessible stylesheets with XHR while auditing contrast.
      // Count/interrupt the browser's actual module/stylesheet loads only.
      if (['xhr', 'fetch'].includes(route.request().resourceType())) {
        await route.continue();
        return;
      }
      attempts += 1;
      if (attempts === 1 && scenario.scope === 'solo') {
        await route.fulfill({ status: 503, headers: { 'cache-control': 'no-store' }, body: 'Temporarily unavailable' });
      } else if (attempts === 1) await route.abort('failed');
      else await route.continue();
    });
    await app.open(ROUTE_BY_ID.dashboard, { state: 'activeSolo', theme: scenario.theme });
    // A real DOM-only draft catches accidental reloads or product form clearing.
    await page.evaluate(() => {
      const draft = document.createElement('textarea');
      draft.id = 'training-recovery-unsaved-draft';
      draft.setAttribute('aria-label', 'Unfinished draft');
      draft.value = 'Keep this unfinished thought';
      document.querySelector('main').append(draft);
    });
    const trainingStorage = () => page.evaluate(() => Object.fromEntries(
      Object.entries(localStorage).filter(([key]) => /siteTraining|soloTraining/i.test(key)),
    ));
    const savedBefore = await trainingStorage();
    const navigationsBefore = navigations;
    await page.getByRole('button', { name: 'Open menu', exact: true }).click();
    const startName = scenario.scope === 'page' ? 'Start page training' : 'Start Training';
    const group = page.locator(scenario.scope === 'page' ? '.global-menu-page-training' : '.global-menu-full-training');
    await group.getByRole('button', { name: startName, exact: true }).click();
    const reload = group.getByRole('button', { name: 'Reload to load training', exact: true });
    await expect(reload).toBeVisible();
    await expect(group.getByRole('alert')).toContainText('Save any unfinished work');
    await expect(page.locator('.site-training-layer')).toHaveCount(0);
    expect(await trainingStorage()).toEqual(savedBefore);
    expect(attempts).toBe(1);
    expect(navigations).toBe(navigationsBefore);
    await reload.click();
    const confirmation = page.getByRole('dialog', { name: 'Reload to load training?', exact: true });
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toContainText('Reloading may discard unsaved changes');
    const keepEditing = confirmation.getByRole('button', { name: 'Keep editing', exact: true });
    await expect(keepEditing).toBeFocused();
    const accessibility = await new AxeBuilder({ page })
      .include(scenario.scope === 'page' ? '#page-training-reload-confirmation' : '#solo-training-reload-confirmation')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(accessibility.violations).toEqual([]);
    await keepEditing.click();
    await expect(confirmation).toBeHidden();
    await expect(page.locator('.global-menu-button')).toBeFocused();
    await expect(page.locator('#training-recovery-unsaved-draft')).toHaveValue('Keep this unfinished thought');
    expect(navigations).toBe(navigationsBefore);
    expect(await trainingStorage()).toEqual(savedBefore);

    // A fresh activation/menu refresh must not mislabel a cached failure as a
    // genuine in-document retry, and still must not reopen the training overlay.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.getByRole('button', { name: 'Open menu', exact: true }).click();
    await expect(reload).toBeVisible();
    await reload.click();
    await expect(confirmation).toBeVisible();
    await Promise.all([
      page.waitForEvent('framenavigated', { predicate: (frame) => frame === page.mainFrame() }),
      confirmation.getByRole('button', { name: 'Reload page', exact: true }).click(),
    ]);
    await expect(page.locator('#training-recovery-unsaved-draft')).toHaveCount(0);
    await expect(page.locator('.site-training-layer')).toHaveCount(0);
    expect(await trainingStorage()).toEqual(savedBefore);
    await page.getByRole('button', { name: 'Open menu', exact: true }).click();
    await group.getByRole('button', { name: startName, exact: true }).click();
    await expect(page.locator('.site-training-coachmark')).toBeVisible();
    await expect(page.locator('#siteTrainingTitle')).toBeFocused();
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--site-training-styles-ready').trim())).toBe('1');
    expect(attempts).toBe(2);
    app.assertNoRuntimeErrors(EXPECTED_ABORT_ERRORS);
  });
}

test('failed automatic Solo handoff survives until an explicitly confirmed reload succeeds', async ({ page, app }) => {
  let attempts = 0;
  await page.route(/\/site-training-ui(?:-[\w-]+)?\.js(?:\?|$)/, async (route) => {
    attempts += 1;
    if (attempts === 1) await route.abort('failed');
    else await route.continue();
  });
  await app.open(ROUTE_BY_ID.dashboard, { state: 'activeSolo' });
  const launch = createSoloTrainingLaunch({
    actorId: FIXED_USER_ID,
    activation: {
      ...fixtureFor('activeSolo').json['dominion:mockChallengeActivation'][FIXED_USER_ID],
      readState: 'ready', contractValid: true,
    },
    requestedAt: FIXED_NOW,
  });
  const serializedLaunch = JSON.stringify({ [FIXED_USER_ID]: launch });
  await page.evaluate(({ key, value, event, actorId }) => {
    localStorage.setItem(key, value);
    window.dispatchEvent(new CustomEvent(event, { detail: { actorId } }));
  }, { key: SOLO_TRAINING_LAUNCH_STORAGE_KEY, value: serializedLaunch, event: SOLO_TRAINING_LAUNCH_EVENT, actorId: FIXED_USER_ID });
  await expect.poll(() => attempts).toBe(1);
  await expect(page.locator('.site-training-layer')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Reload to load training?' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  const recovery = page.locator('.global-menu-full-training').getByRole('button', { name: 'Reload to load training', exact: true });
  await expect(recovery).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), SOLO_TRAINING_LAUNCH_STORAGE_KEY)).toBe(serializedLaunch);
  expect(await page.evaluate(() => localStorage.getItem('dominion:siteTrainingProgress'))).toBe(null);
  await recovery.click();
  const confirmation = page.getByRole('dialog', { name: 'Reload to load training?', exact: true });
  await expect(confirmation.getByRole('button', { name: 'Keep editing', exact: true })).toBeFocused();
  await Promise.all([
    page.waitForEvent('framenavigated', { predicate: (frame) => frame === page.mainFrame() }),
    confirmation.getByRole('button', { name: 'Reload page', exact: true }).click(),
  ]);
  // This was already a user-requested activation handoff, not an unsolicited
  // new training start. It resumes once the new document can load the UI.
  await expect(page.locator('.site-training-coachmark')).toBeVisible();
  await expect(page.locator('#siteTrainingTitle')).toBeFocused();
  expect(attempts).toBe(2);
  expect(await page.evaluate((key) => localStorage.getItem(key), SOLO_TRAINING_LAUNCH_STORAGE_KEY)).toBe(null);
  app.assertNoRuntimeErrors(EXPECTED_ABORT_ERRORS);
});

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

for (const signOut of [false, true]) {
  test(`delayed training UI ${signOut ? 'is discarded after sign-out' : 'keeps busy controls visible and waits for styles'}`, async ({ page, app }) => {
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    await page.route(/\/site-training-ui(?:-[\w-]+)?\.js(?:\?|$)/, async (route) => {
      await blocked;
      await route.continue();
    });
    await app.open(ROUTE_BY_ID.dashboard, { state: 'member' });
    const menu = page.locator('.global-menu');
    try {
      await page.getByRole('button', { name: 'Open menu', exact: true }).click();
      const start = page.getByRole('button', { name: 'Start page training', exact: true });
      await start.click();
      await expect(start).toBeVisible();
      await expect(start).toHaveAttribute('aria-busy', 'true');
      await expect(page.locator('.site-training-layer')).toHaveCount(0);
      if (signOut) {
        await page.evaluate(() => {
          const oldValue = localStorage.getItem('dominion:user');
          localStorage.removeItem('dominion:user');
          window.dispatchEvent(new StorageEvent('storage', { key: 'dominion:user', oldValue, newValue: null }));
        });
        await expect(page.locator('.shared-header-share')).toHaveCount(0);
      }
    } finally { release(); }
    if (signOut) {
      await page.waitForLoadState('networkidle');
      await expect(page.locator('.site-training-layer')).toHaveCount(0);
    } else {
      await expect(menu).toBeHidden();
      const dialog = page.locator('.site-training-coachmark');
      await expect(dialog).toBeVisible();
      await expect(page.locator('#siteTrainingTitle')).toBeFocused();
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--site-training-styles-ready').trim())).toBe('1');
      await expect(page.locator('.site-training-layer')).not.toHaveAttribute('inert');
    }
    app.assertNoRuntimeErrors();
  });
}

for (const route of [ROUTE_BY_ID.landing, ROUTE_BY_ID.login, ROUTE_BY_ID.dashboard, ROUTE_BY_ID.badgesRewards]) {
  test(`${route.id} loads only the everyday font and defers the share UI`, async ({ page, app }) => {
    const requests = [];
    page.on('request', (request) => requests.push(request.url()));
    await app.open(route);
    expect(requests.some((url) => /\/InterLatinUI(?:-[\w-]+)?\.woff2/.test(url))).toBe(true);
    expect(requests.filter((url) => /\/InterVariable(?:-[\w-]+)?\.woff2/.test(url))).toEqual([]);
    expect(requests.filter((url) => /\/share-composer(?!-loader)(?:-[\w-]+)?\.(?:js|css)(?:\?|$)/.test(url))).toEqual([]);
    expect(requests.filter((url) => /\/site-training-(?:ui(?:-[\w-]+)?\.js|coachmark\.mjs|[^/]+\.css)(?:\?|$)/.test(url))).toEqual([]);
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
