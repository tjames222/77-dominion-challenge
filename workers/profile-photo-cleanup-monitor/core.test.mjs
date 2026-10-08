import assert from 'node:assert/strict';
import test from 'node:test';
import { initialState, parseHealth, recoverInterrupted, reconcileNotification, reduceObservation, renderNotification,
  scheduledSlot, settleNotification, validState } from './core.mjs';
import { CONDITIONS, CRON, DAILY_LIMIT, HEALTH_URL, RECIPIENT, SENDER } from './constants.mjs';

const BASE = Date.parse('2026-09-28T12:02:00.000Z');
const iso = value => new Date(value).toISOString();
function response(now = BASE, overrides = {}) {
  return { status: 'ok', health: { schemaVersion: 1, generatedAt: iso(now),
    cleanup: { expiredPending: 0, ready: 0, leased: 0, staleLeases: 0, backingOff: 0,
      failuresLastHour: 0, oldestReadyAt: null, generatedAt: iso(now), ...overrides },
    cron: { extensionAvailable: true, catalogAvailable: true, jobState: 'present', active: true,
      scheduleMatches: true, historyAvailable: true, stale: false, staleAfterSeconds: 900,
      transportEvidence: 'enqueue-only', lastRuns: [
        { runId: '9007199254740993', status: 'succeeded', startedAt: iso(now - 120_000), endedAt: iso(now - 119_000) },
        { runId: '9007199254740992', status: 'succeeded', startedAt: iso(now - 420_000), endedAt: iso(now - 419_000) },
      ] },
  } };
}
function observe(state, tick, change = {}, alertsEnabled = true) {
  const now = BASE + tick * 300_000;
  const body = response(now, change || {});
  const health = change === null ? null : parseHealth(body, now, state.lastSnapshotAt);
  return reduceObservation(state, { now, slot: scheduledSlot(now, now), health, alertsEnabled });
}
function accepted(result) {
  return result.intent ? settleNotification(result.state, { status: 'accepted', messageId: 'synthetic-message-123' }, result.intent.createdAt + 1) : result.state;
}

test('pure reducer pins the existing origin and operational addresses; no transport is invoked', () => {
  assert.equal(HEALTH_URL, 'https://mimolwojppbtsbvtqwpo.supabase.co/functions/v1/process-profile-photo-cleanup');
  assert.equal(SENDER, 'alerts@77dominion.com'); assert.equal(RECIPIENT, 'tjames@cablueprinting.com');
  assert.equal(CRON, '2,7,12,17,22,27,32,37,42,47,52,57 * * * *');
  assert.equal(DAILY_LIMIT, 6);
});

for (const [key, boundary, exceeding, expected] of [
  ['ready', 100, 101, 'ready_backlog'], ['failuresLastHour', 5, 6, 'cleanup_failures'],
  ['oldestReadyAt', iso(BASE - 900_000), iso(BASE - 900_001), 'oldest_ready'],
]) {
  test(`${key} alerts only beyond the documented strict threshold`, () => {
    assert.equal(observe(initialState(), 0, { [key]: boundary }).intent, null);
    const result = observe(initialState(), 0, { [key]: exceeding });
    assert.deepEqual(result.intent.codes, [expected]); assert.equal(result.intent.kind, 'open');
  });
}

test('stale leases must remain observed more than ten minutes; exactly ten does not alert', () => {
  let state = initialState();
  for (let tick = 0; tick < 3; tick++) {
    const result = observe(state, tick, { staleLeases: 1 }); assert.equal(result.intent, null); state = result.state;
  }
  assert.deepEqual(observe(state, 3, { staleLeases: 1 }).intent.codes, ['stale_leases']);
});

test('lease continuity resets on failed health, missing slot or excessive gap', () => {
  for (const kind of ['failure','gap','clear']) {
    let state = observe(initialState(), 0, { staleLeases: 1 }).state;
    state = observe(state, 1, { staleLeases: 1 }).state;
    state = observe(state, 2, kind === 'failure' ? null : { staleLeases: kind === 'clear' ? 0 : 1 }).state;
    const nextTick = kind === 'gap' ? 4 : 3;
    const result = observe(state, nextTick, { staleLeases: 1 });
    assert.equal(result.intent, null); assert.equal(result.state.staleLeaseSince, BASE + nextTick * 300_000);
  }
});

