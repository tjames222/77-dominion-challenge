import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { syncWorkoutDifficultyControls } from './workout-difficulty-controls.mjs';

const select = (workout) => ({
  type: 'select-one',
  value: 'medium',
  dataset: { workout },
});

describe('syncWorkoutDifficultyControls', () => {
  test('hydrates the two Dashboard workout-card selects from draft state', () => {
    const controls = [select('one'), select('two')];

    syncWorkoutDifficultyControls(controls, { one: 'hard', two: 'extreme' });
    assert.deepEqual(controls.map((control) => control.value), ['hard', 'extreme']);

    syncWorkoutDifficultyControls(controls, { one: 'medium', two: 'easy' });
    assert.deepEqual(controls.map((control) => control.value), ['medium', 'easy']);
  });
});
