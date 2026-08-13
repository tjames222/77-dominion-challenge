import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildGameProgressModel, renderGameProgress } from './game-progress.mjs';

function fakeElement() {
  const attributes = new Map();
  const properties = new Map();
  return {
    dataset: {},
    hidden: false,
    textContent: '',
    title: '',
    style: { setProperty: (name, value) => properties.set(name, value) },
    setAttribute: (name, value) => attributes.set(name, value),
    attribute: (name) => attributes.get(name),
    property: (name) => properties.get(name),
  };
}

describe('shared game progress presentation', () => {
  it('keeps level progress independent from reward unlock thresholds', () => {
    const model = buildGameProgressModel({ totalPoints: 29, privateRank: 4 });
    assert.equal(model.level, 3);
    assert.equal(model.pointsIntoLevel, 1);
    assert.equal(model.pointsToNext, 13);
    assert.equal(model.prestige.key, 'default');
  });

  it('preserves zero-point glass and private-group podium materials', () => {
    const zero = buildGameProgressModel({ totalPoints: 0, privateRank: 9 });
    const podium = buildGameProgressModel({ totalPoints: 14, privateRank: 1 });
    assert.equal(zero.zeroPointGlass, true);
    assert.match(zero.emblemLabel, /Zero-point glass coin/);
    assert.equal(podium.zeroPointGlass, false);
    assert.equal(podium.prestige.key, 'private-1');
    assert.equal(podium.prestige.crown, 'private');
  });

  it('renders the coin, accessible progress, and loading state as one update', () => {
    const ids = new Map([
      'gameSummaryCard',
      'gameLevelEmblem',
      'gameLevelCrown',
      'gamePrestigeStatus',
      'gameLevelProgress',
      'gamePointsTotal',
      'gameLevelNumber',
      'gameLevelLabel',
      'gameLevelProgressLabel',
      'gamePointsToNext',
      'gameMomentumMessage',
      'gameLevelProgressFill',
    ].map((id) => [id, fakeElement()]));
    const root = { getElementById: (id) => ids.get(id) || null };

    renderGameProgress(root, { totalPoints: 28, privateRank: 2 });

    assert.equal(ids.get('gameSummaryCard').attribute('aria-busy'), 'false');
    assert.equal(ids.get('gamePointsTotal').textContent, '28');
    assert.equal(ids.get('gameLevelEmblem').dataset.prestige, 'private-2');
    assert.equal(ids.get('gameLevelProgress').attribute('aria-valuemax'), '14');
    assert.equal(ids.get('gameLevelProgressFill').property('--level-progress'), '0%');
  });
});
