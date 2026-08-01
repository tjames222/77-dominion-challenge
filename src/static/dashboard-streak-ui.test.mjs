import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const dashboardHtml = readFileSync(new URL('../../dashboard.html', import.meta.url), 'utf8');
const dashboardJs = readFileSync(new URL('./dashboard.js', import.meta.url), 'utf8');

describe('Dashboard shared streak header handoff', () => {
  test('leaves the authenticated header actions to the shared menu implementation', () => {
    assert.doesNotMatch(dashboardHtml, /topbar-trailing-actions|dashboardStreakButton|dashboardAppStreakCount/);
    assert.doesNotMatch(dashboardHtml, /data-share-kind="streak"/);
    assert.match(dashboardHtml, /<header class="topbar">\s*<a class="back-link"/);
  });

  test('retires Dashboard-local streak dialog and rendering ownership', () => {
    assert.doesNotMatch(
      dashboardJs,
      /createStreakDetailsContent|renderStreakExperience|streakDetailsDialog|dashboardStreakButton|createDialog/,
    );
    assert.match(dashboardJs, /preserveBestStreaks/);
    assert.match(dashboardJs, /event\.key === 'dominion:gameStats'/);
  });
});
