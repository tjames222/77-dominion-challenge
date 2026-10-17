import { profileNameArguments, normalizeProfileNameReceipt } from './admin-profile-name-contract.mjs';
import { runProfileNameOperation } from './admin-profile-name-operation.mjs';

// Explicit confirmation only. Never persist/rebase this intent or automatically
// repeat a write whose response was lost. The receipt describes the original
// operation, not the current profile (which requires a separate fresh read).
export async function runProfileNameCorrection(intent, { signal, operation }, guards) {
  if (!operation) return runProfileNameOperation(intent, { signal }, async () => ({
    correctProfileName: (reviewed, options) => runProfileNameCorrection(reviewed, options, guards),
  }));
  const { capture, assertCurrent, assertEpoch, changed, pending, request, adminReadError, normalizeAdminContext } = guards;
  intent = Object.freeze({ ...intent }); const args = profileNameArguments(intent);
  const controller = new AbortController(); pending.add(controller);
  const abort = () => controller.abort();
  // A stalled Auth/request promise may ignore abort forever. Remove the shared
  // pending entry and both listeners immediately, not only when its await ends.
  const cleanup = () => { pending.delete(controller); signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', cleanup); };
  controller.signal.addEventListener('abort', cleanup, { once: true }); signal?.addEventListener('abort', abort, { once: true });
  let owner; let submitted = false;
  const active = () => { operation.assertActive(); if (signal?.aborted || controller.signal.aborted) throw adminReadError(); };
  try {
      active(); owner = await capture(intent.actorId); active();
      if (owner.identity !== intent.sessionIdentity) throw adminReadError('ADMIN_CHANGED');
      const raw = await request('get_site_admin_context', { target_expected_actor_id: owner.actorId }, { token: owner.token, signal: controller.signal });
      const context = normalizeAdminContext(raw, owner.actorId); await assertCurrent(owner); active();
      if (!context.adminReady || !context.permissions.includes('users.read') || !context.permissions.includes('users.manage')) throw adminReadError('ADMIN_DENIED');
      if (typeof raw.stepUpRequired !== 'boolean') throw adminReadError();
      if (context.stepUpRequired) throw adminReadError('ADMIN_STEP_UP_REQUIRED');
      operation.markSubmitted(); submitted = true;
      const value = await request('site_admin_correct_profile_name', { ...args, target_expected_actor_id: owner.actorId }, { token: owner.token, signal: controller.signal });
      await assertCurrent(owner); active(); return normalizeProfileNameReceipt(value, intent);
  } catch (cause) {
    if (owner) assertEpoch(owner.epoch);
    if (['ADMIN_DENIED', 'ADMIN_SIGNED_OUT', 'ADMIN_CHANGED'].includes(cause?.code)) { changed(cause.code); throw cause; }
    if (['ADMIN_STEP_UP_REQUIRED', 'ADMIN_IDEMPOTENCY_CONFLICT'].includes(cause?.code)) throw cause;
    throw adminReadError(submitted ? 'ADMIN_PROFILE_NAME_RESULT_UNCERTAIN' : 'ADMIN_UNAVAILABLE');
  } finally { cleanup(); }
}
