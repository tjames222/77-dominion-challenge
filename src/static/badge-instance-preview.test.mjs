import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizePreviewBadgeState, recordPreviewInstanceBadgeEvent, previewBadgeCollection,
  claimPreviewBadgeCelebrations, acknowledgePreviewBadgeCelebrations } from './badge-preview-state.mjs';
import { checkInBadgeFacts, instanceCompletionBadgeFacts, evaluateBadgeEvent } from './badge-evaluation.mjs';
const userId = 'preview-instance-owner';
const uuid = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const date = (start, day) => new Date(Date.parse(`${start}T00:00:00Z`) + (day - 1) * 86400000).toISOString().slice(0, 10);
function fixture({ sequence = 1, challengeKey = 'original_77', targetCount = 77,
  submittedCount = targetCount, startDate = '2026-01-01', spacing = 2 } = {}) {
  const id = uuid(sequence); const scopeKey = `instance:${id}`;
  const events = Array.from({ length: submittedCount }, (_, index) => {
    const day = index * spacing + 1; const localDate = date(startDate, day);
    return { source: 'check_in', sourceId: uuid(sequence * 1000 + index), localDate, occurredAt: `${localDate}T12:00:00.000001Z`,
      challengeDay: day, completed: ['walk'], workoutDifficultySelections: {}, instanceId: id, scopeKey };
  });
  const event = events.at(-1); const complete = submittedCount === targetCount;
  const run = { id, challengeKey, title: challengeKey, scopeKey, status: complete ? 'completed' : 'active', startDate,
    timeZone: 'UTC', mode: 'solo', crewId: null, targetCount, submittedCount, calendarDay: event.challengeDay,
    completedAt: complete ? event.occurredAt : null, completionEventId: complete ? uuid(sequence + 9000) : null,
    provenance: 'live', reviewRequired: false };
  const completionEvidence = complete ? { kind: 'canonical_instance_completion', userId, challengeKey, instanceId: id,
    eventId: run.completionEventId, sourceCheckInId: event.sourceId, submittedCount, targetCount,
    completedAt: event.occurredAt, persistedAt: event.occurredAt } : null;
  return { userId, run, event, priorInstanceCheckIns: events.slice(0, -1), completionEvidence };
}
const context = input => ({ userId: input.userId, run: input.run, priorInstanceCheckIns: input.priorInstanceCheckIns, completionEvidence: input.completionEvidence });
const seed = input => normalizePreviewBadgeState({ schemaVersion: 1, awards: [], visits: [], completionEvents: [], checkIns: input.priorInstanceCheckIns });

test('late partial final insertion awards exactly one UUID-scoped Finisher and keeps explicit provenance', () => {
  const input = fixture(); const state = seed(input);
  const awards = recordPreviewInstanceBadgeEvent(state, input.event, context(input));
  const finisher = awards.find(row => row.key === 'original_77_completed');
  assert.ok(finisher); assert.equal(finisher.scopeKey, input.run.scopeKey);
  assert.equal(finisher.metadata.sourceRecordId, input.completionEvidence.eventId);
  assert.equal(finisher.earningEvidence.sourceCheckInId, input.event.sourceId);
  assert.equal(state.checkIns.length, 77); assert.equal(state.completionEvents.length, 1);
  const after = structuredClone(state);
  assert.deepEqual(recordPreviewInstanceBadgeEvent(state, input.event, context(input)), []);
  assert.deepEqual(state, after);
});

test('second original run earns its own Finisher while preserving first award and acknowledgement', () => {
  const first = fixture(); const second = fixture({ sequence: 2, startDate: '2026-07-01' });
  const state = seed(first); recordPreviewInstanceBadgeEvent(state, first.event, context(first));
  const initial = state.awards.find(row => row.key === 'original_77_completed');
  claimPreviewBadgeCelebrations(state, 'first', 0);
  acknowledgePreviewBadgeCelebrations(state, 'first', [initial.awardId], 1);
  const initialSnapshot = structuredClone(initial);
  state.checkIns.push(...structuredClone(second.priorInstanceCheckIns));
  const newAwards = recordPreviewInstanceBadgeEvent(state, second.event, context(second));
  assert.equal(newAwards.filter(row => row.key === 'original_77_completed').length, 1);
  assert.equal(state.awards.filter(row => row.key === 'original_77_completed').length, 2);
  assert.deepEqual(initial, initialSnapshot);
  assert.notEqual(initial.awardId, newAwards.find(row => row.key === 'original_77_completed').awardId);
  assert.deepEqual(claimPreviewBadgeCelebrations(state, 'next', 200000).filter(row => row.key === 'original_77_completed').map(row => row.scopeKey), [second.run.scopeKey]);
});

