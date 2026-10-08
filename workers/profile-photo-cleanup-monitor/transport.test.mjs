import assert from 'node:assert/strict';
import test from 'node:test';
import { HEALTH_URL, RECIPIENT, SENDER } from './constants.mjs';
import { initialState, parseHealth, reduceObservation, scheduledSlot } from './core.mjs';
import { readHealth, sendNotification } from './transport.mjs';
import { BASE, SECRET, healthBody } from './test-fixtures.mjs';

function response(body = JSON.stringify(healthBody()), options = {}) {
  const r = new Response(body, { headers: { 'content-type': 'application/json' }, ...options });
  Object.defineProperty(r, 'url', { value: HEALTH_URL, configurable: true });
  return r;
}
function intent() {
  return reduceObservation(initialState(), { slot: scheduledSlot(BASE, BASE), now: BASE,
    health: parseHealth(healthBody(BASE, 101), BASE), alertsEnabled: true }).intent;
}
test('health request pins URL, tiny mode and credential header, with no cleanup authority or redirects', async () => {
  const got = await readHealth(SECRET, null, { now: () => BASE, fetcher: async (url, init) => {
    assert.equal(url, HEALTH_URL); assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'manual');
    assert.deepEqual(init.headers, { 'content-type': 'application/json', 'x-dominion-health-key': SECRET });
    assert.equal(init.body, '{"mode":"monitor-health"}');
    return response();
  } });
  assert.equal(got.cleanup.ready, 0);
});
for (const bad of ['', 'key', 'A'.repeat(44), 'A'.repeat(42) + 'B', null]) {
  test(`invalid health credential (${String(bad).length} characters) fails before network`, async () => {
    assert.equal(await readHealth(bad, null, { fetcher: () => { throw new Error('Should not call'); } }), null);
  });
}
for (const [label, make] of Object.entries({
  status: () => response('sensitive-provider-error', { status: 403 }),
  redirected: () => { const r = response(); Object.defineProperty(r, 'redirected', { value: true }); return r; },
  wrong_url: () => { const r = response(); Object.defineProperty(r, 'url', { value: 'https://other.invalid/' }); return r; },
  wrong_mime: () => response('{}', { headers: { 'content-type': 'text/plain' } }),
  oversized_header: () => response('{}', { headers: { 'content-type': 'application/json', 'content-length': '8193' } }),
  malformed_length: () => response('{}', { headers: { 'content-type': 'application/json', 'content-length': '-1' } }),
  oversized_stream: () => response(' '.repeat(8193)),
  invalid_json: () => response('{'),
  invalid_utf8: () => response(new Uint8Array([255])),
  stale: () => response(JSON.stringify(healthBody(BASE - 120001))),
})) {
  test(`bounded health transport rejects ${label} without returning provider data`, async () => {
    assert.equal(await readHealth(SECRET, null, { now: () => BASE, fetcher: async () => make() }), null);
  });
}
test('header wait and stalled response body have bounded deadline; cancellation never blocks', async () => {
  let aborted = false;
  assert.equal(await readHealth(SECRET, null, { timeoutMs: 5, fetcher: async (_, init) => {
    init.signal.addEventListener('abort', () => { aborted = true; });
    return new Promise(() => {});
  } }), null);
  assert.equal(aborted, true);
  let canceled = false;
  const stream = new ReadableStream({ cancel() { canceled = true; return new Promise(() => {}); } });
  assert.equal(await readHealth(SECRET, null, { timeoutMs: 5, fetcher: async () => response(stream) }), null);
  assert.equal(canceled, true);
});
test('binding is called once with fixed metadata-only message; acceptance is not delivery', async () => {
  let calls = 0;
  const result = await sendNotification({ send: async mail => {
    calls++; assert.equal(mail.from, SENDER); assert.equal(mail.to, RECIPIENT);
    assert.deepEqual(Object.keys(mail), ['from','to','subject','text']);
    return { messageId: 'provider-message-123' };
  } }, intent());
  assert.equal(calls, 1); assert.deepEqual(result, { status: 'accepted', messageId: 'provider-message-123' });
});
test('known pre-acceptance provider rejection is fixed rejection; unknown/internal errors never get retried', async () => {
  for (const code of ['E_SENDER_NOT_VERIFIED','E_RECIPIENT_NOT_ALLOWED','E_DAILY_LIMIT_EXCEEDED']) {
    const r = await sendNotification({ send: async () => { throw Object.assign(new Error('secret'), { code }); } }, intent());
    assert.deepEqual(r, { status: 'rejected' });
  }
  for (const code of ['E_INTERNAL_SERVER_ERROR','E_DELIVERY_FAILED',undefined]) {
    let calls = 0;
    const r = await sendNotification({ send: async () => { calls++; throw Object.assign(new Error('secret'), { code }); } }, intent());
    assert.deepEqual(r, { status: 'delivery_unknown' }); assert.equal(calls, 1);
  }
});
test('mail timeout, void legacy response and malformed acceptance become unknown without second call', async () => {
  for (const result of [undefined, { messageId: 'bad/id' }, { messageId: 'x' }, new Promise(() => {})]) {
    let calls = 0;
    const outcome = await sendNotification({ send: () => { calls++; return result; } }, intent(), { timeoutMs: 5 });
    assert.deepEqual(outcome, { status: 'delivery_unknown' }); assert.equal(calls, 1);
  }
});
