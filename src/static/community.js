import {
  activateGroupChallenge,
  advanceCrewTraining,
  claimCrewTraining,
  createCrew,
  createCrewAndActivateGroup,
  deleteCrew,
  getBillingState,
  getChallengeActivation,
  getCrews,
  getCrewMembers,
  getCrewMemberProgressProfile,
  getCrewTrainingProgress,
  getLeaderboard,
  getLocalOrSessionUser,
  hasSupabaseAuth,
  isLocalDemoMode,
  leaveCrew,
  manageGroupIntegration,
  redirectToLogin,
  subscribeToAuthStateChanges,
} from './api';
import { newChallengeActivationRequestId } from './challenge-activation.mjs';
import {
  CHALLENGE_START_INTENT_PATH,
  armGroupChallengeActivation,
  bindChallengeStartIntent,
  captureChallengeStartIntent,
  challengeStartTimeZone,
  clearChallengeStartIntent,
  clearChallengeStartIntentMarker,
  readChallengeStartIntent,
  reconcileGroupChallengeStart,
  setChallengeStartIntentStage,
} from './challenge-start-intent.mjs';
import { acquireDialogLayer, createConfirmationDialog, createDialog } from './dialog.mjs';
import {
  crewLifecycleAction,
  crewViewState,
  newCrewLifecycleRequestId,
} from './crew-experience.mjs';
import { groupIntegrationsEnabled } from './group-integration-launch.mjs';
import {
  CREW_TRAINING_STEP_COUNT,
  CREW_TRAINING_VERSION,
  buildCrewTrainingSteps,
  crewTrainingActionLabel,
} from './crew-training.mjs';
import {
  MEMBER_PROGRESS_BADGE_PAGE_SIZE,
  MEMBER_PROGRESS_UNAVAILABLE,
  createMemberProgressRevalidationGate,
  createMemberProgressRequestGate,
  memberProgressRoleLabel,
  mergeMemberProgressBadgePage,
} from './member-progress-profile.mjs';
import { initCrewInviteDialog } from './crew-invite-dialog.js';

const GROUP_INTEGRATIONS_ENABLED = groupIntegrationsEnabled(
  import.meta.env.VITE_ENABLE_GROUP_INTEGRATIONS,
);

const $ = (id) => document.getElementById(id);
const todayKey = () => new Date().toISOString().slice(0, 10);
const COMMUNITY_RETURN_PATH = './community.html';
const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#039;',
}[char]));

const state = {
  billing: null,
  crews: [],
  crewsLoaded: false,
  createFormOpen: false,
  createRequestId: '',
  currentUser: null,
  challengeActivation: null,
  groupStartIntent: null,
  groupStartDialog: null,
  activeCrewId: localStorage.getItem('dominion:activeCrewId') || '',
  crewMembers: [],
  leaderboard: { window: 'week', rows: [], requestId: 0 },
  memberProgress: {
    announcement: '',
    crewId: '',
    dialog: null,
    gate: createMemberProgressRequestGate(),
    revalidationGate: createMemberProgressRevalidationGate(),
    loading: false,
    loadingMore: false,
    memberId: '',
    profile: null,
    trigger: null,
    unavailable: false,
  },
  integrations: [],
  integrationSetupToken: '',
  integrationSetup: null,
  trainingCrewId: '',
  trainingProgress: null,
  trainingOpen: false,
  trainingMode: 'live',
  trainingStep: 0,
  trainingTrigger: null,
  trainingTarget: null,
  trainingDialogOwner: null,
  trainingRequestId: 0,
  trainingBusy: false,
  trainingPositionFrame: 0,
};

function setFeedback(message = '') {
  const feedback = $('communityFeedback');
  if (!feedback) return;
  feedback.textContent = message;
  feedback.classList.toggle('active', Boolean(message));
}

function setButtonBusy(button, label) {
  if (!button) return () => {};
  const original = button.innerHTML;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = label;
  return () => {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.innerHTML = original;
  };
}

function initials(name = 'Member') {
  return String(name)
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] || '')
    .join('')
    .toUpperCase() || 'M';
}

function avatarMarkup({ name = 'Member', avatarUrl = '', size = 'medium', decorative = false } = {}) {
  const label = `${name}'s profile photo`;
  const dimensions = { large: 72, medium: 42, leaderboard: 40, small: 30, tiny: 26 };
  const dimension = dimensions[size] || dimensions.medium;
  const accessibility = decorative
    ? 'aria-hidden="true"'
    : avatarUrl
      ? ''
      : `role="img" aria-label="${escapeHtml(label)}"`;
  return `
    <span class="member-avatar ${size}" data-profile-avatar ${accessibility}>
      <span class="avatar-fallback" aria-hidden="true">${escapeHtml(initials(name))}</span>
      ${avatarUrl ? `<img data-profile-avatar-image src="${escapeHtml(avatarUrl)}" alt="${decorative ? '' : escapeHtml(label)}" width="${dimension}" height="${dimension}" loading="lazy" decoding="async" />` : ''}
    </span>
  `;
}

document.addEventListener('error', (event) => {
  const image = event.target.closest?.('[data-profile-avatar-image]');
  if (!image) return;
  const avatar = image.closest('[data-profile-avatar]');
  image.hidden = true;
  if (avatar && avatar.getAttribute('aria-hidden') !== 'true') {
    avatar.setAttribute('role', 'img');
    avatar.setAttribute('aria-label', image.alt || 'Profile photo unavailable; showing initials');
  }
}, true);

function isCrewLeader() {
  return ['owner', 'admin'].includes(activeCrew()?.role);
}

function dayLabel(startDate) {
  if (!startDate) return 'Day 1';
  const start = new Date(`${startDate}T00:00:00`);
  const today = new Date(`${todayKey()}T00:00:00`);
  const day = Math.max(1, Math.floor((today - start) / 86400000) + 1);
  return `Day ${day}`;
}

function activeCrew() {
  return state.crews.find((crew) => crew.id === state.activeCrewId) || null;
}

function abandonGroupChallengeStart(message = 'Group challenge start canceled. Nothing changed.') {
  clearChallengeStartIntent(sessionStorage);
  clearChallengeStartIntentMarker(window);
  state.groupStartIntent = null;
  state.groupStartDialog = null;
  setFeedback(message);
}

async function refreshChallengeActivation() {
  if (!state.currentUser?.userId) return null;
  state.challengeActivation = await getChallengeActivation({
    expectedUserId: state.currentUser.userId,
  });
  return state.challengeActivation;
}

function openGroupStartConfirmation(crew, { continuation = false } = {}) {
  if (!crew || !state.groupStartIntent || state.groupStartDialog) return;
  const startDate = crew.challengeStartDate || 'the group’s selected date';
  const dialog = createConfirmationDialog({
    id: 'group-challenge-start-confirmation',
    title: continuation ? 'Finish starting your Group challenge?' : `Start with ${crew.name}?`,
    description: continuation
      ? `Your membership in ${crew.name} is ready. Continue to bind your challenge to its ${startDate} start date.`
      : `${crew.name} starts on ${startDate}. Your challenge will use that group-owned date and cannot later switch to Solo mode.`,
    cancelLabel: 'Cancel',
    confirmLabel: continuation ? 'Continue Starting' : 'Confirm Group Start',
    pendingLabel: 'Starting challenge…',
    closeOnBackdrop: false,
    onCancel: () => abandonGroupChallengeStart(),
    onConfirm: async () => {
      const actorId = state.currentUser?.userId || '';
      let intent = bindChallengeStartIntent(sessionStorage, actorId);
      if (!intent) throw new Error('This start request expired. Return to the dashboard and try again.');
      const requestId = intent.crewId === crew.id && intent.activationRequestId
        ? intent.activationRequestId
        : newChallengeActivationRequestId();
      const timeZone = intent.timeZone || challengeStartTimeZone();
      intent = armGroupChallengeActivation(sessionStorage, {
        actorId,
        crewId: crew.id,
        requestId,
        timeZone,
      });
      if (!intent) throw new Error('The signed-in account changed. Refresh and try again.');
      state.groupStartIntent = intent;

      await activateGroupChallenge({
        crewId: crew.id,
        timeZone,
        requestId,
        expectedUserId: actorId,
      });
      const activation = await refreshChallengeActivation();
      const outcome = reconcileGroupChallengeStart(intent, {
        activation,
        crewIds: state.crews.map((item) => item.id),
      });
      if (outcome !== 'complete') {
        throw new Error('Your start was received but could not be verified. Continue with the same request.');
      }
      clearChallengeStartIntent(sessionStorage);
      clearChallengeStartIntentMarker(window);
      state.groupStartIntent = null;
      setFeedback(`${crew.name} is now your Group challenge.`);
    },
    onClose: ({ reason }) => {
      if (['escape', 'close-button'].includes(reason) && state.groupStartIntent) {
        abandonGroupChallengeStart();
      }
      state.groupStartDialog = null;
      dialog.destroy();
    },
  });
  state.groupStartDialog = dialog;
  dialog.open($('crewManageCard') || $('openCrewFormButton'));
}

