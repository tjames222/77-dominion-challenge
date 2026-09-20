import { test } from '../tests/e2e/support/app-test.mjs';
import { fileURLToPath } from 'node:url';

test.beforeEach(async ({ context }) => {
  await context.addInitScript({ path: fileURLToPath(new URL('./preview-badge-observer.js', import.meta.url)) });
});

test.afterEach(async ({ context }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  const pages = await Promise.all(context.pages().map(async (page, index) => {
    try {
      return await page.evaluate((index) => ({ index, url: location.href, observation: window.__previewBadgeObservation?.report() ?? null }), index);
    } catch (error) {
      return { index, url: page.url(), unavailable: String(error.message) };
    }
  }));
  await testInfo.attach('preview-badge-storage-lock-observations', {
    body: JSON.stringify({ schedulingMayBeAffected: true, pages }),
    contentType: 'application/json',
  });
});

// Register the unchanged real tests, then select the existing cross-tab title.
// No test body, fixture, assertion, API operation or clock setup is copied.
await import('../tests/e2e/deterministic-badges.spec.mjs');
