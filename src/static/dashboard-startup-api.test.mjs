import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { createClient } from '@supabase/supabase-js';
import { authSessionIdentity } from './mfa-auth.mjs';
import { calendarDayDifference } from './check-in.mjs';
import { isSupportedChallengeActivationDate } from './challenge-activation.mjs';
import { normalizeDailyActionBootstrap } from './daily-action-bootstrap.mjs';
import { instanceBootstrapFixture, INSTANCE_ACTOR as A, INSTANCE_ID } from '../../tests/fixtures/challenge-instance.mjs';

const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FIRST = '33333333-3333-4333-8333-333333333333';
const SECOND = '44444444-4444-4444-8444-444444444444';
const session = (actor = A, id = FIRST, revision = 0) => ({ user: { id: actor },
  access_token: `fixture.${Buffer.from(JSON.stringify({ sub: actor, session_id: id, revision })).toString('base64url')}.signature` });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const api = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
const page = readFileSync(new URL('./dashboard.js', import.meta.url), 'utf8');
const userSource = api.slice(api.indexOf('const requireUser = async'), api.indexOf('export { isMissingProfilePhotoSchemaError }'));
const startupIndex = api.indexOf('export async function initializeDashboardVisit(');
const source = api.slice(startupIndex < 0 ? api.indexOf('export async function getDashboard()') : startupIndex,
  api.indexOf('const browserTimeZone')).replace(/^export /gm, '');

function fixture({ userHook, historyHook, visitHook, statsHook, preview = false, sdk } = {}) {
  let current = session(), epoch = 0, currentPage = true, committed = false, authReads = 0;
  const events = [], requests = [], warnings = [];
  const raw = instanceBootstrapFixture(); raw.activation.currentInstance.submittedCount = 0;
  raw.draft.activation = structuredClone(raw.activation);
  let history = { schemaVersion: 2, actorId: A, instanceId: INSTANCE_ID, checkIns: [] };
  const query = (name, args = null) => {
    const row = { name, args, steps: [], headers: {} };
    const builder = { then(resolve, reject) {
      requests.push(row); events.push(name);
      return Promise.resolve().then(async () => {
        if (name === 'get_challenge_check_ins_v2') { await historyHook?.(); return { data: history }; }
        if (name === 'record_app_visit') {
          const result = await visitHook?.(); if (result) return result;
          committed = true; return { data: [{ current_app_streak: 6 }] };
        }
        if (name === 'user_game_stats') { const result = await statsHook?.(); return result || { data: { current_app_streak: committed ? 6 : 5 } }; }
        return { data: [], count: 0 };
      }).then(resolve, reject);
    }, setHeader(key, value) { row.headers[key] = value; return builder; } };
    for (const method of ['select', 'eq', 'neq', 'order', 'limit', 'gte', 'lt', 'maybeSingle']) builder[method] = (...args) => { row.steps.push([method, ...args]); return builder; };
    return builder;
  };
  const client = { from: query, rpc: (name, args) => name === 'record_app_visit' && sdk ? sdk.rpc(name, args) : query(name, args), auth: { async getUser() {
    const captured = current?.user; authReads++; events.push('auth'); await userHook?.(authReads);
    return { data: { user: captured }, error: null };
  } } };
  const globals = {
    BUILD_SUPPORTS_LOCAL_DEMO: preview, isLocalDemoMode: () => preview,
    requireSupabase: () => client, getAuthSession: async () => current, authSessionIdentity,
    getProfile: async () => ({ userId: A }), getDailyActionBootstrap: async () => normalizeDailyActionBootstrap(raw, A),
    localDayBounds: () => ({ start: '2026-09-30T00:00:00Z', end: '2026-10-01T00:00:00Z' }), browserTimeZone: () => 'UTC',
    mapGameStats: value => value, mapFeedItem: value => value, mapBadge: value => value,
    isSupportedChallengeActivationDate, calendarDayDifference, console: { warn: (...args) => warnings.push(args) },
    getLocalOrSessionUser: async () => ({ userId: A }),
    withPreviewAggregate: async (actor, fn) => { events.push('preview'); return { profile: { userId: actor }, preview: true }; },
  };
  Object.defineProperty(globals, 'previewBadgeEpoch', { get: () => epoch });
  runInNewContext(`${userSource}\n${source}\nglobalThis.read = getDashboard; globalThis.start = typeof initializeDashboardVisit === 'function' ? initializeDashboardVisit : null;`, globals);
  return { read: globals.read, start: (owner = A) => {
    assert.equal(typeof globals.start, 'function', 'explicit startup API must exist');
    return globals.start({ expectedUserId: owner, isCurrent: () => currentPage });
  }, raw, events, requests, warnings, authReads: () => authReads,
  replace(next, notify = true) { current = next; if (notify) epoch++; },
  token() { current.access_token = session(A, FIRST, 1).access_token; },
  roundTrip() { epoch += 2; current = session(); }, cancel() { currentPage = false; },
  history(value) { history = value; }, epoch() { epoch++; } };
}

