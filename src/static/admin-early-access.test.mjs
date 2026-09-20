import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createAdminReadClient, normalizeAdminContext } from './admin-read-client.mjs';
import { createAdminPreview } from './admin-preview.mjs';
import { mfaChallengeHref } from './mfa-navigation.mjs';
import { createEarlyAccessPreviewStore } from './admin-early-access-preview.mjs';
import { createEarlyAccessDenialIntent, earlyAccessDenialArguments, normalizeEarlyAccessRequest, normalizeEarlyAccessHistory, normalizeEarlyAccessDenial } from './admin-early-access-contract.mjs';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const owner = { actorId: A, sessionIdentity: `${A}:first-session` };
const store = createEarlyAccessPreviewStore();
const item = store.read('site_admin_list_early_access_requests', { target_limit: 25, target_status: 'pending', target_sort: 'newest', target_search: '' }, A).items[0];
const deferred = () => { let resolve; const promise = new Promise((value) => { resolve = value; }); return { promise, resolve }; };
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));
function fixture() {
  let identity = owner.sessionIdentity; let actor = A; let observer; let mode = ''; let handle; let token = '';
  const requests = []; const notices = [];
  const context = () => ({ schemaVersion: 1, actorId: actor, role: 'site_admin', adminReady: true,
    permissions: mode === 'reader' ? ['operations.read'] : ['operations.read', 'operations.manage'], stepUpRequired: mode === 'step-up' });
  const client = createAdminReadClient({
    getSession: async () => ({ user: { id: actor }, access_token: token || identity, identity }), getUser: async () => ({ id: actor }),
    sessionIdentity: (value) => value.identity, subscribe: (callback) => { observer = callback; return () => {}; },
    request: async (name, args, options) => {
      requests.push({ name, args, options }); if (handle) return handle(name, args, options);
      if (name === 'get_site_admin_context') return context();
      return { ok: true, requestId: args.target_request_id, status: 'denied', revision: String(BigInt(args.target_expected_revision) + 1n) };
    },
  });
  client.subscribe((reason) => notices.push(reason));
  return { client, requests, notices, context, mode(value) { mode = value; }, handle(value) { handle = value; }, token(value) { token = value; },
    change(nextActor = A, nextIdentity = `${nextActor}:second-session`, event = 'SIGNED_IN', notify = true) {
      actor = nextActor; identity = nextIdentity; if (notify) observer({ event, sessionIdentity: identity });
    } };
}
test('early-access records and history use only reviewed fixed fields and exact string revisions', () => {
  const normalized = normalizeEarlyAccessRequest({ ...item, answers: { private: true }, metadata: { secret: true } });
  assert.equal(normalized.revision, '0'); assert.equal(normalized.invitationSentAt, null);
  assert.ok(!('answers' in normalized) && !('metadata' in normalized));
  for (const change of [{ revision: 0 }, { revision: '9223372036854775808' }, { name: '<script>\n' }, { status: 'sent' },
    { invitationSentAt: 'yesterday' }, { account: { status: 'ambiguous', userId: A } }]) assert.throws(() => normalizeEarlyAccessRequest({ ...item, ...change }));
  const intent = createEarlyAccessDenialIntent(item, owner);
  const result = store.deny(earlyAccessDenialArguments(intent), A);
  const event = store.read('site_admin_list_early_access_history', { target_request_id: item.id, target_limit: 10 }, A).items[0];
  assert.equal(normalizeEarlyAccessHistory({ ...event, token: 'secret' }, item.id).id, '9007199254740993');
  assert.throws(() => normalizeEarlyAccessHistory({ ...event, afterStatus: 'accepted' }, item.id));
  assert.equal(normalizeEarlyAccessDenial(result, intent).revision, '1');
});
test('one frozen intent pins original revision, actor/session, reason and UUIDs without retaining applicant PII', () => {
  const snapshot = { ...item, status: 'pending', revision: '9007199254740993' };
  const intent = createEarlyAccessDenialIntent(snapshot, owner); snapshot.revision = '9007199254740994';
  assert.ok(Object.isFrozen(intent)); assert.equal(intent.revision, '9007199254740993');
  assert.doesNotMatch(JSON.stringify(intent), /applicant|name|email/);
  const args = earlyAccessDenialArguments(intent);
  assert.deepEqual(Object.keys(args).sort(), ['target_correlation_id', 'target_expected_revision', 'target_operation_id', 'target_request_id']);
  assert.equal(args.target_expected_revision, '9007199254740993');
  for (const change of [{ reasonCode: 'other' }, { operationId: '' }, { actorId: B, sessionIdentity: '' }]) assert.throws(() => earlyAccessDenialArguments({ ...intent, ...change }));
});
test('only explicit matching server success is accepted; malformed and permissive responses stay uncertain', () => {
  const intent = createEarlyAccessDenialIntent(item, owner);
  for (const response of [{ ok: true }, { ok: true, requestId: B, status: 'denied', revision: '1' },
    { ok: true, requestId: item.id, status: 'denied', revision: '2' }, { ok: false, errorCode: 'PRIVATE_ERROR' }]) assert.throws(() => normalizeEarlyAccessDenial(response, intent));
  for (const errorCode of ['revision_conflict', 'invalid_state', 'target_unavailable', 'invalid_input', 'rate_limited']) {
    assert.deepEqual(normalizeEarlyAccessDenial({ ok: false, errorCode, raw: 'secret' }, intent), { ok: false, errorCode });
  }
});
test('denial uses current canonical context, captured bearer and exact original body on every explicit attempt', async () => {
  const f = fixture(); const intent = createEarlyAccessDenialIntent(item, owner);
  await f.client.denyEarlyAccess(intent); await f.client.denyEarlyAccess(intent);
  assert.deepEqual(f.requests.map((value) => value.name), ['get_site_admin_context', 'site_admin_deny_early_access_request', 'get_site_admin_context', 'site_admin_deny_early_access_request']);
  assert.deepEqual(f.requests[1].args, { ...earlyAccessDenialArguments(intent), target_expected_actor_id: A });
  assert.deepEqual(f.requests[1].args, f.requests[3].args); assert.equal(f.requests[1].options.token, owner.sessionIdentity);
});
test('missing capability or recent MFA prevents the write, including a malformed readiness response', async () => {
  for (const mode of ['reader', 'step-up', 'missing']) {
    const f = fixture(); f.mode(mode);
    if (mode === 'missing') f.handle(() => { const value = f.context(); delete value.stepUpRequired; return value; });
    await assert.rejects(f.client.denyEarlyAccess(createEarlyAccessDenialIntent(item, owner)));
    assert.equal(f.requests.length, 1); assert.equal(f.requests[0].name, 'get_site_admin_context');
  }
  const context = fixture().context();
  for (const stepUpRequired of [undefined, null, '', 0, 'false']) assert.equal(normalizeAdminContext({ ...context, stepUpRequired }, A).stepUpRequired, true);
});
test('different initial session cannot replay a prior intent or even begin its context request', async () => {
  const f = fixture(); f.change(A);
  await assert.rejects(f.client.denyEarlyAccess(createEarlyAccessDenialIntent(item, owner)), { code: 'ADMIN_CHANGED' });
  assert.equal(f.requests.length, 0);
  assert.equal(f.notices.at(-1), 'ADMIN_CHANGED');
});
test('an actor round trip while the denial module is settling cannot restart the old intent', async () => {
  const f = fixture(); const result = f.client.denyEarlyAccess(createEarlyAccessDenialIntent(item, owner));
  f.change(B); f.change(A, owner.sessionIdentity);
  await assert.rejects(result, { code: 'ADMIN_CHANGED' }); assert.equal(f.requests.length, 0);
});
for (const scenario of ['new-session', 'new-session-unnotified', 'assurance', 'actor-roundtrip']) {
  test(`${scenario} during async context verification cancels before the denial request`, async () => {
    const f = fixture(); const held = deferred(); f.handle(() => held.promise);
    const result = f.client.denyEarlyAccess(createEarlyAccessDenialIntent(item, owner)); await turn();
    if (scenario === 'actor-roundtrip') { f.change(B); f.change(A, owner.sessionIdentity); }
    else if (scenario === 'assurance') f.change(A, owner.sessionIdentity, 'TOKEN_REFRESHED');
    else f.change(A, `${A}:second-session`, 'SIGNED_IN', scenario !== 'new-session-unnotified');
    held.resolve(f.context()); await assert.rejects(result, { code: 'ADMIN_CHANGED' }); assert.equal(f.requests.length, 1);
  });
}
test('late write responses cannot report success after owner invalidation or ignored request cancellation', async () => {
  for (const kind of ['owner', 'cancel']) {
    const f = fixture(); const held = deferred(); const intent = createEarlyAccessDenialIntent(item, owner); const controller = new AbortController();
    f.handle((name) => name === 'get_site_admin_context' ? f.context() : held.promise);
    const result = f.client.denyEarlyAccess(intent, { signal: controller.signal }); await turn();
    if (kind === 'owner') f.change(B); else controller.abort();
    held.resolve({ ok: true, requestId: item.id, status: 'denied', revision: '1' });
    await assert.rejects(result, { code: kind === 'owner' ? 'ADMIN_CHANGED' : 'ADMIN_UNAVAILABLE' });
  }
});
for (const phase of ['context', 'result']) test(`unnotified same-session bearer replacement during ${phase} cancels the old authority`, async () => {
  const f = fixture(); const held = deferred(); const intent = createEarlyAccessDenialIntent(item, owner);
  f.handle((name) => phase === 'context' || name === 'site_admin_deny_early_access_request' ? held.promise : f.context());
  const result = f.client.denyEarlyAccess(intent); await turn();
  f.token('new-same-session-bearer-with-lower-assurance');
  held.resolve(phase === 'context' ? f.context() : { ok: true, requestId: item.id, status: 'denied', revision: '1' });
  await assert.rejects(result, { code: 'ADMIN_CHANGED' }); assert.equal(f.notices.at(-1), 'ADMIN_CHANGED');
  assert.equal(f.requests.filter((value) => value.name === 'site_admin_deny_early_access_request').length, phase === 'context' ? 0 : 1);
});
test('explicit request cancellation rejects a delayed read even when the provider ignores abort', async () => {
  const f = fixture(); const held = deferred(); const controller = new AbortController(); f.handle(() => held.promise);
  const result = f.client.read('site_admin_list_early_access_requests', {}, { signal: controller.signal }); await turn(); controller.abort();
  held.resolve({ schemaVersion: 1, actorId: A, items: [item] }); await assert.rejects(result, { code: 'ADMIN_UNAVAILABLE' });
});
test('queue controls are no-JS safe, reason is fixed, and the UI never persists or bootstraps private authority', () => {
  const html = readFileSync(new URL('../../admin.html', import.meta.url), 'utf8');
  const detail = readFileSync(new URL('./admin-early-access-detail.mjs', import.meta.url), 'utf8');
  assert.match(html, /<tbody id="adminEarlyRows"><\/tbody>/); assert.match(html, /data-admin-tab="early" hidden/);
  assert.doesNotMatch(detail, /localStorage|sessionStorage|indexedDB|innerHTML|console\.|bootstrap_site_admin|approve.*\(/);
  assert.match(detail, /stepUp: true/); assert.match(detail, /reason\.value !== EARLY_ACCESS_REASON/); assert.match(detail, /originalIntent/);
  const href = new URL(mfaChallengeHref('admin.html', 'https://77dominion.com', { stepUp: true }), 'https://77dominion.com');
  assert.equal(href.searchParams.get('returnTo'), './admin.html');
  assert.equal(href.searchParams.get('mode'), 'step-up');
  assert.doesNotMatch(detail, /mfaChallengeHref\('admin\.html[?#]/);
});
test('legacy preview identities stay in memory and support the same strict denial contract', async () => {
  let id = 'mock_user_e2e_77';
  const preview = createAdminPreview({ getUser: async () => ({ userId: id, authenticated: true }), mode: 'ready' });
  const actor = await preview.owner(); const request = createEarlyAccessPreviewStore().read('site_admin_list_early_access_requests', { target_limit: 25, target_status: 'pending' }, actor.actorId).items[0];
  assert.equal(actor.mockUserId, id); assert.notEqual(actor.actorId, id);
  const intent = createEarlyAccessDenialIntent(request, actor);
  assert.equal((await preview.denyEarlyAccess(intent)).ok, true);
  assert.equal((await preview.denyEarlyAccess(intent)).revision, '1');
  assert.equal((await preview.owner()).actorId, actor.actorId);
  id = 'different_mock_actor'; preview.invalidate();
  await assert.rejects(preview.denyEarlyAccess(intent), { code: 'ADMIN_CHANGED' });
});
test('production owner never exposes a preview identity alias from user or session metadata', async () => {
  const client = createAdminReadClient({
    getSession: async () => ({ user: { id: A }, access_token: 'synthetic', identity: owner.sessionIdentity, mockUserId: 'untrusted' }),
    getUser: async () => ({ id: A, mockUserId: 'untrusted', user_metadata: { mockUserId: 'untrusted' } }),
    sessionIdentity: (value) => value.identity, request: async () => null,
  });
  assert.deepEqual(await client.owner(), owner);
});
test('production-built queue browser coverage stays in the existing required Admin CI suite', () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
  assert.match(read('../../playwright.admin.config.mjs'), /admin-\(\?:live\|early-access-live\)/);
  assert.match(read('../../.github/workflows/browser-quality.yml'), /run: pnpm test:e2e:admin/);
  for (const path of ['./admin-preview.mjs', './admin-read-client.mjs']) {
    assert.doesNotMatch(read(path), /import [^;\n]+ from ['"]\.\/admin-early-access/);
  }
});
