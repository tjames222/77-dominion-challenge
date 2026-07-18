import {
  addPostComment,
  createCommunityPost,
  createCrew,
  deleteCommunityPost,
  deletePostComment,
  getBillingState,
  getCommunityPostPage,
  getCommunityPosts,
  getCrews,
  getCrewMembers,
  getJournalEntries,
  getLeaderboard,
  getOrCreateCrewInvite,
  hasSupabaseAuth,
  isLocalDemoMode,
  joinCrewByInvite,
  redirectToLogin,
  saveJournalEntry,
  setPostLiked,
  updateCommunityPost,
  uploadJournalPhoto,
} from './api';

const tabs = Array.from(document.querySelectorAll('.community-tab'));
const panels = Array.from(document.querySelectorAll('.community-panel'));
const $ = (id) => document.getElementById(id);
const todayKey = () => new Date().toISOString().slice(0, 10);
const CREW_POST_PAGE_SIZE = 8;
const MAX_POST_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_POST_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
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
  const select = $('crewSelect');
  const manageCard = $('crewManageCard');
  const composerCard = $('crewComposerCard');
  const membersCard = $('crewMembersCard');
  const feedSection = $('crewFeedSection');
  const title = $('crewTitle');
  const description = $('crewDescription');

  if (select) {
    select.innerHTML = state.crews.map((item) => (
      `<option value="${item.id}" ${item.id === state.activeCrewId ? 'selected' : ''}>${escapeHtml(item.name)}</option>`
    )).join('');
  }

  if (manageCard) manageCard.hidden = !state.crews.length;
  if (composerCard) composerCard.hidden = !crew;
  if (membersCard) membersCard.hidden = !crew;
  if (feedSection) feedSection.hidden = !crew;

  if (!crew) {
    if (title) title.textContent = 'Create or join a crew.';
    if (description) description.textContent = 'Private crews keep accountability close: one start date, one channel, and people you actually know.';
    $('crewMemberCount').textContent = '0';
    $('crewDayCount').textContent = 'Day 1';
    $('crewPostCount').textContent = '0';
    $('crewFeed').innerHTML = emptyCard('Create a crew or open an invite link to start a private channel.');
    $('crewMemberList').innerHTML = '';
    state.leaderboards.crew.rows = [];
    renderLeaderboard('crew');
    return;
  }

  if (title) title.textContent = crew.name;
  if (description) description.textContent = crew.description || 'A private crew channel for this 77-day challenge.';
  $('crewDayCount').textContent = dayLabel(crew.challengeStartDate);
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
    timeline.innerHTML = emptyCard('Your private journal is ready. Save a note, add a progress photo, and start building the record.');
    return;
  }

  timeline.innerHTML = state.journalEntries.map((entry) => `
    <article class="card timeline-note">
      <span>${entry.day ? `Day ${entry.day}` : escapeHtml(entry.date)}</span>
      <strong>${escapeHtml(entry.win || entry.mood || 'Private entry')}</strong>
      ${entry.note ? `<p>${escapeHtml(entry.note)}</p>` : ''}
      ${entry.prayer ? `<p>${escapeHtml(entry.prayer)}</p>` : ''}
      ${entry.energy ? `<small>Energy: ${escapeHtml(entry.energy)}</small>` : ''}
      ${entry.photos.length ? `
        <div class="journal-photos">
          ${entry.photos.map((photo) => `
            <figure>
              <img src="${escapeHtml(photo.url)}" alt="${escapeHtml(photo.caption || 'Progress photo')}" />
              ${photo.caption ? `<figcaption>${escapeHtml(photo.caption)}</figcaption>` : ''}
            </figure>
          `).join('')}
        </div>
      ` : ''}
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
    loadCrewFeed({ reset: true }),
    refreshLeaderboard('crew'),
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
  if (!state.crews.some((crew) => crew.id === state.activeCrewId)) {
    state.activeCrewId = state.crews[0]?.id || '';
    localStorage.setItem('dominion:activeCrewId', state.activeCrewId);
  }
  await refreshCrew();
}

async function redeemInviteIfPresent() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('invite');
  if (!token) return;

  const crew = await joinCrewByInvite(token);
  if (crew?.id) {
    state.activeCrewId = crew.id;
    localStorage.setItem('dominion:activeCrewId', crew.id);
    setFeedback(`You joined ${crew.name}.`);
  }
  params.delete('invite');
  const nextUrl = `${window.location.pathname}${params.toString() ? `?${params}` : ''}${window.location.hash}`;
  window.history.replaceState({}, '', nextUrl);
}

let crewPostImagePreviewUrl = '';

function clearCrewPostImage() {
  if (crewPostImagePreviewUrl) URL.revokeObjectURL(crewPostImagePreviewUrl);
  crewPostImagePreviewUrl = '';
  const input = $('crewPostImage');
  const preview = $('crewPostImagePreview');
  const previewImage = $('crewPostImagePreviewImage');
  const altLabel = $('crewPostImageAltLabel');
  if (input) input.value = '';
  if (previewImage) previewImage.removeAttribute('src');
  if (preview) preview.hidden = true;
  if (altLabel) altLabel.hidden = true;
  if ($('crewPostImageAlt')) {
    $('crewPostImageAlt').value = '';
    $('crewPostImageAlt').required = false;
  }
}

function setupCrewInfiniteScroll() {
  const root = $('crewFeedScroll');
  const sentinel = $('crewFeedSentinel');
  if (!root || !sentinel || !('IntersectionObserver' in window)) return;
  const observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting) && state.crewFeed.hasMore) {
      loadCrewFeed();
    }
  }, { root, rootMargin: '180px 0px', threshold: 0.01 });
  observer.observe(sentinel);
}

function setupPullToRefresh() {
  const scroll = $('crewFeedScroll');
  const indicator = $('crewPullRefreshIndicator');
  if (!scroll || !indicator) return;
  let startY = null;
  let pullDistance = 0;

  const resetPull = () => {
    startY = null;
    pullDistance = 0;
    scroll.style.removeProperty('--pull-distance');
    indicator.classList.remove('visible', 'ready', 'refreshing');
    indicator.textContent = 'Pull down to refresh';
  };

  scroll.addEventListener('touchstart', (event) => {
    if (scroll.scrollTop > 0 || state.crewFeed.loading) return;
    startY = event.touches[0]?.clientY ?? null;
    pullDistance = 0;
  }, { passive: true });

  scroll.addEventListener('touchmove', (event) => {
    if (startY === null) return;
    if (scroll.scrollTop > 0) {
      resetPull();
      return;
    }
    pullDistance = Math.max(0, Math.min(96, ((event.touches[0]?.clientY ?? startY) - startY) * 0.55));
    indicator.classList.toggle('visible', pullDistance > 8);
    indicator.classList.toggle('ready', pullDistance >= 64);
    indicator.textContent = pullDistance >= 64 ? 'Release to refresh' : 'Pull down to refresh';
    scroll.style.setProperty('--pull-distance', `${pullDistance}px`);
  }, { passive: true });

  scroll.addEventListener('touchend', async () => {
    if (startY === null) return;
    const shouldRefresh = pullDistance >= 64;
    resetPull();
    if (shouldRefresh) {
      indicator.classList.add('visible', 'refreshing');
      indicator.textContent = 'Refreshing private feed…';
      await loadCrewFeed({ reset: true });
    }
    resetPull();
  }, { passive: true });

  scroll.addEventListener('touchcancel', resetPull, { passive: true });
}

async function bootCommunity() {
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

  if (isLocalDemoMode()) setFeedback('Preview mode: crews, posts, comments, leaderboards, and journal entries are using mock local data.');
  await redeemInviteIfPresent();
  await Promise.all([refreshCrews(), refreshGlobal(), refreshJournal()]);
}

setupCrewInfiniteScroll();
setupPullToRefresh();

$('crewSelect')?.addEventListener('change', async (event) => {
  state.activeCrewId = event.target.value;
  localStorage.setItem('dominion:activeCrewId', state.activeCrewId);
  setFeedback('');
  await refreshCrew();
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
    const savedEntry = await saveJournalEntry({
      date: $('journalDate').value,
      day: crew?.challengeStartDate ? Number(dayLabel(crew.challengeStartDate).replace('Day ', '')) : null,
      note: $('journalNote').value.trim(),
      win: $('journalWin').value.trim(),
      prayer: $('journalPrayer').value.trim(),
      mood: $('journalMood').value,
      energy: $('journalEnergy').value,
    });

    const photo = $('journalPhoto').files?.[0];
    if (photo) {
      await uploadJournalPhoto({
        entryId: savedEntry.id,
        file: photo,
        caption: $('journalPhotoCaption').value.trim(),
      });
      $('journalPhoto').value = '';
      $('journalPhotoCaption').value = '';
    }

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