test('boot has an explicit API; ordinary and recurring hydration stay read-only', () => {
  assert.notEqual(startupIndex, -1);
  assert.match(page, /initializeDashboardVisit/);
  const boot = page.slice(page.indexOf('async function bootDashboard()'));
  assert.match(boot, /hydrateDashboardFromApi\(observedAuthOwner, \{ initialVisit: true \}\)/);
  assert.match(boot, /if \(localDemoMode\) await recordDailyAppVisit\(\)/);
  const foreground = page.slice(page.indexOf('function startDashboardForegroundRefresh'), page.indexOf('async function recordDailyAppVisit'));
  assert.doesNotMatch(foreground, /initialVisit|initializeDashboardVisit|recordAppVisit/);
});

test('eligible startup validates history, sends one pinned visit, then one fresh stats/badge pair', async () => {
  const f = fixture(); const result = await f.start();
  assert.equal(result.gameStats.current_app_streak, 6);
  assert.deepEqual(f.events.filter(x => x !== 'auth'), ['community_feed_items', 'community_feed_items', 'get_challenge_check_ins_v2', 'record_app_visit', 'user_game_stats', 'user_badges']);
  const visit = f.requests.find(x => x.name === 'record_app_visit');
  assert.deepEqual(JSON.parse(JSON.stringify(visit.args)), { target_expected_actor_id: A });
  assert.equal(visit.headers.Authorization, `Bearer ${session().access_token}`);
  assert.equal(f.authReads(), 4, 'retain Dashboard initial/final, visit, and summary native checks');
});

test('ordinary Dashboard reads stay uncached, fresh and never write visits', async () => {
  const f = fixture(); await f.read(); await f.read();
  assert.equal(f.requests.filter(x => x.name === 'record_app_visit').length, 0);
  assert.equal(f.requests.filter(x => x.name === 'user_game_stats').length, 2);
  assert.equal(f.requests.filter(x => x.name === 'user_badges').length, 2);
  assert.equal(f.authReads(), 4);
});

test('not-started startup does not visit, and still returns a fresh snapshot', async () => {
  const f = fixture(); f.raw.instanceId = null; f.raw.draft = null;
  Object.assign(f.raw.activation, { status: 'not_started', mode: null, startDate: null, timeZone: null,
    currentInstance: null, canParticipate: false, canMutateDailyStandards: false,
    canActivateSolo: true, canActivateGroup: true });
  await f.start(); assert.equal(f.requests.filter(x => x.name === 'record_app_visit').length, 0);
  assert.equal(f.requests.filter(x => x.name === 'user_game_stats').length, 1);
});

test('invalid current-instance history rejects before any startup visit or game read', async () => {
  const f = fixture(); f.history({ schemaVersion: 2, actorId: B, instanceId: INSTANCE_ID, checkIns: [] });
  await assert.rejects(f.start(), /progress changed/);
  assert.equal(f.requests.filter(x => ['record_app_visit', 'user_game_stats', 'user_badges'].includes(x.name)).length, 0);
});

test('same-context network visit failure warns, reads fresh state and never retries', async () => {
  const f = fixture({ visitHook: async () => ({ error: { message: 'network unavailable', status: 503 } }) });
  const result = await f.start(); assert.equal(result.gameStats.current_app_streak, 5);
  assert.equal(f.requests.filter(x => x.name === 'record_app_visit').length, 1); assert.equal(f.warnings.length, 1);
  await f.read(); assert.equal(f.requests.filter(x => x.name === 'record_app_visit').length, 1);
});

