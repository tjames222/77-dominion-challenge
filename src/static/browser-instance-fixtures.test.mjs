import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dailyBootstrapV2Fixture, DAILY_INSTANCE_ID, rewardCatalogV2Fixture } from '../../tests/fixtures/daily-action-bootstrap-v2.mjs';
import { DAILY_ACTOR } from '../../tests/fixtures/daily-action-bootstrap.mjs';
import { normalizeDailyActionBootstrap } from './daily-action-bootstrap.mjs';
import { normalizeRewardCatalog } from './reward-catalog.mjs';

for (const status of ['active', 'scheduled', 'not_started']) test(`V2 browser fixture ${status} satisfies the strict production contract`, () => {
  const payload = dailyBootstrapV2Fixture({ status });
  const result = normalizeDailyActionBootstrap(payload, DAILY_ACTOR);
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.activation.status, status);
  assert.equal(result.activation.contractValid, true);
  assert.equal(result.instanceId, status === 'not_started' ? null : DAILY_INSTANCE_ID);
  if (status === 'not_started') assert.equal(result.draft, null);
  else {
    assert.equal(result.activation.currentInstance.id, result.instanceId);
    assert.equal(payload.draft.instanceId, result.instanceId);
    assert.equal(result.draft.locked, status !== 'active');
  }
});
test('V2 browser fixture without access includes no private activation or draft', () => {
  const result = normalizeDailyActionBootstrap(dailyBootstrapV2Fixture({ appAccess: false }), DAILY_ACTOR);
  assert.equal(result.appAccess, false); assert.equal(result.instanceId, null);
  assert.equal(result.activation, null); assert.equal(result.draft, null);
});
test('V2 browser fixtures retain captured actor and instance checks instead of falling back to V1', () => {
  const original = dailyBootstrapV2Fixture();
  for (const change of [value => { value.actorId = 'other'; }, value => { value.instanceId = null; },
    value => { value.draft.instanceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; },
    value => { value.draft.activation.currentInstance.submittedCount = 1; }]) {
    const value = structuredClone(original); change(value);
    assert.throws(() => normalizeDailyActionBootstrap(value, DAILY_ACTOR));
  }
});
test('protected-theme browser fixture uses explicit preserved ownership with valid V2 requirements', () => {
  const activation = dailyBootstrapV2Fixture().activation;
  const catalog = normalizeRewardCatalog(rewardCatalogV2Fixture(activation, { ownedThemes: true }));
  assert.equal(catalog.actorId, DAILY_ACTOR); assert.equal(catalog.totalPoints, 0);
  assert.deepEqual(catalog.items.filter(item => item.status === 'owned').map(item => item.key), ['dominion_night_theme', 'dominion_platinum']);
  assert.equal(catalog.items.find(item => item.key === 'twenty_one_day_prayer').pointsRequired, null);
  assert.equal(catalog.items.every(item => !item.allowedActions.includes('start')), true);
});
