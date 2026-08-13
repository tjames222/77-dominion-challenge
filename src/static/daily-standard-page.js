import {
  getBillingState,
  getChallengeActivation,
  getDailyStandardDraft,
  getDashboard,
  getLocalOrSessionUser,
  hasSupabaseAuth,
  isLocalDemoMode,
  mutateDailyStandardDraft,
  redirectToLogin,
  setDailyStandardWorkoutDifficulty,
  subscribeToAuthStateChanges,
} from './api';
import {
  dateKeyForTimeZone,
  migrateMockCheckInCache,
  mockCheckInOwnerForUser,
} from './check-in.mjs';
import { createChallengeActivationState } from './challenge-activation.mjs';
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
  PREVIEW_CHECK_IN_DATES_STORAGE_KEY,
  isPreviewChallengeActive,
  isPreviewChallengeComplete,
  normalizePreviewChallengeState,
  previewChallengeDate,
} from './preview-challenge.mjs';
import {
  PREVIEW_USER_STATE_STORAGE_KEY,
  readPreviewUserValue,
  writePreviewUserValue,
} from './preview-user-state.mjs';

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
let challengeActivation = createChallengeActivationState('loading');
let hydrationRequestId = 0;
let activationRefreshPending = false;
let observedAuthOwner = '';
let hydratedAuthOwner = '';
let authOwnerEpoch = 0;

const hasHydratedAuthOwner = () => Boolean(
  hydratedAuthOwner && hydratedAuthOwner === observedAuthOwner,
);
const captureMutationOwner = () => hasHydratedAuthOwner()
  ? { userId: hydratedAuthOwner, epoch: authOwnerEpoch }
  : null;
const isCurrentMutationOwner = (owner) => Boolean(
  owner
  && owner.epoch === authOwnerEpoch
  && owner.userId === hydratedAuthOwner
  && owner.userId === observedAuthOwner,
);

function localPreviewState(ownerId) {
  return normalizePreviewChallengeState(
    readPreviewUserValue(localStorage, ownerId, PREVIEW_CHALLENGE_STORAGE_KEY, {}),
    entryDate,
  );
}

function localEntryDate(timeZone = browserTimeZone, ownerId = hydratedAuthOwner) {
  const preview = localPreviewState(ownerId);
  return isPreviewChallengeActive(localDemoMode, preview)
    ? previewChallengeDate(preview)
    : dateKeyForTimeZone(new Date(), timeZone);
}

function localDateWasSubmitted(date, user, previewActive) {
  const storageKey = previewActive
    ? PREVIEW_CHECK_IN_DATES_STORAGE_KEY
    : 'dominion:checkInDates';
  const stored = readPreviewUserValue(localStorage, user.userId, storageKey, {});
  const cache = migrateMockCheckInCache(stored, user.userId, user.email);
  writePreviewUserValue(localStorage, user.userId, storageKey, cache);
  return cache.dates.includes(date);
}

function readLocalDraft(activation, user) {
  const date = localEntryDate(activation.timeZone || browserTimeZone, user.userId);
  const preview = localPreviewState(user.userId);
  const previewActive = isPreviewChallengeActive(localDemoMode, preview);
  const nextActivation = previewActive
    ? {
        ...activation,
        readState: 'ready',
        contractValid: true,
        status: 'active',
        mode: 'solo',
        startDate: preview.anchorDate,
        canParticipate: true,
        canMutateDailyStandards: true,
      }
    : activation;
  const challengeActive = nextActivation.canMutateDailyStandards === true;
  const storedEntries = readPreviewUserValue(localStorage, user.userId, ENTRY_STORAGE_KEY, []);
  const entries = Array.isArray(storedEntries) ? storedEntries : [];
  const entry = entries.find((item) => item.date === date) || {};
  const submitted = localDateWasSubmitted(date, user, previewActive);
  return {
    activation: nextActivation,
    date,
    draft: normalizeDailyStandardDraft({
      ...entry,
      entry_date: date,
      workoutDifficulty: entry.workoutDifficulty || readPreviewUserValue(
        localStorage,
        user.userId,
        WORKOUT_DIFFICULTY_STORAGE_KEY,
        {},
      ),
      submitted,
      locked: submitted || isPreviewChallengeComplete(preview) || !challengeActive,
      lockReason: challengeActive ? null : 'challenge_not_active',
    }),
  };
}

