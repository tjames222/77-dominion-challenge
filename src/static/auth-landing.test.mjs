import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finishAuthLanding } from './auth-landing.mjs';
import { authSessionIdentity } from './mfa-auth.mjs';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const S = '11111111-1111-4111-8111-111111111111';
const T = '22222222-2222-4222-8222-222222222222';
function session(actor = A, sid = S, suffix = 'original') {
  return { user: { id: actor, email: 'admin@example.test', user_metadata: { role: 'site_admin', is_admin: true } },
    access_token: `synthetic.${Buffer.from(JSON.stringify({ sub: actor, session_id: sid })).toString('base64url')}.${suffix}` };
}
function fixture({ role = 'member', ready = false, appAccess = false, returnTo = './dashboard.html' } = {}) {
  const state = { session: session(), calls: [], navigations: [], listener: null, unsubs: 0 };
  const lifecycle = new EventTarget();
  const dependencies = {
    session: state.session, returnTo, lifecycle,
    async getAuthSession() { state.calls.push('session'); return state.session; },
    async getSiteAdminContext(options) {
      state.calls.push('admin'); assert.equal(options.expectedUserId, A); assert.equal(options.signal.aborted, false);
      return { schemaVersion: 1, actorId: A, role, adminReady: ready };
    },
    async getBillingState() { state.calls.push('billing'); return { appAccess }; },
    subscribeToAuthStateChanges(listener) { state.listener = listener; return () => { state.unsubs += 1; state.listener = null; }; },
    navigate(target) { state.navigations.push(target); },
  };
  state.emit = (event, current = state.session) => {
    state.session = current;
    state.listener?.({ event, user: current ? { userId: current.user.id } : null, sessionIdentity: authSessionIdentity(current) });
  };
  return { state, dependencies, lifecycle, run: (overrides) => finishAuthLanding({ ...dependencies, ...overrides }) };
}