test('two distinct consecutive health failure observations are required; duplicate slots never count', () => {
  const first = observe(initialState(), 0, null); assert.equal(first.intent, null);
  const duplicate = observe(first.state, 0, null); assert.equal(duplicate.ignored, true);
  assert.equal(duplicate.state.failedHealth, 1);
  const second = observe(first.state, 1, null); assert.deepEqual(second.intent.codes, ['health_unavailable']);
  assert.equal(observe(first.state, 2, null).intent, null, 'a missing slot breaks consecutive failures');
});

test('one failed Cron row observed repeatedly is not two failures', () => {
  let state = initialState();
  for (let tick = 0; tick < 4; tick++) {
    const now = BASE + tick * 300_000, body = response(now);
    body.health.cron.lastRuns[0].status = 'failed';
    const result = reduceObservation(state, { now, slot: scheduledSlot(now, now), health: parseHealth(body, now), alertsEnabled: true });
    assert.equal(result.intent, null); state = result.state;
  }
});

test('two exact consecutive distinct failed Cron IDs open once, pending does not clear, succeeded clears', () => {
  const body = response(); body.health.cron.lastRuns.forEach(r => r.status = 'failed');
  let result = reduceObservation(initialState(), { now: BASE, slot: scheduledSlot(BASE, BASE), health: parseHealth(body, BASE), alertsEnabled: true });
  assert.deepEqual(result.intent.codes, ['cron_failed']); let state = accepted(result);
  const pending = response(BASE + 300_000); pending.health.cron.lastRuns[0].status = 'running';
  pending.health.cron.lastRuns[0].endedAt = null; pending.health.cron.lastRuns[1].status = 'failed';
  result = reduceObservation(state, { now: BASE + 300_000, slot: state.lastSlot + 1, health: parseHealth(pending, BASE + 300_000), alertsEnabled: true });
  assert.equal(result.intent, null); assert.equal(result.state.cronFailure, true);
  result = observe(result.state, 2); assert.equal(result.state.cronFailure, false); assert.equal(result.intent, null);
  assert.equal(observe(result.state, 3).intent.kind, 'recovery');
});

test('simultaneous thresholds combine; one new-condition update is bounded per incident', () => {
  let result = observe(initialState(), 0, { ready: 101, failuresLastHour: 6 });
  assert.deepEqual(result.intent.codes, ['ready_backlog','cleanup_failures']);
  let state = accepted(result);
  result = observe(state, 1, { ready: 101, failuresLastHour: 6 }); assert.equal(result.intent, null);
  result = observe(result.state, 2, { ready: 101, oldestReadyAt: iso(BASE - 900_001) });
  assert.equal(result.intent.kind, 'update'); state = accepted(result);
  result = observe(state, 3, null); assert.equal(result.intent, null);
  result = observe(result.state, 4, null); assert.equal(result.intent, null, 'a second update is suppressed');
  assert.ok(result.state.incident.seenCodes.includes('health_unavailable'));
});

for (const blockedBy of ['observe-only', 'daily-quota']) {
  test(`a condition observed during ${blockedBy} remains eligible for the one update after another condition opens`, () => {
    const initial = initialState();
    if (blockedBy === 'daily-quota') initial.daily = { day: '2026-09-28', count: DAILY_LIMIT };
    let result = observe(initial, 0, { ready: 101 }, blockedBy !== 'observe-only');
    assert.equal(result.intent, null);
    assert.deepEqual(result.state.incident.seenCodes, ['ready_backlog']);
    assert.deepEqual(result.state.incident.notifiedCodes, []);
    const nextTick = blockedBy === 'daily-quota' ? 288 : 1;
    result = observe(result.state, nextTick, { failuresLastHour: 6 });
    assert.equal(result.intent.kind, 'open');
    assert.deepEqual(result.intent.codes, ['cleanup_failures']);
    assert.deepEqual(result.state.incident.notifiedCodes, ['cleanup_failures']);
    result = observe(accepted(result), nextTick + 1, { ready: 101 });
    assert.equal(result.intent.kind, 'update');
    assert.deepEqual(result.intent.codes, ['ready_backlog']);
    assert.deepEqual(result.state.incident.notifiedCodes, ['ready_backlog', 'cleanup_failures']);
    result = observe(accepted(result), nextTick + 2, { ready: 101, failuresLastHour: 6 });
    assert.equal(result.intent, null, 'Previously reserved conditions do not generate another update');
  });
}

