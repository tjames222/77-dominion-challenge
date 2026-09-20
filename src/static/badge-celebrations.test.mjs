import assert from 'node:assert/strict';
import test from 'node:test';
import { createBadgeCelebrationRecovery } from './badge-celebrations.mjs';
import { createDocumentDeliveryToken } from './celebration-delivery-token.mjs';
const store = () => { const values = new Map(); return { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) }; };
test('offline dismissal survives reload and suppresses a replay until acknowledgment recovers', async () => {
  const storage = store(); const sessionStorage = store(); const owner = { userId: 'one' };
  let offline = true; let acknowledged = 0;
  const options = { storage, sessionStorage, isCurrentOwner: (value) => value === owner,
    claim: async () => ({ badges: [{ awardId: 'award', key: 'faithful_start' }] }),
    acknowledge: async () => { if (offline) throw Error('offline'); acknowledged += 1; } };
  const first = createBadgeCelebrationRecovery(options);
  const [badge] = await first.collect(owner);
  await first.complete(badge, 'dismissed');
  const reloaded = createBadgeCelebrationRecovery(options);
  assert.deepEqual(await reloaded.collect(owner), []);
  offline = false;
  await reloaded.collect(owner);
  assert.equal(acknowledged, 1);
});
test('cleared or stale-owner presentation never acknowledges another account', async () => {
  const owner = { userId: 'one' }; let current = owner; let count = 0;
  const recovery = createBadgeCelebrationRecovery({ storage: store(), sessionStorage: store(),
    isCurrentOwner: (value) => value === current, claim: async () => ({ badges: [{ awardId: 'award' }] }),
    acknowledge: async () => { count += 1; } });
  const [badge] = await recovery.collect(owner);
  await recovery.complete(badge, 'cleared');
  current = { userId: 'two' };
  await recovery.complete(badge, 'dismissed');
  assert.equal(count, 0);
});
test('duplicated session storage cannot give two live documents the same claim token', async () => {
  const active = new Set();
  const locks = { async request(name, options, callback) {
    if (active.has(name)) return callback(null);
    active.add(name); try { return await callback({ name }); } finally { active.delete(name); }
  } };
  const sessionStorage = store(); sessionStorage.setItem('dominion:badgeClaim:one', '20000000-0000-4000-8000-000000000001');
  const owner = { userId: 'one' }; const tokens = [];
  const options = { storage: store(), sessionStorage, locks, isCurrentOwner: (value) => value === owner,
    claim: async ({ claimToken }) => { tokens.push(claimToken); return { badges: [] }; }, acknowledge: async () => {} };
  const first = createBadgeCelebrationRecovery(options); const second = createBadgeCelebrationRecovery(options);
  await Promise.all([first.collect(owner), second.collect(owner)]);
  assert.equal(new Set(tokens).size, 2);
  first.release(); second.release();
});
test('storage denial keeps a stable in-memory token for the document', async () => {
  const sessionStorage = { getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); } };
  const delivery = createDocumentDeliveryToken({ sessionStorage, namespace: 'badge' });
  const token = await delivery.get('one');
  assert.equal(await delivery.get('one'), token);
  delivery.release();
  assert.notEqual(await delivery.get('one'), token);
});
