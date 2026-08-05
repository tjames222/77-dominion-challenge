import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  completedTodayLabel,
  countCompletedToday,
  normalizeBadgeTier,
  selectLatestAccountabilityPosts,
  selectLatestBadge,
  shouldUseZeroPointGlass,
} from './dashboard-view-model.mjs';

describe('dashboard badge preview', () => {
  it('selects exactly the newest badge without mutating the source array', () => {
    const badges = [
      { key: 'middle', earnedAt: '2026-07-20T12:00:00Z' },
      { key: 'newest', earnedAt: '2026-07-22T12:00:00Z' },
      { key: 'oldest', earnedAt: '2026-07-18T12:00:00Z' },
    ];
    const originalOrder = badges.map((badge) => badge.key);

    assert.equal(selectLatestBadge(badges).key, 'newest');
    assert.deepEqual(badges.map((badge) => badge.key), originalOrder);
  });

  it('uses a deterministic badge key fallback for equal or missing timestamps', () => {
    assert.equal(selectLatestBadge([
      { key: 'zulu', earnedAt: '2026-07-22T12:00:00Z' },
      { key: 'alpha', earnedAt: '2026-07-22T12:00:00Z' },
    ]).key, 'alpha');
    assert.equal(selectLatestBadge([{ key: 'zulu' }, { key: 'alpha' }]).key, 'alpha');
    assert.equal(selectLatestBadge([]), null);
  });
});

describe('dashboard accountability preview', () => {
  const posts = [
    { id: 'a', createdAt: '2026-07-20T10:00:00Z' },
    { id: 'c', createdAt: '2026-07-22T10:00:00Z' },
    { id: 'b', createdAt: '2026-07-22T10:00:00Z' },
    { id: 'd', createdAt: '2026-07-19T10:00:00Z' },
  ];

  it('renders zero, fewer than three, and exactly three available posts', () => {
    assert.deepEqual(selectLatestAccountabilityPosts([]), []);
    assert.deepEqual(selectLatestAccountabilityPosts(posts.slice(0, 2)).map(({ id }) => id), ['c', 'a']);
    assert.equal(selectLatestAccountabilityPosts(posts.slice(0, 3)).length, 3);
  });

  it('keeps only the newest three with a deterministic descending id tie-breaker', () => {
    const originalOrder = posts.map(({ id }) => id);
    assert.deepEqual(selectLatestAccountabilityPosts(posts).map(({ id }) => id), ['c', 'b', 'a']);
    assert.deepEqual(posts.map(({ id }) => id), originalOrder);
  });

  it('counts every completed-today record independently of the visible preview', () => {
    const fullFeed = Array.from({ length: 7 }, (_, index) => ({
      id: String(index),
      status: index < 5 ? 'complete' : 'partial',
      timestamp: 'Today',
      createdAt: `2026-07-22T10:00:0${index}Z`,
    }));
    assert.equal(selectLatestAccountabilityPosts(fullFeed).length, 3);
    assert.equal(countCompletedToday(fullFeed), 5);
    assert.equal(completedTodayLabel(fullFeed), '5 people completed today');
    assert.equal(completedTodayLabel(fullFeed.slice(0, 1)), '1 person completed today');
  });
});

describe('dashboard presentation states', () => {
  it('uses glass only for zero-point members without a podium prestige', () => {
    assert.equal(shouldUseZeroPointGlass({ totalPoints: 0, prestigeRank: null }), true);
    assert.equal(shouldUseZeroPointGlass({ totalPoints: 0, prestigeRank: 4 }), true);
    [1, 2, 3].forEach((prestigeRank) => {
      assert.equal(shouldUseZeroPointGlass({ totalPoints: 0, prestigeRank }), false);
    });
    assert.equal(shouldUseZeroPointGlass({ totalPoints: 1, prestigeRank: null }), false);
  });

  it('normalizes authoritative badge tiers with a safe bronze fallback', () => {
    assert.equal(normalizeBadgeTier({ tier: 'BRONZE' }), 'bronze');
    assert.equal(normalizeBadgeTier({ tier: 'silver' }), 'silver');
    assert.equal(normalizeBadgeTier({ tier: 'gold' }), 'gold');
    assert.equal(normalizeBadgeTier({ tier: 'platinum' }), 'bronze');
  });
});
