import test from 'node:test';
import assert from 'node:assert/strict';
import { instanceCalendarDay, isInstanceDate, normalizeChallengeInstance, normalizeInstanceActivation } from './challenge-instance-contract.mjs';

const actor = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const eventId = '33333333-3333-4333-8333-333333333333';
const run = (overrides = {}) => ({ id, challengeKey: 'original_77', title: '77-Day Dominion Challenge',
  scopeKey: `instance:${id}`, status: 'active', startDate: '2026-07-01', timeZone: 'UTC', mode: 'solo', crewId: null,
  targetCount: 77, submittedCount: 76, calendarDay: 92, completedAt: null, completionEventId: null,
  provenance: 'live', reviewRequired: false, ...overrides });
const activation = (overrides = {}) => ({ schemaVersion: 2, actorId: actor, revision: 3, serverDate: '2026-09-30',
  status: 'active', mode: 'solo', startDate: '2026-07-01', timeZone: 'UTC', crewId: null,
  groupMembershipActive: false, reviewRequired: false, canActivateSolo: false, canActivateGroup: false,
  canParticipate: true, canMutateDailyStandards: true, canEditStartDate: false, currentInstance: run(),
  originalRepeat: { challengeKey: 'original_77', targetCount: 77, available: false, canStart: false, reason: 'challenge_active' },
  ...overrides });

test('instance dates preserve Gregorian ordinals, including early years and missed days', () => {
  assert.equal(isInstanceDate('2024-02-29'), true);
  for (const date of ['2026-02-29', '2026-04-31', '0000-01-01', '2026-9-30', null]) assert.equal(isInstanceDate(date), false);
  assert.equal(instanceCalendarDay('0001-01-01', '0001-01-02'), 2);
  assert.equal(instanceCalendarDay('2026-07-01', '2026-09-30'), 92);
  assert.equal(instanceCalendarDay('bad', '2026-09-30'), null);
});

test('valid original and variable-target current runs remain instance scoped', () => {
  const initial = normalizeInstanceActivation(activation(), actor);
  assert.equal(initial.currentInstance.id, id);
  assert.equal(initial.currentInstance.submittedCount, 76);
  assert.equal(initial.challengeDay, 92);
  assert.equal(initial.canMutateDailyStandards, true);
  assert.equal(initial.currentInstance.scopeKey, `instance:${id}`);
  assert.equal(normalizeChallengeInstance(run({ challengeKey: 'bible_in_a_year', title: 'Bible in a Year', targetCount: 365, submittedCount: 100 })).targetCount, 365);
  assert.equal(normalizeChallengeInstance(run({ scopeKey: 'original77:2026-07-01' })).scopeKey, 'original77:2026-07-01');
});

test('live completion requires exact target and persisted source event metadata', () => {
  const completed = run({ status: 'completed', submittedCount: 77, completionEventId: eventId, completedAt: '2026-09-30T12:00:00.123456Z' });
  assert.ok(normalizeChallengeInstance(completed));
  for (const fields of [{ submittedCount: 76 }, { completionEventId: null }, { completedAt: null }, { completedAt: '2026-09-30T29:00:00Z' }]) {
    assert.equal(normalizeChallengeInstance({ ...completed, ...fields }), null);
  }
});

test('historical completed state never fabricates a live event or earned timestamp', () => {
  const historical = run({ status: 'completed', submittedCount: 77, provenance: 'legacy_completed' });
  assert.equal(normalizeChallengeInstance(historical).completedAt, null);
  assert.equal(normalizeChallengeInstance(historical).completionEventId, null);
  assert.equal(normalizeChallengeInstance({ ...historical, completionEventId: eventId }), null);
  assert.equal(normalizeChallengeInstance(run({ provenance: 'legacy_completed' })), null);
});

