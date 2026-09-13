import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseMfaAdapter, sessionRequiresMfa } from './mfa-auth.mjs';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const F = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const G = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SECRET = 'JBSWY3DPEHPK3PXP'; // Synthetic fixture, never an account secret.
const factor = (id = F) => ({ id, factor_type: 'totp', status: 'verified', friendly_name: 'My authenticator' });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

function fixture({ enrolled = false, aal = 'aal1' } = {}) {
  const state = { userId: A, factors: enrolled ? [factor()] : [], aal, time: 1, listener: null, calls: [], unsubs: 0 };
  const auth = {
    onAuthStateChange(listener) { state.listener = listener; listener('INITIAL_SESSION', { user: { id: state.userId } }); return { data: { subscription: { unsubscribe() { state.unsubs += 1; } } } }; },
    async getUser() { state.calls.push('getUser'); return { data: { user: state.userId ? { id: state.userId, factors: structuredClone(state.factors) } : null }, error: null }; },
    mfa: {
      async listFactors() { state.calls.push('listFactors'); return { data: { all: structuredClone(state.factors) }, error: null }; },
      async getAuthenticatorAssuranceLevel() { state.calls.push('assurance'); return { data: { currentLevel: state.aal, nextLevel: state.factors.length ? 'aal2' : 'aal1', currentAuthenticationMethods: [{ method: 'totp', timestamp: state.time }] }, error: null }; },
      async enroll(args) { state.calls.push(['enroll', args]); return { data: { id: F, type: 'totp', totp: { secret: SECRET, qr_code: '<svg></svg>' } }, error: null }; },
      async challenge(args) { state.calls.push(['challenge', args]); return { data: { id: C }, error: null }; },
      async verify(args) { state.calls.push(['verify', args]); if (args.code !== '012345') return { error: { code: 'mfa_verification_failed', message: SECRET } }; state.factors = [factor()]; state.aal = 'aal2'; state.time += 1; return { data: { access_token: 'do-not-return-this' }, error: null }; },
      async unenroll() { throw new Error('Must never remove a hosted factor.'); },
    },
  };
  state.emit = (event, userId) => { state.userId = userId; state.listener(event, userId ? { user: { id: userId } } : null); };
  return { auth, state, adapter: createSupabaseMfaAdapter(auth) };
}

test('enrollment returns transient setup data and confirmation requires provider AAL2 + verified factor', async () => {
  const { adapter, state } = fixture();
  const enrollment = await adapter.enroll({ expectedUserId: A });
  assert.equal(enrollment.secret, SECRET);
  assert.deepEqual(Object.keys(enrollment).sort(), ['factorId', 'qrCode', 'secret']);
  const result = await adapter.verify({ expectedUserId: A, factorId: F, code: '012345' });
  assert.equal(result.verified, true);
  assert.equal(result.currentLevel, 'aal2');
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(JSON.stringify(result).includes('access_token'), false);
  assert.equal(state.calls.filter((call) => call[0] === 'challenge').length, 1);
});

test('existing verified AAL1 factor blocks new enrollment, but accepts its own challenge', async () => {
  const { adapter, state } = fixture({ enrolled: true });
  await assert.rejects(adapter.enroll({ expectedUserId: A }), { code: 'MFA_CHALLENGE_REQUIRED' });
  assert.equal(state.calls.some((call) => call[0] === 'enroll'), false);
  assert.equal((await adapter.verify({ expectedUserId: A, factorId: F, code: '012345' })).verified, true);
});

test('verified AAL2 sessions can explicitly step up again without enrolling a new factor', async () => {
  const { adapter, state } = fixture({ enrolled: true, aal: 'aal2' });
  await assert.rejects(adapter.enroll({ expectedUserId: A }), { code: 'MFA_ALREADY_ENABLED' });
  assert.equal((await adapter.verify({ expectedUserId: A, factorId: F, code: '012345' })).totpVerifiedAt, 2);
  assert.equal(state.calls.some((call) => call[0] === 'verify'), true);
});

test('invalid code on an old AAL2 session does not masquerade as success or expose provider errors', async () => {
  const { adapter } = fixture({ enrolled: true, aal: 'aal2' });
  await assert.rejects(adapter.verify({ expectedUserId: A, factorId: F, code: '999999' }), (error) => error.code === 'MFA_INVALID_CODE' && !error.message.includes(SECRET));
});

test('each retry gets a new challenge, preserving leading zeroes', async () => {
  const { adapter, state } = fixture({ enrolled: true });
  await assert.rejects(adapter.verify({ expectedUserId: A, factorId: F, code: '999999' }));
  await adapter.verify({ expectedUserId: A, factorId: F, code: ' 012345 ' });
  assert.equal(state.calls.filter((call) => call[0] === 'challenge').length, 2);
  assert.equal(state.calls.filter((call) => call[0] === 'verify').at(-1)[1].code, '012345');
});

