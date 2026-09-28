import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as invitationModule from './early-access-invitation-client.mjs';
import * as transportModule from './member-authority-transport.mjs';
import { createInvitationAcceptanceIntent } from './early-access-invitation-contract.mjs';

const source = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
const factory = source.slice(source.indexOf('let invitationAcceptanceClient = null;'), source.indexOf('let adminReadClient = null;'))
  .replaceAll('export ', '').replace("import('./early-access-invitation-client.mjs')", 'loadClient()')
  .replace("import('./member-authority-transport.mjs')", 'loadTransport()');
const transportSource = readFileSync(new URL('./member-authority-transport.mjs', import.meta.url), 'utf8');
const actorId = '10000000-0000-4000-8000-000000000001';
const sessionId = '20000000-0000-4000-8000-000000000002';
const generationId = '30000000-0000-4000-8000-000000000003';
const context = { schemaVersion: 1, actorId, asOf: '2026-09-27T23:00:00Z', appAccess: false,
  legacyMembershipActive: false, paidSubscriptionActive: false, earlyAccessActive: false,
  earlyAccessProgram: null, earlyAccessEndsAt: null, betaPriceEligible: false };
const receipt = { ok: true, status: 'accepted', actorId, program: 'early_access_v1' };
function fixture({ realAuth = true, fetcher, userError = false } = {}) {
  let loads = 0; let observer; const calls = []; const nativeBearers = [];
  const api = new Function('usesSupabaseAuthentication', 'supabase', 'getAuthSession', 'authSessionIdentity',
    'subscribeToAuthStateChanges', 'fetch', 'SUPABASE_URL', 'SUPABASE_KEY', 'loadClient', 'loadTransport', `${factory}
      return { load: loadInvitationAcceptanceClient, cancel: cancelInvitationAcceptanceRequests, subscribe: subscribeToInvitationInvalidation };`)(
    () => realAuth,
    { auth: { getUser: async token => { nativeBearers.push(token); return userError ? { error: { message: 'PRIVATE_AUTH_RESPONSE' } } : { data: { user: { id: actorId } }, error: null }; } } },
    async () => ({ user: { id: actorId }, identity: `${actorId}:${sessionId}`, access_token: 'captured-native-bearer' }),
    session => session?.identity || '', callback => { observer = callback; return () => {}; },
    async (url, options) => { calls.push({ url, options }); return fetcher ? fetcher(url, options)
      : Response.json(url.endsWith('/get_member_access_context') ? context : receipt); },
    'https://synthetic.invalid', 'synthetic-public-key', async () => { loads++; return invitationModule; }, async () => transportModule,
  );
  return { api, calls, nativeBearers, loads: () => loads,
    notify: event => observer({ event, sessionIdentity: `${actorId}:${sessionId}` }) };
}
test('invitation factory stays disabled without native Auth and coalesces its lazy real-Auth client', async () => {
  const preview = fixture({ realAuth: false }); assert.equal(await preview.api.load(), null); assert.equal(preview.loads(), 0);
  const live = fixture(); const [first, second] = await Promise.all([live.api.load(), live.api.load()]);
  assert.equal(first, second); assert.equal(live.loads(), 1); assert.equal(live.calls.length, 0);
});
test('invitation factory uses pinned native user verification and original bearer for both allowed RPCs', async () => {
  const f = fixture(); const client = await f.api.load(); const { owner } = await client.review();
  const intent = createInvitationAcceptanceIntent({ generationId, token: 'A'.repeat(43) });
  assert.deepEqual(await client.accept(owner, intent), receipt);
  assert.deepEqual(f.nativeBearers, ['captured-native-bearer', 'captured-native-bearer']);
  assert.deepEqual(f.calls.map(call => new URL(call.url).pathname), ['/rest/v1/rpc/get_member_access_context', '/rest/v1/rpc/get_member_access_context', '/rest/v1/rpc/accept_early_access_invitation']);
  for (const { options } of f.calls) {
    assert.equal(options.method, 'POST'); assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer captured-native-bearer'); assert.equal(options.headers.apikey, 'synthetic-public-key');
    assert.equal(JSON.parse(options.body).target_expected_actor_id, actorId);
  }
  assert.deepEqual(JSON.parse(f.calls.at(-1).options.body), { target_expected_actor_id: actorId, target_generation_id: generationId,
    target_token: intent.token, target_operation_id: intent.operationId, target_correlation_id: intent.correlationId });
});
test('invitation factory enforces streamed byte limit and cancels oversized responses', async () => {
  let cancelled = false;
  const f = fixture({ fetcher: () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(262145).fill(65)); }, cancel() { cancelled = true; },
  })) });
  const client = await f.api.load();
  await assert.rejects(client.review(), { code: 'INVITATION_UNAVAILABLE' }); assert.equal(cancelled, true);
});
test('invitation factory does not expose native Auth errors or raw HTTP response messages', async () => {
  for (const options of [{ userError: true }, { fetcher: () => Response.json({ code: 'PRIVATE_CODE', message: 'PRIVATE_HTTP_RESPONSE' }, { status: 503 }) }]) {
    const f = fixture(options); const client = await f.api.load();
    await assert.rejects(client.review(), error => { assert.doesNotMatch(error.message, /PRIVATE/); return true; });
  }
});
test('invitation factory invalidation synchronously clears reviewed owners and notifies page listeners', async () => {
  const f = fixture(); let notices = 0; const unsubscribe = f.api.subscribe(() => notices++);
  f.api.cancel(); assert.equal(notices, 1);
  const client = await f.api.load(); const first = await client.review(); f.api.cancel();
  assert.equal(client.isCurrent(first.owner), false); assert.equal(notices, 2);
  const second = await client.review(); f.notify('TOKEN_REFRESHED');
  assert.equal(client.isCurrent(second.owner), false); assert.equal(notices, 3); unsubscribe();
});
test('invitation API wiring remains lazy and synchronously covers pagehide, storage and explicit logout', () => {
  assert.match(factory, /if \(!usesSupabaseAuthentication\(\)\) return null/);
  assert.match(transportSource, /createTransport\(\['get_member_access_context', 'accept_early_access_invitation'\], options\)/);
  assert.match(factory, /createInvitationRpcTransport\(\{ baseUrl: SUPABASE_URL, apiKey: SUPABASE_KEY, error: invitationClientError, fetcher: fetch \}\)/);
  assert.doesNotMatch(factory, /createClient\(|\.rpc\(|console\.|localStorage|sessionStorage/);
  assert.doesNotMatch(transportSource, /createClient\(|\.rpc\(|console\.|localStorage|sessionStorage/);
  assert.match(source, /window\.addEventListener\('pagehide', \(\) => \{[^\n]*cancelInvitationAcceptanceRequests\(\)/);
  assert.match(source, /window\.addEventListener\('storage',[\s\S]*?supabaseAuthStorageKey[\s\S]*?cancelInvitationAcceptanceRequests\(\)/);
  assert.match(source, /export async function clearAuthSession\([\s\S]*?cancelInvitationAcceptanceRequests\(\)[\s\S]*?supabase\.auth\.signOut\(\)/);
});
test('shared transport keeps invitation and feedback RPC allowlists separate', async () => {
  const calls = []; const options = { baseUrl: 'https://synthetic.invalid', apiKey: 'synthetic-key', error: () => new Error('denied'),
    fetcher: async (url, request) => { calls.push({ url, request }); return Response.json({ ok: true }); } };
  const invitation = transportModule.createInvitationRpcTransport(options); const feedback = transportModule.createFeedbackRpcTransport(options);
  const scope = { token: 'original-native-token', signal: new AbortController().signal };
  await assert.rejects(invitation('submit_early_access_feedback', {}, scope), /denied/);
  await assert.rejects(feedback('accept_early_access_invitation', {}, scope), /denied/);
  assert.equal(calls.length, 0);
  await feedback('submit_early_access_feedback', {}, scope);
  assert.equal(calls[0].request.headers.Authorization, 'Bearer original-native-token');
  assert.equal(calls[0].request.credentials, 'omit'); assert.equal(calls[0].request.redirect, 'error');
});
