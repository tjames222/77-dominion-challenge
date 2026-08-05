import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const dashboardHtml = readFileSync(new URL('../../dashboard.html', import.meta.url), 'utf8');
const dashboardJs = readFileSync(new URL('./dashboard.js', import.meta.url), 'utf8');
const productCss = readFileSync(new URL('../assets/product.css', import.meta.url), 'utf8');

describe('dashboard document order', () => {
  it('places tracking, countdown, and the actionable scorecard directly after the hero', () => {
    const hero = dashboardHtml.indexOf('class="dashboard-hero');
    const tracking = dashboardHtml.indexOf('class="progress dashboard-section dashboard-tracking');
    const countdown = dashboardHtml.indexOf('id="countdownCard"');
    const scorecard = dashboardHtml.indexOf('id="check-in"');
    const progressCard = dashboardHtml.indexOf('id="gameSummaryCard"');

    assert.ok(hero >= 0 && hero < tracking);
    assert.ok(tracking < countdown);
    assert.ok(countdown < scorecard);
    assert.ok(scorecard < progressCard);
  });

  it('retains one of every id after splitting tracking from the scorecard', () => {
    const ids = [...dashboardHtml.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    assert.deepEqual(duplicates, []);
  });

  it('keeps the countdown action connected to the scorecard anchor', () => {
    assert.match(dashboardHtml, /id="countdownCheckInButton" aria-controls="check-in"/);
    assert.match(dashboardHtml, /id="check-in" tabindex="-1" aria-labelledby="todaysScorecardTitle"/);
  });

  it('uses the private crew placement for the zero-point glass state', () => {
    assert.match(dashboardJs, /prestigeRank:\s*leaderboardPositions\.privateRank/);
    assert.match(dashboardJs, /zeroPointGlass\s*\?\s*resolveLeaderboardPrestige\(\{\}\)\s*:\s*resolvedPrestige/);
  });

  it('dismisses celebrations through one event-driven queue without a delayed badge path', () => {
    assert.match(dashboardHtml, /data-dismiss-celebration/);
    assert.match(dashboardJs, /event\.target\.closest\('\.badge-medal'\)/);
    assert.match(dashboardJs, /celebrationSequence\.dismissCurrent\('backdrop'\)/);
    assert.match(dashboardJs, /queueCheckInCelebrations\([\s\S]+enqueueCelebrationItems\(items\)/);
    assert.doesNotMatch(dashboardJs, /function\s+queueBadgeCelebrations/);
  });

  it('themes the entire animated badge treatment for bronze, silver, and gold', () => {
    for (const tier of ['bronze', 'silver', 'gold']) {
      assert.match(productCss, new RegExp(`\\.badge-celebration\\[data-tier="${tier}"\\]`));
    }
    assert.match(dashboardJs, /stage\.dataset\.tier\s*=\s*tier/);
    assert.match(productCss, /var\(--celebration-(?:accent|strong|light|mid|dark)\)/);
  });
});
