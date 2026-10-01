import progressionCatalog from './reward-progression-catalog.v2.json' with { type: 'json' };

const VALID_CHALLENGE_STATES = new Set(['available', 'active', 'completed']);

export const DEFAULT_CHALLENGE_DEFINITIONS = Object.freeze(progressionCatalog.rewards
  .filter(reward => reward.stateModel === 'challenge_lifecycle')
  .map(reward => Object.freeze({ ...reward, type: 'challenge', teaser: reward.title,
    durationDays: reward.targetSubmittedCheckIns, pointsRequired: reward.unlockRule.pointsRequired ?? null,
    icon: 'repeat', unlockRule: Object.freeze({ ...reward.unlockRule }) })));

const safePoints = (value) => {
  const points = Number(value);
  return Number.isFinite(points) ? Math.max(0, Math.floor(points)) : 0;
};

const safeTimestamp = (value) => value || null;

const normalizeDefinition = (definition = {}) => {
  const entitlementProperty = ['entitlementKey', 'entitlement_key', 'requiredEntitlementKey', 'required_entitlement_key']
    .find((property) => Object.prototype.hasOwnProperty.call(definition, property));
  return {
    key: String(definition.key || definition.challengeKey || definition.challenge_key || '').trim(),
    title: definition.title || 'New Challenge',
    teaser: definition.teaser || definition.description || '',
    type: definition.type || definition.challengeType || definition.challenge_type || 'general',
    pointsRequired: definition.unlockRule?.type === 'challenge_completion' ? null : safePoints(definition.pointsRequired ?? definition.points_required),
    unlockRule: definition.unlockRule || { type: 'lifetime_points', pointsRequired: safePoints(definition.pointsRequired ?? definition.points_required) },
    phase: definition.phase || 'core',
    durationDays: definition.durationDays ?? definition.duration_days ?? null,
    entitlementKey: entitlementProperty ? definition[entitlementProperty] : 'membership_active',
    icon: String(definition.icon || 'target').replace(/[^a-z-]/g, '') || 'target',
    sortOrder: Number(definition.sortOrder ?? definition.sort_order) || 0,
    metadata: definition.metadata || {},
    active: definition.active ?? definition.isActive ?? definition.is_active ?? true,
    accessGranted: definition.accessGranted ?? definition.access_granted ?? definition.canAccess ?? definition.can_access ?? true,
    accessReason: definition.accessReason || definition.access_reason || definition.lockReason || definition.lock_reason || '',
  };
};

const normalizeRecord = (record = {}) => {
  const status = VALID_CHALLENGE_STATES.has(record.status) ? record.status : 'available';
  return {
    key: String(record.key || record.challengeKey || record.challenge_key || '').trim(),
    status,
    unlockPoints: safePoints(record.unlockPoints ?? record.unlock_points),
    unlockedAt: safeTimestamp(record.unlockedAt || record.unlocked_at),
    startedAt: safeTimestamp(record.startedAt || record.started_at),
    completedAt: safeTimestamp(record.completedAt || record.completed_at),
    celebrationSeenAt: safeTimestamp(record.celebrationSeenAt || record.celebration_seen_at),
  };
};

