import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMockLegacyChallengeActivation, createMockNotStartedChallengeActivation } from './challenge-activation.mjs';
import { getPreviewChallengeFacts } from './preview-challenge-instances.mjs';
import { importPreviewChallengeInstances } from './preview-challenge-import.mjs';
import { emptyOriginal77Progress, previewOriginal77Progress } from './original-77-progress.mjs';

const actorId = 'preview-owner';
const otherActor = 'preview-other';
const startDate = '2026-01-01';
const uuid = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const date = ordinal => new Date(Date.UTC(2026, 0, ordinal)).toISOString().slice(0, 10);
const row = ordinal => ({ source: 'check_in', sourceId: `preview-check-in:${date(ordinal)}`,
  localDate: date(ordinal), occurredAt: `${date(ordinal)}T12:00:00.000001Z`, challengeDay: ordinal,
  completed: ordinal % 2 ? ['walk'] : ['bible', 'walk'], workoutDifficultySelections: {} });
const badgeState = (count, completionEvent = null) => ({ schemaVersion: 1, awards: [{ key: 'already-earned' }], visits: [],
  checkIns: Array.from({ length: count }, (_, index) => row(index + 1)),
  completionEvents: completionEvent ? [completionEvent] : [] });
const factory = (start = 1000) => {
  let next = start;
  const calls = [];
  return { calls, createUuid: () => { const value = uuid(next++); calls.push(value); return value; } };
};
const activationFor = (state, patch = {}) => buildMockLegacyChallengeActivation({ startDate, timeZone: 'UTC', actorId,
  originalProgress: previewOriginal77Progress(state, { userId: actorId, startDate }),
  hasCheckIns: state.checkIns.length > 0, now: new Date('2026-05-01T12:00:00Z'), ...patch });
const base = (patch = {}) => ({ actorId, legacyActivation: createMockNotStartedChallengeActivation(),
  badgeState: badgeState(0), gameStats: {}, challengeRecords: [], ownershipRecords: [], drafts: [], scoredDates: [],
  createUuid: factory().createUuid, ...patch });

test('not-started import creates no run or evidence and does not call the UUID factory', () => {
  const ids = factory();
  const runtime = importPreviewChallengeInstances(base({ createUuid: ids.createUuid,
    gameStats: { totalPoints: 91, dailyStandardsPoints: 77 },
    ownershipRecords: [{ key: 'dominion_night_theme', ownedAt: '2026-01-01T12:00:00Z', celebrationSeenAt: null }],
  }));
  assert.deepEqual(ids.calls, []);
  assert.equal(runtime.currentInstanceId, null);
  assert.deepEqual(runtime.runs, []);
  assert.deepEqual(runtime.checkIns, []);
  assert.deepEqual(runtime.completionEvents, []);
  assert.equal(runtime.lifetimePoints, 91);
  assert.equal(runtime.trustedDailyStandardPoints, 77);
  assert.equal(runtime.preservedLegacyRecords[0].status, 'owned');
});

test('active original history maps preview source strings to private runtime UUIDs and preserves drafts', () => {
  const badges = badgeState(2);
  const ids = factory();
  const before = structuredClone(badges);
  const runtime = importPreviewChallengeInstances(base({ legacyActivation: activationFor(badges), badgeState: badges,
    createUuid: ids.createUuid, scoredDates: [date(1)], drafts: [
      { date: date(3), completed: [], workoutDifficultySelections: {}, version: 0, updatedAt: null },
    ] }));
  assert.deepEqual(badges, before);
  assert.equal(runtime.runs[0].scopeKey, `original77:${startDate}`);
  assert.equal(runtime.runs[0].provenance, 'legacy_bound');
  assert.equal(runtime.runs[0].submittedCount, 2);
  assert.equal(runtime.runs[0].reviewRequired, false);
  assert.deepEqual(runtime.checkIns.map(value => value.id), [uuid(1001), uuid(1002)]);
  assert.deepEqual(runtime.scoredDates, [date(1), date(2)]);
  assert.deepEqual(runtime.drafts[0].completed, []);
  assert.equal(runtime.drafts[0].instanceId, uuid(1000));
});

