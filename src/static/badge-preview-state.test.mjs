import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePreviewBadgeState,recordPreviewBadgeEvent,claimPreviewBadgeCelebrations,acknowledgePreviewBadgeCelebrations,previewBadgeCollection } from './badge-preview-state.mjs';
import { normalizeEarnedBadges } from './badges-rewards.mjs';

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
  assert.equal(restarted.items.find(r=>r.key==='original_77_completed').status,'blocked');
});
