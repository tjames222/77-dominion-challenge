import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAdminPreview } from './admin-preview.mjs';
import { parseAdminLookupUserId, readAdminUserLookup } from './admin-user-lookup.mjs';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const U = '70000000-0000-4000-8000-000000000001';
const owner = { actorId: A, sessionIdentity: 'synthetic-session' };
const provider = createAdminPreview({ mode: 'ready', getUser: async () => ({ authenticated: true, userId: A }) });
const payload = async () => structuredClone(await provider.read('site_admin_get_user', { target_user_id: U }, { expectedUserId: A }));
const context = () => ({ schemaVersion: 1, actorId: A, role: 'site_admin', adminReady: true, permissions: ['users.read'] });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(overrides = {}) {
  const calls = [];
  return { owner, userId: U, calls,
    getOwner: async options => { calls.push(['owner', options]); return { ...owner }; },
    getContext: async options => { calls.push(['context', options]); return context(); },
    readUser: async (id, options) => { calls.push(['user', id, options]); return payload(); }, ...overrides };
}

test('exact UUID validation canonicalizes uppercase but never trims or infers prefixes', () => {
  assert.equal(parseAdminLookupUserId(A.toUpperCase()), A); assert.equal(parseAdminLookupUserId(U), U);
  for (const value of [null, undefined, 0, {}, '', 'member@example.test', A.slice(0, 8), ` ${A}`, `${A}\n`, `${A}extra`,
    '00000000-0000-0000-0000-000000000000', 'aaaaaaaa-aaaa-9aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-4aaa-0aaa-aaaaaaaaaaaa']) {
    assert.equal(parseAdminLookupUserId(value), null);
  }
});
test('each explicit lookup uses users.read alone, fresh context on both sides, one exact read and shared cancellation', async () => {
  const f = fixture(); const result = await readAdminUserLookup(f);
  assert.equal(result.item.id, U); assert.deepEqual(f.calls.map(call => call[0]), ['owner', 'context', 'user', 'owner', 'context', 'owner']);
  const signal = f.calls[0][1].signal;
  for (const call of f.calls) assert.equal(call.at(-1).signal, signal);
  assert.equal(f.calls[2][1], U); assert.equal(f.calls[2][2].expectedUserId, A);
});
test('the real ready mock adapter provides a read-only exact snapshot with no production dependency', async () => {
  const preview = createAdminPreview({ mode: 'ready', getUser: async () => ({ authenticated: true, userId: 'legacy-preview-owner' }) });
  const captured = await preview.owner();
  const result = await readAdminUserLookup({ owner: captured, userId: U, getOwner: () => preview.owner(),
    getContext: options => preview.read('get_site_admin_context', {}, options),
    readUser: (id, options) => preview.read('site_admin_get_user', { target_user_id: id }, options) });
  assert.equal(result.item.id, U); assert.equal(result.item.name, 'Preview Member 1');
});
test('safe existing DTO projection removes unknown private fields and bounds the complete response', async () => {
  const value = await payload(); value.secret = 'PRIVATE'; value.item.privateNotes = 'PRIVATE'; value.item.activationSnapshot.secret = 'PRIVATE';
  const result = await readAdminUserLookup(fixture({ readUser: async () => value }));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/); assert.equal(result.item.subscriptionSnapshot, null);
});
for (const [name, mutate] of Object.entries({
  actor: value => { value.actorId = B; }, target: value => { value.item.id = B; }, schema: value => { value.schemaVersion = 2; },
  missing: value => { value.item = null; }, time: value => { value.observedAt = 'yesterday'; },
  oversized: value => { value.item.name = 'x'.repeat(121); }, partial: value => { delete value.item.lastSignInAt; },
  snapshot: value => { value.item.statsSnapshot.totalPoints = '123'; },
})) test(`malformed ${name} lookup response publishes no facts`, async () => {
  const value = await payload(); mutate(value);
  await assert.rejects(readAdminUserLookup(fixture({ readUser: async () => value })), { code: 'ADMIN_UNAVAILABLE' });
});
for (const [name, changes, code] of [
  ['permission', { permissions: ['operations.read'] }, 'ADMIN_DENIED'], ['MFA', { adminReady: false, reason: 'mfa_required' }, 'ADMIN_DENIED'],
  ['actor', { actorId: B }, 'ADMIN_UNAVAILABLE'], ['schema', { schemaVersion: 2 }, 'ADMIN_UNAVAILABLE'],
  ['role', { role: 'member' }, 'ADMIN_UNAVAILABLE'],
]) for (const phase of ['pre', 'post']) test(`${phase} ${name} failure cannot publish lookup facts`, async () => {
  let contexts = 0, reads = 0;
  await assert.rejects(readAdminUserLookup(fixture({ getContext: async () => ({ ...context(),
    ...(phase === 'pre' || ++contexts === 2 ? changes : {}) }),
  readUser: async () => { reads += 1; return payload(); } })), { code });
  assert.equal(reads, phase === 'pre' ? 0 : 1);
});
for (const change of [{ actorId: B }, { sessionIdentity: 'replacement' }]) for (const occurrence of [1, 2, 3]) {
  test(`owner ${Object.keys(change)[0]} change at observation ${occurrence} rejects lookup`, async () => {
    let owners = 0;
    await assert.rejects(readAdminUserLookup(fixture({ getOwner: async () => ({ ...owner, ...(++owners === occurrence ? change : {}) }) })), { code: 'ADMIN_CHANGED' });
  });
}
for (const [method, occurrence] of [['getOwner', 1], ['getContext', 1], ['readUser', 1], ['getOwner', 2], ['getContext', 2], ['getOwner', 3]]) {
  test(`one total deadline bounds ${method} ${occurrence}, with no late continuation or automatic retry`, async () => {
    const f = fixture(); const original = f[method]; const held = deferred(); let count = 0;
    f[method] = async (...args) => ++count === occurrence ? held.promise : original(...args);
    await assert.rejects(readAdminUserLookup({ ...f, timeoutMs: 10 }), { code: 'ADMIN_UNAVAILABLE' });
    const callsAtStop = f.calls.length;
    held.resolve(method === 'getOwner' ? { ...owner } : method === 'getContext' ? context() : await payload());
    await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.length, callsAtStop);
    assert.equal((await readAdminUserLookup(f)).item.id, U);
  });
}
test('abort settles a held read and a late access failure cannot overwrite the next manual lookup', async () => {
  const held = deferred(); const entered = deferred(); let reads = 0;
  const f = fixture({ readUser: async () => { if (++reads === 1) { entered.resolve(); return held.promise; } return payload(); } });
  const controller = new AbortController(); const first = readAdminUserLookup({ ...f, signal: controller.signal });
  await entered.promise; controller.abort(); await assert.rejects(first, { code: 'ADMIN_UNAVAILABLE' });
  assert.equal((await readAdminUserLookup(f)).item.id, U);
  held.reject(Object.assign(new Error('PRIVATE late error'), { code: 'ADMIN_DENIED' }));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(reads, 2);
});
test('invalid target, invalid owner, noncanonical input and pre-aborted operations make zero calls', async () => {
  for (const overrides of [null, '', '<script>', U + 'extra', A.toUpperCase()].map(userId => ({ userId }))
    .concat([{ owner: null }, { owner: { ...owner, actorId: 'invalid' } }, { owner: { ...owner, sessionIdentity: '' } }])) {
    const f = fixture(overrides); await assert.rejects(readAdminUserLookup(f)); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); const controller = new AbortController(); controller.abort();
  await assert.rejects(readAdminUserLookup({ ...f, signal: controller.signal })); assert.equal(f.calls.length, 0);
});
test('lookup composition stays read-only and separate from Users mutations and list state', () => {
  const main = readFileSync(new URL('./admin.js', import.meta.url), 'utf8');
  const view = readFileSync(new URL('./admin-user-lookup-detail.mjs', import.meta.url), 'utf8');
  const helper = readFileSync(new URL('./admin-user-lookup.mjs', import.meta.url), 'utf8');
  const direct = main.slice(main.indexOf('function openUserLookup('), main.indexOf('async function openDetail('));
  assert.match(direct, /mountAdminUserLookup/); assert.match(direct, /capturedOwner === owner/); assert.match(direct, /query === queryEpoch/);
  assert.doesNotMatch(direct, /mountRoleDetail|mountProfileNameDetail|mountAdminUserHistory|loadPage\(|cursors =|page =/);
  assert.doesNotMatch(view + helper + direct, /localStorage|sessionStorage|URLSearchParams|console\.|location\.|\.write\(|\.correctProfileName\(|\.assignRole\(/);
  assert.match(view, /if \(document\.activeElement === retry\) retry\.scrollIntoView\(\{ block: 'nearest', inline: 'nearest' \}\)/);
  assert.doesNotMatch(view, /\.focus\(/);
  assert.match(main, /addEventListener\('pagehide', \(\) => \{ suspended = true; scrub\(\); \}\)/);
  assert.match(main, /clearUserLookup\(\{ reset: true \}\)/);
  const html = readFileSync(new URL('../../admin.html', import.meta.url), 'utf8');
  assert.match(html, /<details id="adminUserLookup" class="admin-user-lookup">/);
  // The editing cap exceeds an exact UUID so a pasted UUID plus suffix cannot
  // be silently truncated into a valid lookup before our parser sees it.
  assert.match(html, /id="adminUserLookupId"[^>]*maxlength="128"[^>]*aria-describedby="adminUserLookupHelp adminUserLookupStatus"/);
  assert.match(html, /id="adminUserLookupStatus"[^>]*role="status"/);
});
