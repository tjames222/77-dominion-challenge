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

const PHONE_LESSON_CASES = [
  { width: 390, height: 844, theme: 'dark' },
  { width: 375, height: 667, theme: 'dark' },
  { width: 360, height: 640, theme: 'dark' },
  { width: 320, height: 568, theme: 'dark' },
  { width: 390, height: 844, theme: 'light' },
  { width: 390, height: 844, theme: 'dominion-night' },
  { width: 390, height: 844, theme: 'dominion-platinum' },
];

async function expectPhoneLessonReadable(page) {
  // Do not click/screenshot a locator first: either can scroll hidden controls
  // into view and conceal the owner's actual first-render regression.
  await expect.poll(() => page.evaluate(() => {
    const panel = document.querySelector('.site-training-coachmark');
    const bounds = panel.getBoundingClientRect();
    const viewport = window.visualViewport;
    const viewportBottom = (viewport?.offsetTop || 0) + (viewport?.height || innerHeight);
    const inside = (rect) => rect.top >= bounds.top && rect.bottom <= bounds.bottom
      && rect.left >= bounds.left && rect.right <= bounds.right && rect.bottom <= viewportBottom;
    const nodes = [...panel.querySelectorAll('#siteTrainingTitle, #siteTrainingDescription, [data-training-action]')];
    const visible = nodes.filter((node) => !node.hidden);
    const controls = visible.filter((node) => node.matches('button'));
    const copy = visible.filter((node) => !node.matches('button'));
    const lesson = panel.querySelector('.site-training-lesson');
    const lessonBounds = lesson?.getBoundingClientRect() || bounds;
    const insideLesson = (rect) => inside(rect) && rect.top >= lessonBounds.top
      && rect.bottom <= lessonBounds.bottom && rect.left >= lessonBounds.left && rect.right <= lessonBounds.right;
    const title = panel.querySelector('#siteTrainingTitle');
    const titleBounds = title.getBoundingClientRect();
    const titleStyle = getComputedStyle(title);
    const focusClearance = Math.max(0, parseFloat(titleStyle.outlineWidth) + parseFloat(titleStyle.outlineOffset));
    const focusVisible = document.activeElement !== title || (
      titleBounds.top - focusClearance >= lessonBounds.top - 1
      && titleBounds.bottom + focusClearance <= lessonBounds.bottom + 1
      && titleBounds.left - focusClearance >= lessonBounds.left - 1
      && titleBounds.right + focusClearance <= lessonBounds.right + 1);
    return panel.scrollHeight <= panel.clientHeight + 1 && visible.every((node) => inside(node.getBoundingClientRect()))
      && (!lesson || lesson.scrollHeight <= lesson.clientHeight + 1)
      && focusVisible
      && controls.every((node) => {
        const rect = node.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        const text = document.createRange();
        text.selectNodeContents(node);
        return rect.height >= 44 && (hit === node || node.contains(hit)) && text.getClientRects().length === 1;
      }) && copy.every((node) => {
        const text = document.createRange();
        text.selectNodeContents(node);
        return [...text.getClientRects()].every(insideLesson);
      });
  })).toBe(true);
}

