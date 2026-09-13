import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { createSupabaseMfaAdapter } from './mfa-auth.mjs';
import { createMfaSessionGuard } from './mfa-session-guard.mjs';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const F = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SA = '11111111-1111-4111-8111-111111111111';
const SB = '22222222-2222-4222-8222-222222222222';
const SA2 = '33333333-3333-4333-8333-333333333333';
const KEY = 'mfa-review-synthetic';
test.beforeEach((context) => {
  // The SDK logs fetch rejections. Guard errors must contain fixed copy only.
  context.mock.method(console, 'error', (...args) => {
    assert.doesNotMatch(args.map(String).join(' '), /synthetic-refresh|synthetic-signature|012345|eyJ|SYNTHETIC_PRIVATE/);
  });
});
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const factor = { id: F, factor_type: 'totp', status: 'verified', friendly_name: 'Synthetic authenticator' };
const user = (id) => ({ id, email: id === A ? 'a@example.test' : 'b@example.test', factors: id === A ? [factor] : [] });
const jwt = (id, aal, sessionId) => [
  { alg: 'HS256', typ: 'JWT' },
  { sub: id, session_id: sessionId, exp: Math.floor(Date.now() / 1000) + 3600, aal,
    amr: [{ method: 'totp', timestamp: aal === 'aal2' ? 2 : 1 }] },
].map((part) => Buffer.from(JSON.stringify(part)).toString('base64url')).concat(Buffer.from('synthetic-signature').toString('base64url')).join('.');
const session = (id, aal = 'aal1', sessionId = id === A ? SA : SB) => ({
  access_token: jwt(id, aal, sessionId), refresh_token: 'synthetic-refresh-only',
  expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: 'bearer', user: user(id),
});

