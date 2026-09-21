import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreviewDeliveryLedger, badgeDeliverySeeds, overlayBadgeDelivery, saveBadgeDelivery,
  rewardDeliverySeeds, overlayRewardDelivery, saveRewardDelivery } from './preview-delivery-ledger.mjs';
import { normalizePreviewBadgeState, claimPreviewBadgeCelebrations, acknowledgePreviewBadgeCelebrations } from './badge-preview-state.mjs';
import { claimPreviewRewardCelebrations, acknowledgePreviewRewardCelebrations } from './reward-celebration-preview.mjs';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { buildMockRewardCatalog, claimMockRewardEntitlementUnlocks } from './reward-catalog.mjs';

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const tick = async () => { for (let count = 0; count < 30; count += 1) await Promise.resolve(); };
const copy = value => value === undefined ? undefined : structuredClone(value);
const unavailable = /Preview delivery is temporarily unavailable/;

// A deterministic transaction lifecycle double, not browser conformance proof.
// Native Chromium/WebKit tests independently cover real IDB queue/abort/storage.
function database(options = {}) {
  const values = new Map();
  let tail = Promise.resolve();
  let opens = 0;
  let closed = 0;
  const db = { version: 1, objectStoreNames: { contains: () => options.missingStore !== true }, close: () => { closed += 1; },
    transaction(_name, mode) {
      let done = false; let pending = 0; let started = false;
      const staged = new Map();
      const released = deferred();
      const ready = tail;
      tail = released.promise;
      const finish = () => { if (done) return; done = true; released.resolve(); };
      const transaction = { abort() { if (done) throw new Error('inactive'); finish(); queueMicrotask(() => transaction.onabort?.()); } };
      const commit = async () => {
        if (!started || pending || done) return;
        if (mode === 'readwrite' && options.holdCommit) await options.holdCommit;
        if (pending || done) return;
        if (mode === 'readwrite' && options.abortCommit) { transaction.abort(); return; }
        for (const [key, value] of staged) values.set(key, value);
        finish(); transaction.oncomplete?.();
      };
      const request = operation => {
        const item = {};
        pending += 1;
        ready.then(() => queueMicrotask(() => {
          if (done) return;
          try { item.result = operation(); item.onsuccess?.(); }
          catch { item.onerror?.(); transaction.onerror?.(); transaction.abort(); }
          pending -= 1;
          queueMicrotask(commit);
        }));
        return item;
      };
      transaction.objectStore = () => ({
        keyPath: options.keyPath ?? ['actorId', 'kind', 'itemId'], autoIncrement: options.autoIncrement ?? false,
        get: key => request(() => copy(values.get(JSON.stringify(key)))),
        put: row => request(() => {
          if (options.putError) throw new Error('PRIVATE_QUOTA_DETAIL');
          staged.set(JSON.stringify([row.actorId, row.kind, row.itemId]), copy(row)); return row.itemId;
        }),
      });
      ready.then(() => { started = true; queueMicrotask(commit); });
      return transaction;
    },
  };
  return { values, options, db, counts: () => ({ opens, closed }), indexedDB: { open() {
    opens += 1;
    if (options.throwOpen) throw new Error('PRIVATE_DENIED_DETAIL');
    const request = { result: db };
    queueMicrotask(() => {
      if (options.blocked) request.onblocked?.();
      else if (options.holdOpen) options.holdOpen.then(() => request.onsuccess?.());
      else request.onsuccess?.();
    });
    return request;
  } } };
}

function fixture(options = {}) {
  const storage = database(options);
  let current = true; let verifications = 0; let clock = 1000;
  const ledger = createPreviewDeliveryLedger({ indexedDB: storage.indexedDB, timeoutMs: 40, now: () => clock });
  const seed = { itemId: 'award', seenAt: null, claimToken: null, leaseUntil: null };
  const args = (extra = {}) => ({ actorId: 'A', kind: 'badge', seeds: [seed],
    assertCurrent: () => { if (!current) throw new Error('The signed-in account changed. Try again.'); },
    verifyOwner: async () => { verifications += 1; if (!current) throw new Error('The signed-in account changed. Try again.'); },
    reduce: rows => copy(rows.get('award')), ...extra });
  return { storage, ledger, seed, args, clock: value => { clock = value; }, stale: () => { current = false; }, verifications: () => verifications };
}

