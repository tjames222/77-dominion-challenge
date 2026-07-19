import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
      key: 'private-1', scope: 'private', rank: 1, crown: 'private', shortLabel: 'Crew #1', accessibleLabel: 'Private group leaderboard, 1st place',
    });
    assert.equal(resolveLeaderboardPrestige({ privateRank: 2 }).key, 'private-2');
    assert.equal(resolveLeaderboardPrestige({ privateRank: 2 }).crown, null);
    assert.equal(resolveLeaderboardPrestige({ privateRank: 3 }).key, 'private-3');
  });

  it('uses the default state outside the private podium', () => {
    assert.equal(resolveLeaderboardPrestige({ privateRank: 4 }).key, 'default');
    assert.equal(resolveLeaderboardPrestige({ privateRank: 400 }).crown, null);
  });

  it('ignores global rank even when stale callers still supply it', () => {
    assert.equal(resolveLeaderboardPrestige({ globalRank: 1, privateRank: 3 }).key, 'private-3');
    assert.equal(resolveLeaderboardPrestige({ globalRank: 1 }).key, 'default');
  });

  it('fully downgrades invalid or missing ranks', () => {
    const prestige = resolveLeaderboardPrestige({ privateRank: -2 });
    assert.equal(prestige.key, 'default');
    assert.equal(prestige.crown, null);
    assert.equal(prestige.shortLabel, '');
  });
});

describe('private-only prestige integration', () => {
  it('does not query the global leaderboard when resolving dashboard prestige', async () => {
    const apiSource = await readFile(new URL('./api.js', import.meta.url), 'utf8');
    const prestigeFunction = apiSource.slice(
      apiSource.indexOf('export async function getLeaderboardPrestige'),
      apiSource.indexOf('function createMockAvatar'),
    );

    assert.doesNotMatch(prestigeFunction, /scope:\s*['"]global['"]/);
    assert.doesNotMatch(prestigeFunction, /globalRank|globalRows/);
    assert.match(prestigeFunction, /queryLeaderboard\(requireSupabase\(\), \{\s*crewId:/);
  });

  it('assigns the premium orbit and epic crown to private podium states only', async () => {
    const css = await readFile(new URL('../assets/product.css', import.meta.url), 'utf8');

    assert.doesNotMatch(css, /data-prestige(?:\^)?=['"]global-/);
    assert.match(css, /data-prestige="private-1"\] \.game-level-crown/);
    assert.match(css, /data-prestige\^="private-"\] \.game-prestige-orbit/);
  });
});
