const DATABASE = 'dominion-preview-delivery-v1';
const STORE = 'deliveries';
const unavailable = () => new Error('Preview delivery is temporarily unavailable. Reload and try again.');
const validateStore = store => {
  if (!Array.isArray(store.keyPath) || store.keyPath.length !== 3
    || store.keyPath.some((key, index) => key !== ['actorId', 'kind', 'itemId'][index])
    || store.autoIncrement !== false) throw unavailable();
};

function deliveryRow(value, actorId, kind, itemId) {
  if (!value || value.version !== 1 || value.actorId !== actorId || value.kind !== kind || value.itemId !== itemId
    || (value.seenAt !== null && typeof value.seenAt !== 'string')
    || (value.claimToken !== null && typeof value.claimToken !== 'string')
    || (value.leaseUntil !== null && !Number.isFinite(value.leaseUntil))) throw unavailable();
  return { version: 1, actorId, kind, itemId, seenAt: value.seenAt, claimToken: value.claimToken, leaseUntil: value.leaseUntil };
}

// Cache a connection, never an actor or private result. Native transactions,
// not localStorage mirrors or WebLock timing, own delivery synchronization.
export function createPreviewDeliveryLedger({ indexedDB = globalThis.indexedDB, timeoutMs = 10000, now = () => Date.now() } = {}) {
  let connection;
  let opening;
  const open = () => {
    if (connection) return Promise.resolve(connection);
    if (opening) return opening;
    const pending = new Promise((resolve, reject) => {
      let request;
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(unavailable());
      };
      const timer = setTimeout(fail, timeoutMs);
      try { request = indexedDB.open(DATABASE, 1); } catch { fail(); return; }
      request.onblocked = fail;
      request.onerror = fail;
      request.onupgradeneeded = () => {
        if (settled) { request.transaction.abort(); return; }
        try { request.result.createObjectStore(STORE, { keyPath: ['actorId', 'kind', 'itemId'] }); }
        catch { request.transaction.abort(); fail(); }
      };
      request.onsuccess = () => {
        const db = request.result;
        if (settled) { db.close(); return; }
        try {
          if (db.version !== 1 || !db.objectStoreNames.contains(STORE)) throw unavailable();
          validateStore(db.transaction(STORE, 'readonly').objectStore(STORE));
        } catch { db.close(); fail(); return; }
        settled = true;
        clearTimeout(timer);
        connection = db;
        db.onversionchange = () => { db.close(); if (connection === db) connection = undefined; };
        db.onclose = () => { if (connection === db) connection = undefined; };
        resolve(db);
      };
    });
    opening = pending;
    const clearOpening = () => { if (opening === pending) opening = undefined; };
    pending.then(clearOpening, clearOpening);
    return pending;
  };

  return {
    async transact({ actorId, kind, seeds = [], receiptIds = [], assertCurrent, verifyOwner, reduce }) {
      if (typeof actorId !== 'string' || !actorId.trim() || !['badge', 'reward'].includes(kind)
        || typeof assertCurrent !== 'function' || typeof verifyOwner !== 'function' || typeof reduce !== 'function') throw unavailable();
      // Snapshot caller inputs before the first await. Empty delivery records
      // are authoritative too; legacy data is used only for an absent row.
      const initial = new Map();
      for (const seed of seeds) {
        if (typeof seed.itemId !== 'string' || !seed.itemId.trim()) throw unavailable();
        if (!initial.has(seed.itemId)) initial.set(seed.itemId, deliveryRow({ ...seed, version: 1, actorId, kind }, actorId, kind, seed.itemId));
      }
      const ids = new Set(initial.keys());
      for (const id of receiptIds) {
        if (typeof id !== 'string' || !id.trim()) throw unavailable();
        ids.add(id);
      }
      assertCurrent();
      const db = await open();
      await verifyOwner();
      assertCurrent();
      const result = await new Promise((resolve, reject) => {
        let transaction;
        let result;
        let failure;
        let settled = false;
        const rows = new Map();
        const abort = (error = unavailable()) => {
          failure ||= error;
          try { transaction?.abort(); } catch { /* Already complete: result still remains fenced. */ }
          if (!settled) { settled = true; clearTimeout(timer); reject(failure); }
        };
        const timer = setTimeout(() => abort(), timeoutMs);
        try { transaction = db.transaction(STORE, 'readwrite'); }
        catch { abort(); return; }
        transaction.onerror = () => { failure ||= unavailable(); };
        transaction.onabort = () => abort(failure || unavailable());
        transaction.oncomplete = () => {
          if (settled) return;
          try { assertCurrent(); } catch (error) { abort(error); return; }
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        let store;
        try { store = transaction.objectStore(STORE); validateStore(store); } catch { abort(); return; }
        const apply = () => {
          if (settled) return;
          try {
            assertCurrent();
            result = reduce(rows, now());
            if (result && typeof result.then === 'function') throw unavailable();
            assertCurrent();
            for (const [id, row] of rows) {
              if (!ids.has(id) || (!initial.has(id) && !row.seenAt)) throw unavailable();
              // Unknown receipt IDs never create a row. Known seen receipts
              // may serve an idempotent retry without a stale source award.
              const value = deliveryRow(row, actorId, kind, id);
              const request = store.put(value);
              request.onerror = () => { failure ||= unavailable(); };
            }
          } catch (error) { abort(error); }
        };
        if (!ids.size) { apply(); return; }
        let remaining = ids.size;
        for (const id of ids) {
          const request = store.get([actorId, kind, id]);
          request.onerror = () => { failure ||= unavailable(); };
          request.onsuccess = () => {
            if (settled) return;
            try {
              assertCurrent();
              if (request.result !== undefined) {
                const row = deliveryRow(request.result, actorId, kind, id);
                if (initial.has(id) || row.seenAt) rows.set(id, row);
              } else if (initial.has(id)) rows.set(id, { ...initial.get(id) });
              if (--remaining === 0) apply();
            } catch (error) { abort(error); }
          };
        }
      });
      await verifyOwner();
      assertCurrent();
      return result;
    },
  };
}

