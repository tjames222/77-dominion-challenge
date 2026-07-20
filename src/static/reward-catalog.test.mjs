import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
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
        teaser: 'Rebuild rhythm.',
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

  it('uses the current-user RPC and passes only the stable pagination cursor', () => {
    assert.match(api, /client\.rpc\('get_reward_catalog'/);
    assert.match(api, /target_after_sort_order: cursor\?\.sortOrder \?\? null/);
    assert.match(api, /target_after_reward_key: cursor\?\.key \|\| null/);
    assert.doesNotMatch(api, /get_reward_catalog[^]*target_user_id/);
  });
});
