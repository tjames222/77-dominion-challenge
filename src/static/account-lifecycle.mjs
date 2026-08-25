export const ACCOUNT_REQUEST_TYPES = Object.freeze({
  DATA_EXPORT: 'data_export',
  ACCOUNT_DELETION: 'account_deletion',
});

export const ACTIVE_ACCOUNT_REQUEST_STATUSES = Object.freeze([
  'requested',
  'in_progress',
]);

const REQUEST_TYPES = new Set(Object.values(ACCOUNT_REQUEST_TYPES));
const STATUSES = new Set([
  ...ACTIVE_ACCOUNT_REQUEST_STATUSES,
  'fulfilled',
  'cancelled',
  'declined',
]);

export function assertAccountRequestType(requestType) {
  const normalized = String(requestType || '').trim().toLowerCase();
  if (!REQUEST_TYPES.has(normalized)) throw new TypeError('Choose a supported account request.');
  return normalized;
}

export function normalizeAccountLifecycleRequest(row = {}) {
  const requestType = String(row.requestType ?? row.request_type ?? '').trim().toLowerCase();
  const status = String(row.status || '').trim().toLowerCase();
  if (!REQUEST_TYPES.has(requestType) || !STATUSES.has(status)) return null;

  return {
    id: String(row.id || ''),
    userId: String(row.userId ?? row.user_id ?? ''),
    requestType,
    status,
    requestedAt: row.requestedAt ?? row.requested_at ?? null,
    updatedAt: row.updatedAt ?? row.updated_at ?? null,
    resolvedAt: row.resolvedAt ?? row.resolved_at ?? null,
    operatorNote: String(row.operatorNote ?? row.operator_note ?? '').trim(),
  };
}

export function normalizeAccountLifecycleRequests(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map(normalizeAccountLifecycleRequest)
    .filter(Boolean)
    .sort((left, right) => {
      const byRequestedAt = String(right.requestedAt || '').localeCompare(String(left.requestedAt || ''));
      return byRequestedAt || right.id.localeCompare(left.id);
    });
}

export function latestAccountRequestsByType(rows) {
  const latest = new Map();
  normalizeAccountLifecycleRequests(rows).forEach((request) => {
    if (!latest.has(request.requestType)) latest.set(request.requestType, request);
  });
  return latest;
}

export function isActiveAccountRequest(request) {
  return ACTIVE_ACCOUNT_REQUEST_STATUSES.includes(String(request?.status || ''));
}

export function accountRequestStatusLabel(status) {
  return ({
    requested: 'Request received',
    in_progress: 'In progress',
    fulfilled: 'Completed',
    cancelled: 'Canceled',
    declined: 'Unable to complete',
  })[String(status || '')] || 'Status unavailable';
}

export function isActiveAccountRequestConflict(error) {
  return String(error?.code || '') === '23505';
}
