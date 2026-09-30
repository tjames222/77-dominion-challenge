import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { emptyOriginal77Progress } from './original-77-progress.mjs';
import {
  CHALLENGE_ACTIVATION_SCHEMA_VERSION,
  buildMockChallengeActivation,
  buildMockLegacyChallengeActivation,
  challengeActivationDateKeyForTimeZone,
  challengeActivationDay,
  challengeActivationReadError,
  createMockNotStartedChallengeActivation,
  createChallengeActivationState,
  isSupportedChallengeActivationDate,
  newChallengeActivationRequestId,
  normalizeChallengeActivation,
  normalizeChallengeActivationMutation,
  refreshMockChallengeActivation,
} from './challenge-activation.mjs';

const explicitCapabilities = Object.freeze({
  canActivateSolo: false,
  canActivateGroup: false,
  canParticipate: true,
  canMutateDailyStandards: true,
  canEditStartDate: true,
});

const activeSolo = Object.freeze({
  originalProgress: emptyOriginal77Progress('user-1', '2026-08-04'),
  schemaVersion: CHALLENGE_ACTIVATION_SCHEMA_VERSION,
  status: 'active',
  storedStatus: 'active',
  mode: 'solo',
  startDate: '2026-08-04',
  timeZone: 'America/Los_Angeles',
  challengeDay: 1,
  crewId: null,
  groupMembershipActive: false,
  activatedAt: '2026-08-04T15:30:00Z',
  confirmedAt: '2026-08-04T15:29:58.123Z',
  activatedBy: 'user-1',
  confirmedBy: 'user-1',
  revision: 1,
  reviewRequired: false,
  ...explicitCapabilities,
});

const notStarted = Object.freeze({
  originalProgress: null,
  schemaVersion: CHALLENGE_ACTIVATION_SCHEMA_VERSION,
  status: 'not_started',
  storedStatus: 'not_started',
  mode: null,
  startDate: null,
  timeZone: null,
  challengeDay: null,
  crewId: null,
  groupMembershipActive: false,
  activatedAt: null,
  confirmedAt: null,
  activatedBy: null,
  confirmedBy: null,
  revision: 0,
  reviewRequired: false,
  canActivateSolo: true,
  canActivateGroup: true,
  canParticipate: false,
  canMutateDailyStandards: false,
  canEditStartDate: false,
});

