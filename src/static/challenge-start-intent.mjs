export const CHALLENGE_START_INTENT_STORAGE_KEY = 'dominion:challengeStartIntent';
export const CHALLENGE_START_INTENT_PATH = './community.html?intent=challenge-start';
export const CHALLENGE_START_INTENT_TTL_MS = 2 * 60 * 60 * 1000;

const INTENT_VERSION = 1;
const INTENT_KIND = 'group';
const INTENT_STAGES = new Set([
  'choose_group',
  'confirm_group',
  'membership_pending',
  'activation_pending',
]);

const text = (value) => String(value || '').trim();

function timestamp(value) {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function normalizeIntent(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.version !== INTENT_VERSION || value.kind !== INTENT_KIND) return null;
  if (!INTENT_STAGES.has(value.stage)) return null;

  const createdAt = timestamp(value.createdAt);
  const expiresAt = timestamp(value.expiresAt);
  if (createdAt === null || expiresAt === null || expiresAt <= now || expiresAt <= createdAt) {
    return null;
  }

  const actorId = text(value.actorId) || null;
  const crewId = text(value.crewId) || null;
  const activationRequestId = text(value.activationRequestId) || null;
  const timeZone = text(value.timeZone) || null;
  if ((crewId || activationRequestId || timeZone) && !actorId) return null;
  if (value.stage === 'activation_pending'
    && (!actorId || !crewId || !activationRequestId || !timeZone)) return null;

  return {
    version: INTENT_VERSION,
    kind: INTENT_KIND,
    stage: value.stage,
    actorId,
    crewId,
    activationRequestId,
    timeZone,
    createdAt: new Date(createdAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

function persist(storage, intent) {
  storage?.setItem?.(CHALLENGE_START_INTENT_STORAGE_KEY, JSON.stringify(intent));
  return intent;
}

export function hasChallengeStartIntentMarker(locationLike = {}) {
  const params = new URLSearchParams(text(locationLike.search).replace(/^\?/, ''));
  return params.get('intent') === 'challenge-start';
}

export function isChallengeStartReturnPath(value) {
  if (!value) return false;
  try {
    const resolved = new URL(value, 'https://challenge-start.local/');
    return resolved.origin === 'https://challenge-start.local'
      && resolved.pathname === '/community.html'
      && resolved.searchParams.get('intent') === 'challenge-start'
      && [...resolved.searchParams.keys()].every((key) => key === 'intent')
      && !resolved.hash;
  } catch {
    return false;
  }
}

export function buildChallengeStartAuthHref(page) {
  const destination = page === 'register' ? './register.html' : './login.html';
  return `${destination}?returnTo=${encodeURIComponent(CHALLENGE_START_INTENT_PATH)}`;
}

export function readChallengeStartIntent(storage, { now = Date.now() } = {}) {
  const rawValue = storage?.getItem?.(CHALLENGE_START_INTENT_STORAGE_KEY);
  let value = null;
  try {
    value = JSON.parse(rawValue || 'null');
  } catch {
    value = null;
  }
  const intent = normalizeIntent(value, now);
  if (!intent && rawValue !== null && rawValue !== undefined) {
    storage?.removeItem?.(CHALLENGE_START_INTENT_STORAGE_KEY);
  }
  return intent;
}

export function captureChallengeStartIntent(
  storage,
  locationLike = {},
  { now = Date.now() } = {},
) {
  const existing = readChallengeStartIntent(storage, { now });
  if (!hasChallengeStartIntentMarker(locationLike)) return existing;
  if (existing) return existing;

  return persist(storage, {
    version: INTENT_VERSION,
    kind: INTENT_KIND,
    stage: 'choose_group',
    actorId: null,
    crewId: null,
    activationRequestId: null,
    timeZone: null,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CHALLENGE_START_INTENT_TTL_MS).toISOString(),
  });
}

export function bindChallengeStartIntent(storage, actorId, { now = Date.now() } = {}) {
  const expectedActorId = text(actorId);
  if (!expectedActorId) return null;
  const intent = readChallengeStartIntent(storage, { now });
  if (!intent) return null;
  if (intent.actorId && intent.actorId !== expectedActorId) {
    storage?.removeItem?.(CHALLENGE_START_INTENT_STORAGE_KEY);
    return null;
  }
  if (intent.actorId === expectedActorId) return intent;
  return persist(storage, { ...intent, actorId: expectedActorId });
}

export function setChallengeStartIntentStage(storage, stage, updates = {}) {
  const intent = readChallengeStartIntent(storage);
  if (!intent || !INTENT_STAGES.has(stage)) return null;
  const updated = normalizeIntent({
    ...intent,
    ...updates,
    version: INTENT_VERSION,
    kind: INTENT_KIND,
    stage,
  });
  return updated ? persist(storage, updated) : null;
}

export function armGroupChallengeActivation(storage, {
  actorId,
  crewId,
  requestId,
  timeZone,
} = {}) {
  const intent = readChallengeStartIntent(storage);
  const capturedActorId = text(actorId);
  if (!intent || !capturedActorId || intent.actorId !== capturedActorId) return null;
  const armed = normalizeIntent({
    ...intent,
    stage: 'activation_pending',
    crewId: text(crewId),
    activationRequestId: text(requestId),
    timeZone: text(timeZone),
  });
  return armed ? persist(storage, armed) : null;
}

export function clearChallengeStartIntent(storage) {
  storage?.removeItem?.(CHALLENGE_START_INTENT_STORAGE_KEY);
}

export function clearChallengeStartIntentMarker(windowLike = {}) {
  if (!hasChallengeStartIntentMarker(windowLike.location)) return false;
  const cleanPath = text(windowLike.location?.pathname) || '/community.html';
  windowLike.history?.replaceState?.(windowLike.history?.state ?? null, '', cleanPath);
  return true;
}

export function challengeStartTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function reconcileGroupChallengeStart(intent, { activation, crewIds = [] } = {}) {
  if (!intent) return 'none';
  if (!activation?.contractValid || activation.readState !== 'ready') return 'unavailable';

  if (activation.status !== 'not_started') {
    if (activation.mode === 'group'
      && (!intent.crewId || activation.crewId === intent.crewId)
      && activation.groupMembershipActive
      && crewIds.includes(activation.crewId)) return 'complete';
    return 'conflict';
  }

  if (intent.crewId && !crewIds.includes(intent.crewId)) return 'membership_missing';
  return intent.stage === 'activation_pending' ? 'activation_pending' : 'pending';
}
