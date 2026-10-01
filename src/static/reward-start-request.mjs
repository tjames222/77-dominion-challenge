// Start request identities are UI retry state, not permission. The actor-bound
// catalog enables the control; the RPC independently enforces actor/run/CAS.
export function prepareRewardStartRequest({ catalog, actorId, challengeKey, previous = null,
  createRequestId, timeZone = 'UTC' } = {}) {
  const allowed = catalog?.schemaVersion === 2 && catalog.actorId === actorId
    && catalog.currentInstance?.status === 'completed' && !catalog.currentInstance.reviewRequired
    && Number.isSafeInteger(catalog.revision) && catalog.revision >= 0
    && (challengeKey === 'original_77' ? catalog.originalRepeat?.canStart === true
      : catalog.items?.some(reward => reward.key === challengeKey && reward.allowedActions?.includes('start')));
  if (!allowed) throw new Error('Reload challenge progress before starting another run.');
  try { new Intl.DateTimeFormat('en-US', { timeZone }); } catch { throw new Error('Choose a valid time zone.'); }
  const signature = JSON.stringify([actorId, challengeKey, catalog.currentInstance.id, catalog.revision]);
  if (previous?.signature === signature) return previous;
  const requestId = createRequestId?.();
  if (typeof requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(requestId)) {
    throw new Error('A safe challenge request could not be created. Refresh and try again.');
  }
  return Object.freeze({ signature, challengeKey, expectedUserId: actorId,
    expectedInstanceId: catalog.currentInstance.id, expectedRevision: catalog.revision,
    requestId, timeZone, startDate: null });
}
