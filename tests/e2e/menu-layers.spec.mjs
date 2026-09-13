import { test, expect, expectNoHorizontalOverflow } from './support/app-test.mjs';
import { ROUTE_BY_ID } from './support/routes.mjs';

const viewports = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1440, height: 1000 },
];

async function settleScroll(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function expectEffectiveMenuLayers(page) {
  const hits = await page.evaluate(() => {
    const tabs = document.querySelector('[data-sticky-secondary-tabs]');
    const drawer = document.querySelector('.global-menu');
    const backdrop = document.querySelector('.global-menu-backdrop');
    const button = document.querySelector('.global-menu-button');
    const shell = tabs.closest('main');
    const savedStyle = tabs.getAttribute('style');
    const savedInert = shell.inert;
    // Temporarily remove interaction/visibility safeguards to prove the actual
    // painted stacking order, not just compare unrelated z-index declarations.
    shell.inert = false;
    tabs.style.setProperty('visibility', 'visible', 'important');
    tabs.style.setProperty('pointer-events', 'auto', 'important');
    try {
      const rect = tabs.getBoundingClientRect();
      const drawerRect = drawer.getBoundingClientRect();
      const points = [rect.left + 2, rect.left + rect.width / 2, rect.right - 2];
      const y = Math.min(innerHeight - 2, rect.top + rect.height / 2);
      const samples = points.map((x) => {
        const stack = document.elementsFromPoint(x, y);
        const tabIndex = stack.indexOf(tabs);
        const backdropIndex = stack.indexOf(backdrop);
        const drawerIndex = stack.indexOf(drawer);
        return {
          tabPresent: tabIndex >= 0,
          backdropAboveTab: backdropIndex >= 0 && backdropIndex < tabIndex,
          drawerAboveTab: x < drawerRect.left || (drawerIndex >= 0 && drawerIndex < tabIndex),
          topIsNavigation: Boolean(stack[0]?.closest('.global-menu, .global-menu-backdrop')),
        };
      });
      const buttonRect = button.getBoundingClientRect();
      return {
        samples,
        bodyRooted: [drawer, backdrop, button].every((element) => element.parentElement === document.body),
        closeOnTop: document.elementFromPoint(buttonRect.x + buttonRect.width / 2, buttonRect.y + buttonRect.height / 2)?.closest('.global-menu-button') === button,
      };
    } finally {
      shell.inert = savedInert;
      if (savedStyle === null) tabs.removeAttribute('style');
      else tabs.setAttribute('style', savedStyle);
    }
  });
  expect(hits.bodyRooted).toBe(true);
  expect(hits.closeOnTop).toBe(true);
  for (const sample of hits.samples) expect(sample).toEqual({
    tabPresent: true, backdropAboveTab: true, drawerAboveTab: true, topIsNavigation: true,
  });
}

for (const theme of ['light', 'dark', 'dominion-night', 'dominion-platinum']) {
  for (const viewport of viewports) {
    test(`navigation isolates sticky rewards controls: ${theme} ${viewport.width}px`, async ({ page, app }, testInfo) => {
      test.setTimeout(90_000);
      await page.setViewportSize(viewport);
      await app.open(ROUTE_BY_ID.badgesRewards, { theme });
      const tabs = page.locator('[data-sticky-secondary-tabs]');
      const topbar = page.locator('.topbar');
      const button = page.locator('.global-menu-button');
      const menu = page.locator('.global-menu');
      const main = page.locator('main');
      const firstLink = menu.locator('a').first();
      const lastControl = menu.getByRole('button', { name: 'Log Out' });

      for (const selectedTab of ['Rewards', 'Badges']) {
        await page.getByRole('tab', { name: selectedTab, exact: true }).click();
        for (const scrollState of ['top', 'sticky']) {
          await page.evaluate((sticky) => window.scrollTo(0, sticky ? 640 : 0), scrollState === 'sticky');
          await settleScroll(page);
          const scrollY = await page.evaluate(() => window.scrollY);
          const tabBox = await tabs.boundingBox();
          const headerBox = await topbar.boundingBox();
          if (scrollState === 'sticky') {
            await expect(topbar).toHaveClass(/topbar-collapsed/);
            expect(tabBox.y).toBeLessThan(300);
          } else await expect(topbar).not.toHaveClass(/topbar-collapsed/);

          const buttonBox = await button.boundingBox();
          // Use the visible sticky control without Playwright scrolling its
          // original layout position into view before dispatching the click.
          await page.mouse.click(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2);
          await expect(menu).toBeVisible();
          expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
          await expect(button).toHaveAccessibleName('Close menu');
          await expect(main).toHaveAttribute('inert', '');
          await expect(main).toHaveAttribute('aria-hidden', 'true');
          await expect(tabs).toBeHidden();
          await expect(page.getByRole('tab', { name: 'Rewards' })).toHaveCount(0);
          await expect(firstLink).toBeFocused();
          await expectEffectiveMenuLayers(page);
          if (selectedTab === 'Badges' && scrollState === 'sticky'
            && (viewport.width === 390 || (theme === 'dominion-night' && viewport.width === 1440))) {
            await testInfo.attach(`menu-sticky-${theme}-${viewport.width}`, {
              body: await page.screenshot(), contentType: 'image/png',
            });
          }

          await page.locator('#rewards-tab').evaluate((element) => element.focus());
          await expect(firstLink).toBeFocused();
          await page.keyboard.press('Shift+Tab');
          await expect(button).toBeFocused();
          await page.keyboard.press('Shift+Tab');
          await expect(lastControl).toBeFocused();
          await page.keyboard.press('Tab');
          await expect(button).toBeFocused();
          await page.keyboard.press('Tab');
          await expect(firstLink).toBeFocused();
          // Body-root content added by asynchronous page hydration is isolated too.
          await page.evaluate(() => {
            const link = document.createElement('a');
            link.id = 'late-menu-background';
            link.href = '#';
            link.textContent = 'Late background action';
            document.body.append(link);
          });
          await expect(page.locator('#late-menu-background')).toHaveAttribute('inert', '');
          await page.mouse.move(5, Math.min(tabBox.y + 20, viewport.height - 5));
          if (testInfo.project.use.browserName === 'webkit') await page.keyboard.press('PageDown');
          else await page.mouse.wheel(0, 500);
          await settleScroll(page);
          expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);

          // Exercise Escape, pointer/touch backdrop dismissal, and the lifted close toggle.
          if (selectedTab === 'Rewards' && scrollState === 'top') await page.keyboard.press('Escape');
          else if (scrollState === 'sticky') {
            const backdropPoint = { x: tabBox.x + 2, y: tabBox.y + tabBox.height / 2 };
            if (testInfo.project.use.hasTouch) await page.touchscreen.tap(backdropPoint.x, backdropPoint.y);
            else await page.mouse.click(backdropPoint.x, backdropPoint.y);
          } else await button.click();
          await expect(menu).toBeHidden();
          await expect(button).toBeFocused();
          await expect(button).toHaveAccessibleName('Open menu');
          await expect(main).not.toHaveAttribute('inert', '');
          await expect(main).not.toHaveAttribute('aria-hidden', 'true');
          await expect(page.locator('#late-menu-background')).not.toHaveAttribute('inert', '');
          await page.locator('#late-menu-background').evaluate((element) => element.remove());
          await expect(page.locator('.global-menu-button-placeholder')).toHaveCount(0);
          await expect(page.locator('html')).not.toHaveClass(/menu-scroll-locked/);
          await expect(tabs).toBeVisible();
          await expect(page.getByRole('tab', { name: selectedTab, exact: true })).toHaveAttribute('aria-selected', 'true');
          expect(await tabs.boundingBox()).toEqual(tabBox);
          expect((await topbar.boundingBox()).height).toBe(headerBox.height);
          expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
          for (const control of [button, page.getByRole('tab', { name: selectedTab, exact: true })]) {
            const box = await control.boundingBox();
            expect(box.width).toBeGreaterThanOrEqual(44);
            expect(box.height).toBeGreaterThanOrEqual(44);
          }
          await page.evaluate((offset) => window.scrollBy(0, offset), scrollY > 0 ? -80 : 80);
          await settleScroll(page);
          expect(await page.evaluate(() => window.scrollY)).not.toBe(scrollY);
        }
      }
      await expectNoHorizontalOverflow(page);
      app.assertNoRuntimeErrors();
    });
  }
}

