import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeAdminUserHistory, readAdminUserHistory, USER_HISTORY_PAGE_SIZE } from './admin-user-history.mjs';

const A = '10000000-0000-4000-8000-000000000001';
const B = '20000000-0000-4000-8000-000000000002';
const C = '30000000-0000-4000-8000-000000000003';
const owner = { actorId: A, sessionIdentity: 'same-session' };
const scope = { actorId: A, targetUserId: B };
const row = (patch = {}) => ({ id: '9223372036854775807', actorId: A, targetUserId: B,
  action: 'roles.assign', permission: 'roles.manage', reasonCode: 'staff_access_review', beforeRole: 'member', afterRole: 'site_admin',
  outcome: 'success', errorCode: null, occurredAt: '2026-10-08T00:00:00.123456+00:00',
  privateNote: 'PRIVATE_HISTORY_SENTINEL', ...patch });
const page = (patch = {}) => ({ schemaVersion: 1, actorId: A, observedAt: '2026-10-08T01:00:00Z', items: [row()], nextCursor: null, ...patch });
const full = () => page({ items: Array.from({ length: USER_HISTORY_PAGE_SIZE }, (_, i) => row({ id: String(30 - i) })),
  nextCursor: { v: 1, actorId: A, query: 'a'.repeat(64), id: '21' } });
const pending = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('account history projects safe fields and preserves bigint event IDs', () => {
  const result = normalizeAdminUserHistory(page(), scope);
  assert.equal(result.items[0].id, '9223372036854775807');
  assert.equal(result.items[0].actionLabel, 'Site role review');
  assert.equal(JSON.stringify(result).includes('PRIVATE_HISTORY_SENTINEL'), false);
  assert.equal(Object.hasOwn(result.items[0], 'actorId'), false);
});

test('mixed linked actions, historical failures and empty results are supported', () => {
  const result = normalizeAdminUserHistory(page({ items: [
    row({ id: '4', actorId: null, action: 'roles.bootstrap', reasonCode: 'initial_admin_bootstrap' }),
    row({ id: '3', outcome: 'failure', errorCode: 'revision_conflict', afterRole: 'member' }),
    row({ id: '2', action: 'early_access.accept', actorId: B, permission: 'early_access.accept', reasonCode: 'invitation_acceptance', beforeRole: null, afterRole: null }),
    row({ id: '1', action: 'early_access.accept', actorId: B, permission: 'early_access.accept', reasonCode: 'invitation_acceptance', beforeRole: null, afterRole: null, outcome: 'failure', errorCode: 'already_qualified' }),
  ] }), scope);
  assert.equal(result.items[1].errorLabel, 'Account changed during review');
  assert.equal(result.items[2].actionLabel, 'Early Access invitation acceptance');
  assert.equal(result.items[3].errorLabel, 'Already qualified');
  assert.deepEqual(normalizeAdminUserHistory(page({ items: [] }), scope).items, []);
});

test('protected operator bootstrap has a null actor without weakening other actions', () => {
  // bootstrap_site_admin writes a NULL actor because this is an operator-only
  // action, not an authenticated browser admin acting on its own account.
  const bootstrap = row({ actorId: null, action: 'roles.bootstrap', reasonCode: 'initial_admin_bootstrap' });
  assert.equal(normalizeAdminUserHistory(page({ items: [bootstrap] }), scope).items[0].actionLabel, 'Initial site-admin assignment');
  for (const actorId of [undefined, '', 'not-a-uuid', A]) assert.throws(() => normalizeAdminUserHistory(page({ items: [{ ...bootstrap, actorId }] }), scope));
  assert.throws(() => normalizeAdminUserHistory(page({ items: [row({ actorId: null })] }), scope));
  assert.throws(() => normalizeAdminUserHistory(page({ items: [row({ actorId: null, action: 'early_access.accept', permission: 'early_access.accept',
    reasonCode: 'invitation_acceptance', beforeRole: null, afterRole: null })] }), scope));
});

for (const [name, patch] of Object.entries({ actor: { actorId: C }, version: { schemaVersion: 2 },
  timestamp: { observedAt: 'yesterday' }, missingCursor: { nextCursor: undefined }, oversized: { items: Array.from({ length: 11 }, () => row()) } })) {
  test(`history rejects malformed page: ${name}`, () => assert.throws(() => normalizeAdminUserHistory(page(patch), scope), /unavailable/i));
}
for (const [name, patch] of Object.entries({ target: { targetUserId: C }, actor: { actorId: null }, roundedId: { id: 9007199254740992 },
  overflow: { id: '9223372036854775808' }, date: { occurredAt: '2026-10-08' }, action: { action: 'private.secret' },
  inheritedAction: { action: 'constructor' }, permission: { permission: 'users.manage' }, reason: { reasonCode: 'PRIVATE_HISTORY_SENTINEL' },
  role: { beforeRole: 'PRIVATE_HISTORY_SENTINEL' }, successError: { errorCode: 'revision_conflict' }, failureCode: { outcome: 'failure', errorCode: 'raw database body' },
  changedFailure: { outcome: 'failure', errorCode: 'revision_conflict' },
  wrongAcceptActor: { action: 'early_access.accept', permission: 'early_access.accept', reasonCode: 'invitation_acceptance', beforeRole: null, afterRole: null },
})) test(`history rejects malformed row: ${name}`, () => assert.throws(() => normalizeAdminUserHistory(page({ items: [row(patch)] }), scope), /unavailable/i));

