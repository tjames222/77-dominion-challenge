// An app invitation is a one-use capability, never a native Auth credential.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const EARLY_ACCESS_INVITATION_PAGE = './early-access-invite.html';
const invalid = () => Object.assign(new Error('Open the current invitation from your email.'), { code: 'INVITATION_INVALID' });
const exact = (value, keys) => Boolean(value && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value');
  }));
export function normalizeInvitationCapability(value) {
  if (!exact(value, ['generationId', 'token']) || typeof value.generationId !== 'string' || !UUID.test(value.generationId)
    || typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value.token)) throw invalid();
  return Object.freeze({ generationId: value.generationId, token: value.token });
}
export function invitationCapabilityFromFragment(fragment) {
  if (typeof fragment !== 'string' || fragment.length > 160 || !fragment.startsWith('#')) throw invalid();
  // Accept only the canonical emitted shape; no URL decoding aliases, duplicate
  // values, extra tracking parameters, or native Auth token fragments.
  const match = /^#token=([A-Za-z0-9_-]{43})&generation=([0-9a-f-]{36})$/.exec(fragment);
  if (!match) throw invalid();
  return normalizeInvitationCapability({ token: match[1], generationId: match[2] });
}
export function createInvitationAcceptanceIntent(capability, operationId = crypto.randomUUID(), correlationId = crypto.randomUUID()) {
  const normalized = normalizeInvitationCapability(capability);
  if (typeof operationId !== 'string' || !UUID.test(operationId) || typeof correlationId !== 'string' || !UUID.test(correlationId)) throw invalid();
  return Object.freeze({ ...normalized, operationId, correlationId });
}
export function normalizeInvitationAcceptanceIntent(value) {
  if (!exact(value, ['generationId', 'token', 'operationId', 'correlationId'])
    || typeof value.operationId !== 'string' || !UUID.test(value.operationId)
    || typeof value.correlationId !== 'string' || !UUID.test(value.correlationId)) throw invalid();
  return createInvitationAcceptanceIntent({ generationId: value.generationId, token: value.token }, value.operationId, value.correlationId);
}
export function normalizeInvitationAcceptanceReceipt(value, actorId) {
  if (exact(value, ['ok', 'status', 'actorId', 'program']) && value.ok === true && value.status === 'accepted'
    && value.actorId === actorId && value.program === 'early_access_v1') {
    return Object.freeze({ ok: true, status: 'accepted', actorId, program: 'early_access_v1' });
  }
  if (exact(value, ['ok', 'errorCode']) && value.ok === false && [
    'invitation_unavailable', 'account_setup_required', 'account_unavailable', 'delivery_not_ready',
    'program_unavailable', 'already_qualified', 'rate_limited',
  ].includes(value.errorCode)) return Object.freeze({ ok: false, errorCode: value.errorCode });
  throw Object.assign(new Error('The invitation result could not be confirmed. Retry the same acceptance.'), { code: 'INVITATION_UNCONFIRMED' });
}

const STORAGE_KEY = 'dominion:early-access-invitation:v1';
const CONTINUATION_MS = 15 * 60 * 1000;
// This short-lived, tab-local continuation only saves reopening the email after
// login/MFA. It is not membership/session evidence. Never put it in returnTo.
export function createInvitationContinuation({ storage, now = Date.now } = {}) {
  const clear = () => { try { storage?.removeItem(STORAGE_KEY); } catch { /* No persistence required. */ } };
  return Object.freeze({
    clear,
    capture(locationLike, historyLike) {
      const fragment = String(locationLike?.hash || '');
      if (!fragment) return this.read();
      // Strip the capability before parsing, storage, UI work, or networking.
      try { historyLike.replaceState(null, '', EARLY_ACCESS_INVITATION_PAGE); } catch { clear(); throw invalid(); }
      clear();
      const capability = invitationCapabilityFromFragment(fragment);
      const capturedAt = now();
      if (!Number.isSafeInteger(capturedAt) || capturedAt <= 0) throw invalid();
      try { storage?.setItem(STORAGE_KEY, JSON.stringify({ ...capability, capturedAt })); } catch { /* Caller can keep memory until navigation. */ }
      return capability;
    },
    read() {
      try {
        const raw = storage?.getItem(STORAGE_KEY);
        if (!raw) return null;
        if (raw.length > 256) throw invalid();
        const value = JSON.parse(raw);
        const observedAt = now();
        if (!exact(value, ['generationId', 'token', 'capturedAt']) || !Number.isSafeInteger(value.capturedAt)
          || !Number.isSafeInteger(observedAt) || observedAt <= 0
          || value.capturedAt <= 0 || value.capturedAt > observedAt || observedAt - value.capturedAt >= CONTINUATION_MS) throw invalid();
        return normalizeInvitationCapability({ generationId: value.generationId, token: value.token });
      } catch { clear(); return null; }
    },
  });
}
