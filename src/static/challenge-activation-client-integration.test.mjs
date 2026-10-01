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
      (activationApi.match(/return normalizeChallengeActivationMutation\((?:data|activation), \{ expectedUserId: capturedActorId \}\);/g) || []).length,
      3,
    );
    assert.equal((activationApi.match(/const activation = await getChallengeActivation\(\{ expectedUserId: capturedActorId \}\);/g) || []).length, 2);
    assert.match(activationApi, /set_challenge_start_date_v2'[\s\S]*target_expected_instance_id: expectedInstanceId/);
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
    assert.equal((activationApi.match(/return withPreviewAggregate\(userId, aggregate => \{/g) || []).length, 3);
    assert.equal((activationApi.match(/activatePreviewInitial\(aggregate\.runtime,/g) || []).length, 2);
    assert.equal((activationApi.match(/aggregate\.runtime = result\.state;\s*return previewActivationFor\(aggregate\);/g) || []).length, 3);
    assert.match(activationApi, /requireCapturedChallengeInstance\(expectedInstanceId\)/);
    assert.match(activationApi, /updatePreviewChallengeStartDate\(aggregate\.runtime, \{ actorId: userId, instanceId: expectedInstanceId,[\s\S]*requestId, startDate, timeZone, expectedRevision/);
    assert.match(activationApi, /data\?\.schemaVersion !== 2 \|\| data\.currentInstance\?\.id !== expectedInstanceId/);
    assert.equal(
      (activationApi.match(/if \(userId !== capturedActorId\)/g) || []).length,
      3,
    );
    assert.match(api, /if \(!actorId\) \{[\s\S]*captured signed-in account is required/);
    assert.doesNotMatch(activationApi, /return normalizeChallengeActivation\(data\);/);
    assert.match(api, /function previewActivationFor\(aggregate\)[\s\S]*normalizeChallengeActivationMutation\(raw, \{ expectedUserId: aggregate\.actorId, preview: true \}\)/);
    const transaction = api.slice(api.indexOf('async function withPreviewAggregate'), api.indexOf('const getMockSubscription'));
    assert.match(transaction, /getPreviewBadgeBoundary\(\)\.run\(actorId,/);
    assert.match(transaction, /assertPreviewDeliveryOwner\(owner\);[\s\S]*let aggregate = readPreviewAggregate\(actorId\)/);
    assert.match(transaction, /assertPreviewDeliveryOwner\(owner\);\s*if \(previousState !== JSON\.stringify\(aggregate\)\) \{[\s\S]*localStorage\.setItem\(`\$\{PREVIEW_AGGREGATE_PREFIX\}\$\{actorId\}`, JSON\.stringify\(aggregate\)\)/);
  });

  test('rehydrates a Daily Standard after activation events and mutation authorization failures', async () => {
    const page = await read('./daily-standard-page.js');

    assert.match(page, /window\.addEventListener\('dominion:challenge-start-date-updated', refreshAfterChallengeActivationEvent\)/);
    assert.match(page, /function refreshAfterChallengeActivationEvent\(event\)[\s\S]*interactiveReady = false;[\s\S]*void hydrate\(\)/);
    assert.match(page, /if \(saving\) \{[\s\S]*activationRefreshPending = true;[\s\S]*return;/);
    assert.equal((page.match(/activationRefreshPending = true;[\s\S]*?getDailyStandardDraft\(entryDate,/g) || []).length, 2);
    const hydration = page.slice(page.indexOf('async function hydrate('), page.indexOf('function invalidateDailyStandardOwner'));
    assert.match(hydration, /if \(hasSupabaseAuth\(\) \|\| localDemoMode\) \{\s*const snapshot = await getDailyActionBootstrap\(\{ expectedUserId: requestedOwner, timeZone: browserTimeZone \}\)/);
    assert.match(hydration, /snapshotOwner = snapshot\.actorId;\s*if \(requestId !== hydrationRequestId \|\| observedAuthOwner !== snapshotOwner\) return/);
    assert.match(hydration, /nextActivation = snapshot\.activation;\s*nextDate = snapshot\.entryDate;\s*nextDraft = snapshot\.draft/);
    assert.match(hydration, /hydratedAuthOwner = snapshotOwner;\s*challengeActivation = nextActivation/);
    assert.doesNotMatch(hydration, /getChallengeActivation\(|readLocalDraft\(/);
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
    const hydration = dashboard.slice(dashboard.indexOf('async function hydrateDashboardFromApi('), dashboard.indexOf('async function handleDashboardAuthOwnerChange('));
    assert.match(hydration, /if \(!hasSupabaseAuth\(\) && !localDemoMode\) return/);
    assert.match(hydration, /const dashboard = await getDashboard\(\);\s*if \(requestId !== dashboardHydrationRequestId\) return/);
    assert.match(hydration, /requestedOwner !== dashboardOwner[\s\S]*observedAuthOwner !== dashboardOwner\)\) return/);
    assert.match(hydration, /challengeActivation = dashboard\?\.activation \|\| createChallengeActivationState\('error'\)/);
    assert.doesNotMatch(hydration, /getChallengeActivation\(/);
    assert.doesNotMatch(dashboard, /let challengeActivation = localDemoMode[\s\S]*canMutateDailyStandards: true/);
  });

  test('uses the persisted mock lifecycle in the shared header and keeps stale recovery busy', async () => {
    const header = await read('./shared-header-actions.js');
    const presentation = await read('./app-streak-dialog.mjs');
    const saveFlow = header.slice(
      header.indexOf('async function saveStartDate(value)'),
      header.indexOf("streakButton.addEventListener('click'"),
    );

    assert.match(header, /const expectedUserId = currentUser\?\.userId \|\| '';[\s\S]*getChallengeActivation\(\{ expectedUserId \}\),[\s\S]*getGameSummary\(\),[\s\S]*localHeaderSnapshot\([\s\S]*activation,[\s\S]*summary\?\.gameStats/);
    assert.match(header, /function localHeaderSnapshot\(user, storage, activation, stats\)/);
    assert.match(header, /activation: effectiveActivation/);
    assert.doesNotMatch(header, /migrateMockCheckInCache|PREVIEW_CHECK_IN_DATES_STORAGE_KEY|writePreviewUserValue/);
    assert.match(saveFlow, /await refresh\(\{ includeLockState: true \}\)/);
    assert.doesNotMatch(saveFlow, /void refresh\(\{ includeLockState: true \}\)/);
    assert.match(saveFlow, /const submitTimeZone = currentActivation\?\.timeZone \|\| ''/);
    assert.match(saveFlow, /timeZone: submitTimeZone/);
    assert.match(saveFlow, /expectedUserId: submitOwnerKey/);
    assert.doesNotMatch(saveFlow, /resolvedOptions\(\)\.timeZone/);
    assert.match(presentation, /dateInput\.disabled = true/);
    assert.match(presentation, /saveButton\.disabled = true/);
  });

  test('stores exact mock request replays and rejects request reuse before another mutation', async () => {
    const api = await read('./api.js');
    const runtime = await read('./preview-challenge-instances.mjs');
    const validator = runtime.slice(runtime.indexOf('function validateActivationArgs'), runtime.indexOf('function stateWithRun'));
    assert.match(validator, /const prior = state\.requests\.find\(request => request\.requestId === args\.requestId\)/);
    assert.match(validator, /prior\.action !== action \|\| prior\.signature !== signature/);
    assert.match(validator, /return \{ signature, prior \}/);
    assert.match(validator, /args\.expectedRevision !== state\.revision/);
    assert.match(runtime, /function activationMutationResult[\s\S]*instanceId !== state\.currentInstanceId[\s\S]*PREVIEW_INSTANCE_CHANGED/);
    assert.match(runtime, /const state = stateForActor\(input, args\.actorId\);\s*const checked = validateActivationArgs[\s\S]*if \(checked\.prior\) return activationMutationResult\(state, checked\.prior\.instanceId, true, args\)/);
    const activationApi = api.slice(api.indexOf('export async function activateSoloChallenge'), api.indexOf('export async function updateChallengeStartDate'));
    assert.equal((activationApi.match(/const prior = aggregate\.runtime\.requests\.find\(row => row\.requestId === requestId\)/g) || []).length, 2);
    assert.equal((activationApi.match(/instanceId: prior\?\.instanceId \|\| crypto\.randomUUID\(\)/g) || []).length, 2);
    assert.equal((activationApi.match(/expectedRevision: prior \? prior\.revision - 1 : aggregate\.runtime\.revision/g) || []).length, 2);
    assert.doesNotMatch(activationApi, /runMockActivationRequest\(|writeMockChallengeActivation\(/);

    const groupActivation = api.slice(
      api.indexOf('export async function activateGroupChallenge'),
      api.indexOf('export async function updateChallengeStartDate'),
    );
    const transactionIndex = groupActivation.indexOf('return withPreviewAggregate(userId, aggregate => {');
    const crewLookupIndex = groupActivation.indexOf('const { crews, members } = ensureMockCrews()');
    const mutationIndex = groupActivation.indexOf('activatePreviewInitial(aggregate.runtime,');
    assert.ok(transactionIndex >= 0);
    assert.ok(crewLookupIndex > transactionIndex);
    assert.ok(mutationIndex > crewLookupIndex);
    assert.match(groupActivation, /member\.userId === userId[\s\S]*if \(!membershipActive\)[\s\S]*groupMembershipActive: membershipActive/);
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
    const [activation, headerPresentation, dailyStandard, dashboard] = await Promise.all([
      read('./challenge-activation.mjs'),
      read('./app-streak-dialog.mjs'),
      read('./daily-standard-page.js'),
      read('./dashboard.js'),
    ]);

    assert.match(activation, /const closed = challengeActivationReadError\(INVALID_CONTRACT_READ_ERROR\)/);
    assert.match(headerPresentation, /currentActivation\?\.readState === 'error'/);
    assert.match(dailyStandard, /challengeActivation\.readState === 'error'/);
    assert.match(dashboard, /challengeActivation\.readState === 'error'/);
  });
});
