import { mfaError } from './mfa-auth.mjs';

// Pure browser simulation, imported only by the explicitly mock runtime. No
// hosted client, persisted assurance, or production acceptance of this code.
export function createPreviewMfaAdapter({ getUser, challenge = false, stepUp = false }) {
  let actorId = '';
  let enrolled = challenge || stepUp;
  let verified = stepUp;
  let pending = false;
  const factorId = '00000000-0000-4000-8000-000000000077';
  const getState = async ({ expectedUserId = '' } = {}) => {
    const user = await getUser();
    if (!user?.authenticated || !user.userId) throw mfaError('MFA_SIGNED_OUT');
    if ((actorId && actorId !== user.userId) || (expectedUserId && expectedUserId !== user.userId)) throw mfaError('MFA_ACTOR_CHANGED');
    actorId = user.userId;
    return { userId: actorId, currentLevel: verified ? 'aal2' : 'aal1', nextLevel: enrolled ? 'aal2' : 'aal1', requiresChallenge: enrolled && !verified, verified, factors: enrolled ? [{ id: factorId, friendlyName: 'Preview authenticator' }] : [], preview: true };
  };
  return {
    getState,
    async enroll(options) {
      const state = await getState(options);
      if (state.requiresChallenge) throw mfaError('MFA_CHALLENGE_REQUIRED');
      if (enrolled) throw mfaError('MFA_ALREADY_ENABLED');
      pending = true;
      return { factorId, secret: 'JBSWY3DPEHPK3PXP', qrCode: '' };
    },
    async verify({ expectedUserId, factorId: selected, code }) {
      await getState({ expectedUserId });
      if (selected !== factorId || (!pending && !enrolled)) throw mfaError('MFA_FACTOR_UNAVAILABLE');
      if (code !== '012345') throw mfaError('MFA_INVALID_CODE');
      enrolled = true;
      verified = true;
      pending = false;
      return getState({ expectedUserId });
    },
    async cancelEnrollment({ expectedUserId }) { if (actorId === expectedUserId) pending = false; },
    dispose() { pending = false; actorId = ''; },
  };
}
