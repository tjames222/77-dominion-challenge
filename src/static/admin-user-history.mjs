import { adminReadError } from './admin-read-client.mjs';

export const USER_HISTORY_PAGE_SIZE = 10;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const sequence = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
const timestamp = value => typeof value === 'string' && value.length <= 40
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
const role = value => value === null || ['member', 'site_admin'].includes(value);
const reasons = {
  initial_admin_bootstrap: 'Initial administrator setup', staff_access_review: 'Staff access review',
  approved_role_change: 'Approved role change', recovery_plan: 'Recovery plan', invitation_acceptance: 'Invitation acceptance',
};
const errors = {
  invalid_input: 'Invalid input', self_action_forbidden: 'Self-action not allowed', target_unavailable: 'Account unavailable',
  revision_conflict: 'Account changed during review', target_mfa_required: 'Account needs MFA',
  invitation_unavailable: 'Invitation unavailable', account_setup_required: 'Account setup required',
  account_unavailable: 'Account unavailable', delivery_not_ready: 'Invitation delivery not ready',
  program_unavailable: 'Early Access unavailable', already_qualified: 'Already qualified',
};
const rules = {
  'roles.bootstrap': { label: 'Initial site-admin assignment', permission: 'roles.manage', reasons: ['initial_admin_bootstrap'], errors: [] },
  'roles.assign': { label: 'Site role review', permission: 'roles.manage', reasons: ['staff_access_review', 'approved_role_change', 'recovery_plan'],
    errors: ['invalid_input', 'self_action_forbidden', 'target_unavailable', 'revision_conflict', 'target_mfa_required'] },
  'early_access.accept': { label: 'Early Access invitation acceptance', permission: 'early_access.accept', reasons: ['invitation_acceptance'],
    errors: ['invitation_unavailable', 'account_setup_required', 'account_unavailable', 'delivery_not_ready', 'program_unavailable', 'already_qualified'] },
};

// Reuse the deployed read contract, projecting only fields this view renders.
// Request-linked invitation decisions are deliberately not reconstructed here.
export function normalizeAdminUserHistory(value, { actorId, targetUserId, cursor = null }) {
  if (!uuid(actorId) || !uuid(targetUserId) || !value || value.schemaVersion !== 1 || value.actorId !== actorId
    || !timestamp(value.observedAt) || !Array.isArray(value.items) || value.items.length > USER_HISTORY_PAGE_SIZE
    || (cursor !== null && !sequence(cursor.id))) throw adminReadError();
  let previous = cursor === null ? 9223372036854775808n : BigInt(cursor.id);
  const items = value.items.map(item => {
    const rule = item && Object.hasOwn(rules, item.action) ? rules[item.action] : null;
    if (!item || !sequence(item.id) || BigInt(item.id) >= previous || item.targetUserId !== targetUserId
      || (item.action === 'roles.bootstrap' ? item.actorId !== null : !uuid(item.actorId))
      || !timestamp(item.occurredAt) || !rule || item.permission !== rule.permission
      || !rule.reasons.includes(item.reasonCode) || !role(item.beforeRole) || !role(item.afterRole)
      || !['success', 'failure'].includes(item.outcome)
      || (item.outcome === 'success' ? item.errorCode !== null : !rule.errors.includes(item.errorCode))
      || (item.action === 'early_access.accept' && (item.actorId !== targetUserId || item.beforeRole !== null || item.afterRole !== null))
      || (item.action === 'roles.bootstrap' && (item.beforeRole !== 'member' || item.afterRole !== 'site_admin'))
      || (item.action === 'roles.assign' && (item.outcome === 'success' ? item.beforeRole === null || item.afterRole === null : item.beforeRole !== item.afterRole))) throw adminReadError();
    previous = BigInt(item.id);
    return { id: item.id, occurredAt: item.occurredAt, action: item.action, actionLabel: rule.label,
      outcome: item.outcome, reasonLabel: reasons[item.reasonCode], errorLabel: item.errorCode === null ? null : errors[item.errorCode],
      beforeRole: item.beforeRole, afterRole: item.afterRole };
  });
  let nextCursor = null;
  if (value.nextCursor !== null) {
    const next = value.nextCursor;
    // Native cursors contain v/actorId/query/id; the explicit local preview
    // uses query/id. Both remain opaque, bounded and anchored to the last row.
    if (!next || typeof next !== 'object' || Array.isArray(next) || items.length !== USER_HISTORY_PAGE_SIZE
      || !sequence(next.id) || next.id !== items.at(-1).id || typeof next.query !== 'string' || !next.query.length
      || new TextEncoder().encode(JSON.stringify(next)).length > 2048
      || Object.keys(next).some(key => !['v', 'actorId', 'query', 'id'].includes(key))
      || (Object.hasOwn(next, 'v') !== Object.hasOwn(next, 'actorId'))
      || (Object.hasOwn(next, 'v') && (next.v !== 1 || next.actorId !== actorId || !/^[0-9a-f]{64}$/.test(next.query)))) throw adminReadError();
    nextCursor = { ...next };
  }
  return { observedAt: value.observedAt, items, nextCursor };
}

// Bound the whole lazy-client/Auth/read operation. An ignored abort may finish
// privately, but cannot dispatch after a delayed owner check or publish late.
export async function readAdminUserHistory({ read, getOwner, owner, targetUserId, cursor = null, signal, timeoutMs = 10000 }) {
  if (!uuid(owner?.actorId) || typeof owner.sessionIdentity !== 'string' || !owner.sessionIdentity.length
    || !uuid(targetUserId) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000 || signal?.aborted) throw adminReadError();
  const controller = new AbortController(); let reject;
  const stopped = new Promise((_, fail) => { reject = fail; });
  const stop = () => { controller.abort(); reject(adminReadError()); };
  const timer = setTimeout(stop, timeoutMs); signal?.addEventListener('abort', stop, { once: true });
  const assertOwner = async () => {
    const current = await getOwner();
    if (controller.signal.aborted) throw adminReadError();
    if (current?.actorId !== owner.actorId || current?.sessionIdentity !== owner.sessionIdentity) throw adminReadError('ADMIN_CHANGED');
  };
  try {
    return await Promise.race([(async () => {
      await assertOwner();
      const result = await read({ target_user_id: targetUserId, target_action: 'all', target_outcome: 'all',
        target_limit: USER_HISTORY_PAGE_SIZE, target_cursor: cursor }, { expectedUserId: owner.actorId, signal: controller.signal });
      await assertOwner();
      return normalizeAdminUserHistory(result, { actorId: owner.actorId, targetUserId, cursor });
    })(), stopped]);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
}
