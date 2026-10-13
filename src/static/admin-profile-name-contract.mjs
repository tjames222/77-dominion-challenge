// Pure, bounded contracts. These values confer no authority; the server checks
// the current actor, permissions, recent MFA and target eligibility separately.
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const stamp = value => typeof value === 'string' && value.length <= 40
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
const error = (code = 'ADMIN_UNAVAILABLE') => Object.assign(new Error(code === 'ADMIN_INVALID_INPUT'
  ? 'Enter a valid display name and review this account again.' : 'The display-name response is unavailable.'), { code });
const edgeSpace = /^[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]|[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$/u;
export const PROFILE_NAME_FAILURES = Object.freeze(['invalid_input', 'revision_conflict', 'self_action_forbidden', 'target_unavailable', 'profile_unavailable', 'unsupported_legacy_name', 'rate_limited']);
const unavailable = ['self_action_forbidden', 'target_unavailable', 'missing_profile', 'missing_version', 'unsupported_legacy_name'];
export function validAdminProfileName(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 240 || edgeSpace.test(value)
    || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) return false;
  const points = Array.from(value);
  return points.length <= 120 && !points.some(point => { const code = point.codePointAt(0); return code >= 0xd800 && code <= 0xdfff; })
    && new TextEncoder().encode(value).length <= 480;
}
export function normalizeAdminProfileName(value, { actorId, targetUserId }) {
  const profile = value?.profile;
  if (!uuid(actorId) || !uuid(targetUserId) || value?.schemaVersion !== 1 || value.actorId !== actorId
    || value.targetUserId !== targetUserId || !stamp(value.observedAt) || !profile) throw error();
  if (profile.state === 'editable') {
    if (actorId === targetUserId || profile.reason !== null || !validAdminProfileName(profile.name)
      || !uuid(profile.version) || !stamp(profile.updatedAt)) throw error();
  } else if (profile.state !== 'unavailable' || !unavailable.includes(profile.reason)
    || profile.name !== null || profile.version !== null || profile.updatedAt !== null
    || (profile.reason === 'self_action_forbidden' && actorId !== targetUserId)) throw error();
  return { schemaVersion: 1, actorId, targetUserId, observedAt: value.observedAt,
    profile: { state: profile.state, reason: profile.reason, name: profile.name, version: profile.version, updatedAt: profile.updatedAt } };
}
export function profileNameArguments(intent) {
  if (!intent || !uuid(intent.actorId) || !uuid(intent.targetUserId) || intent.actorId === intent.targetUserId
    || typeof intent.sessionIdentity !== 'string' || !intent.sessionIdentity.length || intent.sessionIdentity.length > 160
    || /[\x00-\x1f\x7f]/.test(intent.sessionIdentity) || !uuid(intent.expectedVersion)
    || !uuid(intent.operationId) || !uuid(intent.correlationId) || !validAdminProfileName(intent.name)) throw error('ADMIN_INVALID_INPUT');
  return { target_user_id: intent.targetUserId, target_expected_version: intent.expectedVersion, target_name: intent.name,
    target_operation_id: intent.operationId, target_correlation_id: intent.correlationId };
}
export function createProfileNameIntent(snapshot, owner, name, randomUUID = () => crypto.randomUUID()) {
  const value = normalizeAdminProfileName(snapshot, { actorId: owner?.actorId, targetUserId: snapshot?.targetUserId });
  if (value.profile.state !== 'editable') throw error('ADMIN_INVALID_INPUT');
  const intent = { actorId: owner.actorId, sessionIdentity: owner.sessionIdentity, targetUserId: value.targetUserId,
    expectedVersion: value.profile.version, name, operationId: randomUUID(), correlationId: randomUUID() };
  profileNameArguments(intent); return Object.freeze(intent);
}
export function normalizeProfileNameReceipt(value, intent) {
  profileNameArguments(intent);
  const envelope = ['schemaVersion', 'actorId', 'targetUserId', 'operationId', 'correlationId', 'ok'];
  if (!value || value.schemaVersion !== 1 || ['actorId', 'targetUserId', 'operationId', 'correlationId'].some(key => value[key] !== intent[key])) throw error();
  if (value.ok === true && typeof value.changed === 'boolean' && uuid(value.version)
    && (value.changed ? value.version !== intent.expectedVersion : value.version === intent.expectedVersion)
    && Object.keys(value).every(key => [...envelope, 'changed', 'version'].includes(key))) {
    return { schemaVersion: 1, actorId: value.actorId, targetUserId: value.targetUserId, operationId: value.operationId,
      correlationId: value.correlationId, ok: true, changed: value.changed, version: value.version };
  }
  if (value.ok === false && PROFILE_NAME_FAILURES.includes(value.error)
    && Object.keys(value).every(key => [...envelope, 'error'].includes(key))) return { schemaVersion: 1, actorId: value.actorId,
    targetUserId: value.targetUserId, operationId: value.operationId, correlationId: value.correlationId, ok: false, error: value.error };
  throw error();
}
export function normalizeProfileNameAudit(value) {
  if (value?.action !== 'users.display_name.correct' || value.permission !== 'users.manage' || value.reasonCode !== 'profile_name_correction'
    || !uuid(value.actorId) || !uuid(value.targetUserId) || value.beforeRole !== null || value.afterRole !== null) throw error();
  const before = value.beforeProfileNameVersion; const after = value.afterProfileNameVersion; const changed = value.profileNameChanged;
  if (value.outcome === 'success') {
    if (value.errorCode !== null || value.actorId === value.targetUserId || !uuid(before) || !uuid(after) || typeof changed !== 'boolean'
      || (changed ? before === after : before !== after)) throw error();
  } else if (value.outcome !== 'failure' || !PROFILE_NAME_FAILURES.filter(code => code !== 'rate_limited').includes(value.errorCode)
    || before !== null || after !== null || changed !== null) throw error();
  return { beforeProfileNameVersion: before, afterProfileNameVersion: after, profileNameChanged: changed };
}
