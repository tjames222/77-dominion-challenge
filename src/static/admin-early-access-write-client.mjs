import { earlyAccessDenialArguments, normalizeEarlyAccessDenial } from './admin-early-access-contract.mjs';

// Loaded only for an explicit denial. The owning Admin client supplies its
// request-scoped lifecycle guards; this module keeps no authority or payloads.
export async function runEarlyAccessDenial(intent, { signal }, {
  capture, assertCurrent, assertEpoch, changed, pending, request, adminReadError, normalizeAdminContext,
}) {
  const args = earlyAccessDenialArguments(intent);
  let owner;
  try {
    owner = await capture(intent.actorId);
    if (owner.identity !== intent.sessionIdentity) throw adminReadError('ADMIN_CHANGED');
  } catch (error) {
    if (['ADMIN_SIGNED_OUT', 'ADMIN_CHANGED'].includes(error?.code)) changed(error.code);
    throw adminReadError(error?.code);
  }
  const controller = new AbortController(); pending.add(controller);
  const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw adminReadError();
    const rawContext = await request('get_site_admin_context', { target_expected_actor_id: owner.actorId },
      { token: owner.token, signal: controller.signal });
    const context = normalizeAdminContext(rawContext, owner.actorId);
    await assertCurrent(owner);
    if (controller.signal.aborted) throw adminReadError();
    if (!context.adminReady || !context.permissions.includes('operations.read') || !context.permissions.includes('operations.manage')) throw adminReadError('ADMIN_DENIED');
    if (typeof rawContext.stepUpRequired !== 'boolean') throw adminReadError();
    if (context.stepUpRequired) throw adminReadError('ADMIN_STEP_UP_REQUIRED');
    const result = await request('site_admin_deny_early_access_request', { ...args, target_expected_actor_id: owner.actorId },
      { token: owner.token, signal: controller.signal });
    await assertCurrent(owner);
    if (controller.signal.aborted) throw adminReadError();
    return normalizeEarlyAccessDenial(result, intent);
  } catch (error) {
    assertEpoch(owner.epoch);
    if (['ADMIN_DENIED', 'ADMIN_SIGNED_OUT', 'ADMIN_CHANGED'].includes(error?.code)) changed(error.code);
    if (String(error?.code || '').startsWith('ADMIN_')) throw error;
    throw adminReadError();
  } finally { pending.delete(controller); signal?.removeEventListener('abort', abort); }
}