async function resumeGroupChallengeStart() {
  const intent = state.groupStartIntent;
  if (!intent) return;
  const activation = state.challengeActivation || await refreshChallengeActivation();
  const outcome = reconcileGroupChallengeStart(intent, {
    activation,
    crewIds: state.crews.map((crew) => crew.id),
  });

  if (outcome === 'complete') {
    clearChallengeStartIntent(sessionStorage);
    clearChallengeStartIntentMarker(window);
    state.groupStartIntent = null;
    setFeedback('Your Group challenge start is confirmed.');
    return;
  }
  if (outcome === 'conflict') {
    abandonGroupChallengeStart('Your challenge already has a different confirmed start. Nothing was changed.');
    return;
  }
  if (outcome === 'unavailable') {
    setFeedback('Challenge start details are temporarily unavailable. Refresh to try again.');
    return;
  }
  if (outcome === 'membership_missing') {
    state.groupStartIntent = setChallengeStartIntentStage(sessionStorage, 'choose_group', {
      crewId: null,
      activationRequestId: null,
      timeZone: null,
    });
    if (!state.groupStartIntent) {
      abandonGroupChallengeStart('This Group start request expired. Return to the dashboard and try again.');
      return;
    }
  }

  const crew = activeCrew();
  if (crew) {
    const continuation = state.groupStartIntent?.stage === 'activation_pending';
    if (!continuation) {
      state.groupStartIntent = setChallengeStartIntentStage(
        sessionStorage,
        'confirm_group',
        { crewId: crew.id },
      );
    }
    openGroupStartConfirmation(crew, { continuation });
    return;
  }

  state.createFormOpen = true;
  setFeedback('Create your group below, or open a private invitation in this tab. Nothing starts until you confirm.');
  renderCrewShell();
  $('crewNameInput')?.focus();
}

function crewTrainingSteps() {
  return buildCrewTrainingSteps({
    integrationsEnabled: GROUP_INTEGRATIONS_ENABLED,
    crewName: activeCrew()?.name || 'Your crew',
  });
}

function isCrewTrainingTargetAvailable(element) {
  if (!element || element.hidden || element.closest?.('[hidden]')) return false;
  const styles = window.getComputedStyle?.(element);
  if (styles && (styles.display === 'none' || styles.visibility === 'hidden')) return false;
  return Boolean(element.getClientRects?.().length);
}

function boundedCrewTrainingStep(value) {
  const numericValue = Number(value);
  const step = Number.isFinite(numericValue) ? Math.trunc(numericValue) : 0;
  return Math.max(0, Math.min(CREW_TRAINING_STEP_COUNT - 1, step));
}

function renderCrewTrainingLaunch() {
  const button = $('crewTrainingButton');
  if (!button) return;
  const crew = activeCrew();
  const available = Boolean(
    crew
      && isCrewLeader()
      && state.trainingCrewId === crew.id
      && state.trainingProgress,
  );
  button.hidden = !available;
  if (!available) return;
  button.textContent = crewTrainingActionLabel(state.trainingProgress);
}

function clearCrewTrainingTarget() {
  state.trainingTarget?.classList.remove('crew-training-target');
  state.trainingTarget = null;
}

function setCrewTrainingError(message = '') {
  const error = $('crewTrainingError');
  if (!error) return;
  error.textContent = message;
  error.hidden = !message;
}

function setCrewTrainingBusy(busy) {
  state.trainingBusy = Boolean(busy);
  const coachmark = $('crewTrainingCoachmark');
  if (coachmark) {
    if (busy) coachmark.setAttribute('aria-busy', 'true');
    else coachmark.removeAttribute('aria-busy');
  }
  ['crewTrainingBack', 'crewTrainingSkip', 'crewTrainingNext', 'crewTrainingClose']
    .forEach((id) => {
      const button = $(id);
      if (button) button.disabled = Boolean(busy);
    });
}

function releaseCrewTrainingDialog() {
  const owner = state.trainingDialogOwner;
  state.trainingDialogOwner = null;
  owner?.release();
}

function closeCrewTraining({ restoreFocus = true, force = false } = {}) {
  if (state.trainingBusy && !force) return false;
  const trigger = state.trainingTrigger;
  state.trainingRequestId += 1;
  state.trainingOpen = false;
  state.trainingTrigger = null;
  clearCrewTrainingTarget();
  releaseCrewTrainingDialog();
  setCrewTrainingError('');
  const layer = $('crewTrainingLayer');
  if (layer) {
    layer.hidden = true;
    layer.classList.remove('is-modal');
    layer.setAttribute('aria-hidden', 'true');
  }
  if (restoreFocus) {
    const fallback = $('crewTrainingButton');
    const focusTarget = trigger?.isConnected && !trigger.hidden ? trigger : fallback;
    focusTarget?.focus?.({ preventScroll: true });
  }
  return true;
}

function crewTrainingTargetForStep(step, index) {
  if (index === 0 || !step?.targetId) return null;
  const target = document.getElementById(step.targetId);
  return isCrewTrainingTargetAvailable(target) ? target : null;
}

function positionCrewTrainingCoachmark() {
  if (!state.trainingOpen || !state.trainingTarget) return;
  const layer = $('crewTrainingLayer');
  const coachmark = $('crewTrainingCoachmark');
  if (!layer || !coachmark || layer.classList.contains('is-modal')) return;
  if (window.matchMedia?.('(max-width: 520px)').matches) {
    coachmark.style.removeProperty('--crew-training-left');
    coachmark.style.removeProperty('--crew-training-top');
    return;
  }

  const targetBounds = state.trainingTarget.getBoundingClientRect();
  const coachmarkBounds = coachmark.getBoundingClientRect();
  const margin = 16;
  const gap = 14;
  const maxLeft = Math.max(margin, window.innerWidth - coachmarkBounds.width - margin);
  const left = Math.min(Math.max(targetBounds.left, margin), maxLeft);
  let top = targetBounds.bottom + gap;
  if (top + coachmarkBounds.height > window.innerHeight - margin) {
    top = targetBounds.top - coachmarkBounds.height - gap;
  }
  top = Math.min(
    Math.max(top, margin),
    Math.max(margin, window.innerHeight - coachmarkBounds.height - margin),
  );
  coachmark.style.setProperty('--crew-training-left', `${Math.round(left)}px`);
  coachmark.style.setProperty('--crew-training-top', `${Math.round(top)}px`);
}

function queueCrewTrainingPosition() {
  if (!state.trainingOpen || !state.trainingTarget || state.trainingPositionFrame) return;
  state.trainingPositionFrame = window.requestAnimationFrame?.(() => {
    state.trainingPositionFrame = 0;
    positionCrewTrainingCoachmark();
  }) || 0;
}

function revealCrewTrainingTarget(target) {
  if (!target) return;
  const mobile = window.matchMedia?.('(max-width: 520px)').matches;
  const reveal = () => {
    if (!state.trainingOpen || state.trainingTarget !== target) return;
    const bounds = target.getBoundingClientRect();
    const coachmarkBounds = $('crewTrainingCoachmark')?.getBoundingClientRect();
    const safeTop = mobile ? 92 : 16;
    const safeBottom = mobile && coachmarkBounds
      ? coachmarkBounds.top - 48
      : window.innerHeight - 16;
    const outsideVisibleContext = bounds.top < safeTop || bounds.bottom > safeBottom;
    if (outsideVisibleContext) {
      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      target.scrollIntoView?.({
        block: mobile ? 'start' : 'center',
        behavior: reduceMotion ? 'auto' : 'smooth',
      });
    }
    queueCrewTrainingPosition();
  };
  reveal();
  if (mobile) window.requestAnimationFrame?.(reveal);
}

function renderCrewTrainingStep({ focus = false } = {}) {
  if (!state.trainingOpen) return;
  const steps = crewTrainingSteps();
  const stepIndex = boundedCrewTrainingStep(state.trainingStep);
  const step = steps[stepIndex];
  if (!step) {
    closeCrewTraining({ restoreFocus: true, force: true });
    return;
  }
  state.trainingStep = stepIndex;

  const layer = $('crewTrainingLayer');
  const coachmark = $('crewTrainingCoachmark');
  if (!layer || !coachmark) return;
  clearCrewTrainingTarget();
  coachmark.style.removeProperty('--crew-training-left');
  coachmark.style.removeProperty('--crew-training-top');

  const expectedTarget = step.targetId ? document.getElementById(step.targetId) : null;
  const target = crewTrainingTargetForStep(step, stepIndex);
  const modal = !target;
  if (target) {
    state.trainingTarget = target;
    target.classList.add('crew-training-target');
  }

  layer.hidden = false;
  layer.setAttribute('aria-hidden', 'false');
  layer.classList.toggle('is-modal', modal);
  if (modal) coachmark.setAttribute('aria-modal', 'true');
  else coachmark.removeAttribute('aria-modal');

  $('crewTrainingProgress').textContent = `${state.trainingMode === 'replay' ? 'Replay · ' : ''}Step ${stepIndex + 1} of ${steps.length}`;
  $('crewTrainingTitle').textContent = step.title;
  $('crewTrainingDescription').textContent = step.description;
  const targetNote = $('crewTrainingTargetNote');
  const unavailable = Boolean(
    stepIndex !== 0 && step.targetId && (!expectedTarget || !target),
  );
  if (targetNote) {
    targetNote.textContent = step.targetUnavailableDescription
      || 'This step is informational because its on-page target is not currently available.';
    targetNote.hidden = !unavailable;
  }
  coachmark.setAttribute(
    'aria-describedby',
    unavailable
      ? 'crewTrainingDescription crewTrainingTargetNote'
      : 'crewTrainingDescription',
  );
  $('crewTrainingBack').hidden = stepIndex === 0;
  $('crewTrainingSkip').hidden = state.trainingMode === 'replay';
  $('crewTrainingNext').textContent = stepIndex === steps.length - 1 ? 'Finish' : 'Next';
  setCrewTrainingError('');

  if (modal && !state.trainingDialogOwner) {
    state.trainingDialogOwner = acquireDialogLayer({
      document,
      layer,
      panel: coachmark,
      onEscape: () => closeCrewTraining(),
      onReplace: () => closeCrewTraining({ restoreFocus: false, force: true }),
    });
  } else if (!modal) {
    releaseCrewTrainingDialog();
  }

  if (target) revealCrewTrainingTarget(target);
  if (focus) {
    window.requestAnimationFrame?.(() => {
      if (!state.trainingOpen) return;
      const title = $('crewTrainingTitle');
      title?.focus?.({ preventScroll: true });
    });
  }
}

