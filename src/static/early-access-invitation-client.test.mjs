import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInvitationAcceptanceClient } from './early-access-invitation-client.mjs';
import { createInvitationAcceptanceIntent } from './early-access-invitation-contract.mjs';
const A = '10000000-0000-4000-8000-000000000001';
const B = '20000000-0000-4000-8000-000000000002';
const S = '30000000-0000-4000-8000-000000000003';
const S2 = '40000000-0000-4000-8000-000000000004';
const G = '50000000-0000-4000-8000-000000000005';
const O = '60000000-0000-4000-8000-000000000006';
const C = '70000000-0000-4000-8000-000000000007';
const intent = createInvitationAcceptanceIntent({ generationId: G, token: 'A'.repeat(43) }, O, C);
const receipt = { ok: true, status: 'accepted', actorId: A, program: 'early_access_v1' };
const context = (actorId = A) => ({ schemaVersion: 1, actorId, asOf: '2026-09-27T23:00:00Z', appAccess: false,
  legacyMembershipActive: false, paidSubscriptionActive: false, earlyAccessActive: false, earlyAccessProgram: null,
  earlyAccessEndsAt: null, betaPriceEligible: false });
const turn = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture({ timeout = 1000 } = {}) {
  let actorId = A; let sessionId = S; let token = 'native-bearer'; let observer; let handler;
  let sessionRead; let userRead; let notices = 0; let unsubscribed = false;
  const calls = [];
  const session = () => ({ user: { id: actorId }, identity: `${actorId}:${sessionId}`, access_token: token });
  const client = createInvitationAcceptanceClient({
    getSession: async () => sessionRead ? sessionRead() : session(),
    getUser: async bearer => { assert.equal(bearer, token); return userRead ? userRead() : { id: actorId }; },
    sessionIdentity: value => value?.identity || '',
    subscribe: callback => { observer = callback; return () => { unsubscribed = true; }; },
    request: async (name, args, options) => {
      calls.push({ name, args, options }); if (handler) return handler(name, args, options);
      return name === 'get_member_access_context' ? context(actorId) : { ...receipt, actorId };
    }, requestTimeoutMs: timeout,
  });
  client.subscribe(() => notices++);
  return { client, calls, session, handler(value) { handler = value; }, getSession(value) { sessionRead = value; }, getUser(value) { userRead = value; },
    token(value) { token = value; }, notify(event = 'TOKEN_REFRESHED') { observer({ event, sessionIdentity: `${actorId}:${sessionId}` }); },
    change(next = B, sid = S2, notify = true) { actorId = next; sessionId = sid; if (notify) observer({ event: 'SIGNED_IN', sessionIdentity: `${actorId}:${sessionId}` }); },
    notices: () => notices, unsubscribed: () => unsubscribed };
}
test('review does not accept; explicit acceptance pins owner, native bearer, app capability and operation UUIDs', async () => {
  const f = fixture(); const review = await f.client.review();
  assert.deepEqual(review.owner, { actorId: A, sessionIdentity: `${A}:${S}` });
  assert.equal(review.context.earlyAccessActive, false); assert.equal(f.calls.length, 1);
  assert.deepEqual(await f.client.accept(review.owner, intent), receipt);
  assert.deepEqual(f.calls.map(c => c.name), ['get_member_access_context', 'get_member_access_context', 'accept_early_access_invitation']);
  assert.deepEqual(f.calls.at(-1).args, { target_expected_actor_id: A, target_generation_id: G, target_token: intent.token, target_operation_id: O, target_correlation_id: C });
  assert.equal(f.calls.at(-1).options.token, 'native-bearer');
  await f.client.accept(review.owner, intent); assert.deepEqual(f.calls[2].args, f.calls[4].args);
});
test('forged/cloned owners, old owners and mutated retries cannot dispatch', async () => {
  const f = fixture(); const { owner } = await f.client.review();
  assert.throws(() => f.client.accept({ ...owner }, intent), { code: 'INVITATION_CHANGED' });
  await f.client.accept(owner, intent);
  assert.throws(() => f.client.accept(owner, { ...intent, correlationId: B }), { code: 'INVITATION_INTENT_CONFLICT' });
  f.client.invalidate(); assert.equal(f.client.isCurrent(owner), false);
  assert.throws(() => f.client.accept(owner, intent), { code: 'INVITATION_CHANGED' });
});
for (const event of ['SIGNED_OUT', 'TOKEN_REFRESHED', 'USER_UPDATED', 'PASSWORD_RECOVERY', 'MFA_CHALLENGE_VERIFIED', 'replacement', 'ABA']) {
  test(`owner invalidation during member context (${event}) never reaches acceptance`, async () => {
    const f = fixture(); const { owner } = await f.client.review(); const held = deferred();
    f.handler(() => held.promise); const pending = f.client.accept(owner, intent); await turn();
    if (event === 'replacement') f.change();
    else if (event === 'ABA') { f.change(); f.change(A, S); }
    else f.notify(event);
    await assert.rejects(pending, { code: 'INVITATION_CHANGED' }); held.resolve(context()); await turn();
    assert.equal(f.calls.filter(c => c.name === 'accept_early_access_invitation').length, 0);
  });
}
for (const phase of ['context', 'write']) test(`unnotified bearer change during ${phase} cannot publish old-authority success`, async () => {
  const f = fixture(); const { owner } = await f.client.review(); const held = deferred();
  f.handler(name => (phase === 'context' || name === 'accept_early_access_invitation') ? held.promise : context());
  const pending = f.client.accept(owner, intent); await turn(); f.token('replacement-bearer');
  held.resolve(phase === 'context' ? context() : receipt);
  await assert.rejects(pending, { code: 'INVITATION_CHANGED' });
  assert.equal(f.calls.filter(c => c.name === 'accept_early_access_invitation').length, phase === 'context' ? 0 : 1);
});
test('native auth errors, malformed context and wrong self receipt fail closed without provider text', async () => {
  for (const [error, code] of [
    [{ code: 'PT401', message: 'member_authentication_required' }, 'INVITATION_SIGNED_OUT'],
    [{ code: 'PT403', message: 'member_mfa_required' }, 'INVITATION_MFA_REQUIRED'],
    [{ code: 'PT403', message: 'member_origin_forbidden' }, 'INVITATION_DENIED'],
    [{ code: 'XX000', message: intent.token }, 'INVITATION_UNAVAILABLE'],
  ]) {
    const f = fixture(); f.handler(() => { throw error; });
    await assert.rejects(f.client.review(), value => value.code === code && !value.message.includes(intent.token));
  }
  const f = fixture(); f.handler(() => ({ ...context(), earlyAccessActive: 'true' })); await assert.rejects(f.client.review());
  const g = fixture(); const { owner } = await g.client.review();
  g.handler(name => name === 'get_member_access_context' ? context() : { ...receipt, actorId: B });
  await assert.rejects(g.client.accept(owner, intent), { code: 'INVITATION_UNCONFIRMED' });
});
for (const phase of ['session', 'user', 'context', 'write']) test(`total deadline bounds stalled ${phase}, with no late automatic action`, async () => {
  const f = fixture({ timeout: 15 }); const { owner } = await f.client.review(); const held = deferred();
  if (phase === 'session') f.getSession(() => held.promise);
  else if (phase === 'user') f.getUser(() => held.promise);
  else f.handler(name => phase === 'context' || name === 'accept_early_access_invitation' ? held.promise : context());
  const pending = f.client.accept(owner, intent);
  await assert.rejects(pending, { code: 'INVITATION_UNCONFIRMED' });
  held.resolve(phase === 'session' ? f.session() : phase === 'user' ? { id: A } : phase === 'context' ? context() : receipt); await turn();
  assert.equal(f.calls.filter(c => c.name === 'accept_early_access_invitation').length, phase === 'write' ? 1 : 0);
});
test('caller cancellation and destroy reject ignored transports and retire owners', async () => {
  const f = fixture(); const { owner } = await f.client.review(); const held = deferred(); f.handler(() => held.promise);
  const abort = new AbortController(); const pending = f.client.accept(owner, intent, { signal: abort.signal }); await turn(); abort.abort();
  await assert.rejects(pending, { code: 'INVITATION_CANCELLED' }); held.resolve(context()); await turn();
  f.client.destroy(); assert.equal(f.unsubscribed(), true); assert.equal(f.client.isCurrent(owner), false);
  await assert.rejects(f.client.review(), { code: 'INVITATION_CHANGED' });
});
test('receipt recovery remains explicit and uses the same request after an uncertain write', async () => {
  const f = fixture(); const { owner } = await f.client.review(); let writes = 0;
  f.handler(name => {
    if (name === 'get_member_access_context') return context();
    if (++writes === 1) throw new Error('network result lost');
    return receipt;
  });
  await assert.rejects(f.client.accept(owner, intent)); assert.equal(writes, 1);
  assert.deepEqual(await f.client.accept(owner, intent), receipt); assert.equal(writes, 2);
  assert.deepEqual(f.calls[2].args, f.calls[4].args);
});
test('provider getters, proxies and non-string error codes never escape raw credential-bearing errors', async () => {
  for (const error of [
    { get code() { throw new Error('CANARY_PRIVATE'); } },
    { code: { toString() { throw new Error('CANARY_PRIVATE'); } } },
    { code: 'PT401', get message() { throw new Error('CANARY_PRIVATE'); } },
    new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('CANARY_PRIVATE'); } }),
  ]) {
    const f = fixture(); f.handler(() => { throw error; });
    await assert.rejects(f.client.review(), value => value.code === 'INVITATION_UNAVAILABLE' && !value.message.includes('CANARY_PRIVATE'));
  }
});
