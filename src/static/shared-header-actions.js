import {
  getDashboard,
  getGameSummary,
  getProfile,
  hasSupabaseAuth,
  isLocalDemoMode,
  recordAppVisit,
  updateProfile,
} from './api';
import { checkInCacheForOwner, dateKeyForTimeZone } from './check-in.mjs';
import { createDialog } from './dialog.mjs';
import {
  PREVIEW_CHALLENGE_STORAGE_KEY,
  PREVIEW_CHECK_IN_DATES_STORAGE_KEY,
  isPreviewChallengeActive,
  normalizePreviewChallengeState,
} from './preview-challenge.mjs';
import { initShareComposer } from './share-composer.js';
import {
  STREAK_METRIC_DEFINITIONS,
  buildStreakSummary,
  streakIndicatorLabel,
  streakMetrics,
} from './streak-summary.mjs';
import { normalizeChallengeStartDate } from './shared-header-state.mjs';

const GAME_STATS_STORAGE_KEY = 'dominion:gameStats';
const START_DATE_STORAGE_KEY = 'dominion:startDate';
const CHECK_IN_DATES_STORAGE_KEY = 'dominion:checkInDates';
const SHARE_COMPOSER_STYLESHEET = new URL('../assets/share-composer.css', import.meta.url).href;
const DEFAULT_GAME_STATS = Object.freeze({
  currentAppStreak: 0,
  bestAppStreak: 0,
  currentFullDayStreak: 0,
  bestFullDayStreak: 0,
});

