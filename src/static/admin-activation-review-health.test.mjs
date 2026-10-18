import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { normalizeAdminActivationReviewHealth, activationReviewTimestamp } from './admin-activation-review-health.mjs';
import { previewActivationReviewHealth } from './admin-activation-review-health-preview.mjs';
import { mountActivationReviewHealth } from './admin-activation-review-health-view.mjs';
import { createAdminPreview } from './admin-preview.mjs';
import { createAdminReadClient, withAdminReadDeadline } from './admin-read-client.mjs';
import { requestAdminRead } from './admin-read-transport.mjs';

const actor = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const rpc = 'site_admin_get_activation_review_health';
const observedAt = '2026-10-18T12:00:00.000001Z';
const valid = () => ({ schemaVersion: 1, actorId: actor, observedAt, ...previewActivationReviewHealth(observedAt) });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };

test('legacy review DTO projects only its exact bounded aggregate contract', () => {
  const raw = valid(); Object.assign(raw, { userIds: [other], reason: 'PRIVATE_REASON', notes: 'PRIVATE_NOTE', evidence: 'PRIVATE_EVIDENCE' });
  raw.unresolved.rows = ['PRIVATE_ROW']; const value = normalizeAdminActivationReviewHealth(raw, actor);
  assert.deepEqual(Object.keys(value), ['schemaVersion', 'actorId', 'observedAt', 'coverage', 'counterLimit', 'unresolved', 'oldestRecordedAt', 'oldestRecordedState']);
  assert.deepEqual(Object.keys(value.unresolved), ['count', 'hasMore']); assert.doesNotMatch(JSON.stringify(value), /PRIVATE|bbbbbbbb/);
  raw.unresolved.count = 9; assert.equal(value.unresolved.count, 3);
});
for (const [name, change] of Object.entries({
  schema: v => { v.schemaVersion = 2; }, actor: v => { v.actorId = other; }, malformedActor: v => { v.actorId = 'owner'; },
  scope: v => { v.coverage = 'current-activation-blockers'; }, cap: v => { v.counterLimit = 999; },
  missingCount: v => { delete v.unresolved.count; }, countArray: v => { v.unresolved = []; },
  negative: v => { v.unresolved.count = -1; }, fractional: v => { v.unresolved.count = 1.5; }, oversized: v => { v.unresolved.count = 1001; },
  stringCount: v => { v.unresolved.count = '3'; }, stringMore: v => { v.unresolved.hasMore = 'false'; }, falseCap: v => { v.unresolved.hasMore = true; },
  missingState: v => { delete v.oldestRecordedState; }, unsupportedState: v => { v.oldestRecordedState = 'fresh'; },
  nonemptyNone: v => { v.oldestRecordedState = 'none'; v.oldestRecordedAt = null; }, emptyKnown: v => { v.unresolved.count = 0; },
  emptyUnknown: v => { v.unresolved.count = 0; v.oldestRecordedState = 'unknown'; v.oldestRecordedAt = null; },
  emptyWithTime: v => { v.unresolved.count = 0; v.oldestRecordedState = 'none'; },
  unknownWithTime: v => { v.oldestRecordedState = 'unknown'; }, knownWithoutTime: v => { v.oldestRecordedAt = null; },
  futureOldest: v => { v.oldestRecordedAt = '2026-10-18T12:00:00.000002Z'; },
})) test(`legacy review DTO rejects ${name} instead of inventing a count or time`, () => {
  const raw = valid(); change(raw); assert.throws(() => normalizeAdminActivationReviewHealth(raw, actor), { code: 'ADMIN_UNAVAILABLE' });
});

