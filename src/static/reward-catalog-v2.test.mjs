import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildMockRewardCatalogV2, DEFAULT_REWARD_PROGRESSION_DEFINITIONS as definitions,
  preserveLegacyRewardGrants, REWARD_CATALOG_EFFECTIVE_AT } from './preview-reward-catalog.mjs';
import { normalizeRewardCatalog } from './reward-catalog.mjs';
import { buildBadgesRewardsPageModel } from './badges-rewards.mjs';
import { renderRewardCard } from './reward-card.mjs';
import { deriveAuthorizedThemeIds } from './theme-entitlements.mjs';
import { instanceActivationFixture, INSTANCE_ACTOR } from '../../tests/fixtures/challenge-instance.mjs';

const now = '2026-10-01T12:00:00Z';
const uuid = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const activation = () => instanceActivationFixture();
const completedInstance = () => ({ ...activation().currentInstance, status: 'completed', submittedCount: 77,
  completedAt: now, completionEventId: uuid(999) });
const options = (patch = {}) => ({ actorId: INSTANCE_ACTOR, revision: 1, snapshotVersion: 'a'.repeat(64),
  currentInstance: activation().currentInstance, originalRepeat: activation().originalRepeat,
  totalPoints: 0, trustedDailyStandardPoints: 0, now, ...patch });
const build = patch => buildMockRewardCatalogV2(options(patch));
const item = (value, key) => value.catalog.items.find(row => row.key === key);
const completion = (challengeKey, number = 1) => {
  const target = definitions.find(row => row.challengeKey === challengeKey)?.targetSubmittedCheckIns || 77;
  return { kind: 'canonical_instance_completion', userId: INSTANCE_ACTOR, challengeKey,
    instanceId: uuid(number), eventId: uuid(number + 100), sourceCheckInId: uuid(number + 200),
    submittedCount: target, targetCount: target, completedAt: now, persistedAt: now };
};
const legacy = (key, status = 'owned') => ({ userId: INSTANCE_ACTOR, key, status,
  unlockedAt: status === 'owned' ? null : now, ownedAt: status === 'owned' ? now : null,
  startedAt: ['active', 'completed'].includes(status) ? now : null,
  completedAt: status === 'completed' ? now : null, celebrationSeenAt: now,
  grantCatalogVersion: 10, grantReason: 'catalog_v1_preserved' });

test('V2 catalog carries one actor/revision/snapshot contract and deterministic preview effective time', () => {
  const result = build();
  assert.equal(result.catalog.schemaVersion, 2);
  assert.equal(result.catalog.actorId, INSTANCE_ACTOR);
  assert.equal(result.catalog.revision, 1);
  assert.equal(result.catalog.snapshotVersion, 'a'.repeat(64));
  assert.equal(result.catalog.effectiveAt, REWARD_CATALOG_EFFECTIVE_AT);
  assert.deepEqual(result.catalog.items.filter(row => row.phase === 'core').map(row => row.pointsRequired), [42, 112, 210, 308, 420, 532]);
  assert.equal(result.catalog.nextUnlock.key, 'gym_training_discount');
});

