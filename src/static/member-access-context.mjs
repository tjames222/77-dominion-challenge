const ACCESS_KEYS = ['schemaVersion', 'actorId', 'asOf', 'appAccess', 'legacyMembershipActive',
  'paidSubscriptionActive', 'earlyAccessActive', 'earlyAccessProgram', 'earlyAccessEndsAt', 'betaPriceEligible'];
const exact = (value, keys) => Boolean(value && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)));
export const memberActorId = value => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const timestamp = value => typeof value === 'string' && value.length <= 40
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value));

// Shared, pure contract. Callers choose their own safe UI error; no Auth client,
// feature controller, storage, role metadata or permission cache lives here.
export function normalizeMemberAccessContext(value, actorId) {
  if (!exact(value, ACCESS_KEYS) || value.schemaVersion !== 1 || value.actorId !== actorId
    || !memberActorId(actorId)
    || !timestamp(value.asOf) || ['appAccess', 'legacyMembershipActive', 'paidSubscriptionActive', 'earlyAccessActive', 'betaPriceEligible']
      .some(key => typeof value[key] !== 'boolean')
    || value.earlyAccessProgram !== (value.earlyAccessActive ? 'early_access_v1' : null)
    || !(value.earlyAccessEndsAt === null || timestamp(value.earlyAccessEndsAt))
    || (!value.earlyAccessActive && value.earlyAccessEndsAt !== null)
    || value.appAccess !== (value.legacyMembershipActive || value.earlyAccessActive)
    || (value.paidSubscriptionActive && !value.legacyMembershipActive)) {
    throw new TypeError('Member access could not be verified.');
  }
  return Object.freeze(Object.fromEntries(ACCESS_KEYS.map(key => [key, value[key]])));
}
