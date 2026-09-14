const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const EARLY_ACCESS_STATUSES = ['pending', 'approved', 'invited', 'accepted', 'denied', 'expired', 'revoked'];
export const EARLY_ACCESS_REASON = 'early_access_review';
const failure = () => { throw Object.assign(new Error('Early-access records could not be verified.'), { code: 'ADMIN_UNAVAILABLE' }); };
const bounded = (value, limit) => typeof value === 'string' && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
const stamp = (value) => value === null || (typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)));
const revision = (value) => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n;
export function normalizeEarlyAccessRequest(value) {
  if (!value || !UUID.test(value.id) || !bounded(value.name, 120) || !value.name
    || !bounded(value.email, 254) || !value.email || !EARLY_ACCESS_STATUSES.includes(value.status)
    || !revision(value.revision) || !value.requestedAt || !value.updatedAt
    || !['requestedAt', 'updatedAt', 'invitationSentAt', 'invitationExpiresAt', 'acceptedAt'].every((key) => stamp(value[key]))
    || !value.account || !['none', 'ambiguous', 'deleted', 'anonymous', 'suspended', 'confirmed', 'unconfirmed'].includes(value.account.status)
    || (['none', 'ambiguous'].includes(value.account.status) ? value.account.userId !== null : !UUID.test(value.account.userId))) failure();
  return { id: value.id, name: value.name, email: value.email, status: value.status, revision: value.revision,
    requestedAt: value.requestedAt, updatedAt: value.updatedAt, invitationSentAt: value.invitationSentAt,
    invitationExpiresAt: value.invitationExpiresAt, acceptedAt: value.acceptedAt,
    account: { status: value.account.status, userId: value.account.userId } };
}
export function normalizeEarlyAccessHistory(value, requestId) {
  if (!value || !revision(value.id) || value.id === '0' || value.requestId !== requestId
    || !UUID.test(value.actorId) || !UUID.test(value.operationId) || !UUID.test(value.correlationId)
    || value.action !== 'early_access.deny' || value.permission !== 'operations.manage' || value.reasonCode !== EARLY_ACCESS_REASON
    || !['production', 'preview', 'local'].includes(value.environment) || !value.occurredAt || !stamp(value.occurredAt)
    || !['success', 'failure'].includes(value.outcome)
    || ![null, ...EARLY_ACCESS_STATUSES].includes(value.beforeStatus)
    || ![null, ...EARLY_ACCESS_STATUSES].includes(value.afterStatus)) failure();
  if (value.outcome === 'success' ? value.beforeStatus !== 'pending' || value.afterStatus !== 'denied' || value.errorCode !== null
    : !['invalid_input', 'revision_conflict', 'target_unavailable', 'invalid_state'].includes(value.errorCode) || value.afterStatus !== value.beforeStatus) failure();
  return Object.fromEntries(['id', 'actorId', 'requestId', 'action', 'permission', 'reasonCode', 'beforeStatus', 'afterStatus',
    'operationId', 'correlationId', 'environment', 'occurredAt', 'outcome', 'errorCode'].map((key) => [key, value[key]]));
}
export function createEarlyAccessDenialIntent(item, owner, uuid = () => crypto.randomUUID()) {
  const request = normalizeEarlyAccessRequest(item);
  if (request.status !== 'pending' || !owner || !UUID.test(owner.actorId) || !bounded(owner.sessionIdentity, 160) || !owner.sessionIdentity) failure();
  const operationId = uuid(); const correlationId = uuid();
  if (!UUID.test(operationId) || !UUID.test(correlationId)) failure();
  return Object.freeze({ actorId: owner.actorId, sessionIdentity: owner.sessionIdentity, requestId: request.id,
    revision: request.revision, operationId, correlationId, reasonCode: EARLY_ACCESS_REASON });
}
export function earlyAccessDenialArguments(intent) {
  if (!intent || !UUID.test(intent.actorId) || !UUID.test(intent.requestId) || !UUID.test(intent.operationId)
    || !UUID.test(intent.correlationId) || !revision(intent.revision) || intent.reasonCode !== EARLY_ACCESS_REASON
    || !bounded(intent.sessionIdentity, 160) || !intent.sessionIdentity) failure();
  return { target_request_id: intent.requestId, target_expected_revision: intent.revision,
    target_operation_id: intent.operationId, target_correlation_id: intent.correlationId };
}
export function normalizeEarlyAccessDenial(value, intent) {
  earlyAccessDenialArguments(intent);
  if (value?.ok === true && value.requestId === intent.requestId && value.status === 'denied'
    && revision(value.revision) && BigInt(value.revision) === BigInt(intent.revision) + 1n) {
    return { ok: true, requestId: value.requestId, status: 'denied', revision: value.revision };
  }
  if (value?.ok === false && ['invalid_input', 'revision_conflict', 'target_unavailable', 'invalid_state', 'rate_limited'].includes(value.errorCode)) {
    return { ok: false, errorCode: value.errorCode };
  }
  failure();
}
