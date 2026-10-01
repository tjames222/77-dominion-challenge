import assert from 'node:assert/strict';
import test from 'node:test';
import { createDailyActionBootstrapClient, normalizeDailyActionBootstrap } from './daily-action-bootstrap.mjs';
import { instanceBootstrapFixture, INSTANCE_ACTOR as actor, INSTANCE_ID as id } from '../../tests/fixtures/challenge-instance.mjs';

test('V2 bootstrap binds its activation and draft to the same current run', () => {
  const result = normalizeDailyActionBootstrap(instanceBootstrapFixture(), actor);
  assert.equal(result.instanceId, id);
  assert.equal(result.activation.currentInstance.submittedCount, 76);
  assert.equal(result.draft.instanceId, id);
  assert.equal(result.draft.actorId, actor);
  assert.equal(result.draft.schemaVersion, 2);
});

test('V2 bootstrap rejects mixed actor, run, version, revision and nested authority', () => {
  for (const alter of [
    v => { v.instanceId = null; },
    v => { v.draft.instanceId = null; },
    v => { v.draft.actorId = 'another-actor'; },
    v => { v.draft.schemaVersion = 1; },
    v => { v.draft.activation.revision += 1; },
    v => { v.draft.activation.currentInstance.submittedCount -= 1; },
    v => { v.draft.activation.canMutateDailyStandards = false; },
    v => { v.draft.activation.currentInstance.scopeKey = 'instance:other'; },
  ]) {
    const raw = instanceBootstrapFixture(); alter(raw);
    assert.throws(() => normalizeDailyActionBootstrap(raw, actor));
  }
});

test('V2 read carries captured run and rejects a different run even with a valid response', async () => {
  const requests = [];
  const client = createDailyActionBootstrapClient({
    getSession: async () => ({ user: { id: actor }, id: 'session' }),
    getUser: async () => ({ id: actor }), sessionIdentity: value => value.id,
    requiresMfa: async () => false,
    request: async args => { requests.push(args); return instanceBootstrapFixture(); },
  });
  const args = { expectedUserId: actor, timeZone: 'UTC', expectedInstanceId: id };
  assert.equal((await client.read(args)).instanceId, id);
  assert.equal(requests[0].target_expected_instance_id, id);
  await assert.rejects(client.read({ ...args, expectedInstanceId: '33333333-3333-4333-8333-333333333333' }), { code: 'DAILY_ACTION_CHANGED' });
  await assert.rejects(client.read({ ...args, expectedInstanceId: 'invalid' }), { code: 'DAILY_ACTION_INVALID_INPUT' });
  assert.equal(requests.length, 2);
  client.destroy();
});

test('V2 denied bootstrap cannot smuggle a run identifier or private draft', () => {
  const raw = { schemaVersion: 2, actorId: actor, appAccess: false, asOf: '2026-09-30T12:00:00Z',
    instanceId: null, activation: null, timeZone: null, entryDate: null, draft: null };
  assert.equal(normalizeDailyActionBootstrap(raw, actor).instanceId, null);
  assert.throws(() => normalizeDailyActionBootstrap({ ...raw, instanceId: id }, actor));
  assert.throws(() => normalizeDailyActionBootstrap({ ...raw, draft: {} }, actor));
});

test('V2 not-started bootstrap returns no run or draft and cannot expose writable data', () => {
  const raw = instanceBootstrapFixture();
  raw.instanceId = null; raw.draft = null;
  Object.assign(raw.activation, { status: 'not_started', mode: null, startDate: null, timeZone: null,
    currentInstance: null, canParticipate: false, canMutateDailyStandards: false,
    canActivateSolo: true, canActivateGroup: true,
    originalRepeat: { challengeKey: 'original_77', targetCount: 77, available: false, canStart: false, reason: 'original_not_completed' } });
  const result = normalizeDailyActionBootstrap(raw, actor);
  assert.equal(result.draft, null);
  assert.equal(result.activation.currentInstance, null);
  assert.throws(() => normalizeDailyActionBootstrap({ ...raw, instanceId: id }, actor));
  assert.throws(() => normalizeDailyActionBootstrap({ ...raw, draft: instanceBootstrapFixture().draft }, actor));
});