test('expired membership preserves owned theme access but never authorizes unowned themes or member-only challenges', () => {
  const ownershipRecords = ['dominion_night_theme', 'dominion_platinum'].map(key => ({ key, ownedAt: now, celebrationSeenAt: now,
    requiredEntitlementKey: 'stale_grant_metadata' }));
  const challengeRecords = [{ key: 'seven_day_reset', status: 'available', unlockedAt: now }];
  const registry = ['dominion-night', 'dominion-platinum'].map(id => ({ id, availability: { enabled: true, requiresEntitlement: true } }));
  const original = structuredClone({ ownershipRecords, challengeRecords });
  const result = build({ membershipActive: false, ownershipRecords, challengeRecords, currentInstance: completedInstance() });
  assert.deepEqual(deriveAuthorizedThemeIds(result.catalog, registry), registry.map(theme => theme.id));
  for (const key of ['dominion_night_theme', 'dominion_platinum']) {
    assert.equal(item(result, key).canAccess, true);
    assert.equal(item(result, key).requiredEntitlementKey, null);
  }
  assert.equal(item(result, 'seven_day_reset').status, 'available', 'membership expiry does not erase a durable grant');
  assert.equal(item(result, 'seven_day_reset').requiredEntitlementKey, 'membership_active');
  assert.equal(item(result, 'seven_day_reset').canAccess, false);
  assert.equal(item(result, 'seven_day_reset').accessReason, 'entitlement_required');
  assert.deepEqual(item(result, 'seven_day_reset').allowedActions, []);
  assert.deepEqual({ ownershipRecords: result.ownershipRecords, challengeRecords: result.challengeRecords }, original);
  assert.deepEqual(deriveAuthorizedThemeIds(build({ membershipActive: false }).catalog, registry), [], 'no grant means no protected theme');
  const qualified = build({ membershipActive: false, totalPoints: 532, trustedDailyStandardPoints: 42,
    completionEvidence: [completion('seven_day_reset')] });
  assert.equal(qualified.ownershipRecords.length, 5, 'unrestricted ownership rewards retain their released earning rules');
  assert.deepEqual(qualified.challengeRecords, [], 'points and completion do not bypass the membership requirement');
});

test('unrecognized reward entitlements fail closed even with active membership', () => {
  const custom = definitions.map(definition => ({ ...definition, requiredEntitlementKey: 'future_private_access' }));
  const result = build({ definitions: custom, membershipActive: true, totalPoints: 532, trustedDailyStandardPoints: 42 });
  assert.equal(result.catalog.items.every(reward => !reward.canAccess && !reward.allowedActions.length), true);
  assert.deepEqual(result.ownershipRecords, []);
  assert.deepEqual(result.challengeRecords, []);
});

test('legacy preview crew identifiers require an explicit preview contract and remain rejected for production', () => {
  const currentInstance = { ...activation().currentInstance, mode: 'group', crewId: 'crew_preview_legacy' };
  const { catalog } = build({ currentInstance });
  assert.equal(catalog.currentInstance.crewId, 'crew_preview_legacy');
  assert.throws(() => normalizeRewardCatalog(catalog), /verified/);
  assert.equal(normalizeRewardCatalog(catalog, { preview: true }).currentInstance.crewId, 'crew_preview_legacy');
});

for (const definition of definitions.filter(row => row.phase === 'core')) {
  for (const delta of [-1, 0, 1]) test(`${definition.key} runtime threshold ${delta < 0 ? 'below' : delta ? 'above' : 'exact'}`, () => {
    const points = definition.unlockRule.pointsRequired + delta;
    const result = build({ totalPoints: points, trustedDailyStandardPoints: points });
    const reward = item(result, definition.key);
    assert.equal(reward.status === 'locked', delta === -1);
    if (delta >= 0) assert.deepEqual(reward.grantProvenance, { type: 'rule_earned', catalogVersion: 2 });
  });
}

test('trusted gym points exclude sharing and corrections; giant lifetime totals only grant six point rewards', () => {
  const below = build({ totalPoints: Number.MAX_SAFE_INTEGER, trustedDailyStandardPoints: 41 });
  assert.equal(item(below, 'gym_training_discount').status, 'locked');
  assert.equal(item(below, 'gym_training_discount').pointsRemaining, 1);
  const result = build({ totalPoints: Number.MAX_SAFE_INTEGER, trustedDailyStandardPoints: 42 });
  assert.equal(result.catalog.items.filter(row => row.status !== 'locked').length, 6);
  assert.deepEqual(result.challengeUnlockedKeys, ['seven_day_reset']);
  for (const reward of result.catalog.items.filter(row => row.phase === 'post_core')) {
    assert.equal(reward.status, 'locked');
    for (const key of ['pointsRequired', 'currentPoints', 'pointsRemaining', 'progressPercent']) assert.equal(reward[key], null);
    assert.deepEqual(reward.allowedActions, []);
  }
  assert.equal(result.catalog.nextUnlock, null, 'original run does not advance next card into completion-only nodes');
});

