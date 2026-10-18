import { adminReadError } from './admin-read-client.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COVERAGE = 'legacy-activation-migration-reviews-only';
const MIN_TIME = BigInt(Date.parse('0001-01-01T00:00:00Z')) * 1000n;
const MAX_TIME = BigInt(Date.parse('+010000-01-01T00:00:00Z')) * 1000n;

// Validate the actual calendar before Date.parse, which accepts some invalid
// dates by rolling them forward. Retain server microseconds for comparisons;
// neither browser time nor millisecond truncation is a freshness authority.
function timestampMicros(value) {
  if (typeof value !== 'string' || value.length > 40) return null;
  const parts = value.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,6}))?(Z|([+-])(\d\d):(\d\d))$/);
  if (!parts) return null;
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]
    || hour > 23 || minute > 59 || second > 59
    || (parts[8] !== 'Z' && (Number(parts[10]) > 23 || Number(parts[11]) > 59))) return null;
  const base = Date.parse(value.replace(/\.\d{1,6}(?=Z|[+-])/, ''));
  if (!Number.isFinite(base)) return null;
  const result = BigInt(base) * 1000n + BigInt((parts[7] || '').padEnd(6, '0'));
  return result >= MIN_TIME && result < MAX_TIME ? result : null;
}

// Explicit aggregate-only projection. Ignore, and never retain, private rows,
// reasons, evidence, notes or any other extra provider fields.
export function normalizeAdminActivationReviewHealth(value, expectedActorId) {
  if (!object(value) || value.schemaVersion !== 1 || typeof value.actorId !== 'string'
    || !UUID.test(value.actorId) || value.actorId !== expectedActorId || value.coverage !== COVERAGE
    || value.counterLimit !== 1000 || !object(value.unresolved)) throw adminReadError();
  const observed = timestampMicros(value.observedAt);
  const { count, hasMore } = value.unresolved;
  if (observed === null || !Number.isInteger(count) || count < 0 || count > 1000
    || typeof hasMore !== 'boolean' || (hasMore && count !== 1000)) throw adminReadError();
  const state = value.oldestRecordedState;
  if (count === 0) {
    if (state !== 'none' || value.oldestRecordedAt !== null) throw adminReadError();
  } else if (state === 'known') {
    const oldest = timestampMicros(value.oldestRecordedAt);
    if (oldest === null || oldest > observed) throw adminReadError();
  } else if (state !== 'unknown' || value.oldestRecordedAt !== null) throw adminReadError();
  return { schemaVersion: 1, actorId: value.actorId, observedAt: value.observedAt, coverage: COVERAGE,
    counterLimit: 1000, unresolved: { count, hasMore }, oldestRecordedAt: value.oldestRecordedAt, oldestRecordedState: state };
}

export function activationReviewTimestamp(value) {
  const fraction = value.match(/\.(\d{1,6})(?=Z|[+-])/)?.[1];
  return `${new Date(value).toISOString().slice(0, 19).replace('T', ' ')}${fraction ? `.${fraction}` : ''} UTC`;
}
