import assert from 'node:assert/strict';
import test from 'node:test';
import { DAILY_LIMIT, SELF_TEST_ID, SELF_TEST_KEY, STATE_KEY } from './constants.mjs';
import { initialState, parseHealth, renderNotification } from './core.mjs';
import { runTick } from './runner.mjs';
import { BASE, healthBody } from './test-fixtures.mjs';

function fixture() {
  const values = new Map(); const notices = []; let synced = false;
  const storage = { async get(key) { return structuredClone(values.get(key)); },
    async put(key, value) {
      if (typeof key === 'object') for (const [k, v] of Object.entries(key)) values.set(k, structuredClone(v));
      else values.set(key, structuredClone(value));
      synced = false;
    }, async sync() { synced = true; } };
  const env = { MONITOR_SELF_TEST: SELF_TEST_ID, ALERTS_ENABLED: 'false' };
  const sender = async (_, intent, options) => {
    assert.equal(synced, true);
    const saved = values.get(options?.testRun ? SELF_TEST_KEY : STATE_KEY);
    assert.deepEqual(options?.testRun ? saved.state.notification : saved.notification, intent);
    notices.push(renderNotification(intent, options?.testRun));
    return { status: 'accepted', messageId: `fixture-message-${notices.length}` };
  };
  const tick = (n, extra = {}) => runTick(storage, { ...env, ...extra }, BASE + n * 300000, {
    now: () => BASE + n * 300000, healthReader: async () => parseHealth(healthBody(BASE + n * 300000), BASE + n * 300000), sender });
  return { values, notices, storage, env, tick, sender };
}
test('fixed one-shot emits exactly one TEST alert and one TEST recovery; normal health never sees synthetic backlog', async () => {
  const f = fixture();
  await f.tick(0); assert.equal(f.notices.length, 1);
  await f.tick(0); assert.equal(f.notices.length, 1);
  await f.tick(1); assert.equal(f.notices.length, 1);
  await f.tick(2); assert.equal(f.notices.length, 2);
  for (const n of [2,3,4,100,288,289]) await f.tick(n);
  assert.equal(f.notices.length, 2);
  assert.equal(f.values.get(SELF_TEST_KEY).complete, true);
  assert.equal(f.values.get(STATE_KEY).incident, null);
  assert.deepEqual(f.values.get(STATE_KEY).lastCodes, []);
  for (const notice of f.notices) {
    assert.match(notice.subject, /^\[TEST ONLY\]/);
    assert.match(notice.text, /Synthetic monitor acceptance test/);
    assert.equal(notice.to, 'tjames@cablueprinting.com');
  }
  assert.match(f.notices[1].subject, /Recovery/);
});
test('self-test shares global six-intent quota and waits through exhausted budget without losing its opening notice', async () => {
  const f = fixture(); const main = initialState();
  main.daily = { day: '2026-10-06', count: DAILY_LIMIT };
  f.values.set(STATE_KEY, main);
  await f.tick(0); await f.tick(1); assert.equal(f.notices.length, 0);
  assert.equal(f.values.get(STATE_KEY).daily.count, DAILY_LIMIT);
  await f.tick(288); assert.equal(f.notices.length, 1); assert.match(f.notices[0].subject, /Alert/);
  await f.tick(289); await f.tick(290); assert.equal(f.notices.length, 2);
  assert.equal(f.values.get(STATE_KEY).daily.count, 2);
});
test('unknown self-test send holds all mail even after flag removal; qualified reconciliation preserves uncertainty and quota', async () => {
  const f = fixture();
  await runTick(f.storage, f.env, BASE, { now: () => BASE,
    healthReader: async () => parseHealth(healthBody(), BASE),
    sender: async () => ({ status: 'delivery_unknown' }) });
  assert.equal(f.values.get(SELF_TEST_KEY).state.needsReview, true);
  const realEnv = { MONITOR_SELF_TEST: '', ALERTS_ENABLED: 'true' };
  const tick = (n, config = {}) => runTick(f.storage, { ...realEnv, ...config }, BASE + n * 300000, {
    now: () => BASE + n * 300000,
    healthReader: async () => parseHealth(healthBody(BASE + n * 300000, 101), BASE + n * 300000), sender: f.sender });
  await tick(1); assert.equal(f.notices.length, 0);
  await tick(2, { MONITOR_RECONCILE_NOTIFICATION: 'cleanup-1-open' }); assert.equal(f.notices.length, 0);
  await tick(3, { MONITOR_RECONCILE_NOTIFICATION: `${SELF_TEST_ID}/cleanup-1-open` });
  assert.equal(f.notices.length, 1, 'Only the new real incident notice is sent');
  assert.doesNotMatch(f.notices[0].subject, /TEST/);
  assert.equal(f.values.get(SELF_TEST_KEY).state.notification.status, 'delivery_unknown');
  assert.equal(f.values.get(STATE_KEY).daily.count, 2);
});
test('recovery requires two consecutive fresh synthetic polls; unknown run identity and simultaneous live alerts fail before writes', async () => {
  const f = fixture(); await f.tick(0); await f.tick(2); assert.equal(f.notices.length, 1);
  await f.tick(3); assert.equal(f.notices.length, 2);
  const before = structuredClone([...f.values]);
  await assert.rejects(f.tick(4, { MONITOR_SELF_TEST: 'arbitrary-new-run' }));
  await assert.rejects(f.tick(4, { ALERTS_ENABLED: 'true' }));
  assert.deepEqual([...f.values], before);
});

test('uncertain acceptance test pauses its recovery observations until exact acknowledgment, without resending its alert', async () => {
  const f = fixture();
  await runTick(f.storage, f.env, BASE, { now: () => BASE,
    healthReader: async () => parseHealth(healthBody(), BASE),
    sender: async () => ({ status: 'delivery_unknown' }) });
  await f.tick(1); await f.tick(2); await f.tick(3);
  assert.equal(f.values.get(SELF_TEST_KEY).state.incident.number, 1);
  assert.equal(f.values.get(SELF_TEST_KEY).state.healthyPolls, 0);
  const acknowledge = { MONITOR_RECONCILE_NOTIFICATION: `${SELF_TEST_ID}/cleanup-1-open` };
  await f.tick(4, acknowledge); assert.equal(f.notices.length, 0);
  await f.tick(5, acknowledge); assert.equal(f.notices.length, 1);
  assert.match(f.notices[0].subject, /Recovery/);
  assert.equal(f.values.get(SELF_TEST_KEY).complete, true);
  assert.equal(f.values.get(STATE_KEY).daily.count, 2);
});
