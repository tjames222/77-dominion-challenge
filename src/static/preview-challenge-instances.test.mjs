import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { normalizeInstanceActivation } from './challenge-instance-contract.mjs';
import {
  PREVIEW_CHALLENGE_INSTANCE_DEFINITIONS,
  activatePreviewInitial,
  createPreviewChallengeInstancesState,
  getPreviewChallengeActivation,
  getPreviewChallengeDraft,
  getPreviewChallengeFacts,
  mutatePreviewChallengeDraft,
  setPreviewChallengeWorkoutDifficulty,
  startPreviewChallenge,
  submitPreviewChallengeCheckIn,
  updatePreviewChallengeStartDate,
} from './preview-challenge-instances.mjs';
import { assessRewardUnlockEvidence } from './reward-unlock-rules.mjs';

const actor = 'mock_user_alpha';
const otherActor = 'mock_user_beta';
const uuid = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const firstId = uuid(1);
const stamp = (day, hour = 12) => `2026-10-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.123456Z`;
const blank = (overrides = {}) => createPreviewChallengeInstancesState({ actorId: actor, ...overrides });
const initialArgs = (overrides = {}) => ({ actorId: actor, requestId: uuid(101), expectedRevision: 0,
  instanceId: firstId, startDate: '2026-10-01', serverDate: '2026-10-01', timeZone: 'UTC',
  mode: 'solo', crewId: null, hasEntitlement: true, groupMembershipActive: false, ...overrides });

function legacyRun(overrides = {}) {
  const definition = PREVIEW_CHALLENGE_INSTANCE_DEFINITIONS.original_77;
  return { id: firstId, sequenceNo: 0, challengeKey: 'original_77', title: definition.title,
    scopeKey: 'original77:2026-07-01', status: 'completed', startDate: '2026-07-01', timeZone: 'UTC',
    mode: 'solo', crewId: null, targetCount: definition.targetCount, submittedCount: 77,
    completedAt: null, completionEventId: null, provenance: 'legacy_completed', reviewRequired: false,
    ...overrides };
}

function legacyGrant(key, status = 'available', overrides = {}) {
  return { userId: actor, key, status, unlockedAt: stamp(1),
    startedAt: status === 'available' ? null : stamp(2), completedAt: status === 'completed' ? stamp(3) : null,
    ownedAt: null, celebrationSeenAt: null, grantCatalogVersion: 1, grantReason: 'catalog_v1_preserved',
    ...overrides };
}

test('initial activation is immutable, owner-bound, CAS-safe and idempotent', () => {
  const base = blank();
  const created = activatePreviewInitial(base, initialArgs());
  assert.equal(created.replayed, false);
  assert.equal(created.state.revision, 1);
  assert.equal(created.state.currentInstanceId, firstId);
  assert.equal(created.state.runs[0].sequenceNo, 0);
  assert.equal(created.state.runs[0].scopeKey, 'original77:2026-10-01');
  assert.equal(created.activation.currentInstance.scopeKey, 'original77:2026-10-01');
  assert.equal(created.activation.canEditStartDate, true);
  assert.ok(normalizeInstanceActivation(created.activation, actor));
  assert.ok(Object.isFrozen(created.state));
  assert.ok(Object.isFrozen(created.state.runs[0]));
  assert.throws(() => { created.state.runs[0].status = 'completed'; }, TypeError);

  const replay = activatePreviewInitial(created.state, initialArgs());
  assert.equal(replay.replayed, true);
  assert.equal(replay.state.revision, 1);
  assert.equal(replay.state.runs.length, 1);
  assert.throws(() => activatePreviewInitial(created.state, initialArgs({ startDate: '2026-10-02' })),
    error => error.code === 'PREVIEW_INSTANCE_REQUEST_REUSED');
  assert.throws(() => activatePreviewInitial(created.state, initialArgs({ actorId: otherActor })),
    error => error.code === 'PREVIEW_INSTANCE_ACTOR_CHANGED');
  assert.throws(() => activatePreviewInitial(base, initialArgs({ expectedRevision: 9 })),
    error => error.code === 'PREVIEW_INSTANCE_CHANGED');
});