test('canonical live original completion copies source timestamps and event identity without awarding on import', () => {
  const last = row(77);
  const event = { id: uuid(900), userId: actorId, startDate, sourceId: last.sourceId,
    localDate: last.localDate, recordedAt: last.occurredAt, persistedAt: '2026-03-18T12:00:00.000002Z' };
  const badges = badgeState(77, event);
  const ids = factory();
  const before = structuredClone(badges);
  const runtime = importPreviewChallengeInstances(base({ legacyActivation: activationFor(badges), badgeState: badges,
    createUuid: ids.createUuid, gameStats: { totalPoints: 77, dailyStandardsPoints: 77 } }));
  const run = runtime.runs[0];
  assert.equal(run.status, 'completed');
  assert.equal(run.provenance, 'legacy_bound');
  assert.equal(run.completionEventId, event.id);
  assert.equal(run.completedAt, event.recordedAt);
  assert.deepEqual(runtime.completionEvents[0], { id: event.id, instanceId: run.id,
    sourceCheckInId: uuid(1077), localDate: event.localDate, completedAt: event.recordedAt,
    persistedAt: event.persistedAt, targetCount: 77 });
  const facts = getPreviewChallengeFacts(runtime, { actorId });
  assert.equal(facts.completionEvidence.length, 1);
  assert.equal(facts.completionEvidence[0].sourceCheckInId, uuid(1077));
  assert.deepEqual(badges, before, 'legacy badge history and awards are never rewritten');
});

test('77 historical submissions become legacy completed with no invented date, event, or badge', () => {
  const badges = badgeState(77);
  const runtime = importPreviewChallengeInstances(base({ legacyActivation: activationFor(badges), badgeState: badges,
    createUuid: factory().createUuid }));
  assert.equal(runtime.runs[0].status, 'completed');
  assert.equal(runtime.runs[0].provenance, 'legacy_completed');
  assert.equal(runtime.runs[0].submittedCount, 77);
  assert.equal(runtime.runs[0].completedAt, null);
  assert.equal(runtime.runs[0].completionEventId, null);
  assert.deepEqual(runtime.completionEvents, []);
  assert.deepEqual(getPreviewChallengeFacts(runtime, { actorId }).completionEvidence, []);
});

test('legacy activation counters cannot invent check-ins and contradictory evidence closes the run for review', () => {
  const badges = badgeState(0);
  const claimed = { ...emptyOriginal77Progress(actorId, startDate), submittedCount: 76 };
  const legacyActivation = buildMockLegacyChallengeActivation({ startDate, timeZone: 'UTC', actorId,
    originalProgress: claimed, hasCheckIns: true, now: new Date('2026-05-01T12:00:00Z') });
  const runtime = importPreviewChallengeInstances(base({ legacyActivation, badgeState: badges,
    createUuid: factory().createUuid }));
  assert.equal(runtime.runs[0].submittedCount, 0);
  assert.deepEqual(runtime.checkIns, []);
  assert.equal(runtime.runs[0].reviewRequired, true);

  const malformed = badgeState(2); malformed.checkIns[1] = { ...malformed.checkIns[0] };
  const closed = importPreviewChallengeInstances(base({ legacyActivation: activationFor(badgeState(0)), badgeState: malformed,
    createUuid: factory().createUuid }));
  assert.equal(closed.runs[0].submittedCount, 0);
  assert.deepEqual(closed.checkIns, []);
  assert.equal(closed.runs[0].reviewRequired, true);
});

test('approved legacy grants retain their lifecycle but never become canonical completion evidence', () => {
  const badges = badgeState(77);
  const runtime = importPreviewChallengeInstances(base({ legacyActivation: activationFor(badges), badgeState: badges,
    createUuid: factory().createUuid,
    ownershipRecords: [{ key: 'dominion_night_theme', ownedAt: '2026-01-01T12:00:00Z',
      celebrationSeenAt: '2026-01-02T12:00:00Z' }],
    challengeRecords: [{ key: 'seven_day_reset', status: 'completed', unlockedAt: '2026-01-03T12:00:00Z',
      startedAt: '2026-01-04T12:00:00Z', completedAt: '2026-01-11T12:00:00Z', celebrationSeenAt: null }],
  }));
  assert.deepEqual(runtime.preservedLegacyRecords.map(record => [record.key, record.status]),
    [['dominion_night_theme', 'owned'], ['seven_day_reset', 'completed']]);
  const facts = getPreviewChallengeFacts(runtime, { actorId });
  assert.deepEqual(facts.completedChallengeKeys, ['original_77', 'seven_day_reset']);
  assert.deepEqual(facts.completionEvidence, []);
});

