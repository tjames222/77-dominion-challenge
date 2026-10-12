import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdminPreview } from './admin-preview.mjs';
import { isRequesterId, normalizeRequesterAccount, readRequesterAccount } from './admin-requester-account.mjs';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const U = '70000000-0000-4000-8000-000000000001';
const owner = { actorId: A, sessionIdentity: 'synthetic-session' };
const provider = createAdminPreview({ mode: 'ready', getUser: async () => ({ authenticated: true, userId: A }) });
const payload = async () => structuredClone(await provider.read('site_admin_get_user', { target_user_id: U }, { expectedUserId: A }));
const context = () => ({ schemaVersion: 1, actorId: A, role: 'site_admin', adminReady: true, permissions: ['operations.read', 'users.read'] });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(overrides = {}) {
  const calls = [];
  return { owner, requesterId: U, calls,
    getOwner: async options => { calls.push(['owner', options]); return { ...owner }; },
    getContext: async options => { calls.push(['context', options]); return context(); },
    readUser: async (id, options) => { calls.push(['user', id, options]); return payload(); }, ...overrides };
}

test('requester response binds actor and exact user and projects only existing safe fields', async () => {
  const value = await payload(); value.secret = 'PRIVATE'; value.item.privateNotes = 'PRIVATE'; value.item.activationSnapshot.secret = 'PRIVATE';
  value.item.name = '😀'.repeat(120);
  const result = normalizeRequesterAccount(value, { actorId: A, requesterId: U });
  assert.equal(result.item.name, value.item.name); assert.equal(result.item.statsSnapshot.storedPerfectDayStreak, 0);
  assert.equal(result.item.lastSignInAt, null); assert.equal(result.item.subscriptionSnapshot, null);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});
