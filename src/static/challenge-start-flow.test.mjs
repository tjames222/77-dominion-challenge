import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  GROUP_CHALLENGE_START_HREF,
  SOLO_TRAINING_LAUNCH_EVENT,
  SOLO_TRAINING_LAUNCH_STORAGE_KEY,
  backChallengeStartFlow,
  buildGroupChallengeStartHref,
  compareAndClearSoloTrainingLaunch,
  confirmSoloChallengeStart,
  continueChallengeStartMode,
  createChallengeStartFlowState,
  createSoloTrainingLaunch,
  dashboardActivationGate,
  markChallengeStartSubmission,
  persistSoloTrainingLaunch,
  publishSoloTrainingLaunch,
  readSoloTrainingLaunch,
  selectChallengeStartMode,
  setSoloChallengeStartDate,
  soloTrainingLaunchMatchesActivation,
  soloChallengeStartSummary,
  validateSoloChallengeStartDate,
} from './challenge-start-flow.mjs';

const FIXED_NOW = new Date('2026-02-14T17:30:00.000Z');

const NOT_STARTED = Object.freeze({
  readState: 'ready',
  contractValid: true,
  status: 'not_started',
  canActivateSolo: true,
  canActivateGroup: true,
  canParticipate: false,
  canMutateDailyStandards: false,
});

const ACTIVE_SOLO = Object.freeze({
  readState: 'ready',
  contractValid: true,
  status: 'active',
  mode: 'solo',
  startDate: '2026-02-14',
  timeZone: 'UTC',
  revision: 3,
  canActivateSolo: false,
  canActivateGroup: false,
  canParticipate: true,
  canMutateDailyStandards: true,
});

class MemoryStorage {
  #values = new Map();

  getItem(key) {
    return this.#values.has(key) ? this.#values.get(key) : null;
  }

  setItem(key, value) {
    this.#values.set(key, String(value));
  }
}

describe('challenge start choice state', () => {
  test('uses one fixed Group handoff and never places activation data in the URL', () => {
    assert.equal(buildGroupChallengeStartHref(), GROUP_CHALLENGE_START_HREF);
    assert.equal(GROUP_CHALLENGE_START_HREF, './community.html?intent=challenge-start');
    assert.equal(new URL(GROUP_CHALLENGE_START_HREF, 'https://dominion.test/dashboard.html').searchParams.size, 1);
  });

  test('keeps mode choice reversible before any mutation is attempted', () => {
    const initial = createChallengeStartFlowState({
      canActivateGroup: true,
      canActivateSolo: true,
      timeZone: 'UTC',
    });
    const group = continueChallengeStartMode(selectChallengeStartMode(initial, 'group'));
    assert.equal(group.step, 'group_handoff');
    assert.equal(group.submissionAttempted, false);

    const solo = continueChallengeStartMode(selectChallengeStartMode(initial, 'solo'));
    assert.equal(solo.step, 'date');
    assert.equal(backChallengeStartFlow(solo).step, 'mode');
    assert.deepEqual(continueChallengeStartMode(selectChallengeStartMode(initial, 'unknown')), initial);
  });

  test('creates one idempotency key for confirmation and preserves it across exact retries', () => {
    let state = createChallengeStartFlowState({
      canActivateSolo: true,
      timeZone: 'UTC',
    });
    state = continueChallengeStartMode(selectChallengeStartMode(state, 'solo'));
    state = setSoloChallengeStartDate(state, '2099-02-14');

    const first = confirmSoloChallengeStart(state, 'request-one');
    assert.equal(first.validation.valid, true);
    assert.equal(first.state.step, 'confirm');
    assert.equal(first.state.requestId, 'request-one');

    const retried = confirmSoloChallengeStart(markChallengeStartSubmission(first.state), 'request-two');
    assert.equal(retried.state.requestId, 'request-one');
    assert.equal(retried.state.submissionAttempted, true);

    const backedUp = backChallengeStartFlow(retried.state);
    assert.equal(backedUp.step, 'date');
    assert.equal(backedUp.requestId, '');
    assert.equal(setSoloChallengeStartDate(backedUp, '2026-02-15').requestId, '');
  });
});

