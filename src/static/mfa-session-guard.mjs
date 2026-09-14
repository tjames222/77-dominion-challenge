// Public Supabase fetch + SupportedStorage adapters. No SDK internals are used.
// Wire this storage without the SDK's separate userStorage option, so rejecting
// the session commit also prevents its auth notification and user persistence.
// The backing store must be synchronous browser Storage (not an async adapter).
const unavailable = () => Object.assign(new Error('Secure authenticator setup requires available browser storage and Web Locks. Try a supported browser.'), { code: 'MFA_COORDINATION_UNAVAILABLE' });
const changed = () => Object.assign(new Error('The signed-in session changed. Reload account security to continue.'), { code: 'MFA_ACTOR_CHANGED' });
const failed = () => Object.assign(new Error('Account security is temporarily unavailable. Please try again.'), { code: 'MFA_UNAVAILABLE' });
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const abortable = (promise, signal) => new Promise((resolve, reject) => {
  const abort = () => reject(changed());
  if (signal.aborted) reject(changed());
  else signal.addEventListener('abort', abort, { once: true });
  Promise.resolve(promise).then(
    (value) => { signal.removeEventListener('abort', abort); resolve(value); },
    (error) => { signal.removeEventListener('abort', abort); reject(error); },
  );
});

function sessionIdentity(value) {
  try {
    const session = typeof value === 'string' ? JSON.parse(value) : value;
    const payload = JSON.parse(globalThis.atob(session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (!uuid.test(payload.sub) || !uuid.test(payload.session_id) || session.user?.id !== payload.sub) return null;
    return `${payload.sub}:${payload.session_id}`;
  } catch { return null; }
}

export function createMfaSessionGuard({
  supabaseUrl, storageKey, storage: backing, fetch: request = globalThis.fetch,
  locks = globalThis.navigator?.locks, eventTarget = globalThis.window,
} = {}) {
  const baseUrl = new URL(supabaseUrl);
  baseUrl.pathname = `${baseUrl.pathname.replace(/\/$/, '')}/`;
  const authUrl = new URL('auth/v1/', baseUrl);
  if (!storageKey || typeof request !== 'function') throw new TypeError('Auth storage key and fetch are required.');
  const revisionKey = `${storageKey}-mfa-session-revision`;
  const lockName = `dominion:mfa-session:${storageKey}`;
  const contexts = new Set();
  const guardedTokens = new Map();
  // Match the SDK's ordinary nonpersisting-session fallback when browser
  // storage is denied. MFA never uses this fallback as a coordination boundary.
  const memory = new Map();
  let storageUnavailable = !backing;
  let locksUnavailable = false;
  let active = null;
  let queue = Promise.resolve();
  let disposed = false;
  let epoch = 0;
  let unsubscribe;
  const capable = () => Boolean(!storageUnavailable && !locksUnavailable && typeof locks?.request === 'function' && !disposed);
  const cancel = () => {
    epoch += 1;
    for (const context of contexts) context.controller.abort();
  };
  const denyStorage = () => { if (!storageUnavailable) { storageUnavailable = true; cancel(); } };
  const raw = (key) => {
    if (storageUnavailable) return memory.get(key) ?? null;
    try {
      const value = backing?.getItem(key) ?? null;
      if (value !== null && typeof value !== 'string') throw unavailable();
      if (value === null) memory.delete(key); else memory.set(key, value);
      return value;
    } catch { denyStorage(); return memory.get(key) ?? null; }
  };
  const put = (key, value, durable = false) => {
    if (storageUnavailable && durable) throw unavailable();
    if (!storageUnavailable) {
      try { backing.setItem(key, value); } catch { denyStorage(); if (durable) throw unavailable(); }
    }
    memory.set(key, value);
  };
  const remove = (key) => {
    if (!storageUnavailable) { try { backing.removeItem(key); } catch { denyStorage(); } }
    memory.delete(key);
  };
  const mutateRevision = () => { put(revisionKey, globalThis.crypto.randomUUID()); cancel(); };
  const locked = async (callback, required = false) => {
    if (!capable()) {
      if (required) throw unavailable();
      return callback();
    }
    let entered = false;
    try {
      return await locks.request(lockName, { mode: 'exclusive' }, () => { entered = true; return callback(); });
    } catch (error) {
      if (!entered) {
        locksUnavailable = true;
        cancel();
        // Preserve ordinary SDK auth behavior. Any attributable MFA commit
        // still hits assertCurrent and fails closed without coordination.
        if (!required) return callback();
      }
      if (entered && ['MFA_ACTOR_CHANGED', 'MFA_COORDINATION_UNAVAILABLE'].includes(error?.code)) throw error;
      throw unavailable();
    }
  };
  const assertCurrent = (context) => {
    if (!capable()) throw unavailable();
    if (disposed || context.epoch !== epoch || context.controller.signal.aborted
      || raw(revisionKey) !== context.revision || sessionIdentity(raw(storageKey)) !== context.identity) throw changed();
    if (!capable()) throw unavailable();
  };
  const storage = {
    getItem: (key) => locked(() => raw(key)),
    setItem: (key, value) => locked(() => {
      try {
        let guarded = false;
        if (key === storageKey) {
          let token;
          try { token = JSON.parse(value)?.access_token; } catch { /* SDK validates normal session data. */ }
          const context = guardedTokens.get(token);
          if (context) { assertCurrent(context); guarded = true; }
          const before = sessionIdentity(raw(key));
          const after = sessionIdentity(value);
          // This nonsecret revision catches A→B→A even when the final token is
          // byte-for-byte identical, including changes from another document.
          if (before !== after || !after) mutateRevision();
        }
        put(key, value, guarded);
      } catch (error) {
        if (error?.code === 'MFA_ACTOR_CHANGED') throw error;
        throw unavailable();
      }
    }),
    removeItem: (key) => locked(() => {
      try {
        // _saveSession removes PKCE state before its attributable session write.
        // The caller is unknowable here: preserve a newer verifier, but do not
        // reject an unrelated login's removal while a stale MFA write waits.
        if (key === `${storageKey}-code-verifier`) {
          for (const context of new Set(guardedTokens.values())) {
            try { assertCurrent(context); } catch (error) {
              if (error?.code === 'MFA_ACTOR_CHANGED') return;
              throw error;
            }
            if (raw(key) !== context.codeVerifier) return;
          }
        }
        if (key === storageKey) mutateRevision();
        remove(key);
      } catch (error) {
        if (error?.code === 'MFA_ACTOR_CHANGED') throw error;
        throw unavailable();
      }
    }),
  };
  const onStorage = (event) => {
    if (event.key === null || event.key === storageKey || event.key === revisionKey) {
      for (const context of contexts) {
        try { assertCurrent(context); } catch { context.controller.abort(); }
      }
    }
  };
  eventTarget?.addEventListener?.('storage', onStorage);
  eventTarget?.addEventListener?.('pagehide', cancel);

  const guardedFetch = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const isMfa = url.origin === authUrl.origin && url.pathname.startsWith(authUrl.pathname)
      && /^factors(?:\/[^/]+\/(?:challenge|verify))?$/.test(url.pathname.slice(authUrl.pathname.length))
      && String(options.method || input?.method || 'GET').toUpperCase() === 'POST';
    if (!isMfa) return request(input, options);
    const context = active;
    if (!context || !capable()) throw unavailable();
    await locked(() => assertCurrent(context), true);
    // Match the token the SDK actually chose, not merely a preceding getUser.
    const headers = new Headers(options.headers || input?.headers);
    const bearer = headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (!bearer || sessionIdentity({ access_token: bearer, user: { id: context.identity.split(':')[0] } }) !== context.identity) throw changed();
    const suppliedSignal = options.signal || input?.signal;
    const abort = () => context.controller.abort();
    suppliedSignal?.addEventListener?.('abort', abort, { once: true });
    if (suppliedSignal?.aborted) abort();
    try {
      const response = await abortable(request(input, { ...options, signal: context.controller.signal }), context.controller.signal);
      const body = await abortable(response.text(), context.controller.signal);
      await locked(() => {
        assertCurrent(context);
        if (response.ok && url.pathname.endsWith('/verify')) {
          let session;
          try { session = JSON.parse(body); } catch { throw failed(); }
          if (sessionIdentity(session) !== context.identity || typeof session.refresh_token !== 'string') throw changed();
          guardedTokens.set(session.access_token, context);
          context.tokens.add(session.access_token);
        }
      }, true);
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      if (context.controller.signal.aborted || error?.code === 'MFA_ACTOR_CHANGED') throw changed();
      if (error?.code === 'MFA_COORDINATION_UNAVAILABLE') throw error;
      throw failed();
    } finally { suppliedSignal?.removeEventListener?.('abort', abort); }
  };

  const run = (operation) => {
    const requestedEpoch = epoch;
    const execute = async () => {
      if (requestedEpoch !== epoch) throw changed();
      const context = await locked(() => {
        const identity = sessionIdentity(raw(storageKey));
        if (!identity) throw changed();
        let revision = raw(revisionKey);
        if (!capable()) throw unavailable();
        if (!revision) {
          try { revision = globalThis.crypto.randomUUID(); put(revisionKey, revision, true); } catch { throw unavailable(); }
        }
        return { identity, revision, epoch, codeVerifier: raw(`${storageKey}-code-verifier`), controller: new AbortController(), tokens: new Set() };
      }, true);
      active = context;
      contexts.add(context);
      try {
        const result = await operation();
        await locked(() => assertCurrent(context), true);
        return result;
      } finally {
        for (const token of context.tokens) if (guardedTokens.get(token) === context) guardedTokens.delete(token);
        context.tokens.clear();
        context.codeVerifier = null;
        contexts.delete(context);
        context.controller.abort();
        if (active === context) active = null;
      }
    };
    const result = queue.then(execute, execute);
    queue = result.catch(() => {});
    return result;
  };

  return Object.freeze({
    storage, fetch: guardedFetch,
    cancelPending: cancel,
    protectAuth(auth) {
      if (unsubscribe) throw new Error('The MFA session guard is already attached.');
      const subscription = auth.onAuthStateChange((event) => {
        // Identity/revision checks handle same-actor refreshes without canceling
        // them. Explicit sign-out is invalidation even if no storage event fires.
        if (event === 'SIGNED_OUT') cancel();
        else for (const context of contexts) {
          try { assertCurrent(context); } catch { context.controller.abort(); }
        }
      });
      unsubscribe = () => subscription?.data?.subscription?.unsubscribe?.();
      return Object.freeze({
        getUser: (...args) => auth.getUser(...args),
        onAuthStateChange: (...args) => auth.onAuthStateChange(...args),
        cancelPending: cancel,
        mfa: Object.freeze({
          listFactors: (...args) => auth.mfa.listFactors(...args),
          getAuthenticatorAssuranceLevel: (...args) => auth.mfa.getAuthenticatorAssuranceLevel(...args),
          enroll: (...args) => run(() => auth.mfa.enroll(...args)),
          challenge: (...args) => run(() => auth.mfa.challenge(...args)),
          verify: (...args) => run(() => auth.mfa.verify(...args)),
        }),
      });
    },
    dispose() {
      disposed = true;
      cancel();
      unsubscribe?.();
      eventTarget?.removeEventListener?.('storage', onStorage);
      eventTarget?.removeEventListener?.('pagehide', cancel);
    },
  });
}
