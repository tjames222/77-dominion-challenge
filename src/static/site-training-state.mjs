import { SITE_TRAINING_SCHEMA_VERSION } from './site-training-registry.mjs';

export const SITE_TRAINING_STATUSES = Object.freeze([
  'not_started',
  'in_progress',
  'stopped',
  'completed',
]);
export const SITE_TRAINING_TRANSITIONS = Object.freeze([
  'start',
  'resume',
  'back',
  'next',
  'stop',
  'finish',
]);

const STATUS_SET = new Set(SITE_TRAINING_STATUSES);
const TRANSITION_SET = new Set(SITE_TRAINING_TRANSITIONS);
const READ_STATE_SET = new Set(['loading', 'ready', 'error']);
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
const ROUTE_PATTERN = /^\/[a-z0-9]+(?:-[a-z0-9]+)*\.html$/;
const issuedRequestIds = new Set();
let collisionSequence = 0;

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const read = (value, ...keys) => {
  if (!value || typeof value !== 'object') return undefined;
  const key = keys.find((candidate) => hasOwn(value, candidate));
  return key ? value[key] : undefined;
};
const text = (value) => (typeof value === 'string' ? value.trim() : '');
const integer = (value, fallback = 0) => {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : fallback;
};
const timestamp = (value) => {
  if (value === null || value === undefined || value === '') return null;
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
};

export function createSiteTrainingState(readState = 'loading') {
  const state = READ_STATE_SET.has(readState) ? readState : 'error';
  return {
    schemaVersion: SITE_TRAINING_SCHEMA_VERSION,
    readState: state,
    contractValid: false,
    actorId: null,
    page: null,
    overall: null,
    claimedNow: false,
    transition: null,
    ...(state === 'error' ? { errorMessage: 'Unable to load page training.' } : {}),
  };
}

function normalizePage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const pageId = text(read(value, 'pageId', 'page_id'));
  const route = text(read(value, 'route'));
  const contentVersion = integer(read(value, 'contentVersion', 'content_version'), -1);
  const status = text(read(value, 'status')).toLowerCase();
  const stepIds = read(value, 'stepIds', 'step_ids');
  const currentStepId = text(read(value, 'currentStepId', 'current_step_id'));
  const currentStepIndex = integer(read(value, 'currentStepIndex', 'current_step_index', 'currentStep', 'current_step'), -1);
  const furthestStepIndex = integer(read(value, 'furthestStepIndex', 'furthest_step_index', 'furthestStep', 'furthest_step'), -1);
  const revision = integer(read(value, 'revision'), -1);
  const completionCount = integer(read(value, 'completionCount', 'completion_count'), 0);
  const everCompleted = read(value, 'everCompleted', 'ever_completed') === true;
  const startedAt = timestamp(read(value, 'startedAt', 'started_at'));
  const stoppedAt = timestamp(read(value, 'stoppedAt', 'stopped_at'));
  const completedAt = timestamp(read(value, 'completedAt', 'completed_at'));
  const updatedAt = timestamp(read(value, 'updatedAt', 'updated_at'));

  const validSteps = Array.isArray(stepIds)
    && stepIds.length > 0
    && stepIds.every((stepId) => text(stepId) === stepId)
    && new Set(stepIds).size === stepIds.length;
  const valid = Boolean(pageId)
    && ROUTE_PATTERN.test(route)
    && contentVersion >= 1
    && STATUS_SET.has(status)
    && validSteps
    && currentStepIndex >= 0
    && currentStepIndex < stepIds.length
    && furthestStepIndex >= currentStepIndex
    && furthestStepIndex < stepIds.length
    && currentStepId === stepIds[currentStepIndex]
    && revision >= 0
    && completionCount >= 0
    && everCompleted === (completionCount > 0)
    && startedAt !== undefined
    && stoppedAt !== undefined
    && completedAt !== undefined
    && updatedAt !== undefined
    && (status === 'not_started'
      ? startedAt === null && stoppedAt === null && completedAt === null
        && currentStepIndex === 0 && furthestStepIndex === 0
      : startedAt !== null)
    && (status === 'in_progress' ? stoppedAt === null && completedAt === null : true)
    && (status === 'stopped' ? stoppedAt !== null && completedAt === null : true)
    && (status === 'completed'
      ? completedAt !== null && stoppedAt === null
        && currentStepIndex === stepIds.length - 1 && everCompleted
      : true);
  if (!valid) return null;

  return {
    pageId,
    route,
    contentVersion,
    status,
    stepIds: [...stepIds],
    stepCount: stepIds.length,
    currentStepId,
    currentStepIndex,
    furthestStepIndex,
    revision,
    everCompleted,
    completionCount,
    startedAt,
    stoppedAt,
    completedAt,
    updatedAt,
  };
}