for (const successor of definitions.filter(row => row.phase === 'post_core')) {
  test(`completion unlocks only immediate successor ${successor.key}`, () => {
    const result = build({ totalPoints: 0, completionEvidence: [completion(successor.unlockRule.prerequisiteChallengeKey)] });
    assert.deepEqual(result.challengeUnlockedKeys, [successor.key]);
    assert.equal(item(result, successor.key).status, 'available');
    assert.equal(item(result, successor.key).requirement.satisfied, true);
    assert.equal(result.catalog.items.filter(row => row.phase === 'post_core' && row.status !== 'locked').length, 1);
    const replay = build({ completionEvidence: [completion(successor.unlockRule.prerequisiteChallengeKey), completion(successor.unlockRule.prerequisiteChallengeKey, 2)],
      challengeRecords: result.challengeRecords });
    assert.deepEqual(replay.challengeRecords, result.challengeRecords, 'repeated completion never grants/replays a second entitlement');
  });
}

test('merely available, active, or bare completed states cannot grant a successor', () => {
  for (const status of ['available', 'active', 'completed']) {
    const result = build({ challengeRecords: [{ key: 'seven_day_reset', status, unlockedAt: now, startedAt: now, completedAt: status === 'completed' ? now : null }] });
    assert.equal(item(result, 'twenty_one_day_prayer').status, 'locked');
  }
});

test('typed preserved grant import retains ownership, original fields and acknowledgements without fabricating completion events', () => {
  const records = [legacy('dominion_night_theme'), legacy('seven_day_reset', 'completed'), legacy('thirty_day_strength', 'available')];
  const frozen = structuredClone(records);
  const result = build({ preservedLegacyRecords: records, currentInstance: completedInstance() });
  assert.deepEqual(records, frozen);
  assert.equal(item(result, 'dominion_night_theme').status, 'owned');
  assert.equal(item(result, 'dominion_night_theme').pointsRemaining, 0);
  assert.equal(item(result, 'dominion_night_theme').celebrationSeenAt, now);
  assert.deepEqual(item(result, 'dominion_night_theme').grantProvenance, { type: 'legacy_preserved', catalogVersion: 10 });
  assert.equal(item(result, 'twenty_one_day_prayer').status, 'available', 'approved existing completed state satisfies its successor');
  assert.equal(item(result, 'thirty_day_strength').requirement.satisfied, false);
  assert.deepEqual(item(result, 'thirty_day_strength').allowedActions, ['start'], 'previously available later challenge stays usable');
  assert.equal(item(result, 'forty_day_fast').status, 'locked');
  assert.equal(result.catalog.nextUnlock.key, 'twenty_one_day_prayer');
  assert.equal(result.challengeRecords.some(row => 'completionEventId' in row), false);
});

test('new active/complete runs overlay display only and global Start waits for completed current instance', () => {
  const challengeRecords = [{ key: 'seven_day_reset', status: 'available', unlockedAt: now }];
  const before = structuredClone(challengeRecords);
  const run = { ...activation().currentInstance, challengeKey: 'seven_day_reset', title: '7-Day Reset', targetCount: 7, submittedCount: 3 };
  const result = build({ challengeRecords, currentInstance: run });
  assert.equal(item(result, 'seven_day_reset').status, 'active');
  assert.deepEqual(item(result, 'seven_day_reset').allowedActions, []);
  assert.deepEqual(result.challengeRecords, before, 'display never rewrites grant lifecycle on read');
  const done = build({ challengeRecords, currentInstance: { ...run, status: 'completed', submittedCount: 7, completedAt: now, completionEventId: uuid(888) } });
  assert.equal(item(done, 'seven_day_reset').status, 'completed');
  assert.deepEqual(item(done, 'seven_day_reset').allowedActions, ['start']);
});

