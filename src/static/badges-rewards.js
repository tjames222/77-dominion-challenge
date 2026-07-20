import { initReveal } from './reveal';
import {
  claimChallengeUnlocks,
  claimRewardEntitlementUnlocks,
  getAllRewardCatalog,
  getBillingState,
  getEarnedBadges,
  hasSupabaseAuth,
  isLocalDemoMode,
  redirectToLogin,
  startChallenge,
} from './api';
import {
  buildBadgesRewardsPageModel,
  escapeHtml,
} from './badges-rewards.mjs';

const $ = (id) => document.getElementById(id);
const rewardNextPanel = $('rewardNextPanel');
const rewardsList = $('rewardsList');
const badgesGallery = $('badgesGallery');
const errorPanel = $('badgesRewardsError');
const retryButton = $('badgesRewardsRetry');
let catalog = null;
let earnedBadges = [];
let pendingRewardKey = '';
let loadRequestId = 0;

const formatPoints = (value) => `${Number(value || 0).toLocaleString()} ${Number(value || 0) === 1 ? 'point' : 'points'}`;

const rewardTypeLabel = (reward) => {
  if (reward.stateModel === 'ownership') return 'Cosmetic reward';
  const challengeType = String(reward.metadata?.challengeType || reward.rewardType || 'challenge').replace(/_/g, ' ');
  return `${challengeType} challenge`;
};

const rewardCardMarkup = (reward) => {
  const progress = reward.status === 'locked' && reward.active
    ? `<div class="reward-row-progress" role="progressbar" aria-label="Progress toward ${escapeHtml(reward.title)}" aria-valuemin="0" aria-valuemax="${reward.pointsRequired}" aria-valuenow="${Math.min(reward.currentPoints, reward.pointsRequired)}" aria-valuetext="${escapeHtml(`${reward.currentPoints} of ${reward.pointsRequired} points`)}"><span style="--reward-progress:${reward.progressPercent}%"></span></div>`
    : '';
  let action = '';
  if (reward.canStart) {
    const pending = pendingRewardKey === reward.key;
    action = `<button class="reward-action-button" type="button" data-start-reward="${escapeHtml(reward.key)}"${pending ? ' disabled' : ''}>${pending ? 'Starting…' : 'Start challenge'}</button>`;
  } else if (reward.selectionHref) {
    action = `<a class="reward-action-link" href="${escapeHtml(reward.selectionHref)}">${escapeHtml(reward.selectionLabel)}</a>`;
  }
  const nextLabel = reward.isNext ? '<span class="reward-next-marker">Next unlock</span>' : '';
  const inactiveLabel = reward.active ? '' : '<span class="reward-inactive-marker">Unavailable for selection</span>';

  return `<article class="reward-row is-${escapeHtml(reward.status)}${reward.isNext ? ' is-next' : ''}" data-reward-key="${escapeHtml(reward.key)}"><div class="reward-row-icon app-icon ${escapeHtml(reward.iconClass)}" aria-hidden="true"></div><div class="reward-row-main"><div class="reward-row-topline"><span>${escapeHtml(rewardTypeLabel(reward))}</span><span class="reward-status">${escapeHtml(reward.statusLabel)}</span></div><h3>${escapeHtml(reward.title)}</h3><p>${escapeHtml(reward.description)}</p>${progress}<div class="reward-row-footer"><small>${escapeHtml(reward.detail)} · ${formatPoints(reward.pointsRequired)} required</small>${action}</div></div>${nextLabel}${inactiveLabel}</article>`;
};

const badgeCardMarkup = (badge) => {
  const details = [badge.earnedLabel ? `Earned ${badge.earnedLabel}` : 'Recently earned', ...badge.achievementDetails]
    .filter(Boolean)
    .join(' · ');
  return `<article class="badge-gallery-card ${escapeHtml(badge.tier)}" data-badge-key="${escapeHtml(badge.key)}"><span class="badge-gallery-icon app-icon ${escapeHtml(badge.iconClass)}" aria-hidden="true"></span><div><div class="badge-gallery-meta"><span>${escapeHtml(badge.tierLabel)}</span><small>${escapeHtml(details)}</small></div><h3>${escapeHtml(badge.name)}</h3><p>${escapeHtml(badge.description)}</p></div></article>`;
};

