import {
  getBillingState,
  getDailyStandardDraft,
  getDashboard,
  hasSupabaseAuth,
  isLocalDemoMode,
  mutateDailyStandardDraft,
  redirectToLogin,
  setDailyStandardWorkoutDifficulty,
} from './api';
import { calendarDayDifference, dateKeyForTimeZone } from './check-in.mjs';
import {
  applyWorkoutDifficultyMutation,
  normalizeDailyStandardDraft,
} from './daily-standard-draft.mjs';
import {
  FALLBACK_DAILY_VERSE,
  WORSHIP_PLAYLISTS,
  loadDailyVerse,
  pickDailyForDate,
} from './daily-standard-content.mjs';
import { workoutPlanForDate } from './daily-standard-physical-content.mjs';
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
const YOUVERSION_VERSE_URL = import.meta.env.VITE_YOUVERSION_VERSE_URL || '';
const YOUVERSION_APP_URL = import.meta.env.VITE_YOUVERSION_APP_URL || 'https://www.bible.com/';
const YOUVERSION_PRAYER_URL = import.meta.env.VITE_YOUVERSION_PRAYER_URL || 'https://www.bible.com/prayer';
const APPLE_FITNESS_URL = import.meta.env.VITE_APPLE_FITNESS_URL || 'https://fitness.apple.com/';
const WALK_ALARM_URL = import.meta.env.VITE_WALK_ALARM_URL || '';

let entryDate = dateKeyForTimeZone(new Date(), browserTimeZone);
let draft = normalizeDailyStandardDraft({ entry_date: entryDate });
let loading = true;
let saving = false;
let errorMessage = '';
let renderedContentKey = '';
let interactiveReady = false;
let hydrationRequestId = 0;

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

function setExternalLink(link, href) {
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
}

function contentTemplate({ eyebrow, title, lead, steps = [], linkLabel, linkHref }) {
  const content = document.getElementById('actionPageContent');
  if (!content) return null;
  content.replaceChildren();

  const introduction = document.createElement('div');
  introduction.className = 'action-guidance-intro';
  const label = document.createElement('span');
  label.className = 'eyebrow';
  label.textContent = eyebrow;
  const heading = document.createElement('h2');
  heading.textContent = title;
  const copy = document.createElement('p');
  copy.textContent = lead;
  introduction.append(label, heading, copy);
  content.append(introduction);

  if (steps.length) {
    const list = document.createElement('ol');
    list.className = 'action-guidance-steps';
    steps.forEach((step) => {
      const item = document.createElement('li');
      item.textContent = step;
      list.append(item);
    });
    content.append(list);
  }

  if (linkLabel && linkHref) {
    const link = document.createElement('a');
    link.className = 'action-resource-link';
    link.textContent = `${linkLabel} ↗`;
    setExternalLink(link, linkHref);
    content.append(link);
  }
  return content;
}

function createHealthControl(label) {
  const wrapper = document.createElement('div');
  wrapper.className = 'action-native-control';
  const button = document.createElement('button');
  button.className = 'action-secondary-button';
  button.type = 'button';
  button.textContent = label;
  const status = document.createElement('p');
  status.className = 'action-native-status';
  status.setAttribute('role', 'status');
  status.textContent = 'Not connected. Apple Health requires a native iOS or watchOS app with HealthKit permission.';
  button.addEventListener('click', () => {
    status.textContent = 'Apple Health is unavailable in this web app. No health or step data was requested.';
  });
  wrapper.append(button, status);
  return wrapper;
}

function createWorkoutContent() {
  const content = contentTemplate({
    eyebrow: 'Today’s recommendation',
    title: action.title,
    lead: action.workoutId === 'one'
      ? 'Move with intention. The goal is discipline, not ego.'
      : 'Finish the physical standard with patience and resolve.',
    linkLabel: 'Open Apple Fitness',
    linkHref: APPLE_FITNESS_URL,
  });
  if (!content) return;

  const field = document.createElement('label');
  field.className = 'action-difficulty-field';
  const label = document.createElement('span');
  label.textContent = 'Difficulty';
  const description = document.createElement('small');
  description.id = 'actionDifficultyDescription';
  description.textContent = 'Context only · still +1';
  const select = document.createElement('select');
  select.id = 'actionWorkoutDifficulty';
  select.dataset.workout = action.workoutId;
  select.setAttribute('aria-describedby', description.id);
  ['easy', 'medium', 'hard', 'extreme'].forEach((difficulty) => {
    const option = document.createElement('option');
    option.value = difficulty;
    option.textContent = difficulty[0].toUpperCase() + difficulty.slice(1);
    select.append(option);
  });
  field.append(label, description, select);

  const recommendation = document.createElement('p');
  recommendation.id = 'actionWorkoutRecommendation';
  recommendation.className = 'action-workout-recommendation';
  content.querySelector('.action-resource-link')?.before(field, recommendation);
  content.append(createHealthControl('Connect Apple Health'));
  select.addEventListener('change', setWorkoutDifficulty);
}

