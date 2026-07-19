import {
  getBillingState,
  getDailyStandardDraft,
  getDashboard,
  hasSupabaseAuth,
  isLocalDemoMode,
  mutateDailyStandardDraft,
  redirectToLogin,
} from './api';
import { calendarDayDifference, dateKeyForTimeZone } from './check-in.mjs';
import { normalizeDailyStandardDraft } from './daily-standard-draft.mjs';
import { dailyStandardRoute } from './daily-standard-routes.mjs';
import {
  PREVIEW_CHALLENGE_STORAGE_KEY,
  isPreviewChallengeActive,
  isPreviewChallengeComplete,
  normalizePreviewChallengeState,
  previewChallengeDate,
} from './preview-challenge.mjs';

const ENTRY_STORAGE_KEY = 'dominion:entries';
const WORKOUT_DIFFICULTY_STORAGE_KEY = 'dominion:workoutDifficulty';
const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const localDemoMode = isLocalDemoMode();
const root = document.querySelector('[data-daily-standard-page]');
const action = dailyStandardRoute(root?.dataset.actionId);

let entryDate = dateKeyForTimeZone(new Date(), browserTimeZone);
let draft = normalizeDailyStandardDraft({ entry_date: entryDate });
let loading = true;
let saving = false;
let errorMessage = '';

const readJson = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
};

const writeJson = (key, value) => localStorage.setItem(key, JSON.stringify(value));

function localPreviewState() {
  return normalizePreviewChallengeState(
    readJson(PREVIEW_CHALLENGE_STORAGE_KEY, {}),
    entryDate,
  );
}

function localEntryDate() {
  const preview = localPreviewState();
  return isPreviewChallengeActive(localDemoMode, preview)
    ? previewChallengeDate(preview)
    : dateKeyForTimeZone(new Date(), browserTimeZone);
}

function localDateWasSubmitted(date) {
  const candidates = [
    readJson('dominion:checkInDates', {}),
    readJson('dominion:previewCheckInDates', {}),
  ];
  return candidates.some((value) => {
    if (Array.isArray(value)) return value.includes(date);
    if (Array.isArray(value?.dates) && value.dates.includes(date)) return true;
    return Object.values(value || {}).some((nested) => Array.isArray(nested?.dates) && nested.dates.includes(date));
  });
}

function readLocalDraft() {
  entryDate = localEntryDate();
  const preview = localPreviewState();
  const challengeStart = readJson('dominion:startDate', entryDate);
  const challengeDay = calendarDayDifference(entryDate, challengeStart) + 1;
  const challengeFinished = challengeDay < 1 || challengeDay > 77;
  const entry = readJson(ENTRY_STORAGE_KEY, []).find((item) => item.date === entryDate) || {};
  return normalizeDailyStandardDraft({
    ...entry,
    entry_date: entryDate,
    workoutDifficulty: entry.workoutDifficulty || readJson(WORKOUT_DIFFICULTY_STORAGE_KEY, {}),
    submitted: localDateWasSubmitted(entryDate),
    locked: localDateWasSubmitted(entryDate) || isPreviewChallengeComplete(preview) || challengeFinished,
  });
}

function writeLocalDraft(nextDraft) {
  const entries = readJson(ENTRY_STORAGE_KEY, []);
  const index = entries.findIndex((item) => item.date === nextDraft.date);
  if (index >= 0) entries[index] = nextDraft;
  else entries.push(nextDraft);
  writeJson(ENTRY_STORAGE_KEY, entries);
  writeJson(WORKOUT_DIFFICULTY_STORAGE_KEY, nextDraft.workoutDifficulty);
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function render() {
  if (!root || !action) return;
  const isComplete = draft.completed.includes(action.id);
  const isLocked = draft.locked || draft.submitted;
  const button = document.getElementById('actionCompletionToggle');
  const status = document.getElementById('actionPageStatus');
  const handoff = document.getElementById('actionCheckInHandoff');

  setText('actionPageDate', new Intl.DateTimeFormat(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(`${entryDate}T12:00:00Z`)));
  setText('actionProgressCount', `${draft.completed.length} of 7 complete`);
  setText('actionCompletionLabel', isComplete ? `Mark ${action.title} incomplete` : `Mark ${action.title} complete`);

  if (button) {
    button.disabled = loading || saving || isLocked;
    button.classList.toggle('completed', isComplete);
    button.setAttribute('aria-pressed', String(isComplete));
    button.setAttribute('aria-label', isComplete ? `Mark ${action.title} incomplete` : `Mark ${action.title} complete`);
  }
  if (status) {
    status.classList.toggle('is-error', Boolean(errorMessage));
    status.textContent = errorMessage
      || (loading ? 'Loading today’s action…'
        : saving ? 'Saving your change…'
          : isLocked ? 'This day is finalized. Completion can no longer be changed.'
            : isComplete ? `${action.title} is complete for today.`
              : 'Ready when you are. This page never submits your Check-In.');
  }
  if (handoff) handoff.hidden = draft.completed.length !== 7;
  root.toggleAttribute('aria-busy', loading || saving);
}

async function hydrate() {
  loading = true;
  errorMessage = '';
  render();
  try {
    if (hasSupabaseAuth()) {
      const dashboard = await getDashboard();
      const timeZone = dashboard?.profile?.timeZone || browserTimeZone;
      entryDate = dateKeyForTimeZone(new Date(), timeZone);
      draft = await getDailyStandardDraft(entryDate);
    } else {
      draft = readLocalDraft();
    }
  } catch (error) {
    errorMessage = error?.message || 'Unable to load today’s action.';
  } finally {
    loading = false;
    render();
  }
}

async function toggleCompletion() {
  if (loading || saving || draft.locked || draft.submitted) return;
  const nextCompleted = !draft.completed.includes(action.id);
  const previousDraft = draft;
  const completed = new Set(draft.completed);
  if (nextCompleted) completed.add(action.id);
  else completed.delete(action.id);
  draft = normalizeDailyStandardDraft({ ...draft, completed: [...completed], version: draft.version + 1 });
  saving = true;
  errorMessage = '';
  render();

  try {
    if (hasSupabaseAuth()) {
      draft = await mutateDailyStandardDraft({
        date: entryDate,
        actionId: action.id,
        completed: nextCompleted,
        expectedVersion: previousDraft.version,
      });
    } else {
      writeLocalDraft(draft);
    }
  } catch (error) {
    draft = previousDraft;
    errorMessage = error?.message || 'That change could not be saved. Try again.';
    if (hasSupabaseAuth()) {
      try { draft = await getDailyStandardDraft(entryDate); } catch { /* keep recoverable local state */ }
    }
  } finally {
    saving = false;
    render();
  }
}

async function boot() {
  if (!root || !action) {
    window.location.replace('./dashboard.html#daily-standards');
    return;
  }
  const billing = await getBillingState();
  if (!billing.authenticated) {
    redirectToLogin();
    return;
  }
  if (!billing.appAccess) {
    window.location.href = './billing.html?intent=subscription';
    return;
  }
  document.getElementById('actionCompletionToggle')?.addEventListener('click', toggleCompletion);
  window.addEventListener('focus', () => { if (!document.hidden) hydrate(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) hydrate(); });
  window.addEventListener('storage', (event) => {
    if (!hasSupabaseAuth() && [ENTRY_STORAGE_KEY, 'dominion:checkInDates', 'dominion:previewCheckInDates'].includes(event.key)) hydrate();
  });
  await hydrate();
}

boot().catch((error) => {
  loading = false;
  errorMessage = error?.message || 'Unable to open this action.';
  render();
});
