import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { dateKeyForTimeZone } from './check-in.mjs';

const source = readFileSync(new URL('./dashboard.js', import.meta.url), 'utf8');
const hydration = source.slice(source.indexOf('async function hydrateDashboardFromApi('), source.indexOf('async function handleDashboardAuthOwnerChange('));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const snapshot = date => ({ profile: { userId: A, timeZone: 'UTC' },
  activation: { timeZone: 'UTC', serverDate: date, startDate: '2026-10-01', currentInstance: { id: 'current-run' } },
  entries: [], checkIns: [], globalSubmittedDates: [], feed: [], completedTodayCount: 0, gameStats: { currentAppStreak: 6 }, badges: [] });

for (const initialVisit of [true, false]) test(`UTC rollover during delayed ${initialVisit ? 'startup' : 'ordinary read'} repairs through read-only hydration`, async () => {
  let now = Date.parse('2026-10-17T23:59:59.900Z');
  const first = deferred(), recovery = deferred(), calls = [], renderedReadiness = [];
  class WallDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const globals = {
    Date: WallDate, hasSupabaseAuth: () => true, localDemoMode: false,
    observedAuthOwner: A, hydratedAuthOwner: '', authOwnerEpoch: 1, dashboardHydrationRequestId: 0,
    checkInStatusHydratedDate: '', renderedDateKey: '', checkInCacheOwner: '', startDate: '', userTimeZone: 'UTC',
    challengeActivation: {}, submittedCheckInDates: new Set(), submittedChallengeDays: new Set(), entries: [], feed: [],
    completedTodayCount: 0, gameStats: {}, badges: [], CHECK_IN_DATES_STORAGE_KEY: 'synthetic-dates',
    initializeDashboardVisit: args => { calls.push('startup'); assert.equal(args.expectedUserId, A); assert(args.isCurrent()); return first.promise; },
    getDashboard: () => { calls.push('read'); return calls.length === 1 ? first.promise : recovery.promise; },
    todayKey: () => new Date(now).toISOString().slice(0, 10), dateKeyForTimeZone,
    load: () => ({}), checkInCacheForOwner: () => ({ dates: [], challengeDays: [] }), replaceSubmittedCheckIns: () => {},
    preserveBestStreaks: value => value, withPendingDraftMutations: value => value,
    isCheckInStatusReady: () => globals.checkInStatusHydratedDate === globals.todayKey(),
    render: () => renderedReadiness.push(globals.isCheckInStatusReady()),
    clearDashboardUserState: () => { throw new Error('Unexpected hydration failure'); },
    console: { warn: (...args) => { throw new Error(`Unexpected warning: ${args[0]}`); } },
  };
  runInNewContext(`${hydration}\nglobalThis.hydrate = hydrateDashboardFromApi;`, globals);
  const pending = globals.hydrate(A, { initialVisit });
  now = Date.parse('2026-10-18T00:00:00.100Z'); first.resolve(snapshot('2026-10-17'));
  await pending;
  assert.deepEqual(calls, initialVisit ? ['startup', 'read'] : ['read', 'read']);
  assert.equal(globals.checkInStatusHydratedDate, '', 'a stale-day response cannot unlock today');
  assert.equal(renderedReadiness.at(-1), false);
  recovery.resolve(snapshot('2026-10-18')); await new Promise(resolve => setImmediate(resolve));
  assert.equal(globals.checkInStatusHydratedDate, '2026-10-18');
  assert.equal(renderedReadiness.at(-1), true);
  assert.equal(calls.filter(value => value === 'startup').length, initialVisit ? 1 : 0);
  assert.doesNotMatch(hydration, /recordAppVisit\(|recordDailyAppVisit\(/);
});
