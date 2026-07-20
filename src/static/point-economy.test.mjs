import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  LOWEST_REWARD_THRESHOLD,
  MAX_DAILY_STANDARD_POINTS,
  PERFECT_CHALLENGE_POINTS,
  POINT_SOURCE_POLICY,
  SHARING_BONUS_POINTS,
  calculateDailyStandardsPoints,
  calculateLifetimePoints,
  challengeInstancesRequired,
  validateRewardThresholds,
} from './point-economy.mjs';

const scoringMigration = readFileSync(
  new URL('../../supabase/migrations/20260719120000_seven_point_scoring.sql', import.meta.url),
  'utf8',
);

describe('seven-point economy contract', () => {
  it('caps Daily Standards at seven one-point completions', () => {
    assert.equal(calculateDailyStandardsPoints(0), 0);
    assert.equal(calculateDailyStandardsPoints(4), 4);
    assert.equal(calculateDailyStandardsPoints(7), MAX_DAILY_STANDARD_POINTS);
    assert.equal(calculateDailyStandardsPoints(20), MAX_DAILY_STANDARD_POINTS);
  });

  it('classifies sharing outside the Daily Standards cap', () => {
    const result = calculateLifetimePoints({
      completedStandards: 7,
      sharingBonusGranted: true,
    });

    assert.deepEqual(result, {
      totalPoints: 21,
      dailyStandardsPoints: 7,
      sharingBonusPoints: SHARING_BONUS_POINTS,
      adjustmentPoints: 0,
    });
    assert.equal(POINT_SOURCE_POLICY.sharing_bonus.dailyStandardsCap, false);
  });

  it('makes visits, streaks, and workout difficulty non-point signals', () => {
    for (const source of [
      'app_visit',
      'app_streak_milestone',
      'full_standard_streak_milestone',
      'workout_difficulty',
    ]) {
      assert.equal(POINT_SOURCE_POLICY[source].points, 0);
      assert.equal(POINT_SOURCE_POLICY[source].lifetime, false);
    }
  });

  it('defines a repeatable path to every current reward threshold', () => {
    assert.equal(PERFECT_CHALLENGE_POINTS, 539);
    assert.equal(challengeInstancesRequired(LOWEST_REWARD_THRESHOLD), 1);
    assert.equal(challengeInstancesRequired(1000), 2);
    assert.equal(challengeInstancesRequired(3000), 6);
    assert.equal(challengeInstancesRequired(4500), 9);
    assert.equal(challengeInstancesRequired(6000), 12);
    assert.equal(challengeInstancesRequired(10000), 19);
  });

  it('rejects active rewards cheaper than the alternate theme', () => {
    assert.equal(validateRewardThresholds([
      { key: 'alternate_dark_theme', pointsRequired: 500 },
      { key: 'reset', pointsRequired: 1000 },
    ]).valid, true);

    assert.deepEqual(validateRewardThresholds([
      { key: 'too_cheap', pointsRequired: 499 },
      { key: 'ignored_draft', pointsRequired: 10, active: false },
    ]).invalid, [{ key: 'too_cheap', pointsRequired: 499 }]);
  });

  it('preserves explicit audited adjustments without changing daily points', () => {
    assert.deepEqual(calculateLifetimePoints({
      completedStandards: 14,
      adjustmentPoints: -3,
    }), {
      totalPoints: 11,
      dailyStandardsPoints: 14,
      sharingBonusPoints: 0,
      adjustmentPoints: -3,
    });
  });

  it('preserves the deployed point-helper defaults when replacing its body', () => {
    assert.match(
      scoringMigration,
      /target_entry_date date default null,[\s\S]*target_idempotency_key text default null/,
    );
  });
});
