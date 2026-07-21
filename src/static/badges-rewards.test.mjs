import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { PRODUCTION_ENTRYPOINTS } from '../../app-entrypoints.mjs';

import {
  buildBadgesRewardsPageModel,
  iconClass,
  normalizeEarnedBadges,
  rewardViewModel,
} from './badges-rewards.mjs';

const apiSource = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
const pageSource = readFileSync(new URL('./badges-rewards.js', import.meta.url), 'utf8');
const pageHtml = readFileSync(new URL('../../badges-rewards.html', import.meta.url), 'utf8');
const dashboardHtml = readFileSync(new URL('../../dashboard.html', import.meta.url), 'utf8');
const dashboardSource = readFileSync(new URL('./dashboard.js', import.meta.url), 'utf8');
const menuSource = readFileSync(new URL('./menu.js', import.meta.url), 'utf8');

describe('Badges & Rewards page model', () => {
  it('preserves the Sharing badge icon instead of falling back', () => {
    assert.equal(iconClass('share'), 'icon-share');
  });

  it('deduplicates an unbounded badge collection with stable newest-first ordering', () => {
    const badges = normalizeEarnedBadges([
      { key: 'faithful_start', name: 'Old copy', earnedAt: '2026-07-01T00:00:00Z' },
      { key: 'iron_standard', name: 'Iron Standard', earnedAt: '2026-07-03T00:00:00Z' },
      { key: 'faithful_start', name: 'Faithful Start', earnedAt: '2026-07-02T00:00:00Z' },
    ]);

    assert.deepEqual(badges.map((badge) => badge.key), ['iron_standard', 'faithful_start']);
    assert.equal(badges[1].name, 'Faithful Start');
  });

  it('shows exact progress and marks the nearest locked reward', () => {
    const reward = rewardViewModel({
      key: 'dominion_night_theme',
      rewardType: 'cosmetic',
      stateModel: 'ownership',
      status: 'locked',
      pointsRequired: 500,
      currentPoints: 400,
      pointsRemaining: 100,
      progressPercent: 80,
      title: 'Dominion Night',
    }, 'dominion_night_theme');

    assert.equal(reward.statusLabel, 'Locked');
    assert.equal(reward.detail, '100 points remaining');
    assert.equal(reward.progressPercent, 80);
    assert.equal(reward.isNext, true);
    assert.equal(reward.canStart, false);
  });

  it('keeps challenge lifecycle actions separate from cosmetic ownership', () => {
    const available = rewardViewModel({
      key: 'reset',
      stateModel: 'challenge_lifecycle',
      status: 'available',
      canAccess: true,
      allowedActions: ['start'],
    });
    const active = rewardViewModel({ key: 'prayer', stateModel: 'challenge_lifecycle', status: 'active' });
    const completed = rewardViewModel({ key: 'strength', stateModel: 'challenge_lifecycle', status: 'completed' });
    const owned = rewardViewModel({
      key: 'theme',
      stateModel: 'ownership',
      status: 'owned',
      active: true,
      metadata: {
        selectionRoute: 'profile.html#appearance',
        selectionLabel: 'Select in Profile',
      },
    });

    assert.equal(available.canStart, true);
    assert.equal(active.canStart, false);
    assert.equal(active.statusLabel, 'Active');
    assert.equal(completed.statusLabel, 'Completed');
    assert.equal(owned.statusLabel, 'Owned');
    assert.equal(owned.canStart, false);
    assert.equal(owned.selectionHref, './profile.html#appearance');
  });

  it('fails closed for unsafe or inactive cosmetic selection routes', () => {
    const unsafe = rewardViewModel({
      key: 'unsafe',
      stateModel: 'ownership',
      status: 'owned',
      metadata: { selectionRoute: 'javascript:alert(1)' },
    });
    const inactive = rewardViewModel({
      key: 'inactive',
      stateModel: 'ownership',
      status: 'owned',
      active: false,
      metadata: { selectionRoute: 'profile.html#appearance' },
    });

    assert.equal(unsafe.selectionHref, null);
    assert.equal(inactive.selectionHref, null);
  });

  it('handles empty, access-blocked, and all-unlocked catalogs explicitly', () => {
    const empty = buildBadgesRewardsPageModel({ catalog: { items: [] } });
    const blocked = buildBadgesRewardsPageModel({
      catalog: {
        items: [{
          key: 'member_track',
          stateModel: 'challenge_lifecycle',
          status: 'locked',
          canAccess: false,
        }],
      },
    });
    const complete = buildBadgesRewardsPageModel({
      catalog: {
        items: [
          { key: 'theme', stateModel: 'ownership', status: 'owned' },
          { key: 'track', stateModel: 'challenge_lifecycle', status: 'completed' },
        ],
      },
    });

    assert.equal(empty.summaryMode, 'empty');
    assert.equal(blocked.summaryMode, 'access');
    assert.equal(complete.summaryMode, 'complete');
    assert.equal(complete.unlockedCount, 2);
  });
});

describe('Badges & Rewards route integration', () => {
  it('registers a dedicated authenticated Vite entry with refresh-safe loaders', () => {
    assert.equal(PRODUCTION_ENTRYPOINTS.badgesRewards, 'badges-rewards.html');
    assert.match(pageHtml, /src\/static\/badges-rewards\.js/);
    assert.match(pageSource, /redirectToLogin\('\.\/badges-rewards\.html'\)/);
    assert.match(pageSource, /getBillingState\(\)/);
    assert.match(pageSource, /getAllRewardCatalog\(\)/);
    assert.match(pageSource, /window\.addEventListener\('storage'/);
  });

  it('loads all earned badges by page instead of reusing the 12-badge Dashboard shelf', () => {
    const functionSource = apiSource.match(/export async function getEarnedBadges[\s\S]*?\n}\n/)?.[0] || '';
    assert.match(functionSource, /\.range\(offset, offset \+ normalizedPageSize - 1\)/);
    assert.match(functionSource, /while \(true\)/);
    assert.doesNotMatch(functionSource, /\.limit\(12\)/);
  });

  it('follows the typed reward cursor until the entire catalog is loaded', () => {
    const functionSource = apiSource.match(/export async function getAllRewardCatalog[\s\S]*?\n}\n/)?.[0] || '';
    assert.match(functionSource, /while \(true\)/);
    assert.match(functionSource, /page\.page\.hasMore/);
    assert.match(functionSource, /page\.page\.nextCursor/);
    assert.match(functionSource, /pagination did not advance/);
  });

  it('claims one-time unlocks and keeps Start actions on the rewards page', () => {
    assert.match(pageSource, /claimRewardEntitlementUnlocks\(\)/);
    assert.match(pageSource, /claimChallengeUnlocks\(\)/);
    assert.match(pageSource, /data-start-reward/);
    assert.match(pageSource, /await startChallenge\(pendingRewardKey\)/);
  });

  it('removes the Challenge Vault from Dashboard and adds the concise progress link', () => {
    assert.doesNotMatch(dashboardHtml, /id="challengeVault"|Challenge Vault/);
    assert.doesNotMatch(dashboardSource, /data-start-challenge|startChallenge/);
    assert.match(dashboardHtml, /href="\.\/badges-rewards\.html"/);
    assert.match(dashboardHtml, />View badges and rewards</);
  });

  it('replaces the authenticated Challenges destination with Badges & Rewards', () => {
    assert.match(menuSource, /\['Badges & Rewards', '\.\/badges-rewards\.html'\]/);
    assert.doesNotMatch(menuSource, /dashboard\.html#challengeVault/);
  });
});
