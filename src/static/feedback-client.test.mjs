import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createFeedbackClient, normalizeMemberAccessContext } from './feedback-client.mjs';
import { createFeedbackIntent } from './feedback-contract.mjs';
import { createFeedbackDialog } from './feedback-dialog.mjs';
import { feedbackTestPage } from './feedback-test-dom.mjs';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const S1 = '33333333-3333-4333-8333-333333333333';
const S2 = '44444444-4444-4444-8444-444444444444';
const F = '55555555-5555-4555-8555-555555555555';
const O = '66666666-6666-4666-8666-666666666666';
const context = { route: 'dashboard.html', theme: 'dark', viewport: { width: 390, height: 844 }, buildSha: 'a'.repeat(40), browser: 'safari', platform: 'ios' };
const input = { type: 'bug', description: 'Original\n feedback ', expectedBehavior: '', impact: 'minor', contactAllowed: false };
const intent = () => createFeedbackIntent(input, context, O);
const access = (actorId = A, patch = {}) => ({ schemaVersion: 1, actorId, asOf: '2026-09-21T22:30:00.123456+00:00',
  appAccess: true, legacyMembershipActive: false, paidSubscriptionActive: false, earlyAccessActive: true,
  earlyAccessProgram: 'early_access_v1', earlyAccessEndsAt: null, betaPriceEligible: true, ...patch });
const saved = args => ({ schemaVersion: 1, actorId: args.target_expected_actor_id, feedbackId: F, operationId: args.target_operation_id, status: 'saved' });
const session = (actor = A, id = S1, token = `${actor}:${id}:token`) => ({ user: { id: actor }, sid: id, access_token: token });
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check) { for (let index = 0; index < 50; index++) { if (check()) return; await tick(); } assert.fail('Expected local operation stage was not reached.'); }
function fixture({ requestTimeoutMs = 1000 } = {}) {
  let current = session(); let notify; let unsubscribed = 0; let contextPatch = {};
  let onSession; let onUser; let onRequest;
  const sessions = []; const users = []; const requests = [];
  const client = createFeedbackClient({ requestTimeoutMs,
    getSession: async () => { sessions.push(current); return onSession ? onSession(sessions.length) : current; },
    getUser: async token => { users.push(token); return onUser ? onUser(token) : current?.user; },
    sessionIdentity: value => value?.user?.id && value.sid ? `${value.user.id}:${value.sid}` : '',
    subscribe: callback => { notify = callback; return () => unsubscribed++; },
    request: async (name, args, options) => {
      requests.push({ name, args, options });
      return onRequest ? onRequest(name, args, options) : name === 'get_member_access_context' ? access(args.target_expected_actor_id, contextPatch) : saved(args);
    },
  });
  return { client, sessions, users, requests, get current() { return current; }, get unsubscribed() { return unsubscribed; },
    onSession: fn => { onSession = fn; }, onUser: fn => { onUser = fn; }, onRequest: fn => { onRequest = fn; },
    context: patch => { contextPatch = patch; },
    emit(event) { notify({ event, sessionIdentity: current ? `${current.user.id}:${current.sid}` : '' }); },
    change(actor = A, sid = S1, token, emit = true) { current = actor ? session(actor, sid, token) : null; if (emit) notify({ event: actor ? 'SIGNED_IN' : 'SIGNED_OUT', sessionIdentity: actor ? `${actor}:${sid}` : '' }); },
  };
}

test('strict access contract uses canonical active EA only and permits retained beta eligibility when inactive', () => {
  assert.deepEqual(normalizeMemberAccessContext(access(), A), access());
  assert.equal(Object.isFrozen(normalizeMemberAccessContext(access(), A)), true);
  assert.equal(normalizeMemberAccessContext(access(A, { earlyAccessActive: false, earlyAccessProgram: null, appAccess: false }), A).betaPriceEligible, true);
  for (const patch of [{ schemaVersion: 2 }, { actorId: B }, { extra: true }, { asOf: 'today' }, { earlyAccessEndsAt: 'tomorrow' },
    { earlyAccessProgram: 'test_access' }, { earlyAccessActive: 'true' }, { appAccess: false }, { paidSubscriptionActive: true },
    { earlyAccessActive: false }, { betaPriceEligible: 1 },
    { earlyAccessActive: false, earlyAccessProgram: null, appAccess: false, earlyAccessEndsAt: '2026-09-22T00:00:00Z' }]) assert.throws(() => normalizeMemberAccessContext(access(A, patch), A));
  assert.throws(() => normalizeMemberAccessContext(access(undefined, { actorId: undefined }), undefined));
});

