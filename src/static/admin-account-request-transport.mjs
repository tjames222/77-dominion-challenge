import { adminReadError } from './admin-read-client.mjs';

// The Admin entry loads this with its view. Bound the whole new list operation,
// including any deferred API/module/Auth wait; a late load sees aborted signal
// and cannot dispatch. This does not add a deadline to existing admin flows.
export async function readAdminAccountRequests(read, args, options = {}, timeoutMs = 10000) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000 || options.signal?.aborted) throw adminReadError();
  const controller = new AbortController(); let reject;
  const stopped = new Promise((_, fail) => { reject = fail; });
  const stop = () => { controller.abort(); reject(adminReadError()); };
  const timer = setTimeout(stop, timeoutMs); options.signal?.addEventListener('abort', stop, { once: true });
  try { return await Promise.race([read(args, { ...options, signal: controller.signal }), stopped]); }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', stop); }
}

// These two account-request reads share a finite native transport; other admin
// operations keep their transport unchanged. No provider SDK replaces bearer.
export async function requestAdminAccountRequests({ baseUrl, apiKey, token, args, signal,
  fetcher = fetch, timeoutMs = 10000, name = 'site_admin_list_account_requests' }) {
  if (!['site_admin_list_account_requests', 'site_admin_get_account_request_queue_health'].includes(name)) throw adminReadError('ADMIN_INVALID_INPUT');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000 || signal?.aborted) throw adminReadError();
  const controller = new AbortController(); let reader; let reject;
  const stopped = new Promise((_, fail) => { reject = fail; });
  const stop = () => {
    controller.abort();
    try { void reader?.cancel().catch(() => {}); } catch { /* Cancellation is best effort. */ }
    reject(adminReadError());
  };
  const timer = setTimeout(stop, timeoutMs);
  signal?.addEventListener('abort', stop, { once: true });
  async function run() {
    if (controller.signal.aborted || signal?.aborted) throw adminReadError();
    const response = await fetcher(`${baseUrl}/rest/v1/rpc/${name}`, {
      method: 'POST', cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal,
      headers: { apikey: apiKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args),
    });
    if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw adminReadError(); }
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) throw adminReadError();
    reader = response.body?.getReader(); if (!reader) throw adminReadError();
    const decoder = new TextDecoder('utf-8', { fatal: true }); let bytes = 0; let raw = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (controller.signal.aborted) throw adminReadError();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 65536) { stop(); throw adminReadError(); }
        raw += decoder.decode(value, { stream: true });
      }
      raw += decoder.decode();
    } finally { reader.releaseLock(); reader = null; }
    let value; try { value = JSON.parse(raw); } catch { throw adminReadError(); }
    if (!response.ok) throw adminReadError(response.status === 401 ? 'ADMIN_SIGNED_OUT'
      : response.status === 403 ? 'ADMIN_DENIED'
        : value?.message === 'admin_invalid_cursor' ? 'ADMIN_INVALID_CURSOR'
          : value?.message === 'admin_invalid_input' ? 'ADMIN_INVALID_INPUT' : 'ADMIN_UNAVAILABLE');
    return value;
  }
  try { return await Promise.race([run(), stopped]); }
  catch (error) {
    stop();
    throw adminReadError(['ADMIN_SIGNED_OUT', 'ADMIN_DENIED', 'ADMIN_INVALID_CURSOR', 'ADMIN_INVALID_INPUT'].includes(error?.code) ? error.code : 'ADMIN_UNAVAILABLE');
  }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
}
