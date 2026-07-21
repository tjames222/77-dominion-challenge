import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path) => readFile(resolve(repoRoot, path), 'utf8');

test('Profile exposes an accessible fail-closed Dominion Night reward option', async () => {
  const html = await read('profile.html');
  const nightButton = html.match(/<button(?=[^>]*data-theme-mode="dominion-night")[\s\S]*?<\/button>/)?.[0] || '';

  assert.match(nightButton, /aria-disabled="true"/);
  assert.doesNotMatch(nightButton, /\sdisabled(?:\s|>)/);
  assert.match(nightButton, /aria-describedby="dominionNightStatus dominionNightProgressLabel"/);
  assert.doesNotMatch(nightButton, /role="progressbar"/);
  assert.match(html, /role="progressbar"[\s\S]*aria-valuemin="0"[\s\S]*aria-valuemax="100"/);
  assert.match(html, /id="themeSelectionStatus" role="status" aria-live="polite"/);
});

test('Profile renders catalog models without duplicating the reward threshold', async () => {
  const [profile, html] = await Promise.all([
    read('src/static/profile.js'),
    read('profile.html'),
  ]);

  assert.match(profile, /buildThemeOptionModels/);
  assert.match(profile, /hydrateThemeEntitlementState/);
  assert.match(profile, /pointsRequired/);
  assert.match(profile, /pointsRemaining/);
  assert.doesNotMatch(profile, /\b500\b/);
  assert.doesNotMatch(html, /\b500\b/);
});

test('shared route hydration clears authorization before verification, on failure, and on logout', async () => {
  const [state, menu] = await Promise.all([
    read('src/static/theme-entitlement-state.js'),
    read('src/static/menu.js'),
  ]);

  const firstClear = state.indexOf('setThemeEntitlements([])');
  const catalogRead = state.indexOf('getRewardCatalog(');
  assert.ok(firstClear !== -1 && firstClear < catalogRead);
  assert.ok(state.match(/setThemeEntitlements\(\[\]\)/g)?.length >= 2);
  assert.doesNotMatch(state, /localStorage|sessionStorage/);
  assert.match(menu, /hydrateThemeEntitlementState\(\)/);
  assert.match(menu, /clearThemeEntitlementState\(\);[\s\S]*clearAuthSession\(\)/);
});
