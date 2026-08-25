import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FALLBACK_DAILY_VERSE,
  WORSHIP_PLAYLISTS,
  dayIndexForDate,
  loadDailyVerse,
  pickDailyForDate,
  verseFromPayload,
} from './daily-standard-content.mjs';

test('date-based content is stable for the same calendar date', () => {
  const first = pickDailyForDate(WORSHIP_PLAYLISTS, '2026-07-19');
  assert.equal(pickDailyForDate(WORSHIP_PLAYLISTS, '2026-07-19'), first);
  assert.notEqual(dayIndexForDate('2026-07-19'), dayIndexForDate('2026-07-20'));
});

test('daily selection supports an independent offset', () => {
  assert.notEqual(
    pickDailyForDate(WORSHIP_PLAYLISTS, '2026-07-19', 0),
    pickDailyForDate(WORSHIP_PLAYLISTS, '2026-07-19', 1),
  );
});

test('verse payloads preserve configured shapes and field-level fallbacks', () => {
  assert.deepEqual(verseFromPayload({ verse: { text: 'Be still.', reference: 'Psalm 46:10' } }), {
    text: 'Be still.', reference: 'Psalm 46:10',
  });
  assert.deepEqual(verseFromPayload({ text: 'Rejoice.' }), {
    text: 'Rejoice.', reference: FALLBACK_DAILY_VERSE.reference,
  });
});

test('verse loading gracefully falls back when unavailable', async () => {
  assert.equal(await loadDailyVerse('', null), FALLBACK_DAILY_VERSE);
  assert.equal(await loadDailyVerse('/verse', async () => ({ ok: false })), FALLBACK_DAILY_VERSE);
  assert.equal(await loadDailyVerse('/verse', async () => { throw new Error('offline'); }), FALLBACK_DAILY_VERSE);
});
