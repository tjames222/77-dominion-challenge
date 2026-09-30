// Pure evidence assessment only. No caller authentication, database read,
// lifecycle transition, award, or historical reconciliation occurs here.
// A future server adapter must supply canonical rows under its own authority.
export const ORIGINAL_77_REQUIRED_SUBMISSIONS = 77;

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DATE = /^(?!0000)\d{4}-\d{2}-\d{2}$/;
const STAMP = /^((?!0000)\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/;
const ACTIONS = new Set(['bible', 'morningPrayer', 'worshipOnly', 'eveningPrayer', 'workoutOne', 'walk', 'workoutTwo']);
const ROW_KEYS = ['id', 'userId', 'entryDate', 'challengeDay', 'status', 'completed', 'createdAt'];
const DAY_MS = 86_400_000;
const DAY_US = 86_400_000_000n;
const canonicalUuid = (value) => typeof value === 'string' && value.length === 36 && UUID.test(value);

// Snapshot own data properties without invoking accessors or coercing values.
function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(descriptors);
  if (names.length !== keys.length || names.some((key) => typeof key !== 'string' || !keys.includes(key))) return null;
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function list(value, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isInteger(length) || length < 0 || length > maximum
    || Reflect.ownKeys(descriptors).length !== length + 1) return null;
  const result = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return null;
    result.push(descriptor.value);
  }
  return result;
}

function dateNumber(value) {
  if (typeof value !== 'string' || value.length !== 10 || !DATE.test(value)) return null;
  const milliseconds = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().slice(0, 10) === value
    ? milliseconds / DAY_MS : null;
}

// PostgreSQL timestamps retain microseconds. Do not let Date.parse truncate
// different records into a false tie, or infer commit order from these values.
function timestampMicros(value) {
  if (typeof value !== 'string' || value.length > 32) return null;
  const match = STAMP.exec(value);
  if (!match || match[0] !== value) return null;
  const day = dateNumber(match[1]);
  const hour = Number(match[2]); const minute = Number(match[3]); const second = Number(match[4]);
  if (day === null || hour > 23 || minute > 59 || second > 59) return null;
  let offsetSeconds = 0;
  if (match[6] !== 'Z') {
    const offsetHour = Number(match[6].slice(1, 3));
    const offsetMinute = Number(match[6].slice(4, 6));
    // Bound PostgreSQL-compatible explicit offsets; -00:00 denotes unknown
    // offset in RFC3339 and is not an accepted canonical projection here.
    if (offsetHour > 15 || offsetMinute > 59 || match[6] === '-00:00') return null;
    offsetSeconds = (offsetHour * 3600 + offsetMinute * 60) * (match[6][0] === '-' ? -1 : 1);
  }
  const micros = BigInt(day) * DAY_US
    + BigInt(hour * 3600 + minute * 60 + second - offsetSeconds) * 1_000_000n
    + BigInt((match[5] || '').padEnd(6, '0'));
  const minimum = BigInt(dateNumber('0001-01-01')) * DAY_US;
  const maximum = (BigInt(dateNumber('9999-12-31')) + 1n) * DAY_US - 1n;
  return micros >= minimum && micros <= maximum ? micros : null;
}

function result(context, fields = {}) {
  return Object.freeze({
    schemaVersion: 1,
    context,
    valid: false,
    reason: 'invalid_input',
    userId: null,
    instanceId: null,
    submittedCount: null,
    meetsSubmissionRule: false,
    canonicalEvent: null,
    historicalCandidate: null,
    timestampTies: false,
    nonmonotonicTimestamps: false,
    // These remain false even for valid evidence. Only a separately reviewed
    // authoritative writer/reconciler could act on a future server derivation.
    awardAuthorized: false,
    replayAuthorized: false,
    ...fields,
  });
}

