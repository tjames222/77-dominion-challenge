import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminReadClient, withAdminReadDeadline } from './admin-read-client.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture(stage) {
  const held = deferred(); const calls = []; let session = { user: { id: 'A' }, access_token: 'A:token1' }; let listener; let count = 0;
  const client = createAdminReadClient({
    getSession: async () => { const name = ['initial', 'recapture', 'revalidate'][count++] || 'other'; calls.push(name); if (name === stage) await held.promise; return session; },
    getUser: () => { throw new Error('Reads must not use the mutation getUser adapter'); },
    getReadUser: async token => { calls.push('getUser'); assert.equal(token, 'A:token1'); if (stage === 'getUser') await held.promise; return { id: 'A' }; },
    sessionIdentity: value => value ? `session:${value.user.id}` : '', subscribe: fn => { listener = fn; },
    readRequest: async (name, args, { signal, token }) => { calls.push('request'); assert.equal(token, 'A:token1'); assert.equal(args.target_expected_actor_id, 'A');
      if (stage === 'request') await held.promise; return { schemaVersion: 1, actorId: 'A', items: [], signalWasAborted: signal.aborted }; },
    request: () => { throw new Error('Reads must not use the mutation transport'); },
  });
  const notices = []; client.subscribe(code => notices.push(code));
  return { client, held, calls, notices, replaceBearer() { session = { ...session, access_token: 'A:token2' }; },
    event() { listener({ event: 'TOKEN_REFRESHED', sessionIdentity: 'session:A' }); } };
}

for (const method of ['owner', 'read']) for (const stage of method === 'owner' ? ['initial', 'getUser', 'recapture'] : ['initial', 'getUser', 'recapture', 'request', 'revalidate']) {
  test(`${method} deadline settles a stalled ${stage} and prevents every later continuation`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(stage);
    const pending = method === 'owner' ? f.client.owner() : f.client.read('site_admin_list_users', { target_expected_actor_id: 'B' });
    const rejected = assert.rejects(pending, { code: 'ADMIN_UNAVAILABLE' }); await flush();
    const before = [...f.calls]; assert.equal(before.at(-1), stage);
    t.mock.timers.tick(10000); await rejected; assert.deepEqual(f.notices, []);
    f.held.resolve(); await flush(); assert.deepEqual(f.calls, before); assert.deepEqual(f.notices, []);
    f.client.destroy();
  });
}
for (const stage of ['initial', 'getUser', 'recapture', 'request', 'revalidate']) for (const stop of ['abort', 'invalidate']) {
  test(`${stop} settles immediately during ${stage}, including an ignored underlying abort`, async () => {
    const f = fixture(stage); const controller = new AbortController();
    const pending = f.client.read('site_admin_list_users', {}, { signal: controller.signal });
    const rejected = assert.rejects(pending, { code: stop === 'abort' ? 'ADMIN_UNAVAILABLE' : 'ADMIN_CHANGED' }); await flush();
    const before = [...f.calls];
    if (stop === 'abort') controller.abort(); else f.event();
    await rejected; f.held.reject(new Error('PRIVATE late provider failure')); await flush();
    assert.deepEqual(f.calls, before); assert.equal(f.notices.length, stop === 'abort' ? 0 : 1); f.client.destroy();
  });
}
for (const stage of ['getUser', 'recapture', 'request', 'revalidate']) test(`unnotified same-session bearer replacement at ${stage} rejects stale authority`, async () => {
  const f = fixture(stage); const pending = f.client.read('site_admin_list_users'); const rejected = assert.rejects(pending, { code: 'ADMIN_CHANGED' });
  await flush(); f.replaceBearer(); f.held.resolve(); await rejected;
  assert.equal(f.calls.includes('request'), ['request', 'revalidate'].includes(stage)); assert.deepEqual(f.notices, ['ADMIN_CHANGED']); f.client.destroy();
});
for (const stage of ['getUser', 'request']) for (const code of ['ADMIN_DENIED', 'ADMIN_SIGNED_OUT']) test(`old ${stage} ${code} after a successful manual retry cannot invalidate it`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const held = deferred(); const notices = [];
  const session = { user: { id: 'A' }, access_token: 'A:token1' }; let userCalls = 0; let requestCalls = 0;
  const client = createAdminReadClient({ getSession: async () => session, sessionIdentity: () => 'session:A',
    getUser: async () => { userCalls++; return stage === 'getUser' && userCalls === 1 ? held.promise : session.user; },
    request: async () => { requestCalls++; return stage === 'request' && requestCalls === 1 ? held.promise : { schemaVersion: 1, actorId: 'A', items: [] }; } });
  client.subscribe(reason => notices.push(reason));
  const pending = client.read('site_admin_list_users'); const rejected = assert.rejects(pending, { code: 'ADMIN_UNAVAILABLE' });
  await flush(); t.mock.timers.tick(10000); await rejected;
  assert.equal((await client.read('site_admin_list_users')).actorId, 'A');
  held.reject(Object.assign(new Error('PRIVATE old provider failure'), { code })); await flush();
  assert.deepEqual(notices, []); assert.equal((await client.read('site_admin_list_users')).actorId, 'A');
  assert.equal(userCalls, 3); assert.equal(requestCalls, stage === 'getUser' ? 2 : 3); client.destroy();
});
test('pre-aborted reads and invalid deadlines never start Auth or work', async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort();
  await assert.rejects(f.client.owner({ signal: controller.signal }), { code: 'ADMIN_UNAVAILABLE' });
  await assert.rejects(f.client.read('site_admin_list_users', {}, { signal: controller.signal }), { code: 'ADMIN_UNAVAILABLE' });
  for (const timeout of [0, -1, 10001, Infinity, NaN, 1.5, '10']) await assert.rejects(withAdminReadDeadline(() => { throw new Error('Must not run'); }, {}, timeout), { code: 'ADMIN_UNAVAILABLE' });
  assert.deepEqual(f.calls, []); f.client.destroy();
});
test('read-only dispatch rejects mutation names before any Auth call', async () => {
  const f = fixture();
  for (const name of ['site_admin_assign_role', 'site_admin_deny_early_access_request', 'admin-early-access-invitation'])
    await assert.rejects(f.client.read(name), { code: 'ADMIN_INVALID_INPUT' });
  assert.deepEqual(f.calls, []); f.client.destroy();
});
