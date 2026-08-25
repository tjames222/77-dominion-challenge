import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [styles, rewards, community] = await Promise.all([
  readFile(new URL('../assets/styles.css', import.meta.url), 'utf8'),
  readFile(new URL('../assets/badges-rewards.css', import.meta.url), 'utf8'),
  readFile(new URL('../assets/community.css', import.meta.url), 'utf8'),
]);

test('shared back links retain a visible 44px interaction target', () => {
  const backLinkRule = styles.match(/\.theme-toggle,\s*\.back-link\s*\{[\s\S]*?\}/)?.[0] || '';
  assert.match(backLinkRule, /min-height:\s*44px/);
  assert.match(backLinkRule, /display:\s*inline-flex/);
  assert.match(backLinkRule, /align-items:\s*center/);
});

test('reward actions retain a 44px interaction target', () => {
  const rewardActionRule = rewards.match(/\.reward-action-button,\s*\.reward-action-link\s*\{[\s\S]*?\}/)?.[0] || '';
  assert.match(rewardActionRule, /min-height:\s*44px/);
});

test('leaderboard range controls retain a 44px interaction target', () => {
  const leaderboardToggleRule = community.match(/\.leaderboard-toggle button\s*\{[\s\S]*?\}/)?.[0] || '';
  assert.match(leaderboardToggleRule, /min-height:\s*44px/);
});
