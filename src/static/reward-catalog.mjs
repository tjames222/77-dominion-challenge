import { REWARD_POINT_THRESHOLDS } from './point-economy.mjs';
import { isInstanceDate, normalizeChallengeInstance } from './challenge-instance-contract.mjs';
// Shared pure validation; the preview grant reducer is loaded only on demand.
export { ownDataRecord, validTimestamp, resolveTimestamp, safeKey };

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
const validTimestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && isInstanceDate(value.slice(0, 10)) && Number(value.slice(11, 13)) <= 23
  && Number(value.slice(14, 16)) <= 59 && Number(value.slice(17, 19)) <= 59 && Number.isFinite(Date.parse(value));
const ownDataRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Reflect.ownKeys(value).every(key => typeof key === 'string' && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));

export function normalizeReward(reward = {}) {
  const stateModel = STATE_MODELS.has(reward.stateModel || reward.state_model)
    ? reward.stateModel || reward.state_model
    : 'ownership';
  const validStates = stateModel === 'challenge_lifecycle' ? CHALLENGE_STATES : OWNERSHIP_STATES;
  const status = validStates.has(reward.status) ? reward.status : 'locked';
  const rawRequirement = reward.requirement || reward.unlockRule;
  const completionBased = rawRequirement?.type === 'challenge_completion';
  const currentPoints = completionBased ? null : safeWholeNumber(rawRequirement?.currentPoints ?? reward.currentPoints ?? reward.current_points);
  const pointsRequired = completionBased ? null : safeWholeNumber(rawRequirement?.pointsRequired ?? reward.pointsRequired ?? reward.points_required);
  const unlocked = status !== 'locked';
  const pointsRemaining = completionBased ? null : unlocked
    ? 0
    : safeWholeNumber(
      reward.pointsRemaining ?? reward.points_remaining,
      Math.max(pointsRequired - currentPoints, 0),
    );
  const progressPercent = completionBased ? null : unlocked
    ? 100
    : safePercent(
      reward.progressPercent ?? reward.progress_percent
        ?? (pointsRequired ? currentPoints / pointsRequired * 100 : 100),
    );
  const requestedActions = Array.isArray(reward.allowedActions || reward.allowed_actions)
    ? [...new Set(reward.allowedActions || reward.allowed_actions)].filter((action) => typeof action === 'string')
    : [];
  const canAccess = reward.canAccess ?? reward.can_access ?? true;
  const allowedActions = stateModel === 'challenge_lifecycle' && ['available', 'completed'].includes(status) && canAccess
    ? requestedActions.filter(action => action === 'start')
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
    requirement: completionBased ? {
      type: 'challenge_completion', prerequisiteChallengeKey: safeKey(rawRequirement.prerequisiteChallengeKey),
      prerequisiteTitle: String(rawRequirement.prerequisiteTitle || reward.prerequisiteTitle || ''),
      requiredState: 'completed', satisfied: rawRequirement.satisfied === true,
    } : { type: rawRequirement?.type === 'trusted_points' ? 'trusted_points' : 'lifetime_points',
      pointsRequired, currentPoints, pointsRemaining, progressPercent },
    unlockRule: completionBased ? { type: 'challenge_completion', prerequisiteChallengeKey: safeKey(rawRequirement.prerequisiteChallengeKey), requiredState: 'completed' }
      : { type: rawRequirement?.type === 'trusted_points' ? 'trusted_points' : 'lifetime_points', pointsRequired },
    phase: reward.phase === 'post_core' ? 'post_core' : 'core',
    released: reward.released !== false,
    targetSubmittedCheckIns: reward.targetSubmittedCheckIns ?? reward.metadata?.durationDays ?? null,
    grantCatalogVersion: reward.grantCatalogVersion ?? null,
    grantReason: reward.grantReason ?? null,
    grantProvenance: reward.grantProvenance && typeof reward.grantProvenance === 'object' ? { ...reward.grantProvenance } : null,
    blockedReason: reward.blockedReason ?? null,
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
    celebrationSourceType: reward.celebrationSourceType || '',
    celebrationMilestonePoints: reward.celebrationMilestonePoints ?? null,
  };
}

