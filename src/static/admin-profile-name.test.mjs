import assert from 'node:assert/strict';
import test from 'node:test';
import { validAdminProfileName, normalizeAdminProfileName, createProfileNameIntent, profileNameArguments, normalizeProfileNameReceipt, normalizeProfileNameAudit } from './admin-profile-name-contract.mjs';
import { createAdminReadClient, adminReadError } from './admin-read-client.mjs';
import { requestAdminRead } from './admin-read-transport.mjs';
import { runProfileNameCorrection } from './admin-profile-name-write-client.mjs';
import { runProfileNameOperation } from './admin-profile-name-operation.mjs';
import { createAdminPreview } from './admin-preview.mjs';
import { readFileSync } from 'node:fs';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const V = '11111111-1111-4111-8111-111111111111'; const N = '22222222-2222-4222-8222-222222222222';
const owner = { actorId: A, sessionIdentity: 'same-session' };
const snapshot = (patch = {}) => ({ schemaVersion: 1, actorId: A, targetUserId: B, observedAt: '2026-10-13T00:00:00.123456+00:00',
  profile: { state: 'editable', reason: null, name: 'Original Name', version: V, updatedAt: '2026-10-12T01:00:00.654321Z' }, ...patch });
const intent = () => createProfileNameIntent(snapshot(), owner, 'Corrected Name');
const receipt = (value, patch = {}) => ({ schemaVersion: 1, actorId: value.actorId, targetUserId: value.targetUserId,
  operationId: value.operationId, correlationId: value.correlationId, ok: true, changed: true, version: N, ...patch });
