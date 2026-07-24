import {
  advanceCrewTraining,
  claimCrewTraining,
  createCrew,
  deleteCrew,
  getBillingState,
  getCrews,
  getCrewMembers,
  getCrewTrainingProgress,
  getJournalEntries,
  getLeaderboard,
  hasSupabaseAuth,
  isLocalDemoMode,
  leaveCrew,
  manageGroupIntegration,
  redirectToLogin,
  saveJournalEntry,
} from './api';
import { acquireDialogLayer, createConfirmationDialog } from './dialog.mjs';
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

const GROUP_INTEGRATIONS_ENABLED = groupIntegrationsEnabled(
  import.meta.env.VITE_ENABLE_GROUP_INTEGRATIONS,
);

const tabs = Array.from(document.querySelectorAll('.community-tab'));
const panels = Array.from(document.querySelectorAll('.community-panel'));
const $ = (id) => document.getElementById(id);
const todayKey = () => new Date().toISOString().slice(0, 10);
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
  activeCrewId: localStorage.getItem('dominion:activeCrewId') || '',
  crewMembers: [],
  leaderboard: { window: 'week', rows: [], requestId: 0 },
  journalEntries: [],
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

function activateTab(tab, { focus = false } = {}) {
  if (!tab) return;
  const target = tab.dataset.tab;
  if (target !== 'crew' && state.trainingOpen) {
    closeCrewTraining({ restoreFocus: false, force: true });
  }
  tabs.forEach((item) => {
    const selected = item === tab;
    item.classList.toggle('active', selected);
    item.setAttribute('aria-selected', String(selected));
    item.tabIndex = selected ? 0 : -1;
  });
  panels.forEach((panel) => {
    const selected = panel.id === target;
    panel.classList.toggle('active', selected);
    panel.hidden = !selected;
  });
  if (focus) tab.focus();
}

