import {
  deleteCrew,
  getBillingState,
  getCrews,
  getLocalOrSessionUser,
  getOutboundIntegrationDestinations,
  getOutboundUpdateConsent,
  hasSupabaseAuth,
  isLocalDemoMode,
  leaveCrew,
  manageGroupIntegration,
  redirectToLogin,
  subscribeToAuthStateChanges,
  updateOutboundUpdateConsent,
} from './api';
import { createConfirmationDialog } from './dialog.mjs';
import {
  crewLifecycleAction,
  isCrewAdmin,
  newCrewLifecycleRequestId,
} from './crew-experience.mjs';
import { groupIntegrationsEnabled } from './group-integration-launch.mjs';

const GROUP_INTEGRATIONS_ENABLED = groupIntegrationsEnabled(
  import.meta.env.VITE_ENABLE_GROUP_INTEGRATIONS,
);
const RETURN_PATH = './group-settings.html';
const $ = (id) => document.getElementById(id);
const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#039;',
}[character]));

const state = {
  user: null,
  crew: null,
  integrations: [],
  integrationSetupToken: '',
  integrationSetup: null,
};

function setFeedback(message = '', tone = '') {
  const element = $('groupSettingsFeedback');
  if (!element) return;
  element.textContent = message;
  element.classList.toggle('active', Boolean(message));
  element.classList.toggle('error', tone === 'error');
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

function failClosedConsent() {
  return {
    consentRecorded: false,
    outboundUpdatesEnabled: false,
    presentationMode: 'anonymous',
    events: {
      checkIns: false,
      streakMilestones: false,
      badgesRewards: false,
      membership: false,
    },
  };
}

function setConsentFeedback(message = '', tone = '') {
  const element = $('integrationConsentFeedback');
  if (!element) return;
  element.textContent = message;
  element.classList.toggle('error', tone === 'error');
}

function setConsentBusy(busy, label = 'Saving…') {
  $('integrationConsentContent')?.setAttribute('aria-busy', String(busy));
  $('integrationConsentForm')?.querySelectorAll('input, button').forEach((control) => {
    control.disabled = Boolean(busy);
  });
  const button = $('saveIntegrationConsent');
  if (button) button.textContent = busy ? label : 'Save my privacy choices';
}

function renderConsent(consent = failClosedConsent()) {
  if ($('integrationUpdatesEnabled')) {
    $('integrationUpdatesEnabled').checked = Boolean(consent.outboundUpdatesEnabled);
  }
  $('integrationConsentForm')?.querySelectorAll('[name="integrationPresentation"]').forEach((control) => {
    control.checked = control.value === consent.presentationMode;
  });
  if ($('integrationShareCheckIns')) $('integrationShareCheckIns').checked = Boolean(consent.events?.checkIns);
  if ($('integrationShareStreaks')) $('integrationShareStreaks').checked = Boolean(consent.events?.streakMilestones);
  if ($('integrationShareBadges')) $('integrationShareBadges').checked = Boolean(consent.events?.badgesRewards);
  if ($('integrationShareMembership')) $('integrationShareMembership').checked = Boolean(consent.events?.membership);

  if (!consent.consentRecorded) {
    setConsentFeedback('Nothing is shared until you choose what to send and save your choices.');
  } else if (!consent.outboundUpdatesEnabled) {
    setConsentFeedback('Group updates are off. Pending attempts will be blocked.');
  } else {
    setConsentFeedback('Your choices are checked before every send and retry.');
  }
}

function renderConsentDestinations(destinations = []) {
  const list = $('integrationConsentDestinationList');
  const empty = $('integrationConsentDestinationEmpty');
  if (!list || !empty) return;
  list.innerHTML = destinations.map((destination) => {
    const platform = destination.platform === 'discord' ? 'Discord' : 'Slack';
    return `<li class="integration-destination-item"><span><strong>${escapeHtml(platform)} · ${escapeHtml(destination.name || 'Channel')}</strong><small>${escapeHtml(destination.context || `${platform} channel`)}</small></span><em>Connected</em></li>`;
  }).join('');
  empty.hidden = destinations.length > 0;
}

async function loadConsent() {
  if (!GROUP_INTEGRATIONS_ENABLED || !state.crew) return;
  renderConsent(failClosedConsent());
  renderConsentDestinations([]);
  setConsentBusy(true, 'Loading…');
  setConsentFeedback('Loading your privacy choices…');
  try {
    const [consent, destinations] = await Promise.all([
      getOutboundUpdateConsent(state.crew.id),
      getOutboundIntegrationDestinations(state.crew.id),
    ]);
    renderConsent(consent);
    renderConsentDestinations(destinations);
  } catch (error) {
    console.warn('Unable to load group update privacy', error);
    setConsentFeedback(error?.message || 'Unable to load your privacy choices.', 'error');
  } finally {
    setConsentBusy(false);
  }
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
  if (destination.status === 'reconnect_required') return 'Reconnect this channel, then send a test update.';
  if (destination.lastErrorCode === 'provider_rate_limited') return 'The provider is limiting updates. Dominion will retry automatically.';
  if (destination.lastErrorCode) return 'Review the connection and send a test update.';
  if (destination.status === 'active') return 'Delivery health is good.';
  return 'Connect or reconnect this channel to deliver updates.';
}

function providerMark(provider = '') {
  if (provider === 'discord') {
    return `<span class="provider-mark provider-mark-discord" aria-hidden="true"><svg viewBox="0 0 28 24" focusable="false"><path d="M6.2 4.5c4.7-2.1 10.9-2.1 15.6 0 2.5 3.5 4 7.4 4.2 11.6-2.3 2.2-4.3 3.5-6.2 4.4l-1.5-2.1c.9-.4 1.8-.9 2.6-1.5-4.5 2.1-9.3 2.1-13.8 0 .8.6 1.7 1.1 2.6 1.5l-1.5 2.1c-1.9-.9-3.9-2.2-6.2-4.4.2-4.2 1.7-8.1 4.2-11.6Z" fill="#5865f2"></path><circle cx="10.4" cy="12.3" r="1.8" fill="#fff"></circle><circle cx="17.6" cy="12.3" r="1.8" fill="#fff"></circle></svg></span>`;
  }
  return `<span class="provider-mark provider-mark-slack" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><rect x="9" y="1" width="5" height="11" rx="2.5" fill="#36c5f0"></rect><rect x="12" y="9" width="11" height="5" rx="2.5" fill="#2eb67d"></rect><rect x="10" y="12" width="5" height="11" rx="2.5" fill="#ecb22e"></rect><rect x="1" y="10" width="11" height="5" rx="2.5" fill="#e01e5a"></rect></svg></span>`;
}

function integrationEventSummary(destination = {}) {
  const events = [
    ['Daily Check-Ins', destination.checkInsEnabled],
    ['Streak milestones', destination.streakMilestonesEnabled],
    ['Badges & rewards', destination.badgesRewardsEnabled],
    ['New members', destination.membershipEnabled],
    ['Weekly leaderboard recap', destination.recapCadence === 'weekly'],
  ];
  return `<div class="integration-event-summary" aria-label="External update settings"><strong>Updates that can leave Dominion</strong><ul>${events.map(([label, enabled]) => `<li class="${enabled ? 'enabled' : 'disabled'}"><span aria-hidden="true">${enabled ? 'On' : 'Off'}</span>${escapeHtml(label)}</li>`).join('')}</ul></div>`;
}

function integrationSettingsForm(destination = {}) {
  if (!state.crew || !isCrewAdmin(state.crew.role) || !destination.canManage) return '';
  return `
    <form class="integration-settings" data-integration-settings="${escapeHtml(destination.id)}">
      <fieldset>
        <legend>Channel update settings</legend>
        <label><input type="checkbox" name="checkInsEnabled" ${destination.checkInsEnabled ? 'checked' : ''} /> Daily Check-Ins</label>
        <label><input type="checkbox" name="streakMilestonesEnabled" ${destination.streakMilestonesEnabled ? 'checked' : ''} /> Streak milestones</label>
        <label><input type="checkbox" name="badgesRewardsEnabled" ${destination.badgesRewardsEnabled ? 'checked' : ''} /> Badges &amp; rewards</label>
        <label><input type="checkbox" name="membershipEnabled" ${destination.membershipEnabled ? 'checked' : ''} /> New group members</label>
        <label><input type="checkbox" name="includeSafeLink" ${destination.includeSafeLink ? 'checked' : ''} /> Include a safe Dominion link</label>
      </fieldset>
      <label class="integration-recap-cadence"><span>Leaderboard recap</span><select name="recapCadence"><option value="off" ${destination.recapCadence !== 'weekly' ? 'selected' : ''}>Off</option><option value="weekly" ${destination.recapCadence === 'weekly' ? 'selected' : ''}>Weekly</option></select></label>
      <button class="secondary compact" type="submit">Save channel settings</button>
    </form>`;
}

function renderIntegrations({ loading = false, error = '' } = {}) {
  const container = $('groupIntegrationDestinationList');
  const actions = $('integrationConnectActions');
  if (!container || !actions) return;
  const canManage = Boolean(state.crew && isCrewAdmin(state.crew.role));

  if (!GROUP_INTEGRATIONS_ENABLED || !state.crew) {
    container.innerHTML = '';
    actions.hidden = true;
    return;
  }
  if (loading) {
    container.innerHTML = '<p class="integration-disclosure">Loading connected channels…</p>';
    actions.hidden = true;
    return;
  }
  if (error) {
    container.innerHTML = `<p class="inline-error">${escapeHtml(error)}</p>`;
    actions.hidden = !canManage;
    return;
  }
  if (!state.integrations.length) {
    container.innerHTML = '<p class="integration-disclosure">No external channel is connected. Group progress stays inside Dominion.</p>';
  } else {
    container.innerHTML = state.integrations.map((destination) => {
      const provider = destination.provider === 'discord' ? 'discord' : 'slack';
      const providerName = provider === 'discord' ? 'Discord' : 'Slack';
      const status = destination.status || 'disconnected';
      const controls = canManage && destination.canManage ? `<div class="integration-destination-actions">${status === 'active' ? `<button class="provider-button provider-${provider} provider-secondary" type="button" data-test-integration="${escapeHtml(destination.id)}">Test ${providerName}</button>` : ''}<button class="provider-button provider-${provider} provider-secondary" type="button" data-reconnect-provider="${provider}">Reconnect ${providerName}</button>${status !== 'disconnected' ? `<button class="provider-button provider-disconnect provider-secondary" type="button" data-disconnect-integration="${escapeHtml(destination.id)}">Disconnect</button>` : ''}</div>` : '';
      return `<article class="integration-destination" data-integration-status="${escapeHtml(status)}"><div class="integration-destination-copy"><div class="integration-destination-title">${providerMark(provider)}<strong>${providerName}</strong><span class="integration-status ${escapeHtml(status)}">${escapeHtml(integrationStatusLabel(status))}</span></div><span>${escapeHtml(destination.workspaceName || destination.workspaceId || 'Workspace')} · #${escapeHtml(destination.channelName || destination.channelId || 'channel')}</span><small>${escapeHtml(integrationActivityLabel(destination))}</small><small class="integration-health-detail">${escapeHtml(integrationHealthLabel(destination))}</small>${integrationEventSummary(destination)}${integrationSettingsForm(destination)}</div>${controls}</article>`;
    }).join('');
  }

  const configured = new Set(state.integrations.map((destination) => destination.provider));
  actions.querySelectorAll('[data-connect-provider]').forEach((button) => {
    button.hidden = configured.has(button.dataset.connectProvider);
  });
  actions.hidden = !canManage || configured.size >= 2;
}

async function loadIntegrations() {
  if (!GROUP_INTEGRATIONS_ENABLED || !state.crew) return;
  renderIntegrations({ loading: true });
  try {
    const result = await manageGroupIntegration('list', { crewId: state.crew.id });
    state.integrations = Array.isArray(result.destinations) ? result.destinations : [];
    renderIntegrations();
  } catch (error) {
    state.integrations = [];
    renderIntegrations({ error: error?.message || 'Connected channels are unavailable.' });
  }
}

function renderIntegrationSetup() {
  const form = $('integrationConfirmForm');
  const select = $('integrationChannelSelect');
  if (!form || !select) return;
  const setup = state.integrationSetup;
  form.hidden = !GROUP_INTEGRATIONS_ENABLED || !setup;
  if (!GROUP_INTEGRATIONS_ENABLED || !setup) return;
  $('integrationConfirmTitle').textContent = `Choose a ${setup.provider === 'slack' ? 'Slack' : 'Discord'} channel`;
  $('integrationConfirmWorkspace').textContent = setup.workspace?.name || 'Authorized workspace';
  select.innerHTML = (setup.channels || []).map((channel) => `<option value="${escapeHtml(channel.id)}">#${escapeHtml(channel.name)}${channel.kind === 'private' ? ' · private' : ''}</option>`).join('');
  const unavailable = !(setup.channels || []).length;
  select.disabled = unavailable;
  form.querySelector('button[type="submit"]').disabled = unavailable;
}

function captureIntegrationCallback() {
  if (!window.location.hash) return;
  const params = new URLSearchParams(window.location.hash.slice(1));
  const setupToken = params.get('integration-setup');
  const integrationError = params.get('integration-error');
  if (!setupToken && !integrationError) return;
  window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}`);
  if (!GROUP_INTEGRATIONS_ENABLED) return;
  state.integrationSetupToken = setupToken || '';
  if (integrationError) {
    setFeedback(integrationError === 'authorization_denied'
      ? 'Provider authorization was canceled. Nothing was connected.'
      : 'Provider authorization could not be completed.', 'error');
  }
}

async function loadIntegrationSetup() {
  if (!GROUP_INTEGRATIONS_ENABLED || !state.integrationSetupToken) return;
  try {
    const setup = await manageGroupIntegration('channels', { setupToken: state.integrationSetupToken });
    if (setup.crewId !== state.crew?.id) throw new Error('That connection belongs to a different group.');
    state.integrationSetup = setup;
    renderIntegrationSetup();
  } catch (error) {
    state.integrationSetupToken = '';
    state.integrationSetup = null;
    renderIntegrationSetup();
    setFeedback(error?.message || 'That connection setup expired.', 'error');
  }
}

async function beginIntegrationAuthorization(provider, button) {
  if (!GROUP_INTEGRATIONS_ENABLED || !state.crew || !isCrewAdmin(state.crew.role)) return;
  const release = setButtonBusy(button, 'Opening…');
  try {
    const result = await manageGroupIntegration('begin', { crewId: state.crew.id, provider });
    const authorization = new URL(result.authorizationUrl);
    if (!['slack.com', 'discord.com'].includes(authorization.hostname)) {
      throw new Error('The provider returned an invalid authorization page.');
    }
    window.location.assign(authorization.toString());
  } catch (error) {
    release();
    setFeedback(error?.message || `Unable to connect ${provider}.`, 'error');
  }
}

function renderCrew() {
  const crew = state.crew;
  $('groupSettingsOverview').hidden = !crew;
  $('groupSettingsEmpty').hidden = Boolean(crew);
  $('groupSettingsContent').hidden = !crew;
  $('integrationPrivacy').hidden = !crew || !GROUP_INTEGRATIONS_ENABLED;
  $('groupIntegrations').hidden = !crew || !GROUP_INTEGRATIONS_ENABLED;
  if (!crew) return;

  $('groupSettingsOverviewTitle').textContent = crew.name || 'Private group';
  $('groupSettingsOverviewCopy').textContent = crew.description || 'A private accountability group for this challenge.';
  $('groupRoleBadge').textContent = isCrewAdmin(crew.role) ? 'Owner / admin' : 'Member';
  $('integrationPermissionBadge').textContent = isCrewAdmin(crew.role) ? 'You can manage' : 'View only';

  const action = crewLifecycleAction(crew.role);
  $('groupAccessTitle').textContent = action === 'delete' ? 'Delete this group' : 'Leave this group';
  $('groupAccessDescription').textContent = action === 'delete'
    ? 'Remove access for every member and begin the governed deletion process. Personal profiles, progress, badges, and journals are kept.'
    : 'Remove only your membership. Your profile, progress, badges, and journal stay yours.';
  $('groupAccessButton').textContent = action === 'delete' ? 'Delete group' : 'Leave group';
  $('groupAccessButton').dataset.lifecycleAction = action;
}

async function boot() {
  if (!hasSupabaseAuth() && !isLocalDemoMode()) {
    redirectToLogin(RETURN_PATH);
    return;
  }
  const billing = await getBillingState();
  if (!billing.authenticated) {
    redirectToLogin(RETURN_PATH);
    return;
  }
  if (!billing.appAccess) {
    window.location.replace('./billing.html?intent=subscription');
    return;
  }
  state.user = await getLocalOrSessionUser();
  const crews = await getCrews();
  const preferredCrewId = localStorage.getItem('dominion:activeCrewId') || '';
  state.crew = crews.find((crew) => crew.id === preferredCrewId) || crews[0] || null;
  if (state.crew) localStorage.setItem('dominion:activeCrewId', state.crew.id);
  renderCrew();
  captureIntegrationCallback();
  if (GROUP_INTEGRATIONS_ENABLED && state.crew) {
    $('integrationConsentContent').hidden = false;
    await Promise.all([loadConsent(), loadIntegrations()]);
    await loadIntegrationSetup();
  }
}

$('integrationConsentForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!GROUP_INTEGRATIONS_ENABLED || !state.crew) return;
  const presentationMode = event.currentTarget.querySelector('[name="integrationPresentation"]:checked')?.value || 'anonymous';
  setConsentBusy(true);
  setConsentFeedback('Saving your privacy choices…');
  try {
    const consent = await updateOutboundUpdateConsent(state.crew.id, {
      outboundUpdatesEnabled: Boolean($('integrationUpdatesEnabled')?.checked),
      presentationMode,
      events: {
        checkIns: Boolean($('integrationShareCheckIns')?.checked),
        streakMilestones: Boolean($('integrationShareStreaks')?.checked),
        badgesRewards: Boolean($('integrationShareBadges')?.checked),
        membership: Boolean($('integrationShareMembership')?.checked),
      },
    });
    renderConsent(consent);
    setConsentFeedback(consent.outboundUpdatesEnabled
      ? 'Privacy choices saved. They will be checked before every send.'
      : 'Privacy choices saved. Group updates are blocked.');
  } catch (error) {
    setConsentFeedback(error?.message || 'Unable to save your privacy choices.', 'error');
  } finally {
    setConsentBusy(false);
  }
});

$('groupAccessButton')?.addEventListener('click', (event) => {
  if (!state.crew) return;
  const crew = state.crew;
  const action = crewLifecycleAction(crew.role);
  const deleting = action === 'delete';
  const dialog = createConfirmationDialog({
    id: 'group-access-confirmation',
    title: deleting ? `Delete ${crew.name}?` : `Leave ${crew.name}?`,
    description: deleting
      ? 'Every member will lose group access. Personal profiles, progress, badges, and journals are not deleted.'
      : 'Only your membership will be removed. Your personal Dominion data will stay with your account.',
    confirmLabel: deleting ? 'Delete group' : 'Leave group',
    pendingLabel: deleting ? 'Deleting…' : 'Leaving…',
    cancelLabel: 'Cancel',
    destructive: true,
    alert: true,
    closeOnBackdrop: false,
    onConfirm: async () => {
      const requestId = newCrewLifecycleRequestId();
      if (deleting) await deleteCrew({ crewId: crew.id, requestId });
      else await leaveCrew({ crewId: crew.id, requestId });
      localStorage.removeItem('dominion:activeCrewId');
      window.location.replace(`./community.html?groupAccess=${deleting ? 'deleted' : 'left'}`);
    },
    onClose: () => dialog.destroy(),
  });
  dialog.open(event.currentTarget);
});

$('groupIntegrations')?.addEventListener('click', async (event) => {
  if (!GROUP_INTEGRATIONS_ENABLED) return;
  const connect = event.target.closest('[data-connect-provider], [data-reconnect-provider]');
  if (connect) {
    await beginIntegrationAuthorization(
      connect.dataset.connectProvider || connect.dataset.reconnectProvider,
      connect,
    );
    return;
  }
  const test = event.target.closest('[data-test-integration]');
  if (test) {
    const release = setButtonBusy(test, 'Testing…');
    try {
      await manageGroupIntegration('test', { destinationId: test.dataset.testIntegration });
      setFeedback('Test update delivered. The channel is ready.');
      await loadIntegrations();
    } catch (error) {
      setFeedback(error?.message || 'The test update could not be delivered.', 'error');
    } finally {
      release();
    }
    return;
  }
  const disconnect = event.target.closest('[data-disconnect-integration]');
  if (!disconnect) return;
  const dialog = createConfirmationDialog({
    id: 'disconnect-channel-confirmation',
    title: 'Disconnect this channel?',
    description: 'Queued updates will be canceled and the group will stop sending to this channel.',
    confirmLabel: 'Disconnect',
    pendingLabel: 'Disconnecting…',
    cancelLabel: 'Cancel',
    destructive: true,
    alert: true,
    onConfirm: async () => {
      await manageGroupIntegration('disconnect', { destinationId: disconnect.dataset.disconnectIntegration });
      await Promise.all([loadIntegrations(), loadConsent()]);
      setFeedback('Channel disconnected.');
    },
    onClose: () => dialog.destroy(),
  });
  dialog.open(disconnect);
});

$('groupIntegrations')?.addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-integration-settings]');
  if (!form || !state.crew || !isCrewAdmin(state.crew.role)) return;
  event.preventDefault();
  const destination = state.integrations.find((item) => item.id === form.dataset.integrationSettings);
  if (!destination?.canManage) return;
  const values = new FormData(form);
  const release = setButtonBusy(form.querySelector('button[type="submit"]'), 'Saving…');
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
    setFeedback('Channel settings saved.');
    await loadIntegrations();
  } catch (error) {
    setFeedback(error?.message || 'Unable to save channel settings.', 'error');
  } finally {
    release();
  }
});

$('integrationConfirmForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!GROUP_INTEGRATIONS_ENABLED || !state.integrationSetupToken || !state.integrationSetup) return;
  const release = setButtonBusy(event.currentTarget.querySelector('button[type="submit"]'), 'Confirming…');
  try {
    const result = await manageGroupIntegration('confirm', {
      setupToken: state.integrationSetupToken,
      channelId: $('integrationChannelSelect').value,
    });
    state.integrationSetupToken = '';
    state.integrationSetup = null;
    renderIntegrationSetup();
    setFeedback(`${result.destination?.provider === 'discord' ? 'Discord' : 'Slack'} channel connected.`);
    await Promise.all([loadIntegrations(), loadConsent()]);
  } catch (error) {
    setFeedback(error?.message || 'Unable to confirm that channel.', 'error');
  } finally {
    release();
  }
});

$('cancelIntegrationSetup')?.addEventListener('click', () => {
  state.integrationSetupToken = '';
  state.integrationSetup = null;
  renderIntegrationSetup();
  setFeedback('Connection setup canceled. Nothing was connected.');
});

subscribeToAuthStateChanges(({ event, user }) => {
  if (event === 'SIGNED_OUT' || !user?.authenticated) {
    redirectToLogin(RETURN_PATH);
    return;
  }
  if (state.user?.userId && user.userId && state.user.userId !== user.userId) {
    window.location.reload();
  }
});

boot().catch((error) => {
  console.warn('Unable to load group settings', error);
  setFeedback(error?.message || 'Unable to load group settings.', 'error');
});
