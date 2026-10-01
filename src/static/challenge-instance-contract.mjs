// A read contract, never client-side authority to start, score, or complete a run.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[a-z][a-z0-9_]{0,79}$/;
const MAX_CALENDAR_DAY = 3652059;
const ownRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const nullableUuid = value => value === null || (typeof value === 'string' && UUID.test(value));

export function isInstanceDate(value) {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) || value.startsWith('0000')) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function instanceCalendarDay(startDate, date) {
  if (!isInstanceDate(startDate) || !isInstanceDate(date)) return null;
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000) + 1;
}

function timeZone(value) {
  if (typeof value !== 'string' || !value || value.length > 100) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; }
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !isInstanceDate(value.slice(0, 10))) return false;
  const match = value.slice(11).match(/^(\d{2}):(\d{2}):(\d{2})/);
  return Number(match[1]) <= 23 && Number(match[2]) <= 59 && Number(match[3]) <= 59 && Number.isFinite(Date.parse(value));
}

export function normalizeChallengeInstance(value, { serverDate, preview = false } = {}) {
  if (!ownRecord(value) || typeof value.id !== 'string' || !UUID.test(value.id)
    || typeof value.challengeKey !== 'string' || !KEY.test(value.challengeKey)
    || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 200
    || !['scheduled', 'active', 'completed'].includes(value.status)
    || !isInstanceDate(value.startDate) || !timeZone(value.timeZone)
    || !['solo', 'group'].includes(value.mode) || !(nullableUuid(value.crewId)
      || (preview && typeof value.crewId === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(value.crewId)))
    || (value.mode === 'group' ? value.crewId === null : value.crewId !== null)
    || !integer(value.targetCount, 1, 365) || !integer(value.submittedCount, 0, value.targetCount)
    || typeof value.reviewRequired !== 'boolean'
    || !['live', 'legacy_bound', 'legacy_completed'].includes(value.provenance)
    || !nullableUuid(value.completionEventId)
    || !(value.completedAt === null || timestamp(value.completedAt))) return null;
  const legacyScope = value.challengeKey === 'original_77' && value.scopeKey === `original77:${value.startDate}`;
  if (value.scopeKey !== `instance:${value.id}` && !legacyScope) return null;
  if (value.challengeKey === 'original_77' && value.targetCount !== 77) return null;
  if (value.status === 'scheduled') {
    if (value.calendarDay !== null || value.submittedCount !== 0 || value.completionEventId !== null || value.completedAt !== null) return null;
  } else if (!integer(value.calendarDay, 1, MAX_CALENDAR_DAY)) return null;
  if (serverDate !== undefined) {
    if (!isInstanceDate(serverDate)) return null;
    const day = instanceCalendarDay(value.startDate, serverDate);
    if (value.status === 'scheduled' ? day >= 1 : value.calendarDay !== day) return null;
  }
  if (value.status !== 'completed' && (value.submittedCount >= value.targetCount || value.completionEventId !== null || value.completedAt !== null)) return null;
  if (value.status === 'completed' && value.provenance !== 'legacy_completed'
    && (value.submittedCount !== value.targetCount || value.completionEventId === null || value.completedAt === null)) return null;
  // Imported completed state is preserved, not upgraded into a fabricated live event.
  if (value.provenance === 'legacy_completed' && (value.status !== 'completed' || value.completionEventId !== null)) return null;
  return Object.freeze({ id: value.id, challengeKey: value.challengeKey, title: value.title, scopeKey: value.scopeKey,
    status: value.status, startDate: value.startDate, timeZone: value.timeZone, mode: value.mode, crewId: value.crewId,
    targetCount: value.targetCount, submittedCount: value.submittedCount, calendarDay: value.calendarDay,
    completedAt: value.completedAt, completionEventId: value.completionEventId,
    provenance: value.provenance, reviewRequired: value.reviewRequired });
}

export function normalizeInstanceActivation(value, expectedActorId, { preview = false } = {}) {
  if (!ownRecord(value) || value.schemaVersion !== 2 || !expectedActorId || value.actorId !== expectedActorId
    || !integer(value.revision) || !isInstanceDate(value.serverDate)
    || typeof value.groupMembershipActive !== 'boolean' || typeof value.reviewRequired !== 'boolean') return null;
  const names = ['canActivateSolo', 'canActivateGroup', 'canParticipate', 'canMutateDailyStandards', 'canEditStartDate'];
  if (names.some(name => typeof value[name] !== 'boolean')) return null;
  if (value.reviewRequired && names.some(name => value[name])) return null;
  const instance = value.currentInstance === null ? null : normalizeChallengeInstance(value.currentInstance, { serverDate: value.serverDate, preview });
  if (value.currentInstance !== null && !instance) return null;
  if (!instance) {
    if (value.status !== 'not_started' || [value.mode, value.startDate, value.timeZone, value.crewId].some(field => field !== null)
      || value.canParticipate || value.canMutateDailyStandards || value.canEditStartDate || value.groupMembershipActive) return null;
  } else {
    if (['status', 'mode', 'startDate', 'timeZone', 'crewId', 'reviewRequired'].some(field => value[field] !== instance[field])
      || value.canActivateSolo || value.canActivateGroup
      || (value.mode !== 'group' && value.groupMembershipActive)
      || (value.canParticipate && (instance.status !== 'active' || instance.reviewRequired))
      || (value.canMutateDailyStandards && !value.canParticipate)
      || (value.canEditStartDate && (instance.challengeKey !== 'original_77' || instance.mode !== 'solo'
        || instance.submittedCount !== 0 || instance.status === 'completed' || instance.reviewRequired
        || !instance.scopeKey.startsWith('original77:')))) return null;
  }
  const repeat = value.originalRepeat;
  if (!ownRecord(repeat) || repeat.challengeKey !== 'original_77' || repeat.targetCount !== 77
    || typeof repeat.available !== 'boolean' || typeof repeat.canStart !== 'boolean'
    || !(repeat.reason === null || (typeof repeat.reason === 'string' && repeat.reason.length > 0 && repeat.reason.length <= 120))
    || (repeat.canStart && (!repeat.available || !instance || instance.status !== 'completed' || value.reviewRequired || repeat.reason !== null))
    || (!instance && repeat.available)) return null;
  return { schemaVersion: 2, actorId: expectedActorId, revision: value.revision, serverDate: value.serverDate,
    status: value.status, storedStatus: value.status, mode: value.mode, startDate: value.startDate,
    timeZone: value.timeZone, crewId: value.crewId, groupAttributionCrewId: value.crewId,
    groupMembershipActive: value.groupMembershipActive, reviewRequired: value.reviewRequired,
    currentInstance: instance, originalRepeat: Object.freeze({ ...repeat }),
    challengeDay: instance?.calendarDay ?? null,
    ...Object.fromEntries(names.map(name => [name, value[name]])),
    capabilities: Object.fromEntries(names.map(name => [name, value[name]])),
  };
}