test('retained deleted account facts stay recorded, and missing snapshots stay null', async () => {
  const value = await payload(); value.item.deletedAt = '2026-01-01T00:00:00Z';
  for (const key of ['activationSnapshot', 'statsSnapshot', 'subscriptionSnapshot', 'crew']) value.item[key] = null;
  const result = normalizeRequesterAccount(value, { actorId: A, requesterId: U });
  assert.equal(result.item.deletedAt, value.item.deletedAt); assert.equal(result.item.statsSnapshot, null);
});
for (const [name, mutate] of Object.entries({
  actor: value => { value.actorId = B; }, target: value => { value.item.id = B; }, schema: value => { value.schemaVersion = 2; },
  time: value => { value.observedAt = 'yesterday'; }, role: value => { value.item.role = 'owner'; },
  status: value => { value.item.isSuspended = 'false'; }, partial: value => { delete value.item.lastSignInAt; },
  revision: value => { value.item.roleRevision = Number.MAX_SAFE_INTEGER + 1; },
  pending: value => { value.item.deletionPending = true; }, crew: value => { value.item.crew = { id: B, name: 'Crew', role: 'site_admin' }; },
  snapshot: value => { value.item.statsSnapshot.totalPoints = '123'; },
  localDate: value => { value.item.activationSnapshot.startDate = '2026-02-31'; },
})) test(`malformed requester ${name} fails before publication`, async () => {
  const value = await payload(); mutate(value);
  assert.throws(() => normalizeRequesterAccount(value, { actorId: A, requesterId: U }), { code: 'ADMIN_UNAVAILABLE' });
});
test('each explicit operation rechecks context before and after one exact-target read, with owner fences and signal', async () => {
  const f = fixture(); const result = await readRequesterAccount(f);
  assert.equal(result.item.id, U); assert.deepEqual(f.calls.map(call => call[0]), ['owner', 'context', 'user', 'owner', 'context', 'owner']);
  const signal = f.calls[0][1].signal;
  for (const call of f.calls) assert.equal(call.at(-1).signal, signal);
  assert.equal(f.calls[2][1], U); assert.equal(f.calls[2][2].expectedUserId, A);
});
for (const missing of ['operations.read', 'users.read']) for (const phase of ['pre', 'post']) {
  test(`${missing} loss at ${phase} context fails closed`, async () => {
    let contexts = 0, reads = 0;
    const f = fixture({ getContext: async () => { contexts += 1; const value = context();
      if (phase === 'pre' || contexts === 2) value.permissions = value.permissions.filter(p => p !== missing); return value; },
    readUser: async () => { reads += 1; return payload(); } });
    await assert.rejects(readRequesterAccount(f), { code: 'ADMIN_DENIED' }); assert.equal(reads, phase === 'pre' ? 0 : 1);
  });
}
for (const [name, changes, code] of [
  ['actor', { actorId: B }, 'ADMIN_UNAVAILABLE'], ['schema', { schemaVersion: 2 }, 'ADMIN_UNAVAILABLE'],
  ['role', { role: 'member' }, 'ADMIN_UNAVAILABLE'], ['readiness', { adminReady: false }, 'ADMIN_DENIED'],
]) for (const phase of ['pre', 'post']) test(`invalid ${phase} context ${name} cannot publish requester facts`, async () => {
  let contexts = 0, reads = 0;
  await assert.rejects(readRequesterAccount(fixture({ getContext: async () => ({ ...context(),
    ...(phase === 'pre' || ++contexts === 2 ? changes : {}) }),
  readUser: async () => { reads += 1; return payload(); } })), { code });
  assert.equal(reads, phase === 'pre' ? 0 : 1);
});
for (const change of [{ actorId: B }, { sessionIdentity: 'replacement' }]) test(`owner ${Object.keys(change)[0]} replacement rejects results`, async () => {
  let owners = 0;
  await assert.rejects(readRequesterAccount(fixture({ getOwner: async () => ({ ...owner, ...(++owners > 1 ? change : {}) }) })), { code: 'ADMIN_CHANGED' });
});
for (const [method, occurrence] of [['getOwner', 1], ['getContext', 1], ['readUser', 1], ['getOwner', 2], ['getContext', 2], ['getOwner', 3]]) {
  test(`whole deadline bounds ${method} ${occurrence} and stops late continuation`, async () => {
    const f = fixture(); const original = f[method]; const held = deferred(); let count = 0;
    f[method] = async (...args) => ++count === occurrence ? held.promise : original(...args);
    await assert.rejects(readRequesterAccount({ ...f, timeoutMs: 10 }), { code: 'ADMIN_UNAVAILABLE' });
    const callsAtStop = f.calls.length;
    held.resolve(method === 'getOwner' ? { ...owner } : method === 'getContext' ? context() : await payload());
    await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.length, callsAtStop);
    assert.equal((await readRequesterAccount(f)).item.id, U);
  });
}
test('caller abort settles a held read and a late failure cannot change a successful retry', async () => {
  const held = deferred(); const entered = deferred(); let reads = 0;
  const f = fixture({ readUser: async () => { if (++reads === 1) { entered.resolve(); return held.promise; } return payload(); } });
  const controller = new AbortController(); const first = readRequesterAccount({ ...f, signal: controller.signal });
  await entered.promise; controller.abort(); await assert.rejects(first, { code: 'ADMIN_UNAVAILABLE' });
  assert.equal((await readRequesterAccount(f)).item.id, U);
  held.reject(Object.assign(new Error('PRIVATE old error'), { code: 'ADMIN_DENIED' }));
  await new Promise(resolve => setImmediate(resolve)); assert.equal((await readRequesterAccount(f)).item.id, U);
});
test('invalid/null requester and already-aborted operation dispatch nothing', async () => {
  for (const requesterId of [null, '', '<script>', U + 'extra']) {
    assert.equal(isRequesterId(requesterId), false); const f = fixture({ requesterId });
    await assert.rejects(readRequesterAccount(f)); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); const controller = new AbortController(); controller.abort();
  await assert.rejects(readRequesterAccount({ ...f, signal: controller.signal })); assert.equal(f.calls.length, 0);
});
