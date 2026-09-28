import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { adminReadError } from './admin-read-client.mjs';
import * as previewModule from './admin-preview.mjs';

const source = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
const factory = source.slice(source.indexOf('let adminReadClient = null;'), source.indexOf("if (typeof window !== 'undefined') {", source.indexOf('let adminReadClient = null;')))
  .replaceAll('export ', '').replace("import('./admin-preview.mjs')", 'loadPreview()');
const actorId = '10000000-0000-4000-8000-000000000001';
function fixture({ mocks = true, auth = false, deferred = false } = {}) {
  let loads = 0; let creates = 0; let liveCreates = 0; let release;
  const held = deferred ? new Promise(resolve => { release = resolve; }) : Promise.resolve();
  const api = new Function('ENABLE_MOCKS', 'usesSupabaseAuthentication', 'loadPreview', 'getLocalOrSessionUser', 'adminReadError',
    'createAdminReadClient', 'getAuthSession', 'authSessionIdentity', 'subscribeToAuthStateChanges', `${factory}
      return { owner: getAdminSessionOwner, context: getSiteAdminContext, cancel: cancelAdminReads, subscribe: subscribeToAdminInvalidation };`)(
    mocks, () => auth, async () => { loads++; await held; return { createAdminPreview: options => { creates++; return previewModule.createAdminPreview(options); } }; },
    async () => ({ authenticated: true, userId: actorId }), adminReadError,
    () => { liveCreates++; return { subscribe() {}, owner: async () => ({ actorId }), read: async () => ({ actorId }) }; },
    async () => null, () => '', () => () => {},
  );
  return { api, release, counts: () => ({ loads, creates, liveCreates }) };
}
test('synthetic admin data is lazy and concurrent requests share exactly one preview client', async () => {
  const f = fixture(); assert.deepEqual(f.counts(), { loads: 0, creates: 0, liveCreates: 0 });
  const [first, second] = await Promise.all([f.api.owner(), f.api.owner()]);
  assert.equal(first.actorId, actorId); assert.deepEqual(first, second);
  assert.deepEqual(f.counts(), { loads: 1, creates: 1, liveCreates: 0 });
});
test('invalidation during preview import cannot publish a late client or owner; retry is explicit', async () => {
  const f = fixture({ deferred: true }); let notices = 0; f.api.subscribe(() => notices++);
  const pending = f.api.owner(); f.api.cancel(); f.release();
  await assert.rejects(pending, { code: 'ADMIN_CHANGED' });
  assert.equal(notices, 1); assert.equal(f.counts().creates, 0);
  assert.equal((await f.api.owner()).actorId, actorId);
  assert.deepEqual(f.counts(), { loads: 2, creates: 1, liveCreates: 0 });
});
test('real Auth never imports synthetic administration, including hybrid mocks', async () => {
  for (const mocks of [false, true]) {
    const f = fixture({ mocks, auth: true }); assert.equal((await f.api.owner()).actorId, actorId);
    assert.deepEqual(f.counts(), { loads: 0, creates: 0, liveCreates: 1 });
  }
  const disabled = fixture({ mocks: false }); await assert.rejects(disabled.api.owner(), { code: 'ADMIN_SIGNED_OUT' });
  assert.equal(disabled.counts().loads, 0);
});
test('API has no eager preview import and lifecycle invalidation fences lazy loading', () => {
  assert.doesNotMatch(source, /^import .*from '\.\/admin-preview\.mjs'/m);
  assert.match(factory, /const captured = adminClientEpoch;[\s\S]*?if \(captured !== adminClientEpoch\) throw adminReadError\('ADMIN_CHANGED'\)/);
});