for (const stamp of ['infinity', '-infinity', 'yesterday', '0000-01-01T00:00:00Z', '10000-01-01T00:00:00Z',
  '2026-02-29T00:00:00Z', '1900-02-29T00:00:00Z', '2026-04-31T00:00:00Z', '2026-00-01T00:00:00Z',
  '2026-13-01T00:00:00Z', '2026-01-00T00:00:00Z', '2026-01-32T00:00:00Z', '2026-01-01T24:00:00Z',
  '2026-01-01T00:60:00Z', '2026-01-01T00:00:60Z', '2026-01-01T00:00:00+24:00', '2026-01-01T00:00:00+00:60',
  '2026-01-01T00:00:00.0000001Z', '2026-01-01T00:00:00', '0001-01-01T00:00:00+00:01',
  '9999-12-31T23:59:59-00:01']) test(`legacy review timestamps reject invalid calendar/range ${stamp}`, () => {
  for (const field of ['observedAt', 'oldestRecordedAt']) {
    const raw = valid(); raw[field] = stamp; assert.throws(() => normalizeAdminActivationReviewHealth(raw, actor), { code: 'ADMIN_UNAVAILABLE' });
  }
});
test('exact zero, 1000 and 1000+ stay distinct; nonempty unknown remains unknown', () => {
  for (const [count, hasMore, state, time] of [[0, false, 'none', null], [1000, false, 'known', observedAt],
    [1000, true, 'known', observedAt], [3, false, 'unknown', null], [1000, true, 'unknown', null]]) {
    const raw = { ...valid(), unresolved: { count, hasMore }, oldestRecordedState: state, oldestRecordedAt: time };
    assert.deepEqual(normalizeAdminActivationReviewHealth(raw, actor), raw);
  }
});
test('calendar, UTC range and microsecond boundaries do not depend on browser wall time', () => {
  for (const stamp of ['0001-01-01T00:00:00Z', '0099-02-28T00:00:00Z', '2000-02-29T00:00:00Z', '9999-12-31T23:59:59.999999Z']) {
    const raw = { ...valid(), observedAt: stamp, oldestRecordedAt: stamp }; assert.equal(normalizeAdminActivationReviewHealth(raw, actor).oldestRecordedAt, stamp);
  }
  const raw = valid(); raw.oldestRecordedAt = '2026-10-18T05:00:00.000001-07:00';
  assert.equal(normalizeAdminActivationReviewHealth(raw, actor).oldestRecordedAt, raw.oldestRecordedAt);
  assert.equal(activationReviewTimestamp(raw.oldestRecordedAt), '2026-10-18 12:00:00.000001 UTC');
  raw.oldestRecordedAt = '2026-10-18T05:00:00.000002-07:00';
  assert.throws(() => normalizeAdminActivationReviewHealth(raw, actor), { code: 'ADMIN_UNAVAILABLE' });
});