function createWalkContent() {
  const content = contentTemplate({
    eyebrow: 'Intentional reset',
    title: 'Get outside and break the drift',
    lead: 'Walk with purpose. Breathe, notice what is around you, and give your mind room to reset.',
    steps: [
      'Leave the screen behind when you can.',
      'Choose a pace that lets you stay present.',
      'Return with one clear priority for the rest of the day.',
    ],
  });
  if (!content) return;

  const reminder = document.createElement(WALK_ALARM_URL ? 'a' : 'button');
  reminder.className = 'action-resource-link';
  reminder.textContent = 'Set walk alarm ↗';
  if (WALK_ALARM_URL) {
    setExternalLink(reminder, WALK_ALARM_URL);
  } else {
    reminder.type = 'button';
  }
  const reminderStatus = document.createElement('p');
  reminderStatus.className = 'action-native-status';
  reminderStatus.setAttribute('role', 'status');
  reminderStatus.textContent = WALK_ALARM_URL
    ? 'Your configured alarm handoff opens outside Dominion.'
    : 'Clock access requires a native app. Dominion can help you choose a time, but cannot create the alarm here.';
  if (!WALK_ALARM_URL) {
    reminder.addEventListener('click', () => {
      const time = window.prompt('What time should your walk alarm be?', '12:30 PM');
      if (time) reminderStatus.textContent = `Open Clock and create an alarm for ${time} labeled Dominion Walk.`;
    });
  }
  content.append(reminder, reminderStatus, createHealthControl('Connect steps'));
}

async function renderActionContent() {
  if (!action) return;
  const contentKey = `${action.id}:${entryDate}`;
  if (renderedContentKey === contentKey) return;
  renderedContentKey = contentKey;

  if (action.id === 'bible') {
    const content = contentTemplate({
      eyebrow: 'Today’s reading',
      title: 'Read 5–8 chapters',
      lead: 'Read attentively, note what stands out, and carry one truth into the rest of your day.',
      linkLabel: 'Open in YouVersion',
      linkHref: YOUVERSION_APP_URL,
    });
    const verse = document.createElement('blockquote');
    verse.className = 'action-verse';
    const verseText = document.createElement('p');
    verseText.textContent = FALLBACK_DAILY_VERSE.text;
    const citation = document.createElement('cite');
    citation.textContent = FALLBACK_DAILY_VERSE.reference;
    verse.append(verseText, citation);
    content?.querySelector('.action-resource-link')?.before(verse);
    const resolvedVerse = await loadDailyVerse(YOUVERSION_VERSE_URL);
    if (renderedContentKey !== contentKey) return;
    verseText.textContent = resolvedVerse.text;
    citation.textContent = resolvedVerse.reference;
    return;
  }

  if (action.id === 'morningPrayer') {
    contentTemplate({
      eyebrow: 'Morning practice',
      title: 'Begin before the noise',
      lead: 'Meet God before the demands of the day set your direction.',
      steps: [
        'Be still and become aware of God’s presence.',
        'Offer the day, your plans, and the people you will encounter.',
        'Ask for wisdom, courage, and a willing spirit.',
      ],
      linkLabel: 'Open guided prayer',
      linkHref: YOUVERSION_PRAYER_URL,
    });
    return;
  }

  if (action.id === 'worshipOnly') {
    const worship = pickDailyForDate(WORSHIP_PLAYLISTS, entryDate);
    contentTemplate({
      eyebrow: 'Today’s worship prompt',
      title: worship?.label || 'Worship with your full attention',
      lead: 'Choose music centered on worship. Listen without multitasking and let the words shape your attention.',
      linkLabel: 'Open today’s worship on Spotify',
      linkHref: worship?.url || 'https://open.spotify.com/search/worship',
    });
    return;
  }

  if (action.id === 'eveningPrayer') {
    contentTemplate({
      eyebrow: 'Evening practice',
      title: 'Close the day with honesty',
      lead: 'Review the day in God’s presence, receive grace, and release what you cannot carry into tomorrow.',
      steps: [
        'Give thanks for specific gifts and moments from today.',
        'Confess where you drifted and receive forgiveness.',
        'Reflect on what God may be teaching you.',
        'Entrust tomorrow, your concerns, and your rest to God.',
      ],
      linkLabel: 'Open guided prayer',
      linkHref: YOUVERSION_PRAYER_URL,
    });
    return;
  }

  if (action.workoutId) createWorkoutContent();
  else if (action.id === 'walk') createWalkContent();
}

