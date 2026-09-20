export const REWARD_CELEBRATION_LEASE_MS = 15 * 60 * 1000;
const assertToken = (token) => {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(String(token || ''))) {
    throw new Error('A valid reward delivery token is required.');
  }
};

// Preview delivery uses the same owned/unseen/lease contract as the RPC, never
// a client-side point comparison. Catalog reconciliation remains the authority.
export function claimPreviewRewardCelebrations({ catalog, leases = {}, claimToken, now = Date.now() }) {
  assertToken(claimToken);
  const next = { ...leases };
  const claimedUnlocks = (catalog.items || []).filter((reward) => {
    if (reward.stateModel !== 'ownership' || reward.status !== 'owned' || reward.celebrationSeenAt) return false;
    const lease = next[reward.key];
    if (lease && lease.claimToken !== claimToken && lease.leaseUntil > now) return false;
    next[reward.key] = { claimToken, leaseUntil: now + REWARD_CELEBRATION_LEASE_MS };
    return true;
  });
  return { claimedUnlocks, leases: next };
}

export function acknowledgePreviewRewardCelebrations({ ownershipRecords = [], leases = {}, claimToken, rewardKeys = [], now = Date.now() }) {
  assertToken(claimToken);
  const next = { ...leases };
  const acknowledgedKeys = [];
  const records = ownershipRecords.map((record) => {
    if (!rewardKeys.includes(record.key)) return record;
    if (record.celebrationSeenAt) {
      acknowledgedKeys.push(record.key);
      return record;
    }
    if (next[record.key]?.claimToken !== claimToken) return record;
    acknowledgedKeys.push(record.key);
    delete next[record.key];
    return { ...record, celebrationSeenAt: new Date(now).toISOString() };
  });
  return { ownershipRecords: records, leases: next, acknowledgedKeys };
}