function element(ownerDocument, tag, className = '', text = '') {
  const node = ownerDocument.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function readJson(storage, key, fallback) {
  try {
    return JSON.parse(storage?.getItem?.(key) || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

function localDateKey() {
  try {
    return dateKeyForTimeZone(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function formatChallengeStartDate(value) {
  const normalized = normalizeChallengeStartDate(value);
  if (!normalized) return 'Not set';
  const [year, month, day] = normalized.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(year, month - 1, day));
}

function ensureShareComposerStyles(ownerDocument) {
  const existing = [...ownerDocument.querySelectorAll('link[rel="stylesheet"]')]
    .find((link) => {
      const source = link.getAttribute('href') || '';
      return link.href === SHARE_COMPOSER_STYLESHEET
        || /(?:^|\/)share-composer(?:-[A-Za-z0-9_-]+)?\.css(?:[?#]|$)/.test(source);
    });
  if (existing) {
    existing.dataset.globalShareComposerStyles = '';
    return;
  }
  const link = ownerDocument.createElement('link');
  link.rel = 'stylesheet';
  link.href = SHARE_COMPOSER_STYLESHEET;
  link.dataset.globalShareComposerStyles = '';
  ownerDocument.head?.append(link);
}

function createStreakDetailsContent(ownerDocument) {
  const wrapper = element(ownerDocument, 'div', 'global-streak-details');

  const loadStatus = element(ownerDocument, 'p', 'global-streak-load-status', 'Loading your current streaks…');
  loadStatus.dataset.globalStreakLoadStatus = '';
  loadStatus.setAttribute('role', 'status');
  loadStatus.setAttribute('aria-live', 'polite');

  const zeroState = element(
    ownerDocument,
    'p',
    'global-streak-zero',
    'No streak history yet. Open Dominion and complete the full standard to begin.',
  );
  zeroState.dataset.globalStreakZero = '';
  zeroState.hidden = true;

  const grid = element(ownerDocument, 'div', 'global-streak-grid');
  STREAK_METRIC_DEFINITIONS.forEach(({ key, kind, label }) => {
    const metric = element(ownerDocument, 'article', 'global-streak-metric');
    metric.dataset.streakKind = kind === 'Personal best' ? 'best' : 'current';
    metric.append(
      element(ownerDocument, 'span', 'global-streak-kind', kind),
      element(ownerDocument, 'h3', '', label),
    );

    const valueRow = element(ownerDocument, 'p', 'global-streak-value');
    const value = element(ownerDocument, 'strong', '', '0');
    value.dataset.globalStreakValue = key;
    const unit = element(ownerDocument, 'span', '', 'days');
    unit.dataset.globalStreakUnit = key;
    valueRow.append(value, unit);
    metric.append(valueRow);
    grid.append(metric);
  });

  const startDateSection = element(ownerDocument, 'section', 'global-streak-start-date');
  const heading = element(ownerDocument, 'div', 'global-streak-start-date-heading');
  const headingCopy = element(ownerDocument, 'div');
  headingCopy.append(
    element(ownerDocument, 'p', 'eyebrow', 'Challenge timeline'),
    element(ownerDocument, 'h3', '', 'Challenge start date'),
  );
  const dateDisplay = element(ownerDocument, 'strong', 'global-streak-start-date-display', 'Not set');
  dateDisplay.dataset.globalStreakStartDateDisplay = '';
  heading.append(headingCopy, dateDisplay);

  const form = element(ownerDocument, 'form', 'global-streak-start-date-form');
  form.dataset.globalStreakStartDateForm = '';
  const label = element(ownerDocument, 'label');
  label.append(element(ownerDocument, 'span', '', 'Start date'));
  const input = ownerDocument.createElement('input');
  input.type = 'date';
  input.name = 'challengeStartDate';
  input.required = true;
  input.dataset.globalStreakStartDateInput = '';
  label.append(input);
  const saveButton = element(ownerDocument, 'button', 'primary', 'Save start date');
  saveButton.type = 'submit';
  saveButton.dataset.globalStreakStartDateSave = '';
  form.append(label, saveButton);

  const help = element(
    ownerDocument,
    'p',
    'global-streak-start-date-help',
    'Set this before your first check-in. After a check-in is posted, the date stays locked to protect challenge progress.',
  );
  help.dataset.globalStreakStartDateHelp = '';
  const feedback = element(ownerDocument, 'p', 'global-streak-start-date-feedback');
  feedback.dataset.globalStreakStartDateFeedback = '';
  feedback.setAttribute('role', 'status');
  feedback.setAttribute('aria-live', 'polite');
  feedback.setAttribute('aria-atomic', 'true');

  startDateSection.append(heading, form, help, feedback);
  wrapper.append(loadStatus, zeroState, grid, startDateSection);
  return wrapper;
}

function localHeaderSnapshot(user, storage) {
  const today = localDateKey();
  const stats = readJson(storage, GAME_STATS_STORAGE_KEY, DEFAULT_GAME_STATS);
  const previewState = normalizePreviewChallengeState(
    readJson(storage, PREVIEW_CHALLENGE_STORAGE_KEY, {}),
    today,
  );
  const previewActive = isPreviewChallengeActive(true, previewState);
  const checkInStorageKey = previewActive
    ? PREVIEW_CHECK_IN_DATES_STORAGE_KEY
    : CHECK_IN_DATES_STORAGE_KEY;
  const owner = `mock:${user?.email || 'preview'}`;
  const checkIns = checkInCacheForOwner(readJson(storage, checkInStorageKey, {}), owner);
  const startDate = previewActive
    ? previewState.anchorDate
    : normalizeChallengeStartDate(readJson(storage, START_DATE_STORAGE_KEY, today), today);

  return {
    stats,
    profile: { challengeStartDate: startDate },
    startDateLocked: previewActive || checkIns.dates.length > 0 || checkIns.challengeDays.length > 0,
    previewActive,
  };
}

export function createAuthenticatedHeaderActions({
  topbar,
  user,
  document: ownerDocument = globalThis.document,
} = {}) {
  if (!topbar || !ownerDocument?.createElement) {
    throw new TypeError('Authenticated header actions require a topbar and document.');
  }

  ensureShareComposerStyles(ownerDocument);
  topbar.classList.add('has-authenticated-header-actions');

  let trailingActions = topbar.querySelector('.topbar-trailing-actions');
  if (!trailingActions) {
    trailingActions = element(ownerDocument, 'div', 'topbar-trailing-actions');
    topbar.append(trailingActions);
  }

  const existingMenuButton = topbar.querySelector('.global-menu-button');
  if (existingMenuButton && existingMenuButton.parentElement !== trailingActions) {
    trailingActions.append(existingMenuButton);
  }

  const actionGroup = element(ownerDocument, 'div', 'authenticated-header-actions');
  actionGroup.setAttribute('role', 'group');
  actionGroup.setAttribute('aria-label', 'Member actions');

  const shareButton = element(ownerDocument, 'button', 'shared-header-action shared-header-share');
  shareButton.type = 'button';
  shareButton.dataset.shareComposer = '';
  shareButton.dataset.shareKind = 'progress';
  shareButton.append(
    element(ownerDocument, 'span', 'app-icon icon-share', ''),
    element(ownerDocument, 'span', 'shared-header-action-label', 'Share'),
  );
  shareButton.querySelector('.app-icon')?.setAttribute('aria-hidden', 'true');

  const streakButton = element(ownerDocument, 'button', 'shared-header-action shared-header-streak');
  streakButton.type = 'button';
  streakButton.setAttribute('aria-haspopup', 'dialog');
  streakButton.setAttribute('aria-controls', 'globalStreakDetailsDialog');
  streakButton.setAttribute('aria-expanded', 'false');
  streakButton.setAttribute('aria-label', 'App streak: loading. View streak details.');
  const streakIcon = element(ownerDocument, 'span', 'app-icon icon-lightning');
  streakIcon.setAttribute('aria-hidden', 'true');
  const streakLabel = element(ownerDocument, 'span', 'shared-header-action-label', 'App Streak');
  const streakCount = element(ownerDocument, 'strong', 'shared-header-streak-count', '—');
  streakCount.dataset.globalAppStreakCount = '';
  streakButton.append(streakIcon, streakLabel, streakCount);
  actionGroup.append(shareButton, streakButton);

  const menuButton = trailingActions.querySelector('.global-menu-button');
  trailingActions.insertBefore(actionGroup, menuButton || null);

  const content = createStreakDetailsContent(ownerDocument);
  const dateInput = content.querySelector('[data-global-streak-start-date-input]');
  const saveButton = content.querySelector('[data-global-streak-start-date-save]');
  const dateDisplay = content.querySelector('[data-global-streak-start-date-display]');
  const dateHelp = content.querySelector('[data-global-streak-start-date-help]');
  const dateFeedback = content.querySelector('[data-global-streak-start-date-feedback]');
  const loadStatus = content.querySelector('[data-global-streak-load-status]');
  const zeroState = content.querySelector('[data-global-streak-zero]');

  let currentUser = user;
  let currentStartDate = '';
  let startDateLocked = false;
  let previewActive = false;
  let destroyed = false;
  let hydrationRequest = 0;
  let ownerVersion = 0;
  let recordedVisitOwner = '';
  let recordVisitPromise = null;

  const dialog = createDialog({
    id: 'globalStreakDetailsDialog',
    title: 'App Streak',
    eyebrow: 'Your consistency',
    description: 'See current and personal-best streaks, and manage the date that anchors your 77-day challenge.',
    presentation: 'responsive',
    content,
    onOpen: () => {
      dialog.elements.body.scrollTop = 0;
      streakButton.setAttribute('aria-expanded', 'true');
      void refresh({ includeLockState: true });
    },
    onClose: () => streakButton.setAttribute('aria-expanded', 'false'),
  });

  const renderStartDate = () => {
    dateInput.value = currentStartDate;
    dateInput.disabled = startDateLocked;
    saveButton.disabled = true;
    dateDisplay.textContent = formatChallengeStartDate(currentStartDate);
    if (previewActive) {
      dateHelp.textContent = 'The preview simulator controls this challenge date.';
    } else if (startDateLocked) {
      dateHelp.textContent = 'The challenge start date is locked after the first check-in.';
    } else {
      dateHelp.textContent = 'Set this before your first check-in. After a check-in is posted, the date stays locked to protect challenge progress.';
    }
  };

  const renderSnapshot = ({ stats = DEFAULT_GAME_STATS, profile = {}, startDateLocked: locked = false, previewActive: preview = false }) => {
    const summary = buildStreakSummary(stats, localDateKey());
    streakCount.textContent = String(summary.currentAppStreak);
    streakButton.setAttribute('aria-label', streakIndicatorLabel(summary));
    streakMetrics(summary).forEach(({ key, value, unit }) => {
      const valueElement = content.querySelector(`[data-global-streak-value="${key}"]`);
      const unitElement = content.querySelector(`[data-global-streak-unit="${key}"]`);
      if (valueElement) valueElement.textContent = String(value);
      if (unitElement) unitElement.textContent = unit;
    });
    zeroState.hidden = summary.hasHistory;
    currentStartDate = normalizeChallengeStartDate(profile?.challengeStartDate, localDateKey());
    startDateLocked = Boolean(locked);
    previewActive = Boolean(preview);
    renderStartDate();
  };

  async function loadSnapshot(includeLockState) {
    if (isLocalDemoMode()) return localHeaderSnapshot(currentUser, ownerDocument.defaultView?.localStorage);
    const ownerKey = currentUser?.userId || currentUser?.email || '';
    if (ownerKey) {
      if (recordedVisitOwner !== ownerKey || !recordVisitPromise) {
        recordedVisitOwner = ownerKey;
        recordVisitPromise = recordAppVisit().catch((error) => {
          recordedVisitOwner = '';
          recordVisitPromise = null;
          console.warn('Unable to record this app visit from the shared header', error);
        });
      }
      await recordVisitPromise;
    }
    if (includeLockState) {
      const dashboard = await getDashboard();
      return {
        stats: dashboard?.gameStats || DEFAULT_GAME_STATS,
        profile: dashboard?.profile || {},
        startDateLocked: Array.isArray(dashboard?.checkIns) && dashboard.checkIns.length > 0,
        previewActive: false,
      };
    }
    const [summary, profile] = await Promise.all([getGameSummary(), getProfile()]);
    return {
      stats: summary?.gameStats || DEFAULT_GAME_STATS,
      profile: profile || {},
      startDateLocked,
      previewActive: false,
    };
  }

  async function refresh({ includeLockState = false } = {}) {
    if (destroyed) return;
    const requestId = ++hydrationRequest;
    const ownerKey = currentUser?.userId || currentUser?.email || '';
    loadStatus.hidden = false;
    loadStatus.textContent = 'Loading your current streaks…';
    if (dialog.isOpen) dialog.setBusy(true, 'Refreshing streak details…');

    try {
      const snapshot = await loadSnapshot(includeLockState);
      const currentOwnerKey = currentUser?.userId || currentUser?.email || '';
      if (destroyed || requestId !== hydrationRequest || ownerKey !== currentOwnerKey) return;
      renderSnapshot(snapshot);
      loadStatus.hidden = true;
      dialog.clearError();
    } catch (error) {
      if (destroyed || requestId !== hydrationRequest) return;
      loadStatus.hidden = false;
      loadStatus.textContent = 'Streak details could not be refreshed.';
      if (dialog.isOpen) dialog.setError(error?.message || 'Unable to load your streak details.');
    } finally {
      if (!destroyed && requestId === hydrationRequest && dialog.isOpen) dialog.setBusy(false);
    }
  }

  content.querySelector('[data-global-streak-start-date-form]')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (startDateLocked || dialog.isBusy) return;
    const nextStartDate = normalizeChallengeStartDate(dateInput.value);
    if (!nextStartDate) {
      dateFeedback.textContent = 'Choose a valid challenge start date.';
      dateInput.focus();
      return;
    }

    const previousStartDate = currentStartDate;
    const submitOwnerVersion = ownerVersion;
    const submitOwnerKey = currentUser?.userId || currentUser?.email || '';
    const submitExpectedUserId = currentUser?.userId || '';
    currentStartDate = nextStartDate;
    dateFeedback.textContent = '';
    dialog.clearError();
    renderStartDate();
    dialog.setBusy(true, 'Saving challenge start date…');
    saveButton.disabled = true;

    try {
      if (isLocalDemoMode()) {
        ownerDocument.defaultView?.localStorage?.setItem(START_DATE_STORAGE_KEY, JSON.stringify(nextStartDate));
      } else if (hasSupabaseAuth()) {
        await updateProfile(
          { challengeStartDate: nextStartDate },
          { expectedUserId: submitExpectedUserId },
        );
      } else {
        throw new Error('Log in again before changing your challenge start date.');
      }

      if (
        destroyed
        || submitOwnerVersion !== ownerVersion
        || submitOwnerKey !== (currentUser?.userId || currentUser?.email || '')
      ) return;

      dateFeedback.textContent = 'Challenge start date saved.';
      const CustomEventConstructor = ownerDocument.defaultView?.CustomEvent;
      if (CustomEventConstructor) {
        ownerDocument.defaultView.dispatchEvent(new CustomEventConstructor('dominion:challenge-start-date-updated', {
          detail: { challengeStartDate: nextStartDate },
        }));
      }
      renderStartDate();
    } catch (error) {
      if (
        destroyed
        || submitOwnerVersion !== ownerVersion
        || submitOwnerKey !== (currentUser?.userId || currentUser?.email || '')
      ) return;
      currentStartDate = previousStartDate;
      if (/locked after the first check-in/i.test(String(error?.message || ''))) startDateLocked = true;
      renderStartDate();
      dateFeedback.textContent = error?.message || 'Unable to save the challenge start date.';
      dialog.setError(dateFeedback.textContent);
    } finally {
      if (!destroyed && submitOwnerVersion === ownerVersion) {
        dialog.setBusy(false);
        saveButton.disabled = true;
      }
    }
  });

  dateInput.addEventListener('input', () => {
    const nextStartDate = normalizeChallengeStartDate(dateInput.value);
    dateFeedback.textContent = '';
    saveButton.disabled = startDateLocked || !nextStartDate || nextStartDate === currentStartDate;
  });

  streakButton.addEventListener('click', () => dialog.open(streakButton));
  initShareComposer(ownerDocument);
  void refresh();

  return {
    get element() { return actionGroup; },
    get user() { return currentUser; },
    refresh,
    setUser(nextUser) {
      const previousOwner = currentUser?.userId || currentUser?.email || '';
      const nextOwner = nextUser?.userId || nextUser?.email || '';
      currentUser = nextUser;
      if (previousOwner !== nextOwner) {
        ownerVersion += 1;
        hydrationRequest += 1;
        recordedVisitOwner = '';
        recordVisitPromise = null;
        dialog.close('replaced');
        dialog.setBusy(false);
        streakCount.textContent = '—';
        streakButton.setAttribute('aria-label', 'App streak: loading. View streak details.');
        content.querySelectorAll('[data-global-streak-value]').forEach((valueElement) => {
          valueElement.textContent = '0';
        });
        content.querySelectorAll('[data-global-streak-unit]').forEach((unitElement) => {
          unitElement.textContent = 'days';
        });
        currentStartDate = '';
        startDateLocked = true;
        previewActive = false;
        dateInput.value = '';
        dateInput.disabled = true;
        saveButton.disabled = true;
        dateDisplay.textContent = 'Loading…';
        dateFeedback.textContent = '';
        zeroState.hidden = true;
        loadStatus.hidden = false;
        loadStatus.textContent = 'Loading your current streaks…';
      }
      void refresh();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      ownerVersion += 1;
      hydrationRequest += 1;
      dialog.destroy();
      actionGroup.remove();
      topbar.classList.remove('has-authenticated-header-actions');
    },
  };
}
