import { adminReadError, normalizeAdminContext, withAdminReadDeadline } from './admin-read-client.mjs';
import { isRequesterId, normalizeRequesterAccount } from './admin-requester-account.mjs';

// Exact IDs only. Do not silently trim, infer a prefix, or send invalid input.
export const parseAdminLookupUserId = value => isRequesterId(value) ? value.toLowerCase() : null;

// Unlike requester drill-down this is a Users-only read. Keep its permission
// check separate: the request inbox still requires operations.read as well.
export async function readAdminUserLookup({ getOwner, getContext, readUser, owner, userId, signal, timeoutMs = 10000 }) {
  if (!isRequesterId(owner?.actorId) || typeof owner.sessionIdentity !== 'string' || !owner.sessionIdentity.length
    || typeof userId !== 'string' || parseAdminLookupUserId(userId) !== userId) throw adminReadError();
  const actorId = owner.actorId; const sessionIdentity = owner.sessionIdentity;
  return withAdminReadDeadline(async ({ signal: readSignal, assertActive }) => {
    const options = { expectedUserId: actorId, signal: readSignal };
    const checkOwner = async () => {
      assertActive(); const current = await getOwner({ signal: readSignal }); assertActive();
      if (current?.actorId !== actorId || current?.sessionIdentity !== sessionIdentity) throw adminReadError('ADMIN_CHANGED');
    };
    const checkContext = async () => {
      assertActive(); const raw = await getContext(options); assertActive();
      const context = normalizeAdminContext(raw, actorId);
      if (!context.adminReady || !context.permissions.includes('users.read')) throw adminReadError('ADMIN_DENIED');
    };
    await checkOwner(); await checkContext(); assertActive();
    const result = await readUser(userId, options); assertActive();
    await checkOwner(); await checkContext(); await checkOwner(); assertActive();
    return normalizeRequesterAccount(result, { actorId, requesterId: userId });
  }, { signal }, timeoutMs);
}
