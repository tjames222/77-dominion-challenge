import {
  createCrew,
  getBillingState,
  getCrews,
  getCrewMembers,
  getJournalEntries,
  getLeaderboard,
  hasSupabaseAuth,
  isLocalDemoMode,
  manageGroupIntegration,
  redirectToLogin,
  saveJournalEntry,
} from './api';

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
  activeCrewId: localStorage.getItem('dominion:activeCrewId') || '',
  crewMembers: [],
  leaderboard: { window: 'week', rows: [], requestId: 0 },
  journalEntries: [],
  integrations: [],
  integrationSetupToken: '',
  integrationSetup: null,
};

function activateTab(tab, { focus = false } = {}) {
  if (!tab) return;
  const target = tab.dataset.tab;
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
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  return () => {
    button.disabled = false;
    button.textContent = original;
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
  const select = $('crewSelect');
  const manageCard = $('crewManageCard');
  const membersCard = $('crewMembersCard');
  const integrationsCard = $('crewIntegrationsCard');
  const title = $('crewTitle');
  const description = $('crewDescription');

  if (select) {
    select.innerHTML = state.crews.map((item) => (
      `<option value="${item.id}" ${item.id === state.activeCrewId ? 'selected' : ''}>${escapeHtml(item.name)}</option>`
    )).join('');
  }

  if (manageCard) manageCard.hidden = !state.crews.length;
  if (membersCard) membersCard.hidden = !crew;
  if (integrationsCard) integrationsCard.hidden = !crew;

  if (!crew) {
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

  if (title) title.textContent = crew.name;
  if (description) description.textContent = crew.description || 'A private accountability group for this 77-day challenge.';
  $('crewDayCount').textContent = dayLabel(crew.challengeStartDate);
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

  if (!crew) {
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
      const actionMarkup = canManage && destination.canManage ? `
        <div class="integration-destination-actions">
          ${status === 'active' ? `<button class="secondary compact" type="button" data-test-integration="${escapeHtml(destination.id)}">Test</button>` : ''}
          <button class="secondary compact" type="button" data-reconnect-provider="${escapeHtml(destination.provider)}">Reconnect</button>
          ${status !== 'disconnected' ? `<button class="secondary compact" type="button" data-disconnect-integration="${escapeHtml(destination.id)}">Disconnect</button>` : ''}
        </div>
      ` : '';
      return `
        <article class="integration-destination">
          <div class="integration-destination-copy">
            <div class="integration-destination-title">
              <strong>${escapeHtml(destination.provider)}</strong>
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
  if (!crew) {
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
  form.hidden = !setup;
  if (!setup) return;
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
  if (setupToken) state.integrationSetupToken = setupToken;
  if (integrationError) {
    setFeedback(integrationError === 'authorization_denied'
      ? 'Provider authorization was canceled. Nothing was connected.'
      : 'Provider authorization could not be completed. Try connecting again.');
  }
}

async function loadIntegrationSetup() {
  if (!state.integrationSetupToken) return;
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
  if (!crew || !isCrewLeader()) return;
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
  if (!crew) return;
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
  ]);
}

async function refreshJournal() {
  state.journalEntries = await getJournalEntries();
  renderJournal();
  fillJournalFormForDate();
}

async function refreshCrews() {
  state.crews = await getCrews();
  if (!state.crews.some((crew) => crew.id === state.activeCrewId)) {
    state.activeCrewId = state.crews[0]?.id || '';
    localStorage.setItem('dominion:activeCrewId', state.activeCrewId);
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
  if (isLocalDemoMode()) setFeedback('Preview mode: groups, leaderboards, integrations, and journal entries use local mock data.');
  await Promise.all([refreshCrews(), refreshJournal()]);
  await loadIntegrationSetup();
}

$('crewSelect')?.addEventListener('change', async (event) => {
  state.activeCrewId = event.target.value;
  localStorage.setItem('dominion:activeCrewId', state.activeCrewId);
  setFeedback('');
  await refreshCrew();
});

$('crewIntegrationsCard')?.addEventListener('click', async (event) => {
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
  if (!state.integrationSetupToken || !state.integrationSetup) return;
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
    const crew = await createCrew({
      name: $('crewNameInput').value.trim(),
      description: $('crewDescriptionInput').value.trim(),
      challengeStartDate: $('crewStartDateInput').value,
    });
    state.activeCrewId = crew.id;
    localStorage.setItem('dominion:activeCrewId', crew.id);
    event.target.reset();
    $('crewStartDateInput').value = todayKey();
    setFeedback(`${crew.name} is ready. Copy the invite link when you want to bring people in.`);
    await refreshCrews();
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
