import {
  getChallengeActivation,
  getGameSummary,
  isLocalDemoMode,
  recordAppVisit,
  updateChallengeStartDate,
} from './api';
import { dateKeyForTimeZone, migrateMockCheckInCache } from './check-in.mjs';
import {
  PREVIEW_CHALLENGE_STORAGE_KEY,
  PREVIEW_CHECK_IN_DATES_STORAGE_KEY,
  isPreviewChallengeActive,
  normalizePreviewChallengeState,
} from './preview-challenge.mjs';
import { readPreviewUserValue, writePreviewUserValue } from './preview-user-state.mjs';
import { initShareComposer } from './share-composer-loader.js';
import {
  buildStreakSummary,
  streakIndicatorLabel,
} from './streak-summary.mjs';
import { normalizeChallengeStartDate } from './shared-header-state.mjs';

const GAME_STATS_STORAGE_KEY = 'dominion:gameStats';
const CHECK_IN_DATES_STORAGE_KEY = 'dominion:checkInDates';
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

function localDateKey() {
  try {
    return dateKeyForTimeZone(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

let streakDialogModule;
function loadStreakDialog() {
  if (!streakDialogModule) streakDialogModule = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('App Streak needs a reload.')), 30_000);
    import('./app-streak-dialog.mjs').then(resolve, reject).finally(() => clearTimeout(timer));
  });
  return streakDialogModule;
}

function localHeaderSnapshot(user, storage, activation) {
  const today = localDateKey();
  const ownerId = String(user?.userId || '');
  const stats = readPreviewUserValue(storage, ownerId, GAME_STATS_STORAGE_KEY, DEFAULT_GAME_STATS);
  const previewState = normalizePreviewChallengeState(
    readPreviewUserValue(storage, ownerId, PREVIEW_CHALLENGE_STORAGE_KEY, {}),
    today,
  );
  const previewActive = isPreviewChallengeActive(true, previewState);
  const checkInStorageKey = previewActive
    ? PREVIEW_CHECK_IN_DATES_STORAGE_KEY
    : CHECK_IN_DATES_STORAGE_KEY;
  const checkIns = migrateMockCheckInCache(
    readPreviewUserValue(storage, ownerId, checkInStorageKey, {}),
    ownerId,
    user?.email,
  );
  writePreviewUserValue(storage, ownerId, checkInStorageKey, checkIns);
  const effectiveActivation = previewActive
    ? {
        ...activation,
        readState: 'ready',
        contractValid: true,
        status: 'active',
        mode: 'solo',
        startDate: previewState.anchorDate,
        canParticipate: true,
        canEditStartDate: false,
      }
    : activation;
  const startDate = effectiveActivation?.startDate || '';

  return {
    stats,
    profile: { challengeStartDate: startDate },
    activation: effectiveActivation,
    startDateLocked: previewActive
      || !effectiveActivation?.canEditStartDate
      || checkIns.dates.length > 0
      || checkIns.challengeDays.length > 0,
    previewActive,
  };
}

