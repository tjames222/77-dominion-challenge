import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const profileHtml = readFileSync(new URL('../../profile.html', import.meta.url), 'utf8');
const profileJs = readFileSync(new URL('./profile.js', import.meta.url), 'utf8');
const dashboardHtml = readFileSync(new URL('../../dashboard.html', import.meta.url), 'utf8');
const dashboardJs = readFileSync(new URL('./dashboard.js', import.meta.url), 'utf8');
const dailyStandardPageJs = readFileSync(new URL('./daily-standard-page.js', import.meta.url), 'utf8');

describe('preview challenge controls', () => {
  it('contains no Profile testing controls in production, preview, or local mode', () => {
    // The shared document and controller have no controls to reveal in any
    // environment; hiding a production-only switch is not sufficient.
    for (const source of [profileHtml, profileJs]) {
      assert.doesNotMatch(source, /profilePreview|resetPreviewChallenge|77-day test mode|Advance after every preview/i);
    }
    assert.match(profileHtml, /href="\.\/account-security\.html">Account security/);
    assert.match(profileHtml, /id="profileChallengeStatus"/);
  });

  it('has no Profile handler, importer, or storage writer for simulated testing state', () => {
    assert.doesNotMatch(profileJs, /preview-challenge\.mjs|preview-user-state\.mjs/);
    assert.doesNotMatch(profileJs, /PREVIEW_CHALLENGE|PREVIEW_USER_STATE|previewChallenge|setPreviewChallengeEnabled|writePreviewUserValue/);
    assert.doesNotMatch(profileJs, /dominion:previewChallengeSimulation|dominion:previewCheckInDates/);
    assert.match(profileJs, /captureProfileOwner/);
    assert.match(profileJs, /hydrateThemeEntitlementState/);
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
    const celebrationStart = dashboardJs.indexOf("if (status === 'complete') launchConfetti();");
    const celebrationEnd = dashboardJs.indexOf('  } catch (error) {', celebrationStart);
    const celebrationBlock = dashboardJs.slice(celebrationStart, celebrationEnd);

    assert.ok(celebrationStart >= 0 && celebrationEnd > celebrationStart);
    assert.doesNotMatch(celebrationBlock, /simulatedPreviewPost|suppressCelebration/);
    assert.match(celebrationBlock, /status === 'complete'\) launchConfetti\(\)/);
    assert.match(celebrationBlock, /queueCheckInCelebrations\(/);
    assert.match(celebrationBlock, /queuePermanentRewardAndChallengeCelebrations\(submissionOwner\)/);
    assert.match(dashboardJs, /item\.kind === 'reward'\) return showRewardToast\(item\.reward\)/);
    assert.match(dashboardJs, /item\.kind === 'badge'[\s\S]*?const controller = showBadgeCelebration\(item\.badge\)/);
    assert.match(dashboardJs, /acknowledgeBadgeCelebrations/);
    assert.match(dashboardJs, /queueChallengeUnlockCelebration\(result\.claimedUnlocks, owner\)/);
    assert.match(dashboardJs, /claimChallengeUnlocks\(\{ expectedUserId: owner\.userId \}\)/);
  });
});
