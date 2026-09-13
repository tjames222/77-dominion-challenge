import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { assertEarlyAccessActor, normalizeEarlyAccessRequest, postEarlyAccessRequest } from './early-access-request.mjs';

test('early-access input is normalized without accepting writable status or identity', () => {
  assert.deepEqual(normalizeEarlyAccessRequest({ name: '  Sam  ', email: ' SAM@EXAMPLE.COM ', status: 'approved', userId: 'fake' }), {
    name: 'Sam', email: 'sam@example.com', website: '',
  });
});
test('early-access input rejects empty, oversized, malformed, and control-character values', () => {
  for (const name of ['', ' ', 'a'.repeat(121), 'Sam\nOther', null, {}]) {
    assert.throws(() => normalizeEarlyAccessRequest({ name, email: 'a@example.com' }));
  }
  for (const email of ['', 'a@', 'a@b', 'a b@example.com', 'a@b@example.com', `a${'x'.repeat(250)}@x.com`, 'a\u0000@b.com']) {
    assert.throws(() => normalizeEarlyAccessRequest({ name: 'Sam', email }));
  }
});
test('early-access actor guard isolates anonymous, sign-in, sign-out and account changes', () => {
  assert.doesNotThrow(() => assertEarlyAccessActor(null, ''));
  assert.doesNotThrow(() => assertEarlyAccessActor({ authenticated: true, userId: 'a' }, 'a'));
  for (const [user, expected] of [[null, 'a'], [{ authenticated: true, userId: 'a' }, ''], [{ authenticated: true, userId: 'b' }, 'a']]) {
    assert.throws(() => assertEarlyAccessActor(user, expected), /account changed/);
  }
});
test('early-access intake never submits PII through a no-JavaScript GET form', () => {
  const html = readFileSync(new URL('../../membership.html', import.meta.url), 'utf8');
  assert.match(html, /<form[^>]*id="earlyAccessForm"[^>]*hidden/);
  assert.match(html, /<noscript>[\s\S]*enable JavaScript/);
  assert.match(html, /name="email"[^>]*maxlength="254"/);
});

test('early-access transport posts a minimal body with optional verified-session authorization and no redirects', async () => {
  for (const accessToken of ['', 'test-user-session']) {
    const request = normalizeEarlyAccessRequest({ name: 'Sam', email: 'sam@example.com' });
    let calls = 0;
    assert.deepEqual(await postEarlyAccessRequest(request, {
      endpoint: 'https://project.example/request', publicKey: 'public-test-key', accessToken,
      fetchImpl: async (url, options) => {
        calls++;
        assert.equal(url, 'https://project.example/request');
        assert.equal(options.redirect, 'error');
        assert.equal(options.method, 'POST');
        assert.equal(options.cache, 'no-store');
        assert.equal(options.headers.apikey, 'public-test-key');
        assert.equal(options.headers.Authorization, accessToken ? `Bearer ${accessToken}` : undefined);
        assert.deepEqual(JSON.parse(options.body), request);
        assert.ok(options.signal instanceof AbortSignal);
        return new Response('{"received":true,"ignored":"not returned"}', { status: 200 });
      },
    }), { received: true });
    assert.equal(calls, 1);
  }
});

test('early-access transport keeps failures useful and never echoes server data or retries automatically', async () => {
  for (const [status, message] of [[429, /in an hour/], [401, /sign in again/], [403, /verified account/], [500, /details are still here/], [200, /details are still here/]]) {
    let calls = 0;
    await assert.rejects(postEarlyAccessRequest({}, {
      fetchImpl: async () => { calls++; return new Response('{"error":"PRIVATE_SERVER_DATA"}', { status }); },
    }), message);
    assert.equal(calls, 1);
  }
  await assert.rejects(postEarlyAccessRequest({}, { fetchImpl: async () => { throw new Error('PRIVATE_NETWORK_DATA'); } }), /Submitting again won’t create a duplicate/);
});
