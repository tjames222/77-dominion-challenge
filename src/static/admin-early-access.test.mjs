import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createAdminReadClient, normalizeAdminContext } from './admin-read-client.mjs';
import { createAdminPreview } from './admin-preview.mjs';
import { mfaChallengeHref } from './mfa-navigation.mjs';
import { createEarlyAccessPreviewStore } from './admin-early-access-preview.mjs';
import { createEarlyAccessDenialIntent, earlyAccessDenialArguments, normalizeEarlyAccessRequest, normalizeEarlyAccessHistory, normalizeEarlyAccessDenial,
  createEarlyAccessInvitationIntent, earlyAccessInvitationArguments, normalizeEarlyAccessInvitation, EARLY_ACCESS_INVITATION_FAILURES } from './admin-early-access-contract.mjs';
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
      if (name === 'admin-early-access-invitation') return { ok: true, requestId: args.requestId,
        status: args.action === 'revoke' ? 'revoked' : 'approved', revision: String(BigInt(args.expectedRevision) + 1n) };
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
test('queue footnote distinguishes available invitation review from delivery and accepted access', () => {
  const html = readFileSync(new URL('../../admin.html', import.meta.url), 'utf8');
  const panel = html.match(/<section id="adminEarlyPanel"[\s\S]*?<\/section>/)?.[0];
  assert.ok(panel);
  const footnotes = [...panel.matchAll(/<p class="admin-footnote">([^<]*)<\/p>/g)];
  assert.equal(footnotes.length, 1);
  assert.equal(footnotes[0][1], 'Review requests individually. Authorized reviewers can approve and queue an invitation email, deny a pending request, or manage an existing invitation. Approval does not confirm email delivery or grant access; Early Access begins after a valid invitation is accepted.');
});
test('only approval and denial use semantic colors, including the reused confirmation control', () => {
  const detail = readFileSync(new URL('./admin-early-access-detail.mjs', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../assets/admin.css', import.meta.url), 'utf8');
  assert.match(detail, /deny: \{ tone: 'deny', noun: 'denial', review: 'Review denial', confirm: 'Confirm denial'/);
  assert.match(detail, /approve: \{ tone: 'approve', noun: 'approval', review: 'Review approval', confirm: 'Approve and queue email'/);
  for (const action of ['resend', 'revoke']) assert.doesNotMatch(detail.match(new RegExp(`${action}: \\{[^\\n]+`))?.[0] || '', /tone:/);
  assert.match(detail, /styleDecisionButton\(button\(decision\.review,/);
  assert.match(detail, /confirm\.textContent = decision\.confirm; styleDecisionButton\(confirm, decision\)/);
  assert.match(detail, /else delete control\.dataset\.earlyAccessDecision/);
  assert.match(css, /\[data-early-access-decision="approve"\] \{ --admin-decision-color: var\(--success\)/);
  assert.match(css, /\[data-early-access-decision="deny"\] \{ --admin-decision-color: var\(--danger\)/);
  assert.match(css, /\[data-early-access-decision\]:not\(:disabled\):hover/);
  assert.match(css, /\[data-early-access-decision\]:disabled \{[^}]+color: var\(--button-disabled-text\); opacity: 1; cursor: not-allowed/);
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
  assert.match(read('../../playwright.admin.config.mjs'), /admin-\(\?:live\|early-access-live\|roles-live\)/);
  assert.match(read('../../.github/workflows/browser-quality.yml'), /run: pnpm test:e2e:admin/);
  for (const path of ['./admin-preview.mjs', './admin-read-client.mjs']) {
    assert.doesNotMatch(read(path), /import [^;\n]+ from ['"]\.\/admin-early-access/);
  }
});
for (const [action, states] of Object.entries({ approve: ['pending'], resend: ['approved', 'invited', 'expired'], revoke: ['approved', 'invited'] })) {
  test(`${action} requires its exact lifecycle states and a PII-free frozen original intent`, () => {
    for (const status of ['pending', 'approved', 'invited', 'accepted', 'denied', 'expired', 'revoked']) {
      const request = { ...item, status, revision: '9007199254740993' };
      if (!states.includes(status)) { assert.throws(() => createEarlyAccessInvitationIntent(action, request, owner)); continue; }
      const intent = createEarlyAccessInvitationIntent(action, request, owner);
      assert.ok(Object.isFrozen(intent)); request.revision = '9007199254740994';
      assert.equal(intent.revision, '9007199254740993');
      assert.doesNotMatch(JSON.stringify(intent), /applicant|name|email|token|reason/);
      const args = earlyAccessInvitationArguments(intent);
      assert.deepEqual(Object.keys(args).sort(), ['action', 'correlationId', 'expectedActorId', 'expectedRevision', 'operationId', 'requestId']);
      assert.equal(args.expectedActorId, A); assert.equal(args.expectedRevision, '9007199254740993');
      for (const change of [{ action: 'accept' }, { revision: 0 }, { sessionIdentity: '' }, { operationId: '' }]) assert.throws(() => earlyAccessInvitationArguments({ ...intent, ...change }));
    }
  });
  test(`${action} uses fresh MFA/context and exactly the same Edge intent for an explicit retry`, async () => {
    const f = fixture(); const intent = createEarlyAccessInvitationIntent(action, { ...item, status: states[0] }, owner);
    await f.client.manageEarlyAccessInvitation(intent); await f.client.manageEarlyAccessInvitation(intent);
    assert.deepEqual(f.requests.map((value) => value.name), ['get_site_admin_context', 'admin-early-access-invitation', 'get_site_admin_context', 'admin-early-access-invitation']);
    assert.deepEqual(f.requests[1].args, earlyAccessInvitationArguments(intent));
    assert.deepEqual(f.requests[1].args, f.requests[3].args); assert.equal(f.requests[1].options.token, owner.sessionIdentity);
  });
}
test('invitation responses require exact owner, state and revision with only fixed safe failures', () => {
  const intent = createEarlyAccessInvitationIntent('approve', item, owner);
  for (const response of [{ ok: true }, { ok: true, requestId: B, status: 'approved', revision: '1' },
    { ok: true, requestId: item.id, status: 'invited', revision: '1' }, { ok: true, requestId: item.id, status: 'accepted', revision: '1' },
    { ok: true, requestId: item.id, status: 'approved', revision: 1 }, { ok: true, requestId: item.id, status: 'approved', revision: '2' },
    { ok: false, errorCode: 'PRIVATE_RAW_ERROR' }]) assert.throws(() => normalizeEarlyAccessInvitation(response, intent));
  for (const errorCode of EARLY_ACCESS_INVITATION_FAILURES) assert.deepEqual(normalizeEarlyAccessInvitation({ ok: false, errorCode, raw: 'secret' }, intent), { ok: false, errorCode });
});
test('invitation writes fail before Edge for denied capability, MFA, malformed readiness, and a prior session', async () => {
  const intent = createEarlyAccessInvitationIntent('approve', item, owner);
  for (const mode of ['reader', 'step-up', 'missing', 'changed']) {
    const f = fixture(); f.mode(mode);
    if (mode === 'missing') f.handle(() => { const value = f.context(); delete value.stepUpRequired; return value; });
    if (mode === 'changed') f.change(A);
    await assert.rejects(f.client.manageEarlyAccessInvitation(intent));
    assert.equal(f.requests.filter((value) => value.name === 'admin-early-access-invitation').length, 0);
  }
});
test('invitation lazy-load cannot replay an intent after an actor round trip', async () => {
  const f = fixture(); const result = f.client.manageEarlyAccessInvitation(createEarlyAccessInvitationIntent('approve', item, owner));
  f.change(B); f.change(A, owner.sessionIdentity);
  await assert.rejects(result, { code: 'ADMIN_CHANGED' }); assert.equal(f.requests.length, 0);
});
for (const phase of ['context', 'result']) for (const replacement of ['actor-roundtrip', 'new-session', 'bearer', 'assurance', 'cancel']) {
  test(`invitation ${replacement} at ${phase} fences the captured authority and delayed response`, async () => {
    const f = fixture(); const held = deferred(); const controller = new AbortController();
    const intent = createEarlyAccessInvitationIntent('approve', item, owner);
    f.handle((name) => phase === 'context' || name === 'admin-early-access-invitation' ? held.promise : f.context());
    const result = f.client.manageEarlyAccessInvitation(intent, { signal: controller.signal }); await turn();
    if (replacement === 'actor-roundtrip') { f.change(B); f.change(A, owner.sessionIdentity); }
    else if (replacement === 'new-session') f.change(A, `${A}:replacement`, 'SIGNED_IN', false);
    else if (replacement === 'bearer') f.token('replaced-unnotified-bearer');
    else if (replacement === 'assurance') f.change(A, owner.sessionIdentity, 'TOKEN_REFRESHED');
    else controller.abort();
    held.resolve(phase === 'context' ? f.context() : { ok: true, requestId: item.id, status: 'approved', revision: '1' });
    await assert.rejects(result, { code: replacement === 'cancel' ? 'ADMIN_UNAVAILABLE' : 'ADMIN_CHANGED' });
    assert.equal(f.requests.filter((value) => value.name === 'admin-early-access-invitation').length, phase === 'context' ? 0 : 1);
  });
}
test('synthetic approval, resend and revoke queue only in-memory decisions and never fabricate delivery/acceptance', async () => {
  const preview = createAdminPreview({ getUser: async () => ({ userId: A, authenticated: true }), mode: 'ready' });
  const actor = await preview.owner();
  let request = (await preview.read('site_admin_list_early_access_requests', { target_limit: 25, target_status: 'pending' })).items[0];
  for (const action of ['approve', 'resend', 'revoke']) {
    const intent = createEarlyAccessInvitationIntent(action, request, actor);
    const result = await preview.manageEarlyAccessInvitation(intent);
    assert.deepEqual(await preview.manageEarlyAccessInvitation(intent), result);
    request = (await preview.read('site_admin_get_early_access_request', { target_request_id: request.id })).item;
    assert.equal(request.status, action === 'revoke' ? 'revoked' : 'approved');
    assert.equal(request.invitationSentAt, null); assert.equal(request.acceptedAt, null);
  }
  const history = (await preview.read('site_admin_list_early_access_history', { target_request_id: request.id, target_limit: 10 })).items;
  assert.deepEqual(history.map((event) => normalizeEarlyAccessHistory(event, request.id).action), ['early_access.revoke', 'early_access.resend', 'early_access.approve']);
});
test('acceptance and expiry history are strictly distinguished from admin approval and delivery', () => {
  const base = { id: '1', requestId: item.id, actorId: A, operationId: A, correlationId: B, environment: 'production', occurredAt: '2026-09-27T12:00:00Z', outcome: 'success', errorCode: null, beforeStatus: 'invited' };
  const accepted = { ...base, action: 'early_access.accept', permission: 'early_access.accept', reasonCode: 'invitation_acceptance', afterStatus: 'accepted' };
  const expired = { ...base, actorId: null, action: 'early_access.expire', permission: 'early_access.lifecycle', reasonCode: 'invitation_expiry', afterStatus: 'expired' };
  assert.equal(normalizeEarlyAccessHistory(accepted, item.id).afterStatus, 'accepted');
  assert.equal(normalizeEarlyAccessHistory(expired, item.id).actorId, null);
  for (const change of [{ actorId: null }, { permission: 'operations.manage' }, { reasonCode: 'early_access_review' }, { beforeStatus: 'pending' }]) assert.throws(() => normalizeEarlyAccessHistory({ ...accepted, ...change }, item.id));
  assert.throws(() => normalizeEarlyAccessHistory({ ...expired, actorId: A }, item.id));
  assert.throws(() => normalizeEarlyAccessHistory({ ...expired, outcome: 'failure', errorCode: 'invalid_state', afterStatus: 'invited' }, item.id));
});
