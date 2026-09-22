import { createFeedbackIntent, normalizeFeedbackOwner, normalizeFeedbackReceipt } from './feedback-contract.mjs';

const ACCESS_KEYS = ['schemaVersion', 'actorId', 'asOf', 'appAccess', 'legacyMembershipActive',
  'paidSubscriptionActive', 'earlyAccessActive', 'earlyAccessProgram', 'earlyAccessEndsAt', 'betaPriceEligible'];
const messages = Object.freeze({
  FEEDBACK_UNAVAILABLE: 'Feedback is temporarily unavailable. Try again.',
  FEEDBACK_SIGNED_OUT: 'Log in again to send feedback.',
  FEEDBACK_CHANGED: 'The account or session changed. Reopen feedback to continue.',
  FEEDBACK_DENIED: 'Feedback access could not be verified.',
  FEEDBACK_MFA_REQUIRED: 'Verify your authenticator before continuing.',
  FEEDBACK_NOT_ELIGIBLE: 'Feedback is available to active Early Access participants.',
  FEEDBACK_INVALID_INPUT: 'Check the feedback fields and try again.',
  FEEDBACK_INTENT_CONFLICT: 'This retry no longer matches the original feedback.',
  FEEDBACK_CANCELLED: 'The feedback request was cancelled without confirmation.',
  FEEDBACK_UNCONFIRMED: 'The feedback result could not be confirmed. Retry the same submission.',
});
export function feedbackClientError(code = 'FEEDBACK_UNAVAILABLE') {
  const safe = Object.hasOwn(messages, code) ? code : 'FEEDBACK_UNAVAILABLE';
  return Object.assign(new Error(messages[safe]), { code: safe });
}
function safeError(error) {
  const provider = error?.code === 'PT401' && error?.message === 'member_authentication_required' ? 'FEEDBACK_SIGNED_OUT'
    : error?.code === 'PT403' && error?.message === 'member_origin_forbidden' ? 'FEEDBACK_DENIED'
      : error?.code === 'PT403' && error?.message === 'member_mfa_required' ? 'FEEDBACK_MFA_REQUIRED' : error?.code;
  return feedbackClientError(provider);
}
const exact = (value, keys) => Boolean(value && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)));
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const timestamp = value => typeof value === 'string' && value.length <= 40
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value));

export function normalizeMemberAccessContext(value, actorId) {
  if (!exact(value, ACCESS_KEYS) || value.schemaVersion !== 1 || value.actorId !== actorId
    || typeof actorId !== 'string' || !uuid.test(actorId)
    || !timestamp(value.asOf) || ['appAccess', 'legacyMembershipActive', 'paidSubscriptionActive', 'earlyAccessActive', 'betaPriceEligible']
      .some(key => typeof value[key] !== 'boolean')
    || value.earlyAccessProgram !== (value.earlyAccessActive ? 'early_access_v1' : null)
    || !(value.earlyAccessEndsAt === null || timestamp(value.earlyAccessEndsAt))
    || (!value.earlyAccessActive && value.earlyAccessEndsAt !== null)
    || value.appAccess !== (value.legacyMembershipActive || value.earlyAccessActive)
    || (value.paidSubscriptionActive && !value.legacyMembershipActive)) throw feedbackClientError();
  return Object.freeze(Object.fromEntries(ACCESS_KEYS.map(key => [key, value[key]])));
}

