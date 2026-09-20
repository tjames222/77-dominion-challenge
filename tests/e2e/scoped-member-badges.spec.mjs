import { expect, test } from './support/app-test.mjs';
import { analyzeAccessibility, assertNoBlockingAxeViolations } from './support/quality-gates.mjs';
import { ROUTE_BY_ID } from './support/routes.mjs';

async function seedScopedAwards(page) {
  await page.evaluate(() => {
    localStorage.setItem('dominion:badges', JSON.stringify(Array.from({ length: 13 }, (_, index) => ({
      awardId: `c2500000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      key: 'seven_sealed', name: '7-Day Perfect Streak', description: 'Public badge description',
      tier: 'silver', icon: 'shield', earnedAt: '2026-02-07T12:00:00.000Z',
      scopeKey: index === 0 ? 'lifetime' : `original77:fixture-${index}`,
      metadata: { privateNote: 'Never display this' },
    }))));
  });
  await page.locator('.member-progress-trigger[aria-label="View Jordan Test’s level and badges"]').click();
  const dialog = page.getByRole('dialog', { name: 'Member progress' });
  await expect(dialog.locator('.member-progress-badge')).toHaveCount(12);
  return dialog;
}

test('scoped badge pages retain identical-key awards and never reveal provenance', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.community);
  const dialog = await seedScopedAwards(page);
  await dialog.getByRole('button', { name: 'Load more badges' }).click();
  await expect(dialog.locator('.member-progress-badge')).toHaveCount(13);
  await expect(dialog.getByText('13 of 13 badges loaded')).toBeFocused();
  await expect(dialog).not.toContainText('Never display this');
  await expect(dialog).not.toContainText('original77:');
  await expect(dialog.getByRole('button', { name: 'Load more badges' })).toHaveCount(0);
  app.assertNoRuntimeErrors();
});

test('crew display preserves grandfathered gold and newer scoped silver presentation', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.community);
  await page.evaluate(() => {
    const definition = { name: '7-Day Perfect Streak', description: 'Current description', tier: 'silver', icon: 'repeat' };
    localStorage.setItem('dominion:badges', JSON.stringify([
      { id: 'c2500000-0000-4000-8000-000000000101', badge_key: 'seven_sealed', scope_key: 'lifetime',
        earned_at: '2026-02-07T12:00:00Z', badge_definitions: definition,
        metadata: { legacy: true, privateNote: 'Never display', awardDefinition: {
          name: 'Seven Sealed', description: 'Originally earned description', tier: 'gold', icon: 'crown',
        } } },
      { id: 'c2500000-0000-4000-8000-000000000102', badge_key: 'seven_sealed', scope_key: 'original77:2026-02-01',
        earned_at: '2026-02-07T11:00:00Z', badge_definitions: definition, metadata: { awardDefinition: definition } },
    ]));
  });
  await page.reload({ waitUntil: 'networkidle' });
  await app.stable();
  const leaderboard = page.locator('.leaderboard-row').filter({ has: page.locator('[aria-label="View Jordan Test’s level and badges"]') });
  await expect(leaderboard.locator('.badge-chip.gold')).toHaveText('Seven Sealed');
  await expect(leaderboard.locator('.badge-chip.silver')).toHaveText('7-Day Perfect Streak');
  await page.locator('.member-progress-trigger[aria-label="View Jordan Test’s level and badges"]').click();
  const dialog = page.getByRole('dialog', { name: 'Member progress' });
  await expect(dialog.locator('.member-progress-badge').first()).toContainText('gold badge');
  await expect(dialog.locator('.member-progress-badge').first()).toContainText('Originally earned description');
  await expect(dialog.locator('.member-progress-badge').nth(1)).toContainText('silver badge');
  await expect(dialog).not.toContainText('Never display');
  app.assertNoRuntimeErrors();
});

for (const theme of ['light', 'dark', 'dominion-night']) {
  test(`stale badge cursor offers an accessible first-page reload in ${theme}`, async ({ page, app }) => {
    await app.open(ROUTE_BY_ID.community, { theme });
    const dialog = await seedScopedAwards(page);
    await page.evaluate(() => {
      const badges = JSON.parse(localStorage.getItem('dominion:badges'));
      // Simulate another valid data version between pages, without firing an
      // unrelated foreground event which would already revalidate page one.
      localStorage.setItem('dominion:badges', JSON.stringify(badges.filter(b => !b.awardId.endsWith('000000000012'))));
    });
    await dialog.getByRole('button', { name: 'Load more badges' }).click();
    const reload = dialog.getByRole('button', { name: 'Reload badges' });
    await expect(reload).toBeFocused();
    await expect(dialog).toContainText('Badge history changed. Reload badges to start from the first page.');
    await expect(dialog.locator('.member-progress-badge')).toHaveCount(0);
    await expect(dialog).not.toContainText('member_badge_cursor_restart_required');
    assertNoBlockingAxeViolations(await analyzeAccessibility(page));
    await reload.click();
    await expect(dialog.locator('.member-progress-badge')).toHaveCount(12);
    await expect(dialog).toContainText('12 of 12 badges loaded');
    await expect(reload).toHaveCount(0);
    app.assertNoRuntimeErrors();
  });
}