test('malformed code and foreign factor ID cannot initiate a provider challenge', async () => {
  const { adapter, state } = fixture({ enrolled: true });
  for (const code of ['12345', '1234567', '1e2345', '１２３４５６']) {
    await assert.rejects(adapter.verify({ expectedUserId: A, factorId: F, code }), { code: 'MFA_INVALID_CODE' });
  }
  await assert.rejects(adapter.verify({ expectedUserId: A, factorId: G, code: '012345' }), { code: 'MFA_FACTOR_UNAVAILABLE' });
  assert.equal(state.calls.some((call) => call[0] === 'challenge'), false);
});

test('provider confirmation is required even when verify returned no error', async () => {
  const { adapter, auth } = fixture({ enrolled: true });
  auth.mfa.verify = async () => ({ error: null });
  await assert.rejects(adapter.verify({ expectedUserId: A, factorId: F, code: '012345' }), { code: 'MFA_NOT_CONFIRMED', factorVerified: true });
});

test('lost successful verify response reconciles provider AAL2 without removing the factor', async () => {
  const { adapter, auth } = fixture();
  await adapter.enroll({ expectedUserId: A });
  const verify = auth.mfa.verify;
  auth.mfa.verify = async (args) => { await verify(args); throw new Error('Response lost'); };
  assert.equal((await adapter.verify({ expectedUserId: A, factorId: F, code: '012345' })).verified, true);
});

test('lost response with server-verified factor and client AAL1 permits a fresh-code retry', async () => {
  const { adapter, auth, state } = fixture();
  await adapter.enroll({ expectedUserId: A });
  const verify = auth.mfa.verify;
  auth.mfa.verify = async () => { state.factors = [factor()]; throw new Error('Response lost'); };
  await assert.rejects(adapter.verify({ expectedUserId: A, factorId: F, code: '012345' }), { code: 'MFA_NOT_CONFIRMED', factorVerified: true });
  auth.mfa.verify = verify;
  assert.equal((await adapter.verify({ expectedUserId: A, factorId: F, code: '012345' })).verified, true);
});

test('lost response on an unchanged existing AAL2 session is not fresh step-up proof', async () => {
  const { adapter, auth } = fixture({ enrolled: true, aal: 'aal2' });
  auth.mfa.verify = async () => { throw new Error('Network unavailable'); };
  await assert.rejects(adapter.verify({ expectedUserId: A, factorId: F, code: '012345' }), { code: 'MFA_NOT_CONFIRMED' });
});

test('cancel only forgets the pending operation, never calls hosted unenroll', async () => {
  const { adapter } = fixture();
  await adapter.enroll({ expectedUserId: A });
  assert.equal(await adapter.cancelEnrollment({ expectedUserId: B, factorId: F }), false);
  assert.equal(await adapter.cancelEnrollment({ expectedUserId: A, factorId: F }), true);
  await assert.rejects(adapter.verify({ expectedUserId: A, factorId: F, code: '012345' }), { code: 'MFA_FACTOR_UNAVAILABLE' });
});

test('a different verified factor appearing during pending enrollment cannot be bypassed', async () => {
  const { adapter, state } = fixture();
  await adapter.enroll({ expectedUserId: A });
  state.factors = [factor(G)];
  await assert.rejects(adapter.verify({ expectedUserId: A, factorId: F, code: '012345' }), { code: 'MFA_CHALLENGE_REQUIRED' });
});

test('getState uses authoritative getUser factors, not listFactors or user-controlled claims alone', async () => {
  const { adapter, auth, state } = fixture({ aal: 'aal2' });
  auth.mfa.listFactors = async () => ({ data: { all: [factor()] } });
  assert.equal((await adapter.getState({ expectedUserId: A })).verified, false);
  state.factors = [factor(G)];
  await assert.rejects(adapter.getState({ expectedUserId: A }), { code: 'MFA_UNAVAILABLE' });
});

for (const method of ['enroll', 'challenge', 'verify']) {
  test(`account A→B→A during provider ${method} fences stale completion`, async () => {
    const { adapter, auth, state } = fixture({ enrolled: method !== 'enroll' });
    const gate = deferred();
    const entered = deferred();
    const original = auth.mfa[method];
    auth.mfa[method] = async (...args) => { entered.resolve(); await gate.promise; return original(...args); };
    const operation = method === 'enroll'
      ? adapter.enroll({ expectedUserId: A })
      : adapter.verify({ expectedUserId: A, factorId: F, code: '012345' });
    await entered.promise;
    state.emit('SIGNED_IN', B);
    state.emit('SIGNED_IN', A);
    gate.resolve();
    await assert.rejects(operation, { code: 'MFA_ACTOR_CHANGED' });
    if (method === 'enroll') await assert.rejects(adapter.verify({ expectedUserId: A, factorId: F, code: '012345' }), { code: 'MFA_FACTOR_UNAVAILABLE' });
  });
}