async function loadCrewTrainingProgress() {
  const crew = activeCrew();
  const requestId = state.trainingRequestId + 1;
  state.trainingRequestId = requestId;
  state.trainingCrewId = crew?.id || '';
  state.trainingProgress = null;
  renderCrewTrainingLaunch();

  if (!crew || !isCrewLeader()) {
    if (state.trainingOpen) closeCrewTraining({ restoreFocus: false, force: true });
    return null;
  }

  try {
    const progress = await getCrewTrainingProgress(crew.id, CREW_TRAINING_VERSION);
    if (state.trainingRequestId !== requestId || activeCrew()?.id !== crew.id) return null;
    state.trainingProgress = progress;
    renderCrewTrainingLaunch();
    return progress;
  } catch (error) {
    if (state.trainingRequestId !== requestId || activeCrew()?.id !== crew.id) return null;
    console.warn('Crew training is unavailable for this member', error);
    state.trainingProgress = null;
    renderCrewTrainingLaunch();
    return null;
  }
}

async function openCrewTraining({ trigger = $('crewTrainingButton'), progress = null } = {}) {
  const crew = activeCrew();
  if (!crew || !isCrewLeader()) return false;
  const requestId = state.trainingRequestId + 1;
  state.trainingRequestId = requestId;
  const release = trigger ? setButtonBusy(trigger, 'Opening…') : () => {};

  try {
    let nextProgress = progress;
    if (!nextProgress) {
      nextProgress = await getCrewTrainingProgress(crew.id, CREW_TRAINING_VERSION);
    }
    if (!nextProgress) return false;
    if (nextProgress.status === 'not_started') {
      nextProgress = await claimCrewTraining(crew.id, CREW_TRAINING_VERSION);
    } else if (nextProgress.status === 'skipped') {
      nextProgress = await advanceCrewTraining({
        crewId: crew.id,
        contentVersion: CREW_TRAINING_VERSION,
        action: 'resume',
        targetStep: boundedCrewTrainingStep(nextProgress.furthestStep),
      });
    }
    if (state.trainingRequestId !== requestId || activeCrew()?.id !== crew.id) return false;

    state.trainingCrewId = crew.id;
    state.trainingProgress = nextProgress;
    state.trainingMode = nextProgress.status === 'completed' ? 'replay' : 'live';
    state.trainingStep = state.trainingMode === 'replay'
      ? 0
      : boundedCrewTrainingStep(Math.max(nextProgress.currentStep, nextProgress.furthestStep));
    state.trainingTrigger = trigger;
    state.trainingOpen = true;
    renderCrewTrainingLaunch();
    renderCrewTrainingStep({ focus: true });
    return true;
  } catch (error) {
    setFeedback(error?.message || 'Crew training is unavailable right now.');
    return false;
  } finally {
    release();
    renderCrewTrainingLaunch();
  }
}

async function moveCrewTrainingForward() {
  if (!state.trainingOpen || state.trainingBusy) return;
  const crew = activeCrew();
  const steps = crewTrainingSteps();
  if (!crew || !steps.length) return;
  const currentStep = boundedCrewTrainingStep(state.trainingStep);
  const finalStep = currentStep === steps.length - 1;

  if (state.trainingMode === 'replay') {
    if (finalStep) closeCrewTraining();
    else {
      state.trainingStep = currentStep + 1;
      renderCrewTrainingStep({ focus: true });
    }
    return;
  }

  setCrewTrainingBusy(true);
  setCrewTrainingError('');
  try {
    const nextStep = finalStep ? currentStep : currentStep + 1;
    const progress = await advanceCrewTraining({
      crewId: crew.id,
      contentVersion: CREW_TRAINING_VERSION,
      action: finalStep ? 'complete' : 'advance',
      targetStep: nextStep,
    });
    if (!state.trainingOpen || activeCrew()?.id !== crew.id) return;
    state.trainingProgress = progress;
    renderCrewTrainingLaunch();
    if (progress.status === 'completed' || finalStep) {
      closeCrewTraining({ force: true });
      return;
    }
    const authoritativeStep = boundedCrewTrainingStep(Math.max(
      progress.currentStep,
      progress.furthestStep,
    ));
    state.trainingStep = Math.max(nextStep, authoritativeStep);
    renderCrewTrainingStep({ focus: true });
  } catch (error) {
    setCrewTrainingError(error?.message || 'Progress could not be saved. Try again.');
  } finally {
    setCrewTrainingBusy(false);
  }
}

async function skipCrewTraining() {
  if (!state.trainingOpen || state.trainingBusy) return;
  if (state.trainingMode === 'replay') {
    closeCrewTraining();
    return;
  }
  const crew = activeCrew();
  if (!crew) return;
  setCrewTrainingBusy(true);
  setCrewTrainingError('');
  try {
    const authoritativeStep = boundedCrewTrainingStep(Math.max(
      state.trainingStep,
      state.trainingProgress?.currentStep ?? 0,
      state.trainingProgress?.furthestStep ?? 0,
    ));
    const progress = await advanceCrewTraining({
      crewId: crew.id,
      contentVersion: CREW_TRAINING_VERSION,
      action: 'skip',
      targetStep: authoritativeStep,
    });
    if (!state.trainingOpen || activeCrew()?.id !== crew.id) return;
    state.trainingProgress = progress;
    renderCrewTrainingLaunch();
    closeCrewTraining({ force: true });
  } catch (error) {
    setCrewTrainingError(error?.message || 'Progress could not be saved. Try again.');
  } finally {
    setCrewTrainingBusy(false);
  }
}

function emptyCard(message) {
  return `<article class="empty-state card"><p>${escapeHtml(message)}</p></article>`;
}

function badgeChip(badge) {
  return `<span class="badge-chip ${badge.tier || 'bronze'}"><span>${escapeHtml(badge.name || 'Badge')}</span></span>`;
}

function memberProgressTriggerLabel(name = 'Member') {
  return `View ${name || 'Member'}’s level and badges`;
}

function ensureMemberProgressDialog() {
  const progress = state.memberProgress;
  if (progress.dialog) return progress.dialog;
  progress.dialog = createDialog({
    id: 'member-progress-dialog',
    title: 'Member progress',
    eyebrow: 'Private Group',
    description: 'Read-only lifetime level and earned badges for a current member of this private group.',
    closeLabel: 'Close member progress',
    presentation: 'responsive',
    onClose: () => {
      progress.gate.invalidate();
      progress.revalidationGate.reset();
      progress.announcement = '';
      progress.crewId = '';
      progress.loading = false;
      progress.loadingMore = false;
      progress.memberId = '';
      progress.profile = null;
      progress.trigger = null;
      progress.unavailable = false;
      scrubMemberProgressDialog();
    },
  });
  progress.dialog.elements.panel.classList.add('member-progress-dialog');
  return progress.dialog;
}

function scrubMemberProgressDialog() {
  const dialog = state.memberProgress.dialog;
  if (!dialog) return;
  dialog.clearError();
  dialog.elements.content.replaceChildren();
  dialog.elements.content.removeAttribute('aria-busy');
}

function memberProgressBadgeMarkup(badge) {
  const tier = badge.tier === 'gold' ? 'gold' : badge.tier === 'silver' ? 'silver' : 'bronze';
  return `
    <article class="member-progress-badge" data-badge-tier="${tier}">
      <span class="member-progress-badge-icon app-icon icon-${escapeHtml(badge.icon || 'shield')}" aria-hidden="true"></span>
      <div>
        <p class="member-progress-badge-tier">${escapeHtml(tier)} badge</p>
        <h4>${escapeHtml(badge.name || 'Badge')}</h4>
        <p>${escapeHtml(badge.description || 'Earned through faithful progress.')}</p>
      </div>
    </article>
  `;
}

