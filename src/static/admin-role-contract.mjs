// Pure data validation: no session client/API import (including through a
// dynamic write entry) may turn this contract into a shared-shell dependency.
const adminReadError = (code = 'ADMIN_UNAVAILABLE') => Object.assign(new Error(code === 'ADMIN_INVALID_INPUT'
  ? 'The reviewed role change is invalid.' : 'The role-change response is unavailable.'), { code });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const roles = ['member', 'site_admin'];
export const ROLE_REASONS = Object.freeze({ staff_access_review: 'Staff access review', approved_role_change: 'Approved role change', recovery_plan: 'Recovery plan' });
const revision = (value) => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
const identity = (value) => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\x00-\x1f\x7f]/.test(value);
const uuid = (value) => typeof value === 'string' && UUID.test(value);

// The existing RPC returns bigint revisions as JSON numbers. Never attempt to
// recover a rounded revision by converting it to a string; fail closed instead.
export function normalizeRoleTarget(value) {
  if (!value || !uuid(value.id) || !roles.includes(value.role) || !revision(value.roleRevision)) throw adminReadError('ADMIN_INVALID_INPUT');
  return { id: value.id, role: value.role, roleRevision: value.roleRevision };
}
export function createRoleAssignmentIntent(item, owner, decision, randomUUID = () => crypto.randomUUID()) {
  const target = normalizeRoleTarget(item);
  const candidate = { actorId: owner?.actorId, sessionIdentity: owner?.sessionIdentity, targetUserId: target.id,
    previousRole: target.role, role: decision?.role, revision: target.roleRevision,
    operationId: randomUUID(), correlationId: randomUUID(), reasonCode: decision?.reasonCode };
  roleAssignmentArguments(candidate);
  return Object.freeze(candidate);
}
export function roleAssignmentArguments(intent) {
  if (!intent || !uuid(intent.actorId) || !identity(intent.sessionIdentity) || !uuid(intent.targetUserId)
    || intent.actorId.toLowerCase() === intent.targetUserId.toLowerCase() || !roles.includes(intent.previousRole)
    || !roles.includes(intent.role) || intent.role === intent.previousRole || !revision(intent.revision)
    || !uuid(intent.operationId) || !uuid(intent.correlationId) || !Object.hasOwn(ROLE_REASONS, intent.reasonCode)) throw adminReadError('ADMIN_INVALID_INPUT');
  return { target_user_id: intent.targetUserId, target_role: intent.role, target_expected_revision: intent.revision,
    target_request_id: intent.operationId, target_correlation_id: intent.correlationId, target_reason_code: intent.reasonCode };
}
export function normalizeRoleAssignment(value, intent) {
  roleAssignmentArguments(intent);
  if (value?.ok === true && value.role === intent.role && Number.isSafeInteger(value.revision)
    && value.revision === intent.revision + 1 && value.reauthenticationRequired === true) {
    return { ok: true, role: value.role, revision: value.revision, reauthenticationRequired: true };
  }
  if (value?.ok === false && ['invalid_input', 'self_action_forbidden', 'target_unavailable', 'revision_conflict', 'target_mfa_required', 'rate_limited'].includes(value.errorCode)) return { ok: false, errorCode: value.errorCode };
  throw adminReadError();
}
