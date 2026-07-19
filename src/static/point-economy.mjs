export const DAILY_STANDARD_COUNT = 7;
export const POINTS_PER_DAILY_STANDARD = 1;
export const MAX_DAILY_STANDARD_POINTS = DAILY_STANDARD_COUNT * POINTS_PER_DAILY_STANDARD;
export const DEFAULT_CHALLENGE_DURATION_DAYS = 77;
export const PERFECT_CHALLENGE_POINTS = MAX_DAILY_STANDARD_POINTS * DEFAULT_CHALLENGE_DURATION_DAYS;
export const SHARING_BONUS_POINTS = 14;
export const LOWEST_REWARD_THRESHOLD = 500;

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
  const invalid = normalized.filter((reward) => (
    !reward.key || reward.pointsRequired < LOWEST_REWARD_THRESHOLD
  ));

  return {
    valid: invalid.length === 0,
    invalid,
    rewards: normalized,
  };
}
