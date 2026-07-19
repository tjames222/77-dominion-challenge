export const PREVIEW_CHALLENGE_STORAGE_KEY = 'dominion:previewChallengeSimulation';
export const PREVIEW_CHECK_IN_DATES_STORAGE_KEY = 'dominion:previewCheckInDates';
export const PREVIEW_TOTAL_DAYS = 77;
export const PREVIEW_COMPLETE_DAY = PREVIEW_TOTAL_DAYS + 1;
export const PREVIEW_CHALLENGE_RESET_KEYS = [
  'dominion:startDate',
  'dominion:entries',
  'dominion:checkInDates',
  PREVIEW_CHECK_IN_DATES_STORAGE_KEY,
  'dominion:feed',
  'dominion:gameStats',
  'dominion:badges',
  'dominion:mockChallengeStates',
  'dominion:mockChallengeThresholdsVersion',
  PREVIEW_CHALLENGE_STORAGE_KEY,
];

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validDateKey(value) {
  if (!DATE_KEY_PATTERN.test(String(value || ''))) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function addPreviewCalendarDays(dateKey, days) {
  if (!validDateKey(dateKey)) throw new TypeError('A valid YYYY-MM-DD preview anchor is required.');
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + Math.trunc(Number(days) || 0));
  return date.toISOString().slice(0, 10);
}

export function normalizePreviewChallengeState(value = {}, fallbackDate) {
  const fallbackAnchor = validDateKey(fallbackDate) ? fallbackDate : '2026-01-01';
  const numericDay = Math.floor(Number(value?.day));
  return {
    enabled: value?.enabled === true,
    anchorDate: validDateKey(value?.anchorDate) ? value.anchorDate : fallbackAnchor,
    day: Number.isFinite(numericDay)
      ? Math.min(Math.max(numericDay, 1), PREVIEW_COMPLETE_DAY)
      : 1,
  };
}

export function isPreviewChallengeActive(isLocalPreview, state) {
  return Boolean(isLocalPreview && normalizePreviewChallengeState(state, state?.anchorDate).enabled);
}

export function previewChallengeDay(state) {
  return Math.min(normalizePreviewChallengeState(state, state?.anchorDate).day, PREVIEW_TOTAL_DAYS);
}

export function previewChallengeDate(state) {
  const normalized = normalizePreviewChallengeState(state, state?.anchorDate);
  return addPreviewCalendarDays(normalized.anchorDate, previewChallengeDay(normalized) - 1);
}

export function isPreviewChallengeComplete(state) {
  return normalizePreviewChallengeState(state, state?.anchorDate).day > PREVIEW_TOTAL_DAYS;
}

export function setPreviewChallengeEnabled(state, enabled, fallbackDate) {
  return {
    ...normalizePreviewChallengeState(state, fallbackDate),
    enabled: Boolean(enabled),
  };
}

export function advancePreviewChallenge(state) {
  const normalized = normalizePreviewChallengeState(state, state?.anchorDate);
  if (!normalized.enabled || isPreviewChallengeComplete(normalized)) return normalized;
  return {
    ...normalized,
    day: Math.min(normalized.day + 1, PREVIEW_COMPLETE_DAY),
  };
}

export function advancePreviewStreaks(stats = {}, status = 'partial') {
  const currentAppStreak = Math.max(0, Math.floor(Number(stats.currentAppStreak) || 0)) + 1;
  const currentFullDayStreak = status === 'complete'
    ? Math.max(0, Math.floor(Number(stats.currentFullDayStreak) || 0)) + 1
    : Math.max(0, Math.floor(Number(stats.currentFullDayStreak) || 0));
  return {
    ...stats,
    currentAppStreak,
    bestAppStreak: Math.max(Math.floor(Number(stats.bestAppStreak) || 0), currentAppStreak),
    currentFullDayStreak,
    bestFullDayStreak: Math.max(Math.floor(Number(stats.bestFullDayStreak) || 0), currentFullDayStreak),
  };
}
