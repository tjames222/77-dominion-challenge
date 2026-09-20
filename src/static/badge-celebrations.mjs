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