function renderNextUnlock(model) {
  const eyebrow = $('rewardNextEyebrow');
  const title = $('rewardNextTitle');
  const copy = $('rewardNextCopy');
  const total = $('rewardTotalPoints');
  const progress = $('rewardNextProgress');
  const fill = $('rewardNextProgressFill');
  rewardNextPanel?.setAttribute('aria-busy', 'false');
  if (total) total.textContent = formatPoints(model.totalPoints);

  if (model.nextUnlock) {
    const next = model.nextUnlock;
    if (eyebrow) eyebrow.textContent = 'Next unlock';
    if (title) title.textContent = next.title;
    if (copy) copy.textContent = `${formatPoints(next.pointsRemaining)} to go · ${model.totalPoints.toLocaleString()} of ${next.pointsRequired.toLocaleString()} earned`;
    if (progress) {
      progress.hidden = false;
      progress.setAttribute('aria-valuemax', String(next.pointsRequired));
      progress.setAttribute('aria-valuenow', String(Math.min(model.totalPoints, next.pointsRequired)));
      progress.setAttribute('aria-valuetext', `${model.totalPoints} of ${next.pointsRequired} points earned toward ${next.title}`);
    }
    if (fill) fill.style.setProperty('--reward-progress', `${next.progressPercent}%`);
    return;
  }

  if (progress) {
    progress.hidden = model.summaryMode === 'empty';
    progress.setAttribute('aria-valuemax', '1');
    progress.setAttribute('aria-valuenow', model.summaryMode === 'complete' ? '1' : '0');
    progress.setAttribute('aria-valuetext', model.summaryMode === 'complete' ? 'Every configured reward is unlocked' : 'No reachable next reward');
  }
  if (fill) fill.style.setProperty('--reward-progress', model.summaryMode === 'complete' ? '100%' : '0%');
  if (model.summaryMode === 'complete') {
    if (eyebrow) eyebrow.textContent = 'Progress complete';
    if (title) title.textContent = 'Every configured reward is open.';
    if (copy) copy.textContent = 'Keep building your lifetime total. New rewards will appear here when they are added.';
  } else if (model.summaryMode === 'access') {
    if (eyebrow) eyebrow.textContent = 'Access needed';
    if (title) title.textContent = 'A locked reward needs membership access.';
    if (copy) copy.textContent = 'Restore access to continue into the next available challenge.';
  } else {
    if (eyebrow) eyebrow.textContent = 'Reward catalog';
    if (title) title.textContent = 'No point rewards are configured yet.';
    if (copy) copy.textContent = 'Your lifetime points are still being tracked.';
  }
}

function renderPage() {
  if (!catalog) return;
  const model = buildBadgesRewardsPageModel({ catalog, badges: earnedBadges });
  renderNextUnlock(model);

  if (rewardsList) {
    rewardsList.setAttribute('aria-busy', 'false');
    rewardsList.innerHTML = model.rewards.length
      ? model.rewards.map(rewardCardMarkup).join('')
      : '<p class="badges-rewards-empty"><strong>No rewards are configured yet.</strong><span>Your lifetime points will keep accumulating.</span></p>';
  }
  const rewardSummary = $('rewardsCatalogSummary');
  if (rewardSummary) rewardSummary.textContent = model.rewards.length
    ? `${model.unlockedCount} of ${model.rewards.length} unlocked`
    : 'No rewards yet';

  if (badgesGallery) {
    badgesGallery.setAttribute('aria-busy', 'false');
    badgesGallery.innerHTML = model.badges.length
      ? model.badges.map(badgeCardMarkup).join('')
      : '<div class="badges-rewards-empty"><span class="app-icon icon-shield" aria-hidden="true"></span><div><strong>Your first badge is waiting.</strong><span>Complete an honest check-in to add proof of the work here.</span></div></div>';
  }
  const badgeSummary = $('badgesGallerySummary');
  if (badgeSummary) badgeSummary.textContent = model.badges.length
    ? `${model.badges.length} earned`
    : 'No badges yet';
}

