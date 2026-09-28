import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  APPROVED_TEST_EMAIL, APPROVED_TEST_EMAIL_IDEMPOTENCY_KEY, APPROVED_TEST_EMAIL_WINDOW,
  sendApprovedProductionTestEmail,
} from './send-approved-production-test-email.mjs';

const apiKey = 're_SYNTHETIC_PRIVATE_SMOKE_KEY';
const messageId = '10000000-0000-4000-8000-000000000001';
const stamp = Date.parse('2026-09-28T00:00:00.000Z');
const MESSAGE = 'Approved test email was not confirmed accepted. Do not automatically retry; inspect the provider before another attempt.';
const denied = value => assert.rejects(value, error => {
  assert.equal(error.message, MESSAGE); assert.equal(error.cause, undefined);
  assert.doesNotMatch(JSON.stringify(error), /PRIVATE|tjames|noreply/); return true;
});
function fixture(patch = {}) {
  const calls = [];
  const options = { apiKey, now: () => stamp, timeoutMs: 100,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return Response.json({ id: messageId }); }, ...patch };
  return { options, calls };
}
test('one approved fixed email produces exactly one pinned provider POST and only an acceptance receipt', async () => {
  const f = fixture();
  const result = await sendApprovedProductionTestEmail(f.options);
  assert.deepEqual(result, { accepted: true, messageId }); assert.equal(Object.isFrozen(result), true);
  assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0];
  assert.equal(url, 'https://api.resend.com/emails'); assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, `Bearer ${apiKey}`);
  assert.equal(init.headers['Idempotency-Key'], APPROVED_TEST_EMAIL_IDEMPOTENCY_KEY);
  assert.equal(init.body, JSON.stringify(APPROVED_TEST_EMAIL));
  assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store'); assert.equal(init.credentials, 'omit');
  assert(init.signal instanceof AbortSignal); assert.equal(init.signal.aborted, true);
  assert.doesNotMatch(JSON.stringify(result), /delivered|PRIVATE|approved|tjames|noreply/i);
});
test('recipient, sender, subject and no-link content are immutable and never selected by runtime options', async () => {
  assert.equal(APPROVED_TEST_EMAIL.from, 'Dominion <noreply@mail.77dominion.com>');
  assert.equal(APPROVED_TEST_EMAIL.to, 'tjames@cablueprinting.com');
  assert.match(APPROVED_TEST_EMAIL.subject, /^\[TEST\]/);
  assert.match(APPROVED_TEST_EMAIL.text, /No account, Early Access grant, subscription, or billing changes/);
  assert.doesNotMatch(APPROVED_TEST_EMAIL.text + APPROVED_TEST_EMAIL.html, /https?:|href=|access_token|token=|code=|<script/i);
  assert.equal(Object.isFrozen(APPROVED_TEST_EMAIL), true);
  const f = fixture({ to: 'other@example.test', from: 'spoof@example.test', body: 'other', idempotencyKey: 'other' });
  await sendApprovedProductionTestEmail(f.options);
  assert.equal(f.calls[0].init.body, JSON.stringify(APPROVED_TEST_EMAIL));
  assert.equal(f.calls[0].init.headers['Idempotency-Key'], APPROVED_TEST_EMAIL_IDEMPOTENCY_KEY);
});
test('the source-fixed key and 23-hour approval window cannot outlive provider idempotency retention', async () => {
  assert.match(APPROVED_TEST_EMAIL_IDEMPOTENCY_KEY, /^dominion-approved-test\/2026-09-27\/[0-9a-f-]{36}$/);
  assert.equal(Date.parse(APPROVED_TEST_EMAIL_WINDOW.notAfter) - Date.parse(APPROVED_TEST_EMAIL_WINDOW.notBefore), 23 * 3600000);
  for (const now of [Date.parse(APPROVED_TEST_EMAIL_WINDOW.notBefore)-1,
    Date.parse(APPROVED_TEST_EMAIL_WINDOW.notAfter)-100,
    Date.parse(APPROVED_TEST_EMAIL_WINDOW.notAfter), stamp+2*86400000, NaN, Infinity, 1.5]) {
    const f = fixture({ now: () => now }); await denied(sendApprovedProductionTestEmail(f.options)); assert.equal(f.calls.length, 0);
  }
});
test('date/key/header/fetch configuration errors are fixed and make no network request', async () => {
  for (const patch of [{ apiKey: '' }, { apiKey: `${apiKey}\r\nBcc:other` }, { apiKey: 're_'+'a'.repeat(251) },
    { timeoutMs: 0 }, { timeoutMs: 10001 }, { now: () => { throw new Error(apiKey); } }, { fetchImpl: null }]) {
    const f = fixture(patch); await denied(sendApprovedProductionTestEmail(f.options)); assert.equal(f.calls.length, 0);
  }
});
test('an expiry crossed immediately before dispatch cannot POST', async () => {
  let clock = 0; const f = fixture({ now: () => ++clock === 1 ? stamp : Date.parse(APPROVED_TEST_EMAIL_WINDOW.notAfter) });
  await denied(sendApprovedProductionTestEmail(f.options)); assert.equal(f.calls.length, 0);
});
for (const status of [202, 301, 400, 401, 403, 409, 429, 500, 503]) {
  test(`HTTP ${status} never triggers retries, upgrades, or reflected provider errors`, async () => {
    let calls = 0;
    const f = fixture({ fetchImpl: async () => { calls++; return Response.json({ message: apiKey }, { status }); } });
    await denied(sendApprovedProductionTestEmail(f.options)); assert.equal(calls, 1);
  });
}
test('both documented success status codes require one exact validated UUID receipt', async () => {
  for (const status of [200, 201]) {
    const f = fixture({ fetchImpl: async () => Response.json({ id: messageId }, { status }) });
    assert.deepEqual(await sendApprovedProductionTestEmail(f.options), { accepted: true, messageId });
  }
  for (const payload of [null, [], { id: 'not-an-id' }, { id: messageId, message: apiKey },
    { id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }, { id: 2 }]) {
    const f = fixture({ fetchImpl: async () => Response.json(payload) });
    await denied(sendApprovedProductionTestEmail(f.options));
  }
});
test('redirects, malformed UTF8/JSON, declared oversized and streamed oversized bodies fail safely', async () => {
  let cancelled = false;
  const responses = [new Response('not JSON'), new Response(Uint8Array.of(0xff)),
    new Response('{}', { headers: { 'content-length': '16385' } }),
    new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(16385)); }, cancel() { cancelled = true; } })),
    (() => { const value = Response.json({ id: messageId }); Object.defineProperty(value, 'redirected', { value: true }); return value; })()];
  for (const response of responses) {
    const f = fixture({ fetchImpl: async () => response }); await denied(sendApprovedProductionTestEmail(f.options));
  }
  assert.equal(cancelled, true);
});
test('lost response, stalled fetch and stalled body remain unknown without any second request', async () => {
  for (const fetcher of [() => Promise.reject(new Error(apiKey)), () => new Promise(() => {}),
    () => Promise.resolve(new Response(new ReadableStream({ start() {} })))]) {
    let calls = 0; let signal;
    const f = fixture({ timeoutMs: 5, fetchImpl: (url, init) => { calls++; signal = init.signal; return fetcher(); } });
    await denied(sendApprovedProductionTestEmail(f.options)); assert.equal(calls, 1); assert.equal(signal.aborted, true);
  }
});
test('late accepted response after deadline cannot return a success or cause a status GET', async () => {
  let complete; let calls = 0;
  const f = fixture({ timeoutMs: 5, fetchImpl: async () => { calls++; return new Promise(resolve => { complete = resolve; }); } });
  await denied(sendApprovedProductionTestEmail(f.options)); complete(Response.json({ id: messageId }));
  await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(calls, 1);
});
test('operator module has no SDK, database, account, workflow, filesystem write, or delivery-status operation', () => {
  const source = readFileSync(new URL('./send-approved-production-test-email.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /createClient|\.rpc\(|\.auth\.|writeFile|appendFile|spawn|execFile|method:\s*'GET'/);
  assert.match(source, /console\.log\(JSON\.stringify\(result\)\)/);
  assert.equal((source.match(/await fetchImpl\(/g)||[]).length, 1);
});
test('release integration is explicit opt-in, defaults false, and only sends in the full backend job', () => {
  const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.match(workflow, /^on:\n  workflow_dispatch:\n    inputs:/m);
  const approvalInput = workflow.match(/^      send_test_email:\n(?:(?:        [^\n]*|)\n)*/m)?.[0];
  assert(approvalInput);
  assert.match(approvalInput, /^        required: false$/m);
  assert.match(approvalInput, /^        default: false$/m);
  assert.match(approvalInput, /^        type: boolean$/m);
  const backend = workflow.match(/^  backend:\n[\s\S]*?(?=^  [a-z][a-z-]*:\n|$(?![\s\S]))/m)?.[0];
  assert(backend);
  assert.match(backend, /^    if: inputs\.release_scope == 'full'$/m);
  assert.match(backend, /^      - name: Send the single explicitly approved email-delivery test\n        if: inputs\.send_test_email == true\n        env:\n          RESEND_API_KEY: \$\{\{ secrets\.RESEND_API_KEY \}\}\n        run: node scripts\/send-approved-production-test-email\.mjs$/m);
  assert(backend.indexOf('run: node scripts/configure-production-auth-email.mjs')
    < backend.indexOf('run: node scripts/send-approved-production-test-email.mjs'));
  assert.equal((workflow.match(/run: node scripts\/send-approved-production-test-email\.mjs/g) || []).length, 1);
});