function renderMemberProgressDialog() {
  const progress = state.memberProgress;
  const dialog = ensureMemberProgressDialog();
  const { content } = dialog.elements;
  content.classList.add('member-progress-content');
  content.setAttribute('aria-busy', String(progress.loading || progress.loadingMore));

  if (progress.loading) {
    dialog.clearError();
    content.innerHTML = `
      <div class="member-progress-loading" role="status" aria-live="polite">
        <span class="skeleton member-progress-avatar-skeleton" aria-hidden="true"></span>
        <div aria-hidden="true">
          <span class="skeleton member-progress-line-skeleton"></span>
          <span class="skeleton member-progress-line-skeleton short"></span>
        </div>
        <span class="sr-only">Loading member progress…</span>
      </div>
    `;
    return;
  }

  if (progress.unavailable || !progress.profile) {
    dialog.setError(MEMBER_PROGRESS_UNAVAILABLE);
    content.innerHTML = `
      <div class="member-progress-unavailable">
        <span class="app-icon icon-shield" aria-hidden="true"></span>
        <h3>${escapeHtml(MEMBER_PROGRESS_UNAVAILABLE)}</h3>
        <p>This private-group view may have changed. Retry to verify access again.</p>
        <button class="secondary" type="button" data-member-progress-retry>Try again</button>
      </div>
    `;
    return;
  }

  dialog.clearError();
  const profile = progress.profile;
  const loadedCount = profile.badges.length;
  const summary = `${loadedCount} of ${profile.badgeCount} badges loaded`;
  const badgeCollection = loadedCount
    ? `<div class="member-progress-badges">${profile.badges.map(memberProgressBadgeMarkup).join('')}</div>`
    : `
      <div class="member-progress-empty">
        <span class="app-icon icon-shield" aria-hidden="true"></span>
        <p>No badges earned yet. This member’s shelf is ready for the first one.</p>
      </div>
    `;
  content.innerHTML = `
    <section class="member-progress-summary" aria-label="${escapeHtml(profile.displayName)} progress summary">
      ${avatarMarkup({
        name: profile.displayName,
        avatarUrl: profile.avatarUrl,
        size: 'large',
      })}
      <div class="member-progress-identity">
        <p class="member-progress-role">${escapeHtml(memberProgressRoleLabel(profile.role))}</p>
        <h3>${escapeHtml(profile.displayName)}</h3>
        <div class="member-progress-stats" aria-label="Level and earned badge count">
          <span><strong>Level ${profile.level}</strong><small>Lifetime level</small></span>
          <span><strong>${profile.badgeCount}</strong><small>${profile.badgeCount === 1 ? 'Earned badge' : 'Earned badges'}</small></span>
        </div>
      </div>
    </section>
    <section class="member-progress-collection" aria-labelledby="memberProgressBadgesTitle">
      <div class="member-progress-collection-heading">
        <div>
          <p class="eyebrow">Earned Badges</p>
          <h3 id="memberProgressBadgesTitle">Proof of the work</h3>
        </div>
        <span>${profile.badgeCount}</span>
      </div>
      ${badgeCollection}
      <p class="member-progress-announcement" tabindex="-1" role="status" aria-live="polite" aria-atomic="true">${escapeHtml(progress.announcement || summary)}</p>
      ${profile.hasMore ? `
        <button class="secondary member-progress-load-more" type="button" data-member-progress-load-more>
          Load more badges
        </button>
      ` : ''}
    </section>
  `;
}

function showMemberProgressUnavailable() {
  const progress = state.memberProgress;
  progress.loading = false;
  progress.loadingMore = false;
  progress.profile = null;
  progress.unavailable = true;
  progress.announcement = '';
  renderMemberProgressDialog();
}

function clearMemberProgress({ close = true, reason = 'access-changed' } = {}) {
  const progress = state.memberProgress;
  progress.gate.invalidate();
  progress.revalidationGate.reset();
  progress.announcement = '';
  progress.crewId = '';
  progress.loading = false;
  progress.loadingMore = false;
  progress.memberId = '';
  progress.profile = null;
  progress.trigger = null;
  progress.unavailable = false;
  if (close && progress.dialog?.isOpen) progress.dialog.close(reason);
  scrubMemberProgressDialog();
}

function setActiveCrewId(nextCrewId = '') {
  const normalized = String(nextCrewId || '');
  if (normalized !== state.activeCrewId) clearMemberProgress({ reason: 'crew-change' });
  state.activeCrewId = normalized;
}

async function openMemberProgress(trigger, memberId) {
  const crew = activeCrew();
  const progress = state.memberProgress;
  if (!crew || !memberId || !state.currentUser?.userId) return false;
  if (progress.loading && progress.gate.pendingFor(crew.id, memberId, 'profile')) return false;

  progress.revalidationGate.reset();
  const request = progress.gate.begin({ crewId: crew.id, memberId, kind: 'profile' });
  progress.announcement = '';
  progress.crewId = crew.id;
  progress.loading = true;
  progress.loadingMore = false;
  progress.memberId = memberId;
  progress.profile = null;
  progress.trigger = trigger;
  progress.unavailable = false;
  renderMemberProgressDialog();
  ensureMemberProgressDialog().open(trigger);

  try {
    const profile = await getCrewMemberProgressProfile({
      crewId: crew.id,
      userId: memberId,
      limit: MEMBER_PROGRESS_BADGE_PAGE_SIZE,
      expectedUserId: state.currentUser.userId,
    });
    if (!progress.gate.isCurrent(request, {
      crewId: activeCrew()?.id || '',
      memberId: progress.memberId,
    })) return false;
    progress.loading = false;
    progress.profile = profile;
    progress.unavailable = false;
    progress.announcement = `${profile.badges.length} of ${profile.badgeCount} badges loaded`;
    renderMemberProgressDialog();
    return true;
  } catch {
    if (!progress.gate.isCurrent(request, {
      crewId: activeCrew()?.id || '',
      memberId: progress.memberId,
    })) return false;
    showMemberProgressUnavailable();
    return false;
  }
}

async function revalidateOpenMemberProgress({ bypassCooldown = false } = {}) {
  const progress = state.memberProgress;
  const crew = activeCrew();
  const actorId = state.currentUser?.userId || '';
  const memberId = progress.memberId;
  const contextIsCurrent = Boolean(
    progress.dialog?.isOpen
      && progress.profile
      && !progress.loading
      && crew?.id
      && actorId
      && progress.crewId === crew.id
      && progress.profile.memberId === memberId
  );
  if (!contextIsCurrent) {
    if (progress.dialog?.isOpen && (
      !crew?.id
      || !actorId
      || progress.crewId !== crew.id
      || (progress.profile && progress.profile.memberId !== memberId)
    )) {
      clearMemberProgress({ reason: 'access-context-changed' });
    }
    return false;
  }

  const revalidation = progress.revalidationGate.begin({ bypassCooldown });
  if (!revalidation) return false;
  const request = progress.gate.begin({
    crewId: crew.id,
    memberId,
    kind: 'revalidate',
  });
  progress.announcement = '';
  progress.loading = true;
  progress.loadingMore = false;
  progress.profile = null;
  progress.unavailable = false;
  renderMemberProgressDialog();

  try {
    const profile = await getCrewMemberProgressProfile({
      crewId: crew.id,
      userId: memberId,
      limit: MEMBER_PROGRESS_BADGE_PAGE_SIZE,
      expectedUserId: actorId,
    });
    if (!progress.dialog?.isOpen || !progress.gate.isCurrent(request, {
      crewId: activeCrew()?.id || '',
      memberId: progress.memberId,
    })) return false;
    progress.loading = false;
    progress.profile = profile;
    progress.unavailable = false;
    progress.announcement = `${profile.badges.length} of ${profile.badgeCount} badges loaded`;
    renderMemberProgressDialog();
    return true;
  } catch {
    if (!progress.dialog?.isOpen || !progress.gate.isCurrent(request, {
      crewId: activeCrew()?.id || '',
      memberId: progress.memberId,
    })) return false;
    showMemberProgressUnavailable();
    return false;
  } finally {
    progress.revalidationGate.finish(revalidation);
  }
}

async function loadMoreMemberProgressBadges(button) {
  const progress = state.memberProgress;
  const profile = progress.profile;
  const crew = activeCrew();
  if (!crew || !profile?.hasMore || !profile.nextCursor || progress.loadingMore) return false;
  const request = progress.gate.begin({
    crewId: crew.id,
    memberId: profile.memberId,
    kind: 'badges',
  });
  progress.loadingMore = true;
  progress.announcement = 'Loading more badges…';
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = 'Loading badges…';
  const status = ensureMemberProgressDialog().elements.content.querySelector('.member-progress-announcement');
  if (status) status.textContent = progress.announcement;

  try {
    const nextPage = await getCrewMemberProgressProfile({
      crewId: crew.id,
      userId: profile.memberId,
      cursor: profile.nextCursor,
      limit: MEMBER_PROGRESS_BADGE_PAGE_SIZE,
      expectedUserId: state.currentUser?.userId || '',
    });
    if (!progress.gate.isCurrent(request, {
      crewId: activeCrew()?.id || '',
      memberId: progress.memberId,
    })) return false;
    progress.profile = mergeMemberProgressBadgePage(profile, nextPage);
    progress.loadingMore = false;
    progress.announcement = `${progress.profile.badges.length} of ${progress.profile.badgeCount} badges loaded`;
    renderMemberProgressDialog();
    const nextFocus = ensureMemberProgressDialog().elements.content.querySelector(
      '[data-member-progress-load-more], .member-progress-announcement',
    );
    nextFocus?.focus?.({ preventScroll: true });
    return true;
  } catch {
    if (!progress.gate.isCurrent(request, {
      crewId: activeCrew()?.id || '',
      memberId: progress.memberId,
    })) return false;
    showMemberProgressUnavailable();
    ensureMemberProgressDialog().elements.content.querySelector('[data-member-progress-retry]')
      ?.focus?.({ preventScroll: true });
    return false;
  }
}

function reconcileOpenMemberProgress(members, crewId) {
  const progress = state.memberProgress;
  if (!progress.dialog?.isOpen || progress.crewId !== crewId || !progress.memberId) return;
  if (!members.some((member) => member.userId === progress.memberId)) {
    progress.gate.invalidate();
    showMemberProgressUnavailable();
  }
}

