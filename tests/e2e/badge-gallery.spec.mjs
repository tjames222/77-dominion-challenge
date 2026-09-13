import { test, expect, expectNoHorizontalOverflow } from './support/app-test.mjs';
import { GALLERY_BADGES, seedBadgeGallery } from './support/badge-gallery-fixtures.mjs';
import { countApiFunctionCalls, deferApiFunction, injectApiFunctionFailureOnce } from './support/network-states.mjs';
import { analyzeAccessibility, assertNoBlockingAxeViolations } from './support/quality-gates.mjs';

async function openGallery(page, app, options = {}) {
  await seedBadgeGallery(page, app, options);
  await page.goto('/badges-rewards', { waitUntil: 'networkidle' });
  await app.stable();
  await page.getByRole('tab', { name: 'Badges', exact: true }).click();
  await expect(page.locator('#badgesGallery')).toHaveAttribute('aria-busy', 'false');
}

for (const theme of ['light', 'dark', 'dominion-night', 'dominion-platinum']) {
  for (const width of [390, 768, 1440]) {
    test(`icon grid and details retain tier materials: ${theme} ${width}px`, async ({ page, app }) => {
      await page.setViewportSize({ width, height: 844 });
      await openGallery(page, app, { theme });
      const tiles = page.locator('.badge-gallery-tile');
      await expect(tiles).toHaveCount(3);
      expect(await tiles.evaluateAll((nodes) => nodes.map((node) => node.textContent))).toEqual(['', '', '']);
      const colors = [];
      for (const badge of GALLERY_BADGES) {
        const tile = page.locator(`[data-badge-key="${badge.key}"]`);
        await expect(tile).toHaveAttribute('aria-label', new RegExp(`View ${badge.name} badge details`));
        const box = await tile.boundingBox();
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(Math.abs(box.width - box.height)).toBeLessThan(2);
        colors.push(await tile.locator('.badge-medallion').evaluate((node) => getComputedStyle(node).backgroundImage));
        await tile.click();
        const dialog = page.getByRole('dialog', { name: badge.name, exact: true });
        await expect(dialog).toBeVisible();
        await expect(dialog.locator('.badge-detail-medallion')).toHaveAttribute('data-badge-tier', badge.tier);
        await expect(dialog).toContainText(badge.requirement);
        await expect(dialog).toContainText(badge.legacy ? 'Detailed earning history is unavailable' : 'You earned it by:');
        await expect(dialog.getByRole('button', { name: 'Close badge details' })).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(dialog.getByRole('button', { name: 'Close badge details' })).toBeFocused();
        await expect(page.locator('main')).toHaveAttribute('inert', '');
        await expectNoHorizontalOverflow(page);
        await page.keyboard.press('Escape');
        await expect(tile).toBeFocused();
        await expect(tile).toHaveAttribute('aria-expanded', 'false');
      }
      expect(new Set(colors).size).toBe(3);
      assertNoBlockingAxeViolations(await analyzeAccessibility(page));
      app.assertNoRuntimeErrors();
    });
  }
}