for (const error of [{ status: 401 }, { status: 403 }, { code: '42501' }, { code: 'PGRST301' },
  { code: '28000' }, { code: '40001', details: 'challenge_activation_actor_changed' }, { code: 'P0001', status: 500 }]) {
  test(`visit authority error ${JSON.stringify(error)} is not swallowed`, async () => {
    const f = fixture({ visitHook: async () => ({ error }) });
    await assert.rejects(f.start()); assert.equal(f.warnings.length, 0);
    assert.equal(f.requests.filter(x => x.name === 'user_game_stats').length, 0);
  });
}

test('visit may commit before initial game read fails; subsequent recovery only reads', async () => {
  let fail = true; const f = fixture({ statsHook: async () => fail ? { error: new Error('snapshot unavailable') } : null });
  await assert.rejects(f.start(), /snapshot unavailable/); fail = false; await f.read();
  assert.equal(f.requests.filter(x => x.name === 'record_app_visit').length, 1);
});

const changes = [['A to B', f => f.replace(session(B))], ['same-user replacement', f => f.replace(session(A, SECOND), false)],
  ['token replacement', f => f.token()], ['A to B to A', f => f.roundTrip()], ['logout', f => f.replace(null)],
  ['epoch invalidation', f => f.epoch()], ['page/request cancellation', f => f.cancel()]];
for (const [name, change] of changes) {
  for (const stage of ['history', 'visit', 'stats']) test(`${name} during ${stage} fences dispatch/publication without retry`, async () => {
    const entered = deferred(), gate = deferred();
    const f = fixture({ [`${stage}Hook`]: async () => { entered.resolve(); await gate.promise; } });
    const pending = f.start(); const rejected = assert.rejects(pending, /account changed|log in/);
    await entered.promise; change(f); gate.resolve(); await rejected;
    assert.equal(f.requests.filter(x => x.name === 'record_app_visit').length, stage === 'history' ? 0 : 1);
    if (stage !== 'stats') assert.equal(f.requests.filter(x => x.name === 'user_game_stats').length, 0);
  });
}

test('local-demo startup delegates to the existing preview read and performs no native work', async () => {
  const f = fixture({ preview: true }); const value = await f.start();
  assert.equal(value.preview, true); assert.equal(f.authReads(), 0); assert.equal(f.requests.length, 0);
});

test('installed SDK may complete an already-created request only for the captured bearer after async token replacement', async () => {
  const entered = deferred(), gate = deferred(), sent = []; let armed = false;
  const sdk = createClient('https://dashboard-startup-fixture.invalid', 'public-synthetic-fixture-key', {
    accessToken: async () => { if (!armed) return session().access_token; entered.resolve(); return gate.promise; },
    global: { fetch: async (url, init) => {
      sent.push({ url: String(url), method: init.method, headers: new Headers(init.headers), body: JSON.parse(init.body) });
      return new Response(JSON.stringify([{ current_app_streak: 6 }]), { status: 200, headers: { 'content-type': 'application/json' } });
    } },
  });
  await new Promise(resolve => setImmediate(resolve)); armed = true;
  const f = fixture({ sdk }); const pending = f.start(); const rejected = assert.rejects(pending, /account changed/);
  await entered.promise; f.replace(session(B)); gate.resolve(session(B).access_token); await rejected;
  assert.equal(sent.length, 1); assert.equal(sent[0].method, 'POST');
  assert.equal(sent[0].url, 'https://dashboard-startup-fixture.invalid/rest/v1/rpc/record_app_visit');
  assert.deepEqual(sent[0].body, { target_expected_actor_id: A });
  assert.equal(sent[0].headers.get('authorization'), `Bearer ${session().access_token}`);
  assert.equal(f.requests.filter(x => x.name === 'user_game_stats').length, 0);
});

for (const lost of [false, true]) test(`installed SDK ${lost ? 'lost transport' : '503'} visit POST is not retried`, async () => {
  const sent = []; const sdk = createClient('https://dashboard-startup-fixture.invalid', 'public-synthetic-fixture-key', {
    accessToken: async () => session().access_token,
    global: { fetch: async (url, init) => {
      sent.push({ url: String(url), method: init.method });
      if (lost) throw new TypeError('Synthetic lost response');
      return new Response(JSON.stringify({ message: 'Synthetic temporary failure' }), { status: 503, headers: { 'content-type': 'application/json' } });
    } },
  });
  const f = fixture({ sdk }); await f.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 1); assert.equal(sent[0].method, 'POST'); assert.equal(f.warnings.length, 1);
  assert.equal(f.requests.filter(x => x.name === 'user_game_stats').length, 1);
});