async function fixture({ noLocks = false, respectAbort = false, aal = 'aal1', basePath = '', initialStorageDenied = false, initialLocksDenied = false } = {}) {
  const values = new Map();
  const control = { denyStorage: initialStorageDenied, denyLocks: initialLocksDenied, delayVerify: true, aborted: false, commitArmed: false, pauseNext: false };
  const verifyEntered = deferred(); const verifyRelease = deferred();
  const commitEntered = deferred(); const commitRelease = deferred();
  const queues = new Map();
  const locks = {
    async request(name, options, callback) {
      if (control.denyLocks) throw new Error('Synthetic lock denied');
      if (control.pauseNext) {
        control.pauseNext = false;
        commitEntered.resolve();
        await commitRelease.promise;
      }
      const result = (queues.get(name) || Promise.resolve()).catch(() => {}).then(callback);
      queues.set(name, result.catch(() => {}));
      return result;
    },
  };
  const backing = {
    getItem(key) { if (control.denyStorage) throw new Error('Synthetic storage denied'); return values.get(key) || null; },
    setItem(key, value) { if (control.denyStorage) throw new Error('Synthetic storage denied'); values.set(key, value); },
    removeItem(key) {
      if (control.denyStorage) throw new Error('Synthetic storage denied');
      values.delete(key);
      if (control.commitArmed && key === `${KEY}-code-verifier`) { control.commitArmed = false; control.pauseNext = true; }
    },
  };
  const events = [];
  const transport = async (input, options) => {
    const url = new URL(input);
    const body = options?.body ? JSON.parse(options.body) : {};
    if (url.pathname.endsWith('/token')) {
      if (url.searchParams.get('grant_type') === 'refresh_token') return Response.json(session(A, aal));
      const id = body.email === 'a@example.test' ? A : B;
      return Response.json(session(id, id === A ? aal : 'aal1', body.password === 'new-session' ? SA2 : id === A ? SA : SB));
    }
    if (url.pathname.endsWith('/user')) {
      const token = new Headers(options.headers).get('authorization').replace(/^Bearer /, '');
      return Response.json(user(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub));
    }
    if (url.pathname.endsWith('/challenge')) return Response.json({ id: C });
    if (url.pathname.endsWith('/verify')) {
      verifyEntered.resolve();
      const aborted = new Promise((_, reject) => options.signal.addEventListener('abort', () => {
        control.aborted = true;
        if (respectAbort) reject(new Error('Synthetic abort'));
      }, { once: true }));
      if (control.delayVerify) await (respectAbort ? Promise.race([verifyRelease.promise, aborted]) : verifyRelease.promise);
      if (control.loseVerifyResponse) throw new Error('SYNTHETIC_PRIVATE_RESPONSE_PAYLOAD');
      return Response.json(session(A, 'aal2'));
    }
    if (url.pathname.endsWith('/logout')) return new Response(null, { status: 204 });
    throw new Error('Unexpected synthetic endpoint');
  };
  const supabaseUrl = `https://mfa-review.example.test${basePath}`;
  const eventTarget = new EventTarget();
  const guard = createMfaSessionGuard({ supabaseUrl, storageKey: KEY,
    storage: backing, fetch: transport, locks: noLocks ? null : locks, eventTarget });
  const client = createClient(supabaseUrl, 'synthetic-publishable', {
    global: { fetch: guard.fetch }, auth: { storage: guard.storage, storageKey: KEY,
      persistSession: true, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const login = (id, password = 'synthetic-only') => client.auth.signInWithPassword({ email: id === A ? 'a@example.test' : 'b@example.test', password });
  assert.equal((await login(A)).error, null);
  const adapter = createSupabaseMfaAdapter(guard.protectAuth(client.auth));
  const observer = client.auth.onAuthStateChange((event, value) => events.push([event, value?.user.id]));
  await new Promise((resolve) => setImmediate(resolve));
  const verify = () => adapter.verify({ expectedUserId: A, factorId: F, code: '012345' });
  const current = () => JSON.parse(values.get(KEY) || 'null');
  const close = () => { adapter.dispose(); guard.dispose(); observer.data.subscription.unsubscribe(); };
  return { client, guard, adapter, login, verify, current, close, values, events, eventTarget, control, locks, backing,
    verifyEntered, verifyRelease, commitEntered, commitRelease };
}

test('actual SDK promotes a successful same-session verification without leaking helper secrets to storage', async () => {
  const f = await fixture();
  try {
    f.control.delayVerify = false;
    assert.equal((await f.verify()).verified, true);
    assert.equal(f.current().user.id, A);
    assert.deepEqual([...f.values.keys()].sort(), [KEY, `${KEY}-mfa-session-revision`].sort());
    assert.match(f.values.get(`${KEY}-mfa-session-revision`), /^[0-9a-f-]{36}$/);
  } finally { f.close(); }
});

for (const transition of ['different account', 'A→B→A', 'same actor new session', 'sign out']) {
  test(`actual SDK delayed verify cannot overwrite ${transition}`, async () => {
    const f = await fixture();
    try {
      const pending = f.verify().then(() => null, (error) => error);
      await f.verifyEntered.promise;
      if (transition === 'sign out') await f.client.auth.signOut({ scope: 'local' });
      else if (transition === 'same actor new session') await f.login(A, 'new-session');
      else { await f.login(B); if (transition === 'A→B→A') await f.login(A); }
      const expected = f.values.get(KEY);
      f.verifyRelease.resolve();
      assert.ok(['MFA_ACTOR_CHANGED', 'MFA_NOT_CONFIRMED'].includes((await pending).code));
      assert.equal(f.values.get(KEY), expected);
      assert.equal(f.events.some(([event]) => event === 'MFA_CHALLENGE_VERIFIED'), false);
      assert.equal(f.control.aborted, true);
    } finally { f.close(); }
  });
}

test('actual SDK commit-boundary race rejects before session persistence and auth notification', async () => {
  const f = await fixture();
  try {
    const pending = f.verify().then(() => null, (error) => error);
    await f.verifyEntered.promise;
    f.control.commitArmed = true;
    f.verifyRelease.resolve();
    await f.commitEntered.promise;
    assert.equal((await f.login(B)).error, null);
    const expected = f.values.get(KEY);
    f.commitRelease.resolve();
    assert.ok(['MFA_ACTOR_CHANGED', 'MFA_NOT_CONFIRMED'].includes((await pending).code));
    assert.equal(f.values.get(KEY), expected);
    assert.equal(f.events.some(([event]) => event === 'MFA_CHALLENGE_VERIFIED'), false);
  } finally { f.close(); }
});

test('actual SDK cancellation drops an in-flight request, even without a later response', async () => {
  const f = await fixture({ respectAbort: true });
  try {
    const pending = f.verify().then(() => null, (error) => error);
    await f.verifyEntered.promise;
    await f.login(B);
    assert.equal((await pending).code, 'MFA_ACTOR_CHANGED');
    assert.equal(f.current().user.id, B);
  } finally { f.close(); }
});

for (const method of ['explicit cancel', 'pagehide']) {
  test(`${method} abandons a verification even when the transport ignores abort, and allows later retry`, async () => {
    const f = await fixture();
    try {
      const pending = f.verify().then(() => null, (error) => error);
      await f.verifyEntered.promise;
      const expected = f.values.get(KEY);
      if (method === 'pagehide') f.eventTarget.dispatchEvent(new Event('pagehide'));
      else f.guard.cancelPending();
      assert.equal((await pending).code, 'MFA_ACTOR_CHANGED');
      assert.equal(f.values.get(KEY), expected);
      f.verifyRelease.resolve();
      f.control.delayVerify = false;
      assert.equal((await f.verify()).verified, true);
    } finally { f.close(); }
  });
}

test('explicit cancellation rejects a queued MFA operation without a provider request', async () => {
  const f = await fixture();
  try {
    // Invoke the public guard facade directly so both operations are enqueued
    // before the first one can reach its transport.
    const facade = createMfaSessionGuard({ supabaseUrl: 'https://mfa-review.example.test', storageKey: KEY,
      storage: f.backing, fetch: async () => { throw new Error('No request expected'); }, locks: f.locks, eventTarget: null });
    const auth = facade.protectAuth(f.client.auth);
    const pending = auth.mfa.challenge({ factorId: F }).then(() => null, (error) => error);
    facade.cancelPending();
    assert.equal((await pending).code, 'MFA_ACTOR_CHANGED');
    facade.dispose();
  } finally { f.close(); }
});

test('cancel after verify response but before storage commit cannot promote the abandoned session', async () => {
  const f = await fixture();
  try {
    const pending = f.verify().then(() => null, (error) => error);
    await f.verifyEntered.promise;
    f.control.commitArmed = true;
    f.verifyRelease.resolve();
    await f.commitEntered.promise;
    const expected = f.values.get(KEY);
    f.guard.cancelPending();
    f.commitRelease.resolve();
    assert.equal((await pending).code, 'MFA_ACTOR_CHANGED');
    assert.equal(f.values.get(KEY), expected);
    assert.equal(f.events.some(([event]) => event === 'MFA_CHALLENGE_VERIFIED'), false);
  } finally { f.close(); }
});

test('a stale MFA commit cannot reject a later unrelated normal login at PKCE cleanup', async () => {
  const f = await fixture();
  try {
    const pending = f.verify().then(() => null, (error) => error);
    await f.verifyEntered.promise;
    f.control.commitArmed = true;
    f.verifyRelease.resolve();
    await f.commitEntered.promise;
    assert.equal((await f.login(B)).error, null);
    f.values.set(`${KEY}-code-verifier`, 'SYNTHETIC_PRIVATE_NEW_PKCE');
    assert.equal((await f.login(A, 'new-session')).error, null);
    const expected = f.values.get(KEY);
    f.commitRelease.resolve();
    assert.ok(await pending);
    assert.equal(f.values.get(KEY), expected);
    assert.equal(f.values.get(`${KEY}-code-verifier`), 'SYNTHETIC_PRIVATE_NEW_PKCE');
  } finally { f.close(); }
});

test('base-path Auth endpoints use the same guarded transport', async () => {
  const f = await fixture({ basePath: '/__mfa_fixture__' });
  try {
    const pending = f.verify().then(() => null, (error) => error);
    await f.verifyEntered.promise;
    await f.login(B);
    f.verifyRelease.resolve();
    assert.ok(await pending);
    assert.equal(f.current().user.id, B);
  } finally { f.close(); }
});

test('ordinary lost verification responses remain retryable and never expose raw transport errors', async () => {
  const f = await fixture();
  try {
    f.control.delayVerify = false;
    f.control.loseVerifyResponse = true;
    await assert.rejects(f.verify(), { code: 'MFA_NOT_CONFIRMED' });
    f.control.loseVerifyResponse = false;
    assert.equal((await f.verify()).verified, true);
  } finally { f.close(); }
});

test('same-actor token refresh does not invalidate an in-flight MFA operation', async () => {
  const f = await fixture();
  try {
    const pending = f.verify();
    await f.verifyEntered.promise;
    assert.equal((await f.client.auth.refreshSession()).error, null);
    f.verifyRelease.resolve();
    assert.equal((await pending).verified, true);
  } finally { f.close(); }
});

test('an already AAL2 session still performs a new verified challenge', async () => {
  const f = await fixture({ aal: 'aal2' });
  try { f.control.delayVerify = false; assert.equal((await f.verify()).verified, true); }
  finally { f.close(); }
});

for (const failure of ['missing Web Locks', 'denied Web Lock', 'denied storage']) {
  test(`${failure} never silently runs unguarded MFA`, async () => {
    const f = await fixture({ noLocks: failure === 'missing Web Locks' });
    try {
      const auth = f.guard.protectAuth; // A second attachment is intentionally disallowed.
      assert.throws(() => auth(f.client.auth), /already attached/);
      if (failure === 'denied Web Lock') f.control.denyLocks = true;
      if (failure === 'denied storage') f.control.denyStorage = true;
      await assert.rejects(f.verify());
      assert.equal(f.current().user.id, A);
      assert.equal(f.events.some(([event]) => event === 'MFA_CHALLENGE_VERIFIED'), false);
    } finally { f.control.denyLocks = false; f.control.denyStorage = false; f.close(); }
  });
}

test('initial browser storage denial preserves ordinary in-memory sign-in, but not MFA setup', async () => {
  const f = await fixture({ initialStorageDenied: true });
  try {
    assert.equal((await f.client.auth.getUser()).data.user.id, A);
    assert.equal((await f.login(B)).error, null);
    assert.equal((await f.client.auth.getUser()).data.user.id, B);
    assert.equal((await f.login(A)).error, null);
    await assert.rejects(f.verify(), { code: 'MFA_COORDINATION_UNAVAILABLE' });
    assert.equal(f.values.size, 0);
  } finally { f.close(); }
});

test('denied Web Lock capability preserves ordinary sign-in, but MFA remains fail-closed', async () => {
  const f = await fixture({ initialLocksDenied: true });
  try {
    assert.equal((await f.login(B)).error, null);
    assert.equal((await f.client.auth.getUser()).data.user.id, B);
    assert.equal((await f.login(A)).error, null);
    await assert.rejects(f.verify(), { code: 'MFA_COORDINATION_UNAVAILABLE' });
    assert.equal(f.current().user.id, A);
  } finally { f.close(); }
});

test('direct unwrapped public MFA calls fail closed instead of bypassing the guard', async () => {
  const f = await fixture();
  try {
    const result = await f.client.auth.mfa.verify({ factorId: F, challengeId: C, code: '012345' });
    assert.ok(result.error);
    assert.equal(f.current().user.id, A);
  } finally { f.close(); }
});

test('another document sharing the lock/storage can replace the session before the guarded commit', async () => {
  const f = await fixture();
  const other = createMfaSessionGuard({ supabaseUrl: 'https://mfa-review.example.test', storageKey: KEY,
    storage: f.backing, fetch: async () => { throw new Error('Must not call network'); }, locks: f.locks, eventTarget: null });
  try {
    const pending = f.verify().then(() => null, (error) => error);
    await f.verifyEntered.promise;
    await other.storage.setItem(KEY, JSON.stringify(session(B)));
    await other.storage.setItem(KEY, JSON.stringify(session(A)));
    f.verifyRelease.resolve();
    assert.ok(['MFA_ACTOR_CHANGED', 'MFA_NOT_CONFIRMED'].includes((await pending).code));
    assert.equal(f.current().access_token, session(A).access_token);
    assert.equal(f.events.some(([event]) => event === 'MFA_CHALLENGE_VERIFIED'), false);
  } finally { other.dispose(); f.close(); }
});
