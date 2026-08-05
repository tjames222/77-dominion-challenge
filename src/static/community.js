import {
  addPostComment,
  createCommunityPost,
  createCrew,
  deleteCrew,
  deleteCommunityPost,
  deletePostComment,
  getBillingState,
  getCommunityPostPage,
  getCommunityPosts,
  getCrews,
  getCrewInvitePreview,
  getCrewMembers,
  getCrewTrainingProgress,
  getJournalEntries,
  getLeaderboard,
  getOrCreateCrewInvite,
  hasSupabaseAuth,
  isLocalDemoMode,
  joinCrewByInvite,
  leaveCrew,
  manageGroupIntegration,
  redirectToLogin,
  saveJournalEntry,
  saveCrewTrainingProgress,
  setPostLiked,
  updateCommunityPost,
} from './api';
import {
  CREW_TRAINING_VERSION,
  buildCrewTrainingSteps,
  crewLifecycleAction,
  crewTrainingActionLabel,
  crewViewState,
  integrationsEnabled,
  normalizeCrewTrainingProgress,
  shouldAutoStartCrewTraining,
} from './crew-experience.mjs';

const tabs = Array.from(document.querySelectorAll('.community-tab'));
const panels = Array.from(document.querySelectorAll('.community-panel'));
const $ = (id) => document.getElementById(id);
const todayKey = () => new Date().toISOString().slice(0, 10);
const CREW_POST_PAGE_SIZE = 8;
const MAX_POST_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_POST_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const GROUP_INTEGRATIONS_ENABLED = integrationsEnabled(import.meta.env.VITE_ENABLE_GROUP_INTEGRATIONS);
const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
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
  activeCrewId: localStorage.getItem('dominion:activeCrewId') || '',
  createFormOpen: false,
  createRequestId: '',
  crewMembers: [],
  crewPosts: [],
  globalPosts: [],
  editingPostId: '',
  confirmingDeletePostId: '',
  crewFeed: {
    loading: false,
    loadingMore: false,
    error: '',
    loadMoreError: '',
    hasMore: false,
    nextCursor: null,
    requestId: 0,
  },
  leaderboards: {
    crew: { window: 'week', rows: [], requestId: 0 },
    global: { window: 'week', rows: [], requestId: 0 },
  },
  journalEntries: [],
  integrations: [],
  integrationSetupToken: '',
  integrationSetup: null,
  trainingProgress: null,
  trainingStep: 0,
  trainingTrigger: null,
  trainingHighlightedElement: null,
  lifecycleAction: '',
  lifecycleRequestId: '',
  lifecycleTrigger: null,
  inviteToken: '',
  invitePreview: null,
  inviteTrigger: null,
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
  const original = button.innerHTML;
  const originallyDisabled = button.disabled;
  button.disabled = true;
  button.textContent = label;
  return () => {
    button.disabled = originallyDisabled;
    if (button.textContent === label) button.innerHTML = original;
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

function timestampMarkup(item = {}) {
  const createdAt = item.createdAt || '';
  const label = item.timestamp || 'Just now';
  return `<time datetime="${escapeHtml(createdAt)}" title="${escapeHtml(createdAt ? new Date(createdAt).toLocaleString() : label)}">${escapeHtml(label)}</time>`;
}

function isCrewLeader() {
  return ['owner', 'admin'].includes(activeCrew()?.role);
}

function findPost(postId) {
  return [...state.crewPosts, ...state.globalPosts].find((item) => item.id === postId) || null;
}

function renderPostScope(scope) {
  if (scope === 'crew') renderCrewFeed();
  else renderPosts(state.globalPosts, 'globalFeed');
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

function renderLeaderboard(scope) {
  const board = state.leaderboards[scope];
  const container = $(`${scope}Leaderboard`);
  if (!board || !container) return;

  document.querySelectorAll(`[data-leaderboard-scope="${scope}"]`).forEach((button) => {
    button.classList.toggle('active', button.dataset.leaderboardWindow === board.window);
  });

  const crew = activeCrew();
  if (scope === 'crew' && !crew) {
    container.innerHTML = '<article class="leaderboard-empty">Create or join a crew to unlock a private leaderboard.</article>';
    return;
  }

  if (!board.rows.length) {
    container.innerHTML = `<article class="leaderboard-empty">${scope === 'crew' ? 'Crew points will show here after check-ins.' : 'Global points will show here after members post check-ins.'}</article>`;
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

async function refreshLeaderboard(scope) {
  const crew = activeCrew();
  const board = state.leaderboards[scope];
  const requestedCrewId = scope === 'crew' ? crew?.id || '' : '';
  const requestedWindow = board.window;
  const requestId = board.requestId + 1;
  board.requestId = requestId;
  if (scope === 'crew' && !crew) {
    state.leaderboards.crew.rows = [];
    renderLeaderboard('crew');
    return;
  }

  try {
    const rows = await getLeaderboard({
      scope,
      crewId: scope === 'crew' ? crew.id : null,
      window: requestedWindow,
    });
    const crewChanged = scope === 'crew' && activeCrew()?.id !== requestedCrewId;
    if (board.requestId !== requestId || board.window !== requestedWindow || crewChanged) return;
    board.rows = rows;
  } catch (error) {
    const crewChanged = scope === 'crew' && activeCrew()?.id !== requestedCrewId;
    if (board.requestId !== requestId || board.window !== requestedWindow || crewChanged) return;
    console.warn(`Unable to load ${scope} leaderboard`, error);
    board.rows = [];
  }
  renderLeaderboard(scope);
}

function renderCrewShell() {
  const crew = activeCrew();
  const view = crewViewState({
    loaded: state.crewsLoaded,
    crew,
    createFormOpen: state.createFormOpen,
  });
  const createCard = $('crewCreateCard');
  const createButton = $('openCrewFormButton');
  const createForm = $('crewForm');
  const manageCard = $('crewManageCard');
  const composerCard = $('crewComposerCard');
  const membersCard = $('crewMembersCard');
  const feedSection = $('crewFeedSection');
  const integrationsCard = $('crewIntegrationsCard');
  const stats = $('crewStats');
  const leaderboardCard = $('crewLeaderboardCard');
  const lifecycleCard = $('crewLifecycleCard');
  const trainingButton = $('crewTrainingButton');
  const title = $('crewTitle');
  const description = $('crewDescription');

  if (createCard) createCard.hidden = !view.showCreateCard;
  if (createButton) {
    createButton.hidden = !view.showCreateButton;
    createButton.setAttribute('aria-expanded', String(view.showCreateForm));
  }
  if (createForm) createForm.hidden = !view.showCreateForm;
  if (manageCard) manageCard.hidden = !view.showActiveCrew;
  if (composerCard) composerCard.hidden = !view.showActiveCrew;
  if (membersCard) membersCard.hidden = !view.showActiveCrew;
  if (feedSection) feedSection.hidden = !view.showActiveCrew;
  if (integrationsCard) integrationsCard.hidden = !view.showActiveCrew || !GROUP_INTEGRATIONS_ENABLED;
  if (stats) stats.hidden = !view.showActiveCrew;
  if (leaderboardCard) leaderboardCard.hidden = !view.showActiveCrew;
  if (lifecycleCard) lifecycleCard.hidden = !view.showActiveCrew;

  if (!crew) {
    if (title) title.textContent = 'Create or join a crew.';
    if (description) description.textContent = 'Private crews keep accountability close: one start date, one channel, and people you actually know.';
    $('crewMemberCount').textContent = '0';
    $('crewDayCount').textContent = 'Day 1';
    $('crewPostCount').textContent = '0';
    $('crewFeed').innerHTML = emptyCard('Create a crew or open an invite link to start a private channel.');
    $('crewMemberList').innerHTML = '';
    $('inviteLinkText').textContent = '';
    state.integrations = [];
    state.trainingProgress = null;
    renderIntegrations();
    state.leaderboards.crew.rows = [];
    renderLeaderboard('crew');
    return;
  }

  if (title) title.textContent = crew.name;
  if (description) description.textContent = crew.description || 'A private crew channel for this 77-day challenge.';
  if ($('activeCrewName')) $('activeCrewName').textContent = crew.name;
  $('crewDayCount').textContent = dayLabel(crew.challengeStartDate);

  const isCreator = crew.role === 'owner';
  if (trainingButton) {
    trainingButton.hidden = !isCreator;
    trainingButton.textContent = crewTrainingActionLabel(state.trainingProgress);
  }

  const action = crewLifecycleAction(crew.role);
  state.lifecycleAction = action;
  $('crewLifecycleHeading').textContent = action === 'delete' ? 'Delete this crew' : 'Leave this crew';
  $('crewLifecycleDescription').textContent = action === 'delete'
    ? 'Deleting ends crew access for everyone, revokes invitations, and disconnects external destinations. Personal profiles, progress, points, badges, and journals are never deleted.'
    : 'Leaving removes only your membership. Your profile, progress, points, badges, and journal remain yours.';
  $('crewLifecycleButton').textContent = action === 'delete' ? 'Delete Crew' : 'Leave Group';
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
  return Number.isNaN(date.getTime()) ? 'Connection activity recorded.' : `Last verified ${date.toLocaleString()}`;
}

function integrationHealthLabel(destination = {}) {
  if (destination.correctiveAction) return destination.correctiveAction;
  if (destination.status === 'reconnect_required') return 'Reconnect this destination, then send a test update.';
  if (destination.lastErrorCode === 'provider_rate_limited') return 'The provider is rate limiting updates. Dominion will retry automatically.';
  if (destination.lastErrorCode) return 'Review the connection and send a test update.';
  if (destination.status === 'active') return 'Delivery health is good.';
  return 'Connect or reconnect this destination to deliver updates.';
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
    container.innerHTML = '<p class="integration-disclosure">No external channels are connected. Crew progress stays inside Dominion.</p>';
  } else {
    container.innerHTML = state.integrations.map((destination) => {
      const status = destination.status || 'disconnected';
      const provider = destination.provider === 'discord' ? 'discord' : 'slack';
      const providerName = provider === 'discord' ? 'Discord' : 'Slack';
      const actionMarkup = canManage && destination.canManage ? `
        <div class="integration-destination-actions">
          ${status === 'active' ? `<button class="provider-button provider-${provider} provider-secondary" type="button" data-test-integration="${escapeHtml(destination.id)}">Test ${providerName}</button>` : ''}
          <button class="provider-button provider-${provider} provider-secondary" type="button" data-reconnect-provider="${provider}">Reconnect</button>
          ${status !== 'disconnected' ? `<button class="provider-button provider-disconnect provider-secondary" type="button" data-disconnect-integration="${escapeHtml(destination.id)}">Disconnect</button>` : ''}
        </div>
      ` : '';
      return `
        <article class="integration-destination">
          <div class="integration-destination-copy">
            <div class="integration-destination-title">
              <strong>${providerName}</strong>
              <span class="integration-status ${escapeHtml(status)}">${escapeHtml(integrationStatusLabel(status))}</span>
            </div>
            <span>${escapeHtml(destination.workspaceName || destination.workspaceId || 'Workspace')} · #${escapeHtml(destination.channelName || destination.channelId || 'channel')}</span>
            <small>${escapeHtml(integrationActivityLabel(destination))}</small>
            <small>${escapeHtml(integrationHealthLabel(destination))}</small>
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
    setFeedback('Slack and Discord connections are not available right now. Nothing was connected.');
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
    const setup = await manageGroupIntegration('channels', { setupToken: state.integrationSetupToken });
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

async function beginIntegrationAuthorization(provider, button) {
  const crew = activeCrew();
  if (!GROUP_INTEGRATIONS_ENABLED || !crew || !isCrewLeader()) return;
  const release = setButtonBusy(button, 'Opening…');
  try {
    const result = await manageGroupIntegration('begin', { crewId: crew.id, provider });
    const authorization = new URL(result.authorizationUrl);
    if (!['slack.com', 'discord.com'].includes(authorization.hostname)) {
      throw new Error('The provider returned an invalid authorization destination.');
    }
    window.location.assign(authorization.toString());
  } catch (error) {
    release();
    setFeedback(error?.message || `Unable to connect ${provider} right now.`);
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

function postActionsMarkup(post) {
  const canEdit = Boolean(post.isOwn);
  const canRemove = canEdit || (post.scope === 'crew' && isCrewLeader());
  if (!canEdit && !canRemove) return '';
  if (state.confirmingDeletePostId === post.id) {
    return `
      <div class="post-actions confirming" aria-label="Confirm removal of ${escapeHtml(post.name)}'s post">
        <button class="danger" type="button" data-confirm-delete-post="${post.id}" aria-label="Confirm ${canEdit ? 'deletion' : 'removal'} of ${escapeHtml(post.name)}'s post">Confirm</button>
        <button type="button" data-cancel-delete-post="${post.id}">Cancel</button>
      </div>
    `;
  }
  return `
    <div class="post-actions" aria-label="Actions for ${escapeHtml(post.name)}'s post">
      ${canEdit && state.editingPostId !== post.id ? `<button type="button" data-edit-post="${post.id}" aria-label="Edit ${escapeHtml(post.name)}'s post">Edit</button>` : ''}
      ${canRemove ? `<button class="danger" type="button" data-delete-post="${post.id}" aria-label="${canEdit ? 'Delete' : 'Remove'} ${escapeHtml(post.name)}'s post">${canEdit ? 'Delete' : 'Remove'}</button>` : ''}
    </div>
  `;
}

function postBodyMarkup(post) {
  if (state.editingPostId !== post.id) {
    return post.body ? `<p class="post-body">${escapeHtml(post.body)}</p>` : '';
  }
  return `
    <form class="post-edit-form" data-edit-post-form="${post.id}">
      <label class="sr-only" for="edit-post-${post.id}">Edit post message</label>
      <textarea id="edit-post-${post.id}" name="body" maxlength="2000" ${post.imagePath ? '' : 'required'}>${escapeHtml(post.body)}</textarea>
      <div class="post-edit-actions">
        <button class="primary compact" type="submit">Save changes</button>
        <button class="secondary compact" type="button" data-cancel-edit-post="${post.id}">Cancel</button>
      </div>
    </form>
  `;
}

function commentMarkup(comment, post) {
  const canRemove = comment.isOwn || (post.scope === 'crew' && isCrewLeader());
  return `
    <article class="comment-item">
      ${avatarMarkup({ ...comment, size: 'small' })}
      <div class="comment-copy">
        <div class="comment-meta">
          <strong>${escapeHtml(comment.name)}</strong>
          ${timestampMarkup(comment)}
          ${canRemove ? `<button class="comment-delete" type="button" data-delete-comment="${comment.id}" data-post-id="${post.id}" aria-label="Remove ${escapeHtml(comment.name)}'s comment">Remove</button>` : ''}
        </div>
        <p>${escapeHtml(comment.body)}</p>
      </div>
    </article>
  `;
}

function reactionSummaryMarkup(post) {
  const count = Number(post.likeCount || 0);
  if (!count) return '';
  const reactions = (post.reactions || []).slice(0, 3);
  const names = reactions.map((reaction) => reaction.name || 'Member');
  let summary = `${count.toLocaleString()} ${count === 1 ? 'person likes' : 'people like'} this`;
  if (names.length === 1 && count === 1) summary = `${names[0]} likes this`;
  else if (names.length >= 2 && count === 2) summary = `${names[0]} and ${names[1]} like this`;
  else if (names.length) {
    const shownNames = names.slice(0, 2);
    const remaining = Math.max(count - shownNames.length, 0);
    summary = remaining
      ? `${shownNames.join(', ')} and ${remaining.toLocaleString()} ${remaining === 1 ? 'other' : 'others'} like this`
      : `${shownNames.join(' and ')} like this`;
  }
  return `
    <div class="reaction-summary" aria-label="${escapeHtml(`Liked by ${summary.replace(/ like(?:s)? this$/, '')}`)}">
      ${reactions.length ? `
        <span class="reaction-avatar-stack" aria-hidden="true">
          ${reactions.map((reaction) => avatarMarkup({ ...reaction, size: 'tiny', decorative: true })).join('')}
        </span>
      ` : ''}
      <span>${escapeHtml(summary)}</span>
    </div>
  `;
}

function postMarkup(post) {
  return `
    <article class="feed-card card" data-post-id="${post.id}" data-scope="${post.scope}">
      <header class="post-header">
        <div class="post-author">
          ${avatarMarkup(post)}
          <div>
            <strong>${escapeHtml(post.name)}</strong>
            ${timestampMarkup(post)}
          </div>
        </div>
        ${postActionsMarkup(post)}
      </header>
      ${postBodyMarkup(post)}
      ${post.imageUrl ? `
        <figure class="post-image">
          <img src="${escapeHtml(post.imageUrl)}" alt="${escapeHtml(post.imageAlt || '')}" loading="lazy" />
        </figure>
      ` : ''}
      <div class="reaction-row" aria-label="Post engagement">
        <button type="button" class="${post.likedByMe ? 'active' : ''}" data-like-post="${post.id}" aria-pressed="${String(Boolean(post.likedByMe))}">
          ${post.likedByMe ? 'Liked' : 'Like'} · ${post.likeCount}
        </button>
        <button type="button" data-focus-comment="${post.id}">Comment · ${post.comments.length}</button>
      </div>
      ${reactionSummaryMarkup(post)}
      <div class="comment-list">
        ${post.comments.map((comment) => commentMarkup(comment, post)).join('')}
      </div>
      <form class="comment-form" data-comment-post="${post.id}">
        <label class="sr-only" for="comment-${post.id}">Comment on ${escapeHtml(post.name)}'s post</label>
        <input id="comment-${post.id}" type="text" name="comment" maxlength="1000" placeholder="Write a comment..." autocomplete="off" required />
        <button type="submit">Post</button>
      </form>
    </article>
  `;
}

function renderPosts(posts, containerId) {
  const container = $(containerId);
  if (!container) return;
  if (!posts.length) {
    container.innerHTML = emptyCard(containerId === 'crewFeed'
      ? 'No crew posts yet. Be the first to put a little courage in the room.'
      : 'No global posts yet. Share a win or prayer request to start the conversation.');
    return;
  }

  container.innerHTML = posts.map(postMarkup).join('');
}

function feedLoadingMarkup() {
  return Array.from({ length: 3 }, () => `
    <article class="feed-card card feed-card-loading" aria-hidden="true">
      <div class="skeleton-row"><span class="skeleton skeleton-avatar"></span><span class="skeleton skeleton-line"></span></div>
      <span class="skeleton skeleton-copy"></span>
      <span class="skeleton skeleton-copy short"></span>
    </article>
  `).join('');
}

function renderCrewFeedStatus() {
  const container = $('crewFeed');
  const sentinel = $('crewFeedSentinel');
  if (!container || !sentinel) return;
  container.setAttribute('aria-busy', String(state.crewFeed.loading || state.crewFeed.loadingMore));

  if (state.crewFeed.loading || state.crewFeed.error) {
    sentinel.innerHTML = '';
    return;
  }
  if (state.crewFeed.loadingMore) {
    sentinel.innerHTML = '<span class="feed-loading-more" role="status">Loading older posts…</span>';
    return;
  }
  if (state.crewFeed.loadMoreError) {
    sentinel.innerHTML = `
      <div class="feed-load-error" role="alert">
        <span>${escapeHtml(state.crewFeed.loadMoreError)}</span>
        <button type="button" class="secondary compact" data-load-more-crew>Try again</button>
      </div>
    `;
    return;
  }
  if (state.crewFeed.hasMore) {
    sentinel.innerHTML = '<button type="button" class="secondary compact" data-load-more-crew>Load older posts</button>';
    return;
  }
  sentinel.innerHTML = state.crewPosts.length ? '<span class="feed-end">You are all caught up.</span>' : '';
}

function renderCrewFeed() {
  const container = $('crewFeed');
  if (!container) return;

  if (state.crewFeed.loading) {
    container.innerHTML = feedLoadingMarkup();
  } else if (state.crewFeed.error && !state.crewPosts.length) {
    container.innerHTML = `
      <article class="feed-state feed-error card" role="alert">
        <strong>We could not load this private feed.</strong>
        <p>${escapeHtml(state.crewFeed.error)}</p>
        <button class="secondary compact" type="button" data-retry-crew-feed>Try again</button>
      </article>
    `;
  } else {
    renderPosts(state.crewPosts, 'crewFeed');
  }
  renderCrewFeedStatus();
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

const dialogFocusReturn = new WeakMap();

function dialogFocusableElements(dialog) {
  return Array.from(dialog?.querySelectorAll(
    'button:not([disabled]):not([hidden]), input:not([disabled]):not([hidden]), select:not([disabled]):not([hidden]), textarea:not([disabled]):not([hidden]), [href], [tabindex]:not([tabindex="-1"])',
  ) || []).filter((element) => !element.closest('[hidden]'));
}

function showCrewDialog(dialog, { trigger = document.activeElement, initialFocus = null } = {}) {
  if (!dialog || dialog.open) return;
  if (trigger instanceof HTMLElement) dialogFocusReturn.set(dialog, trigger);
  dialog.showModal();
  requestAnimationFrame(() => (initialFocus || dialogFocusableElements(dialog)[0] || dialog).focus());
}

function closeCrewDialog(dialog) {
  if (dialog?.open) dialog.close();
}

function restoreDialogFocus(dialog) {
  const trigger = dialogFocusReturn.get(dialog);
  dialogFocusReturn.delete(dialog);
  if (trigger?.isConnected && !trigger.hidden && !trigger.disabled) trigger.focus();
}

function trapDialogFocus(event) {
  if (event.key !== 'Tab') return;
  const dialog = event.currentTarget;
  const focusable = dialogFocusableElements(dialog);
  if (!focusable.length) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

document.querySelectorAll('.crew-dialog').forEach((dialog) => {
  dialog.addEventListener('keydown', trapDialogFocus);
  dialog.addEventListener('close', () => restoreDialogFocus(dialog));
});

function removeInviteFromUrl() {
  const params = new URLSearchParams(window.location.search);
  params.delete('invite');
  const query = params.toString();
  window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
}

async function prepareInviteIfPresent() {
  const token = new URLSearchParams(window.location.search).get('invite');
  if (!token) return;
  state.inviteToken = token;
  const dialog = $('crewInviteDialog');
  const errorElement = $('crewInviteDialogError');
  const confirmButton = $('confirmCrewInviteButton');
  errorElement.hidden = true;
  confirmButton.disabled = true;
  try {
    const preview = await getCrewInvitePreview(token);
    state.invitePreview = preview;
    if (preview.alreadyMember) {
      state.activeCrewId = preview.crewId;
      localStorage.setItem('dominion:activeCrewId', preview.crewId);
      removeInviteFromUrl();
      setFeedback(`You are already a member of ${preview.name}.`);
      await refreshCrews();
      return;
    }
    $('crewInviteDialogTitle').textContent = `Join ${preview.name}?`;
    $('crewInviteDialogDescription').textContent = `${preview.inviterName} invited you to this private crew. Joining requires your confirmation.`;
    if (preview.hasOtherCrew) {
      errorElement.textContent = 'You already have an active crew. Leave or delete it before joining another.';
      errorElement.hidden = false;
    } else {
      confirmButton.disabled = false;
    }
    showCrewDialog(dialog, { initialFocus: preview.hasOtherCrew ? $('cancelCrewInviteButton') : confirmButton });
  } catch (error) {
    removeInviteFromUrl();
    setFeedback(error?.message || 'This invitation is invalid or has expired.');
  }
}

function clearTrainingHighlight() {
  state.trainingHighlightedElement?.classList.remove('crew-training-highlight');
  state.trainingHighlightedElement = null;
}

function trainingSteps() {
  return buildCrewTrainingSteps({
    crewName: activeCrew()?.name,
    providersEnabled: GROUP_INTEGRATIONS_ENABLED,
  });
}

function renderCrewTraining() {
  const steps = trainingSteps();
  const index = Math.max(0, Math.min(steps.length - 1, state.trainingStep));
  const step = steps[index];
  state.trainingStep = index;
  clearTrainingHighlight();

  $('crewTrainingProgress').textContent = `Step ${index + 1} of ${steps.length}`;
  $('crewTrainingTitle').textContent = step.title;
  $('crewTrainingDescription').textContent = step.body;
  $('crewTrainingBackButton').disabled = index === 0;
  $('crewTrainingNextButton').textContent = index === steps.length - 1 ? 'Finish' : 'Next';

  const target = step.targetId ? $(step.targetId) : null;
  const targetAvailable = Boolean(target && !target.hidden && target.getClientRects().length);
  $('crewTrainingTargetNote').hidden = targetAvailable;
  if (targetAvailable) {
    target.classList.add('crew-training-highlight');
    state.trainingHighlightedElement = target;
    const bounds = target.getBoundingClientRect();
    if (bounds.top < 12 || bounds.bottom > window.innerHeight - 12) {
      target.scrollIntoView({ behavior: prefersReducedMotion ? 'auto' : 'smooth', block: 'center' });
    }
  }
}

async function loadCrewTraining() {
  const crew = activeCrew();
  if (!crew || crew.role !== 'owner') {
    state.trainingProgress = null;
    renderCrewShell();
    return null;
  }
  try {
    state.trainingProgress = normalizeCrewTrainingProgress(
      await getCrewTrainingProgress(crew.id, CREW_TRAINING_VERSION),
    );
  } catch (error) {
    state.trainingProgress = null;
    console.warn('Unable to load crew training progress', error);
  }
  renderCrewShell();
  return state.trainingProgress;
}

async function persistCrewTraining(status, step = state.trainingStep) {
  const crew = activeCrew();
  if (!crew || crew.role !== 'owner') throw new Error('Only the crew creator can update this training.');
  const saved = await saveCrewTrainingProgress({
    crewId: crew.id,
    version: CREW_TRAINING_VERSION,
    status,
    currentStep: step,
  });
  state.trainingProgress = normalizeCrewTrainingProgress(saved);
  $('crewTrainingButton').textContent = crewTrainingActionLabel(state.trainingProgress);
  return state.trainingProgress;
}

async function openCrewTraining({ replay = false, trigger = document.activeElement } = {}) {
  const crew = activeCrew();
  if (!crew || crew.role !== 'owner') return;
  const progress = normalizeCrewTrainingProgress(state.trainingProgress);
  state.trainingStep = replay || progress.status === 'completed' ? 0 : progress.currentStep;
  state.trainingTrigger = trigger;
  $('crewTrainingError').hidden = true;
  try {
    await persistCrewTraining('in_progress', state.trainingStep);
    renderCrewTraining();
    showCrewDialog($('crewTrainingDialog'), { trigger, initialFocus: $('crewTrainingNextButton') });
  } catch (error) {
    setFeedback(error?.message || 'Crew training is unavailable right now.');
  }
}

async function skipCrewTraining() {
  const dialog = $('crewTrainingDialog');
  const errorElement = $('crewTrainingError');
  try {
    await persistCrewTraining('skipped', state.trainingStep);
    clearTrainingHighlight();
    closeCrewDialog(dialog);
    setFeedback('Crew training saved. You can resume it from the crew card.');
  } catch (error) {
    errorElement.textContent = error?.message || 'Unable to save crew training progress.';
    errorElement.hidden = false;
  }
}

function openCrewLifecycleDialog(trigger) {
  const crew = activeCrew();
  if (!crew) return;
  const action = crewLifecycleAction(crew.role);
  state.lifecycleAction = action;
  state.lifecycleRequestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  state.lifecycleTrigger = trigger;
  $('crewLifecycleDialogTitle').textContent = 'Are you sure?';
  $('crewLifecycleDialogDescription').textContent = action === 'delete'
    ? `Delete ${crew.name}? Everyone will lose access, active invitations will be revoked, and connected Slack or Discord destinations will be disabled. Personal profile and challenge data will remain intact.`
    : `Leave ${crew.name}? You will lose access to its private feed and will need a new invitation to rejoin. Your personal profile and challenge data will remain intact.`;
  $('confirmCrewLifecycleButton').textContent = action === 'delete' ? 'Delete Crew' : 'Leave Group';
  $('crewLifecycleDialogError').hidden = true;
  showCrewDialog($('crewLifecycleDialog'), { trigger, initialFocus: $('cancelCrewLifecycleButton') });
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

async function loadCrewFeed({ reset = false } = {}) {
  const crew = activeCrew();
  if (!crew) return;
  if (!reset && (state.crewFeed.loading || state.crewFeed.loadingMore)) return;
  if (!reset && !state.crewFeed.hasMore && state.crewPosts.length) return;

  const requestedCrewId = crew.id;
  const requestId = reset ? state.crewFeed.requestId + 1 : state.crewFeed.requestId;
  if (reset) state.crewFeed.requestId = requestId;
  if (reset) {
    state.crewPosts = [];
    state.editingPostId = '';
    state.confirmingDeletePostId = '';
    state.crewFeed.loading = true;
    state.crewFeed.error = '';
    state.crewFeed.loadMoreError = '';
    state.crewFeed.hasMore = false;
    state.crewFeed.nextCursor = null;
  } else {
    state.crewFeed.loadingMore = true;
    state.crewFeed.loadMoreError = '';
  }
  if (reset) renderCrewFeed();
  else renderCrewFeedStatus();

  let appendedPosts = [];

  try {
    const page = await getCommunityPostPage({
      scope: 'crew',
      crewId: requestedCrewId,
      limit: CREW_POST_PAGE_SIZE,
      before: reset ? null : state.crewFeed.nextCursor,
    });
    if (state.activeCrewId !== requestedCrewId || state.crewFeed.requestId !== requestId) return;
    const incoming = page.posts || [];
    if (reset) {
      state.crewPosts = incoming;
    } else {
      const knownIds = new Set(state.crewPosts.map((post) => post.id));
      appendedPosts = incoming.filter((post) => !knownIds.has(post.id));
      state.crewPosts.push(...appendedPosts);
    }
    state.crewFeed.hasMore = Boolean(page.hasMore);
    state.crewFeed.nextCursor = page.nextCursor || null;
  } catch (error) {
    if (state.activeCrewId !== requestedCrewId || state.crewFeed.requestId !== requestId) return;
    const message = error?.message || 'Check your connection and try again.';
    if (reset) state.crewFeed.error = message;
    else state.crewFeed.loadMoreError = message;
  } finally {
    if (state.activeCrewId === requestedCrewId && state.crewFeed.requestId === requestId) {
      state.crewFeed.loading = false;
      state.crewFeed.loadingMore = false;
      $('crewPostCount').textContent = String(state.crewPosts.length);
      if (reset) {
        renderCrewFeed();
      } else {
        if (appendedPosts.length) $('crewFeed')?.insertAdjacentHTML('beforeend', appendedPosts.map(postMarkup).join(''));
        renderCrewFeedStatus();
      }
    }
  }
}

async function refreshCrew() {
  renderCrewShell();
  const crew = activeCrew();
  if (!crew) {
    state.crewMembers = [];
    state.crewPosts = [];
    state.integrations = [];
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
    loadCrewFeed({ reset: true }),
    refreshLeaderboard('crew'),
    loadCrewIntegrations(),
    loadCrewTraining(),
  ]);
}

async function refreshGlobal() {
  const [posts] = await Promise.all([
    getCommunityPosts({ scope: 'global' }),
    refreshLeaderboard('global'),
  ]);
  state.globalPosts = posts;
  renderPosts(state.globalPosts, 'globalFeed');
}

async function refreshJournal() {
  state.journalEntries = await getJournalEntries();
  renderJournal();
  fillJournalFormForDate();
}

async function refreshCrews() {
  state.crews = await getCrews();
  state.crewsLoaded = true;
  if (!state.crews.some((crew) => crew.id === state.activeCrewId)) {
    state.activeCrewId = state.crews[0]?.id || '';
    if (state.activeCrewId) localStorage.setItem('dominion:activeCrewId', state.activeCrewId);
    else localStorage.removeItem('dominion:activeCrewId');
  }
  if (state.activeCrewId) state.createFormOpen = false;
  await refreshCrew();
}

let crewPostImagePreviewUrl = '';

function clearCrewPostImage() {
  if (crewPostImagePreviewUrl) URL.revokeObjectURL(crewPostImagePreviewUrl);
  crewPostImagePreviewUrl = '';
  const input = $('crewPostImage');
  const preview = $('crewPostImagePreview');
  const previewImage = $('crewPostImagePreviewImage');
  const altLabel = $('crewPostImageAltLabel');
  const altInput = $('crewPostImageAlt');
  if (document.activeElement === altInput) altInput.blur();
  if (input) input.value = '';
  if (previewImage) previewImage.removeAttribute('src');
  if (preview) preview.hidden = true;
  if (altLabel) altLabel.hidden = true;
  if (altInput) {
    altInput.value = '';
    altInput.required = false;
  }
}

function setupCrewInfiniteScroll() {
  const sentinel = $('crewFeedSentinel');
  if (!sentinel || !('IntersectionObserver' in window)) return;
  const observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting) && state.crewFeed.hasMore) {
      loadCrewFeed();
    }
  }, { root: null, rootMargin: '180px 0px', threshold: 0.01 });
  observer.observe(sentinel);
}

async function bootCommunity() {
  $('crewStartDateInput').value = todayKey();
  $('journalDate').value = todayKey();

  if (!hasSupabaseAuth() && !isLocalDemoMode()) {
    redirectToLogin();
    return;
  }

  state.billing = await getBillingState();
  if (!state.billing.authenticated) {
    redirectToLogin();
    return;
  }
  if (!state.billing.appAccess) {
    window.location.href = './billing.html?intent=subscription';
    return;
  }

  takeIntegrationCallbackFragment();
  if (isLocalDemoMode()) setFeedback('Preview mode: crews, posts, comments, leaderboards, and journal entries are using mock local data.');
  await Promise.all([refreshCrews(), refreshGlobal(), refreshJournal()]);
  await Promise.all([prepareInviteIfPresent(), loadIntegrationSetup()]);
}

setupCrewInfiniteScroll();

$('openCrewFormButton')?.addEventListener('click', (event) => {
  state.createFormOpen = true;
  state.createRequestId = '';
  renderCrewShell();
  $('crewNameInput')?.focus();
  event.currentTarget.setAttribute('aria-expanded', 'true');
});

$('cancelCrewFormButton')?.addEventListener('click', () => {
  state.createFormOpen = false;
  state.createRequestId = '';
  $('crewForm')?.reset();
  $('crewStartDateInput').value = todayKey();
  renderCrewShell();
  $('openCrewFormButton')?.setAttribute('aria-expanded', 'false');
  $('openCrewFormButton')?.focus();
});

$('refreshCrewFeedButton')?.addEventListener('click', async (event) => {
  const release = setButtonBusy(event.currentTarget, 'Refreshing…');
  await loadCrewFeed({ reset: true });
  release();
});

$('crewPostBody')?.addEventListener('input', (event) => {
  $('crewPostCharacterCount').textContent = `${event.target.value.length.toLocaleString()} / 2,000`;
});

$('crewPostImage')?.addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  if (!file) {
    clearCrewPostImage();
    return;
  }
  if ((file.type && !ALLOWED_POST_IMAGE_TYPES.has(file.type)) || file.size > MAX_POST_IMAGE_BYTES) {
    clearCrewPostImage();
    window.alert(file.size > MAX_POST_IMAGE_BYTES
      ? 'Choose a photo smaller than 10 MB.'
      : 'Choose a JPG, PNG, WebP, or HEIC photo.');
    return;
  }
  if (crewPostImagePreviewUrl) URL.revokeObjectURL(crewPostImagePreviewUrl);
  crewPostImagePreviewUrl = URL.createObjectURL(file);
  $('crewPostImagePreviewImage').src = crewPostImagePreviewUrl;
  $('crewPostImagePreview').hidden = false;
  $('crewPostImageAltLabel').hidden = false;
  $('crewPostImageAlt').required = true;
});

$('removeCrewPostImage')?.addEventListener('click', clearCrewPostImage);

document.querySelectorAll('[data-leaderboard-window]').forEach((button) => {
  button.addEventListener('click', async () => {
    const scope = button.dataset.leaderboardScope;
    const nextWindow = button.dataset.leaderboardWindow;
    if (!state.leaderboards[scope] || state.leaderboards[scope].window === nextWindow) return;
    state.leaderboards[scope].window = nextWindow;
    renderLeaderboard(scope);
    await refreshLeaderboard(scope);
  });
});

$('crewForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  const release = setButtonBusy(button, 'Creating...');
  if (!state.createRequestId) {
    state.createRequestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  const createdInThisFlow = Boolean(state.createRequestId);
  try {
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
    state.createFormOpen = false;
    state.createRequestId = '';
    setFeedback(`${crew.name} is ready. Copy the invite link when you want to bring people in.`);
    await refreshCrews();
    if (shouldAutoStartCrewTraining({
      createdNew: crew.createdNew || createdInThisFlow,
      role: activeCrew()?.role,
      progress: state.trainingProgress,
    })) {
      await openCrewTraining({ trigger: $('crewTrainingButton') });
    }
  } catch (error) {
    window.alert(error?.message || 'Unable to create that crew right now.');
  } finally {
    release();
  }
});

$('crewIntegrationsCard')?.addEventListener('click', async (event) => {
  if (!GROUP_INTEGRATIONS_ENABLED) return;
  const connectButton = event.target.closest('[data-connect-provider]');
  const reconnectButton = event.target.closest('[data-reconnect-provider]');
  if (connectButton || reconnectButton) {
    const button = connectButton || reconnectButton;
    await beginIntegrationAuthorization(
      button.dataset.connectProvider || button.dataset.reconnectProvider,
      button,
    );
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
  if (!disconnectButton || !window.confirm('Disconnect this external channel? Queued updates will be canceled immediately.')) return;
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

$('crewLifecycleButton')?.addEventListener('click', (event) => openCrewLifecycleDialog(event.currentTarget));

$('cancelCrewLifecycleButton')?.addEventListener('click', () => {
  state.lifecycleRequestId = '';
  closeCrewDialog($('crewLifecycleDialog'));
});

$('crewLifecycleDialog')?.addEventListener('cancel', (event) => {
  event.preventDefault();
  state.lifecycleRequestId = '';
  closeCrewDialog(event.currentTarget);
});

$('confirmCrewLifecycleButton')?.addEventListener('click', async (event) => {
  const crew = activeCrew();
  if (!crew || !state.lifecycleRequestId) return;
  const action = state.lifecycleAction;
  const errorElement = $('crewLifecycleDialogError');
  errorElement.hidden = true;
  const release = setButtonBusy(event.currentTarget, action === 'delete' ? 'Deleting…' : 'Leaving…');
  try {
    if (action === 'delete') await deleteCrew(crew.id, state.lifecycleRequestId);
    else await leaveCrew(crew.id, state.lifecycleRequestId);
    clearTrainingHighlight();
    closeCrewDialog($('crewLifecycleDialog'));
    state.lifecycleRequestId = '';
    state.activeCrewId = '';
    localStorage.removeItem('dominion:activeCrewId');
    await refreshCrews();
    setFeedback(action === 'delete' ? `${crew.name} was deleted.` : `You left ${crew.name}.`);
  } catch (error) {
    errorElement.textContent = error?.message || `Unable to ${action} this crew right now.`;
    errorElement.hidden = false;
  } finally {
    release();
  }
});

$('cancelCrewInviteButton')?.addEventListener('click', () => {
  removeInviteFromUrl();
  state.inviteToken = '';
  state.invitePreview = null;
  closeCrewDialog($('crewInviteDialog'));
});

$('crewInviteDialog')?.addEventListener('cancel', (event) => {
  event.preventDefault();
  $('cancelCrewInviteButton').click();
});

$('confirmCrewInviteButton')?.addEventListener('click', async (event) => {
  if (!state.inviteToken || state.invitePreview?.hasOtherCrew) return;
  const errorElement = $('crewInviteDialogError');
  errorElement.hidden = true;
  const release = setButtonBusy(event.currentTarget, 'Joining…');
  try {
    const crew = await joinCrewByInvite(state.inviteToken);
    if (!crew?.id) throw new Error('This invitation is invalid or has expired.');
    state.activeCrewId = crew.id;
    localStorage.setItem('dominion:activeCrewId', crew.id);
    removeInviteFromUrl();
    state.inviteToken = '';
    state.invitePreview = null;
    closeCrewDialog($('crewInviteDialog'));
    await refreshCrews();
    setFeedback(`You joined ${crew.name}.`);
  } catch (error) {
    errorElement.textContent = error?.message || 'Unable to join this crew right now.';
    errorElement.hidden = false;
  } finally {
    release();
  }
});

$('crewTrainingButton')?.addEventListener('click', async (event) => {
  const progress = normalizeCrewTrainingProgress(state.trainingProgress);
  await openCrewTraining({ replay: progress.status === 'completed', trigger: event.currentTarget });
});

$('crewTrainingBackButton')?.addEventListener('click', async (event) => {
  if (state.trainingStep <= 0) return;
  const release = setButtonBusy(event.currentTarget, 'Saving…');
  try {
    state.trainingStep -= 1;
    await persistCrewTraining('in_progress', state.trainingStep);
    renderCrewTraining();
    $('crewTrainingNextButton').focus();
  } catch (error) {
    state.trainingStep += 1;
    $('crewTrainingError').textContent = error?.message || 'Unable to save your place.';
    $('crewTrainingError').hidden = false;
  } finally {
    release();
    event.currentTarget.disabled = state.trainingStep === 0;
  }
});

$('crewTrainingNextButton')?.addEventListener('click', async (event) => {
  const steps = trainingSteps();
  const isLast = state.trainingStep >= steps.length - 1;
  const release = setButtonBusy(event.currentTarget, isLast ? 'Finishing…' : 'Saving…');
  $('crewTrainingError').hidden = true;
  try {
    if (isLast) {
      await persistCrewTraining('completed', state.trainingStep);
      clearTrainingHighlight();
      closeCrewDialog($('crewTrainingDialog'));
      setFeedback('Crew training complete. You can replay it any time.');
    } else {
      state.trainingStep += 1;
      await persistCrewTraining('in_progress', state.trainingStep);
      renderCrewTraining();
    }
  } catch (error) {
    if (!isLast) state.trainingStep -= 1;
    $('crewTrainingError').textContent = error?.message || 'Unable to save crew training progress.';
    $('crewTrainingError').hidden = false;
  } finally {
    release();
  }
});

$('skipCrewTrainingButton')?.addEventListener('click', skipCrewTraining);

$('crewTrainingDialog')?.addEventListener('cancel', (event) => {
  event.preventDefault();
  skipCrewTraining();
});

$('copyInviteButton')?.addEventListener('click', async (event) => {
  const crew = activeCrew();
  if (!crew) return;
  const release = setButtonBusy(event.currentTarget, 'Preparing...');
  try {
    const invite = await getOrCreateCrewInvite(crew.id);
    const url = new URL('./community.html', window.location.href);
    url.searchParams.set('invite', invite.token);
    $('inviteLinkText').textContent = url.href;
    await navigator.clipboard?.writeText(url.href);
    setFeedback('Invite link copied.');
  } catch (error) {
    window.alert(error?.message || 'Unable to create an invite link right now.');
  } finally {
    release();
  }
});

$('crewPostForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const crew = activeCrew();
  const body = $('crewPostBody').value.trim();
  const imageFile = $('crewPostImage').files?.[0] || null;
  if (!crew || (!body && !imageFile)) {
    setFeedback('Write a message or add a photo before posting.');
    return;
  }
  const imageAlt = $('crewPostImageAlt').value.trim();
  if (imageFile && !imageAlt) {
    setFeedback('Add a short photo description so every group member can understand the image.');
    $('crewPostImageAlt').focus();
    return;
  }
  const release = setButtonBusy(event.submitter, 'Posting...');
  try {
    await createCommunityPost({ scope: 'crew', crewId: crew.id, body, imageFile, imageAlt });
    $('crewPostBody').value = '';
    $('crewPostCharacterCount').textContent = '0 / 2,000';
    clearCrewPostImage();
    await loadCrewFeed({ reset: true });
    setFeedback('Your post is live in this private group.');
  } catch (error) {
    window.alert(error?.message || 'Unable to post to your crew right now.');
  } finally {
    release();
  }
});

$('globalPostForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = $('globalPostBody').value.trim();
  if (!body) return;
  const release = setButtonBusy(event.submitter, 'Posting...');
  try {
    await createCommunityPost({ scope: 'global', body });
    $('globalPostBody').value = '';
    await refreshGlobal();
  } catch (error) {
    window.alert(error?.message || 'Unable to post globally right now.');
  } finally {
    release();
  }
});

document.addEventListener('click', async (event) => {
  const retryButton = event.target.closest('[data-retry-crew-feed]');
  if (retryButton) {
    await loadCrewFeed({ reset: true });
    $('crewFeedScroll')?.focus();
    return;
  }

  const loadMoreButton = event.target.closest('[data-load-more-crew]');
  if (loadMoreButton) {
    await loadCrewFeed();
    (document.querySelector('[data-load-more-crew]') || $('crewFeedScroll'))?.focus();
    return;
  }

  const editButton = event.target.closest('[data-edit-post]');
  if (editButton) {
    const post = findPost(editButton.dataset.editPost);
    if (!post?.isOwn) return;
    state.confirmingDeletePostId = '';
    state.editingPostId = post.id;
    renderPostScope(post.scope);
    document.querySelector(`[data-edit-post-form="${post.id}"] textarea`)?.focus();
    return;
  }

  const cancelEditButton = event.target.closest('[data-cancel-edit-post]');
  if (cancelEditButton) {
    const post = findPost(cancelEditButton.dataset.cancelEditPost);
    if (!post) return;
    state.editingPostId = '';
    renderPostScope(post.scope);
    document.querySelector(`[data-edit-post="${post.id}"]`)?.focus();
    return;
  }

  const deleteButton = event.target.closest('[data-delete-post]');
  if (deleteButton) {
    const post = findPost(deleteButton.dataset.deletePost);
    if (!post) return;
    state.editingPostId = '';
    state.confirmingDeletePostId = post.id;
    renderPostScope(post.scope);
    document.querySelector(`[data-confirm-delete-post="${post.id}"]`)?.focus();
    return;
  }

  const cancelDeleteButton = event.target.closest('[data-cancel-delete-post]');
  if (cancelDeleteButton) {
    const post = findPost(cancelDeleteButton.dataset.cancelDeletePost);
    if (!post) return;
    state.confirmingDeletePostId = '';
    renderPostScope(post.scope);
    document.querySelector(`[data-delete-post="${post.id}"]`)?.focus();
    return;
  }

  const confirmDeleteButton = event.target.closest('[data-confirm-delete-post]');
  if (confirmDeleteButton) {
    const post = findPost(confirmDeleteButton.dataset.confirmDeletePost);
    if (!post) return;
    confirmDeleteButton.disabled = true;
    try {
      await deleteCommunityPost(post.id, post.imagePath || null);
      if (post.scope === 'crew') {
        state.crewPosts = state.crewPosts.filter((item) => item.id !== post.id);
        $('crewPostCount').textContent = String(state.crewPosts.length);
      } else {
        state.globalPosts = state.globalPosts.filter((item) => item.id !== post.id);
      }
      state.confirmingDeletePostId = '';
      renderPostScope(post.scope);
      setFeedback(post.isOwn ? 'Post deleted.' : 'Post removed from the private group.');
      (post.scope === 'crew' ? $('crewFeedScroll') : $('globalFeed'))?.focus();
    } catch (error) {
      window.alert(error?.message || 'Unable to remove that post right now.');
      confirmDeleteButton.disabled = false;
    }
    return;
  }

  const deleteCommentButton = event.target.closest('[data-delete-comment]');
  if (deleteCommentButton) {
    const post = findPost(deleteCommentButton.dataset.postId);
    const comment = post?.comments.find((item) => item.id === deleteCommentButton.dataset.deleteComment);
    if (!post || !comment || !window.confirm('Remove this comment?')) return;
    deleteCommentButton.disabled = true;
    try {
      await deletePostComment(comment.id);
      post.comments = post.comments.filter((item) => item.id !== comment.id);
      renderPostScope(post.scope);
      setFeedback(comment.isOwn ? 'Comment deleted.' : 'Comment removed from the private group.');
      document.querySelector(`[data-comment-post="${post.id}"] input`)?.focus();
    } catch (error) {
      window.alert(error?.message || 'Unable to remove that comment right now.');
      deleteCommentButton.disabled = false;
    }
    return;
  }

  const likeButton = event.target.closest('[data-like-post]');
  if (likeButton) {
    const postId = likeButton.dataset.likePost;
    const post = findPost(postId);
    if (!post) return;
    likeButton.disabled = true;
    try {
      const shouldLike = !post.likedByMe;
      const ownReaction = await setPostLiked(postId, shouldLike);
      post.likeCount = Math.max(0, post.likeCount + (shouldLike ? 1 : -1));
      post.likedByMe = shouldLike;
      post.reactions = shouldLike && ownReaction
        ? [ownReaction, ...(post.reactions || []).filter((reaction) => !reaction.isOwn)].slice(0, 3)
        : (post.reactions || []).filter((reaction) => !reaction.isOwn);
      renderPostScope(post.scope);
      document.querySelector(`[data-like-post="${post.id}"]`)?.focus();
    } catch (error) {
      window.alert(error?.message || 'Unable to update that like right now.');
      likeButton.disabled = false;
    }
    return;
  }

  const focusButton = event.target.closest('[data-focus-comment]');
  if (focusButton) {
    document.querySelector(`[data-comment-post="${focusButton.dataset.focusComment}"] input`)?.focus();
  }
});

document.addEventListener('submit', async (event) => {
  const editForm = event.target.closest('[data-edit-post-form]');
  if (editForm) {
    event.preventDefault();
    const post = findPost(editForm.dataset.editPostForm);
    const body = editForm.elements.body.value.trim();
    if (!post?.isOwn || (!body && !post.imagePath)) return;
    if (body === post.body) {
      state.editingPostId = '';
      renderPostScope(post.scope);
      document.querySelector(`[data-edit-post="${post.id}"]`)?.focus();
      return;
    }
    const release = setButtonBusy(editForm.querySelector('button[type="submit"]'), 'Saving…');
    try {
      await updateCommunityPost(post.id, body);
      post.body = body;
      state.editingPostId = '';
      renderPostScope(post.scope);
      setFeedback('Post updated.');
      document.querySelector(`[data-edit-post="${post.id}"]`)?.focus();
    } catch (error) {
      window.alert(error?.message || 'Unable to update that post right now.');
      release();
    }
    return;
  }

  const form = event.target.closest('[data-comment-post]');
  if (!form) return;
  event.preventDefault();
  const postId = form.dataset.commentPost;
  const input = form.querySelector('input[name="comment"]');
  const body = input.value.trim();
  if (!body) return;
  const post = findPost(postId);
  const release = setButtonBusy(form.querySelector('button'), 'Posting...');
  try {
    const comment = await addPostComment(postId, body);
    input.value = '';
    if (post && comment) {
      post.comments.push(comment);
      renderPostScope(post.scope);
      document.querySelector(`[data-comment-post="${postId}"] input`)?.focus();
    }
  } catch (error) {
    window.alert(error?.message || 'Unable to add that comment right now.');
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
