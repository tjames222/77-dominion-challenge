import { normalizeChallengeActivation } from './challenge-activation.mjs';
import { isInstanceDate } from './challenge-instance-contract.mjs';
import { DAILY_STANDARD_ACTION_IDS, WORKOUT_DIFFICULTIES, WORKOUT_IDS } from './daily-standard-draft.mjs';
import { original77TimestampValid, previewOriginal77Progress } from './original-77-progress.mjs';
import {
  PREVIEW_CHALLENGE_INSTANCE_DEFINITIONS,
  createPreviewChallengeInstancesState,
  getPreviewChallengeFacts,
} from './preview-challenge-instances.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ACTIONS = new Set(DAILY_STANDARD_ACTION_IDS);
const ACTION_ORDER = new Map(DAILY_STANDARD_ACTION_IDS.map((key, index) => [key, index]));
const WORKOUTS = new Set(WORKOUT_IDS);
const DIFFICULTIES = new Set(WORKOUT_DIFFICULTIES);
const MAX_ROWS = 10_000;

function importError(message) {
  return Object.assign(new Error(message), { code: 'PREVIEW_INSTANCE_IMPORT_INVALID' });
}

function fail(message) {
  throw importError(message);
}

function ownRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function snapshotRecord(value, label) {
  if (!ownRecord(value)) fail(`Legacy preview ${label} is invalid.`);
  const result = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail(`Legacy preview ${label} is invalid.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(`Legacy preview ${label} is invalid.`);
    result[key] = descriptor.value;
  }
  return result;
}

function snapshotRows(value, label, maximum = MAX_ROWS) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) {
    fail(`Legacy preview ${label} are invalid.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) fail(`Legacy preview ${label} are invalid.`);
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[index];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(`Legacy preview ${label} are invalid.`);
    return descriptor.value;
  });
}

function optionalField(record, ...keys) {
  for (const key of keys) if (Object.hasOwn(record, key)) return record[key];
  return undefined;
}

function assertAliasesAgree(records, keys, label) {
  let found = false; let value;
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) if (Object.hasOwn(record, key)) {
      if (!found) { found = true; value = record[key]; }
      else if (!Object.is(value, record[key])) fail(`Legacy preview ${label} aliases conflict.`);
    }
  }
  return found ? value : undefined;
}

function validateActivationAliases(record) {
  const capabilities = record.capabilities === undefined ? null : snapshotRecord(record.capabilities, 'activation capabilities');
  const groups = [
    ['schemaVersion', 'schema_version'], ['storedStatus', 'stored_status', 'activationStatus', 'activation_status'],
    ['mode', 'participationMode', 'participation_mode'],
    ['startDate', 'start_date', 'challengeStartDate', 'challenge_start_date'], ['timeZone', 'time_zone'],
    ['challengeDay', 'challenge_day'], ['crewId', 'crew_id', 'groupAttributionCrewId', 'group_attribution_crew_id'],
    ['groupMembershipActive', 'group_membership_active'], ['activatedAt', 'activated_at'],
    ['confirmedAt', 'confirmed_at'], ['activatedBy', 'activated_by'], ['confirmedBy', 'confirmed_by'],
    ['revision', 'activationRevision', 'activation_revision'],
    ['reviewRequired', 'review_required', 'activationReviewRequired', 'activation_review_required'],
  ];
  for (const keys of groups) assertAliasesAgree([record], keys, 'activation');
  for (const keys of [
    ['canActivateSolo', 'can_activate_solo'], ['canActivateGroup', 'can_activate_group'],
    ['canParticipate', 'can_participate'], ['canMutateDailyStandards', 'can_mutate_daily_standards'],
    ['canEditStartDate', 'can_edit_start_date'],
  ]) assertAliasesAgree([record, capabilities], keys, 'activation capability');
  return capabilities ? { ...record, capabilities } : record;
}

