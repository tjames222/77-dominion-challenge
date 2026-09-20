import assert from 'node:assert/strict';
import test from 'node:test';
import { BADGE_CATALOG, badgeRuleMatches, checkInBadgeFacts, appVisitBadgeFacts, evaluateBadgeEvent } from './badge-evaluation.mjs';

const actions = ['bible','morningPrayer','worshipOnly','eveningPrayer','workoutOne','walk','workoutTwo'];
const event = (day, extra={}) => ({sourceId:`event-${day}`,localDate:new Date(Date.UTC(2026,0,day)).toISOString().slice(0,10),
  occurredAt:new Date(Date.UTC(2026,0,day,12)).toISOString(),challengeDay:day,completed:actions,...extra});
const history = (n) => Array.from({length:n},(_,i)=>event(i+1));

test('catalog audits all31 old keys and explicitly blocks undefined completion', () => {
  assert.equal(BADGE_CATALOG.filter((r)=>!r.key.startsWith('check_ins_')&&r.key!=='original_77_completed').length,31);
  assert.equal(new Set(BADGE_CATALOG.map(r=>r.key)).size,BADGE_CATALOG.length);
  assert.equal(BADGE_CATALOG.find(r=>r.key==='original_77_completed').status,'blocked');
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
