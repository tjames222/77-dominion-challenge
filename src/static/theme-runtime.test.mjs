import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const bootstrapSource = await readFile(resolve(repoRoot, 'public/theme-bootstrap.js'), 'utf8');

function runBootstrap({ storedTheme = null, dominionNightEnabled = false, storageError = false } = {}) {
  const attributes = new Map([['data-theme', 'dark']]);
  const writes = [];
  const events = [];
  let themeColor = '#0e1116';

  const context = {
    localStorage: {
      getItem(key) {
        if (storageError) throw new Error('storage unavailable');
        return key === 'dominion:theme' ? storedTheme : null;
      },
      setItem(key, value) {
        if (storageError) throw new Error('storage unavailable');
        writes.push([key, value]);
      },
    },
    document: {
      currentScript: {
        dataset: { enableDominionNight: String(dominionNightEnabled) },
      },
      documentElement: {
        style: {},
        setAttribute(name, value) {
          attributes.set(name, value);
        },
        getAttribute(name) {
          return attributes.get(name) || null;
        },
      },
      querySelector(selector) {
        if (selector !== 'meta[name="theme-color"]') return null;
        return {
          setAttribute(name, value) {
            if (name === 'content') themeColor = value;
          },
        };
      },
    },
    CustomEvent: class CustomEvent {
      constructor(type, options) {
        this.type = type;
        this.detail = options?.detail;
      }
    },
    dispatchEvent(event) {
      events.push(event);
      return true;
    },
  };

  vm.runInNewContext(bootstrapSource, context, { filename: 'theme-bootstrap.js' });

  return {
    runtime: context.DominionThemeRuntime,
    root: context.document.documentElement,
    activeTheme: () => attributes.get('data-theme'),
    themeColor: () => themeColor,
    writes,
    events,
  };
}

test('early bootstrap applies existing Light and Dark preferences synchronously', () => {
  const light = runBootstrap({ storedTheme: JSON.stringify('light') });
  assert.equal(light.activeTheme(), 'light');
  assert.equal(light.root.style.colorScheme, 'light');
  assert.equal(light.themeColor(), '#fbfaf7');

  const dark = runBootstrap({ storedTheme: JSON.stringify('dark') });
  assert.equal(dark.activeTheme(), 'dark');
  assert.equal(dark.root.style.colorScheme, 'dark');
  assert.equal(dark.themeColor(), '#0e1116');
});

test('registry exposes stable theme metadata and dark asset fallback', () => {
  const { runtime } = runBootstrap({ dominionNightEnabled: true });
  const night = runtime.getTheme('dominion-night');

  assert.deepEqual(
    Array.from(runtime.themes, (theme) => theme.id),
    ['dark', 'light', 'dominion-night'],
  );
  assert.equal(night.label, 'Dominion Night');
  assert.equal(night.colorScheme, 'dark');
  assert.equal(night.assets.variant, 'dominion-night');
  assert.equal(night.assets.fallback, 'dark');
  assert.equal(night.availability.featureFlag, 'VITE_ENABLE_DOMINION_NIGHT_THEME');
  assert.equal(night.availability.requiresEntitlement, true);
  assert.deepEqual(Array.from(runtime.getAssetVariants(night.id)), ['dominion-night', 'dark']);
});

test('Dominion Night is locked by default and can be activated only by the bootstrap flag', () => {
  const locked = runBootstrap({ storedTheme: JSON.stringify('dominion-night') });
  assert.equal(locked.runtime.isThemeAvailable('dominion-night'), false);
  assert.equal(locked.activeTheme(), 'dark');
  assert.equal(locked.root.style.colorScheme, 'dark');
  assert.equal(Object.isFrozen(locked.runtime), true);
  assert.equal(Object.isFrozen(locked.runtime.getTheme('dominion-night').availability), true);
  assert.throws(() => {
    locked.runtime.getTheme('dominion-night').availability.enabled = true;
  });

  const enabled = runBootstrap({
    storedTheme: JSON.stringify('dominion-night'),
    dominionNightEnabled: true,
  });
  assert.equal(enabled.runtime.isThemeAvailable('dominion-night'), true);
  assert.equal(enabled.activeTheme(), 'dominion-night');
  assert.equal(enabled.root.style.colorScheme, 'dark');
});

test('unknown, removed, malformed, and unavailable stored themes fall back safely', () => {
  for (const storedTheme of [
    JSON.stringify('removed-theme'),
    JSON.stringify({ id: 'light' }),
    '{broken-json',
  ]) {
    const result = runBootstrap({ storedTheme });
    assert.equal(result.activeTheme(), 'dark');
    assert.equal(result.runtime.getActiveTheme(), 'dark');
  }

  const unavailableStorage = runBootstrap({ storageError: true });
  assert.equal(unavailableStorage.activeTheme(), 'dark');
});

test('shared setter normalizes selections, persists JSON, and emits one change event', () => {
  const enabled = runBootstrap({ dominionNightEnabled: true });
  assert.equal(enabled.runtime.setTheme('dominion-night'), 'dominion-night');
  assert.deepEqual(enabled.writes, [['dominion:theme', JSON.stringify('dominion-night')]]);
  assert.equal(enabled.events.length, 1);
  assert.equal(enabled.events[0].detail.theme, 'dominion-night');

  const locked = runBootstrap();
  assert.equal(locked.runtime.setTheme('dominion-night'), 'dark');
  assert.deepEqual(locked.writes, [['dominion:theme', JSON.stringify('dark')]]);
});

test('every HTML entry blocks on the shared bootstrap before stylesheets', async () => {
  const htmlFiles = (await readdir(repoRoot)).filter((file) => file.endsWith('.html')).sort();
  assert.ok(htmlFiles.length >= 10, 'expected every current application entry');

  for (const file of htmlFiles) {
    const html = await readFile(resolve(repoRoot, file), 'utf8');
    const bootstrapIndex = html.indexOf('src="./theme-bootstrap.js"');
    const stylesheetIndex = html.indexOf('rel="stylesheet"');
    const themeMetaIndex = html.indexOf('name="theme-color"');

    assert.notEqual(bootstrapIndex, -1, `${file} is missing the early theme bootstrap`);
    assert.ok(themeMetaIndex < bootstrapIndex, `${file} must define theme-color before bootstrap`);
    assert.ok(bootstrapIndex < stylesheetIndex, `${file} must bootstrap before loading CSS`);
    assert.equal(html.match(/src="\.\/theme-bootstrap\.js"/g)?.length, 1, `${file} must bootstrap once`);
    assert.doesNotMatch(html, /localStorage\.getItem\(['"]dominion:theme/);
  }
});

test('page modules no longer own independent binary theme state', async () => {
  const pageModules = [
    'auth.js',
    'dashboard.js',
    'landing.js',
    'membership.js',
    'profile.js',
    'science.js',
  ];

  for (const file of pageModules) {
    const source = await readFile(resolve(repoRoot, 'src/static', file), 'utf8');
    assert.doesNotMatch(source, /localStorage\.(?:getItem|setItem)\(['"]dominion:theme/);
    assert.doesNotMatch(source, /document\.documentElement\.dataset\.theme\s*=/);
    assert.doesNotMatch(source, /theme\s*===\s*['"]dark['"]\s*\?\s*['"]light['"]/);
  }
});