function assess(activationValue, rowValues) {
  const activation = record(activationValue, ['userId', 'startDate', 'reviewRequired']);
  if (!activation || !canonicalUuid(activation.userId)
    || dateNumber(activation.startDate) === null || typeof activation.reviewRequired !== 'boolean') {
    return { reason: 'invalid_activation' };
  }
  if (activation.reviewRequired) return { reason: 'activation_review_required' };
  const startDay = dateNumber(activation.startDate);
  const ids = new Set(); const dates = new Set(); const days = new Set();
  const rows = [];
  for (const value of rowValues) {
    const row = record(value, ROW_KEYS);
    if (!row || !canonicalUuid(row.id) || !canonicalUuid(row.userId)
      || dateNumber(row.entryDate) === null
      || !Number.isSafeInteger(row.challengeDay) || row.challengeDay < 1
      || !['complete', 'partial'].includes(row.status)) return { reason: 'invalid_check_in' };
    const completed = list(row.completed, 7);
    if (!completed || !completed.length || completed.some((action) => !ACTIONS.has(action))
      || new Set(completed).size !== completed.length) return { reason: 'invalid_check_in' };
    // Match current private.check_in_badge_facts: either posted status with
    // 1..7 valid actions counts. Status/action-count coupling is not a new rule.
    const micros = timestampMicros(row.createdAt);
    if (micros === null) return { reason: 'invalid_timestamp' };
    if (row.userId !== activation.userId) return { reason: 'owner_mismatch' };
    // challengeDay is a calendar ordinal, not the submission count. Gaps can
    // place the 77th submission after day 77; exact finite dates bound its range.
    if (dateNumber(row.entryDate) - row.challengeDay + 1 !== startDay) return { reason: 'instance_mismatch' };
    if (ids.has(row.id)) return { reason: 'duplicate_check_in_id' };
    if (dates.has(row.entryDate)) return { reason: 'duplicate_entry_date' };
    if (days.has(row.challengeDay)) return { reason: 'duplicate_challenge_day' };
    ids.add(row.id); dates.add(row.entryDate); days.add(row.challengeDay);
    rows.push({ ...row, micros });
  }
  return { activation, rows, instanceId: `original77:${activation.startDate}` };
}

const eventProjection = (row) => Object.freeze({ sourceId: row.id, localDate: row.entryDate, recordedAt: row.createdAt });

/**
 * Assess explicit canonical INSERT context, not an arbitrary client claim.
 * priorRows must be the complete same-instance snapshot before that event.
 * This pure function cannot establish that provenance or authenticate anyone.
 */
export function assessOriginal77LiveSubmission(input) {
  const context = 'canonical_insert';
  try {
    const data = record(input, ['activation', 'priorRows', 'event']);
    if (!data) return result(context);
    const priorRows = list(data.priorRows, ORIGINAL_77_REQUIRED_SUBMISSIONS - 1);
    if (!priorRows) return result(context, { reason: 'invalid_rows' });
    const evidence = assess(data.activation, [...priorRows, data.event]);
    if (evidence.reason) return result(context, { reason: evidence.reason });
    return result(context, {
      valid: true, reason: null, userId: evidence.activation.userId, instanceId: evidence.instanceId,
      submittedCount: evidence.rows.length,
      meetsSubmissionRule: evidence.rows.length === ORIGINAL_77_REQUIRED_SUBMISSIONS,
      canonicalEvent: eventProjection(evidence.rows.at(-1)),
    });
  } catch { return result(context); }
}

/**
 * Historical rows can establish the submission count, never insertion order.
 * Even strictly ordered created_at values provide only an unverified candidate:
 * DEFAULT now() is transaction-start time, not a durable commit sequence.
 */
export function assessOriginal77HistoricalSubmissions(input) {
  const context = 'historical_snapshot';
  try {
    const data = record(input, ['activation', 'rows']);
    if (!data) return result(context);
    const rows = list(data.rows, ORIGINAL_77_REQUIRED_SUBMISSIONS);
    if (!rows) return result(context, { reason: 'invalid_rows' });
    const evidence = assess(data.activation, rows);
    if (evidence.reason) return result(context, { reason: evidence.reason });
    const ordered = [...evidence.rows].sort((a, b) => a.challengeDay - b.challengeDay);
    const timestampTies = new Set(ordered.map((row) => row.micros)).size !== ordered.length;
    const nonmonotonicTimestamps = ordered.some((row, index) => index > 0 && row.micros < ordered[index - 1].micros);
    const meetsSubmissionRule = ordered.length === ORIGINAL_77_REQUIRED_SUBMISSIONS;
    return result(context, {
      valid: true, reason: null, userId: evidence.activation.userId, instanceId: evidence.instanceId,
      submittedCount: ordered.length, meetsSubmissionRule, timestampTies, nonmonotonicTimestamps,
      historicalCandidate: meetsSubmissionRule && !timestampTies && !nonmonotonicTimestamps
        ? Object.freeze({ ...eventProjection(ordered.at(-1)), verified: false }) : null,
    });
  } catch { return result(context); }
}
