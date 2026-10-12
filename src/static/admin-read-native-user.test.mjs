import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from '@supabase/supabase-js';
import { createAdminReadClient } from './admin-read-client.mjs';
import { requestAdminReadUser } from './admin-read-transport.mjs';
import { authSessionIdentity } from './mfa-auth.mjs';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const session = id => ({ user: { id, email: `${id}@example.invalid` }, refresh_token: `synthetic-${id}`, token_type: 'bearer', expires_in: 3600, expires_at: 9999999999,
  access_token: [encode({ alg: 'HS256' }), encode({ sub: id, session_id: id, exp: 9999999999, aal: 'aal2' }), encode('synthetic')].join('.') });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

for (const mode of ['SDK sign-in', 'silent stored session']) test(`late native session_not_found cannot clear a replacement ${mode}`, { timeout: 3000 }, async () => {
  const key = `admin-native-${mode}`; const first = session(A); const second = session(B);
  const stored = new Map([[key, JSON.stringify(first)]]); const entered = deferred(); const reply = deferred(); const lateSettled = deferred();
  const events = []; let sdkUserReads = 0; let nativeSignal; let rpcCalls = 0;
  const request = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path === '/auth/v1/token') return Response.json(second);
    assert.equal(path, '/auth/v1/user'); assert.equal(options.method, 'GET');
    const bearer = new Headers(options.headers).get('authorization');
    if (bearer === `Bearer ${second.access_token}`) return Response.json(second.user);
    assert.equal(bearer, `Bearer ${first.access_token}`); nativeSignal = options.signal; entered.resolve(); await reply.promise;
    lateSettled.resolve(); return Response.json({ code: 'session_not_found', message: 'PRIVATE old failure' }, { status: 403, headers: { 'x-supabase-api-version': '2024-01-01' } });
  };
  const sdk = createClient('https://synthetic.invalid', 'synthetic-key', { global: { fetch: request }, auth: {
    storageKey: key, storage: { getItem: name => stored.get(name) ?? null, setItem: (name, value) => stored.set(name, value), removeItem: name => stored.delete(name) },
    persistSession: true, autoRefreshToken: false, detectSessionInUrl: false } });
  let client;
  try {
    await sdk.auth.getSession();
    client = createAdminReadClient({ getSession: async () => (await sdk.auth.getSession()).data.session,
      getUser: token => { sdkUserReads++; return sdk.auth.getUser(token); },
      getReadUser: (token, { signal }) => requestAdminReadUser({ baseUrl: 'https://synthetic.invalid', apiKey: 'synthetic-key', token, signal, fetcher: request }),
      sessionIdentity: authSessionIdentity, readTimeoutMs: 25,
      subscribe: listener => { const { data } = sdk.auth.onAuthStateChange((event, value) => { events.push(event); listener({ event, sessionIdentity: authSessionIdentity(value) }); }); return () => data.subscription.unsubscribe(); },
      request: async (name, args) => { rpcCalls++; return { schemaVersion: 1, actorId: args.target_expected_actor_id, items: [] }; } });
    const old = client.read('site_admin_list_users'); const rejected = assert.rejects(old, { code: 'ADMIN_UNAVAILABLE' }); await entered.promise; await rejected;
    assert.equal(nativeSignal.aborted, true); assert.equal(rpcCalls, 0);
    if (mode === 'SDK sign-in') assert.equal((await sdk.auth.signInWithPassword({ email: second.user.email, password: 'synthetic password' })).error, null);
    else stored.set(key, JSON.stringify(second));
    assert.equal((await client.read('site_admin_list_users', {}, { expectedUserId: B })).actorId, B);
    reply.resolve(); await lateSettled.promise; await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal((await sdk.auth.getSession()).data.session.user.id, B); assert.equal(JSON.parse(stored.get(key)).access_token, second.access_token);
    assert.equal((await client.read('site_admin_list_users', {}, { expectedUserId: B })).actorId, B);
    assert.equal(sdkUserReads, 0); assert.equal(rpcCalls, 2); assert.equal(events.includes('SIGNED_OUT'), false);
  } finally { reply.resolve(); client?.destroy(); await sdk.auth.stopAutoRefresh(); }
});