export function buildChallengeProgression({
  definitions = DEFAULT_CHALLENGE_DEFINITIONS,
  records = [],
  totalPoints = 0,
  now = new Date().toISOString(),
  allowClientUnlocks = true,
  completedChallengeKeys = [],
} = {}) {
  const points = safePoints(totalPoints);
  const normalizedDefinitions = definitions
    .map(normalizeDefinition)
    .filter((definition) => definition.key && definition.active)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.key.localeCompare(right.key));
  const recordsByKey = new Map(
    records
      .map(normalizeRecord)
      .filter((record) => record.key)
      .map((record) => [record.key, record]),
  );
  const newlyUnlockedKeys = new Set();

  normalizedDefinitions.forEach((definition) => {
    const eligible = definition.unlockRule.type === 'challenge_completion'
      ? completedChallengeKeys.includes(definition.unlockRule.prerequisiteChallengeKey)
      : points >= definition.pointsRequired;
    if (!allowClientUnlocks || !definition.accessGranted || recordsByKey.has(definition.key) || !eligible) return;
    recordsByKey.set(definition.key, {
      key: definition.key,
      status: 'available',
      unlockPoints: definition.pointsRequired,
      unlockedAt: now,
      startedAt: null,
      completedAt: null,
      celebrationSeenAt: null,
    });
    newlyUnlockedKeys.add(definition.key);
  });

  const challenges = normalizedDefinitions.map((definition) => {
    const record = recordsByKey.get(definition.key) || null;
    const status = record?.status || 'locked';
    const completionBased = definition.unlockRule.type === 'challenge_completion';
    const pointsRemaining = completionBased ? null : status === 'locked' ? Math.max(definition.pointsRequired - points, 0) : 0;
    const progressPercent = completionBased ? null : status !== 'locked' || definition.pointsRequired === 0
      ? 100
      : Math.min((points / definition.pointsRequired) * 100, 100);
    return {
      ...definition,
      status,
      pointsRemaining,
      progressPercent,
      requirement: completionBased ? { ...definition.unlockRule, satisfied: completedChallengeKeys.includes(definition.unlockRule.prerequisiteChallengeKey) }
        : { ...definition.unlockRule, currentPoints: points, pointsRemaining, progressPercent },
      unlockPoints: record?.unlockPoints ?? null,
      unlockedAt: record?.unlockedAt || null,
      startedAt: record?.startedAt || null,
      completedAt: record?.completedAt || null,
      celebrationSeenAt: record?.celebrationSeenAt || null,
    };
  });
  const nextUnlock = challenges.find((challenge) => challenge.status === 'locked' && challenge.accessGranted) || null;
  const unseenUnlocks = challenges.filter((challenge) => challenge.status !== 'locked' && !challenge.celebrationSeenAt);
  const newlyUnlocked = challenges.filter((challenge) => newlyUnlockedKeys.has(challenge.key));

  return {
    totalPoints: points,
    challenges,
    nextUnlock,
    unseenUnlocks,
    newlyUnlocked,
    records: [...recordsByKey.values()],
  };
}

export function migrateChallengeUnlockRecords({
  previousDefinitions = [],
  records = [],
  totalPoints = 0,
  now = new Date().toISOString(),
} = {}) {
  const persistedKeys = new Set(records.map((record) => (
    String(record?.key || record?.challengeKey || record?.challenge_key || '').trim()
  )).filter(Boolean));
  const previousProgression = buildChallengeProgression({
    definitions: previousDefinitions,
    records,
    totalPoints,
    now,
  });

  return previousProgression.records.map((record) => (
    persistedKeys.has(record.key) ? record : acknowledgeChallengeRecord(record, now)
  ));
}

export function normalizeChallengeProgression(payload = {}) {
  const challenges = Array.isArray(payload?.challenges) ? payload.challenges : [];
  return buildChallengeProgression({
    totalPoints: payload?.totalPoints ?? payload?.total_points ?? 0,
    definitions: challenges,
    records: challenges.filter((challenge) => VALID_CHALLENGE_STATES.has(challenge.status)),
    allowClientUnlocks: false,
  });
}

export function transitionChallengeRecord(record, targetStatus, now = new Date().toISOString()) {
  const current = normalizeRecord(record);
  if (!current.key) throw new Error('An unlocked challenge is required.');

  if (current.status === 'available' && targetStatus === 'active') {
    return { ...current, status: 'active', startedAt: current.startedAt || now };
  }
  if (current.status === 'active' && targetStatus === 'completed') {
    return { ...current, status: 'completed', completedAt: current.completedAt || now };
  }
  throw new Error(`Challenge cannot move from ${current.status} to ${targetStatus}.`);
}

export function acknowledgeChallengeRecord(record, now = new Date().toISOString()) {
  const current = normalizeRecord(record);
  if (!current.key) throw new Error('An unlocked challenge is required.');
  return { ...current, celebrationSeenAt: current.celebrationSeenAt || now };
}