test('an incomplete run cannot claim completion data or exceed its configured target', () => {
  for (const fields of [{ submittedCount: 77 }, { submittedCount: 78 }, { submittedCount: -1 }, { submittedCount: 3.5 },
    { targetCount: 76 }, { completionEventId: eventId }, { completedAt: '2026-09-30T12:00:00Z' },
    { id: 'not-a-uuid' }, { scopeKey: 'instance:someone-else' }, { scopeKey: 'original77:2026-07-02' }, { title: '' },
    { timeZone: 'Not/A_Timezone' }, { mode: 'group', crewId: null }]) assert.equal(normalizeChallengeInstance(run(fields)), null);
});

test('scheduled run cannot contain submissions and must begin after the server date', () => {
  const scheduled = run({ status: 'scheduled', startDate: '2026-10-01', calendarDay: null, submittedCount: 0 });
  assert.ok(normalizeChallengeInstance(scheduled, { serverDate: '2026-09-30' }));
  assert.equal(normalizeChallengeInstance(scheduled, { serverDate: '2026-10-01' }), null);
  assert.equal(normalizeChallengeInstance({ ...scheduled, submittedCount: 1 }), null);
  assert.equal(normalizeChallengeInstance(run(), { serverDate: '2026-09-29' }), null);
});

test('activation rejects wrong actor, unknown version, inconsistent aliases and unsafe capabilities', () => {
  assert.equal(normalizeInstanceActivation(activation(), 'someone-else'), null);
  for (const fields of [{ schemaVersion: 1 }, { revision: -1 }, { revision: '3' }, { status: 'completed' },
    { startDate: '2026-07-02' }, { timeZone: 'America/Los_Angeles' }, { mode: 'group' },
    { reviewRequired: true }, { canActivateSolo: true }, { canActivateGroup: true }, { canEditStartDate: true },
    { groupMembershipActive: true }, { canParticipate: false }, { currentInstance: undefined }]) {
    assert.equal(normalizeInstanceActivation(activation(fields), actor), null);
  }
});

test('not-started activation is closed and has no repeat authority', () => {
  const initial = activation({ status: 'not_started', mode: null, startDate: null, timeZone: null, crewId: null,
    currentInstance: null, canParticipate: false, canMutateDailyStandards: false, canActivateSolo: true,
    canActivateGroup: true, originalRepeat: { challengeKey: 'original_77', targetCount: 77, available: false, canStart: false, reason: 'original_not_completed' } });
  assert.ok(normalizeInstanceActivation(initial, actor));
  assert.equal(normalizeInstanceActivation({ ...initial, canMutateDailyStandards: true }, actor), null);
  assert.equal(normalizeInstanceActivation({ ...initial, originalRepeat: { ...initial.originalRepeat, available: true } }, actor), null);
});

test('repeat permission is explicit and requires completed current context', () => {
  const repeat = { challengeKey: 'original_77', targetCount: 77, available: true, canStart: true, reason: null };
  const complete = activation({ status: 'completed', currentInstance: run({ status: 'completed', submittedCount: 77,
    completedAt: '2026-09-30T12:00:00Z', completionEventId: eventId }), canParticipate: false, canMutateDailyStandards: false, originalRepeat: repeat });
  assert.equal(normalizeInstanceActivation(complete, actor).originalRepeat.canStart, true);
  assert.equal(normalizeInstanceActivation(activation({ originalRepeat: repeat }), actor), null);
  for (const fields of [{ available: false }, { reason: 'membership_required' }, { targetCount: 7 }]) {
    assert.equal(normalizeInstanceActivation({ ...complete, originalRepeat: { ...repeat, ...fields } }, actor), null);
  }
});

test('only the initial untouched solo run can expose edit-start-date', () => {
  const initial = activation({ currentInstance: run({ scopeKey: 'original77:2026-07-01', submittedCount: 0 }), canEditStartDate: true });
  assert.ok(normalizeInstanceActivation(initial, actor));
  assert.equal(normalizeInstanceActivation({ ...initial, currentInstance: run({ submittedCount: 0 }) }, actor), null);
  assert.equal(normalizeInstanceActivation({ ...initial, currentInstance: run({ scopeKey: 'original77:2026-07-01', submittedCount: 1 }) }, actor), null);
});