test('completed and active later-track grants become resumable ordered runtime history without invented evidence', () => {
  const badges = badgeState(77);
  const runtime = importPreviewChallengeInstances(base({ legacyActivation: activationFor(badges), badgeState: badges,
    createUuid: factory().createUuid, challengeRecords: [
      { key: 'seven_day_reset', status: 'completed', unlockedAt: '2026-03-19T12:00:00Z',
        startedAt: '2026-04-01T01:00:00-07:00', completedAt: '2026-04-08T08:00:00Z', celebrationSeenAt: null },
      { key: 'twenty_one_day_prayer', status: 'active', unlockedAt: '2026-04-08T08:00:00Z',
        startedAt: '2026-04-09T01:00:00-07:00', completedAt: null, celebrationSeenAt: null },
    ] }));
  assert.deepEqual(runtime.runs.map(run => [run.sequenceNo, run.challengeKey, run.status, run.submittedCount]), [
    [0, 'original_77', 'completed', 77], [1, 'seven_day_reset', 'completed', 0],
    [2, 'twenty_one_day_prayer', 'active', 0],
  ]);
  assert.equal(runtime.runs[1].provenance, 'legacy_completed');
  assert.equal(runtime.runs[1].startDate, '2026-04-01');
  assert.equal(runtime.runs[1].completedAt, '2026-04-08T08:00:00Z');
  assert.equal(runtime.runs[1].completionEventId, null);
  assert.equal(runtime.runs[2].provenance, 'legacy_bound');
  assert.equal(runtime.runs[2].startDate, '2026-04-09');
  assert.equal(runtime.runs[2].reviewRequired, false);
  assert.equal(runtime.currentInstanceId, runtime.runs[2].id);
  assert.deepEqual(getPreviewChallengeFacts(runtime, { actorId }).completedChallengeKeys,
    ['original_77', 'seven_day_reset']);
  assert.deepEqual(getPreviewChallengeFacts(runtime, { actorId }).completionEvidence, []);
  assert.deepEqual(runtime.preservedLegacyRecords.filter(record => record.status !== 'owned')
    .map(record => [record.key, record.status]),
  [['seven_day_reset', 'completed'], ['twenty_one_day_prayer', 'active']]);
});

test('later lifecycle conflicts retain every raw grant but close the represented current run for review', () => {
  const badges = badgeState(1);
  const runtime = importPreviewChallengeInstances(base({ legacyActivation: activationFor(badges), badgeState: badges,
    createUuid: factory().createUuid, challengeRecords: [
      { key: 'seven_day_reset', status: 'active', unlockedAt: '2026-04-01T08:00:00Z',
        startedAt: '2026-04-02T08:00:00Z', completedAt: null, celebrationSeenAt: null },
    ] }));
  assert.deepEqual(runtime.runs.map(run => run.challengeKey), ['original_77']);
  assert.equal(runtime.runs[0].reviewRequired, true);
  assert.deepEqual(runtime.preservedLegacyRecords.map(record => [record.key, record.status]),
    [['seven_day_reset', 'active']]);
});

test('explicit preserved grants bypass only new predecessor rules while contradictory chronology requires review', () => {
  const badges = badgeState(77);
  const gap = importPreviewChallengeInstances(base({ legacyActivation: activationFor(badges), badgeState: badges,
    createUuid: factory().createUuid, challengeRecords: [
      { key: 'thirty_day_strength', status: 'active', unlockedAt: '2026-04-01T08:00:00Z',
        startedAt: '2026-04-02T08:00:00Z', completedAt: null, celebrationSeenAt: null },
    ] }));
  assert.deepEqual(gap.runs.map(run => run.challengeKey), ['original_77', 'thirty_day_strength']);
  assert.equal(gap.runs.at(-1).reviewRequired, false,
    'a durable pre-chain grant stays usable without inventing a predecessor completion');

  const contradictory = importPreviewChallengeInstances(base({ legacyActivation: activationFor(badges), badgeState: badges,
    createUuid: factory(3000).createUuid, challengeRecords: [
      { key: 'seven_day_reset', status: 'completed', unlockedAt: '2026-05-01T08:00:00Z',
        startedAt: '2026-05-02T08:00:00Z', completedAt: '2026-05-09T08:00:00Z', celebrationSeenAt: null },
      { key: 'twenty_one_day_prayer', status: 'completed', unlockedAt: '2026-04-01T08:00:00Z',
        startedAt: '2026-04-02T08:00:00Z', completedAt: '2026-04-23T08:00:00Z', celebrationSeenAt: null },
    ] }));
  assert.deepEqual(contradictory.runs.map(run => run.challengeKey),
    ['original_77', 'seven_day_reset', 'twenty_one_day_prayer']);
  assert.equal(contradictory.runs.at(-1).reviewRequired, true);
  assert.deepEqual(contradictory.preservedLegacyRecords.map(record => record.key),
    ['seven_day_reset', 'twenty_one_day_prayer']);

  const localConflict = importPreviewChallengeInstances(base({ legacyActivation: activationFor(badges), badgeState: badges,
    createUuid: factory(5000).createUuid, challengeRecords: [
      { key: 'seven_day_reset', status: 'completed', unlockedAt: '2026-04-03T08:00:00Z',
        startedAt: '2026-04-02T08:00:00Z', completedAt: '2026-04-09T08:00:00Z', celebrationSeenAt: null },
    ] }));
  assert.equal(localConflict.runs.at(-1).challengeKey, 'seven_day_reset');
  assert.equal(localConflict.runs.at(-1).reviewRequired, true);
});

