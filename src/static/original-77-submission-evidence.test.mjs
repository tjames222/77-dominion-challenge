import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  ORIGINAL_77_REQUIRED_SUBMISSIONS,
  assessOriginal77LiveSubmission as live,
  assessOriginal77HistoricalSubmissions as historical,
} from './original-77-submission-evidence.mjs';

const userId = '10000000-0000-4000-8000-000000000001';
const otherId = '10000000-0000-4000-8000-000000000002';
const actions = ['bible', 'morningPrayer', 'worshipOnly', 'eveningPrayer', 'workoutOne', 'walk', 'workoutTwo'];
const activation = () => ({ userId, startDate: '2026-01-01', reviewRequired: false });
const date = (day) => new Date(Date.parse('2026-01-01T00:00:00Z') + (day - 1) * 86_400_000).toISOString().slice(0, 10);
const row = (day, fields = {}) => ({
  id: `20000000-0000-4000-8000-${day.toString(16).padStart(12, '0')}`,
  userId, entryDate: date(day), challengeDay: day, status: 'partial', completed: ['walk'],
  createdAt: `${date(day)}T12:00:00.123456Z`, ...fields,
});
const rows = (count = 77) => Array.from({ length: count }, (_, index) => row(index + 1));
const liveInput = (count = 77) => ({ activation: activation(), priorRows: rows(count - 1), event: row(count) });
const historyInput = (count = 77) => ({ activation: activation(), rows: rows(count) });
function invalid(result, reason) {
  assert.equal(result.valid, false);
  if (reason) assert.equal(result.reason, reason);
  assert.equal(result.submittedCount, null);
  assert.equal(result.meetsSubmissionRule, false);
  assert.equal(result.canonicalEvent, null);
  assert.equal(result.historicalCandidate, null);
  assert.equal(result.awardAuthorized, false);
  assert.equal(result.replayAuthorized, false);
}

test('76 versus77 submitted partials is the explicit content rule, never an award', () => {
  assert.equal(ORIGINAL_77_REQUIRED_SUBMISSIONS, 77);
  for (const count of [1, 7, 76, 77]) {
    const result = live(liveInput(count));
    assert.equal(result.valid, true);
    assert.equal(result.submittedCount, count);
    assert.equal(result.meetsSubmissionRule, count === 77);
    assert.equal(result.instanceId, 'original77:2026-01-01');
    assert.equal(result.userId, userId);
    assert.deepEqual(result.canonicalEvent, { sourceId: row(count).id, localDate: date(count), recordedAt: row(count).createdAt });
    assert.equal(result.historicalCandidate, null);
    assert.equal(result.awardAuthorized, false);
    assert.equal(result.replayAuthorized, false);
  }
});

for (const status of ['complete', 'partial']) for (const completed of Array.from({ length: 7 }, (_, index) => actions.slice(0, index + 1))) {
  test(`${status} plus ${completed.length} distinct actions counts under existing SQL semantics`, () => {
    const input = historyInput();
    input.rows = input.rows.map((entry) => ({ ...entry, status, completed: [...completed] }));
    const result = historical(input);
    assert.equal(result.valid, true);
    assert.equal(result.meetsSubmissionRule, true);
    assert.equal(result.submittedCount, 77);
    assert.equal(Object.hasOwn(result, 'perfect_count'), false);
    assert.equal(Object.hasOwn(result, 'partial_count'), false);
    assert.equal(Object.hasOwn(result, 'badges'), false);
  });
}

test('historical count0/76/77 is independent of award/replay authority', () => {
  for (const count of [0, 76, 77]) {
    const result = historical(historyInput(count));
    assert.equal(result.valid, true);
    assert.equal(result.submittedCount, count);
    assert.equal(result.meetsSubmissionRule, count === 77);
    assert.equal(result.canonicalEvent, null);
    assert.equal(result.awardAuthorized, false);
    assert.equal(result.replayAuthorized, false);
    assert.equal(result.historicalCandidate?.verified ?? false, false);
    if (count === 77) assert.deepEqual(result.historicalCandidate,
      { sourceId: row(77).id, localDate: date(77), recordedAt: row(77).createdAt, verified: false });
    else assert.equal(result.historicalCandidate, null);
  }
});

test('array ordering never chooses an event or changes evidence', () => {
  const before = historyInput();
  const after = { ...before, rows: [...before.rows].reverse() };
  assert.deepEqual(historical(after), historical(before));
  const insert = liveInput();
  assert.deepEqual(live({ ...insert, priorRows: [...insert.priorRows].reverse() }), live(insert));
});

