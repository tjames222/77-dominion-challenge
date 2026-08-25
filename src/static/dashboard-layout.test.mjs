import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const dashboardHtml = readFileSync(new URL('../../dashboard.html', import.meta.url), 'utf8');
const dashboardJs = readFileSync(new URL('./dashboard.js', import.meta.url), 'utf8');
const rewardsHtml = readFileSync(new URL('../../badges-rewards.html', import.meta.url), 'utf8');
const rewardsJs = readFileSync(new URL('./badges-rewards.js', import.meta.url), 'utf8');
const gameProgressJs = readFileSync(new URL('./game-progress.mjs', import.meta.url), 'utf8');
const productCss = readFileSync(new URL('../assets/product.css', import.meta.url), 'utf8');
const stylesCss = readFileSync(new URL('../assets/styles.css', import.meta.url), 'utf8');

describe('dashboard progress document order', () => {
  it('places tracking, countdown, and the actionable scorecard before remaining content', () => {
    const hero = dashboardHtml.indexOf('class="dashboard-hero');
    const tracking = dashboardHtml.indexOf('class="progress dashboard-section dashboard-tracking');
    const countdown = dashboardHtml.indexOf('id="countdownCard"');
    const scorecard = dashboardHtml.indexOf('class="progress dashboard-section dashboard-scorecard');
    const brandPanel = dashboardHtml.indexOf('class="dashboard-brand-panel');

    assert.ok(hero >= 0 && hero < tracking);
    assert.ok(tracking < countdown);
    assert.ok(countdown < scorecard);
    assert.ok(scorecard < brandPanel);
    assert.equal(dashboardHtml.indexOf('id="gameSummaryCard"'), -1);
  });

  it('retains one of every id after splitting tracking from the scorecard', () => {
    const ids = [...dashboardHtml.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    assert.deepEqual(duplicates, []);
    for (const id of ['trackingTitle', 'challengeRing', 'todayRing', 'daily-standards', 'checklist', 'checkInButton']) {
      assert.equal(ids.filter((candidate) => candidate === id).length, 1);
    }
  });

  it('removes requested Dashboard clutter and local Share control while retaining an accessible gauge name', () => {
    assert.doesNotMatch(dashboardHtml, /data-share-composer|data-share-kind=|Share my progress|Share the challenge/);
    assert.doesNotMatch(dashboardHtml, /How today is tracking|Challenge start date|id="startDate"/);
    assert.match(dashboardHtml, /<h2 class="sr-only" id="trackingTitle">Challenge and daily progress<\/h2>/);
    assert.match(dashboardHtml, /class="rings" role="group" aria-labelledby="trackingTitle"/);
    assert.doesNotMatch(dashboardHtml, /class="progress-intro"/);
    assert.doesNotMatch(stylesCss, /\.progress-intro/);
  });

  it('centers the progress gauges instead of reserving the removed Share column', () => {
    assert.match(
      productCss,
      /\.dashboard-tracking\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/,
    );
    assert.match(
      productCss,
      /\.dashboard-tracking \.rings\s*\{[\s\S]*?grid-column:\s*1;[\s\S]*?width:\s*min\(100%, 560px\);[\s\S]*?margin-inline:\s*auto/,
    );
  });

  it('refreshes gauge calculations when the shared streak dialog changes the start date', () => {
    assert.match(dashboardJs, /window\.addEventListener\('dominion:challenge-start-date-updated'/);
    assert.match(dashboardJs, /const nextActivation = event\.detail\?\.activation/);
    assert.match(dashboardJs, /nextActivation\?\.contractValid && nextActivation\.readState === 'ready'/);
    assert.match(dashboardJs, /challengeActivation = nextActivation/);
    assert.match(dashboardJs, /startDate = nextActivation\.startDate \|\| ''/);
    assert.doesNotMatch(dashboardJs, /event\.detail\?\.challengeStartDate \|\| startDate/);
    assert.doesNotMatch(dashboardJs, /startDateInput|updateProfile\(\{ challengeStartDate/);
  });

  it('keeps the countdown action connected to the focusable scorecard section', () => {
    assert.match(dashboardHtml, /id="countdownCheckInButton" aria-controls="check-in"/);
    assert.match(
      dashboardHtml,
      /class="progress dashboard-section dashboard-scorecard reveal" id="check-in" tabindex="-1"[^>]+aria-labelledby="todaysScorecardTitle"/,
    );
    assert.match(dashboardJs, /scorecardSection\.scrollIntoView\(\{ behavior: reducedMotionEnabled\(\) \? 'auto' : 'smooth', block: 'start' \}\)/);
    assert.match(dashboardJs, /scorecardSection\.focus\(\{ preventScroll: true \}\)/);
  });
});

describe('Rewards level and private-ranking coin integration', () => {
  it('renders the shared fourteen-point level contract after the Rewards intro controls', () => {
    const hero = rewardsHtml.indexOf('class="badges-rewards-hero');
    const tabs = rewardsHtml.indexOf('class="badges-rewards-tabs secondary-tabs"');
    const share = rewardsHtml.indexOf('class="badges-rewards-share-action"');
    const progress = rewardsHtml.indexOf('id="gameSummaryCard"');
    assert.ok(hero >= 0 && hero < tabs && tabs < share && share < progress);
    assert.match(
      gameProgressJs,
      /import \{ POINTS_PER_LEVEL, calculateLevelProgress \} from '\.\/point-economy\.mjs'/,
    );
    assert.match(gameProgressJs, /calculateLevelProgress\(totalPoints\)/);
    assert.match(gameProgressJs, /setAttribute\('aria-valuemax', String\(POINTS_PER_LEVEL\)\)/);
    assert.doesNotMatch(gameProgressJs, /const POINTS_PER_LEVEL\s*=|getLevelProgress/);
    assert.match(rewardsHtml, /id="gamePointsToNext">14 points to Level 2</);
    assert.match(rewardsHtml, /aria-valuemax="14"/);
    assert.doesNotMatch(rewardsHtml, /500 points to Level 2|aria-valuemax="500"/);
    assert.doesNotMatch(dashboardHtml, /gamePointsToNext|gameLevelEmblem/);
  });

  it('uses the private-group rank to preserve podium prestige', () => {
    assert.match(rewardsJs, /getLeaderboardPrestige\(\{/);
    assert.match(rewardsJs, /privateRank:\s*leaderboardPositions\.privateRank/);
    assert.match(gameProgressJs, /zeroPointGlass\s*\?\s*resolveLeaderboardPrestige\(\{\}\)\s*:\s*resolvedPrestige/);
    assert.match(gameProgressJs, /if \(model\.zeroPointGlass\) emblem\.dataset\.material = 'zero-glass'/);
    assert.match(gameProgressJs, /else delete emblem\.dataset\.material/);
  });

  it('defines readable glass materials for dark and light themes', () => {
    assert.match(productCss, /\.game-level-emblem\[data-material="zero-glass"\][\s\S]*?backdrop-filter: blur\(14px\)/);
    assert.match(productCss, /:root\[data-theme="light"\] \.game-level-emblem\[data-material="zero-glass"\]/);
    assert.match(productCss, /data-material="zero-glass"[\s\S]*?--coin-text:/);
  });
});