for (const ready of [false, true]) {
  test(`server-confirmed admin lands at the admin gate (ready=${ready}) without billing`, async () => {
    const f = fixture({ role: 'site_admin', ready }); await f.run();
    assert.deepEqual(f.state.navigations, ['./admin.html']);
    assert.equal(f.state.calls.filter(call => call === 'admin').length, 1);
    assert.equal(f.state.calls.includes('billing'), false); assert.equal(f.state.unsubs, 1);
  });
}
for (const appAccess of [false, true]) {
  test(`ordinary member retains ${appAccess ? 'dashboard' : 'billing'} despite admin-looking metadata`, async () => {
    const f = fixture({ appAccess }); await f.run();
    assert.deepEqual(f.state.navigations, [appAccess ? './dashboard.html' : './billing.html']);
    assert.deepEqual(f.state.calls.filter(call => call !== 'session'), ['admin', 'billing']);
  });
}
for (const returnTo of ['./early-access-invite.html', './invite.html', './support.html', './account-security.html', './profile.html#billing', './dashboard.html?start=solo', './dashboard.html#challenge', './dashboard?start=group', './dashboard/#challenge']) {
  test(`explicit safe continuation ${returnTo} takes precedence without optional role/billing reads`, async () => {
    const f = fixture({ role: 'site_admin', returnTo }); await f.run();
    assert.deepEqual(f.state.navigations, [returnTo]); assert.equal(f.state.calls.every(call => call === 'session'), true);
  });
}
for (const returnTo of ['', './dashboard', '/dashboard', '/dashboard/', './dashboard/', 'dashboard.html']) {
  test(`default destination ${returnTo || '(missing)'} also resolves server admin context`, async () => {
    const f = fixture({ role: 'site_admin' }); await f.run({ returnTo }); assert.deepEqual(f.state.navigations, ['./admin.html']);
  });
}
for (const [name, value] of [['missing', null], ['missing token', { user: { id: A } }], ['malformed token', { user: { id: A }, access_token: 'malformed' }], ['mismatched user', session(B)]]) {
  test(`missing or mismatched owner fails before a role read (${name})`, async () => {
    const f = fixture(); await assert.rejects(f.run({ session: value }), { code: 'AUTH_LANDING_CHANGED' });
    assert.deepEqual(f.state.navigations, []); assert.equal(f.state.calls.includes('admin'), false);
  });
}
for (const context of [null, { schemaVersion: 2, actorId: A, role: 'site_admin', adminReady: true }, { schemaVersion: 1, actorId: B, role: 'site_admin', adminReady: true }, { schemaVersion: 1, actorId: A, role: 'owner', adminReady: true }]) {
  test(`malformed/foreign server context cannot fall through to billing (${JSON.stringify(context)})`, async () => {
    const f = fixture(); await assert.rejects(f.run({ getSiteAdminContext: async () => context }), { code: 'AUTH_LANDING_UNAVAILABLE' });
    assert.deepEqual(f.state.navigations, []); assert.equal(f.state.calls.includes('billing'), false);
  });
}
test('provider errors are fixed, retryable, and never expose payload or choose a fallback', async () => {
  const f = fixture();
  await assert.rejects(f.run({ getSiteAdminContext: async () => { throw new Error('PRIVATE_PROVIDER_PAYLOAD'); } }), {
    code: 'AUTH_LANDING_UNAVAILABLE', message: 'Unable to open your account right now. Please try again.',
  });
  assert.deepEqual(f.state.navigations, []); assert.equal(f.state.unsubs, 1);
  await f.run(); assert.deepEqual(f.state.navigations, ['./billing.html']);
});
for (const changed of [session(B), session(A, T), session(A, S, 'replacement')]) {
  test(`silent owner/bearer replacement during the server read blocks navigation (${authSessionIdentity(changed)}/${changed.access_token.split('.').at(-1)})`, async () => {
    const f = fixture({ role: 'site_admin' });
    await assert.rejects(f.run({ getSiteAdminContext: async options => {
      const result = await f.dependencies.getSiteAdminContext(options); f.state.session = changed; return result;
    } }), { code: 'AUTH_LANDING_CHANGED' }); assert.deepEqual(f.state.navigations, []);
  });
}
for (const event of ['SIGNED_OUT', 'TOKEN_REFRESHED', 'USER_UPDATED', 'MFA_CHALLENGE_VERIFIED', 'PASSWORD_RECOVERY']) {
  test(`${event} synchronously invalidates the in-flight decision`, async () => {
    const f = fixture({ role: 'site_admin' });
    await assert.rejects(f.run({ getSiteAdminContext: async options => {
      f.state.emit(event); return f.dependencies.getSiteAdminContext({ ...options, signal: new AbortController().signal });
    } }), { code: 'AUTH_LANDING_CHANGED' }); assert.deepEqual(f.state.navigations, []);
  });
}
test('account A→B→A cannot revive a pending decision even when the exact bearer returns', async () => {
  const f = fixture({ role: 'site_admin' }); const original = f.state.session;
  await assert.rejects(f.run({ getSiteAdminContext: async () => {
    f.state.emit('SIGNED_IN', session(B)); f.state.emit('SIGNED_IN', original);
    return { schemaVersion: 1, actorId: A, role: 'site_admin', adminReady: true };
  } }), { code: 'AUTH_LANDING_CHANGED' }); assert.deepEqual(f.state.navigations, []);
});
test('same-owner, same-bearer refocus does not invalidate a server decision', async () => {
  const f = fixture({ role: 'site_admin' });
  await f.run({ getSiteAdminContext: async options => { f.state.emit('SIGNED_IN'); return f.dependencies.getSiteAdminContext(options); } });
  assert.deepEqual(f.state.navigations, ['./admin.html']);
});
for (const stage of ['getBillingState', 'beforeNavigate']) {
  test(`replacement during ${stage} cannot publish a previously correct role read`, async () => {
    const f = fixture();
    await assert.rejects(f.run({ [stage]: async () => { f.state.session = session(B); return { appAccess: true }; } }), { code: 'AUTH_LANDING_CHANGED' });
    assert.deepEqual(f.state.navigations, []);
  });
}
test('MFA continuation must pass the caller’s final native assurance check', async () => {
  const f = fixture({ role: 'site_admin' });
  await assert.rejects(f.run({ beforeNavigate: async () => { throw Object.assign(new Error('MFA failed'), { code: 'MFA_CHALLENGE_REQUIRED' }); } }), { code: 'AUTH_LANDING_UNAVAILABLE' });
  assert.deepEqual(f.state.navigations, []);
});
for (const event of ['pagehide', 'storage']) {
  test(`${event} aborts a pending decision without waiting for the provider`, async () => {
    const f = fixture(); let pending;
    const started = new Promise(resolve => { pending = resolve; });
    const outcome = f.run({ getSiteAdminContext: () => { pending(); return new Promise(() => {}); } });
    const rejected = assert.rejects(outcome, { code: 'AUTH_LANDING_CHANGED' });
    await started; f.lifecycle.dispatchEvent(new Event(event)); await rejected;
    assert.deepEqual(f.state.navigations, []); assert.equal(f.state.unsubs, 1);
  });
}
test('the read has a bounded deadline and releases its listeners without retrying', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(); let pending;
  const started = new Promise(resolve => { pending = resolve; });
  const outcome = f.run({ getSiteAdminContext: () => { pending(); return new Promise(() => {}); } });
  const rejected = assert.rejects(outcome, { code: 'AUTH_LANDING_UNAVAILABLE' });
  await started; t.mock.timers.tick(10_000); await rejected;
  assert.deepEqual(f.state.navigations, []); assert.equal(f.state.unsubs, 1);
});