function normalizeOverall(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const programId = text(read(value, 'programId', 'program_id'));
  const programVersion = integer(read(value, 'programVersion', 'program_version'), -1);
  const status = text(read(value, 'status')).toLowerCase();
  const currentPageId = read(value, 'currentPageId', 'current_page_id');
  const currentPageContentVersion = read(value, 'currentPageContentVersion', 'current_page_content_version');
  const currentPageIndex = integer(read(value, 'currentPageIndex', 'current_page_index'), -1);
  const revision = integer(read(value, 'revision'), -1);
  const startedAt = timestamp(read(value, 'startedAt', 'started_at'));
  const stoppedAt = timestamp(read(value, 'stoppedAt', 'stopped_at'));
  const completedAt = timestamp(read(value, 'completedAt', 'completed_at'));
  const updatedAt = timestamp(read(value, 'updatedAt', 'updated_at'));
  const hasCurrentPage = currentPageId !== null && currentPageId !== undefined && currentPageId !== '';
  if (!programId
    || programVersion < 1
    || !STATUS_SET.has(status)
    || revision < 0
    || startedAt === undefined
    || stoppedAt === undefined
    || completedAt === undefined
    || updatedAt === undefined
    || (status === 'not_started'
      ? startedAt !== null || stoppedAt !== null || completedAt !== null
      : startedAt === null)
    || (status === 'in_progress' && (stoppedAt !== null || completedAt !== null))
    || (status === 'stopped' && (stoppedAt === null || completedAt !== null))
    || (status === 'completed' && (stoppedAt !== null || completedAt === null))
    || (hasCurrentPage && (
      !text(currentPageId)
      || integer(currentPageContentVersion, -1) < 1
      || currentPageIndex < 0
    ))) return undefined;

  return {
    programId,
    programVersion,
    status,
    currentPageId: hasCurrentPage ? text(currentPageId) : null,
    currentPageContentVersion: hasCurrentPage ? integer(currentPageContentVersion) : null,
    currentPageIndex: hasCurrentPage ? currentPageIndex : null,
    revision,
    startedAt,
    stoppedAt,
    completedAt,
    updatedAt,
  };
}

export function siteTrainingReadError(error) {
  const state = createSiteTrainingState('error');
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  state.errorMessage = message.trim().slice(0, 300) || state.errorMessage;
  return state;
}

