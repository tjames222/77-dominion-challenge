import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const api = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
const summarySource = api.slice(api.indexOf('export async function getGameSummary('),
  api.indexOf('export async function getBadgeCollection(')).replace(/^export /, '');
const mappings = api.slice(api.indexOf('const mapBadge = '), api.indexOf('const mapLeaderboardRow = '));
const stats = { total_points: 500, challenge_points: 42, current_app_streak: 6, best_app_streak: 8,
  current_full_day_streak: 2, best_full_day_streak: 4, last_seen_date: '2026-10-12', last_full_day_date: '2026-10-11' };
const award = { id: 'award-1', badge_key: 'finisher', scope_key: 'original77:run-1',
  earned_at: '2026-10-12T12:00:00Z', metadata: { awardDefinition: { name: 'Finisher', tier: 'gold' } } };
const plain = value => JSON.parse(JSON.stringify(value));

function fixture({ preview = false, authError, userReady, statsResult = { data: stats }, badgesResult = { data: [award, null] } } = {}) {
  const queries = []; const requests = []; const events = []; let badgeSnapshotReads = 0;
  const values = { 'dominion:gameStats': { totalPoints: 500, challengePoints: 42, currentAppStreak: 6,
    bestAppStreak: 8, currentFullDayStreak: 2, bestFullDayStreak: 4,
    lastSeenDate: '2026-10-12', lastFullDayDate: '2026-10-11' } };
  Object.defineProperty(values, 'badges', { get() { badgeSnapshotReads++; return { awards: [award, null] }; } });
  const runtime = {
    BUILD_SUPPORTS_LOCAL_DEMO: true, isLocalDemoMode: () => preview,
    PREVIEW_BADGE_STATE_KEY: 'badges',
    getLocalOrSessionUser: async () => { events.push('preview-user'); await userReady; return { userId: 'A' }; },
    withPreviewAggregate: async (actor, read) => {
      assert.equal(actor, 'A'); events.push('preview-aggregate');
      return read({ values, runtime: { lifetimePoints: 900 } });
    },
    requireUser: async () => { events.push('requireUser'); await userReady; if (authError) throw authError; return { id: 'A' }; },
    requireSupabase: () => ({ from(table) {
      const query = { table, steps: [] }; queries.push(query);
      const builder = { then(resolve, reject) {
        requests.push(table); events.push(table);
        return Promise.resolve(table === 'user_game_stats' ? statsResult : badgesResult).then(resolve, reject);
      } };
      for (const method of ['select', 'eq', 'maybeSingle', 'order', 'limit']) {
        builder[method] = (...args) => { query.steps.push([method, ...args]); return builder; };
      }
      return builder;
    } }),
  };
  const read = runInNewContext(`${mappings}\n${summarySource}\ngetGameSummary;`, runtime);
  return { read, queries, requests, events, badgeSnapshotReads: () => badgeSnapshotReads };
}

test('full-summary default retains both parallel queries, their actor/projection/order/limit, and badge mapping', async () => {
  const f = fixture(); const result = plain(await f.read());
  assert.deepEqual(f.requests, ['user_game_stats', 'user_badges']);
  assert.deepEqual(f.events, ['requireUser', 'user_game_stats', 'user_badges']);
  assert.deepEqual(plain(f.queries), [
    { table: 'user_game_stats', steps: [
      ['select', 'total_points, challenge_points, current_app_streak, best_app_streak, current_full_day_streak, best_full_day_streak, last_seen_date, last_full_day_date'],
      ['eq', 'user_id', 'A'], ['maybeSingle'],
    ] },
    { table: 'user_badges', steps: [
      ['select', 'id, scope_key, badge_key, earned_at, entry_date, metadata, badge_definitions(name, description, category, tier, icon, requirement, retired, sort_order)'],
      ['eq', 'user_id', 'A'], ['order', 'earned_at', { ascending: false }], ['limit', 12],
    ] },
  ]);
  assert.deepEqual(result.gameStats, { totalPoints: 500, challengePoints: 42, currentAppStreak: 6, bestAppStreak: 8,
    currentFullDayStreak: 2, bestFullDayStreak: 4, lastSeenDate: '2026-10-12', lastFullDayDate: '2026-10-11' });
  assert.equal(result.badges.length, 1); assert.equal(result.badges[0].awardId, 'award-1');
  assert.equal(result.badges[0].name, 'Finisher'); assert.equal(result.badges[0].tier, 'gold');
});