describe('Solo date validation', () => {
  test('rejects impossible dates and dates outside the current 77-day window', () => {
    assert.deepEqual(validateSoloChallengeStartDate({
      startDate: '2026-02-29',
      timeZone: 'UTC',
      now: FIXED_NOW,
    }), {
      valid: false,
      message: 'Choose a valid challenge start date.',
    });

    const finalAllowedDay = validateSoloChallengeStartDate({
      startDate: '2025-11-30',
      timeZone: 'UTC',
      now: FIXED_NOW,
    });
    assert.equal(finalAllowedDay.valid, true);
    assert.equal(finalAllowedDay.status, 'active');
    assert.equal(finalAllowedDay.challengeDay, 77);

    assert.match(validateSoloChallengeStartDate({
      startDate: '2025-11-29',
      timeZone: 'UTC',
      now: FIXED_NOW,
    }).message, /77-day challenge window/i);
  });

  test('describes today, a prior valid date, and a future date before confirmation', () => {
    const today = validateSoloChallengeStartDate({
      startDate: '2026-02-14',
      timeZone: 'UTC',
      now: FIXED_NOW,
    });
    assert.equal(today.status, 'active');
    assert.equal(today.challengeDay, 1);
    assert.match(soloChallengeStartSummary(today), /starts today/i);

    const prior = validateSoloChallengeStartDate({
      startDate: '2026-02-10',
      timeZone: 'UTC',
      now: FIXED_NOW,
    });
    assert.equal(prior.challengeDay, 5);
    assert.match(soloChallengeStartSummary(prior), /Day 5 of 77/);

    const future = validateSoloChallengeStartDate({
      startDate: '2026-02-20',
      timeZone: 'UTC',
      now: FIXED_NOW,
    });
    assert.equal(future.status, 'scheduled');
    assert.equal(future.challengeDay, null);
    assert.match(soloChallengeStartSummary(future), /scheduled/i);
  });

  test('uses the selected time zone as the authoritative date boundary', () => {
    const boundaryNow = new Date('2026-02-15T00:30:00.000Z');
    const losAngeles = validateSoloChallengeStartDate({
      startDate: '2026-02-15',
      timeZone: 'America/Los_Angeles',
      now: boundaryNow,
    });
    const tokyo = validateSoloChallengeStartDate({
      startDate: '2026-02-15',
      timeZone: 'Asia/Tokyo',
      now: boundaryNow,
    });

    assert.equal(losAngeles.currentDate, '2026-02-14');
    assert.equal(losAngeles.status, 'scheduled');
    assert.equal(tokyo.currentDate, '2026-02-15');
    assert.equal(tokyo.status, 'active');
    assert.match(validateSoloChallengeStartDate({
      startDate: '2026-02-15',
      timeZone: 'Not/AZone',
      now: boundaryNow,
    }).message, /time zone/i);
  });
});

describe('Dashboard activation gate', () => {
  test('opens only for a verified not-started owner who is online', () => {
    assert.deepEqual(dashboardActivationGate(NOT_STARTED, { hydrated: true, online: true }), {
      ready: true,
      notStarted: true,
      showStartGate: true,
      canStart: true,
      canParticipate: false,
      canMutateDailyStandards: false,
      showRetry: false,
    });
    assert.equal(dashboardActivationGate(NOT_STARTED, { hydrated: true, online: false }).canStart, false);
    assert.equal(dashboardActivationGate(NOT_STARTED, { hydrated: false, online: true }).showStartGate, false);
  });

  test('fails closed for loading, error, scheduled, and active states', () => {
    const loading = dashboardActivationGate({ readState: 'loading' }, { hydrated: true });
    assert.equal(loading.canStart, false);
    assert.equal(loading.canParticipate, false);
    assert.equal(loading.showStartGate, false);

    const failed = dashboardActivationGate({ readState: 'error' }, { hydrated: true });
    assert.equal(failed.showStartGate, true);
    assert.equal(failed.showRetry, true);
    assert.equal(failed.canStart, false);

    const scheduled = dashboardActivationGate({
      ...ACTIVE_SOLO,
      status: 'scheduled',
      canParticipate: false,
      canMutateDailyStandards: false,
    }, { hydrated: true });
    assert.equal(scheduled.showStartGate, false);
    assert.equal(scheduled.canParticipate, false);

    const active = dashboardActivationGate(ACTIVE_SOLO, { hydrated: true });
    assert.equal(active.showStartGate, false);
    assert.equal(active.canParticipate, true);
    assert.equal(active.canMutateDailyStandards, true);
  });
});

