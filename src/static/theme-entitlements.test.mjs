import assert from 'node:assert/strict';
import test from 'node:test';
import { DOMINION_NIGHT_THEME_REWARD } from './reward-catalog.mjs';
import { buildThemeOptionModels, deriveAuthorizedThemeIds } from './theme-entitlements.mjs';

const registry = [
  {
    id: 'dark',
    label: 'Dark',
    availability: { enabled: true, requiresEntitlement: false },
  },
  {
    id: 'light',
    label: 'Light',
    availability: { enabled: true, requiresEntitlement: false },
  },
  {
    id: 'dominion-night',
    label: 'Dominion Night',
    availability: { enabled: true, requiresEntitlement: true },
  },
];

const nightReward = (overrides = {}) => ({
  ...DOMINION_NIGHT_THEME_REWARD,
  status: 'locked',
  currentPoints: 125,
  pointsRemaining: DOMINION_NIGHT_THEME_REWARD.pointsRequired - 125,
  progressPercent: 25,
  ...overrides,
});

test('authorizes an entitlement theme only from an active owned catalog record', () => {
  const locked = { totalPoints: 125, items: [nightReward()] };
  assert.deepEqual(deriveAuthorizedThemeIds(locked, registry), []);
  assert.deepEqual(deriveAuthorizedThemeIds(null, registry), []);

  const owned = { totalPoints: 500, items: [nightReward({ status: 'owned' })] };
  assert.deepEqual(deriveAuthorizedThemeIds(owned, registry), ['dominion-night']);

  const inactive = { totalPoints: 500, items: [nightReward({ status: 'owned', active: false })] };
  assert.deepEqual(deriveAuthorizedThemeIds(inactive, registry), []);
});

test('builds accessible locked progress from the typed reward catalog definition', () => {
  const models = buildThemeOptionModels({ totalPoints: 125, items: [nightReward()] }, registry);
  const dark = models.find((model) => model.themeId === 'dark');
  const night = models.find((model) => model.themeId === 'dominion-night');

  assert.equal(dark.status, 'public');
  assert.equal(dark.available, true);
  assert.equal(night.status, 'locked');
  assert.equal(night.available, false);
  assert.equal(night.locked, true);
  assert.equal(night.pointsRequired, DOMINION_NIGHT_THEME_REWARD.pointsRequired);
  assert.equal(night.pointsRemaining, 375);
  assert.equal(night.progressPercent, 25);
  assert.equal(night.isLowestPointUnlock, true);
  assert.equal(night.reason, '375 points to unlock.');
});

test('missing or mismatched ownership fails closed while preserving public themes', () => {
  const missing = buildThemeOptionModels(null, registry);
  assert.equal(missing.find((model) => model.themeId === 'dark').available, true);
  assert.deepEqual(deriveAuthorizedThemeIds({}, registry), []);
  assert.equal(
    missing.find((model) => model.themeId === 'dominion-night').reason,
    'Theme ownership could not be verified.',
  );

  const wrongModel = {
    totalPoints: 500,
    items: [nightReward({ status: 'owned', stateModel: 'challenge_lifecycle' })],
  };
  assert.deepEqual(deriveAuthorizedThemeIds(wrongModel, registry), []);
});

test('owned progress is complete and a disabled feature flag still blocks activation', () => {
  const disabledRegistry = registry.map((theme) => theme.id === 'dominion-night'
    ? { ...theme, availability: { ...theme.availability, enabled: false } }
    : theme);
  const catalog = { totalPoints: 500, items: [nightReward({ status: 'owned' })] };

  const enabled = buildThemeOptionModels(catalog, registry).find((model) => model.themeId === 'dominion-night');
  assert.equal(enabled.available, true);
  assert.equal(enabled.progressPercent, 100);
  assert.equal(enabled.pointsRemaining, 0);

  const disabled = buildThemeOptionModels(catalog, disabledRegistry).find((model) => model.themeId === 'dominion-night');
  assert.equal(disabled.available, false);
  assert.equal(disabled.reason, 'This theme is not available in this release.');
});
