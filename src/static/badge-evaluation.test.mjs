import assert from 'node:assert/strict';
import test from 'node:test';
import { BADGE_CATALOG, badgeRuleMatches, checkInBadgeFacts, appVisitBadgeFacts, evaluateBadgeEvent, original77CompletionBadgeFacts } from './badge-evaluation.mjs';

const actions = ['bible','morningPrayer','worshipOnly','eveningPrayer','workoutOne','walk','workoutTwo'];
const event = (day, extra={}) => ({sourceId:`event-${day}`,localDate:new Date(Date.UTC(2026,0,day)).toISOString().slice(0,10),
  occurredAt:new Date(Date.UTC(2026,0,day,12)).toISOString(),challengeDay:day,completed:actions,...extra});
const history = (n) => Array.from({length:n},(_,i)=>event(i+1));
const completionInput = () => {
  const last = { ...event(78, { completed: ['walk'] }), source: 'check_in' };
  return { userId: 'preview-user-a', startDate: '2026-01-01', event: last,
    priorEvents: history(76).map(row => ({ ...row, source: 'check_in' })),
    completionEvent: { id: '10000000-0000-4000-8000-000000000077',
      userId: 'preview-user-a', startDate: '2026-01-01', sourceId: last.sourceId,
      localDate: last.localDate, recordedAt: last.occurredAt, persistedAt: '2026-03-19T12:00:00.000001Z' } };
};

test('catalog audits all31 old keys and activates only the canonical submission completion rule', () => {
  assert.equal(BADGE_CATALOG.filter((r)=>!r.key.startsWith('check_ins_')&&r.key!=='original_77_completed').length,31);
  assert.equal(new Set(BADGE_CATALOG.map(r=>r.key)).size,BADGE_CATALOG.length);
  assert.equal(BADGE_CATALOG.find(r=>r.key==='original_77_completed').status,'active');
  assert.equal(BADGE_CATALOG.find(r=>r.key==='day_77_finisher').status,'retired');
  for (const r of BADGE_CATALOG.filter(r=>r.status==='active')) {
    assert.equal(r.criteriaVersion,1); assert.ok(r.requirement); assert.ok(r.migrationTreatment); assert.ok(r.tierRationale);
    assert.equal(r.tierRank,{bronze:1,silver:2,gold:3}[r.tier]);
    if(['participation','perfect_streak','app_streak'].includes(r.series)) assert.ok(r.name.includes(String(r.threshold)));
  }
  for(const series of ['participation','perfect_streak','app_streak']) {
    const rules=BADGE_CATALOG.filter(r=>r.status==='active'&&r.series===series).sort((a,b)=>a.threshold-b.threshold);
    for(let i=1;i<rules.length;i++) assert.ok(rules[i].tierRank>=rules[i-1].tierRank);
  }
});
for (const rule of BADGE_CATALOG.filter(r=>r.status==='active')) {
  test(`${rule.key}: one before, exact, and one after the canonical predicate`, () => {
    const facts={source:rule.source,instanceId:'original77:2026-01-01',workouts:{}};
    if(rule.metric==='workout') {
      assert.equal(badgeRuleMatches(rule,facts),false);
      assert.equal(badgeRuleMatches(rule,{...facts,workouts:{[rule.predicate]:'one'}}),true);
      assert.equal(badgeRuleMatches(rule,{...facts,workouts:{invalid:'one'}}),false);
    } else if (rule.metric === 'original_77_completion') {
      const canonical = original77CompletionBadgeFacts(completionInput());
      assert.equal(badgeRuleMatches(rule, canonical), true);
      for (const delta of [-1, 0, 1]) assert.equal(badgeRuleMatches(rule, { ...canonical, [rule.metric]: rule.threshold + delta }), false);
    } else for(const delta of [-1,0,1]) assert.equal(badgeRuleMatches(rule,{...facts,[rule.metric]:rule.threshold+delta}),delta===0);
    assert.equal(badgeRuleMatches(rule,{...facts,source:'untrusted'}),false);
  });
}
test('first partial and first perfect award all foundations alongside explicit workouts', () => {
  const partial=checkInBadgeFacts(event(1,{completed:['workoutOne'],workoutDifficultySelections:{one:'medium'}}));
  assert.deepEqual(evaluateBadgeEvent(partial).map(r=>r.key),['faithful_start','honest_partial','steady_grind']);
  const perfect=checkInBadgeFacts(event(1,{workoutDifficultySelections:{one:'hard',two:'easy'}}));
  assert.deepEqual(evaluateBadgeEvent(perfect).map(r=>r.key),['faithful_start','iron_standard','first_sweat','hard_path']);
});
test('no guessed difficulty, calendar-day catch-up, or client completion award', () => {
  assert.ok(!evaluateBadgeEvent(checkInBadgeFacts(event(1))).some(r=>r.category==='workout'));
  assert.ok(!evaluateBadgeEvent(checkInBadgeFacts(event(77))).some(r=>r.key.startsWith('check_ins_')||r.key.includes('finisher')||r.key==='original_77_completed'));
  assert.deepEqual(evaluateBadgeEvent({...appVisitBadgeFacts(event(1)),source:'challenge_completion',original_77_completion:1,instanceId:'claimed-by-client'}),[]);
});
test('seven perfect posted days grant both exact count and perfect streak with original provenance', () => {
  const result=evaluateBadgeEvent(checkInBadgeFacts(event(7),history(6)));
  assert.deepEqual(result.map(r=>r.key),['seven_sealed','check_ins_7']);
  assert.equal(result[0].earnedAt,event(7).occurredAt);
  assert.equal(result[0].metadata.sourceRecordId,'event-7');
  assert.deepEqual(evaluateBadgeEvent(checkInBadgeFacts(event(8),history(7))),[]);
});
test('partial or missed local date resets perfect streak; app visits need no check-in', () => {
  const days=history(6); days[4]=event(5,{completed:['walk']});
  assert.equal(checkInBadgeFacts(event(7),days).perfect_streak,2);
  assert.equal(checkInBadgeFacts(event(7),history(5)).perfect_streak,1);
  assert.equal(evaluateBadgeEvent(appVisitBadgeFacts(event(3),history(2)))[0].key,'morning_watch');
  assert.equal(appVisitBadgeFacts(event(3),history(1)).app_streak,1);
});
test('scope, retries, contradictory records, and incomplete evidence fail safely', () => {
  const facts=checkInBadgeFacts(event(7),history(6)); const first=evaluateBadgeEvent(facts);
  assert.deepEqual(evaluateBadgeEvent(facts,first),[]);
  assert.equal(evaluateBadgeEvent({...facts,instanceId:'original77:2027-01-01'},first).length,2);
  assert.equal(checkInBadgeFacts(event(1),[event(1,{sourceId:'contradiction'})]),null);
  assert.equal(checkInBadgeFacts(event(1,{localDate:'2026-02-31'})),null);
  assert.deepEqual(evaluateBadgeEvent({...facts,sourceId:''}),[]);
});