test('delivery resolves only after transaction completion and preserves first empty import', async () => {
  const hold = deferred(); const f = fixture({ holdCommit: hold.promise }); let returned = false;
  const first = f.ledger.transact(f.args()).then(value => { returned = true; return value; });
  await tick(); assert.equal(returned, false); assert.equal(f.storage.values.size, 0);
  hold.resolve(); const row = await first; assert.equal(row.seenAt, null);
  const second = await f.ledger.transact(f.args({ seeds: [{ ...f.seed, seenAt: 'stale-later-mirror', claimToken: 'stale', leaseUntil: 99999 }] }));
  assert.deepEqual(second, row); assert.equal(f.storage.counts().opens, 1); assert.equal(f.verifications(), 4);
});

test('concurrent transactions share canonical rows and sample lease time after queue wait', async () => {
  const hold = deferred(); const f = fixture({ holdCommit: hold.promise });
  const claim = token => f.ledger.transact(f.args({ reduce: (rows, now) => {
    const row = rows.get('award'); if (row.claimToken && row.leaseUntil > now) return [];
    row.claimToken = token; row.leaseUntil = now + 120000; return [token];
  } }));
  const first = claim('one'); await tick(); f.clock(2000); const second = claim('two'); await tick();
  hold.resolve(); assert.deepEqual(await Promise.all([first, second]), [['one'], []]);
  assert.equal([...f.storage.values.values()][0].leaseUntil, 121000);
  f.clock(121001); assert.deepEqual(await claim('three'), ['three']);
  assert.equal([...f.storage.values.values()][0].leaseUntil, 241001);
});

test('input copy, actor/domain namespace and prototype-shaped keys remain independent', async () => {
  const hold = deferred(); const f = fixture({ holdOpen: hold.promise });
  const seeds = [{ ...f.seed, itemId: '__proto__' }];
  const first = f.ledger.transact(f.args({ seeds, reduce: rows => rows.get('__proto__').itemId }));
  seeds[0].itemId = 'changed'; hold.resolve(); assert.equal(await first, '__proto__');
  for (const actorId of ['A', 'B']) for (const kind of ['badge', 'reward']) {
    await f.ledger.transact(f.args({ actorId, kind, reduce: rows => { rows.get('award').claimToken = `${actorId}:${kind}`; } }));
  }
  assert.equal(f.storage.values.size, 5);
});

test('unknown acknowledgement IDs do not create rows; known seen receipts survive absent candidates', async () => {
  const f = fixture();
  await f.ledger.transact(f.args({ reduce: rows => { rows.get('award').seenAt = 'legacy'; } }));
  const keys = await f.ledger.transact(f.args({ seeds: [], receiptIds: ['award', 'unknown'], reduce: rows => [...rows.keys()] }));
  assert.deepEqual(keys, ['award']); assert.equal(f.storage.values.size, 1);
});

for (const options of [{ throwOpen: true }, { blocked: true }, { missingStore: true }, { keyPath: 'itemId' },
  { keyPath: ['actorId', 'itemId', 'kind'] }, { autoIncrement: true }, { putError: true }, { abortCommit: true }]) {
  test(`storage fails closed without false success or provider text: ${JSON.stringify(options)}`, async () => {
    const f = fixture(options);
    await assert.rejects(f.ledger.transact(f.args()), error => unavailable.test(error.message) && !error.message.includes('PRIVATE'));
    assert.equal(f.storage.values.size, 0);
  });
}

test('failed open is not cached; late timed-out open is closed; explicit retry works', async () => {
  const hold = deferred(); const f = fixture({ holdOpen: hold.promise });
  await assert.rejects(f.ledger.transact(f.args()), unavailable);
  hold.resolve(); await tick(); assert.equal(f.storage.counts().closed, 1);
  delete f.storage.options.holdOpen;
  assert.equal((await f.ledger.transact(f.args())).itemId, 'award'); assert.equal(f.storage.counts().opens, 2);
});

test('owner change while opening or waiting to commit rejects without publishing a result', async () => {
  for (const phase of ['open', 'commit']) {
    const hold = deferred(); const f = fixture({ [phase === 'open' ? 'holdOpen' : 'holdCommit']: hold.promise });
    const pending = f.ledger.transact(f.args()); const rejected = assert.rejects(pending, /account changed/);
    await tick(); f.stale(); hold.resolve(); await rejected;
    if (phase === 'open') assert.equal(f.storage.values.size, 0);
  }
});

test('synchronous guard before reduction and before writes aborts transaction', async () => {
  const f = fixture();
  await assert.rejects(f.ledger.transact(f.args({ reduce: rows => { rows.get('award').seenAt = 'seen'; f.stale(); } })), /account changed/);
  assert.equal(f.storage.values.size, 0);
});