test('only the new allowlisted read uses an immutable 64KiB ASCII/UTF-8 cap and exact bearer', async () => {
  for (const char of ['x', '界']) for (const extra of [0, 1]) {
    const width = new TextEncoder().encode(char).length, repeats = Math.floor((65536 - 2) / width);
    const raw = `"${char.repeat(repeats)}${'x'.repeat(65536 - 2 - repeats * width + extra)}"`;
    const pending = requestAdminRead({ name: rpc, baseUrl: 'https://provider.invalid', apiKey: 'synthetic', token: 'captured-bearer',
      args: { target_expected_actor_id: actor }, maxBytes: 999999, maxChars: 999999, fetcher: async (url, options) => {
        assert.equal(url, `https://provider.invalid/rest/v1/rpc/${rpc}`); assert.equal(options.cache, 'no-store');
        assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, 'Bearer captured-bearer');
        assert.deepEqual(JSON.parse(options.body), { target_expected_actor_id: actor });
        return new Response(raw, { headers: { 'content-type': 'application/json' } });
      } });
    if (extra) await assert.rejects(pending, { code: 'ADMIN_UNAVAILABLE' }); else assert.equal(await pending, raw.slice(1, -1));
  }
  await assert.rejects(requestAdminRead({ name: 'site_admin_resolve_activation_review' }), { code: 'ADMIN_INVALID_INPUT' });
});
test('invalid UTF-8 and a late response body fail closed without an automatic read retry', async t => {
  const options = { name: rpc, baseUrl: 'https://provider.invalid', apiKey: 'synthetic', token: 'captured', args: {} };
  await assert.rejects(requestAdminRead({ ...options, fetcher: async () => new Response(new Uint8Array([0xc3, 0x28]),
    { headers: { 'content-type': 'application/json' } }) }), { code: 'ADMIN_UNAVAILABLE' });
  t.mock.timers.enable({ apis: ['setTimeout'] }); const gate = deferred(); let calls = 0; let cancels = 0;
  const pending = requestAdminRead({ ...options, fetcher: async () => { calls++; return { ok: true,
    headers: new Headers({ 'content-type': 'application/json' }), body: { getReader: () => ({ read: () => gate.promise,
      cancel: async () => { cancels++; }, releaseLock() {} }) } }; } });
  const failed = assert.rejects(pending, { code: 'ADMIN_UNAVAILABLE' }); await flush(); t.mock.timers.tick(10000); await failed;
  gate.resolve({ done: false, value: new TextEncoder().encode(JSON.stringify(valid())) }); await flush();
  assert.equal(calls, 1); assert(cancels > 0);
});
for (const mode of ['unchanged', 'ABA', 'bearer-only', 'assurance-event']) test(`new read preserves native bearer and owner fencing: ${mode}`, async () => {
  const gate = deferred(); let listener, requested = false; let token = 'captured'; let userId = actor;
  const client = createAdminReadClient({ getSession: async () => ({ user: { id: userId }, access_token: token, identity: 'session' }),
    getUser: async () => { assert.fail('Read may not use mutation identity path'); }, sessionIdentity: session => session.identity,
    getReadUser: async captured => { assert.equal(captured, 'captured'); return { id: actor }; },
    subscribe: callback => { listener = callback; }, request: () => { assert.fail('Read may not use mutation transport'); },
    readRequest: async (name, args, options) => { requested = true; assert.equal(name, rpc); assert.equal(options.token, 'captured');
      assert.deepEqual(args, { target_expected_actor_id: actor }); return gate.promise; } });
  const pending = client.read(rpc, { target_expected_actor_id: other }, { expectedUserId: actor });
  const rejection = mode === 'unchanged' ? null : assert.rejects(pending, { code: 'ADMIN_CHANGED' });
  while (!requested) await Promise.resolve();
  if (mode === 'ABA') for (const id of [other, actor]) { userId = id; listener({ event: 'SIGNED_IN', sessionIdentity: id }); }
  if (mode === 'bearer-only') token = 'replacement-with-same-session';
  if (mode === 'assurance-event') listener({ event: 'TOKEN_REFRESHED', sessionIdentity: 'session' });
  gate.resolve(valid()); if (rejection) await rejection; else assert.equal((await pending).actorId, actor); client.destroy();
});
test('actual API wrapper deadline includes lazy loading and forbids a late dispatch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const source = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
  const read = source.slice(source.indexOf('const readSiteAdmin ='), source.indexOf('export const getSiteAdminContext'));
  const wrapper = source.match(/export const getSiteAdminActivationReviewHealth =[^\n]+/)[0].replace('export ', '');
  const gate = deferred(); let calls = 0;
  const invoke = new Function('getAdminReadClient', 'withAdminReadDeadline', `${read}\n${wrapper}\nreturn getSiteAdminActivationReviewHealth;`)(
    async () => { await gate.promise; return { read(name, args, options) { calls++; assert.equal(name, rpc); assert.deepEqual(args, {});
      assert.equal(options.expectedUserId, actor); return valid(); } }; }, withAdminReadDeadline);
  const pending = invoke({ expectedUserId: actor }); const failed = assert.rejects(pending, { code: 'ADMIN_UNAVAILABLE' });
  t.mock.timers.tick(10000); await failed; gate.resolve(); await flush(); assert.equal(calls, 0);
  assert.equal((await invoke({ expectedUserId: actor })).actorId, actor); assert.equal(calls, 1);
});
test('the existing pure mock adapter alone supplies synthetic review aggregates', async () => {
  const preview = createAdminPreview({ mode: 'ready', getUser: async () => ({ authenticated: true, userId: actor }) });
  const result = await preview.read(rpc, {}, { expectedUserId: actor }); assert.equal(result.preview, true);
  assert.equal(normalizeAdminActivationReviewHealth(result, actor).unresolved.count, 3);
  await assert.rejects(createAdminPreview({ mode: 'member', getUser: async () => ({ authenticated: true, userId: actor }) }).read(rpc), { code: 'ADMIN_DENIED' });
});

