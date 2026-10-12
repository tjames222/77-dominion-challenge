import { adminReadError, normalizeAdminContext, withAdminReadDeadline } from './admin-read-client.mjs';

export const isRequesterId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nullable = check => value => value === null || check(value);
const string = max => value => typeof value === 'string' && Array.from(value).length <= max;
const oneOf = choices => value => choices.includes(value);
const boolean = value => typeof value === 'boolean';
const integer = value => Number.isSafeInteger(value);
const timestamp = value => typeof value === 'string' && value.length <= 40
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
const localDate = value => typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const project = (value, fields) => {
  if (!object(value)) throw adminReadError();
  const result = {};
  for (const [key, check] of Object.entries(fields)) {
    if (!check(value[key])) throw adminReadError();
    result[key] = value[key];
  }
  return result;
};

// Project only the existing account DTO's fixed display fields. Never publish
// part of a malformed response or infer identity from the request ledger.
export function normalizeRequesterAccount(value, { actorId, requesterId }) {
  if (!isRequesterId(actorId) || !isRequesterId(requesterId) || !object(value) || value.schemaVersion !== 1
    || value.actorId !== actorId || !timestamp(value.observedAt) || value.item?.id !== requesterId) throw adminReadError();
  const item = project(value.item, {
    id: isRequesterId, name: nullable(string(120)), email: nullable(string(254)),
    createdAt: nullable(timestamp), emailConfirmedAt: nullable(timestamp), lastSignInAt: nullable(timestamp),
    isAnonymous: boolean, isSuspended: boolean, suspendedUntil: nullable(timestamp), deletedAt: nullable(timestamp),
    role: oneOf(['member', 'site_admin']), roleRevision: value => integer(value) && value >= 0,
    deletionPending: boolean, deletionRequestStatus: nullable(oneOf(['requested', 'in_progress'])),
  });
  if (item.deletionPending !== (item.deletionRequestStatus !== null)) throw adminReadError();
  const nested = {
    crew: { id: isRequesterId, name: nullable(string(80)), role: oneOf(['member', 'admin', 'owner']) },
    activationSnapshot: { storedStatus: oneOf(['not_started', 'scheduled', 'active']), mode: nullable(oneOf(['solo', 'group'])),
      startDate: nullable(localDate), reviewRequired: boolean, recordedAt: nullable(timestamp) },
    statsSnapshot: { totalPoints: integer, storedAppStreak: integer, storedPerfectDayStreak: integer,
      lastSeenLocalDate: nullable(localDate), recordedAt: nullable(timestamp) },
    subscriptionSnapshot: { status: oneOf(['incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused', 'unknown']),
      currentPeriodEnd: nullable(timestamp), cancelAtPeriodEnd: boolean, recordedAt: nullable(timestamp) },
  };
  for (const [key, fields] of Object.entries(nested)) item[key] = value.item[key] === null ? null : project(value.item[key], fields);
  return { item, observedAt: value.observedAt };
}

// Each explicit open/retry is one bounded operation, not one RPC: obtain fresh
// context before and after the exact detail read, plus owner/session fences.
export async function readRequesterAccount({ getOwner, getContext, readUser, owner, requesterId, signal, timeoutMs = 10000 }) {
  if (!isRequesterId(owner?.actorId) || typeof owner.sessionIdentity !== 'string' || !owner.sessionIdentity.length
    || !isRequesterId(requesterId)) throw adminReadError();
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
      if (!context.adminReady || !['operations.read', 'users.read'].every(permission => context.permissions.includes(permission))) throw adminReadError('ADMIN_DENIED');
    };
    await checkOwner(); await checkContext(); assertActive();
    const result = await readUser(requesterId, options); assertActive();
    await checkOwner(); await checkContext(); await checkOwner(); assertActive();
    return normalizeRequesterAccount(result, { actorId, requesterId });
  }, { signal }, timeoutMs);
}