test('every read and submit verifies canonical Auth; both RPCs have exact fields and the original bearer', async () => {
  const f = fixture(); const first = await f.client.readAccess({ expectedUserId: A });
  assert.deepEqual(first.owner, { actorId: A, sessionIdentity: `${A}:${S1}` });
  assert.deepEqual(Object.keys(first), ['owner', 'context']); assert.equal(Object.isFrozen(first.owner), true);
  const result = await f.client.submit(first.owner, intent());
  assert.deepEqual(result, saved({ target_expected_actor_id: A, target_operation_id: O }));
  assert.deepEqual(f.users, [f.current.access_token, f.current.access_token]);
  assert.deepEqual(f.requests.map(item => item.name), ['get_member_access_context', 'get_member_access_context', 'submit_early_access_feedback']);
  for (const item of f.requests) {
    assert.equal(item.args.target_expected_actor_id, A); assert.equal(item.options.token, f.current.access_token);
    assert.ok(item.options.signal instanceof AbortSignal);
  }
  assert.deepEqual(f.requests[2].args, { target_expected_actor_id: A, target_operation_id: O, target_input: input, target_context: context });
  assert.doesNotMatch(JSON.stringify(first), /access_token|:token/); f.client.destroy();
});

test('issued owners cannot be forged or cloned; bound callbacks support the actual dialog owner clone', async () => {
  const f = fixture(); const { owner } = await f.client.readAccess();
  assert.equal(f.client.isCurrent({ ...owner }), false);
  assert.throws(() => f.client.bindOwner({ ...owner }), { code: 'FEEDBACK_CHANGED' });
  await assert.rejects(f.client.submit({ ...owner }, intent()), { code: 'FEEDBACK_CHANGED' });
  const bound = f.client.bindOwner(owner); assert.equal(bound.isCurrent({ ...owner }), true);
  assert.equal(bound.isCurrent({ ...owner, actorId: B }), false);
  const page = feedbackTestPage(); const dialog = createFeedbackDialog({ document: page.document, ...bound, context });
  assert.equal(dialog.open(page.trigger), true);
  const field = name => page.find(node => node.name === name);
  for (const [name, value] of Object.entries(input)) { if (name === 'contactAllowed') field(name).checked = value; else field(name).value = value; }
  await page.find(node => node.tagName === 'FORM').dispatch('submit');
  assert.match(page.text(), /Your feedback is saved/); assert.equal(f.requests.length, 3);
  dialog.destroy(); f.client.destroy();
});

test('idle issued owners are scrubbed by the first replacement notice even before INITIAL_SESSION', async () => {
  for (const [actor, sid] of [[A, S2], [B, S1]]) {
    const f = fixture(); const { owner } = await f.client.readAccess(); let notices = 0;
    f.client.subscribe(() => notices++); const before = f.users.length;
    f.change(actor, sid); assert.equal(notices, 1); assert.equal(f.client.isCurrent(owner), false);
    assert.equal(f.users.length, before); f.client.destroy();
  }
  const f = fixture(); const { owner } = await f.client.readAccess(); f.change(A, S2, undefined, false);
  await assert.rejects(f.client.readAccess(), { code: 'FEEDBACK_CHANGED' }); assert.equal(f.client.isCurrent(owner), false);
  const next = await f.client.readAccess(); assert.equal(next.owner.sessionIdentity, `${A}:${S2}`); f.client.destroy();
});

