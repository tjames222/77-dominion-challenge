// Tiny eager lifecycle bridge. The reset-only mutation controller loads lazily,
// but its one current PASSWORD_RECOVERY event must never be missed. No Auth
// method is called in this observer and captured credentials are never exported.
export function createPasswordRecoveryOwnerBridge({ auth, sessionIdentity, authStorageKey, eventTarget = globalThis.window }) {
  const listeners = new Set(); let recovery = null; let disposed = false;
  const own = (value, key) => {
    const descriptor = value && Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  };
  function copy(session) {
    const id = own(own(session, 'user'), 'id'); const token = own(session, 'access_token');
    if (typeof id !== 'string' || typeof token !== 'string' || !token || token.length > 16384) return null;
    const value = Object.freeze({ user: Object.freeze({ id }), access_token: token });
    return sessionIdentity(value) ? value : null;
  }
  function emit(event, session) {
    for (const listener of listeners) { try { listener(event, session); } catch { /* Notify every owner. */ } }
  }
  function clear() { recovery = null; emit('SIGNED_OUT', null); }
  const subscription = auth.onAuthStateChange((event, session) => {
    if (disposed) return;
    let next; try { next = copy(session); } catch { next = null; }
    if (event === 'PASSWORD_RECOVERY') recovery = next;
    else if (recovery && (['SIGNED_OUT', 'TOKEN_REFRESHED', 'USER_UPDATED', 'MFA_CHALLENGE_VERIFIED'].includes(event)
      || !next || next.access_token !== recovery.access_token || next.user.id !== recovery.user.id
      || sessionIdentity(next) !== sessionIdentity(recovery))) recovery = null;
    emit(event, next);
  });
  const storage = event => { if (!event.key || (authStorageKey && event.key.startsWith(authStorageKey))) clear(); };
  function destroy() {
    if (disposed) return;
    disposed = true; clear(); listeners.clear();
    eventTarget?.removeEventListener?.('pagehide', destroy);
    eventTarget?.removeEventListener?.('storage', storage);
    subscription?.data?.subscription?.unsubscribe?.();
  }
  eventTarget?.addEventListener?.('pagehide', destroy);
  eventTarget?.addEventListener?.('storage', storage);
  return Object.freeze({
    connect(listener) {
      if (disposed || typeof listener !== 'function') throw new Error('Recovery session is unavailable.');
      listeners.add(listener);
      if (recovery) listener('PASSWORD_RECOVERY', recovery);
      return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } };
    },
    destroy,
  });
}