function integer(value) {
  return Number.isSafeInteger(value) && !Object.is(value, -0) && value >= 0;
}

function pointsFrom(gameStats, key, fallbackKey = null) {
  const value = optionalField(gameStats, key);
  if (value === undefined && fallbackKey) {
    const fallback = optionalField(gameStats, fallbackKey);
    return fallback === undefined ? 0 : integer(fallback) ? fallback : fail('Legacy preview points are invalid.');
  }
  return value === undefined ? 0 : integer(value) ? value : fail('Legacy preview points are invalid.');
}

function nextUuid(createUuid, used) {
  let value;
  try { value = createUuid(); } catch { fail('A preview UUID could not be created.'); }
  if (typeof value !== 'string' || !UUID.test(value) || used.has(value)) fail('A fresh preview UUID is required.');
  used.add(value);
  return value;
}

function preserveUuid(value, createUuid, used) {
  if (typeof value === 'string' && UUID.test(value) && !used.has(value)) {
    used.add(value);
    return value;
  }
  return nextUuid(createUuid, used);
}

function canonicalCompleted(value, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < (allowEmpty ? 0 : 1) || value.length > DAILY_STANDARD_ACTION_IDS.length) return null;
  const result = [];
  for (const action of value) {
    if (!ACTIONS.has(action) || result.includes(action)) return null;
    result.push(action);
  }
  return result.sort((left, right) => ACTION_ORDER.get(left) - ACTION_ORDER.get(right));
}

function workoutDifficulty(value) {
  if (value === undefined || value === null) return {};
  if (!ownRecord(value)) return null;
  const result = {};
  for (const [key, difficulty] of Object.entries(value)) {
    if (!WORKOUTS.has(key) || !DIFFICULTIES.has(difficulty)) return null;
    result[key] = difficulty;
  }
  return Object.fromEntries(WORKOUT_IDS.filter(key => Object.hasOwn(result, key)).map(key => [key, result[key]]));
}