test('late partial 77th INSERT awards one scoped Finisher with explicit immutable-event provenance', () => {
  const input = completionInput();
  const facts = original77CompletionBadgeFacts(input);
  assert.ok(facts);
  assert.equal(Object.isFrozen(facts), true);
  const [award] = evaluateBadgeEvent(facts);
  assert.equal(award.key, 'original_77_completed');
  assert.equal(award.scopeKey, 'original77:2026-01-01');
  assert.equal(award.earnedAt, input.event.occurredAt);
  assert.equal(award.entryDate, input.event.localDate);
  assert.equal(award.metadata.sourceRecordId, input.completionEvent.id);
  assert.equal(award.metadata.sourceCheckInId, input.event.sourceId);
  assert.deepEqual(award.earningEvidence, { schemaVersion: 1, kind: 'challenge_completion',
    completionKind: 'original_77_submissions', completionEventId: input.completionEvent.id,
    sourceCheckInId: input.event.sourceId, submittedCount: 77, targetCount: 77 });
  assert.deepEqual(evaluateBadgeEvent(facts, [award]), []);
  assert.deepEqual(evaluateBadgeEvent({ ...facts }), []);
  assert.deepEqual(evaluateBadgeEvent(JSON.parse(JSON.stringify(facts))), []);
  assert.equal(checkInBadgeFacts(input.event, input.priorEvents).instance_check_in_count, 77);
  assert.ok(!evaluateBadgeEvent(checkInBadgeFacts(input.event, input.priorEvents)).some(row => row.key === award.key));
});

