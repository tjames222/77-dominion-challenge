import { normalizeInvitationAcceptanceIntent, normalizeInvitationAcceptanceReceipt } from './early-access-invitation-contract.mjs';
import { normalizeMemberAccessContext } from './member-access-context.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const messages = Object.freeze({
  INVITATION_UNAVAILABLE: 'Invitation acceptance is temporarily unavailable. Try again.',
  INVITATION_SIGNED_OUT: 'Sign in with the invited email address before accepting.',
  INVITATION_CHANGED: 'Your account or session changed. Review this invitation again.',
  INVITATION_DENIED: 'Invitation access could not be verified.',
  INVITATION_MFA_REQUIRED: 'Verify your authenticator before accepting this invitation.',
  INVITATION_INVALID: 'Open the current invitation from your email.',
  INVITATION_INTENT_CONFLICT: 'This retry no longer matches the original acceptance.',
  INVITATION_CANCELLED: 'Acceptance was cancelled without confirmation.',
  INVITATION_UNCONFIRMED: 'The result could not be confirmed. Retry this same acceptance.',
});
export function invitationClientError(code = 'INVITATION_UNAVAILABLE') {
  const safe = typeof code === 'string' && Object.hasOwn(messages, code) ? code : 'INVITATION_UNAVAILABLE';
  return Object.assign(new Error(messages[safe]), { code: safe });
}
function safeError(error) {
  try {
    const data = key => {
      const descriptor = error && Object.getOwnPropertyDescriptor(error, key);
      return descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string' ? descriptor.value : '';
    };
    const providerCode = data('code'); const message = data('message');
    const code = providerCode === 'PT401' && message === 'member_authentication_required' ? 'INVITATION_SIGNED_OUT'
      : providerCode === 'PT403' && message === 'member_mfa_required' ? 'INVITATION_MFA_REQUIRED'
        : providerCode === 'PT403' && message === 'member_origin_forbidden' ? 'INVITATION_DENIED'
          : providerCode === '22023' && message === 'invitation_idempotency_conflict' ? 'INVITATION_INTENT_CONFLICT' : providerCode;
    return invitationClientError(code);
  } catch { return invitationClientError(); }
}