test('live context preserves explicit event despite tied or reversed transaction-start timestamps', () => {
  for (const createdAt of [row(1).createdAt, '0001-01-01T00:00:00Z', row(76).createdAt]) {
    const input = liveInput(); input.event.createdAt = createdAt;
    const result = live(input);
    assert.equal(result.valid, true);
    assert.equal(result.meetsSubmissionRule, true);
    assert.equal(result.canonicalEvent.recordedAt, createdAt);
    assert.equal(result.canonicalEvent.sourceId, input.event.id);
  }
});

test('live content contract does not invent a latest-local-date eligibility prerequisite', () => {
  const input = { activation: activation(), priorRows: rows().slice(1), event: row(1) };
  const result = live(input);
  assert.equal(result.valid, true);
  assert.equal(result.meetsSubmissionRule, true);
  assert.equal(result.canonicalEvent.sourceId, row(1).id);
  assert.equal(result.awardAuthorized, false);
});

test('tied historical timestamps preserve77 count but cannot select a verified crossing', () => {
  const input = historyInput(); input.rows[76].createdAt = input.rows[75].createdAt;
  const result = historical(input);
  assert.equal(result.valid, true); assert.equal(result.submittedCount, 77);
  assert.equal(result.meetsSubmissionRule, true); assert.equal(result.timestampTies, true);
  assert.equal(result.nonmonotonicTimestamps, false); assert.equal(result.historicalCandidate, null);
});

test('nonmonotonic historical timestamps preserve77 count without an invented earned time', () => {
  const input = historyInput(); input.rows[76].createdAt = '2026-01-02T00:00:00Z';
  const result = historical(input);
  assert.equal(result.valid, true); assert.equal(result.meetsSubmissionRule, true);
  assert.equal(result.timestampTies, false); assert.equal(result.nonmonotonicTimestamps, true);
  assert.equal(result.historicalCandidate, null); assert.equal(result.replayAuthorized, false);
});

test('nonadjacent ties and backwards order are independently reported', () => {
  const input = historyInput(); input.rows[76].createdAt = input.rows[0].createdAt;
  const result = historical(input);
  assert.equal(result.meetsSubmissionRule, true);
  assert.equal(result.timestampTies, true); assert.equal(result.nonmonotonicTimestamps, true);
});

test('microsecond-distinct historical stamps are not collapsed into millisecond ties', () => {
  const input = historyInput();
  input.rows = input.rows.map((entry, index) => ({ ...entry, createdAt: `2026-03-18T12:00:00.${String(index + 1).padStart(6, '0')}Z` }));
  const result = historical(input);
  assert.equal(result.valid, true); assert.equal(result.timestampTies, false);
  assert.equal(result.nonmonotonicTimestamps, false); assert.equal(result.historicalCandidate.verified, false);
  assert.equal(result.historicalCandidate.recordedAt, '2026-03-18T12:00:00.000077Z');
});

test('different explicit offsets denoting the same instant are ties', () => {
  const input = historyInput();
  input.rows[75].createdAt = '2026-03-17T12:00:00.123456Z';
  input.rows[76].createdAt = '2026-03-17T05:00:00.123456-07:00';
  const result = historical(input);
  assert.equal(result.timestampTies, true); assert.equal(result.historicalCandidate, null);
  assert.equal(result.meetsSubmissionRule, true);
});

for (const createdAt of ['2026-01-01T00:00:00Z', '2026-01-01T00:00:00+00:00',
  '2026-01-01T12:30:59.1+05:30', '2026-01-01T12:30:59.000001-07:00',
  '0001-01-01T00:00:00.000001Z', '9999-12-31T23:59:59.999999Z']) {
  test(`accepted finite explicit timestamp: ${createdAt}`, () => {
    const input = liveInput(1); input.event.createdAt = createdAt;
    const result = live(input);
    assert.equal(result.valid, true); assert.equal(result.canonicalEvent.recordedAt, createdAt);
  });
}