test('Enter, Space, close and backdrop restore the exact trigger without catalog reads', async ({ page, app }) => {
  const reads = await countApiFunctionCalls(page, 'getAllRewardCatalog');
  await openGallery(page, app);
  const before = await reads.count();
  const tile = page.locator('[data-badge-key="perfect_week"]');
  await tile.focus();
  await page.keyboard.press('Enter');
  let dialog = page.getByRole('dialog', { name: 'Seven for Seven' });
  await dialog.getByRole('heading', { name: 'How you earned it' }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close badge details' }).click();
  await expect(tile).toBeFocused();
  await page.keyboard.press('Space');
  dialog = page.getByRole('dialog', { name: 'Seven for Seven' });
  await expect(dialog).toBeVisible();
  await page.locator('.app-dialog-layer[data-pattern="badge-detail"] .app-dialog-backdrop').click({ position: { x: 4, y: 4 } });
  await expect(tile).toBeFocused();
  expect(await reads.count()).toBe(before);
  await expect(page.getByRole('tab', { name: 'Badges', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('empty and many-badge collections stay complete, deduplicated and ordered', async ({ page, app }) => {
  const many = Array.from({ length: 125 }, (_, index) => ({ ...GALLERY_BADGES[index % 3], key: `badge_${String(index).padStart(3, '0')}`, earnedAt: '2026-02-12T20:00:00Z' }));
  await openGallery(page, app, { badges: [...many].reverse().concat(many[0]) });
  await expect(page.locator('.badge-gallery-tile')).toHaveCount(125);
  expect(await page.locator('.badge-gallery-tile').first().getAttribute('data-badge-key')).toBe('badge_000');
  await page.locator('.badge-gallery-tile').last().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.badge-gallery-tile').last()).toBeFocused();
});

test('zero earned badges preserve a useful empty state', async ({ page, app }) => {
  await openGallery(page, app, { badges: [] });
  await expect(page.locator('.badge-gallery-tile')).toHaveCount(0);
  await expect(page.locator('#badgesGallery')).toContainText('Your first badge is waiting.');
});

test('same-account insertion keeps selected badge and exact trigger identity', async ({ page, app }) => {
  await openGallery(page, app);
  const tile = page.locator('[data-badge-key="perfect_week"]');
  await tile.evaluate((node) => { window.__galleryOriginalTrigger = node; });
  await tile.click();
  await page.evaluate(async (badges) => {
    const { writePreviewUserValue } = await import('/src/static/preview-user-state.mjs');
    const owner = localStorage.getItem('dominion:mockUserId');
    writePreviewUserValue(localStorage, owner, 'dominion:badges', [
      { ...badges[0], key: 'new_remote', name: 'New remote badge', earnedAt: '2026-02-14T20:00:00Z' }, ...badges,
    ]);
    window.dispatchEvent(new StorageEvent('storage', { key: 'dominion:badges' }));
  }, GALLERY_BADGES);
  await expect(page.locator('.badge-gallery-tile')).toHaveCount(4);
  const dialog = page.getByRole('dialog', { name: 'Seven for Seven' });
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toContainText('New remote badge');
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => document.activeElement === window.__galleryOriginalTrigger)).toBe(true);
});

test('200 percent text, landscape and forced colors keep content and controls reachable', async ({ page, app, browserName }) => {
  await page.setViewportSize({ width: 667, height: 375 });
  await openGallery(page, app, { badges: [{ ...GALLERY_BADGES[0], name: 'A long badge name '.repeat(8), description: 'A complete and helpful description. '.repeat(30) }] });
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  if (browserName === 'chromium') await page.emulateMedia({ forcedColors: 'active' });
  await page.locator('.badge-gallery-tile').click();
  const dialog = page.getByRole('dialog');
  const close = dialog.getByRole('button', { name: 'Close badge details' });
  await expect(close).toBeInViewport();
  await dialog.locator('.badge-detail-evidence').scrollIntoViewIfNeeded();
  await expect(dialog.locator('.badge-detail-evidence')).toBeInViewport();
  await expectNoHorizontalOverflow(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('.badge-gallery-tile')).toBeFocused();
});

test('loading skeletons and retryable errors do not leave a stuck gallery', async ({ page, app }) => {
  const gate = await deferApiFunction(page, 'getEarnedBadges');
  await seedBadgeGallery(page, app);
  await page.goto('/badges-rewards');
  await gate.intercepted;
  await page.getByRole('tab', { name: 'Badges', exact: true }).click();
  await expect(page.locator('.badge-gallery-skeleton')).toHaveCount(4);
  await gate.release();
  await expect(page.locator('.badge-gallery-tile')).toHaveCount(3);
});

test('failed reads can be retried without awarding or fabricating badges', async ({ page, app }) => {
  await injectApiFunctionFailureOnce(page, 'getEarnedBadges', 'Badge history temporarily unavailable');
  await seedBadgeGallery(page, app);
  await page.goto('/badges-rewards');
  await expect(page.locator('#badgesRewardsError')).toBeVisible();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('#badgesGallery')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.badge-gallery-tile')).toHaveCount(3);
});

test('account loss synchronously removes open badge content', async ({ page, app }) => {
  await openGallery(page, app);
  await page.locator('[data-badge-key="perfect_week"]').click();
  const result = await page.evaluate(() => {
    localStorage.removeItem('dominion:user');
    window.dispatchEvent(new StorageEvent('storage', { key: 'dominion:user' }));
    return { tiles: document.querySelectorAll('.badge-gallery-tile').length, details: document.querySelectorAll('.badge-detail-panel').length };
  });
  expect(result).toEqual({ tiles: 0, details: 0 });
});

test('cross-tab storage clear synchronously scrubs the earned collection and details', async ({ page, app }) => {
  await openGallery(page, app);
  await page.locator('[data-badge-key="perfect_week"]').click();
  const result = await page.evaluate(() => {
    localStorage.clear();
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
    return { tiles: document.querySelectorAll('.badge-gallery-tile').length, details: document.querySelectorAll('.badge-detail-panel').length };
  });
  expect(result).toEqual({ tiles: 0, details: 0 });
});