for (const preview of [false, true]) {
  for (const includeBadges of [false, true]) {
    test(`${preview ? 'preview' : 'real'} snapshots includeBadges=${includeBadges} before user lookup settles`, async () => {
      let release; const userReady = new Promise(resolve => { release = resolve; });
      const f = fixture({ preview, userReady }); const options = { includeBadges };
      const pending = f.read(options); options.includeBadges = !includeBadges; release();
      const result = await pending;
      assert.equal(result.badges.length, includeBadges ? 1 : 0);
      assert.equal(preview ? f.badgeSnapshotReads() : f.requests.filter(table => table === 'user_badges').length, includeBadges ? 1 : 0);
    });
  }
  test(`${preview ? 'preview' : 'real'} stats-only keeps the same statistics and omits badge work`, async () => {
    const full = fixture({ preview }); const lean = fixture({ preview });
    const expected = plain(await full.read()); const actual = plain(await lean.read({ includeBadges: false }));
    assert.deepEqual(actual, { gameStats: expected.gameStats, badges: [] });
    assert.equal(expected.badges.length, 1);
    assert.deepEqual(lean.events, preview ? ['preview-user', 'preview-aggregate'] : ['requireUser', 'user_game_stats']);
    if (preview) {
      assert.equal(full.badgeSnapshotReads(), 1); assert.equal(lean.badgeSnapshotReads(), 0);
      assert.equal(actual.gameStats.totalPoints, 900);
    } else {
      assert.deepEqual(lean.queries.map(query => query.table), ['user_game_stats']);
      assert.deepEqual(plain(lean.queries[0]), plain(full.queries[0]));
    }
  });
  for (const includeBadges of [undefined, true, null, 0, '', 'false']) {
    test(`${preview ? 'preview' : 'real'} only explicit false skips badges (${String(includeBadges)})`, async () => {
      const f = fixture({ preview }); const result = await f.read({ includeBadges });
      assert.equal(result.badges.length, 1);
      assert.equal(preview ? f.badgeSnapshotReads() : f.requests.filter(table => table === 'user_badges').length, 1);
    });
  }
}

for (const includeBadges of [true, false]) {
  test(`authentication and statistics errors remain failures (includeBadges=${includeBadges})`, async () => {
    const signedOut = new Error('signed out'); const noActor = fixture({ authError: signedOut });
    await assert.rejects(noActor.read({ includeBadges }), error => error === signedOut);
    assert.deepEqual(noActor.queries, []);
    const unavailable = new Error('stats unavailable'); const failed = fixture({ statsResult: { error: unavailable } });
    await assert.rejects(failed.read({ includeBadges }), error => error === unavailable);
  });
  test(`missing statistics and badge rows retain their empty defaults (includeBadges=${includeBadges})`, async () => {
    const f = fixture({ statsResult: { data: null }, badgesResult: { data: null } });
    const result = plain(await f.read({ includeBadges }));
    assert.equal(result.gameStats.currentAppStreak, 0); assert.equal(result.gameStats.lastSeenDate, null);
    assert.deepEqual(result.badges, []);
  });
}

test('badge failures remain visible to full-summary callers but cannot block a stats-only caller', async () => {
  const unavailable = new Error('badges unavailable');
  await assert.rejects(fixture({ badgesResult: { error: unavailable } }).read(), error => error === unavailable);
  const lean = fixture({ badgesResult: { error: unavailable } });
  assert.equal((await lean.read({ includeBadges: false })).gameStats.currentAppStreak, 6);
  assert.deepEqual(lean.requests, ['user_game_stats']);
});

test('omitting badges does not add a settled cache or alter subsequent full-summary callers', async () => {
  const f = fixture(); await f.read({ includeBadges: false }); await f.read(); await f.read({ includeBadges: false });
  assert.deepEqual(f.requests, ['user_game_stats', 'user_game_stats', 'user_badges', 'user_game_stats']);
  assert.equal(f.events.filter(event => event === 'requireUser').length, 3);
});