test('recovery requires two fresh healthy observations and a pending lease is not healthy', () => {
  let state = accepted(observe(initialState(), 0, { ready: 101 }));
  let result = observe(state, 1); assert.equal(result.intent, null);
  result = observe(result.state, 2, { staleLeases: 1 }); assert.equal(result.state.healthyPolls, 0);
  result = observe(result.state, 3); assert.equal(result.intent, null);
  result = observe(result.state, 4); assert.equal(result.intent.kind, 'recovery');
  state = accepted(result); assert.equal(state.incident, null);
  assert.equal(observe(state, 5).intent, null);
});

test('gap and failed health do not count toward two-observation recovery', () => {
  let state = accepted(observe(initialState(), 0, { ready: 101 }));
  state = observe(state, 1).state;
  let result = observe(state, 3); assert.equal(result.intent, null); assert.equal(result.state.healthyPolls, 1);
  result = observe(result.state, 4, null); assert.equal(result.state.healthyPolls, 0);
  assert.equal(observe(result.state, 5).intent, null);
});

test('daily six-intent ceiling includes accepted and rejected attempts and defers a still-active incident', () => {
  let state = initialState(), attempts = 0, tick = 0;
  for (let cycle = 0; cycle < 4; cycle++) {
    let result = observe(state, tick++, { ready: 101 });
    if (result.intent) { attempts++; state = settleNotification(result.state, { status: 'rejected' }, result.intent.createdAt + 1); }
    else state = result.state;
    state = observe(state, tick++).state;
    result = observe(state, tick++);
    if (result.intent) { attempts++; state = accepted(result); } else state = result.state;
  }
  assert.equal(attempts, 6); assert.equal(state.daily.count, 6);
  const blocked = observe(state, tick++, { ready: 101 }); assert.equal(blocked.intent, null);
  const nextDay = observe(blocked.state, tick + 288, { ready: 101 });
  assert.equal(nextDay.intent.kind, 'open'); assert.equal(nextDay.state.daily.count, 1);
});

test('observe-only mode never reserves mail, and clear unnotified incidents do not emit recovery', () => {
  let result = observe(initialState(), 0, { ready: 101 }, false);
  assert.equal(result.intent, null); assert.equal(result.state.daily.count, 0);
  result = observe(result.state, 1, {}, false); result = observe(result.state, 2, {}, false);
  assert.equal(result.state.incident, null); assert.equal(result.intent, null);
  assert.throws(() => observe(initialState(), 0, { ready: 101 }, 'false'));
});

test('durable intent is sending before call; reducer cannot overwrite uncompleted sending', () => {
  const result = observe(initialState(), 0, { ready: 101 });
  assert.equal(result.state.notification.status, 'sending'); assert.equal(result.state.daily.count, 1);
  assert.throws(() => observe(result.state, 1, { ready: 101 }));
  const interrupted = recoverInterrupted(result.state, BASE + 1);
  assert.equal(interrupted.needsReview, true); assert.equal(interrupted.notification.status, 'delivery_unknown');
  assert.equal(interrupted.notification.code, 'interrupted');
});

for (const outcome of [{ status: 'delivery_unknown' }, { status: 'accepted', messageId: 'bad/id' }, { status: 'accepted' }]) {
  test(`uncertain outcome ${JSON.stringify(outcome)} survives serialization and blocks all future notices`, () => {
    let result = observe(initialState(), 0, { ready: 101 });
    let state = settleNotification(result.state, outcome, BASE + 1);
    state = validState(JSON.parse(JSON.stringify(state)));
    assert.equal(state.needsReview, true);
    result = observe(state, 1, { ready: 101, failuresLastHour: 6 }); assert.equal(result.intent, null);
    result = observe(result.state, 2); result = observe(result.state, 3);
    assert.equal(result.intent, null); assert.equal(result.state.incident, null);
    result = observe(result.state, 290, { ready: 101 });
    assert.equal(result.intent, null); assert.equal(result.state.needsReview, true);
    assert.equal(result.state.notification.id, 'cleanup-1-open');
  });
}

test('duplicate and out-of-order slots preserve state without extra incidents or quota', () => {
  const state = accepted(observe(initialState(), 2, { ready: 101 }));
  for (const tick of [2,1,0]) {
    const result = reduceObservation(state, { now: BASE + tick * 300_000, slot: scheduledSlot(BASE + tick * 300_000, BASE + tick * 300_000), alertsEnabled: true });
    assert.equal(result.ignored, true); assert.deepEqual(result.state, state); assert.equal(result.intent, null);
  }
});