class Node {
  constructor() { this.children = []; this.attributes = {}; this.listeners = new Map(); this.dataset = {}; this.value = ''; }
  set textContent(value) { this.value = value; this.children = []; }
  get textContent() { return this.value + this.children.map(child => child.textContent).join(' '); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this.value = ''; }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  removeEventListener(name) { this.listeners.delete(name); }
}
async function viewTest(work) {
  const previous = globalThis.document; globalThis.document = { createElement: () => new Node(), createDocumentFragment: () => new Node() };
  const root = new Node(), button = new Node(), status = new Node(), data = new Node();
  root.querySelector = id => ({ '#adminActivationReviewRefresh': button, '#adminActivationReviewStatus': status, '#adminActivationReviewData': data })[id];
  let owner = { actorId: actor }; let calls = 0; let read = async () => valid(); const errors = [];
  const view = mountActivationReviewHealth({ root, read: options => { calls++; assert.equal(options.expectedUserId, actor); return read(options); },
    getOwner: () => owner, isCurrent: captured => captured === owner, onAuthorityError: error => { errors.push(error.code); view.clear(); } });
  try { await work({ root, button, status, data, view, errors, click: () => button.listeners.get('click')(), calls: () => calls,
    setRead: next => { read = next; }, changeOwner: () => { owner = { actorId: other }; } }); }
  finally { view.destroy(); globalThis.document = previous; }
}
test('view is manual-only, suppresses duplicate reads, preserves a stable button and projects no private fields', async () => viewTest(async f => {
  f.view.clear({ ready: true }); assert.equal(f.calls(), 0); assert.match(f.status.textContent, /Not checked/);
  const gate = deferred(); f.setRead(() => gate.promise); const pending = f.click(); await f.click();
  assert.equal(f.calls(), 1); assert.equal(f.root.attributes['aria-busy'], 'true'); assert.equal(f.button.attributes['aria-disabled'], 'true');
  assert.equal(f.data.textContent, ''); const raw = valid(); raw.reason = 'PRIVATE_REASON'; gate.resolve(raw); await pending;
  assert.match(f.data.textContent, /Unresolved legacy review records 3/); assert.match(f.status.textContent, /Observed/);
  assert.doesNotMatch(f.data.textContent, /PRIVATE|aaaaaaaa/); assert.equal(f.button.attributes['aria-disabled'], undefined);
  assert.equal(f.calls(), 1);
}));
for (const mode of ['abort-ignored', 'owner-change', 'shape', 'transport', 'authority']) test(`view clears and cannot republish stale data after ${mode}`, async () => viewTest(async f => {
  await f.click(); const gate = deferred(); f.setRead(() => gate.promise); const pending = f.click(); assert.equal(f.data.textContent, '');
  if (mode === 'abort-ignored') f.view.clear();
  if (mode === 'owner-change') f.changeOwner();
  if (mode === 'shape') gate.resolve({ ...valid(), oldestRecordedState: 'none' });
  else if (mode === 'transport' || mode === 'authority') { f.view.clear(); f.setRead(async () => { throw Object.assign(new Error('PRIVATE_ERROR'), { code: mode === 'authority' ? 'ADMIN_DENIED' : 'ADMIN_UNAVAILABLE' }); }); await f.click(); gate.resolve(valid()); }
  else gate.resolve(valid());
  await pending; assert.equal(f.data.textContent, ''); assert.doesNotMatch(f.status.textContent, /PRIVATE/);
  if (['shape', 'transport'].includes(mode)) assert.match(f.status.textContent, /counts and oldest recorded time are unknown/);
  if (mode === 'authority') assert.deepEqual(f.errors, ['ADMIN_DENIED']);
}));
test('view displays none, capped and unknown without conflating legacy rows with current blockers', async () => viewTest(async f => {
  for (const [count, hasMore, state] of [[0, false, 'none'], [1000, false, 'unknown'], [1000, true, 'unknown']]) {
    f.setRead(async () => ({ ...valid(), unresolved: { count, hasMore }, oldestRecordedAt: null, oldestRecordedState: state }));
    await f.click(); assert.match(f.data.textContent, new RegExp(`records ${count}${hasMore ? '\\+' : ' '}`));
    assert.match(f.data.textContent, state === 'none' ? /No unresolved legacy review records/ : /Unknown/);
    assert.match(f.data.textContent, /does not prove the underlying account was repaired/);
  }
}));
test('integration stays Operations-only, scrubbed and free of timers, writes or eager non-Admin imports', () => {
  const admin = readFileSync(new URL('./admin.js', import.meta.url), 'utf8');
  assert.match(admin, /activationReviewHealth = mountActivationReviewHealth[\s\S]*?tab === 'operations' && permissions\.includes\('operations\.read'\)/);
  assert.match(admin.slice(admin.indexOf('function scrub('), admin.indexOf('function showError(')), /activationReviewHealth\.clear\(\)/);
  assert.match(admin.slice(admin.indexOf('function selectTab('), admin.indexOf('async function verifyAccess(')), /activationReviewHealth\.clear\(\{ ready: true \}\)/);
  const view = readFileSync(new URL('./admin-activation-review-health-view.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(view, /setInterval|setTimeout|localStorage|sessionStorage|console\.|\.rpc\(/);
  const api = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
  assert.doesNotMatch(api, /^import .*admin-activation-review-health/m);
});
