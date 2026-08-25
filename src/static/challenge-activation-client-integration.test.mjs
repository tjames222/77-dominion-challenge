import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

const read = (relativePath) => readFile(new URL(relativePath, import.meta.url), 'utf8');

describe('challenge activation client integration', () => {
  test('requires a valid lifecycle contract from every mutation RPC before reporting success', async () => {
    const api = await read('./api.js');
    const activationApi = api.slice(
      api.indexOf('export async function activateSoloChallenge'),
      api.indexOf('const bootstrapDailyStandardTimeZone'),
    );

    assert.equal(
      (activationApi.match(/return normalizeChallengeActivationMutation\(data\);/g) || []).length,
      3,
    );
    assert.equal((activationApi.match(/expectedUserId,/g) || []).length, 3);
    assert.equal(
      (activationApi.match(/requireCapturedActivationActor\(expectedUserId\)/g) || []).length,
      3,
    );
    assert.equal(
      (activationApi.match(/const user = await requireUser\(capturedActorId\);/g) || []).length,
      3,
    );
    assert.equal(
      (activationApi.match(/target_expected_actor_id: user\.id/g) || []).length,
      3,
    );
    assert.equal(
      (activationApi.match(/requestId = newChallengeActivationRequestId\(\)/g) || []).length,
      3,
    );
    for (const action of ['solo_activate', 'group_activate']) {
      assert.match(activationApi, new RegExp(`action: '${action}'`));
    }
    assert.equal(
      (activationApi.match(/if \(userId !== capturedActorId\)/g) || []).length,
      3,
    );
    assert.match(api, /if \(!actorId\) \{[\s\S]*captured signed-in account is required/);
    assert.doesNotMatch(activationApi, /return normalizeChallengeActivation\(data\);/);
    assert.match(api, /const normalized = normalizeChallengeActivationMutation\(activation\);[\s\S]*const userId = getMockUserId\(\);[\s\S]*states\[userId\] = normalized/);
  });

  test('rehydrates a Daily Standard after activation events and mutation authorization failures', async () => {
    const page = await read('./daily-standard-page.js');

    assert.match(page, /window\.addEventListener\('dominion:challenge-start-date-updated', refreshAfterChallengeActivationEvent\)/);
    assert.match(page, /function refreshAfterChallengeActivationEvent\(event\)[\s\S]*interactiveReady = false;[\s\S]*void hydrate\(\)/);
    assert.match(page, /if \(saving\) \{[\s\S]*activationRefreshPending = true;[\s\S]*return;/);
    assert.equal((page.match(/activationRefreshPending = true;[\s\S]*?getDailyStandardDraft\(entryDate,/g) || []).length, 2);
    assert.match(page, /const activation = await getChallengeActivation\(\{ expectedUserId: dashboardOwner \}\);[\s\S]*readLocalDraft\([\s\S]*activation,/);
  });

  test('applies an event timezone before resetting and rehydrating Dashboard date state', async () => {
    const dashboard = await read('./dashboard.js');
    const eventHandler = dashboard.slice(
      dashboard.indexOf("window.addEventListener('dominion:challenge-start-date-updated'"),
      dashboard.indexOf('if (selectAllActionsButton)', dashboard.indexOf("window.addEventListener('dominion:challenge-start-date-updated'")),
    );

    assert.match(eventHandler, /userTimeZone = nextActivation\.timeZone \|\| BROWSER_TIME_ZONE/);
    assert.match(eventHandler, /renderedDateKey = todayKey\(\)/);
    assert.match(eventHandler, /checkInStatusHydratedDate = hasSupabaseAuth\(\) \? '' : renderedDateKey/);
    assert.match(eventHandler, /void hydrateDashboardFromApi\(\)/);
    assert.match(dashboard, /if \(localDemoMode\) \{[\s\S]*const activation = await getChallengeActivation\(\{ expectedUserId: dashboardOwner \}\)/);
    assert.doesNotMatch(dashboard, /let challengeActivation = localDemoMode[\s\S]*canMutateDailyStandards: true/);
  });

  test('uses the persisted mock lifecycle in the shared header and keeps stale recovery busy', async () => {
    const header = await read('./shared-header-actions.js');
    const saveFlow = header.slice(
      header.indexOf("content.querySelector('[data-global-streak-start-date-form]')"),
      header.indexOf("dateInput.addEventListener('input'"),
    );

    assert.match(header, /const activation = await getChallengeActivation\(\{ expectedUserId: currentUser\?\.userId \}\);[\s\S]*localHeaderSnapshot\([\s\S]*activation/);
    assert.match(header, /function localHeaderSnapshot\(user, storage, activation\)/);
    assert.match(header, /activation: effectiveActivation/);
    assert.match(saveFlow, /await refresh\(\{ includeLockState: true \}\)/);
    assert.doesNotMatch(saveFlow, /void refresh\(\{ includeLockState: true \}\)/);
    assert.match(saveFlow, /const submitTimeZone = currentActivation\?\.timeZone \|\| ''/);
    assert.match(saveFlow, /timeZone: submitTimeZone/);
    assert.match(saveFlow, /expectedUserId: submitOwnerKey/);
    assert.doesNotMatch(saveFlow, /resolvedOptions\(\)\.timeZone/);
    assert.match(header, /input\.disabled = true/);
    assert.match(header, /saveButton\.disabled = true/);
  });

  test('stores exact mock request replays and rejects request reuse before another mutation', async () => {
    const api = await read('./api.js');
    const requestRunner = api.slice(
      api.indexOf('function runMockActivationRequest'),
      api.indexOf('function readMockChallengeActivation'),
    );

    assert.match(requestRunner, /const prior = requests\[requestId\]/);
    assert.match(requestRunner, /storedRequests && typeof storedRequests === 'object' && !Array\.isArray\(storedRequests\)/);
    assert.match(requestRunner, /prior\.signature !== signature/);
    assert.match(requestRunner, /return normalizeChallengeActivationMutation\(prior\.result\)/);
    assert.match(requestRunner, /requests\[requestId\] = \{ actorId, action, signature, result \}/);
    assert.match(api, /expectedRevision,[\s\S]*buildMockChallengeActivation\(\{[\s\S]*expectedRevision/);

    const groupActivation = api.slice(
      api.indexOf('export async function activateGroupChallenge'),
      api.indexOf('export async function updateChallengeStartDate'),
    );
    const requestRunnerIndex = groupActivation.indexOf('return runMockActivationRequest');
    const mutateIndex = groupActivation.indexOf('mutate: () => {');
    const crewLookupIndex = groupActivation.indexOf('const { crews, members } = ensureMockCrews()');
    assert.ok(requestRunnerIndex >= 0);
    assert.ok(mutateIndex > requestRunnerIndex);
    assert.ok(crewLookupIndex > mutateIndex);
  });

  test('claims a legacy mock date only for an evidenced owner and locks out later accounts', async () => {
    const api = await read('./api.js');
    const claim = api.slice(
      api.indexOf('function claimMockLegacyChallengeActivation'),
      api.indexOf('function mockGroupMembershipIsActive'),
    );
    const reader = api.slice(
      api.indexOf('function readMockChallengeActivation'),
      api.indexOf('function writeMockChallengeActivation'),
    );
    const writer = api.slice(
      api.indexOf('function writeMockChallengeActivation'),
      api.indexOf('export async function getChallengeActivation'),
    );

    assert.doesNotMatch(reader, /activationStorageExisted/);
    assert.doesNotMatch(reader, /setItem\(MOCK_CHALLENGE_ACTIVATION_LEGACY_OWNER_KEY/);
    assert.match(reader, /storedStates && typeof storedStates === 'object' && !Array\.isArray\(storedStates\)/);
    assert.match(reader, /claimMockLegacyChallengeActivation\(\{ userId, hasEntitlement \}\)[\s\S]*createMockNotStartedChallengeActivation\(\)/);
    assert.match(reader, /states\[userId\] = initial/);
    assert.match(claim, /claimPreviewLegacyOwner\(localStorage, userId\)/);
    assert.match(claim, /readMockUserValue\('dominion:checkInDates', \{\}, userId\)/);
    assert.match(claim, /migrateMockCheckInCache\(checkIns, userId, getMockUser\(\)\.email\)/);
    assert.match(claim, /mockOwnedCheckInCache\(migratedCheckIns, userId\)/);
    assert.match(claim, /mockPersistedCrewMembershipExists\(userId\)/);
    assert.match(claim, /if \(!claimedOwnerId && !hasCheckInOwnerEvidence && !hasCrewOwnerEvidence\) return null/);
    assert.match(claim, /writeMockUserValue\('dominion:checkInDates', migratedCheckIns, userId\)/);
    assert.match(claim, /buildMockLegacyChallengeActivation[\s\S]*MOCK_CHALLENGE_ACTIVATION_LEGACY_OWNER_KEY, userId/);
    assert.match(api, /function mockOwnedCheckInCache\(stored, userId = getMockUserId\(\)\)[\s\S]*migrateMockCheckInCache\(stored, userId, getMockUser\(\)\.email\)/);
    assert.match(writer, /legacyOwnerId === userId[\s\S]*writeJson\('dominion:startDate', normalized\.startDate\)/);
    assert.doesNotMatch(writer, /setItem\(MOCK_CHALLENGE_ACTIVATION_LEGACY_OWNER_KEY/);
  });

  test('turns malformed lifecycle reads into recoverable consumer error states', async () => {
    const [activation, header, dailyStandard, dashboard] = await Promise.all([
      read('./challenge-activation.mjs'),
      read('./shared-header-actions.js'),
      read('./daily-standard-page.js'),
      read('./dashboard.js'),
    ]);

    assert.match(activation, /const closed = challengeActivationReadError\(INVALID_CONTRACT_READ_ERROR\)/);
    assert.match(header, /currentActivation\?\.readState === 'error'/);
    assert.match(dailyStandard, /challengeActivation\.readState === 'error'/);
    assert.match(dashboard, /challengeActivation\.readState === 'error'/);
  });
});
