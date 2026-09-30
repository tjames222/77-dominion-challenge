import { MAX_ORIGINAL_CALENDAR_DAY, original77DateNumber } from './original-77-progress.mjs';

export const PREVIEW_CHALLENGE_STORAGE_KEY = 'dominion:previewChallengeSimulation';
export const PREVIEW_CHECK_IN_DATES_STORAGE_KEY = 'dominion:previewCheckInDates';
export const PREVIEW_TOTAL_DAYS = 77;
export const PREVIEW_COMPLETE_DAY = PREVIEW_TOTAL_DAYS + 1;

function validDateKey(value) {
  return original77DateNumber(value) !== null;
}

export function addPreviewCalendarDays(dateKey, days) {
  if (!validDateKey(dateKey)) throw new TypeError('A valid YYYY-MM-DD preview anchor is required.');
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + Math.trunc(Number(days) || 0));
  return date.toISOString().slice(0, 10);
}

export function normalizePreviewChallengeState(value = {}, fallbackDate) {
  const fallbackAnchor = validDateKey(fallbackDate) ? fallbackDate : '2026-01-01';
  const numericDay = Math.floor(Number(value?.day));
  const anchorDate = validDateKey(value?.anchorDate) ? value.anchorDate : fallbackAnchor;
  const maximumDay = original77DateNumber('9999-12-31') - original77DateNumber(anchorDate) + 1;
  return {
    enabled: value?.enabled === true,
    anchorDate,
    day: Number.isFinite(numericDay)
      ? Math.min(Math.max(numericDay, 1), maximumDay, MAX_ORIGINAL_CALENDAR_DAY)
      : 1,
  };
}

export function isPreviewChallengeActive(isLocalPreview, state) {
  return Boolean(isLocalPreview && normalizePreviewChallengeState(state, state?.anchorDate).enabled);
}

export function previewChallengeDay(state) {
  return normalizePreviewChallengeState(state, state?.anchorDate).day;
}

export function previewChallengeDate(state) {
  const normalized = normalizePreviewChallengeState(state, state?.anchorDate);
  return addPreviewCalendarDays(normalized.anchorDate, previewChallengeDay(normalized) - 1);
}

export function isPreviewChallengeComplete(state, progress) {
  return normalizePreviewChallengeState(state, state?.anchorDate).enabled
    && progress?.submittedCount === PREVIEW_TOTAL_DAYS
    && ['live_completed', 'historical_provenance_pending'].includes(progress.completionState);
}

export function setPreviewChallengeEnabled(state, enabled, fallbackDate) {
  return {
    ...normalizePreviewChallengeState(state, fallbackDate),
    enabled: Boolean(enabled),
  };
}

export function advancePreviewChallenge(state, progress) {
  const normalized = normalizePreviewChallengeState(state, state?.anchorDate);
  if (!normalized.enabled || isPreviewChallengeComplete(normalized, progress)) return normalized;
  return normalizePreviewChallengeState({
    ...normalized,
    day: normalized.day + 1,
  }, normalized.anchorDate);
}

export function advancePreviewStreaks(stats = {}, status = 'partial', entryDate = '') {
  const currentAppStreak = Math.max(0, Math.floor(Number(stats.currentAppStreak) || 0)) + 1;
  const previousFullDayStreak = Math.max(0, Math.floor(Number(stats.currentFullDayStreak) || 0));
  const normalizedEntryDate = validDateKey(entryDate) ? entryDate : '';
  let currentFullDayStreak = previousFullDayStreak;
  let lastFullDayDate = stats.lastFullDayDate || null;

  if (status === 'complete') {
    if (normalizedEntryDate && lastFullDayDate === normalizedEntryDate) {
      currentFullDayStreak = previousFullDayStreak;
    } else if (normalizedEntryDate && lastFullDayDate === addPreviewCalendarDays(normalizedEntryDate, -1)) {
      currentFullDayStreak = previousFullDayStreak + 1;
    } else {
      currentFullDayStreak = 1;
    }
    if (normalizedEntryDate) lastFullDayDate = normalizedEntryDate;
  }

  return {
    ...stats,
    currentAppStreak,
    bestAppStreak: Math.max(Math.floor(Number(stats.bestAppStreak) || 0), currentAppStreak),
    currentFullDayStreak,
    bestFullDayStreak: Math.max(Math.floor(Number(stats.bestFullDayStreak) || 0), currentFullDayStreak),
    lastFullDayDate,
  };
}
