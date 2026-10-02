import assert from 'node:assert/strict';
import test from 'node:test';
import {
  JOURNAL_PAGE_FETCH_LIMIT,
  JOURNAL_PAGE_SIZE,
  compareJournalOrdering,
  journalPageFilter,
  journalTimestampMicros,
  normalizeJournalCursor,
  projectJournalPage,
  selectPreviewJournalPage,
} from './journal-pagination.mjs';

const ACTOR = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const uuid = (value) => `00000000-0000-0000-0000-${value.toString(16).padStart(12, '0')}`;
const row = (index, overrides = {}) => ({
  id: uuid(100 - index),
  user_id: ACTOR,
  entry_date: index === 0 ? '2999-12-31' : '2026-10-01',
  challenge_day: index + 1,
  note: `note-${index}`,
  win: '',
  prayer: '',
  mood: '',
  energy: '',
  created_at: `2026-10-01T12:00:00.${String(999999 - index).padStart(6, '0')}+00:00`,
  updated_at: `2026-10-01T12:00:01.${String(999999 - index).padStart(6, '0')}+00:00`,
  ...overrides,
});

test('projects exactly 25 displayed rows plus one lookahead without dropping the boundary row', () => {
  const rows = Array.from({ length: JOURNAL_PAGE_FETCH_LIMIT }, (_, index) => row(index));
  const page = projectJournalPage(rows, { actorId: ACTOR });
  assert.equal(JOURNAL_PAGE_SIZE, 25);
  assert.equal(page.entries.length, 25);
  assert.equal(page.hasNext, true);
  assert.deepEqual(page.nextCursor, {
    entryDate: rows[24].entry_date,
    createdAt: rows[24].created_at,
    id: rows[24].id,
  });
  assert.equal(page.entries[0].date, '2999-12-31', 'pre-existing future rows remain readable');
  assert.equal(page.entries.some((entry) => entry.id === rows[25].id), false, 'lookahead is not displayed');
});

test('preview keyset pages preserve all rows, raw microseconds and a non-UUID legacy id', () => {
  const values = Array.from({ length: 31 }, (_, index) => ({
    ...row(index),
    id: `preview_journal_${String(100 - index).padStart(3, '0')}`,
    user_id: undefined,
  }));
  const firstRows = selectPreviewJournalPage(values);
  const first = projectJournalPage(firstRows, { preview: true });
  const secondRows = selectPreviewJournalPage(values, first.nextCursor);
  const second = projectJournalPage(secondRows, { preview: true });
  assert.equal(first.entries.length, 25);
  assert.equal(second.entries.length, 6);
  assert.equal(second.hasNext, false);
  assert.deepEqual(
    [...first.entries, ...second.entries].map((entry) => entry.id),
    values.map((entry) => entry.id),
  );
  assert.equal(first.nextCursor.createdAt, values[24].created_at);
});

test('orders equivalent offset timestamps by the generic UUID tie breaker without Date precision loss', () => {
  const left = row(1, {
    id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
    entry_date: '2026-10-01',
    created_at: '2026-10-01T12:00:00.123456Z',
  });
  const right = row(2, {
    id: '00000000-0000-0000-0000-000000000000',
    entry_date: '2026-10-01',
    created_at: '2026-10-01T08:00:00.123456-04:00',
  });
  assert.equal(journalTimestampMicros(left.created_at), journalTimestampMicros(right.created_at));
  assert.equal(compareJournalOrdering(left, right, { actorId: ACTOR }), -1);
});

test('keeps uncapped saved text and permits nullable legacy updatedAt because neither controls ordering', () => {
  const long = 'journal '.repeat(50_000);
  const page = projectJournalPage([row(1, { note: long, updated_at: null })], { actorId: ACTOR });
  assert.equal(page.entries[0].note, long);
  assert.equal(page.entries[0].updatedAt, null);
});

test('fails the complete page visibly for malformed ordering metadata or actor mismatch', () => {
  for (const invalid of [
    row(1, { created_at: 'infinity' }),
    row(1, { created_at: '0001-01-01 00:00:00 BC' }),
    row(1, { id: 'not-a-uuid' }),
    row(1, { user_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }),
  ]) {
    assert.throws(() => projectJournalPage([invalid], { actorId: ACTOR }), { code: 'JOURNAL_INVALID_DATA' });
  }
  assert.throws(
    () => selectPreviewJournalPage([{ ...row(1), id: 'preview_journal_1', user_id: undefined, created_at: null }]),
    { code: 'JOURNAL_INVALID_DATA' },
    'missing legacy createdAt is unsupported ordering evidence, not a silently dropped row',
  );
});

test('requires exact cursor fields and produces the strict PostgREST continuation predicate', () => {
  const cursor = {
    entryDate: '2026-10-01',
    createdAt: '2026-10-01T12:00:00.123456+00:00',
    id: '00000000-0000-0000-0000-000000000000',
  };
  assert.deepEqual(normalizeJournalCursor(cursor), cursor);
  assert.equal(journalPageFilter(cursor), [
    'entry_date.lt.2026-10-01',
    'and(entry_date.eq.2026-10-01,created_at.lt.2026-10-01T12:00:00.123456+00:00)',
    'and(entry_date.eq.2026-10-01,created_at.eq.2026-10-01T12:00:00.123456+00:00,id.lt.00000000-0000-0000-0000-000000000000)',
  ].join(','));
  assert.throws(() => normalizeJournalCursor({ ...cursor, extra: true }), { code: 'JOURNAL_INVALID_CURSOR' });
  assert.throws(() => normalizeJournalCursor({ ...cursor, createdAt: `${cursor.createdAt}),id.gt.0` }), {
    code: 'JOURNAL_INVALID_CURSOR',
  });
});

test('rejects duplicate or out-of-order server rows rather than re-sorting them client-side', () => {
  const first = row(1);
  assert.throws(() => projectJournalPage([first, first], { actorId: ACTOR }), { code: 'JOURNAL_INVALID_DATA' });
  assert.throws(() => projectJournalPage([row(3), row(2)], { actorId: ACTOR }), { code: 'JOURNAL_INVALID_DATA' });
});

