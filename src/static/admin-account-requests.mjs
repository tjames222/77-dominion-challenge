import { adminReadError } from './admin-read-client.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuid = value => typeof value === 'string' && UUID.test(value);
const TYPES = new Set(['data_export', 'account_deletion']);
const STATUSES = new Set(['requested', 'in_progress', 'fulfilled', 'cancelled', 'declined']);
const timestamp = value => typeof value === 'string' && value.length <= 40
  && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));

// Operations reads deliberately do not include identity/profile or free text.
export function normalizeAdminAccountRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !uuid(value.id) || (value.userId !== null && !uuid(value.userId))
    || !TYPES.has(value.requestType) || !STATUSES.has(value.status)
    || !timestamp(value.requestedAt) || !timestamp(value.updatedAt)
    || (['requested', 'in_progress'].includes(value.status) ? value.resolvedAt !== null : !timestamp(value.resolvedAt))) throw adminReadError();
  return { id: value.id, userId: value.userId, requestType: value.requestType, status: value.status,
    requestedAt: value.requestedAt, updatedAt: value.updatedAt, resolvedAt: value.resolvedAt };
}

export function normalizeAdminAccountRequestPage(value) {
  if (!value || !timestamp(value.observedAt) || !Array.isArray(value.items) || value.items.length > 50
    || (value.nextCursor !== null && (typeof value.nextCursor !== 'object' || Array.isArray(value.nextCursor)
      || new TextEncoder().encode(JSON.stringify(value.nextCursor)).length > 2048))) throw adminReadError();
  return { schemaVersion: value.schemaVersion, actorId: value.actorId, observedAt: value.observedAt,
    items: value.items.map(normalizeAdminAccountRequest), nextCursor: value.nextCursor };
}

export const accountRequestTypeLabel = value => ({ data_export: 'Data export', account_deletion: 'Account deletion' })[value];
export const accountRequestRecordedStatus = value => ({ requested: 'Requested', in_progress: 'In progress',
  fulfilled: 'Recorded fulfilled', cancelled: 'Cancelled', declined: 'Declined' })[value];

export function normalizeAdminAccountRequestQueueHealth(value) {
  if (!value || value.schemaVersion !== 1 || !uuid(value.actorId) || !timestamp(value.observedAt)
    || !Array.isArray(value.buckets) || value.buckets.length !== 4) throw adminReadError();
  const seen = new Set();
  const buckets = value.buckets.map(bucket => {
    if (!bucket || !TYPES.has(bucket.requestType) || !['requested', 'in_progress'].includes(bucket.status)
      || !Number.isInteger(bucket.count) || bucket.count < 0 || bucket.count > 1000
      || typeof bucket.hasMore !== 'boolean' || (bucket.hasMore && bucket.count !== 1000)
      || (bucket.count === 0 ? bucket.oldestRequestedAt !== null : !timestamp(bucket.oldestRequestedAt))
      || (bucket.count > 0 && Date.parse(bucket.oldestRequestedAt) > Date.parse(value.observedAt))) throw adminReadError();
    const key = `${bucket.requestType}:${bucket.status}`;
    if (seen.has(key)) throw adminReadError(); seen.add(key);
    return { requestType: bucket.requestType, status: bucket.status, count: bucket.count,
      hasMore: bucket.hasMore, oldestRequestedAt: bucket.oldestRequestedAt };
  });
  return { schemaVersion: 1, actorId: value.actorId, observedAt: value.observedAt, buckets };
}
