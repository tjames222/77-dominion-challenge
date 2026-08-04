import { expect, test } from './support/app-test.mjs';
import { PRODUCTION_ROUTES } from './support/routes.mjs';

const dashboardRoute = PRODUCTION_ROUTES.find((route) => route.id === 'dashboard');

test('production Inter tokens drive both app and share-composer typography', async ({ page, app }) => {
  await app.open(dashboardRoute);
  await page.getByRole('button', { name: 'Share my progress' }).click();

  const previewMetric = page.locator('.share-preview-metric');
  await expect(previewMetric).toBeVisible();

  const typography = await page.evaluate(() => {
    const rootStyles = getComputedStyle(document.documentElement);
    const metricStyles = getComputedStyle(document.querySelector('.share-preview-metric'));
    const interFace = [...document.fonts].find(
      (face) => face.family.replaceAll('"', '') === 'Inter',
    );

    return {
      displayToken: rootStyles.getPropertyValue('--font-display').trim(),
      fontFaceStatus: interFace?.status || 'missing',
      metricFamily: metricStyles.fontFamily,
      rootFamily: rootStyles.fontFamily,
      sansToken: rootStyles.getPropertyValue('--font-sans').trim(),
    };
  });

  expect(typography.fontFaceStatus).toBe('loaded');
  expect(typography.rootFamily).toContain('Inter');
  expect(typography.displayToken).toBe(typography.sansToken);
  expect(typography.metricFamily).toBe(typography.rootFamily);
  app.assertNoRuntimeErrors();
});