describe('challenge activation read contract', () => {
  test('creates an isolated mock account in an authoritative not-started state', () => {
    const state = createMockNotStartedChallengeActivation();

    assert.equal(state.contractValid, true);
    assert.equal(state.status, 'not_started');
    assert.equal(state.startDate, null);
    assert.equal(state.timeZone, null);
    assert.equal(state.revision, 0);
    assert.equal(state.canActivateSolo, true);
    assert.equal(state.canActivateGroup, true);
    assert.equal(state.canParticipate, false);
    assert.equal(state.canMutateDailyStandards, false);
  });

  test('starts loading with every capability closed and no error field', () => {
    const state = createChallengeActivationState();

    assert.equal(state.readState, 'loading');
    assert.equal(state.contractValid, false);
    assert.equal(state.canParticipate, false);
    assert.equal(state.canMutateDailyStandards, false);
    assert.equal(state.canEditStartDate, false);
    assert.equal(Object.hasOwn(state, 'errorMessage'), false);
  });

  test('accepts a complete schema-v1 Solo response and mirrors explicit capabilities', () => {
    const state = normalizeChallengeActivation(activeSolo);

    assert.equal(state.contractValid, true);
    assert.equal(state.status, 'active');
    assert.equal(state.storedStatus, 'active');
    assert.equal(state.mode, 'solo');
    assert.equal(state.challengeDay, 1);
    assert.equal(state.canParticipate, true);
    assert.equal(state.canMutateDailyStandards, true);
    assert.equal(state.canEditStartDate, true);
    assert.deepEqual(state.capabilities, {
      canActivateSolo: false,
      canActivateGroup: false,
      canParticipate: true,
      canMutateDailyStandards: true,
      canEditStartDate: true,
    });
    assert.equal(Object.hasOwn(state, 'errorMessage'), false);
  });

  test('preserves Group attribution after membership becomes inactive without granting edits', () => {
    const state = normalizeChallengeActivation({
      schema_version: 1,
      status: 'scheduled',
      stored_status: 'scheduled',
      participation_mode: 'group',
      challenge_start_date: '2026-08-10',
      time_zone: 'UTC',
      challenge_day: null,
      crew_id: 'crew-history-1',
      group_membership_active: false,
      activated_at: null,
      confirmed_at: '2026-08-04T16:00:00+00:00',
      activated_by: null,
      confirmed_by: 'user-1',
      activation_revision: 2,
      activation_review_required: false,
      originalProgress: emptyOriginal77Progress('user-1', '2026-08-10'),
      capabilities: {
        can_activate_solo: false,
        can_activate_group: false,
        can_participate: true,
        can_mutate_daily_standards: true,
        can_edit_start_date: true,
      },
    });

    assert.equal(state.contractValid, true);
    assert.equal(state.groupMembershipActive, false);
    assert.equal(state.crewId, 'crew-history-1');
    assert.equal(state.groupAttributionCrewId, 'crew-history-1');
    assert.equal(state.canParticipate, false);
    assert.equal(state.canMutateDailyStandards, false);
    assert.equal(state.canEditStartDate, false);
  });

  test('requires explicit server capabilities instead of deriving write access', () => {
    const { canMutateDailyStandards: omitted, ...missingCapability } = activeSolo;
    const malformed = normalizeChallengeActivation(missingCapability);

    assert.equal(malformed.readState, 'error');
    assert.equal(malformed.contractValid, false);
    assert.equal(malformed.status, null);
    assert.match(malformed.errorMessage, /could not be verified/i);
    assert.equal(malformed.canParticipate, false);
    assert.equal(malformed.canMutateDailyStandards, false);
    assert.equal(malformed.canEditStartDate, false);
  });

  test('fails closed for unknown schemas and malformed lifecycle metadata', () => {
    const malformedPayloads = [
      { ...activeSolo, schemaVersion: 2 },
      { ...activeSolo, status: 'paused' },
      { ...activeSolo, mode: 'crew' },
      { ...activeSolo, startDate: '2026-02-30' },
      { ...activeSolo, activatedAt: 'yesterday' },
      { ...activeSolo, activatedAt: '2026-02-30T15:30:00Z' },
      { ...activeSolo, activatedAt: '2026-08-04T25:30:00Z' },
      { ...activeSolo, activatedAt: null },
      { ...activeSolo, confirmedBy: null },
      { ...activeSolo, challengeDay: null },
      { ...activeSolo, crewId: 'unexpected-crew' },
      { ...activeSolo, groupMembershipActive: undefined },
      { ...activeSolo, revision: -1 },
      { ...activeSolo, revision: '1' },
    ];

    for (const payload of malformedPayloads) {
      const state = normalizeChallengeActivation(payload);
      assert.equal(state.readState, 'error');
      assert.equal(state.contractValid, false);
      assert.equal(state.canParticipate, false);
      assert.equal(state.canMutateDailyStandards, false);
      assert.equal(state.canEditStartDate, false);
    }
  });

  test('keeps completed legacy day numbers readable while honoring server write denial', () => {
    const state = normalizeChallengeActivation({
      ...activeSolo,
      challengeDay: 91,
      canParticipate: true,
      canMutateDailyStandards: false,
    });

    assert.equal(state.contractValid, true);
    assert.equal(state.challengeDay, 91);
    assert.equal(state.canParticipate, true);
    assert.equal(state.canMutateDailyStandards, false);
  });

  test('keeps read failures distinct from ready and loading states', () => {
    const failure = challengeActivationReadError(new Error('Activation service unavailable'));

    assert.equal(failure.readState, 'error');
    assert.equal(failure.errorMessage, 'Activation service unavailable');
    assert.equal(failure.canParticipate, false);
    assert.equal(failure.canMutateDailyStandards, false);
    assert.equal(failure.canEditStartDate, false);
    assert.equal(Object.hasOwn(createChallengeActivationState('ready'), 'errorMessage'), false);
  });

  test('binds progress to the expected actor and locks canonical completed or invalid evidence', () => {
    const late = { ...activeSolo, challengeDay: 91, originalProgress: { ...activeSolo.originalProgress, submittedCount: 76 } };
    assert.equal(normalizeChallengeActivation(late, { expectedUserId: 'user-1' }).canMutateDailyStandards, true);
    assert.equal(normalizeChallengeActivation(late, { expectedUserId: 'other' }).contractValid, false);
    assert.equal(normalizeChallengeActivation({ ...late, originalProgress: undefined }).contractValid, false);
    for (const [submittedCount, completionState] of [[77, 'historical_provenance_pending'], [null, 'invalid_evidence']]) {
      const completed = { ...late, canParticipate: false, canMutateDailyStandards: false, canEditStartDate: false,
        originalProgress: { ...late.originalProgress, submittedCount, completionState } };
      const normalized = normalizeChallengeActivation(completed, { expectedUserId: 'user-1' });
      assert.equal(normalized.contractValid, true); assert.equal(normalized.challengeDay, 91);
      assert.equal(normalized.originalProgress.submittedCount, submittedCount);
      assert.equal(normalizeChallengeActivation({ ...completed, canMutateDailyStandards: true }).contractValid, false);
    }
  });

  test('closed progress cannot reopen participation or start-date edits through inconsistent capabilities', () => {
    const event = { id: '11111111-1111-4111-8111-111111111111',
      sourceId: '22222222-2222-4222-8222-222222222222', localDate: '2026-11-02',
      recordedAt: '2026-11-02T12:00:00.123456Z', persistedAt: '2026-11-02T12:00:01.123456Z' };
    for (const [submittedCount, completionState, canonicalEvent] of [
      [null, 'invalid_evidence', null], [77, 'historical_provenance_pending', null],
      [77, 'live_completed', event],
    ]) {
      const normalized = normalizeChallengeActivation({ ...activeSolo, challengeDay: 91,
        canParticipate: true, canMutateDailyStandards: false, canEditStartDate: true,
        originalProgress: { ...activeSolo.originalProgress, submittedCount, completionState, canonicalEvent },
      }, { expectedUserId: 'user-1' });
      assert.equal(normalized.contractValid, true);
      assert.equal(normalized.originalProgress.submittedCount, submittedCount);
      assert.equal(normalized.originalProgress.completionState, completionState);
      for (const key of ['canParticipate', 'canMutateDailyStandards', 'canEditStartDate']) {
        assert.equal(normalized[key], false);
        assert.equal(normalized.capabilities[key], false);
      }
    }
  });

  test('a submitted check-in makes the original start date immutable despite a requested capability', () => {
    for (const submittedCount of [0, 1, 76]) {
      const normalized = normalizeChallengeActivation({ ...activeSolo,
        originalProgress: { ...activeSolo.originalProgress, submittedCount },
      }, { expectedUserId: 'user-1' });
      assert.equal(normalized.contractValid, true);
      assert.equal(normalized.canMutateDailyStandards, true);
      assert.equal(normalized.canEditStartDate, submittedCount === 0);
      assert.equal(normalized.capabilities.canEditStartDate, submittedCount === 0);
    }
  });

  test('creates UUID-v4 request identifiers, including without randomUUID', () => {
    const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    assert.match(newChallengeActivationRequestId(), uuidV4);

    const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {
        getRandomValues(bytes) {
          bytes.fill(0xab);
          return bytes;
        },
      },
    });
    try {
      assert.equal(newChallengeActivationRequestId(), 'abababab-abab-4bab-abab-abababababab');
    } finally {
      if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
      else delete globalThis.crypto;
    }
  });

  test('keeps back-to-back mock Solo and Group request IDs fresh under deterministic crypto', () => {
    const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {
        randomUUID: () => '00000000-0000-4000-8000-000000000077',
        getRandomValues(bytes) {
          bytes.fill(0xab);
          return bytes;
        },
      },
    });
    try {
      const soloRequestId = newChallengeActivationRequestId();
      const groupRequestId = newChallengeActivationRequestId();
      assert.match(soloRequestId, uuidV4);
      assert.match(groupRequestId, uuidV4);
      assert.notEqual(groupRequestId, soloRequestId);
    } finally {
      if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
      else delete globalThis.crypto;
    }
  });

  test('rejects malformed mutation responses instead of reporting a closed state as success', () => {
    assert.throws(
      () => normalizeChallengeActivationMutation({ ...activeSolo, canParticipate: undefined }),
      (error) => error.code === 'CHALLENGE_ACTIVATION_CONTRACT_INVALID',
    );
    assert.equal(normalizeChallengeActivationMutation(activeSolo).contractValid, true);
  });

  test('uses the requested IANA timezone and the full supported date range for mock dates', () => {
    const boundary = new Date('2026-08-05T00:30:00.000Z');
    assert.equal(challengeActivationDateKeyForTimeZone(boundary, 'America/Los_Angeles'), '2026-08-04');
    assert.equal(challengeActivationDateKeyForTimeZone(boundary, 'Asia/Tokyo'), '2026-08-05');
    assert.equal(challengeActivationDay('0001-01-01', '0001-01-02'), 2);
    assert.equal(isSupportedChallengeActivationDate('0001-01-01'), true);
    assert.equal(isSupportedChallengeActivationDate('9999-12-31'), true);
    assert.equal(isSupportedChallengeActivationDate('2026-02-30'), false);
    assert.throws(
      () => challengeActivationDateKeyForTimeZone(boundary, 'Not/A_Timezone'),
      /valid time zone/i,
    );
  });

  test('models scheduled activation, due promotion, entitlement gates, and check-in date locks', () => {
    const scheduled = buildMockChallengeActivation({
      current: notStarted,
      action: 'solo_activate',
      startDate: '2026-08-05',
      timeZone: 'America/Los_Angeles',
      actorId: 'user-1',
      now: new Date('2026-08-05T00:30:00.000Z'),
    });
    assert.equal(scheduled.status, 'scheduled');
    assert.equal(scheduled.challengeDay, null);
    assert.equal(scheduled.revision, 1);

    const promoted = refreshMockChallengeActivation(scheduled, {
      now: new Date('2026-08-05T08:30:00.000Z'),
      hasEntitlement: true,
    });
    assert.equal(promoted.status, 'active');
    assert.equal(promoted.challengeDay, 1);
    assert.equal(promoted.revision, 2);
    assert.equal(promoted.canMutateDailyStandards, true);

    const locked = refreshMockChallengeActivation(promoted, {
      now: new Date('2026-08-05T08:30:00.000Z'),
      hasCheckIns: true,
      hasEntitlement: false,
    });
    assert.equal(locked.canEditStartDate, false);
    assert.equal(locked.canMutateDailyStandards, false);

    const stillLocked = refreshMockChallengeActivation(locked, {
      now: new Date('2026-08-05T08:30:00.000Z'),
      hasCheckIns: false,
      hasEntitlement: true,
    });
    assert.equal(stillLocked.canEditStartDate, false);
    assert.equal(stillLocked.canMutateDailyStandards, true);
  });

  test('retains a past77 legacy calendar ordinal without inventing completion from elapsed time', () => {
    const backfilled = buildMockLegacyChallengeActivation({
      startDate: '2026-05-01',
      timeZone: 'America/Los_Angeles',
      actorId: 'legacy-user',
      hasCheckIns: true,
      hasEntitlement: true,
      now: new Date('2026-08-05T08:30:00.000Z'),
    });

    assert.equal(backfilled.status, 'active');
    assert.equal(backfilled.mode, 'solo');
    assert.equal(backfilled.startDate, '2026-05-01');
    assert.equal(backfilled.timeZone, 'America/Los_Angeles');
    assert.equal(backfilled.challengeDay, 97);
    assert.equal(backfilled.canParticipate, true);
    assert.equal(backfilled.canMutateDailyStandards, true);
    assert.equal(backfilled.originalProgress.submittedCount, 0);
    assert.equal(backfilled.canEditStartDate, false);
  });

  test('enforces mock expected-revision compare-and-swap while allowing an idempotent no-op', () => {
    const current = buildMockChallengeActivation({
      current: notStarted,
      action: 'solo_activate',
      startDate: '2026-08-04',
      timeZone: 'UTC',
      actorId: 'user-1',
      now: new Date('2026-08-04T12:00:00.000Z'),
    });

    assert.throws(
      () => buildMockChallengeActivation({
        current,
        action: 'date_update',
        startDate: '2026-08-05',
        timeZone: 'UTC',
        actorId: 'user-1',
        expectedRevision: current.revision - 1,
        now: new Date('2026-08-04T12:00:00.000Z'),
      }),
      (error) => error.code === '40001' && error.details === 'challenge_activation_stale_revision',
    );

    const noOp = buildMockChallengeActivation({
      current,
      action: 'date_update',
      startDate: current.startDate,
      timeZone: current.timeZone,
      actorId: 'user-1',
      expectedRevision: current.revision - 1,
      now: new Date('2026-08-04T12:00:00.000Z'),
    });
    assert.equal(noOp.revision, current.revision);
    assert.equal(noOp.startDate, current.startDate);
  });

  test('returns the existing Solo activation for a compatible fresh request', () => {
    const current = buildMockChallengeActivation({
      current: notStarted,
      action: 'solo_activate',
      startDate: '2026-08-04',
      timeZone: 'UTC',
      actorId: 'user-1',
      now: new Date('2026-08-04T12:00:00.000Z'),
    });
    const retried = buildMockChallengeActivation({
      current,
      action: 'solo_activate',
      startDate: current.startDate,
      timeZone: current.timeZone,
      actorId: 'user-1',
      now: new Date('2026-08-04T12:05:00.000Z'),
    });

    assert.deepEqual(retried, current);
  });

  test('returns the existing Group activation for a compatible fresh request', () => {
    const current = buildMockChallengeActivation({
      current: notStarted,
      action: 'group_activate',
      startDate: '2026-08-05',
      timeZone: 'UTC',
      actorId: 'user-1',
      crewId: 'crew-1',
      groupMembershipActive: true,
      now: new Date('2026-08-04T12:00:00.000Z'),
    });
    const retried = buildMockChallengeActivation({
      current,
      action: 'group_activate',
      startDate: current.startDate,
      timeZone: current.timeZone,
      actorId: 'user-1',
      crewId: 'crew-1',
      groupMembershipActive: true,
      now: new Date('2026-08-04T12:05:00.000Z'),
    });

    assert.deepEqual(retried, current);
  });

  test('rejects invalid and out-of-window mock activation dates', () => {
    const inputs = ['2026-02-30', 'not-a-date', '', null];
    for (const startDate of inputs) {
      assert.throws(() => buildMockChallengeActivation({
        current: notStarted,
        action: 'solo_activate',
        startDate,
        timeZone: 'UTC',
        actorId: 'user-1',
        now: new Date('2026-08-04T12:00:00.000Z'),
      }), /valid challenge start date/i);
    }
    assert.throws(() => buildMockChallengeActivation({
      current: notStarted,
      action: 'solo_activate',
      startDate: '2026-05-19',
      timeZone: 'UTC',
      actorId: 'user-1',
      now: new Date('2026-08-04T12:00:00.000Z'),
    }), /77-day challenge window/i);
  });
});
