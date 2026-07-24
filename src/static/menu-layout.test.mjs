import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const menuCss = readFileSync(new URL('../assets/menu.css', import.meta.url), 'utf8');
const productCss = readFileSync(new URL('../assets/product.css', import.meta.url), 'utf8');
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
        const clearThemeEntitlementState = () => {};
        const hydrateThemeEntitlementState = async () => ({});
        const initThemeState = () => {};
        const initThemeAssets = () => {};
        ${menuJs.replace(/^import[\s\S]*?from .*;$/gm, '')}
      `;
      await import(`data:text/javascript;base64,${Buffer.from(executableSource).toString('base64')}`);

      runScrollFrame(13);
      assert.equal(topbar.classList.contains('topbar-collapsed'), true);
      assert.equal(topbar.classList.contains('topbar-scrolled'), true);

      runScrollFrame(7);
      assert.equal(topbar.classList.contains('topbar-collapsed'), true, 'minor upward scrolling must not expand the menu');

      runScrollFrame(0);
      assert.equal(topbar.classList.contains('topbar-collapsed'), false);
      assert.equal(topbar.classList.contains('topbar-scrolled'), false);

      body.classList.add('menu-open');
      runScrollFrame(40);
      assert.equal(topbar.classList.contains('topbar-collapsed'), false, 'the open navigation must remain full size');
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

  test('preserves mobile touch targets, safe areas, and reduced-motion preferences', () => {
    const menuButton = declarationsFor('.global-menu-button');
    const reducedMotion = menuCss.slice(menuCss.indexOf('@media (prefers-reduced-motion: reduce)'));

    assert.match(menuButton, /width:\s*46px/);
    assert.match(menuButton, /height:\s*46px/);
    assert.match(menuCss, /\.global-menu-button\s*\{\s*width:\s*44px;\s*height:\s*44px;/);
    assert.doesNotMatch(menuCss, /\.topbar\.topbar-collapsed > \*\s*\{[^}]*transform\s*:/s);
    assert.match(productCss, /\.topbar\.topbar-collapsed \.dashboard-streak-button\s*\{[^}]*transform:\s*none/s);
    assert.match(productCss, /\.topbar\.topbar-collapsed \.dashboard-streak-button > \*\s*\{[^}]*transform:\s*scale\(\.9\)/s);
    assert.match(productCss, /\.dashboard-streak-button > \*\s*\{[^}]*transition:\s*transform/s);
    assert.match(productCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.dashboard-streak-button > \*\s*\{[^}]*transition:\s*none/s);
    assert.match(menuCss, /env\(safe-area-inset-top\)/);
    assert.match(menuCss, /env\(safe-area-inset-right\)/);
    assert.match(reducedMotion, /\.topbar::before/);
    assert.match(reducedMotion, /\.global-menu/);
    assert.match(reducedMotion, /transition:\s*none\s*!important/);
  });
});