test('async reducers, malformed rows and unauthorized new IDs cannot commit', async () => {
  const f = fixture();
  await assert.rejects(f.ledger.transact(f.args({ reduce: async () => 'no' })), unavailable);
  await assert.rejects(f.ledger.transact(f.args({ reduce: rows => rows.set('invented', { ...rows.get('award'), itemId: 'invented' }) })), unavailable);
  f.storage.values.set(JSON.stringify(['A', 'badge', 'award']), { version: 2 });
  await assert.rejects(f.ledger.transact(f.args()), unavailable);
});

test('actual badge reducers retain token-after-seen and overlay every candidate before maximum-eight selection', async () => {
  const f = fixture();
  const awards = Array.from({ length: 10 }, (_, index) => ({ awardId: `b${index}`, key: `key${index}`, legacy: false, earnedAt: `2026-01-${String(index + 1).padStart(2, '0')}` }));
  const run = (token, ids) => f.ledger.transact(f.args({ seeds: badgeDeliverySeeds(awards), receiptIds: ids || [], reduce: (rows, now) => {
    const state = { awards: copy(awards) }; overlayBadgeDelivery(state.awards, rows);
    const result = ids ? acknowledgePreviewBadgeCelebrations(state, token, ids, now) : claimPreviewBadgeCelebrations(state, token, now);
    saveBadgeDelivery(state.awards, rows); return result;
  } }));
  const first = await run('one'); assert.equal(first.length, 8);
  const second = await run('two'); assert.equal(second.length, 2);
  const ids = first.map(award => award.awardId);
  assert.deepEqual(await run('wrong', ids), []);
  assert.deepEqual(await run('one', ids), ids);
  assert.deepEqual(await run('one', ids), ids);
  const seen = f.storage.values.get(JSON.stringify(['A', 'badge', ids[0]]));
  assert.equal(seen.claimToken, 'one'); assert.equal(seen.leaseUntil, null); assert.ok(seen.seenAt);
});

test('legacy badge sentinel remains seen; reward acknowledgements remove lease without permitting rollback', async () => {
  const legacy = normalizePreviewBadgeState(null, [{ key: 'legacy' }]);
  assert.equal(badgeDeliverySeeds(legacy.awards)[0].seenAt, 'legacy');
  const f = fixture(); const one = '00000000-0000-4000-8000-000000000001'; const two = '00000000-0000-4000-8000-000000000002';
  const catalog = { items: [{ key: 'dominion_night_theme', stateModel: 'ownership', status: 'owned', celebrationSeenAt: null }] };
  const run = (token, ack = false) => f.ledger.transact(f.args({ kind: 'reward', seeds: rewardDeliverySeeds(catalog), reduce: (rows, now) => {
    const fresh = copy(catalog); const leases = overlayRewardDelivery(fresh, rows);
    if (!ack) { const result = claimPreviewRewardCelebrations({ catalog: fresh, leases, claimToken: token, now }); saveRewardDelivery([], result.leases, rows); return result.claimedUnlocks; }
    const records = fresh.items.map(item => ({ key: item.key, celebrationSeenAt: item.celebrationSeenAt }));
    const result = acknowledgePreviewRewardCelebrations({ ownershipRecords: records, leases, claimToken: token, rewardKeys: ['dominion_night_theme'], now });
    saveRewardDelivery(result.ownershipRecords, result.leases, rows); return result.acknowledgedKeys;
  } }));
  assert.equal((await run(one)).length, 1); assert.deepEqual(await run(two), []);
  assert.deepEqual(await run(two, true), []); assert.deepEqual(await run(one, true), ['dominion_night_theme']);
  assert.deepEqual(await run(one, true), ['dominion_night_theme']); assert.deepEqual(await run(two), []);
  const row = [...f.storage.values.values()][0]; assert.equal(row.claimToken, null); assert.equal(row.leaseUntil, null); assert.ok(row.seenAt);
});

const api = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
const functionSlice = (start, end) => api.slice(api.indexOf(start), api.indexOf(end)).replaceAll('export ', '');

test('presentation-only member/leaderboard badge mapping removes only delivery status', () => {
  const context = {};
  const source = functionSlice('const mapBadge = ', '\nconst mapGameStats = ');
  runInNewContext(source + '\nglobalThis.map = mapBadge; globalThis.present = mapPresentationBadge;', context);
  const badge = { key: 'faithful_start', awardId: 'id', scopeKey: 'lifetime', name: 'Existing name', metadata: { important: true },
    celebrationSeenAt: 'stale-seen', celebrationClaimToken: 'not-presented' };
  const { celebrationSeenAt, ...expected } = context.map(badge);
  assert.deepEqual(copy(context.present(badge)), copy(expected)); assert.equal(context.present(null), null);
  assert.equal(context.present(badge).metadata, badge.metadata);
  assert.ok(!Object.hasOwn(context.present(badge), 'celebrationSeenAt'));
  assert.match(functionSlice('function getMockMemberProgressFixture(', '\nfunction getMockLeaderboard('), /map\(mapPresentationBadge\)/);
  assert.match(functionSlice('function getMockCrewMemberProgressProfile(', '\nasync function getCurrentCommunityIdentity('), /map\(mapPresentationBadge\)/);
});

