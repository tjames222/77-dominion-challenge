import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const profileHtml = readFileSync(new URL('../../profile.html', import.meta.url), 'utf8');
const profileJs = readFileSync(new URL('./profile.js', import.meta.url), 'utf8');
const dashboardHtml = readFileSync(new URL('../../dashboard.html', import.meta.url), 'utf8');
const dashboardJs = readFileSync(new URL('./dashboard.js', import.meta.url), 'utf8');
const dailyStandardPageJs = readFileSync(new URL('./daily-standard-page.js', import.meta.url), 'utf8');

describe('preview challenge controls', () => {
  it('keeps the Profile switch hidden by default and gates it on local preview mode', () => {
    assert.match(profileHtml, /id=["']profilePreviewTools["'][^>]*hidden/);
    assert.match(profileHtml, /id=["']profilePreviewChallengeSwitch["'][^>]*role=["']switch["']/);
    assert.match(profileJs, /profilePreviewTools\.hidden = !localPreviewMode/);
  });

  it('shares simulated action state across the Dashboard and dedicated Daily Standard pages', () => {
    assert.match(dashboardHtml, /src=["']\.\/src\/static\/dashboard\.js["']/);
    assert.match(dashboardJs, /isPreviewChallengeActive\(localDemoMode, previewChallengeState\)/);
    assert.match(dailyStandardPageJs, /isPreviewChallengeActive\(localDemoMode, preview\)/);
    assert.match(dailyStandardPageJs, /previewChallengeDate\(preview\)/);
    assert.match(dailyStandardPageJs, /dominion:entries/);
  });

  it('starts each simulated challenge day with a fresh production-style scorecard', () => {
    const advanceStart = dashboardJs.indexOf('function advanceCommittedPreviewPost');
    const advanceEnd = dashboardJs.indexOf('function renderChecklist', advanceStart);
    const advanceBlock = dashboardJs.slice(advanceStart, advanceEnd);

    assert.ok(advanceStart >= 0 && advanceEnd > advanceStart);
    assert.doesNotMatch(advanceBlock, /saveEntry|completed:\s*\[\.\.\.entry\.completed\]/);
  });

  it('uses the full production celebration pipeline after preview check-ins', () => {
    const celebrationStart = dashboardJs.indexOf('const confettiDuration =');
    const celebrationEnd = dashboardJs.indexOf('  } catch (error) {', celebrationStart);
    const celebrationBlock = dashboardJs.slice(celebrationStart, celebrationEnd);

    assert.ok(celebrationStart >= 0 && celebrationEnd > celebrationStart);
    assert.doesNotMatch(celebrationBlock, /simulatedPreviewPost|suppressCelebration/);
    assert.match(celebrationBlock, /status === 'complete' \? launchConfetti\(\)/);
    assert.match(celebrationBlock, /showRewardToast\(/);
    assert.match(celebrationBlock, /queueBadgeCelebrations\(/);
    assert.match(celebrationBlock, /refreshChallengeProgression\(/);
    assert.match(dashboardJs, /queueChallengeUnlockCelebration\(result\.claimedUnlocks, celebrationDelay\)/);
  });
});
