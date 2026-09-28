import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createPasswordRecoveryController } from './account-recovery-session.mjs';
import { authSessionIdentity } from './mfa-auth.mjs';
import { createClient } from '@supabase/supabase-js';
import { createPasswordRecoveryOwnerBridge } from './password-recovery-owner.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const sid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const password = 'new synthetic password';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const session = (userId = id, sessionId = sid, extra = '') => ({ user: { id: userId }, access_token: [
  encode({ alg: 'HS256' }), encode({ sub: userId, session_id: sessionId, exp: 9999999999, aal: 'aal1', extra }), encode('synthetic'),
].join('.') });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(options = {}) {
  let active = session(); let observer; let inCallback = false; let unsubscribed = false;
  const calls = []; const nativeCalls = []; const events = new Map();
  const auth = {
    onAuthStateChange(callback) { observer = callback; return { data: { subscription: { unsubscribe() { unsubscribed = true; } } } }; },
    getSession: async () => { assert.equal(inCallback, false); nativeCalls.push(['session']);
      await options.sessionHook?.(); return { data: { session: active }, error: null }; },
    getUser: async token => { assert.equal(inCallback, false); nativeCalls.push(['user', token]);
      await options.userHook?.(); return { data: { user: { id: options.userId || id } }, error: options.userError || null }; },
    mfa: { getAuthenticatorAssuranceLevel: async token => { assert.equal(inCallback, false); nativeCalls.push(['mfa', token]);
      await options.mfaHook?.(); return { data: options.assurance || { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null }; } },
    signOut: () => { throw new Error('SDK_SIGNOUT_FORBIDDEN'); }, updateUser: () => { throw new Error('SDK_UPDATE_FORBIDDEN'); },
  };
  const controller = createPasswordRecoveryController({ auth, sessionIdentity: authSessionIdentity,
    supabaseUrl: 'https://synthetic.invalid', apiKey: 'synthetic-public-key', authStorageKey: 'sb-synthetic-auth-token',
    deadlineMs: options.deadlineMs || 100,
    eventTarget: { addEventListener: (name, callback) => events.set(name, callback), removeEventListener: name => events.delete(name) },
    request: async (url, init) => {
      calls.push({ url, init });
      if (options.request) return options.request(url, init);
      return init.method === 'PUT' ? Response.json({ id }) : new Response(null, { status: 204 });
    },
  });
  const emit = (event, next = active) => { active = next; inCallback = true; try { observer(event, next); } finally { inCallback = false; } };
  return { controller, calls, nativeCalls, events, emit, active: () => active,
    setSession: value => { active = value; }, unsubscribed: () => unsubscribed,
    async ready() { emit('PASSWORD_RECOVERY'); return (await controller.verify()).owner; } };
}

test('ordinary sessions never become recovery authority; PASSWORD_RECOVERY creates only an opaque owner', async () => {
  const f = fixture(); f.emit('INITIAL_SESSION'); await assert.rejects(f.controller.verify());
  assert.equal(f.nativeCalls.length, 0); assert.equal(f.calls.length, 0);
  f.emit('PASSWORD_RECOVERY'); assert.equal(f.controller.getState().phase, 'pending');
  assert.deepEqual(f.controller.getState().owner, {}); assert.equal(f.nativeCalls.length, 0);
  const ready = await f.controller.verify(); assert.equal(ready.phase, 'ready');
  assert.doesNotMatch(JSON.stringify(ready), /access_token|11111111|synthetic/);
  f.controller.destroy();
});

test('exact native bearer owns getUser, current MFA, password PUT and global logout without SDK cache changes', async () => {
  const f = fixture(); const owner = await f.ready(); const token = f.active().access_token;
  const result = await f.controller.complete(owner, password);
  assert.deepEqual(result, { completed: true, owner, sessionsRevoked: 'global' });
  assert.equal(f.active().access_token, token);
  assert.equal(f.calls.length, 2); assert.equal(f.calls[0].url, 'https://synthetic.invalid/auth/v1/user');
  assert.equal(f.calls[1].url, 'https://synthetic.invalid/auth/v1/logout?scope=global');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { password });
  for (const { init } of f.calls) {
    assert.equal(init.headers.Authorization, `Bearer ${token}`); assert.equal(init.headers.apikey, 'synthetic-public-key');
    assert.equal(init.cache, 'no-store'); assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
  }
  for (const [kind, bearer] of f.nativeCalls) if (kind !== 'session') assert.equal(bearer, token);
  await assert.rejects(f.controller.complete(owner, password)); assert.equal(f.calls.length, 2);
  f.controller.destroy();
});