test('late enrollment resolved for B cannot return its secret to A', async () => {
  const { adapter, auth, state } = fixture();
  auth.mfa.enroll = async () => { state.emit('SIGNED_IN', B); return { data: { id: F, type: 'totp', totp: { secret: SECRET, qr_code: '<svg />' } } }; };
  await assert.rejects(adapter.enroll({ expectedUserId: A }), { code: 'MFA_ACTOR_CHANGED' });
});

test('same-actor token refresh does not cancel verification', async () => {
  const { adapter, auth, state } = fixture({ enrolled: true });
  const verify = auth.mfa.verify;
  auth.mfa.verify = async (args) => { state.emit('TOKEN_REFRESHED', A); const result = await verify(args); state.emit('MFA_CHALLENGE_VERIFIED', A); return result; };
  assert.equal((await adapter.verify({ expectedUserId: A, factorId: F, code: '012345' })).verified, true);
});

test('pending enrollment survives same-session SIGNED_IN but not a new immutable session', async () => {
  const eventSession = (sessionId, iat) => ({ user: { id: A }, access_token: `synthetic.${Buffer.from(JSON.stringify({ sub: A, session_id: sessionId, iat })).toString('base64url')}.synthetic` });
  const same = '11111111-1111-4111-8111-111111111111';
  const newer = '22222222-2222-4222-8222-222222222222';
  const retained = fixture();
  retained.state.listener('INITIAL_SESSION', eventSession(same, 1));
  await retained.adapter.enroll({ expectedUserId: A });
  retained.state.listener('SIGNED_IN', eventSession(same, 2));
  assert.equal((await retained.adapter.verify({ expectedUserId: A, factorId: F, code: '012345' })).verified, true);
  const replaced = fixture();
  replaced.state.listener('INITIAL_SESSION', eventSession(same, 1));
  await replaced.adapter.enroll({ expectedUserId: A });
  replaced.state.listener('SIGNED_IN', eventSession(newer, 2));
  await assert.rejects(replaced.adapter.verify({ expectedUserId: A, factorId: F, code: '012345' }), { code: 'MFA_FACTOR_UNAVAILABLE' });
});

test('factor limit and coordination failures use fixed copy without automatic cleanup', async () => {
  const { adapter, auth } = fixture();
  auth.mfa.enroll = async () => ({ error: { code: 'too_many_enrolled_mfa_factors', message: SECRET } });
  await assert.rejects(adapter.enroll({ expectedUserId: A }), (error) => error.code === 'MFA_FACTOR_LIMIT' && !error.message.includes(SECRET));
  auth.mfa.enroll = async () => { throw Object.assign(new Error(SECRET), { code: 'MFA_COORDINATION_UNAVAILABLE' }); };
  await assert.rejects(adapter.enroll({ expectedUserId: A }), (error) => error.code === 'MFA_COORDINATION_UNAVAILABLE' && !error.message.includes(SECRET));
});

test('signout and disposal invalidate pending ownership; observer performs no provider calls', async () => {
  const { adapter, state } = fixture();
  await adapter.enroll({ expectedUserId: A });
  const before = state.calls.length;
  state.emit('SIGNED_OUT', null);
  assert.equal(state.calls.length, before);
  await assert.rejects(adapter.getState({ expectedUserId: A }), { code: 'MFA_SIGNED_OUT' });
  adapter.dispose();
  await assert.rejects(adapter.getState({ expectedUserId: A }), { code: 'MFA_ACTOR_CHANGED' });
  assert.equal(state.unsubs, 1);
});

test('assurance presentation gate is guest-aware and fails closed on errors/unknown levels', async () => {
  const { auth, state } = fixture({ enrolled: true });
  assert.equal(await sessionRequiresMfa(auth), true);
  state.aal = 'aal2';
  assert.equal(await sessionRequiresMfa(auth), false);
  auth.mfa.getAuthenticatorAssuranceLevel = async () => ({ data: { currentLevel: null, nextLevel: null } });
  assert.equal(await sessionRequiresMfa(auth), false);
  auth.mfa.getAuthenticatorAssuranceLevel = async () => ({ data: { currentLevel: 'anything', nextLevel: 'aal2' } });
  await assert.rejects(sessionRequiresMfa(auth), { code: 'MFA_UNAVAILABLE' });
});