test('start-date editing requires explicit access, bounded dates and exact replay identity', () => {
  const activated = activatePreviewInitial(blank(), initialArgs());
  const args = { actorId: actor, instanceId: firstId, requestId: uuid(501),
    expectedRevision: 1, startDate: '2026-10-02', serverDate: '2026-10-01', timeZone: 'UTC', hasEntitlement: true };
  for (const hasEntitlement of [undefined, false, 'true']) {
    assert.throws(() => updatePreviewChallengeStartDate(activated.state, { ...args, hasEntitlement }),
      error => error.code === 'PREVIEW_INSTANCE_ACCESS_REQUIRED');
  }
  assert.throws(() => updatePreviewChallengeStartDate(activated.state, { ...args, startDate: '2026-07-15' }),
    error => error.code === 'PREVIEW_INSTANCE_DATE_INVALID');
  const edited = updatePreviewChallengeStartDate(activated.state, args);
  assert.equal(edited.state.revision, 2);
  assert.equal(edited.activation.currentInstance.scopeKey, 'original77:2026-10-02');
  const replay = updatePreviewChallengeStartDate(edited.state, args);
  assert.equal(replay.replayed, true);
  assert.equal(replay.state.revision, 2);
  assert.equal(replay.activation.currentInstance.id, firstId);
  assert.throws(() => updatePreviewChallengeStartDate(edited.state, { ...args, startDate: '2026-10-03' }),
    error => error.code === 'PREVIEW_INSTANCE_REQUEST_REUSED');
  const noOp = updatePreviewChallengeStartDate(activated.state, { ...args, startDate: '2026-10-01' });
  assert.equal(noOp.state.revision, 1);
  assert.equal(noOp.state.requests.length, 2);
  assert.throws(() => updatePreviewChallengeStartDate(edited.state, { ...args, requestId: uuid(502) }),
    error => error.code === 'PREVIEW_INSTANCE_CHANGED');
});

test('live counters require exact source rows and identifiers reject trailing line terminators', () => {
  const activated = activatePreviewInitial(blank(), initialArgs());
  assert.throws(() => createPreviewChallengeInstancesState({ ...activated.state,
    runs: [{ ...activated.state.runs[0], submittedCount: 76 }] }),
  error => error.code === 'PREVIEW_INSTANCE_STATE_INVALID');
  for (const instanceId of [`${firstId}\n`, `${firstId}\r`]) {
    assert.throws(() => activatePreviewInitial(blank(), initialArgs({ instanceId })),
      error => error.code === 'PREVIEW_INSTANCE_INPUT_INVALID');
  }
  assert.throws(() => createPreviewChallengeInstancesState({ actorId: `${actor}\n` }),
    error => error.code === 'PREVIEW_INSTANCE_STATE_INVALID');
});

test('initial access and group membership are checked inside the transition', () => {
  assert.throws(() => activatePreviewInitial(blank(), initialArgs({ hasEntitlement: false })),
    error => error.code === 'PREVIEW_INSTANCE_ACCESS_REQUIRED');
  assert.throws(() => activatePreviewInitial(blank(), initialArgs({ mode: 'group', crewId: uuid(99), groupMembershipActive: false })),
    error => error.code === 'PREVIEW_INSTANCE_ACCESS_REQUIRED');
  const group = activatePreviewInitial(blank(), initialArgs({ mode: 'group', crewId: uuid(99), groupMembershipActive: true }));
  const active = getPreviewChallengeActivation(group.state, { actorId: actor, serverDate: '2026-10-01',
    hasEntitlement: true, groupMembershipActive: true });
  assert.equal(active.canParticipate, true);
  assert.equal(active.groupMembershipActive, true);
  assert.equal(getPreviewChallengeActivation(group.state, { actorId: actor, serverDate: '2026-10-01',
    hasEntitlement: true, groupMembershipActive: false }).canParticipate, false);
});

test('scheduled runs become active by supplied server date without a wall-clock read', () => {
  const scheduled = activatePreviewInitial(blank(), initialArgs({ startDate: '2026-10-03' }));
  assert.equal(scheduled.activation.status, 'scheduled');
  assert.equal(scheduled.activation.currentInstance.calendarDay, null);
  assert.throws(() => mutatePreviewChallengeDraft(scheduled.state, { actorId: actor, instanceId: firstId,
    localDate: '2026-10-02', serverDate: '2026-10-02', actionId: 'bible', completed: true,
    expectedVersion: 0, now: stamp(2) }), error => error.code === 'PREVIEW_INSTANCE_LOCKED');
  const active = mutatePreviewChallengeDraft(scheduled.state, { actorId: actor, instanceId: firstId,
    localDate: '2026-10-03', serverDate: '2026-10-03', actionId: 'bible', completed: true,
    expectedVersion: 0, now: stamp(3) });
  assert.equal(active.draft.activation_status, 'active');
  assert.equal(active.draft.version, 1);
  assert.equal(getPreviewChallengeActivation(active.state, { actorId: actor, serverDate: '2026-10-03' }).status, 'active');
});

