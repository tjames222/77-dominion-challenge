import AxeBuilder from '@axe-core/playwright';
import { test, expect, expectNoHorizontalOverflow } from './support/app-test.mjs';
import { PRODUCTION_ROUTES, ROUTE_BY_ID } from './support/routes.mjs';
import { AUTHENTICATED_HEADER_ROUTES } from '../../src/static/shared-header-state.mjs';

const shareRoutes = PRODUCTION_ROUTES.filter((route) => AUTHENTICATED_HEADER_ROUTES.includes(route.htmlEntry));
const dialogName = 'Choose what you want to send';

async function expectBrandedComposer(page) {
  const dialog = page.getByRole('dialog', { name: dialogName });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-share-method="copy_link"]')).toBeEnabled();
  await expect(page.locator('#shareComposerDialog')).toHaveCount(1);
  const styles = await dialog.evaluate((panel) => {
    const css = (selector) => getComputedStyle(panel.querySelector(selector));
    const fieldset = css('.share-flow-options');
    const metric = css('.share-preview-metric');
    const preview = css('.share-composer-preview');
    const action = css('[data-share-method="copy_link"]');
    const options = [...panel.querySelectorAll('.share-flow-option')].map((option) => {
      const radio = getComputedStyle(option.querySelector('input'));
      const card = getComputedStyle(option.querySelector('span'));
      const title = option.querySelector('strong');
      const copy = option.querySelector('small');
      return {
        radioOpacity: radio.opacity,
        radioWidth: radio.width,
        radioHeight: radio.height,
        radioPosition: radio.position,
        display: card.display,
        gap: parseFloat(card.rowGap),
        radius: card.borderTopLeftRadius,
        border: card.borderTopWidth,
        padding: parseFloat(card.paddingTop),
        height: option.getBoundingClientRect().height,
        separation: copy.getBoundingClientRect().top - title.getBoundingClientRect().bottom,
        titleSize: parseFloat(getComputedStyle(title).fontSize),
        copySize: parseFloat(getComputedStyle(copy).fontSize),
      };
    });
    const body = panel.querySelector('.app-dialog-body');
    return {
      fieldsetDisplay: fieldset.display,
      fieldsetBorder: fieldset.borderTopWidth,
      metricSize: parseFloat(metric.fontSize),
      metricFamily: metric.fontFamily,
      previewDisplay: preview.display,
      previewRadius: preview.borderTopLeftRadius,
      previewBorder: preview.borderTopWidth,
      actionHeight: parseFloat(action.minHeight),
      actionWeight: parseInt(action.fontWeight, 10),
      actionRadius: parseFloat(action.borderTopLeftRadius),
      bodyOverflow: body.scrollWidth - body.clientWidth,
      options,
    };
  });
  expect(styles.fieldsetDisplay).toBe('grid');
  expect(styles.fieldsetBorder).toBe('0px');
  expect(styles.metricSize).toBeGreaterThanOrEqual(35);
  expect(styles.metricFamily).toContain('Inter');
  expect(styles.previewDisplay).toBe('grid');
  expect(styles.previewRadius).toBe('18px');
  expect(styles.previewBorder).toBe('1px');
  expect(styles.actionHeight).toBeGreaterThanOrEqual(44);
  expect(styles.actionWeight).toBeGreaterThanOrEqual(700);
  expect(styles.actionRadius).toBeGreaterThan(0);
  expect(styles.bodyOverflow).toBeLessThanOrEqual(1);
  for (const option of styles.options) {
    expect(option.radioOpacity).toBe('0');
    expect(option.radioWidth).toBe('1px');
    expect(option.radioHeight).toBe('1px');
    expect(option.radioPosition).toBe('absolute');
    expect(option.display).toBe('grid');
    expect(option.gap).toBeGreaterThanOrEqual(4);
    expect(option.radius).toBe('14px');
    expect(option.border).toBe('1px');
    expect(option.padding).toBeGreaterThanOrEqual(12);
    expect(option.height).toBeGreaterThanOrEqual(44);
    expect(option.separation).toBeGreaterThanOrEqual(3);
    expect(option.titleSize).toBeGreaterThan(option.copySize);
  }
  await expectNoHorizontalOverflow(page);
}

