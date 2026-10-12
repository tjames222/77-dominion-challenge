const READS = new Set(['get_site_admin_context', 'site_admin_list_users', 'site_admin_get_user', 'site_admin_list_audit', 'site_admin_get_audit_event',
  'site_admin_list_early_access_requests', 'site_admin_get_early_access_request', 'site_admin_list_early_access_history', 'site_admin_list_account_requests', 'site_admin_get_account_request_queue_health']);
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

// Read-only work may be retried explicitly after a deadline. Never use this
// helper for a mutation: a lost write response does not establish rollback.
export async function withAdminReadDeadline(work, { signal } = {}, timeoutMs = 10000) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000 || signal?.aborted) throw adminReadError();
  const controller = new AbortController(); let reject;
  const stopped = new Promise((_, fail) => { reject = fail; });
  const stop = () => { controller.abort(); reject(adminReadError()); };
  const timer = setTimeout(stop, timeoutMs);
  signal?.addEventListener('abort', stop, { once: true });
  const assertActive = () => { if (controller.signal.aborted) throw adminReadError(); };
  try {
    return await Promise.race([(async () => {
      assertActive(); const value = await work({ signal: controller.signal, assertActive });
      assertActive(); return value;
    })(), stopped]);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
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
export function createAdminReadClient({ getSession, getUser, sessionIdentity, subscribe, request,
  readRequest = request, getReadUser = getUser, readTimeoutMs = 10000 }) {
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
  // Dedicated read guards keep mutation capture/continuation semantics intact.
  // The read's provider verification and RPC use the same captured bearer.
  async function captureRead(expectedUserId, assertActive, signal) {
    assertActive(); const session = await getSession(); assertActive();
    const identity = sessionIdentity(session); const actorId = session?.user?.id; const token = session?.access_token;
    if (!identity || !actorId || !token) throw adminReadError('ADMIN_SIGNED_OUT');
    if (expectedUserId && actorId !== expectedUserId) throw adminReadError('ADMIN_CHANGED');
    const user = await getReadUser(token, { signal }); assertActive();
    const current = await getSession(); assertActive();
    if (user?.id !== actorId || sessionIdentity(current) !== identity || current?.access_token !== token) throw adminReadError('ADMIN_CHANGED');
    return { actorId, identity, token };
  }
  async function assertReadCurrent(owner, assertActive) {
    assertActive(); const current = await getSession(); assertActive();
    if (sessionIdentity(current) !== owner.identity || current?.access_token !== owner.token) throw adminReadError('ADMIN_CHANGED');
  }
  async function readOperation(work, { signal } = {}) {
    const captured = epoch; const controller = new AbortController(); pending.add(controller);
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    try {
      return await withAdminReadDeadline(({ signal: readSignal, assertActive }) => work({ signal: readSignal,
        assertActive: () => { assertEpoch(captured); assertActive(); } }), { signal: controller.signal }, readTimeoutMs);
    } catch (error) {
      assertEpoch(captured);
      if (['ADMIN_SIGNED_OUT', 'ADMIN_CHANGED', 'ADMIN_DENIED'].includes(error?.code)) changed(error.code);
      throw adminReadError(error?.code);
    } finally { pending.delete(controller); signal?.removeEventListener('abort', abort); }
  }
  return {
    async owner(options = {}) {
      return readOperation(async ({ signal, assertActive }) => {
        const owner = await captureRead('', assertActive, signal); assertActive();
        return { actorId: owner.actorId, sessionIdentity: owner.identity };
      }, options);
    },
    async read(name, args = {}, { expectedUserId = '', signal } = {}) {
      if (!READS.has(name)) throw adminReadError('ADMIN_INVALID_INPUT');
      return readOperation(async ({ signal: readSignal, assertActive }) => {
        const owner = await captureRead(expectedUserId, assertActive, readSignal); assertActive();
        const result = await readRequest(name, { ...args, target_expected_actor_id: owner.actorId }, { token: owner.token, signal: readSignal });
        assertActive(); await assertReadCurrent(owner, assertActive); assertActive();
        if (!result || result.schemaVersion !== 1 || result.actorId !== owner.actorId) throw adminReadError();
        return name === 'get_site_admin_context' ? normalizeAdminContext(result, owner.actorId) : result;
      }, { signal });
    },
    async denyEarlyAccess(intent, { signal } = {}) {
      const captured = epoch;
      const { runEarlyAccessDenial } = await import('./admin-early-access-write-client.mjs');
      assertEpoch(captured);
      return runEarlyAccessDenial(intent, { signal }, {
        capture, assertCurrent, assertEpoch, changed, pending, request, adminReadError, normalizeAdminContext,
      });
    },
    async manageEarlyAccessInvitation(intent, { signal } = {}) {
      const captured = epoch;
      const { runEarlyAccessInvitation } = await import('./admin-early-access-invitation-client.mjs');
      assertEpoch(captured);
      return runEarlyAccessInvitation(intent, { signal }, {
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