test('completion uses the explicit insertion identity, never inferred timestamp order', () => {
  const input = completionInput();
  input.event.occurredAt = '2026-01-01T12:00:00.123456Z';
  input.completionEvent.recordedAt = input.event.occurredAt;
  input.completionEvent.persistedAt = '2026-01-01T11:00:00.000001Z';
  assert.equal(original77CompletionBadgeFacts(input).occurredAt, input.event.occurredAt);
  input.completionEvent.recordedAt = '2026-01-01T12:00:00.123455Z';
  assert.equal(original77CompletionBadgeFacts(input), null);
});

for (const [label, change] of [
  ['only 76 submissions', input => input.priorEvents.pop()],
  ['78 submissions', input => input.priorEvents.push({ ...event(77), source: 'check_in' })],
  ['wrong owner', input => { input.completionEvent.userId = 'other'; }],
  ['wrong scope', input => { input.completionEvent.startDate = '2026-01-02'; }],
  ['wrong source row', input => { input.completionEvent.sourceId = input.priorEvents[0].sourceId; }],
  ['wrong source date', input => { input.completionEvent.localDate = '2026-03-18'; }],
  ['invalid event ID', input => { input.completionEvent.id += '\n'; }],
  ['invalid owner ID', input => { input.userId += '\n'; input.completionEvent.userId = input.userId; }],
  ['unknown action', input => { input.priorEvents[0].completed = ['unknown']; }],
  ['empty actions', input => { input.priorEvents[0].completed = []; }],
  ['duplicate actions', input => { input.priorEvents[0].completed = ['walk', 'walk']; }],
  ['sparse actions', input => { input.priorEvents[0].completed = new Array(1); }],
  ['foreign event source', input => { input.priorEvents[0].source = 'app_visit'; }],
  ['duplicate event ID', input => { input.priorEvents[0].sourceId = input.event.sourceId; }],
  ['duplicate date', input => { input.priorEvents[0] = { ...input.event, sourceId: 'distinct' }; }],
  ['wrong ordinal', input => { input.priorEvents[0].challengeDay = 2; }],
  ['oversized ordinal', input => { input.event.challengeDay = Number.MAX_SAFE_INTEGER; }],
  ['zero ordinal', input => { input.event.challengeDay = 0; }],
  ['noncanonical date', input => { input.priorEvents[0].localDate = '2026-02-30'; }],
  ['invalid persisted time', input => { input.completionEvent.persistedAt = '2026-03-19T24:00:00Z'; }],
  ['unknown offset', input => { input.completionEvent.persistedAt = '2026-03-19T12:00:00-00:00'; }],
  ['invalid source time', input => { input.priorEvents[0].occurredAt = '0000-01-01T12:00:00Z'; }],
  ['extra context flag', input => { input.historical = true; }],
  ['extra event flag', input => { input.completionEvent.backfilled = true; }],
  ['sparse history', input => { delete input.priorEvents[0]; }],
]) {
  test(`Finisher INSERT adapter rejects ${label}`, () => {
    const input = completionInput(); change(input);
    assert.equal(original77CompletionBadgeFacts(input), null);
  });
}

test('Finisher adapter does not invoke accessor-backed evidence', () => {
  let reads = 0;
  for (const target of ['context', 'row', 'completion', 'history', 'actions']) {
    const input = completionInput();
    const [object, field] = target === 'context' ? [input, 'event']
      : target === 'row' ? [input.event, 'sourceId']
      : target === 'completion' ? [input.completionEvent, 'recordedAt']
      : target === 'history' ? [input.priorEvents, '0'] : [input.event.completed, '0'];
    Object.defineProperty(object, field, { enumerable: true, get() { reads++; throw new Error('not data'); } });
    assert.equal(original77CompletionBadgeFacts(input), null);
  }
  assert.equal(reads, 0);
});

test('positive calendar ordinals are date-bounded without a day-77 cap', () => {
  assert.equal(checkInBadgeFacts(event(78)).instanceId, 'original77:2026-01-01');
  for (const day of [0, -1, 1.5, Number.MAX_SAFE_INTEGER, Infinity, '78']) {
    assert.equal(checkInBadgeFacts(event(78, { challengeDay: day })), null);
  }
});
