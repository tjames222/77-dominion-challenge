import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { assessRewardUnlockEvidence, validateRewardProgressionCatalog } from './reward-unlock-rules.mjs';

const readCatalog = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const catalog = readCatalog('./reward-progression-catalog.v2.json');
const legacy = readCatalog('./reward-progression-catalog.legacy-launch.v1.json');
const clone = (value) => structuredClone(value);
const owner = 'mock_user_reward_fixture';
const stamp = '2026-09-30T12:00:00.123456+00:00';
const uuid = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const args = (overrides = {}) => ({ catalog, userId: owner, lifetimePoints: 0, trustedDailyStandardPoints: 0, completionEvidence: [], existingStates: [], ...overrides });
const item = (result, key) => result.items.find((entry) => entry.key === key);
const noAuthority = (result) => {
  for (const field of ['evidenceAuthorityVerified', 'grantAuthorized', 'ownershipAuthorized', 'transitionAuthorized', 'replayAuthorized']) assert.equal(result[field], false, field);
};
const canonical = (challengeKey, number = 1) => {
  const definition = catalog.rewards.find((entry) => entry.challengeKey === challengeKey);
  return { kind: 'canonical_instance_completion', userId: owner, challengeKey, instanceId: uuid(number), eventId: uuid(number + 100),
    sourceCheckInId: uuid(number + 200), submittedCount: definition.targetSubmittedCheckIns, targetCount: definition.targetSubmittedCheckIns,
    completedAt: stamp, persistedAt: '2026-09-30T12:00:00.123455+00:00' };
};
const state = (key, status = 'owned') => ({ userId: owner, key, status,
  unlockedAt: status === 'owned' ? null : stamp,
  startedAt: ['active', 'completed'].includes(status) ? stamp : null,
  completedAt: status === 'completed' ? stamp : null,
  ownedAt: status === 'owned' ? stamp : null,
  celebrationSeenAt: stamp, grantCatalogVersion: 10, grantReason: 'existing_pre_cutover_record' });
const approvedLegacy = (challengeKey, number = 1) => ({ kind: 'approved_legacy_completed', userId: owner, challengeKey,
  legacyStateKey: `${owner}:${challengeKey}`, completedAt: stamp, approvalId: uuid(number + 300), approvedAt: '2026-10-01T01:00:00Z' });

test('released catalog has exactly six approved point rewards, four completion edges, and unchanged identities', () => {
  const validated = validateRewardProgressionCatalog(catalog, { previousCatalog: legacy });
  assert.equal(validated.valid, true);
  assert.equal(validated.catalog.lifecycle, 'released');
  assert.equal(validated.catalog.effectiveAt, '2026-10-01T00:12:45Z');
  assert.ok(validated.catalog.rewards.every((entry) => entry.released));
  assert.deepEqual(catalog.rewards.filter((entry) => entry.phase === 'core').map((entry) => [entry.key, entry.unlockRule.type, entry.unlockRule.pointsRequired]), [
    ['gym_training_discount', 'trusted_points', 42], ['dominion_night_theme', 'lifetime_points', 112],
    ['nehemiah_leadership_handbook', 'lifetime_points', 210], ['dominion_platinum', 'lifetime_points', 308],
    ['seven_day_reset', 'lifetime_points', 420], ['big_god_energy_tshirt_discount', 'lifetime_points', 532],
  ]);
  assert.deepEqual(catalog.rewards.filter((entry) => entry.phase === 'post_core').map((entry) => [entry.challengeKey, entry.unlockRule.prerequisiteChallengeKey, entry.targetSubmittedCheckIns]), [
    ['twenty_one_day_prayer', 'seven_day_reset', 21], ['thirty_day_strength', 'twenty_one_day_prayer', 30],
    ['forty_day_fast', 'thirty_day_strength', 40], ['bible_in_a_year', 'forty_day_fast', 365],
  ]);
  // Another original77 run is a separate runtime instance, not a seventh point reward.
  assert.equal(catalog.rewards.some((entry) => entry.key.includes('original')), false);
});

