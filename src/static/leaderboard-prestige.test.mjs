import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  normalizeLeaderboardRank,
  resolveLeaderboardPrestige,
} from './leaderboard-prestige.mjs';

describe('leaderboard prestige', () => {
  it('normalizes only positive whole-number ranks', () => {
    assert.equal(normalizeLeaderboardRank('2'), 2);
    assert.equal(normalizeLeaderboardRank(1), 1);
    [null, undefined, '', true, [1], 0, -1, 1.5, 'second'].forEach((value) => {
      assert.equal(normalizeLeaderboardRank(value), null);
    });
  });

  it('maps private podium ranks to gold, silver, and bronze states', () => {
    assert.deepEqual(resolveLeaderboardPrestige({ privateRank: 1 }), {
      key: 'private-1', scope: 'private', rank: 1, crown: 'private', shortLabel: 'Crew #1', accessibleLabel: 'Private leaderboard, 1st place',
    });
    assert.equal(resolveLeaderboardPrestige({ privateRank: 2 }).key, 'private-2');
    assert.equal(resolveLeaderboardPrestige({ privateRank: 2 }).crown, null);
    assert.equal(resolveLeaderboardPrestige({ privateRank: 3 }).key, 'private-3');
  });

  it('uses the default state outside the private podium', () => {
    assert.equal(resolveLeaderboardPrestige({ privateRank: 4 }).key, 'default');
    assert.equal(resolveLeaderboardPrestige({ privateRank: 400 }).crown, null);
  });

  it('maps the global podium to elevated global states', () => {
    assert.deepEqual(resolveLeaderboardPrestige({ globalRank: 1 }), {
      key: 'global-1', scope: 'global', rank: 1, crown: 'global', shortLabel: 'Global #1', accessibleLabel: 'Global leaderboard, 1st place',
    });
    assert.equal(resolveLeaderboardPrestige({ globalRank: 2 }).key, 'global-2');
    assert.equal(resolveLeaderboardPrestige({ globalRank: 2 }).crown, null);
    assert.equal(resolveLeaderboardPrestige({ globalRank: 3 }).key, 'global-3');
  });

  it('always gives a qualifying global rank precedence over private first place', () => {
    assert.equal(resolveLeaderboardPrestige({ globalRank: 3, privateRank: 1 }).key, 'global-3');
    assert.equal(resolveLeaderboardPrestige({ globalRank: 2, privateRank: 1 }).crown, null);
  });

  it('falls through from a non-prestige global rank to a private podium rank', () => {
    assert.equal(resolveLeaderboardPrestige({ globalRank: 4, privateRank: 1 }).key, 'private-1');
  });

  it('fully downgrades invalid or missing ranks', () => {
    const prestige = resolveLeaderboardPrestige({ globalRank: 'none', privateRank: -2 });
    assert.equal(prestige.key, 'default');
    assert.equal(prestige.crown, null);
    assert.equal(prestige.shortLabel, '');
  });
});
