import { createDocumentDeliveryToken } from './celebration-delivery-token.mjs';

// A dismissal is recorded locally before its server acknowledgment. Lost
// responses and offline reloads retry the acknowledgment, not the presentation.
export function createBadgeCelebrationRecovery({ claim, acknowledge, storage, sessionStorage, isCurrentOwner, locks = globalThis.navigator?.locks }) {
  const pendingMemory = new Map();
  const flushes = new Map();
  const deliveryToken = createDocumentDeliveryToken({ sessionStorage, namespace: 'badge', locks });
  const key = (owner) => `dominion:badgePendingAck:${owner.userId}`;
  const read = (owner) => {
    if (pendingMemory.has(owner.userId)) return pendingMemory.get(owner.userId);
    try {
      const value = JSON.parse(storage.getItem(key(owner)) || '[]');
      if (Array.isArray(value)) return value.filter((row) => typeof row?.awardId === 'string' && typeof row.claimToken === 'string');
    } catch { /* Retain this page's pending acknowledgments when storage fails. */ }
    return pendingMemory.get(owner.userId) || [];
  };
  const write = (owner, rows) => {
    try { storage.setItem(key(owner), JSON.stringify(rows)); pendingMemory.delete(owner.userId); }
    catch { pendingMemory.set(owner.userId, rows); }
  };
  const tokenFor = (owner) => {
    if (tokenPromises.has(owner.userId)) return tokenPromises.get(owner.userId);
    const promise = (async () => {
      const tokenKey = `dominion:badgeClaim:${owner.userId}`;
      let token = sessionStorage.getItem(tokenKey) || crypto.randomUUID();
      if (locks?.request) {
        // Duplicating a tab copies sessionStorage. A document-held lock keeps
        // the copied claim token from being reused by two live presenters.
        const acquire = (candidate) => new Promise((resolve) => {
          let release;
          const held = new Promise((done) => { release = done; });
          void locks.request(`dominion:badgePresenter:${owner.userId}:${candidate}`, { ifAvailable: true }, async (lock) => {
            resolve(Boolean(lock));
            if (lock) { releases.add(release); await held; releases.delete(release); }
          }).catch(() => resolve(false));
        });
        if (!await acquire(token)) { token = crypto.randomUUID(); if (!await acquire(token)) throw Error('Badge presentation is unavailable.'); }
      } else {
        // Without document locks a fresh token is safe; any old lease recovers
        // after the server's bounded two-minute timeout.
        token = crypto.randomUUID();
      }
      sessionStorage.setItem(tokenKey, token);
      return token;
    })();
    tokenPromises.set(owner.userId, promise);
    return promise;
  };
  const flush = (owner) => {
    if (!isCurrentOwner(owner)) return Promise.resolve();
    if (flushes.has(owner.userId)) return flushes.get(owner.userId);
    const job = (async () => {
      for (const row of read(owner)) {
        if (!isCurrentOwner(owner)) return;
        try {
          await acknowledge({ expectedUserId: owner.userId, claimToken: row.claimToken, awardIds: [row.awardId] });
        } catch { return; }
        if (!isCurrentOwner(owner)) return;
        write(owner, read(owner).filter((item) => item.awardId !== row.awardId || item.claimToken !== row.claimToken));
      }
    })().finally(() => flushes.delete(owner.userId));
    flushes.set(owner.userId, job);
    return job;
  };
  return {
    async collect(owner) {
      if (!owner || !isCurrentOwner(owner)) return [];
      await flush(owner);
      if (!isCurrentOwner(owner)) return [];
      let claimToken;
      try { claimToken = await deliveryToken.get(owner.userId); } catch { return []; }
      if (!isCurrentOwner(owner)) return [];
      const result = await claim({ expectedUserId: owner.userId, claimToken });
      if (!isCurrentOwner(owner)) return [];
      const pending = new Set(read(owner).map((row) => row.awardId));
      return result.badges.filter((badge) => !pending.has(badge.awardId))
        .map((badge) => ({ ...badge, claimToken, claimOwner: owner }));
    },
    complete(badge, reason) {
      const owner = badge?.claimOwner;
      if (['cleared', 'replaced'].includes(reason) || !badge?.claimToken || !badge.awardId || !isCurrentOwner(owner)) return Promise.resolve();
      const rows = read(owner).filter((row) => row.awardId !== badge.awardId);
      rows.push({ awardId: badge.awardId, claimToken: badge.claimToken });
      write(owner, rows);
      return flush(owner);
    },
    release() { deliveryToken.release(); },
  };
}
