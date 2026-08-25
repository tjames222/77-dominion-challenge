import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

const [dashboardHtml, dashboardSource, flowSource, headerSource, menuSource, productStyles] = await Promise.all([
  readFile(new URL('../../dashboard.html', import.meta.url), 'utf8'),
  readFile(new URL('./dashboard.js', import.meta.url), 'utf8'),
  readFile(new URL('./challenge-start-flow.js', import.meta.url), 'utf8'),
  readFile(new URL('./shared-header-actions.js', import.meta.url), 'utf8'),
  readFile(new URL('./menu.js', import.meta.url), 'utf8'),
  readFile(new URL('../assets/product.css', import.meta.url), 'utf8'),
]);

describe('Dashboard challenge start integration', () => {
  test('ships one branded, disabled-by-default start gate and neutral progress state', () => {
    assert.match(dashboardHtml, /id="challengeStartGate"[\s\S]*hidden/);
    assert.match(dashboardHtml, /id="startChallengeButton"[\s\S]*aria-controls="challengeStartDialog"[\s\S]*disabled/);
    assert.match(dashboardHtml, /id="retryChallengeActivationButton"[^>]*hidden disabled/);
    assert.match(dashboardHtml, /id="challengePercent">—</);
    assert.match(dashboardHtml, /id="countdownCheckInButton"[^>]*disabled/);
    assert.match(dashboardHtml, /id="selectAllActionsButton"[^>]*disabled/);
    assert.match(productStyles, /\.challenge-start-gate\s*\{/);
    assert.match(productStyles, /\.challenge-start-flow/);
  });

  test('renders every pre-start mutation and detail path closed until participation is authoritative', () => {
    assert.match(dashboardSource, /class="check-row-toggle"[\s\S]*type="button" disabled/);
    assert.match(dashboardSource, /class="check-row-details" data-enabled-href=/);
    assert.match(dashboardSource, /aria-disabled="true" aria-describedby="checkInStatus" tabindex="-1"/);
    assert.match(dashboardSource, /const navigationLocked = !canParticipateInChallenge\(\) \|\| draftBusy/);
    assert.match(dashboardSource, /if \(!canParticipateInChallenge\(\) \|\| !link\.hasAttribute\('href'\)\)/);
    assert.match(dashboardSource, /if \(!canMutateChallenge\(\) \|\| isChallengeFinished\(\)/);
    assert.match(dashboardSource, /const participationOpen = canParticipateInChallenge\(\)/);
    assert.match(dashboardSource, /participationOpen[\s\S]*\{ \.\.\.storedEntry, completed: \[\] \}/);
    assert.match(headerSource, /activation\?\.canParticipate === true/);
    assert.match(headerSource, /shareButton\.disabled = !shareAvailable/);
  });

  test('binds Solo confirmation to the captured actor and refreshes authoritative state', () => {
    assert.match(flowSource, /activateSoloChallenge\(\{[\s\S]*startDate: state\.startDate,[\s\S]*timeZone: state\.timeZone,[\s\S]*requestId: state\.requestId,[\s\S]*expectedUserId: owner\.userId/);
    assert.match(flowSource, /getChallengeActivation\(\{ expectedUserId: owner\.userId \}\)/);
    assert.match(flowSource, /compatibleSoloActivation\(fresh, state\)/);
    assert.match(flowSource, /publishSoloTrainingLaunch\(\{[\s\S]*actorId: owner\.userId/);
    assert.match(flowSource, /storage: windowLike\.localStorage/);
    assert.match(dashboardSource, /dominion:challenge-activation-updated/);
    assert.match(menuSource, /dominion:challenge-activation-updated/);
    const finish = flowSource.slice(
      flowSource.indexOf('async function finishSoloActivation'),
      flowSource.indexOf('async function submitSoloActivation'),
    );
    const releaseIndex = finish.indexOf("dialog.close('activated')");
    const publishIndex = finish.indexOf('publishSoloTrainingLaunch({');
    assert.ok(releaseIndex >= 0);
    assert.ok(publishIndex > releaseIndex);
  });

  test('hands Group choice to the canonical Community intent without mutating Group state', () => {
    assert.match(flowSource, /buildGroupChallengeStartHref\(\)/);
    assert.match(flowSource, /windowLike\.location\.href = destination/);
    assert.doesNotMatch(flowSource, /activateGroupChallenge|createCrew|joinCrew|challengeStartDate=/);
  });
});