test('collection and count facts use current UUID scope, not earlier original run or reconstructed calendar date', () => {
  const old = fixture(); const fresh = fixture({ sequence: 2, startDate: '2026-07-01', submittedCount: 1 });
  const state = seed(old); recordPreviewInstanceBadgeEvent(state, old.event, context(old));
  recordPreviewInstanceBadgeEvent(state, fresh.event, context(fresh));
  const facts = checkInBadgeFacts(fresh.event, state.checkIns);
  assert.equal(facts.check_in_count, 78); assert.equal(facts.instance_check_in_count, 1);
  const before = structuredClone(state);
  const collection = previewBadgeCollection(state, { schemaVersion: 2, currentInstance: fresh.run }, fresh.event.localDate);
  assert.equal(collection.scopeKey, fresh.run.scopeKey);
  assert.equal(collection.items.find(row => row.key === 'check_ins_7').progress.current, 1);
  assert.equal(collection.items.find(row => row.key === 'original_77_completed').earnedInCurrentScope, false);
  assert.deepEqual(state, before);
});

test('later-track completion never creates an original77 Finisher or fabricated original scope', () => {
  const input = fixture({ challengeKey: 'seven_day_reset', targetCount: 7 }); const state = seed(input);
  const awards = recordPreviewInstanceBadgeEvent(state, input.event, context(input));
  assert.ok(awards.some(row => row.key === 'check_ins_7'));
  assert.equal(awards.some(row => row.key === 'original_77_completed'), false);
  assert.equal(instanceCompletionBadgeFacts(context(input)), null);
  assert.ok(awards.filter(row => row.scopeKey !== 'lifetime').every(row => row.scopeKey === input.run.scopeKey));
});

test('imported original scope remains unchanged for its actual new final insertion', () => {
  const input = fixture(); input.run.scopeKey = `original77:${input.run.startDate}`; input.run.provenance = 'legacy_bound';
  input.event.scopeKey = input.run.scopeKey; input.priorInstanceCheckIns.forEach(row => { row.scopeKey = input.run.scopeKey; });
  const state = seed(input); const awards = recordPreviewInstanceBadgeEvent(state, input.event, context(input));
  assert.equal(awards.find(row => row.key === 'original_77_completed').scopeKey, input.run.scopeKey);
});

test('a copied completion metric is not an insert-backed Finisher capability', () => {
  const input = fixture(); const facts = instanceCompletionBadgeFacts({ ...context(input), event: input.event });
  assert.ok(facts); assert.equal(evaluateBadgeEvent(facts).length, 1);
  assert.deepEqual(evaluateBadgeEvent({ ...facts }), []);
  assert.deepEqual(evaluateBadgeEvent(JSON.parse(JSON.stringify(facts))), []);
});

for (const [name, mutate] of [
  ['wrong owner', input => { input.completionEvidence.userId = 'other'; }],
  ['wrong run', input => { input.event.instanceId = uuid(90); }],
  ['invented scope', input => { input.event.scopeKey = 'instance:invented'; }],
  ['wrong source', input => { input.completionEvidence.sourceCheckInId = uuid(900); }],
  ['wrong count', input => { input.completionEvidence.submittedCount = 76; }],
  ['short history', input => { input.priorInstanceCheckIns.pop(); }],
  ['cross-instance history', input => { input.priorInstanceCheckIns[0].instanceId = uuid(90); }],
  ['duplicate prior row', input => { input.priorInstanceCheckIns[1] = input.priorInstanceCheckIns[0]; }],
  ['invalid standards', input => { input.event.completed = ['walk', 'walk']; }],
  ['legacy completed without canonical event', input => { input.run.provenance = 'legacy_completed'; input.run.completionEventId = null; }],
  ['wrong persisted timestamp', input => { input.completionEvidence.persistedAt = 'bad'; }],
]) test(`reject ${name} without modifying history or awards`, () => {
  const input = fixture(); const state = seed(input); const before = structuredClone(state); mutate(input);
  assert.throws(() => recordPreviewInstanceBadgeEvent(state, input.event, context(input)), /verified/);
  assert.deepEqual(state, before);
});

test('same global date in a different run is rejected even if a client invents a new UUID', () => {
  const input = fixture({ submittedCount: 1 }); const state = normalizePreviewBadgeState(null);
  recordPreviewInstanceBadgeEvent(state, input.event, context(input));
  const next = fixture({ sequence: 2, submittedCount: 1 }); const before = structuredClone(state);
  assert.throws(() => recordPreviewInstanceBadgeEvent(state, next.event, context(next)), /verified/);
  assert.deepEqual(state, before);
});
