import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  DEFAULT_DIFFICULTY_POINT_VALUES,
  DIFFICULTY_OPTIONS,
  calculateCheckInScore,
  normalizeDifficultyPointValues,
  normalizeWorkoutDifficulty,
} from './scoring.mjs';

const nonWorkoutActions = [
  'bible',
  'morningPrayer',
  'worshipOnly',
  'eveningPrayer',
  'walk',
];

const allActions = [
  ...nonWorkoutActions.slice(0, 4),
  'workoutOne',
  'walk',
  'workoutTwo',
];

describe('workout scoring configuration', () => {
  test('preserves the default difficulty values', () => {
    assert.deepEqual(DEFAULT_DIFFICULTY_POINT_VALUES, {
      easy: 2,
      medium: 5,
      hard: 10,
      extreme: 15,
    });
    assert.deepEqual(DIFFICULTY_OPTIONS, ['easy', 'medium', 'hard', 'extreme']);
  });

  test('normalizes missing and invalid selections to medium', () => {
    assert.deepEqual(normalizeWorkoutDifficulty(), { one: 'medium', two: 'medium' });
    assert.deepEqual(
      normalizeWorkoutDifficulty({ one: 'unknown', two: 'hard' }),
      { one: 'medium', two: 'hard' },
    );
  });

  test('accepts valid point overrides and rejects invalid values', () => {
    assert.deepEqual(
      normalizeDifficultyPointValues({ easy: 7, medium: -1, hard: 12.5, extreme: 20 }),
      { easy: 7, medium: 5, hard: 10, extreme: 20 },
    );
  });
});

describe('calculateCheckInScore', () => {
  test('scales a completed workout with each difficulty', () => {
    const expectedTotals = {
      easy: 22,
      medium: 25,
      hard: 30,
      extreme: 35,
    };

    Object.entries(expectedTotals).forEach(([difficulty, expected]) => {
      assert.deepEqual(calculateCheckInScore({
        completed: ['workoutOne'],
        status: 'partial',
        workoutDifficulty: { one: difficulty, two: 'medium' },
      }), {
        totalPoints: expected,
        workoutPoints: DEFAULT_DIFFICULTY_POINT_VALUES[difficulty],
        actionPoints: 10,
        bonusPoints: 10,
      });
    });
  });

  test('adds the two workout difficulty values independently', () => {
    assert.deepEqual(calculateCheckInScore({
      completed: ['workoutOne', 'workoutTwo'],
      status: 'partial',
      workoutDifficulty: { one: 'easy', two: 'hard' },
    }), {
      totalPoints: 42,
      workoutPoints: 12,
      actionPoints: 20,
      bonusPoints: 10,
    });
  });

  test('calculates complete-day totals for matching and mixed difficulties', () => {
    assert.equal(calculateCheckInScore({
      completed: allActions,
      status: 'complete',
      workoutDifficulty: { one: 'medium', two: 'medium' },
    }).totalPoints, 110);

    assert.deepEqual(calculateCheckInScore({
      completed: allActions,
      status: 'complete',
      workoutDifficulty: { one: 'easy', two: 'extreme' },
    }), {
      totalPoints: 117,
      workoutPoints: 17,
      actionPoints: 70,
      bonusPoints: 30,
    });
  });

  test('preserves non-workout action scoring across difficulty selections', () => {
    for (const difficulty of DIFFICULTY_OPTIONS) {
      assert.deepEqual(calculateCheckInScore({
        completed: nonWorkoutActions,
        status: 'partial',
        workoutDifficulty: { one: difficulty, two: difficulty },
      }), {
        totalPoints: 60,
        workoutPoints: 0,
        actionPoints: 50,
        bonusPoints: 10,
      });
    }
  });

  test('preserves scheduled-miss scoring across difficulty selections', () => {
    assert.deepEqual(calculateCheckInScore({
      completed: [],
      status: 'scheduled',
      workoutDifficulty: { one: 'extreme', two: 'extreme' },
    }), {
      totalPoints: 15,
      workoutPoints: 0,
      actionPoints: 0,
      bonusPoints: 15,
    });
  });

  test('does not award difficulty points for an uncompleted workout', () => {
    assert.deepEqual(calculateCheckInScore({
      completed: ['bible'],
      status: 'partial',
      workoutDifficulty: { one: 'extreme', two: 'extreme' },
    }), {
      totalPoints: 20,
      workoutPoints: 0,
      actionPoints: 10,
      bonusPoints: 10,
    });
  });

  test('uses injected difficulty values without changing calculation logic', () => {
    const rebalancedPoints = { easy: 4, medium: 8, hard: 12, extreme: 20 };

    assert.deepEqual(calculateCheckInScore({
      completed: ['workoutOne'],
      status: 'partial',
      workoutDifficulty: { one: 'easy', two: 'medium' },
      difficultyPointValues: rebalancedPoints,
    }), {
      totalPoints: 24,
      workoutPoints: 4,
      actionPoints: 10,
      bonusPoints: 10,
    });

    assert.deepEqual(calculateCheckInScore({
      completed: allActions,
      status: 'complete',
      workoutDifficulty: { one: 'hard', two: 'extreme' },
      difficultyPointValues: rebalancedPoints,
    }), {
      totalPoints: 132,
      workoutPoints: 32,
      actionPoints: 70,
      bonusPoints: 30,
    });
  });
});