test('draft CAS, workout selection and submission use the authoritative owned draft', () => {
  const activated = activatePreviewInitial(blank({ lifetimePoints: 10, trustedDailyStandardPoints: 7 }), initialArgs());
  const bible = mutatePreviewChallengeDraft(activated.state, { actorId: actor, instanceId: firstId,
    localDate: '2026-10-01', serverDate: '2026-10-01', actionId: 'bible', completed: true,
    expectedVersion: 0, now: stamp(1, 9) });
  assert.deepEqual(bible.draft.completed, ['bible']);
  assert.throws(() => mutatePreviewChallengeDraft(bible.state, { actorId: actor, instanceId: firstId,
    localDate: '2026-10-01', serverDate: '2026-10-01', actionId: 'walk', completed: true,
    expectedVersion: 0, now: stamp(1, 9) }), error => error.code === 'PREVIEW_DRAFT_CHANGED');
  const difficulty = setPreviewChallengeWorkoutDifficulty(bible.state, { actorId: actor, instanceId: firstId,
    localDate: '2026-10-01', serverDate: '2026-10-01', workoutId: 'one', difficulty: 'hard',
    expectedVersion: 1, now: stamp(1, 10) });
  const workout = mutatePreviewChallengeDraft(difficulty.state, { actorId: actor, instanceId: firstId,
    localDate: '2026-10-01', serverDate: '2026-10-01', actionId: 'workoutOne', completed: true,
    expectedVersion: 2, now: stamp(1, 11) });
  const submitted = submitPreviewChallengeCheckIn(workout.state, { actorId: actor, instanceId: firstId,
    localDate: '2026-10-01', serverDate: '2026-10-01', checkInId: uuid(201), recordedAt: stamp(1) });
  assert.deepEqual(submitted.checkIn.completed, ['bible', 'workoutOne']);
  assert.deepEqual(submitted.checkIn.workoutDifficulty, { one: 'hard' });
  assert.equal(submitted.result.status, 'partial');
  assert.equal(submitted.result.completed_count, 2);
  assert.equal(submitted.result.points_awarded, 2);
  assert.equal(submitted.state.lifetimePoints, 12);
  assert.equal(submitted.state.revision, activated.state.revision + 1);
  assert.equal(submitted.state.trustedDailyStandardPoints, 9);
  assert.equal(submitted.result.activation.currentInstance.submittedCount, 1);
  assert.equal(submitted.completionEvidence, null);
  const locked = getPreviewChallengeDraft(submitted.state, { actorId: actor, instanceId: firstId, localDate: '2026-10-01' });
  assert.equal(locked.locked, true);
  assert.equal(locked.submitted, true);
  assert.equal(locked.lock_reason, 'already_submitted');
  assert.throws(() => submitPreviewChallengeCheckIn(submitted.state, { actorId: actor, instanceId: firstId,
    localDate: '2026-10-01', serverDate: '2026-10-01', checkInId: uuid(202), recordedAt: stamp(1) }),
  error => error.code === 'PREVIEW_CHECK_IN_ALREADY_COMPLETE');
});