test('historical snapshot retains all ten old grant rules independently of the new defaults', () => {
  assert.equal(validateRewardProgressionCatalog(legacy).valid, true);
  assert.equal(legacy.lifecycle, 'historical_reference');
  assert.deepEqual(legacy.rewards.map((entry) => entry.unlockRule.pointsRequired), [21, 56, 98, 140, 210, 273, 336, 406, 469, 532]);
  assert.ok(legacy.rewards.every((entry) => entry.unlockRule.type !== 'challenge_completion'));
  const old = assessRewardUnlockEvidence(args({ catalog: legacy, lifetimePoints: 336, trustedDailyStandardPoints: 336 }));
  const next = assessRewardUnlockEvidence(args({ lifetimePoints: 336, trustedDailyStandardPoints: 336 }));
  assert.equal(item(old, 'twenty_one_day_prayer').requirementSatisfied, true);
  assert.equal(item(next, 'twenty_one_day_prayer').requirementSatisfied, false);
  noAuthority(old); noAuthority(next);
});

for (const definition of catalog.rewards.filter((entry) => entry.phase === 'core')) {
  for (const delta of [-1, 0, 1]) test(`${definition.key}: threshold ${delta < 0 ? 'minus one' : delta ? 'plus one' : 'exact'}`, () => {
    const points = definition.unlockRule.pointsRequired + delta;
    const result = assessRewardUnlockEvidence(args({ lifetimePoints: points, trustedDailyStandardPoints: points }));
    assert.equal(result.valid, true);
    const reward = item(result, definition.key);
    assert.equal(reward.requirementSatisfied, delta >= 0);
    assert.equal(reward.pointsRemaining, Math.max(-delta, 0));
    assert.equal(reward.preservedState, null);
    noAuthority(result);
  });
}

test('gym requires explicit trusted points; sharing and adjustments never substitute', () => {
  for (const trusted of [null, 0, 41]) {
    const result = assessRewardUnlockEvidence(args({ lifetimePoints: Number.MAX_SAFE_INTEGER, trustedDailyStandardPoints: trusted }));
    assert.equal(result.valid, true);
    assert.equal(item(result, 'gym_training_discount').requirementSatisfied, trusted === null ? null : false);
    assert.equal(item(result, 'gym_training_discount').currentPoints, trusted);
    assert.equal(item(result, 'dominion_night_theme').requirementSatisfied, true);
    noAuthority(result);
  }
  assert.equal(item(assessRewardUnlockEvidence(args({ lifetimePoints: 0, trustedDailyStandardPoints: 42 })), 'gym_training_discount').requirementSatisfied, true);
});

test('huge points cannot skip or bulk-unlock the completion chain', () => {
  const result = assessRewardUnlockEvidence(args({ lifetimePoints: Number.MAX_SAFE_INTEGER, trustedDailyStandardPoints: Number.MAX_SAFE_INTEGER }));
  assert.equal(result.items.filter((entry) => entry.requirementSatisfied).length, 6);
  for (const reward of result.items.filter((entry) => entry.ruleType === 'challenge_completion')) {
    assert.equal(reward.requirementSatisfied, false);
    assert.equal(reward.currentPoints, null); assert.equal(reward.pointsRemaining, null); assert.equal(reward.pointsRequired, null);
  }
  noAuthority(result);
});

for (const [label, standards, sharing, expected] of [
  ['perfect', Array(77).fill(7), 0, 6], ['perfect plus Sharing', Array(77).fill(7), 14, 6],
  ['four per submitted day', Array(77).fill(4), 0, 4],
  ['irregular and missed days', Array.from({ length: 77 }, (_, index) => index % 7 + 1), 0, 4],
  ['partial-only finisher', Array(77).fill(1), 0, 1],
]) test(`${label} simulation counts committed standards, never elapsed days as completion`, () => {
  const submitted = standards.map((count, index) => ({ calendarDay: 1 + index * (label.includes('missed') ? 2 : 1), count }));
  const trusted = submitted.reduce((total, row) => total + row.count, 0);
  const result = assessRewardUnlockEvidence(args({ lifetimePoints: trusted + sharing, trustedDailyStandardPoints: trusted }));
  assert.equal(submitted.length, 77);
  assert.equal(result.items.filter((entry) => entry.requirementSatisfied).length, expected);
  assert.ok(result.items.filter((entry) => entry.ruleType === 'challenge_completion').every((entry) => !entry.requirementSatisfied));
  if (label.includes('missed')) assert.ok(submitted.at(-1).calendarDay > 77);
  if (label === 'partial-only finisher') assert.equal(item(result, 'seven_day_reset').requirementSatisfied, false);
  noAuthority(result);
});

