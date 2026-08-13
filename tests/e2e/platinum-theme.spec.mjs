import {
  expectNoHorizontalOverflow,
  expectStableScreenshot,
  test,
} from './support/app-test.mjs';
import { ROUTE_BY_ID } from './support/routes.mjs';

for (const viewport of [
  { id: 'mobile', width: 390, height: 844 },
  { id: 'tablet', width: 768, height: 1024 },
  { id: 'desktop', width: 1440, height: 1000 },
]) {
  test(`Dominion Platinum Dashboard visual contract at ${viewport.id}`, async ({ page, app }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await app.open(ROUTE_BY_ID.dashboard, {
      state: 'rewardsUnlocked',
      theme: 'dominion-platinum',
    });
    await expectNoHorizontalOverflow(page);
    await expectStableScreenshot(page, app, `dominion-platinum-dashboard-${viewport.id}.png`);
    app.assertNoRuntimeErrors();
  });
}

test('Dominion Platinum honors the reduced-motion preference', async ({ page, app }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await app.open(ROUTE_BY_ID.dashboard, {
    state: 'rewardsUnlocked',
    theme: 'dominion-platinum',
  });

  const motion = await page.evaluate(() => {
    const probe = document.querySelector('.card') || document.body;
    const style = getComputedStyle(probe);
    return {
      prefersReducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      animationDuration: style.animationDuration,
      transitionDuration: style.transitionDuration,
      scrollBehavior: style.scrollBehavior,
    };
  });

  if (!motion.prefersReducedMotion) throw new Error('Reduced-motion browser preference was not active.');
  if (Number.parseFloat(motion.animationDuration) > 0.00001) {
    throw new Error(`Unexpected animation duration: ${motion.animationDuration}`);
  }
  if (Number.parseFloat(motion.transitionDuration) > 0.00001) {
    throw new Error(`Unexpected transition duration: ${motion.transitionDuration}`);
  }
  if (motion.scrollBehavior !== 'auto') throw new Error(`Unexpected scroll behavior: ${motion.scrollBehavior}`);
});
