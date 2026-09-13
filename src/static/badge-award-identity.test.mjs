import assert from 'node:assert/strict';
import test from 'node:test';
import { badgeAwardIdentity, normalizeEarnedBadges } from './badges-rewards.mjs';

test('award identity prefers immutable award ID and uses unambiguous key/scope legacy fallback',()=>{
  assert.equal(badgeAwardIdentity({id:'one',key:'badge',scope_key:'instance'}),'award:one');
  assert.equal(badgeAwardIdentity({awardId:'one',key:'badge'}),'award:one');
  assert.equal(badgeAwardIdentity({key:'badge'}),'badge:["badge","lifetime"]');
  assert.notEqual(badgeAwardIdentity({key:'a:b',scopeKey:'c'}),badgeAwardIdentity({key:'a',scopeKey:'b:c'}));
  assert.equal(badgeAwardIdentity(null),'');
});
test('scoped normalization preserves earned identity/evidence and does not collapse separate instances',()=>{
  const records=[{key:'seven_sealed',awardId:'legacy',scopeKey:'lifetime'},
    {key:'seven_sealed',awardId:'new',scopeKey:'original77:2026-01-01',requirement:'Seven consecutive days.',earningEvidence:{schemaVersion:1,kind:'perfect_streak',qualifyingValue:7}},
    {key:'seven_sealed',awardId:'new',scopeKey:'original77:2026-01-01'}];
  const normalized=normalizeEarnedBadges(records);
  assert.deepEqual(normalized.map(r=>r.awardId),['legacy','new']);
  assert.equal(normalized[1].scopeKey,'original77:2026-01-01');
  assert.equal(normalized[1].earningEvidence.qualifyingValue,7);
  assert.equal(normalized[1].requirement,'Seven consecutive days.');
  assert.equal(normalizeEarnedBadges([{key:'same'},{key:'same'}]).length,1);
});
