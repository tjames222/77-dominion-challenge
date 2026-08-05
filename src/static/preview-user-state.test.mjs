import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  PREVIEW_USER_STATE_LEGACY_OWNER_KEY,
  PREVIEW_USER_STATE_STORAGE_KEY,
  peekPreviewUserValue,
  readPreviewUserValue,
  writePreviewUserValue,
} from './preview-user-state.mjs';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, String(value)]));
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

describe('preview user state isolation', () => {
  test('does not let the wrong account claim legacy data by loading first', () => {
    const storage = memoryStorage({
      [PREVIEW_USER_STATE_LEGACY_OWNER_KEY]: 'user-a',
      'dominion:mockUserId': 'user-b',
      'dominion:mockUserIdsByIdentity': JSON.stringify({
        'a@example.test': 'user-a',
        'b@example.test': 'user-b',
      }),
      'dominion:gameStats': JSON.stringify({ totalPoints: 77 }),
    });

    assert.deepEqual(readPreviewUserValue(storage, 'user-b', 'dominion:gameStats', { totalPoints: 0 }), {
      totalPoints: 0,
    });
    assert.equal(storage.getItem(PREVIEW_USER_STATE_LEGACY_OWNER_KEY), 'user-a');
    assert.deepEqual(readPreviewUserValue(storage, 'user-a', 'dominion:gameStats', { totalPoints: 0 }), {
      totalPoints: 77,
    });
  });

  test('does not treat a fresh activation marker as proof of legacy global ownership', () => {
    const storage = memoryStorage({
      'dominion:mockChallengeActivationLegacyOwner': 'user-b',
      'dominion:mockUserId': 'user-b',
      'dominion:mockUserIdsByIdentity': JSON.stringify({
        'a@example.test': 'user-a',
        'b@example.test': 'user-b',
      }),
      'dominion:gameStats': JSON.stringify({ totalPoints: 77 }),
    });

    assert.deepEqual(readPreviewUserValue(storage, 'user-b', 'dominion:gameStats', { totalPoints: 0 }), {
      totalPoints: 0,
    });
    assert.equal(storage.getItem(PREVIEW_USER_STATE_LEGACY_OWNER_KEY), null);
  });

  test('keeps separate account values and mirrors only the proven legacy owner', () => {
    const storage = memoryStorage({
      'dominion:mockUserId': 'user-a',
      'dominion:mockUserIdsByIdentity': JSON.stringify({ 'a@example.test': 'user-a' }),
      'dominion:entries': JSON.stringify([{ date: '2026-08-04', completed: ['bible'] }]),
    });

    assert.equal(readPreviewUserValue(storage, 'user-a', 'dominion:entries', []).length, 1);
    writePreviewUserValue(storage, 'user-b', 'dominion:entries', []);
    assert.equal(JSON.parse(storage.getItem('dominion:entries')).length, 1);
    assert.deepEqual(readPreviewUserValue(storage, 'user-b', 'dominion:entries', []), []);
  });

  test('leaves ambiguous legacy state unclaimed when no authoritative owner exists', () => {
    const storage = memoryStorage({
      'dominion:mockUserId': 'user-b',
      'dominion:mockUserIdsByIdentity': JSON.stringify({
        'a@example.test': 'user-a',
        'b@example.test': 'user-b',
      }),
      'dominion:badges': JSON.stringify([{ key: 'a-only' }]),
    });

    assert.deepEqual(readPreviewUserValue(storage, 'user-b', 'dominion:badges', []), []);
    assert.equal(storage.getItem(PREVIEW_USER_STATE_LEGACY_OWNER_KEY), null);
  });

  test('can inspect an account-scoped value without claiming or writing fallback state', () => {
    const storage = memoryStorage({
      'dominion:mockUserId': 'user-a',
      'dominion:mockUserIdsByIdentity': JSON.stringify({ 'a@example.test': 'user-a' }),
    });
    assert.deepEqual(peekPreviewUserValue(storage, 'user-a', 'dominion:siteTrainingProgress', {}), {});
    assert.equal(storage.getItem(PREVIEW_USER_STATE_STORAGE_KEY), null);
    assert.equal(storage.getItem(PREVIEW_USER_STATE_LEGACY_OWNER_KEY), null);
  });
});
