import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { createAuthEntryTransition } from './auth-entry-transition.mjs';
import { finishAuthLanding } from './auth-landing.mjs';
import { authSessionIdentity, mfaError } from './mfa-auth.mjs';
import { mfaChallengeHref } from './mfa-navigation.mjs';

// Execute the actual entry module, including its unexported startup, with only
// DOM/SDK seams replaced. The landing/session/entry helpers remain real code.
const source = readFileSync(new URL('./auth.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?from '[^']+';\n/gm, '');
const apiSource = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
const sanitizerSource = apiSource.slice(apiSource.indexOf('export function sanitizeReturnTo('),
  apiSource.indexOf('export async function clearAuthSession(')).replace('export function', 'function');
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const S = '11111111-1111-4111-8111-111111111111';
const T = '22222222-2222-4222-8222-222222222222';
const verified = () => ({ verified: true, requiresChallenge: false });
function session(actor = A, sid = S, suffix = 'saved') {
  return { user: { id: actor, user_metadata: { role: 'site_admin' } },
    access_token: `synthetic.${Buffer.from(JSON.stringify({ sub: actor, session_id: sid })).toString('base64url')}.${suffix}` };
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function until(predicate, description) {
  for (let i = 0; i < 256; i += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail(`Entry did not reach ${description}`);
}
async function flush() { for (let i = 0; i < 64; i += 1) await Promise.resolve(); }

function fixture(t, options = {}) {
  const listeners = new Set(), formListeners = new Map();
  const f = { session: options.session === undefined ? session() : options.session,
    calls: [], replacements: [], explicitNavigations: [], saved: [], alerts: [],
    entry: createAuthEntryTransition(), listeners, subscriptions: 0, unsubscriptions: 0 };
  const button = { disabled: false, textContent: 'Log in' };
  const status = { hidden: true, textContent: '' };
  const fields = { email: { value: 'synthetic@example.test' }, password: { value: 'Synthetic password' }, authResumeStatus: status };
  if (options.signup) fields.name = { value: 'Synthetic member' };
  const form = { hidden: false, querySelector: () => button,
    addEventListener: (event, listener) => formListeners.set(event, listener) };
  let href = '/login.html';
  const location = { origin: 'https://synthetic.example.test', search: options.search || '', hash: options.hash || '',
    get href() { return href; }, set href(value) { href = value; f.explicitNavigations.push(value); },
    replace(value) { f.replacements.push(value); } };
  const window = new EventTarget();
  Object.assign(window, { location, alert: value => f.alerts.push(value) });
  f.window = window; f.button = button; f.status = status; f.fields = fields;
  f.count = kind => f.calls.filter(call => call.kind === kind).length;
  f.emit = (event, next = f.session) => {
    f.session = next;
    const payload = { event, user: next ? { userId: next.user.id } : null, sessionIdentity: authSessionIdentity(next) };
    for (const listener of [...listeners]) listener(payload);
  };
  f.input = () => formListeners.get('input')?.({});
  f.submit = () => formListeners.get('submit')({ preventDefault() {} });
  f.done = () => until(() => listeners.size === 0, 'all startup listeners to be released');
  f.assertStayed = () => {
    assert.deepEqual(f.replacements, []); assert.deepEqual(f.explicitNavigations, []);
    assert.deepEqual(f.saved, []); assert.deepEqual(f.alerts, []);
    assert.equal(button.disabled, false); assert.equal(status.hidden, true); assert.equal(status.textContent, '');
    assert.equal(f.entry.isCurrent(f.entry.capture()), true, 'Failed/cancelled startup restores optional hydration.');
    assert.equal(f.count('password'), 0); assert.equal(f.unsubscriptions, f.subscriptions);
  };
  t.after(async () => { window.dispatchEvent(new Event('pagehide')); await flush(); });
  const sanitizeReturnTo = runInNewContext(sanitizerSource + '\nsanitizeReturnTo;', { URL, URLSearchParams, window });
  runInNewContext(source, {
    URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    authEntryTransition: f.entry, finishAuthLanding, authSessionIdentity, mfaError, mfaChallengeHref,
    window, document: { getElementById: id => id === 'authForm' ? form : fields[id] || null, querySelector: () => null },
    RELEASE_GATES: { publicSignupEnabled: true }, initReveal() { f.revealed = true; },
    hasSupabaseAuthentication: () => options.enabled !== false,
    hasPendingPasswordRecovery: () => options.pendingRecovery === true,
    sanitizeReturnTo, isInviteReturnPath: () => false, isChallengeStartReturnPath: () => false,
    async getAuthSession() {
      f.calls.push({ kind: 'session' });
      return options.readSession ? options.readSession(f.count('session'), f) : f.session;
    },
    getMfaAuthAdapter: () => ({ async getState(args) {
      f.calls.push({ kind: 'mfa', expectedUserId: args.expectedUserId });
      assert.equal(args.expectedUserId, A, 'Saved-session MFA is always bound to its captured actor.');
      return options.readMfa ? options.readMfa(f.count('mfa'), f) : verified();
    } }),
    async getSiteAdminContext(args) {
      f.calls.push({ kind: 'admin', expectedUserId: args.expectedUserId, signal: args.signal });
      assert.equal(args.expectedUserId, A); assert.equal(args.signal.aborted, false);
      return options.readAdmin ? options.readAdmin(f) : { schemaVersion: 1, actorId: A, role: options.role || 'member', adminReady: options.role === 'site_admin' };
    },
    async getBillingState() {
      f.calls.push({ kind: 'billing' });
      return options.readBilling ? options.readBilling(f) : { appAccess: options.appAccess !== false };
    },
    subscribeToAuthStateChanges(listener) {
      f.subscriptions += 1; listeners.add(listener);
      return () => { assert(listeners.delete(listener), 'Each subscription is released exactly once.'); f.unsubscriptions += 1; };
    },
    async signInWithPassword(args) {
      f.calls.push({ kind: 'password', args });
      assert.equal(f.entry.capture(), null);
      return options.password ? options.password(f) : { session: null };
    },
    signUpWithPassword() { assert.fail('Saved session must not create an account.'); },
    saveLocalUserFromSession(value) { f.saved.push(value); },
    isLocalDemoMode: () => false,
    saveLocalMockUser() { assert.fail('Native saved sessions must not write mock users.'); },
  });
  assert.equal(f.revealed, true, 'Reveal is not held by saved-session requests.');
  return f;
}

for (const [role, appAccess, target] of [
  ['site_admin', false, './admin.html'], ['member', true, './dashboard.html'], ['member', false, './billing.html'],
]) test(`saved verified ${role} resumes at ${target} without a password mutation`, async t => {
  const f = fixture(t, { role, appAccess }); await f.done();
  assert.deepEqual(f.replacements, [target]); assert.deepEqual(f.explicitNavigations, []);
  assert.equal(f.saved.length, 1); assert.equal(f.saved[0], f.session); assert.equal(f.count('password'), 0);
  assert.equal(f.count('mfa'), 2, 'Assurance is rechecked immediately before landing.');
  assert.equal(f.count('admin'), 1); assert.equal(f.count('billing'), role === 'member' ? 1 : 0);
  assert.equal(f.entry.capture(), null, 'Successful navigation does not resume departing-document hydration.');
});

for (const target of ['./support.html', './invite.html', './profile.html#billing', './dashboard.html?start=solo']) {
  test(`saved verified session preserves safe returnTo ${target}`, async t => {
    const f = fixture(t, { role: 'site_admin', search: '?returnTo=' + encodeURIComponent(target) }); await f.done();
    assert.deepEqual(f.replacements, [target]); assert.equal(f.count('mfa'), 2);
    assert.equal(f.count('admin'), 0); assert.equal(f.count('billing'), 0); assert.equal(f.count('password'), 0);
  });
}
test('external returnTo cannot redirect a saved session off-origin', async t => {
  const f = fixture(t, { search: '?returnTo=' + encodeURIComponent('https://outside.example.test/path') }); await f.done();
  assert.deepEqual(f.replacements, ['./dashboard.html']);
});
test('saved AAL1 session requiring its existing authenticator goes only to MFA challenge', async t => {
  const f = fixture(t, { search: '?returnTo=.%2Fdashboard.html%3Fstart%3Dsolo', readMfa: () => ({ verified: false, requiresChallenge: true }) }); await f.done();
  assert.deepEqual(f.replacements, [mfaChallengeHref('./dashboard.html?start=solo', f.window.location.origin)]);
  assert.equal(f.count('mfa'), 1); assert.equal(f.count('admin'), 0); assert.equal(f.count('billing'), 0);
  assert.equal(f.count('password'), 0); assert.deepEqual(f.saved, []);
});
for (const [label, value] of [['missing', null], ['missing token', { user: { id: A } }], ['invalid identity', { user: { id: A }, access_token: 'synthetic.invalid.signature' }]]) {
  test(`${label} saved session leaves the explicit login usable`, async t => {
    const f = fixture(t, { session: value }); await f.done(); f.assertStayed(); assert.equal(f.count('mfa'), 0);
  });
}
test('an unverified non-MFA session is not silently resumed', async t => {
  const f = fixture(t, { readMfa: () => ({ verified: false, requiresChallenge: false }) }); await f.done(); f.assertStayed();
  assert.equal(f.count('admin'), 0);
});
for (const [label, options] of [['signup', { signup: true }], ['mock/unconfigured Auth', { enabled: false }], ['SDK-cleaned pending recovery', { pendingRecovery: true }]]) {
  test(`${label} does not begin saved-login work`, async t => {
    const f = fixture(t, options); await flush(); assert.deepEqual(f.calls, []); assert.equal(f.subscriptions, 0); f.assertStayed();
  });
}
for (const [channel, fragment] of [
  ['search', 'code=x'], ['search', 'CoDe=x'], ['search', '%63ode=x'], ['search', 'ACCESS_TOKEN=x'],
  ['search', 'token_hash=x'], ['search', 'provider_refresh_token=x'], ['search', 'error_description=x'], ['search', 'TYPE=RECOVERY'],
  ['hash', 'code=x'], ['hash', '%43ODE=x'], ['hash', 'refresh_token=x'], ['hash', 'Provider_Token=x'],
  ['hash', 'TOKEN=x'], ['hash', 'error_code=x'], ['hash', 'error=x'], ['hash', 'type=Recovery'],
]) test(`callback ${channel} ${fragment} skips all saved-session reads`, async t => {
  const f = fixture(t, { [channel]: (channel === 'search' ? '?' : '#') + fragment }); await flush();
  assert.deepEqual(f.calls, []); assert.equal(f.subscriptions, 0); f.assertStayed();
});
for (const target of ['./login.html', './register', './forgot-password.html', './reset-password/', './support.html?code=x',
  './support.html?%63ode=x', './support.html?CoDe=x', './dashboard.html#ACCESS_TOKEN=x']) {
  test(`auth/callback returnTo ${target} cannot trigger saved resume`, async t => {
    const f = fixture(t, { search: '?returnTo=' + encodeURIComponent(target) }); await flush();
    assert.deepEqual(f.calls, []); f.assertStayed();
  });
}

for (const stage of ['mfa', 'landing']) {
  for (const cause of ['signout', 'recovery', 'refresh', 'replacement', 'ABA', 'pagehide', 'storage']) {
    test(`${cause} while ${stage} is pending prevents saved navigation and ignores late completion`, async t => {
      const hold = deferred();
      const f = fixture(t, stage === 'mfa' ? { readMfa: () => hold.promise } : { readAdmin: () => hold.promise });
      await until(() => f.count(stage === 'mfa' ? 'mfa' : 'admin') === 1, stage);
      if (cause === 'signout') f.emit('SIGNED_OUT', null);
      else if (cause === 'recovery') f.emit('PASSWORD_RECOVERY');
      else if (cause === 'refresh') f.emit('TOKEN_REFRESHED', session(A, S, 'refreshed'));
      else if (cause === 'replacement') f.emit('SIGNED_IN', session(A, T));
      else if (cause === 'ABA') { const original = f.session; f.emit('SIGNED_IN', session(B)); f.emit('SIGNED_IN', original); }
      else f.window.dispatchEvent(new Event(cause));
      await f.done(); f.assertStayed();
      if (stage === 'landing') assert.equal(f.calls.find(call => call.kind === 'admin').signal.aborted, true);
      const count = f.calls.length;
      hold.resolve(stage === 'mfa' ? verified() : { schemaVersion: 1, actorId: A, role: 'site_admin', adminReady: true });
      await flush(); f.assertStayed(); assert.equal(f.calls.length, count, 'Cancelled work cannot continue or retry.');
    });
  }
}
for (const cause of ['signout', 'recovery', 'ABA']) {
  test(`${cause} during initial session acquisition prevents even the first MFA read`, async t => {
    const hold = deferred(); const f = fixture(t, { readSession: () => hold.promise });
    if (cause === 'ABA') { f.emit('INITIAL_SESSION'); const original = f.session; f.emit('SIGNED_IN', session(B)); f.emit('SIGNED_IN', original); }
    else f.emit(cause === 'signout' ? 'SIGNED_OUT' : 'PASSWORD_RECOVERY', cause === 'signout' ? null : f.session);
    await f.done(); hold.resolve(session()); await flush(); f.assertStayed(); assert.equal(f.count('mfa'), 0);
  });
}
test('one initial refresh may supply the saved snapshot without a password retry', async t => {
  const hold = deferred(); const f = fixture(t, { readSession: (n, state) => n === 1 ? hold.promise : state.session });
  f.emit('INITIAL_SESSION'); f.emit('TOKEN_REFRESHED', session(A, S, 'first-refresh')); hold.resolve(f.session);
  await f.done(); assert.deepEqual(f.replacements, ['./dashboard.html']); assert.equal(f.count('password'), 0);
});
test('two refreshes during initial acquisition cancel rather than revive a saved decision', async t => {
  const hold = deferred(); const f = fixture(t, { readSession: () => hold.promise });
  f.emit('TOKEN_REFRESHED', session(A, S, 'first')); f.emit('TOKEN_REFRESHED', session(A, S, 'second'));
  await f.done(); hold.resolve(f.session); await flush(); f.assertStayed(); assert.equal(f.count('mfa'), 0);
});
for (const changed of [session(B), session(A, T), session(A, S, 'silent-token-change')]) {
  test(`silent replacement after MFA blocks landing (${authSessionIdentity(changed)}/${changed.access_token.split('.').at(-1)})`, async t => {
    const f = fixture(t, { readMfa: (_n, state) => { state.session = changed; return verified(); } });
    await f.done(); f.assertStayed(); assert.equal(f.count('admin'), 0);
  });
}
test('final native MFA recheck can refuse an otherwise valid admin landing', async t => {
  const f = fixture(t, { role: 'site_admin', readMfa: n => n === 1 ? verified() : { verified: false, requiresChallenge: true } });
  await f.done(); f.assertStayed(); assert.equal(f.count('mfa'), 2); assert.equal(f.count('admin'), 1);
});
for (const stage of ['mfa', 'landing']) {
  test(`typing preempts pending ${stage} and leaves late success unable to navigate`, async t => {
    const hold = deferred(); const f = fixture(t, stage === 'mfa' ? { readMfa: () => hold.promise } : { readAdmin: () => hold.promise });
    await until(() => f.count(stage === 'mfa' ? 'mfa' : 'admin') === 1, stage); f.input(); await f.done();
    f.assertStayed(); hold.resolve(stage === 'mfa' ? verified() : { schemaVersion: 1, actorId: A, role: 'site_admin', adminReady: true });
    await flush(); f.assertStayed();
  });
}
test('explicit password submit owns continuation and the obsolete saved-session result cannot replace it', async t => {
  const hold = deferred(); const fresh = session(B, T, 'explicit');
  const f = fixture(t, { search: '?returnTo=.%2Fsupport.html', readMfa: () => hold.promise,
    password(state) { state.session = fresh; state.emit('SIGNED_IN', fresh); return { session: fresh, mfaRequired: false }; } });
  await until(() => f.count('mfa') === 1, 'initial MFA'); await f.submit(); await f.done();
  assert.equal(f.count('password'), 1); assert.deepEqual(f.explicitNavigations, ['./support.html']); assert.deepEqual(f.replacements, []);
  assert.deepEqual(f.saved, [fresh]); hold.resolve(verified()); await flush();
  assert.deepEqual(f.replacements, []); assert.deepEqual(f.explicitNavigations, ['./support.html']); assert.deepEqual(f.saved, [fresh]);
});
for (const stage of ['session', 'mfa', 'admin', 'billing', 'finalMfa']) {
  test(`hung ${stage} is bounded to ten seconds and never retries or publishes late`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] }); const hold = deferred();
    const options = stage === 'session' ? { readSession: () => hold.promise }
      : stage === 'mfa' ? { readMfa: () => hold.promise }
        : stage === 'admin' ? { readAdmin: () => hold.promise }
          : stage === 'billing' ? { readBilling: () => hold.promise }
            : { readMfa: n => n === 2 ? hold.promise : verified() };
    const f = fixture(t, options);
    await until(() => f.count(stage === 'finalMfa' ? 'mfa' : stage) === (stage === 'finalMfa' ? 2 : 1), stage);
    t.mock.timers.tick(9_999); await flush(); assert.equal(f.entry.capture(), null); assert.deepEqual(f.replacements, []);
    t.mock.timers.tick(1); await f.done(); f.assertStayed(); const count = f.calls.length;
    hold.resolve(stage === 'session' ? session() : stage === 'admin' ? { schemaVersion: 1, actorId: A, role: 'member', adminReady: false }
      : stage === 'billing' ? { appAccess: true } : verified());
    await flush(); f.assertStayed(); assert.equal(f.calls.length, count);
  });
}