for (const event of ['SIGNED_OUT', 'TOKEN_REFRESHED', 'USER_UPDATED', 'MFA_CHALLENGE_VERIFIED', 'replacement', 'ABA', 'pagehide', 'storage']) {
  test(`${event} synchronously invalidates the recovery owner before another mutation`, async () => {
    const f = fixture(); const owner = await f.ready();
    if (event === 'replacement' || event === 'ABA') {
      f.emit('SIGNED_IN', session(otherId)); if (event === 'ABA') f.emit('SIGNED_IN', session());
    } else if (event === 'pagehide') f.events.get('pagehide')();
    else if (event === 'storage') f.events.get('storage')({ key: 'sb-synthetic-auth-token' });
    else f.emit(event, event === 'SIGNED_OUT' ? null : f.active());
    assert.equal(f.controller.getState().owner, null);
    await assert.rejects(f.controller.complete(owner, password)); assert.equal(f.calls.length, 0);
    f.controller.destroy();
  });
}

for (const hook of ['userHook', 'mfaHook', 'sessionHook']) {
  test(`replacement while awaiting ${hook} cannot dispatch a password request`, async () => {
    let armed = false; const gate = deferred(); const entered = deferred();
    const f = fixture({ [hook]: () => { if (armed) { entered.resolve(); return gate.promise; } } });
    const owner = await f.ready(); armed = true;
    const pending = f.controller.complete(owner, password); await entered.promise;
    f.emit('SIGNED_IN', session(otherId)); f.emit('SIGNED_IN', session()); gate.resolve();
    await assert.rejects(pending); assert.equal(f.calls.length, 0); f.controller.destroy();
  });
}

test('replacement after the final validation but before dispatch is fenced synchronously', async () => {
  const f = fixture(); const owner = await f.ready();
  f.controller.subscribe(state => { if (state.phase === 'working') f.emit('SIGNED_IN', session(otherId)); });
  await assert.rejects(f.controller.complete(owner, password)); assert.equal(f.calls.length, 0); f.controller.destroy();
});

test('replacement during a password response still revokes only captured tokens and never clears the replacement', async () => {
  const entered = deferred(); const gate = deferred();
  const f = fixture({ request: async (url, init) => {
    if (init.method === 'PUT') { entered.resolve(); await gate.promise; return Response.json({ id }); }
    return new Response(null, { status: 204 });
  } });
  const owner = await f.ready(); const originalToken = f.active().access_token;
  const pending = f.controller.complete(owner, password); await entered.promise;
  const replacement = session(otherId); f.emit('SIGNED_IN', replacement); gate.resolve();
  const result = await pending; assert.equal(result.sessionsRevoked, 'global');
  assert.equal(f.active(), replacement); assert.equal(f.controller.getState().owner, null);
  assert.equal(f.calls[1].init.headers.Authorization, `Bearer ${originalToken}`); f.controller.destroy();
});

test('same-user replacement session and new recovery generation never inherit or receive old completion', async () => {
  const entered = deferred(); const gate = deferred();
  const f = fixture({ request: async (url, init) => {
    if (init.method === 'PUT') { entered.resolve(); await gate.promise; return Response.json({ id }); }
    return new Response(null, { status: 204 });
  } });
  const first = await f.ready(); const pending = f.controller.complete(first, password); await entered.promise;
  f.emit('PASSWORD_RECOVERY', session(id, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));
  const second = f.controller.getState().owner; assert.notEqual(first, second); gate.resolve(); await pending;
  assert.equal(f.controller.getState().owner, second); assert.equal(f.controller.getState().phase, 'pending'); f.controller.destroy();
});

