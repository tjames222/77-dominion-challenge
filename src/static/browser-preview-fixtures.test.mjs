import assert from 'node:assert/strict';
import test from 'node:test';
import { APP_STATES, fixtureFor, FIXED_USER_ID, FIXED_TODAY, FIXED_NOW } from '../../tests/e2e/support/fixtures.mjs';
import { normalizePreviewBadgeState } from './badge-preview-state.mjs';
import { normalizeChallengeActivation, refreshMockChallengeActivation } from './challenge-activation.mjs';
import { importPreviewChallengeInstances } from './preview-challenge-import.mjs';
import { previewOriginal77Progress } from './original-77-progress.mjs';

function importFixture(name) {
  const { json } = fixtureFor(name);
  const badgeState = normalizePreviewBadgeState(json['dominion:badgeState:v1'], json['dominion:badges']);
  const raw = json['dominion:mockChallengeActivation']?.[FIXED_USER_ID];
  // Match the real API's legacy read: the saved source events supply progress,
  // never the date cache or a fixture's unverified count.
  const progress = raw?.status === 'not_started' ? null
    : previewOriginal77Progress(badgeState, { userId: FIXED_USER_ID, startDate: raw?.startDate });
  const projected = raw && normalizeChallengeActivation({ ...raw, originalProgress: progress,
    canMutateDailyStandards: raw.canMutateDailyStandards === true && progress?.completionState === 'in_progress',
  }, { expectedUserId: FIXED_USER_ID, preview: true });
  const legacyActivation = projected && refreshMockChallengeActivation(projected, {
    now: new Date(FIXED_NOW), hasCheckIns: badgeState.checkIns.length > 0,
    hasEntitlement: Boolean(json['dominion:mockSubscription']?.subscriptionActive),
    groupMembershipActive: Boolean(json['dominion:mockCrewMembers']?.[raw.crewId]
      ?.some(member => member.userId === FIXED_USER_ID)),
  });
  let nextId = 1;
  return importPreviewChallengeInstances({ actorId: FIXED_USER_ID,
    legacyActivation, badgeState,
    gameStats: json['dominion:gameStats'], challengeRecords: json['dominion:mockChallengeStates'],
    ownershipRecords: json['dominion:mockRewardEntitlements'], drafts: json['dominion:entries'],
    scoredDates: [], createUuid: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`,
  });
}

test('every shared member browser fixture imports through the strict preview contract', () => {
  for (const name of Object.keys(APP_STATES).filter(name => name !== 'guest')) {
    const state = importFixture(name);
    assert.equal(state.actorId, FIXED_USER_ID, name);
    assert.equal(state.runs.some(run => run.reviewRequired), false, name);
  }
});

test('submitted fixture has one canonical source, one scored date and no invented completion', () => {
  const state = importFixture('submitted');
  assert.equal(state.runs[0].submittedCount, 1);
  assert.equal(state.checkIns.length, 1);
  assert.equal(state.checkIns[0].localDate, FIXED_TODAY);
  assert.equal(state.checkIns[0].pointsAwarded, 7);
  assert.equal(state.trustedDailyStandardPoints, 7);
  assert.deepEqual(state.scoredDates, [FIXED_TODAY]);
  assert.deepEqual(state.completionEvents, []);
});

test('acknowledged reward fixture retains explicit grants and cannot imply later completion', () => {
  const state = importFixture('memberRewardsAcknowledged');
  assert.equal(state.preservedLegacyRecords.length, 5);
  assert(state.preservedLegacyRecords.every(record => record.celebrationSeenAt));
  assert.equal(state.runs.length, 1);
  assert.equal(state.runs[0].challengeKey, 'original_77');
  assert.equal(state.runs[0].submittedCount, 0);
  assert.deepEqual(state.completionEvents, []);
});