test('alias conflicts and malformed optional workout evidence fail closed without changing source history', () => {
  assert.throws(() => importPreviewChallengeInstances(base({ ownershipRecords: [{ key: 'theme', rewardKey: 'other',
    ownedAt: '2026-01-01T12:00:00Z', celebrationSeenAt: null }] })), /aliases conflict/u);
  const badges = badgeState(1);
  assert.throws(() => importPreviewChallengeInstances(base({ legacyActivation: {
    ...activationFor(badges), start_date: '2026-01-02',
  }, badgeState: badges })), /aliases conflict/u);
  const malformed = badgeState(1);
  malformed.checkIns[0].workoutDifficultySelections = { workoutOne: 'impossible' };
  const runtime = importPreviewChallengeInstances(base({ legacyActivation: activationFor(malformed), badgeState: malformed,
    createUuid: factory().createUuid }));
  assert.equal(runtime.runs[0].submittedCount, 1);
  assert.equal(runtime.runs[0].reviewRequired, true);
  assert.deepEqual(runtime.checkIns[0].workoutDifficulty, {});
  assert.deepEqual(malformed.checkIns[0].workoutDifficultySelections, { workoutOne: 'impossible' });
});

test('an absent legacy activation preserves durable facts without inventing a run or UUID', () => {
  const ids = factory();
  const runtime = importPreviewChallengeInstances(base({ legacyActivation: null, createUuid: ids.createUuid,
    ownershipRecords: [{ key: 'dominion_night_theme', ownedAt: '2026-01-01T12:00:00Z', celebrationSeenAt: null }] }));
  assert.deepEqual(ids.calls, []);
  assert.equal(runtime.currentInstanceId, null);
  assert.deepEqual(runtime.runs, []);
  assert.deepEqual(runtime.preservedLegacyRecords.map(record => record.key), ['dominion_night_theme']);
});

test('missing original activation context cannot silently orphan an active or completed later run', () => {
  const later = status => ({ key: 'seven_day_reset', status, unlockedAt: '2026-04-01T08:00:00Z',
    startedAt: '2026-04-02T08:00:00Z', completedAt: status === 'completed' ? '2026-04-09T08:00:00Z' : null,
    celebrationSeenAt: null });
  for (const [legacyActivation, status] of [[null, 'active'], [createMockNotStartedChallengeActivation(), 'completed']]) {
    const input = base({ legacyActivation, challengeRecords: [later(status)] });
    const before = structuredClone({ ...input, createUuid: null });
    assert.throws(() => importPreviewChallengeInstances(input), /missing its activation context/u);
    assert.deepEqual({ ...input, createUuid: null }, before);
  }
});

test('cross-owner activation, accessors, malformed grants and UUID collisions fail without mutating inputs', () => {
  const badges = badgeState(1);
  const otherProgress = previewOriginal77Progress(badges, { userId: otherActor, startDate });
  const otherActivation = buildMockLegacyChallengeActivation({ startDate, timeZone: 'UTC', actorId: otherActor,
    originalProgress: otherProgress, hasCheckIns: true, now: new Date('2026-05-01T12:00:00Z') });
  const input = base({ legacyActivation: otherActivation, badgeState: badges,
    createUuid: factory().createUuid });
  const before = structuredClone({ ...input, createUuid: null });
  assert.throws(() => importPreviewChallengeInstances(input), error => error.code === 'PREVIEW_INSTANCE_IMPORT_INVALID');
  assert.deepEqual({ ...input, createUuid: null }, before);

  const accessor = base(); Object.defineProperty(accessor, 'actorId', { enumerable: true, get() { throw new Error('read'); } });
  assert.throws(() => importPreviewChallengeInstances(accessor), /invalid/u);
  assert.throws(() => importPreviewChallengeInstances(base({ ownershipRecords: [
    { key: 'theme', ownedAt: '2026-01-01T12:00:00Z', celebrationSeenAt: null, grantReason: 'bad\nreason' },
  ] })), /grant reason/u);
  const collision = () => uuid(1);
  assert.throws(() => importPreviewChallengeInstances(base({ legacyActivation: activationFor(badges), badgeState: badges,
    createUuid: collision })), /fresh preview UUID/u);
});
