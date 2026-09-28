import { pathToFileURL } from 'node:url';

// This source is pinned to one explicit September 27 approval. Do not reuse or
// rotate the key for another send without a new approval and reviewed source.
// Resend retains idempotency keys for 24h; every allowed invocation (including
// its complete deadline) fits in this stricter fixed 23h execution window.
export const APPROVED_TEST_EMAIL_IDEMPOTENCY_KEY =
  'dominion-approved-test/2026-09-27/7edc8e1d-7a11-4f21-9e37-996543824b09';
export const APPROVED_TEST_EMAIL_WINDOW = Object.freeze({
  notBefore: '2026-09-27T23:55:00.000Z',
  notAfter: '2026-09-28T22:55:00.000Z',
});
export const APPROVED_TEST_EMAIL = Object.freeze({
  from: 'Dominion <noreply@mail.77dominion.com>',
  to: 'tjames@cablueprinting.com',
  subject: '[TEST] Dominion email delivery check',
  text: [
    'This is the one-time Dominion email test you approved on September 27, 2026.',
    'This message tests sending from noreply@mail.77dominion.com. It is not an invitation or a password reset. No account, Early Access grant, subscription, or billing changes were made by this test.',
    'No action is required.',
  ].join('\n\n'),
  html: '<!doctype html><html lang="en"><body><h1>Dominion email test</h1>'
    + '<p>This is the one-time Dominion email test you approved on September 27, 2026.</p>'
    + '<p>This message tests sending from noreply@mail.77dominion.com. It is not an invitation or a password reset. No account, Early Access grant, subscription, or billing changes were made by this test.</p>'
    + '<p>No action is required.</p></body></html>',
});
const ENDPOINT = 'https://api.resend.com/emails';
const BODY = JSON.stringify(APPROVED_TEST_EMAIL);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const failure = () => new Error('Approved test email was not confirmed accepted. Do not automatically retry; inspect the provider before another attempt.');

/** At most one provider POST. No delivery GET, account operation, or retry. */
export async function sendApprovedProductionTestEmail({
  apiKey, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 10000,
} = {}) {
  if (typeof apiKey !== 'string' || !/^re_[A-Za-z0-9_-]{1,250}$/.test(apiKey)
    || typeof fetchImpl !== 'function' || typeof now !== 'function'
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw failure();
  const allowedNow = () => {
    let value; try { value = now(); } catch { throw failure(); }
    if (!Number.isSafeInteger(value) || value < Date.parse(APPROVED_TEST_EMAIL_WINDOW.notBefore)
      || value + timeoutMs >= Date.parse(APPROVED_TEST_EMAIL_WINDOW.notAfter)) throw failure();
  };
  allowedNow();
  const controller = new AbortController(); let reader; let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(); void reader?.cancel().catch(() => {}); reject(failure());
    }, timeoutMs);
  });
  const work = async () => {
    // Pin both clock and body immediately before the sole network mutation.
    allowedNow();
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST', headers: {
        Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json',
        Accept: 'application/json', 'Idempotency-Key': APPROVED_TEST_EMAIL_IDEMPOTENCY_KEY,
      },
      body: BODY, redirect: 'error', cache: 'no-store', credentials: 'omit', signal: controller.signal,
    });
    if (controller.signal.aborted || ![200, 201].includes(response?.status) || response.redirected || !response.body) {
      void response?.body?.cancel().catch(() => {}); throw failure();
    }
    const length = response.headers.get('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > 16384)) {
      void response.body.cancel().catch(() => {}); throw failure();
    }
    reader = response.body.getReader(); const chunks = []; let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (controller.signal.aborted) throw failure();
        if (done) break;
        bytes += value.byteLength; if (bytes > 16384) throw failure(); chunks.push(value);
      }
    } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Object.keys(payload).length !== 1 || typeof payload.id !== 'string' || !UUID.test(payload.id)) throw failure();
    // Provider acceptance is not inbox delivery. A sending-only key is not
    // escalated to full access merely to query delivery status.
    return Object.freeze({ accepted: true, messageId: payload.id });
  };
  try { return await Promise.race([work(), timeout]); }
  catch { throw failure(); }
  finally { clearTimeout(timer); controller.abort(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await sendApprovedProductionTestEmail({ apiKey: process.env.RESEND_API_KEY });
    // Only the acceptance flag and validated UUID are emitted. Never the body,
    // recipient, key, provider errors, tracking URLs, or request headers.
    console.log(JSON.stringify(result));
  } catch {
    console.error('Approved test email was not confirmed accepted. Do not automatically retry; inspect the provider before another attempt.');
    process.exitCode = 1;
  }
}
