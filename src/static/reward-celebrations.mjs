import { createDocumentDeliveryToken } from './celebration-delivery-token.mjs';

const safeKey = (value) => /^[a-z0-9][a-z0-9_.:-]*$/.test(String(value || '')) ? String(value) : '';
const safeArtwork = (value) => /^\.\/images\/[a-z0-9._-]+\.(?:jpg|jpeg|png|webp)$/i.test(String(value || '')) ? value : null;
const cleanText = (value, fallback = '') => String(value || fallback).slice(0, 600);

export function rewardCelebrationHref(key = '') {
  return `./badges-rewards.html${safeKey(key) ? `?reward=${encodeURIComponent(key)}` : ''}#rewards`;
}

export { rewardKeyFromLocation } from './reward-link-contract.mjs';

export function normalizeRewardCelebration(reward = {}) {
  if (!safeKey(reward.key) || reward.stateModel !== 'ownership' || reward.status !== 'owned') return null;
  const milestone = Number(reward.celebrationMilestonePoints);
  return {
    key: reward.key,
    title: cleanText(reward.title, 'New reward'),
    description: cleanText(reward.description, 'A new reward has been added to your collection.'),
    rewardType: cleanText(reward.rewardType, 'reward'),
    icon: /^[a-z][a-z0-9-]*$/.test(reward.icon || '') ? reward.icon : 'gift',
    artwork: safeArtwork(reward.metadata?.thumbnailUrl),
    artworkAlt: cleanText(reward.metadata?.thumbnailAlt, ''),
    ownedAt: reward.ownedAt || null,
    sortOrder: Number(reward.sortOrder) || 0,
    sourceType: cleanText(reward.celebrationSourceType),
    milestonePoints: Number.isInteger(milestone) && milestone > 0 ? milestone : null,
  };
}

export function buildRewardCelebrationItems({ rewards = [], claimToken, recovery = false, owner } = {}) {
  const byKey = new Map();
  rewards.forEach((reward) => {
    const normalized = normalizeRewardCelebration(reward);
    if (normalized && !byKey.has(normalized.key)) byKey.set(normalized.key, normalized);
  });
  const ordered = [...byKey.values()].sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key));
  if (!ordered.length) return [];
  const catchUp = recovery || ordered.some((item) => ['backfill', 'catalog_threshold', 'migration'].includes(item.sourceType));
  const groups = catchUp && ordered.length > 1 ? [ordered] : ordered.map((item) => [item]);
  return groups.map((group) => ({
    id: `permanent-reward:${group.map((item) => `${item.key}:${item.ownedAt || 'owned'}`).join('|')}`,
    kind: 'permanentReward',
    owner,
    claimToken,
    rewardKeys: group.map((item) => item.key),
    rewards: group,
    consolidated: group.length > 1,
    href: rewardCelebrationHref(group.length === 1 ? group[0].key : ''),
  }));
}

// Delivery is acknowledged separately from ownership. A token survives reloads
// in this tab, while acknowledged dismissals are durably queued for retry.
export function createRewardCelebrationRecovery({
  claim,
  acknowledge,
  sessionStorage,
  storage,
  isCurrentOwner,
  deliveryToken = createDocumentDeliveryToken({ sessionStorage, namespace: 'permanentReward' }),
  onError = () => {},
} = {}) {
  const inflight = new Map();
  const memory = new Map();
  const storageKey = (owner, suffix) => `dominion:rewardCelebrations:${encodeURIComponent(owner.userId)}:${suffix}`;
  const read = (store, key, fallback) => {
    try { return JSON.parse(store?.getItem(key) || 'null') || memory.get(key) || fallback; } catch { return memory.get(key) || fallback; }
  };
  const write = (store, key, value) => {
    memory.set(key, value);
    try { store?.setItem(key, JSON.stringify(value)); } catch { /* Server unseen state remains recoverable. */ }
  };
  const pendingFor = (owner) => {
    const prefix = storageKey(owner, 'ack:');
    const keys = new Set([...memory.keys()].filter((key) => key.startsWith(prefix)));
    try {
      for (let index = 0; index < (storage?.length || 0); index += 1) {
        const key = storage.key(index);
        if (key?.startsWith(prefix)) keys.add(key);
      }
    } catch { /* In-memory retries still work when storage is blocked. */ }
    return [...keys].map((key) => ({ key, ...read(storage, key, {}) }))
      .filter((item) => item.id && item.claimToken && Array.isArray(item.rewardKeys));
  };
  const flush = async (owner) => {
    if (!isCurrentOwner(owner)) return;
    for (const pending of pendingFor(owner)) {
      if (!isCurrentOwner(owner)) return;
      try {
        const acknowledgedKeys = new Set();
        for (let offset = 0; offset < pending.rewardKeys.length; offset += 100) {
          if (!isCurrentOwner(owner)) return;
          const result = await acknowledge({ expectedUserId: owner.userId, claimToken: pending.claimToken, rewardKeys: pending.rewardKeys.slice(offset, offset + 100) });
          (result?.acknowledgedKeys || []).forEach((key) => acknowledgedKeys.add(key));
        }
        if (!isCurrentOwner(owner)) return;
        if (pending.rewardKeys.every((key) => acknowledgedKeys.has(key))) {
          memory.delete(pending.key);
          try { storage?.removeItem(pending.key); } catch { /* No persisted acknowledgement to remove. */ }
        }
      } catch (error) { onError(error); }
    }
  };
  return {
    async collect(owner, { recovery = true } = {}) {
      if (!owner?.userId || !isCurrentOwner(owner)) return [];
      if (inflight.has(owner.userId)) return [];
      const operation = (async () => {
        await flush(owner);
        if (!isCurrentOwner(owner)) return [];
        try {
          const claimToken = await deliveryToken.get(owner.userId);
          if (!isCurrentOwner(owner)) return [];
          const result = await claim({ expectedUserId: owner.userId, claimToken });
          if (!isCurrentOwner(owner)) return [];
          const locallyDismissed = new Set(pendingFor(owner).flatMap((item) => item.rewardKeys));
          return buildRewardCelebrationItems({
            rewards: (result.claimedUnlocks || []).filter((item) => !locallyDismissed.has(item.key)),
            claimToken, recovery, owner,
          });
        } catch (error) { onError(error); return []; }
      })();
      inflight.set(owner.userId, operation);
      try { return await operation; } finally { inflight.delete(owner.userId); }
    },
    complete(item, reason) {
      if (['cleared', 'replaced'].includes(reason) || !isCurrentOwner(item.owner)) return;
      const key = storageKey(item.owner, `ack:${encodeURIComponent(item.id)}`);
      write(storage, key, { id: item.id, claimToken: item.claimToken, rewardKeys: item.rewardKeys });
      void flush(item.owner);
    },
    release() { deliveryToken.release(); },
  };
}