for (const [name, mutate] of Object.entries({
  stale: b => { b.health.generatedAt = iso(BASE - 120_001); }, future: b => { b.health.generatedAt = iso(BASE + 5_001); },
  wrong_version: b => { b.health.schemaVersion = 2; }, private_payload: b => { b.health.memberId = 'private'; },
  malformed_date: b => { b.health.generatedAt = '2026-02-30T12:00:00.000Z'; },
  negative: b => { b.health.cleanup.ready = -1; }, unsafe_count: b => { b.health.cleanup.ready = 2 ** 54; },
  stale_cleanup: b => { b.health.cleanup.generatedAt = iso(BASE - 120_001); },
  future_ready: b => { b.health.cleanup.oldestReadyAt = iso(BASE + 5_001); },
  unsafe_status: b => { b.health.cron.lastRuns[0].status = 'private-error-path'; },
  alias_id: b => { b.health.cron.lastRuns[0].runId = '01'; }, overflow_id: b => { b.health.cron.lastRuns[0].runId = '9223372036854775808'; },
  repeated_id: b => { b.health.cron.lastRuns[0].runId = b.health.cron.lastRuns[1].runId; },
  three_runs: b => { b.health.cron.lastRuns.push(b.health.cron.lastRuns[1]); },
  absent_success_time: b => { b.health.cron.lastRuns[0].endedAt = null; },
  end_before_start: b => { b.health.cron.lastRuns[0].endedAt = iso(BASE - 130_000); },
  future_run: b => { b.health.cron.lastRuns[0].endedAt = iso(BASE + 5_001); },
  wrong_transport: b => { b.health.cron.transportEvidence = 'HTTP delivered'; },
  private_command: b => { b.health.cron.command = 'SECRET'; },
  missing_active: b => { b.health.cron.active = null; },
})) {
  test(`snapshot rejects ${name} without embedding its contents in errors`, () => {
    const body = response(); mutate(body);
    assert.throws(() => parseHealth(body, BASE), { message: 'Monitor data is invalid.' });
  });
}

test('freshness boundary allows reviewed clock tolerance but not repeated timestamps', () => {
  for (const shift of [-120_000, 5_000]) {
    const body = response(BASE + shift); assert.doesNotThrow(() => parseHealth(body, BASE));
  }
  assert.throws(() => parseHealth(response(), BASE, BASE));
  assert.throws(() => parseHealth(response(), BASE, BASE + 1));
});

for (const jobState of ['unavailable','missing','ambiguous']) {
  test(`explicit ${jobState} schedule metadata triggers one combined incident`, () => {
    const body = response(); Object.assign(body.health.cron, { jobState, extensionAvailable: jobState !== 'unavailable',
      catalogAvailable: jobState !== 'unavailable', active: null, scheduleMatches: null, historyAvailable: false, stale: true, lastRuns: [] });
    const result = reduceObservation(initialState(), { now: BASE, slot: scheduledSlot(BASE, BASE), health: parseHealth(body, BASE), alertsEnabled: true });
    assert.deepEqual(result.intent.codes, ['cron_unavailable','cron_stale']);
  });
}

test('inactive and changed schedule are separate fixed codes; absent old history cannot hide behind stale:false', () => {
  const body = response(); body.health.cron.active = false; body.health.cron.scheduleMatches = false;
  body.health.cron.lastRuns = []; body.health.cron.historyAvailable = false;
  const result = reduceObservation(initialState(), { now: BASE, slot: scheduledSlot(BASE, BASE), health: parseHealth(body, BASE), alertsEnabled: true });
  assert.deepEqual(result.intent.codes, ['cron_inactive','cron_schedule','cron_stale']);
});

test('rendering is fixed metadata-only and cannot accept arbitrary codes or destination overrides', () => {
  const result = observe(initialState(), 0, { ready: 101 });
  const mail = renderNotification(result.intent);
  assert.equal(mail.from, SENDER); assert.equal(mail.to, RECIPIENT);
  assert.match(mail.subject, /^\[Dominion cleanup\] Alert - incident 1$/);
  assert.match(mail.text, /not HTTP delivery or deletion/); assert.equal(Object.isFrozen(mail), true);
  for (const mutate of [n => { n.codes = ['private-path']; }, n => { n.to = 'other@example.com'; }, n => { n.incident = '1\r\nBcc: other@example.com'; }]) {
    const intent = structuredClone(result.intent); mutate(intent); assert.throws(() => renderNotification(intent));
  }
});