test('snapshots bind exact input/context to operation ID, reject changed-payload reuse before any Auth call', async () => {
  const f = fixture(); const { owner } = await f.client.readAccess(); const original = intent();
  await f.client.submit(owner, original); const before = f.users.length;
  await assert.rejects(f.client.submit(owner, createFeedbackIntent({ ...input, description: 'Changed' }, context, O)), { code: 'FEEDBACK_INTENT_CONFLICT' });
  await assert.rejects(f.client.submit(owner, { ...original, actorId: B }), { code: 'FEEDBACK_INVALID_INPUT' });
  assert.equal(f.users.length, before);
  await f.client.submit(owner, original);
  assert.deepEqual(f.requests.filter(item => item.name === 'submit_early_access_feedback').map(item => item.args), [f.requests[2].args, f.requests[2].args]);
  assert.equal(f.users.length, before + 1); f.client.destroy();
});

test('inactive EA never grants a first submission based on legacy membership or beta eligibility', async () => {
  const f = fixture(); const { owner } = await f.client.readAccess();
  f.context({ earlyAccessActive: false, earlyAccessProgram: null, legacyMembershipActive: true, paidSubscriptionActive: true });
  await assert.rejects(f.client.submit(owner, intent()), { code: 'FEEDBACK_NOT_ELIGIBLE' });
  assert.equal(f.requests.some(item => item.name === 'submit_early_access_feedback'), false); f.client.destroy();
});

test('exact retry after an uncertain dispatch can reconcile a committed receipt after EA lapses', async () => {
  const f = fixture(); const { owner } = await f.client.readAccess(); let sends = 0;
  f.onRequest((name, args) => {
    if (name === 'get_member_access_context') return access(A, sends ? { earlyAccessActive: false, earlyAccessProgram: null, appAccess: false } : {});
    sends++; if (sends === 1) throw new Error('Lost response secret'); return saved(args);
  });
  await assert.rejects(f.client.submit(owner, intent()), error => error.code === 'FEEDBACK_UNAVAILABLE' && !error.message.includes('secret'));
  assert.equal((await f.client.submit(owner, intent())).status, 'saved'); assert.equal(sends, 2);
  const fresh = createFeedbackIntent(input, context);
  await assert.rejects(f.client.submit(owner, fresh), { code: 'FEEDBACK_NOT_ELIGIBLE' }); assert.equal(sends, 2); f.client.destroy();
});

test('same-user replacement and A-to-B-to-A notifications synchronously fence held requests despite ignored abort', async () => {
  for (const replacement of [false, true]) {
    const f = fixture(); const { owner } = await f.client.readAccess(); const held = deferred(); let dispatched = false; let notices = 0;
    f.client.subscribe(() => { throw new Error('Broken listener'); }); f.client.subscribe(() => notices++);
    f.onRequest((name, args) => { if (name === 'submit_early_access_feedback') { dispatched = true; return held.promise; } return access(); });
    const result = f.client.submit(owner, intent()); const rejection = assert.rejects(result, { code: 'FEEDBACK_CHANGED' });
    await until(() => dispatched);
    if (replacement) f.change(A, S2); else { f.change(B); f.change(A); }
    assert.ok(notices >= 1); assert.equal(f.client.isCurrent(owner), false);
    assert.equal(f.requests.at(-1).options.signal.aborted, true);
    await rejection; held.resolve(saved({ target_expected_actor_id: A, target_operation_id: O })); await tick(); f.client.destroy();
  }
});

test('assurance, refresh, recovery and lifecycle invalidation retire all issued owners without SDK calls inside observer', async () => {
  for (const event of ['SIGNED_OUT', 'TOKEN_REFRESHED', 'USER_UPDATED', 'PASSWORD_RECOVERY', 'MFA_CHALLENGE_VERIFIED', 'pagehide']) {
    const f = fixture(); const { owner } = await f.client.readAccess(); const before = [f.users.length, f.sessions.length, f.requests.length]; let notices = 0;
    f.client.subscribe(() => notices++);
    if (event === 'pagehide') f.client.invalidate(); else f.emit(event);
    assert.equal(notices, 1); assert.equal(f.client.isCurrent(owner), false);
    assert.deepEqual([f.users.length, f.sessions.length, f.requests.length], before); f.client.destroy();
  }
});

