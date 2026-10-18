import { adminReadError, withAdminReadDeadline } from './admin-read-client.mjs';

const READS = new Set(['get_site_admin_context', 'site_admin_list_users', 'site_admin_get_user', 'site_admin_get_profile_name', 'site_admin_list_audit',
  'site_admin_get_audit_event', 'site_admin_list_early_access_requests', 'site_admin_get_early_access_request', 'site_admin_list_early_access_history', 'site_admin_get_cleanup_health', 'site_admin_get_activation_review_health']);
const MAX_CHARS = 262144; // Preserve the former response.text().length limit.
const MAX_BYTES = MAX_CHARS * 3; // Maximum valid UTF-8 bytes per UTF-16 code unit.

// Only allowlisted read RPCs enter here. Invitation/role/denial mutations and their
// context preflights retain their separate request path and uncertain-write rules.
async function requestJson({ baseUrl, apiKey, token, path, args, signal, fetcher = fetch, timeoutMs = 10000, identity = false, maxBytes = MAX_BYTES, maxChars = MAX_CHARS }) {
  let reader; let response;
  const cancelBody = () => {
    try { void (reader ? reader.cancel() : response?.body?.cancel())?.catch(() => {}); } catch { /* Best effort; never block failure/retry. */ }
  };
  try {
    return await withAdminReadDeadline(async ({ signal: readSignal, assertActive }) => {
      const cancel = () => cancelBody(); readSignal.addEventListener('abort', cancel, { once: true });
      try {
        assertActive();
        response = await fetcher(`${baseUrl}${path}`, {
          method: identity ? 'GET' : 'POST', cache: 'no-store', credentials: 'omit', redirect: 'error', signal: readSignal,
          headers: { apikey: apiKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(identity ? {} : { body: JSON.stringify(args) }),
        });
        if (readSignal.aborted) { cancelBody(); assertActive(); }
        if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) throw adminReadError();
        reader = response.body?.getReader(); if (!reader) throw adminReadError();
        const decoder = new TextDecoder('utf-8', { fatal: true }); let raw = ''; let bytes = 0;
        while (true) {
          const { done, value } = await reader.read(); assertActive();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > maxBytes) throw adminReadError();
          raw += decoder.decode(value, { stream: true });
          if (raw.length > maxChars) throw adminReadError();
        }
        raw += decoder.decode(); if (raw.length > maxChars) throw adminReadError();
        let value; try { value = JSON.parse(raw); } catch { throw adminReadError(); }
        if (!response.ok) throw adminReadError(identity ? [401, 403].includes(response.status) ? 'ADMIN_SIGNED_OUT' : 'ADMIN_UNAVAILABLE'
          : response.status === 401 ? 'ADMIN_SIGNED_OUT'
          : response.status === 403 ? 'ADMIN_DENIED' : response.status === 404 ? 'ADMIN_NOT_FOUND'
            : value?.message === 'admin_invalid_cursor' ? 'ADMIN_INVALID_CURSOR'
              : value?.message === 'admin_invalid_input' ? 'ADMIN_INVALID_INPUT' : 'ADMIN_UNAVAILABLE');
        return value;
      } catch (error) {
        // Cancel before releasing the reader: reader.cancel() cannot cancel its
        // stream after releaseLock(), including on an oversized response.
        cancelBody(); throw error;
      } finally {
        readSignal.removeEventListener('abort', cancel);
        // A fetch/body implementation may ignore cancellation and settle after
        // the caller's deadline. Retry release in that late continuation too.
        try { reader?.releaseLock(); } catch { /* Outer cleanup also attempts release. */ }
      }
    }, { signal }, timeoutMs);
  } catch (error) {
    cancelBody();
    throw adminReadError(['ADMIN_SIGNED_OUT', 'ADMIN_DENIED', 'ADMIN_NOT_FOUND', 'ADMIN_INVALID_CURSOR', 'ADMIN_INVALID_INPUT'].includes(error?.code) ? error.code : 'ADMIN_UNAVAILABLE');
  } finally {
    try { reader?.releaseLock(); } catch { /* A late blocked read is already cancelled. */ }
  }
}

export async function requestAdminRead(options) {
  if (!READS.has(options.name)) throw adminReadError('ADMIN_INVALID_INPUT');
  const limit = ['site_admin_get_cleanup_health', 'site_admin_get_profile_name', 'site_admin_get_activation_review_health'].includes(options.name) ? 65536 : null;
  return requestJson({ ...options, path: `/rest/v1/rpc/${options.name}`, identity: false,
    maxBytes: limit ?? MAX_BYTES, maxChars: limit ?? MAX_CHARS });
}

// Native verification has no SDK session-storage hooks. In particular, a late
// session_not_found for the old bearer cannot sign out a newer SDK account.
export async function requestAdminReadUser(options) {
  const value = await requestJson({ ...options, path: '/auth/v1/user', identity: true, maxBytes: MAX_BYTES, maxChars: MAX_CHARS });
  if (!value || typeof value.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id)) throw adminReadError();
  return { id: value.id };
}