// Inject the existing singleton's methods and a pinned-token JSON RPC transport.
// getUser(token) must use authoritative Auth getUser(token), not cached metadata.
// request(name,args,{token,signal}) returns parsed JSON or throws a provider error;
// its response-body read must also honor signal and enforce a bounded body size.
// No SDK construction, storage, permission cache or automatic replay lives here.
// The future coordinator must call invalidate synchronously on pagehide and any
// recognized cross-tab owner-storage event, before scheduling new UI hydration.
export function createFeedbackClient({ getSession, getUser, sessionIdentity, subscribe, request,
  requestTimeoutMs = 20000 } = {}) {
  if ([getSession, getUser, sessionIdentity, subscribe, request].some(fn => typeof fn !== 'function')
    || !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 60000) {
    throw new TypeError('Feedback requires existing Auth/RPC adapters and a bounded deadline.');
  }
  let epoch = 0; let disposed = false; let observedIdentity; let issued = new WeakMap();
  const pending = new Set(); const listeners = new Set();
  const invalidate = () => {
    epoch += 1; issued = new WeakMap();
    for (const operation of pending) { operation.abortCode = 'FEEDBACK_CHANGED'; operation.controller.abort(); }
    for (const listener of listeners) { try { listener(); } catch { /* Notify every owner synchronously. */ } }
  };
  const unsubscribe = subscribe(({ event, sessionIdentity: identity }) => {
    const next = typeof identity === 'string' ? identity : '';
    if (['SIGNED_OUT', 'TOKEN_REFRESHED', 'USER_UPDATED', 'PASSWORD_RECOVERY', 'MFA_CHALLENGE_VERIFIED'].includes(event)
      || (observedIdentity !== undefined && observedIdentity !== next)
      || (observedIdentity === undefined && [...pending].some(operation => operation.identity && operation.identity !== next))) invalidate();
    observedIdentity = next;
  });
  const assertOperation = operation => {
    if (disposed || operation.epoch !== epoch) throw feedbackClientError('FEEDBACK_CHANGED');
    if (operation.closed || operation.controller.signal.aborted) throw feedbackClientError(operation.abortCode);
  };
  const checkOwner = owner => {
    const record = owner && issued.get(owner);
    if (disposed || !record || record.epoch !== epoch) throw feedbackClientError('FEEDBACK_CHANGED');
    return record;
  };
  async function run(signal, body) {
    if (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean'
      || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw feedbackClientError('FEEDBACK_INVALID_INPUT');
    const operation = { epoch, identity: '', controller: new AbortController(), closed: false, abortCode: 'FEEDBACK_CANCELLED' };
    pending.add(operation);
    const callerAbort = () => { operation.abortCode = 'FEEDBACK_CANCELLED'; operation.controller.abort(); };
    let rejectAbort;
    const aborted = new Promise((resolve, reject) => { rejectAbort = reject; });
    const abort = () => rejectAbort(feedbackClientError(operation.abortCode));
    operation.controller.signal.addEventListener('abort', abort, { once: true });
    signal?.addEventListener('abort', callerAbort, { once: true });
    const timer = setTimeout(() => { operation.abortCode = 'FEEDBACK_UNCONFIRMED'; operation.controller.abort(); }, requestTimeoutMs);
    const wait = async callback => {
      assertOperation(operation);
      const result = await callback();
      assertOperation(operation);
      return result;
    };
    try {
      if (signal?.aborted) callerAbort();
      const work = Promise.resolve().then(() => { assertOperation(operation); return body(operation, wait); });
      const result = await Promise.race([work, aborted]);
      assertOperation(operation); return result;
    } catch (error) {
      if (disposed || operation.epoch !== epoch) throw feedbackClientError('FEEDBACK_CHANGED');
      if (operation.controller.signal.aborted) throw feedbackClientError(operation.abortCode);
      const failure = safeError(error);
      if (['FEEDBACK_SIGNED_OUT', 'FEEDBACK_CHANGED', 'FEEDBACK_DENIED', 'FEEDBACK_MFA_REQUIRED'].includes(failure.code)) invalidate();
      throw failure;
    } finally {
      operation.closed = true; pending.delete(operation); clearTimeout(timer);
      signal?.removeEventListener('abort', callerAbort); operation.controller.signal.removeEventListener('abort', abort);
    }
  }
  async function capture(operation, wait, expected) {
    const first = await wait(() => getSession());
    const actorId = first?.user?.id; const identity = sessionIdentity(first); const token = first?.access_token;
    if (!actorId || !identity || typeof token !== 'string' || !token) throw feedbackClientError('FEEDBACK_SIGNED_OUT');
    const owner = normalizeFeedbackOwner({ actorId, sessionIdentity: identity });
    if (expected && (expected.actorId !== actorId || expected.sessionIdentity !== identity)) throw feedbackClientError('FEEDBACK_CHANGED');
    operation.identity = identity;
    const user = await wait(() => getUser(token));
    if (!user?.id) throw feedbackClientError('FEEDBACK_SIGNED_OUT');
    if (user.id !== actorId) throw feedbackClientError('FEEDBACK_CHANGED');
    const captured = { ...owner, token };
    await assertCurrent(captured, wait);
    if (observedIdentity !== undefined && observedIdentity !== identity) {
      observedIdentity = identity; invalidate(); throw feedbackClientError('FEEDBACK_CHANGED');
    }
    // The SDK may not have delivered INITIAL_SESSION yet. An issued idle owner
    // must still be retired by its very first different-session notification.
    observedIdentity = identity;
    return captured;
  }
  async function assertCurrent(owner, wait) {
    const current = await wait(() => getSession());
    if (current?.user?.id !== owner.actorId || sessionIdentity(current) !== owner.sessionIdentity
      || current?.access_token !== owner.token) throw feedbackClientError('FEEDBACK_CHANGED');
  }
  async function access(owner, operation, wait) {
    const value = await wait(() => request('get_member_access_context', { target_expected_actor_id: owner.actorId },
      { token: owner.token, signal: operation.controller.signal }));
    await assertCurrent(owner, wait);
    return normalizeMemberAccessContext(value, owner.actorId);
  }
  async function submit(owner, suppliedIntent, { signal } = {}) {
    const record = checkOwner(owner);
    if (!exact(suppliedIntent, ['operationId', 'input', 'context'])) throw feedbackClientError('FEEDBACK_INVALID_INPUT');
    const normalized = createFeedbackIntent(suppliedIntent.input, suppliedIntent.context, suppliedIntent.operationId);
    const fingerprint = JSON.stringify(normalized);
    let binding = record.operations.get(normalized.operationId);
    if (binding && binding.fingerprint !== fingerprint) throw feedbackClientError('FEEDBACK_INTENT_CONFLICT');
    if (!binding) { binding = { intent: normalized, fingerprint, dispatched: false }; record.operations.set(normalized.operationId, binding); }
    return run(signal, async (operation, wait) => {
      checkOwner(owner);
      const captured = await capture(operation, wait, owner);
      const context = await access(captured, operation, wait);
      if (!context.earlyAccessActive && !binding.dispatched) throw feedbackClientError('FEEDBACK_NOT_ELIGIBLE');
      await assertCurrent(captured, wait);
      const value = await wait(() => {
        // A retry after a potentially committed call may recover that same
        // receipt after EA ends. The RPC rechecks eligibility for any NEW row.
        binding.dispatched = true;
        return request('submit_early_access_feedback', {
          target_expected_actor_id: captured.actorId, target_operation_id: binding.intent.operationId,
          target_input: binding.intent.input, target_context: binding.intent.context,
        }, { token: captured.token, signal: operation.controller.signal });
      });
      await assertCurrent(captured, wait); checkOwner(owner);
      return normalizeFeedbackReceipt(value, binding.intent, owner);
    });
  }
  const isCurrent = owner => { try { checkOwner(owner); return true; } catch { return false; } };
  return Object.freeze({
    readAccess({ expectedUserId = '', signal } = {}) {
      return run(signal, async (operation, wait) => {
        const captured = await capture(operation, wait);
        if (expectedUserId && captured.actorId !== expectedUserId) throw feedbackClientError('FEEDBACK_CHANGED');
        const context = await access(captured, operation, wait);
        const owner = Object.freeze({ actorId: captured.actorId, sessionIdentity: captured.sessionIdentity });
        issued.set(owner, { epoch: operation.epoch, operations: new Map() });
        return Object.freeze({ owner, context });
      });
    },
    submit,
    isCurrent,
    bindOwner(owner) {
      checkOwner(owner);
      // The dialog normalizes its display owner into a clone. These callbacks
      // retain the issued owner; structural equality never grants issuance.
      return Object.freeze({ owner,
        isCurrent: displayed => isCurrent(owner) && displayed?.actorId === owner.actorId && displayed?.sessionIdentity === owner.sessionIdentity,
        submit: (intent, options) => submit(owner, intent, options),
      });
    },
    invalidate,
    subscribe(listener) { if (typeof listener !== 'function') throw new TypeError('Feedback requires a listener.'); listeners.add(listener); return () => listeners.delete(listener); },
    destroy() { if (disposed) return; disposed = true; invalidate(); unsubscribe?.(); listeners.clear(); },
  });
}