function renderLeaderboard() {
  const board = state.leaderboard;
  const container = $('crewLeaderboard');
  if (!board || !container) return;

  document.querySelectorAll('[data-leaderboard-window]').forEach((button) => {
    button.classList.toggle('active', button.dataset.leaderboardWindow === board.window);
  });

  const crew = activeCrew();
  if (!crew) {
    container.innerHTML = '<article class="leaderboard-empty">Create or join a crew to unlock a private leaderboard.</article>';
    return;
  }

  if (!board.rows.length) {
    container.innerHTML = '<article class="leaderboard-empty">Crew points will show here after check-ins.</article>';
    return;
  }

  container.innerHTML = board.rows.map((row) => {
    const badges = row.badges?.length
      ? `<div class="badge-shelf">${row.badges.slice(0, 3).map(badgeChip).join('')}</div>`
      : '<div class="badge-shelf"><span class="badge-empty">Badges coming soon</span></div>';
    const dayLabelText = row.latestChallengeDay ? `Day ${row.latestChallengeDay}` : 'Challenge active';
    return `
      <article class="leaderboard-row">
        <span class="leaderboard-rank">${row.rank || '-'}</span>
        <button
          class="leaderboard-identity leaderboard-member-trigger"
          type="button"
          data-member-progress-user-id="${escapeHtml(row.userId)}"
          aria-label="${escapeHtml(memberProgressTriggerLabel(row.name))}"
        >
          ${avatarMarkup({ ...row, size: 'leaderboard' })}
          <div class="leaderboard-player">
            <strong>${escapeHtml(row.name)}</strong>
            <small>${dayLabelText} · ${row.currentAppStreak || 0} day app streak</small>
            ${badges}
          </div>
        </button>
        <div class="leaderboard-points">
          <strong>${Number(row.points || 0).toLocaleString()}</strong>
          <span>pts</span>
        </div>
      </article>
    `;
  }).join('');
}

async function refreshLeaderboard() {
  const crew = activeCrew();
  const board = state.leaderboard;
  const requestedCrewId = crew?.id || '';
  const requestedWindow = board.window;
  const requestId = board.requestId + 1;
  board.requestId = requestId;
  if (!crew) {
    state.leaderboard.rows = [];
    renderLeaderboard();
    return;
  }

  try {
    const rows = await getLeaderboard({
      crewId: crew.id,
      window: requestedWindow,
    });
    const crewChanged = activeCrew()?.id !== requestedCrewId;
    if (board.requestId !== requestId || board.window !== requestedWindow || crewChanged) return;
    board.rows = rows;
  } catch (error) {
    const crewChanged = activeCrew()?.id !== requestedCrewId;
    if (board.requestId !== requestId || board.window !== requestedWindow || crewChanged) return;
    console.warn('Unable to load the private-group leaderboard', error);
    board.rows = [];
  }
  renderLeaderboard();
}

function renderCrewShell() {
  const crew = activeCrew();
  const view = crewViewState({
    loaded: state.crewsLoaded,
    crew,
    createFormOpen: state.createFormOpen,
  });
  const createCard = $('crewCreateCard');
  const openCreateButton = $('openCrewFormButton');
  const joinCrewButton = $('joinCrewButton');
  const createForm = $('crewForm');
  const manageCard = $('crewManageCard');
  const settingsButton = $('crewSettingsButton');
  const membersCard = $('crewMembersCard');
  const title = $('crewTitle');
  const description = $('crewDescription');

  if (createCard) createCard.hidden = !view.showCreateCard;
  if (openCreateButton) {
    openCreateButton.hidden = !view.showCreateButton;
    openCreateButton.setAttribute('aria-expanded', String(view.showCreateForm));
  }
  if (joinCrewButton) joinCrewButton.hidden = !view.showCreateButton;
  if (createForm) createForm.hidden = !view.showCreateForm;
  const createSubmit = createForm?.querySelector('button[type="submit"]');
  if (createSubmit) {
    createSubmit.textContent = state.groupStartIntent
      ? 'Create Crew and Start Challenge'
      : 'Create Crew';
  }
  if (manageCard) manageCard.hidden = !view.showActiveCrew;
  if (settingsButton) settingsButton.hidden = !crew;
  if (membersCard) membersCard.hidden = !crew;

  if (!crew) {
    state.trainingCrewId = '';
    state.trainingProgress = null;
    if (state.trainingOpen) closeCrewTraining({ restoreFocus: false, force: true });
    renderCrewTrainingLaunch();
    if (title) title.textContent = 'Create or join a crew.';
    if (description) description.textContent = 'Private crews keep accountability close: one start date, one channel, and people you actually know.';
    $('crewMemberCount').textContent = '0';
    $('crewDayCount').textContent = 'Day 1';
    $('crewMemberList').innerHTML = '';
    state.integrations = [];
    renderIntegrations();
    state.leaderboard.rows = [];
    renderLeaderboard();
    return;
  }

  if ($('activeCrewName')) $('activeCrewName').textContent = crew.name;
  if (title) title.textContent = crew.name;
  if (description) description.textContent = crew.description || 'A private accountability group for this 77-day challenge.';
  $('crewDayCount').textContent = dayLabel(crew.challengeStartDate);

  const lifecycleAction = crewLifecycleAction(crew.role);
  if ($('crewLifecycleEyebrow')) {
    $('crewLifecycleEyebrow').textContent = 'Group Access';
  }
  if ($('crewLifecycleTitle')) {
    $('crewLifecycleTitle').textContent = lifecycleAction === 'delete'
      ? 'Delete this group'
      : 'Leave this group';
  }
  if ($('crewLifecycleDescription')) {
    $('crewLifecycleDescription').textContent = lifecycleAction === 'delete'
      ? 'Remove access for every member and begin the retained deletion process.'
      : 'Remove only your membership. Your profile, progress, points, badges, and journal stay yours.';
  }
  if ($('crewLifecycleButton')) {
    $('crewLifecycleButton').textContent = lifecycleAction === 'delete' ? 'Delete Crew' : 'Leave Group';
    $('crewLifecycleButton').dataset.lifecycleAction = lifecycleAction;
  }
  renderCrewTrainingLaunch();
}

function integrationStatusLabel(status = '') {
  if (status === 'active') return 'Connected';
  if (status === 'reconnect_required') return 'Needs attention';
  if (status === 'disconnected' || status === 'revoked') return 'Disconnected';
  return 'Unavailable';
}

function integrationActivityLabel(destination = {}) {
  const value = destination.lastDeliveredAt || destination.lastTestedAt || destination.lastVerifiedAt;
  if (!value) return 'No successful test or delivery yet.';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Connection activity recorded.';
  return `Last verified ${date.toLocaleString()}`;
}

function integrationHealthLabel(destination = {}) {
  if (destination.correctiveAction) return destination.correctiveAction;
  if (destination.status === 'reconnect_required') return 'Reconnect this destination, then send a test update.';
  if (destination.lastErrorCode === 'provider_rate_limited') return 'The provider is rate limiting updates. Dominion will retry automatically.';
  if (destination.lastErrorCode) return 'Review the connection and send a test update.';
  if (destination.status === 'active') return 'Delivery health is good.';
  return 'Connect or reconnect this destination to deliver updates.';
}

function providerMark(provider = '') {
  if (provider === 'discord') {
    return `
      <span class="provider-mark provider-mark-discord" aria-hidden="true">
        <svg viewBox="0 0 28 24" focusable="false">
          <path d="M6.2 4.5c4.7-2.1 10.9-2.1 15.6 0 2.5 3.5 4 7.4 4.2 11.6-2.3 2.2-4.3 3.5-6.2 4.4l-1.5-2.1c.9-.4 1.8-.9 2.6-1.5-4.5 2.1-9.3 2.1-13.8 0 .8.6 1.7 1.1 2.6 1.5l-1.5 2.1c-1.9-.9-3.9-2.2-6.2-4.4.2-4.2 1.7-8.1 4.2-11.6Z" fill="#5865f2"></path>
          <circle cx="10.4" cy="12.3" r="1.8" fill="#fff"></circle>
          <circle cx="17.6" cy="12.3" r="1.8" fill="#fff"></circle>
        </svg>
      </span>
    `;
  }
  return `
    <span class="provider-mark provider-mark-slack" aria-hidden="true">
      <svg viewBox="0 0 24 24" focusable="false">
        <rect x="9" y="1" width="5" height="11" rx="2.5" fill="#36c5f0"></rect>
        <rect x="12" y="9" width="11" height="5" rx="2.5" fill="#2eb67d"></rect>
        <rect x="10" y="12" width="5" height="11" rx="2.5" fill="#ecb22e"></rect>
        <rect x="1" y="10" width="11" height="5" rx="2.5" fill="#e01e5a"></rect>
      </svg>
    </span>
  `;
}

function integrationEventSummary(destination = {}) {
  const events = [
    ['Daily Check-Ins', destination.checkInsEnabled],
    ['Streak milestones', destination.streakMilestonesEnabled],
    ['Badges & rewards', destination.badgesRewardsEnabled],
    ['New members', destination.membershipEnabled],
    ['Weekly leaderboard recap', destination.recapCadence === 'weekly'],
  ];
  return `
    <div class="integration-event-summary" aria-label="External update settings">
      <strong>Updates that can leave Dominion</strong>
      <ul>
        ${events.map(([label, enabled]) => `
          <li class="${enabled ? 'enabled' : 'disabled'}">
            <span aria-hidden="true">${enabled ? 'On' : 'Off'}</span>
            ${escapeHtml(label)}
          </li>
        `).join('')}
      </ul>
    </div>
  `;
}