test('actual API compatibility selection overlays seen before reduction and never writes legacy seen on abort', async () => {
  const f = fixture();
  const ledgerModule = await import('./preview-delivery-ledger.mjs');
  const owner = { actorId: 'A', sessionIdentity: 'preview:A', token: '', epoch: 0 };
  const progression = { totalPoints: 10000, eligibleDailyStandardPoints: 10000 };
  const storedOwnership = [{ key: 'dominion_night_theme', unlockedAt: '2026-01-01T00:00:00Z', celebrationSeenAt: null }];
  let rawWrites = 0;
  const context = {
    isLocalDemoMode: () => true, usesSupabaseAuthentication: () => false, previewBadgeEpoch: 0,
    requireMockRewardActor: () => 'A', capturePreviewBadgeOwner: async () => owner,
    loadDelivery: async () => ({ ...ledgerModule, previewDeliveryLedger: f.ledger }),
    getMockRewardCatalog: () => ({ ...buildMockRewardCatalog({ progression, ownershipRecords: copy(storedOwnership) }), progression }),
    readMockUserValue: () => ({}), writeMockUserValue: () => { rawWrites += 1; },
    MOCK_REWARD_CELEBRATION_LEASES_KEY: 'leases', claimMockRewardEntitlementUnlocks,
  };
  const source = functionSlice('function assertPreviewDeliveryOwner(', '\nasync function readPreviewBadgeHistory(')
    + functionSlice('export async function claimRewardEntitlementUnlocks(', '\nfunction mockRewardFulfillment(');
  runInNewContext(source.replace("import('./preview-delivery-ledger.mjs')", 'loadDelivery()') + '\nglobalThis.claim = claimRewardEntitlementUnlocks;', context);
  const first = await context.claim({ expectedUserId: 'A' });
  assert.ok(first.claimedUnlocks.some(item => item.key === 'dominion_night_theme'));
  const again = await context.claim({ expectedUserId: 'A' });
  assert.equal(again.claimedUnlocks.length, 0); assert.equal(rawWrites, 0);
  const prior = copy([...f.storage.values]);
  f.storage.options.abortCommit = true;
  await assert.rejects(context.claim({ expectedUserId: 'A' }), unavailable);
  assert.deepEqual([...f.storage.values], prior); assert.equal(rawWrites, 0);
});

test('actual API reward ack does not accept unknown seen legacy ownership as a receipt', async () => {
  const f = fixture(); const ledgerModule = await import('./preview-delivery-ledger.mjs');
  const owner = { actorId: 'A', sessionIdentity: 'preview:A', token: '', epoch: 0 };
  const ownershipRecords = [{ key: 'not_a_catalog_reward', celebrationSeenAt: 'legacy-forged' }];
  const context = {
    isLocalDemoMode: () => true, usesSupabaseAuthentication: () => false, previewBadgeEpoch: 0,
    requireMockRewardActor: () => 'A', capturePreviewBadgeOwner: async () => owner,
    loadDelivery: async () => ({ ...ledgerModule, previewDeliveryLedger: f.ledger }),
    getMockRewardCatalog: () => ({ ...buildMockRewardCatalog({ progression: {}, ownershipRecords: copy(ownershipRecords) }), progression: {} }),
    readMockUserValue: () => ({}), MOCK_REWARD_CELEBRATION_LEASES_KEY: 'leases', acknowledgePreviewRewardCelebrations,
  };
  const source = functionSlice('function assertPreviewDeliveryOwner(', '\nasync function readPreviewBadgeHistory(')
    + functionSlice('export async function acknowledgeRewardCelebrations(', '\nexport async function claimRewardEntitlementUnlocks(');
  runInNewContext(source.replace("import('./preview-delivery-ledger.mjs')", 'loadDelivery()') + '\nglobalThis.ack = acknowledgeRewardCelebrations;', context);
  const result = await context.ack({ expectedUserId: 'A', claimToken: '00000000-0000-4000-8000-000000000001', rewardKeys: ['not_a_catalog_reward'] });
  assert.equal(result.acknowledgedKeys.length, 0); assert.equal(f.storage.values.size, 0);
});