export function createAuthenticatedHeaderActions({
  topbar,
  user,
  captureLifecycle,
  isCurrentLifecycle,
  document: ownerDocument = globalThis.document,
} = {}) {
  if (!topbar || !ownerDocument?.createElement
    || typeof captureLifecycle !== 'function' || typeof isCurrentLifecycle !== 'function') {
    throw new TypeError('Authenticated header actions require a topbar and document.');
  }

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
  shareButton.disabled = true;
  shareButton.setAttribute('aria-label', 'Share progress unavailable until your challenge starts.');
  shareButton.dataset.shareComposer = '';
  shareButton.dataset.shareKind = 'progress';
  shareButton.dataset.trainingTarget = 'global-share';
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
  streakButton.dataset.trainingTarget = 'global-app-streak';
  const streakIcon = element(ownerDocument, 'span', 'app-icon icon-lightning');
  streakIcon.setAttribute('aria-hidden', 'true');
  const streakLabel = element(ownerDocument, 'span', 'shared-header-action-label', 'App Streak');
  const streakCount = element(ownerDocument, 'strong', 'shared-header-streak-count', '—');
  streakCount.dataset.globalAppStreakCount = '';
  streakButton.append(streakIcon, streakLabel, streakCount);
  actionGroup.append(shareButton, streakButton);

  const menuButton = trailingActions.querySelector('.global-menu-button');
  trailingActions.insertBefore(actionGroup, menuButton || null);

  let dialog = null;
  let openRequest = 0;
  let loadingDialog = false;
  let dialogLoadFailed = false;
  let currentSummary = buildStreakSummary(DEFAULT_GAME_STATS, localDateKey());

  let currentUser = user;
  let currentStartDate = '';
  let currentActivation = null;
  let startDateLocked = true;
  let previewActive = false;
  let destroyed = false;
  let hydrationRequest = 0;
  let ownerVersion = 0;
  let recordedVisitOwner = '';
  let recordVisitPromise = null;

  const renderStartDate = () => dialog?.renderTimeline();

  async function openStreakDialog() {
    if (destroyed || loadingDialog) return;
    if (dialogLoadFailed) {
      if (ownerDocument.defaultView?.confirm('Save any unfinished work before reloading to load App Streak. Reload now?')) {
        ownerDocument.defaultView.location.reload();
      }
      return;
    }
    const generation = captureLifecycle();
    const version = ownerVersion;
    const request = ++openRequest;
    const isCurrent = () => !destroyed && request === openRequest
      && version === ownerVersion && isCurrentLifecycle(generation);
    loadingDialog = true;
    streakButton.disabled = true;
    streakButton.setAttribute('aria-busy', 'true');
    try {
      if (!dialog) {
        const { createAppStreakDialog } = await loadStreakDialog();
        if (!isCurrent()) return;
        dialog = createAppStreakDialog({
          document: ownerDocument,
          getState: () => ({ currentStartDate, startDateLocked, currentActivation, previewActive }),
          onSubmit: saveStartDate,
          onOpen: () => {
            streakButton.setAttribute('aria-expanded', 'true');
            void refresh({ includeLockState: true });
          },
          onClose: () => streakButton.setAttribute('aria-expanded', 'false'),
        });
      }
      if (!isCurrent()) return;
      dialog.render(currentSummary);
      dialog.open(streakButton);
    } catch {
      if (isCurrent()) {
        dialogLoadFailed = true;
        streakLabel.textContent = 'Reload for App Streak';
        streakButton.setAttribute('aria-label', 'Reload this page to load App Streak. Save unfinished work first.');
      }
    } finally {
      if (!destroyed && request === openRequest) {
        loadingDialog = false;
        streakButton.disabled = false;
        streakButton.removeAttribute('aria-busy');
      }
    }
  }

  const renderSnapshot = ({
    stats = DEFAULT_GAME_STATS,
    profile = {},
    activation = null,
    startDateLocked: locked = true,
    previewActive: preview = false,
  }) => {
    const shareAvailable = activation?.readState === 'ready'
      && activation?.contractValid
      && activation?.canParticipate === true;
    shareButton.disabled = !shareAvailable;
    shareButton.setAttribute(
      'aria-label',
      shareAvailable ? 'Share' : 'Share progress unavailable until your challenge starts.',
    );
    const summary = buildStreakSummary(stats, localDateKey());
    streakCount.textContent = String(summary.currentAppStreak);
    if (!dialogLoadFailed) streakButton.setAttribute('aria-label', streakIndicatorLabel(summary));
    currentSummary = summary;
    currentActivation = activation;
    currentStartDate = normalizeChallengeStartDate(
      activation?.startDate || profile?.challengeStartDate,
    );
    startDateLocked = Boolean(locked || !activation?.canEditStartDate);
    previewActive = Boolean(preview);
    dialog?.render(summary);
  };

  async function loadSnapshot(includeLockState) {
    if (isLocalDemoMode()) {
      const activation = await getChallengeActivation({ expectedUserId: currentUser?.userId });
      return localHeaderSnapshot(
        currentUser,
        ownerDocument.defaultView?.localStorage,
        activation,
      );
    }
    const expectedUserId = currentUser?.userId || '';
    const activation = await getChallengeActivation({ expectedUserId });
    if (expectedUserId && activation?.canParticipate === true) {
      if (recordedVisitOwner !== expectedUserId || !recordVisitPromise) {
        recordedVisitOwner = expectedUserId;
        recordVisitPromise = recordAppVisit({ expectedUserId }).catch((error) => {
          recordedVisitOwner = '';
          recordVisitPromise = null;
          console.warn('Unable to record this app visit from the shared header', error);
        });
      }
      await recordVisitPromise;
    }
    const summary = await getGameSummary();
    return {
      stats: summary?.gameStats || DEFAULT_GAME_STATS,
      profile: { challengeStartDate: activation.startDate },
      activation,
      startDateLocked: !activation.canEditStartDate,
      previewActive: false,
    };
  }

  async function refresh({ includeLockState = false } = {}) {
    if (destroyed) return;
    const requestId = ++hydrationRequest;
    const ownerKey = currentUser?.userId || currentUser?.email || '';
    dialog?.loading('Loading your current streaks…');
    if (dialog?.isOpen) dialog.setBusy(true, 'Refreshing streak details…');

    try {
      const snapshot = await loadSnapshot(includeLockState);
      const currentOwnerKey = currentUser?.userId || currentUser?.email || '';
      if (destroyed || requestId !== hydrationRequest || ownerKey !== currentOwnerKey) return;
      renderSnapshot(snapshot);
      dialog?.loading();
      dialog?.clearError();
    } catch (error) {
      if (destroyed || requestId !== hydrationRequest) return;
      dialog?.loading('Streak details could not be refreshed.');
      if (dialog?.isOpen) dialog.setError(error?.message || 'Unable to load your streak details.');
    } finally {
      if (!destroyed && requestId === hydrationRequest && dialog?.isOpen) dialog.setBusy(false);
    }
  }

  async function saveStartDate(value) {
    if (startDateLocked || !dialog || dialog.isBusy) return;
    const nextStartDate = normalizeChallengeStartDate(value);
    if (!nextStartDate) {
      dialog.setDateFeedback('Choose a valid challenge start date.');
      dialog.focusDate();
      return;
    }

    const previousStartDate = currentStartDate;
    const submitOwnerVersion = ownerVersion;
    const submitOwnerKey = currentUser?.userId || currentUser?.email || '';
    const expectedRevision = currentActivation?.revision ?? null;
    const submitTimeZone = currentActivation?.timeZone || '';
    currentStartDate = nextStartDate;
    dialog.setDateFeedback('');
    dialog.clearError();
    renderStartDate();
    dialog.setBusy(true, 'Saving challenge start date…');

    try {
      const savedActivation = await updateChallengeStartDate({
        startDate: nextStartDate,
        timeZone: submitTimeZone,
        expectedRevision,
        expectedUserId: submitOwnerKey,
      });

      if (
        destroyed
        || submitOwnerVersion !== ownerVersion
        || submitOwnerKey !== (currentUser?.userId || currentUser?.email || '')
      ) return;

      currentActivation = savedActivation;
      currentStartDate = savedActivation.startDate || nextStartDate;
      startDateLocked = !savedActivation.canEditStartDate;
      dialog.setDateFeedback('Challenge start date saved.');
      const CustomEventConstructor = ownerDocument.defaultView?.CustomEvent;
      if (CustomEventConstructor) {
        ownerDocument.defaultView.dispatchEvent(new CustomEventConstructor('dominion:challenge-start-date-updated', {
          detail: {
            activation: savedActivation,
            challengeStartDate: savedActivation.startDate || nextStartDate,
          },
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
      renderStartDate();
      const message = error?.message || 'Unable to save the challenge start date.';
      dialog.setDateFeedback(message);
      dialog.setError(message);
      await refresh({ includeLockState: true });
    } finally {
      if (!destroyed && submitOwnerVersion === ownerVersion) {
        dialog.setBusy(false);
        dialog.disableSave();
      }
    }
  }

  streakButton.addEventListener('click', () => { void openStreakDialog(); });
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
        dialog?.close('replaced');
        dialog?.destroy();
        dialog = null;
        currentSummary = buildStreakSummary(DEFAULT_GAME_STATS, localDateKey());
        streakCount.textContent = '—';
        if (!dialogLoadFailed) streakButton.setAttribute('aria-label', 'App streak: loading. View streak details.');
        shareButton.disabled = true;
        shareButton.setAttribute('aria-label', 'Share progress unavailable until your challenge starts.');
        currentStartDate = '';
        currentActivation = null;
        startDateLocked = true;
        previewActive = false;
      }
      void refresh();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      ownerVersion += 1;
      hydrationRequest += 1;
      dialog?.destroy();
      actionGroup.remove();
      topbar.classList.remove('has-authenticated-header-actions');
    },
  };
}
