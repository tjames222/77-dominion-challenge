import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyOriginal77Progress, normalizeOriginal77Progress, previewOriginal77Progress, original77TimestampValid } from './original-77-progress.mjs';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const startDate = '2026-01-01';
const context = { userId, startDate };
const event = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', sourceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  localDate: '2026-04-01', recordedAt: '2026-04-01T12:00:00.000002+00:00', persistedAt: '2026-04-01T12:00:00.000001Z' };
const progress = (count, completionState = count === 77 ? 'historical_provenance_pending' : 'in_progress', canonicalEvent = null) => ({
  ...emptyOriginal77Progress(userId, startDate), submittedCount: count, completionState, canonicalEvent,
});
const row = (day) => ({ source: 'check_in', sourceId: `preview-check-in:${new Date(Date.UTC(2026, 0, day)).toISOString().slice(0, 10)}`,
  localDate: new Date(Date.UTC(2026, 0, day)).toISOString().slice(0, 10), occurredAt: new Date(Date.UTC(2026, 0, day, 12)).toISOString(),
  challengeDay: day, completed: ['walk'] });

test('progress preserves strict counts and live source/write timestamps without inferring order', () => {
  for (const count of [0, 1, 76, 77]) assert.equal(normalizeOriginal77Progress(progress(count), context).submittedCount, count);
  const raw = progress(77, 'live_completed', event);
  const normalized = normalizeOriginal77Progress(raw, context);
  assert.deepEqual(normalized, raw); assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.canonicalEvent), true);
  raw.canonicalEvent = null; assert.equal(normalized.canonicalEvent.recordedAt, event.recordedAt);
  assert.equal(normalizeOriginal77Progress(progress(null, 'invalid_evidence'), context).submittedCount, null);
});
test('wrong actor/scope, coerced counts, overflow, and contradictory states fail closed', () => {
  for (const patch of [{ userId: 'another-owner' }, { instanceId: 'original77:2026-01-02' }, { schemaVersion: 2 },
    { targetCount: '77' }, { submittedCount: '76' }, { submittedCount: -1 }, { submittedCount: 78 },
    { submittedCount: 0.5 }, { submittedCount: null }, { submittedCount: NaN }, { submittedCount: Infinity },
    { completionState: 'finished' }, { canonicalEvent: event }, { unexpected: true }]) {
    assert.equal(normalizeOriginal77Progress({ ...progress(76), ...patch }, context), null, JSON.stringify(patch));
  }
  for (const raw of [progress(77, 'in_progress'), progress(76, 'historical_provenance_pending'), progress(77, 'live_completed'),
    progress(0, 'invalid_evidence'), progress(null, 'invalid_evidence', event)]) assert.equal(normalizeOriginal77Progress(raw, context), null);
});
test('completion requires exact finite source provenance; preview source strings are explicitly isolated', () => {
  for (const patch of [{ id: '' }, { sourceId: '' }, { localDate: '2026-02-30' }, { localDate: '2025-12-31' },
    { recordedAt: 'infinity' }, { persistedAt: '2026-02-30T00:00:00Z' }, { recordedAt: '0000-01-01T00:00:00Z' },
    { persistedAt: '10000-01-01T00:00:00Z' }, { recordedAt: '2026-01-01T24:00:00Z' }, { extra: 1 },
    { id: `${event.id}\n` }, { sourceId: `${event.sourceId}\n` }, { recordedAt: `${event.recordedAt}\n` }]) {
    assert.equal(normalizeOriginal77Progress(progress(77, 'live_completed', { ...event, ...patch }), context), null);
  }
  const preview = progress(77, 'live_completed', { ...event, sourceId: 'preview-check-in:2026-04-01' });
  assert.equal(normalizeOriginal77Progress(preview, context), null);
  assert.equal(normalizeOriginal77Progress(preview, { ...context, preview: true }).completionState, 'live_completed');
  for (const sourceId of ['has spaces', 'a'.repeat(161), 'newline\n']) {
    assert.equal(normalizeOriginal77Progress(progress(77, 'live_completed', { ...event, sourceId }), { ...context, preview: true }), null);
  }
  const accessor = { ...progress(76) }; Object.defineProperty(accessor, 'submittedCount', { enumerable: true, get() { throw Error('called'); } });
  assert.equal(normalizeOriginal77Progress(accessor, context), null);
  assert.equal(original77TimestampValid('0001-01-01T00:00:00+00:01'), false);
  assert.equal(original77TimestampValid('9999-12-31T23:59:59-00:01'), false);
});
test('late partial preview rows count; history alone never creates completion provenance', () => {
  const state = { schemaVersion: 1, checkIns: Array.from({ length: 77 }, (_, index) => row(index * 2 + 1)), completionEvents: [] };
  assert.equal(previewOriginal77Progress(state, context).completionState, 'historical_provenance_pending');
  assert.equal(previewOriginal77Progress(state, context).canonicalEvent, null);
  const source = state.checkIns.at(-1);
  state.completionEvents.push({ id: event.id, userId, startDate, sourceId: source.sourceId, localDate: source.localDate,
    recordedAt: source.occurredAt, persistedAt: event.persistedAt });
  assert.equal(previewOriginal77Progress(state, context).completionState, 'live_completed');
  state.completionEvents[0].userId = 'other';
  assert.equal(previewOriginal77Progress(state, context).completionState, 'invalid_evidence');
});
test('invalid preview history is not silently filtered, clamped, or replaced by legacy counters', () => {
  for (const rows of [[row(1), row(1)], [null], [{ ...row(1), completed: ['walk', 'walk'] }],
    [{ ...row(1), challengeDay: 2 }], [{ ...row(1), occurredAt: 'bad' }], Array.from({ length: 78 }, (_, i) => row(i + 1))]) {
    assert.equal(previewOriginal77Progress({ schemaVersion: 1, checkIns: rows }, context).completionState, 'invalid_evidence');
  }
  assert.equal(previewOriginal77Progress({ schemaVersion: 1, checkIns: [], day: 78, totalPoints: 99999 }, context).submittedCount, 0);
});
