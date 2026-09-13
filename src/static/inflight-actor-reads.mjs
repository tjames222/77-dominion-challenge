const staleRead = () => Object.assign(new Error('The account or data changed. Please try again.'), {
  code: 'STALE_ACTOR_READ',
});

// Coalesce only pending presentation reads, never authorization or mutations.
// Nothing survives settlement; caller-owned result copies cannot contaminate a
// second consumer. Epochs fence delayed A→B→A responses even when IDs match again.
export function createInflightActorReads() {
  let epoch = 0;
  let authKnown = false;
  let authActor = '';
  const pending = new Map();
  const queryEpochs = new Map();

  const invalidate = (query = '') => {
    if (query) {
      queryEpochs.set(query, (queryEpochs.get(query) || 0) + 1);
      for (const [key, entry] of pending) if (entry.query === query) pending.delete(key);
    } else {
      epoch += 1;
      pending.clear();
      queryEpochs.clear();
    }
  };

  const observeAuth = (event, actorId = '') => {
    const nextActor = String(actorId || '');
    const initialMatches = !authKnown && event === 'INITIAL_SESSION'
      && [...pending.values()].every((entry) => entry.actorId === nextActor);
    if (!initialMatches && (!authKnown || authActor !== nextActor
      || ['SIGNED_OUT', 'TOKEN_REFRESHED', 'USER_UPDATED', 'PASSWORD_RECOVERY'].includes(event))) invalidate();
    authKnown = true;
    authActor = nextActor;
  };

  const run = ({ actorId, query, version, args = [] }, read) => {
    if (!actorId || !query || !version || typeof read !== 'function') {
      throw new TypeError('An actor, query, contract version and authoritative read are required.');
    }
    const readEpoch = epoch;
    const queryEpoch = queryEpochs.get(query) || 0;
    const isCurrent = () => readEpoch === epoch && queryEpoch === (queryEpochs.get(query) || 0);
    const key = JSON.stringify([readEpoch, queryEpoch, actorId, query, version, args]);
    let entry = pending.get(key);
    if (!entry) {
      const promise = Promise.resolve().then(() => {
        if (!isCurrent()) throw staleRead();
        return read();
      }).then((result) => {
        if (!isCurrent()) throw staleRead();
        return result;
      }).finally(() => {
        if (pending.get(key)?.promise === promise) pending.delete(key);
      });
      entry = { actorId, query, promise };
      pending.set(key, entry);
    }
    return entry.promise.then((result) => {
      if (!isCurrent()) throw staleRead();
      return structuredClone(result);
    });
  };

  return { run, invalidate, observeAuth };
}
