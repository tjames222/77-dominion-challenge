import { initReveal } from './reveal';
import {
  claimRewardOffer,
  claimChallengeUnlocks,
  claimRewardEntitlementUnlocks,
  downloadRewardAsset,
  getAllRewardCatalog,
  getBillingState,
  getEarnedBadges,
  getLeaderboardPrestige,
  getLocalOrSessionUser,
  getRewardFulfillment,
  hasSupabaseAuth,
  isLocalDemoMode,
  redirectToLogin,
  startChallenge,
  subscribeToAuthStateChanges,
} from './api';
import {
  buildBadgesRewardsPageModel,
  escapeHtml,
} from './badges-rewards.mjs';
import { renderGameProgress } from './game-progress.mjs';
import {
  buildFulfillmentDialogModel,
} from './reward-fulfillment.mjs';

const $ = (id) => document.getElementById(id);
const ACTIVE_CREW_STORAGE_KEY = 'dominion:activeCrewId';
const LEADERBOARD_PRESTIGE_WINDOW = 'week';
const rewardNextPanel = $('rewardNextPanel');
const rewardsList = $('rewardsList');
const badgesGallery = $('badgesGallery');
const errorPanel = $('badgesRewardsError');
const retryButton = $('badgesRewardsRetry');
const tabs = Array.from(document.querySelectorAll('.badges-rewards-tab'));
const panels = Array.from(document.querySelectorAll('.badges-rewards-panel'));
const rewardDetailDialog = $('rewardDetailDialog');
const rewardDetailContent = $('rewardDetailContent');
const rewardDetailActions = $('rewardDetailActions');
const rewardDetailFeedback = $('rewardDetailFeedback');
let catalog = null;
let earnedBadges = [];
let pendingRewardKey = '';
let loadRequestId = 0;
let leaderboardPositions = {
  privateRank: null,
  crewId: null,
  window: LEADERBOARD_PRESTIGE_WINDOW,
};
let detailRequestId = 0;
let activeReward = null;
let activeFulfillment = {};
let rewardDetailReturnFocus = null;
let pageActorId = '';
let actorInvalidated = false;
let unsubscribeAuthState = () => {};

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

const formatPoints = (value) => `${Number(value || 0).toLocaleString()} ${Number(value || 0) === 1 ? 'point' : 'points'}`;