function syncPhysicalContent() {
  if (!action?.workoutId) return;
  const difficulty = draft.workoutDifficulty[action.workoutId];
  const select = document.getElementById('actionWorkoutDifficulty');
  const recommendation = document.getElementById('actionWorkoutRecommendation');
  if (select) {
    select.value = difficulty;
    select.disabled = loading || saving || draft.locked || draft.submitted;
  }
  if (recommendation) recommendation.textContent = workoutPlanForDate(entryDate, difficulty, action.workoutId);
}

function render() {
  if (!root || !action) return;
  const isComplete = draft.completed.includes(action.id);
  const isLocked = !interactiveReady || draft.locked || draft.submitted;
  const button = document.getElementById('actionCompletionToggle');
  const status = document.getElementById('actionPageStatus');
  const handoff = document.getElementById('actionCheckInHandoff');
  const date = document.getElementById('actionPageDate');
  const backLink = root.querySelector('.back-link');

  const formattedDate = new Intl.DateTimeFormat(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(`${entryDate}T12:00:00Z`));
  setText('actionPageDate', formattedDate);
  if (date) date.dateTime = entryDate;
  if (backLink) backLink.href = `./dashboard.html?focus=${encodeURIComponent(action.id)}#standard-${encodeURIComponent(action.id)}`;
  setText('actionProgressCount', `${draft.completed.length} of 7 complete`);
  setText('actionCompletionLabel', isComplete ? `Mark ${action.title} incomplete` : `Mark ${action.title} complete`);

  if (button) {
    button.disabled = loading || saving || isLocked;
    button.classList.toggle('completed', isComplete);
    button.setAttribute('aria-pressed', String(isComplete));
    button.setAttribute('aria-label', `${isComplete ? `Mark ${action.title} incomplete` : `Mark ${action.title} complete`}, worth 1 point`);
  }
  if (status) {
    status.classList.toggle('is-error', Boolean(errorMessage));
    status.setAttribute('role', errorMessage ? 'alert' : 'status');
    status.setAttribute('aria-live', errorMessage ? 'assertive' : 'polite');
    status.textContent = errorMessage
      || (loading ? 'Loading today’s action…'
        : saving ? 'Saving your change…'
          : isLocked ? 'This day is finalized. Completion can no longer be changed.'
            : isComplete ? `${action.title} is complete for today.`
              : 'Ready when you are. This page never submits your Check-In.');
  }
  if (handoff) handoff.hidden = draft.completed.length !== 7;
  root.setAttribute('aria-busy', String(loading || saving));
  syncPhysicalContent();
}

async function setWorkoutDifficulty(event) {
  const workoutId = action?.workoutId;
  const difficulty = event.currentTarget.value;
  if (!workoutId || loading || saving || draft.locked || draft.submitted) return;
  if (draft.workoutDifficulty[workoutId] === difficulty) return;
  const previousDraft = draft;
  draft = applyWorkoutDifficultyMutation(draft, workoutId, difficulty);
  saving = true;
  errorMessage = '';
  render();

  try {
    if (hasSupabaseAuth()) {
      draft = await setDailyStandardWorkoutDifficulty({
        date: entryDate,
        workoutId,
        difficulty,
        expectedVersion: previousDraft.version,
      });
    } else {
      writeLocalDraft(draft);
    }
  } catch (error) {
    draft = previousDraft;
    errorMessage = error?.message || 'That difficulty could not be saved. Try again.';
    if (hasSupabaseAuth()) {
      try { draft = await getDailyStandardDraft(entryDate); } catch { /* keep recoverable local state */ }
    }
  } finally {
    saving = false;
    render();
  }
}

async function hydrate() {
  if (saving) return;
  const requestId = ++hydrationRequestId;
  loading = true;
  errorMessage = '';
  render();
  try {
    let nextDate = entryDate;
    let nextDraft;
    if (hasSupabaseAuth()) {
      const dashboard = await getDashboard();
      const timeZone = dashboard?.profile?.timeZone || browserTimeZone;
      nextDate = dateKeyForTimeZone(new Date(), timeZone);
      nextDraft = await getDailyStandardDraft(nextDate);
    } else {
      nextDraft = readLocalDraft();
      nextDate = entryDate;
    }
    if (requestId !== hydrationRequestId || saving) return;
    entryDate = nextDate;
    draft = nextDraft;
    interactiveReady = true;
  } catch (error) {
    if (requestId !== hydrationRequestId) return;
    interactiveReady = false;
    errorMessage = error?.message || 'Unable to load today’s action.';
  } finally {
    if (requestId !== hydrationRequestId || saving) return;
    loading = false;
    render();
    await renderActionContent();
    syncPhysicalContent();
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
