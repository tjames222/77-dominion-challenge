import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { prepareRewardStartRequest } from './reward-start-request.mjs';
const actorId = '11111111-1111-4111-8111-111111111111';
const instanceId = '22222222-2222-4222-8222-222222222222';
const requestId = '33333333-3333-4333-8333-333333333333';
const catalog = () => ({ schemaVersion: 2, actorId, revision: 9,
  currentInstance: { id: instanceId, status: 'completed', reviewRequired: false, timeZone: 'America/Los_Angeles' },
  originalRepeat: { canStart: true }, items: [{ key: 'seven_day_reset', allowedActions: ['start'] },
    { key: 'twenty_one_day_prayer', allowedActions: [] }] });
const args = () => ({ catalog: catalog(), actorId, challengeKey: 'seven_day_reset',
  activation: { schemaVersion: 2, contractValid: true, actorId, revision: 9, serverDate: '2026-09-30',
    timeZone: 'America/Los_Angeles', reviewRequired: false, currentInstance: structuredClone(catalog().currentInstance) },
  createRequestId: () => requestId });

test('Start captures actor, exact completed run and CAS revision with a generated UUID', () => {
  const request = prepareRewardStartRequest(args());
  assert.equal(request.expectedUserId, actorId); assert.equal(request.expectedInstanceId, instanceId);
  assert.equal(request.expectedRevision, 9); assert.equal(request.requestId, requestId);
  assert.equal(request.startDate, '2026-09-30'); assert.equal(request.timeZone, 'America/Los_Angeles');
  assert.equal(Object.isFrozen(request), true);
});
test('uncertain retry retains request ID and timezone for the same actor/run/revision/challenge', () => {
  const previous = prepareRewardStartRequest(args());
  const next = args();
  Object.assign(next.activation, { serverDate: '2026-10-01', timeZone: 'UTC', revision: 10,
    currentInstance: { id: '55555555-5555-4555-8555-555555555555', status: 'active', timeZone: 'UTC' } });
  const retried = prepareRewardStartRequest({ ...next, previous, createRequestId: () => { throw new Error('must not mint retry UUID'); } });
  assert.equal(retried, previous); assert.equal(retried.timeZone, 'America/Los_Angeles');
  assert.equal(retried.startDate, '2026-09-30', 'midnight or a committed run must not rewrite the original request');
});
test('a different run, revision, challenge or actor cannot reuse the previous Start identity', () => {
  const previous = prepareRewardStartRequest(args());
  const nextId = '44444444-4444-4444-8444-444444444444';
  for (const patch of [value => { value.catalog.revision++; }, value => { value.catalog.currentInstance.id = nextId; },
    value => { value.challengeKey = 'original_77'; }, value => { value.actorId = nextId; value.catalog.actorId = nextId; }]) {
    const value = { ...args(), previous, createRequestId: () => nextId }; patch(value);
    Object.assign(value.activation, { actorId: value.actorId, revision: value.catalog.revision,
      currentInstance: structuredClone(value.catalog.currentInstance) });
    assert.equal(prepareRewardStartRequest(value).requestId, nextId);
  }
});
test('locked, active-run, review-required, wrong actor, stale V1, and malformed revision Start requests fail closed', () => {
  for (const patch of [value => { value.challengeKey = 'twenty_one_day_prayer'; }, value => { value.catalog.currentInstance.status = 'active'; },
    value => { value.catalog.currentInstance.reviewRequired = true; }, value => { value.actorId = 'other'; },
    value => { value.catalog.schemaVersion = 1; }, value => { value.catalog.revision = '9'; },
    value => { value.catalog.originalRepeat.canStart = false; value.challengeKey = 'original_77'; }]) {
    const value = args(); patch(value); assert.throws(() => prepareRewardStartRequest(value), /Reload/);
  }
});
test('invalid timezone and request UUID cannot start a run', () => {
  const value = args(); value.activation.timeZone = value.activation.currentInstance.timeZone = value.catalog.currentInstance.timeZone = 'not/a-zone';
  assert.throws(() => prepareRewardStartRequest(value), /time zone/);
  assert.throws(() => prepareRewardStartRequest({ ...args(), createRequestId: () => 'not-uuid' }), /request/);
});
test('fresh Start requires matching verified actor/run/revision and one valid server date/timezone', () => {
  for (const mutate of [value => { value.activation = null; }, value => { value.activation.contractValid = false; },
    value => { value.activation.actorId = 'other'; }, value => { value.activation.currentInstance.id = requestId; },
    value => { value.activation.revision++; }, value => { value.activation.currentInstance.status = 'active'; },
    value => { value.activation.reviewRequired = true; }, value => { value.activation.timeZone = 'UTC'; },
    value => { value.activation.currentInstance.timeZone = 'UTC'; },
    value => { value.activation.serverDate = null; }, value => { value.activation.serverDate = '2026-02-30'; }]) {
    const value = args(); mutate(value); assert.throws(() => prepareRewardStartRequest(value), /Reload/);
  }
});
test('route retains retry identity, clears it on account invalidation, disables all Starts and restores keyboard focus', () => {
  const source = readFileSync(new URL('./badges-rewards.js', import.meta.url), 'utf8');
  assert.match(source, /prepareRewardStartRequest\([\s\S]*previous: retryableStart/);
  assert.match(source, /function scrubAccountBoundPage\(\)[\s\S]*?retryableStart = null/);
  assert.match(source, /expectedInstanceId, expectedRevision,[\s\S]*requestId: request\.requestId/);
  assert.match(source, /const activation = await getChallengeActivation\(\{ expectedUserId \}\)/);
  assert.match(source, /startDate: request\.startDate/);
  assert.doesNotMatch(source, /startDate: null/);
  assert.match(source, /if \(pageActorId === expectedUserId\)[\s\S]*nextFocus\?\.focus\(\)/);
  const card = readFileSync(new URL('./reward-card.mjs', import.meta.url), 'utf8');
  assert.match(card, /pendingRewardKey \? ' disabled'/);
});