test('cursor is bounded, exact-actor and anchored to a full ordered page', () => {
  assert.deepEqual(normalizeAdminUserHistory(full(), scope).nextCursor, full().nextCursor);
  const preview = full(); preview.nextCursor = { query: JSON.stringify({ actor: A, target_user_id: B }), id: '21' };
  assert.deepEqual(normalizeAdminUserHistory(preview, scope).nextCursor, preview.nextCursor);
  for (const cursor of [[], {}, { ...full().nextCursor, actorId: B }, { ...full().nextCursor, id: '22' },
    { ...full().nextCursor, v: 2 }, { ...full().nextCursor, query: 'x'.repeat(2049) }, { ...full().nextCursor, secret: 'not allowed' },
    { id: '21', actorId: A, query: 'a'.repeat(64) }]) {
    assert.throws(() => normalizeAdminUserHistory({ ...full(), nextCursor: cursor }, scope));
  }
  assert.throws(() => normalizeAdminUserHistory(page({ nextCursor: full().nextCursor }), scope));
  assert.throws(() => normalizeAdminUserHistory(page({ items: [row({ id: '3' }), row({ id: '3' })] }), scope));
  assert.throws(() => normalizeAdminUserHistory(page({ items: [row({ id: '3' }), row({ id: '4' })] }), scope));
  assert.throws(() => normalizeAdminUserHistory(page({ items: [row({ id: '21' })] }), { ...scope, cursor: full().nextCursor }));
  assert.equal(normalizeAdminUserHistory(page({ items: [row({ id: '20' })] }), { ...scope, cursor: full().nextCursor }).items[0].id, '20');
});

test('read uses only exact target, bounded page and deployed guarded read arguments', async () => {
  const calls = []; let ownerReads = 0;
  const result = await readAdminUserHistory({ owner, targetUserId: B, getOwner: async () => { ownerReads += 1; return owner; },
    read: async (...args) => { calls.push(args); return page(); } });
  assert.equal(result.items.length, 1); assert.equal(ownerReads, 2);
  assert.deepEqual(calls[0][0], { target_user_id: B, target_action: 'all', target_outcome: 'all', target_limit: 10, target_cursor: null });
  assert.equal(calls[0][1].expectedUserId, A); assert.equal(calls[0][1].signal.aborted, false);
});

for (const mode of ['different actor', 'replacement session']) test(`read rejects ${mode} before dispatch and after response`, async () => {
  const changed = mode === 'different actor' ? { ...owner, actorId: C } : { ...owner, sessionIdentity: 'replacement' };
  for (const when of [1, 2]) {
    let reads = 0; let captures = 0;
    await assert.rejects(readAdminUserHistory({ owner, targetUserId: B,
      getOwner: async () => ++captures === when ? changed : owner,
      read: async () => { reads += 1; return page(); } }), { code: 'ADMIN_CHANGED' });
    assert.equal(reads, when - 1);
  }
});

test('deadline includes delayed Auth and prevents a late read dispatch', async () => {
  const held = pending(); let reads = 0;
  await assert.rejects(readAdminUserHistory({ owner, targetUserId: B, timeoutMs: 5, getOwner: () => held.promise,
    read: async () => { reads += 1; return page(); } }), { code: 'ADMIN_UNAVAILABLE' });
  held.resolve(owner); await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(reads, 0);
});

test('abort and deadline settle even if a read ignores its signal', async () => {
  for (const abort of [false, true]) {
    const held = pending(); const started = pending(); const controller = new AbortController(); let signal;
    const result = readAdminUserHistory({ owner, targetUserId: B, timeoutMs: abort ? 1000 : 5, signal: controller.signal,
      getOwner: async () => owner, read: async (_, options) => { signal = options.signal; started.resolve(); return held.promise; } });
    await started.promise; if (abort) controller.abort();
    await assert.rejects(result, { code: 'ADMIN_UNAVAILABLE' }); assert.equal(signal.aborted, true);
    held.resolve(page()); await new Promise(resolve => setTimeout(resolve, 0));
  }
});

test('permission denial is preserved for the parent workspace scrub', async () => {
  await assert.rejects(readAdminUserHistory({ owner, targetUserId: B, getOwner: async () => owner,
    read: async () => { throw Object.assign(new Error('denied'), { code: 'ADMIN_DENIED' }); } }), { code: 'ADMIN_DENIED' });
});
