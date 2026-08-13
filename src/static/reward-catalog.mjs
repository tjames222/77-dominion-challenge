import { REWARD_POINT_THRESHOLDS } from './point-economy.mjs';

const CHALLENGE_STATES = new Set(['locked', 'available', 'active', 'completed']);
const OWNERSHIP_STATES = new Set(['locked', 'owned']);
const STATE_MODELS = new Set(['challenge_lifecycle', 'ownership']);

export const DOMINION_NIGHT_THEME_REWARD = Object.freeze({
  key: 'dominion_night_theme',
  rewardType: 'cosmetic',
  stateModel: 'ownership',
  title: 'Dominion Night',
  description: 'Earn a dark app theme, then select it from Profile.',
  pointsRequired: REWARD_POINT_THRESHOLDS.dominion_night_theme,
  fulfillmentKey: 'dominion-night',
  icon: 'palette',
  sortOrder: 20,
  active: true,
  metadata: Object.freeze({
    themeKey: 'dominion-night',
    preview: 'dominion-night',
    colorScheme: 'dark',
    selectionRoute: 'profile.html#appearance',
    selectionLabel: 'Select in Profile',
  }),
});

export const GYM_TRAINING_DISCOUNT_REWARD = Object.freeze({
  key: 'gym_training_discount',
  rewardType: 'partner_discount',
  stateModel: 'ownership',
  title: 'Gym Training Discount',
  description: 'Earn a configurable partner offer to support training in a properly equipped gym.',
  pointsRequired: REWARD_POINT_THRESHOLDS.gym_training_discount,
  fulfillmentKey: 'gym-training-discount',
  icon: 'dumbbell',
  sortOrder: 10,
  active: true,
  metadata: Object.freeze({
    eligibilitySource: 'daily_standard',
    fulfillmentAvailability: 'unavailable',
    encouragement: 'Complete challenge workouts at a properly equipped gym whenever practical so you can train safely and consistently.',
  }),
});

export const NEHEMIAH_HANDBOOK_REWARD = Object.freeze({
  key: 'nehemiah_leadership_handbook',
  rewardType: 'digital_download',
  stateModel: 'ownership',
  title: 'Nehemiah Leadership Handbook',
  description: 'A faith-centered leadership resource for the rest of your challenge.',
  pointsRequired: REWARD_POINT_THRESHOLDS.nehemiah_leadership_handbook,
  fulfillmentKey: 'nehemiah-leadership-handbook',
  icon: 'book',
  sortOrder: 30,
  active: true,
  metadata: Object.freeze({
    format: 'PDF',
    fulfillmentAvailability: 'unavailable',
  }),
});

export const DOMINION_PLATINUM_THEME_REWARD = Object.freeze({
  key: 'dominion_platinum',
  rewardType: 'cosmetic',
  stateModel: 'ownership',
  title: 'Dominion Platinum',
  description: 'Unlock a rare obsidian, platinum-glass, and Dominion gold app theme.',
  pointsRequired: REWARD_POINT_THRESHOLDS.dominion_platinum,
  fulfillmentKey: 'dominion-platinum',
  icon: 'crown',
  sortOrder: 50,
  active: true,
  metadata: Object.freeze({
    themeKey: 'dominion-platinum',
    preview: 'dominion-platinum',
    colorScheme: 'dark',
    selectionRoute: 'profile.html#appearance',
    selectionLabel: 'Select in Profile',
  }),
});

export const BIG_GOD_ENERGY_TSHIRT_REWARD = Object.freeze({
  key: 'big_god_energy_tshirt_discount',
  rewardType: 'merch_discount',
  stateModel: 'ownership',
  title: 'Big God Energy T-Shirt Discount',
  description: 'Earn a configurable discount toward the Big God Energy T-shirt.',
  pointsRequired: REWARD_POINT_THRESHOLDS.big_god_energy_tshirt_discount,
  fulfillmentKey: 'big-god-energy-tshirt-discount',
  icon: 'gift',
  sortOrder: 60,
  active: true,
  metadata: Object.freeze({
    thumbnailUrl: './images/big-god-energy-tshirt.jpg',
    thumbnailAlt: 'Black Big God Energy T-shirt with white lettering.',
    fulfillmentAvailability: 'unavailable',
  }),
});

export const DEFAULT_OWNERSHIP_REWARD_DEFINITIONS = Object.freeze([
  GYM_TRAINING_DISCOUNT_REWARD,
  DOMINION_NIGHT_THEME_REWARD,
  NEHEMIAH_HANDBOOK_REWARD,
  DOMINION_PLATINUM_THEME_REWARD,
  BIG_GOD_ENERGY_TSHIRT_REWARD,
]);

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
    fulfillment: reward.fulfillment && typeof reward.fulfillment === 'object' ? reward.fulfillment : {},
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

const resolveTimestamp = (now) => {
  if (typeof now === 'function') return String(now());
  if (typeof now === 'string' && now) return now;
  return new Date().toISOString();
};