test('menu cleanup preserves existing inert and accessibility state', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.badgesRewards);
  await page.evaluate(() => {
    const region = document.createElement('section');
    region.id = 'pre-isolated-region';
    region.setAttribute('inert', '');
    region.setAttribute('aria-hidden', 'true');
    document.body.append(region);
  });
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('button', { name: 'Close menu', exact: true }).click();
    await expect(page.locator('#pre-isolated-region')).toHaveAttribute('inert', '');
    await expect(page.locator('#pre-isolated-region')).toHaveAttribute('aria-hidden', 'true');
  }
  app.assertNoRuntimeErrors();
});

test('open-menu hydration retains its lifted close toggle and keyboard context', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.badgesRewards);
  await page.getByRole('button', { name: 'Open menu' }).click();
  const firstLink = page.locator('.global-menu-links a').first();
  await firstLink.evaluate((element) => element.setAttribute('data-before-hydration', 'true'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('[data-before-hydration]')).toHaveCount(0);
  await expect(firstLink).toBeFocused();
  await expect(page.locator('body > .global-menu-button')).toHaveCount(1);
  await expect(page.locator('main')).toHaveAttribute('inert', '');
  await page.getByRole('button', { name: 'Close menu', exact: true }).click();
  await expect(page.locator('.topbar .global-menu-button')).toBeFocused();
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  await expect(page.locator('.global-menu-button-placeholder')).toHaveCount(0);
  app.assertNoRuntimeErrors();
});
