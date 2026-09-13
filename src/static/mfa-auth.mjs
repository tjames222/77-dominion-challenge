const FACTOR_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const CODE = /^\d{6}$/;
const text = (value) => typeof value === 'string' ? value.trim() : '';

export function mfaError(code = 'MFA_UNAVAILABLE') {
  const messages = {
    MFA_UNAVAILABLE: 'Account security is temporarily unavailable. Please try again.',
    MFA_SIGNED_OUT: 'Log in again to continue account security setup.',
    MFA_ACTOR_CHANGED: 'The signed-in account changed. Reload account security to continue.',
    MFA_CHALLENGE_REQUIRED: 'Verify your existing authenticator before changing security settings.',
    MFA_ALREADY_ENABLED: 'An authenticator is already enabled for this account.',
    MFA_INVALID_CODE: 'Enter the current six-digit code from your authenticator and try again.',
    MFA_FACTOR_UNAVAILABLE: 'This authenticator is no longer available. Reload account security.',
    MFA_RATE_LIMIT: 'Too many attempts. Wait a little, then try again.',
    MFA_NOT_CONFIRMED: 'Verification could not be confirmed. Try a fresh code; your authenticator has not been removed.',
  };
  return Object.assign(new Error(messages[code] || messages.MFA_UNAVAILABLE), { code });
}

function providerError(error, fallback = 'MFA_UNAVAILABLE') {
  const code = text(error?.code);
  if (['mfa_verification_failed', 'mfa_verification_rejected', 'mfa_challenge_expired'].includes(code)) return mfaError('MFA_INVALID_CODE');
  if (code.includes('rate_limit') || error?.status === 429) return mfaError('MFA_RATE_LIMIT');
  if (code === 'session_not_found' || code === 'refresh_token_not_found') return mfaError('MFA_SIGNED_OUT');
  return mfaError(fallback);
}

const verifiedTotp = (factors) => (Array.isArray(factors) ? factors : [])
  .filter((factor) => factor.factor_type === 'totp' && factor.status === 'verified' && FACTOR_ID.test(factor.id))
  .map((factor, index) => ({ id: factor.id, friendlyName: text(factor.friendly_name).slice(0, 80) || `Authenticator ${index + 1}` }));

// A cheap, fail-closed presentation gate. It grants no backend authorization;
// enrollment and successful verification still use authoritative getState.
export async function sessionRequiresMfa(auth) {
  let result;
  try { result = await auth.mfa.getAuthenticatorAssuranceLevel(); } catch { throw mfaError(); }
  if (result.error) throw providerError(result.error);
  const { currentLevel, nextLevel } = result.data || {};
  if (currentLevel === null && nextLevel === null) return false;
  if (!['aal1', 'aal2'].includes(currentLevel) || !['aal1', 'aal2'].includes(nextLevel)) throw mfaError();
  return currentLevel !== 'aal2' && nextLevel === 'aal2';
}