test('silent exact-bearer replacement during canonical Auth prevents context/mutation dispatch', async () => {
  const f = fixture(); const held = deferred(); f.onUser(() => held.promise);
  const result = f.client.readAccess(); const rejection = assert.rejects(result, { code: 'FEEDBACK_CHANGED' });
  await until(() => f.users.length === 1); f.change(A, S1, 'new-bearer-same-session', false); held.resolve({ id: A });
  await rejection; assert.equal(f.requests.length, 0); f.client.destroy();
});

test('silent replacement during RPC or postcheck rejects old result without adopting a newer bearer', async () => {
  const f = fixture(); const held = deferred(); f.onRequest(() => held.promise);
  const result = f.client.readAccess(); const rejection = assert.rejects(result, { code: 'FEEDBACK_CHANGED' });
  await until(() => f.requests.length === 1); f.change(A, S1, 'new-bearer', false); held.resolve(access());
  await rejection; assert.equal(f.requests[0].options.token.endsWith(':token'), true); f.client.destroy();
});

test('caller-only cancellation settles a hung caller while another current owner remains usable', async () => {
  const f = fixture(); const { owner } = await f.client.readAccess(); const held = deferred(); let blocked = true;
  f.onRequest((name, args) => blocked ? held.promise : name === 'get_member_access_context' ? access() : saved(args));
  const controller = new AbortController(); const result = f.client.readAccess({ signal: controller.signal });
  const rejection = assert.rejects(result, { code: 'FEEDBACK_CANCELLED' }); await until(() => f.requests.length === 2);
  controller.abort(); await rejection; assert.equal(f.client.isCurrent(owner), true);
  blocked = false; assert.equal((await f.client.submit(owner, intent())).status, 'saved');
  held.resolve(access()); await tick(); f.client.destroy();
});

test('an already-aborted caller never starts Auth or RPC work', async () => {
  const f = fixture(); const signal = AbortSignal.abort();
  await assert.rejects(f.client.readAccess({ signal }), { code: 'FEEDBACK_CANCELLED' });
  assert.equal(f.sessions.length + f.users.length + f.requests.length, 0); f.client.destroy();
});

test('malformed cancellation inputs fail before registering work or starting Auth', async () => {
  const f = fixture();
  for (const signal of [null, {}, false, { aborted: false }]) await assert.rejects(f.client.readAccess({ signal }), { code: 'FEEDBACK_INVALID_INPUT' });
  assert.equal(f.sessions.length + f.users.length + f.requests.length, 0); f.client.destroy();
});

test('one bounded deadline covers each Auth/read wait and blocks late continuation dispatch', async () => {
  for (const stage of ['first-session', 'user', 'access-rpc', 'final-session']) {
    const f = fixture({ requestTimeoutMs: 5 }); const held = deferred();
    if (stage === 'first-session') f.onSession(() => held.promise);
    if (stage === 'user') f.onUser(() => held.promise);
    if (stage === 'access-rpc') f.onRequest(() => held.promise);
    if (stage === 'final-session') f.onSession(count => count === 3 ? held.promise : f.current);
    await assert.rejects(f.client.readAccess(), { code: 'FEEDBACK_UNCONFIRMED' });
    const before = [f.sessions.length, f.users.length, f.requests.length];
    held.resolve(stage === 'user' ? { id: A } : stage === 'access-rpc' ? access() : f.current); await tick();
    assert.deepEqual([f.sessions.length, f.users.length, f.requests.length], before); f.client.destroy();
  }
});

test('write timeout permits same-operation retry but a delayed committed response cannot escape the expired call', async () => {
  const f = fixture({ requestTimeoutMs: 5 }); const { owner } = await f.client.readAccess(); const held = deferred(); let count = 0;
  f.onRequest((name, args) => name === 'get_member_access_context' ? access() : (++count === 1 ? held.promise : saved(args)));
  await assert.rejects(f.client.submit(owner, intent()), { code: 'FEEDBACK_UNCONFIRMED' });
  assert.equal(f.requests.at(-1).options.signal.aborted, true);
  assert.equal((await f.client.submit(owner, intent())).status, 'saved');
  held.resolve(saved({ target_expected_actor_id: A, target_operation_id: O })); await tick(); assert.equal(count, 2); f.client.destroy();
});

