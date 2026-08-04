export const CHALLENGE_ACTIVATION_SCHEMA_VERSION = 1;

const READ_STATES = new Set(['loading', 'ready', 'error']);
const ACTIVATION_STATUSES = new Set(['not_started', 'scheduled', 'active']);
const PARTICIPATION_MODES = new Set(['solo', 'group']);
const CAPABILITY_FIELDS = Object.freeze([
  ['canActivateSolo', 'can_activate_solo'],
  ['canActivateGroup', 'can_activate_group'],
  ['canParticipate', 'can_participate'],
  ['canMutateDailyStandards', 'can_mutate_daily_standards'],
  ['canEditStartDate', 'can_edit_start_date'],
]);
const DEFAULT_READ_ERROR = 'Unable to load challenge activation.';
const INVALID_CONTRACT_READ_ERROR = 'Challenge activation data could not be verified. Refresh to try again.';
const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const issuedChallengeActivationRequestIds = new Set();
let challengeActivationRequestCollisionSequence = 0;

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function readField(object, ...keys) {
  if (!object || typeof object !== 'object') return undefined;
  const key = keys.find((candidate) => hasOwn(object, candidate));
  return key ? object[key] : undefined;
}

function asNullableString(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function validDateKey(value) {
  if (typeof value !== 'string') return false;
  const match = DATE_KEY_PATTERN.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1];
}

function dateKeyDayNumber(value) {
  if (!validDateKey(value)) throw new TypeError('Choose a valid challenge start date.');
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return Math.floor(date.getTime() / 86_400_000);
}

function validTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = TIMESTAMP_PATTERN.exec(value);
  if (!match || !validDateKey(match[1])) return false;

  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4]);
  const offsetHour = match[5] === 'Z' ? 0 : Number(match[7]);
  const offsetMinute = match[5] === 'Z' ? 0 : Number(match[8]);
  return hour <= 23
    && minute <= 59
    && second <= 59
    && offsetHour <= 23
    && offsetMinute <= 59
    && Number.isFinite(Date.parse(value));
}

