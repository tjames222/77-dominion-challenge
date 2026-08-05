import {
  challengeActivationDateKeyForTimeZone,
  challengeActivationDay,
  isSupportedChallengeActivationDate,
} from './challenge-activation.mjs';
import { CHALLENGE_START_INTENT_PATH } from './challenge-start-intent.mjs';

export const GROUP_CHALLENGE_START_HREF = CHALLENGE_START_INTENT_PATH;
export const SOLO_TRAINING_LAUNCH_EVENT = 'dominion:solo-training-launch-requested';
export const SOLO_TRAINING_LAUNCH_STORAGE_KEY = 'dominion:soloTrainingLaunchRequests';
export const SOLO_TRAINING_LAUNCH_SCHEMA_VERSION = 1;

const PARTICIPATION_MODES = new Set(['group', 'solo']);
const ACTIVE_ACTIVATION_STATUSES = new Set(['scheduled', 'active']);

const asText = (value) => String(value ?? '').trim();

export function buildGroupChallengeStartHref() {
  return GROUP_CHALLENGE_START_HREF;
}

export function resolveChallengeStartTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function validateSoloChallengeStartDate({
  startDate,
  timeZone,
  now = new Date(),
} = {}) {
  const normalizedStartDate = asText(startDate);
  const normalizedTimeZone = asText(timeZone);
  if (!isSupportedChallengeActivationDate(normalizedStartDate)) {
    return {
      valid: false,
      message: 'Choose a valid challenge start date.',
    };
  }

  let currentDate;
  try {
    currentDate = challengeActivationDateKeyForTimeZone(now, normalizedTimeZone);
  } catch {
    return {
      valid: false,
      message: 'Your time zone could not be confirmed. Refresh and try again.',
    };
  }

  const challengeDay = challengeActivationDay(normalizedStartDate, currentDate);
  if (challengeDay > 77) {
    return {
      valid: false,
      message: 'Choose a start date within the current 77-day challenge window.',
    };
  }

  const status = challengeDay <= 0 ? 'scheduled' : 'active';
  return {
    valid: true,
    startDate: normalizedStartDate,
    timeZone: normalizedTimeZone,
    currentDate,
    status,
    challengeDay: status === 'active' ? challengeDay : null,
  };
}

export function soloChallengeStartSummary(validation) {
  if (!validation?.valid) return '';
  if (validation.status === 'scheduled') {
    return 'Your challenge will be scheduled for this date. Training can begin now, and Daily Standards unlock when the date arrives.';
  }
  if (validation.challengeDay === 1) {
    return 'Your challenge starts today. Day 1 and today\'s Daily Standards become available after confirmation.';
  }
  return `Your challenge timeline will begin on this date, making today Day ${validation.challengeDay} of 77.`;
}

export function createChallengeStartFlowState({
  canActivateGroup = false,
  canActivateSolo = false,
  timeZone = resolveChallengeStartTimeZone(),
} = {}) {
  return {
    step: 'mode',
    mode: '',
    startDate: '',
    timeZone,
    requestId: '',
    submissionAttempted: false,
    canActivateGroup: Boolean(canActivateGroup),
    canActivateSolo: Boolean(canActivateSolo),
  };
}

export function selectChallengeStartMode(state, mode) {
  const normalizedMode = PARTICIPATION_MODES.has(mode) ? mode : '';
  return {
    ...state,
    mode: normalizedMode,
    step: 'mode',
    requestId: '',
    submissionAttempted: false,
  };
}

export function continueChallengeStartMode(state) {
  if (state?.mode === 'group' && state.canActivateGroup) {
    return { ...state, step: 'group_handoff' };
  }
  if (state?.mode === 'solo' && state.canActivateSolo) {
    return { ...state, step: 'date' };
  }
  return state;
}

export function setSoloChallengeStartDate(state, startDate) {
  return {
    ...state,
    startDate: asText(startDate),
    requestId: '',
    submissionAttempted: false,
  };
}

export function confirmSoloChallengeStart(state, requestId) {
  const validation = validateSoloChallengeStartDate(state);
  if (!validation.valid || state?.mode !== 'solo' || !state.canActivateSolo) {
    return { state, validation };
  }
  return {
    validation,
    state: {
      ...state,
      step: 'confirm',
      requestId: state.requestId || asText(requestId),
    },
  };
}

