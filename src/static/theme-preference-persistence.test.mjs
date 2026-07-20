import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path) => readFile(resolve(repoRoot, path), 'utf8');

test('theme choices reconcile with an authenticated server preference on every route', async () => {
  const [api, hydration, profile, menu] = await Promise.all([
    read('src/static/api.js'),
    read('src/static/theme-entitlement-state.js'),
    read('src/static/profile.js'),
    read('src/static/menu.js'),
  ]);

  assert.match(api, /client\.rpc\('get_theme_preference'\)/);
  assert.match(api, /client\.rpc\('set_theme_preference'/);
  assert.match(hydration, /Promise\.all\(\[[\s\S]*getRewardCatalog[\s\S]*getThemePreference/);
  assert.match(hydration, /setThemeEntitlements[\s\S]*setTheme\(preferredTheme\)/);
  assert.match(profile, /setTheme\(themeId\)[\s\S]*await setThemePreference\(themeId\)/);
  assert.match(profile, /setTheme\(previousTheme\)/);
  assert.match(menu, /hydrateThemeEntitlementState\(\)/);
});

test('logout clears the browser preference while mock server preferences stay user-scoped', async () => {
  const api = await read('src/static/api.js');

  assert.match(api, /MOCK_THEME_PREFERENCES_KEY = 'dominion:mockThemePreferences'/);
  assert.match(api, /preferences\[userId\] = preference/);
  assert.match(api, /clearAuthSession[\s\S]*localStorage\.removeItem\('dominion:theme'\)/);
  assert.match(api, /getLocalOrSessionUser[\s\S]*userId: getMockUserId\(\)/);
});

test('the database accepts public themes but validates Dominion Night ownership', async () => {
  const [migration, schema] = await Promise.all([
    read('supabase/migrations/20260720230000_user_theme_preferences.sql'),
    read('supabase/schema.sql'),
  ]);

  assert.match(migration, /theme_key in \('dark', 'light', 'dominion-night'\)/);
  assert.match(migration, /normalized_theme_key = 'dominion-night'[\s\S]*user_reward_entitlements/);
  assert.match(migration, /reward_key = 'dominion_night_theme'/);
  assert.match(migration, /revoke all on public\.user_theme_preferences from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.set_theme_preference\(text\) to authenticated/);
  assert.match(schema, /20260720230000_user_theme_preferences\.sql/);
});