export function normalizeSiteTrainingState(payload, { expectedPage = null, expectedProgram = null } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return siteTrainingReadError('Page training data could not be verified. Refresh and try again.');
  }
  const schemaVersion = read(payload, 'schemaVersion', 'schema_version');
  const actorId = text(read(payload, 'actorId', 'actor_id', 'userId', 'user_id'));
  const page = normalizePage(read(payload, 'page', 'pageProgress', 'page_progress'));
  const overall = normalizeOverall(read(payload, 'overall', 'overallProgress', 'overall_progress'));
  const claimedNow = read(payload, 'claimedNow', 'claimed_now') === true;
  const transitionValue = read(payload, 'transition');
  const transitionNextRoute = text(read(transitionValue, 'nextRoute', 'next_route')) || null;
  const transitionCompletedPageId = text(read(transitionValue, 'completedPageId', 'completed_page_id')) || null;
  const transition = transitionValue === null || transitionValue === undefined
    ? null
    : {
        action: text(read(transitionValue, 'action')).toLowerCase(),
        scope: text(read(transitionValue, 'scope')).toLowerCase() || null,
        applied: read(transitionValue, 'applied') === true,
        nextRoute: transitionNextRoute,
        completedPageId: transitionCompletedPageId,
      };

  const expectedMatches = !expectedPage || (
    page?.pageId === expectedPage.id
    && page?.route === expectedPage.route
    && page?.contentVersion === expectedPage.contentVersion
    && JSON.stringify(page?.stepIds) === JSON.stringify(expectedPage.steps.map((step) => step.id))
  );
  const expectedProgramMatches = !expectedProgram
    ? overall === null
    : Boolean(overall
      && overall.programId === expectedProgram.id
      && overall.programVersion === expectedProgram.version
      && expectedProgram.pages.some((candidate, index) => (
        candidate.pageId === overall.currentPageId
        && candidate.contentVersion === overall.currentPageContentVersion
        && index === overall.currentPageIndex
      )));
  if (schemaVersion !== SITE_TRAINING_SCHEMA_VERSION
    || !actorId
    || !page
    || overall === undefined
    || !expectedMatches
    || !expectedProgramMatches
    || (transition && (
      !TRANSITION_SET.has(transition.action)
      || (transition.scope !== null && !['page', 'overall'].includes(transition.scope))
      || (transition.nextRoute !== null && !ROUTE_PATTERN.test(transition.nextRoute))
      || (transition.completedPageId !== null && !IDENTIFIER_PATTERN.test(transition.completedPageId))
    ))) {
    return siteTrainingReadError('Page training data could not be verified. Refresh and try again.');
  }

  return {
    schemaVersion,
    readState: 'ready',
    contractValid: true,
    actorId,
    page,
    overall,
    claimedNow,
    transition,
  };
}

export function normalizeSiteTrainingMutation(payload, options = {}) {
  const state = normalizeSiteTrainingState(payload, options);
  if (state.contractValid
    && state.transition
    && ['page', 'overall'].includes(state.transition.scope)
    && state.claimedNow === (
      state.transition.action === 'start' && state.transition.applied
    )
    && (state.transition.scope !== 'overall'
      || state.transition.action !== 'finish'
      || state.transition.completedPageId !== null)
    && (state.transition.nextRoute === null || (
      state.transition.scope === 'overall'
      && state.transition.action === 'finish'
      && state.transition.completedPageId !== null
    ))) return state;
  const error = new Error('The page training response was invalid. Refresh and try again.');
  error.code = 'SITE_TRAINING_CONTRACT_INVALID';
  throw error;
}

export function createSiteTrainingPageProgress(page, actorId) {
  const now = null;
  return {
    schemaVersion: SITE_TRAINING_SCHEMA_VERSION,
    actorId,
    page: {
      pageId: page.id,
      route: page.route,
      contentVersion: page.contentVersion,
      status: 'not_started',
      stepIds: page.steps.map((step) => step.id),
      currentStepId: page.steps[0].id,
      currentStepIndex: 0,
      furthestStepIndex: 0,
      revision: 0,
      everCompleted: false,
      completionCount: 0,
      startedAt: now,
      stoppedAt: now,
      completedAt: now,
      updatedAt: now,
    },
    overall: null,
    claimedNow: false,
    transition: null,
  };
}

