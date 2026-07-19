import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ACTION_POINTS_PER_COMPLETION,
  DIFFICULTY_OPTIONS,
  calculateCheckInScore,
  normalizeWorkoutDifficulty,
} from './scoring.mjs';

const allActions = [
  'bible',
  'morningPrayer',
  'worshipOnly',
  'eveningPrayer',
  'workoutOne',
  'walk',
  'workoutTwo',
];

describe('workout difficulty context', () => {
  test('normalizes difficulty without assigning point values', () => {
    assert.equal(ACTION_POINTS_PER_COMPLETION, 1);
    assert.deepEqual(DIFFICULTY_OPTIONS, ['easy', 'medium', 'hard', 'extreme']);
    assert.deepEqual(normalizeWorkoutDifficulty(), { one: 'medium', two: 'medium' });
    assert.deepEqual(
      normalizeWorkoutDifficulty({ one: 'unknown', two: 'hard' }),
      { one: 'medium', two: 'hard' },
    );
  });
});

describe('calculateCheckInScore', () => {
  test('awards exactly one point for every distinct completed action', () => {
    allActions.forEach((_, index) => {
      assert.equal(calculateCheckInScore({ completed: allActions.slice(0, index + 1) }).totalPoints, index + 1);
    });
  });

  test('caps a full Daily Standards day at seven points', () => {
    assert.deepEqual(calculateCheckInScore({ completed: allActions }), {
      totalPoints: 7,
      workoutPoints: 0,
      actionPoints: 7,
      bonusPoints: 0,
    });
    assert.equal(calculateCheckInScore({ completed: [...allActions, 'extra'] }).totalPoints, 7);
  });

  test('ignores status, workout difficulty, and former point modifiers', () => {
    const expected = {
      totalPoints: 2,
      workoutPoints: 0,
      actionPoints: 2,
      bonusPoints: 0,
    };
    for (const difficulty of DIFFICULTY_OPTIONS) {
      assert.deepEqual(calculateCheckInScore({
        completed: ['workoutOne', 'bible'],
        status: 'complete',
        workoutDifficulty: { one: difficulty, two: difficulty },
        difficultyPointValues: { easy: 100, medium: 100, hard: 100, extreme: 100 },
      }), expected);
    }
  });

  test('deduplicates stale action IDs and awards zero for invalid input', () => {
    assert.equal(calculateCheckInScore({ completed: ['bible', 'bible'] }).totalPoints, 1);
    assert.equal(calculateCheckInScore({ completed: ['not-a-standard'] }).totalPoints, 0);
    assert.equal(calculateCheckInScore({ completed: null }).totalPoints, 0);
  });
});
