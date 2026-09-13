import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createDailyActionBootstrapClient, normalizeDailyActionBootstrap } from './daily-action-bootstrap.mjs';
import { dailyBootstrapFixture, DAILY_ACTOR as A } from '../../tests/fixtures/daily-action-bootstrap.mjs';

const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function fixture(options = {}) {
  let actor = A; let sid = 'session-1'; let observer; let requiresMfa = false;
  let response = async () => dailyBootstrapFixture({ actorId: actor });
  let authChecks = 0; const calls = [];
  const client = createDailyActionBootstrapClient({
    getSession: async () => ({ user: { id: actor }, sid }),
    getUser: async () => { authChecks += 1; return { id: actor }; },
    sessionIdentity: (session) => session.user.id ? `${session.user.id}:${session.sid}` : '',
    requiresMfa: async () => requiresMfa,
    subscribe: (callback) => { observer = callback; return () => {}; },
    request: async (args, signal) => { calls.push({ args, signal }); return response(); },
    ...options,
  });
  return { client, calls, checks: () => authChecks,
    read: (args = {}) => client.read({ expectedUserId: A, timeZone: 'UTC', ...args }),
    response(fn) { response = fn; }, mfa(value) { requiresMfa = value; },
    switch(id, nextSid = sid, event = 'SIGNED_IN', notify = true) {
      actor = id; sid = nextSid;
      if (notify) observer({ event, sessionIdentity: `${actor}:${sid}` });
    },
  };
}
const untilRequest = async (f) => { for (let i = 0; i < 30 && !f.calls.length; i += 1) await Promise.resolve(); assert.equal(f.calls.length, 1); };

