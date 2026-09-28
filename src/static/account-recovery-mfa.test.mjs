import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createPasswordRecoveryController } from './account-recovery-session.mjs';
import { authSessionIdentity } from './mfa-auth.mjs';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FACTOR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CHALLENGE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TIME = 1801108800000;
const PASSWORD = 'private synthetic new password';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function session({ id = ID, sid = SID, aal = 'aal1', exp = TIME / 1000 + 3600 } = {}) {
  return { user: { id }, token_type: 'bearer', expires_in: 3600,
    access_token: [encode({ alg: 'HS256' }), encode({ sub: id, session_id: sid, aal, exp }), encode('synthetic signature')].join('.'),
    refresh_token: 'PRIVATE_RETURNED_REFRESH_TOKEN' };
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(options = {}) {
  const anchor = session(); const elevated = session({ aal: 'aal2' });
  let active = anchor; let observer; let time = TIME; let insideObserver = false;
  let factors = [{ id: FACTOR, factor_type: 'totp', status: 'verified', friendly_name: 'My authenticator' }];
  const calls = []; const reads = []; const events = new Map();
  const controller = createPasswordRecoveryController({
    sessionIdentity: authSessionIdentity, supabaseUrl: 'https://synthetic.invalid', apiKey: 'synthetic-publishable-key',
    deadlineMs: options.deadlineMs || 1000, now: () => time, authStorageKey: 'synthetic-storage',
    eventTarget: { addEventListener: (event, callback) => events.set(event, callback), removeEventListener: event => events.delete(event) },
    auth: {
      onAuthStateChange(callback) { observer = callback; return { data: { subscription: { unsubscribe() {} } } }; },
      async getSession() { assert.equal(insideObserver, false); reads.push(['session']); await options.readHook?.('session'); return { data: { session: active }, error: null }; },
      async getUser(token) { assert.equal(insideObserver, false); reads.push(['user', token]); await options.readHook?.('user', token);
        return { data: { user: { id: options.nativeUserId || ID, factors } }, error: options.userError || null }; },
      mfa: { async getAuthenticatorAssuranceLevel(token) { assert.equal(insideObserver, false); reads.push(['aal', token]); await options.readHook?.('aal', token);
        return { data: options.assurance || { currentLevel: token === elevated.access_token ? 'aal2' : 'aal1', nextLevel: factors.some(factor => factor.status === 'verified') ? 'aal2' : 'aal1' }, error: null }; },
        challenge() { throw new Error('MUTABLE_SDK_CHALLENGE'); }, verify() { throw new Error('MUTABLE_SDK_VERIFY'); } },
      setSession() { throw new Error('MUTABLE_SDK_SET_SESSION'); },
    },
    async request(url, init) {
      calls.push({ url, init });
      const response = await options.request?.(url, init, { elevated, calls });
      if (response !== undefined) return response;
      if (url.endsWith('/challenge')) return Response.json({ id: CHALLENGE, type: 'totp', expires_at: time / 1000 + 120 });
      if (url.endsWith('/verify')) return Response.json(elevated);
      if (init.method === 'PUT') return Response.json({ id: ID });
      return new Response(null, { status: 204 });
    },
  });
  const emit = (event, next = active) => { active = next; insideObserver = true; try { observer(event, next); } finally { insideObserver = false; } };
  return { controller, calls, reads, events, anchor, elevated, emit, active: () => active,
    factors: value => { factors = value; }, advance: value => { time += value; }, setSession: value => { active = value; },
    async required() { emit('PASSWORD_RECOVERY'); const state = await controller.verify(); assert.equal(state.phase, 'mfa-required'); return state.owner; },
    async challenged() { const owner = await this.required(); await controller.challengeMfa(owner, FACTOR); return owner; },
    async ready() { const owner = await this.challenged(); await controller.verifyMfa(owner, '123456'); assert.equal(controller.getState().phase, 'ready'); return owner; },
  };
}

test('native MFA upgrade stays private and exact derived bearer alone owns password/logout; SDK anchor remains untouched', async () => {
  const f = fixture(); const owner = await f.ready();
  assert.equal(f.active(), f.anchor);
  assert.deepEqual(f.controller.getState().factors, [{ id: FACTOR, friendlyName: 'My authenticator' }]);
  assert.doesNotMatch(JSON.stringify(f.controller.getState()), /access_token|refresh_token|PRIVATE|eyJ/);
  await f.controller.complete(owner, PASSWORD);
  assert.deepEqual(f.calls.map(call => new URL(call.url).pathname), [
    `/auth/v1/factors/${FACTOR}/challenge`, `/auth/v1/factors/${FACTOR}/verify`, '/auth/v1/user', '/auth/v1/logout',
  ]);
  for (const [index, call] of f.calls.entries()) {
    assert.equal(call.init.headers.Authorization, `Bearer ${index < 2 ? f.anchor.access_token : f.elevated.access_token}`);
    assert.equal(call.init.headers['X-Supabase-Api-Version'], '2024-01-01');
    assert.equal(call.init.cache, 'no-store'); assert.equal(call.init.credentials, 'omit'); assert.equal(call.init.redirect, 'error');
  }
  assert.deepEqual(JSON.parse(f.calls[1].init.body), { challenge_id: CHALLENGE, code: '123456' });
  assert.equal(f.active(), f.anchor);
  await assert.rejects(f.controller.verifyMfa(owner, '123456')); await assert.rejects(f.controller.complete(owner, PASSWORD));
  f.controller.destroy();
});

test('exact native 422 invalid-code rejection permits only explicit fresh challenge, never replay of consumed challenge', async () => {
  let rejected = false;
  const f = fixture({ request: (url) => {
    if (url.endsWith('/verify') && !rejected) { rejected = true; return Response.json({ code: 'mfa_verification_failed', message: 'PRIVATE_PROVIDER_MESSAGE' }, { status: 422 }); }
  } });
  const owner = await f.challenged();
  const retry = await f.controller.verifyMfa(owner, '123456');
  assert.equal(retry.phase, 'mfa-required'); assert.equal(retry.code, 'RECOVERY_MFA_REJECTED'); assert.equal(retry.owner, owner);
  await assert.rejects(f.controller.verifyMfa(owner, '123456')); assert.equal(f.calls.length, 2);
  await f.controller.challengeMfa(owner, FACTOR); await f.controller.verifyMfa(owner, '654321');
  assert.equal(f.controller.getState().phase, 'ready'); assert.equal(f.calls.length, 4); f.controller.destroy();
});

for (const response of [
  () => Response.json({ code: 'mfa_verification_failed', message: 'PRIVATE' }, { status: 400 }),
  () => Response.json({ code: 'mfa_verification_rejected', message: 'PRIVATE' }, { status: 403 }),
  () => Response.json({ code: 'mfa_verification_failed', message: 'PRIVATE' }, { status: 429 }),
  () => new Response('PRIVATE', { status: 503 }),
  () => new Response('not-json'),
  () => { throw new Error('PRIVATE_NETWORK'); },
]) test(`unknown or nonretryable MFA result retires capability (${response.toString().slice(6, 72)})`, async () => {
  const f = fixture({ request: url => url.endsWith('/verify') ? response() : undefined });
  const owner = await f.challenged(); await assert.rejects(f.controller.verifyMfa(owner, '123456'), error => !error.message.includes('PRIVATE'));
  assert.equal(f.controller.getState().owner, null); await assert.rejects(f.controller.challengeMfa(owner, FACTOR));
  assert.equal(f.calls.length, 2); f.controller.destroy();
});

for (const value of [session({ id: OTHER, aal: 'aal2' }), session({ sid: FACTOR, aal: 'aal2' }), session(),
  session({ aal: 'aal2', exp: TIME / 1000 }), session({ aal: 'aal2', exp: TIME / 1000 + 86401 }),
  { ...session({ aal: 'aal2' }), token_type: 'other' }, { ...session({ aal: 'aal2' }), expires_in: 0 },
  { user: { id: ID, user_metadata: { aal: 'aal2' } }, access_token: 'PRIVATE_INVALID_TOKEN' },
]) test(`malformed/mismatched/unexpired-AAL2 receipt requirements reject ${JSON.stringify(value).length}-byte case`, async () => {
  const f = fixture({ request: url => url.endsWith('/verify') ? Response.json(value) : undefined });
  const owner = await f.challenged(); await assert.rejects(f.controller.verifyMfa(owner, '123456'));
  assert.equal(f.controller.getState().owner, null); assert.equal(f.calls.length, 2); f.controller.destroy();
});

for (const event of ['SIGNED_OUT', 'TOKEN_REFRESHED', 'USER_UPDATED', 'MFA_CHALLENGE_VERIFIED', 'ABA', 'storage', 'pagehide']) {
  for (const phase of ['mfa-challenging', 'mfa-verifying', 'ready']) test(`${event} at ${phase} synchronously retires the owner without accepting a same-SID event`, async () => {
    const f = fixture(); const owner = await f.required();
    const invalidate = () => {
      if (event === 'ABA') { f.emit('SIGNED_IN', session({ id: OTHER })); f.emit('SIGNED_IN', f.anchor); }
      else if (event === 'storage') f.events.get('storage')({ key: 'synthetic-storage' });
      else if (event === 'pagehide') f.events.get('pagehide')();
      else f.emit(event, event === 'SIGNED_OUT' ? null : f.elevated);
    };
    f.controller.subscribe(state => { if (state.phase === phase) invalidate(); });
    if (phase === 'mfa-challenging') await assert.rejects(f.controller.challengeMfa(owner, FACTOR));
    else { await f.controller.challengeMfa(owner, FACTOR); await assert.rejects(f.controller.verifyMfa(owner, '123456')); }
    assert.equal(f.controller.getState().owner, null); await assert.rejects(f.controller.complete(owner, PASSWORD));
    assert.equal(f.calls.length, phase === 'mfa-challenging' ? 0 : phase === 'mfa-verifying' ? 1 : 2); f.controller.destroy();
  });
}

for (const at of ['challenge', 'verify', 'password']) test(`factor loss before ${at} cannot remove the MFA requirement`, async () => {
  const f = fixture(); const owner = at === 'challenge' ? await f.required() : at === 'verify' ? await f.challenged() : await f.ready();
  f.factors([]);
  await assert.rejects(at === 'challenge' ? f.controller.challengeMfa(owner, FACTOR) : at === 'verify' ? f.controller.verifyMfa(owner, '123456') : f.controller.complete(owner, PASSWORD));
  assert.equal(f.calls.length, at === 'challenge' ? 0 : at === 'verify' ? 1 : 2);
  assert.equal(f.controller.getState().owner, null); f.controller.destroy();
});

test('phone-only or unverified factors remain blocked; no enrollment or replacement is attempted', async () => {
  for (const factor of [{ factor_type: 'phone', status: 'verified' }, { factor_type: 'totp', status: 'unverified' }]) {
    const f = fixture({ assurance: { currentLevel: 'aal1', nextLevel: 'aal2' } }); f.factors([{ id: FACTOR, ...factor }]);
    f.emit('PASSWORD_RECOVERY'); await assert.rejects(f.controller.verify(), { code: 'RECOVERY_MFA_UNSUPPORTED' });
    assert.equal(f.calls.length, 0); f.controller.destroy();
  }
});

test('expired challenge and expired derived token cannot dispatch verification/password', async () => {
  const f = fixture(); const owner = await f.challenged(); f.advance(121000);
  await assert.rejects(f.controller.verifyMfa(owner, '123456')); assert.equal(f.calls.length, 1); f.controller.destroy();
  const g = fixture(); const ready = await g.ready(); g.advance(3600000);
  await assert.rejects(g.controller.complete(ready, PASSWORD)); assert.equal(g.calls.length, 2); g.controller.destroy();
});

for (const when of ['last-session-read', 'working-publication']) test(`derived expiry during ${when} cannot dispatch or leave a working recovery`, async () => {
  let armed = false; let sessions = 0;
  const f = fixture({ readHook: kind => { if (armed && kind === 'session' && ++sessions === 2) f.advance(3600000); } });
  const owner = await f.ready();
  if (when === 'last-session-read') armed = true;
  else f.controller.subscribe(state => { if (state.phase === 'working') f.advance(3600000); });
  await assert.rejects(f.controller.complete(owner, PASSWORD));
  assert.equal(f.calls.length, 2); assert.equal(f.controller.getState().phase, 'blocked'); assert.equal(f.controller.getState().owner, null);
  f.controller.destroy();
});

for (const patch of [{ id: '../user' }, { type: 'phone' }, { expires_at: TIME / 1000 },
  { expires_at: TIME / 1000 + 601 }, { expires_at: '1801108920' }, { expires_at: null }]) {
  test(`challenge response rejects invalid bounded shape ${JSON.stringify(patch)}`, async () => {
    const f = fixture({ request: url => url.endsWith('/challenge')
      ? Response.json({ id: CHALLENGE, type: 'totp', expires_at: TIME / 1000 + 120, ...patch }) : undefined });
    const owner = await f.required(); await assert.rejects(f.controller.challengeMfa(owner, FACTOR));
    assert.equal(f.controller.getState().owner, null); assert.equal(f.calls.length, 1); f.controller.destroy();
  });
}

for (const phase of ['challenge', 'verify']) {
  for (const kind of ['oversized', 'stalled']) test(`${phase} ${kind} response is cancelled and cannot enable password`, async () => {
    let cancelled = false;
    const f = fixture({ deadlineMs: 20, request: url => url.endsWith(`/${phase}`) ? new Response(new ReadableStream({
      start(stream) { if (kind === 'oversized') stream.enqueue(new Uint8Array(65537)); },
      cancel() { cancelled = true; },
    })) : undefined });
    const owner = phase === 'challenge' ? await f.required() : await f.challenged();
    await assert.rejects(phase === 'challenge' ? f.controller.challengeMfa(owner, FACTOR) : f.controller.verifyMfa(owner, '123456'));
    assert.equal(cancelled, true); assert.equal(f.controller.getState().owner, null);
    await assert.rejects(f.controller.complete(owner, PASSWORD)); f.controller.destroy();
  });
}

for (const phase of ['challenge', 'verify', 'derived-check']) {
  for (const change of ['ABA', 'silent-token']) test(`${change} while awaiting ${phase} cannot publish or use a verified bearer`, async () => {
    const entered = deferred(); const gate = deferred(); let armed = false;
    const f = fixture({ request: async url => {
      if (armed && url.endsWith(`/${phase}`)) { entered.resolve(); await gate.promise; }
    }, readHook: async (kind, token) => {
      if (armed && phase === 'derived-check' && kind === 'user' && token === f.elevated.access_token) { entered.resolve(); await gate.promise; }
    } });
    const owner = phase === 'challenge' ? await f.required() : await f.challenged(); armed = true;
    const pending = phase === 'challenge' ? f.controller.challengeMfa(owner, FACTOR) : f.controller.verifyMfa(owner, '123456');
    await entered.promise;
    if (change === 'ABA') { f.emit('SIGNED_IN', session({ id: OTHER })); f.emit('SIGNED_IN', f.anchor); }
    else f.setSession(session({ exp: TIME / 1000 + 1800 }));
    gate.resolve(); await assert.rejects(pending); assert.equal(f.controller.getState().owner, null);
    await assert.rejects(f.controller.complete(owner, PASSWORD)); assert.equal(f.calls.some(call => call.init.method === 'PUT'), false); f.controller.destroy();
  });
}

test('a locally parsed AAL2 token cannot substitute for current native assurance validation', async () => {
  const assurance = { currentLevel: 'aal1', nextLevel: 'aal2' };
  const f = fixture({ assurance }); const owner = await f.challenged();
  await assert.rejects(f.controller.verifyMfa(owner, '123456'));
  assert.equal(f.controller.getState().owner, null); assert.equal(f.calls.length, 2); f.controller.destroy();
});

test('invalid code, forged handle and duplicate clicks never start extra native requests', async () => {
  const entered = deferred(); const gate = deferred();
  const f = fixture({ request: async url => { if (url.endsWith('/verify')) { entered.resolve(); await gate.promise; } } });
  const owner = await f.challenged();
  for (const code of ['', '12345', '1234567', '１２３４５６', 123456, { toString() { throw new Error('PRIVATE'); } }]) await assert.rejects(f.controller.verifyMfa(owner, code), { code: 'RECOVERY_MFA_CODE' });
  await assert.rejects(f.controller.verifyMfa({}, '123456')); assert.equal(f.calls.length, 1);
  const pending = f.controller.verifyMfa(owner, '123456'); await entered.promise;
  await assert.rejects(f.controller.verifyMfa(owner, '123456')); await assert.rejects(f.controller.challengeMfa(owner, FACTOR));
  gate.resolve(); await pending; assert.equal(f.calls.length, 2); f.controller.destroy();
});

test('late verification response after deadline never enables password or installs credentials', async () => {
  const gate = deferred(); const f = fixture({ deadlineMs: 15, request: url => url.endsWith('/verify') ? gate.promise : undefined });
  const owner = await f.challenged(); await assert.rejects(f.controller.verifyMfa(owner, '123456'));
  gate.resolve(Response.json(f.elevated)); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.controller.getState().owner, null); assert.equal(f.active(), f.anchor);
  await assert.rejects(f.controller.complete(owner, PASSWORD)); assert.equal(f.calls.length, 2); f.controller.destroy();
});