export function backChallengeStartFlow(state) {
  if (state?.step === 'confirm') {
    return {
      ...state,
      step: 'date',
      requestId: '',
      submissionAttempted: false,
    };
  }
  if (state?.step === 'date') {
    return {
      ...state,
      step: 'mode',
      requestId: '',
      submissionAttempted: false,
    };
  }
  return state;
}

export function markChallengeStartSubmission(state) {
  return {
    ...state,
    submissionAttempted: true,
  };
}

export function dashboardActivationGate(activation, {
  hydrated = false,
  online = true,
} = {}) {
  const ready = Boolean(
    hydrated
    && activation?.readState === 'ready'
    && activation?.contractValid,
  );
  const notStarted = ready && activation.status === 'not_started';
  const canStart = Boolean(
    notStarted
    && online
    && (activation.canActivateSolo || activation.canActivateGroup),
  );

  return {
    ready,
    notStarted,
    showStartGate: notStarted || (hydrated && activation?.readState === 'error'),
    canStart,
    canParticipate: ready && activation.canParticipate === true,
    canMutateDailyStandards: ready && activation.canMutateDailyStandards === true,
    showRetry: Boolean(hydrated && activation?.readState === 'error'),
  };
}

export function createSoloTrainingLaunch({
  actorId,
  activation,
  requestedAt = new Date().toISOString(),
} = {}) {
  const normalizedActorId = asText(actorId);
  if (!normalizedActorId) throw new TypeError('A Solo training launch actor is required.');
  if (activation?.readState !== 'ready'
    || !activation.contractValid
    || activation.mode !== 'solo'
    || !ACTIVE_ACTIVATION_STATUSES.has(activation.status)
    || !isSupportedChallengeActivationDate(activation.startDate)
    || !Number.isInteger(activation.revision)
    || activation.revision < 1) {
    throw new TypeError('A verified Solo activation is required to launch training.');
  }

  const timestamp = new Date(requestedAt);
  if (Number.isNaN(timestamp.getTime())) {
    throw new TypeError('A valid Solo training launch time is required.');
  }

  return {
    schemaVersion: SOLO_TRAINING_LAUNCH_SCHEMA_VERSION,
    actorId: normalizedActorId,
    activationRevision: activation.revision,
    activationStatus: activation.status,
    startDate: activation.startDate,
    requestedAt: timestamp.toISOString(),
    source: 'challenge_activation',
  };
}

function normalizeSoloTrainingLaunch(launch) {
  if (launch?.schemaVersion !== SOLO_TRAINING_LAUNCH_SCHEMA_VERSION
    || launch?.source !== 'challenge_activation') {
    throw new TypeError('A supported Solo training launch contract is required.');
  }
  return createSoloTrainingLaunch({
    actorId: launch?.actorId,
    activation: {
      readState: 'ready',
      contractValid: true,
      mode: 'solo',
      status: launch?.activationStatus,
      startDate: launch?.startDate,
      revision: launch?.activationRevision,
    },
    requestedAt: launch?.requestedAt,
  });
}

function readStoredSoloTrainingLaunches(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem?.(SOLO_TRAINING_LAUNCH_STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function persistSoloTrainingLaunch(storage, launch) {
  if (typeof storage?.setItem !== 'function') {
    throw new TypeError('Durable browser storage is required for Solo training.');
  }
  const normalized = normalizeSoloTrainingLaunch(launch);
  const launches = readStoredSoloTrainingLaunches(storage);
  launches[normalized.actorId] = normalized;
  storage.setItem(SOLO_TRAINING_LAUNCH_STORAGE_KEY, JSON.stringify(launches));
  return normalized;
}

export function readSoloTrainingLaunch(storage, actorId) {
  const normalizedActorId = asText(actorId);
  if (!normalizedActorId) return null;
  const launch = readStoredSoloTrainingLaunches(storage)[normalizedActorId];
  if (!launch || launch.actorId !== normalizedActorId) return null;
  try {
    return normalizeSoloTrainingLaunch(launch);
  } catch {
    return null;
  }
}

export function publishSoloTrainingLaunch({
  actorId,
  activation,
  storage = globalThis.localStorage,
  window: windowLike = globalThis.window,
  requestedAt,
} = {}) {
  const launch = persistSoloTrainingLaunch(storage, createSoloTrainingLaunch({
    actorId,
    activation,
    requestedAt,
  }));
  const EventConstructor = windowLike?.CustomEvent;
  if (typeof EventConstructor === 'function') {
    windowLike.dispatchEvent(new EventConstructor(SOLO_TRAINING_LAUNCH_EVENT, {
      detail: launch,
    }));
  }
  return launch;
}