function writeLocalDraft(nextDraft, ownerId) {
  const storedEntries = readPreviewUserValue(localStorage, ownerId, ENTRY_STORAGE_KEY, []);
  const entries = Array.isArray(storedEntries) ? storedEntries : [];
  const index = entries.findIndex((item) => item.date === nextDraft.date);
  if (index >= 0) entries[index] = nextDraft;
  else entries.push(nextDraft);
  writePreviewUserValue(localStorage, ownerId, ENTRY_STORAGE_KEY, entries);
  writePreviewUserValue(localStorage, ownerId, WORKOUT_DIFFICULTY_STORAGE_KEY, nextDraft.workoutDifficulty);
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
  introduction.dataset.trainingTarget = 'daily-standard-guidance';
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
    link.dataset.trainingTarget = 'daily-standard-resource';
    link.textContent = `${linkLabel} ↗`;
    setExternalLink(link, linkHref);
    content.append(link);
  }
  return content;
}

function createHealthControl(label) {
  const wrapper = document.createElement('div');
  wrapper.className = 'action-native-control';
  wrapper.dataset.trainingTarget = 'daily-standard-native';
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
      : 'Finish this action at a steady pace.',
    linkLabel: 'Open Apple Fitness',
    linkHref: APPLE_FITNESS_URL,
  });
  if (!content) return;

  const field = document.createElement('label');
  field.className = 'action-difficulty-field';
  field.dataset.trainingTarget = 'daily-standard-difficulty';
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
    eyebrow: 'Walk Break',
    title: 'Step outside and reset',
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
  reminder.dataset.trainingTarget = 'daily-standard-resource';
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
    select.disabled = loading
      || saving
      || !hasHydratedAuthOwner()
      || !challengeActivation.canMutateDailyStandards
      || draft.locked
      || draft.submitted;
  }
  if (recommendation) recommendation.textContent = workoutPlanForDate(entryDate, difficulty, action.workoutId);
}

function render() {
  if (!root || !action) return;
  const isComplete = draft.completed.includes(action.id);
  const isLocked = !interactiveReady
    || !hasHydratedAuthOwner()
    || !challengeActivation.canMutateDailyStandards
    || draft.locked
    || draft.submitted;
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
          : challengeActivation.readState === 'error'
            ? 'Challenge activation could not be confirmed. Refresh to try again.'
          : challengeActivation.status === 'not_started'
            ? 'Start your challenge before tracking this Daily Action.'
          : challengeActivation.status === 'scheduled'
            ? `Your challenge is scheduled to begin ${challengeActivation.startDate}.`
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
  if (!workoutId || loading || saving || !hasHydratedAuthOwner() || !challengeActivation.canMutateDailyStandards || draft.locked || draft.submitted) return;
  if (draft.workoutDifficulty[workoutId] === difficulty) return;
  const owner = captureMutationOwner();
  if (!owner) return;
  const previousDraft = draft;
  draft = applyWorkoutDifficultyMutation(draft, workoutId, difficulty);
  saving = true;
  errorMessage = '';
  render();

  try {
    if (hasSupabaseAuth()) {
      const authoritative = await setDailyStandardWorkoutDifficulty({
        date: entryDate,
        workoutId,
        difficulty,
        expectedVersion: previousDraft.version,
        expectedUserId: owner.userId,
      });
      if (!isCurrentMutationOwner(owner)) return;
      draft = authoritative;
    } else {
      if (!isCurrentMutationOwner(owner)) return;
      writeLocalDraft(draft, owner.userId);
    }
  } catch (error) {
    if (!isCurrentMutationOwner(owner)) return;
    draft = previousDraft;
    errorMessage = error?.message || 'That difficulty could not be saved. Try again.';
    if (hasSupabaseAuth()) {
      activationRefreshPending = true;
      try {
        const authoritative = await getDailyStandardDraft(entryDate, {
          expectedUserId: owner.userId,
        });
        if (isCurrentMutationOwner(owner)) draft = authoritative;
      } catch { /* keep recoverable local state */ }
    }
  } finally {
    if (!isCurrentMutationOwner(owner)) return;
    saving = false;
    render();
    if (activationRefreshPending) {
      activationRefreshPending = false;
      void hydrate();
    }
  }
}