for (const createdAt of [null, undefined, 0, Infinity, NaN, {}, new Date(), '', 'now', 'infinity', '-infinity',
  '2026-01-01', '2026-01-01T12:00:00', '2026-01-01 12:00:00Z', '2026-01-01T12:00:00z',
  '2026-02-30T12:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T00:60:00Z',
  '2026-01-01T00:00:60Z', '2026-01-01T00:00:00.1234567Z', '2026-01-01T00:00:00.Z',
  '2026-01-01T00:00:00-00:00', '2026-01-01T00:00:00+16:00', '2026-01-01T00:00:00+00:60',
  '0000-01-01T00:00:00Z', '0001-01-01T00:00:00+00:01', '9999-12-31T23:59:59-00:01',
  '2026-01-01T00:00:00Z\n', 'x'.repeat(1000)]) {
  test(`reject malformed/out-of-range timestamp ${String(createdAt).slice(0, 48)}`, () => {
    const input = liveInput(1); input.event.createdAt = createdAt;
    invalid(live(input), 'invalid_timestamp');
  });
}

for (const status of ['draft', 'scheduled', 'submitted', 'COMPLETE', '', null, 1, true]) {
  test(`reject non-posted status ${String(status)}`, () => {
    const input = liveInput(); input.event.status = status;
    invalid(live(input), 'invalid_check_in');
  });
}

for (const completed of [[], ['walk', 'walk'], ['unknown'], ['walk', 'unknown'], ['WALK'],
  ['walk '], [true], [1], [null], actions.concat('walk'), null, 'walk', {}, new Set(['walk'])]) {
  test(`invalid actions are never normalized into count evidence (${JSON.stringify(completed)})`, () => {
    const input = liveInput(); input.priorRows[0].completed = completed;
    invalid(live(input), 'invalid_check_in');
  });
}

