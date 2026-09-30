import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { normalizeAdminAccountRequest, normalizeAdminAccountRequestPage, accountRequestRecordedStatus } from './admin-account-requests.mjs';
import { previewAccountRequests } from './admin-account-request-preview.mjs';
import { createAdminPreview } from './admin-preview.mjs';
import { createAdminReadClient } from './admin-read-client.mjs';
import { requestAdminAccountRequests, readAdminAccountRequests } from './admin-account-request-transport.mjs';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const stamp = '2026-01-01T12:00:00Z';
const row = () => ({ id: B, userId: A, requestType: 'data_export', status: 'requested', requestedAt: stamp, updatedAt: stamp, resolvedAt: null });
const page = () => ({ schemaVersion: 1, actorId: A, observedAt: stamp, items: [row()], nextCursor: null });
const defer = () => { let resolve; return { promise: new Promise(r => { resolve = r; }), resolve }; };
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const input = { baseUrl: 'https://fixture.invalid', apiKey: 'synthetic-public', token: 'captured-only', args: { target_expected_actor_id: A }, timeoutMs: 50 };

test('Operations projection strips private fields and preserves nullable requester without inventing a failure state', () => {
  assert.deepEqual(normalizeAdminAccountRequest({ ...row(), operatorNote: 'PRIVATE', email: 'PRIVATE', payload: 'PRIVATE' }), row());
  assert.equal(normalizeAdminAccountRequest({ ...row(), userId: null }).userId, null);
  assert.equal(accountRequestRecordedStatus('fulfilled'), 'Recorded fulfilled');
  for (const status of ['fulfilled', 'cancelled', 'declined']) assert.equal(normalizeAdminAccountRequest({ ...row(), status, resolvedAt: stamp }).status, status);
  for (const patch of [{ id: {} }, { userId: '' }, { userId: undefined }, { requestType: 'private_export' }, { status: 'failed' },
    { requestedAt: 'not-a-date' }, { updatedAt: null }, { resolvedAt: stamp }, { status: 'fulfilled' }]) {
    assert.throws(() => normalizeAdminAccountRequest({ ...row(), ...patch }), { code: 'ADMIN_UNAVAILABLE' });
  }
});
test('page rejects oversized, malformed and partially valid rows before rendering', () => {
  assert.deepEqual(normalizeAdminAccountRequestPage({ ...page(), privatePayload: 'PRIVATE' }), page());
  for (const patch of [{ observedAt: '' }, { items: Array(51).fill(row()) }, { items: [row(), { ...row(), status: 'failed' }] },
    { nextCursor: [] }, { nextCursor: 'raw' }, { nextCursor: { payload: 'x'.repeat(2048) } }]) {
    assert.throws(() => normalizeAdminAccountRequestPage({ ...page(), ...patch }), { code: 'ADMIN_UNAVAILABLE' });
  }
});
test('synthetic inbox uses existing statuses and exact keyset boundaries without mutations or persistence', async () => {
  const first = await previewAccountRequests({}, A); assert.equal(first.items.length, 25);
  const second = await previewAccountRequests({ target_cursor: first.nextCursor }, A); assert.equal(second.items.length, 3);
  assert.equal(new Set([...first.items, ...second.items].map(r => r.id)).size, 28);
  assert.deepEqual(await previewAccountRequests({}, A), first);
  for (const patch of [{ target_status: 'all' }, { target_sort: 'newest' }, { target_request_type: 'data_export' }])
    await assert.rejects(previewAccountRequests({ ...patch, target_cursor: first.nextCursor }, A), { code: 'ADMIN_INVALID_CURSOR' });
  await assert.rejects(previewAccountRequests({ target_cursor: first.nextCursor }, B), { code: 'ADMIN_INVALID_CURSOR' });
  for (const cursor of [false, '', [], 1, { ...first.nextCursor, stamp: 'yesterday' }, { ...first.nextCursor, extra: true }])
    await assert.rejects(previewAccountRequests({ target_cursor: cursor }, A), { code: 'ADMIN_INVALID_CURSOR' });
  for (const patch of [{ target_limit: 0 }, { target_limit: 51 }, { target_limit: null }, { target_status: null }, { target_status: 'failed' }, { target_sort: 'random' }])
    await assert.rejects(previewAccountRequests(patch, A), { code: 'ADMIN_INVALID_INPUT' });
  const all = (await previewAccountRequests({ target_status: 'all', target_limit: 50 }, A)).items;
  assert.equal(all.length, 36); assert.equal(all.filter(r => r.userId === null).length, 1);
  const preview = createAdminPreview({ mode: 'ready', getUser: async () => ({ userId: A, authenticated: true }) });
  assert.equal((await preview.read('site_admin_list_account_requests')).preview, true);
  await assert.rejects(createAdminPreview({ mode: 'member', getUser: async () => ({ userId: A, authenticated: true }) }).read('site_admin_list_account_requests'), { code: 'ADMIN_DENIED' });
});
test('new inbox read is allowlisted, pins actor and rejects ABA/session replacement after dispatch', async () => {
  for (const mode of ['aba', 'replacement', 'pagehide', 'wrong-actor']) {
    let session = { user: { id: A }, access_token: 'A:1' }; let observe;
    const held = defer(), sent = defer();
    const client = createAdminReadClient({ getSession: async () => session, getUser: async () => session.user,
      sessionIdentity: s => s.access_token, subscribe: fn => { observe = fn; }, request: async (name, args, options) => {
        assert.equal(name, 'site_admin_list_account_requests'); assert.equal(args.target_expected_actor_id, A); assert.equal(options.token, 'A:1'); sent.resolve(); return held.promise;
      } });
    const pending = client.read('site_admin_list_account_requests', { target_expected_actor_id: B }); await sent.promise;
    if (mode === 'aba') { observe({ event: 'SIGNED_IN', sessionIdentity: 'B:1' }); observe({ event: 'SIGNED_IN', sessionIdentity: 'A:1' }); }
    if (mode === 'replacement') session = { ...session, access_token: 'A:2' };
    if (mode === 'pagehide') client.invalidate();
    held.resolve({ ...page(), actorId: mode === 'wrong-actor' ? B : A });
    await assert.rejects(pending, { code: mode === 'wrong-actor' ? 'ADMIN_UNAVAILABLE' : 'ADMIN_CHANGED' }); client.destroy();
  }
});
test('bounded transport sends one exact pinned native read with private fetch settings', async () => {
  let calls = 0;
  const result = await requestAdminAccountRequests({ ...input, fetcher: async (url, options) => {
    calls++; assert.equal(url, 'https://fixture.invalid/rest/v1/rpc/site_admin_list_account_requests');
    assert.equal(options.method, 'POST'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store');
    assert.equal(options.headers.Authorization, 'Bearer captured-only'); assert.deepEqual(JSON.parse(options.body), input.args); return json(page());
  } });
  assert.deepEqual(result, page()); assert.equal(calls, 1);
});
for (const [status, message, code] of [[401, 'PRIVATE', 'ADMIN_SIGNED_OUT'], [403, 'PRIVATE', 'ADMIN_DENIED'], [400, 'admin_invalid_cursor', 'ADMIN_INVALID_CURSOR'],
  [400, 'admin_invalid_input', 'ADMIN_INVALID_INPUT'], [503, 'PRIVATE', 'ADMIN_UNAVAILABLE']]) test(`transport returns only safe ${status}/${code}`, async () => {
  await assert.rejects(requestAdminAccountRequests({ ...input, fetcher: async () => new Response(JSON.stringify({ message }), { status, headers: { 'content-type': 'application/json' } }) }),
    error => error.code === code && !error.message.includes('PRIVATE'));
});
test('stream byte limit, UTF-8 and MIME validation fail closed without raw-body errors', async () => {
  for (const response of [new Response('x'.repeat(65537), { headers: { 'content-type': 'application/json' } }),
    new Response(new Uint8Array([255]), { headers: { 'content-type': 'application/json' } }), new Response('PRIVATE', { headers: { 'content-type': 'text/html' } }),
    new Response('PRIVATE', { headers: { 'content-type': 'application/json' } })]) {
    await assert.rejects(requestAdminAccountRequests({ ...input, fetcher: async () => response }), { code: 'ADMIN_UNAVAILABLE' });
  }
});
test('deadline and owner abort bound stalled fetch/body and cancel late responses, with zero retries', async () => {
  let calls = 0, cancelled = 0; const late = defer();
  await assert.rejects(requestAdminAccountRequests({ ...input, timeoutMs: 5, fetcher: () => { calls++; return late.promise; } }), { code: 'ADMIN_UNAVAILABLE' });
  late.resolve(new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-type': 'application/json' } }));
  await new Promise(r => setTimeout(r, 0)); assert.equal(calls, 1); assert.equal(cancelled, 1);
  for (const abort of [false, true]) {
    const controller = new AbortController(); let bodyCancelled = false;
    const result = requestAdminAccountRequests({ ...input, timeoutMs: 5, signal: controller.signal,
      fetcher: async () => new Response(new ReadableStream({ cancel() { bodyCancelled = true; } }), { headers: { 'content-type': 'application/json' } }) });
    if (abort) setTimeout(() => controller.abort(), 1);
    await assert.rejects(result, { code: 'ADMIN_UNAVAILABLE' }); assert.equal(bodyCancelled, true);
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(requestAdminAccountRequests({ ...input, signal: controller.signal, fetcher: () => { throw new Error('must not dispatch'); } }), { code: 'ADMIN_UNAVAILABLE' });
});
test('view deadline includes deferred loading/Auth and late continuation cannot dispatch', async () => {
  const loaded = defer(); let calls = 0;
  const result = readAdminAccountRequests(async (_, { signal }) => {
    await loaded.promise;
    return requestAdminAccountRequests({ ...input, signal, fetcher: async () => { calls++; return json(page()); } });
  }, {}, {}, 5);
  await assert.rejects(result, { code: 'ADMIN_UNAVAILABLE' });
  loaded.resolve(); await new Promise(r => setTimeout(r, 0)); assert.equal(calls, 0);
});
test('request projection stays deferred and the view exposes no fulfillment controls or persistence', () => {
  const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
  const api = read('./api.js');
  assert.doesNotMatch(api, /^import.*admin-account-request/m);
  assert.match(api, /await import\('\.\/admin-account-request-transport\.mjs'\)/);
  const html = read('../../admin.html').split('id="adminRequestsPanel"')[1].split('class="admin-pagination"')[0];
  assert.equal((html.match(/<button/g) || []).length, 1); assert.match(html, /Read-only intake/);
  assert.doesNotMatch(read('./admin-account-requests.mjs'), /localStorage|sessionStorage|innerHTML|console\./);
});