async function hydrate(expectedOwnerId = observedAuthOwner) {
  if (saving) return;
  const requestId = ++hydrationRequestId;
  const requestedOwner = String(expectedOwnerId || '');
  loading = true;
  interactiveReady = false;
  errorMessage = '';
  render();
  try {
    let nextDate = entryDate;
    let nextDraft;
    let nextActivation;
    let dashboardOwner;
    if (hasSupabaseAuth()) {
      const dashboard = await getDashboard();
      dashboardOwner = String(dashboard?.profile?.userId || '');
      if (!dashboardOwner) throw new Error('We couldn’t verify the account for this Daily Action.');
      if ((requestedOwner && requestedOwner !== dashboardOwner)
        || (observedAuthOwner && observedAuthOwner !== dashboardOwner)) return;
      nextActivation = dashboard?.activation || createChallengeActivationState('error');
      const timeZone = nextActivation.timeZone || dashboard?.profile?.timeZone || browserTimeZone;
      nextDate = dateKeyForTimeZone(new Date(), timeZone);
      nextDraft = nextActivation.canMutateDailyStandards
        ? await getDailyStandardDraft(nextDate, { expectedUserId: dashboardOwner })
        : normalizeDailyStandardDraft({
            entry_date: nextDate,
            locked: true,
            lock_reason: nextActivation.status === 'scheduled'
              ? 'challenge_scheduled'
              : 'challenge_not_active',
            activation_status: nextActivation.status,
          });
    } else {
      const currentUser = await getLocalOrSessionUser();
      dashboardOwner = String(currentUser?.userId || '');
      if (!dashboardOwner) throw new Error('You need to log in again.');
      if ((requestedOwner && requestedOwner !== dashboardOwner)
        || (observedAuthOwner && observedAuthOwner !== dashboardOwner)) return;
      const activation = await getChallengeActivation({ expectedUserId: dashboardOwner });
      const localState = readLocalDraft(
        activation,
        currentUser,
      );
      nextActivation = localState.activation;
      nextDraft = localState.draft;
      nextDate = localState.date;
    }
    if (requestId !== hydrationRequestId
      || saving
      || (observedAuthOwner && observedAuthOwner !== dashboardOwner)) return;
    observedAuthOwner ||= dashboardOwner;
    hydratedAuthOwner = dashboardOwner;
    challengeActivation = nextActivation;
    entryDate = nextDate;
    draft = nextDraft;
    interactiveReady = true;
  } catch (error) {
    if (requestId !== hydrationRequestId) return;
    hydratedAuthOwner = '';
    entryDate = dateKeyForTimeZone(new Date(), browserTimeZone);
    draft = normalizeDailyStandardDraft({ entry_date: entryDate });
    renderedContentKey = '';
    if (hasSupabaseAuth()) challengeActivation = createChallengeActivationState('error');
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

function invalidateDailyStandardOwner(nextOwner = '') {
  authOwnerEpoch += 1;
  hydrationRequestId += 1;
  observedAuthOwner = String(nextOwner || '');
  hydratedAuthOwner = '';
  interactiveReady = false;
  loading = true;
  saving = false;
  activationRefreshPending = false;
  challengeActivation = createChallengeActivationState('loading');
  entryDate = dateKeyForTimeZone(new Date(), browserTimeZone);
  draft = normalizeDailyStandardDraft({ entry_date: entryDate });
  renderedContentKey = '';
  errorMessage = '';
  render();
  void renderActionContent();
  syncPhysicalContent();
}

async function handleDailyStandardAuthOwnerChange(nextUser, { force = false } = {}) {
  const nextOwner = String(nextUser?.userId || '');
  if (!force && nextOwner && nextOwner === observedAuthOwner) return;
  invalidateDailyStandardOwner(nextOwner);
  if (!nextOwner) {
    redirectToLogin();
    return;
  }

  try {
    const billing = await getBillingState();
    if (observedAuthOwner !== nextOwner) return;
    if (!billing.authenticated) {
      redirectToLogin();
      return;
    }
    if (!billing.appAccess) {
      window.location.href = './billing.html?intent=subscription';
      return;
    }
    await hydrate(nextOwner);
  } catch (error) {
    if (observedAuthOwner !== nextOwner) return;
    loading = false;
    challengeActivation = createChallengeActivationState('error');
    errorMessage = error?.message || 'Unable to reload this action after the account changed.';
    render();
  }
}

async function toggleCompletion() {
  if (loading || saving || !hasHydratedAuthOwner() || !challengeActivation.canMutateDailyStandards || draft.locked || draft.submitted) return;
  const owner = captureMutationOwner();
  if (!owner) return;
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
      const authoritative = await mutateDailyStandardDraft({
        date: entryDate,
        actionId: action.id,
        completed: nextCompleted,
        expectedVersion: previousDraft.version,
        expectedUserId: owner.userId,
      });
      if (!isCurrentMutationOwner(owner)) return;
      draft = authoritative;
    } else {
      if (!isCurrentMutationOwner(owner)) return;
      writeLocalDraft(draft, owner.userId);
    }
  } catch (error) {
    if (!isCurrentMutationOwner(owner)) return;
    draft = previousDraft;
    errorMessage = error?.message || 'That change could not be saved. Try again.';
    if (hasSupabaseAuth()) {
      activationRefreshPending = true;
      try {
        const authoritative = await getDailyStandardDraft(entryDate, {
          expectedUserId: owner.userId,
        });
        if (isCurrentMutationOwner(owner)) draft = authoritative;
      } catch { /* keep recoverable local state */ }
    }
  } finally {
    if (!isCurrentMutationOwner(owner)) return;
    saving = false;
    render();
    if (activationRefreshPending) {
      activationRefreshPending = false;
      void hydrate();
    }
  }
}