test('the target-th partial check-in atomically completes a generic run with canonical evidence', () => {
  const reset = PREVIEW_CHALLENGE_INSTANCE_DEFINITIONS.seven_day_reset;
  const state = blank({ currentInstanceId: firstId, lifetimePoints: 419, trustedDailyStandardPoints: 41,
    runs: [{ id: firstId, sequenceNo: 0, challengeKey: 'seven_day_reset', title: reset.title,
      scopeKey: `instance:${firstId}`, status: 'active', startDate: '2026-10-01', timeZone: 'UTC', mode: 'solo',
      crewId: null, targetCount: 7, submittedCount: 6, completedAt: null, completionEventId: null,
      provenance: 'live', reviewRequired: false }],
    drafts: [{ instanceId: firstId, localDate: '2026-10-07', completed: ['walk'], workoutDifficulty: {},
      version: 1, updatedAt: stamp(7, 9) }],
    checkIns: Array.from({ length: 6 }, (_, index) => ({ id: uuid(201 + index), instanceId: firstId,
      localDate: `2026-10-0${index + 1}`, calendarDay: index + 1, status: 'partial', completed: ['walk'],
      workoutDifficulty: {}, pointsAwarded: 1, recordedAt: stamp(index + 1) })),
    scoredDates: ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06'] });
  assert.throws(() => submitPreviewChallengeCheckIn(state, { actorId: actor, instanceId: firstId,
    localDate: '2026-10-07', serverDate: '2026-10-07', checkInId: uuid(207), recordedAt: stamp(7) }),
  error => error.code === 'PREVIEW_COMPLETION_EVIDENCE_REQUIRED');
  const completed = submitPreviewChallengeCheckIn(state, { actorId: actor, instanceId: firstId,
    localDate: '2026-10-07', serverDate: '2026-10-07', checkInId: uuid(207), recordedAt: stamp(7),
    completionEventId: uuid(307), persistedAt: stamp(7, 8) });
  assert.equal(completed.state.runs[0].status, 'completed');
  assert.equal(completed.state.runs[0].submittedCount, 7);
  assert.equal(completed.result.status, 'partial');
  assert.equal(completed.result.points_awarded, 1);
  assert.deepEqual(completed.completionEvidence, {
    kind: 'canonical_instance_completion', userId: actor, challengeKey: 'seven_day_reset',
    instanceId: firstId, eventId: uuid(307), sourceCheckInId: uuid(207), submittedCount: 7,
    targetCount: 7, completedAt: stamp(7), persistedAt: stamp(7, 8),
  });
  assert.deepEqual(getPreviewChallengeFacts(completed.state, { actorId: actor }).completedChallengeKeys, ['seven_day_reset']);
  assert.ok(normalizeInstanceActivation(completed.result.activation, actor));
});

test('new starts require membership, exact CAS, an unlock, and the completion chain', () => {
  const completedReset = blank({ currentInstanceId: firstId, revision: 4,
    runs: [legacyRun({ challengeKey: 'seven_day_reset', title: '7-Day Reset', scopeKey: `instance:${firstId}`,
      targetCount: 7, submittedCount: 7 })] });
  const args = { actorId: actor, requestId: uuid(401), expectedRevision: 4, expectedCurrentInstanceId: firstId,
    instanceId: uuid(2), challengeKey: 'twenty_one_day_prayer', challengeUnlocked: true,
    startDate: '2026-10-08', serverDate: '2026-10-08', timeZone: 'UTC', mode: 'solo', crewId: null,
    hasEntitlement: true };
  assert.throws(() => startPreviewChallenge(completedReset, { ...args, challengeKey: 'thirty_day_strength' }),
    error => error.code === 'PREVIEW_INSTANCE_LOCKED');
  assert.throws(() => startPreviewChallenge(completedReset, { ...args, challengeUnlocked: false }),
    error => error.code === 'PREVIEW_INSTANCE_LOCKED');
  assert.throws(() => startPreviewChallenge(completedReset, { ...args, hasEntitlement: false }),
    error => error.code === 'PREVIEW_INSTANCE_ACCESS_REQUIRED');
  assert.throws(() => startPreviewChallenge(completedReset, { ...args, expectedRevision: 3 }),
    error => error.code === 'PREVIEW_INSTANCE_CHANGED');
  const prayer = startPreviewChallenge(completedReset, args);
  assert.equal(prayer.state.runs[1].scopeKey, `instance:${uuid(2)}`);
  assert.equal(prayer.state.runs[1].targetCount, 21);
  assert.equal(prayer.state.revision, 5);
  assert.equal(prayer.activation.currentInstance.challengeKey, 'twenty_one_day_prayer');
  assert.equal(startPreviewChallenge(prayer.state, args).replayed, true);
});

test('typed preserved grants remain usable without pretending to be new completion evidence', () => {
  const record = legacyGrant('thirty_day_strength');
  const state = blank({ currentInstanceId: firstId, revision: 2,
    runs: [legacyRun({ challengeKey: 'seven_day_reset', title: '7-Day Reset', scopeKey: `instance:${firstId}`,
      targetCount: 7, submittedCount: 7 })], preservedLegacyRecords: [record] });
  const facts = getPreviewChallengeFacts(state, { actorId: actor });
  assert.deepEqual(facts.preservedLegacyRecords, [record]);
  assert.deepEqual(facts.completionEvidence, []);
  const strength = startPreviewChallenge(state, { actorId: actor, requestId: uuid(501), expectedRevision: 2,
    expectedCurrentInstanceId: firstId, instanceId: uuid(5), challengeKey: 'thirty_day_strength',
    challengeUnlocked: false, startDate: '2026-10-08', serverDate: '2026-10-08', timeZone: 'UTC',
    mode: 'solo', crewId: null, hasEntitlement: true });
  assert.equal(strength.state.runs[1].challengeKey, 'thirty_day_strength');
  assert.deepEqual(strength.state.preservedLegacyRecords, [record]);
  assert.throws(() => blank({ preservedLegacyRecords: [{ ...record, userId: otherActor }] }),
    error => error.code === 'PREVIEW_INSTANCE_STATE_INVALID');
  assert.throws(() => blank({ preservedLegacyRecords: [{ ...record, points: 420 }] }),
    error => error.code === 'PREVIEW_INSTANCE_STATE_INVALID');
});

test('a legacy original completion can start a fresh UUID run without fabricated provenance', () => {
  const state = blank({ currentInstanceId: firstId, revision: 1, runs: [legacyRun()], scoredDates: ['2026-10-01'] });
  const before = getPreviewChallengeFacts(state, { actorId: actor });
  assert.deepEqual(before.completedChallengeKeys, ['original_77']);
  assert.deepEqual(before.completionEvidence, []);
  assert.equal(state.runs[0].completedAt, null);
  assert.equal(state.runs[0].completionEventId, null);
  const repeat = startPreviewChallenge(state, { actorId: actor, requestId: uuid(601), expectedRevision: 1,
    expectedCurrentInstanceId: firstId, instanceId: uuid(6), challengeKey: 'original_77', challengeUnlocked: false,
    startDate: '2026-10-01', serverDate: '2026-10-01', timeZone: 'UTC', mode: 'solo', crewId: null,
    hasEntitlement: true });
  assert.equal(repeat.state.runs[0].completionEventId, null);
  assert.equal(repeat.state.runs[1].scopeKey, `instance:${uuid(6)}`);
  assert.equal(repeat.state.runs[1].sequenceNo, 1);
  assert.throws(() => mutatePreviewChallengeDraft(repeat.state, { actorId: actor, instanceId: uuid(6),
    localDate: '2026-10-01', serverDate: '2026-10-01', actionId: 'bible', completed: true,
    expectedVersion: 0, now: stamp(1) }), error => error.code === 'PREVIEW_CHECK_IN_ALREADY_COMPLETE');
});

test('point facts feed the approved six-threshold catalog without writing reward state', async () => {
  const catalog = JSON.parse(await readFile(new URL('./reward-progression-catalog.v2.json', import.meta.url), 'utf8'));
  const state = blank({ lifetimePoints: 532, trustedDailyStandardPoints: 42 });
  const facts = getPreviewChallengeFacts(state, { actorId: actor });
  const assessment = assessRewardUnlockEvidence({ catalog, userId: actor,
    lifetimePoints: facts.lifetimePoints, trustedDailyStandardPoints: facts.trustedDailyStandardPoints,
    completionEvidence: facts.completionEvidence, existingStates: facts.preservedLegacyRecords });
  assert.equal(assessment.valid, true);
  assert.deepEqual(assessment.items.slice(0, 6).map(item => [item.key, item.pointsRequired, item.requirementSatisfied]), [
    ['gym_training_discount', 42, true], ['dominion_night_theme', 112, true],
    ['nehemiah_leadership_handbook', 210, true], ['dominion_platinum', 308, true],
    ['seven_day_reset', 420, true], ['big_god_energy_tshirt_discount', 532, true],
  ]);
  assert.ok(assessment.items.slice(6).every(item => item.requirementSatisfied === false));
  assert.deepEqual(state.preservedLegacyRecords, []);
});

test('malformed identities, timestamps, state aliases and premature evidence fail closed', () => {
  assert.throws(() => blank({ actorId: '' }), error => error.code === 'PREVIEW_INSTANCE_STATE_INVALID');
  assert.throws(() => blank({ scoredDates: ['2026-02-30'] }), error => error.code === 'PREVIEW_INSTANCE_STATE_INVALID');
  const active = activatePreviewInitial(blank(), initialArgs()).state;
  assert.throws(() => mutatePreviewChallengeDraft(active, { actorId: actor, instanceId: uuid(999),
    localDate: '2026-10-01', serverDate: '2026-10-01', actionId: 'bible', completed: true,
    expectedVersion: 0, now: stamp(1) }), error => error.code === 'PREVIEW_INSTANCE_CHANGED');
  const draft = mutatePreviewChallengeDraft(active, { actorId: actor, instanceId: firstId,
    localDate: '2026-10-01', serverDate: '2026-10-01', actionId: 'bible', completed: true,
    expectedVersion: 0, now: stamp(1) }).state;
  assert.throws(() => submitPreviewChallengeCheckIn(draft, { actorId: actor, instanceId: firstId,
    localDate: '2026-10-01', serverDate: '2026-10-01', checkInId: uuid(701), recordedAt: stamp(1),
    completionEventId: uuid(702), persistedAt: stamp(1) }),
  error => error.code === 'PREVIEW_COMPLETION_EVIDENCE_UNEXPECTED');
});
