import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminReadClient, adminReadError } from './admin-read-client.mjs';
import { ROLE_REASONS, normalizeRoleTarget, createRoleAssignmentIntent, roleAssignmentArguments, normalizeRoleAssignment } from './admin-role-contract.mjs';
import { runRoleAssignment } from './admin-role-write-client.mjs';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const target = { id: B, role: 'member', roleRevision: 7, email: 'private@example.invalid' };
const owner = { actorId: A, sessionIdentity: `${A}:s1` };
const intent = () => createRoleAssignmentIntent(target, owner, { role: 'site_admin', reasonCode: 'staff_access_review' });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));
function fixture() {
  let session = { user: { id: A }, identity: owner.sessionIdentity, access_token: 'token1' }; let listener; let handler;
  const calls = [];
  const client = createAdminReadClient({ getSession: async () => session, getUser: async () => session?.user, sessionIdentity: (value) => value?.identity || '',
    subscribe: (fn) => { listener = fn; return () => {}; }, request: async (name, args, options) => {
      calls.push({ name, args, options });
      if (handler) return handler(name, args, options);
      return name === 'get_site_admin_context' ? context() : success();
    } });
  return { client, calls, handler(value) { handler = value; }, token(value) { session = { ...session, access_token: value }; },
    session(value) { session = value; }, event(event = 'TOKEN_REFRESHED') { listener({ event, sessionIdentity: session?.identity || '' }); } };
}
const context = (extra = {}) => ({ schemaVersion: 1, actorId: A, role: 'site_admin', adminReady: true, permissions: ['users.read', 'roles.manage'], stepUpRequired: false, ...extra });
const success = (extra = {}) => ({ ok: true, role: 'site_admin', revision: 8, reauthenticationRequired: true, ...extra });