function refreshAfterChallengeActivationEvent(event) {
  const nextActivation = event.detail?.activation;
  challengeActivation = nextActivation?.contractValid && nextActivation.readState === 'ready'
    ? nextActivation
    : createChallengeActivationState('loading');
  interactiveReady = false;
  render();
  if (saving) {
    activationRefreshPending = true;
    return;
  }
  void hydrate();
}

async function boot() {
  invalidateDailyStandardOwner('');
  if (!root || !action) {
    window.location.replace('./dashboard.html#daily-standards');
    return;
  }
  const currentUser = await getLocalOrSessionUser();
  if (!currentUser?.userId) {
    redirectToLogin();
    return;
  }
  invalidateDailyStandardOwner(currentUser.userId);
  const unsubscribeAuth = subscribeToAuthStateChanges(({ user }) => {
    void handleDailyStandardAuthOwnerChange(user);
  });
  window.addEventListener('pagehide', unsubscribeAuth, { once: true });

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
  window.addEventListener('dominion:challenge-start-date-updated', refreshAfterChallengeActivationEvent);
  window.addEventListener('focus', () => { if (!document.hidden) hydrate(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) hydrate(); });
  window.addEventListener('storage', (event) => {
    if (event.key === 'dominion:user' && localDemoMode) {
      invalidateDailyStandardOwner('');
      void getLocalOrSessionUser()
        .then((user) => handleDailyStandardAuthOwnerChange(user, { force: true }))
        .catch((error) => {
          console.warn('Unable to resolve the updated preview account', error);
          redirectToLogin();
        });
      return;
    }
    if (localDemoMode && [
      PREVIEW_USER_STATE_STORAGE_KEY,
      ENTRY_STORAGE_KEY,
      'dominion:checkInDates',
      'dominion:previewCheckInDates',
      'dominion:startDate',
      'dominion:mockChallengeActivation',
    ].includes(event.key)) hydrate(observedAuthOwner);
  });
  await hydrate(observedAuthOwner);
}

boot().catch((error) => {
  loading = false;
  errorMessage = error?.message || 'Unable to open this action.';
  render();
});
