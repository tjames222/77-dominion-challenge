import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const apiSource = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
const pageSource = readFileSync(new URL('./badges-rewards.js', import.meta.url), 'utf8');
const body = (source, name) => {
  const start = source.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1);
  return source.slice(start, source.indexOf('\n}\n', start) + 2);
};
const claimSource = body(apiSource, 'claimChallengeUnlocks');
const makeClaim = dependencies => new Function(...Object.keys(dependencies),
  `${claimSource}; return claimChallengeUnlocks;`)(...Object.values(dependencies));
const catalog = (label = 'post-claim') => ({ label, schemaVersion: 2, actorId: 'actor-a',
  revision: 4, catalogVersion: 2, snapshotVersion: 'a'.repeat(64), totalPoints: 420,
  items: [{ key: 'seven_day_reset', stateModel: 'challenge_lifecycle' },
    { key: 'theme', stateModel: 'ownership' }], page: { hasMore: false, nextCursor: null } });

test('live claim exposes the same complete verified post-claim catalog without another read', async () => {
  const calls = []; const complete = catalog();
  const claim = makeClaim({ BUILD_SUPPORTS_LOCAL_DEMO: false, requireSupabase: () => ({
    rpc: async (name, args) => { calls.push([name, args]); return { data: { claimedKeys: ['seven_day_reset'] } }; },
  }), requireUser: async actor => { calls.push(['user', actor]); return { id: 'actor-a' }; },
  getAllRewardCatalog: async args => { calls.push(['catalog', args]); return complete; } });
  const result = await claim({ expectedUserId: 'actor-a' });
  assert.equal(result.catalog, complete);
  assert.deepEqual(result.claimedUnlocks, [complete.items[0]]);
  assert.deepEqual(result.progression, { challenges: [complete.items[0]], totalPoints: 420 });
  assert.deepEqual(calls, [['user', 'actor-a'], ['claim_challenge_unlocks', { target_expected_actor_id: 'actor-a' }],
    ['user', 'actor-a'], ['catalog', { expectedUserId: 'actor-a' }]]);
});

for (const stage of ['claim', 'verification', 'catalog']) test(`live ${stage} rejection is propagated without retrying the claim`, async () => {
  const failure = new Error(stage); let userCalls = 0; let claims = 0; let reads = 0;
  const claim = makeClaim({ BUILD_SUPPORTS_LOCAL_DEMO: false, requireSupabase: () => ({
    rpc: async () => { claims += 1; return stage === 'claim' ? { error: failure } : { data: {} }; },
  }), requireUser: async () => { if (++userCalls === 2 && stage === 'verification') throw failure; return { id: 'actor-a' }; },
  getAllRewardCatalog: async () => { reads += 1; throw failure; } });
  await assert.rejects(claim({ expectedUserId: 'actor-a' }), error => error === failure);
  assert.equal(claims, 1); assert.equal(reads, stage === 'catalog' ? 1 : 0);
});

test('preview claim keeps its existing aggregate write and does not expose an uncommitted zero-digest catalog', async () => {
  const aggregate = { values: {} }; const complete = catalog(); const records = [{ key: 'seven_day_reset', celebrationSeenAt: null }];
  const claim = makeClaim({ BUILD_SUPPORTS_LOCAL_DEMO: true, isLocalDemoMode: () => true,
    requireMockRewardActor: actor => actor, withPreviewAggregate: (actor, operation) => {
      assert.equal(actor, 'actor-a'); const value = operation(aggregate); assert.equal(typeof value?.then, 'undefined'); return value;
    }, previewCatalogFor: () => ({ catalog: complete, challengeRecords: records }), MOCK_CHALLENGE_STATES_KEY: 'states' });
  const result = await claim({ expectedUserId: 'actor-a' });
  assert.equal(Object.hasOwn(result, 'catalog'), false);
  assert.deepEqual(result.claimedUnlocks, [complete.items[0]]);
  assert.ok(Number.isFinite(Date.parse(aggregate.values.states[0].celebrationSeenAt)));
  assert.equal(records[0].celebrationSeenAt, null);
});

