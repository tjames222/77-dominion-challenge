import progressionCatalog from './reward-progression-catalog.v2.json' with { type: 'json' };

export const DAILY_STANDARD_COUNT = 7;
export const POINTS_PER_DAILY_STANDARD = 1;
export const MAX_DAILY_STANDARD_POINTS = DAILY_STANDARD_COUNT * POINTS_PER_DAILY_STANDARD;
export const DEFAULT_CHALLENGE_DURATION_DAYS = 77;
export const PERFECT_CHALLENGE_POINTS = MAX_DAILY_STANDARD_POINTS * DEFAULT_CHALLENGE_DURATION_DAYS;
export const SHARING_BONUS_POINTS = 14;
export const POINTS_PER_LEVEL = 14;
// This projection is for scoring simulations and display only. Grants are
// persisted by the server (or the isolated preview transaction), never pages.
export const REWARD_POINT_THRESHOLDS = Object.freeze(Object.fromEntries(
  progressionCatalog.rewards.filter(reward => reward.active && reward.phase === 'core'
    && ['trusted_points', 'lifetime_points'].includes(reward.unlockRule.type))
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map(reward => [reward.key, reward.unlockRule.pointsRequired]),
));
export const REWARD_CURVE = Object.freeze(Object.entries(REWARD_POINT_THRESHOLDS).map(
  ([key, pointsRequired], sortOrder) => Object.freeze({ key, pointsRequired, sortOrder }),
));
export const LOWEST_REWARD_THRESHOLD = REWARD_POINT_THRESHOLDS.gym_training_discount;

export const POINT_SOURCE_POLICY = Object.freeze({
  daily_standard: Object.freeze({
    points: POINTS_PER_DAILY_STANDARD,
    frequency: 'per_completed_standard',
    lifetime: true,
    dailyStandardsCap: true,
  }),
  sharing_bonus: Object.freeze({
    points: SHARING_BONUS_POINTS,
    frequency: 'once_per_user',
    lifetime: true,
    dailyStandardsCap: false,
  }),
  app_visit: Object.freeze({
    points: 0,
    frequency: 'tracked_without_points',
    lifetime: false,
    dailyStandardsCap: false,
  }),
  app_streak_milestone: Object.freeze({
    points: 0,
    frequency: 'badge_only',
    lifetime: false,
    dailyStandardsCap: false,
  }),
  full_standard_streak_milestone: Object.freeze({
    points: 0,
    frequency: 'badge_only',
    lifetime: false,
    dailyStandardsCap: false,
  }),
  workout_difficulty: Object.freeze({
    points: 0,
    frequency: 'descriptive_only',
    lifetime: false,
    dailyStandardsCap: false,
  }),
});

const safeWholeNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
};

export function calculateDailyStandardsPoints(completedCount) {
  return Math.min(safeWholeNumber(completedCount), DAILY_STANDARD_COUNT) * POINTS_PER_DAILY_STANDARD;
}

export function calculateLevelProgress(rawTotalPoints) {
  const totalPoints = safeWholeNumber(rawTotalPoints);
  const level = Math.floor(totalPoints / POINTS_PER_LEVEL) + 1;
  const pointsIntoLevel = totalPoints % POINTS_PER_LEVEL;
  const pointsToNext = POINTS_PER_LEVEL - pointsIntoLevel;

  return {
    totalPoints,
    level,
    nextLevel: level + 1,
    pointsIntoLevel,
    pointsToNext,
    progressPercent: pointsIntoLevel / POINTS_PER_LEVEL * 100,
  };
}

export function calculateLifetimePoints({
  completedStandards = 0,
  sharingBonusGranted = false,
  adjustmentPoints = 0,
} = {}) {
  const dailyStandardsPoints = safeWholeNumber(completedStandards) * POINTS_PER_DAILY_STANDARD;
  const sharingBonusPoints = sharingBonusGranted ? SHARING_BONUS_POINTS : 0;
  const normalizedAdjustment = Number.isInteger(adjustmentPoints) ? adjustmentPoints : 0;

  return {
    totalPoints: Math.max(0, dailyStandardsPoints + sharingBonusPoints + normalizedAdjustment),
    dailyStandardsPoints,
    sharingBonusPoints,
    adjustmentPoints: normalizedAdjustment,
  };
}
export function challengeInstancesRequired(pointsRequired, {
  durationDays = DEFAULT_CHALLENGE_DURATION_DAYS,
  standardsPerDay = DAILY_STANDARD_COUNT,
} = {}) {
  const target = safeWholeNumber(pointsRequired);
  if (target === 0) return 0;
  const pointsPerInstance = safeWholeNumber(durationDays) * Math.min(
    safeWholeNumber(standardsPerDay),
    DAILY_STANDARD_COUNT,
  ) * POINTS_PER_DAILY_STANDARD;
  if (pointsPerInstance === 0) return Infinity;
  return Math.ceil(target / pointsPerInstance);
}

export function validateRewardThresholds(rewards = []) {
  const normalized = rewards
    .filter((reward) => reward?.active !== false)
    .map((reward) => ({
      key: String(reward?.key || '').trim(),
      pointsRequired: safeWholeNumber(reward?.pointsRequired ?? reward?.points_required),
    }));
  const invalid = normalized.filter((reward, index) => (
    !reward.key
    || reward.pointsRequired < LOWEST_REWARD_THRESHOLD
    || (index > 0 && reward.pointsRequired <= normalized[index - 1].pointsRequired)
  ));

  return {
    valid: invalid.length === 0,
    invalid,
    rewards: normalized,
  };
}
