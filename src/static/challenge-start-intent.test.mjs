import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CHALLENGE_START_INTENT_PATH,
  CHALLENGE_START_INTENT_STORAGE_KEY,
  CHALLENGE_START_INTENT_TTL_MS,
  armGroupChallengeActivation,
  bindChallengeStartIntent,
  buildChallengeStartAuthHref,
  captureChallengeStartIntent,
  clearChallengeStartIntent,
  clearChallengeStartIntentMarker,
  hasChallengeStartIntentMarker,
  isChallengeStartReturnPath,
  readChallengeStartIntent,
  reconcileGroupChallengeStart,
  setChallengeStartIntentStage,
} from './challenge-start-intent.mjs';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    values,
  };
}

const readyActivation = (overrides = {}) => ({
  contractValid: true,
  readState: 'ready',
  status: 'not_started',
  mode: null,
  crewId: null,
  groupMembershipActive: false,
  ...overrides,
});

describe('Group challenge-start continuation intent', () => {
  test('uses only the fixed marker and fixed same-origin authentication return path', () => {
    assert.equal(CHALLENGE_START_INTENT_PATH, './community.html?intent=challenge-start');
    assert.equal(hasChallengeStartIntentMarker({ search: '?intent=challenge-start' }), true);
    assert.equal(hasChallengeStartIntentMarker({ search: '?intent=solo-start' }), false);
    assert.equal(isChallengeStartReturnPath(CHALLENGE_START_INTENT_PATH), true);
    assert.equal(isChallengeStartReturnPath('./community.html?intent=challenge-start&crew=secret'), false);
    assert.equal(isChallengeStartReturnPath('https://evil.example/community.html?intent=challenge-start'), false);
    assert.equal(buildChallengeStartAuthHref('login'),
      './login.html?returnTo=.%2Fcommunity.html%3Fintent%3Dchallenge-start');
    assert.equal(buildChallengeStartAuthHref('register'),
      './register.html?returnTo=.%2Fcommunity.html%3Fintent%3Dchallenge-start');
  });

  test('capture is read-only lifecycle setup and never allocates an activation request', () => {
    const storage = memoryStorage();
    const now = Date.parse('2026-08-04T18:00:00.000Z');
    const intent = captureChallengeStartIntent(
      storage,
      { search: '?intent=challenge-start' },
      { now },
    );

    assert.equal(intent.stage, 'choose_group');
    assert.equal(intent.actorId, null);
    assert.equal(intent.crewId, null);
    assert.equal(intent.activationRequestId, null);
    assert.equal(intent.expiresAt, new Date(now + CHALLENGE_START_INTENT_TTL_MS).toISOString());
  });

  test('bind-once actor ownership survives refresh and clears on account mismatch', () => {
    const storage = memoryStorage();
    captureChallengeStartIntent(storage, { search: '?intent=challenge-start' });
    const bound = bindChallengeStartIntent(storage, 'user-one');
    assert.equal(bound.actorId, 'user-one');
    assert.equal(bindChallengeStartIntent(storage, 'user-one').actorId, 'user-one');

    assert.equal(bindChallengeStartIntent(storage, 'user-two'), null);
    assert.equal(readChallengeStartIntent(storage), null);
  });

  test('malformed and expired values fail closed and are removed', () => {
    const storage = memoryStorage();
    storage.setItem(CHALLENGE_START_INTENT_STORAGE_KEY, '{bad json');
    assert.equal(readChallengeStartIntent(storage), null);
    assert.equal(storage.getItem(CHALLENGE_START_INTENT_STORAGE_KEY), null);

    const now = Date.parse('2026-08-04T18:00:00.000Z');
    captureChallengeStartIntent(storage, { search: '?intent=challenge-start' }, { now });
    assert.equal(readChallengeStartIntent(storage, {
      now: now + CHALLENGE_START_INTENT_TTL_MS + 1,
    }), null);
    assert.equal(storage.getItem(CHALLENGE_START_INTENT_STORAGE_KEY), null);
  });

  test('a stable request is armed only after an actor-bound explicit action', () => {
    const storage = memoryStorage();
    captureChallengeStartIntent(storage, { search: '?intent=challenge-start' });
    bindChallengeStartIntent(storage, 'user-one');
    const pending = setChallengeStartIntentStage(storage, 'membership_pending', {
      activationRequestId: 'request-one',
      timeZone: 'UTC',
    });
    assert.equal(pending.stage, 'membership_pending');
    assert.equal(pending.crewId, null);

    const armed = armGroupChallengeActivation(storage, {
      actorId: 'user-one',
      crewId: 'crew-one',
      requestId: 'request-one',
      timeZone: 'UTC',
    });
    assert.deepEqual({
      stage: armed.stage,
      actorId: armed.actorId,
      crewId: armed.crewId,
      activationRequestId: armed.activationRequestId,
      timeZone: armed.timeZone,
    }, {
      stage: 'activation_pending',
      actorId: 'user-one',
      crewId: 'crew-one',
      activationRequestId: 'request-one',
      timeZone: 'UTC',
    });
    assert.equal(armGroupChallengeActivation(storage, {
      actorId: 'user-two',
      crewId: 'crew-one',
      requestId: 'request-two',
      timeZone: 'UTC',
    }), null);
    assert.equal(readChallengeStartIntent(storage).activationRequestId, 'request-one');
  });

  test('invalid stage updates do not overwrite a valid continuation', () => {
    const storage = memoryStorage();
    captureChallengeStartIntent(storage, { search: '?intent=challenge-start' });
    bindChallengeStartIntent(storage, 'user-one');
    assert.equal(setChallengeStartIntentStage(storage, 'activation_pending', {
      crewId: 'crew-one',
    }), null);
    assert.equal(readChallengeStartIntent(storage).stage, 'choose_group');
  });

  test('fresh authoritative reads converge completed, pending, conflict, and membership-loss cases', () => {
    const intent = {
      stage: 'activation_pending',
      crewId: 'crew-one',
    };
    assert.equal(reconcileGroupChallengeStart(intent, {
      activation: readyActivation(),
      crewIds: ['crew-one'],
    }), 'activation_pending');
    assert.equal(reconcileGroupChallengeStart(intent, {
      activation: readyActivation(),
      crewIds: [],
    }), 'membership_missing');
    assert.equal(reconcileGroupChallengeStart(intent, {
      activation: readyActivation({
        status: 'active', mode: 'group', crewId: 'crew-one', groupMembershipActive: true,
      }),
      crewIds: ['crew-one'],
    }), 'complete');
    assert.equal(reconcileGroupChallengeStart(intent, {
      activation: readyActivation({
        status: 'active', mode: 'group', crewId: 'crew-one', groupMembershipActive: false,
      }),
      crewIds: [],
    }), 'conflict');
    assert.equal(reconcileGroupChallengeStart(intent, {
      activation: readyActivation({ status: 'active', mode: 'solo' }),
      crewIds: ['crew-one'],
    }), 'conflict');
    assert.equal(reconcileGroupChallengeStart(intent, {
      activation: { readState: 'error', contractValid: false },
      crewIds: ['crew-one'],
    }), 'unavailable');
  });

  test('clear removes the entire session-scoped continuation', () => {
    const storage = memoryStorage();
    captureChallengeStartIntent(storage, { search: '?intent=challenge-start' });
    clearChallengeStartIntent(storage);
    assert.equal(storage.getItem(CHALLENGE_START_INTENT_STORAGE_KEY), null);
  });

  test('completion and cancellation remove the marker so refresh cannot recapture it', () => {
    const calls = [];
    const windowLike = {
      location: {
        pathname: '/nested/community.html',
        search: '?intent=challenge-start',
      },
      history: {
        state: { retained: true },
        replaceState: (...args) => calls.push(args),
      },
    };
    assert.equal(clearChallengeStartIntentMarker(windowLike), true);
    assert.deepEqual(calls, [[{ retained: true }, '', '/nested/community.html']]);
    assert.equal(clearChallengeStartIntentMarker({
      location: { pathname: '/community.html', search: '' },
    }), false);
  });
});
