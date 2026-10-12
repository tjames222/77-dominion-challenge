import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { adminReadError, withAdminReadDeadline } from './admin-read-client.mjs';
import { requestAdminReadUser } from './admin-read-transport.mjs';

const source = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
const factory = source.slice(source.indexOf('let adminReadClient = null;'), source.indexOf("if (typeof window !== 'undefined') {", source.indexOf('let adminReadClient = null;')))
  .replaceAll('export ', '')
  .replaceAll("import('./admin-read-transport.mjs')", 'loadReadTransport()')
  .replaceAll("import('./admin-account-request-transport.mjs')", 'loadInboxTransport()');

test('API routes explicit reads separately without changing mutation context/preflight and write transport', async () => {
  let adapters; const events = []; let heldModule; let actualNative = false; let nativeRequests = 0;
  const get = new Function('ENABLE_MOCKS', 'usesSupabaseAuthentication', 'createAdminReadClient', 'getAuthSession', 'supabase',
    'authSessionIdentity', 'subscribeToAuthStateChanges', 'adminReadError', 'withAdminReadDeadline', 'SUPABASE_URL', 'SUPABASE_KEY',
    'fetch', 'loadReadTransport', 'loadInboxTransport', `${factory}; return getAdminReadClient;`)(
    false, () => true, options => { adapters = options; return { subscribe() {} }; }, () => {},
    { auth: { getUser: async (...args) => { events.push(['getUser', args]); return { data: { user: { id: 'A' } } }; } } },
    () => '', () => {}, adminReadError, withAdminReadDeadline, 'https://provider.invalid', 'synthetic-key',
    async (url, options) => { events.push(['legacy-fetch', url, options]); return new Response('{}'); },
    async () => { if (heldModule) await heldModule; return { requestAdminRead: args => { events.push(['read', args]); return {}; },
      requestAdminReadUser: args => actualNative ? requestAdminReadUser({ ...args, fetcher: () => { nativeRequests++; throw new Error('Late native dispatch forbidden'); } })
        : (events.push(['native-user', args]), { id: 'A' }) }; },
    async () => ({ requestAdminAccountRequests: args => { events.push(['inbox', args]); return {}; } }),
  );
  await get(); const controller = new AbortController(); const options = { token: 'exact-bearer', signal: controller.signal };
  await adapters.getUser(); assert.deepEqual(events.splice(0), [['getUser', []]]);
  await adapters.getReadUser('exact-bearer', options);
  assert.deepEqual(events.splice(0), [['native-user', { baseUrl: 'https://provider.invalid', apiKey: 'synthetic-key', token: 'exact-bearer', signal: options.signal }]]);
  await adapters.readRequest('get_site_admin_context', { read: true }, options);
  assert.equal(events[0][0], 'read'); assert.equal(events[0][1].token, options.token); assert.equal(events[0][1].signal, options.signal); events.length = 0;
  await adapters.readRequest('site_admin_list_account_requests', {}, options); assert.equal(events[0][0], 'inbox'); events.length = 0;
  for (const name of ['get_site_admin_context', 'site_admin_assign_role', 'site_admin_deny_early_access_request', 'admin-early-access-invitation']) {
    await adapters.request(name, { original: name }, options);
    const [kind, url, request] = events.pop(); assert.equal(kind, 'legacy-fetch');
    assert.equal(url, `https://provider.invalid/${name === 'admin-early-access-invitation' ? 'functions/v1' : 'rest/v1/rpc'}/${name}`);
    assert.equal(request.body, JSON.stringify({ original: name })); assert.equal(request.signal, options.signal);
    assert.equal(request.headers.Authorization, 'Bearer exact-bearer');
  }
  assert.deepEqual(events, []);
  let release; heldModule = new Promise(resolve => { release = resolve; }); actualNative = true;
  const late = adapters.getReadUser('exact-bearer', options); const rejected = assert.rejects(late, { code: 'ADMIN_UNAVAILABLE' });
  controller.abort(); release(); await rejected; assert.equal(nativeRequests, 0);
});
