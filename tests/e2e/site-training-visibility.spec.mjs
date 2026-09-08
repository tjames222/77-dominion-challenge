import { expect, test } from './support/app-test.mjs';
import { ROUTE_BY_ID } from './support/routes.mjs';

test.afterEach(async ({ app }) => {
  app.assertNoRuntimeErrors();
});

async function openSpotlight(page, kind = 'stacking') {
  await page.evaluate(async (targetKind) => {
    const { createSiteTrainingCoachmark } = await import('/src/static/site-training-coachmark.mjs');
    const host = document.createElement('div');
    host.id = 'trainingVisibilityFixture';
    // A stable surface isolates the control's pixels from WebKit repainting
    // fixed body gradients through rounded corners when modal scroll locks.
    host.style.cssText = 'position:fixed;left:40px;top:160px;transform:translateZ(0);isolation:isolate;z-index:1;overflow:hidden;padding:2px;background:var(--surface);';
    host.innerHTML = '<button data-training-target="visibility-fixture" style="background:rgb(255, 255, 255);color:rgb(0, 0, 0);width:200px;height:64px;border:0">Visible target <span aria-hidden="true">★</span></button>';
    if (targetKind === 'form') {
      host.innerHTML = '<input data-training-target="visibility-fixture" aria-label="Training form field" value="Unchanged value" disabled style="width:200px;height:64px" />';
    } else if (targetKind === 'scroller') {
      host.style.width = '240px';
      host.style.overflow = 'auto';
      host.firstElementChild.style.marginLeft = '360px';
      host.firstElementChild.style.flexShrink = '0';
      host.firstElementChild.style.display = 'block';
    }
    document.body.append(host);
    const coachmark = createSiteTrainingCoachmark({ onAction: (_, controller) => controller.close() });
    window.__visibilityCoachmark = coachmark;
    window.__visibilityRender = () => coachmark.render({ step: { id: 'visible', title: 'Read this control', description: 'The original control stays sharp and fully visible.', target: 'visibility-fixture' }, index: 1, total: 3 });
  }, kind);
  const originalPixels = await page.locator('[data-training-target="visibility-fixture"]').screenshot();
  await page.evaluate(() => {
    const coachmark = window.__visibilityCoachmark;
    // A screenshot scrolls its locator into view. Put this nested scroller
    // back before training so render(), not the screenshot, must reveal it.
    document.getElementById('trainingVisibilityFixture').scrollLeft = 0;
    coachmark.open();
    window.__visibilityRender();
  });
  await expect(page.locator('#siteTrainingTitle')).toBeFocused();
  return originalPixels;
}

async function sameDecodedPixels(page, before, after) {
  return page.evaluate(async (images) => {
    const decoded = await Promise.all(images.map(async (base64) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      return { width: canvas.width, height: canvas.height, pixels: context.getImageData(0, 0, canvas.width, canvas.height).data };
    }));
    const [first, second] = decoded;
    return first.width === second.width && first.height === second.height
      && first.pixels.every((channel, index) => channel === second.pixels[index]);
  }, [before.toString('base64'), after.toString('base64')]);
}

async function expectClearTarget(page) {
  await expect(page.locator('.site-training-spotlight')).toBeVisible();
  expect(await page.locator('.site-training-spotlight').evaluate((outline) => {
    const css = getComputedStyle(outline);
    return css.borderTopWidth === '4px' && css.borderTopStyle === 'solid'
      && css.borderTopColor !== 'transparent' && !css.borderTopColor.endsWith(', 0)') && css.opacity === '1';
  })).toBe(true);
  expect(await page.locator('.site-training-backdrop, .site-training-scrim').evaluateAll((nodes) => nodes.every((node) => {
    const css = getComputedStyle(node);
    return css.backdropFilter === 'none' && (!css.webkitBackdropFilter || css.webkitBackdropFilter === 'none') && css.filter === 'none';
  }))).toBe(true);
  await expect.poll(() => page.evaluate(() => {
    const target = document.querySelector('.site-training-target').getBoundingClientRect();
    const panel = document.querySelector('.site-training-coachmark').getBoundingClientRect();
    const outline = document.querySelector('.site-training-spotlight').getBoundingClientRect();
    const center = { x: (target.left + target.right) / 2, y: (target.top + target.bottom) / 2 };
    const covering = document.elementsFromPoint(center.x, center.y).some((node) =>
      node.matches('.site-training-scrim, .site-training-coachmark') || node.closest('.site-training-coachmark'));
    return !covering && outline.left < target.left && outline.right > target.right
      && outline.top < target.top && outline.bottom > target.bottom
      && (panel.right <= outline.left || panel.left >= outline.right || panel.bottom <= outline.top || panel.top >= outline.bottom);
  })).toBe(true);
}

