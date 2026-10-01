import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  DEFAULT_OWNERSHIP_REWARD_DEFINITIONS,
  DOMINION_NIGHT_THEME_REWARD,
  GYM_TRAINING_DISCOUNT_REWARD,
  backfillMockRewardEntitlements,
  buildMockRewardCatalog,
  claimMockRewardEntitlementUnlocks,
  challengeProgressionToRewardCatalog,
  normalizeReward,
  normalizeRewardCatalog,
} from './reward-catalog.mjs';

const api = readFileSync(new URL('./api.js', import.meta.url), 'utf8');

describe('typed reward catalog', () => {
  it('keeps challenge lifecycle states and actions explicit', () => {
    const reward = normalizeReward({
      key: 'seven_day_reset',
      rewardType: 'challenge',
      stateModel: 'challenge_lifecycle',
      status: 'available',
      pointsRequired: 1000,
      currentPoints: 1200,
      pointsRemaining: 0,
      progressPercent: 100,
      allowedActions: ['start', 'start'],
    });

    assert.equal(reward.status, 'available');
    assert.equal(reward.stateModel, 'challenge_lifecycle');
    assert.deepEqual(reward.allowedActions, ['start']);
    assert.equal(reward.pointsRemaining, 0);
  });

  it('models cosmetics as locked or permanently owned without a Start action', () => {
    const locked = normalizeReward({
      key: 'theme_reward',
      rewardType: 'cosmetic',
      stateModel: 'ownership',
      status: 'locked',
      pointsRequired: 500,
      currentPoints: 499,
      allowedActions: ['start'],
    });
    const owned = normalizeReward({ ...locked, status: 'owned', ownedAt: '2026-07-20T00:00:00Z' });

    assert.equal(locked.pointsRemaining, 1);
    assert.equal(locked.progressPercent, 99.8);
    assert.deepEqual(locked.allowedActions, []);
    assert.equal(owned.pointsRemaining, 0);
    assert.equal(owned.progressPercent, 100);
    assert.equal(owned.ownedAt, '2026-07-20T00:00:00Z');
  });

  it('preserves catalog versioning, pagination, and next-unlock identity', () => {
    const catalog = normalizeRewardCatalog({
      schemaVersion: 1,
      catalogVersion: 7,
      totalPoints: 250,
      items: [{
        key: 'reset',
        rewardType: 'challenge',
        stateModel: 'challenge_lifecycle',
        status: 'locked',
        pointsRequired: 1000,
        currentPoints: 250,
      }],
      nextUnlock: { key: 'reset' },
      page: {
        limit: 1,
        totalItems: 5,
        hasMore: true,
        nextCursor: { sortOrder: 10, key: 'reset' },
      },
    });

    assert.equal(catalog.catalogVersion, 7);
    assert.equal(catalog.nextUnlock, catalog.items[0]);
    assert.deepEqual(catalog.page.nextCursor, { sortOrder: 10, key: 'reset' });
  });

  it('adapts the existing Challenge Vault data without changing its state', () => {
    const catalog = challengeProgressionToRewardCatalog({
      totalPoints: 1200,
      challenges: [{
        key: 'reset',
        title: 'Reset',
        teaser: 'Rebuild your habits.',
        type: 'reset',
        pointsRequired: 1000,
        durationDays: 7,
        status: 'active',
        startedAt: '2026-07-20T00:00:00Z',
        pointsRemaining: 0,
        progressPercent: 100,
      }],
      nextUnlock: null,
    });

    assert.equal(catalog.items[0].rewardType, 'challenge');
    assert.equal(catalog.items[0].status, 'active');
    assert.equal(catalog.items[0].startedAt, '2026-07-20T00:00:00Z');
    assert.equal(catalog.items[0].metadata.durationDays, 7);
  });

  it('never invents a Start action from a legacy unlock and requires V2 Start authority', () => {
    const catalog = challengeProgressionToRewardCatalog({ totalPoints: 140, challenges: [{ key: 'seven_day_reset',
      status: 'available', pointsRequired: 140, accessGranted: true, unlockedAt: '2026-01-01T00:00:00Z' }] });
    assert.equal(catalog.items[0].status, 'available'); assert.equal(catalog.items[0].unlockedAt, '2026-01-01T00:00:00Z');
    assert.deepEqual(catalog.items[0].allowedActions, []);
    const start = api.slice(api.indexOf('export async function startChallenge'), api.indexOf('export async function getDashboard'));
    assert.match(start, /start_challenge_instance_v2/);
    assert.match(start, /target_expected_instance_id: expectedInstanceId/);
    assert.match(start, /target_expected_revision: expectedRevision/);
    assert.doesNotMatch(start, /transitionChallengeRecord|writeMockUserValue/);
  });

  it('uses the current-user RPC and passes only the stable pagination cursor', () => {
    const getRewardCatalog = api.match(
      /export async function getRewardCatalog\([^]*?\n\}/,
    )?.[0] || '';
    assert.match(getRewardCatalog, /client\.rpc\('get_reward_catalog_v2'/);
    assert.match(getRewardCatalog, /target_expected_snapshot_version: expectedSnapshotVersion/);
    assert.match(getRewardCatalog, /target_after_sort_order: cursor\?\.sortOrder \?\? null/);
    assert.match(getRewardCatalog, /target_after_reward_key: cursor\?\.key \|\| null/);
    assert.doesNotMatch(getRewardCatalog, /target_user_id/);
  });

  it('uses stable Dominion Night reward and fulfillment identities', () => {
    assert.equal(DOMINION_NIGHT_THEME_REWARD.key, 'dominion_night_theme');
    assert.equal(DOMINION_NIGHT_THEME_REWARD.fulfillmentKey, 'dominion-night');
    assert.equal(DOMINION_NIGHT_THEME_REWARD.pointsRequired, 112);
    assert.equal(DOMINION_NIGHT_THEME_REWARD.stateModel, 'ownership');
    assert.equal(DOMINION_NIGHT_THEME_REWARD.metadata.themeKey, 'dominion-night');
  });

  it('represents preview users below, at, and above the theme threshold', () => {
    const below = buildMockRewardCatalog({
      progression: { totalPoints: 111, challenges: [] },
      now: '2026-07-20T01:00:00Z',
    });
    const at = buildMockRewardCatalog({
      progression: { totalPoints: 112, challenges: [] },
      now: '2026-07-20T01:00:00Z',
    });
    const above = buildMockRewardCatalog({
      progression: { totalPoints: 113, challenges: [] },
      now: '2026-07-20T01:00:00Z',
    });

    const belowTheme = below.catalog.items.find((reward) => reward.key === 'dominion_night_theme');
    const atTheme = at.catalog.items.find((reward) => reward.key === 'dominion_night_theme');
    const aboveTheme = above.catalog.items.find((reward) => reward.key === 'dominion_night_theme');

    assert.equal(belowTheme.status, 'locked');
    assert.equal(belowTheme.pointsRemaining, 1);
    assert.equal(below.catalog.nextUnlock.key, 'dominion_night_theme');
    assert.equal(atTheme.status, 'owned');
    assert.equal(atTheme.ownedAt, '2026-07-20T01:00:00Z');
    assert.equal(aboveTheme.status, 'owned');
  });

  it('uses eligible Daily Standards points only for the first gym reward', () => {
    const sharingInflated = buildMockRewardCatalog({
      progression: { totalPoints: 55, eligibleDailyStandardPoints: 41, challenges: [] },
      now: '2026-07-20T01:00:00Z',
    });
    const earned = buildMockRewardCatalog({
      progression: { totalPoints: 56, eligibleDailyStandardPoints: 42, challenges: [] },
      now: '2026-07-20T01:00:00Z',
    });
    const gymBefore = sharingInflated.catalog.items.find((reward) => reward.key === GYM_TRAINING_DISCOUNT_REWARD.key);
    const gymAt = earned.catalog.items.find((reward) => reward.key === GYM_TRAINING_DISCOUNT_REWARD.key);

    assert.equal(gymBefore.status, 'locked');
    assert.equal(gymBefore.currentPoints, 41);
    assert.equal(gymAt.status, 'owned');
  });

  it('keeps mock ownership after a correction and claims its celebration once', () => {
    const earned = buildMockRewardCatalog({
      progression: { totalPoints: 112, challenges: [] },
      rewardDefinitions: [DOMINION_NIGHT_THEME_REWARD],
      now: '2026-07-20T01:00:00Z',
    });
    const corrected = buildMockRewardCatalog({
      progression: { totalPoints: 5, challenges: [] },
      ownershipRecords: earned.ownershipRecords,
      rewardDefinitions: [DOMINION_NIGHT_THEME_REWARD],
      now: '2026-07-20T02:00:00Z',
    });
    const firstClaim = claimMockRewardEntitlementUnlocks({
      progression: { totalPoints: 5, challenges: [] },
      ownershipRecords: corrected.ownershipRecords,
      rewardDefinitions: [DOMINION_NIGHT_THEME_REWARD],
      now: '2026-07-20T03:00:00Z',
    });
    const retriedClaim = claimMockRewardEntitlementUnlocks({
      progression: { totalPoints: 5, challenges: [] },
      ownershipRecords: firstClaim.ownershipRecords,
      rewardDefinitions: [DOMINION_NIGHT_THEME_REWARD],
      now: '2026-07-20T04:00:00Z',
    });

    assert.equal(corrected.catalog.items[0].status, 'owned');
    assert.equal(corrected.catalog.items[0].ownedAt, '2026-07-20T01:00:00Z');
    assert.deepEqual(firstClaim.claimedUnlocks.map((reward) => reward.key), ['dominion_night_theme']);
    assert.equal(firstClaim.catalog.items[0].celebrationSeenAt, '2026-07-20T03:00:00Z');
    assert.deepEqual(retriedClaim.claimedUnlocks, []);
  });

  it('retains compatibility helper acknowledgements without making it the V2 grant path', () => {
    const migratedAt = '2026-07-30T12:00:00Z';
    const newlyEligible = backfillMockRewardEntitlements({
      progression: { totalPoints: 112, challenges: [] },
      ownershipRecords: [],
      rewardDefinitions: [DOMINION_NIGHT_THEME_REWARD],
      now: migratedAt,
    });
    const existingPending = backfillMockRewardEntitlements({
      progression: { totalPoints: 112, challenges: [] },
      ownershipRecords: [{
        key: 'dominion_night_theme',
        ownedAt: '2026-07-30T11:00:00Z',
        celebrationSeenAt: null,
      }],
      rewardDefinitions: [DOMINION_NIGHT_THEME_REWARD],
      now: migratedAt,
    });

    assert.equal(newlyEligible[0].celebrationSeenAt, migratedAt);
    assert.equal(existingPending[0].celebrationSeenAt, null);
    const source = readFileSync(new URL('./preview-reward-catalog.mjs', import.meta.url), 'utf8');
    const v2 = source.slice(source.indexOf('export function buildMockRewardCatalogV2'));
    assert.match(v2, /^export function buildMockRewardCatalogV2/);
    assert.doesNotMatch(v2, /backfillMockRewardEntitlements|migrateChallengeUnlockRecords/);
    assert.doesNotMatch(api, /pointsRequired: definition\.pointsRequired \/ 2/);
  });

  it('keeps the five typed ownership rewards in launch order', () => {
    assert.deepEqual(
      DEFAULT_OWNERSHIP_REWARD_DEFINITIONS.map((reward) => [
        reward.key,
        reward.rewardType,
        reward.pointsRequired,
      ]),
      [
        ['gym_training_discount', 'partner_discount', 42],
        ['dominion_night_theme', 'cosmetic', 112],
        ['nehemiah_leadership_handbook', 'digital_download', 210],
        ['dominion_platinum', 'cosmetic', 308],
        ['big_god_energy_tshirt_discount', 'merch_discount', 532],
      ],
    );
  });

  it('persists mock ownership with the same atomic aggregate as challenge progress', () => {
    assert.match(api, /dominion:mockRewardEntitlements/);
    const transaction = api.slice(api.indexOf('async function withPreviewAggregate('), api.indexOf('const getMockSubscription'));
    assert.match(transaction, /aggregate\.values\[MOCK_REWARD_ENTITLEMENTS_KEY\] = grants\.ownershipRecords/);
    assert.match(transaction, /aggregate\.values\[MOCK_CHALLENGE_STATES_KEY\] = grants\.challengeRecords/);
    assert.equal((transaction.match(/localStorage\.setItem\(/g) || []).length, 1);
    assert.doesNotMatch(transaction, /writeMockUserValue|backfillMockRewardEntitlements/);
  });
});
