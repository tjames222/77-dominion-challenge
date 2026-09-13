import { expect, test } from './support/app-test.mjs';
import { ROUTE_BY_ID } from './support/routes.mjs';

const controllerRequest = '**/src/static/menu-training-controllers.mjs*';

test('visitor navigation does not fetch the training catalog, controllers, or presentation', async ({ page, app }) => {
  const requests = [];
  page.on('request', (request) => requests.push(request.url()));
  await app.seed('guest', 'dark');
  for (const path of ['/index.html', '/login.html', '/support.html', '/science.html']) {
    await page.goto(path, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(page.getByRole('navigation', { name: 'Global navigation' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Log In', exact: true })).toBeVisible();
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
  await expect(page.getByRole('link', { name: 'Private Journal', exact: true })).toBeVisible();
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
  await expect(page.getByRole('link', { name: 'Log In', exact: true })).toBeVisible();
  await expect(page.locator('.global-menu-training-section')).toHaveCount(0);
  await expect(page.locator('.site-training-layer')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('dominion:siteTrainingProgress'))).toBeNull();
  app.assertNoRuntimeErrors();
});

test('a controller download failure offers safe explicit reload and recovers after confirmation', async ({ page, app }) => {
  let blocked = true;
  await page.route(controllerRequest, async (route) => {
    if (blocked) return route.fulfill({ status: 503, contentType: 'text/javascript', body: '/* unavailable fixture */' });
    return route.continue();
  });
  await app.seed('member', 'dark');
  await page.goto('/science.html', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Open menu' }).click();
  const recovery = page.getByRole('button', { name: 'Reload to load training', exact: true });
  await expect(recovery).toBeVisible();
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
  await page.getByRole('button', { name: 'Reload page', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible();
  await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(page.getByRole('button', { name: 'Start page training', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reload to load training', exact: true })).toHaveCount(0);
});
