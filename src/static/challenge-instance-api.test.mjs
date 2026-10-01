import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { calendarDayDifference } from './check-in.mjs';
import { normalizeChallengeActivation, isSupportedChallengeActivationDate } from './challenge-activation.mjs';
import { normalizeDailyActionBootstrap } from './daily-action-bootstrap.mjs';
import { instanceBootstrapFixture, INSTANCE_ACTOR as actor, INSTANCE_ID as id } from '../../tests/fixtures/challenge-instance.mjs';

const api = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
function fixture() {
  const raw = instanceBootstrapFixture();
  raw.activation.currentInstance.submittedCount = 0;
  raw.draft.activation = structuredClone(raw.activation);
  let currentActor = actor;
  let history = { schemaVersion: 2, actorId: actor, instanceId: id, checkIns: [] };
  const requests = []; const tables = [];
  const query = { then: resolve => resolve({ data: [], error: null, count: 0 }) };
  for (const method of ['select', 'eq', 'neq', 'order', 'limit', 'gte', 'lt', 'maybeSingle']) query[method] = () => query;
  const globals = {
    isLocalDemoMode: () => false,
    requireSupabase: () => ({ from: name => { tables.push(name); return query; },
      rpc: async (name, args) => { requests.push({ name, args }); return { data: history, error: null }; } }),
    requireUser: async expected => { if (expected && expected !== currentActor) throw new Error('Account changed'); return { id: currentActor }; },
    getProfile: async () => ({ userId: actor }),
    getDailyActionBootstrap: async () => normalizeDailyActionBootstrap(raw, actor),
    localDayBounds: () => ({ start: '2026-09-30T00:00:00Z', end: '2026-10-01T00:00:00Z' }),
    browserTimeZone: () => 'UTC', mapGameStats: value => value, mapFeedItem: value => value, mapBadge: value => value,
    isSupportedChallengeActivationDate, calendarDayDifference,
  };
  const source = api.slice(api.indexOf('export async function getDashboard'), api.indexOf('const browserTimeZone')).replace(/^export /, '');
  runInNewContext(`${source}\nglobalThis.read = getDashboard;`, globals);
  return { read: globals.read, requests, tables, raw,
    history(value) { history = value; }, actor(value) { currentActor = value; },
    setCount(value) { raw.activation.currentInstance.submittedCount = value; raw.draft.activation = structuredClone(raw.activation); },
  };
}

test('dashboard uses current-instance history and separately preserves the global same-date lock', async () => {
  const f = fixture(); f.raw.draft.submitted = true; f.raw.draft.locked = true;
  const result = await f.read();
  assert.equal(result.activation.currentInstance.id, id);
  assert.equal(result.entries[0].instanceId, id);
  assert.deepEqual([...result.checkIns], []);
  assert.deepEqual([...result.globalSubmittedDates], ['2026-09-30']);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].name, 'get_challenge_check_ins_v2');
  assert.equal(f.requests[0].args.target_expected_instance_id, id);
  assert.equal(f.requests[0].args.target_expected_actor_id, actor);
  assert(!f.tables.includes('check_ins')); assert(!f.tables.includes('challenge_entries'));
});

test('dashboard rejects mixed run histories, noncanonical days and racing counts', async () => {
  const valid = { entry_date: '2026-09-29', challenge_day: 91, instanceId: id };
  for (const patch of [{ instanceId: null }, { entry_date: '2026-10-01', challenge_day: 93 },
    { entry_date: '2026-06-30', challenge_day: 1 }, { challenge_day: 1 }, { challenge_day: '91' }]) {
    const f = fixture(); f.setCount(1);
    f.history({ schemaVersion: 2, actorId: actor, instanceId: id, checkIns: [{ ...valid, ...patch }] });
    await assert.rejects(f.read(), /progress changed/);
  }
  for (const patch of [{ schemaVersion: 1 }, { actorId: 'other' }, { instanceId: null }, { checkIns: [valid, valid] }]) {
    const f = fixture(); f.setCount(1);
    f.history({ schemaVersion: 2, actorId: actor, instanceId: id, checkIns: [valid], ...patch });
    await assert.rejects(f.read(), /progress changed/);
  }
  const f = fixture(); f.setCount(1); await assert.rejects(f.read(), /progress changed/);
});

test('dashboard admits canonical calendar-day evidence beyond the old day77 limit', async () => {
  const f = fixture(); f.setCount(1);
  f.history({ schemaVersion: 2, actorId: actor, instanceId: id,
    checkIns: [{ entry_date: '2026-09-29', challenge_day: 91, instanceId: id }] });
  const result = await f.read(); assert.equal(result.checkIns[0].challengeDay, 91);
});

test('not-started dashboard never requests an unscoped check-in history', async () => {
  const f = fixture(); f.raw.instanceId = null; f.raw.draft = null;
  Object.assign(f.raw.activation, { status: 'not_started', mode: null, startDate: null, timeZone: null,
    currentInstance: null, canParticipate: false, canMutateDailyStandards: false,
    canActivateSolo: true, canActivateGroup: true });
  const result = await f.read();
  assert.equal(result.activation.currentInstance, null); assert.equal(f.requests.length, 0);
  assert.equal(result.checkIns.length, 0); assert.equal(result.entries.length, 0);
});

test('strict V2 activation reader rejects an old response without opening capabilities', () => {
  const value = normalizeChallengeActivation({ schemaVersion: 2, actorId: actor });
  assert.equal(value.contractValid, false); assert.equal(value.canMutateDailyStandards, false);
});