// Existing singleton Auth only; no SDK instance, storage, auto-acceptance, or
// authority inferred from an email-link token. Both RPCs use the captured native
// bearer and SQL revalidates session, verified email, MFA and live invitation.
export function createInvitationAcceptanceClient({ getSession, getUser, sessionIdentity, subscribe, request, requestTimeoutMs = 20000 } = {}) {
  if ([getSession, getUser, sessionIdentity, subscribe, request].some(fn => typeof fn !== 'function')
    || !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 60000) {
    throw new TypeError('Invitation acceptance requires existing Auth/RPC adapters and a bounded deadline.');
  }
  let epoch = 0; let disposed = false; let observedIdentity; let owners = new WeakMap();
  const pending = new Set(); const listeners = new Set();
  const invalidate = () => {
    epoch += 1; owners = new WeakMap();
    for (const op of pending) { op.abortCode = 'INVITATION_CHANGED'; op.controller.abort(); }
    for (const listener of listeners) { try { listener(); } catch { /* Clear every owner. */ } }
  };
  const unsubscribe = subscribe(({ event, sessionIdentity: identity }) => {
    const next = typeof identity === 'string' ? identity : '';
    if (['SIGNED_OUT', 'TOKEN_REFRESHED', 'USER_UPDATED', 'PASSWORD_RECOVERY', 'MFA_CHALLENGE_VERIFIED'].includes(event)
      || (observedIdentity !== undefined && observedIdentity !== next)
      || (observedIdentity === undefined && [...pending].some(op => op.identity && op.identity !== next))) invalidate();
    observedIdentity = next;
  });
  function assertOperation(op) {
    if (disposed || op.epoch !== epoch) throw invitationClientError('INVITATION_CHANGED');
    if (op.closed || op.controller.signal.aborted) throw invitationClientError(op.abortCode);
  }
  function ownerRecord(owner) {
    const record = owner && owners.get(owner);
    if (disposed || !record || record.epoch !== epoch) throw invitationClientError('INVITATION_CHANGED');
    return record;
  }
  async function run(signal, body) {
    if (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean'
      || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw invitationClientError('INVITATION_INVALID');
    const op = { epoch, identity: '', controller: new AbortController(), closed: false, abortCode: 'INVITATION_CANCELLED' };
    pending.add(op);
    const callerAbort = () => { op.abortCode = 'INVITATION_CANCELLED'; op.controller.abort(); };
    let rejectAbort;
    const aborted = new Promise((resolve, reject) => { rejectAbort = reject; });
    const abort = () => rejectAbort(invitationClientError(op.abortCode));
    op.controller.signal.addEventListener('abort', abort, { once: true });
    signal?.addEventListener('abort', callerAbort, { once: true });
    const timer = setTimeout(() => { op.abortCode = 'INVITATION_UNCONFIRMED'; op.controller.abort(); }, requestTimeoutMs);
    const wait = async callback => { assertOperation(op); const value = await callback(); assertOperation(op); return value; };
    try {
      if (signal?.aborted) callerAbort();
      const work = Promise.resolve().then(() => { assertOperation(op); return body(op, wait); });
      const result = await Promise.race([work, aborted]); assertOperation(op); return result;
    } catch (error) {
      if (disposed || op.epoch !== epoch) throw invitationClientError('INVITATION_CHANGED');
      if (op.controller.signal.aborted) throw invitationClientError(op.abortCode);
      const failure = safeError(error);
      if (['INVITATION_SIGNED_OUT', 'INVITATION_CHANGED', 'INVITATION_DENIED', 'INVITATION_MFA_REQUIRED'].includes(failure.code)) invalidate();
      throw failure;
    } finally {
      op.closed = true; pending.delete(op); clearTimeout(timer);
      signal?.removeEventListener('abort', callerAbort); op.controller.signal.removeEventListener('abort', abort);
    }
  }
  async function assertCurrent(owner, wait) {
    const current = await wait(() => getSession());
    if (current?.user?.id !== owner.actorId || sessionIdentity(current) !== owner.sessionIdentity || current?.access_token !== owner.token) {
      throw invitationClientError('INVITATION_CHANGED');
    }
  }
  async function capture(op, wait, expected) {
    const session = await wait(() => getSession());
    const actorId = session?.user?.id; const identity = sessionIdentity(session); const token = session?.access_token;
    if (!actorId || !identity || typeof token !== 'string' || !token) throw invitationClientError('INVITATION_SIGNED_OUT');
    if (!UUID.test(actorId) || !identity.startsWith(`${actorId}:`) || !UUID.test(identity.slice(actorId.length + 1))) throw invitationClientError();
    if (expected && (actorId !== expected.actorId || identity !== expected.sessionIdentity)) throw invitationClientError('INVITATION_CHANGED');
    op.identity = identity;
    const user = await wait(() => getUser(token));
    if (!user?.id) throw invitationClientError('INVITATION_SIGNED_OUT');
    if (user.id !== actorId) throw invitationClientError('INVITATION_CHANGED');
    const owner = { actorId, sessionIdentity: identity, token };
    await assertCurrent(owner, wait);
    if (observedIdentity !== undefined && observedIdentity !== identity) {
      observedIdentity = identity; invalidate(); throw invitationClientError('INVITATION_CHANGED');
    }
    observedIdentity = identity;
    return owner;
  }
  async function checkAccess(owner, op, wait) {
    const value = await wait(() => request('get_member_access_context', { target_expected_actor_id: owner.actorId },
      { token: owner.token, signal: op.controller.signal }));
    await assertCurrent(owner, wait);
    try { return normalizeMemberAccessContext(value, owner.actorId); } catch { throw invitationClientError(); }
  }
  return Object.freeze({
    review({ signal } = {}) {
      return run(signal, async (op, wait) => {
        const captured = await capture(op, wait);
        const context = await checkAccess(captured, op, wait);
        const owner = Object.freeze({ actorId: captured.actorId, sessionIdentity: captured.sessionIdentity });
        owners.set(owner, { epoch: op.epoch, operations: new Map() });
        return Object.freeze({ owner, context });
      });
    },
    accept(owner, suppliedIntent, { signal } = {}) {
      const record = ownerRecord(owner);
      const normalized = normalizeInvitationAcceptanceIntent(suppliedIntent);
      const fingerprint = JSON.stringify(normalized);
      let binding = record.operations.get(normalized.operationId);
      if (binding && binding.fingerprint !== fingerprint) throw invitationClientError('INVITATION_INTENT_CONFLICT');
      if (!binding) { binding = { intent: normalized, fingerprint }; record.operations.set(normalized.operationId, binding); }
      return run(signal, async (op, wait) => {
        ownerRecord(owner);
        const captured = await capture(op, wait, owner);
        await checkAccess(captured, op, wait);
        await assertCurrent(captured, wait);
        const value = await wait(() => request('accept_early_access_invitation', {
          target_expected_actor_id: captured.actorId, target_generation_id: binding.intent.generationId,
          target_token: binding.intent.token, target_operation_id: binding.intent.operationId, target_correlation_id: binding.intent.correlationId,
        }, { token: captured.token, signal: op.controller.signal }));
        await assertCurrent(captured, wait); ownerRecord(owner);
        return normalizeInvitationAcceptanceReceipt(value, captured.actorId);
      });
    },
    isCurrent(owner) { try { ownerRecord(owner); return true; } catch { return false; } },
    invalidate,
    subscribe(listener) { if (typeof listener !== 'function') throw new TypeError('A listener is required.'); listeners.add(listener); return () => listeners.delete(listener); },
    destroy() { if (disposed) return; disposed = true; invalidate(); unsubscribe?.(); listeners.clear(); },
  });
}
