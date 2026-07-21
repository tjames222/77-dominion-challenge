import {
  confirmCrewInvite,
  getBillingState,
  previewCrewInvite,
} from './api';
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

const actionIds = [
  'confirmInviteButton',
  'loginInviteLink',
  'registerInviteLink',
  'billingInviteLink',
  'retryInviteButton',
  'openGroupLink',
];

function setBusy(isBusy) {
  const button = $('confirmInviteButton');
  if (!button) return;
  button.disabled = isBusy;
  button.textContent = isBusy ? 'Joining…' : 'Confirm and join group';
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

  const canRevealPreview = ['ready', 'authentication_required', 'subscription_required', 'already_member', 'joined'].includes(status)
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
  if (['already_member', 'joined'].includes(status)) $('openGroupLink').hidden = false;
  if (status === 'joined') $('leaveInviteLink').hidden = true;
}

async function loadInvite() {
  const continuationToken = getStoredInviteContinuation(sessionStorage);
  if (!rawInviteSecret && !continuationToken) {
    render('invalid');
    return;
  }

  try {
    billingState = await getBillingState();
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
    const response = await confirmCrewInvite(continuationToken);
    if (response.status === 'joined') {
      clearInviteContinuation(sessionStorage);
      if (response.crewId) localStorage.setItem('dominion:activeCrewId', response.crewId);
    }
    render(response.status, response.preview || latestPreview);
  } catch {
    render('rate_limited');
  } finally {
    setBusy(false);
  }
});

$('retryInviteButton')?.addEventListener('click', () => {
  $('inviteTitle').textContent = 'Checking invitation…';
  $('inviteMessage').textContent = 'No membership change will happen until you confirm.';
  loadInvite();
});

loadInvite();
