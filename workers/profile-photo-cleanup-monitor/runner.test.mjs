import assert from 'node:assert/strict';
import test from 'node:test';
import { STATE_KEY } from './constants.mjs';
import { parseHealth } from './core.mjs';
import { runTick } from './runner.mjs';
import { BASE, SECRET, healthBody } from './test-fixtures.mjs';

function fixture() {
  const values = new Map(); let synced = false;
  const storage = { async get(key) { return structuredClone(values.get(key)); },
    async put(key, state) {
      if (typeof key === 'object') for (const [k, v] of Object.entries(key)) values.set(k, structuredClone(v));
      else values.set(key, structuredClone(state));
      synced = false;
    },
    async sync() { synced = true; }, value: () => structuredClone(values.get(STATE_KEY)), synced: () => synced };
  return { storage, env: { ALERTS_ENABLED: 'true', PROFILE_PHOTO_HEALTH_SECRET: SECRET } };
}
test('intent and quota are physically synchronized before email, then acceptance is persisted', async () => {
  const f = fixture(); let sends = 0;
  const result = await runTick(f.storage, f.env, BASE, { now: () => BASE,
    healthReader: async () => parseHealth(healthBody(BASE, 101), BASE),
    sender: async (_, intent) => {
      sends++; assert.equal(f.storage.synced(), true);
      assert.deepEqual(f.storage.value().notification, intent);
      assert.equal(f.storage.value().daily.count, 1);
      return { status: 'accepted', messageId: 'fixture-message-1' };
    },
  });
  assert.equal(sends, 1); assert.equal(result.notificationStatus, 'accepted');
  assert.equal(f.storage.value().notification.status, 'accepted');
});
test('crash after mail starts recovers unknown, blocks mail, and exact config acknowledgment never retries', async () => {
  const f = fixture(); let sends = 0;
  const deps = { now: () => BASE, healthReader: async () => parseHealth(healthBody(BASE, 101), BASE),
    sender: async () => { sends++; throw new Error('Simulated isolate termination'); } };
  await assert.rejects(runTick(f.storage, f.env, BASE, deps));
  assert.equal(f.storage.value().notification.status, 'sending');
  let result = await runTick(f.storage, f.env, BASE, deps);
  assert.equal(result.ignored, true); assert.equal(result.notificationStatus, 'delivery_unknown');
  assert.equal(result.status, 'needs_review'); assert.equal(sends, 1);
  result = await runTick(f.storage, { ...f.env, MONITOR_RECONCILE_NOTIFICATION: 'cleanup-1-open' }, BASE, deps);
  assert.equal(result.status, 'observed'); assert.equal(result.notificationStatus, 'delivery_unknown');
  assert.equal(result.dailyCount, 1); assert.equal(sends, 1);
});
test('duplicate schedule skips health and mail; malformed persisted data fails closed without reset', async () => {
  const f = fixture();
  const deps = { now: () => BASE, healthReader: async () => parseHealth(healthBody(), BASE) };
  await runTick(f.storage, f.env, BASE, deps);
  assert.equal((await runTick(f.storage, f.env, BASE, { ...deps, healthReader: () => { throw new Error('Should not poll'); } })).ignored, true);
  await f.storage.put(STATE_KEY, { corrupt: true });
  await assert.rejects(runTick(f.storage, f.env, BASE, deps));
  assert.deepEqual(f.storage.value(), { corrupt: true });
});
test('different second offsets in one scheduled minute never repeat health reads or reserve another notice', async () => {
  const f = fixture(); let reads = 0, sends = 0;
  for (const [index, offset] of [35_000,55_000,59_999,1,0].entries()) {
    const at = BASE + offset;
    const result = await runTick(f.storage, f.env, at, { now: () => BASE + 60_000,
      healthReader: async () => { reads++; return parseHealth(healthBody(BASE + 60_000, 101), BASE + 60_000); },
      sender: async () => { sends++; return { status: 'accepted', messageId: 'fixture-message-1' }; } });
    assert.equal(result.ignored, index > 0);
    assert.equal(result.dailyCount, 1);
    assert.equal(f.storage.value().lastSlot, Math.floor(BASE / 300_000));
    assert.equal(reads, 1); assert.equal(sends, 1);
  }
});
test('jittered duplicate schedules cannot supply the second consecutive health failure', async () => {
  const f = fixture(); let reads = 0, sends = 0;
  const tick = at => runTick(f.storage, f.env, at, { now: () => at,
    healthReader: async () => { reads++; return null; },
    sender: async () => { sends++; return { status: 'accepted', messageId: 'fixture-message-1' }; } });
  assert.equal((await tick(BASE + 35_000)).notificationId, null);
  assert.equal((await tick(BASE + 55_000)).ignored, true);
  assert.equal(reads, 1); assert.equal(sends, 0);
  const second = await tick(BASE + 300_000 + 35_000);
  assert.deepEqual(second.conditionCodes, ['health_unavailable']);
  assert.equal(reads, 2); assert.equal(sends, 1);
});
test('observe-only state still evaluates incidents but never invokes email', async () => {
  const f = fixture();
  const result = await runTick(f.storage, { ...f.env, ALERTS_ENABLED: 'false' }, BASE, { now: () => BASE,
    healthReader: async () => parseHealth(healthBody(BASE, 101), BASE), sender: () => { throw new Error('Should not send'); } });
  assert.deepEqual(result.conditionCodes, ['ready_backlog']); assert.equal(result.dailyCount, 0);
});