function preserveLegacyGrants({ actorId, ownershipRecords, challengeRecords }) {
  const result = [];
  const keys = new Set();
  const add = (raw, stateModel) => {
    const record = snapshotRecord(raw, 'grant');
    const key = assertAliasesAgree([record], ['key', 'rewardKey', 'reward_key', 'challengeKey', 'challenge_key'], 'grant identity');
    if (typeof key !== 'string' || !/^[a-z0-9][a-z0-9_.:-]{0,99}$/u.test(key) || keys.has(key)) {
      fail('Legacy preview grant identities are invalid.');
    }
    const suppliedActor = assertAliasesAgree([record], ['userId', 'user_id', 'actorId', 'actor_id'], 'grant owner');
    if (suppliedActor !== undefined && suppliedActor !== actorId) fail('Legacy preview grant belongs to another account.');
    const status = stateModel === 'ownership' ? 'owned' : record.status;
    if (stateModel === 'ownership' && record.status !== undefined && record.status !== 'owned') {
      fail('Legacy preview ownership grant is invalid.');
    }
    if (stateModel === 'challenge' && !['available', 'active', 'completed'].includes(status)) {
      fail('Legacy preview challenge grant is invalid.');
    }
    const grantCatalogVersion = assertAliasesAgree([record], ['grantCatalogVersion', 'grant_catalog_version'], 'grant catalog');
    const grantReason = assertAliasesAgree([record], ['grantReason', 'grant_reason'], 'grant reason');
    if (grantCatalogVersion !== undefined && (!integer(grantCatalogVersion) || grantCatalogVersion < 1)) {
      fail('Legacy preview grant catalog version is invalid.');
    }
    if (grantReason !== undefined && (typeof grantReason !== 'string' || !grantReason.trim()
      || grantReason.length > 120 || /[\u0000-\u001f\u007f]/u.test(grantReason))) {
      fail('Legacy preview grant reason is invalid.');
    }
    const unlockedAt = assertAliasesAgree([record], ['unlockedAt', 'unlocked_at'], 'grant unlock time') ?? null;
    const startedAt = assertAliasesAgree([record], ['startedAt', 'started_at'], 'grant start time') ?? null;
    const completedAt = assertAliasesAgree([record], ['completedAt', 'completed_at'], 'grant completion time') ?? null;
    const ownedAt = assertAliasesAgree([record], ['ownedAt', 'owned_at'], 'grant ownership time') ?? null;
    const celebrationSeenAt = assertAliasesAgree([record], ['celebrationSeenAt', 'celebration_seen_at'], 'grant acknowledgement') ?? null;
    if ([unlockedAt, startedAt, completedAt, ownedAt, celebrationSeenAt]
      .some(value => value !== null && !original77TimestampValid(value))) fail('Legacy preview grant timestamps are invalid.');
    if (stateModel === 'ownership'
      ? ownedAt === null || unlockedAt !== null || startedAt !== null || completedAt !== null
      : ownedAt !== null || unlockedAt === null
        || (status === 'available' && (startedAt !== null || completedAt !== null))
        || (status === 'active' && (startedAt === null || completedAt !== null))
        || (status === 'completed' && (startedAt === null || completedAt === null))) {
      fail('Legacy preview grant lifecycle is invalid.');
    }
    const preserved = {
      userId: actorId,
      key,
      status,
      unlockedAt: stateModel === 'ownership' ? null : unlockedAt,
      startedAt: stateModel === 'ownership' ? null : startedAt,
      completedAt: stateModel === 'ownership' ? null : completedAt,
      ownedAt: stateModel === 'ownership' ? ownedAt : null,
      celebrationSeenAt,
      grantCatalogVersion: integer(grantCatalogVersion) && grantCatalogVersion >= 1 ? grantCatalogVersion : 1,
      grantReason: typeof grantReason === 'string' && grantReason.trim()
        ? grantReason
        : stateModel === 'ownership' ? 'legacy_preview_ownership' : 'legacy_preview_challenge',
    };
    keys.add(key);
    result.push(preserved);
  };
  snapshotRows(ownershipRecords, 'ownership grants', 256).forEach(record => add(record, 'ownership'));
  snapshotRows(challengeRecords, 'challenge grants', 256).forEach(record => add(record, 'challenge'));
  return result;
}

function activationConflict(activation, progress) {
  if (activation.reviewRequired) return true;
  if (activation.originalProgress !== null && activation.originalProgress !== undefined
    && JSON.stringify(activation.originalProgress) !== JSON.stringify(progress)) return true;
  if (activation.status === 'scheduled' && progress.submittedCount > 0) return true;
  if (activation.status === 'completed' && !['live_completed', 'historical_provenance_pending'].includes(progress.completionState)) return true;
  return false;
}

function importDrafts(value, instanceId, markReview) {
  const result = [];
  const dates = new Set();
  for (const raw of snapshotRows(value, 'drafts')) {
    const record = snapshotRecord(raw, 'draft');
    const localDate = assertAliasesAgree([record], ['date', 'entry_date', 'localDate', 'local_date'], 'draft date');
    const completed = canonicalCompleted(record.completed, { allowEmpty: true });
    const difficulty = workoutDifficulty(assertAliasesAgree([record], ['workoutDifficultySelections',
      'workout_difficulty_selections', 'workoutDifficulty', 'workout_difficulty'], 'draft workout difficulty'));
    const version = optionalField(record, 'version');
    const updatedAt = assertAliasesAgree([record], ['updatedAt', 'updated_at'], 'draft update time');
    if (!isInstanceDate(localDate) || dates.has(localDate) || completed === null || difficulty === null
      || (version !== undefined && !integer(version))
      || !(updatedAt === undefined || updatedAt === null || original77TimestampValid(updatedAt))) {
      markReview();
      continue;
    }
    dates.add(localDate);
    result.push({ instanceId, localDate, completed, workoutDifficulty: difficulty,
      version: version ?? 0, updatedAt: updatedAt ?? null });
  }
  return result;
}

