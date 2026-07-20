const CHALLENGE_STATES = new Set(['locked', 'available', 'active', 'completed']);
const OWNERSHIP_STATES = new Set(['locked', 'owned']);
const STATE_MODELS = new Set(['challenge_lifecycle', 'ownership']);

const safeWholeNumber = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : fallback;
};

const safePercent = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(Math.max(number, 0), 100) : 0;
};

const safeKey = (value) => String(value || '').trim();

export function normalizeReward(reward = {}) {
  const stateModel = STATE_MODELS.has(reward.stateModel || reward.state_model)
    ? reward.stateModel || reward.state_model
    : 'ownership';
  const validStates = stateModel === 'challenge_lifecycle' ? CHALLENGE_STATES : OWNERSHIP_STATES;
  const status = validStates.has(reward.status) ? reward.status : 'locked';
  const currentPoints = safeWholeNumber(reward.currentPoints ?? reward.current_points);
  const pointsRequired = safeWholeNumber(reward.pointsRequired ?? reward.points_required);
  const unlocked = status !== 'locked';
  const pointsRemaining = unlocked
    ? 0
    : safeWholeNumber(
      reward.pointsRemaining ?? reward.points_remaining,
      Math.max(pointsRequired - currentPoints, 0),
    );
  const progressPercent = unlocked
    ? 100
    : safePercent(
      reward.progressPercent ?? reward.progress_percent
        ?? (pointsRequired ? currentPoints / pointsRequired * 100 : 100),
    );
  const requestedActions = Array.isArray(reward.allowedActions || reward.allowed_actions)
    ? [...new Set(reward.allowedActions || reward.allowed_actions)].filter((action) => typeof action === 'string')
    : [];
  const canAccess = reward.canAccess ?? reward.can_access ?? true;
  const allowedActions = stateModel === 'challenge_lifecycle' && status === 'available' && canAccess
    ? requestedActions
    : [];

  return {
    key: safeKey(reward.key || reward.rewardKey || reward.reward_key),
    rewardType: safeKey(reward.rewardType || reward.reward_type) || 'reward',
    stateModel,
    status,
    title: reward.title || 'Reward',
    description: reward.description || '',
    pointsRequired,
    currentPoints,
    pointsRemaining,
    progressPercent,
    fulfillmentKey: safeKey(reward.fulfillmentKey || reward.fulfillment_key),
    requiredEntitlementKey: reward.requiredEntitlementKey || reward.required_entitlement_key || null,
    icon: safeKey(reward.icon).replace(/[^a-z0-9-]/g, '') || 'gift',
    sortOrder: Number(reward.sortOrder ?? reward.sort_order) || 0,
    active: reward.active ?? reward.isActive ?? reward.is_active ?? true,
    metadata: reward.metadata && typeof reward.metadata === 'object' ? reward.metadata : {},
    canAccess,
    accessReason: reward.accessReason || reward.access_reason || null,
    allowedActions,
    unlockPoints: reward.unlockPoints ?? reward.unlock_points ?? null,
    unlockedAt: reward.unlockedAt || reward.unlocked_at || null,
    startedAt: reward.startedAt || reward.started_at || null,
    completedAt: reward.completedAt || reward.completed_at || null,
    ownedAt: reward.ownedAt || reward.owned_at || null,
    celebrationSeenAt: reward.celebrationSeenAt || reward.celebration_seen_at || null,
  };
}

export function normalizeRewardCatalog(payload = {}) {
  const items = (Array.isArray(payload.items) ? payload.items : [])
    .map(normalizeReward)
    .filter((reward) => reward.key);
  const nextKey = safeKey(payload.nextUnlock?.key || payload.next_unlock?.key);
  const nextUnlock = nextKey
    ? items.find((reward) => reward.key === nextKey)
      || normalizeReward(payload.nextUnlock || payload.next_unlock)
    : null;
  const rawPage = payload.page && typeof payload.page === 'object' ? payload.page : {};
  const rawCursor = rawPage.nextCursor || rawPage.next_cursor;
  const nextCursor = rawCursor && typeof rawCursor === 'object'
    ? {
      sortOrder: Number(rawCursor.sortOrder ?? rawCursor.sort_order) || 0,
      key: safeKey(rawCursor.key),
    }
    : null;

  return {
    schemaVersion: safeWholeNumber(payload.schemaVersion ?? payload.schema_version, 1) || 1,
    catalogVersion: safeWholeNumber(payload.catalogVersion ?? payload.catalog_version, 1) || 1,
    totalPoints: safeWholeNumber(payload.totalPoints ?? payload.total_points),
    items,
    nextUnlock,
    page: {
      limit: safeWholeNumber(rawPage.limit, items.length),
      totalItems: safeWholeNumber(rawPage.totalItems ?? rawPage.total_items, items.length),
      hasMore: Boolean(rawPage.hasMore ?? rawPage.has_more),
      nextCursor: nextCursor?.key ? nextCursor : null,
    },
  };
}

export function challengeProgressionToRewardCatalog(progression = {}) {
  const totalPoints = safeWholeNumber(progression.totalPoints ?? progression.total_points);
  const items = (progression.challenges || []).map((challenge) => normalizeReward({
    ...challenge,
    rewardType: 'challenge',
    stateModel: 'challenge_lifecycle',
    fulfillmentKey: challenge.key,
    currentPoints: totalPoints,
    description: challenge.teaser || challenge.description || '',
    metadata: {
      ...(challenge.metadata || {}),
      challengeType: challenge.type || 'general',
      durationDays: challenge.durationDays ?? null,
    },
    allowedActions: challenge.status === 'available' && challenge.accessGranted !== false ? ['start'] : [],
    canAccess: challenge.accessGranted ?? true,
    accessReason: challenge.accessReason || null,
  }));
  const nextUnlock = progression.nextUnlock
    ? items.find((reward) => reward.key === progression.nextUnlock.key) || null
    : null;

  return normalizeRewardCatalog({
    schemaVersion: 1,
    catalogVersion: 1,
    totalPoints,
    items,
    nextUnlock,
    page: {
      limit: items.length,
      totalItems: items.length,
      hasMore: false,
      nextCursor: null,
    },
  });
}
