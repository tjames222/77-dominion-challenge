import { DAILY_STANDARD_ACTION_IDS, WORKOUT_DIFFICULTIES, WORKOUT_IDS } from './daily-standard-draft.mjs';
import { instanceCalendarDay, isInstanceDate } from './challenge-instance-contract.mjs';

// Pure local-preview parity for the repeatable challenge RPCs. Auth/session
// capture, browser storage, navigator locks, clocks, UUID generation, reward
// grants, badge awards and persistence remain the caller's responsibility.
export const PREVIEW_CHALLENGE_INSTANCES_STORAGE_KEY = 'dominion:previewChallengeInstancesV2';

export const PREVIEW_CHALLENGE_INSTANCE_DEFINITIONS = Object.freeze({
  original_77: Object.freeze({ title: '77-Day Dominion Challenge', targetCount: 77, prerequisiteChallengeKey: null }),
  seven_day_reset: Object.freeze({ title: '7-Day Reset', targetCount: 7, prerequisiteChallengeKey: null }),
  twenty_one_day_prayer: Object.freeze({ title: '21-Day Prayer Track', targetCount: 21, prerequisiteChallengeKey: 'seven_day_reset' }),
  thirty_day_strength: Object.freeze({ title: '30-Day Strength Intensive', targetCount: 30, prerequisiteChallengeKey: 'twenty_one_day_prayer' }),
  forty_day_fast: Object.freeze({ title: '40-Day Fasting & Prayer Track', targetCount: 40, prerequisiteChallengeKey: 'thirty_day_strength' }),
  bible_in_a_year: Object.freeze({ title: 'Bible in a Year', targetCount: 365, prerequisiteChallengeKey: 'forty_day_fast' }),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACTOR = /^[A-Za-z0-9:_-]{1,160}$/;
const MAX_ROWS = 10_000;
const MAX_LEGACY_RECORDS = 256;
const LEGACY_RECORD_KEYS = Object.freeze(['userId', 'key', 'status', 'unlockedAt', 'startedAt', 'completedAt',
  'ownedAt', 'celebrationSeenAt', 'grantCatalogVersion', 'grantReason']);
const ACTION_ORDER = new Map(DAILY_STANDARD_ACTION_IDS.map((key, index) => [key, index]));
const ACTIONS = new Set(DAILY_STANDARD_ACTION_IDS);
const WORKOUTS = new Set(WORKOUT_IDS);
const DIFFICULTIES = new Set(WORKOUT_DIFFICULTIES);

function previewError(code, message) {
  return Object.assign(new Error(message), { code });
}

function fail(code, message) {
  throw previewError(code, message);
}

const ownRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const safeInteger = (value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value)
  && !Object.is(value, -0) && value >= minimum && value <= maximum;
const validActor = value => typeof value === 'string' && ACTOR.exec(value)?.[0] === value;
const validUuid = value => typeof value === 'string' && value.length === 36 && UUID.test(value);

function validTimestamp(value) {
  if (typeof value !== 'string' || value.length > 40) return false;
  const match = /^((?!0000)\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || match[0] !== value || !isInstanceDate(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return false;
  return Number.isFinite(Date.parse(value));
}

function validTimeZone(value) {
  if (typeof value !== 'string' || !value || value.length > 100) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function normalizePreservedLegacyRecord(value, actorId) {
  const descriptors = ownRecord(value) ? Object.getOwnPropertyDescriptors(value) : null;
  const snapshot = {};
  if (!descriptors || Reflect.ownKeys(descriptors).length !== LEGACY_RECORD_KEYS.length
    || LEGACY_RECORD_KEYS.some((key) => {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return true;
      snapshot[key] = descriptor.value;
      return false;
    }) || snapshot.userId !== actorId
    || typeof snapshot.key !== 'string' || !/^[a-z0-9][a-z0-9_.:-]{0,99}$/.test(snapshot.key)
    || !['owned', 'available', 'active', 'completed'].includes(snapshot.status)
    || !safeInteger(snapshot.grantCatalogVersion, 1)
    || typeof snapshot.grantReason !== 'string' || !snapshot.grantReason || snapshot.grantReason.length > 120
    || ['unlockedAt', 'startedAt', 'completedAt', 'ownedAt', 'celebrationSeenAt']
      .some(key => snapshot[key] !== null && !validTimestamp(snapshot[key]))) {
    fail('PREVIEW_INSTANCE_STATE_INVALID', 'A preserved preview grant is invalid.');
  }
  if (snapshot.status === 'owned') {
    if (snapshot.ownedAt === null || snapshot.unlockedAt !== null || snapshot.startedAt !== null || snapshot.completedAt !== null) {
      fail('PREVIEW_INSTANCE_STATE_INVALID', 'A preserved preview ownership grant is invalid.');
    }
  } else if (snapshot.ownedAt !== null || snapshot.unlockedAt === null
    || (snapshot.status === 'available' && (snapshot.startedAt !== null || snapshot.completedAt !== null))
    || (snapshot.status === 'active' && (snapshot.startedAt === null || snapshot.completedAt !== null))
    || (snapshot.status === 'completed' && (snapshot.startedAt === null || snapshot.completedAt === null))) {
    fail('PREVIEW_INSTANCE_STATE_INVALID', 'A preserved preview challenge grant is invalid.');
  }
  return snapshot;
}

function canonicalActions(value) {
  if (!Array.isArray(value) || value.length > DAILY_STANDARD_ACTION_IDS.length) return null;
  const actions = [];
  for (const action of value) {
    if (!ACTIONS.has(action) || actions.includes(action)) return null;
    actions.push(action);
  }
  return actions.sort((left, right) => ACTION_ORDER.get(left) - ACTION_ORDER.get(right));
}

function canonicalDifficulty(value) {
  if (!ownRecord(value)) return null;
  const result = {};
  for (const [workoutId, difficulty] of Object.entries(value)) {
    if (!WORKOUTS.has(workoutId) || !DIFFICULTIES.has(difficulty)) return null;
    result[workoutId] = difficulty;
  }
  return Object.fromEntries(WORKOUT_IDS.filter(key => Object.hasOwn(result, key)).map(key => [key, result[key]]));
}

function normalizeRun(value) {
  if (!ownRecord(value) || !validUuid(value.id) || !safeInteger(value.sequenceNo)
    || !Object.hasOwn(PREVIEW_CHALLENGE_INSTANCE_DEFINITIONS, value.challengeKey)
    || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 180
    || !['scheduled', 'active', 'completed'].includes(value.status)
    || !isInstanceDate(value.startDate) || !validTimeZone(value.timeZone)
    || !['solo', 'group'].includes(value.mode)
    || !(value.crewId === null || validActor(value.crewId))
    || (value.mode === 'solo' ? value.crewId !== null : value.crewId === null)
    || !safeInteger(value.submittedCount, 0)
    || typeof value.reviewRequired !== 'boolean'
    || !['live', 'legacy_bound', 'legacy_completed'].includes(value.provenance)
    || !(value.completedAt === null || validTimestamp(value.completedAt))
    || !(value.completionEventId === null || validUuid(value.completionEventId))) {
    fail('PREVIEW_INSTANCE_STATE_INVALID', 'Saved preview challenge run is invalid.');
  }
  const definition = PREVIEW_CHALLENGE_INSTANCE_DEFINITIONS[value.challengeKey];
  if (value.title !== definition.title || value.targetCount !== definition.targetCount || value.submittedCount > definition.targetCount) {
    fail('PREVIEW_INSTANCE_STATE_INVALID', 'Saved preview challenge run does not match its definition.');
  }
  const legacyOriginalScope = value.challengeKey === 'original_77' && value.sequenceNo === 0
    && value.scopeKey === `original77:${value.startDate}`;
  if (value.scopeKey !== `instance:${value.id}` && !legacyOriginalScope) fail('PREVIEW_INSTANCE_STATE_INVALID', 'Saved preview challenge scope is invalid.');
  if (value.status === 'scheduled' && value.submittedCount !== 0) fail('PREVIEW_INSTANCE_STATE_INVALID', 'A scheduled preview challenge cannot have check-ins.');
  if (value.status !== 'completed' && (value.submittedCount >= value.targetCount || value.completedAt !== null || value.completionEventId !== null)) {
    fail('PREVIEW_INSTANCE_STATE_INVALID', 'An open preview challenge contains completion data.');
  }
  if (value.status === 'completed' && value.provenance !== 'legacy_completed'
    && (value.submittedCount !== value.targetCount || value.completedAt === null || value.completionEventId === null)) {
    fail('PREVIEW_INSTANCE_STATE_INVALID', 'A live preview completion is missing its source event.');
  }
  if (value.provenance === 'legacy_completed' && (value.status !== 'completed' || value.completionEventId !== null)) {
    fail('PREVIEW_INSTANCE_STATE_INVALID', 'Historical preview completion evidence cannot be invented.');
  }
  return { id: value.id, sequenceNo: value.sequenceNo, challengeKey: value.challengeKey, title: value.title,
    scopeKey: value.scopeKey, status: value.status, startDate: value.startDate, timeZone: value.timeZone,
    mode: value.mode, crewId: value.crewId, targetCount: value.targetCount, submittedCount: value.submittedCount,
    completedAt: value.completedAt, completionEventId: value.completionEventId,
    provenance: value.provenance, reviewRequired: value.reviewRequired };
}

function normalizeDraft(value, runIds) {
  const completed = canonicalActions(value?.completed);
  const workoutDifficulty = canonicalDifficulty(value?.workoutDifficulty);
  if (!ownRecord(value) || !runIds.has(value.instanceId) || !isInstanceDate(value.localDate)
    || completed === null || workoutDifficulty === null || !safeInteger(value.version)
    || !(value.updatedAt === null || validTimestamp(value.updatedAt))) {
    fail('PREVIEW_INSTANCE_STATE_INVALID', 'Saved preview Daily Action draft is invalid.');
  }
  return { instanceId: value.instanceId, localDate: value.localDate, completed, workoutDifficulty,
    version: value.version, updatedAt: value.updatedAt };
}

function normalizeCheckIn(value, runsById) {
  const run = ownRecord(value) && runsById.get(value.instanceId);
  const completed = canonicalActions(value?.completed);
  const workoutDifficulty = canonicalDifficulty(value?.workoutDifficulty);
  if (!run || !validUuid(value.id) || !isInstanceDate(value.localDate) || completed === null || completed.length === 0
    || workoutDifficulty === null || !['partial', 'complete'].includes(value.status)
    || value.status !== (completed.length === DAILY_STANDARD_ACTION_IDS.length ? 'complete' : 'partial')
    || !safeInteger(value.calendarDay, 1, 3_652_059)
    || value.calendarDay !== instanceCalendarDay(run.startDate, value.localDate)
    || !safeInteger(value.pointsAwarded, 0, completed.length) || !validTimestamp(value.recordedAt)) {
    fail('PREVIEW_INSTANCE_STATE_INVALID', 'Saved preview check-in is invalid.');
  }
  return { id: value.id, instanceId: value.instanceId, localDate: value.localDate, calendarDay: value.calendarDay,
    status: value.status, completed, workoutDifficulty, pointsAwarded: value.pointsAwarded, recordedAt: value.recordedAt };
}

function normalizeCompletion(value, runsById, checkInsById) {
  const run = ownRecord(value) && runsById.get(value.instanceId);
  const source = ownRecord(value) && checkInsById.get(value.sourceCheckInId);
  if (!run || !source || source.instanceId !== value.instanceId || !validUuid(value.id)
    || value.id === value.sourceCheckInId || !isInstanceDate(value.localDate) || value.localDate !== source.localDate
    || value.completedAt !== source.recordedAt || !validTimestamp(value.completedAt) || !validTimestamp(value.persistedAt)
    || value.targetCount !== run.targetCount) {
    fail('PREVIEW_INSTANCE_STATE_INVALID', 'Saved preview completion event is invalid.');
  }
  return { id: value.id, instanceId: value.instanceId, sourceCheckInId: value.sourceCheckInId,
    localDate: value.localDate, completedAt: value.completedAt, persistedAt: value.persistedAt,
    targetCount: value.targetCount };
}

function normalizeRequest(value, runIds) {
  if (!ownRecord(value) || !validUuid(value.requestId) || !['activate_initial', 'start', 'set_start_date'].includes(value.action)
    || typeof value.signature !== 'string' || !value.signature || value.signature.length > 2_048
    || !runIds.has(value.instanceId) || !safeInteger(value.revision, 1)) {
    fail('PREVIEW_INSTANCE_STATE_INVALID', 'Saved preview activation request is invalid.');
  }
  return { requestId: value.requestId, action: value.action, signature: value.signature,
    instanceId: value.instanceId, revision: value.revision };
}

export function createPreviewChallengeInstancesState(input = {}) {
  if (!ownRecord(input) || (input.schemaVersion !== undefined && input.schemaVersion !== 2)
    || !validActor(input.actorId) || !safeInteger(input.revision ?? 0)
    || !(input.currentInstanceId === null || input.currentInstanceId === undefined || validUuid(input.currentInstanceId))
    || !safeInteger(input.lifetimePoints ?? 0) || !safeInteger(input.trustedDailyStandardPoints ?? 0)) {
    fail('PREVIEW_INSTANCE_STATE_INVALID', 'Saved preview challenge state is invalid.');
  }
  const rows = (value, label, maximum = MAX_ROWS) => {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) {
      fail('PREVIEW_INSTANCE_STATE_INVALID', `Saved preview ${label} are invalid.`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== value.length + 1) fail('PREVIEW_INSTANCE_STATE_INVALID', `Saved preview ${label} are invalid.`);
    return Array.from({ length: value.length }, (_, index) => {
      const descriptor = descriptors[index];
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
        fail('PREVIEW_INSTANCE_STATE_INVALID', `Saved preview ${label} are invalid.`);
      }
      return descriptor.value;
    });
  };
  const runs = rows(input.runs ?? [], 'runs').map(normalizeRun);
  const runIds = new Set(); const scopes = new Set(); const sequences = new Set();
  for (const run of runs) {
    if (runIds.has(run.id) || scopes.has(run.scopeKey) || sequences.has(run.sequenceNo)) fail('PREVIEW_INSTANCE_STATE_INVALID', 'Saved preview run identities are not unique.');
    runIds.add(run.id); scopes.add(run.scopeKey); sequences.add(run.sequenceNo);
  }
  const ordered = [...runs].sort((left, right) => left.sequenceNo - right.sequenceNo);
  if (ordered.some((run, index) => run.sequenceNo !== index) || ordered.some((run, index) => run !== runs[index])) {
    fail('PREVIEW_INSTANCE_STATE_INVALID', 'Saved preview run sequence is invalid.');
  }
  const currentInstanceId = input.currentInstanceId ?? null;
  if ((runs.length === 0) !== (currentInstanceId === null)
    || (runs.length > 0 && runs.at(-1).id !== currentInstanceId)
    || runs.filter(run => run.status !== 'completed').length > 1
    || runs.some((run, index) => run.status !== 'completed' && index !== runs.length - 1)) {
    fail('PREVIEW_INSTANCE_STATE_INVALID', 'Saved preview current run is invalid.');
  }
  const runsById = new Map(runs.map(run => [run.id, run]));
  const drafts = rows(input.drafts ?? [], 'drafts').map(value => normalizeDraft(value, runIds));
  const draftKeys = new Set();
  for (const draft of drafts) {
    const key = `${draft.instanceId}:${draft.localDate}`;
    if (draftKeys.has(key)) fail('PREVIEW_INSTANCE_STATE_INVALID', 'Saved preview draft identities are not unique.');
    draftKeys.add(key);
  }
  const checkIns = rows(input.checkIns ?? [], 'check-ins').map(value => normalizeCheckIn(value, runsById));
  const checkInIds = new Set(); const checkInDates = new Set(); const instanceDays = new Set();
  for (const checkIn of checkIns) {
    const instanceDay = `${checkIn.instanceId}:${checkIn.calendarDay}`;
    if (checkInIds.has(checkIn.id) || checkInDates.has(checkIn.localDate) || instanceDays.has(instanceDay)) {
      fail('PREVIEW_INSTANCE_STATE_INVALID', 'Saved preview check-in identities are not unique.');
    }
    checkInIds.add(checkIn.id); checkInDates.add(checkIn.localDate); instanceDays.add(instanceDay);
  }
  for (const run of runs) {
    const sourceCount = checkIns.filter(checkIn => checkIn.instanceId === run.id).length;
    if (sourceCount > run.submittedCount || (run.provenance === 'live' && sourceCount !== run.submittedCount)) {
      fail('PREVIEW_INSTANCE_STATE_INVALID', 'Saved preview check-in count does not match its run.');
    }
  }
  const checkInsById = new Map(checkIns.map(checkIn => [checkIn.id, checkIn]));
  const completionEvents = rows(input.completionEvents ?? [], 'completion events').map(value => normalizeCompletion(value, runsById, checkInsById));
  const eventIds = new Set(); const eventInstances = new Set(); const eventSources = new Set();
  for (const event of completionEvents) {
    if (eventIds.has(event.id) || eventInstances.has(event.instanceId) || eventSources.has(event.sourceCheckInId)) {
      fail('PREVIEW_INSTANCE_STATE_INVALID', 'Saved preview completion identities are not unique.');
    }
    eventIds.add(event.id); eventInstances.add(event.instanceId); eventSources.add(event.sourceCheckInId);
  }
  for (const run of runs) {
    const event = completionEvents.find(candidate => candidate.instanceId === run.id) || null;
    if (run.provenance === 'legacy_completed') {
      if (event !== null) fail('PREVIEW_INSTANCE_STATE_INVALID', 'Historical preview runs cannot gain live completion events.');
    } else if (run.status === 'completed') {
      if (!event || event.id !== run.completionEventId || event.completedAt !== run.completedAt) fail('PREVIEW_INSTANCE_STATE_INVALID', 'Saved live completion provenance is inconsistent.');
    } else if (event !== null) fail('PREVIEW_INSTANCE_STATE_INVALID', 'An open preview run cannot have a completion event.');
  }
  const scoredDates = rows(input.scoredDates ?? [], 'scored dates').map(value => {
    if (!isInstanceDate(value)) fail('PREVIEW_INSTANCE_STATE_INVALID', 'Saved preview scored dates are invalid.');
    return value;
  });
  if (new Set(scoredDates).size !== scoredDates.length || [...scoredDates].sort().some((value, index) => value !== scoredDates[index])
    || checkIns.some(checkIn => !scoredDates.includes(checkIn.localDate))) {
    fail('PREVIEW_INSTANCE_STATE_INVALID', 'Saved preview scored dates are inconsistent.');
  }
  const requests = rows(input.requests ?? [], 'requests').map(value => normalizeRequest(value, runIds));
  if (new Set(requests.map(request => request.requestId)).size !== requests.length) fail('PREVIEW_INSTANCE_STATE_INVALID', 'Saved preview request IDs are not unique.');
  const preservedLegacyRecords = rows(input.preservedLegacyRecords ?? [], 'legacy grants', MAX_LEGACY_RECORDS)
    .map(value => normalizePreservedLegacyRecord(value, input.actorId));
  if (new Set(preservedLegacyRecords.map(record => record.key)).size !== preservedLegacyRecords.length) {
    fail('PREVIEW_INSTANCE_STATE_INVALID', 'Saved legacy grant identities are not unique.');
  }
  return deepFreeze({ schemaVersion: 2, actorId: input.actorId, revision: input.revision ?? 0,
    currentInstanceId, lifetimePoints: input.lifetimePoints ?? 0,
    trustedDailyStandardPoints: input.trustedDailyStandardPoints ?? 0,
    runs, drafts, checkIns, scoredDates, completionEvents, requests, preservedLegacyRecords });
}

function stateForActor(input, actorId) {
  const state = createPreviewChallengeInstancesState(input);
  if (!validActor(actorId) || actorId !== state.actorId) fail('PREVIEW_INSTANCE_ACTOR_CHANGED', 'The signed-in account changed. Try again.');
  return state;
}

function effectiveRun(run, serverDate) {
  if (!isInstanceDate(serverDate)) fail('PREVIEW_INSTANCE_DATE_INVALID', 'Choose a valid preview date.');
  const calendarDay = instanceCalendarDay(run.startDate, serverDate);
  if (calendarDay === null || (run.status !== 'scheduled' && calendarDay < 1)) fail('PREVIEW_INSTANCE_STATE_INVALID', 'The preview run date is inconsistent.');
  const status = run.status === 'scheduled' && calendarDay >= 1 ? 'active' : run.status;
  return { ...run, status, calendarDay: status === 'scheduled' ? null : calendarDay };
}

function publicRun(run, serverDate) {
  if (!run) return null;
  const effective = effectiveRun(run, serverDate);
  return { id: effective.id, challengeKey: effective.challengeKey, title: effective.title, scopeKey: effective.scopeKey,
    status: effective.status, startDate: effective.startDate, timeZone: effective.timeZone, mode: effective.mode,
    crewId: effective.crewId, targetCount: effective.targetCount, submittedCount: effective.submittedCount,
    calendarDay: effective.calendarDay, completedAt: effective.completedAt, completionEventId: effective.completionEventId,
    provenance: effective.provenance, reviewRequired: effective.reviewRequired };
}

export function getPreviewChallengeFacts(input, { actorId } = {}) {
  const state = stateForActor(input, actorId);
  const runById = new Map(state.runs.map(run => [run.id, run]));
  const completionEvidence = state.completionEvents.map(event => {
    const run = runById.get(event.instanceId);
    return { kind: 'canonical_instance_completion', userId: state.actorId, challengeKey: run.challengeKey,
      instanceId: run.id, eventId: event.id, sourceCheckInId: event.sourceCheckInId,
      submittedCount: run.submittedCount, targetCount: run.targetCount,
      completedAt: event.completedAt, persistedAt: event.persistedAt };
  });
  const preservedCompleted = state.preservedLegacyRecords
    .filter(record => record.status === 'completed').map(record => record.key);
  return deepFreeze({ schemaVersion: 1, actorId: state.actorId, revision: state.revision,
    lifetimePoints: state.lifetimePoints, trustedDailyStandardPoints: state.trustedDailyStandardPoints,
    completedChallengeKeys: [...new Set(state.runs.filter(run => run.status === 'completed' && !run.reviewRequired)
      .map(run => run.challengeKey).concat(preservedCompleted))], completionEvidence,
    preservedLegacyRecords: state.preservedLegacyRecords.map(record => ({ ...record })) });
}

export function getPreviewChallengeActivation(input, { actorId, serverDate, hasEntitlement = true,
  groupMembershipActive = false, canActivateGroup = false } = {}) {
  const state = stateForActor(input, actorId);
  if (typeof hasEntitlement !== 'boolean' || typeof groupMembershipActive !== 'boolean' || typeof canActivateGroup !== 'boolean') {
    fail('PREVIEW_INSTANCE_INPUT_INVALID', 'Preview challenge capabilities are invalid.');
  }
  if (!isInstanceDate(serverDate)) fail('PREVIEW_INSTANCE_DATE_INVALID', 'Choose a valid preview date.');
  const stored = state.runs.find(run => run.id === state.currentInstanceId) || null;
  const instance = publicRun(stored, serverDate);
  const groupActive = Boolean(instance?.mode === 'group' && groupMembershipActive);
  const membershipReady = instance?.mode !== 'group' || groupActive;
  const canParticipate = Boolean(instance && instance.status === 'active' && !instance.reviewRequired && hasEntitlement && membershipReady);
  const originalCompleted = state.runs.some(run => run.challengeKey === 'original_77' && run.status === 'completed' && !run.reviewRequired)
    || state.preservedLegacyRecords.some(record => record.key === 'original_77' && record.status === 'completed');
  const canStartRepeat = Boolean(instance && originalCompleted && instance.status === 'completed'
    && !instance.reviewRequired && hasEntitlement);
  const repeatReason = canStartRepeat ? null : !originalCompleted ? 'original_completion_required'
    : instance?.reviewRequired ? 'review_required' : instance?.status !== 'completed' ? 'active_instance_exists'
      : !hasEntitlement ? 'entitlement_required' : 'challenge_unavailable';
  const canEditStartDate = Boolean(instance && hasEntitlement && instance.challengeKey === 'original_77'
    && instance.mode === 'solo' && instance.scopeKey.startsWith('original77:') && instance.submittedCount === 0
    && instance.status !== 'completed' && !instance.reviewRequired);
  return deepFreeze({ schemaVersion: 2, actorId: state.actorId, revision: state.revision, serverDate,
    status: instance?.status ?? 'not_started', mode: instance?.mode ?? null, startDate: instance?.startDate ?? null,
    timeZone: instance?.timeZone ?? null, crewId: instance?.crewId ?? null,
    groupMembershipActive: groupActive, reviewRequired: instance?.reviewRequired ?? false,
    canActivateSolo: !instance && hasEntitlement, canActivateGroup: !instance && hasEntitlement && canActivateGroup,
    canParticipate, canMutateDailyStandards: canParticipate, canEditStartDate,
    currentInstance: instance,
    originalRepeat: { challengeKey: 'original_77', targetCount: 77, available: Boolean(instance && originalCompleted),
      canStart: canStartRepeat, reason: repeatReason } });
}

function validateActivationArgs(state, args, action) {
  if (!ownRecord(args) || !validUuid(args.requestId) || !validUuid(args.instanceId)
    || !safeInteger(args.expectedRevision) || !isInstanceDate(args.startDate)
    || !isInstanceDate(args.serverDate) || !validTimeZone(args.timeZone)
    || !['solo', 'group'].includes(args.mode ?? 'solo')
    || !((args.mode ?? 'solo') === 'solo' ? (args.crewId ?? null) === null : validActor(args.crewId))) {
    fail('PREVIEW_INSTANCE_INPUT_INVALID', 'Preview challenge start input is invalid.');
  }
  const signature = JSON.stringify([action, args.instanceId, args.challengeKey ?? 'original_77', args.startDate,
    args.timeZone, args.mode ?? 'solo', args.crewId ?? null, args.expectedCurrentInstanceId ?? null, args.expectedRevision]);
  const prior = state.requests.find(request => request.requestId === args.requestId);
  if (prior) {
    if (prior.action !== action || prior.signature !== signature) fail('PREVIEW_INSTANCE_REQUEST_REUSED', 'This request ID was already used for another operation.');
    return { signature, prior };
  }
  if (args.expectedRevision !== state.revision) fail('PREVIEW_INSTANCE_CHANGED', 'The challenge timeline changed. Reload and try again.');
  if (state.runs.some(run => run.id === args.instanceId)) fail('PREVIEW_INSTANCE_ID_REUSED', 'This challenge run ID is already in use.');
  return { signature, prior: null };
}

function stateWithRun(state, run, requestId, action, signature) {
  const revision = state.revision + 1;
  return createPreviewChallengeInstancesState({ ...state, revision, currentInstanceId: run.id,
    runs: [...state.runs, run], requests: [...state.requests,
      { requestId, action, signature, instanceId: run.id, revision }] });
}

function activationMutationResult(state, instanceId, replayed, args) {
  if (instanceId !== state.currentInstanceId) fail('PREVIEW_INSTANCE_CHANGED', 'The challenge changed. Reload your progress.');
  return deepFreeze({ state, instanceId, replayed,
    activation: getPreviewChallengeActivation(state, { actorId: state.actorId, serverDate: args.serverDate,
      hasEntitlement: args.hasEntitlement, groupMembershipActive: args.groupMembershipActive ?? false }) });
}

export function activatePreviewInitial(input, args = {}) {
  const state = stateForActor(input, args.actorId);
  const checked = validateActivationArgs(state, { ...args, challengeKey: 'original_77' }, 'activate_initial');
  if (checked.prior) return activationMutationResult(state, checked.prior.instanceId, true, args);
  if (args.hasEntitlement !== true || ((args.mode ?? 'solo') === 'group' && args.groupMembershipActive !== true)) {
    fail('PREVIEW_INSTANCE_ACCESS_REQUIRED', 'An active membership and current group access are required.');
  }
  if (state.currentInstanceId !== null || state.runs.length !== 0) fail('PREVIEW_INSTANCE_ALREADY_STARTED', 'A preview challenge is already active.');
  const calendarDay = instanceCalendarDay(args.startDate, args.serverDate);
  const run = { id: args.instanceId, sequenceNo: 0, challengeKey: 'original_77',
    title: PREVIEW_CHALLENGE_INSTANCE_DEFINITIONS.original_77.title, scopeKey: `original77:${args.startDate}`,
    status: calendarDay < 1 ? 'scheduled' : 'active', startDate: args.startDate, timeZone: args.timeZone,
    mode: args.mode ?? 'solo', crewId: args.crewId ?? null, targetCount: 77, submittedCount: 0,
    completedAt: null, completionEventId: null, provenance: 'live', reviewRequired: false };
  return activationMutationResult(stateWithRun(state, run, args.requestId, 'activate_initial', checked.signature), run.id, false, args);
}

export function startPreviewChallenge(input, args = {}) {
  const state = stateForActor(input, args.actorId);
  if (!Object.hasOwn(PREVIEW_CHALLENGE_INSTANCE_DEFINITIONS, args.challengeKey)
    || (args.challengeKey !== 'original_77' && typeof args.challengeUnlocked !== 'boolean')) {
    fail('PREVIEW_INSTANCE_INPUT_INVALID', 'Choose an available preview challenge.');
  }
  const checked = validateActivationArgs(state, args, 'start');
  if (checked.prior) return activationMutationResult(state, checked.prior.instanceId, true, args);
  if (args.hasEntitlement !== true || (args.mode ?? 'solo') !== 'solo' || (args.crewId ?? null) !== null) {
    fail('PREVIEW_INSTANCE_ACCESS_REQUIRED', 'An active membership is required to start this challenge.');
  }
  if (!validUuid(args.expectedCurrentInstanceId) || state.currentInstanceId !== args.expectedCurrentInstanceId) {
    fail('PREVIEW_INSTANCE_CHANGED', 'The challenge timeline changed. Reload and try again.');
  }
  const current = state.runs.at(-1);
  if (!current || current.status !== 'completed' || current.reviewRequired) fail('PREVIEW_INSTANCE_ACTIVE', 'Complete the current challenge before starting another.');
  if (args.startDate < args.serverDate) fail('PREVIEW_INSTANCE_DATE_INVALID', 'Choose today or a future preview start date.');
  const completed = new Set(state.runs.filter(run => run.status === 'completed' && !run.reviewRequired).map(run => run.challengeKey)
    .concat(state.preservedLegacyRecords.filter(record => record.status === 'completed').map(record => record.key)));
  const definition = PREVIEW_CHALLENGE_INSTANCE_DEFINITIONS[args.challengeKey];
  if (args.challengeKey === 'original_77') {
    if (!completed.has('original_77')) fail('PREVIEW_INSTANCE_LOCKED', 'Complete the original challenge before repeating it.');
  } else {
    const preservedGrant = state.preservedLegacyRecords.some(record => record.key === args.challengeKey
      && ['available', 'active', 'completed'].includes(record.status));
    if (!args.challengeUnlocked && !preservedGrant) fail('PREVIEW_INSTANCE_LOCKED', 'Unlock this challenge before starting it.');
    if (definition.prerequisiteChallengeKey && !completed.has(definition.prerequisiteChallengeKey) && !preservedGrant) {
      fail('PREVIEW_INSTANCE_LOCKED', 'Complete the previous challenge before starting this one.');
    }
  }
  const run = { id: args.instanceId, sequenceNo: state.runs.length, challengeKey: args.challengeKey,
    title: definition.title, scopeKey: `instance:${args.instanceId}`,
    status: args.startDate > args.serverDate ? 'scheduled' : 'active', startDate: args.startDate,
    timeZone: args.timeZone, mode: args.mode ?? 'solo', crewId: args.crewId ?? null,
    targetCount: definition.targetCount, submittedCount: 0, completedAt: null, completionEventId: null,
    provenance: 'live', reviewRequired: false };
  return activationMutationResult(stateWithRun(state, run, args.requestId, 'start', checked.signature), run.id, false, args);
}

export function updatePreviewChallengeStartDate(input, args = {}) {
  const state = stateForActor(input, args.actorId);
  if (!validUuid(args.requestId) || !validUuid(args.instanceId) || !isInstanceDate(args.startDate)
    || !validTimeZone(args.timeZone) || !isInstanceDate(args.serverDate) || !safeInteger(args.expectedRevision)) {
    fail('PREVIEW_INSTANCE_INPUT_INVALID', 'Choose a valid start date.');
  }
  const signature = JSON.stringify([args.instanceId, args.startDate, args.timeZone, args.expectedRevision]);
  const prior = state.requests.find(row => row.requestId === args.requestId);
  if (prior) {
    if (prior.action !== 'set_start_date' || prior.signature !== signature) fail('PREVIEW_INSTANCE_REQUEST_REUSED', 'This request ID was already used for another operation.');
    return activationMutationResult(state, prior.instanceId, true, args);
  }
  if (args.hasEntitlement !== true) fail('PREVIEW_INSTANCE_ACCESS_REQUIRED', 'An active membership is required.');
  if (instanceCalendarDay(args.startDate, args.serverDate) > 77) fail('PREVIEW_INSTANCE_DATE_INVALID', 'Choose a start date within the supported 77-day window.');
  const activation = getPreviewChallengeActivation(state, { actorId: args.actorId,
    serverDate: args.serverDate, hasEntitlement: args.hasEntitlement });
  if (state.revision !== args.expectedRevision || state.currentInstanceId !== args.instanceId
    || !activation.canEditStartDate || state.runs.length !== 1) fail('PREVIEW_INSTANCE_CHANGED', 'The challenge changed. Reload before editing its start date.');
  const changed = state.runs[0].startDate !== args.startDate || state.runs[0].timeZone !== args.timeZone;
  const revision = state.revision + (changed ? 1 : 0);
  const saved = createPreviewChallengeInstancesState({ ...state, revision,
    runs: [{ ...state.runs[0], startDate: args.startDate, timeZone: args.timeZone,
      scopeKey: `original77:${args.startDate}`, status: args.startDate > args.serverDate ? 'scheduled' : 'active' }],
    requests: [...state.requests, { requestId: args.requestId, action: 'set_start_date', signature,
      instanceId: args.instanceId, revision }] });
  return activationMutationResult(saved, args.instanceId, false, args);
}

function currentMutableRun(state, { actorId, instanceId, localDate, serverDate }) {
  if (!validUuid(instanceId) || !isInstanceDate(localDate) || !isInstanceDate(serverDate) || localDate !== serverDate) {
    fail('PREVIEW_INSTANCE_INPUT_INVALID', 'Reload this Daily Action and try again.');
  }
  if (actorId !== state.actorId || instanceId !== state.currentInstanceId) fail('PREVIEW_INSTANCE_CHANGED', 'The challenge changed. Reload this action.');
  const stored = state.runs.at(-1);
  const run = effectiveRun(stored, serverDate);
  if (run.status !== 'active' || run.reviewRequired || run.calendarDay < 1) fail('PREVIEW_INSTANCE_LOCKED', 'Today’s Daily Actions are locked.');
  if (state.scoredDates.includes(localDate)) fail('PREVIEW_CHECK_IN_ALREADY_COMPLETE', 'Today’s check-in is already posted. Your original entry and points are unchanged.');
  return run;
}

function draftPayload(state, run, localDate) {
  const draft = state.drafts.find(row => row.instanceId === run.id && row.localDate === localDate)
    || { instanceId: run.id, localDate, completed: [], workoutDifficulty: {}, version: 0, updatedAt: null };
  const globallySubmitted = state.scoredDates.includes(localDate);
  const current = run.id === state.currentInstanceId;
  const locked = !current || run.status !== 'active' || run.reviewRequired || globallySubmitted;
  const lockReason = globallySubmitted ? 'already_submitted' : !current ? 'instance_changed'
    : run.reviewRequired ? 'review_required' : run.status !== 'active' ? 'challenge_inactive' : null;
  return deepFreeze({ schemaVersion: 2, actorId: state.actorId, instanceId: run.id, entry_date: localDate,
    completed: [...draft.completed], workout_difficulty: { ...draft.workoutDifficulty }, version: draft.version,
    updated_at: draft.updatedAt, locked, lock_reason: lockReason, submitted: globallySubmitted,
    activation_status: run.status });
}

export function getPreviewChallengeDraft(input, { actorId, instanceId, localDate, serverDate = localDate } = {}) {
  const state = stateForActor(input, actorId);
  if (!validUuid(instanceId) || !isInstanceDate(localDate) || !isInstanceDate(serverDate)
    || localDate !== serverDate || instanceId !== state.currentInstanceId) fail('PREVIEW_INSTANCE_CHANGED', 'The challenge changed. Reload this action.');
  return draftPayload(state, effectiveRun(state.runs.at(-1), serverDate), localDate);
}

function saveDraft(state, run, localDate, expectedVersion, now, mutate) {
  if (!safeInteger(expectedVersion) || !validTimestamp(now)) fail('PREVIEW_INSTANCE_INPUT_INVALID', 'Reload this Daily Action and try again.');
  const index = state.drafts.findIndex(row => row.instanceId === run.id && row.localDate === localDate);
  const current = index < 0
    ? { instanceId: run.id, localDate, completed: [], workoutDifficulty: {}, version: 0, updatedAt: null }
    : state.drafts[index];
  if (current.version !== expectedVersion) fail('PREVIEW_DRAFT_CHANGED', 'This Daily Action changed. Reload and try again.');
  const next = { ...mutate(current), version: current.version + 1, updatedAt: now };
  const drafts = index < 0 ? [...state.drafts, next] : state.drafts.map((row, position) => position === index ? next : row);
  const saved = createPreviewChallengeInstancesState({ ...state, drafts });
  return deepFreeze({ state: saved, draft: draftPayload(saved, run, localDate) });
}

export function mutatePreviewChallengeDraft(input, args = {}) {
  const state = stateForActor(input, args.actorId);
  const run = currentMutableRun(state, args);
  if (!ACTIONS.has(args.actionId) || typeof args.completed !== 'boolean') fail('PREVIEW_INSTANCE_INPUT_INVALID', 'Choose a valid Daily Action.');
  return saveDraft(state, run, args.localDate, args.expectedVersion, args.now, current => {
    const completed = new Set(current.completed);
    if (args.completed) completed.add(args.actionId); else completed.delete(args.actionId);
    return { ...current, completed: [...completed].sort((left, right) => ACTION_ORDER.get(left) - ACTION_ORDER.get(right)) };
  });
}

export function setPreviewChallengeWorkoutDifficulty(input, args = {}) {
  const state = stateForActor(input, args.actorId);
  const run = currentMutableRun(state, args);
  if (!WORKOUTS.has(args.workoutId) || !DIFFICULTIES.has(args.difficulty)) fail('PREVIEW_INSTANCE_INPUT_INVALID', 'Choose a valid workout difficulty.');
  return saveDraft(state, run, args.localDate, args.expectedVersion, args.now, current => ({ ...current,
    workoutDifficulty: { ...current.workoutDifficulty, [args.workoutId]: args.difficulty } }));
}

export function submitPreviewChallengeCheckIn(input, args = {}) {
  const state = stateForActor(input, args.actorId);
  const run = currentMutableRun(state, args);
  if (!validUuid(args.checkInId) || state.checkIns.some(row => row.id === args.checkInId)
    || !validTimestamp(args.recordedAt)) fail('PREVIEW_INSTANCE_INPUT_INVALID', 'The preview check-in identity is invalid.');
  const draft = state.drafts.find(row => row.instanceId === run.id && row.localDate === args.localDate);
  if (!draft?.completed.length) fail('PREVIEW_CHECK_IN_EMPTY', 'Complete at least one Daily Action before posting.');
  const completing = run.submittedCount + 1 === run.targetCount;
  if (completing) {
    if (!validUuid(args.completionEventId) || args.completionEventId === args.checkInId
      || state.completionEvents.some(event => event.id === args.completionEventId)
      || !validTimestamp(args.persistedAt)) fail('PREVIEW_COMPLETION_EVIDENCE_REQUIRED', 'A canonical completion event is required for the final check-in.');
  } else if (args.completionEventId !== undefined || args.persistedAt !== undefined) {
    fail('PREVIEW_COMPLETION_EVIDENCE_UNEXPECTED', 'Completion evidence is only accepted for the final check-in.');
  }
  const completed = [...draft.completed];
  const status = completed.length === DAILY_STANDARD_ACTION_IDS.length ? 'complete' : 'partial';
  const checkIn = { id: args.checkInId, instanceId: run.id, localDate: args.localDate,
    calendarDay: run.calendarDay, status, completed, workoutDifficulty: { ...draft.workoutDifficulty },
    pointsAwarded: completed.length, recordedAt: args.recordedAt };
  const completionEvent = completing ? { id: args.completionEventId, instanceId: run.id,
    sourceCheckInId: args.checkInId, localDate: args.localDate, completedAt: args.recordedAt,
    persistedAt: args.persistedAt, targetCount: run.targetCount } : null;
  const nextRun = { ...state.runs.at(-1), status: completing ? 'completed' : 'active',
    submittedCount: run.submittedCount + 1, completedAt: completionEvent?.completedAt ?? null,
    completionEventId: completionEvent?.id ?? null };
  const saved = createPreviewChallengeInstancesState({ ...state, revision: state.revision + 1,
    runs: state.runs.map((row, index) => index === state.runs.length - 1 ? nextRun : row),
    checkIns: [...state.checkIns, checkIn], scoredDates: [...state.scoredDates, args.localDate].sort(),
    completionEvents: completionEvent ? [...state.completionEvents, completionEvent] : state.completionEvents,
    lifetimePoints: state.lifetimePoints + checkIn.pointsAwarded,
    trustedDailyStandardPoints: state.trustedDailyStandardPoints + checkIn.pointsAwarded });
  const activation = getPreviewChallengeActivation(saved, { actorId: saved.actorId, serverDate: args.serverDate });
  const completionEvidence = completionEvent ? getPreviewChallengeFacts(saved, { actorId: saved.actorId }).completionEvidence
    .find(evidence => evidence.eventId === completionEvent.id) : null;
  return deepFreeze({ state: saved, checkIn, completionEvidence,
    result: { schemaVersion: 2, actorId: saved.actorId, instanceId: run.id, id: checkIn.id,
      entry_date: checkIn.localDate, challenge_day: checkIn.calendarDay, status: checkIn.status,
      completed_count: checkIn.completed.length, points_awarded: checkIn.pointsAwarded,
      created_at: checkIn.recordedAt, activation } });
}
