import { adminReadError } from './admin-read-client.mjs';

// Fictional in-memory intake only. There is no fulfillment implementation.
const rows = Array.from({ length: 36 }, (_, index) => {
  const stamp = `2026-01-${String(1 + Math.floor(index / 2)).padStart(2, '0')}T12:00:00Z`;
  const status = index < 28 ? (index % 2 ? 'in_progress' : 'requested') : ['fulfilled', 'cancelled', 'declined'][index % 3];
  return { id: `80000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    userId: index === 35 ? null : `70000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    requestType: index % 2 ? 'account_deletion' : 'data_export', status, requestedAt: stamp,
    updatedAt: stamp, resolvedAt: index < 28 ? null : '2026-02-01T12:00:00Z' };
});

export function previewAccountRequestQueueHealth() {
  return { buckets: ['data_export', 'account_deletion'].flatMap(requestType => ['requested', 'in_progress'].map(status => {
    const matches = rows.filter(row => row.requestType === requestType && row.status === status)
      .sort((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt)).slice(0, 1001);
    return { requestType, status, count: Math.min(matches.length, 1000), hasMore: matches.length > 1000,
      oldestRequestedAt: matches[0]?.requestedAt ?? null };
  })) };
}

export async function previewAccountRequests(args, actorId) {
  const { target_limit: limit = 25, target_request_type: type = 'all', target_status: status = 'active', target_sort: sort = 'oldest' } = args;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !['all', 'data_export', 'account_deletion'].includes(type)
    || !['all', 'active', 'requested', 'in_progress', 'fulfilled', 'cancelled', 'declined'].includes(status)
    || !['oldest', 'newest'].includes(sort)) throw adminReadError('ADMIN_INVALID_INPUT');
  const queryBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`[${[type, status, sort].map(value => JSON.stringify(value)).join(', ')}]`));
  const query = [...new Uint8Array(queryBytes)].map(value => value.toString(16).padStart(2, '0')).join('');
  const cursor = args.target_cursor === undefined ? null : args.target_cursor;
  if (cursor !== null && (typeof cursor !== 'object' || Array.isArray(cursor) || Object.keys(cursor).length !== 5 || cursor.query !== query || cursor.actorId !== actorId || cursor.v !== 1
    || typeof cursor.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(cursor.id)
    || typeof cursor.stamp !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(cursor.stamp) || !Number.isFinite(Date.parse(cursor.stamp))
    || new TextEncoder().encode(JSON.stringify(cursor)).length > 2048)) throw adminReadError('ADMIN_INVALID_CURSOR');
  let matches = rows.filter(row => (type === 'all' || row.requestType === type)
    && (status === 'all' || (status === 'active' ? ['requested', 'in_progress'].includes(row.status) : row.status === status)));
  const compare = (a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt) || a.id.localeCompare(b.id);
  matches.sort((a, b) => compare(a, b) * (sort === 'oldest' ? 1 : -1));
  if (cursor) matches = matches.filter(row => compare(row, { requestedAt: cursor.stamp, id: cursor.id }) * (sort === 'oldest' ? 1 : -1) > 0);
  const items = matches.slice(0, limit).map(row => ({ ...row }));
  const last = items.at(-1);
  return { items, nextCursor: matches.length > limit ? { v: 1, actorId, query, stamp: last.requestedAt, id: last.id } : null };
}