test('bootstrap returns only the approved, actor-bound shape and server date', () => {
  const raw = dailyBootstrapFixture(); raw.secret = 'must not propagate';
  const value = normalizeDailyActionBootstrap(raw, A);
  assert.deepEqual(Object.keys(value).sort(), ['schemaVersion', 'actorId', 'asOf', 'appAccess', 'activation', 'timeZone', 'entryDate', 'draft'].sort());
  assert.equal(value.entryDate, '2026-09-12'); assert.equal(value.draft.date, value.entryDate);
  for (const status of ['scheduled', 'not_started']) assert.equal(normalizeDailyActionBootstrap(dailyBootstrapFixture({ status }), A).draft.locked, true);
  assert.equal(normalizeDailyActionBootstrap(dailyBootstrapFixture({ appAccess: false }), A).activation, null);
});
test('invalid, mismatched, unsafe or permissive draft contracts fail closed', () => {
  for (const update of [{ actorId: B }, { schemaVersion: 2 }, { entryDate: '2026-02-31' },
    { timeZone: 'Invalid/Zone' }, { asOf: 'yesterday' }, { activation: {} },
    { draft: { ...dailyBootstrapFixture().draft, version: Number.MAX_SAFE_INTEGER + 1 } },
    { draft: { ...dailyBootstrapFixture().draft, submitted: true, locked: false } },
    { appAccess: false }]) {
    assert.throws(() => normalizeDailyActionBootstrap({ ...dailyBootstrapFixture(), ...update }, A), /could not be loaded/);
  }
  assert.throws(() => normalizeDailyActionBootstrap(dailyBootstrapFixture(), A, '2026-09-11'));
});
test('identical pending reads share one RPC and pre/post Auth checks, with independent returned objects', async () => {
  const f = fixture(); const gate = deferred(); f.response(() => gate.promise);
  const one = f.read(); const two = f.read(); await untilRequest(f);
  gate.resolve(dailyBootstrapFixture()); const [left, right] = await Promise.all([one, two]);
  left.draft.completed.push('bible'); assert.deepEqual(right.draft.completed, []);
  assert.equal(f.calls.length, 1); assert.equal(f.checks(), 2);
  assert.deepEqual(f.calls[0].args, { target_expected_actor_id: A, target_time_zone: 'UTC', target_entry_date: null });
  await f.read(); assert.equal(f.calls.length, 2, 'settled private responses are not cached');
});
test('different query arguments are never coalesced and invalid inputs make no request', async () => {
  const f = fixture();
  await Promise.all([f.read(), f.read({ timeZone: 'America/Los_Angeles' })]);
  assert.equal(f.calls.length, 2);
  for (const args of [{ expectedUserId: '' }, { entryDate: '2026-02-31' }, { timeZone: 'Invalid/Zone' }]) {
    await assert.rejects(f.read(args), { code: 'DAILY_ACTION_INVALID_INPUT' });
  }
  assert.equal(f.calls.length, 2);
});
for (const [name, change] of [
  ['A→B→A auth notifications', (f) => { f.switch(B); f.switch(A); }],
  ['same actor new session', (f) => f.switch(A, 'session-2')],
  ['changed actor without a notification', (f) => f.switch(B, 'session-2', '', false)],
  ['changed session without a notification', (f) => f.switch(A, 'session-2', '', false)],
  ['explicit mutation/page invalidation', (f) => f.client.invalidate()],
]) test(`late private response is rejected after ${name}`, async () => {
  const f = fixture(); f.switch(A); const gate = deferred(); f.response(() => gate.promise);
  const pending = f.read(); const rejected = assert.rejects(pending, { code: 'DAILY_ACTION_CHANGED' });
  await untilRequest(f); change(f); gate.resolve(dailyBootstrapFixture()); await rejected;
});
test('same-session focus notification retains the pending request', async () => {
  const f = fixture(); f.switch(A); const gate = deferred(); f.response(() => gate.promise);
  const pending = f.read(); await untilRequest(f); f.switch(A); gate.resolve(dailyBootstrapFixture());
  assert.equal((await pending).actorId, A); assert.equal(f.calls.length, 1);
});
test('enrolled AAL1 and lost Auth block reads; denied access still receives fresh owner checks', async () => {
  const f = fixture(); f.mfa(true);
  await assert.rejects(f.read(), { code: 'DAILY_ACTION_SIGNED_OUT' }); assert.equal(f.calls.length, 0);
  f.mfa(false); f.response(async () => dailyBootstrapFixture({ appAccess: false }));
  assert.equal((await f.read()).appAccess, false); assert.equal(f.checks(), 2);
});
test('transport failures are fixed-copy and a retry performs a fresh request', async () => {
  const f = fixture(); f.response(async () => { throw new Error('PRIVATE_PROVIDER_DETAIL'); });
  await assert.rejects(f.read(), { code: 'DAILY_ACTION_UNAVAILABLE', message: 'Today’s action could not be loaded. Try again.' });
  f.response(async () => dailyBootstrapFixture()); await f.read(); assert.equal(f.calls.length, 2);
});
test('a stalled request times out into retry state and cannot deliver a late private result', async () => {
  const f = fixture({ timeoutMs: 10 }); const gate = deferred(); f.response(() => gate.promise);
  await assert.rejects(f.read(), { code: 'DAILY_ACTION_UNAVAILABLE' });
  assert.equal(f.calls[0].signal.aborted, true);
  gate.resolve(dailyBootstrapFixture()); f.response(async () => dailyBootstrapFixture());
  assert.equal((await f.read()).actorId, A); assert.equal(f.calls.length, 2);
});
test('all Daily Action live startup paths use only the focused bootstrap, retaining mock and mutation paths', () => {
  const page = readFileSync(new URL('./daily-standard-page.js', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /getDashboard/);
  assert.match(page, /getDailyActionBootstrap\(\{ expectedUserId: requestedOwner, timeZone: browserTimeZone \}\)/);
  assert.match(page, /nextDate = snapshot\.entryDate/);
  assert.match(page, /if \(!hasSupabaseAuth\(\)\) \{\s+const billing = await getBillingState/);
  assert.match(page, /force: sessionChanged/);
  assert.match(page, /actionLoadRetry/);
});