// This adapter returns no access/refresh token and never stores a TOTP secret.
// Provider errors are mapped to fixed copy; raw error payloads are not exposed.
export function createSupabaseMfaAdapter(auth) {
  if (!auth?.mfa || typeof auth.getUser !== 'function') throw new TypeError('A Supabase Auth client is required.');
  let epoch = 0;
  let observedActor = null;
  let destroyed = false;
  const pendingFactors = new Map();
  const subscription = auth.onAuthStateChange?.((event, session) => {
    const next = text(session?.user?.id);
    if (event === 'SIGNED_OUT' || (observedActor !== null && next !== observedActor)) {
      epoch += 1;
      pendingFactors.clear();
    }
    observedActor = next;
  });

  const assertEpoch = (captured) => {
    if (destroyed || captured !== epoch) throw mfaError('MFA_ACTOR_CHANGED');
  };
  const actor = async (expectedUserId, captured) => {
    assertEpoch(captured);
    let response;
    try { response = await auth.getUser(); } catch { throw mfaError('MFA_UNAVAILABLE'); }
    assertEpoch(captured);
    if (response.error || !response.data?.user?.id) throw mfaError('MFA_SIGNED_OUT');
    if (expectedUserId && response.data.user.id !== expectedUserId) throw mfaError('MFA_ACTOR_CHANGED');
    return response.data.user;
  };

  const getState = async ({ expectedUserId = '' } = {}) => {
    const captured = epoch;
    const initial = await actor(expectedUserId, captured);
    let listed;
    let assurance;
    try {
      listed = await auth.mfa.listFactors();
      assertEpoch(captured);
      assurance = await auth.mfa.getAuthenticatorAssuranceLevel();
    } catch (error) {
      if (error?.code === 'MFA_ACTOR_CHANGED') throw error;
      throw mfaError('MFA_UNAVAILABLE');
    }
    if (listed.error || assurance.error) throw providerError(listed.error || assurance.error);
    const current = await actor(initial.id, captured);
    // Confirm listed factor IDs against the authoritative Auth user response,
    // not user_metadata, locally supplied assurance flags, or a preview fixture.
    const authoritative = verifiedTotp(current.factors);
    const listedIds = new Set(verifiedTotp(listed.data?.all || listed.data?.totp).map((factor) => factor.id));
    const factors = authoritative.filter((factor) => listedIds.has(factor.id));
    if (factors.length !== authoritative.length) throw mfaError('MFA_UNAVAILABLE');
    const currentLevel = assurance.data?.currentLevel;
    const nextLevel = assurance.data?.nextLevel;
    if (!['aal1', 'aal2'].includes(currentLevel) || !['aal1', 'aal2'].includes(nextLevel)) throw mfaError('MFA_UNAVAILABLE');
    return Object.freeze({
      userId: current.id, currentLevel, nextLevel, factors,
      totpVerifiedAt: Math.max(0, ...(assurance.data?.currentAuthenticationMethods || [])
        .filter((method) => method.method === 'totp' && Number.isFinite(method.timestamp))
        .map((method) => method.timestamp)),
      requiresChallenge: currentLevel !== 'aal2' && (nextLevel === 'aal2' || factors.length > 0),
      verified: currentLevel === 'aal2' && factors.length > 0,
      preview: false,
    });
  };

  const enroll = async ({ expectedUserId } = {}) => {
    const captured = epoch;
    const state = await getState({ expectedUserId });
    assertEpoch(captured);
    if (state.requiresChallenge) throw mfaError('MFA_CHALLENGE_REQUIRED');
    if (state.factors.length) throw mfaError('MFA_ALREADY_ENABLED');
    await actor(state.userId, captured);
    let response;
    try {
      response = await auth.mfa.enroll({ factorType: 'totp', friendlyName: `Dominion ${globalThis.crypto.randomUUID().slice(0, 8)}`, issuer: '77 Dominion' });
    } catch { throw mfaError('MFA_UNAVAILABLE'); }
    if (response.error) throw providerError(response.error);
    await actor(state.userId, captured);
    const data = response.data;
    if (!FACTOR_ID.test(data?.id || '') || data?.type !== 'totp'
      || !/^[A-Z2-7]{16,128}$/.test(data?.totp?.secret || '')
      || typeof data?.totp?.qr_code !== 'string') throw mfaError('MFA_UNAVAILABLE');
    pendingFactors.set(data.id, { actorId: state.userId, epoch: captured });
    return { factorId: data.id, secret: data.totp.secret, qrCode: data.totp.qr_code };
  };

  const verify = async ({ expectedUserId, factorId, code } = {}) => {
    if (!CODE.test(text(code))) throw mfaError('MFA_INVALID_CODE');
    if (!FACTOR_ID.test(text(factorId))) throw mfaError('MFA_FACTOR_UNAVAILABLE');
    const captured = epoch;
    const state = await getState({ expectedUserId });
    const pending = pendingFactors.get(factorId);
    const ownsPending = pending?.actorId === state.userId && pending.epoch === captured;
    if (!state.factors.some((factor) => factor.id === factorId) && !ownsPending) throw mfaError('MFA_FACTOR_UNAVAILABLE');
    // An enrollment created at AAL1 cannot bypass an existing verified factor.
    if (ownsPending && state.requiresChallenge && !state.factors.some((factor) => factor.id === factorId)) {
      throw mfaError('MFA_CHALLENGE_REQUIRED');
    }
    await actor(state.userId, captured);
    let challenge;
    try { challenge = await auth.mfa.challenge({ factorId }); } catch { throw mfaError('MFA_UNAVAILABLE'); }
    if (challenge.error) throw providerError(challenge.error);
    if (!FACTOR_ID.test(challenge.data?.id || '')) throw mfaError('MFA_UNAVAILABLE');
    await actor(state.userId, captured);
    let verificationError = null;
    try {
      const result = await auth.mfa.verify({ factorId, challengeId: challenge.data.id, code: text(code) });
      verificationError = result.error || null;
    } catch { verificationError = { code: 'response_lost' }; }
    await actor(state.userId, captured);
    // Also reconcile a lost successful response; never guess success or delete
    // a factor because a network response was lost during verification.
    const confirmed = await getState({ expectedUserId: state.userId });
    assertEpoch(captured);
    const newlyConfirmed = !verificationError
      || (verificationError.code === 'response_lost'
        && (state.currentLevel !== 'aal2' || confirmed.totpVerifiedAt > state.totpVerifiedAt));
    if (newlyConfirmed && confirmed.verified && confirmed.factors.some((factor) => factor.id === factorId)) {
      pendingFactors.delete(factorId);
      return confirmed;
    }
    if (verificationError) throw providerError(verificationError, 'MFA_NOT_CONFIRMED');
    throw mfaError('MFA_NOT_CONFIRMED');
  };

  const cancelEnrollment = async ({ expectedUserId, factorId } = {}) => {
    const pending = pendingFactors.get(factorId);
    if (!pending || pending.actorId !== expectedUserId || pending.epoch !== epoch) return false;
    // No hosted factor deletion: a read-then-unenroll sequence could race a
    // successful verification in another tab. Forget only this operation.
    pendingFactors.delete(factorId);
    return true;
  };

  return Object.freeze({
    getState, enroll, verify, cancelEnrollment,
    dispose() {
      destroyed = true;
      epoch += 1;
      pendingFactors.clear();
      subscription?.data?.subscription?.unsubscribe?.();
    },
  });
}