function integrationSettingsForm(destination = {}) {
  if (!destination.canManage || !isCrewLeader()) return '';
  return `
    <form class="integration-settings" data-integration-settings="${escapeHtml(destination.id)}">
      <fieldset>
        <legend>Channel update settings</legend>
        <label><input type="checkbox" name="checkInsEnabled" ${destination.checkInsEnabled ? 'checked' : ''} /> Daily Check-Ins</label>
        <label><input type="checkbox" name="streakMilestonesEnabled" ${destination.streakMilestonesEnabled ? 'checked' : ''} /> Streak milestones</label>
        <label><input type="checkbox" name="badgesRewardsEnabled" ${destination.badgesRewardsEnabled ? 'checked' : ''} /> Badges &amp; rewards</label>
        <label><input type="checkbox" name="membershipEnabled" ${destination.membershipEnabled ? 'checked' : ''} /> New group members</label>
        <label><input type="checkbox" name="includeSafeLink" ${destination.includeSafeLink ? 'checked' : ''} /> Include a safe link to Dominion</label>
      </fieldset>
      <label class="integration-recap-cadence">
        <span>Leaderboard recap</span>
        <select name="recapCadence">
          <option value="off" ${destination.recapCadence !== 'weekly' ? 'selected' : ''}>Off</option>
          <option value="weekly" ${destination.recapCadence === 'weekly' ? 'selected' : ''}>Weekly</option>
        </select>
      </label>
      <button class="secondary compact" type="submit">Save update settings</button>
    </form>
  `;
}

function renderIntegrations({ loading = false, error = '' } = {}) {
  const container = $('integrationDestinationList');
  const actions = $('integrationConnectActions');
  const crew = activeCrew();
  if (!container || !actions) return;

  if (!GROUP_INTEGRATIONS_ENABLED || !crew) {
    container.innerHTML = '';
    actions.hidden = true;
    return;
  }
  if (loading) {
    container.innerHTML = '<p class="integration-disclosure">Loading connected destinations…</p>';
    actions.hidden = true;
    return;
  }
  if (error) {
    container.innerHTML = `<p class="inline-error">${escapeHtml(error)}</p>`;
    actions.hidden = !isCrewLeader();
    return;
  }

  const canManage = isCrewLeader();
  if (!state.integrations.length) {
    container.innerHTML = '<p class="integration-disclosure">No external channels are connected. Group progress stays inside Dominion.</p>';
  } else {
    container.innerHTML = state.integrations.map((destination) => {
      const status = destination.status || 'disconnected';
      const provider = destination.provider === 'discord' ? 'discord' : 'slack';
      const providerName = provider === 'discord' ? 'Discord' : 'Slack';
      const actionMarkup = canManage && destination.canManage ? `
        <div class="integration-destination-actions">
          ${status === 'active' ? `<button class="provider-button provider-${provider} provider-secondary" type="button" data-test-integration="${escapeHtml(destination.id)}">Test ${providerName}</button>` : ''}
          <button class="provider-button provider-${provider} provider-secondary" type="button" data-reconnect-provider="${provider}">Reconnect ${providerName}</button>
          ${status !== 'disconnected' ? `<button class="provider-button provider-disconnect provider-secondary" type="button" data-disconnect-integration="${escapeHtml(destination.id)}">Disconnect</button>` : ''}
        </div>
      ` : '';
      return `
        <article class="integration-destination" data-integration-status="${escapeHtml(status)}">
          <div class="integration-destination-copy">
            <div class="integration-destination-title">
              ${providerMark(provider)}
              <strong>${providerName}</strong>
              <span class="integration-status ${escapeHtml(status)}">${escapeHtml(integrationStatusLabel(status))}</span>
            </div>
            <span>${escapeHtml(destination.workspaceName || destination.workspaceId || 'Workspace')} · #${escapeHtml(destination.channelName || destination.channelId || 'channel')}</span>
            <small>${escapeHtml(integrationActivityLabel(destination))}</small>
            <small class="integration-health-detail">${escapeHtml(integrationHealthLabel(destination))}</small>
            ${integrationEventSummary(destination)}
            ${integrationSettingsForm(destination)}
          </div>
          ${actionMarkup}
        </article>
      `;
    }).join('');
  }

  const configured = new Set(state.integrations.map((item) => item.provider));
  actions.querySelectorAll('[data-connect-provider]').forEach((button) => {
    button.hidden = configured.has(button.dataset.connectProvider);
  });
  actions.hidden = !canManage || configured.size >= 2;
}

async function loadCrewIntegrations() {
  const crew = activeCrew();
  if (!GROUP_INTEGRATIONS_ENABLED || !crew) {
    state.integrations = [];
    renderIntegrations();
    return;
  }
  const requestedCrewId = crew.id;
  renderIntegrations({ loading: true });
  try {
    const result = await manageGroupIntegration('list', { crewId: requestedCrewId });
    if (state.activeCrewId !== requestedCrewId) return;
    state.integrations = Array.isArray(result.destinations) ? result.destinations : [];
    renderIntegrations();
  } catch (error) {
    if (state.activeCrewId !== requestedCrewId) return;
    state.integrations = [];
    renderIntegrations({ error: error?.message || 'Connected destinations are unavailable right now.' });
  }
}

function renderIntegrationSetup() {
  const form = $('integrationConfirmForm');
  const select = $('integrationChannelSelect');
  const setup = state.integrationSetup;
  if (!form || !select) return;
  form.hidden = !GROUP_INTEGRATIONS_ENABLED || !setup;
  if (!GROUP_INTEGRATIONS_ENABLED || !setup) return;
  $('integrationConfirmTitle').textContent = `Choose a ${setup.provider === 'slack' ? 'Slack' : 'Discord'} channel`;
  $('integrationConfirmWorkspace').textContent = setup.workspace?.name || 'Authorized workspace';
  select.innerHTML = (setup.channels || []).map((item) => (
    `<option value="${escapeHtml(item.id)}">#${escapeHtml(item.name)}${item.kind === 'private' ? ' · private' : ''}</option>`
  )).join('');
  select.disabled = !(setup.channels || []).length;
  form.querySelector('button[type="submit"]').disabled = !(setup.channels || []).length;
  if (!(setup.channels || []).length) {
    setFeedback(`Add the Dominion app to a ${setup.provider} channel, then reconnect and try again.`);
  }
}

function takeIntegrationCallbackFragment() {
  if (!window.location.hash) return;
  const params = new URLSearchParams(window.location.hash.slice(1));
  const setupToken = params.get('integration-setup');
  const integrationError = params.get('integration-error');
  if (!setupToken && !integrationError) return;
  window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}`);
  if (!GROUP_INTEGRATIONS_ENABLED) {
    state.integrationSetupToken = '';
    state.integrationSetup = null;
    setFeedback('Slack and Discord connections are currently unavailable. Nothing was connected.');
    return;
  }
  if (setupToken) state.integrationSetupToken = setupToken;
  if (integrationError) {
    setFeedback(integrationError === 'authorization_denied'
      ? 'Provider authorization was canceled. Nothing was connected.'
      : 'Provider authorization could not be completed. Try connecting again.');
  }
}

async function loadIntegrationSetup() {
  if (!GROUP_INTEGRATIONS_ENABLED || !state.integrationSetupToken) return;
  try {
    const setup = await manageGroupIntegration('channels', {
      setupToken: state.integrationSetupToken,
    });
    if (setup.crewId && state.crews.some((crew) => crew.id === setup.crewId)) {
      setActiveCrewId(setup.crewId);
      localStorage.setItem('dominion:activeCrewId', setup.crewId);
      renderCrewShell();
    }
    state.integrationSetup = setup;
    renderIntegrationSetup();
  } catch (error) {
    state.integrationSetupToken = '';
    state.integrationSetup = null;
    renderIntegrationSetup();
    setFeedback(error?.message || 'That integration setup expired. Start the connection again.');
  }
}

async function beginIntegrationAuthorization(selectedProvider, button) {
  const crew = activeCrew();
  if (!GROUP_INTEGRATIONS_ENABLED || !crew || !isCrewLeader()) return;
  const release = setButtonBusy(button, 'Opening…');
  try {
    const result = await manageGroupIntegration('begin', {
      crewId: crew.id,
      provider: selectedProvider,
    });
    const authorization = new URL(result.authorizationUrl);
    if (!['slack.com', 'discord.com'].includes(authorization.hostname)) {
      throw new Error('The provider returned an invalid authorization destination.');
    }
    window.location.assign(authorization.toString());
  } catch (error) {
    release();
    setFeedback(error?.message || `Unable to connect ${selectedProvider} right now.`);
  }
}

function renderMembers({ loading = false, error = '' } = {}) {
  $('crewMemberCount').textContent = String(state.crewMembers.length);
  const container = $('crewMemberList');
  if (!container) return;
  if (loading) {
    container.innerHTML = Array.from({ length: 3 }, () => `
      <div class="member-chip member-chip-loading" aria-hidden="true">
        <span class="skeleton skeleton-avatar"></span>
        <span class="skeleton skeleton-line"></span>
      </div>
    `).join('');
    return;
  }
  if (error) {
    container.innerHTML = `<p class="inline-error">${escapeHtml(error)}</p>`;
    return;
  }
  container.innerHTML = state.crewMembers.map((member) => `
    <button
      class="member-chip member-progress-trigger"
      type="button"
      data-member-progress-user-id="${escapeHtml(member.userId)}"
      aria-label="${escapeHtml(memberProgressTriggerLabel(member.name))}"
    >
      ${avatarMarkup(member)}
      <div>
        <strong>${escapeHtml(member.name)}</strong>
        <span>${escapeHtml(memberProgressRoleLabel(member.role))}</span>
      </div>
    </button>
  `).join('');
}

async function refreshCrewRoster(requestedCrewId, { revalidateProfile = true } = {}) {
  state.crewMembers = [];
  renderMembers({ loading: true });

  try {
    const members = await getCrewMembers(requestedCrewId);
    if (state.activeCrewId !== requestedCrewId) return;
    state.crewMembers = members;
    renderMembers();
    reconcileOpenMemberProgress(members, requestedCrewId);
  } catch (error) {
    if (state.activeCrewId !== requestedCrewId) return;
    renderMembers({ error: error?.message || 'Member activity is unavailable right now.' });
  } finally {
    if (revalidateProfile && state.activeCrewId === requestedCrewId) {
      await revalidateOpenMemberProgress({ bypassCooldown: true });
    }
  }
}

async function refreshCrew() {
  renderCrewShell();
  const crew = activeCrew();
  if (!crew) {
    await loadCrewTrainingProgress();
    return;
  }
  const requestedCrewId = crew.id;
  const membersPromise = refreshCrewRoster(requestedCrewId);

  await Promise.all([
    membersPromise,
    refreshLeaderboard(),
    loadCrewTrainingProgress(),
  ]);
}

async function refreshCrews() {
  state.crews = await getCrews();
  state.crewsLoaded = true;
  setActiveCrewId(state.crews[0]?.id || '');
  if (state.activeCrewId) {
    localStorage.setItem('dominion:activeCrewId', state.activeCrewId);
  } else {
    localStorage.removeItem('dominion:activeCrewId');
  }
  await refreshCrew();
}

function continueLegacyInviteIfPresent() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('invite');
  if (!token) return;
  window.location.replace(`./invite.html#invite=${encodeURIComponent(token)}`);
}