export function applySiteTrainingTransition(state, action, {
  targetStepId = null,
  now = new Date().toISOString(),
} = {}) {
  const normalizedAction = text(action).toLowerCase();
  if (!TRANSITION_SET.has(normalizedAction)) throw new TypeError('Choose a valid page training action.');
  const current = structuredClone(state);
  current.claimedNow = false;
  const page = current.page;
  const targetIndex = targetStepId === null ? page.currentStepIndex : page.stepIds.indexOf(targetStepId);
  if (targetIndex < 0) throw new TypeError('Choose a published page training step.');
  let applied = true;

  if (normalizedAction === 'start') {
    if (page.status !== 'not_started') applied = false;
    else {
      page.status = 'in_progress';
      page.startedAt = now;
      current.claimedNow = true;
    }
  } else if (normalizedAction === 'resume') {
    if (page.status === 'in_progress') applied = false;
    else if (page.status !== 'stopped') throw new Error('This page training cannot be resumed.');
    else {
      page.status = 'in_progress';
      page.stoppedAt = null;
    }
  } else if (normalizedAction === 'back') {
    if (page.status === 'in_progress' && page.currentStepIndex === 0) applied = false;
    else if (page.status !== 'in_progress' || targetIndex !== page.currentStepIndex - 1) {
      throw new Error('Page training can only move back one published step.');
    } else {
      page.currentStepIndex = targetIndex;
      page.currentStepId = page.stepIds[targetIndex];
    }
  } else if (normalizedAction === 'next') {
    if (page.status !== 'in_progress' || targetIndex !== page.currentStepIndex + 1) {
      throw new Error('Page training steps must be completed in order.');
    }
    page.currentStepIndex = targetIndex;
    page.currentStepId = page.stepIds[targetIndex];
    page.furthestStepIndex = Math.max(page.furthestStepIndex, targetIndex);
  } else if (normalizedAction === 'stop') {
    if (page.status === 'stopped') applied = false;
    else if (page.status !== 'in_progress') throw new Error('Start page training before stopping it.');
    else {
      page.status = 'stopped';
      page.stoppedAt = now;
    }
  } else if (normalizedAction === 'finish') {
    if (page.status !== 'in_progress' || page.currentStepIndex !== page.stepIds.length - 1) {
      throw new Error('Finish the final page training step before completing it.');
    } else {
      page.status = 'completed';
      page.stoppedAt = null;
      page.completedAt = now;
      page.everCompleted = true;
      page.completionCount += 1;
    }
  }

  if (applied) {
    page.revision += 1;
    page.updatedAt = now;
  }
  current.transition = {
    action: normalizedAction,
    scope: 'page',
    applied,
    nextRoute: null,
    completedPageId: null,
  };
  return current;
}

export function reconcileSiteTrainingContentVersion(previousState, page, actorId) {
  const initial = createSiteTrainingPageProgress(page, actorId);
  const previous = previousState?.page;
  if (!previous) return initial;
  const retainedStepIndex = page.steps.findIndex((step) => step.id === previous.currentStepId);
  const nextIndex = Math.max(0, retainedStepIndex);
  initial.page.status = previous.status === 'not_started' ? 'not_started' : 'stopped';
  initial.page.currentStepIndex = nextIndex;
  initial.page.currentStepId = initial.page.stepIds[nextIndex];
  initial.page.furthestStepIndex = nextIndex;
  initial.page.startedAt = previous.startedAt;
  initial.page.stoppedAt = previous.status === 'not_started' ? null : new Date().toISOString();
  initial.page.everCompleted = Boolean(previous.everCompleted);
  initial.page.completionCount = Math.max(0, Number(previous.completionCount) || 0);
  return initial;
}

function randomRequestId(salt = 0) {
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  if (!bytes.some(Boolean)) {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[15] = (bytes[15] + salt) & 0xff;
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function newSiteTrainingRequestId() {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidate = typeof globalThis.crypto?.randomUUID === 'function' && attempt === 0
      ? globalThis.crypto.randomUUID()
      : randomRequestId(++collisionSequence);
    if (UUID_V4_PATTERN.test(candidate) && !issuedRequestIds.has(candidate)) {
      issuedRequestIds.add(candidate);
      return candidate;
    }
  }
  throw new Error('Unable to create a fresh page training request ID.');
}