for (const challengeDay of [0, -1, 77.1, '77', null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  test(`imported invalid challengeDay ${String(challengeDay)} blocks instead of contributing`, () => {
    const input = historyInput(); input.rows[0].challengeDay = challengeDay;
    invalid(historical(input), 'invalid_check_in');
  });
}

for (const entryDate of ['2026-02-29', '2026-02-31', '0000-01-01', '10000-01-01', '2026-1-01',
  '2026-01-01T00:00:00Z', '2026-01-01\n', null, 1]) {
  test(`invalid local date ${String(entryDate)} is not an instance`, () => {
    const input = historyInput(); input.rows[0].entryDate = entryDate;
    invalid(historical(input), 'invalid_check_in');
  });
}

test('owner and instance must match the exact reviewed activation', () => {
  const owner = historyInput(); owner.rows[0].userId = otherId;
  invalid(historical(owner), 'owner_mismatch');
  const scope = historyInput(); scope.rows[0].entryDate = '2025-12-31';
  invalid(historical(scope), 'instance_mismatch');
  const shiftedDay = historyInput(); shiftedDay.rows[0].challengeDay = 2;
  invalid(historical(shiftedDay), 'instance_mismatch');
  const review = historyInput(); review.activation.reviewRequired = true;
  invalid(historical(review), 'activation_review_required');
});

for (const patch of [{ userId: '' }, { userId: otherId.toUpperCase().replace('1000', 'ABCD') },
  { startDate: '2026-02-30' }, { reviewRequired: 'false' }, { reviewRequired: null }, { startDate: null }]) {
  test(`invalid activation projection ${JSON.stringify(patch)}`, () => {
    const input = historyInput(); Object.assign(input.activation, patch);
    invalid(historical(input), 'invalid_activation');
  });
}

test('duplicate identity/date/day evidence cannot be silently deduplicated', () => {
  const duplicateId = historyInput(); duplicateId.rows[1].id = duplicateId.rows[0].id;
  invalid(historical(duplicateId), 'duplicate_check_in_id');
  const duplicateDateDay = historyInput(); duplicateDateDay.rows[1] = { ...duplicateDateDay.rows[0], id: duplicateDateDay.rows[1].id };
  invalid(historical(duplicateDateDay), 'duplicate_entry_date');
  const repeatedEvent = liveInput(); repeatedEvent.priorRows[0] = { ...repeatedEvent.event };
  invalid(live(repeatedEvent), 'duplicate_check_in_id');
  const exactDuplicate = historyInput(); exactDuplicate.rows[1] = { ...exactDuplicate.rows[0] };
  invalid(historical(exactDuplicate), 'duplicate_check_in_id');
  const conflictingDay = historyInput(); conflictingDay.rows[1].challengeDay = 1;
  invalid(historical(conflictingDay), 'instance_mismatch');
});

test('calendar ordinals do not count missing submissions or finish the original challenge', () => {
  for (const day of [77, 78, 365, 1000]) {
    const result = live({ activation: activation(), priorRows: [], event: row(day) });
    assert.equal(result.valid, true);
    assert.equal(result.submittedCount, 1); assert.equal(result.meetsSubmissionRule, false);
    assert.equal(result.awardAuthorized, false); assert.equal(result.replayAuthorized, false);
  }
  const missing = historyInput(); missing.rows.splice(20, 1);
  assert.equal(historical(missing).submittedCount, 76);
  assert.equal(historical(missing).meetsSubmissionRule, false);
});

test('the 77th submitted partial can arrive on calendar day 78', () => {
  const input = liveInput(); input.event = row(78);
  const result = live(input);
  assert.equal(result.valid, true); assert.equal(result.submittedCount, 77);
  assert.equal(result.meetsSubmissionRule, true);
  assert.deepEqual(result.canonicalEvent, {
    sourceId: row(78).id, localDate: date(78), recordedAt: row(78).createdAt,
  });
  assert.equal(result.instanceId, 'original77:2026-01-01');
  assert.equal(result.awardAuthorized, false); assert.equal(result.replayAuthorized, false);
});

test('77 sparse submitted days qualify without filling or renumbering the gaps', () => {
  const sparse = Array.from({ length: 77 }, (_, index) => row(index * 3 + 1));
  const input = { activation: activation(), rows: sparse };
  const before = JSON.stringify(input);
  const result = historical(input);
  assert.equal(result.valid, true); assert.equal(result.submittedCount, 77);
  assert.equal(result.meetsSubmissionRule, true);
  assert.equal(result.historicalCandidate.sourceId, row(229).id);
  assert.equal(result.historicalCandidate.verified, false);
  assert.equal(result.awardAuthorized, false); assert.equal(result.replayAuthorized, false);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(historical({ ...input, rows: [...sparse].reverse() }), result);
  const unfinished = historical({ ...input, rows: sparse.slice(1) });
  assert.equal(unfinished.submittedCount, 76); assert.equal(unfinished.meetsSubmissionRule, false);
});

test('a delayed original submission still needs the exact recorded start and actor', () => {
  const wrongDay = historyInput(1); wrongDay.rows[0].challengeDay = 78;
  invalid(historical(wrongDay), 'instance_mismatch');
  const wrongStart = { activation: { ...activation(), startDate: date(2) }, rows: [row(78)] };
  invalid(historical(wrongStart), 'instance_mismatch');
  const wrongOwner = { activation: activation(), rows: [row(78, { userId: otherId })] };
  invalid(historical(wrongOwner), 'owner_mismatch');
  const review = { activation: { ...activation(), reviewRequired: true }, rows: [row(78)] };
  invalid(historical(review), 'activation_review_required');
});

test('late duplicate IDs, dates, and calendar ordinals remain invalid evidence', () => {
  const first = row(78); const later = row(150);
  invalid(historical({ activation: activation(), rows: [first, { ...later, id: first.id }] }), 'duplicate_check_in_id');
  invalid(historical({ activation: activation(), rows: [first, { ...first, id: later.id }] }), 'duplicate_entry_date');
  invalid(historical({ activation: activation(), rows: [first, { ...later, challengeDay: first.challengeDay }] }), 'instance_mismatch');
  invalid(live({ activation: activation(), priorRows: [first], event: { ...first } }), 'duplicate_check_in_id');
});

test('late historical timestamps never acquire award or replay provenance', () => {
  for (const mode of ['increasing', 'tie', 'reversed']) {
    const input = historyInput(); input.rows[76] = row(150);
    if (mode === 'tie') input.rows[76].createdAt = input.rows[75].createdAt;
    if (mode === 'reversed') input.rows[76].createdAt = '2026-01-01T00:00:00Z';
    const result = historical(input);
    assert.equal(result.valid, true); assert.equal(result.meetsSubmissionRule, true);
    assert.equal(result.canonicalEvent, null);
    assert.equal(result.historicalCandidate?.verified ?? false, false);
    assert.equal(result.historicalCandidate !== null, mode === 'increasing');
    assert.equal(result.timestampTies, mode === 'tie');
    assert.equal(result.nonmonotonicTimestamps, mode === 'reversed');
    assert.equal(result.awardAuthorized, false); assert.equal(result.replayAuthorized, false);
  }
});

test('late live threshold keeps its explicit event despite nonmonotonic transaction time', () => {
  const input = liveInput(); input.event = row(150, { createdAt: row(1).createdAt });
  const result = live(input);
  assert.equal(result.valid, true); assert.equal(result.meetsSubmissionRule, true);
  assert.equal(result.canonicalEvent.sourceId, row(150).id);
  assert.equal(result.canonicalEvent.recordedAt, row(1).createdAt);
  assert.equal(result.historicalCandidate, null);
  assert.equal(result.awardAuthorized, false); assert.equal(result.replayAuthorized, false);
});

test('positive calendar ordinals are bounded by exact supported Gregorian dates', () => {
  const maximumDay = (Date.parse('9999-12-31T00:00:00Z') - Date.parse('0001-01-01T00:00:00Z')) / 86_400_000 + 1;
  const last = row(1, {
    entryDate: '9999-12-31', challengeDay: maximumDay, createdAt: '9999-12-31T23:59:59.999999Z',
  });
  const input = { activation: { userId, startDate: '0001-01-01', reviewRequired: false }, rows: [last] };
  const result = historical(input);
  assert.equal(result.valid, true); assert.equal(result.submittedCount, 1);
  assert.equal(result.meetsSubmissionRule, false);
  for (const challengeDay of [maximumDay + 1, Number.MAX_SAFE_INTEGER]) {
    invalid(historical({ ...input, rows: [{ ...last, challengeDay }] }), 'instance_mismatch');
  }
});

test('a late event cannot admit a 78th submission into either bounded snapshot', () => {
  const sparse = Array.from({ length: 78 }, (_, index) => row(index * 2 + 1));
  invalid(historical({ activation: activation(), rows: sparse }), 'invalid_rows');
  invalid(live({ activation: activation(), priorRows: sparse.slice(0, 77), event: sparse[77] }), 'invalid_rows');
});

test('no aggregate, elapsed clock, draft, old award, or client flag is an accepted shortcut', () => {
  for (const field of ['completed', 'completion', 'submittedCount', 'points', 'elapsedDay', 'finisherBadge', 'instanceId']) {
    const input = historyInput(); input[field] = true;
    invalid(historical(input), 'invalid_input');
  }
  const rawDraft = historyInput(); rawDraft.rows[0] = { user_id: userId, entry_date: date(1), completed: actions, submitted: true };
  invalid(historical(rawDraft), 'invalid_check_in');
  const extraRowFlag = historyInput(); extraRowFlag.rows[0].submitted = true;
  invalid(historical(extraRowFlag), 'invalid_check_in');
});

test('inputs are bounded exact plain-data projections with no missing or extra keys', () => {
  for (const input of [null, undefined, [], true, 77, 'complete', new Date(), Object.create({ activation: activation(), rows: rows() })]) {
    invalid(historical(input)); invalid(live(input));
  }
  for (const field of ['activation', 'rows']) {
    const input = historyInput(); delete input[field]; invalid(historical(input));
  }
  for (const field of ['id', 'userId', 'entryDate', 'challengeDay', 'status', 'completed', 'createdAt']) {
    const input = historyInput(); delete input.rows[0][field]; invalid(historical(input));
  }
  for (const value of [null, {}, '77', Array(77), rows(78)]) {
    invalid(historical({ activation: activation(), rows: value }));
  }
  invalid(live({ activation: activation(), priorRows: rows(77), event: row(78) }), 'invalid_rows');
  const extraIndex = historyInput(); extraIndex.rows.extra = 'ignored?'; invalid(historical(extraIndex));
  const symbol = historyInput(); symbol[Symbol('hidden')] = true; invalid(historical(symbol));
  const hidden = historyInput(); Object.defineProperty(hidden, 'rows', { enumerable: false }); invalid(historical(hidden));
});

test('UUID projections are canonical lowercase strings without coercion', () => {
  for (const id of ['', 'event-77', '20000000000040008000000000000077', 'ABCDEF00-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000077\n', null, 77, {}]) {
    const input = historyInput(); input.rows[0].id = id; invalid(historical(input));
  }
});

for (const suffix of ['\r', '\n', '\r\n', '\u2028', '\u2029']) {
  test(`line terminator ${JSON.stringify(suffix)} cannot alias any canonical field`, () => {
    for (const [target, field] of [['activation', 'userId'], ['activation', 'startDate'],
      ['event', 'id'], ['event', 'userId'], ['event', 'entryDate'], ['event', 'createdAt']]) {
      const input = liveInput(1); input[target][field] += suffix;
      invalid(live(input));
    }
  });
}

test('accessors and coercion callbacks cannot execute or leak their sentinels', () => {
  let reads = 0;
  const sentinel = 'PRIVATE_DO_NOT_RETURN_932a';
  const getter = () => { reads += 1; throw new Error(sentinel); };
  const inputs = [];
  const top = historyInput(); Object.defineProperty(top, 'rows', { enumerable: true, get: getter }); inputs.push(top);
  const nested = historyInput(); Object.defineProperty(nested.rows[0], 'createdAt', { enumerable: true, get: getter }); inputs.push(nested);
  const array = historyInput(); Object.defineProperty(array.rows, 0, { enumerable: true, get: getter }); inputs.push(array);
  const action = historyInput(); Object.defineProperty(action.rows[0].completed, 0, { enumerable: true, get: getter }); inputs.push(action);
  const coercion = historyInput(); coercion.rows[0].createdAt = { toString: getter, valueOf: getter }; inputs.push(coercion);
  for (const input of inputs) { const result = historical(input); invalid(result); assert.ok(!JSON.stringify(result).includes(sentinel)); }
  assert.equal(reads, 0);
  const proxy = new Proxy({}, { getPrototypeOf() { throw new Error(sentinel); } });
  const result = historical(proxy); invalid(result); assert.ok(!JSON.stringify(result).includes(sentinel));
});

test('null-prototype records and frozen JSON data work without mutation', () => {
  const input = historyInput();
  input.activation = Object.assign(Object.create(null), input.activation);
  input.rows = input.rows.map((entry) => Object.freeze(Object.assign(Object.create(null),
    { ...entry, completed: Object.freeze(entry.completed) })));
  Object.freeze(input.rows); Object.freeze(input.activation); Object.freeze(input);
  const result = historical(input);
  assert.equal(result.meetsSubmissionRule, true); assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.historicalCandidate));
  assert.throws(() => { result.historicalCandidate.verified = true; }, TypeError);
  const liveResult = live(liveInput()); assert.ok(Object.isFrozen(liveResult.canonicalEvent));
});