for (const [index, definition] of catalog.rewards.filter((entry) => entry.phase === 'post_core').entries()) {
  test(`canonical completion satisfies only ${definition.key}'s immediate prerequisite`, () => {
    const proof = canonical(definition.unlockRule.prerequisiteChallengeKey, index + 1);
    const result = assessRewardUnlockEvidence(args({ completionEvidence: [proof] }));
    assert.equal(result.valid, true);
    assert.deepEqual(result.items.filter((entry) => entry.ruleType === 'challenge_completion' && entry.requirementSatisfied).map((entry) => entry.key), [definition.key]);
    assert.deepEqual(item(result, definition.key).matchedEvidence, [proof]);
    assert.equal(item(result, definition.key).preservedState, null);
    noAuthority(result);
    for (const badCount of [proof.targetCount - 1, proof.targetCount + 1, String(proof.targetCount)]) {
      assert.equal(assessRewardUnlockEvidence(args({ completionEvidence: [{ ...proof, submittedCount: badCount }] })).valid, false);
    }
  });
}

test('legacy completed state needs separate approval provenance and cannot fabricate a live event', () => {
  const completed = state('seven_day_reset', 'completed');
  const bare = assessRewardUnlockEvidence(args({ existingStates: [completed] }));
  assert.equal(item(bare, 'twenty_one_day_prayer').requirementSatisfied, false);
  const proof = approvedLegacy('seven_day_reset');
  const result = assessRewardUnlockEvidence(args({ existingStates: [completed], completionEvidence: [proof] }));
  assert.equal(result.valid, true);
  const reward = item(result, 'twenty_one_day_prayer');
  assert.equal(reward.requirementSatisfied, true);
  assert.deepEqual(reward.matchedEvidence, [proof]);
  assert.equal(Object.hasOwn(reward.matchedEvidence[0], 'eventId'), false);
  assert.equal(Object.hasOwn(reward.matchedEvidence[0], 'sourceCheckInId'), false);
  for (const existing of [[], [state('seven_day_reset', 'available')], [state('seven_day_reset', 'active')]]) {
    assert.equal(assessRewardUnlockEvidence(args({ existingStates: existing, completionEvidence: [proof] })).valid, false);
  }
  assert.equal(assessRewardUnlockEvidence(args({ existingStates: [completed], completionEvidence: [{ ...proof, completedAt: '2026-09-29T12:00:00Z' }] })).valid, false);
  noAuthority(result);
});

test('existing owned/available/active/completed and seen provenance survive raised thresholds untouched', () => {
  const existing = [state('dominion_night_theme'), state('seven_day_reset', 'available'), state('twenty_one_day_prayer', 'active'), state('thirty_day_strength', 'completed')];
  const input = args({ existingStates: existing }); const before = clone(input);
  const result = assessRewardUnlockEvidence(input);
  assert.equal(result.valid, true);
  for (const entry of existing) assert.deepEqual(item(result, entry.key).preservedState, entry);
  assert.equal(item(result, 'dominion_night_theme').requirementSatisfied, false);
  assert.equal(item(result, 'forty_day_fast').requirementSatisfied, false, 'a retained completed label is not approved completion evidence');
  assert.deepEqual(input, before);
  assert.equal(Object.isFrozen(existing[0]), false);
  assert.equal(Object.isFrozen(item(result, 'dominion_night_theme').preservedState), true);
  noAuthority(result);
});