for (const route of shareRoutes) {
  test(`${route.id} clean URL and hard refresh open one fully styled composer`, async ({ page, app }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await app.open({ ...route, path: route.path.replace(/\.html$/, '') }, { state: 'member' });
    for (const phase of ['direct', 'refresh']) {
      await page.locator('.shared-header-share').click();
      await expectBrandedComposer(page);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: dialogName })).toBeHidden();
      await expect(page.locator('.shared-header-share')).toBeFocused();
      if (phase === 'direct') {
        await page.reload({ waitUntil: 'networkidle' });
        await app.stable();
      }
    }
    app.assertNoRuntimeErrors();
  });
}

for (const theme of ['light', 'dark', 'dominion-night', 'dominion-platinum']) {
  for (const width of [390, 1440]) {
    test(`composer retains branded accessible layout in ${theme} at ${width}px`, async ({ page, app, browserName }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'share', { configurable: true, value: async () => undefined });
      });
      await app.open(ROUTE_BY_ID.dashboard, { state: 'rewardsUnlocked', theme });
      await page.locator('.shared-header-share').focus();
      await page.keyboard.press('Enter');
      await expectBrandedComposer(page);
      const dialog = page.getByRole('dialog', { name: dialogName });
      const checked = dialog.locator('[data-share-flow]:checked');
      await expect(checked).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await expect(dialog.locator('[data-share-flow]:checked')).not.toHaveValue('progress');
      const focusOutline = await dialog.locator('.share-flow-option:focus-within').evaluate((option) => getComputedStyle(option).outlineWidth);
      expect(parseFloat(focusOutline)).toBeGreaterThanOrEqual(3);
      await expectBrandedComposer(page);
      for (let index = 0; index < 10; index += 1) {
        // Safari's default keyboard mode uses Option-Tab to include buttons.
        await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
        expect(await dialog.evaluate((panel) => panel.contains(document.activeElement))).toBe(true);
      }
      const results = await new AxeBuilder({ page }).include('#shareComposerDialog').analyze();
      expect(results.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact))).toEqual([]);
      await page.keyboard.press('Escape');
      await expect(page.locator('.shared-header-share')).toBeFocused();
      app.assertNoRuntimeErrors();
    });
  }
}

test('slow stylesheet loading cannot expose an unstyled first-open composer', async ({ page, app }) => {
  let unblockStyles;
  let sawStyleRequest;
  const blocked = new Promise((resolve) => { unblockStyles = resolve; });
  const requested = new Promise((resolve) => { sawStyleRequest = resolve; });
  await page.route(/\.css(?:\?|$)/, async (route) => {
    sawStyleRequest();
    await blocked;
    await route.continue();
  });
  await app.seed('member');
  await page.goto('/dashboard', { waitUntil: 'commit' });
  await requested;
  try {
    await expect(page.getByRole('dialog', { name: dialogName })).toBeHidden();
    // Styles are module dependencies, so no enabled Share trigger can race them.
    await expect(page.locator('.shared-header-share:enabled')).toHaveCount(0);
  } finally {
    unblockStyles();
  }
  await page.locator('.shared-header-share').click();
  await expectBrandedComposer(page);
  app.assertNoRuntimeErrors();
});

test('composer remains reachable at 200 percent text size with reduced motion', async ({ page, app }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await app.open(ROUTE_BY_ID.dashboard);
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await page.locator('.shared-header-share').click();
  await expectBrandedComposer(page);
  const dialog = page.getByRole('dialog', { name: dialogName });
  const copy = dialog.getByRole('button', { name: 'Copy share link' });
  await copy.scrollIntoViewIfNeeded();
  await expect(copy).toBeInViewport();
  await expect(dialog.getByRole('button', { name: 'Close dialog' })).toBeInViewport();
  expect(await dialog.evaluate((panel) => getComputedStyle(panel).animationName)).toBe('none');
});