async function bootCommunity() {
  if (new URLSearchParams(window.location.search).get('view') === 'journal') {
    window.location.replace('./private-journal.html');
    return;
  }
  state.groupStartIntent = captureChallengeStartIntent(sessionStorage, window.location);
  continueLegacyInviteIfPresent();
  if (new URLSearchParams(window.location.search).has('invite')) return;
  $('crewStartDateInput').value = todayKey();

  if (!hasSupabaseAuth() && !isLocalDemoMode()) {
    redirectToLogin(state.groupStartIntent ? CHALLENGE_START_INTENT_PATH : COMMUNITY_RETURN_PATH);
    return;
  }

  state.billing = await getBillingState();
  if (!state.billing.authenticated) {
    redirectToLogin(state.groupStartIntent ? CHALLENGE_START_INTENT_PATH : COMMUNITY_RETURN_PATH);
    return;
  }
  if (!state.billing.appAccess) {
    window.location.href = './billing.html?intent=subscription';
    return;
  }

  state.currentUser = await getLocalOrSessionUser();
  state.groupStartIntent = bindChallengeStartIntent(
    sessionStorage,
    state.currentUser?.userId,
  );

  if (isLocalDemoMode()) {
    setFeedback(GROUP_INTEGRATIONS_ENABLED
      ? 'Preview mode: groups, leaderboards, and integrations use local mock data.'
      : 'Preview mode: groups and leaderboards use local mock data. External channel connections are safely off.');
  }
  await Promise.all([refreshCrews(), refreshChallengeActivation()]);
  await resumeGroupChallengeStart();
}

function setCrewFormOpen(open, { focus = true } = {}) {
  state.createFormOpen = Boolean(open);
  renderCrewShell();
  if (!focus) return;
  const target = state.createFormOpen ? $('crewNameInput') : $('openCrewFormButton');
  target?.focus();
}

$('openCrewFormButton')?.addEventListener('click', () => setCrewFormOpen(true));
$('joinCrewButton')?.addEventListener('click', () => {
  window.location.href = './invite.html';
});
$('cancelCrewFormButton')?.addEventListener('click', () => {
  $('crewForm')?.reset();
  $('crewStartDateInput').value = todayKey();
  state.createRequestId = '';
  if (state.groupStartIntent) abandonGroupChallengeStart();
  setCrewFormOpen(false);
});

$('crewTrainingButton')?.addEventListener('click', (event) => {
  void openCrewTraining({ trigger: event.currentTarget });
});
$('crewTrainingBack')?.addEventListener('click', () => {
  if (!state.trainingOpen || state.trainingBusy || state.trainingStep <= 0) return;
  state.trainingStep -= 1;
  renderCrewTrainingStep({ focus: true });
});
$('crewTrainingNext')?.addEventListener('click', () => {
  void moveCrewTrainingForward();
});
$('crewTrainingSkip')?.addEventListener('click', () => {
  void skipCrewTraining();
});
$('crewTrainingClose')?.addEventListener('click', () => closeCrewTraining());
$('crewTrainingLayer')?.addEventListener('click', (event) => {
  if (event.target.classList.contains('crew-training-backdrop')) closeCrewTraining();
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !state.trainingOpen || state.trainingDialogOwner) return;
  event.preventDefault();
  closeCrewTraining();
});
document.addEventListener('click', (event) => {
  if (!state.trainingOpen || state.trainingDialogOwner) return;
  const interactiveTarget = event.target.closest?.(
    'a[href], button, input, select, textarea, summary, [contenteditable="true"], [tabindex]:not([tabindex="-1"])',
  );
  if (!interactiveTarget || $('crewTrainingCoachmark')?.contains(interactiveTarget)) return;
  closeCrewTraining({ restoreFocus: false, force: true });
}, { capture: true });
window.addEventListener('resize', queueCrewTrainingPosition, { passive: true });
window.addEventListener('scroll', queueCrewTrainingPosition, { passive: true });

['crewMemberList', 'crewLeaderboard'].forEach((containerId) => {
  $(containerId)?.addEventListener('click', (event) => {
    const trigger = event.target.closest?.('[data-member-progress-user-id]');
    if (!trigger || !event.currentTarget.contains(trigger)) return;
    void openMemberProgress(trigger, trigger.dataset.memberProgressUserId);
  });
});

document.addEventListener('click', (event) => {
  const dialog = state.memberProgress.dialog;
  if (!dialog?.isOpen || !dialog.elements.content.contains(event.target)) return;
  const retry = event.target.closest?.('[data-member-progress-retry]');
  if (retry) {
    void openMemberProgress(state.memberProgress.trigger || retry, state.memberProgress.memberId);
    return;
  }
  const loadMore = event.target.closest?.('[data-member-progress-load-more]');
  if (loadMore) void loadMoreMemberProgressBadges(loadMore);
});

$('crewLifecycleButton')?.addEventListener('click', (event) => {
  const crew = activeCrew();
  if (!crew) return;
  const action = crewLifecycleAction(crew.role);
  const requestId = newCrewLifecycleRequestId();
  const isDelete = action === 'delete';
  const dialog = createConfirmationDialog({
    id: 'crew-lifecycle-confirmation',
    title: 'Are you sure?',
    description: isDelete
      ? `Deleting ${crew.name} removes access for every member, revokes invitations, stops external delivery, and begins the retained deletion process. Personal profiles, progress, points, badges, and journals are not deleted.`
      : `Leaving ${crew.name} removes only your membership. You will lose access to its roster, leaderboard, invitations, and integrations. Your profile, progress, points, badges, and journal remain yours.`,
    cancelLabel: 'Cancel',
    confirmLabel: isDelete ? 'Delete Crew' : 'Leave Group',
    pendingLabel: isDelete ? 'Deleting…' : 'Leaving…',
    destructive: true,
    alert: true,
    closeOnBackdrop: false,
    onConfirm: async () => {
      clearMemberProgress({ reason: isDelete ? 'crew-delete' : 'crew-leave' });
      if (isDelete) await deleteCrew({ crewId: crew.id, requestId });
      else await leaveCrew({ crewId: crew.id, requestId });
      state.createFormOpen = false;
      await refreshCrews();
      setFeedback(isDelete
        ? `${crew.name} was deleted. Member access and external delivery stopped immediately.`
        : `You left ${crew.name}. Your personal Dominion data was preserved.`);
    },
    onClose: () => dialog.destroy(),
  });
  dialog.open(event.currentTarget);
});

$('crewIntegrationsCard')?.addEventListener('click', async (event) => {
  if (!GROUP_INTEGRATIONS_ENABLED) return;
  const connectButton = event.target.closest('[data-connect-provider]');
  const reconnectButton = event.target.closest('[data-reconnect-provider]');
  if (connectButton || reconnectButton) {
    const button = connectButton || reconnectButton;
    const selectedProvider = button.dataset.connectProvider || button.dataset.reconnectProvider;
    await beginIntegrationAuthorization(selectedProvider, button);
    return;
  }

  const testButton = event.target.closest('[data-test-integration]');
  if (testButton) {
    const release = setButtonBusy(testButton, 'Testing…');
    try {
      await manageGroupIntegration('test', { destinationId: testButton.dataset.testIntegration });
      setFeedback('Test update delivered. The external channel is ready.');
      await loadCrewIntegrations();
    } catch (error) {
      setFeedback(error?.message || 'The integration test could not be delivered.');
      await loadCrewIntegrations();
    } finally {
      release();
    }
    return;
  }

  const disconnectButton = event.target.closest('[data-disconnect-integration]');
  if (!disconnectButton) return;
  const confirmed = window.confirm('Disconnect this external channel? Queued updates will be canceled immediately.');
  if (!confirmed) return;
  const release = setButtonBusy(disconnectButton, 'Disconnecting…');
  try {
    const result = await manageGroupIntegration('disconnect', {
      destinationId: disconnectButton.dataset.disconnectIntegration,
    });
    setFeedback(result.providerRevoked
      ? 'External channel disconnected and provider access revoked.'
      : 'External channel disconnected. Dominion credentials and queued updates were removed.');
    await loadCrewIntegrations();
  } catch (error) {
    setFeedback(error?.message || 'Unable to disconnect that channel right now.');
  } finally {
    release();
  }
});