const normalizeOwnershipRecords = (records = []) => {
  const recordsByKey = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const key = safeKey(record?.key || record?.rewardKey || record?.reward_key);
    if (!key || recordsByKey.has(key)) continue;
    recordsByKey.set(key, {
      key,
      ownedAt: record.ownedAt || record.owned_at || null,
      celebrationSeenAt: record.celebrationSeenAt || record.celebration_seen_at || null,
    });
  }
  return recordsByKey;
};

export function buildMockRewardCatalog({
  progression = {},
  ownershipRecords = [],
  rewardDefinitions = DEFAULT_OWNERSHIP_REWARD_DEFINITIONS,
  eligibleDailyStandardPoints = progression.eligibleDailyStandardPoints
    ?? progression.eligible_daily_standard_points
    ?? progression.totalPoints
    ?? progression.total_points,
  now,
} = {}) {
  const challengeCatalog = challengeProgressionToRewardCatalog(progression);
  const totalPoints = challengeCatalog.totalPoints;
  const recordsByKey = normalizeOwnershipRecords(ownershipRecords);
  const timestamp = resolveTimestamp(now);

  for (const definition of rewardDefinitions) {
    const key = safeKey(definition?.key);
    if (!key || recordsByKey.has(key) || definition.active === false) continue;
    const eligiblePoints = key === GYM_TRAINING_DISCOUNT_REWARD.key
      ? safeWholeNumber(eligibleDailyStandardPoints)
      : totalPoints;
    if (eligiblePoints >= safeWholeNumber(definition.pointsRequired)) {
      recordsByKey.set(key, {
        key,
        ownedAt: timestamp,
        celebrationSeenAt: null,
      });
    }
  }

  const ownershipItems = rewardDefinitions.map((definition) => {
    const ownership = recordsByKey.get(safeKey(definition?.key));
    const currentPoints = definition.key === GYM_TRAINING_DISCOUNT_REWARD.key
      ? safeWholeNumber(eligibleDailyStandardPoints)
      : totalPoints;
    return normalizeReward({
      ...definition,
      status: ownership ? 'owned' : 'locked',
      currentPoints,
      ownedAt: ownership?.ownedAt || null,
      celebrationSeenAt: ownership?.celebrationSeenAt || null,
    });
  });
  const items = [...ownershipItems, ...challengeCatalog.items]
    .sort((left, right) => (
      left.sortOrder - right.sortOrder || left.key.localeCompare(right.key)
    ));
  const nextUnlock = [...items]
    .filter((reward) => reward.active && reward.status === 'locked' && reward.canAccess)
    .sort((left, right) => (
      left.pointsRequired - right.pointsRequired
      || left.sortOrder - right.sortOrder
      || left.key.localeCompare(right.key)
    ))[0] || null;
  const catalog = normalizeRewardCatalog({
    schemaVersion: 1,
    catalogVersion: 2,
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

  return {
    catalog,
    ownershipRecords: [...recordsByKey.values()],
  };
}

export function backfillMockRewardEntitlements({
  progression = {},
  ownershipRecords = [],
  rewardDefinitions = DEFAULT_OWNERSHIP_REWARD_DEFINITIONS,
  eligibleDailyStandardPoints,
  now,
} = {}) {
  const timestamp = resolveTimestamp(now);
  const existingKeys = new Set(normalizeOwnershipRecords(ownershipRecords).keys());
  const backfill = buildMockRewardCatalog({
    progression,
    ownershipRecords,
    rewardDefinitions,
    eligibleDailyStandardPoints,
    now: timestamp,
  });

  return backfill.ownershipRecords.map((record) => (
    existingKeys.has(record.key)
      ? record
      : { ...record, celebrationSeenAt: timestamp }
  ));
}

export function claimMockRewardEntitlementUnlocks({
  progression = {},
  ownershipRecords = [],
  rewardDefinitions = DEFAULT_OWNERSHIP_REWARD_DEFINITIONS,
  eligibleDailyStandardPoints,
  now,
} = {}) {
  const timestamp = resolveTimestamp(now);
  const initial = buildMockRewardCatalog({
    progression,
    ownershipRecords,
    rewardDefinitions,
    eligibleDailyStandardPoints,
    now: timestamp,
  });
  const claimedKeySet = new Set(
    initial.ownershipRecords
      .filter((record) => !record.celebrationSeenAt)
      .map((record) => record.key),
  );
  const nextRecords = initial.ownershipRecords.map((record) => (
    claimedKeySet.has(record.key)
      ? { ...record, celebrationSeenAt: timestamp }
      : record
  ));
  const next = buildMockRewardCatalog({
    progression,
    ownershipRecords: nextRecords,
    rewardDefinitions,
    eligibleDailyStandardPoints,
    now: timestamp,
  });

  return {
    claimedUnlocks: initial.catalog.items.filter((reward) => claimedKeySet.has(reward.key)),
    catalog: next.catalog,
    ownershipRecords: next.ownershipRecords,
  };
}
