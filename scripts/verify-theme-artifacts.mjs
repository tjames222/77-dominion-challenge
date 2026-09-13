import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

import { PRODUCTION_ENTRYPOINTS } from '../app-entrypoints.mjs';

const attribute = (tag, name) => tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1];

// Exercise the shipped bootstrap, not a second registry or the source copy.
function verifyRuntime(source, enabled, route) {
  for (const preference of ['dark', 'light', 'dominion-night', 'unknown-theme']) {
    const attributes = new Map([['data-theme', 'dark']]);
    const context = {
      localStorage: {
        getItem: () => JSON.stringify(preference),
        setItem() {},
      },
      document: {
        currentScript: { dataset: { enableDominionNight: String(enabled) } },
        documentElement: {
          style: { removeProperty() {} },
          setAttribute: (key, value) => attributes.set(key, value),
          getAttribute: (key) => attributes.get(key),
          removeAttribute: (key) => attributes.delete(key),
        },
        querySelector: () => null,
      },
      setTimeout: () => 1,
      clearTimeout() {},
    };
    vm.runInNewContext(source, context, { filename: `${route}:theme-bootstrap.js`, timeout: 1000 });
    const runtime = context.DominionThemeRuntime;
    const night = runtime?.getTheme('dominion-night');
    assert.equal(night?.availability.enabled, enabled, `${route}: release availability differs`);
    assert.equal(night?.availability.requiresEntitlement, true, `${route}: ownership is required`);
    assert.equal(night?.availability.featureFlag, 'VITE_ENABLE_DOMINION_NIGHT_THEME');
    assert.equal(Object.isFrozen(night.availability), true, `${route}: registry must be immutable`);
    assert.equal(runtime.isThemeAvailable('dark'), true);
    assert.equal(runtime.isThemeAvailable('light'), true);
    assert.equal(runtime.isThemeAvailable('dominion-night'), false, `${route}: unverified owner`);
    assert.equal(runtime.getActiveTheme(), preference === 'light' ? 'light' : 'dark');
    assert.equal(runtime.applyTheme('dominion-night'), 'dark', `${route}: tampered preference`);
    runtime.setThemeEntitlements(['dominion-night']);
    assert.equal(runtime.isThemeAvailable('dominion-night'), enabled);
    assert.equal(runtime.applyTheme('dominion-night'), enabled ? 'dominion-night' : 'dark');
    runtime.setThemeEntitlements([]);
    assert.equal(runtime.getActiveTheme(), preference === 'light' ? 'light' : 'dark');
    assert.equal(runtime.applyTheme('unknown-theme'), 'dark');
  }
}

export async function verifyThemeArtifacts({
  distRoot = new URL('../dist/', import.meta.url),
  environment = process.env,
  entrypoints = Object.values(PRODUCTION_ENTRYPOINTS),
} = {}) {
  const canonical = ['1', 'true', 'yes'].includes(String(environment.CF_PAGES || '').trim().toLowerCase())
    && ['main', 'develop'].includes(String(environment.CF_PAGES_BRANCH || '').trim());
  const requireEnabled = canonical || environment.VITE_ENABLE_DOMINION_NIGHT_THEME === 'true';
  const readAsset = async (path) => {
    const url = new URL(path.replace(/^\//, ''), distRoot);
    assert.ok(url.href.startsWith(distRoot.href), 'Theme assets must remain inside the immutable artifact');
    return readFile(url, 'utf8');
  };
  const assetCache = new Map();
  const cachedAsset = (path) => {
    if (!assetCache.has(path)) assetCache.set(path, readAsset(path));
    return assetCache.get(path);
  };

  for (const route of entrypoints) {
    const html = await readAsset(route);
    const bootstrapTags = [...html.matchAll(/<script\b[^>]*>/gi)]
      .map(([tag]) => tag)
      .filter((tag) => attribute(tag, 'src')?.endsWith('theme-bootstrap.js'));
    assert.equal(bootstrapTags.length, 1, `${route}: must load one theme bootstrap`);
    const tag = bootstrapTags[0];
    const flag = attribute(tag, 'data-enable-dominion-night');
    assert.ok(['true', 'false'].includes(flag), `${route}: missing theme release state`);
    if (requireEnabled) assert.equal(flag, 'true', `${route}: Dominion Night must be release-enabled`);
    assert.doesNotMatch(tag, /\s(?:async|defer)(?:\s|=|>)/i, `${route}: bootstrap must run before paint`);
    const firstStylesheet = [...html.matchAll(/<link\b[^>]*>/gi)]
      .find(([link]) => attribute(link, 'rel') === 'stylesheet');
    if (firstStylesheet) {
      assert.ok(html.indexOf(tag) < firstStylesheet.index, `${route}: bootstrap must precede stylesheets`);
    }
    verifyRuntime(await cachedAsset(attribute(tag, 'src')), flag === 'true', route);

    const stylesheets = [...html.matchAll(/<link\b[^>]*>/gi)]
      .map(([link]) => link)
      .filter((link) => attribute(link, 'rel') === 'stylesheet')
      .map((link) => attribute(link, 'href'));
    const css = (await Promise.all(stylesheets.map(cachedAsset))).join('\n');
    const profile = css.match(/:root\[data-theme=(?:"dominion-night"|'dominion-night'|dominion-night)\]\s*\{([^}]+)\}/)?.[1];
    assert.ok(profile, `${route}: linked CSS is missing the Dominion Night profile`);
    for (const token of ['--background', '--surface', '--text', '--accent', '--focus-ring']) {
      assert.ok(profile.includes(`${token}:`), `${route}: theme profile lacks ${token}`);
    }
  }
  return entrypoints.length;
}