$('crewIntegrationsCard')?.addEventListener('submit', async (event) => {
  if (!GROUP_INTEGRATIONS_ENABLED) return;
  const form = event.target.closest('[data-integration-settings]');
  if (!form) return;
  event.preventDefault();
  const destination = state.integrations.find((item) => item.id === form.dataset.integrationSettings);
  if (!destination?.canManage || !isCrewLeader()) return;
  const values = new FormData(form);
  const submitButton = form.querySelector('button[type="submit"]');
  const release = setButtonBusy(submitButton, 'Saving…');
  try {
    await manageGroupIntegration('configure', {
      destinationId: destination.id,
      checkInsEnabled: values.has('checkInsEnabled'),
      streakMilestonesEnabled: values.has('streakMilestonesEnabled'),
      badgesRewardsEnabled: values.has('badgesRewardsEnabled'),
      membershipEnabled: values.has('membershipEnabled'),
      recapCadence: values.get('recapCadence') === 'weekly' ? 'weekly' : 'off',
      includeSafeLink: values.has('includeSafeLink'),
    });
    setFeedback('External update settings saved. New and queued deliveries use the current settings.');
    await loadCrewIntegrations();
  } catch (error) {
    setFeedback(error?.message || 'Unable to save external update settings.');
  } finally {
    release();
  }
});

$('integrationConfirmForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!GROUP_INTEGRATIONS_ENABLED || !state.integrationSetupToken || !state.integrationSetup) return;
  const submitButton = event.currentTarget.querySelector('button[type="submit"]');
  const release = setButtonBusy(submitButton, 'Confirming…');
  try {
    const result = await manageGroupIntegration('confirm', {
      setupToken: state.integrationSetupToken,
      channelId: $('integrationChannelSelect').value,
    });
    state.integrationSetupToken = '';
    state.integrationSetup = null;
    renderIntegrationSetup();
    if (result.destination?.crewId && result.destination.crewId !== state.activeCrewId) {
      setActiveCrewId(result.destination.crewId);
      localStorage.setItem('dominion:activeCrewId', state.activeCrewId);
      renderCrewShell();
    }
    setFeedback(`${result.destination?.provider === 'discord' ? 'Discord' : 'Slack'} channel connected.`);
    await loadCrewIntegrations();
  } catch (error) {
    setFeedback(error?.message || 'Unable to confirm that external channel.');
  } finally {
    release();
  }
});

$('cancelIntegrationSetup')?.addEventListener('click', () => {
  state.integrationSetupToken = '';
  state.integrationSetup = null;
  renderIntegrationSetup();
  setFeedback('Integration setup canceled. No channel was connected.');
});

document.querySelectorAll('[data-leaderboard-window]').forEach((button) => {
  button.addEventListener('click', async () => {
    const scope = button.dataset.leaderboardScope;
    const nextWindow = button.dataset.leaderboardWindow;
    if (scope !== 'crew' || state.leaderboard.window === nextWindow) return;
    state.leaderboard.window = nextWindow;
    renderLeaderboard();
    await refreshLeaderboard();
  });
});

$('crewForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  const startingGroupChallenge = Boolean(state.groupStartIntent);
  const release = setButtonBusy(
    button,
    startingGroupChallenge ? 'Creating and starting…' : 'Creating...',
  );
  try {
    state.createRequestId ||= newCrewLifecycleRequestId();
    const crewInput = {
      name: $('crewNameInput').value.trim(),
      description: $('crewDescriptionInput').value.trim(),
      challengeStartDate: $('crewStartDateInput').value,
    };
    let crew;
    if (startingGroupChallenge) {
      const actorId = state.currentUser?.userId || '';
      const activationRequestId = state.groupStartIntent.activationRequestId
        || newChallengeActivationRequestId();
      const timeZone = state.groupStartIntent.timeZone || challengeStartTimeZone();
      state.groupStartIntent = setChallengeStartIntentStage(
        sessionStorage,
        'membership_pending',
        { activationRequestId, timeZone },
      );
      if (!state.groupStartIntent) {
        throw new Error('This Group start request expired. Return to the dashboard and try again.');
      }
      const result = await createCrewAndActivateGroup({
        ...crewInput,
        timeZone,
        crewRequestId: state.createRequestId,
        activationRequestId,
        expectedUserId: actorId,
      });
      crew = result.crew;
      state.challengeActivation = result.activation;
      state.groupStartIntent = armGroupChallengeActivation(sessionStorage, {
        actorId,
        crewId: crew.id,
        requestId: activationRequestId,
        timeZone,
      });
    } else {
      crew = await createCrew({
        ...crewInput,
        requestId: state.createRequestId,
      });
    }
    setActiveCrewId(crew.id);
    localStorage.setItem('dominion:activeCrewId', crew.id);
    event.target.reset();
    $('crewStartDateInput').value = todayKey();
    state.createRequestId = '';
    state.createFormOpen = false;
    setFeedback(startingGroupChallenge
      ? `${crew.name} is ready. Verifying your Group challenge start…`
      : `${crew.name} is ready. Use Invite People when you want to bring someone in.`);
    await refreshCrews();
    const authoritativeCrew = activeCrew();
    if (startingGroupChallenge) {
      const activation = await refreshChallengeActivation();
      const outcome = reconcileGroupChallengeStart(state.groupStartIntent, {
        activation,
        crewIds: state.crews.map((item) => item.id),
      });
      if (outcome !== 'complete') {
        throw new Error('The group was created, but its challenge start could not be verified. Refresh to continue safely.');
      }
      clearChallengeStartIntent(sessionStorage);
      clearChallengeStartIntentMarker(window);
      state.groupStartIntent = null;
      setFeedback(`${crew.name} is ready and your Group challenge is confirmed.`);
    }
    if (crew.createdNew && authoritativeCrew?.id === crew.id && isCrewLeader()) {
      try {
        const trainingProgress = await claimCrewTraining(
          authoritativeCrew.id,
          CREW_TRAINING_VERSION,
        );
        state.trainingCrewId = authoritativeCrew.id;
        state.trainingProgress = trainingProgress;
        renderCrewTrainingLaunch();
        if (trainingProgress.claimedNow) {
          await openCrewTraining({
            trigger: $('crewTrainingButton'),
            progress: trainingProgress,
          });
        }
      } catch (trainingError) {
        console.warn('The crew was created, but its training walkthrough could not start', trainingError);
      }
    }
  } catch (error) {
    window.alert(error?.message || 'Unable to create that crew right now.');
  } finally {
    release();
  }
});
function scrubPrivateCommunityState() {
  clearMemberProgress({ reason: 'auth-change' });
  state.currentUser = null;
  state.billing = null;
  state.crews = [];
  state.crewsLoaded = false;
  state.createFormOpen = false;
  state.createRequestId = '';
  state.activeCrewId = '';
  state.crewMembers = [];
  state.leaderboard.rows = [];
  state.leaderboard.requestId += 1;
  state.integrations = [];
  state.integrationSetup = null;
  state.integrationSetupToken = '';
  localStorage.removeItem('dominion:activeCrewId');
  renderCrewShell();
}

const unsubscribeMemberProgressAuth = subscribeToAuthStateChanges(({ event, user }) => {
  const signedOut = event === 'SIGNED_OUT' || !user?.authenticated;
  const accountChanged = Boolean(
    user?.userId
    && state.currentUser?.userId
    && user.userId !== state.currentUser.userId
  );
  if (!signedOut && !accountChanged) return;
  scrubPrivateCommunityState();
  if (signedOut) {
    redirectToLogin(COMMUNITY_RETURN_PATH);
  } else {
    window.location.reload();
  }
});

function revalidateMemberProgressAfterForegroundSignal() {
  if (document.visibilityState === 'hidden') return;
  void revalidateOpenMemberProgress();
}

function revalidateMemberProgressAfterReconnect() {
  const progress = state.memberProgress;
  const crewId = activeCrew()?.id || '';
  if (!progress.dialog?.isOpen || !progress.profile || progress.crewId !== crewId) return;
  void revalidateOpenMemberProgress({ bypassCooldown: true });
  void refreshCrewRoster(crewId);
}

window.addEventListener('focus', revalidateMemberProgressAfterForegroundSignal);
document.addEventListener('visibilitychange', revalidateMemberProgressAfterForegroundSignal);
window.addEventListener('pageshow', revalidateMemberProgressAfterForegroundSignal);
window.addEventListener('online', revalidateMemberProgressAfterReconnect);

window.addEventListener('storage', (event) => {
  if (![
    'dominion:user',
    'dominion:activeCrewId',
    'dominion:mockCrews',
    'dominion:mockCrewMembers',
    'dominion:mockSubscription',
  ].includes(event.key)) return;
  clearMemberProgress({ reason: 'cross-tab-access-change' });
});

let memberProgressAuthUnsubscribed = false;
window.addEventListener('pagehide', (event) => {
  clearMemberProgress({ reason: 'pagehide' });
  if (!event.persisted && !memberProgressAuthUnsubscribed) {
    memberProgressAuthUnsubscribed = true;
    unsubscribeMemberProgressAuth();
  }
});
initCrewInviteDialog({ getCrew: activeCrew });

bootCommunity().catch((error) => {
  console.warn('Unable to load community', error);
  setFeedback(error?.message || 'Unable to load community right now.');
});
