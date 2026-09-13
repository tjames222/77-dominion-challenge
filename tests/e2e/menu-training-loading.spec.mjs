import { expect, test } from './support/app-test.mjs';
import { ROUTE_BY_ID } from './support/routes.mjs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import AxeBuilder from '@axe-core/playwright';

const controllerRequest = /\/menu-training-controllers(?:-[\w-]+)?\.(?:mjs|js)(?:\?|$)/;

for (const chunk of ['menu-training-controllers', 'site-training-ui']) {
  test(`the full built ${chunk} graph recovers from a real HTTP503 after explicit reload`, async ({ page, app }) => {
    const artifact = await build({
      root: fileURLToPath(new URL('../..', import.meta.url)),
      configFile: fileURLToPath(new URL('../../vite.config.mjs', import.meta.url)),
      logLevel: 'silent',
      define: {
        'import.meta.env.VITE_ENABLE_MOCKS': JSON.stringify('true'),
        'import.meta.env.VITE_ENABLE_PRODUCTION_CONNECTIONS': JSON.stringify('false'),
        'import.meta.env.VITE_ENABLE_SUPABASE_AUTH_IN_MOCKS': JSON.stringify('false'),
        'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(''),
        'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify(''),
        'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(''),
      },
      build: { write: false },
    });
    const assets = new Map(artifact.output.map((asset) => [`/${asset.fileName}`, asset.type === 'chunk' ? asset.code : asset.source]));
    // Vite copies public/ when writing a build; the in-memory fixture must
    // serve those same shipped files, including the real theme bootstrap.
    const publicRoot = fileURLToPath(new URL('../../public/', import.meta.url));
    for (const entry of readdirSync(publicRoot, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = join(entry.parentPath, entry.name);
      assets.set(`/${relative(publicRoot, path)}`, readFileSync(path));
    }
    const trainingChunks = artifact.output.filter((asset) => asset.type === 'chunk'
      && Object.keys(asset.modules).some((id) => /(?:site-training-registry|site-training-runtime|page-training-controls|solo-first-run-training|site-training-coachmark)\.(?:mjs|js)$/.test(id)));
    expect(trainingChunks.map((asset) => asset.name).sort())
      .toEqual(['menu-training-controllers', 'site-training-ui']);
    const target = new RegExp(`/${chunk}-[\\w-]+\\.js$`);
    let failing = true;
    let attempts = 0;
    const server = createServer((request, response) => {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      response.setHeader('Cache-Control', 'no-store');
      if (target.test(pathname)) {
        attempts += 1;
        if (failing) { response.writeHead(503); response.end('Temporarily unavailable'); return; }
      }
      if (!assets.has(pathname)) { response.writeHead(404); response.end(); return; }
      response.setHeader('Content-Type', pathname.endsWith('.html') ? 'text/html' : pathname.endsWith('.css') ? 'text/css' : pathname.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
      response.end(assets.get(pathname));
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    try {
      await app.seed('member', 'dark');
      await page.goto(`http://127.0.0.1:${server.address().port}/science.html`, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: 'Open menu' }).click();
      if (chunk === 'site-training-ui') await page.getByRole('button', { name: 'Start page training', exact: true }).click();
      const recovery = page.getByRole('button', { name: 'Reload to load training', exact: true });
      await expect(recovery).toBeVisible();
      expect(attempts).toBe(1);
      await expect(page.locator(`link[rel="modulepreload"][href*="${chunk}-"]`)).toHaveCount(0);
      failing = false;
      await recovery.click();
      await expect(page.getByRole('button', { name: 'Keep editing', exact: true })).toBeFocused();
      await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
      await page.getByRole('button', { name: 'Open menu' }).click();
      expect(attempts).toBe(1, 'Recovery must not imply a cached module rejection can be retried in-document.');
      await recovery.click();
      await Promise.all([
        page.waitForEvent('framenavigated', { predicate: (frame) => frame === page.mainFrame() }),
        page.getByRole('button', { name: 'Reload page', exact: true }).click(),
      ]);
      await page.getByRole('button', { name: 'Open menu' }).click();
      await page.getByRole('button', { name: 'Start page training', exact: true }).click();
      await expect(page.locator('.site-training-layer')).toBeVisible();
      await expect(page.locator('#siteTrainingTitle')).toBeFocused();
      expect(attempts).toBe(2);
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--site-training-styles-ready').trim())).toBe('1');
      app.assertNoRuntimeErrors([/Failed to load resource: the server responded with a status of 503/, /Failed to load resource: (?:The operation couldn’t be completed|Load failed)/]);
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });
}

test('visitor navigation does not fetch the training catalog, controllers, or presentation', async ({ page, app }) => {
  const requests = [];
  page.on('request', (request) => requests.push(request.url()));
  await app.seed('guest', 'dark');
  for (const path of ['/index.html', '/login.html', '/support.html', '/science.html']) {
    await page.goto(path, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(page.getByRole('navigation', { name: 'Global navigation' })).toBeVisible();
    await expect(page.locator('.global-menu-links a[href="./login.html"]')).toBeVisible();
    await page.keyboard.press('Escape');
  }
  expect(requests.filter((url) => /(?:menu-training-controllers|site-training-registry|site-training-runtime|page-training-controls|solo-first-run-training|site-training-ui\.js)/.test(url))).toEqual([]);
  app.assertNoRuntimeErrors();
});

test('member navigation works while controllers load and rehydration attaches one working training action', async ({ page, app }) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route(controllerRequest, async (route) => { await gate; await route.continue(); });
  await app.seed('member', 'dark');
  await page.goto(ROUTE_BY_ID.dashboard.path, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(page.locator('.global-menu-training-load-status')).toHaveText('Loading training…');
  await expect(page.locator('.global-menu-links a[href="./private-journal.html"]')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  release();
  const start = page.getByRole('button', { name: 'Start page training', exact: true });
  await expect(start).toHaveCount(1);
  await expect(start).toBeVisible();
  await start.click();
  await expect(page.locator('.site-training-layer')).toBeVisible();
  await expect(page.locator('.global-menu')).toBeHidden();
  await expect(page.locator('.site-training-layer')).not.toHaveAttribute('inert');
  await page.locator('[data-training-action="stop"]').click();
  await expect(page.locator('.global-menu-button')).toBeFocused();
  app.assertNoRuntimeErrors();
});

test('account removal during controller download cannot attach member controls or start training', async ({ page, app }) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route(controllerRequest, async (route) => { await gate; await route.continue(); });
  await app.seed('member', 'dark');
  // Science supports training without a member-page login redirect.
  await page.goto('/science.html', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(page.locator('.global-menu-training-load-status')).toBeVisible();
  await page.evaluate(() => {
    localStorage.removeItem('dominion:user');
    window.dispatchEvent(new StorageEvent('storage', { key: 'dominion:user', newValue: null }));
  });
  await expect(page.locator('.global-menu-training-section')).toHaveCount(0);
  release();
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(page.locator('.global-menu-links a[href="./login.html"]')).toBeVisible();
  await expect(page.locator('.global-menu-training-section')).toHaveCount(0);
  await expect(page.locator('.site-training-layer')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('dominion:siteTrainingProgress'))).toBeNull();
  app.assertNoRuntimeErrors();
});

for (const theme of ['dark', 'light', 'dominion-night', 'dominion-platinum']) {
test(`a controller download failure offers safe explicit reload and recovers after confirmation: ${theme}`, async ({ page, app }) => {
  let blocked = true;
  await page.route(controllerRequest, async (route) => {
    if (blocked) return route.fulfill({ status: 503, contentType: 'text/javascript', body: '/* unavailable fixture */' });
    return route.continue();
  });
  await app.seed('member', theme);
  await page.goto('/science.html', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Open menu' }).click();
  const recovery = page.getByRole('button', { name: 'Reload to load training', exact: true });
  await expect(recovery).toBeVisible();
  expect((await recovery.boundingBox()).height).toBeGreaterThanOrEqual(44);
  expect((await new AxeBuilder({ page }).include('.global-menu').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await expect(page.locator('.global-menu-training-load-status')).toContainText('Save');
  await recovery.click();
  const dialog = page.getByRole('dialog', { name: 'Reload to load training?' });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('button', { name: 'Keep editing', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Open menu' }).click();
  await recovery.click();
  blocked = false;
  await Promise.all([
    page.waitForEvent('framenavigated', { predicate: (frame) => frame === page.mainFrame() }),
    page.getByRole('button', { name: 'Reload page', exact: true }).click(),
  ]);
  await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible();
  await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(page.getByRole('button', { name: 'Start page training', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reload to load training', exact: true })).toBeHidden();
});
}
