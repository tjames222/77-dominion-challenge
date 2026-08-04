import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

const read = (relativePath) => readFile(new URL(relativePath, import.meta.url), 'utf8');

describe('authenticated mutation owner binding', () => {
  test('binds every Daily Standard, check-in, bootstrap, and visit write to the verified actor', async () => {
    const api = await read('./api.js');
    const draftApi = api.slice(
      api.indexOf('const bootstrapDailyStandardTimeZone'),
      api.indexOf('export async function getCommunityFeed'),
    );
    const visitApi = api.slice(
      api.indexOf('export async function recordAppVisit'),
      api.indexOf('export async function getGameSummary'),
    );

    assert.match(draftApi, /bootstrap_daily_standard_time_zone'[\s\S]*target_expected_actor_id: userId/);
    assert.match(draftApi, /const user = await requireUser\(expectedUserId\)/);
    assert.match(draftApi, /mutation[\s\S]*target_expected_actor_id: user\.id/);
    assert.match(draftApi, /getDailyStandardDraft\(entryDate, \{ expectedUserId = '' \} = \{\}\)/);
    assert.match(draftApi, /mutateDailyStandardDraft\([\s\S]*expectedUserId = ''[\s\S]*mutation: true/);
    assert.match(draftApi, /setDailyStandardWorkoutDifficulty\([\s\S]*expectedUserId = ''[\s\S]*mutation: true/);
    assert.match(draftApi, /postCheckIn\(checkIn, \{ expectedUserId = '' \} = \{\}\)[\s\S]*target_expected_actor_id: user\.id/);
    assert.match(visitApi, /recordAppVisit\(\{ expectedUserId = '' \} = \{\}\)[\s\S]*requireUser\(expectedUserId\)[\s\S]*target_expected_actor_id: user\.id/);

    const readCall = draftApi.slice(
      draftApi.indexOf('export async function getDailyStandardDraft'),
      draftApi.indexOf('export async function mutateDailyStandardDraft'),
    );
    assert.doesNotMatch(readCall, /mutation: true|target_expected_actor_id/);
  });

  test('Dashboard and action pages invalidate stale owners and pass captured IDs to every write', async () => {
    const [dashboard, actionPage, header] = await Promise.all([
      read('./dashboard.js'),
      read('./daily-standard-page.js'),
      read('./shared-header-actions.js'),
    ]);

    for (const source of [dashboard, actionPage]) {
      assert.match(source, /let observedAuthOwner = ''/);
      assert.match(source, /let hydratedAuthOwner = ''/);
      assert.match(source, /let authOwnerEpoch = 0/);
      assert.match(source, /subscribeToAuthStateChanges/);
      assert.match(source, /expectedUserId: owner\.userId/);
      assert.match(source, /isCurrentMutationOwner\(owner\)/);
    }
    assert.match(dashboard, /postCheckIn\([\s\S]*expectedUserId: submissionOwner\.userId/);
    assert.match(dashboard, /recordAppVisit\(\{ expectedUserId: owner\.userId \}\)/);
    assert.match(actionPage, /getDailyStandardDraft\(nextDate, \{ expectedUserId: dashboardOwner \}\)/);
    assert.match(header, /recordAppVisit\(\{ expectedUserId \}\)/);
  });

  test('scopes preview check-in locks and Dashboard activation mirrors to the hydrated account', async () => {
    const [dashboard, actionPage] = await Promise.all([
      read('./dashboard.js'),
      read('./daily-standard-page.js'),
    ]);

    const submittedReader = actionPage.slice(
      actionPage.indexOf('function localDateWasSubmitted'),
      actionPage.indexOf('function readLocalDraft'),
    );
    assert.match(submittedReader, /PREVIEW_CHECK_IN_DATES_STORAGE_KEY/);
    assert.match(submittedReader, /readPreviewUserValue\(localStorage, user\.userId, storageKey, \{\}\)/);
    assert.match(submittedReader, /migrateMockCheckInCache\(stored, user\.userId, user\.email\)/);
    assert.match(submittedReader, /writePreviewUserValue\(localStorage, user\.userId, storageKey, cache\)/);
    assert.doesNotMatch(dashboard, /save\('dominion:startDate'/);
    assert.match(dashboard, /if \(hasSupabaseAuth\(\) \|\| localDemoMode\) void hydrateDashboardFromApi\(observedAuthOwner\)/);
    assert.match(dashboard, /!previewChallengeMode\(\) && challengeActivation\.status === 'not_started'/);
    assert.match(dashboard, /checkInCacheOwner = mockCheckInOwnerForUser\(dashboardOwner\)/);
  });

  test('carries a valid legacy Solo date forward only when its legacy ID is adopted', async () => {
    const api = await read('./api.js');
    const continuity = api.slice(
      api.indexOf('const preserveAdoptedMockLegacyActivation'),
      api.indexOf('const getMockUserId'),
    );
    assert.match(continuity, /resolution\?\.adoptedLegacy/);
    assert.match(continuity, /isSupportedChallengeActivationDate\(readJson\('dominion:startDate', ''\)\)/);
    assert.match(continuity, /MOCK_CHALLENGE_ACTIVATION_LEGACY_OWNER_KEY[\s\S]*resolution\.userId/);
    assert.equal((api.match(/preserveAdoptedMockLegacyActivation\(resolution\)/g) || []).length, 2);
  });

  test('does not let a logged-out public preview claim account-scoped billing state', async () => {
    const api = await read('./api.js');
    const billing = api.slice(
      api.indexOf('const getMockBillingState'),
      api.indexOf('const todayLabel'),
    );
    assert.match(billing, /const user = readJson\('dominion:user', null\)/);
    assert.match(billing, /const subscription = user\?\.authenticated \? getMockSubscription\(\) : null/);
  });
});
