const READS = new Set(['get_site_admin_context', 'site_admin_list_users', 'site_admin_get_user', 'site_admin_list_audit', 'site_admin_get_audit_event',
  'site_admin_list_early_access_requests', 'site_admin_get_early_access_request', 'site_admin_list_early_access_history']);
const PERMISSIONS = new Set(['users.read', 'users.manage', 'roles.manage', 'testing.manage', 'metrics.read', 'operations.read', 'operations.manage', 'audit.read']);

export function adminReadError(code = 'ADMIN_UNAVAILABLE') {
  const messages = {
    ADMIN_UNAVAILABLE: 'Administration is temporarily unavailable. Try again.',
    ADMIN_SIGNED_OUT: 'Log in to continue.',
    ADMIN_CHANGED: 'The account or session changed. Reload to continue.',
    ADMIN_DENIED: 'Administration access could not be verified.',
    ADMIN_INVALID_INPUT: 'Check the filters and try again.',
    ADMIN_INVALID_CURSOR: 'This page has changed. Return to the first page.',
    ADMIN_NOT_FOUND: 'This record is no longer available.',
    ADMIN_STEP_UP_REQUIRED: 'Verify your authenticator again before confirming an administrative change.',
    ADMIN_IDEMPOTENCY_CONFLICT: 'This operation no longer matches the reviewed request. Reload the request before starting again.',
  };
  return Object.assign(new Error(messages[code] || messages.ADMIN_UNAVAILABLE), { code });
}

export function normalizeAdminContext(value, actorId) {
  if (!value || value.schemaVersion !== 1 || value.actorId !== actorId || !['member', 'site_admin'].includes(value.role)
    || typeof value.adminReady !== 'boolean') throw adminReadError();
  if (!value.adminReady) return { schemaVersion: 1, actorId, role: value.role, adminReady: false,
    reason: ['mfa_required', 'reauthentication_required'].includes(value.reason) ? value.reason : null, permissions: [] };
  if (value.role !== 'site_admin' || !Array.isArray(value.permissions) || value.permissions.some((permission) => !PERMISSIONS.has(permission))) throw adminReadError();
  return { schemaVersion: 1, actorId, role: 'site_admin', adminReady: true,
    permissions: [...new Set(value.permissions)], stepUpRequired: value.stepUpRequired !== false };
}

// No cache or storage: the only retained identity is a non-authoritative
// lifecycle marker. Each read obtains a verified user and fresh server decision.
export function createAdminReadClient({ getSession, getUser, sessionIdentity, subscribe, request }) {
  let epoch = 0; let observedIdentity; let disposed = false;
  const pending = new Set(); const listeners = new Set();
  const changed = (reason = '') => {
    epoch += 1;
    for (const controller of pending) controller.abort();
    pending.clear();
    for (const listener of listeners) { try { listener(typeof reason === 'string' ? reason : ''); } catch { /* One view cannot prevent another from clearing. */ } }
  };
  const unsubscribe = subscribe?.(({ event, sessionIdentity: identity }) => {
    const next = typeof identity === 'string' ? identity : '';
    // Even an unchanged session UUID can lose MFA assurance or user health.
    // Recheck after assurance/user updates. Same-session SIGNED_IN may merely
    // recover a tab's existing session; it is not a new authority decision.
    if (['SIGNED_OUT', 'TOKEN_REFRESHED', 'USER_UPDATED', 'MFA_CHALLENGE_VERIFIED'].includes(event)
      || (observedIdentity !== undefined && observedIdentity !== next)) changed();
    observedIdentity = next;
  });
  const assertEpoch = (captured) => { if (disposed || captured !== epoch) throw adminReadError('ADMIN_CHANGED'); };
  async function capture(expectedUserId = '') {
    const captured = epoch;
    const session = await getSession(); assertEpoch(captured);
    const identity = sessionIdentity(session); const actorId = session?.user?.id;
    if (!identity || !actorId || !session?.access_token) throw adminReadError('ADMIN_SIGNED_OUT');
    if (expectedUserId && actorId !== expectedUserId) throw adminReadError('ADMIN_CHANGED');
    const user = await getUser(); assertEpoch(captured);
    const current = await getSession(); assertEpoch(captured);
    if (user?.id !== actorId || sessionIdentity(current) !== identity) throw adminReadError('ADMIN_CHANGED');
    return { actorId, identity, epoch: captured, token: current.access_token };
  }
  async function assertCurrent(owner) {
    assertEpoch(owner.epoch);
    const current = await getSession(); assertEpoch(owner.epoch);
    // Even without a delivered Auth event, a replaced bearer can carry lower
    // assurance. Never send or publish a response under the prior bearer.
    if (sessionIdentity(current) !== owner.identity || current?.access_token !== owner.token) throw adminReadError('ADMIN_CHANGED');
  }
  return {
    async owner() {
      try { const owner = await capture(); return { actorId: owner.actorId, sessionIdentity: owner.identity }; }
      catch (error) { if (['ADMIN_SIGNED_OUT', 'ADMIN_CHANGED'].includes(error?.code)) changed(error.code); throw adminReadError(error?.code); }
    },
    async read(name, args = {}, { expectedUserId = '', signal } = {}) {
      if (!READS.has(name)) throw adminReadError('ADMIN_INVALID_INPUT');
      let owner;
      try { owner = await capture(expectedUserId); }
      catch (error) { if (['ADMIN_SIGNED_OUT', 'ADMIN_CHANGED'].includes(error?.code)) changed(error.code); throw adminReadError(error?.code); }
      const controller = new AbortController(); pending.add(controller);
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      try {
        if (signal?.aborted) throw adminReadError();
        const result = await request(name, { ...args, target_expected_actor_id: owner.actorId }, { token: owner.token, signal: controller.signal });
        await assertCurrent(owner);
        if (controller.signal.aborted) throw adminReadError();
        if (!result || result.schemaVersion !== 1 || result.actorId !== owner.actorId) throw adminReadError();
        return name === 'get_site_admin_context' ? normalizeAdminContext(result, owner.actorId) : result;
      } catch (error) {
        assertEpoch(owner.epoch);
        if (['ADMIN_DENIED', 'ADMIN_SIGNED_OUT', 'ADMIN_CHANGED'].includes(error?.code)) changed(error.code);
        if (String(error?.code || '').startsWith('ADMIN_')) throw error;
        throw adminReadError();
      } finally { pending.delete(controller); signal?.removeEventListener('abort', abort); }
    },
    async denyEarlyAccess(intent, { signal } = {}) {
      const captured = epoch;
      const { runEarlyAccessDenial } = await import('./admin-early-access-write-client.mjs');
      assertEpoch(captured);
      return runEarlyAccessDenial(intent, { signal }, {
        capture, assertCurrent, assertEpoch, changed, pending, request, adminReadError, normalizeAdminContext,
      });
    },
    async assignRole(intent, { signal } = {}) {
      const captured = epoch;
      const { runRoleAssignment } = await import('./admin-role-write-client.mjs');
      assertEpoch(captured);
      return runRoleAssignment(intent, { signal }, {
        capture, assertCurrent, assertEpoch, changed, pending, request, adminReadError, normalizeAdminContext,
      });
    },
    invalidate: changed,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    destroy() { changed(); disposed = true; unsubscribe?.(); listeners.clear(); },
  };
}