test('training never blurs the page or wraps desktop navigation labels', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.dashboard, { state: 'member' });
  await openSpotlight(page);
  await expectClearTarget(page);
  const filters = await page.locator('.site-training-backdrop').evaluate((element) => {
    const css = getComputedStyle(element);
    return [css.backdropFilter, css.webkitBackdropFilter || 'none', css.filter];
  });
  expect(filters).toEqual(['none', 'none', 'none']);
  for (const action of ['back', 'stop']) {
    expect(await page.locator(`[data-training-action="${action}"]`).evaluate((button) => {
      const range = document.createRange();
      range.selectNodeContents(button);
      return range.getClientRects().length;
    })).toBe(1);
  }
  await page.locator('[data-training-action="stop"]').click();
  await expect(page.locator('.site-training-target')).toHaveCount(0);
});

for (const theme of ['light', 'dark', 'dominion-night', 'dominion-platinum']) {
  for (const width of [390, 1280]) {
    test(`spotlight preserves original pixels and outline in ${theme} at ${width}px`, async ({ page, app }, testInfo) => {
      await page.setViewportSize({ width, height: 844 });
      await app.open(ROUTE_BY_ID.dashboard, { state: 'member', theme });
      for (const kind of ['stacking', 'form', 'scroller']) {
        const originalPixels = await openSpotlight(page, kind);
        await expectClearTarget(page);
        const target = page.locator('[data-training-target="visibility-fixture"]');
        // Compare to the same engine/theme's unmodified target, not a duplicate
        // DOM image or an OS-specific baseline. This catches dimming and blur.
        const highlightedPixels = await target.screenshot();
        await testInfo.attach(`${kind}-before`, { body: originalPixels, contentType: 'image/png' });
        await testInfo.attach(`${kind}-after`, { body: highlightedPixels, contentType: 'image/png' });
        expect(await sameDecodedPixels(page, originalPixels, highlightedPixels), kind).toBe(true);
        await expect(target).toHaveCount(1);
        if (kind === 'form') {
          await expect(target).toBeDisabled();
          await expect(target).toHaveValue('Unchanged value');
        }
        await testInfo.attach(`${theme}-${width}-${kind}`, { body: await page.screenshot(), contentType: 'image/png' });
        await page.evaluate(() => {
          window.__visibilityCoachmark.destroy();
          document.getElementById('trainingVisibilityFixture').remove();
        });
        await expect(page.locator('.site-training-target')).toHaveCount(0);
        await expect(page.locator('body')).not.toHaveAttribute('data-dialog-open');
      }
    });
  }
}

test('nested clipping fallback recovers its outline and accessible description', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.dashboard, { state: 'member' });
  await openSpotlight(page, 'scroller');
  await page.evaluate(() => { document.getElementById('trainingVisibilityFixture').scrollLeft = 0; });
  await expect(page.locator('.site-training-layer')).not.toHaveClass(/has-target/);
  await expect(page.locator('#siteTrainingFallback')).toBeVisible();
  await expect(page.locator('.site-training-coachmark')).toHaveAttribute('aria-describedby', /siteTrainingFallback/);
  await page.evaluate(() => { document.getElementById('trainingVisibilityFixture').scrollLeft = 350; });
  await expectClearTarget(page);
  await expect(page.locator('#siteTrainingFallback')).toBeHidden();
  await expect(page.locator('.site-training-coachmark')).toHaveAttribute('aria-describedby', 'siteTrainingDescription');
  await page.evaluate(() => {
    document.getElementById('trainingVisibilityFixture').style.width = '270px';
    document.querySelector('.site-training-target').style.width = '210px';
  });
  await expectClearTarget(page);
  await page.evaluate(() => { document.getElementById('trainingVisibilityFixture').style.width = '100px'; });
  await expect.poll(() => page.evaluate(() => {
    const host = document.getElementById('trainingVisibilityFixture').getBoundingClientRect();
    const outline = document.querySelector('.site-training-spotlight').getBoundingClientRect();
    return outline.right <= host.right + 8;
  })).toBe(true);
  await page.evaluate(() => {
    window.__visibilityCoachmark.render({ step: { id: 'orientation', title: 'Orientation', description: 'No target is needed here.' }, index: 0, total: 1 });
  });
  await expect(page.locator('.site-training-spotlight')).toBeHidden();
  expect(await page.locator('.site-training-backdrop').evaluate((node) => {
    const css = getComputedStyle(node);
    return [css.backdropFilter, css.webkitBackdropFilter || 'none', css.filter];
  })).toEqual(['none', 'none', 'none']);
  await expect(page.locator('.site-training-target')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.site-training-layer')).toBeHidden();
});