test('a repeated completed instance supplies distinct evidence without another grant or replay', () => {
  const proofs = [canonical('seven_day_reset', 1), canonical('seven_day_reset', 2)];
  const result = assessRewardUnlockEvidence(args({ completionEvidence: proofs }));
  assert.equal(result.valid, true);
  assert.equal(item(result, 'twenty_one_day_prayer').matchedEvidence.length, 2);
  assert.equal(result.items.filter((entry) => entry.requirementSatisfied).length, 1);
  noAuthority(result);
  for (const duplicate of [proofs[0], { ...proofs[1], instanceId: proofs[0].instanceId }, { ...proofs[1], sourceCheckInId: proofs[0].sourceCheckInId }]) {
    assert.equal(assessRewardUnlockEvidence(args({ completionEvidence: [proofs[0], duplicate] })).valid, false);
  }
});

test('configuration alone supports inserted rewards, shifted thresholds and an extended chain', () => {
  const extended = clone(catalog); extended.manifestVersion += 1;
  extended.rewards.splice(2, 0, { ...clone(catalog.rewards[1]), key: 'future_cosmetic', title: 'Future cosmetic', fulfillmentKey: 'future-cosmetic', unlockRule: { type: 'lifetime_points', pointsRequired: 150 } });
  extended.rewards.find((entry) => entry.key === 'nehemiah_leadership_handbook').unlockRule.pointsRequired = 220;
  extended.rewards.push({ ...clone(catalog.rewards.at(-1)), key: 'future_track', title: 'Future track', fulfillmentKey: 'future_track', challengeKey: 'future_track', targetSubmittedCheckIns: 90,
    unlockRule: { type: 'challenge_completion', prerequisiteChallengeKey: 'bible_in_a_year', requiredState: 'completed' } });
  extended.rewards.forEach((entry, index) => { entry.sortOrder = (index + 1) * 10; });
  assert.equal(validateRewardProgressionCatalog(extended, { previousCatalog: catalog }).valid, true);
  const result = assessRewardUnlockEvidence(args({ catalog: extended, lifetimePoints: 150, completionEvidence: [canonical('bible_in_a_year')] }));
  assert.equal(result.valid, true);
  assert.equal(item(result, 'future_cosmetic').requirementSatisfied, true);
  assert.equal(item(result, 'future_track').requirementSatisfied, true);
  noAuthority(result);
});

test('catalog rejects coercion, duplicates, invalid rules, missing prerequisites, cycles and identity changes', () => {
  const changes = [
    (value) => { value.manifestVersion = '2'; },
    (value) => { value.rewards[0].sortOrder = '10'; },
    (value) => { value.rewards[1].sortOrder = 10; },
    (value) => { value.rewards[1].key = value.rewards[0].key; },
    (value) => { value.rewards[0].unlockRule.pointsRequired = '42'; },
    (value) => { value.rewards[0].unlockRule.pointsRequired = 0; },
    (value) => { value.rewards[1].unlockRule.pointsRequired = 41; },
    (value) => { value.rewards[0].unlockRule.approved = true; },
    (value) => { value.rewards[6].unlockRule.pointsRequired = 0; },
    (value) => { value.rewards[6].unlockRule.requiredState = 'active'; },
    (value) => { value.rewards[6].unlockRule.prerequisiteChallengeKey = 'missing'; },
    (value) => { value.rewards[6].unlockRule.prerequisiteChallengeKey = 'dominion_night_theme'; },
    (value) => { value.rewards[6].unlockRule.prerequisiteChallengeKey = 'twenty_one_day_prayer'; },
    (value) => { value.rewards[6].unlockRule.prerequisiteChallengeKey = 'thirty_day_strength'; },
    (value) => { value.rewards[4].active = false; },
    (value) => { value.rewards[4].targetSubmittedCheckIns = '7'; },
    (value) => { value.rewards[0].key += '\n'; },
    (value) => { value.rewards[0].active = 1; },
    (value) => { value.rewards[0].released = 'false'; },
    (value) => { value.rewards[0].rewardType = 'cosmetic.unknown'; },
    (value) => { value.rewards[4].fulfillmentKey = 'other'; },
  ];
  for (const change of changes) { const value = clone(catalog); change(value); assert.equal(validateRewardProgressionCatalog(value).valid, false); }
  for (const field of ['rewardType', 'stateModel', 'fulfillmentKey', 'challengeKey']) {
    const value = clone(catalog); value.rewards[0][field] = field === 'stateModel' ? 'challenge_lifecycle' : 'different';
    assert.equal(validateRewardProgressionCatalog(value, { previousCatalog: legacy }).valid, false);
  }
  const removed = clone(catalog); removed.rewards.splice(1, 1);
  assert.equal(validateRewardProgressionCatalog(removed, { previousCatalog: legacy }).reason, 'immutable_identity_changed');
  assert.equal(validateRewardProgressionCatalog(catalog, { previousCatalog: catalog }).reason, 'nonadvancing_manifest_version');
});

