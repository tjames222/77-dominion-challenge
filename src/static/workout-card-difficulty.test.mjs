import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

describe('workout-card difficulty controls', () => {
  it('removes the standalone intensity panel and renders independent card controls', async () => {
    const [dashboardHtml, dashboardSource, styles] = await Promise.all([
      read('../../dashboard.html'),
      read('./dashboard.js'),
      read('../assets/styles.css'),
    ]);

    assert.doesNotMatch(dashboardHtml, /scorecard-training-panel|Workout intensity|difficulty-options/);
    assert.match(dashboardSource, /class="check-row-difficulty"/);
    assert.match(dashboardSource, /data-workout="\$\{route\.workoutId\}"/);
    assert.match(dashboardSource, /Context only · still \+1/);
    assert.match(styles, /\.check-row-difficulty\s*\{/);
  });

  it('uses delegated events so dynamically rendered selects stay synchronized', async () => {
    const dashboardSource = await read('./dashboard.js');
    assert.match(dashboardSource, /document\.addEventListener\('change',[\s\S]+closest\?\.\('\[data-workout\]'\)/);
    assert.match(dashboardSource, /setDailyStandardWorkoutDifficulty/);
    assert.doesNotMatch(dashboardSource, /difficulty bonus|difficultyPointValues/i);
  });
});