describe('Solo training launch handoff', () => {
  test('requires a verified actor-bound Solo activation', () => {
    assert.throws(() => createSoloTrainingLaunch({ actorId: '', activation: ACTIVE_SOLO }), /actor/i);
    assert.throws(() => createSoloTrainingLaunch({
      actorId: 'user-1',
      activation: { ...ACTIVE_SOLO, readState: 'loading' },
    }), /verified Solo activation/i);
    assert.throws(() => createSoloTrainingLaunch({
      actorId: 'user-1',
      activation: { ...ACTIVE_SOLO, mode: 'group' },
    }), /verified Solo activation/i);

    assert.deepEqual(createSoloTrainingLaunch({
      actorId: 'user-1',
      activation: ACTIVE_SOLO,
      requestedAt: '2026-02-14T17:31:00.000Z',
    }), {
      schemaVersion: 1,
      actorId: 'user-1',
      activationRevision: 3,
      activationStatus: 'active',
      startDate: '2026-02-14',
      requestedAt: '2026-02-14T17:31:00.000Z',
      source: 'challenge_activation',
    });
  });

  test('persists separate actor requests and rejects malformed stored contracts', () => {
    const storage = new MemoryStorage();
    const launch = createSoloTrainingLaunch({
      actorId: 'user-1',
      activation: ACTIVE_SOLO,
      requestedAt: '2026-02-14T17:31:00.000Z',
    });
    assert.throws(() => persistSoloTrainingLaunch(null, launch), /Durable browser storage/i);
    persistSoloTrainingLaunch(storage, launch);
    persistSoloTrainingLaunch(storage, { ...launch, actorId: 'user-2' });

    assert.deepEqual(readSoloTrainingLaunch(storage, 'user-1'), launch);
    assert.equal(readSoloTrainingLaunch(storage, 'user-3'), null);
    const stored = JSON.parse(storage.getItem(SOLO_TRAINING_LAUNCH_STORAGE_KEY));
    stored['user-1'].schemaVersion = 2;
    storage.setItem(SOLO_TRAINING_LAUNCH_STORAGE_KEY, JSON.stringify(stored));
    assert.equal(readSoloTrainingLaunch(storage, 'user-1'), null);
    assert.equal(readSoloTrainingLaunch(storage, 'user-2')?.actorId, 'user-2');
  });

  test('publishes the same durable contract consumed by the FOU-1442 training flow', () => {
    const storage = new MemoryStorage();
    const events = [];
    class FakeCustomEvent {
      constructor(type, options) {
        this.type = type;
        this.detail = options.detail;
      }
    }
    const windowLike = {
      CustomEvent: FakeCustomEvent,
      dispatchEvent(event) { events.push(event); },
    };

    const launch = publishSoloTrainingLaunch({
      actorId: 'user-1',
      activation: ACTIVE_SOLO,
      storage,
      window: windowLike,
      requestedAt: '2026-02-14T17:31:00.000Z',
    });

    assert.equal(events.length, 1);
    assert.equal(events[0].type, SOLO_TRAINING_LAUNCH_EVENT);
    assert.deepEqual(events[0].detail, launch);
    assert.deepEqual(readSoloTrainingLaunch(storage, 'user-1'), launch);
  });

  test('matches the authoritative activation and compare-clears only the exact handoff', () => {
    const storage = new MemoryStorage();
    const launch = persistSoloTrainingLaunch(storage, createSoloTrainingLaunch({
      actorId: 'user-1',
      activation: ACTIVE_SOLO,
      requestedAt: '2026-02-14T17:31:00.000Z',
    }));
    persistSoloTrainingLaunch(storage, { ...launch, actorId: 'user-2' });

    assert.equal(soloTrainingLaunchMatchesActivation(launch, ACTIVE_SOLO, 'user-1'), true);
    assert.equal(soloTrainingLaunchMatchesActivation(launch, {
      ...ACTIVE_SOLO,
      revision: ACTIVE_SOLO.revision + 1,
    }, 'user-1'), false);
    assert.equal(compareAndClearSoloTrainingLaunch(storage, {
      ...launch,
      requestedAt: '2026-02-14T17:32:00.000Z',
    }), false);
    assert.deepEqual(readSoloTrainingLaunch(storage, 'user-1'), launch);
    assert.equal(compareAndClearSoloTrainingLaunch(storage, launch), true);
    assert.equal(readSoloTrainingLaunch(storage, 'user-1'), null);
    assert.equal(readSoloTrainingLaunch(storage, 'user-2')?.actorId, 'user-2');
  });
});