test('original grant metadata and old award milestones remain exact while wire provenance comes from typed import evidence', () => {
  const ownershipRecords = [{ key: 'dominion_night_theme', ownedAt: now, celebrationSeenAt: null,
    celebrationMilestonePoints: 56, celebrationSourceType: 'point_threshold', metadata: { original: ['kept', 1] } }];
  const challengeRecords = [{ key: 'seven_day_reset', status: 'available', unlockedAt: now,
    unlockPoints: 126, celebrationSeenAt: now, metadata: { original: ['challenge', 2] } }];
  const original = structuredClone({ ownershipRecords, challengeRecords });
  const preservedLegacyRecords = [{ ...legacy('dominion_night_theme'), celebrationSeenAt: null }, legacy('seven_day_reset', 'available')];
  const result = build({ ownershipRecords, challengeRecords, preservedLegacyRecords });
  assert.deepEqual({ ownershipRecords, challengeRecords }, original, 'catalog reads cannot mutate source records');
  assert.deepEqual(result.ownershipRecords, original.ownershipRecords);
  assert.deepEqual(result.challengeRecords, original.challengeRecords);
  const night = item(result, 'dominion_night_theme');
  assert.equal(night.pointsRequired, 112, 'current rule is independent of original award evidence');
  assert.equal(night.celebrationMilestonePoints, 56);
  assert.equal(night.celebrationSourceType, 'point_threshold');
  assert.equal(night.celebrationSeenAt, null);
  assert.deepEqual(night.metadata, original.ownershipRecords[0].metadata);
  assert.deepEqual(night.grantProvenance, { type: 'legacy_preserved', catalogVersion: 10 });
  assert.deepEqual(item(result, 'seven_day_reset').grantProvenance, { type: 'legacy_preserved', catalogVersion: 10 });
  assert.equal(item(result, 'seven_day_reset').unlockPoints, 126);
});

test('original completion enables repeat without making it a seventh point reward', () => {
  const originalRepeat = { challengeKey: 'original_77', targetCount: 77, available: true, canStart: true, reason: null };
  const result = build({ currentInstance: completedInstance(), originalRepeat });
  assert.deepEqual(result.catalog.originalRepeat, originalRepeat);
  assert.equal(result.catalog.items.some(row => row.key === 'original_77'), false);
  assert.throws(() => build({ originalRepeat }), /could not be verified/);
});

test('next unlock prioritizes the current run successor over an older available grant', () => {
  const currentInstance = { ...completedInstance(), challengeKey: 'twenty_one_day_prayer',
    title: '21-Day Prayer Track', targetCount: 21, submittedCount: 21 };
  const result = build({ currentInstance, totalPoints: 532, trustedDailyStandardPoints: 42,
    completionEvidence: [completion('twenty_one_day_prayer')] });
  assert.equal(item(result, 'seven_day_reset').status, 'available');
  assert.equal(item(result, 'thirty_day_strength').status, 'available');
  assert.equal(result.catalog.nextUnlock.key, 'thirty_day_strength');
});

test('an active later run never falls back to a locked completion-only next unlock', () => {
  const currentInstance = { ...activation().currentInstance, challengeKey: 'twenty_one_day_prayer',
    title: '21-Day Prayer Track', targetCount: 21, submittedCount: 0 };
  const result = build({ currentInstance, totalPoints: 532, trustedDailyStandardPoints: 42,
    completionEvidence: [completion('seven_day_reset')] });
  assert.equal(item(result, 'twenty_one_day_prayer').status, 'active');
  assert.equal(item(result, 'thirty_day_strength').status, 'locked');
  assert.equal(result.catalog.nextUnlock, null);
});