test('200% and 400% reflow keeps controls bounded and labels intact', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.dashboard, { state: 'member' });
  for (const width of [640, 320]) {
    await page.setViewportSize({ width, height: 720 });
    await openSpotlight(page);
    await expectClearTarget(page);
    expect(await page.locator('.site-training-coachmark').evaluate((panel) => panel.scrollWidth <= panel.clientWidth)).toBe(true);
    for (const action of ['back', 'stop', 'next']) {
      const button = page.locator(`[data-training-action="${action}"]`);
      expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(44);
      expect(await button.evaluate((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return range.getClientRects().length;
      })).toBe(1);
    }
    await page.evaluate(() => { window.__visibilityCoachmark.destroy(); document.getElementById('trainingVisibilityFixture').remove(); });
  }
});

test('synthetic visual viewport constrains actual panel width, not just its coordinates', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.dashboard, { state: 'member' });
  await page.evaluate(() => {
    const viewport = new EventTarget();
    Object.assign(viewport, { offsetLeft: 20, offsetTop: 40, width: 195, height: 580 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  });
  await openSpotlight(page);
  const bounds = await page.locator('.site-training-coachmark').boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(32);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(203);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(608);
  expect(await page.locator('.site-training-coachmark').evaluate((panel) => panel.scrollWidth <= panel.clientWidth)).toBe(true);
});

test('targeted placement respects computed safe-area padding', async ({ page, app }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await app.open(ROUTE_BY_ID.dashboard, { state: 'member' });
  await openSpotlight(page);
  await page.evaluate(() => {
    document.querySelector('.site-training-layer').style.padding = '48px 36px 28px 44px';
    window.dispatchEvent(new Event('resize'));
  });
  const panel = await page.locator('.site-training-coachmark').boundingBox();
  expect(panel.x).toBeGreaterThanOrEqual(44);
  expect(panel.y).toBeGreaterThanOrEqual(48);
  expect(panel.x + panel.width).toBeLessThanOrEqual(354);
  expect(panel.y + panel.height).toBeLessThanOrEqual(816);
});

test('real global navigation and sticky tabs stay sharp and outside the coachmark', async ({ page, app }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await app.open(ROUTE_BY_ID.dashboard, { state: 'member' });
  for (const selector of ['.shared-header-share', '.member-tab']) {
    await page.evaluate(async (targetSelector) => {
      const { createSiteTrainingCoachmark } = await import('/src/static/site-training-coachmark.mjs');
      const target = document.querySelector(targetSelector);
      target.dataset.trainingTarget = 'real-navigation-fixture';
      const coachmark = createSiteTrainingCoachmark();
      window.__visibilityCoachmark = coachmark;
      coachmark.open();
      coachmark.render({ step: { id: 'navigation', title: 'Navigation', description: 'Read the highlighted navigation control.', target: 'real-navigation-fixture' }, index: 0, total: 1 });
    }, selector);
    await expectClearTarget(page);
    await page.evaluate(() => {
      window.__visibilityCoachmark.destroy();
      document.querySelector('[data-training-target="real-navigation-fixture"]').removeAttribute('data-training-target');
    });
  }
});

test('training defers to a native modal without stealing focus or changing product state', async ({ page, app }) => {
  await app.open(ROUTE_BY_ID.dashboard, { state: 'member' });
  const result = await page.evaluate(async () => {
    const { createSiteTrainingCoachmark } = await import('/src/static/site-training-coachmark.mjs');
    const dialog = document.createElement('dialog');
    dialog.innerHTML = '<button autofocus>Keep native focus</button>';
    document.body.append(dialog);
    dialog.showModal();
    const focus = document.activeElement;
    const coachmark = createSiteTrainingCoachmark();
    let message = '';
    try { coachmark.open(); } catch (error) { message = error.message; }
    const state = { message, stillOpen: dialog.open, focusUnchanged: document.activeElement === focus, trainingOpen: coachmark.isOpen, pageIsolationChanged: document.body.hasAttribute('data-dialog-open') };
    coachmark.destroy();
    dialog.close();
    dialog.remove();
    return state;
  });
  expect(result).toEqual({ message: 'Close the open dialog before starting page training.', stillOpen: true, focusUnchanged: true, trainingOpen: false, pageIsolationChanged: false });
});