for (const { width, height, theme } of PHONE_LESSON_CASES) {
  test(`phone Dashboard step six shows all copy, actions and focus at ${width}x${height} in ${theme}`, async ({ page, app }, testInfo) => {
    await page.setViewportSize({ width, height });
    await app.open(ROUTE_BY_ID.dashboard, { state: 'activeSolo', theme });
    await page.evaluate(() => {
      let sequence = 0;
      Object.defineProperty(globalThis.crypto, 'randomUUID', {
        configurable: true,
        value: () => `00000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, '0')}`,
      });
    });
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('button', { name: 'Start Training', exact: true }).click();
    await expect(page.locator('.site-training-layer')).toBeVisible();
    // The drawer has its own blur layer and must be visually closed, not just
    // inert, before a spotlight can reveal the actual Dashboard behind it.
    await expect(page.locator('body')).not.toHaveClass(/menu-open/);
    await expect(page.locator('.global-menu-button')).toHaveAttribute('aria-expanded', 'false');
    for (let step = 1; step < 6; step += 1) {
      await expect(page.locator('#siteTrainingProgress')).toContainText(`Step ${step} of 9`);
      await page.locator('[data-training-action="next"]').click();
    }
    await expect(page.locator('#siteTrainingProgress')).toContainText('Step 6 of 9');
    await expect(page.locator('#siteTrainingTitle')).toHaveText('Complete your seven Daily Actions');
    await testInfo.attach('step-six-first-render', { body: await page.screenshot(), contentType: 'image/png' });
    await expectPhoneLessonReadable(page);
    await expect.poll(() => page.evaluate(() => {
      const target = document.querySelector('[data-training-target="dashboard-standards"]').getBoundingClientRect();
      const hole = document.querySelector('.site-training-spotlight').getBoundingClientRect();
      const panel = document.querySelector('.site-training-coachmark').getBoundingClientRect();
      const heading = document.getElementById('todaysScorecardTitle').getBoundingClientRect();
      return hole.height >= 100 && hole.top >= 0 && hole.bottom < panel.top
        && target.top < hole.bottom && target.bottom > hole.top
        && heading.top >= hole.top && heading.bottom <= hole.bottom
        && hole.left <= target.left && hole.right >= target.right;
    })).toBe(true);
    await expect(page.locator('.site-training-coachmark')).toContainText('Highlighted above');
    await page.locator('[data-training-action="next"]').click();
    await expect(page.locator('#siteTrainingProgress')).toContainText('Step 7 of 9');
    await expectPhoneLessonReadable(page);
    await page.locator('[data-training-action="back"]').click();
    await expect(page.locator('#siteTrainingProgress')).toContainText('Step 6 of 9');
    await expectPhoneLessonReadable(page);
    await page.locator('[data-training-action="stop"]').click();
    await expect(page.locator('.site-training-layer')).toBeHidden();
    await expect(page.locator('.site-training-target')).toHaveCount(0);
    await expect(page.locator('body')).not.toHaveAttribute('data-dialog-open');
    await expect(page.locator('.global-menu-button')).toBeFocused();
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('button', { name: 'Resume Training', exact: true }).click();
    await expect(page.locator('body')).not.toHaveClass(/menu-open/);
    await expect(page.locator('#siteTrainingProgress')).toContainText('Step 6 of 9');
    await expectPhoneLessonReadable(page);
    await page.locator('[data-training-action="stop"]').click();
    await expect(page.locator('.global-menu-button')).toBeFocused();
  });
}

test('orientation lesson releases mobile height when the viewport grows', async ({ page, app }) => {
  await page.setViewportSize({ width: 320, height: 400 });
  await app.open(ROUTE_BY_ID.dashboard, { state: 'activeSolo' });
  await page.evaluate(async () => {
    const { createSiteTrainingCoachmark } = await import('/src/static/site-training-coachmark.mjs');
    window.__visibilityCoachmark = createSiteTrainingCoachmark();
    window.__visibilityCoachmark.open();
    window.__visibilityCoachmark.render({ step: {
      id: 'orientation', title: 'Complete your seven Daily Actions',
      description: 'The scorecard groups today’s Mind, Spirit, and Body actions and shows which ones are complete.',
    }, index: 5, total: 9 });
  });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await expect.poll(() => page.locator('.site-training-coachmark').evaluate((panel) => {
    const lesson = panel.querySelector('.site-training-lesson');
    return !panel.style.maxHeight && !panel.style.getPropertyValue('--site-training-left')
      && !panel.style.getPropertyValue('--site-training-top') && lesson.scrollHeight <= lesson.clientHeight + 1;
  })).toBe(true);
});