test('role intent is immutable, PII-free and maps the exact reviewed operation identities', () => {
  const value = intent(); assert.equal(Object.isFrozen(value), true); assert.equal('email' in value, false);
  assert.deepEqual(normalizeRoleTarget(target), { id: B, role: 'member', roleRevision: 7 });
  assert.deepEqual(roleAssignmentArguments(value), { target_user_id: B, target_role: 'site_admin', target_expected_revision: 7,
    target_request_id: value.operationId, target_correlation_id: value.correlationId, target_reason_code: 'staff_access_review' });
  assert.deepEqual(Object.keys(ROLE_REASONS), ['staff_access_review', 'approved_role_change', 'recovery_plan']);
  assert.notEqual(intent().operationId, value.operationId);
});
test('unsafe, rounded, string, fractional, negative, and +1-overflow revisions fail closed', () => {
  for (const roleRevision of [NaN, Infinity, -1, 1.5, '7', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => normalizeRoleTarget({ ...target, roleRevision }), { code: 'ADMIN_INVALID_INPUT' });
  const value = createRoleAssignmentIntent({ ...target, roleRevision: Number.MAX_SAFE_INTEGER - 1 }, owner, { role: 'site_admin', reasonCode: 'recovery_plan' });
  assert.equal(normalizeRoleAssignment(success({ revision: Number.MAX_SAFE_INTEGER }), value).revision, Number.MAX_SAFE_INTEGER);
});
test('self, same role, unsupported role/reason, malformed UUID/session and mutated decisions are rejected', () => {
  for (const changes of [{ actorId: B }, { actorId: B.toUpperCase() }, { role: 'member' }, { role: 'owner' }, { reasonCode: 'other' }, { reasonCode: '__proto__' }, { operationId: 'x' }, { correlationId: '' }, { sessionIdentity: '' }, { sessionIdentity: 'a\nb' }, { revision: Number.MAX_SAFE_INTEGER }]) assert.throws(() => roleAssignmentArguments({ ...intent(), ...changes }), { code: 'ADMIN_INVALID_INPUT' });
});
test('success is bound to exact role, revision +1 and literal reauthentication flag; unknown failures are rejected', () => {
  const value = intent(); assert.deepEqual(normalizeRoleAssignment(success({ secret: 'not exposed' }), value), success());
  for (const raw of [success({ role: 'member' }), success({ revision: 9 }), success({ revision: '8' }), success({ reauthenticationRequired: false }), success({ reauthenticationRequired: 'true' }), { ok: false, errorCode: 'final_admin' }, null]) assert.throws(() => normalizeRoleAssignment(raw, value), { code: 'ADMIN_UNAVAILABLE' });
  for (const errorCode of ['invalid_input', 'self_action_forbidden', 'target_unavailable', 'revision_conflict', 'target_mfa_required', 'rate_limited']) assert.deepEqual(normalizeRoleAssignment({ ok: false, errorCode, secret: 'not exposed' }, value), { ok: false, errorCode });
});
test('only explicit calls submit; an explicit retry preserves every immutable request field', async () => {
  const f = fixture(); const value = intent(); await f.client.assignRole(value); await f.client.assignRole(value);
  assert.deepEqual(f.calls.map((call) => call.name), ['get_site_admin_context', 'site_admin_assign_role', 'get_site_admin_context', 'site_admin_assign_role']);
  assert.deepEqual(f.calls[1].args, f.calls[3].args); assert.equal(f.calls[1].args.target_expected_actor_id, A);
  assert.equal(f.calls[1].options.token, 'token1');
});
test('fresh roles.manage and users.read plus a literal recent MFA decision are mandatory before every write', async () => {
  for (const [raw, code] of [[context({ permissions: ['users.read'] }), 'ADMIN_DENIED'], [context({ permissions: ['roles.manage'] }), 'ADMIN_DENIED'], [context({ adminReady: false }), 'ADMIN_DENIED'], [context({ stepUpRequired: true }), 'ADMIN_STEP_UP_REQUIRED'], [context({ stepUpRequired: undefined }), 'ADMIN_UNAVAILABLE'], [context({ stepUpRequired: 'false' }), 'ADMIN_UNAVAILABLE']]) {
    const f = fixture(); f.handler(() => raw); await assert.rejects(f.client.assignRole(intent()), { code }); assert.equal(f.calls.length, 1);
  }
});
test('mismatched actor/session and an already aborted caller never submit', async () => {
  for (const changes of [{ actorId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, { sessionIdentity: 'other-session' }]) {
    const f = fixture(); await assert.rejects(f.client.assignRole({ ...intent(), ...changes }), { code: 'ADMIN_CHANGED' }); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); const controller = new AbortController(); controller.abort(); await assert.rejects(f.client.assignRole(intent(), { signal: controller.signal }), { code: 'ADMIN_UNAVAILABLE' }); assert.equal(f.calls.length, 0);
});
for (const phase of ['context', 'write']) test(`unnotified bearer replacement during ${phase} cannot send/publish prior-token data`, async () => {
  const f = fixture(); const wait = deferred(); f.handler((name) => (name === 'get_site_admin_context') === (phase === 'context') ? wait.promise : context());
  const result = f.client.assignRole(intent()); const rejected = assert.rejects(result, { code: 'ADMIN_CHANGED' }); await flush(); f.token('lower-assurance-token'); wait.resolve(phase === 'context' ? context() : success()); await rejected;
  assert.equal(f.calls.filter((call) => call.name === 'site_admin_assign_role').length, phase === 'context' ? 0 : 1);
});
for (const event of ['TOKEN_REFRESHED', 'USER_UPDATED', 'MFA_CHALLENGE_VERIFIED', 'SIGNED_OUT']) test(`${event} invalidates a delayed role operation and scrubs subscribers`, async () => {
  const f = fixture(); const wait = deferred(); let notices = 0; f.client.subscribe(() => notices++); f.handler(() => wait.promise);
  const result = f.client.assignRole(intent()); const rejected = assert.rejects(result, { code: 'ADMIN_CHANGED' }); await flush(); f.event(event); wait.resolve(context()); await rejected;
  assert.equal(notices, 1); assert.equal(f.calls.length, 1);
});
test('preflight failures cannot be confused with an uncertain submitted role change', async () => {
  for (const afterWrite of [false, true]) {
    const f = fixture(); f.handler((name) => { if (afterWrite && name === 'get_site_admin_context') return context(); throw new Error('RAW PRIVATE PROVIDER TEXT'); });
    await assert.rejects(f.client.assignRole(intent()), (error) => error.code === (afterWrite ? 'ADMIN_ROLE_RESULT_UNCERTAIN' : 'ADMIN_UNAVAILABLE') && !error.message.includes('RAW'));
    assert.equal(f.calls.length, afterWrite ? 2 : 1);
  }
});
test('malformed success is uncertain but safe server rejections remain distinct and never auto-retry', async () => {
  for (const [response, code] of [[success({ revision: 99 }), 'ADMIN_ROLE_RESULT_UNCERTAIN'], ['ADMIN_RECOVERY_PROTECTED', 'ADMIN_RECOVERY_PROTECTED'], ['ADMIN_IDEMPOTENCY_CONFLICT', 'ADMIN_IDEMPOTENCY_CONFLICT'], ['ADMIN_DENIED', 'ADMIN_DENIED']]) {
    const f = fixture(); f.handler((name) => { if (name === 'get_site_admin_context') return context(); if (typeof response === 'string') throw adminReadError(response); return response; });
    await assert.rejects(f.client.assignRole(intent()), { code }); assert.equal(f.calls.length, 2);
  }
});
test('owner verification timeout is bounded and a late captured owner cannot start any RPC', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const wait = deferred(); let requests = 0;
  const result = runRoleAssignment(intent(), {}, { capture: () => wait.promise, assertCurrent: async () => {}, assertEpoch() {}, changed() {}, pending: new Set(), adminReadError,
    normalizeAdminContext: (value) => value, request: () => { requests++; return context(); } });
  const rejected = assert.rejects(result, { code: 'ADMIN_UNAVAILABLE' }); t.mock.timers.tick(20_001); await rejected;
  wait.resolve({ actorId: A, identity: owner.sessionIdentity, epoch: 0, token: 'token1' }); await Promise.resolve(); await Promise.resolve(); assert.equal(requests, 0);
});
test('a caller cannot mutate the reviewed object while the adapter awaits context', async () => {
  const f = fixture(); const value = { ...intent() }; const wait = deferred(); f.handler((name) => name === 'get_site_admin_context' ? wait.promise : success());
  const result = f.client.assignRole(value); await flush(); value.role = 'member'; value.revision = 500; value.operationId = crypto.randomUUID(); wait.resolve(context()); await result;
  assert.equal(f.calls[1].args.target_role, 'site_admin'); assert.equal(f.calls[1].args.target_expected_revision, 7); assert.notEqual(f.calls[1].args.target_request_id, value.operationId);
});
