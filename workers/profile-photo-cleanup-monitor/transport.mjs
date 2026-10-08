import { HEALTH_URL } from './constants.mjs';
import { parseHealth, renderNotification } from './core.mjs';

const MAX_BYTES = 8192;
const HEALTH_TIMEOUT_MS = 8000;
const MAIL_TIMEOUT_MS = 8000;
const SECRET = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

// Error messages and provider bodies are deliberately never propagated/logged.
export async function readHealth(secret, previousSnapshotAt, {
  fetcher = fetch, now = Date.now, timeoutMs = HEALTH_TIMEOUT_MS,
} = {}) {
  if (typeof secret !== 'string' || !SECRET.test(secret)) return null;
  const controller = new AbortController();
  let timer, reader;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('health_timeout')); }, timeoutMs);
  });
  try {
    const response = await Promise.race([fetcher(HEALTH_URL, {
      // Workerd supports manual/follow only. Never follow a redirect carrying
      // the health credential; the exact-200 check below rejects every 3xx.
      method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-dominion-health-key': secret },
      body: '{"mode":"monitor-health"}',
    }), deadline]);
    if (response.status !== 200 || response.redirected || response.url !== HEALTH_URL ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') || '')) return null;
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d{1,5}$/.test(length) || Number(length) > MAX_BYTES)) return null;
    reader = response.body?.getReader();
    if (!reader) return null;
    const bytes = new Uint8Array(MAX_BYTES);
    let used = 0;
    while (true) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array) || used + chunk.value.byteLength > MAX_BYTES) return null;
      bytes.set(chunk.value, used); used += chunk.value.byteLength;
    }
    return parseHealth(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used))), now(), previousSnapshotAt);
  } catch { return null; }
  finally {
    clearTimeout(timer); controller.abort();
    if (reader) void reader.cancel().catch(() => {});
  }
}

const REJECTED = new Set(['E_VALIDATION_ERROR','E_FIELD_MISSING','E_TOO_MANY_RECIPIENTS',
  'E_TOO_MANY_ATTACHMENTS','E_SENDER_NOT_VERIFIED','E_RECIPIENT_NOT_ALLOWED',
  'E_RECIPIENT_SUPPRESSED','E_SENDER_DOMAIN_NOT_AVAILABLE','E_CONTENT_TOO_LARGE',
  'E_RATE_LIMIT_EXCEEDED','E_DAILY_LIMIT_EXCEEDED','E_HEADER_NOT_ALLOWED',
  'E_HEADER_USE_API_FIELD','E_HEADER_VALUE_INVALID','E_HEADER_VALUE_TOO_LONG',
  'E_HEADER_NAME_INVALID','E_HEADERS_TOO_LARGE','E_HEADERS_TOO_MANY']);

export async function sendNotification(binding, intent, { timeoutMs = MAIL_TIMEOUT_MS, testRun = null } = {}) {
  let timer;
  const mail = renderNotification(intent, testRun);
  if (typeof binding?.send !== 'function') return { status: 'rejected' };
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => binding.send(mail)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('mail_timeout')), timeoutMs); }),
    ]);
    if (typeof result?.messageId === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(result.messageId)) {
      return { status: 'accepted', messageId: result.messageId };
    }
    return { status: 'delivery_unknown' };
  } catch (error) {
    return { status: REJECTED.has(error?.code) ? 'rejected' : 'delivery_unknown' };
  } finally { clearTimeout(timer); }
}
