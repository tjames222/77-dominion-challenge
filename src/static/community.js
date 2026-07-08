import {
  addPostComment,
  createCommunityPost,
  createCrew,
  getBillingState,
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
  uploadJournalPhoto,
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
  crewPosts: [],
  globalPosts: [],
  leaderboards: {
    crew: { window: 'week', rows: [] },
    global: { window: 'week', rows: [] },
  },
  journalEntries: [],
};

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;
    tabs.forEach((item) => item.classList.toggle('active', item === tab));
    panels.forEach((panel) => panel.classList.toggle('active', panel.id === target));
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

function renderAccess() {
  const title = $('communityMembershipTitle');
  const copy = $('communityMembershipCopy');
  const link = $('communityMembershipLink');
  if (!title || !copy || !link || !state.billing) return;

  if (state.billing.subscriptionActive) {
    title.textContent = 'Your Dominion subscription is active.';
    copy.textContent = 'Private crews, global encouragement, comments, likes, and your journal are open.';
    link.textContent = 'Manage subscription';
    link.href = './profile.html#billing';
    return;
  }

  title.textContent = 'Subscription needed.';
  copy.textContent = 'Subscribe for $7/month to unlock private crews, community posts, comments, likes, and your journal.';
  link.textContent = 'Subscribe';
  link.href = './billing.html?intent=subscription';
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
        <div class="leaderboard-player">
          <strong>${escapeHtml(row.name)}</strong>
          <small>${dayLabelText} · ${row.currentAppStreak || 0} day app streak</small>
          ${badges}
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
  if (scope === 'crew' && !crew) {
    state.leaderboards.crew.rows = [];
    renderLeaderboard('crew');
    return;
  }

  try {
    state.leaderboards[scope].rows = await getLeaderboard({
      scope,
      crewId: scope === 'crew' ? crew.id : null,
      window: state.leaderboards[scope].window,
    });
  } catch (error) {
    console.warn(`Unable to load ${scope} leaderboard`, error);
    state.leaderboards[scope].rows = [];
  }
  renderLeaderboard(scope);
}

function renderCrewShell() {
  const crew = activeCrew();
  const select = $('crewSelect');
  const manageCard = $('crewManageCard');
  const composerCard = $('crewComposerCard');
  const title = $('crewTitle');
  const description = $('crewDescription');

  if (select) {
    select.innerHTML = state.crews.map((item) => (
      `<option value="${item.id}" ${item.id === state.activeCrewId ? 'selected' : ''}>${escapeHtml(item.name)}</option>`
    )).join('');
  }

  if (manageCard) manageCard.hidden = !state.crews.length;
  if (composerCard) composerCard.hidden = !crew;

  if (!crew) {
    if (title) title.textContent = 'Create or join a crew.';
    if (description) description.textContent = 'Private crews keep accountability close: one start date, one channel, and people you actually know.';
    $('crewMemberCount').textContent = '0';
    $('crewDayCount').textContent = 'Day 1';
    $('crewPostCount').textContent = '0';
    $('crewFeed').innerHTML = emptyCard('Create a crew or open an invite link to start a private channel.');
    state.leaderboards.crew.rows = [];
    renderLeaderboard('crew');
    return;
  }

  if (title) title.textContent = crew.name;
  if (description) description.textContent = crew.description || 'A private crew channel for this 77-day challenge.';
  $('crewDayCount').textContent = dayLabel(crew.challengeStartDate);
}

function renderMembers() {
  $('crewMemberCount').textContent = String(state.crewMembers.length);
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

  container.innerHTML = posts.map((post) => `
    <article class="feed-card card" data-post-id="${post.id}" data-scope="${post.scope}">
      <div>
        <strong>${escapeHtml(post.name)}</strong>
        <span>${escapeHtml(post.timestamp)}</span>
      </div>
      <p>${escapeHtml(post.body)}</p>
      <div class="reaction-row">
        <button type="button" class="${post.likedByMe ? 'active' : ''}" data-like-post="${post.id}">
          ${post.likedByMe ? 'Liked' : 'Like'} · ${post.likeCount}
        </button>
        <button type="button" data-focus-comment="${post.id}">Comment · ${post.comments.length}</button>
      </div>
      <div class="comment-list">
        ${post.comments.map((comment) => `
          <article class="comment-item">
            <strong>${escapeHtml(comment.name)}</strong>
            <p>${escapeHtml(comment.body)}</p>
          </article>
        `).join('')}
      </div>
      <form class="comment-form" data-comment-post="${post.id}">
        <input type="text" name="comment" placeholder="Write a comment..." autocomplete="off" required />
        <button type="submit">Post</button>
      </form>
    </article>
  `).join('');
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

async function refreshCrew() {
  renderCrewShell();
  const crew = activeCrew();
  if (!crew) return;
  const [members, posts] = await Promise.all([
    getCrewMembers(crew.id),
    getCommunityPosts({ scope: 'crew', crewId: crew.id }),
    refreshLeaderboard('crew'),
  ]);
  state.crewMembers = members;
  state.crewPosts = posts;
  $('crewPostCount').textContent = String(posts.length);
  renderMembers();
  renderPosts(posts, 'crewFeed');
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

  renderAccess();
  if (isLocalDemoMode()) setFeedback('Preview mode: crews, posts, comments, leaderboards, and journal entries are using mock local data.');
  await redeemInviteIfPresent();
  await Promise.all([refreshCrews(), refreshGlobal(), refreshJournal()]);
}

$('crewSelect')?.addEventListener('change', async (event) => {
  state.activeCrewId = event.target.value;
  localStorage.setItem('dominion:activeCrewId', state.activeCrewId);
  setFeedback('');
  await refreshCrew();
});

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
  if (!crew || !body) return;
  const release = setButtonBusy(event.submitter, 'Posting...');
  try {
    await createCommunityPost({ scope: 'crew', crewId: crew.id, body });
    $('crewPostBody').value = '';
    await refreshCrew();
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
  const likeButton = event.target.closest('[data-like-post]');
  if (likeButton) {
    const postId = likeButton.dataset.likePost;
    const post = [...state.crewPosts, ...state.globalPosts].find((item) => item.id === postId);
    if (!post) return;
    likeButton.disabled = true;
    try {
      await setPostLiked(postId, !post.likedByMe);
      await (post.scope === 'crew' ? refreshCrew() : refreshGlobal());
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
  const form = event.target.closest('[data-comment-post]');
  if (!form) return;
  event.preventDefault();
  const postId = form.dataset.commentPost;
  const input = form.querySelector('input[name="comment"]');
  const body = input.value.trim();
  if (!body) return;
  const post = [...state.crewPosts, ...state.globalPosts].find((item) => item.id === postId);
  const release = setButtonBusy(form.querySelector('button'), 'Posting...');
  try {
    await addPostComment(postId, body);
    input.value = '';
    await (post?.scope === 'crew' ? refreshCrew() : refreshGlobal());
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