export function normalizeRewardCatalog(payload = {}, { preview = false } = {}) {
  const isV2 = payload.schemaVersion === 2;
  if (isV2 && (typeof payload.actorId !== 'string' || !payload.actorId
    || !Number.isSafeInteger(payload.catalogVersion) || payload.catalogVersion < 1
    || !Number.isSafeInteger(payload.revision) || payload.revision < 0
    || typeof payload.snapshotVersion !== 'string' || !/^[a-f0-9]{64}$/.test(payload.snapshotVersion)
    || !validTimestamp(payload.effectiveAt) || !Number.isSafeInteger(payload.totalPoints) || payload.totalPoints < 0
    || (payload.currentInstance !== null && !normalizeChallengeInstance(payload.currentInstance, { preview }))
    || !payload.originalRepeat || payload.originalRepeat.challengeKey !== 'original_77'
    || payload.originalRepeat.targetCount !== 77 || typeof payload.originalRepeat.available !== 'boolean'
    || typeof payload.originalRepeat.canStart !== 'boolean'
    || !(payload.originalRepeat.reason === null || typeof payload.originalRepeat.reason === 'string')
    || (payload.originalRepeat.canStart && (!payload.originalRepeat.available || payload.currentInstance?.status !== 'completed'
      || payload.currentInstance.reviewRequired || payload.originalRepeat.reason !== null)))) {
    throw new Error('Reward progress could not be verified. Refresh and try again.');
  }
  if (isV2) {
    for (const reward of [...(Array.isArray(payload.items) ? payload.items : []), ...(payload.nextUnlock ? [payload.nextUnlock] : [])]) {
      // A key-only nextUnlock is resolved from this page; full off-page nodes
      // must carry the same discriminated requirement as every catalog item.
      if (Object.keys(reward).length === 1 && reward.key) continue;
      const requirement = reward.requirement;
      if (!ownDataRecord(reward) || !ownDataRecord(requirement) || !/^[a-z0-9][a-z0-9_.:-]{0,99}$/.test(reward.key)
        || !STATE_MODELS.has(reward.stateModel) || !(reward.stateModel === 'ownership' ? OWNERSHIP_STATES : CHALLENGE_STATES).has(reward.status)
        || typeof reward.active !== 'boolean' || typeof reward.released !== 'boolean' || typeof reward.canAccess !== 'boolean'
        || !Array.isArray(reward.allowedActions) || reward.allowedActions.some(action => action !== 'start')
        || (reward.allowedActions.length > 0 && (reward.stateModel !== 'challenge_lifecycle' || !['available', 'completed'].includes(reward.status)
          || !reward.active || !reward.released || !reward.canAccess || payload.currentInstance?.status !== 'completed' || payload.currentInstance.reviewRequired))
        || !['trusted_points', 'lifetime_points', 'challenge_completion'].includes(requirement.type)
        || (requirement.type === 'challenge_completion'
          ? (!safeKey(requirement.prerequisiteChallengeKey) || requirement.requiredState !== 'completed' || typeof requirement.satisfied !== 'boolean'
            || ['pointsRequired', 'currentPoints', 'pointsRemaining', 'progressPercent'].some(key => reward[key] !== null))
          : (!['pointsRequired', 'currentPoints', 'pointsRemaining'].every(key => Number.isSafeInteger(requirement[key]) && requirement[key] >= 0)
            || requirement.pointsRequired < 1 || !Number.isFinite(requirement.progressPercent) || requirement.progressPercent < 0 || requirement.progressPercent > 100
            || ['pointsRequired', 'currentPoints', 'pointsRemaining', 'progressPercent'].some(key => requirement[key] !== reward[key])))) {
        throw new Error('Reward requirements could not be verified. Refresh and try again.');
      }
    }
  }
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
    ...(isV2 ? { actorId: payload.actorId, effectiveAt: payload.effectiveAt, revision: payload.revision,
      snapshotVersion: payload.snapshotVersion, currentInstance: payload.currentInstance === null ? null : normalizeChallengeInstance(payload.currentInstance, { preview }),
      originalRepeat: Object.freeze({ ...payload.originalRepeat }) } : {}),
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
    // Ownership/unlock thresholds remain intact; later-instance execution is
    // not implemented by the original-challenge completion release.
    allowedActions: challenge.allowedActions || [],
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
      celebrationSourceType: record.celebrationSourceType || '',
      celebrationMilestonePoints: record.celebrationMilestonePoints ?? null,
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
        celebrationSourceType: 'point_threshold',
        celebrationMilestonePoints: definition.pointsRequired,
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
      celebrationSourceType: ownership?.celebrationSourceType || '',
      celebrationMilestonePoints: ownership?.celebrationMilestonePoints ?? null,
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