function pageHarness({ read, claim } = {}) {
  const calls = []; const renders = []; const notices = []; const errorPanel = { hidden: true };
  const dependencies = {
    getAllRewardCatalog: async args => { calls.push(['catalog', args]); return read ? read(args) : catalog('initial-or-fallback'); },
    claimChallengeUnlocks: async args => { calls.push(['claim', args]); return claim ? claim(args) : { claimedUnlocks: [], catalog: catalog() }; },
    getBadgeCollection: async () => ({ earnedBadges: [] }), getLeaderboardPrestige: async () => ({ crewId: null }),
    loadGallery: async () => ({}), setLoading: () => {}, badgesGallery: null,
    ACTIVE_CREW_STORAGE_KEY: 'crew', LEADERBOARD_PRESTIGE_WINDOW: 'week',
    localStorage: { getItem: () => null, setItem: () => assert.fail('No selected crew') },
    errorPanel, $: () => null, pageActorIsCurrent: async () => true,
    console: { warn: () => {} }, renders, notices,
  };
  // Execute the actual page load body. Only its optional gallery import is a
  // controlled module fixture; catalog selection and owner fences are intact.
  const loader = body(pageSource, 'loadBadgesAndRewards').replace("import('./badge-collection.mjs')", 'loadGallery()');
  const page = new Function(...Object.keys(dependencies), `
    let pageActorId = 'actor-a', loadRequestId = 0, badgeGallery, badgeCollection, earnedBadges, catalog, leaderboardPositions;
    const renderPage = () => renders.push(catalog);
    const showUnlockNotice = value => notices.push(value);
    const invalidatePageActor = () => { pageActorId = ''; loadRequestId += 1; };
    ${loader}
    return { load: loadBadgesAndRewards, invalidate: invalidatePageActor, replace: actor => { pageActorId = actor; loadRequestId += 1; } };
  `)(...Object.values(dependencies));
  return { ...page, calls, renders, notices, errorPanel };
}

test('successful page hydration keeps the initial read, one claim and one ready render using the exact catalog', async () => {
  const complete = catalog(); const page = pageHarness({ claim: async () => ({ claimedUnlocks: [complete.items[0]], catalog: complete }) });
  await page.load();
  assert.deepEqual(page.calls.map(call => call[0]), ['catalog', 'claim']);
  assert.deepEqual(page.renders, [complete]); assert.equal(page.renders[0], complete);
  assert.deepEqual(page.notices, [[complete.items[0]]]);
});

for (const mode of ['preview-or-legacy', 'claim-rejected', 'post-claim-read-rejected']) {
  test(`${mode} keeps the canonical fallback read without retrying the mutation`, async () => {
    const fallback = catalog('fallback'); let reads = 0;
    const page = pageHarness({ read: async () => { reads += 1; return fallback; }, claim: async () => {
      if (mode !== 'preview-or-legacy') throw new Error(mode);
      return { claimedUnlocks: [] };
    } });
    await page.load();
    assert.equal(reads, 2);
    assert.deepEqual(page.calls.map(call => call[0]), ['catalog', 'claim', 'catalog']);
    assert.deepEqual(page.renders, [fallback]);
  });
}

test('initial read failure prevents claims and renders; fallback failure remains an error', async () => {
  const initial = pageHarness({ read: async () => { throw new Error('initial'); } }); await initial.load();
  assert.deepEqual(initial.calls.map(call => call[0]), ['catalog']); assert.deepEqual(initial.renders, []);
  assert.equal(initial.errorPanel.hidden, false);
  let reads = 0;
  const fallback = pageHarness({ read: async () => { if (++reads === 2) throw new Error('fallback'); return catalog(); },
    claim: async () => { throw new Error('claim'); } }); await fallback.load();
  assert.deepEqual(fallback.calls.map(call => call[0]), ['catalog', 'claim', 'catalog']);
  assert.deepEqual(fallback.renders, []); assert.equal(fallback.errorPanel.hidden, false);
});

test('no-claim refresh retains exactly one catalog read', async () => {
  const page = pageHarness(); await page.load({ claimUnlocks: false });
  assert.deepEqual(page.calls.map(call => call[0]), ['catalog']); assert.equal(page.renders.length, 1);
});

for (const event of ['account-replacement', 'A-B-A', 'pagehide', 'newer-load']) test(`late catalog after ${event} cannot render or trigger fallback`, async () => {
  let release; let started;
  const waiting = new Promise(resolve => { started = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const page = pageHarness({ claim: async () => { started(); return held; } });
  const pending = page.load(); await waiting;
  if (event === 'account-replacement') page.replace('actor-b');
  else if (event === 'A-B-A') { page.replace('actor-b'); page.replace('actor-a'); }
  else if (event === 'pagehide') page.invalidate();
  else await page.load({ claimUnlocks: false });
  release({ claimedUnlocks: [], catalog: catalog('stale') }); await pending;
  assert.ok(page.renders.every(value => value.label !== 'stale'));
  assert.equal(page.calls.filter(call => call[0] === 'claim').length, 1);
  assert.equal(page.calls.filter(call => call[0] === 'catalog').length, event === 'newer-load' ? 2 : 1);
});
