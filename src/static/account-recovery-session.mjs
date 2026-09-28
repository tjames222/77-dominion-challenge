const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const messages = Object.freeze({
  RECOVERY_REQUIRED: 'Open the current reset link from your email to continue.',
  RECOVERY_CHANGED: 'The account or session changed. Open a new reset link to continue.',
  RECOVERY_MFA_REQUIRED: 'Verify your existing authenticator to choose a new password.',
  RECOVERY_MFA_UNSUPPORTED: 'A verified authenticator is not available for this recovery session. Contact support for help.',
  RECOVERY_MFA_CODE: 'Enter the current six-digit code from your authenticator.',
  RECOVERY_MFA_REJECTED: 'That code was not accepted. Enter a fresh code to try again.',
  RECOVERY_MFA_UNCONFIRMED: 'Authenticator verification could not be confirmed. Open a new reset link; do not retry this session.',
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
// lifecycle evidence. A pinned native /user request authorizes outside the
// callback. SDK getUser/MFA can clear a replacement session on a stale 403;
// validation, password and logout therefore never use those mutable SDK paths.
export function createPasswordRecoveryController({
  auth, sessionIdentity, supabaseUrl, apiKey, authStorageKey,
  request = globalThis.fetch, eventTarget = globalThis.window, deadlineMs = 10000, now = Date.now,
} = {}) {
  if (!auth || typeof auth.onAuthStateChange !== 'function' || typeof auth.getSession !== 'function'
    || typeof sessionIdentity !== 'function' || typeof request !== 'function' || typeof now !== 'function'
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
  const factorUrl = `${base.origin}/auth/v1/factors`;
  const listeners = new Set(); const pending = new Set();
  let owner = null; let disposed = false; let completing = false;
  let state = Object.freeze({ phase: 'idle', owner: null, code: 'RECOVERY_REQUIRED' });
  function publish(phase, current = owner, code = '') {
    state = Object.freeze({ phase, owner: current?.handle || null, code,
      factors: Object.freeze((current?.factors || []).map(factor => Object.freeze({ ...factor }))) });
    for (const listener of listeners) { try { listener(state); } catch { /* Scrub every view. */ } }
  }
  function invalidate(code = 'RECOVERY_CHANGED') {
    if (owner) { owner.elevatedToken = ''; owner.challenge = null; }
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
  function currentTime() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw passwordRecoverySessionError();
    return Math.floor(value / 1000);
  }
  function nativeFactors(user) {
    // GoTrue omits this optional field when there are no factors. A malformed
    // present field must never be interpreted as "MFA is not enabled".
    const factors = own(user, 'factors') ?? (Object.hasOwn(user, 'factors') ? null : []);
    if (!Array.isArray(factors) || factors.length > 32) throw passwordRecoverySessionError();
    const result = []; const ids = new Set(); let hasVerified = false;
    for (const factor of factors) {
      const status = own(factor, 'status'); const type = own(factor, 'factor_type');
      const id = own(factor, 'id'); const name = own(factor, 'friendly_name');
      if (!['verified', 'unverified'].includes(status) || typeof type !== 'string' || !type
        || typeof id !== 'string' || !UUID.test(id) || ids.has(id)) throw passwordRecoverySessionError();
      ids.add(id);
      if (status !== 'verified') continue;
      hasVerified = true; // Includes phone/WebAuthn/future verified factor types.
      if (type !== 'totp') continue;
      result.push({ id, friendlyName: typeof name === 'string' && name.trim()
        ? name.trim().slice(0, 80) : `Authenticator ${result.length + 1}` });
    }
    return { factors: result, hasVerified };
  }
  function validatedLevel(token, captured) {
    // Called only after native /user has authenticated this exact bearer. Local
    // decoding binds that server-validated JWT; it never replaces verification.
    const claims = JSON.parse(globalThis.atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    const level = own(claims, 'aal'); const expiresAt = own(claims, 'exp');
    if (own(claims, 'sub') !== captured.id || `${captured.id}:${own(claims, 'session_id')}` !== captured.identity
      || !['aal1', 'aal2'].includes(level) || !Number.isSafeInteger(expiresAt) || expiresAt <= currentTime()) throw passwordRecoverySessionError();
    return level;
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
  async function verifyOwner(captured, { allowMfa = false, token = captured?.elevatedToken || captured?.token, factorId = captured?.factorId } = {}) {
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
      return await bounded(async signal => {
        await exactSession();
        if (captured.elevatedToken && captured.elevatedExpiresAt <= currentTime()) throw passwordRecoverySessionError();
        const response = await wait(() => nativeRequest(userUrl, token, signal, 'GET'));
        if (response?.ok !== true) { void response?.body?.cancel().catch(() => {}); throw passwordRecoverySessionError(); }
        const user = await wait(() => responseJson(response, signal));
        if (own(user, 'id') !== captured.id) throw passwordRecoverySessionError();
        const { factors, hasVerified } = nativeFactors(user);
        if (factorId && !factors.some(factor => factor.id === factorId)) throw passwordRecoverySessionError('RECOVERY_MFA_UNSUPPORTED');
        const level = validatedLevel(token, captured);
        const next = hasVerified ? 'aal2' : level;
        const requiresMfa = level !== 'aal2' && next === 'aal2';
        if (captured.elevatedToken && (level !== 'aal2' || next !== 'aal2')) throw passwordRecoverySessionError();
        if (requiresMfa && !allowMfa) throw passwordRecoverySessionError('RECOVERY_MFA_REQUIRED');
        if (requiresMfa && !factors.length) throw passwordRecoverySessionError('RECOVERY_MFA_UNSUPPORTED');
        await exactSession(); check();
        validatedLevel(token, captured); // Expiry can cross during the final SDK read.
        if (captured.elevatedToken && captured.elevatedExpiresAt <= currentTime()) throw passwordRecoverySessionError();
        return { requiresMfa, factors, level, next };
      }, controller);
    } finally { pending.delete(controller); }
  }
  const nativeRequest = (url, token, signal, method, body) => request(url, {
    method, headers: { apikey: apiKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      'X-Supabase-Api-Version': '2024-01-01' },
    credentials: 'omit', cache: 'no-store', redirect: 'error', signal,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  async function responseJson(response, signal) {
    if (!response?.body) {
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
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } finally { signal.removeEventListener('abort', cancel); cancel(); reader.releaseLock(); }
  }
  async function responseUser(response, signal) {
    if (!response?.ok) { void response?.body?.cancel().catch(() => {}); return null; }
    return own(await responseJson(response, signal), 'id');
  }
  function elevatedSnapshot(value, captured) {
    const session = snapshot(value); const tokenType = own(value, 'token_type');
    const expiresIn = own(value, 'expires_in');
    if (!session || session.id !== captured.id || session.identity !== captured.identity || session.token === captured.token
      || tokenType !== 'bearer' || !Number.isSafeInteger(expiresIn) || expiresIn < 1 || expiresIn > 86400) throw passwordRecoverySessionError();
    const claims = JSON.parse(globalThis.atob(session.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    const expiresAt = own(claims, 'exp'); const time = currentTime();
    if (own(claims, 'aal') !== 'aal2' || !Number.isSafeInteger(expiresAt) || expiresAt <= time || expiresAt > time + 86400) throw passwordRecoverySessionError();
    return { token: session.token, expiresAt };
  }
  async function mfaOperation(captured, work) {
    const controller = new AbortController(); pending.add(controller);
    const check = () => { current(captured); if (controller.signal.aborted) throw passwordRecoverySessionError(); };
    const wait = async action => { check(); const result = await action(); check(); return result; };
    try { return await bounded(signal => work({ signal, check, wait }), controller); }
    finally { pending.delete(controller); }
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
      current(captured);
      if (state.phase !== 'pending') throw passwordRecoverySessionError('RECOVERY_CHANGED');
      try {
        const result = await verifyOwner(captured, { allowMfa: true }); current(captured);
        captured.factors = result.factors;
        publish(result.requiresMfa ? 'mfa-required' : 'ready', captured, result.requiresMfa ? 'RECOVERY_MFA_REQUIRED' : '');
        return state;
      }
      catch (error) {
        const failure = safeFailure(error);
        if (owner === captured) invalidate(failure.code);
        throw failure;
      }
    },
    async challengeMfa(handle, factorId) {
      const captured = owner; current(captured);
      if (captured.handle !== handle || state.phase !== 'mfa-required' || typeof factorId !== 'string'
        || !captured.factors?.some(factor => factor.id === factorId)) throw passwordRecoverySessionError('RECOVERY_CHANGED');
      captured.challenge = null;
      publish('mfa-challenging');
      try {
        await mfaOperation(captured, async ({ signal, wait, check }) => {
          const result = await wait(() => verifyOwner(captured, { allowMfa: true, factorId }));
          if (!result.requiresMfa) throw passwordRecoverySessionError();
          const response = await wait(() => nativeRequest(`${factorUrl}/${factorId}/challenge`, captured.token, signal, 'POST', { factorId }));
          const value = await wait(() => responseJson(response, signal));
          const id = own(value, 'id'); const expiresAt = own(value, 'expires_at'); const time = currentTime();
          if (!response.ok || own(value, 'type') !== 'totp' || typeof id !== 'string' || !UUID.test(id)
            || !Number.isSafeInteger(expiresAt) || expiresAt <= time || expiresAt > time + 600) throw passwordRecoverySessionError();
          await wait(() => verifyOwner(captured, { allowMfa: true, factorId })); check();
          if (expiresAt <= currentTime()) throw passwordRecoverySessionError();
          captured.factorId = factorId;
          captured.challenge = { id, expiresAt };
          publish('mfa-code');
        });
        return state;
      } catch (error) {
        if (owner === captured) invalidate('RECOVERY_MFA_UNCONFIRMED');
        throw safeFailure(error, 'RECOVERY_MFA_UNCONFIRMED');
      }
    },
    async verifyMfa(handle, code) {
      if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw passwordRecoverySessionError('RECOVERY_MFA_CODE');
      const captured = owner; current(captured);
      if (captured.handle !== handle || state.phase !== 'mfa-code' || !captured.challenge) throw passwordRecoverySessionError('RECOVERY_CHANGED');
      const challenge = captured.challenge;
      captured.challenge = null; // One request consumes it even if its outcome is lost.
      publish('mfa-verifying');
      try {
        await mfaOperation(captured, async ({ signal, wait, check }) => {
          if (challenge.expiresAt <= currentTime()) throw passwordRecoverySessionError();
          await wait(() => verifyOwner(captured, { allowMfa: true }));
          if (challenge.expiresAt <= currentTime()) throw passwordRecoverySessionError();
          const response = await wait(() => nativeRequest(`${factorUrl}/${captured.factorId}/verify`, captured.token, signal, 'POST', { challenge_id: challenge.id, code }));
          const value = await wait(() => responseJson(response, signal));
          if (response.status === 422 && own(value, 'code') === 'mfa_verification_failed') {
            const result = await wait(() => verifyOwner(captured, { allowMfa: true }));
            if (!result.requiresMfa) throw passwordRecoverySessionError();
            captured.factors = result.factors;
            publish('mfa-required', captured, 'RECOVERY_MFA_REJECTED');
            return;
          }
          if (!response.ok) throw passwordRecoverySessionError();
          const elevated = elevatedSnapshot(value, captured);
          const result = await wait(() => verifyOwner(captured, { token: elevated.token, factorId: captured.factorId }));
          if (result.level !== 'aal2' || result.next !== 'aal2' || elevated.expiresAt <= currentTime()) throw passwordRecoverySessionError();
          check();
          captured.elevatedToken = elevated.token; captured.elevatedExpiresAt = elevated.expiresAt;
          publish('ready');
        });
        return state;
      } catch (error) {
        if (owner === captured) invalidate('RECOVERY_MFA_UNCONFIRMED');
        throw safeFailure(error, 'RECOVERY_MFA_UNCONFIRMED');
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
        const mutationToken = captured.elevatedToken || captured.token;
        const mutationExpiresAt = captured.elevatedToken ? captured.elevatedExpiresAt : null;
        // Once dispatched, a lost response cannot safely authorize another PUT.
        captured.consumed = true; publish('working');
        let confirmed = false; let dispatched = false;
        try {
          confirmed = await bounded(async signal => {
            if (disposed || owner !== captured) throw passwordRecoverySessionError('RECOVERY_CHANGED');
            if (mutationExpiresAt !== null && mutationExpiresAt <= currentTime()) throw passwordRecoverySessionError();
            dispatched = true;
            const response = await nativeRequest(userUrl, mutationToken, signal, 'PUT', { password });
            return await responseUser(response, signal) === captured.id;
          });
        } catch { /* Unknown outcome: retire the capability and revoke only it. */ }
        if (!dispatched) {
          if (owner === captured) invalidate();
          throw passwordRecoverySessionError('RECOVERY_CHANGED');
        }
        const sessionsRevoked = await revokeCaptured(mutationToken);
        if (owner === captured) publish(confirmed ? 'completed' : 'blocked', captured, confirmed ? '' : 'RECOVERY_UNCONFIRMED');
        if (!confirmed) throw passwordRecoverySessionError('RECOVERY_UNCONFIRMED');
        return Object.freeze({ completed: true, owner: captured.handle, sessionsRevoked });
      } catch (error) {
        const failure = safeFailure(error);
        if (owner === captured && !captured.consumed) invalidate(failure.code);
        throw failure;
      } finally { if (captured.consumed) { captured.token = ''; captured.elevatedToken = ''; } completing = false; }
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
