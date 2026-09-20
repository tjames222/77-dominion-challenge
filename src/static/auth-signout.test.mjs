import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createClient } from '@supabase/supabase-js';

const MESSAGE = 'Sign out could not be confirmed. Retry signing out before leaving this device.';
const source = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('export async function clearAuthSession('), source.indexOf('export function saveLocalMockUser'))
  .replace('export async function', 'async function');
const redirect = source.slice(source.indexOf('export function redirectToLogin('), source.indexOf('export function sanitizeReturnTo('))
  .replace('export function', 'function');
function authFunctions(client, storage, window = { location: {} }, cancelled = []) {
  window.addEventListener ||= () => {};
  return new Function('usesSupabaseAuthentication', 'supabase', 'isHybridAuthPreview', 'localStorage', 'MOCK_USER_ID_KEY', 'window', 'cancelAdminReads', 'inflightActorReads',
    `let logoutNavigationPending = false; let previewBadgeEpoch = 0;${body};${redirect};return { clear: clearAuthSession, redirect: redirectToLogin };`)(
    () => true, client, () => false, storage, 'dominion:mockUserId', window,
    () => cancelled.push('admin'), { invalidate() {} },
  );
}

test('actual SDK provider outage preserves the session, rejects safely, and permits a confirmed retry', async () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const access = [encode({ alg: 'HS256', typ: 'JWT' }), encode({ sub: id, session_id: '11111111-1111-4111-8111-111111111111', aal: 'aal1', exp: Math.floor(Date.now() / 1000) + 3600 }), encode('synthetic')].join('.');
  const values = new Map([
    ['signout-review-auth', JSON.stringify({ access_token: access, refresh_token: 'synthetic-refresh-only', expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: 'bearer', user: { id } })],
    ['dominion:user', 'synthetic identity'], ['dominion:mockUserId', id], ['dominion:theme', 'dark'],
  ]);
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  let outage = true;
  let calls = 0;
  const client = createClient('https://synthetic.invalid', 'synthetic-public-key', {
    global: { fetch: async input => {
      assert.equal(new URL(input).pathname, '/auth/v1/logout');
      calls += 1;
      return outage
        ? Response.json({ code: 'unexpected_failure', message: 'SYNTHETIC_PRIVATE_RESPONSE' }, { status: 503 })
        : new Response(null, { status: 204 });
    } },
    auth: { storageKey: 'signout-review-auth', storage, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false },
  });
  try {
    assert.ok((await client.auth.getSession()).data.session);
    const cancelled = [];
    const { clear } = authFunctions(client, storage, undefined, cancelled);
    await assert.rejects(clear(), { message: MESSAGE });
    assert.deepEqual(cancelled, ['admin']);
    assert.ok((await client.auth.getSession()).data.session, 'No false claim that the provider revoked the session');
    assert.equal(values.get('dominion:user'), 'synthetic identity');
    outage = false;
    await clear();
    assert.deepEqual(cancelled, ['admin', 'admin']);
    assert.equal((await client.auth.getSession()).data.session, null);
    assert.equal(values.has('dominion:user'), false);
    assert.equal(values.has('dominion:theme'), false);
    assert.equal(calls, 2);
  } finally { await client.auth.stopAutoRefresh(); }
});

test('thrown provider failures are replaced with fixed copy and no cause or raw payload', async () => {
  const values = new Map([['dominion:user', 'keep until confirmed']]);
  const storage = { removeItem: key => values.delete(key) };
  const { clear } = authFunctions({ auth: { signOut: async () => { throw new Error('SYNTHETIC_PRIVATE_TOKEN_PAYLOAD'); } } }, storage);
  await assert.rejects(clear(), error => {
    assert.equal(error.message, MESSAGE);
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(String(error), /SYNTHETIC_PRIVATE/);
    return true;
  });
  assert.equal(values.get('dominion:user'), 'keep until confirmed');
});

test('explicit logout owns navigation through synchronous observers and delayed completion', async () => {
  const destinations = [];
  let pagehide;
  const window = {
    location: { set href(value) { destinations.push(value); } },
    addEventListener(event, listener, options) {
      assert.equal(event, 'pagehide');
      assert.deepEqual(options, { once: true });
      pagehide = listener;
    },
  };
  const values = new Map([['dominion:user', 'synthetic identity']]);
  let complete;
  const confirmation = new Promise(resolve => { complete = resolve; });
  const client = { auth: { signOut: async () => {
    functions.redirect('./private-journal.html');
    await confirmation;
    return { error: null };
  } } };
  const functions = authFunctions(client, { removeItem: key => values.delete(key) }, window);
  const pending = functions.clear({ redirectToLanding: true });
  assert.deepEqual(destinations, []);
  assert.equal(values.has('dominion:user'), true, 'local identity is not claimed cleared before provider confirmation');
  complete();
  await pending;
  functions.redirect('./private-journal.html');
  assert.deepEqual(destinations, ['./index.html'], 'late guards cannot override the confirmed destination');
  assert.equal(values.has('dominion:user'), false);
  pagehide();
  functions.redirect('./private-journal.html');
  assert.equal(destinations.at(-1), './login.html?returnTo=.%2Fprivate-journal.html', 'BFCache restoration does not retain the old navigation reservation');
});

test('logout failure releases the navigation reservation and a retry can own it again', async () => {
  const destinations = [];
  const window = { location: { set href(value) { destinations.push(value); } } };
  let outage = true;
  const functions = authFunctions({ auth: { signOut: async () => ({ error: outage ? new Error('PRIVATE') : null }) } }, { removeItem() {} }, window);
  await assert.rejects(functions.clear({ redirectToLanding: true }), { message: MESSAGE });
  assert.deepEqual(destinations, []);
  functions.redirect('./private-journal.html');
  assert.deepEqual(destinations, ['./login.html?returnTo=.%2Fprivate-journal.html']);
  outage = false;
  await functions.clear({ redirectToLanding: true });
  assert.equal(destinations.at(-1), './index.html');
});

test('plain signout retains private-route Login guards and does not select a menu destination', async () => {
  const destinations = [];
  const window = { location: { set href(value) { destinations.push(value); } } };
  const functions = authFunctions({ auth: { signOut: async () => {
    functions.redirect('./private-journal.html');
    return { error: null };
  } } }, { removeItem() {} }, window);
  await functions.clear();
  assert.deepEqual(destinations, ['./login.html?returnTo=.%2Fprivate-journal.html']);
});