test('malformed/coerced evidence and cross-owner proof fail closed with no partial results', () => {
  for (const value of ['42', true, null, NaN, Infinity, -1, -0, 1.1, 42n, Number.MAX_SAFE_INTEGER + 1, { valueOf: () => 42 }]) {
    const result = assessRewardUnlockEvidence(args({ lifetimePoints: value }));
    assert.equal(result.valid, false); assert.deepEqual(result.items, []); noAuthority(result);
  }
  for (const value of ['42', false, -1, 1.1]) assert.equal(assessRewardUnlockEvidence(args({ trustedDailyStandardPoints: value })).valid, false);
  for (const patch of [
    { userId: 'other_owner' }, { challengeKey: 'missing' }, { kind: 'completed' }, { eventId: uuid(1) + '\n' },
    { instanceId: 1 }, { sourceCheckInId: uuid(101) }, { completedAt: '2026-02-30T00:00:00Z' },
    { completedAt: stamp + '\n' }, { persistedAt: 'infinity' }, { persistedAt: '2026-09-30T00:00:00-00:00' },
    { completedAt: '0001-01-01T00:00:00+01:00' }, { targetCount: '7' }, { approved: true },
  ]) assert.equal(assessRewardUnlockEvidence(args({ completionEvidence: [{ ...canonical('seven_day_reset'), ...patch }] })).valid, false);
  assert.equal(assessRewardUnlockEvidence(args({ existingStates: [{ ...state('dominion_night_theme'), userId: 'other' }] })).valid, false);
  assert.equal(assessRewardUnlockEvidence(args({ existingStates: [state('dominion_night_theme'), state('dominion_night_theme')] })).valid, false);
});

test('strict bounded data snapshots never invoke accessors or mutate inputs', () => {
  let invoked = false;
  const value = clone(catalog); Object.defineProperty(value.rewards[0].unlockRule, 'type', { enumerable: true, get() { invoked = true; return 'trusted_points'; } });
  assert.equal(validateRewardProgressionCatalog(value).valid, false);
  const malicious = args(); Object.defineProperty(malicious, 'lifetimePoints', { enumerable: true, get() { invoked = true; return 1000; } });
  assert.equal(assessRewardUnlockEvidence(malicious).valid, false);
  assert.equal(invoked, false);
  const sparse = clone(catalog); delete sparse.rewards[2]; assert.equal(validateRewardProgressionCatalog(sparse).valid, false);
  const extra = clone(catalog); extra.rewards.extra = true; assert.equal(validateRewardProgressionCatalog(extra).valid, false);
  assert.equal(assessRewardUnlockEvidence(args({ completionEvidence: Array(513).fill(canonical('seven_day_reset')) })).valid, false);
  const before = clone(catalog); const validated = validateRewardProgressionCatalog(catalog);
  assert.deepEqual(catalog, before); assert.equal(Object.isFrozen(catalog), false);
  assert.equal(Object.isFrozen(validated.catalog.rewards[0].unlockRule), true);
  assert.throws(() => { validated.catalog.rewards[0].unlockRule.pointsRequired = 1; }, TypeError);
});

test('runtime catalog shares validated configuration without adding authority to the evidence assessor', () => {
  for (const name of ['point-economy.mjs', 'challenge-progression.mjs', 'preview-reward-catalog.mjs']) {
    assert.match(readFileSync(new URL(name, import.meta.url), 'utf8'), /reward-progression-catalog\.v2\.json/);
  }
  const source = readFileSync(new URL('./reward-unlock-rules.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^import\s/m);
  assert.doesNotMatch(source, /\b(?:fetch|setTimeout|setInterval)\s*\(|\b(?:localStorage|sessionStorage|document|supabase)\./);
});
