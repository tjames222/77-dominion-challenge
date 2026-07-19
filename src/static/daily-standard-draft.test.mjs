import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyActionMutation,
  applyWorkoutDifficultyMutation,
  normalizeDailyStandardDraft,
} from './daily-standard-draft.mjs';

describe('atomic Daily Standard drafts', () => {
  it('merges independent action mutations without replacing unrelated actions', () => {
    const firstTab = applyActionMutation({ completed: ['bible'], version: 1 }, 'walk', true);
    const serverAfterSecondTab = applyActionMutation(firstTab, 'morningPrayer', true);
    const reconciledFirstTab = applyActionMutation(serverAfterSecondTab, 'walk', true);

    assert.deepEqual(new Set(reconciledFirstTab.completed), new Set(['bible', 'walk', 'morningPrayer']));
    assert.equal(reconciledFirstTab.version, 4);
  });

  it('makes retries idempotent at the action-state level', () => {
    const once = applyActionMutation({ completed: [], version: 1 }, 'bible', true);
    const retried = applyActionMutation(once, 'bible', true);
    assert.deepEqual(retried.completed, ['bible']);
  });

  it('keeps workout difficulty date-draft context separate from points', () => {
    const draft = applyWorkoutDifficultyMutation({ completed: ['workoutOne'] }, 'one', 'extreme');
    assert.deepEqual(draft.workoutDifficulty, { one: 'extreme', two: 'medium' });
    assert.deepEqual(draft.completed, ['workoutOne']);
  });

  it('normalizes trusted payload names and rejects edits after submission', () => {
    const draft = normalizeDailyStandardDraft({
      entry_date: '2026-07-19',
      workout_difficulty: { one: 'hard' },
      submitted: true,
    });
    assert.equal(draft.date, '2026-07-19');
    assert.equal(draft.workoutDifficulty.one, 'hard');
    assert.throws(() => applyActionMutation(draft, 'walk', true), /locked/);
  });

  it('drops unknown action IDs and rejects invalid mutations', () => {
    assert.deepEqual(normalizeDailyStandardDraft({ completed: ['bible', 'unknown'] }).completed, ['bible']);
    assert.throws(() => applyActionMutation({}, 'unknown', true), /valid Daily Standard/);
    assert.throws(() => applyWorkoutDifficultyMutation({}, 'one', 'impossible'), /valid workout difficulty/);
  });
});
