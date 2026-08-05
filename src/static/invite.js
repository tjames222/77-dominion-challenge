import {
  activateGroupChallenge,
  confirmCrewInvite,
  getBillingState,
  getChallengeActivation,
  getCrews,
  getLocalOrSessionUser,
  previewCrewInvite,
} from './api';
import { newChallengeActivationRequestId } from './challenge-activation.mjs';
import {
  CHALLENGE_START_INTENT_PATH,
  armGroupChallengeActivation,
  bindChallengeStartIntent,
  challengeStartTimeZone,
  clearChallengeStartIntent,
  reconcileGroupChallengeStart,
  setChallengeStartIntentStage,
} from './challenge-start-intent.mjs';
import {
  TERMINAL_INVITE_STATUSES,
  buildInviteAuthHref,
  captureInviteSecret,
  clearInviteContinuation,
  getStoredInviteContinuation,
  inviteNeedsContinuation,
  inviteStatusContent,
  storeInviteContinuation,
} from './invite-flow.mjs';

const $ = (id) => document.getElementById(id);
const capturedInvite = captureInviteSecret(window);
let rawInviteSecret = capturedInvite.secret;
let latestPreview = {};
let latestServerStatus = 'invalid';
let billingState = { authenticated: false, appAccess: false };
let currentUser = null;
let groupStartIntent = null;

const actionIds = [
  'confirmInviteButton',
  'loginInviteLink',
  'registerInviteLink',
  'billingInviteLink',
  'retryInviteButton',
  'continueGroupStartButton',
  'openGroupLink',
];

function setBusy(isBusy) {
  const button = $('confirmInviteButton');
  if (!button) return;
  button.disabled = isBusy;
  if (isBusy) {
    button.textContent = groupStartIntent ? 'Joining and starting…' : 'Joining…';
  } else {
    button.textContent = groupStartIntent
      ? 'Confirm, join, and start challenge'
      : 'Confirm and join group';
  }
}

function resetActions() {
  actionIds.forEach((id) => {
    const element = $(id);
    if (element) element.hidden = true;
  });
  $('leaveInviteLink').hidden = false;
}

function visibleStatus(serverStatus) {
  if (serverStatus !== 'ready') return serverStatus;
  if (!billingState.authenticated) return 'authentication_required';
  if (!billingState.appAccess) return 'subscription_required';
  return 'ready';
}

function render(serverStatus, preview = {}) {
  latestServerStatus = serverStatus;
  latestPreview = preview;
  const status = visibleStatus(serverStatus);
  const content = inviteStatusContent(status, preview);

  $('inviteEyebrow').textContent = content.eyebrow;
  $('inviteTitle').textContent = content.title;
  $('inviteMessage').textContent = content.message;

  const canRevealPreview = ['ready', 'authentication_required', 'subscription_required', 'already_member', 'current_crew_conflict', 'joined', 'activation_pending', 'challenge_started'].includes(status)
    && Boolean(preview.groupName);
  $('invitePreview').hidden = !canRevealPreview;
  if (canRevealPreview) {
    $('inviteGroupName').textContent = preview.groupName;
    $('inviteInviterName').textContent = preview.inviterName || 'Dominion member';
  }

  resetActions();
  if (status === 'ready') $('confirmInviteButton').hidden = false;
  if (status === 'authentication_required') {
    $('loginInviteLink').href = buildInviteAuthHref('login');
    $('registerInviteLink').href = buildInviteAuthHref('register');
    $('loginInviteLink').hidden = false;
    $('registerInviteLink').hidden = false;
  }
  if (status === 'subscription_required') $('billingInviteLink').hidden = false;
  if (['full', 'rate_limited'].includes(status)) $('retryInviteButton').hidden = false;
  if (status === 'activation_pending') $('continueGroupStartButton').hidden = false;
  if (['already_member', 'current_crew_conflict', 'joined'].includes(status)) $('openGroupLink').hidden = false;
  if (status === 'challenge_started') $('openGroupLink').hidden = false;
  if (groupStartIntent && ['already_member', 'current_crew_conflict'].includes(status)) {
    $('openGroupLink').href = CHALLENGE_START_INTENT_PATH;
  } else {
    $('openGroupLink').href = './community.html';
  }
  if (['joined', 'challenge_started'].includes(status)) $('leaveInviteLink').hidden = true;
}

async function bindCurrentGroupStartIntent() {
  currentUser = billingState.authenticated ? await getLocalOrSessionUser() : null;
  groupStartIntent = bindChallengeStartIntent(sessionStorage, currentUser?.userId);
  setBusy(false);
  return groupStartIntent;
}

async function resolveJoinedCrewId(preferredCrewId = '') {
  if (preferredCrewId) return preferredCrewId;
  const crews = await getCrews();
  return crews[0]?.id || '';
}

async function reconcilePendingGroupStart() {
  if (!groupStartIntent || !currentUser?.userId) return 'none';
  const [activation, crews] = await Promise.all([
    getChallengeActivation({ expectedUserId: currentUser.userId }),
    getCrews(),
  ]);
  return reconcileGroupChallengeStart(groupStartIntent, {
    activation,
    crewIds: crews.map((crew) => crew.id),
  });
}

