import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

describe('workout-card difficulty controls', () => {
  it('removes the standalone intensity panel and renders independent card controls', async () => {
    const [dashboardHtml, dashboardSource, styles, productStyles] = await Promise.all([
      read('../../dashboard.html'),
      read('./dashboard.js'),
      read('../assets/styles.css'),
      read('../assets/product.css'),
    ]);

    assert.doesNotMatch(dashboardHtml, /scorecard-training-panel|Workout intensity|difficulty-options/);
    assert.match(dashboardSource, /class="check-row-difficulty"/);
    assert.match(dashboardSource, /data-workout="\$\{route\.workoutId\}"/);
    assert.match(dashboardSource, /class="sr-only"[^>]*>\$\{escapeHtml\(label\)\} difficulty<\/span>/);
    assert.match(dashboardSource, /<option value="" disabled>Difficulty<\/option>/);
    assert.doesNotMatch(dashboardSource, /Context only · still \+1|<span>Difficulty <small/);
    assert.match(styles, /\.check-row-difficulty\s*\{/);
    assert.match(productStyles, /\.dashboard-scorecard \.check-row-difficulty\s*\{[\s\S]*?border-top:\s*0/);
  });

  it('uses delegated events so dynamically rendered selects stay synchronized', async () => {
    const dashboardSource = await read('./dashboard.js');
    assert.match(dashboardSource, /document\.addEventListener\('change',[\s\S]+closest\?\.\('\[data-workout\]'\)/);
    assert.match(dashboardSource, /if \(!DIFFICULTY_OPTIONS\.includes\(target\.value\)\)/);
    assert.match(dashboardSource, /syncWorkoutDifficultyControls\(difficultyControls, selectedWorkoutDifficulty\)/);
    assert.match(dashboardSource, /save\(WORKOUT_DIFFICULTY_STORAGE_KEY, selectedWorkoutDifficulty\)/);
    assert.doesNotMatch(dashboardSource, /save\(WORKOUT_DIFFICULTY_STORAGE_KEY, workoutDifficulty\)/);
    assert.match(dashboardSource, /currentDraft\.workoutDifficultySelections/);
    assert.match(dashboardSource, /setDailyStandardWorkoutDifficulty/);
    assert.doesNotMatch(dashboardSource, /difficulty bonus|difficultyPointValues/i);
  });
});
