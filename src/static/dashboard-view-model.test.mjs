import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shouldUseZeroPointGlass } from './dashboard-view-model.mjs';

describe('dashboard zero-point level coin', () => {
  it('uses glass for zero-point users outside the private-group podium', () => {
    assert.equal(shouldUseZeroPointGlass({ totalPoints: 0, prestigeRank: null }), true);
    assert.equal(shouldUseZeroPointGlass({ totalPoints: 0, prestigeRank: undefined }), true);
    assert.equal(shouldUseZeroPointGlass({ totalPoints: 0, prestigeRank: 4 }), true);
  });

  it('preserves podium prestige even when the user has zero points', () => {
    for (const prestigeRank of [1, 2, 3]) {
      assert.equal(shouldUseZeroPointGlass({ totalPoints: 0, prestigeRank }), false);
    }
  });

  it('removes the glass state as soon as the user earns a point', () => {
    assert.equal(shouldUseZeroPointGlass({ totalPoints: 1, prestigeRank: null }), false);
    assert.equal(shouldUseZeroPointGlass({ totalPoints: 77, prestigeRank: 8 }), false);
  });
});