test('phone fallback recovers the same target near the card boundary', async ({ page, app }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await app.open(ROUTE_BY_ID.dashboard, { state: 'activeSolo' });
  await page.evaluate(async () => {
    const { createSiteTrainingCoachmark } = await import('/src/static/site-training-coachmark.mjs');
    const target = document.createElement('div');
    target.dataset.trainingTarget = 'boundary-fixture';
    target.style.cssText = 'position:fixed;left:40px;top:540px;width:200px;height:30px;background:white;color:black';
    target.textContent = 'Fixed target';
    document.body.append(target);
    window.__visibilityCoachmark = createSiteTrainingCoachmark();
    window.__visibilityCoachmark.open();
    window.__visibilityCoachmark.render({ step: {
      id: 'boundary', title: 'Read the target', description: 'The highlighted control is here.', target: 'boundary-fixture',
    }, index: 1, total: 3 });
  });
  await expect(page.locator('.site-training-layer')).toHaveClass(/has-target/);
  await page.evaluate(() => {
    document.querySelector('[data-training-target="boundary-fixture"]').style.top = '800px';
    window.dispatchEvent(new Event('scroll'));
  });
  await expect(page.locator('#siteTrainingFallback')).toBeVisible();
  await expect(page.locator('.site-training-layer')).not.toHaveClass(/has-target/);
  await page.evaluate(() => {
    document.querySelector('[data-training-target="boundary-fixture"]').style.top = '540px';
    window.dispatchEvent(new Event('scroll'));
  });
  await expect(page.locator('.site-training-layer')).toHaveClass(/has-target/);
  await expect(page.locator('#siteTrainingFallback')).toBeHidden();
  await expect(page.locator('.site-training-coachmark')).toHaveAttribute('aria-describedby', 'siteTrainingDescription');
});

test('phone Resume reveals the real scorecard without entrance blur or movement', async ({ page, app }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await app.open(ROUTE_BY_ID.dashboard, { state: 'activeSolo' });
  await page.addInitScript(() => {
    let sequence = 1000;
    Object.defineProperty(crypto, 'randomUUID', { configurable: true,
      value: () => `00000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, '0')}` });
  });
  await page.evaluate(() => {
    let sequence = 0;
    Object.defineProperty(crypto, 'randomUUID', { configurable: true,
      value: () => `00000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, '0')}` });
  });
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('button', { name: 'Start Training', exact: true }).click();
  for (let step = 1; step < 6; step += 1) await page.locator('[data-training-action="next"]').click();
  await expect(page.locator('#siteTrainingProgress')).toContainText('Step 6 of 9');
  await page.locator('[data-training-action="stop"]').click();
  await page.reload();
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('button', { name: 'Resume Training', exact: true }).click();
  await expect(page.locator('#siteTrainingProgress')).toContainText('Step 6 of 9');
  await expect(page.locator('body')).not.toHaveClass(/menu-open/);
  await expectPhoneLessonReadable(page);
  // Observe consecutive frames rather than waiting out the animation: training
  // must reveal the actual target immediately and keep the card stable.
  const frames = await page.evaluate(async () => {
    const result = [];
    for (let frame = 0; frame < 45; frame += 1) {
      await new Promise(requestAnimationFrame);
      const target = document.querySelector('.site-training-target');
      const rect = target.getBoundingClientRect();
      const css = getComputedStyle(target);
      const hole = document.querySelector('.site-training-spotlight').getBoundingClientRect();
      const heading = document.getElementById('todaysScorecardTitle').getBoundingClientRect();
      const button = document.querySelector('[data-training-action="stop"]').getBoundingClientRect();
      result.push({ top: rect.top, buttonTop: button.top, transform: css.transform,
        filter: css.filter, opacity: css.opacity,
        headingVisible: heading.top >= hole.top && heading.bottom <= hole.bottom });
    }
    return result;
  });
  expect(frames.every((frame) => frame.top >= 12 && frame.headingVisible
    && frame.transform === 'none' && frame.filter === 'none' && frame.opacity === '1')).toBe(true);
  expect(Math.max(...frames.map((frame) => frame.top)) - Math.min(...frames.map((frame) => frame.top))).toBeLessThan(1);
  expect(Math.max(...frames.map((frame) => frame.buttonTop)) - Math.min(...frames.map((frame) => frame.buttonTop))).toBeLessThan(1);
  await page.locator('[data-training-action="stop"]').click();
  await expect(page.locator('.site-training-target')).toHaveCount(0);
  await expect(page.locator('.site-training-reveal-settled')).toHaveCount(0);
  await expect(page.locator('.global-menu-button')).toBeFocused();
});