export const previewDeliveryLedger = createPreviewDeliveryLedger();

export function badgeDeliverySeeds(awards) {
  return awards.map(award => ({ itemId: award.awardId || award.id,
    seenAt: award.celebrationSeenAt || null, claimToken: award.celebrationClaimToken || null,
    leaseUntil: award.celebrationClaimUntil ? Date.parse(award.celebrationClaimUntil) : null }));
}

export function overlayBadgeDelivery(awards, rows) {
  for (const award of awards) {
    const row = rows.get(award.awardId || award.id);
    award.celebrationSeenAt = row.seenAt;
    award.celebrationClaimToken = row.claimToken;
    award.celebrationClaimUntil = row.leaseUntil === null ? null : new Date(row.leaseUntil).toISOString();
  }
}

export function saveBadgeDelivery(awards, rows) {
  for (const seed of badgeDeliverySeeds(awards)) Object.assign(rows.get(seed.itemId), seed);
}

export function rewardDeliverySeeds(catalog, leases = {}) {
  return catalog.items.filter(reward => reward.stateModel === 'ownership' && reward.status === 'owned')
    .map(reward => {
      const lease = Object.hasOwn(leases, reward.key) ? leases[reward.key] : null;
      return { itemId: reward.key, seenAt: reward.celebrationSeenAt || null,
        claimToken: lease?.claimToken || null, leaseUntil: lease?.leaseUntil ?? null };
    });
}

export function overlayRewardDelivery(catalog, rows) {
  const leases = Object.create(null);
  for (const reward of catalog.items) {
    const row = rows.get(reward.key);
    if (!row || reward.stateModel !== 'ownership' || reward.status !== 'owned') continue;
    reward.celebrationSeenAt = row.seenAt;
    if (row.claimToken) leases[reward.key] = { claimToken: row.claimToken, leaseUntil: row.leaseUntil };
  }
  return leases;
}

export function saveRewardDelivery(ownershipRecords, leases, rows) {
  for (const [id, row] of rows) {
    const record = ownershipRecords.find(item => item.key === id);
    // An old receipt remains valid even when the current catalog omits it.
    if (!record && !Object.hasOwn(leases, id)) continue;
    if (record?.celebrationSeenAt) row.seenAt = record.celebrationSeenAt;
    row.claimToken = leases[id]?.claimToken || null;
    row.leaseUntil = leases[id]?.leaseUntil ?? null;
  }
}
