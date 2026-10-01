// Start request identities are UI retry state, not permission. The actor-bound
// catalog enables the control; the RPC independently enforces actor/run/CAS.
import { isInstanceDate } from './challenge-instance-contract.mjs';

export function prepareRewardStartRequest({ catalog, activation, actorId, challengeKey, previous = null,
  createRequestId } = {}) {
  const allowed = catalog?.schemaVersion === 2 && catalog.actorId === actorId
    && catalog.currentInstance?.status === 'completed' && !catalog.currentInstance.reviewRequired
    && Number.isSafeInteger(catalog.revision) && catalog.revision >= 0
    && (challengeKey === 'original_77' ? catalog.originalRepeat?.canStart === true
      : catalog.items?.some(reward => reward.key === challengeKey && reward.allowedActions?.includes('start')));
  if (!allowed) throw new Error('Reload challenge progress before starting another run.');
  if (activation?.schemaVersion !== 2 || activation.contractValid !== true || activation.actorId !== actorId) {
    throw new Error('Reload challenge progress before starting another run.');
  }
  const signature = JSON.stringify([actorId, challengeKey, catalog.currentInstance.id, catalog.revision]);
  // An uncertain write may already have committed, including before midnight.
  // Its retry must retain the original date/zone/UUID even if the current read
  // has advanced. SQL checks the stored request before today's date or CAS.
  if (previous?.signature === signature) return previous;
  if (activation.currentInstance?.id !== catalog.currentInstance.id || activation.revision !== catalog.revision
    || activation.currentInstance.status !== 'completed' || activation.reviewRequired
    || activation.timeZone !== catalog.currentInstance.timeZone
    || activation.timeZone !== activation.currentInstance.timeZone || !isInstanceDate(activation.serverDate)) {
    throw new Error('Reload challenge progress before starting another run.');
  }
  const timeZone = activation.timeZone;
  if (typeof timeZone !== 'string' || !timeZone) throw new Error('Choose a valid time zone.');
  try { new Intl.DateTimeFormat('en-US', { timeZone }); } catch { throw new Error('Choose a valid time zone.'); }
  const requestId = createRequestId?.();
  if (typeof requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(requestId)) {
    throw new Error('A safe challenge request could not be created. Refresh and try again.');
  }
  return Object.freeze({ signature, challengeKey, expectedUserId: actorId,
    expectedInstanceId: catalog.currentInstance.id, expectedRevision: catalog.revision,
    requestId, timeZone, startDate: activation.serverDate });
}
