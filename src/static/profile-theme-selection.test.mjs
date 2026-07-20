import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path) => readFile(resolve(repoRoot, path), 'utf8');

test('Profile exposes public themes and a fail-closed Dominion Night reward option', async () => {
  const html = await read('profile.html');
  const profile = await read('src/static/profile.js');

  assert.match(html, /id="appearance"/);
  assert.match(html, /data-theme-mode="dark"/);
  assert.match(html, /data-theme-mode="light"/);
  assert.match(html, /data-theme-mode="dominion-night"[\s\S]*aria-disabled="true"/);
  assert.match(html, /role="progressbar"[\s\S]*aria-valuemin="0"[\s\S]*aria-valuemax="100"/);
  assert.match(html, /id="themeSelectionStatus"[^>]*role="status"[^>]*aria-live="polite"/);

  assert.match(profile, /buildThemeOptionModels\(catalog, registry\)/);
  assert.match(profile, /hydrateThemeEntitlementState\(\)/);
  assert.match(profile, /setAttribute\('aria-disabled', String\(!model\?\.available\)\)/);
  assert.match(profile, /setTheme\(themeId\)/);
  assert.doesNotMatch(profile, /(?:points|totalPoints)\s*>=\s*500/);
});

test('all routes hydrate authoritative theme ownership and clear it on logout', async () => {
  const menu = await read('src/static/menu.js');
  const hydration = await read('src/static/theme-entitlement-state.js');

  assert.match(menu, /hydrateThemeEntitlementState\(\)/);
  assert.match(menu, /clearThemeEntitlementState\(\)[\s\S]*clearAuthSession\(\)/);
  assert.match(hydration, /getLocalOrSessionUser\(\)/);
  assert.match(hydration, /getRewardCatalog\(\{ limit: 100 \}\)/);
  assert.match(hydration, /deriveAuthorizedThemeIds\(catalog, getThemeRegistry\(\)\)/);
  assert.match(hydration, /setThemeEntitlements\(\[\]\)/);
  assert.doesNotMatch(hydration, /localStorage|sessionStorage/);
});