function showUnlockNotice(unlocks = []) {
  const notice = $('rewardUnlockNotice');
  if (!notice || !unlocks.length) return;
  const names = [...new Set(unlocks.map((reward) => reward?.title).filter(Boolean))];
  const title = $('rewardUnlockNoticeTitle');
  const copy = $('rewardUnlockNoticeCopy');
  if (title) title.textContent = names.length === 1 ? names[0] : `${names.length} new rewards are open`;
  if (copy) copy.textContent = names.length === 1
    ? 'Your progress opened this reward. Its current state is shown below.'
    : `${names.join(', ')} are now reflected in your reward progression.`;
  notice.hidden = false;
  notice.scrollIntoView({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' });
}

function setLoading() {
  errorPanel.hidden = true;
  rewardNextPanel?.setAttribute('aria-busy', 'true');
  rewardsList?.setAttribute('aria-busy', 'true');
  badgesGallery?.setAttribute('aria-busy', 'true');
  const feedback = $('rewardsCatalogFeedback');
  if (feedback) feedback.textContent = 'Loading your complete reward history.';
}

async function loadBadgesAndRewards({ claimUnlocks = true } = {}) {
  const requestId = ++loadRequestId;
  setLoading();
  try {
    const [nextBadges, nextCatalog] = await Promise.all([
      getEarnedBadges(),
      getAllRewardCatalog(),
    ]);
    if (requestId !== loadRequestId) return;
    earnedBadges = nextBadges;
    catalog = nextCatalog;
    renderPage();

    const feedback = $('rewardsCatalogFeedback');
    if (feedback) feedback.textContent = '';
    if (!claimUnlocks) return;

    const [ownershipClaim, challengeClaim] = await Promise.allSettled([
      claimRewardEntitlementUnlocks(),
      claimChallengeUnlocks(),
    ]);
    if (requestId !== loadRequestId) return;
    const unlocks = [];
    if (ownershipClaim.status === 'fulfilled') {
      unlocks.push(...ownershipClaim.value.claimedUnlocks);
    }
    if (challengeClaim.status === 'fulfilled') {
      unlocks.push(...challengeClaim.value.claimedUnlocks);
    }
    catalog = await getAllRewardCatalog();
    if (requestId !== loadRequestId) return;
    renderPage();
    showUnlockNotice(unlocks);
  } catch (error) {
    if (requestId !== loadRequestId) return;
    console.warn('Unable to load Badges & Rewards', error);
    errorPanel.hidden = false;
    const errorCopy = $('badgesRewardsErrorCopy');
    if (errorCopy) errorCopy.textContent = error?.message || 'Please try again in a moment.';
    const feedback = $('rewardsCatalogFeedback');
    if (feedback) feedback.textContent = 'Unable to load rewards.';
  }
}

rewardsList?.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-start-reward]');
  if (!button || pendingRewardKey) return;
  pendingRewardKey = button.dataset.startReward;
  renderPage();
  const feedback = $('rewardsCatalogFeedback');
  if (feedback) feedback.textContent = `Starting ${button.closest('[data-reward-key]')?.querySelector('h3')?.textContent || 'challenge'}…`;
  try {
    await startChallenge(pendingRewardKey);
    catalog = await getAllRewardCatalog();
    if (feedback) feedback.textContent = 'Challenge started. Your reward progression is updated.';
  } catch (error) {
    if (feedback) feedback.textContent = error?.message || 'Unable to start that challenge right now.';
  } finally {
    pendingRewardKey = '';
    renderPage();
  }
});

retryButton?.addEventListener('click', () => loadBadgesAndRewards());

window.addEventListener('storage', (event) => {
  if ([
    'dominion:badges',
    'dominion:gameStats',
    'dominion:mockChallengeStates',
    'dominion:mockRewardEntitlements',
  ].includes(event.key)) loadBadgesAndRewards({ claimUnlocks: false });
});

async function bootBadgesAndRewards() {
  if (!hasSupabaseAuth() && !isLocalDemoMode()) {
    redirectToLogin('./badges-rewards.html');
    return;
  }

  const billing = await getBillingState();
  if (!billing.authenticated) {
    redirectToLogin('./badges-rewards.html');
    return;
  }
  if (!billing.appAccess) {
    window.location.href = './billing.html?intent=subscription';
    return;
  }

  await loadBadgesAndRewards();
  requestAnimationFrame(() => initReveal());
}

bootBadgesAndRewards().catch((error) => {
  console.warn('Unable to boot Badges & Rewards', error);
  errorPanel.hidden = false;
  requestAnimationFrame(() => initReveal());
});