async function continueGroupChallengeStart() {
  groupStartIntent = bindChallengeStartIntent(sessionStorage, currentUser?.userId);
  if (!groupStartIntent || groupStartIntent.stage !== 'activation_pending') {
    render('session_expired');
    return false;
  }

  const button = $('continueGroupStartButton');
  const priorLabel = button?.textContent;
  if (button) {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = 'Starting challenge…';
  }
  try {
    await activateGroupChallenge({
      crewId: groupStartIntent.crewId,
      timeZone: groupStartIntent.timeZone,
      requestId: groupStartIntent.activationRequestId,
      expectedUserId: currentUser.userId,
    });
    const outcome = await reconcilePendingGroupStart();
    if (outcome !== 'complete') {
      throw new Error('Your start was received but could not be verified. Continue with the same request.');
    }
    clearChallengeStartIntent(sessionStorage);
    groupStartIntent = null;
    render('challenge_started', latestPreview);
    return true;
  } catch (error) {
    render('activation_pending', latestPreview);
    $('inviteMessage').textContent = error?.message
      || 'Your membership is active. Continue the same protected request to finish starting.';
    return false;
  } finally {
    if (button) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = priorLabel || 'Continue starting challenge';
    }
  }
}

async function armStartAfterMembership(crewId) {
  if (!groupStartIntent || !currentUser?.userId || !crewId) return null;
  const requestId = groupStartIntent.activationRequestId || newChallengeActivationRequestId();
  const timeZone = groupStartIntent.timeZone || challengeStartTimeZone();
  groupStartIntent = armGroupChallengeActivation(sessionStorage, {
    actorId: currentUser.userId,
    crewId,
    requestId,
    timeZone,
  });
  return groupStartIntent;
}

async function loadInvite() {
  try {
    billingState = await getBillingState();
    await bindCurrentGroupStartIntent();
    const continuationToken = getStoredInviteContinuation(sessionStorage);
    if (!rawInviteSecret && !continuationToken) {
      if (groupStartIntent?.stage === 'activation_pending') {
        const outcome = await reconcilePendingGroupStart();
        if (outcome === 'complete') {
          clearChallengeStartIntent(sessionStorage);
          groupStartIntent = null;
          render('challenge_started', latestPreview);
        } else if (outcome === 'activation_pending') {
          render('activation_pending', latestPreview);
        } else {
          clearChallengeStartIntent(sessionStorage);
          groupStartIntent = null;
          render('invalid');
        }
        return;
      }
      render('invalid');
      return;
    }

    const response = await previewCrewInvite({
      token: rawInviteSecret || '',
      continuationToken: rawInviteSecret ? '' : continuationToken,
    });
    rawInviteSecret = '';

    if (response.continuationToken) {
      storeInviteContinuation(sessionStorage, response.continuationToken);
    }
    if (TERMINAL_INVITE_STATUSES.has(response.status) && response.status !== 'joined') {
      clearInviteContinuation(sessionStorage);
    }
    if (!inviteNeedsContinuation(response.status) && response.status === 'session_expired') {
      clearInviteContinuation(sessionStorage);
    }

    if (response.status === 'already_member' && groupStartIntent?.activationRequestId) {
      const crewId = await resolveJoinedCrewId(response.crewId);
      if (await armStartAfterMembership(crewId)) {
        clearInviteContinuation(sessionStorage);
        render('activation_pending', response.preview || {});
        return;
      }
    }

    render(response.status, response.preview || {});
  } catch {
    rawInviteSecret = '';
    render('rate_limited');
  }
}

$('confirmInviteButton')?.addEventListener('click', async () => {
  const continuationToken = getStoredInviteContinuation(sessionStorage);
  if (!continuationToken || latestServerStatus !== 'ready') {
    render('session_expired');
    return;
  }

  setBusy(true);
  try {
    if (groupStartIntent && currentUser?.userId) {
      const activationRequestId = groupStartIntent.activationRequestId
        || newChallengeActivationRequestId();
      const timeZone = groupStartIntent.timeZone || challengeStartTimeZone();
      groupStartIntent = setChallengeStartIntentStage(
        sessionStorage,
        'membership_pending',
        { activationRequestId, timeZone },
      );
      if (!groupStartIntent) {
        throw new Error('This Group start request expired. Return to the dashboard and try again.');
      }
    }
    const response = await confirmCrewInvite(continuationToken, {
      expectedUserId: currentUser?.userId || '',
    });
    if (response.status === 'joined') {
      clearInviteContinuation(sessionStorage);
      if (response.crewId) localStorage.setItem('dominion:activeCrewId', response.crewId);
    }
    if (groupStartIntent && ['joined', 'already_member'].includes(response.status)) {
      const crewId = await resolveJoinedCrewId(response.crewId);
      if (await armStartAfterMembership(crewId)) {
        clearInviteContinuation(sessionStorage);
        render('activation_pending', response.preview || latestPreview);
        await continueGroupChallengeStart();
        return;
      }
    }
    render(response.status, response.preview || latestPreview);
  } catch {
    render(groupStartIntent?.stage === 'activation_pending' ? 'activation_pending' : 'rate_limited');
  } finally {
    setBusy(false);
  }
});

$('retryInviteButton')?.addEventListener('click', () => {
  $('inviteTitle').textContent = 'Checking invitation…';
  $('inviteMessage').textContent = 'No membership change will happen until you confirm.';
  loadInvite();
});

$('continueGroupStartButton')?.addEventListener('click', () => {
  void continueGroupChallengeStart();
});

$('leaveInviteLink')?.addEventListener('click', () => {
  if (!groupStartIntent) return;
  clearChallengeStartIntent(sessionStorage);
  groupStartIntent = null;
});

loadInvite();
