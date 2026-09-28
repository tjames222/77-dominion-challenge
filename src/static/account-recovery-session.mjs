const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const messages = Object.freeze({
  RECOVERY_REQUIRED: 'Open the current reset link from your email to continue.',
  RECOVERY_CHANGED: 'The account or session changed. Open a new reset link to continue.',
  RECOVERY_MFA_REQUIRED: 'This account requires authenticator verification. Password recovery cannot continue here yet. Contact support for help.',
  RECOVERY_UNAVAILABLE: 'This reset session could not be verified. Request a new reset link.',
  RECOVERY_UNCONFIRMED: 'The password change could not be confirmed. Do not retry this link. Try signing in with your new password, or request a new reset link.',
  RECOVERY_PASSWORD: 'Enter a new password between 12 and 1024 characters.',
});
export function passwordRecoverySessionError(code = 'RECOVERY_UNAVAILABLE') {
  const safe = typeof code === 'string' && Object.hasOwn(messages, code) ? code : 'RECOVERY_UNAVAILABLE';
  return Object.assign(new Error(messages[safe]), { code: safe });
}
const own = (value, key) => {
  const descriptor = value && Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
};

// One existing Auth singleton, never another SDK client. Event payloads are only
// lifecycle evidence. Native getUser(jwt) and MFA(jwt) authorize outside the
// callback. Password and logout requests never ask the SDK to select an owner.
export function createPasswordRecoveryController({
  auth, sessionIdentity, supabaseUrl, apiKey, authStorageKey,
  request = globalThis.fetch, eventTarget = globalThis.window, deadlineMs = 10000,
} = {}) {
  if (!auth || typeof auth.onAuthStateChange !== 'function' || typeof auth.getSession !== 'function'
    || typeof auth.getUser !== 'function' || typeof auth.mfa?.getAuthenticatorAssuranceLevel !== 'function'
    || typeof sessionIdentity !== 'function' || typeof request !== 'function'
    || typeof apiKey !== 'string' || !apiKey || /[\r\n]/.test(apiKey)
    || !Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 30000) {
    throw new TypeError('Password recovery requires existing Auth and bounded native requests.');
  }
  const base = new URL(supabaseUrl);
  if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))
    || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new TypeError('Password recovery requires a configured Auth origin.');
  }
  const userUrl = `${base.origin}/auth/v1/user`;
  const logoutUrl = `${base.origin}/auth/v1/logout`;
  const listeners = new Set(); const pending = new Set();
  let owner = null; let disposed = false; let completing = false;
  let state = Object.freeze({ phase: 'idle', owner: null, code: 'RECOVERY_REQUIRED' });
  function publish(phase, current = owner, code = '') {
    state = Object.freeze({ phase, owner: current?.handle || null, code });
    for (const listener of listeners) { try { listener(state); } catch { /* Scrub every view. */ } }
  }
  function invalidate(code = 'RECOVERY_CHANGED') {
    owner = null;
    for (const operation of pending) operation.abort();
    publish('blocked', null, code);
  }
  function snapshot(session) {
    const id = own(own(session, 'user'), 'id'); const token = own(session, 'access_token');
    if (typeof id !== 'string' || !UUID.test(id) || typeof token !== 'string' || token.length > 16384
      || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
    const identity = sessionIdentity({ user: { id }, access_token: token });
    if (typeof identity !== 'string' || !identity.startsWith(`${id}:`) || !UUID.test(identity.slice(id.length + 1))) return null;
    return { id, token, identity };
  }
  function current(captured) {
    if (disposed || !captured || owner !== captured || captured.consumed) throw passwordRecoverySessionError('RECOVERY_CHANGED');
  }
  const subscription = auth.onAuthStateChange((event, session) => {
    if (disposed) return;
    let next;
    try { next = snapshot(session); } catch { next = null; }
    if (event === 'PASSWORD_RECOVERY') {
      invalidate();
      if (next) {
        owner = { ...next, handle: Object.freeze({}), consumed: false };
        publish('pending');
      }
    } else if (owner && (['SIGNED_OUT', 'TOKEN_REFRESHED', 'USER_UPDATED', 'MFA_CHALLENGE_VERIFIED'].includes(event)
      || !next || next.id !== owner.id || next.identity !== owner.identity || next.token !== owner.token)) invalidate();
  });
  async function bounded(work, controller = new AbortController()) {
    let rejectAbort;
    const aborted = new Promise((resolve, reject) => { rejectAbort = reject; });
    const abort = () => rejectAbort(passwordRecoverySessionError());
    controller.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    try {
      if (controller.signal.aborted) abort();
      return await Promise.race([Promise.resolve().then(() => {
        if (controller.signal.aborted) throw passwordRecoverySessionError();
        return work(controller.signal);
      }), aborted]);
    } finally {
      clearTimeout(timer); controller.abort(); controller.signal.removeEventListener('abort', abort);
    }
  }
  async function verifyOwner(captured) {
    const controller = new AbortController(); pending.add(controller);
    const check = () => { current(captured); if (controller.signal.aborted) throw passwordRecoverySessionError(); };
    const wait = async action => { check(); const result = await action(); check(); return result; };
    async function exactSession() {
      const response = await wait(() => auth.getSession());
      const session = !own(response, 'error') && snapshot(own(own(response, 'data'), 'session'));
      if (!session || session.id !== captured.id || session.identity !== captured.identity || session.token !== captured.token) {
        throw passwordRecoverySessionError('RECOVERY_CHANGED');
      }
    }
    try {
      return await bounded(async () => {
        await exactSession();
        const response = await wait(() => auth.getUser(captured.token));
        if (own(response, 'error') || own(own(own(response, 'data'), 'user'), 'id') !== captured.id) throw passwordRecoverySessionError();
        const assurance = await wait(() => auth.mfa.getAuthenticatorAssuranceLevel(captured.token));
        const data = own(assurance, 'data');
        const level = own(data, 'currentLevel'); const next = own(data, 'nextLevel');
        if (own(assurance, 'error') || !['aal1', 'aal2'].includes(level) || !['aal1', 'aal2'].includes(next)) throw passwordRecoverySessionError();
        if (level !== 'aal2' && next === 'aal2') throw passwordRecoverySessionError('RECOVERY_MFA_REQUIRED');
        await exactSession(); check();
      }, controller);
    } finally { pending.delete(controller); }
  }
  const nativeRequest = (url, token, signal, method, body) => request(url, {
    method, headers: { apikey: apiKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    credentials: 'omit', cache: 'no-store', redirect: 'error', signal,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  async function responseUser(response, signal) {
    if (!response?.ok || !response.body) {
      void response?.body?.cancel().catch(() => {});
      return null;
    }
    const reader = response.body.getReader(); const chunks = []; let size = 0;
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      while (true) {
        if (signal.aborted) throw passwordRecoverySessionError();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 65536) throw passwordRecoverySessionError();
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return own(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), 'id');
    } finally { signal.removeEventListener('abort', cancel); cancel(); reader.releaseLock(); }
  }
  async function revokeCaptured(token) {
    for (const scope of ['global', 'local']) {
      try {
        const confirmed = await bounded(async signal => {
          const response = await nativeRequest(`${logoutUrl}?scope=${scope}`, token, signal, 'POST');
          void response?.body?.cancel().catch(() => {});
          return response?.ok === true;
        });
        if (confirmed) return scope;
      } catch { /* Fixed result only; never retry under another SDK owner. */ }
    }
    return 'unconfirmed';
  }
  function safeFailure(error, fallback = 'RECOVERY_UNAVAILABLE') {
    try { return passwordRecoverySessionError(own(error, 'code') || fallback); }
    catch { return passwordRecoverySessionError(fallback); }
  }
  const pagehide = () => api.destroy();
  const storage = event => { if (!event.key || (authStorageKey && event.key.startsWith(authStorageKey))) invalidate(); };
  eventTarget?.addEventListener?.('pagehide', pagehide);
  eventTarget?.addEventListener?.('storage', storage);
  const api = Object.freeze({
    getState: () => state,
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('A recovery listener is required.');
      listeners.add(listener); return () => listeners.delete(listener);
    },
    async verify() {
      const captured = owner;
      try { current(captured); await verifyOwner(captured); current(captured); publish('ready'); return state; }
      catch (error) {
        const failure = safeFailure(error);
        if (owner === captured) invalidate(failure.code);
        throw failure;
      }
    },
    async complete(handle, password) {
      if (typeof password !== 'string' || password.length < 12 || password.length > 1024) throw passwordRecoverySessionError('RECOVERY_PASSWORD');
      const captured = owner;
      current(captured);
      if (captured.handle !== handle || state.phase !== 'ready' || completing) throw passwordRecoverySessionError('RECOVERY_CHANGED');
      completing = true;
      try {
        await verifyOwner(captured); current(captured);
        // Once dispatched, a lost response cannot safely authorize another PUT.
        captured.consumed = true; publish('working');
        let confirmed = false; let dispatched = false;
        try {
          confirmed = await bounded(async signal => {
            if (disposed || owner !== captured) throw passwordRecoverySessionError('RECOVERY_CHANGED');
            dispatched = true;
            const response = await nativeRequest(userUrl, captured.token, signal, 'PUT', { password });
            return await responseUser(response, signal) === captured.id;
          });
        } catch { /* Unknown outcome: retire the capability and revoke only it. */ }
        if (!dispatched) throw passwordRecoverySessionError('RECOVERY_CHANGED');
        const sessionsRevoked = await revokeCaptured(captured.token);
        if (owner === captured) publish(confirmed ? 'completed' : 'blocked', captured, confirmed ? '' : 'RECOVERY_UNCONFIRMED');
        if (!confirmed) throw passwordRecoverySessionError('RECOVERY_UNCONFIRMED');
        return Object.freeze({ completed: true, owner: captured.handle, sessionsRevoked });
      } catch (error) {
        const failure = safeFailure(error);
        if (owner === captured && !captured.consumed) invalidate(failure.code);
        throw failure;
      } finally { if (captured.consumed) captured.token = ''; completing = false; }
    },
    destroy() {
      if (disposed) return;
      disposed = true; invalidate(); listeners.clear();
      eventTarget?.removeEventListener?.('pagehide', pagehide);
      eventTarget?.removeEventListener?.('storage', storage);
      subscription?.data?.subscription?.unsubscribe?.();
    },
  });
  return api;
}