test('returned evidence cannot later change through mutable input aliases', () => {
  const input = liveInput(); const result = live(input);
  input.event.createdAt = 'changed'; input.event.id = 'changed'; input.activation.startDate = 'changed';
  assert.equal(result.canonicalEvent.recordedAt, row(77).createdAt);
  assert.equal(result.canonicalEvent.sourceId, row(77).id);
  assert.equal(result.instanceId, 'original77:2026-01-01');
});

test('leap dates and years below100 retain exact Gregorian instance arithmetic', () => {
  const input = { activation: { userId, startDate: '0096-02-28', reviewRequired: false }, rows: [
    row(1, { entryDate: '0096-02-28', createdAt: '0096-02-28T12:00:00Z' }),
    row(2, { entryDate: '0096-02-29', createdAt: '0096-02-29T12:00:00Z' }),
    row(3, { entryDate: '0096-03-01', createdAt: '0096-03-01T12:00:00Z' }),
  ] };
  const result = historical(input);
  assert.equal(result.valid, true); assert.equal(result.instanceId, 'original77:0096-02-28');
  assert.equal(result.submittedCount, 3);
});

test('pure evidence remains non-awarding after activation of the separately persisted completion rule', async () => {
  const catalog = JSON.parse(await readFile(new URL('./badge-catalog.v1.json', import.meta.url), 'utf8'));
  assert.equal(catalog.badges.find((badge) => badge.key === 'original_77_completed').status, 'active');
  assert.equal(catalog.badges.find((badge) => badge.key === 'day_77_finisher').status, 'retired');
  const { evaluateBadgeEvent } = await import('./badge-evaluation.mjs');
  assert.deepEqual(evaluateBadgeEvent(live(liveInput())), []);
  const qualifiedHistory = historical(historyInput());
  assert.equal(qualifiedHistory.valid, true);
  assert.equal(qualifiedHistory.meetsSubmissionRule, true);
  assert.deepEqual(evaluateBadgeEvent(qualifiedHistory), []);
  const source = await readFile(new URL('./original-77-submission-evidence.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bimport\s|\bfetch\s*\(|\blocalStorage\b|\bsessionStorage\b|\bconsole\s*\.|Date\.now\s*\(/);
});