test('state rejects unknown versions/fields, overlarge records and false delivery assertions rather than resetting', () => {
  const state = accepted(observe(initialState(), 0, { ready: 101 }));
  for (const mutate of [s => { s.version = 2; }, s => { s.secret = 'private'; }, s => { s.daily.count = 7; },
    s => { s.lastCodes = ['private']; }, s => { s.notification.providerMessageId = null; },
    s => { s.notification.status = 'sending'; }, s => { s.notification.codes = []; },
    s => { s.notification.code = 'x'.repeat(9000); }]) {
    const candidate = structuredClone(state); mutate(candidate); assert.throws(() => validState(candidate));
  }
  assert.ok(JSON.stringify(state).length < 8192); assert.ok(state.lastCodes.every(c => CONDITIONS.includes(c)));
});

test('Cloudflare second/millisecond offsets map only approved cron minutes to the unchanged durable slot', () => {
  const observed = 1791405155000;
  assert.equal(iso(observed), '2026-10-07T20:32:35.000Z');
  assert.equal(scheduledSlot(observed, observed), Math.floor(observed / 300_000));
  for (let tick = 0; tick < 12; tick++) {
    const minute = BASE + tick * 300_000;
    for (const offset of [0,1,35_000,55_000,59_999]) {
      assert.equal(scheduledSlot(minute + offset, minute + offset), Math.floor(minute / 300_000));
    }
  }
  const hour = BASE - 120_000;
  for (let minute = 0; minute < 60; minute++) {
    if (minute % 5 === 2) continue;
    for (const offset of [0,59_999]) {
      const at = hour + minute * 60_000 + offset;
      assert.throws(() => scheduledSlot(at, at), { message: 'Monitor data is invalid.' });
    }
  }
});

test('raw scheduled timestamps retain exact delay/future bounds before minute normalization', () => {
  for (const scheduled of [BASE,BASE + 35_000,BASE + 59_999]) {
    assert.doesNotThrow(() => scheduledSlot(scheduled, scheduled + 120_000));
    assert.doesNotThrow(() => scheduledSlot(scheduled, scheduled - 5_000));
    assert.throws(() => scheduledSlot(scheduled, scheduled + 120_001));
    assert.throws(() => scheduledSlot(scheduled, scheduled - 5_001));
  }
  for (const invalid of [undefined,null,true,String(BASE),NaN,Infinity,-1,BASE + 0.5,Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => scheduledSlot(invalid, BASE));
    assert.throws(() => scheduledSlot(BASE, invalid));
  }
});

test('exact protected reconciliation resumes without retrying or claiming delivery of an uncertain notice', () => {
  let result = observe(initialState(), 0, { ready: 101 });
  const unknown = settleNotification(result.state, { status: 'delivery_unknown' }, BASE + 1);
  assert.deepEqual(reconcileNotification(unknown, 'cleanup-999-open', BASE + 2), unknown);
  const reviewed = reconcileNotification(unknown, 'cleanup-1-open', BASE + 2);
  assert.equal(reviewed.needsReview, false);
  assert.equal(reviewed.notification.status, 'delivery_unknown');
  assert.equal(reviewed.notification.providerMessageId, null);
  assert.equal(reviewed.daily.count, 1);
  assert.deepEqual(reviewed.reconciliation, { notificationId: 'cleanup-1-open', acknowledgedAt: BASE + 2, action: 'resume_without_retry' });
  assert.deepEqual(reconcileNotification(reviewed, 'cleanup-1-open', BASE + 3), reviewed);
  result = observe(reviewed, 1, { ready: 101 });
  assert.equal(result.intent, null);
  result = observe(result.state, 2, { ready: 101, failuresLastHour: 6 });
  assert.equal(result.intent.kind, 'update');
  const secondUnknown = settleNotification(result.state, { status: 'delivery_unknown' }, BASE + 600_001);
  assert.equal(reconcileNotification(secondUnknown, 'cleanup-1-open', BASE + 600_002).needsReview, true);
});
