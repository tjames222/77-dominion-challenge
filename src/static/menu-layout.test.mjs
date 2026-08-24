import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const menuCss = readFileSync(new URL('../assets/menu.css', import.meta.url), 'utf8');
const dominionNightCss = readFileSync(new URL('../assets/dominion-night.css', import.meta.url), 'utf8');
const menuJs = readFileSync(new URL('./menu.js', import.meta.url), 'utf8');

function declarationsFor(selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return menuCss.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`))?.[1] || '';
}

function createClassList() {
  const classes = new Set();

  return {
    add: (...names) => names.forEach((name) => classes.add(name)),
    remove: (...names) => names.forEach((name) => classes.delete(name)),
    contains: (name) => classes.has(name),
    toggle(name, force) {
      const shouldAdd = force === undefined ? !classes.has(name) : Boolean(force);
      if (shouldAdd) classes.add(name);
      else classes.delete(name);
      return shouldAdd;
    },
  };
}

describe('shared sticky menu', () => {
  test('enters a compact state near the top and restores only at the top', async () => {
    const topbar = {
      classList: createClassList(),
      getBoundingClientRect: () => ({ height: 72 }),
    };
    const memberTabs = {
      classList: createClassList(),
      getBoundingClientRect: () => ({ height: 56 }),
    };
    const secondaryTabs = {
      classList: createClassList(),
      getBoundingClientRect: () => ({ height: 56 }),
    };
    const body = { classList: createClassList(), appendChild() {} };
    const listeners = new Map();
    const animationFrames = [];
    const windowMock = {
      scrollY: 0,
      addEventListener(type, listener) {
        const handlers = listeners.get(type) || [];
        handlers.push(listener);
        listeners.set(type, handlers);
      },
      requestAnimationFrame(callback) {
        animationFrames.push(callback);
      },
    };
    const documentMock = {
      body,
      documentElement: { style: { setProperty() {} } },
      querySelector(selector) {
        if (selector === '.topbar') return topbar;
        if (selector === '[data-member-tabs]') return memberTabs;
        if (selector === '[data-sticky-secondary-tabs]') return secondaryTabs;
        if (selector === '.global-menu') return {};
        return null;
      },
      addEventListener() {},
    };

    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;
    globalThis.window = windowMock;
    globalThis.document = documentMock;

    const runScrollFrame = (scrollY) => {
      windowMock.scrollY = scrollY;
      listeners.get('scroll')?.forEach((listener) => listener());
      animationFrames.splice(0).forEach((callback) => callback());
    };

    try {
      const executableSource = `
        const clearAuthSession = async () => {};
        const getLocalOrSessionUser = async () => null;
        const subscribeToAuthStateChanges = () => () => {};
        const clearThemeEntitlementState = () => {};
        const hydrateThemeEntitlementState = async () => ({});
        const initThemeState = () => {};
        const initThemeAssets = () => {};
        const SOLO_TRAINING_LAUNCH_EVENT = 'dominion:solo-training-launch-requested';
        const SOLO_TRAINING_LAUNCH_STORAGE_KEY = 'dominion:soloTrainingLaunchRequests';
        const createSoloFirstRunTraining = () => ({
          available: false,
          attachControl() {}, destroy() {}, refresh: async () => {}, consumeHandoff: async () => {},
        });
        const createPageTrainingControls = () => ({
          available: false,
          attachControls() {}, destroy() {}, refresh: async () => {},
        });
        ${menuJs.replace(/^import[\s\S]*?from .*;$/gm, '')}
      `;
      await import(`data:text/javascript;base64,${Buffer.from(executableSource).toString('base64')}`);

      runScrollFrame(13);
      assert.equal(topbar.classList.contains('topbar-collapsed'), true);
      assert.equal(topbar.classList.contains('topbar-scrolled'), true);
      assert.equal(memberTabs.classList.contains('member-tabs-collapsed'), true);
      assert.equal(memberTabs.classList.contains('member-tabs-scrolled'), true);
      assert.equal(secondaryTabs.classList.contains('secondary-tabs-scrolled'), true);

      runScrollFrame(7);
      assert.equal(topbar.classList.contains('topbar-collapsed'), true, 'minor upward scrolling must not expand the menu');

      runScrollFrame(0);
      assert.equal(topbar.classList.contains('topbar-collapsed'), false);
      assert.equal(topbar.classList.contains('topbar-scrolled'), false);
      assert.equal(memberTabs.classList.contains('member-tabs-collapsed'), false);
      assert.equal(memberTabs.classList.contains('member-tabs-scrolled'), false);
      assert.equal(secondaryTabs.classList.contains('secondary-tabs-scrolled'), false);

      body.classList.add('menu-open');
      runScrollFrame(40);
      assert.equal(topbar.classList.contains('topbar-collapsed'), false, 'the open navigation must remain full size');
      assert.equal(memberTabs.classList.contains('member-tabs-collapsed'), false, 'the primary navigation must remain full size while the drawer is open');
    } finally {
      globalThis.window = originalWindow;
      globalThis.document = originalDocument;
    }
  });

  test('keeps the sticky layout footprint stable while compacting the visual surface', () => {
    const body = declarationsFor('body');
    const topbarDeclarations = declarationsFor('.topbar');
    const compactSurface = declarationsFor('.topbar.topbar-collapsed::before');
    const compactItems = declarationsFor('.topbar.topbar-collapsed > *');

    assert.match(body, /overflow-x:\s*clip/, 'the body must not become the sticky menu scroll container');
    assert.doesNotMatch(body, /overflow-y\s*:/);
    assert.match(topbarDeclarations, /position:\s*sticky/);
    assert.match(topbarDeclarations, /top:\s*0/);
    assert.match(topbarDeclarations, /border-bottom:\s*1px solid transparent/);
    assert.match(compactSurface, /transform:\s*scaleY\(\.9\)/);
    assert.match(compactSurface, /background:\s*color-mix\([^;]*78%/);
    assert.doesNotMatch(compactSurface, /(?:min-)?height\s*:|padding\s*:|margin\s*:/);
    assert.doesNotMatch(compactItems, /(?:min-)?height\s*:|padding\s*:|margin\s*:|transform\s*:/);
    assert.match(dominionNightCss, /:root\[data-theme="dominion-night"\] \.topbar::before\s*\{/);
    assert.match(dominionNightCss, /:root\[data-theme="dominion-night"\] \.topbar\.topbar-collapsed::before\s*\{/);
  });

  test('uses the measured wrapped-header height for anchor and scorecard scrolling', () => {
    const productCss = readFileSync(new URL('../assets/product.css', import.meta.url), 'utf8');
    assert.match(menuCss, /scroll-padding-top:\s*calc\(var\(--topbar-sticky-height\) \+ var\(--member-tabs-sticky-height\) \+ 24px\)/);
    assert.match(menuJs, /root\.style\.setProperty\('--member-tabs-sticky-height'/);
    assert.match(menuJs, /root\.style\.setProperty\('--secondary-tabs-sticky-height'/);
    assert.match(productCss, /\.dashboard-scorecard\s*\{[\s\S]*scroll-margin-top:\s*calc\(var\(--topbar-sticky-height\) \+ var\(--member-tabs-sticky-height\) \+ 24px\)/);
    assert.doesNotMatch(menuCss, /scroll-padding-top:\s*calc\((?:76|88)px/);
  });

  test('preserves mobile touch targets, safe areas, and reduced-motion preferences', () => {
    const menuButton = declarationsFor('.global-menu-button');
    const reducedMotion = menuCss.slice(menuCss.indexOf('@media (prefers-reduced-motion: reduce)'));

    assert.match(menuButton, /width:\s*46px/);
    assert.match(menuButton, /height:\s*46px/);
    assert.match(menuCss, /\.global-menu-button\s*\{\s*width:\s*44px;\s*height:\s*44px;/);
    assert.doesNotMatch(menuCss, /\.topbar\.topbar-collapsed > \*\s*\{[^}]*transform\s*:/s);
    assert.match(menuCss, /\.topbar\.topbar-collapsed \.shared-header-action > \*\s*\{[^}]*transform:\s*scale\(\.94\)/s);
    assert.match(menuCss, /\.shared-header-action > \*\s*\{[^}]*transition:\s*transform/s);
    assert.match(reducedMotion, /\.shared-header-action/);
    assert.doesNotMatch(menuCss, /dashboard-streak-button|streak-details-/);
    assert.match(menuCss, /env\(safe-area-inset-top\)/);
    assert.match(menuCss, /env\(safe-area-inset-right\)/);
    assert.match(reducedMotion, /\.topbar::before/);
    assert.match(reducedMotion, /\.global-menu/);
    assert.match(reducedMotion, /transition:\s*none\s*!important/);
  });

  test('fully hides the closed drawer visually and from interaction', () => {
    const drawer = declarationsFor('.global-menu');
    const backdrop = declarationsFor('.global-menu-backdrop');
    const openDrawer = declarationsFor('.menu-open .global-menu');

    assert.match(drawer, /visibility:\s*hidden/);
    assert.match(drawer, /pointer-events:\s*none/);
    assert.match(drawer, /box-shadow:\s*none/);
    assert.match(backdrop, /visibility:\s*hidden/);
    assert.match(openDrawer, /visibility:\s*visible/);
    assert.match(openDrawer, /pointer-events:\s*auto/);
    assert.match(openDrawer, /box-shadow:\s*-24px 0 80px/);
    assert.match(menuJs, /menu\.inert = !isOpen/);
    assert.match(menuJs, /menu\.setAttribute\('aria-hidden', String\(!isOpen\)\)/);
    assert.match(menuJs, /button\.setAttribute\('aria-controls', menu\.id\)/);
    assert.match(menuJs, /event\.key !== 'Tab'/);
    assert.match(menuJs, /styles\.display !== 'none'/);
    assert.match(menuJs, /styles\.visibility !== 'hidden'/);
    assert.match(menuJs, /focusIsOutside \|\| document\.activeElement === first/);
    assert.match(menuJs, /document\.activeElement === last/);
  });

  test('keeps authenticated site training independent from optional header actions', () => {
    assert.match(menuJs, /if \(!pageTrainingControls\)[\s\S]*?createPageTrainingControls/);
    assert.ok(
      menuJs.indexOf('createPageTrainingControls({')
        < menuJs.indexOf('createSoloFirstRunTraining({'),
      'the page controller must create the shared runtime before Solo subscribes',
    );
    assert.match(menuJs, /if \(nextTraining\.available\)/);
    assert.doesNotMatch(
      menuJs,
      /if \(showMemberActions && nextOwner\) \{\s*if \(!soloFirstRunTraining\)/,
    );
    assert.match(
      menuJs,
      /addEventListener\('dominion:challenge-start-date-updated',[\s\S]*?invalidateCachedActivation:\s*true/,
    );
    assert.match(menuCss, /\.global-menu-training\[hidden\]\s*\{\s*display:\s*none/);
    assert.match(menuCss, /\.global-menu-page-training\[hidden\]/);
    assert.match(menuJs, /Start page training/);
    assert.match(menuJs, /Restart page training/);
    assert.match(menuJs, /role="alert" aria-live="assertive"/);
    assert.match(menuJs, /runtime:\s*pageTrainingControls\?\.runtime \|\| null/);
    assert.match(menuJs, /function openMenu\(\) \{\s*void refreshTrainingControllers\(\)/);
    assert.match(
      menuJs,
      /else \{\s*pageTrainingRefresh = pageTrainingControls\.refresh\(\{ hideWhileLoading: true \}\)/,
    );
    assert.match(menuJs, /autoOpen:\s*false,[\s\S]*?consumeHandoff:\s*false/);
    const trainingMarkup = menuJs.match(
      /<section class="global-menu-training-section" aria-label="Training" hidden>([\s\S]*?)<\/section>/,
    );
    assert.ok(trainingMarkup, 'authenticated navigation must have one semantic Training section');
    assert.match(trainingMarkup[1], /class="global-menu-training"/);
    assert.match(trainingMarkup[1], /class="global-menu-page-training-primary"/);
    assert.match(trainingMarkup[1], /class="global-menu-page-training-restart"/);
    assert.equal(
      (menuJs.match(/<section class="global-menu-training-section"/g) || []).length,
      1,
    );
    const drawer = declarationsFor('.global-menu');
    assert.match(drawer, /overflow-y:\s*auto/);
    assert.match(drawer, /overscroll-behavior:\s*contain/);
  });
});
