import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { syncWorkoutDifficultyControls } from './workout-difficulty-controls.mjs';

const radio = (workout, value) => ({
  type: 'radio',
  value,
  checked: false,
  dataset: { workout },
});

const select = (workout) => ({
  type: 'select-one',
  value: 'medium',
  dataset: { workout },
});

describe('syncWorkoutDifficultyControls', () => {
  test('hydrates dashboard radios and Today\'s Actions selects from the same state', () => {
    const dashboardControls = [
      radio('one', 'easy'),
      radio('one', 'medium'),
      radio('one', 'hard'),
      radio('one', 'extreme'),
      radio('two', 'easy'),
      radio('two', 'medium'),
      radio('two', 'hard'),
      radio('two', 'extreme'),
    ];
    const todayActionsControls = [select('one'), select('two')];

    syncWorkoutDifficultyControls(
      [...dashboardControls, ...todayActionsControls],
      { one: 'hard', two: 'extreme' },
    );

    assert.deepEqual(
      dashboardControls.filter((control) => control.checked).map((control) => control.value),
      ['hard', 'extreme'],
    );
    assert.deepEqual(
      todayActionsControls.map((control) => control.value),
      ['hard', 'extreme'],
    );

    syncWorkoutDifficultyControls(
      [...dashboardControls, ...todayActionsControls],
      { one: 'medium', two: 'easy' },
    );

    assert.deepEqual(
      dashboardControls.filter((control) => control.checked).map((control) => control.value),
      ['medium', 'easy'],
    );
    assert.deepEqual(
      todayActionsControls.map((control) => control.value),
      ['medium', 'easy'],
    );
  });
});
