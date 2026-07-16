const VALID_CHALLENGE_STATES = new Set(['available', 'active', 'completed']);

export const DEFAULT_CHALLENGE_DEFINITIONS = Object.freeze([
  {
    key: 'seven_day_reset',
    title: '7-Day Reset',
    teaser: 'A focused week to rebuild rhythm and recover momentum.',
    type: 'reset',
    pointsRequired: 500,
    durationDays: 7,
    icon: 'repeat',
    sortOrder: 10,
  },
  {
    key: 'twenty_one_day_prayer',
    title: '21-Day Prayer Track',
    teaser: 'Deepen the daily prayer habit with a guided three-week track.',
    type: 'spiritual',
    pointsRequired: 1500,
    durationDays: 21,
    icon: 'spark',
    sortOrder: 20,
  },
  {
    key: 'thirty_day_strength',
    title: '30-Day Strength Intensive',
    teaser: 'Turn consistency into a focused month of physical training.',
    type: 'physical',
    pointsRequired: 2250,
    durationDays: 30,
    icon: 'dumbbell',
    sortOrder: 30,
  },
  {
    key: 'forty_day_fast',
    title: '40-Day Fasting & Prayer Track',
    teaser: 'Build a guided rhythm of fasting, prayer, and disciplined reflection.',
    type: 'fasting',
    pointsRequired: 3000,
    durationDays: 40,
    icon: 'flame',
    sortOrder: 40,
  },
  {
    key: 'bible_in_a_year',
    title: 'Bible in a Year',
    teaser: 'Carry the reading discipline into a complete yearlong plan.',
    type: 'bible',
    pointsRequired: 5000,
    durationDays: 365,
    icon: 'book',
    sortOrder: 50,
  },
]);

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
    pointsRequired: safePoints(definition.pointsRequired ?? definition.points_required),
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
} = {}) {
  const points = safePoints(totalPoints);
  const normalizedDefinitions = definitions
    .map(normalizeDefinition)
    .filter((definition) => definition.key && definition.active)
    .sort((left, right) => left.pointsRequired - right.pointsRequired || left.sortOrder - right.sortOrder);
  const recordsByKey = new Map(
    records
      .map(normalizeRecord)
      .filter((record) => record.key)
      .map((record) => [record.key, record]),
  );
  const newlyUnlockedKeys = new Set();

  normalizedDefinitions.forEach((definition) => {
    if (!allowClientUnlocks || !definition.accessGranted || recordsByKey.has(definition.key) || points < definition.pointsRequired) return;
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
    const pointsRemaining = status === 'locked' ? Math.max(definition.pointsRequired - points, 0) : 0;
    const progressPercent = definition.pointsRequired > 0
      ? Math.min((points / definition.pointsRequired) * 100, 100)
      : 100;
    return {
      ...definition,
      status,
      pointsRemaining,
      progressPercent,
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
