import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePreviewBadgeState,recordPreviewBadgeEvent,claimPreviewBadgeCelebrations,acknowledgePreviewBadgeCelebrations,previewBadgeCollection } from './badge-preview-state.mjs';
import { normalizeEarnedBadges } from './badges-rewards.mjs';
import { previewOriginal77Progress } from './original-77-progress.mjs';

const userId = 'preview-owner';
const startDate = '2026-01-01';
const posted = (ordinal) => {
  const localDate = new Date(Date.UTC(2026, 0, ordinal)).toISOString().slice(0, 10);
  return { source: 'check_in', sourceId: `preview-check-in:${localDate}`, localDate, occurredAt: `${localDate}T12:00:00.000001Z`,
    challengeDay: ordinal, completed: ['walk'] };
};
const completionContext = { userId, startDate,
  createEventId: () => 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', now: () => '2026-06-03T12:00:00.000002Z' };

test('new late partial 77th insertion atomically persists distinct event provenance and one Finisher', () => {
  const state = normalizePreviewBadgeState({ schemaVersion: 1, awards: [], visits: [],
    checkIns: Array.from({ length: 76 }, (_, i) => posted(i * 2 + 1)) });
  const before = structuredClone(state);
  assert.deepEqual(state.completionEvents, []);
  const event = posted(153);
  const awards = recordPreviewBadgeEvent(state, event, completionContext);
  assert.equal(before.checkIns.length, 76);
  assert.equal(state.checkIns.length, 77);
  assert.equal(state.completionEvents.length, 1);
  assert.equal(state.completionEvents[0].sourceId, event.sourceId);
  assert.notEqual(state.completionEvents[0].id, event.sourceId);
  const finisher = awards.find((award) => award.key === 'original_77_completed');
  assert.ok(finisher); assert.equal(finisher.earnedAt, event.occurredAt);
  assert.equal(finisher.metadata.sourceRecordId, state.completionEvents[0].id);
  assert.equal(previewOriginal77Progress(state, { userId, startDate }).completionState, 'live_completed');
  const committed = structuredClone(state);
  assert.deepEqual(recordPreviewBadgeEvent(state, event, completionContext), []);
  assert.deepEqual(state, committed);
  assert.throws(() => recordPreviewBadgeEvent(state, posted(154), completionContext), /cannot accept/);
  assert.deepEqual(state, committed);
  const claim = claimPreviewBadgeCelebrations(state, 'claim', 0).find((award) => award.key === 'original_77_completed');
  assert.ok(claim);
  acknowledgePreviewBadgeCelebrations(state, 'claim', [claim.awardId], 1);
  assert.equal(claimPreviewBadgeCelebrations(normalizePreviewBadgeState(state), 'later', 200000).some((award) => award.key === 'original_77_completed'), false);
});
test('history, legacy simulator counters, and reading collections cannot create completion or replay', () => {
  const state = normalizePreviewBadgeState({ schemaVersion: 1, awards: [], visits: [], checkIns: Array.from({ length: 77 }, (_, i) => posted(i + 1)), day: 78 });
  const before = structuredClone(state);
  assert.equal(previewOriginal77Progress(state, { userId, startDate }).completionState, 'historical_provenance_pending');
  previewBadgeCollection(state, { startDate }, '2026-03-18');
  assert.deepEqual(state, before);
  assert.throws(() => recordPreviewBadgeEvent(state, posted(78), completionContext), /cannot accept/);
  assert.deepEqual(state, before);
});
test('invalid completion context and malformed new evidence leave all local state untouched', () => {
  const prior = { schemaVersion: 1, awards: [], visits: [], checkIns: Array.from({ length: 76 }, (_, i) => posted(i + 1)) };
  for (const [event, context] of [[posted(78), { ...completionContext, startDate: '2026-01-02' }],
    [{ ...posted(78), completed: ['walk', 'walk'] }, completionContext],
    [posted(78), { ...completionContext, createEventId: () => 'not-a-uuid' }],
    [posted(78), { ...completionContext, now: () => 'infinity' }]]) {
    const state = normalizePreviewBadgeState(prior); const before = structuredClone(state);
    assert.throws(() => recordPreviewBadgeEvent(state, event, context)); assert.deepEqual(state, before);
  }
  const malformed = normalizePreviewBadgeState({ ...prior, checkIns: [...prior.checkIns, null] });
  assert.equal(malformed.checkIns.length, 77);
  assert.equal(previewOriginal77Progress(malformed, { userId, startDate }).completionState, 'invalid_evidence');
});

test('legacy previews never fabricate provenance or generate migration celebrations',()=>{
  const state=normalizePreviewBadgeState(null,[{key:'old',earnedAt:'2026-01-01T12:00:00Z'}]);
  assert.equal(state.awards[0].legacy,true);assert.equal(claimPreviewBadgeCelebrations(state,'token').length,0);
});
test('committed preview events are idempotent and claims recover until acknowledged',()=>{
  const state=normalizePreviewBadgeState(null);
  const event={source:'check_in',sourceId:'one',localDate:'2026-01-01',occurredAt:'2026-01-01T12:00:00Z',challengeDay:1,completed:['walk']};
  assert.equal(recordPreviewBadgeEvent(state,event).length,2);
  assert.equal(recordPreviewBadgeEvent(state,event).length,0);
  const claimed=claimPreviewBadgeCelebrations(state,'one',0);assert.equal(claimed.length,2);
  assert.equal(claimPreviewBadgeCelebrations(state,'two',0).length,0);
  assert.equal(claimPreviewBadgeCelebrations(state,'one',100).length,2);
  acknowledgePreviewBadgeCelebrations(state,'wrong',[claimed[0].awardId],100);
  assert.equal(claimPreviewBadgeCelebrations(state,'three',130000).length,2);
  acknowledgePreviewBadgeCelebrations(state,'three',[claimed[0].awardId],130001);
  assert.equal(claimPreviewBadgeCelebrations(state,'three',130002).length,1);
});
test('earned collection preserves distinct scoped awards and deduplicates a retried record',()=>{
  const records=[{key:'seven_sealed',scopeKey:'lifetime',awardId:'legacy'},{key:'seven_sealed',scopeKey:'original77:2026-01-01',awardId:'new'}, {key:'seven_sealed',scopeKey:'original77:2026-01-01',awardId:'new'}];
  assert.deepEqual(normalizeEarnedBadges(records).map(r=>r.awardId),['legacy','new']);
});
test('legacy preview migration preserves different scopes even without stable award IDs',()=>{
  const state=normalizePreviewBadgeState(null,[{key:'seven_sealed',scopeKey:'lifetime'},{key:'seven_sealed',scopeKey:'original77:2026-01-01'}]);
  assert.equal(normalizeEarnedBadges(state.awards).length,2);
  assert.notEqual(state.awards[0].awardId,state.awards[1].awardId);
});
test('collection progress is from committed events in the active scope, not old totals',()=>{
  const state=normalizePreviewBadgeState(null);
  recordPreviewBadgeEvent(state,{source:'check_in',sourceId:'one',localDate:'2026-01-01',occurredAt:'2026-01-01T12:00:00Z',challengeDay:1,completed:['walk']});
  const original=previewBadgeCollection(state,{startDate:'2026-01-01'},'2026-01-01');
  assert.equal(original.items.find(r=>r.key==='check_ins_7').progress.current,1);
  const restarted=previewBadgeCollection(state,{startDate:'2026-01-02'},'2026-01-02');
  assert.equal(restarted.items.find(r=>r.key==='check_ins_7').progress.current,0);
  assert.equal(restarted.items.find(r=>r.key==='streak_flame').progress.current,0);
  assert.equal(restarted.items.some(r=>r.key==='day_77_finisher'),false);
  assert.equal(restarted.items.find(r=>r.key==='original_77_completed').status,'active');
  assert.equal(restarted.items.find(r=>r.key==='original_77_completed').earnedInCurrentScope,false);
  assert.deepEqual(state.completionEvents, []);
});