function validTimeZone(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function challengeActivationDateKeyForTimeZone(value = new Date(), timeZone = 'UTC') {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('A valid activation time is required.');
  if (!validTimeZone(timeZone)) throw new TypeError('Choose a valid time zone.');

  const parts = new Intl.DateTimeFormat('en', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function challengeActivationDay(startDate, currentDate) {
  return dateKeyDayNumber(currentDate) - dateKeyDayNumber(startDate) + 1;
}

export function isSupportedChallengeActivationDate(value) {
  return validDateKey(value);
}

function optionalTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  return validTimestamp(value) ? value : undefined;
}

function explicitCapability(payload, camelKey, snakeKey) {
  const direct = readField(payload, camelKey, snakeKey);
  if (typeof direct === 'boolean') return direct;

  const capabilities = readField(payload, 'capabilities');
  const nested = readField(capabilities, camelKey, snakeKey);
  return typeof nested === 'boolean' ? nested : undefined;
}

function closedCapabilities() {
  return Object.fromEntries(CAPABILITY_FIELDS.map(([key]) => [key, false]));
}

function normalizedReadState(readState) {
  return READ_STATES.has(readState) ? readState : 'error';
}

export function createChallengeActivationState(readState = 'loading') {
  const state = normalizedReadState(readState);
  const capabilities = closedCapabilities();
  const activation = {
    schemaVersion: CHALLENGE_ACTIVATION_SCHEMA_VERSION,
    readState: state,
    contractValid: false,
    status: null,
    storedStatus: null,
    mode: null,
    startDate: null,
    timeZone: null,
    challengeDay: null,
    crewId: null,
    groupAttributionCrewId: null,
    groupMembershipActive: false,
    activatedAt: null,
    confirmedAt: null,
    activatedBy: null,
    confirmedBy: null,
    revision: 0,
    reviewRequired: false,
    ...capabilities,
    capabilities: { ...capabilities },
  };

  if (state === 'error') activation.errorMessage = DEFAULT_READ_ERROR;
  return activation;
}

export function normalizeChallengeActivation(payload, { readState = 'ready' } = {}) {
  const normalizedState = normalizedReadState(readState);
  if (normalizedState !== 'ready') return createChallengeActivationState(normalizedState);

  const closed = challengeActivationReadError(INVALID_CONTRACT_READ_ERROR);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return closed;

  const schemaVersion = readField(payload, 'schemaVersion', 'schema_version');
  const status = readField(payload, 'status');
  const storedStatus = readField(
    payload,
    'storedStatus',
    'stored_status',
    'activationStatus',
    'activation_status',
  );
  const rawMode = readField(payload, 'mode', 'participationMode', 'participation_mode');
  const mode = rawMode === null || rawMode === undefined || rawMode === '' ? null : rawMode;
  const rawStartDate = readField(
    payload,
    'startDate',
    'start_date',
    'challengeStartDate',
    'challenge_start_date',
  );
  const startDate = rawStartDate === null || rawStartDate === undefined || rawStartDate === ''
    ? null
    : rawStartDate;
  const rawTimeZone = readField(payload, 'timeZone', 'time_zone');
  const timeZone = rawTimeZone === null || rawTimeZone === undefined || rawTimeZone === ''
    ? null
    : rawTimeZone;
  const rawChallengeDay = readField(payload, 'challengeDay', 'challenge_day');
  const challengeDay = rawChallengeDay === null || rawChallengeDay === undefined
    ? null
    : rawChallengeDay;
  const crewId = asNullableString(readField(
    payload,
    'crewId',
    'crew_id',
    'groupAttributionCrewId',
    'group_attribution_crew_id',
  ));
  const groupMembershipActive = readField(
    payload,
    'groupMembershipActive',
    'group_membership_active',
  );
  const activatedAt = optionalTimestamp(readField(payload, 'activatedAt', 'activated_at'));
  const confirmedAt = optionalTimestamp(readField(payload, 'confirmedAt', 'confirmed_at'));
  const activatedBy = asNullableString(readField(payload, 'activatedBy', 'activated_by'));
  const confirmedBy = asNullableString(readField(payload, 'confirmedBy', 'confirmed_by'));
  const revision = readField(payload, 'revision', 'activationRevision', 'activation_revision');
  const reviewRequired = readField(
    payload,
    'reviewRequired',
    'review_required',
    'activationReviewRequired',
    'activation_review_required',
  );
  const requestedCapabilities = Object.fromEntries(CAPABILITY_FIELDS.map(([camelKey, snakeKey]) => [
    camelKey,
    explicitCapability(payload, camelKey, snakeKey),
  ]));

  const statusShapeValid = ACTIVATION_STATUSES.has(status)
    && ACTIVATION_STATUSES.has(storedStatus)
    && (
      status === storedStatus
      || (status === 'active' && storedStatus === 'scheduled')
    );
  const lifecycleShapeValid = status === 'not_started'
    ? mode === null
      && startDate === null
      && timeZone === null
      && crewId === null
      && challengeDay === null
      && activatedAt === null
      && confirmedAt === null
      && activatedBy === null
      && confirmedBy === null
    : status === 'scheduled'
      ? PARTICIPATION_MODES.has(mode)
        && validDateKey(startDate)
        && validTimeZone(timeZone)
        && challengeDay === null
        && activatedAt === null
        && activatedBy === null
        && confirmedAt !== null
        && confirmedBy !== null
      : PARTICIPATION_MODES.has(mode)
        && validDateKey(startDate)
        && validTimeZone(timeZone)
        && Number.isInteger(challengeDay)
        && challengeDay >= 1
        && activatedAt !== null
        && activatedBy !== null
        && confirmedAt !== null
        && confirmedBy !== null;
  const groupShapeValid = typeof groupMembershipActive === 'boolean'
    && (mode === 'group' ? crewId !== null && crewId !== undefined : crewId === null);
  const metadataValid = schemaVersion === CHALLENGE_ACTIVATION_SCHEMA_VERSION
    && statusShapeValid
    && lifecycleShapeValid
    && groupShapeValid
    && activatedAt !== undefined
    && confirmedAt !== undefined
    && activatedBy !== undefined
    && confirmedBy !== undefined
    && Number.isInteger(revision)
    && revision >= 0
    && typeof reviewRequired === 'boolean'
    && Object.values(requestedCapabilities).every((value) => typeof value === 'boolean');

  if (!metadataValid) return closed;

  const canParticipate = requestedCapabilities.canParticipate
    && status === 'active';
  const canMutateDailyStandards = requestedCapabilities.canMutateDailyStandards
    && canParticipate;
  const canEditStartDate = requestedCapabilities.canEditStartDate
    && mode === 'solo'
    && (status === 'scheduled' || status === 'active');
  const capabilities = {
    canActivateSolo: requestedCapabilities.canActivateSolo && status === 'not_started',
    canActivateGroup: requestedCapabilities.canActivateGroup && status === 'not_started',
    canParticipate,
    canMutateDailyStandards,
    canEditStartDate,
  };

  return {
    schemaVersion: CHALLENGE_ACTIVATION_SCHEMA_VERSION,
    readState: 'ready',
    contractValid: true,
    status,
    storedStatus,
    mode,
    startDate,
    timeZone,
    challengeDay,
    crewId,
    groupAttributionCrewId: crewId,
    groupMembershipActive: groupMembershipActive === true,
    activatedAt,
    confirmedAt,
    activatedBy,
    confirmedBy,
    revision,
    reviewRequired,
    ...capabilities,
    capabilities: { ...capabilities },
  };
}

export function normalizeChallengeActivationMutation(payload) {
  const activation = normalizeChallengeActivation(payload);
  if (activation.contractValid) return activation;

  const error = new Error('The challenge activation response was invalid. Refresh and try again.');
  error.code = 'CHALLENGE_ACTIVATION_CONTRACT_INVALID';
  throw error;
}

export function createMockNotStartedChallengeActivation() {
  return normalizeChallengeActivationMutation({
    schemaVersion: CHALLENGE_ACTIVATION_SCHEMA_VERSION,
    revision: 0,
    status: 'not_started',
    storedStatus: 'not_started',
    mode: null,
    startDate: null,
    timeZone: null,
    challengeDay: null,
    crewId: null,
    groupMembershipActive: false,
    activatedAt: null,
    confirmedAt: null,
    activatedBy: null,
    confirmedBy: null,
    reviewRequired: false,
    canActivateSolo: true,
    canActivateGroup: true,
    canParticipate: false,
    canMutateDailyStandards: false,
    canEditStartDate: false,
  });
}

function staleActivationRevisionError() {
  const error = new Error('The challenge timeline changed in another session. Refresh and try again.');
  error.code = '40001';
  error.details = 'challenge_activation_stale_revision';
  return error;
}

function validateMockStartDate(startDate, currentDate) {
  if (!validDateKey(startDate)) throw new TypeError('Choose a valid challenge start date.');
  if (challengeActivationDay(startDate, currentDate) > 77) {
    throw new RangeError('Choose a start date within the current 77-day challenge window.');
  }
}

export function refreshMockChallengeActivation(
  payload,
  {
    now = new Date(),
    hasCheckIns = false,
    hasEntitlement = true,
    groupMembershipActive = false,
  } = {},
) {
  const current = normalizeChallengeActivationMutation(payload);
  if (current.status === 'not_started') {
    return normalizeChallengeActivationMutation({
      ...current,
      canActivateSolo: true,
      canActivateGroup: true,
      canParticipate: false,
      canMutateDailyStandards: false,
      canEditStartDate: false,
    });
  }

  const currentDate = challengeActivationDateKeyForTimeZone(now, current.timeZone);
  const due = current.status === 'scheduled' && current.startDate <= currentDate;
  const status = due ? 'active' : current.status;
  const challengeDay = status === 'active'
    ? challengeActivationDay(current.startDate, currentDate)
    : null;
  const canParticipate = status === 'active';
  const canMutateDailyStandards = canParticipate
    && challengeDay >= 1
    && challengeDay <= 77
    && hasEntitlement;
  const canEditStartDate = current.mode === 'solo'
    && ['scheduled', 'active'].includes(status)
    && current.canEditStartDate
    && !hasCheckIns;
  const promotedAt = due ? (now instanceof Date ? now : new Date(now)).toISOString() : null;

  return normalizeChallengeActivationMutation({
    ...current,
    status,
    storedStatus: status,
    challengeDay,
    groupMembershipActive: current.mode === 'group' ? Boolean(groupMembershipActive) : false,
    activatedAt: due ? (current.activatedAt || promotedAt) : current.activatedAt,
    activatedBy: due ? (current.activatedBy || current.confirmedBy) : current.activatedBy,
    revision: current.revision + (due ? 1 : 0),
    canActivateSolo: false,
    canActivateGroup: false,
    canParticipate,
    canMutateDailyStandards,
    canEditStartDate,
  });
}

export function buildMockLegacyChallengeActivation({
  startDate,
  timeZone,
  actorId,
  hasCheckIns = false,
  hasEntitlement = true,
  now = new Date(),
} = {}) {
  if (!actorId) throw new TypeError('A challenge activation actor is required.');
  const requestedTimeZone = typeof timeZone === 'string' ? timeZone.trim() : '';
  const currentDate = challengeActivationDateKeyForTimeZone(now, requestedTimeZone);
  if (!validDateKey(startDate)) throw new TypeError('Choose a valid challenge start date.');

  const status = startDate > currentDate ? 'scheduled' : 'active';
  const challengeDay = status === 'active'
    ? challengeActivationDay(startDate, currentDate)
    : null;
  const recordedAt = (now instanceof Date ? now : new Date(now)).toISOString();
  const canMutateDailyStandards = status === 'active'
    && challengeDay >= 1
    && challengeDay <= 77
    && hasEntitlement;

  return normalizeChallengeActivationMutation({
    schemaVersion: CHALLENGE_ACTIVATION_SCHEMA_VERSION,
    revision: 1,
    status,
    storedStatus: status,
    mode: 'solo',
    startDate,
    timeZone: requestedTimeZone,
    challengeDay,
    crewId: null,
    groupMembershipActive: false,
    activatedAt: status === 'active' ? recordedAt : null,
    confirmedAt: recordedAt,
    activatedBy: status === 'active' ? actorId : null,
    confirmedBy: actorId,
    reviewRequired: false,
    canActivateSolo: false,
    canActivateGroup: false,
    canParticipate: status === 'active',
    canMutateDailyStandards,
    canEditStartDate: !hasCheckIns,
  });
}

export function buildMockChallengeActivation({
  current,
  action,
  startDate,
  timeZone,
  actorId,
  crewId = null,
  groupMembershipActive = false,
  expectedRevision = null,
  hasEntitlement = true,
  now = new Date(),
} = {}) {
  const prior = normalizeChallengeActivationMutation(current);
  const requestedTimeZone = typeof timeZone === 'string' ? timeZone.trim() : '';
  const currentDate = challengeActivationDateKeyForTimeZone(now, requestedTimeZone);
  validateMockStartDate(startDate, currentDate);
  const confirmedAt = (now instanceof Date ? now : new Date(now)).toISOString();
  if (!actorId) throw new TypeError('A challenge activation actor is required.');

  if (action === 'date_update') {
    if (prior.mode !== 'solo' || !prior.canEditStartDate) {
      throw new Error('This challenge start date cannot be changed.');
    }
    if (expectedRevision !== null
      && (!Number.isInteger(expectedRevision) || expectedRevision < 0)) {
      throw new TypeError('Choose a valid challenge activation revision.');
    }
    const changed = prior.startDate !== startDate || prior.timeZone !== requestedTimeZone;
    if (expectedRevision !== null && expectedRevision !== prior.revision && changed) {
      throw staleActivationRevisionError();
    }
    if (!changed) return prior;

    const status = startDate > currentDate ? 'scheduled' : 'active';
    return normalizeChallengeActivationMutation({
      ...prior,
      revision: prior.revision + 1,
      status,
      storedStatus: status,
      startDate,
      timeZone: requestedTimeZone,
      challengeDay: status === 'active' ? challengeActivationDay(startDate, currentDate) : null,
      activatedAt: status === 'active' ? (prior.activatedAt || confirmedAt) : null,
      activatedBy: status === 'active' ? (prior.activatedBy || actorId) : null,
      canParticipate: status === 'active',
      canMutateDailyStandards: status === 'active' && hasEntitlement,
      canEditStartDate: true,
    });
  }

  if (!['solo_activate', 'group_activate'].includes(action)) {
    throw new TypeError('Choose a valid challenge activation action.');
  }
  if (action === 'group_activate' && (!crewId || !groupMembershipActive)) {
    throw new Error('Current crew membership is required for Group activation.');
  }

  const mode = action === 'group_activate' ? 'group' : 'solo';
  const compatibleExistingActivation = prior.mode === mode
    && prior.startDate === startDate
    && prior.timeZone === requestedTimeZone
    && (mode === 'solo' || prior.crewId === crewId);
  if (prior.status !== 'not_started') {
    if (compatibleExistingActivation) return prior;
    throw new Error('Challenge activation conflicts with the existing participation history.');
  }
  const status = startDate > currentDate ? 'scheduled' : 'active';
  return normalizeChallengeActivationMutation({
    schemaVersion: CHALLENGE_ACTIVATION_SCHEMA_VERSION,
    revision: prior.revision + 1,
    status,
    storedStatus: status,
    mode,
    startDate,
    timeZone: requestedTimeZone,
    challengeDay: status === 'active' ? challengeActivationDay(startDate, currentDate) : null,
    crewId: mode === 'group' ? crewId : null,
    groupMembershipActive: mode === 'group',
    activatedAt: status === 'active' ? confirmedAt : null,
    confirmedAt,
    activatedBy: status === 'active' ? actorId : null,
    confirmedBy: actorId,
    reviewRequired: false,
    canActivateSolo: false,
    canActivateGroup: false,
    canParticipate: status === 'active',
    canMutateDailyStandards: status === 'active' && hasEntitlement,
    canEditStartDate: mode === 'solo',
  });
}

export function challengeActivationReadError(error) {
  const state = createChallengeActivationState('error');
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : '';
  state.errorMessage = message.trim().slice(0, 300) || DEFAULT_READ_ERROR;
  return state;
}

function randomChallengeActivationRequestId(collisionSalt = 0) {
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  let carry = Math.max(0, Number(collisionSalt) || 0);
  for (let index = bytes.length - 1; index >= 12 && carry > 0; index -= 1) {
    const sum = bytes[index] + (carry & 0xff);
    bytes[index] = sum & 0xff;
    carry = Math.floor(carry / 256) + (sum > 0xff ? 1 : 0);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function reserveChallengeActivationRequestId(candidate) {
  if (!UUID_V4_PATTERN.test(String(candidate || ''))
    || issuedChallengeActivationRequestIds.has(candidate)) return '';
  issuedChallengeActivationRequestIds.add(candidate);
  return candidate;
}

export function newChallengeActivationRequestId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    try {
      const nativeId = reserveChallengeActivationRequestId(globalThis.crypto.randomUUID());
      if (nativeId) return nativeId;
    } catch {
      // Fall through to a compatible UUID-v4 generator.
    }
  }

  for (let attempt = 0; attempt < 16; attempt += 1) {
    const collisionSalt = attempt === 0
      ? 0
      : ++challengeActivationRequestCollisionSequence;
    const generatedId = reserveChallengeActivationRequestId(
      randomChallengeActivationRequestId(collisionSalt),
    );
    if (generatedId) return generatedId;
  }
  throw new Error('Unable to create a fresh challenge activation request ID.');
}