tabs.forEach((tab, index) => {
  tab.tabIndex = tab.classList.contains('active') ? 0 : -1;
  tab.addEventListener('click', () => activateTab(tab));
  tab.addEventListener('keydown', (event) => {
    let nextIndex = null;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    activateTab(tabs[nextIndex], { focus: true });
  });
});

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
  const dimensions = { medium: 42, leaderboard: 40, small: 30, tiny: 26 };
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
        <div class="leaderboard-identity">
          ${avatarMarkup({ ...row, size: 'leaderboard' })}
          <div class="leaderboard-player">
            <strong>${escapeHtml(row.name)}</strong>
            <small>${dayLabelText} · ${row.currentAppStreak || 0} day app streak</small>
            ${badges}
          </div>
        </div>
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
  const createForm = $('crewForm');
  const manageCard = $('crewManageCard');
  const membersCard = $('crewMembersCard');
  const integrationsCard = $('crewIntegrationsCard');
  const lifecycleCard = $('crewLifecycleCard');
  const title = $('crewTitle');
  const description = $('crewDescription');

  if (createCard) createCard.hidden = !view.showCreateCard;
  if (openCreateButton) {
    openCreateButton.hidden = !view.showCreateButton;
    openCreateButton.setAttribute('aria-expanded', String(view.showCreateForm));
  }
  if (createForm) createForm.hidden = !view.showCreateForm;
  if (manageCard) manageCard.hidden = !view.showActiveCrew;
  if (membersCard) membersCard.hidden = !crew;
  if (integrationsCard) integrationsCard.hidden = !crew || !GROUP_INTEGRATIONS_ENABLED;
  if (lifecycleCard) lifecycleCard.hidden = !crew;

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
      state.activeCrewId = setup.crewId;
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
    <article class="member-chip">
      ${avatarMarkup(member)}
      <div>
        <strong>${escapeHtml(member.name)}</strong>
        <span>${escapeHtml(member.role === 'owner' ? 'Group leader' : member.role === 'admin' ? 'Leader' : 'Member')}</span>
      </div>
    </article>
  `).join('');
}

function renderJournal() {
  const timeline = $('journalTimeline');
  if (!timeline) return;
  if (!state.journalEntries.length) {
    timeline.innerHTML = emptyCard('Your private journal is ready. Save a note and start building the record.');
    return;
  }

  timeline.innerHTML = state.journalEntries.map((entry) => `
    <article class="card timeline-note">
      <span>${entry.day ? `Day ${entry.day}` : escapeHtml(entry.date)}</span>
      <strong>${escapeHtml(entry.win || entry.mood || 'Private entry')}</strong>
      ${entry.note ? `<p>${escapeHtml(entry.note)}</p>` : ''}
      ${entry.prayer ? `<p>${escapeHtml(entry.prayer)}</p>` : ''}
      ${entry.energy ? `<small>Energy: ${escapeHtml(entry.energy)}</small>` : ''}
    </article>
  `).join('');
}

function fillJournalFormForDate() {
  const selectedDate = $('journalDate')?.value || todayKey();
  const entry = state.journalEntries.find((item) => item.date === selectedDate);
  $('journalNote').value = entry?.note || '';
  $('journalWin').value = entry?.win || '';
  $('journalPrayer').value = entry?.prayer || '';
  $('journalMood').value = entry?.mood || '';
  $('journalEnergy').value = entry?.energy || '';
}

async function refreshCrew() {
  renderCrewShell();
  const crew = activeCrew();
  if (!crew) {
    await loadCrewTrainingProgress();
    return;
  }
  const requestedCrewId = crew.id;
  state.crewMembers = [];
  renderMembers({ loading: true });

  const membersPromise = getCrewMembers(requestedCrewId)
    .then((members) => {
      if (state.activeCrewId !== requestedCrewId) return;
      state.crewMembers = members;
      renderMembers();
    })
    .catch((error) => {
      if (state.activeCrewId !== requestedCrewId) return;
      renderMembers({ error: error?.message || 'Member activity is unavailable right now.' });
    });

  await Promise.all([
    membersPromise,
    refreshLeaderboard(),
    loadCrewIntegrations(),
    loadCrewTrainingProgress(),
  ]);
}

async function refreshJournal() {
  state.journalEntries = await getJournalEntries();
  renderJournal();
  fillJournalFormForDate();
}

async function refreshCrews() {
  state.crews = await getCrews();
  state.crewsLoaded = true;
  state.activeCrewId = state.crews[0]?.id || '';
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
  continueLegacyInviteIfPresent();
  if (new URLSearchParams(window.location.search).has('invite')) return;
  $('crewStartDateInput').value = todayKey();
  $('journalDate').value = todayKey();

  if (!hasSupabaseAuth() && !isLocalDemoMode()) {
    redirectToLogin('./community.html');
    return;
  }

  state.billing = await getBillingState();
  if (!state.billing.authenticated) {
    redirectToLogin('./community.html');
    return;
  }
  if (!state.billing.appAccess) {
    window.location.href = './billing.html?intent=subscription';
    return;
  }

  takeIntegrationCallbackFragment();
  if (isLocalDemoMode()) {
    setFeedback(GROUP_INTEGRATIONS_ENABLED
      ? 'Preview mode: groups, leaderboards, integrations, and journal entries use local mock data.'
      : 'Preview mode: groups, leaderboards, and journal entries use local mock data. External channel connections are safely off.');
  }
  await Promise.all([refreshCrews(), refreshJournal()]);
  await loadIntegrationSetup();
}

function setCrewFormOpen(open, { focus = true } = {}) {
  state.createFormOpen = Boolean(open);
  renderCrewShell();
  if (!focus) return;
  const target = state.createFormOpen ? $('crewNameInput') : $('openCrewFormButton');
  target?.focus();
}

$('openCrewFormButton')?.addEventListener('click', () => setCrewFormOpen(true));
$('cancelCrewFormButton')?.addEventListener('click', () => {
  $('crewForm')?.reset();
  $('crewStartDateInput').value = todayKey();
  state.createRequestId = '';
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
      state.activeCrewId = result.destination.crewId;
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
  const release = setButtonBusy(button, 'Creating...');
  try {
    state.createRequestId ||= newCrewLifecycleRequestId();
    const crew = await createCrew({
      name: $('crewNameInput').value.trim(),
      description: $('crewDescriptionInput').value.trim(),
      challengeStartDate: $('crewStartDateInput').value,
      requestId: state.createRequestId,
    });
    state.activeCrewId = crew.id;
    localStorage.setItem('dominion:activeCrewId', crew.id);
    event.target.reset();
    $('crewStartDateInput').value = todayKey();
    state.createRequestId = '';
    state.createFormOpen = false;
    setFeedback(`${crew.name} is ready. Copy the invite link when you want to bring people in.`);
    await refreshCrews();
    const authoritativeCrew = activeCrew();
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


$('journalDate')?.addEventListener('change', fillJournalFormForDate);

$('journalForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const release = setButtonBusy(event.submitter, 'Saving...');
  try {
    const crew = activeCrew();
    await saveJournalEntry({
      date: $('journalDate').value,
      day: crew?.challengeStartDate ? Number(dayLabel(crew.challengeStartDate).replace('Day ', '')) : null,
      note: $('journalNote').value.trim(),
      win: $('journalWin').value.trim(),
      prayer: $('journalPrayer').value.trim(),
      mood: $('journalMood').value,
      energy: $('journalEnergy').value,
    });

    setFeedback('Private journal entry saved.');
    await refreshJournal();
  } catch (error) {
    window.alert(error?.message || 'Unable to save your journal entry right now.');
  } finally {
    release();
  }
});

bootCommunity().catch((error) => {
  console.warn('Unable to load community', error);
  setFeedback(error?.message || 'Unable to load community right now.');
});