test('strict RPC and receipt validation never publishes extra fields, wrong actors or incomplete outcomes', async () => {
  for (const patch of [{ actorId: B }, { operationId: F }, { status: 'queued' }, { tokens: 'private' }]) {
    const f = fixture(); const { owner } = await f.client.readAccess();
    f.onRequest((name, args) => name === 'get_member_access_context' ? access() : { ...saved(args), ...patch });
    await assert.rejects(f.client.submit(owner, intent()), { code: 'FEEDBACK_UNCONFIRMED' }); f.client.destroy();
  }
  const f = fixture(); f.onRequest(() => access(A, { journal: 'private' }));
  await assert.rejects(f.client.readAccess(), { code: 'FEEDBACK_UNAVAILABLE' }); f.client.destroy();
});

test('fixed provider Auth/origin/MFA errors invalidate consumers and never display provider details', async () => {
  for (const [code, message, expected] of [['PT401', 'member_authentication_required', 'FEEDBACK_SIGNED_OUT'],
    ['PT403', 'member_origin_forbidden', 'FEEDBACK_DENIED'], ['PT403', 'member_mfa_required', 'FEEDBACK_MFA_REQUIRED']]) {
    const f = fixture(); const { owner } = await f.client.readAccess(); let notices = 0; f.client.subscribe(() => notices++);
    f.onRequest(() => { throw { code, message, details: 'private detail' }; });
    await assert.rejects(f.client.submit(owner, intent()), error => error.code === expected && !error.message.includes('private'));
    assert.equal(notices, 1); assert.equal(f.client.isCurrent(owner), false); f.client.destroy();
  }
});

test('final write session check remains deadline-bound and cannot publish through silent bearer replacement', async () => {
  const f = fixture({ requestTimeoutMs: 10 }); const { owner } = await f.client.readAccess(); const held = deferred();
  f.onSession(count => count === 8 ? held.promise : f.current);
  await assert.rejects(f.client.submit(owner, intent()), { code: 'FEEDBACK_UNCONFIRMED' });
  assert.equal(f.requests.filter(item => item.name === 'submit_early_access_feedback').length, 1);
  held.resolve(f.current); await tick(); f.onSession(null);
  assert.equal((await f.client.submit(owner, intent())).status, 'saved'); f.client.destroy();
  const changed = fixture(); const issued = await changed.client.readAccess();
  changed.onSession(count => { if (count === 8) changed.change(A, S1, 'silently-replaced-after-write', false); return changed.current; });
  await assert.rejects(changed.client.submit(issued.owner, intent()), { code: 'FEEDBACK_CHANGED' });
  assert.equal(changed.client.isCurrent(issued.owner), false); changed.client.destroy();
});

test('destroy cancels pending work, unsubscribes once and permanently rejects old owners', async () => {
  const f = fixture(); const { owner } = await f.client.readAccess(); const held = deferred(); f.onRequest(() => held.promise);
  const result = f.client.submit(owner, intent()); const rejection = assert.rejects(result, { code: 'FEEDBACK_CHANGED' }); await until(() => f.requests.length === 2);
  f.client.destroy(); f.client.destroy(); await rejection; assert.equal(f.unsubscribed, 1);
  assert.equal(f.client.isCurrent(owner), false); await assert.rejects(f.client.submit(owner, intent()), { code: 'FEEDBACK_CHANGED' });
  held.resolve(access()); await tick();
});

test('the adapter is a lazy injection leaf, with no SDK construction, ambient state or feature UI imports', () => {
  const source = readFileSync(new URL('./feedback-client.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /createClient\(|localStorage|sessionStorage|console\.|fetch\(|import\s.+(?:api\.js|auth-runtime|feedback-dialog|menu\.js)/);
  const api = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
  assert.match(api, /import\('\.\/feedback-client\.mjs'\)/);
  assert.doesNotMatch(api, /from ['"]\.\/feedback-(?:client|dialog|widget)/);
  for (const file of ['menu.js', 'auth-runtime-core.mjs']) assert.doesNotMatch(readFileSync(new URL(`./${file}`, import.meta.url), 'utf8'), /feedback-client/);
});
