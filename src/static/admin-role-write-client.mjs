import { roleAssignmentArguments, normalizeRoleAssignment } from './admin-role-contract.mjs';

// Loaded only on an explicit confirmation. No intent/authority is persisted;
// returning from MFA cannot enter this boundary without a new reviewed action.
export async function runRoleAssignment(intent, { signal }, guards) {
  const { capture, assertCurrent, assertEpoch, changed, pending, request, adminReadError, normalizeAdminContext } = guards;
  intent = Object.freeze({ ...intent });
  const args = roleAssignmentArguments(intent);
  const controller = new AbortController(); pending.add(controller);
  const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
  let owner; let submitted = false; let timer;
  const work = async () => {
    if (signal?.aborted) throw adminReadError();
    owner = await capture(intent.actorId);
    if (owner.identity !== intent.sessionIdentity) throw adminReadError('ADMIN_CHANGED');
    if (controller.signal.aborted) throw adminReadError();
    const raw = await request('get_site_admin_context', { target_expected_actor_id: owner.actorId }, { token: owner.token, signal: controller.signal });
    const context = normalizeAdminContext(raw, owner.actorId);
    await assertCurrent(owner);
    if (controller.signal.aborted) throw adminReadError();
    if (!context.adminReady || !context.permissions.includes('roles.manage') || !context.permissions.includes('users.read')) throw adminReadError('ADMIN_DENIED');
    if (typeof raw.stepUpRequired !== 'boolean') throw adminReadError();
    if (context.stepUpRequired) throw adminReadError('ADMIN_STEP_UP_REQUIRED');
    submitted = true;
    const result = await request('site_admin_assign_role', { ...args, target_expected_actor_id: owner.actorId }, { token: owner.token, signal: controller.signal });
    await assertCurrent(owner);
    if (controller.signal.aborted) throw adminReadError();
    return normalizeRoleAssignment(result, intent);
  };
  try {
    return await Promise.race([work(), new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(adminReadError()); }, 20_000);
    })]);
  } catch (error) {
    if (owner) assertEpoch(owner.epoch);
    if (['ADMIN_DENIED', 'ADMIN_SIGNED_OUT', 'ADMIN_CHANGED'].includes(error?.code)) { changed(error.code); throw error; }
    if (['ADMIN_STEP_UP_REQUIRED', 'ADMIN_IDEMPOTENCY_CONFLICT', 'ADMIN_RECOVERY_PROTECTED'].includes(error?.code)) throw error;
    // A malformed/lost/timed-out write response does not prove rollback. Only
    // this state permits the UI to retain the exact request for manual retry.
    throw adminReadError(submitted ? 'ADMIN_ROLE_RESULT_UNCERTAIN' : 'ADMIN_UNAVAILABLE');
  } finally { clearTimeout(timer); pending.delete(controller); signal?.removeEventListener('abort', abort); }
}