const context = (patch = {}) => ({ schemaVersion: 1, actorId: A, role: 'site_admin', adminReady: true, permissions: ['users.read', 'users.manage'], stepUpRequired: false, ...patch });
const held = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
function fixture(value = intent()) {
  let session = { user: { id: A }, identity: owner.sessionIdentity, access_token: 'original-token' }; let listener; let handler;
  const calls = []; const client = createAdminReadClient({ getSession: async () => session, getUser: async () => session?.user,
    sessionIdentity: value => value?.identity || '', subscribe: callback => { listener = callback; return () => {}; },
    request: async (name, args, options) => { calls.push({ name, args, options }); return handler ? handler(name, args, options) : name === 'get_site_admin_context' ? context() : receipt(value); } });
  return { client, calls, handler: value => { handler = value; }, token: value => { session = { ...session, access_token: value }; },
    session: value => { session = value; }, event: event => listener({ event, sessionIdentity: session?.identity || '' }) };
}
test('name validation counts scalar code points and preserves exact international spelling', () => {
  for (const name of ['A', 'O’Connor', '李 小龙', 'José', 'Jose\u0301', 'a\u00a0b', '😀'.repeat(120), '界'.repeat(120), '<img src=x onerror=alert(1)>']) assert.equal(validAdminProfileName(name), true, name);
  for (const name of ['', 'a'.repeat(121), '😀'.repeat(121), null, 42, '\ud800', 'a\udfffb', '\ud800a\udc00']) assert.equal(validAdminProfileName(name), false);
});
for (const code of [9, 10, 11, 12, 13, 32, 160, 5760, ...Array.from({ length: 11 }, (_, i) => 8192 + i), 8232, 8233, 8239, 8287, 12288, 65279]) {
  test(`exact edge-space rejection U+${code.toString(16)}`, () => {
    const char = String.fromCodePoint(code); for (const name of [char, `${char}Name`, `Name${char}`]) assert.equal(validAdminProfileName(name), false);
  });
}
test('C0/C1 and line/paragraph separators are prohibited everywhere', () => {
  for (const code of [...Array.from({ length: 32 }, (_, i) => i), ...Array.from({ length: 33 }, (_, i) => 127 + i), 8232, 8233]) assert.equal(validAdminProfileName(`a${String.fromCodePoint(code)}b`), false);
});
test('exact read projects bounded fields and preserves informational timestamp microseconds', () => {
  const value = normalizeAdminProfileName({ ...snapshot(), secret: 'not projected', profile: { ...snapshot().profile, email: 'private@example.invalid' } }, ownerScope());
  assert.deepEqual(value, snapshot()); assert.equal(value.profile.updatedAt, snapshot().profile.updatedAt);
  for (const reason of ['target_unavailable', 'missing_profile', 'missing_version', 'unsupported_legacy_name']) {
    const raw = snapshot({ profile: { state: 'unavailable', reason, name: null, version: null, updatedAt: null } });
    assert.deepEqual(normalizeAdminProfileName(raw, ownerScope()), raw);
  }
  const raw = snapshot({ targetUserId: A, profile: { state: 'unavailable', reason: 'self_action_forbidden', name: null, version: null, updatedAt: null } });
  assert.deepEqual(normalizeAdminProfileName(raw, { actorId: A, targetUserId: A }), raw);
});
function ownerScope() { return { actorId: A, targetUserId: B }; }
test('malformed, truncated, self-editable and mismatched read DTOs fail closed', () => {
  const p = snapshot().profile;
  for (const patch of [{ actorId: B }, { targetUserId: A }, { schemaVersion: 2 }, { observedAt: 'yesterday' }, { profile: null },
    ...[{ reason: 'oops' }, { name: 'x'.repeat(121) }, { version: 'rounded' }, { updatedAt: null },
      { state: 'unavailable', reason: 'missing_profile' }, { state: 'unavailable', reason: 'other', name: null, version: null, updatedAt: null },
      { state: 'unavailable', reason: 'self_action_forbidden', name: null, version: null, updatedAt: null }].map(patch => ({ profile: { ...p, ...patch } }))]) assert.throws(() => normalizeAdminProfileName(snapshot(patch), ownerScope()));
  assert.throws(() => normalizeAdminProfileName(snapshot({ targetUserId: A }), { actorId: A, targetUserId: A }));
});
test('immutable intent binds only the exact reviewed target, version and spelling', () => {
  const value = intent(); assert.equal(Object.isFrozen(value), true);
  assert.deepEqual(profileNameArguments(value), { target_user_id: B, target_expected_version: V, target_name: 'Corrected Name', target_operation_id: value.operationId, target_correlation_id: value.correlationId });
  assert.notEqual(intent().operationId, value.operationId);
  for (const patch of [{ actorId: B }, { sessionIdentity: '' }, { sessionIdentity: 'bad\nidentity' }, { expectedVersion: null }, { name: ' Space' }, { operationId: 'x' }]) assert.throws(() => profileNameArguments({ ...value, ...patch }));
});
test('strict receipt validates all IDs, result shape and changed/version relationship without exposing names', () => {
  const value = intent(); assert.deepEqual(normalizeProfileNameReceipt(receipt(value), value), receipt(value));
  assert.equal(normalizeProfileNameReceipt(receipt(value, { changed: false, version: V }), value).changed, false);
  for (const patch of [{ actorId: B }, { targetUserId: A }, { operationId: N }, { correlationId: N }, { schemaVersion: 2 }, { changed: false }, { version: V }, { name: 'private' }, { extra: 'private' }, { changed: 'true' }]) assert.throws(() => normalizeProfileNameReceipt(receipt(value, patch), value));
  const { changed, version, ...base } = receipt(value);
  for (const error of ['invalid_input', 'revision_conflict', 'self_action_forbidden', 'target_unavailable', 'profile_unavailable', 'unsupported_legacy_name', 'rate_limited']) assert.equal(normalizeProfileNameReceipt({ ...base, ok: false, error }, value).error, error);
  for (const patch of [{ error: 'raw database error' }, { error: 'rate_limited', version: V }, { errorCode: 'invalid_input' }, { error: 'invalid_input', name: 'private' }]) assert.throws(() => normalizeProfileNameReceipt({ ...base, ok: false, ...patch }, value));
});
test('write dispatch is explicit and exact retries preserve every reviewed field', async () => {
  const value = intent(); const f = fixture(value); assert.equal(f.calls.length, 0);
  await f.client.correctProfileName(value); await f.client.correctProfileName(value);
  assert.deepEqual(f.calls.map(call => call.name), ['get_site_admin_context', 'site_admin_correct_profile_name', 'get_site_admin_context', 'site_admin_correct_profile_name']);
  assert.deepEqual(f.calls[1].args, f.calls[3].args); assert.equal(f.calls[1].options.token, 'original-token');
});
test('fresh users.read/users.manage and literal recent-MFA readiness precede every mutation', async () => {
  for (const [raw, code] of [[context({ permissions: ['users.read'] }), 'ADMIN_DENIED'], [context({ permissions: ['users.manage'] }), 'ADMIN_DENIED'],
    [context({ adminReady: false }), 'ADMIN_DENIED'], [context({ stepUpRequired: true }), 'ADMIN_STEP_UP_REQUIRED'], [context({ stepUpRequired: undefined }), 'ADMIN_UNAVAILABLE'], [context({ stepUpRequired: 'false' }), 'ADMIN_UNAVAILABLE']]) {
    const f = fixture(); f.handler(() => raw); await assert.rejects(f.client.correctProfileName(intent()), { code }); assert.equal(f.calls.length, 1);
  }
});
test('already aborted and mismatched owners never start a request', async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort();
  await assert.rejects(f.client.correctProfileName(intent(), { signal: controller.signal })); assert.equal(f.calls.length, 0);
  await assert.rejects(f.client.correctProfileName({ ...intent(), sessionIdentity: 'other' }), { code: 'ADMIN_CHANGED' }); assert.equal(f.calls.length, 0);
});
for (const phase of ['context', 'write']) test(`silent bearer replacement during ${phase} suppresses old-token continuation`, async () => {
  const value = intent(); const f = fixture(value); const pause = held();
  f.handler(name => (name === 'get_site_admin_context') === (phase === 'context') ? pause.promise : context());
  const pending = f.client.correctProfileName(value); const rejected = assert.rejects(pending, { code: 'ADMIN_CHANGED' });
  await new Promise(resolve => setTimeout(resolve, 5)); f.token('replacement'); pause.resolve(phase === 'context' ? context() : receipt(value)); await rejected;
  assert.equal(f.calls.filter(call => call.name === 'site_admin_correct_profile_name').length, phase === 'context' ? 0 : 1);
});
for (const event of ['TOKEN_REFRESHED', 'USER_UPDATED', 'MFA_CHALLENGE_VERIFIED', 'SIGNED_OUT']) test(`${event} invalidation scrubs a delayed reviewed operation`, async () => {
  const value = intent(); const f = fixture(value); const pause = held(); let notices = 0; f.client.subscribe(() => notices++); f.handler(() => pause.promise);
  const pending = f.client.correctProfileName(value); const rejected = assert.rejects(pending, { code: 'ADMIN_CHANGED' });
  await new Promise(resolve => setTimeout(resolve, 5)); f.event(event); pause.resolve(context()); await rejected; assert.equal(notices, 1); assert.equal(f.calls.length, 1);
});
test('caller mutation during dynamic import/context cannot alter the reviewed request', async () => {
  const value = intent(); const mutable = { ...value }; const f = fixture(value); const pause = held();
  f.handler(name => name === 'get_site_admin_context' ? pause.promise : receipt(value));
  const pending = f.client.correctProfileName(mutable); mutable.name = 'UNREVIEWED'; mutable.expectedVersion = N; mutable.operationId = N;
  await new Promise(resolve => setTimeout(resolve, 5)); pause.resolve(context()); await pending;
  assert.equal(f.calls[1].args.target_name, value.name); assert.equal(f.calls[1].args.target_operation_id, value.operationId);
});
test('preflight errors are unavailable; malformed/lost submitted responses are uncertain, with no automatic retry', async () => {
  for (const mode of ['preflight', 'lost', 'malformed']) {
    const value = intent(); const f = fixture(value); f.handler(name => {
      if (mode !== 'preflight' && name === 'get_site_admin_context') return context();
      if (mode === 'malformed') return receipt(value, { name: 'PRIVATE RESPONSE' });
      throw new Error('PRIVATE RAW BODY');
    });
    await assert.rejects(f.client.correctProfileName(value), cause => cause.code === (mode === 'preflight' ? 'ADMIN_UNAVAILABLE' : 'ADMIN_PROFILE_NAME_RESULT_UNCERTAIN') && !cause.message.includes('PRIVATE'));
    assert.equal(f.calls.length, mode === 'preflight' ? 1 : 2);
  }
});
for (const phase of ['owner', 'context', 'write']) test(`20-second ${phase} deadline cannot dispatch or publish late work`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const pause = held(); const calls = []; const value = intent(); const pending = new Set();
  const result = runProfileNameCorrection(value, {}, { capture: () => phase === 'owner' ? pause.promise : Promise.resolve({ actorId: A, identity: owner.sessionIdentity, epoch: 0, token: 'token' }),
    assertCurrent: async () => {}, assertEpoch() {}, changed() {}, pending, adminReadError, normalizeAdminContext: value => value,
    request: async name => { calls.push(name); return (name === 'get_site_admin_context') === (phase === 'context') ? pause.promise : context(); } });
  const rejected = assert.rejects(result, { code: phase === 'write' ? 'ADMIN_PROFILE_NAME_RESULT_UNCERTAIN' : 'ADMIN_UNAVAILABLE' }); await flush(); t.mock.timers.tick(20_001); await rejected;
  assert.equal(pending.size, 0, 'Stalled promises must not retain aborted controllers before they resolve');
  pause.resolve(phase === 'owner' ? { actorId: A, identity: owner.sessionIdentity } : phase === 'context' ? context() : receipt(value)); await flush();
  assert.equal(calls.length, phase === 'owner' ? 0 : phase === 'context' ? 1 : 2); assert.equal(pending.size, 0);
});
for (const phase of ['factory', 'writer import']) test(`total deadline starts before delayed ${phase} and forbids late dispatch`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const pause = held(); let writes = 0; const value = intent();
  const client = { correctProfileName: async (_, { operation, signal }) => {
    if (phase === 'writer import') await pause.promise;
    operation.assertActive(); assert.equal(signal.aborted, false); operation.markSubmitted(); writes++; return receipt(value);
  } };
  const result = runProfileNameOperation(value, {}, async () => { if (phase === 'factory') await pause.promise; return client; });
  const rejected = assert.rejects(result, { code: 'ADMIN_UNAVAILABLE' }); await flush(); t.mock.timers.tick(20_001); await rejected;
  pause.resolve(); await flush(); assert.equal(writes, 0);
});
test('one total deadline is not renewed between factory, import and submitted response', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const factory = held(); const module = held(); const response = held(); const value = intent(); let writes = 0; let signal;
  const result = runProfileNameOperation(value, {}, async () => { await factory.promise; return {
    correctProfileName: async (_, options) => { signal = options.signal; await module.promise; options.operation.assertActive(); options.operation.markSubmitted(); writes++; return response.promise; },
  }; });
  const rejected = assert.rejects(result, { code: 'ADMIN_PROFILE_NAME_RESULT_UNCERTAIN' });
  await flush(); t.mock.timers.tick(9_000); factory.resolve(); await flush(); t.mock.timers.tick(9_000); module.resolve(); await flush();
  assert.equal(writes, 1); t.mock.timers.tick(2_001); await rejected; assert.equal(signal.aborted, true);
  response.resolve(receipt(value)); await flush(); assert.equal(writes, 1);
});
test('API entry starts the total deadline before client acquisition and rejects an owner epoch change', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
  const entry = source.slice(source.indexOf('export const correctSiteAdminProfileName ='), source.indexOf('export const listSiteAdminUsers =')).replace('export ', '');
  for (const mode of ['deadline', 'owner change']) {
    const pause = held(); let writes = 0;
    const api = new Function('runProfileNameOperation', 'getAdminReadClient', 'adminReadError', `let adminClientEpoch = 0; ${entry}; return { correctSiteAdminProfileName, change: () => adminClientEpoch++ };`)(
      runProfileNameOperation, () => pause.promise, adminReadError);
    const pending = api.correctSiteAdminProfileName(intent()); const rejected = assert.rejects(pending, { code: mode === 'deadline' ? 'ADMIN_UNAVAILABLE' : 'ADMIN_CHANGED' });
    await flush(); if (mode === 'deadline') t.mock.timers.tick(20_001); else api.change();
    pause.resolve({ correctProfileName: () => { writes++; } }); await rejected; await flush(); assert.equal(writes, 0);
  }
});
test('operation abort listeners are removed after success, failure and caller cancellation', async () => {
  for (const mode of ['success', 'failure', 'cancel']) {
    const controller = new AbortController(); const signal = controller.signal; let activeListeners = 0; let writes = 0; const pause = held(); const value = intent();
    const add = signal.addEventListener.bind(signal); const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (...args) => { activeListeners++; return add(...args); };
    signal.removeEventListener = (...args) => { activeListeners--; return remove(...args); };
    const pending = runProfileNameOperation(value, { signal }, async () => {
      if (mode === 'cancel') await pause.promise;
      if (mode === 'failure') throw adminReadError();
      return { correctProfileName: async (_, { operation }) => { operation.markSubmitted(); writes++; return receipt(value); } };
    });
    if (mode === 'success') await pending;
    else { const rejected = assert.rejects(pending, { code: 'ADMIN_UNAVAILABLE' }); if (mode === 'cancel') controller.abort(); await rejected; }
    pause.resolve(); await flush(); assert.equal(activeListeners, 0); assert.equal(writes, mode === 'success' ? 1 : 0);
  }
});
test('new read has a 64KiB streaming bound and mutation never enters read transport', async () => {
  const base = { name: 'site_admin_get_profile_name', baseUrl: 'https://synthetic.invalid', apiKey: 'synthetic', token: 'synthetic', args: {} };
  assert.deepEqual(await requestAdminRead({ ...base, fetcher: async () => new Response(JSON.stringify(snapshot()), { headers: { 'content-type': 'application/json' } }) }), snapshot());
  await assert.rejects(requestAdminRead({ ...base, fetcher: async () => new Response('x'.repeat(65537), { headers: { 'content-type': 'application/json' } }) }));
  await assert.rejects(requestAdminRead({ ...base, name: 'site_admin_correct_profile_name', fetcher: () => assert.fail('Mutation entered read transport') }), { code: 'ADMIN_INVALID_INPUT' });
});
test('profile audit has an exact metadata-only typed branch; rate rejections are not persisted', () => {
  const row = { action: 'users.display_name.correct', permission: 'users.manage', reasonCode: 'profile_name_correction', actorId: A, targetUserId: B,
    beforeRole: null, afterRole: null, outcome: 'success', errorCode: null, beforeProfileNameVersion: V, afterProfileNameVersion: N, profileNameChanged: true };
  assert.deepEqual(normalizeProfileNameAudit(row), { beforeProfileNameVersion: V, afterProfileNameVersion: N, profileNameChanged: true });
  for (const patch of [{ profileNameChanged: false }, { afterProfileNameVersion: V }, { beforeRole: 'member' }, { outcome: 'failure', errorCode: 'rate_limited' }]) assert.throws(() => normalizeProfileNameAudit({ ...row, ...patch }));
  assert.equal(normalizeProfileNameAudit({ ...row, afterProfileNameVersion: V, profileNameChanged: false }).profileNameChanged, false);
  assert.equal(normalizeProfileNameAudit({ ...row, outcome: 'failure', errorCode: 'revision_conflict', beforeProfileNameVersion: null, afterProfileNameVersion: null, profileNameChanged: null }).profileNameChanged, null);
});
test('preview changes synthetic memory only, replays metadata, rejects conflicting IDs and resets in a new adapter', async () => {
  const getUser = async () => ({ authenticated: true, userId: A }); const preview = createAdminPreview({ getUser, mode: 'ready' });
  const target = '70000000-0000-4000-8000-000000000028'; const actor = await preview.owner();
  const read = () => preview.read('site_admin_get_profile_name', { target_user_id: target }, { expectedUserId: A });
  const original = await read(); const value = createProfileNameIntent(original, actor, 'Synthetic Correction');
  const result = await preview.correctProfileName(value); assert.equal(result.changed, true);
  assert.equal((await read()).profile.name, value.name); assert.deepEqual(await preview.correctProfileName(value), result);
  await assert.rejects(preview.correctProfileName({ ...value, name: 'Different' }), { code: 'ADMIN_IDEMPOTENCY_CONFLICT' });
  const next = createProfileNameIntent(await read(), actor, 'Synthetic Correction'); assert.equal((await preview.correctProfileName(next)).changed, false);
  const fresh = createAdminPreview({ getUser, mode: 'ready' }); assert.equal((await fresh.read('site_admin_get_profile_name', { target_user_id: target })).profile.name, original.profile.name);
  const controller = new AbortController(); controller.abort(); await assert.rejects(preview.correctProfileName(next, { signal: controller.signal }), { code: 'ADMIN_CHANGED' });
  for (const mode of ['member', 'mfa']) await assert.rejects(createAdminPreview({ getUser, mode }).correctProfileName(value), { code: 'ADMIN_DENIED' });
});
test('editor owns no persistent draft or automatic retry and is not wired through member profile mutation', () => {
  const source = readFileSync(new URL('./admin-profile-name-detail.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /localStorage|sessionStorage|updateProfile|setInterval|innerHTML/);
  assert.match(source, /createProfileNameIntent\(snapshot, owner, input.value\)/);
  assert.match(source, /return \(\) => \{ disposed = true; discard\(\)/);
});