for (const field of ['id', 'session', 'token']) {
  test(`silent ${field} replacement is rejected by exact current-session reads`, async () => {
    const f = fixture(); const owner = await f.ready();
    f.setSession(field === 'id' ? session(otherId) : field === 'session' ? session(id, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') : session(id, sid, 'refresh'));
    await assert.rejects(f.controller.complete(owner, password)); assert.equal(f.calls.length, 0); f.controller.destroy();
  });
}

test('current verified MFA is enforced, malformed assurance and wrong native actor fail closed', async () => {
  for (const options of [{ assurance: { currentLevel: 'aal1', nextLevel: 'aal2' } }, { assurance: {} }, { userId: otherId }, { userError: { message: 'PRIVATE_AUTH_PAYLOAD' } }]) {
    const f = fixture(options); f.emit('PASSWORD_RECOVERY');
    await assert.rejects(f.controller.verify(), error => { assert.doesNotMatch(error.message, /PRIVATE/); return true; });
    assert.equal(f.calls.length, 0); f.controller.destroy();
  }
  const verified = fixture({ assurance: { currentLevel: 'aal2', nextLevel: 'aal2' } });
  const owner = await verified.ready(); await verified.controller.complete(owner, password); verified.controller.destroy();
});

test('a failed native ownership check cannot be resurrected by restoring an old cached session', async () => {
  const f = fixture(); const owner = await f.ready();
  f.setSession(session(otherId)); await assert.rejects(f.controller.complete(owner,password));
  assert.equal(f.controller.getState().owner,null);
  f.setSession(session()); await assert.rejects(f.controller.verify()); await assert.rejects(f.controller.complete(owner,password));
  assert.equal(f.calls.length,0); f.controller.destroy();
});

test('global outage falls back only to local revocation of the same captured token', async () => {
  const f = fixture({ request: async (url, init) => init.method === 'PUT' ? Response.json({ id })
    : new Response(null, { status: url.endsWith('global') ? 503 : 204 }) });
  const owner = await f.ready(); const result = await f.controller.complete(owner, password);
  assert.equal(result.sessionsRevoked, 'local'); assert.equal(f.calls.length, 3);
  assert.equal(f.calls[2].url, 'https://synthetic.invalid/auth/v1/logout?scope=local');
  assert.equal(new Set(f.calls.map(call => call.init.headers.Authorization)).size, 1); f.controller.destroy();
});

test('all revocation failures return fixed unconfirmed status without undoing a confirmed password change', async () => {
  const f = fixture({ request: async (url, init) => {
    if (init.method === 'PUT') return Response.json({ id }); throw new Error('PRIVATE_TOKEN_PAYLOAD');
  } });
  const owner = await f.ready(); const result = await f.controller.complete(owner, password);
  assert.equal(result.completed, true); assert.equal(result.sessionsRevoked, 'unconfirmed');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/); await assert.rejects(f.controller.complete(owner, password)); f.controller.destroy();
});

test('unknown password response is consumed, token-bound logout attempted, and blind retry denied', async () => {
  const f = fixture({ request: async (url, init) => { if (init.method === 'PUT') throw new Error('PRIVATE_BODY'); return new Response(null, { status: 204 }); } });
  const owner = await f.ready();
  await assert.rejects(f.controller.complete(owner, password), { code: 'RECOVERY_UNCONFIRMED' });
  await assert.rejects(f.controller.complete(owner, password)); assert.equal(f.calls.length, 2); f.controller.destroy();
});

test('deadlines stop late native validation from ever dispatching; password timeout cannot retry', async () => {
  const gate = deferred(); const f = fixture({ deadlineMs: 10, userHook: () => gate.promise });
  f.emit('PASSWORD_RECOVERY'); await assert.rejects(f.controller.verify()); gate.resolve();
  await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(f.calls.length, 0); f.controller.destroy();
  const pendingPut = deferred();
  const timed = fixture({ deadlineMs: 10, request: (url, init) => init.method === 'PUT' ? pendingPut.promise : Promise.resolve(new Response(null, { status: 204 })) });
  const owner = await timed.ready(); await assert.rejects(timed.controller.complete(owner, password), { code: 'RECOVERY_UNCONFIRMED' });
  pendingPut.resolve(Response.json({ id })); await assert.rejects(timed.controller.complete(owner, password));
  assert.equal(timed.calls.length, 2); timed.controller.destroy();
});

test('oversized response is cancelled, malformed or cross-owner receipt is never success', async () => {
  let cancelled = false;
  for (const response of [Response.json({ id: otherId }), new Response('not json'), new Response(new ReadableStream({
    start(stream) { stream.enqueue(new Uint8Array(65537)); }, cancel() { cancelled = true; },
  }))]) {
    const f = fixture({ request: async (url, init) => init.method === 'PUT' ? response : new Response(null, { status: 204 }) });
    const owner = await f.ready(); await assert.rejects(f.controller.complete(owner, password), { code: 'RECOVERY_UNCONFIRMED' }); f.controller.destroy();
  }
  assert.equal(cancelled, true);
});

test('invalid passwords, forged handles, and session accessors never dispatch or leak raw values', async () => {
  const f = fixture(); const owner = await f.ready();
  for (const value of ['', 'short', 'a'.repeat(1025), { toString() { throw new Error('PRIVATE'); } }]) await assert.rejects(f.controller.complete(owner, value), { code: 'RECOVERY_PASSWORD' });
  await assert.rejects(f.controller.complete({}, password));
  let read = false; f.emit('PASSWORD_RECOVERY', { user: { id }, get access_token() { read = true; throw new Error('PRIVATE'); } });
  assert.equal(read, false); assert.equal(f.controller.getState().owner, null); assert.equal(f.calls.length, 0); f.controller.destroy();
});

test('recovery UI/API never select an SDK mutation owner, log payloads, or claim local browser logout', () => {
  const api = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
  const area = api.slice(api.indexOf('const passwordRecoveryOwnerBridge ='), api.indexOf('const ACCOUNT_REQUEST_COLUMNS ='));
  assert.match(area, /passwordRecoveryController\.complete\(owner, password\)/);
  assert.doesNotMatch(area, /updateUser|signOut|localStorage|clearLocalAuthenticatedIdentity|console\./);
  const ui = readFileSync(new URL('./password-recovery.js', import.meta.url), 'utf8');
  assert.match(ui, /completePasswordRecovery\(resetPassword\.value, submittedOwner\)/);
  assert.match(ui, /recoveryOwner !== submittedOwner/); assert.match(ui, /setTimeout\(/);
  assert.doesNotMatch(ui, /console\.|this browser was signed out|all sessions were signed out/);
});

test('actual SDK recovery event and native MFA checks cannot replace a newer SDK account during password completion', async () => {
  const stored = new Map(); const calls = []; const putEntered = deferred(); const putReply = deferred();
  const nativeSession = userId => ({ ...session(userId), refresh_token: `synthetic-${userId}`, token_type: 'bearer',
    expires_in: 3600, expires_at: 9999999999,
    user: { id: userId, email: userId === id ? 'original@example.test' : 'replacement@example.test',
      email_confirmed_at: '2026-09-27T00:00:00Z', factors: [] } });
  const first = nativeSession(id); const second = nativeSession(otherId);
  const request = async (url, init = {}) => {
    const target = new URL(url); const headers = new Headers(init.headers);
    const bearer = headers.get('authorization'); calls.push({ target, method: init.method, bearer });
    if (target.pathname.endsWith('/verify')) return Response.json(first);
    if (target.pathname.endsWith('/token')) return Response.json(second);
    if (target.pathname.endsWith('/user') && init.method === 'GET') {
      assert.equal(bearer, `Bearer ${first.access_token}`); return Response.json(first.user);
    }
    if (target.pathname.endsWith('/user') && init.method === 'PUT') {
      assert.equal(bearer, `Bearer ${first.access_token}`); putEntered.resolve(); await putReply.promise;
      return Response.json(first.user);
    }
    assert.equal(target.pathname, '/auth/v1/logout'); assert.equal(bearer, `Bearer ${first.access_token}`);
    return new Response(null, { status: 204 });
  };
  const client = createClient('https://synthetic.invalid', 'synthetic-public-key', {
    global: { fetch: request }, auth: { storageKey: 'recovery-owner-sdk-test',
      storage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) },
      persistSession: true, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const bridge = createPasswordRecoveryOwnerBridge({ auth: client.auth, sessionIdentity: authSessionIdentity });
  let controller;
  try {
    assert.equal((await client.auth.verifyOtp({ type: 'recovery', token_hash: 'synthetic-native-recovery' })).error, null);
    controller = createPasswordRecoveryController({ auth: {
      onAuthStateChange: listener => bridge.connect(listener),
      getSession: () => client.auth.getSession(), getUser: token => client.auth.getUser(token),
      mfa: { getAuthenticatorAssuranceLevel: token => client.auth.mfa.getAuthenticatorAssuranceLevel(token) },
    }, sessionIdentity: authSessionIdentity,
    supabaseUrl: 'https://synthetic.invalid', apiKey: 'synthetic-public-key', request, deadlineMs: 1000 });
    assert.equal(controller.getState().phase, 'pending');
    const { owner } = await controller.verify(); const completion = controller.complete(owner, password); await putEntered.promise;
    assert.equal((await client.auth.signInWithPassword({ email: second.user.email, password: 'synthetic replacement password' })).error, null);
    assert.equal(controller.getState().owner, null); putReply.resolve();
    assert.equal((await completion).sessionsRevoked, 'global');
    assert.equal((await client.auth.getSession()).data.session.user.id, otherId);
    assert.equal(JSON.parse(stored.get('recovery-owner-sdk-test')).access_token, second.access_token);
    assert.equal(calls.filter(call => call.method === 'PUT').length, 1);
    assert.equal(calls.filter(call => call.target.pathname.endsWith('/logout')).length, 1);
  } finally { controller?.destroy(); bridge.destroy(); await client.auth.stopAutoRefresh(); }
});
