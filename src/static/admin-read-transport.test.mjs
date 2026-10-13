import assert from 'node:assert/strict';
import test from 'node:test';
import { requestAdminRead, requestAdminReadUser } from './admin-read-transport.mjs';

const base = { baseUrl: 'https://provider.invalid', apiKey: 'synthetic-key', token: 'exact-synthetic-bearer',
  name: 'site_admin_list_users', args: { target_expected_actor_id: 'A' } };
const encode = text => new TextEncoder().encode(text);
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const response = (body, options = {}) => new Response(body, { headers: { 'content-type': 'application/json' }, ...options });

test('read transport pins exact bearer/no-store policy for original reads and rejects mutation RPCs', async () => {
  for (const name of ['get_site_admin_context', 'site_admin_list_users', 'site_admin_get_user', 'site_admin_list_audit', 'site_admin_get_audit_event',
    'site_admin_list_early_access_requests', 'site_admin_get_early_access_request', 'site_admin_list_early_access_history']) {
    let calls = 0;
    assert.deepEqual(await requestAdminRead({ ...base, name, fetcher: async (url, options) => {
      calls++; assert.equal(url, `${base.baseUrl}/rest/v1/rpc/${name}`);
      assert.deepEqual({ ...options, signal: undefined }, { method: 'POST', cache: 'no-store', credentials: 'omit', redirect: 'error', signal: undefined,
        headers: { apikey: base.apiKey, Authorization: `Bearer ${base.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(base.args) });
      return response('{"ok":true}');
    } }), { ok: true }); assert.equal(calls, 1);
  }
  for (const name of ['site_admin_assign_role', 'site_admin_deny_early_access_request', 'admin-early-access-invitation', 'site_admin_list_account_requests', '', '../other'])
    await assert.rejects(requestAdminRead({ ...base, name, fetcher: () => { throw new Error('Must not fetch'); } }), { code: 'ADMIN_INVALID_INPUT' });
});
test('streamed responses preserve the former 262144 UTF-16-unit limit for ASCII and multibyte payloads', async () => {
  for (const char of ['x', '界', '😀']) for (const extra of [0, 2]) {
    const text = `"${char.repeat((262144 - 2) / char.length)}${'x'.repeat(extra)}"`;
    const bytes = encode(text); let offset = 0;
    const body = new ReadableStream({ pull(controller) { if (offset === bytes.length) { controller.close(); return; }
      const end = Math.min(offset + 113, bytes.length); controller.enqueue(bytes.subarray(offset, end)); offset = end; } });
    const result = requestAdminRead({ ...base, fetcher: async () => response(body) });
    if (extra) await assert.rejects(result, { code: 'ADMIN_UNAVAILABLE' }); else assert.equal(await result, text.slice(1, -1));
  }
});
test('invalid MIME, missing bodies, malformed JSON and invalid UTF-8 fail closed with cancellation', async () => {
  for (const contentType of ['', 'text/plain', 'text/html', 'application/jsonx']) {
    let cancelled = false; const body = new ReadableStream({ cancel() { cancelled = true; } });
    await assert.rejects(requestAdminRead({ ...base, fetcher: async () => response(body, { headers: { 'content-type': contentType } }) }), { code: 'ADMIN_UNAVAILABLE' });
    assert.equal(cancelled, true);
  }
  for (const body of [null, 'not json', Uint8Array.of(0x22, 0xff, 0x22), Uint8Array.of(0x22, 0xe2, 0x82)])
    await assert.rejects(requestAdminRead({ ...base, fetcher: async () => response(body) }), { code: 'ADMIN_UNAVAILABLE' });
});
test('oversized data cancels its source before reading an unbounded tail', async () => {
  for (const chunk of [encode('x'.repeat(262145)), new Uint8Array(262144 * 3 + 1)]) {
    let cancelled = false; let pulls = 0;
    const body = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(chunk); }, cancel() { cancelled = true; } });
    await assert.rejects(requestAdminRead({ ...base, fetcher: async () => response(body) }), { code: 'ADMIN_UNAVAILABLE' });
    assert.equal(cancelled, true); assert.ok(pulls <= 2);
  }
});
for (const stage of ['fetch', 'body']) for (const stop of ['timeout', 'abort']) test(`${stop} settles a stalled ${stage}, cancels the body and rejects late data`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const held = deferred(); let cancelled = false; let receivedSignal;
  const body = new ReadableStream({ cancel() { cancelled = true; } }); const controller = new AbortController();
  const pending = requestAdminRead({ ...base, signal: controller.signal, fetcher: async (url, { signal }) => {
    receivedSignal = signal; if (stage === 'fetch') await held.promise; return response(body);
  } }); const rejected = assert.rejects(pending, { code: 'ADMIN_UNAVAILABLE' }); await flush();
  if (stop === 'timeout') t.mock.timers.tick(10000); else controller.abort();
  await rejected; assert.equal(receivedSignal.aborted, true); held.resolve(); await flush(); assert.equal(cancelled, true);
});
test('HTTP failures map to fixed categories without rendering provider text', async () => {
  for (const [status, message, code] of [[401, 'private', 'ADMIN_SIGNED_OUT'], [403, 'private', 'ADMIN_DENIED'], [404, 'private', 'ADMIN_NOT_FOUND'],
    [400, 'admin_invalid_cursor', 'ADMIN_INVALID_CURSOR'], [400, 'admin_invalid_input', 'ADMIN_INVALID_INPUT'], [500, 'PRIVATE token', 'ADMIN_UNAVAILABLE']]) {
    await assert.rejects(requestAdminRead({ ...base, fetcher: async () => response(JSON.stringify({ message }), { status }) }), error => {
      assert.equal(error.code, code); assert.doesNotMatch(error.message, /PRIVATE|private|token/); return true;
    });
  }
});
test('a body that ignores cancellation releases its reader when the late read finally settles', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const held = deferred(); let reading = true; let releases = 0; let cancellations = 0;
  const reader = { read: () => held.promise, cancel: () => { cancellations++; return new Promise(() => {}); },
    releaseLock() { releases++; if (reading) throw new TypeError('Synthetic pending read'); } };
  const pending = requestAdminRead({ ...base, fetcher: async () => ({ ok: true, headers: new Headers({ 'content-type': 'application/json' }), body: { getReader: () => reader } }) });
  const rejected = assert.rejects(pending, { code: 'ADMIN_UNAVAILABLE' }); await flush(); t.mock.timers.tick(10000); await rejected;
  assert.ok(cancellations >= 1); assert.equal(releases, 1);
  reading = false; held.resolve({ done: true }); await flush(); assert.equal(releases, 2);
});
test('native user verification sends only an exact-bearer GET and projects the verified ID', async () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const value = await requestAdminReadUser({ ...base, fetcher: async (url, options) => {
    assert.equal(url, `${base.baseUrl}/auth/v1/user`); assert.equal(options.method, 'GET'); assert.equal(options.body, undefined);
    assert.equal(options.headers.Authorization, `Bearer ${base.token}`); assert.equal(options.cache, 'no-store');
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    return response(JSON.stringify({ id, email: 'PRIVATE_EMAIL', user_metadata: { role: 'site_admin' }, factors: ['PRIVATE_FACTOR'] }));
  } }); assert.deepEqual(value, { id });
  for (const invalid of [{}, { id: 1 }, { id: 'not-a-uuid' }, [], null])
    await assert.rejects(requestAdminReadUser({ ...base, fetcher: async () => response(JSON.stringify(invalid)) }), { code: 'ADMIN_UNAVAILABLE' });
  for (const status of [401, 403]) await assert.rejects(requestAdminReadUser({ ...base,
    fetcher: async () => response('{"code":"session_not_found","message":"PRIVATE"}', { status }) }), { code: 'ADMIN_SIGNED_OUT' });
});
