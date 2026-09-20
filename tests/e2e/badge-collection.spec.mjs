import { test, expect, expectNoHorizontalOverflow } from './support/app-test.mjs';
import { GALLERY_BADGES } from './support/badge-gallery-fixtures.mjs';
import { analyzeAccessibility, assertNoBlockingAxeViolations } from './support/quality-gates.mjs';

const payload = {
  collection: { catalogVersion: 1, items: [
    { key: 'faithful_start', name: 'Faithful Start', series: 'foundation', displayOrder: 10, status: 'active', visibility: 'public', earnedInCurrentScope: true },
    { key: 'check_ins_7', name: '7 Check-Ins', requirement: 'Post 7 check-ins in one original 77-day challenge.', series: 'participation', displayOrder: 200, status: 'active', visibility: 'public', tier: 'silver', icon: 'check', showProgress: true, progress: { metric: 'instance_check_in_count', current: 5, target: 7 } },
    { key: 'seven_sealed', name: '7-Day Perfect Streak', requirement: 'Post all seven Daily Actions on 7 consecutive local calendar days.', series: 'perfect_streak', displayOrder: 100, status: 'active', visibility: 'public', tier: 'silver', icon: 'flame', showProgress: true, progress: { metric: 'perfect_streak', current: 2, target: 7 } },
    { key: 'secret', name: 'Hidden locked badge', series: 'community', status: 'active', visibility: 'hidden' },
  ] },
  awards: GALLERY_BADGES,
};

async function mountCollection(page, app, theme = 'dark') {
  await app.seed('rewardsUnlocked', theme);
  await page.goto('/badges-rewards', { waitUntil: 'networkidle' });
  await app.stable();
  await page.getByRole('tab', { name: 'Badges', exact: true }).click();
  await page.evaluate(async (data) => {
    const { createBadgeCollection } = await import('/src/static/badge-collection.mjs');
    document.querySelector('.badges-gallery-section').hidden = true;
    const section = document.createElement('section');
    section.id = 'badgeCollectionFixture';
    section.className = 'badges-gallery-section';
    section.setAttribute('aria-label', 'Badge collection component fixture');
    document.getElementById('badges-panel').append(section);
    window.__badgeCollection = createBadgeCollection(section);
    window.__badgeCollection.render(data);
  }, payload);
}

for (const theme of ['light', 'dark', 'dominion-night', 'dominion-platinum']) {
  for (const width of [390, 1440]) {
    test(`route uses the actor-bound badge catalog: ${theme} ${width}px`, async ({ page, app }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await app.seed('rewardsUnlocked', theme);
      await page.goto('/badges-rewards', { waitUntil: 'networkidle' });
      await app.stable();
      await page.getByRole('tab', { name: 'Badges', exact: true }).click();
      const collection = page.locator('#badgesGallery');
      await expect(collection).toHaveAttribute('aria-busy', 'false');
      const catalog = await page.evaluate(async () => {
        const api = await import('/src/static/api.js');
        const actor = await api.getLocalOrSessionUser();
        return api.getBadgeCollection({ expectedUserId: actor.userId });
      });
      const locked = catalog.items.filter((item) => item.visibility === 'public'
        && ['active', 'blocked'].includes(item.status) && !item.earnedInCurrentScope);
      await expect(collection.locator('[data-badge-requirement]')).toHaveCount(locked.length);
      await expect(collection.locator('.badge-gallery-tile')).toHaveCount(catalog.earnedBadges.length);
      await expect(collection.getByRole('heading', { name: 'Check-in milestones' })).toBeVisible();
      const seven = collection.locator('[data-badge-requirement="check_ins_7"]');
      await expect(seven).toContainText('0 of 7 check-ins');
      const finisher = collection.locator('[data-badge-requirement="original_77_completed"]');
      await expect(finisher).toContainText('Not available yet');
      await expect(finisher.getByRole('progressbar')).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
      assertNoBlockingAxeViolations(await analyzeAccessibility(page));
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: testInfo.outputPath('badge-collection-route.png'), fullPage: true });
      app.assertNoRuntimeErrors();
    });

    test(`series requirements and earned details: ${theme} ${width}px`, async ({ page, app }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await mountCollection(page, app, theme);
      const collection = page.locator('#badgeCollectionFixture');
      await expect(collection.getByRole('heading', { name: 'Check-in milestones' })).toBeVisible();
      await expect(collection.getByRole('heading', { name: 'Legacy collection' })).toBeVisible();
      await expect(collection.getByRole('progressbar', { name: '7 Check-Ins: 5 of 7 check-ins' })).toHaveAttribute('aria-valuenow', '5');
      await expect(collection).not.toContainText('Hidden locked badge');
      await expect(collection.locator('.badge-gallery-tile')).toHaveCount(3);
      const tile = collection.locator('[data-badge-key="faithful_start"]');
      await tile.click();
      await expect(page.getByRole('dialog', { name: 'Faithful Start', exact: true })).toContainText('Posting your first check-in.');
      await page.keyboard.press('Escape');
      await expect(tile).toBeFocused();
      await expectNoHorizontalOverflow(page);
      assertNoBlockingAxeViolations(await analyzeAccessibility(page));
      await collection.screenshot({ path: testInfo.outputPath('badge-collection.png') });
      app.assertNoRuntimeErrors();
    });
  }
}

test('group reconciliation preserves exact dialog origin and clear removes actor data', async ({ page, app }) => {
  await mountCollection(page, app);
  const tile = page.locator('#badgeCollectionFixture [data-badge-key="faithful_start"]');
  await tile.evaluate((node) => { window.__seriesTrigger = node; });
  await tile.click();
  await page.evaluate((data) => window.__badgeCollection.render({ ...data, collection: { ...data.collection, items: [...data.collection.items].reverse() } }), payload);
  await expect(page.getByRole('dialog', { name: 'Faithful Start', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => document.activeElement === window.__seriesTrigger)).toBe(true);
  await tile.click();
  await page.evaluate(() => window.__badgeCollection.clear());
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#badgeCollectionFixture')).toBeEmpty();
});