test('replacement during derived-token PUT still revokes only the captured elevated session', async () => {
  const entered = deferred(); const gate = deferred(); const f = fixture({ request: async (url, init) => {
    if (init.method === 'PUT') { entered.resolve(); await gate.promise; return Response.json({ id: ID }); }
  } });
  const owner = await f.ready(); const completion = f.controller.complete(owner, PASSWORD); await entered.promise;
  const replacement = session({ id: OTHER }); f.emit('SIGNED_IN', replacement); gate.resolve(); await completion;
  assert.equal(f.active(), replacement); assert.equal(f.controller.getState().owner, null);
  assert.equal(f.calls.at(-1).init.headers.Authorization, `Bearer ${f.elevated.access_token}`); f.controller.destroy();
});

test('MFA reset UI never persists codes, changes SDK session, or replaces factors', () => {
  const source = readFileSync(new URL('./account-recovery-session.mjs', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('./password-recovery.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../../reset-password.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../assets/password-recovery.css', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\.setSession\(|\.mfa\.(?:challenge|verify|enroll|unenroll)\(|localStorage|sessionStorage|console\./);
  assert.doesNotMatch(ui, /localStorage|sessionStorage|console\./);
  assert.match(ui, /mfaCode\.value = ''/); assert.match(ui, /code = ''; mfaInFlight = false/);
  assert.match(html, /autocomplete="one-time-code"/); assert.match(html, /A reset link cannot remove MFA/);
  assert.doesNotMatch(html, /user-scalable=no|maximum-scale=1/);
  assert.match(html, /src\/assets\/password-recovery\.css/);
  assert.match(css, /#passwordRecoveryMfaFactor\s*\{/); assert.match(css, /min-height: 52px/);
  assert.match(css, /forced-colors: active/); assert.match(css, /:focus-visible/);
});
