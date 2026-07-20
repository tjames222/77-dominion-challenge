import { currentFullDayStreakForDate } from './check-in.mjs';

export const STREAK_METRIC_DEFINITIONS = Object.freeze([
  Object.freeze({ key: 'currentFullStandardStreak', label: 'Full standard streak', kind: 'Current' }),
  Object.freeze({ key: 'bestFullStandardStreak', label: 'Best full standard streak', kind: 'Personal best' }),
  Object.freeze({ key: 'currentAppStreak', label: 'App streak', kind: 'Current' }),
  Object.freeze({ key: 'bestAppStreak', label: 'Best app streak', kind: 'Personal best' }),
]);

export function normalizeStreakValue(value) {
  if (
    value === null
    || typeof value === 'boolean'
    || Array.isArray(value)
    || (typeof value === 'string' && value.trim() === '')
  ) return 0;
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? Math.max(0, Math.floor(numericValue)) : 0;
}

export function preserveBestStreaks(nextStats = {}, previousStats = {}) {
  const currentAppStreak = normalizeStreakValue(nextStats.currentAppStreak);
  const currentFullDayStreak = normalizeStreakValue(nextStats.currentFullDayStreak);

  return {
    ...nextStats,
    currentAppStreak,
    bestAppStreak: Math.max(
      currentAppStreak,
      normalizeStreakValue(nextStats.bestAppStreak),
      normalizeStreakValue(previousStats.bestAppStreak),
    ),
    currentFullDayStreak,
    bestFullDayStreak: Math.max(
      currentFullDayStreak,
      normalizeStreakValue(nextStats.bestFullDayStreak),
      normalizeStreakValue(previousStats.bestFullDayStreak),
    ),
  };
}

export function buildStreakSummary(stats = {}, currentDateKey) {
  const normalized = preserveBestStreaks(stats);
  const currentFullStandardStreak = currentFullDayStreakForDate(normalized, currentDateKey);
  const summary = {
    currentFullStandardStreak,
    bestFullStandardStreak: Math.max(
      currentFullStandardStreak,
      normalizeStreakValue(normalized.bestFullDayStreak),
    ),
    currentAppStreak: normalized.currentAppStreak,
    bestAppStreak: normalized.bestAppStreak,
  };

  return {
    ...summary,
    hasHistory: Object.values(summary).some((value) => value > 0),
  };
}

export function dayUnit(value) {
  return normalizeStreakValue(value) === 1 ? 'day' : 'days';
}

export function streakIndicatorLabel(summary = {}) {
  const value = normalizeStreakValue(summary.currentAppStreak);
  return `App streak: ${value} ${dayUnit(value)}. View streak details.`;
}

export function streakMetrics(summary = {}) {
  return STREAK_METRIC_DEFINITIONS.map((definition) => {
    const value = normalizeStreakValue(summary[definition.key]);
    return { ...definition, value, unit: dayUnit(value) };
  });
}
