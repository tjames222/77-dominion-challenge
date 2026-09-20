import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminReadClient, normalizeAdminContext, adminReadError } from './admin-read-client.mjs';
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function fixture() {
  let session = { user: { id: 'A' }, access_token: 'A:session1' }; let listener; let calls = 0; let request;
  const client = createAdminReadClient({
    getSession: async () => session, getUser: async () => session?.user, sessionIdentity: (s) => s?.access_token || '',
    subscribe: (fn) => { listener = fn; return () => {}; },
    request: async (name, args, options) => { calls += 1; return request ? request(name, args, options) : { schemaVersion: 1, actorId: args.target_expected_actor_id, items: [] }; },
  });
  return { client, setRequest(fn) { request = fn; }, calls: () => calls,
    event(event) { listener({ event, sessionIdentity: session?.access_token || '' }); },
    change(id, sid = 'session1') { session = id ? { user: { id }, access_token: `${id}:${sid}` } : null; listener({ event: id ? 'SIGNED_IN' : 'SIGNED_OUT', sessionIdentity: session?.access_token || '' }); },
  };
}
test('every request captures actor/session and cannot override the expected actor', async () => {
  const f = fixture();
  f.setRequest(async (name, args, options) => { assert.equal(args.target_expected_actor_id, 'A'); assert.equal(options.token, 'A:session1'); return { schemaVersion: 1, actorId: 'A', items: [] }; });
  await f.client.read('site_admin_list_users', { target_expected_actor_id: 'B' });
  await f.client.read('site_admin_list_users'); assert.equal(f.calls(), 2);
  await assert.rejects(f.client.read('site_admin_list_users', {}, { expectedUserId: 'B' }), { code: 'ADMIN_CHANGED' });
});
test('delayed A→B→A and same-account replacement sessions cannot release old data', async () => {
  for (const replace of [false, true]) {
    const f = fixture(); const wait = deferred(); f.setRequest(() => wait.promise);
    const result = f.client.read('site_admin_list_users'); await new Promise((r) => setTimeout(r, 0));
    if (replace) f.change('A', 'session2'); else { f.change('B'); f.change('A'); }
    wait.resolve({ schemaVersion: 1, actorId: 'A', items: [{ email: 'private' }] });
    await assert.rejects(result, { code: 'ADMIN_CHANGED' });
  }
});
test('page lifecycle invalidation suppresses an ignored abort and notifies consumers synchronously', async () => {
  const f = fixture(); const wait = deferred(); let notices = 0; f.client.subscribe(() => { notices += 1; }); f.setRequest(() => wait.promise);
  const result = f.client.read('site_admin_list_users'); await new Promise((r) => setTimeout(r, 0));
  f.client.invalidate(); assert.equal(notices, 1); wait.resolve({ schemaVersion: 1, actorId: 'A', items: [] });
  await assert.rejects(result, { code: 'ADMIN_CHANGED' });
});
test('same-session provider refresh or user update clears old authority and every view', async () => {
  for (const event of ['TOKEN_REFRESHED', 'USER_UPDATED', 'MFA_CHALLENGE_VERIFIED']) {
    const f = fixture(); let notices = 0;
    f.client.subscribe(() => { throw new Error('Unrelated broken subscriber'); });
    f.client.subscribe(() => { notices += 1; });
    const wait = deferred(); f.setRequest(() => wait.promise);
    const result = f.client.read('site_admin_list_users'); await new Promise((resolve) => setTimeout(resolve, 0));
    f.event(event); assert.equal(notices, 1); wait.resolve({ schemaVersion: 1, actorId: 'A', items: [] });
    await assert.rejects(result, { code: 'ADMIN_CHANGED' });
  }
});
test('denial clears every consumer and raw provider errors are never displayed', async () => {
  const f = fixture(); let notices = 0; f.client.subscribe(() => { notices += 1; });
  f.setRequest(() => { throw adminReadError('ADMIN_DENIED'); });
  await assert.rejects(f.client.read('site_admin_list_users'), { code: 'ADMIN_DENIED' }); assert.equal(notices, 1);
  f.setRequest(() => { throw new Error('SECRET TOKEN BODY'); });
  await assert.rejects(f.client.read('site_admin_list_users'), (error) => error.code === 'ADMIN_UNAVAILABLE' && !error.message.includes('SECRET'));
});
test('context normalization never promotes metadata or malformed permission shapes', () => {
  const member = normalizeAdminContext({ schemaVersion: 1, actorId: 'A', role: 'member', adminReady: false, permissions: ['users.read'] }, 'A');
  assert.deepEqual(member.permissions, []);
  for (const value of [{ schemaVersion: 1, actorId: 'B', role: 'site_admin', adminReady: true, permissions: ['users.read'] }, { schemaVersion: 1, actorId: 'A', role: 'member', adminReady: true, permissions: [] }, { schemaVersion: 1, actorId: 'A', role: 'site_admin', adminReady: true, permissions: ['journal.read'] }]) assert.throws(() => normalizeAdminContext(value, 'A'));
});
test('owner verification failure clears other consumers even before an RPC starts', async () => {
  const notices = [];
  const client = createAdminReadClient({ getSession: async () => ({ user: { id: 'A' }, access_token: 'A:session' }),
    getUser: async () => { throw adminReadError('ADMIN_SIGNED_OUT'); }, sessionIdentity: (session) => session.access_token, request: () => { throw new Error('Must not run'); } });
  client.subscribe((reason) => notices.push(reason));
  await assert.rejects(client.owner(), { code: 'ADMIN_SIGNED_OUT' }); assert.deepEqual(notices, ['ADMIN_SIGNED_OUT']);
});
