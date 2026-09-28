// Loaded only when the invitation client is requested. Never asks the SDK to
// choose a bearer: every operation carries its original native owner token.
function createTransport(names, { baseUrl, apiKey, error, fetcher = globalThis.fetch }) {
  return async (name, args, { token, signal }) => {
    if (!names.includes(name)) throw error();
    const response = await fetcher(`${baseUrl}/rest/v1/rpc/${name}`, {
      method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', signal,
      headers: { apikey: apiKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args),
    });
    const reader = response.body?.getReader(); if (!reader) throw error();
    const decoder = new TextDecoder(); let raw = ''; let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > 262144 || signal.aborted) { await reader.cancel(); throw error(); }
        raw += decoder.decode(value, { stream: true });
      }
      raw += decoder.decode();
    } finally { reader.releaseLock(); }
    let value; try { value = JSON.parse(raw); } catch { throw error(); }
    // Only the client translates fixed provider codes/messages to safe UI.
    if (!response.ok) throw { code: value?.code, message: value?.message };
    return value;
  };
}
export const createInvitationRpcTransport = options => createTransport(['get_member_access_context', 'accept_early_access_invitation'], options);
export const createFeedbackRpcTransport = options => createTransport(['get_member_access_context', 'submit_early_access_feedback'], options);
