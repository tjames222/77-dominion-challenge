// Presentation contract only. Counts and event identities come from a verified
// server response (or the isolated preview reducer), never a badge or date cache.
export const ORIGINAL_77_TARGET = 77;
export const MAX_ORIGINAL_CALENDAR_DAY = 3652059;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuid = (value) => typeof value === 'string' && value.length === 36 && UUID.test(value);
const identifier = (value) => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[^A-Za-z0-9:_-]/.test(value);
const KEYS = ['schemaVersion', 'userId', 'instanceId', 'targetCount', 'submittedCount', 'completionState', 'canonicalEvent'];
const EVENT_KEYS = ['id', 'sourceId', 'localDate', 'recordedAt', 'persistedAt'];
function exactRecord(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(descriptors).length === keys.length && keys.every((key) =>
    descriptors[key]?.enumerable && Object.hasOwn(descriptors[key], 'value'));
}
export function original77DateNumber(value) {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const number = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(number) && new Date(number).toISOString().slice(0, 10) === value
    ? number / 86400000 : null;
}
export function original77TimestampValid(value) {
  if (typeof value !== 'string') return false;
  const match = /^((?!0000)\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || match[0] !== value || original77DateNumber(match[1]) === null || +match[2] > 23 || +match[3] > 59 || +match[4] > 59) return false;
  if (match[5] !== 'Z' && (match[5] === '-00:00' || +match[5].slice(1, 3) > 15 || +match[5].slice(4) > 59)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && milliseconds >= -62135596800000 && milliseconds < 253402300800000;
}
export function emptyOriginal77Progress(userId, startDate) {
  return Object.freeze({ schemaVersion: 1, userId, instanceId: `original77:${startDate}`,
    targetCount: ORIGINAL_77_TARGET, submittedCount: 0, completionState: 'in_progress', canonicalEvent: null });
}
export function invalidOriginal77Progress(userId, startDate) {
  return Object.freeze({ ...emptyOriginal77Progress(userId, startDate), submittedCount: null, completionState: 'invalid_evidence' });
}
export function normalizeOriginal77Progress(value, { userId, startDate, preview = false } = {}) {
  try {
    if (!identifier(userId) || original77DateNumber(startDate) === null
      || !exactRecord(value, KEYS) || value.schemaVersion !== 1 || value.userId !== userId
      || value.instanceId !== `original77:${startDate}` || value.targetCount !== ORIGINAL_77_TARGET) return null;
    const count = value.submittedCount; const state = value.completionState;
    if (state === 'invalid_evidence') {
      return count === null && value.canonicalEvent === null ? invalidOriginal77Progress(userId, startDate) : null;
    }
    if (!Number.isSafeInteger(count) || count < 0 || count > ORIGINAL_77_TARGET) return null;
    if (state === 'in_progress' || state === 'historical_provenance_pending') {
      if (value.canonicalEvent !== null || (state === 'in_progress' ? count >= ORIGINAL_77_TARGET : count !== ORIGINAL_77_TARGET)) return null;
      return Object.freeze({ ...emptyOriginal77Progress(userId, startDate), submittedCount: count, completionState: state });
    }
    const event = value.canonicalEvent;
    if (state !== 'live_completed' || count !== ORIGINAL_77_TARGET || !exactRecord(event, EVENT_KEYS)
      || !uuid(event.id)
      || !(uuid(event.sourceId) || (preview && identifier(event.sourceId)))
      || original77DateNumber(event.localDate) === null || event.localDate < startDate
      || !original77TimestampValid(event.recordedAt) || !original77TimestampValid(event.persistedAt)) return null;
    return Object.freeze({ ...emptyOriginal77Progress(userId, startDate), submittedCount: count, completionState: state,
      canonicalEvent: Object.freeze({ ...event }) });
  } catch { return null; }
}

// Local-demo projection only. Reading old committed rows can establish a
// count, but cannot create the separate completion event or an earned badge.
export function previewOriginal77Progress(value, { userId, startDate } = {}) {
  const invalid = () => invalidOriginal77Progress(userId, startDate);
  if (original77DateNumber(startDate) === null || !userId) return invalid();
  if (value === null || value === undefined) return emptyOriginal77Progress(userId, startDate);
  if (value.schemaVersion !== 1 || !Array.isArray(value.checkIns) || value.checkIns.length > ORIGINAL_77_TARGET) return invalid();
  const actions = new Set(['bible', 'morningPrayer', 'worshipOnly', 'eveningPrayer', 'workoutOne', 'walk', 'workoutTwo']);
  const ids = new Set(); const dates = new Set(); const days = new Set();
  for (const row of value.checkIns) {
    if (!row || row.source !== 'check_in' || !identifier(row.sourceId)
      || original77DateNumber(row.localDate) === null || !original77TimestampValid(row.occurredAt)
      || !Number.isSafeInteger(row.challengeDay) || row.challengeDay < 1
      || original77DateNumber(row.localDate) - row.challengeDay + 1 !== original77DateNumber(startDate)
      || !Array.isArray(row.completed) || row.completed.length < 1 || row.completed.length > 7
      || row.completed.some((action) => !actions.has(action)) || new Set(row.completed).size !== row.completed.length
      || ids.has(row.sourceId) || dates.has(row.localDate) || days.has(row.challengeDay)) return invalid();
    ids.add(row.sourceId); dates.add(row.localDate); days.add(row.challengeDay);
  }
  const events = value.completionEvents ?? [];
  if (!Array.isArray(events) || events.length > 1) return invalid();
  const count = value.checkIns.length;
  let canonicalEvent = null;
  if (events.length) {
    const event = events[0];
    if (!exactRecord(event, ['id', 'userId', 'startDate', 'sourceId', 'localDate', 'recordedAt', 'persistedAt'])
      || event.userId !== userId || event.startDate !== startDate || count !== ORIGINAL_77_TARGET) return invalid();
    const source = value.checkIns.find((row) => row.sourceId === event.sourceId);
    if (!source || source.localDate !== event.localDate || source.occurredAt !== event.recordedAt) return invalid();
    canonicalEvent = { id: event.id, sourceId: event.sourceId, localDate: event.localDate,
      recordedAt: event.recordedAt, persistedAt: event.persistedAt };
  }
  return normalizeOriginal77Progress({ ...emptyOriginal77Progress(userId, startDate), submittedCount: count,
    completionState: canonicalEvent ? 'live_completed' : count === ORIGINAL_77_TARGET ? 'historical_provenance_pending' : 'in_progress',
    canonicalEvent }, { userId, startDate, preview: true }) || invalid();
}
