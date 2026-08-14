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
const pageCss = readFileSync(new URL('../assets/badges-rewards.css', import.meta.url), 'utf8');
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
      { key: 'iron_standard', name: 'Seven for Seven', earnedAt: '2026-07-03T00:00:00Z' },
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
  it('splits Rewards and Badges into accessible Community-style tabs with Rewards selected by default', () => {
    assert.match(pageHtml, /class="badges-rewards-tabs" role="tablist" aria-label="Rewards and badges"/);
    assert.match(pageHtml, /id="rewards-tab"[\s\S]*?role="tab"[\s\S]*?aria-selected="true"[\s\S]*?aria-controls="rewards-panel"/);
    assert.match(pageHtml, /id="badges-tab"[\s\S]*?role="tab"[\s\S]*?aria-selected="false"[\s\S]*?aria-controls="badges-panel"[\s\S]*?tabindex="-1"/);
    assert.match(pageHtml, /class="badges-rewards-panel active"[\s\S]*?id="rewards-panel"[\s\S]*?role="tabpanel"[\s\S]*?aria-labelledby="rewards-tab"/);
    assert.match(pageHtml, /class="badges-rewards-panel"[\s\S]*?id="badges-panel"[\s\S]*?role="tabpanel"[\s\S]*?aria-labelledby="badges-tab"[\s\S]*?hidden/);

    const tabsIndex = pageHtml.indexOf('class="badges-rewards-tabs"');
    const progressIndex = pageHtml.indexOf('id="gameSummaryCard"');
    const shareIndex = pageHtml.indexOf('data-share-kind="progress"');
    const nextUnlockIndex = pageHtml.indexOf('id="rewardNextPanel"');
    const rewardsCatalogIndex = pageHtml.indexOf('class="rewards-catalog-section');
    const badgesPanelIndex = pageHtml.indexOf('id="badges-panel"');
    const badgesGalleryIndex = pageHtml.indexOf('class="badges-gallery-section');
    assert.ok(tabsIndex < progressIndex);
    assert.ok(progressIndex < shareIndex);
    assert.ok(shareIndex < nextUnlockIndex);
    assert.ok(nextUnlockIndex < rewardsCatalogIndex);
    assert.ok(rewardsCatalogIndex < badgesPanelIndex);
    assert.ok(badgesPanelIndex < badgesGalleryIndex);
  });

  it('supports roving tab focus and the complete horizontal keyboard contract', () => {
    assert.match(pageSource, /item\.setAttribute\('aria-selected', String\(selected\)\)/);
    assert.match(pageSource, /item\.tabIndex = selected \? 0 : -1/);
    assert.match(pageSource, /panel\.hidden = !selected/);
    assert.match(pageSource, /event\.key === 'ArrowRight'/);
    assert.match(pageSource, /event\.key === 'ArrowLeft'/);
    assert.match(pageSource, /event\.key === 'Home'/);
    assert.match(pageSource, /event\.key === 'End'/);
    assert.match(pageSource, /activateTab\(tabs\[nextIndex\], \{ focus: true \}\)/);
  });

  it('gives the share action, tabs, and selected panel explicit responsive spacing', () => {
    assert.match(pageCss, /--badges-rewards-section-gap:\s*clamp\(28px, 5vw, 56px\)/);
    assert.match(pageCss, /\.badges-rewards-shell\s*\{[\s\S]*?display:\s*grid;[\s\S]*?gap:\s*var\(--badges-rewards-section-gap\)/);
    assert.match(pageCss, /\.badges-rewards-tabs\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
    assert.match(pageCss, /\.badges-rewards-panel\s*\{[\s\S]*?gap:\s*var\(--badges-rewards-section-gap\)/);
    assert.match(pageCss, /@media \(max-width: 520px\)[\s\S]*?\.badges-rewards-tab/);
  });

  it('registers a dedicated authenticated Vite entry with refresh-safe loaders', () => {
    assert.equal(PRODUCTION_ENTRYPOINTS.badgesRewards, 'badges-rewards.html');
    assert.match(pageHtml, /src\/static\/badges-rewards\.js/);
    assert.match(pageSource, /redirectToLogin\('\.\/badges-rewards\.html'\)/);
    assert.match(pageSource, /getBillingState\(\)/);
    assert.match(pageSource, /getAllRewardCatalog\(\{ expectedUserId \}\)/);
    assert.match(pageSource, /window\.addEventListener\('storage'/);
  });

  it('binds secure fulfillment to one page actor and scrubs account-bound details', () => {
    for (const apiName of ['getRewardFulfillment', 'claimRewardOffer', 'downloadRewardAsset']) {
      const functionSource = apiSource.match(
        new RegExp(`export async function ${apiName}\\([\\s\\S]*?\\n}`),
      )?.[0] || '';
      assert.match(functionSource, /expectedUserId/);
      assert.match(functionSource, /requireMockRewardActor\(expectedUserId\)/);
      assert.match(functionSource, /requireMockRewardActor\(actorId\)/);
      if (apiName !== 'downloadRewardAsset') {
        assert.match(functionSource, /const actor = await requireUser\(expectedUserId\)/);
        assert.match(functionSource, /await requireUser\(actor\.id\)/);
      }
    }

    assert.match(pageSource, /getLocalOrSessionUser\(\)/);
    assert.match(pageSource, /subscribeToAuthStateChanges/);
    assert.match(pageSource, /getRewardFulfillment\(reward\.key, \{ expectedUserId \}\)/);
    assert.match(pageSource, /claimRewardOffer\(action\.rewardKey, \{ expectedUserId: action\.actorId \}\)/);
    assert.match(pageSource, /downloadRewardAsset\(action\.rewardKey, \{ expectedUserId: action\.actorId \}\)/);
    assert.match(
      pageSource,
      /if \(rewardActionInFlight\) return;[\s\S]*?rewardActionInFlight = action;[\s\S]*?button\.disabled = true;[\s\S]*?await pageActorIsCurrent\(action\.actorId\)/,
    );
    assert.match(pageSource, /function scrubRewardDetail[\s\S]*?activeFulfillment = \{}[\s\S]*?replaceChildren\(\)/);
    assert.match(pageSource, /function scrubAccountBoundPage[\s\S]*?replaceChildren\(\)/);
    assert.match(pageSource, /window\.addEventListener\('pagehide'[\s\S]*?scrubAccountBoundPage\(\)/);
    assert.match(pageSource, /window\.addEventListener\('storage'[\s\S]*?dismissAndScrubRewardDetail\(\)/);
    assert.match(pageSource, /renderRewardDetail\(\{ busy: true \}\)/);
    assert.match(pageSource, /rewardDetailContent\.setAttribute\('aria-busy', String\(busy\)\)/);
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
    assert.match(pageSource, /claimRewardEntitlementUnlocks\(\{ expectedUserId \}\)/);
    assert.match(pageSource, /claimChallengeUnlocks\(\{ expectedUserId \}\)/);
    assert.match(pageSource, /data-start-reward/);
    assert.match(pageSource, /await startChallenge\(pendingRewardKey, \{ expectedUserId \}\)/);
  });

  it('downloads verified PDF bytes without navigating to a signed storage URL', () => {
    assert.match(pageSource, /result\?\.blob instanceof Blob/);
    assert.match(pageSource, /URL\.createObjectURL\(result\.blob\)/);
    assert.match(pageSource, /URL\.revokeObjectURL\(objectUrl\)/);
    assert.doesNotMatch(pageSource, /window\.location\.assign\(result\.url\)/);
    const functionSource = apiSource.match(/export async function downloadRewardAsset[\s\S]*?\n}\n/)?.[0] || '';
    assert.match(functionSource, /client\.functions\.invoke\('reward-download'/);
    assert.match(functionSource, /data instanceof Blob/);
    assert.match(functionSource, /String\.fromCharCode\(\.\.\.signature\) !== '%PDF-'/);
    assert.doesNotMatch(functionSource, /data\?\.url|new URL\(data\.url\)/);
  });

  it('removes duplicate rewards content from Dashboard and keeps Rewards in the member navigation', () => {
    assert.doesNotMatch(dashboardHtml, /id="challengeVault"|Challenge Vault/);
    assert.doesNotMatch(dashboardSource, /data-start-challenge|challengeVault/);
    assert.match(dashboardHtml, /class="member-tab" href="\.\/badges-rewards\.html">[\s\S]*?class="member-tab-label">Rewards<\/span>/);
    assert.doesNotMatch(dashboardHtml, />View badges and rewards</);
    assert.doesNotMatch(dashboardHtml, /class="progression-badges"|id="badgeShelf"/);
    assert.doesNotMatch(dashboardHtml, /id="gameSummaryCard"/);
    assert.match(pageHtml, /id="gameSummaryCard"[\s\S]*?id="gameLevelEmblem"[\s\S]*?id="gameLevelProgress"/);
    assert.match(pageSource, /renderGameProgress\(document/);
    assert.match(pageSource, /getLeaderboardPrestige\(/);
  });

  it('replaces the authenticated Challenges destination with Badges & Rewards', () => {
    assert.match(menuSource, /\['Badges & Rewards', '\.\/badges-rewards\.html'\]/);
    assert.doesNotMatch(menuSource, /dashboard\.html#challengeVault/);
  });
});
