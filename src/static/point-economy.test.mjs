import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  LOWEST_REWARD_THRESHOLD,
  MAX_DAILY_STANDARD_POINTS,
  PERFECT_CHALLENGE_POINTS,
  POINTS_PER_LEVEL,
  POINT_SOURCE_POLICY,
  REWARD_POINT_THRESHOLDS,
  SHARING_BONUS_POINTS,
  calculateDailyStandardsPoints,
  calculateLevelProgress,
  calculateLifetimePoints,
  challengeInstancesRequired,
  validateRewardThresholds,
} from './point-economy.mjs';

const scoringMigration = readFileSync(
  new URL('../../supabase/migrations/20260719120000_seven_point_scoring.sql', import.meta.url),
  'utf8',
);

const simulateEarningPath = ({ dailyPoints, sharingBonusDay = null }) => {
  let totalPoints = 0;
  let eligibleDailyStandardPoints = 0;
  const rewardDays = {};

  for (let day = 1; day <= 77; day += 1) {
    const completedStandards = typeof dailyPoints === 'function'
      ? dailyPoints(day)
      : dailyPoints;
    const earnedDailyStandardPoints = calculateDailyStandardsPoints(completedStandards);
    eligibleDailyStandardPoints += earnedDailyStandardPoints;
    totalPoints += earnedDailyStandardPoints;
    if (day === sharingBonusDay) totalPoints += SHARING_BONUS_POINTS;

    Object.entries(REWARD_POINT_THRESHOLDS).forEach(([key, threshold]) => {
      const eligiblePoints = key === 'gym_training_discount'
        ? eligibleDailyStandardPoints
        : totalPoints;
      if (rewardDays[key] === undefined && eligiblePoints >= threshold) rewardDays[key] = day;
    });
  }

  return {
    totalPoints,
    level: calculateLevelProgress(totalPoints).level,
    rewardDays,
  };
};

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

  it('levels independently every fourteen lifetime points', () => {
    assert.deepEqual(calculateLevelProgress(0), {
      totalPoints: 0,
      level: 1,
      nextLevel: 2,
      pointsIntoLevel: 0,
      pointsToNext: POINTS_PER_LEVEL,
      progressPercent: 0,
    });
    assert.equal(calculateLevelProgress(13).level, 1);
    assert.equal(calculateLevelProgress(13).pointsToNext, 1);
    assert.equal(calculateLevelProgress(14).level, 2);
    assert.equal(calculateLevelProgress(55).level, 4);
    assert.equal(calculateLevelProgress(56).level, 5);
  });

  it('keeps every launch reward reachable in the first challenge without coupling rewards to levels', () => {
    assert.equal(PERFECT_CHALLENGE_POINTS, 539);
    assert.equal(challengeInstancesRequired(LOWEST_REWARD_THRESHOLD), 1);
    Object.values(REWARD_POINT_THRESHOLDS).forEach((threshold) => {
      assert.equal(challengeInstancesRequired(threshold), 1);
    });
    assert.ok(
      calculateLevelProgress(REWARD_POINT_THRESHOLDS.big_god_energy_tshirt_discount).level
        > Object.keys(REWARD_POINT_THRESHOLDS).length,
    );
  });

  it('keeps every reward boundary point-gated and strictly ordered', () => {
    const thresholds = Object.values(REWARD_POINT_THRESHOLDS);

    thresholds.forEach((threshold, index) => {
      const below = thresholds.filter((candidate) => candidate <= threshold - 1);
      const at = thresholds.filter((candidate) => candidate <= threshold);
      const above = thresholds.filter((candidate) => candidate <= threshold + 1);

      assert.equal(below.length, index);
      assert.equal(at.length, index + 1);
      assert.equal(above.length, index + 1);
    });
    assert.deepEqual(thresholds, [42, 112, 210, 308, 420, 532]);
  });

  it('requires active rewards to meet the floor and remain strictly ordered', () => {
    assert.equal(validateRewardThresholds([
      { key: 'gym_training_discount', pointsRequired: 42 },
      { key: 'dominion_night_theme', pointsRequired: 112 },
    ]).valid, true);

    assert.deepEqual(validateRewardThresholds([
      { key: 'too_cheap', pointsRequired: 41 },
      { key: 'ordered', pointsRequired: 56 },
      { key: 'out_of_order', pointsRequired: 55 },
      { key: 'ignored_draft', pointsRequired: 10, active: false },
    ]).invalid, [
      { key: 'too_cheap', pointsRequired: 41 },
      { key: 'out_of_order', pointsRequired: 55 },
    ]);
  });

  it('paces early wins and the reward catalog across seventy-seven days', () => {
    const thresholds = Object.values(REWARD_POINT_THRESHOLDS);
    const perfectWithSharingAtDaySeven = 7 * MAX_DAILY_STANDARD_POINTS + SHARING_BONUS_POINTS;
    const rewardsByDaySeven = thresholds.filter((threshold) => threshold <= perfectWithSharingAtDaySeven);

    assert.equal(rewardsByDaySeven.length, 1);
    assert.equal(Math.ceil(LOWEST_REWARD_THRESHOLD / MAX_DAILY_STANDARD_POINTS), 6);
    assert.equal(Math.ceil(LOWEST_REWARD_THRESHOLD / 4), 11);
    assert.equal(Math.ceil(REWARD_POINT_THRESHOLDS.big_god_energy_tshirt_discount / MAX_DAILY_STANDARD_POINTS), 76);
  });

  it('simulates perfect participation with and without Sharing across all 77 days', () => {
    const perfect = simulateEarningPath({ dailyPoints: 7 });
    const perfectWithSharing = simulateEarningPath({ dailyPoints: 7, sharingBonusDay: 1 });

    assert.equal(perfect.totalPoints, 539);
    assert.equal(perfect.level, 39);
    assert.deepEqual(Object.values(perfect.rewardDays), [6, 16, 30, 44, 60, 76]);
    assert.equal(perfectWithSharing.totalPoints, 553);
    assert.equal(perfectWithSharing.level, 40);
    assert.deepEqual(Object.values(perfectWithSharing.rewardDays), [6, 14, 28, 42, 58, 74]);
    assert.equal(
      Object.values(perfectWithSharing.rewardDays).filter((day) => day <= 7).length,
      1,
    );
  });

  it('simulates consistent partial participation with and without Sharing', () => {
    const partial = simulateEarningPath({ dailyPoints: 4 });
    const partialWithSharing = simulateEarningPath({ dailyPoints: 4, sharingBonusDay: 1 });

    assert.equal(partial.totalPoints, 308);
    assert.deepEqual(Object.values(partial.rewardDays), [11, 28, 53, 77]);
    assert.equal(partialWithSharing.totalPoints, 322);
    assert.deepEqual(Object.values(partialWithSharing.rewardDays), [11, 25, 49, 74]);
  });

  it('simulates irregular participation without awarding points for missed days', () => {
    const weeklyPattern = [7, 0, 4, 0, 2, 6, 0];
    const irregular = simulateEarningPath({
      dailyPoints: (day) => weeklyPattern[(day - 1) % weeklyPattern.length],
    });
    const sharingOnly = simulateEarningPath({ dailyPoints: 0, sharingBonusDay: 1 });

    assert.equal(irregular.totalPoints, 209);
    assert.equal(irregular.level, 15);
    assert.deepEqual(Object.keys(irregular.rewardDays), [
      'gym_training_discount',
      'dominion_night_theme',
    ]);
    assert.equal(sharingOnly.totalPoints, SHARING_BONUS_POINTS);
    assert.equal(sharingOnly.level, 2);
    assert.deepEqual(sharingOnly.rewardDays, {});
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