function legacyRunDate(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function appendLegacyChallengeRuns({ originalRun, preservedLegacyRecords, activation, createUuid, usedUuids }) {
  const definitions = Object.entries(PREVIEW_CHALLENGE_INSTANCE_DEFINITIONS)
    .filter(([key]) => key !== 'original_77');
  const order = new Map(definitions.map(([key], index) => [key, index]));
  const lifecycle = preservedLegacyRecords.filter(record => record.status !== 'owned'
    && ['active', 'completed'].includes(record.status));
  const known = lifecycle.filter(record => order.has(record.key));
  const completed = known.filter(record => record.status === 'completed')
    .sort((left, right) => order.get(left.key) - order.get(right.key));
  const active = known.filter(record => record.status === 'active');
  const unknownActive = lifecycle.some(record => record.status === 'active' && !order.has(record.key));
  const originalReady = originalRun.status === 'completed' && !originalRun.reviewRequired;
  const chronologyInvalid = record => Date.parse(record.unlockedAt) > Date.parse(record.startedAt)
    || (record.completedAt !== null && Date.parse(record.startedAt) > Date.parse(record.completedAt));
  let conflict = unknownActive || active.length > 1 || known.some(chronologyInvalid)
    || (!originalReady && lifecycle.length > 0);
  const activeRecord = active.length === 1 ? active[0] : null;
  if (activeRecord && completed.some(record => order.get(record.key) > order.get(activeRecord.key))) conflict = true;
  let priorCompletedAt = originalRun.completedAt;
  for (const record of completed) {
    if (priorCompletedAt !== null && Date.parse(priorCompletedAt) > Date.parse(record.startedAt)) conflict = true;
    priorCompletedAt = record.completedAt;
  }
  if (activeRecord && priorCompletedAt !== null
    && Date.parse(priorCompletedAt) > Date.parse(activeRecord.startedAt)) conflict = true;

  // Existing grants always remain in preservedLegacyRecords. Runtime rows are
  // added only when their sequence can be represented without rewriting the
  // original run or inventing check-ins/completion events.
  if (!originalReady) return { runs: [originalRun], conflict };
  const runs = [originalRun];
  for (const record of completed) {
    const definition = PREVIEW_CHALLENGE_INSTANCE_DEFINITIONS[record.key];
    const id = nextUuid(createUuid, usedUuids);
    runs.push({ id, sequenceNo: runs.length, challengeKey: record.key, title: definition.title,
      scopeKey: `instance:${id}`, status: 'completed', startDate: legacyRunDate(record.startedAt),
      timeZone: activation.timeZone, mode: 'solo', crewId: null, targetCount: definition.targetCount,
      submittedCount: 0, completedAt: record.completedAt, completionEventId: null,
      provenance: 'legacy_completed', reviewRequired: false });
  }
  if (activeRecord && !conflict) {
    const definition = PREVIEW_CHALLENGE_INSTANCE_DEFINITIONS[activeRecord.key];
    const id = nextUuid(createUuid, usedUuids);
    runs.push({ id, sequenceNo: runs.length, challengeKey: activeRecord.key, title: definition.title,
      scopeKey: `instance:${id}`, status: 'active', startDate: legacyRunDate(activeRecord.startedAt),
      timeZone: activation.timeZone, mode: 'solo', crewId: null, targetCount: definition.targetCount,
      submittedCount: 0, completedAt: null, completionEventId: null,
      provenance: 'legacy_bound', reviewRequired: false });
  }
  return { runs, conflict };
}

function emptyImportedState({ actorId, lifetimePoints, trustedDailyStandardPoints, preservedLegacyRecords }) {
  return createPreviewChallengeInstancesState({ actorId, revision: 0, currentInstanceId: null,
    lifetimePoints, trustedDailyStandardPoints, runs: [], drafts: [], checkIns: [], scoredDates: [],
    completionEvents: [], requests: [], preservedLegacyRecords });
}

function requireNoUnboundLegacyRun(preservedLegacyRecords) {
  if (preservedLegacyRecords.some(record => ['active', 'completed'].includes(record.status))) {
    fail('Legacy preview challenge history is missing its activation context.');
  }
}

// One-time local-preview import only. The legacy aggregate remains untouched;
// this projection never backfills badge awards or treats cached dates/points as
// completion evidence.
export function importPreviewChallengeInstances(input = {}) {
  const source = snapshotRecord(input, 'import');
  const actorId = source.actorId;
  if (typeof actorId !== 'string' || !actorId || typeof source.createUuid !== 'function') {
    fail('A preview owner and UUID factory are required.');
  }
  const badgeState = source.badgeState === null || source.badgeState === undefined
    ? { schemaVersion: 1, awards: [], visits: [], checkIns: [], completionEvents: [] }
    : snapshotRecord(source.badgeState, 'badge state');
  const gameStats = source.gameStats === null || source.gameStats === undefined
    ? {} : snapshotRecord(source.gameStats, 'game stats');
  const ownershipRecords = source.ownershipRecords ?? [];
  const challengeRecords = source.challengeRecords ?? [];
  const preservedLegacyRecords = preserveLegacyGrants({ actorId, ownershipRecords, challengeRecords });
  const lifetimePoints = pointsFrom(gameStats, 'totalPoints', 'challengePoints');
  if (Object.hasOwn(gameStats, 'totalPoints') && Object.hasOwn(gameStats, 'challengePoints')
    && gameStats.totalPoints !== gameStats.challengePoints) fail('Legacy preview point aliases conflict.');
  // Never reinterpret old totals or sharing grants as trusted Daily Action
  // points. Missing dedicated evidence starts at zero while durable grants stay.
  const trustedDailyStandardPoints = pointsFrom(gameStats, 'dailyStandardsPoints');
  if (source.legacyActivation === null || source.legacyActivation === undefined) {
    requireNoUnboundLegacyRun(preservedLegacyRecords);
    return emptyImportedState({ actorId, lifetimePoints, trustedDailyStandardPoints, preservedLegacyRecords });
  }
  const rawActivation = validateActivationAliases(snapshotRecord(source.legacyActivation, 'activation'));
  const activation = normalizeChallengeActivation(rawActivation, { expectedUserId: actorId, preview: true });
  if (!activation.contractValid) fail('Legacy preview activation could not be verified.');
  if (activation.status === 'not_started') {
    requireNoUnboundLegacyRun(preservedLegacyRecords);
    return emptyImportedState({ actorId, lifetimePoints, trustedDailyStandardPoints, preservedLegacyRecords });
  }
  if ([activation.activatedBy, activation.confirmedBy].some(value => value !== null && value !== actorId)) {
    fail('Legacy preview activation belongs to another account.');
  }

  const progress = previewOriginal77Progress(badgeState, { userId: actorId, startDate: activation.startDate });
  const usedUuids = new Set();
  const instanceId = nextUuid(source.createUuid, usedUuids);
  let reviewRequired = activationConflict(activation, progress) || progress.completionState === 'invalid_evidence';
  const markReview = () => { reviewRequired = true; };
  const sourceIdMap = new Map();
  const checkIns = [];
  if (progress.completionState !== 'invalid_evidence') {
    for (const raw of snapshotRows(badgeState.checkIns, 'badge check-ins')) {
      const row = snapshotRecord(raw, 'badge check-in');
      const completed = canonicalCompleted(row.completed);
      if (completed === null) { markReview(); break; }
      const id = preserveUuid(row.sourceId, source.createUuid, usedUuids);
      sourceIdMap.set(row.sourceId, id);
      const difficulty = workoutDifficulty(assertAliasesAgree([row], ['workoutDifficultySelections',
        'workout_difficulty_selections', 'workoutDifficulty', 'workout_difficulty'], 'check-in workout difficulty'));
      if (difficulty === null) markReview();
      checkIns.push({ id, instanceId, localDate: row.localDate, calendarDay: row.challengeDay,
        status: completed.length === DAILY_STANDARD_ACTION_IDS.length ? 'complete' : 'partial', completed,
        workoutDifficulty: difficulty ?? {}, pointsAwarded: completed.length, recordedAt: row.occurredAt });
    }
  }
  if (reviewRequired && progress.completionState === 'invalid_evidence') checkIns.length = 0;

  const completedFromEvidence = ['live_completed', 'historical_provenance_pending'].includes(progress.completionState);
  const legacyCompletedFlag = activation.status === 'completed' && !completedFromEvidence;
  let status = completedFromEvidence || legacyCompletedFlag ? 'completed' : activation.status;
  if (status === 'scheduled' && checkIns.length > 0) { status = 'active'; markReview(); }
  const liveEvent = progress.completionState === 'live_completed' ? progress.canonicalEvent : null;
  const completionEvents = [];
  let completionEventId = null;
  let completedAt = null;
  if (liveEvent) {
    const sourceCheckInId = sourceIdMap.get(liveEvent.sourceId);
    if (!sourceCheckInId) markReview();
    else {
      completionEventId = preserveUuid(liveEvent.id, source.createUuid, usedUuids);
      completedAt = liveEvent.recordedAt;
      completionEvents.push({ id: completionEventId, instanceId, sourceCheckInId,
        localDate: liveEvent.localDate, completedAt, persistedAt: liveEvent.persistedAt, targetCount: 77 });
    }
  }
  const provenance = status === 'completed' && !liveEvent ? 'legacy_completed' : 'legacy_bound';
  if (status === 'completed' && liveEvent && completionEvents.length !== 1) {
    status = 'completed'; completionEventId = null; completedAt = null; markReview();
  }
  const submittedCount = progress.completionState === 'invalid_evidence' ? 0 : checkIns.length;
  const run = { id: instanceId, sequenceNo: 0, challengeKey: 'original_77',
    title: PREVIEW_CHALLENGE_INSTANCE_DEFINITIONS.original_77.title,
    scopeKey: `original77:${activation.startDate}`, status, startDate: activation.startDate,
    timeZone: activation.timeZone, mode: activation.mode, crewId: activation.crewId,
    targetCount: 77, submittedCount, completedAt, completionEventId,
    provenance, reviewRequired };
  const drafts = importDrafts(source.drafts ?? [], instanceId, markReview);
  run.reviewRequired = reviewRequired;
  const importedLifecycle = appendLegacyChallengeRuns({ originalRun: run, preservedLegacyRecords,
    activation, createUuid: source.createUuid, usedUuids });
  if (importedLifecycle.conflict) {
    importedLifecycle.runs.at(-1).reviewRequired = true;
    reviewRequired = true;
  }
  const scoredDates = new Set(checkIns.map(row => row.localDate));
  for (const value of snapshotRows(source.scoredDates ?? [], 'scored dates')) {
    if (!isInstanceDate(value)) { markReview(); continue; }
    scoredDates.add(value);
  }
  importedLifecycle.runs.at(-1).reviewRequired ||= reviewRequired;
  const state = createPreviewChallengeInstancesState({ actorId,
    revision: integer(activation.revision) ? activation.revision : 1,
    currentInstanceId: importedLifecycle.runs.at(-1).id,
    lifetimePoints, trustedDailyStandardPoints, runs: importedLifecycle.runs, drafts, checkIns,
    scoredDates: [...scoredDates].sort(), completionEvents, requests: [], preservedLegacyRecords });
  // Exercise the same immutable fact projection used by reward integration;
  // legacy completed rows must never appear as canonical completion evidence.
  getPreviewChallengeFacts(state, { actorId });
  return state;
}