const rewardTypeLabel = (reward) => {
  if (reward.rewardType === 'partner_discount') return 'Partner discount';
  if (reward.rewardType === 'merch_discount') return 'Merchandise discount';
  if (reward.rewardType === 'digital_download') return 'Digital download';
  if (reward.rewardType === 'cosmetic') return 'Cosmetic reward';
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
  } else if (reward.hasDetails) {
    action = `<span class="reward-action-link reward-detail-label" aria-hidden="true">${reward.status === 'locked' ? 'View progress' : 'View reward'}</span>`;
  }
  const nextLabel = reward.isNext ? '<span class="reward-next-marker">Next unlock</span>' : '';
  const inactiveLabel = reward.active ? '' : '<span class="reward-inactive-marker">Unavailable for selection</span>';

  const visual = reward.thumbnailUrl
    ? `<img class="reward-row-thumbnail" src="${escapeHtml(reward.thumbnailUrl)}" alt="${escapeHtml(reward.thumbnailAlt)}" loading="lazy" decoding="async" />`
    : `<div class="reward-row-icon app-icon ${escapeHtml(reward.iconClass)}" aria-hidden="true"></div>`;
  const detailAttributes = reward.hasDetails && !reward.canStart && !reward.selectionHref
    ? ` role="button" tabindex="0" data-view-reward="${escapeHtml(reward.key)}" aria-haspopup="dialog" aria-label="${escapeHtml(`${reward.status === 'locked' ? 'View progress for' : 'View'} ${reward.title}`)}"`
    : '';
  return `<article class="reward-row is-${escapeHtml(reward.status)}${reward.isNext ? ' is-next' : ''}" data-reward-key="${escapeHtml(reward.key)}"${detailAttributes}>${visual}<div class="reward-row-main"><div class="reward-row-topline"><span>${escapeHtml(rewardTypeLabel(reward))}</span><span class="reward-status">${escapeHtml(reward.statusLabel)}</span></div><h3>${escapeHtml(reward.title)}</h3><p>${escapeHtml(reward.description)}</p>${progress}<div class="reward-row-footer"><small>${escapeHtml(reward.detail)} · ${formatPoints(reward.pointsRequired)} required</small>${action}</div></div>${nextLabel}${inactiveLabel}</article>`;
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
    if (eyebrow) eyebrow.textContent = 'Next reward';
    if (title) title.textContent = next.title;
    if (copy) copy.textContent = `${formatPoints(next.pointsRemaining)} to go · ${next.currentPoints.toLocaleString()} of ${next.pointsRequired.toLocaleString()} earned`;
    if (progress) {
      progress.hidden = false;
      progress.setAttribute('aria-valuemax', String(next.pointsRequired));
      progress.setAttribute('aria-valuenow', String(Math.min(next.currentPoints, next.pointsRequired)));
      progress.setAttribute('aria-valuetext', `${next.currentPoints} of ${next.pointsRequired} points earned toward ${next.title}`);
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
    if (copy) copy.textContent = 'Your points will keep adding up. New rewards will appear here when they’re available.';
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
  renderGameProgress(document, {
    totalPoints: model.totalPoints,
    privateRank: leaderboardPositions.privateRank,
  });
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
  const image = $('rewardUnlockNoticeImage');
  if (title) title.textContent = names.length === 1 ? names[0] : `${names.length} new rewards are open`;
  if (copy) copy.textContent = names.length === 1
    ? 'You earned this reward. See its current status below.'
    : `${names.join(', ')} are now reflected in your reward progression.`;
  const thumbnailUrl = unlocks.length === 1
    ? String(unlocks[0]?.metadata?.thumbnailUrl || unlocks[0]?.metadata?.thumbnail_url || '')
    : '';
  const safeThumbnail = /^\.\/images\/[a-z0-9._-]+\.(?:jpg|jpeg|png|webp)$/i.test(thumbnailUrl);
  const noticeIcon = notice.querySelector('.app-icon');
  if (noticeIcon) noticeIcon.hidden = safeThumbnail;
  if (image) {
    image.hidden = !safeThumbnail;
    if (safeThumbnail) {
      image.src = thumbnailUrl;
      image.alt = String(unlocks[0]?.metadata?.thumbnailAlt || unlocks[0]?.metadata?.thumbnail_alt || 'Unlocked reward');
    } else {
      image.removeAttribute('src');
      image.alt = '';
    }
  }
  notice.hidden = false;
  notice.scrollIntoView({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' });
}

function renderRewardDetail({ busy = false } = {}) {
  if (!activeReward || !rewardDetailDialog) return;
  const model = buildFulfillmentDialogModel(activeReward, activeFulfillment);
  const title = $('rewardDetailTitle');
  const eyebrow = $('rewardDetailEyebrow');
  const description = $('rewardDetailDescription');
  if (title) title.textContent = model.title;
  if (eyebrow) eyebrow.textContent = rewardTypeLabel(activeReward);
  if (description) description.textContent = activeReward.description;

  const thumbnail = activeReward.thumbnailUrl
    ? `<img class="reward-detail-thumbnail" src="${escapeHtml(activeReward.thumbnailUrl)}" alt="${escapeHtml(activeReward.thumbnailAlt)}" />`
    : '';
  const progress = model.showProgress
    ? `<div class="reward-detail-progress" role="progressbar" aria-label="Progress toward ${escapeHtml(model.title)}" aria-valuemin="0" aria-valuemax="${model.pointsRequired}" aria-valuenow="${Math.min(model.currentPoints, model.pointsRequired)}"><span style="--reward-progress:${activeReward.progressPercent}%"></span></div><p><strong>${formatPoints(model.pointsRemaining)}</strong> remaining</p>`
    : '';
  const encouragement = model.encouragement
    ? `<aside class="reward-detail-encouragement"><strong>Train with intention</strong><p>${escapeHtml(model.encouragement)}</p></aside>`
    : '';
  const offer = [
    model.partnerName ? `<p><strong>Partner</strong><span>${escapeHtml(model.partnerName)}</span></p>` : '',
    model.offerTitle ? `<p><strong>Offer</strong><span>${escapeHtml(model.offerTitle)}</span></p>` : '',
    model.description ? `<p><strong>Details</strong><span>${escapeHtml(model.description)}</span></p>` : '',
    model.edition ? `<p><strong>Edition</strong><span>${escapeHtml(model.edition)}</span></p>` : '',
    model.format ? `<p><strong>Format</strong><span>${escapeHtml(model.format)}</span></p>` : '',
    model.expiration ? `<p><strong>Expiration</strong><span>${escapeHtml(model.expiration)}</span></p>` : '',
    model.terms ? `<p><strong>Terms</strong><span>${escapeHtml(model.terms)}</span></p>` : '',
  ].filter(Boolean).join('');
  const code = model.code
    ? `<div class="reward-code"><span>Your code</span><code id="rewardDetailCode">${escapeHtml(model.code)}</code></div>`
    : '';
  if (rewardDetailContent) {
    rewardDetailContent.setAttribute('aria-busy', String(busy));
    rewardDetailContent.innerHTML = `${thumbnail}${progress}${encouragement}${model.message ? `<p class="reward-detail-message">${escapeHtml(model.message)}</p>` : ''}${offer ? `<div class="reward-detail-facts">${offer}</div>` : ''}${code}`;
  }

  const actions = [];
  if (model.canClaim || model.canReveal) actions.push(`<button class="reward-action-button" type="button" data-claim-reward-offer>${escapeHtml(model.actionLabel)}</button>`);
  if (model.canCopy) actions.push('<button class="reward-action-button" type="button" data-copy-reward-code>Copy code</button>');
  if (model.canVisitWebsite) actions.push(`<a class="reward-action-link" href="${escapeHtml(model.websiteUrl)}" target="_blank" rel="noopener noreferrer">Visit gym website</a>`);
  if (model.canVisitDestination) actions.push(`<a class="reward-action-link" href="${escapeHtml(model.destinationUrl)}" target="_blank" rel="noopener noreferrer">Redeem offer</a>`);
  if (model.canDownload) actions.push('<button class="reward-action-button" type="button" data-download-reward>Download handbook</button>');
  if (rewardDetailActions) rewardDetailActions.innerHTML = busy ? '' : actions.join('');
}

function scrubRewardDetail({ restoreFocus = false } = {}) {
  detailRequestId += 1;
  activeReward = null;
  activeFulfillment = {};
  const target = restoreFocus ? rewardDetailReturnFocus : null;
  rewardDetailReturnFocus = null;
  rewardDetailContent?.replaceChildren();
  rewardDetailActions?.replaceChildren();
  if (rewardDetailContent) rewardDetailContent.setAttribute('aria-busy', 'false');
  if (rewardDetailFeedback) rewardDetailFeedback.textContent = '';
  const title = $('rewardDetailTitle');
  const eyebrow = $('rewardDetailEyebrow');
  const description = $('rewardDetailDescription');
  if (title) title.textContent = 'Reward details';
  if (eyebrow) eyebrow.textContent = '';
  if (description) description.textContent = '';
  if (target?.isConnected) target.focus();
}

function dismissAndScrubRewardDetail({ restoreFocus = false } = {}) {
  const target = restoreFocus ? rewardDetailReturnFocus : null;
  rewardDetailReturnFocus = null;
  if (rewardDetailDialog?.open) rewardDetailDialog.close();
  scrubRewardDetail();
  if (target?.isConnected) target.focus();
}

function scrubAccountBoundPage() {
  catalog = null;
  earnedBadges = [];
  pendingRewardKey = '';
  dismissAndScrubRewardDetail();
  rewardsList?.replaceChildren();
  badgesGallery?.replaceChildren();
  const notice = $('rewardUnlockNotice');
  if (notice) notice.hidden = true;
  for (const id of [
    'rewardNextTitle',
    'rewardNextCopy',
    'rewardTotalPoints',
    'rewardsCatalogSummary',
    'badgesGallerySummary',
    'rewardsCatalogFeedback',
  ]) {
    const node = $(id);
    if (node) node.textContent = '';
  }
}

async function pageActorIsCurrent(expectedUserId = pageActorId) {
  if (!expectedUserId || expectedUserId !== pageActorId) return false;
  const user = await getLocalOrSessionUser();
  return Boolean(user?.authenticated && user.userId === expectedUserId && pageActorId === expectedUserId);
}

function invalidatePageActor(nextUser = null) {
  if (actorInvalidated) return;
  actorInvalidated = true;
  loadRequestId += 1;
  pendingRewardKey = '';
  pageActorId = '';
  scrubAccountBoundPage();
  unsubscribeAuthState();
  unsubscribeAuthState = () => {};
  if (nextUser?.authenticated && nextUser.userId) {
    window.location.assign('./badges-rewards.html');
  } else {
    redirectToLogin('./badges-rewards.html');
  }
}

async function openRewardDetail(rewardKey, trigger) {
  const reward = catalog?.items?.find((item) => item.key === rewardKey);
  const expectedUserId = pageActorId;
  if (!reward?.key || !reward.hasDetails || !rewardDetailDialog || !expectedUserId) return;
  const requestId = ++detailRequestId;
  activeReward = reward;
  activeFulfillment = reward.fulfillment || {};
  rewardDetailReturnFocus = trigger;
  if (rewardDetailFeedback) rewardDetailFeedback.textContent = 'Loading secure reward details…';
  if (rewardDetailContent) rewardDetailContent.setAttribute('aria-busy', 'true');
  renderRewardDetail({ busy: true });
  rewardDetailDialog.showModal();
  $('rewardDetailClose')?.focus();
  try {
    const nextFulfillment = await getRewardFulfillment(reward.key, { expectedUserId });
    if (requestId !== detailRequestId || !rewardDetailDialog.open || pageActorId !== expectedUserId) return;
    activeFulfillment = nextFulfillment;
    if (rewardDetailFeedback) rewardDetailFeedback.textContent = '';
    renderRewardDetail();
  } catch (error) {
    if (requestId !== detailRequestId || !rewardDetailDialog.open) return;
    if (!(await pageActorIsCurrent(expectedUserId))) {
      invalidatePageActor();
      return;
    }
    if (rewardDetailFeedback) rewardDetailFeedback.textContent = error?.message || 'Reward details are temporarily unavailable.';
    if (rewardDetailContent) rewardDetailContent.setAttribute('aria-busy', 'false');
  }
}

function closeRewardDetail() {
  if (rewardDetailDialog?.open) rewardDetailDialog.close();
  else scrubRewardDetail({ restoreFocus: true });
}

$('rewardDetailClose')?.addEventListener('click', closeRewardDetail);
rewardDetailDialog?.addEventListener('click', (event) => {
  if (event.target === rewardDetailDialog) closeRewardDetail();
});
rewardDetailDialog?.addEventListener('close', () => {
  scrubRewardDetail({ restoreFocus: true });
});

rewardDetailActions?.addEventListener('click', async (event) => {
  const claimButton = event.target.closest('[data-claim-reward-offer]');
  const copyButton = event.target.closest('[data-copy-reward-code]');
  const downloadButton = event.target.closest('[data-download-reward]');
  if (!activeReward || (!claimButton && !copyButton && !downloadButton)) return;
  const expectedUserId = pageActorId;
  const requestId = detailRequestId;
  if (!(await pageActorIsCurrent(expectedUserId))) {
    invalidatePageActor();
    return;
  }

  if (copyButton) {
    const code = String(activeFulfillment.code || '');
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      if (rewardDetailFeedback) rewardDetailFeedback.textContent = 'Discount code copied.';
    } catch {
      if (rewardDetailFeedback) rewardDetailFeedback.textContent = 'Select the code and copy it manually.';
    }
    return;
  }

  const button = claimButton || downloadButton;
  button.disabled = true;
  if (rewardDetailFeedback) rewardDetailFeedback.textContent = downloadButton ? 'Preparing secure download…' : 'Securing your discount code…';
  try {
    if (claimButton) {
      const nextFulfillment = await claimRewardOffer(activeReward.key, { expectedUserId });
      if (requestId !== detailRequestId || !rewardDetailDialog?.open || pageActorId !== expectedUserId) return;
      activeFulfillment = nextFulfillment;
      if (rewardDetailFeedback) rewardDetailFeedback.textContent = activeFulfillment.code
        ? 'Your code is ready.'
        : activeFulfillment.message || 'The offer is temporarily unavailable.';
      renderRewardDetail();
    } else {
      const result = await downloadRewardAsset(activeReward.key, { expectedUserId });
      if (requestId !== detailRequestId || !rewardDetailDialog?.open || pageActorId !== expectedUserId) return;
      if (result?.blob instanceof Blob) {
        if (rewardDetailFeedback) rewardDetailFeedback.textContent = 'Your download is ready.';
        const objectUrl = URL.createObjectURL(result.blob);
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = result.filename || activeFulfillment.downloadFilename || 'Nehemiah-Leadership-Handbook.pdf';
        link.hidden = true;
        document.body.append(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
      } else if (rewardDetailFeedback) {
        rewardDetailFeedback.textContent = result?.message || 'The approved handbook edition is not available yet.';
      }
    }
  } catch (error) {
    if (!(await pageActorIsCurrent(expectedUserId))) {
      invalidatePageActor();
      return;
    }
    if (rewardDetailFeedback) rewardDetailFeedback.textContent = error?.message || 'Unable to complete that reward action.';
  } finally {
    if (button.isConnected) button.disabled = false;
  }
});

function setLoading() {
  errorPanel.hidden = true;
  rewardNextPanel?.setAttribute('aria-busy', 'true');
  rewardsList?.setAttribute('aria-busy', 'true');
  badgesGallery?.setAttribute('aria-busy', 'true');
  const feedback = $('rewardsCatalogFeedback');
  if (feedback) feedback.textContent = 'Loading your complete reward history.';
}

async function loadBadgesAndRewards({ claimUnlocks = true } = {}) {
  const expectedUserId = pageActorId;
  if (!expectedUserId) return;
  const requestId = ++loadRequestId;
  setLoading();
  try {
    const [badgesResult, catalogResult, prestigeResult] = await Promise.allSettled([
      getEarnedBadges({ expectedUserId }),
      getAllRewardCatalog({ expectedUserId }),
      getLeaderboardPrestige({
        crewId: localStorage.getItem(ACTIVE_CREW_STORAGE_KEY),
        window: LEADERBOARD_PRESTIGE_WINDOW,
        expectedUserId,
      }),
    ]);
    if (badgesResult.status === 'rejected') throw badgesResult.reason;
    if (catalogResult.status === 'rejected') throw catalogResult.reason;
    if (requestId !== loadRequestId || pageActorId !== expectedUserId) return;
    earnedBadges = badgesResult.value;
    catalog = catalogResult.value;
    if (prestigeResult.status === 'fulfilled') {
      leaderboardPositions = prestigeResult.value;
      if (leaderboardPositions.crewId) {
        localStorage.setItem(ACTIVE_CREW_STORAGE_KEY, leaderboardPositions.crewId);
      }
    } else {
      console.warn('Unable to load private-group ranking', prestigeResult.reason);
      leaderboardPositions = {
        privateRank: null,
        crewId: null,
        window: LEADERBOARD_PRESTIGE_WINDOW,
      };
    }
    renderPage();

    const feedback = $('rewardsCatalogFeedback');
    if (feedback) feedback.textContent = '';
    if (!claimUnlocks) return;

    const [ownershipClaim, challengeClaim] = await Promise.allSettled([
      claimRewardEntitlementUnlocks({ expectedUserId }),
      claimChallengeUnlocks({ expectedUserId }),
    ]);
    if (requestId !== loadRequestId || pageActorId !== expectedUserId) return;
    const unlocks = [];
    if (ownershipClaim.status === 'fulfilled') {
      unlocks.push(...ownershipClaim.value.claimedUnlocks);
    }
    if (challengeClaim.status === 'fulfilled') {
      unlocks.push(...challengeClaim.value.claimedUnlocks);
    }
    catalog = await getAllRewardCatalog({ expectedUserId });
    if (requestId !== loadRequestId || pageActorId !== expectedUserId) return;
    renderPage();
    showUnlockNotice(unlocks);
  } catch (error) {
    if (requestId !== loadRequestId || pageActorId !== expectedUserId) return;
    if (!(await pageActorIsCurrent(expectedUserId))) {
      invalidatePageActor();
      return;
    }
    console.warn('Unable to load Badges & Rewards', error);
    errorPanel.hidden = false;
    const errorCopy = $('badgesRewardsErrorCopy');
    if (errorCopy) errorCopy.textContent = error?.message || 'Please try again in a moment.';
    const feedback = $('rewardsCatalogFeedback');
    if (feedback) feedback.textContent = 'Unable to load rewards.';
  }
}

rewardsList?.addEventListener('click', async (event) => {
  const detailCard = event.target.closest('[data-view-reward]');
  if (detailCard) {
    await openRewardDetail(detailCard.dataset.viewReward, detailCard);
    return;
  }
  const button = event.target.closest('[data-start-reward]');
  if (!button || pendingRewardKey) return;
  pendingRewardKey = button.dataset.startReward;
  renderPage();
  const feedback = $('rewardsCatalogFeedback');
  if (feedback) feedback.textContent = `Starting ${button.closest('[data-reward-key]')?.querySelector('h3')?.textContent || 'challenge'}…`;
  const expectedUserId = pageActorId;
  try {
    await startChallenge(pendingRewardKey, { expectedUserId });
    if (pageActorId !== expectedUserId) return;
    catalog = await getAllRewardCatalog({ expectedUserId });
    if (pageActorId !== expectedUserId) return;
    if (feedback) feedback.textContent = 'Challenge started. Your rewards are up to date.';
  } catch (error) {
    if (!(await pageActorIsCurrent(expectedUserId))) {
      invalidatePageActor();
      return;
    }
    if (feedback) feedback.textContent = error?.message || 'Unable to start that challenge right now.';
  } finally {
    pendingRewardKey = '';
    renderPage();
  }
});

rewardsList?.addEventListener('keydown', async (event) => {
  if (!['Enter', ' '].includes(event.key)) return;
  const detailCard = event.target.closest('[data-view-reward]');
  if (!detailCard || event.target !== detailCard) return;
  event.preventDefault();
  await openRewardDetail(detailCard.dataset.viewReward, detailCard);
});

retryButton?.addEventListener('click', () => loadBadgesAndRewards());

window.addEventListener('storage', (event) => {
  dismissAndScrubRewardDetail();
  if (['dominion:user', 'dominion:mockUserId', 'dominion:mockUserIdsByIdentity'].includes(event.key)) {
    void getLocalOrSessionUser()
      .then((user) => {
        if (!user?.authenticated || user.userId !== pageActorId) invalidatePageActor(user);
      })
      .catch(() => invalidatePageActor());
    return;
  }
  if ([
    'dominion:badges',
    'dominion:gameStats',
    'dominion:mockChallengeStates',
    'dominion:mockRewardEntitlements',
    ACTIVE_CREW_STORAGE_KEY,
  ].includes(event.key)) loadBadgesAndRewards({ claimUnlocks: false });
});

window.addEventListener('pagehide', () => {
  loadRequestId += 1;
  pageActorId = '';
  unsubscribeAuthState();
  unsubscribeAuthState = () => {};
  scrubAccountBoundPage();
});

window.addEventListener('pageshow', (event) => {
  if (event.persisted) window.location.reload();
});

async function bootBadgesAndRewards() {
  if (!hasSupabaseAuth() && !isLocalDemoMode()) {
    redirectToLogin('./badges-rewards.html');
    return;
  }

  const actor = await getLocalOrSessionUser();
  if (!actor?.authenticated || !actor.userId) {
    redirectToLogin('./badges-rewards.html');
    return;
  }
  pageActorId = actor.userId;

  const billing = await getBillingState();
  if (!billing.authenticated) {
    redirectToLogin('./badges-rewards.html');
    return;
  }
  if (!billing.appAccess) {
    window.location.href = './billing.html?intent=subscription';
    return;
  }

  const verifiedActor = await getLocalOrSessionUser();
  if (!verifiedActor?.authenticated || verifiedActor.userId !== pageActorId) {
    invalidatePageActor(verifiedActor);
    return;
  }
  unsubscribeAuthState = subscribeToAuthStateChanges(({ user }) => {
    if (!user?.authenticated || user.userId !== pageActorId) invalidatePageActor(user);
  });

  await loadBadgesAndRewards();
  requestAnimationFrame(() => initReveal());
}

bootBadgesAndRewards().catch((error) => {
  console.warn('Unable to boot Badges & Rewards', error);
  errorPanel.hidden = false;
  requestAnimationFrame(() => initReveal());
});
