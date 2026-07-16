import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  acknowledgeChallengeRecord,
  buildChallengeProgression,
  normalizeChallengeProgression,
  transitionChallengeRecord,
} from './challenge-progression.mjs';

const definitions = [
  { key: 'reset', title: 'Reset', pointsRequired: 500, sortOrder: 1 },
  { key: 'fast', title: 'Fast', pointsRequired: 1500, sortOrder: 2 },
];
const timestamp = '2026-07-16T00:00:00.000Z';

describe('challenge point progression', () => {
  it('shows locked challenges and the next configurable threshold', () => {
    const result = buildChallengeProgression({ definitions, totalPoints: 250, now: timestamp });

    assert.equal(result.challenges[0].status, 'locked');
    assert.equal(result.challenges[0].pointsRemaining, 250);
    assert.equal(result.nextUnlock.key, 'reset');
    assert.equal(result.nextUnlock.progressPercent, 50);
  });

  it('unlocks each eligible challenge once at its configured threshold', () => {
    const first = buildChallengeProgression({ definitions, totalPoints: 500, now: timestamp });
    const second = buildChallengeProgression({
      definitions,
      records: first.records,
      totalPoints: 500,
      now: '2026-07-17T00:00:00.000Z',
    });

    assert.deepEqual(first.newlyUnlocked.map((challenge) => challenge.key), ['reset']);
    assert.equal(first.records.length, 1);
    assert.equal(second.records.length, 1);
    assert.equal(second.newlyUnlocked.length, 0);
    assert.equal(second.challenges[0].unlockedAt, timestamp);
  });

  it('stays locked one point below a threshold and unlocks at the exact threshold', () => {
    const below = buildChallengeProgression({ definitions, totalPoints: 499, now: timestamp });
    const exact = buildChallengeProgression({ definitions, totalPoints: 500, now: timestamp });

    assert.equal(below.challenges[0].status, 'locked');
    assert.equal(below.challenges[0].pointsRemaining, 1);
    assert.equal(below.challenges[0].progressPercent, 99.8);
    assert.equal(below.newlyUnlocked.length, 0);
    assert.equal(exact.challenges[0].status, 'available');
    assert.equal(exact.challenges[0].pointsRemaining, 0);
    assert.deepEqual(exact.newlyUnlocked.map((challenge) => challenge.key), ['reset']);
  });

  it('unlocks multiple crossed thresholds in one trusted sync', () => {
    const result = buildChallengeProgression({ definitions, totalPoints: 2000, now: timestamp });

    assert.deepEqual(result.newlyUnlocked.map((challenge) => challenge.key), ['reset', 'fast']);
    assert.equal(result.nextUnlock, null);
  });

  it('preserves an unlock when points or thresholds are later adjusted', () => {
    const unlocked = buildChallengeProgression({ definitions, totalPoints: 500, now: timestamp });
    const adjustedDefinitions = [{ ...definitions[0], pointsRequired: 900 }, definitions[1]];
    const result = buildChallengeProgression({
      definitions: adjustedDefinitions,
      records: unlocked.records,
      totalPoints: 100,
    });

    assert.equal(result.challenges[0].status, 'available');
    assert.equal(result.challenges[0].pointsRemaining, 0);
    assert.equal(result.challenges[0].unlockPoints, 500);
  });

  it('responds to configuration changes without changing progression code', () => {
    const result = buildChallengeProgression({
      definitions: [{ ...definitions[0], pointsRequired: 200 }],
      totalPoints: 250,
      now: timestamp,
    });

    assert.equal(result.challenges[0].status, 'available');
    assert.equal(result.newlyUnlocked[0].key, 'reset');
  });

  it('keeps celebrations unseen until they are acknowledged', () => {
    const unlocked = buildChallengeProgression({ definitions, totalPoints: 500, now: timestamp });
    const acknowledged = acknowledgeChallengeRecord(unlocked.records[0], '2026-07-16T01:00:00.000Z');
    const result = buildChallengeProgression({ definitions, records: [acknowledged], totalPoints: 500 });

    assert.equal(unlocked.unseenUnlocks.length, 1);
    assert.equal(result.unseenUnlocks.length, 0);
    assert.deepEqual(
      acknowledgeChallengeRecord(acknowledged, '2026-07-18T00:00:00.000Z'),
      acknowledged,
    );
  });

  it('keeps inaccessible and inactive definitions out of unlock eligibility', () => {
    const result = buildChallengeProgression({
      definitions: [
        { ...definitions[0], accessGranted: false, accessReason: 'Membership required' },
        { ...definitions[1], active: false },
      ],
      totalPoints: 2000,
      now: timestamp,
    });

    assert.equal(result.challenges.length, 1);
    assert.equal(result.challenges[0].status, 'locked');
    assert.equal(result.challenges[0].accessGranted, false);
    assert.equal(result.nextUnlock, null);
    assert.equal(result.records.length, 0);
  });

  it('normalizes invalid points and trusted snake_case payloads without client promotion', () => {
    const invalid = buildChallengeProgression({ definitions, totalPoints: -40 });
    const trusted = normalizeChallengeProgression({
      total_points: 800,
      challenges: [{
        challenge_key: 'server_locked',
        title: 'Server Locked',
        points_required: 500,
        duration_days: 7,
        access_granted: true,
        status: 'locked',
      }],
    });

    assert.equal(invalid.totalPoints, 0);
    assert.equal(invalid.newlyUnlocked.length, 0);
    assert.equal(trusted.challenges[0].key, 'server_locked');
    assert.equal(trusted.challenges[0].status, 'locked');
    assert.equal(trusted.challenges[0].durationDays, 7);
    assert.equal(trusted.records.length, 0);
  });

  it('preserves authoritative access, permanent unlock, and claimed celebration fields', () => {
    const claimedAt = '2026-07-16T03:00:00.000Z';
    const trusted = normalizeChallengeProgression({
      total_points: 250,
      challenges: [
        {
          challenge_key: 'server_locked',
          title: 'Server Locked',
          points_required: 100,
          entitlement_key: null,
          canAccess: true,
          status: 'locked',
        },
        {
          challenge_key: 'earned_before_adjustment',
          title: 'Earned Before Adjustment',
          points_required: 900,
          entitlement_key: 'membership_active',
          canAccess: false,
          accessReason: 'Renew membership to start this challenge.',
          status: 'available',
          unlock_points: 500,
          unlocked_at: timestamp,
          celebration_seen_at: claimedAt,
        },
      ],
    });
    const locked = trusted.challenges.find((challenge) => challenge.key === 'server_locked');
    const earned = trusted.challenges.find((challenge) => challenge.key === 'earned_before_adjustment');

    assert.equal(locked.status, 'locked', 'the client must not promote an authoritative locked row');
    assert.equal(locked.entitlementKey, null, 'future public tracks can explicitly omit an entitlement');
    assert.equal(earned.status, 'available', 'a persisted unlock survives later point/threshold changes');
    assert.equal(earned.unlockPoints, 500);
    assert.equal(earned.unlockedAt, timestamp);
    assert.equal(earned.accessGranted, false);
    assert.equal(earned.accessReason, 'Renew membership to start this challenge.');
    assert.equal(earned.entitlementKey, 'membership_active');
    assert.equal(earned.celebrationSeenAt, claimedAt);
    assert.deepEqual(trusted.unseenUnlocks, [], 'an atomically claimed unlock must not celebrate again');
    assert.equal(trusted.nextUnlock.key, 'server_locked');
  });

  it('allows only available-to-active-to-completed state transitions', () => {
    const unlocked = buildChallengeProgression({ definitions, totalPoints: 500, now: timestamp }).records[0];
    const active = transitionChallengeRecord(unlocked, 'active', '2026-07-16T01:00:00.000Z');
    const completed = transitionChallengeRecord(active, 'completed', '2026-07-16T02:00:00.000Z');

    assert.equal(active.status, 'active');
    assert.equal(completed.status, 'completed');
    assert.throws(() => transitionChallengeRecord(unlocked, 'completed'), /cannot move/);
    assert.throws(() => transitionChallengeRecord(completed, 'active'), /cannot move/);
  });
});
