import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRewardCelebrationItems, createRewardCelebrationRecovery, normalizeRewardCelebration, rewardCelebrationHref, rewardKeyFromLocation } from './reward-celebrations.mjs';
import { claimPreviewRewardCelebrations, acknowledgePreviewRewardCelebrations } from './reward-celebration-preview.mjs';
import { buildMockRewardCatalog } from './reward-catalog.mjs';

const owner = { userId: 'a', epoch: 1 };
const token = '10000000-0000-4000-8000-000000000001';
const otherToken = '10000000-0000-4000-8000-000000000002';
const deliveryToken = { get: async () => token, release() {} };
const reward = (key = 'theme', extra = {}) => ({ key, stateModel: 'ownership', status: 'owned', title: 'Night theme', ownedAt: '2026-09-13Z', ...extra });
const store = () => {
  const data = new Map();
  return { get length() { return data.size; }, key: (index) => [...data.keys()][index], getItem: (key) => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('only authoritative permanent ownership is eligible, including future types', () => {
  assert.equal(normalizeRewardCelebration(reward('x', { status: 'locked', currentPoints: 9999 })), null);
  assert.equal(normalizeRewardCelebration(reward('x', { stateModel: 'challenge_lifecycle' })), null);
  for (const rewardType of ['partner_discount', 'merch_discount', 'digital_download', 'cosmetic', 'future_type']) {
    assert.equal(normalizeRewardCelebration(reward('x', { rewardType })).rewardType, rewardType);
  }
});
test('safe links/artwork and genuine milestone snapshots only', () => {
  assert.equal(rewardCelebrationHref('x'), './badges-rewards.html?reward=x#rewards');
  assert.equal(rewardKeyFromLocation({ href: 'https://app.test/badges-rewards?reward=x#rewards' }), 'x');
  assert.equal(rewardKeyFromLocation({ href: 'https://app.test/?reward=%3Cscript%3E' }), '');
  const item = normalizeRewardCelebration(reward('x', { icon: '"onclick', pointsRequired: 900, metadata: { thumbnailUrl: 'https://evil.test/a.png' } }));
  assert.equal(item.icon, 'gift'); assert.equal(item.artwork, null); assert.equal(item.milestonePoints, null);
  assert.equal(normalizeRewardCelebration(reward('x', { celebrationMilestonePoints: 42 })).milestonePoints, 42);
});
test('catalog ordering, deduplication and one consolidated recovery/backfill', () => {
  const rewards = [reward('b', { sortOrder: 2 }), reward('a', { sortOrder: 1 }), reward('b')];
  assert.deepEqual(buildRewardCelebrationItems({ rewards, owner }).map((item) => item.rewardKeys), [['a'], ['b']]);
  const [catchup] = buildRewardCelebrationItems({ rewards, recovery: true, owner });
  assert.equal(catchup.consolidated, true); assert.deepEqual(catchup.rewardKeys, ['a', 'b']);
  assert.equal(catchup.href, './badges-rewards.html#rewards');
  assert.equal(buildRewardCelebrationItems({ rewards: [reward('a'), reward('b', { celebrationSourceType: 'migration' })] }).length, 1);
});
test('preview threshold minus one/exact ownership feeds claims without point inference', () => {
  const definitions = [{ key: 'x', rewardType: 'cosmetic', stateModel: 'ownership', pointsRequired: 42 }];
  const below = buildMockRewardCatalog({ progression: { totalPoints: 41 }, rewardDefinitions: definitions }).catalog;
  const exact = buildMockRewardCatalog({ progression: { totalPoints: 42 }, rewardDefinitions: definitions }).catalog;
  assert.equal(claimPreviewRewardCelebrations({ catalog: below, claimToken: token }).claimedUnlocks.length, 0);
  assert.equal(claimPreviewRewardCelebrations({ catalog: exact, claimToken: token }).claimedUnlocks[0].celebrationMilestonePoints, 42);
});
test('preview leases prevent second-device delivery until expiry; same token recovers interrupted response', () => {
  const catalog = { items: [reward()] };
  const first = claimPreviewRewardCelebrations({ catalog, claimToken: token, now: 0 });
  assert.equal(claimPreviewRewardCelebrations({ catalog, leases: first.leases, claimToken: otherToken, now: 1 }).claimedUnlocks.length, 0);
  assert.equal(claimPreviewRewardCelebrations({ catalog, leases: first.leases, claimToken: token, now: 1 }).claimedUnlocks.length, 1);
  assert.equal(claimPreviewRewardCelebrations({ catalog, leases: first.leases, claimToken: otherToken, now: 900001 }).claimedUnlocks.length, 1);
  const records = [{ key: 'theme', ownedAt: 'historical', celebrationSeenAt: null }];
  assert.equal(acknowledgePreviewRewardCelebrations({ ownershipRecords: records, leases: first.leases, claimToken: otherToken, rewardKeys: ['theme'] }).acknowledgedKeys.length, 0);
  const ack = acknowledgePreviewRewardCelebrations({ ownershipRecords: records, leases: first.leases, claimToken: token, rewardKeys: ['theme'] });
  assert.equal(ack.ownershipRecords[0].ownedAt, 'historical');
  assert.deepEqual(ack.acknowledgedKeys, ['theme']);
  assert.deepEqual(acknowledgePreviewRewardCelebrations({ ownershipRecords: ack.ownershipRecords, claimToken: token, rewardKeys: ['theme'] }).acknowledgedKeys, ['theme']);
});
test('reload before dismissal recovers same token; dismissal retries durably after offline failure', async () => {
  const sessionStorage = store(); const storage = store(); const calls = []; let offline = true; let seen = false;
  const deps = { sessionStorage, storage, isCurrentOwner: () => true, deliveryToken,
    claim: async (args) => { calls.push(args); return { claimedUnlocks: seen ? [] : [reward()] }; },
    acknowledge: async () => { if (offline) throw new Error('offline'); seen = true; return { acknowledgedKeys: ['theme'] }; },
  };
  const initial = createRewardCelebrationRecovery(deps);
  const [item] = await initial.collect(owner);
  const recovered = createRewardCelebrationRecovery(deps);
  assert.equal((await recovered.collect(owner))[0].claimToken, item.claimToken);
  recovered.complete(item, 'continue'); await tick();
  assert.equal((await recovered.collect(owner)).length, 0, 'local dismissal suppresses offline replays');
  offline = false;
  assert.equal((await createRewardCelebrationRecovery(deps).collect(owner)).length, 0);
  assert.equal(seen, true); assert.ok(calls.every((call) => call.expectedUserId === owner.userId));
});
test('stale actor responses and cleared/replaced overlays never acknowledge', async () => {
  let current = true; let resolve; let acknowledgements = 0;
  const recovery = createRewardCelebrationRecovery({ sessionStorage: store(), storage: store(), deliveryToken,
    isCurrentOwner: () => current, claim: () => new Promise((done) => { resolve = done; }),
    acknowledge: async () => { acknowledgements += 1; },
  });
  const pending = recovery.collect(owner); await tick(); current = false; resolve({ claimedUnlocks: [reward()] });
  assert.deepEqual(await pending, []);
  const [item] = buildRewardCelebrationItems({ rewards: [reward()], owner });
  recovery.complete(item, 'continue'); current = true;
  recovery.complete(item, 'cleared'); recovery.complete(item, 'replaced'); await tick();
  assert.equal(acknowledgements, 0);
});
test('blocked browser storage still attempts acknowledgement with an in-memory retry', async () => {
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  let acknowledgements = 0;
  const recovery = createRewardCelebrationRecovery({ sessionStorage: blocked, storage: blocked, isCurrentOwner: () => true,
    deliveryToken, claim: async () => ({ claimedUnlocks: [reward()] }),
    acknowledge: async () => { acknowledgements += 1; return { acknowledgedKeys: ['theme'] }; },
  });
  recovery.complete((await recovery.collect(owner))[0], 'continue'); await tick();
  assert.equal(acknowledgements, 1);
});
