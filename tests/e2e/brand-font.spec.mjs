import { expect, test } from './support/app-test.mjs';
import { PRODUCTION_ROUTES } from './support/routes.mjs';

const dashboardRoute = PRODUCTION_ROUTES.find((route) => route.id === 'dashboard');

test('production Inter tokens drive both app and share-composer typography', async ({ page, app }) => {
  const fontRequests = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'font') fontRequests.push(request.url());
  });
  await app.open(dashboardRoute);
  await page.locator('.shared-header-share').click();

  const previewMetric = page.locator('.share-preview-metric');
  await expect(previewMetric).toBeVisible();

  const typography = await page.evaluate(async () => {
    const rootStyles = getComputedStyle(document.documentElement);
    const metric = document.querySelector('.share-preview-metric');
    const metricStyles = getComputedStyle(metric);
    // Unicode-range faces are demand-loaded. Ask for the face that covers the
    // rendered metric, not the first (extended-language) face in CSS order.
    const metricFaces = await document.fonts.load(
      `${metricStyles.fontWeight} 16px "Inter"`, metric.textContent,
    );

    return {
      displayToken: rootStyles.getPropertyValue('--font-display').trim(),
      metricFaces: metricFaces.map((face) => ({
        family: face.family.replaceAll('"', ''), status: face.status,
      })),
      metricFamily: metricStyles.fontFamily,
      rootFamily: rootStyles.fontFamily,
      sansToken: rootStyles.getPropertyValue('--font-sans').trim(),
    };
  });

  expect(typography.metricFaces).toEqual([{ family: 'Inter', status: 'loaded' }]);
  expect(fontRequests.some((url) => /\/InterLatinUI(?:-[\w-]+)?\.woff2/.test(url))).toBe(true);
  expect(fontRequests.filter((url) => /\/InterVariable(?:-[\w-]+)?\.woff2/.test(url))).toEqual([]);
  expect(typography.rootFamily).toContain('Inter');
  expect(typography.displayToken).toBe(typography.sansToken);
  expect(typography.metricFamily).toBe(typography.rootFamily);
  app.assertNoRuntimeErrors();
});