test('adding a point reward, changing order/thresholds, and extending the completion chain needs no route-specific logic', () => {
  const custom = structuredClone(definitions);
  custom.push({ ...custom[1], key: 'future_theme', title: 'Future theme', fulfillmentKey: 'future-theme', sortOrder: 25,
    unlockRule: { type: 'lifetime_points', pointsRequired: 160 }, metadata: {} });
  custom.find(row => row.key === 'nehemiah_leadership_handbook').unlockRule.pointsRequired = 224;
  custom.push({ ...custom.at(-2), key: 'future_challenge', challengeKey: 'future_challenge', title: 'Future Challenge',
    fulfillmentKey: 'future_challenge', phase: 'post_core', sortOrder: 110, stateModel: 'challenge_lifecycle', rewardType: 'challenge',
    targetSubmittedCheckIns: 90, unlockRule: { type: 'challenge_completion', prerequisiteChallengeKey: 'bible_in_a_year', requiredState: 'completed' } });
  const result = build({ definitions: custom, totalPoints: 160, trustedDailyStandardPoints: 160,
    completionEvidence: [completion('bible_in_a_year')], currentInstance: completedInstance() });
  assert.equal(item(result, 'future_theme').status, 'owned');
  assert.equal(item(result, 'nehemiah_leadership_handbook').pointsRequired, 224);
  assert.equal(item(result, 'future_challenge').status, 'available');
  const model = buildBadgesRewardsPageModel({ catalog: result.catalog });
  assert.equal(model.rewards.find(row => row.key === 'future_challenge').canStart, true);
  assert.match(renderRewardCard(model.rewards.find(row => row.key === 'future_challenge')), /Start challenge/);
});

test('completion card/title uses catalog data and never renders zero-point requirements', () => {
  const result = build();
  const model = buildBadgesRewardsPageModel({ catalog: result.catalog });
  const prayer = model.rewards.find(row => row.key === 'twenty_one_day_prayer');
  assert.equal(prayer.requirementLabel, 'Complete 7-Day Reset to unlock');
  const html = renderRewardCard(prayer);
  assert.match(html, /Complete 7-Day Reset to unlock/);
  assert.doesNotMatch(html, /role="progressbar"|points required|data-start-reward/);
});

test('V2 read rejects malformed snapshot, actor, state, contradictory point fields and invented Start', () => {
  const catalog = build().catalog;
  for (const patch of [{ actorId: '' }, { revision: -1 }, { revision: '1' }, { snapshotVersion: 'x'.repeat(64) },
    { effectiveAt: '2026-02-30T00:00:00Z' }, { currentInstance: undefined }]) {
    assert.throws(() => normalizeRewardCatalog({ ...catalog, ...patch }), /verified/);
  }
  for (const mutate of [row => { row.currentPoints = 42; }, row => { row.allowedActions = ['start']; },
    row => { row.requirement.type = 'unknown'; }, row => { row.status = 'invented'; }]) {
    const altered = structuredClone(catalog); mutate(altered.items[0]);
    assert.throws(() => normalizeRewardCatalog(altered), /verified/);
  }
});

test('V2 preview rejects coerced/cross-owner/duplicate/fabricated completion and legacy evidence', () => {
  for (const patch of [{ totalPoints: '420' }, { trustedDailyStandardPoints: null }, { membershipActive: 'true' },
    { completionEvidence: [{ ...completion('seven_day_reset'), userId: 'different' }] },
    { completionEvidence: [{ ...completion('seven_day_reset'), submittedCount: 6 }] },
    { completionEvidence: [{ ...completion('seven_day_reset'), targetCount: 8 }] },
    { completionEvidence: [completion('seven_day_reset'), completion('seven_day_reset')] },
    { preservedLegacyRecords: [{ ...legacy('seven_day_reset', 'completed'), completedAt: null }] }]) {
    assert.throws(() => build(patch), /invalid/);
  }
  let accessed = false;
  const proof = completion('seven_day_reset'); Object.defineProperty(proof, 'challengeKey', { enumerable: true, get() { accessed = true; return 'seven_day_reset'; } });
  assert.throws(() => build({ completionEvidence: [proof] }), /invalid/);
  assert.equal(accessed, false);
  const badLegacy = legacy('dominion_night_theme'); delete badLegacy.grantReason;
  assert.throws(() => preserveLegacyRewardGrants([badLegacy], { actorId: INSTANCE_ACTOR }), /invalid/);
});