for (const width of [390, 1280]) {
  test(`real lower Dashboard lessons reveal through the scroll lock and restore the page at ${width}px`, async ({ page, app }) => {
    await page.setViewportSize({ width, height: 720 });
    await app.open(ROUTE_BY_ID.dashboard, { state: 'activeSolo' });
    await page.evaluate(() => window.scrollTo(0, 180));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(180);
    const original = await page.evaluate(() => ({
      scrollX: window.scrollX, scrollY: window.scrollY,
      bodyStyle: document.body.getAttribute('style'),
      inert: document.querySelector('main').getAttribute('inert'),
      hidden: document.querySelector('main').getAttribute('aria-hidden'),
    }));
    // Inspect before any locator screenshot/click can scroll the target for us.
    expect((await page.locator('[data-training-target="dashboard-standards"]').boundingBox()).y).toBeGreaterThan(720);
    await page.evaluate(async () => {
      const { createSiteTrainingCoachmark } = await import('/src/static/site-training-coachmark.mjs');
      const { SITE_TRAINING_REGISTRY, siteTrainingPageForRoute } = await import('/src/static/site-training-registry.mjs');
      const lesson = siteTrainingPageForRoute(SITE_TRAINING_REGISTRY, '/dashboard.html');
      const coachmark = createSiteTrainingCoachmark({ onAction: (_, controller) => controller.close() });
      window.__visibilityCoachmark = coachmark;
      window.__renderDashboardLesson = (index) => coachmark.render({
        step: lesson.steps[index], index, total: lesson.steps.length,
        capabilities: { 'daily-standards-open': true, 'can-share-progress': true },
      });
      coachmark.open();
    });
    for (const index of [4, 5, 6, 4, 2, 5]) {
      await page.evaluate((step) => window.__renderDashboardLesson(step), index);
      await expect(page.locator('#siteTrainingTitle')).toBeFocused();
      await expect(page.locator('.site-training-layer')).toHaveClass(/has-target/);
      await expect(page.locator('#siteTrainingFallback')).toBeHidden();
      await expect(page.locator('main')).toHaveAttribute('inert', '');
      const bounds = await page.locator('.site-training-target').boundingBox();
      const panel = await page.locator('.site-training-coachmark').boundingBox();
      expect(panel.height).toBeGreaterThanOrEqual(240);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.y).toBeLessThan(720);
      if (bounds.height <= 664) expect(bounds.y + bounds.height).toBeLessThanOrEqual(720);
    }
    await page.evaluate(() => window.__visibilityCoachmark.close({ restoreFocus: false }));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(original.scrollY);
    const restored = await page.evaluate(() => ({
      scrollX: window.scrollX, scrollY: window.scrollY,
      bodyStyle: document.body.getAttribute('style') || null,
      inert: document.querySelector('main').getAttribute('inert'),
      hidden: document.querySelector('main').getAttribute('aria-hidden'),
    }));
    expect(restored).toEqual(original);
    await page.evaluate(async () => {
      const { createDialog } = await import('/src/static/dialog.mjs');
      window.__visibilityCoachmark.open();
      window.__renderDashboardLesson(5);
      const replacement = createDialog({ title: 'Replacement dialog' });
      replacement.open();
      window.__visibilityReplacement = replacement;
    });
    await expect(page.locator('.site-training-layer')).toBeHidden();
    await expect(page.locator('.site-training-target')).toHaveCount(0);
    await page.evaluate(() => { window.__visibilityReplacement.destroy(); window.__visibilityCoachmark.destroy(); });
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(original.scrollY);
    expect(await page.evaluate(() => ({
      scrollX: window.scrollX, scrollY: window.scrollY,
      bodyStyle: document.body.getAttribute('style') || null,
      inert: document.querySelector('main').getAttribute('inert'),
      hidden: document.querySelector('main').getAttribute('aria-hidden'),
    }))).toEqual(original);
  });
}

test('resizing an open Dashboard lesson re-reveals its real page target', async ({ page, app }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await app.open(ROUTE_BY_ID.dashboard, { state: 'activeSolo' });
  await page.evaluate(async () => {
    const { createSiteTrainingCoachmark } = await import('/src/static/site-training-coachmark.mjs');
    const { SITE_TRAINING_REGISTRY, siteTrainingPageForRoute } = await import('/src/static/site-training-registry.mjs');
    const lesson = siteTrainingPageForRoute(SITE_TRAINING_REGISTRY, '/dashboard.html');
    const coachmark = createSiteTrainingCoachmark();
    window.__visibilityCoachmark = coachmark;
    coachmark.open();
    coachmark.render({ step: lesson.steps[4], index: 4, total: lesson.steps.length });
  });
  await expect(page.locator('#siteTrainingTitle')).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 400 });
  await expect(page.locator('.site-training-layer')).toHaveClass(/has-target/);
  await expect(page.locator('#siteTrainingFallback')).toBeHidden();
  await expect.poll(() => page.locator('.site-training-target').boundingBox().then((bounds) => bounds.y >= 0 && bounds.y + bounds.height <= 400)).toBe(true);
  await page.evaluate(() => window.__visibilityCoachmark.destroy());
});
