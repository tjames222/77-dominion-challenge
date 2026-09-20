// Retain a retry token across reloads, but never let duplicated tabs use the
// same token concurrently (sessionStorage is copied when a tab is duplicated).
export function createDocumentDeliveryToken({ sessionStorage, namespace, locks = globalThis.navigator?.locks }) {
  if (!/^[a-z][a-zA-Z]+$/.test(namespace)) throw new TypeError('A delivery namespace is required.');
  const tokenPromises = new Map();
  const releases = new Set();
  let epoch = 0;
  return {
    get(actorId) {
      if (!actorId) return Promise.reject(new TypeError('A delivery actor is required.'));
      if (tokenPromises.has(actorId)) return tokenPromises.get(actorId);
      const requestedEpoch = epoch;
      const promise = (async () => {
        const tokenKey = `dominion:${namespace}Claim:${actorId}`;
        let token;
        try { token = sessionStorage.getItem(tokenKey); } catch { /* Private browsing can deny storage. */ }
        if (typeof token !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) token = crypto.randomUUID();
        if (locks?.request) {
          const acquire = (candidate) => new Promise((resolve) => {
            let release;
            const held = new Promise((done) => { release = done; });
            void locks.request(`dominion:${namespace}Presenter:${actorId}:${candidate}`, { ifAvailable: true }, async (lock) => {
              if (requestedEpoch !== epoch) { resolve(false); return; }
              resolve(Boolean(lock));
              if (lock) { releases.add(release); await held; releases.delete(release); }
            }).catch(() => resolve(false));
          });
          if (!await acquire(token)) {
            token = crypto.randomUUID();
            if (!await acquire(token)) throw Error('Celebration presentation is unavailable.');
          }
        } else {
          // No document locks: use a fresh page token. Older claims remain
          // recoverable after their bounded server lease, without duplicate UI.
          token = crypto.randomUUID();
        }
        if (requestedEpoch !== epoch) throw Error('Celebration owner changed.');
        try { sessionStorage.setItem(tokenKey, token); } catch { /* Retain this document's token in memory. */ }
        return token;
      })();
      tokenPromises.set(actorId, promise);
      void promise.catch(() => { if (tokenPromises.get(actorId) === promise) tokenPromises.delete(actorId); });
      return promise;
    },
    release() {
      epoch += 1;
      for (const release of releases) release();
      releases.clear(); tokenPromises.clear();
    },
  };
}
