const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#039;',
}[character]));

export const formatRewardPoints = (value) => {
  const points = Number(value || 0);
  return `${points.toLocaleString()} ${points === 1 ? 'point' : 'points'}`;
};

export const rewardTypeLabel = (reward = {}) => {
  if (reward.rewardType === 'partner_discount') return 'Partner discount';
  if (reward.rewardType === 'merch_discount') return 'Merchandise discount';
  if (reward.rewardType === 'digital_download') return 'Digital download';
  if (reward.rewardType === 'cosmetic') return 'Cosmetic reward';
  const challengeType = String(reward.metadata?.challengeType || reward.rewardType || 'challenge')
    .replace(/_/g, ' ');
  return `${challengeType} challenge`;
};

export function renderRewardCard(reward = {}, { pendingRewardKey = '' } = {}) {
  const key = String(reward.key || '');
  const title = String(reward.title || 'Reward');
  const pointsRequired = Math.max(0, Number(reward.pointsRequired || 0));
  const currentPoints = Math.max(0, Number(reward.currentPoints || 0));
  const progressValue = Math.min(currentPoints, pointsRequired);
  const progress = reward.status === 'locked' && reward.active
    ? `<div class="reward-row-progress" role="progressbar" aria-label="Progress toward ${escapeHtml(title)}" aria-valuemin="0" aria-valuemax="${pointsRequired}" aria-valuenow="${progressValue}" aria-valuetext="${escapeHtml(`${currentPoints} of ${pointsRequired} points`)}"><span style="--reward-progress:${Number(reward.progressPercent || 0)}%"></span></div>`
    : '';

  const contextualActions = [];
  if (reward.canStart) {
    const pending = pendingRewardKey === key;
    contextualActions.push(`<button class="reward-action-button" type="button" data-start-reward="${escapeHtml(key)}"${pending ? ' disabled' : ''}>${pending ? 'Starting…' : 'Start challenge'}</button>`);
  } else if (reward.selectionHref) {
    contextualActions.push(`<a class="reward-action-link" href="${escapeHtml(reward.selectionHref)}">${escapeHtml(reward.selectionLabel)}</a>`);
  }

  contextualActions.push(`<button class="reward-action-link reward-progress-action" type="button" data-view-reward="${escapeHtml(key)}" aria-haspopup="dialog" aria-controls="rewardDetailDialog" aria-label="${escapeHtml(`View progress for ${title}`)}">View Progress</button>`);

  const visual = reward.thumbnailUrl
    ? `<img class="reward-row-thumbnail" src="${escapeHtml(reward.thumbnailUrl)}" alt="${escapeHtml(reward.thumbnailAlt)}" loading="lazy" decoding="async" />`
    : `<div class="reward-row-icon app-icon ${escapeHtml(reward.iconClass)}" aria-hidden="true"></div>`;
  const nextLabel = reward.isNext ? '<span class="reward-next-marker">Next unlock</span>' : '';
  const inactiveLabel = reward.active ? '' : '<span class="reward-inactive-marker">Unavailable for selection</span>';
  const classes = `reward-row is-${escapeHtml(reward.status)}${reward.isNext ? ' is-next' : ''}`;
  const detail = `${String(reward.detail || '')} · ${formatRewardPoints(pointsRequired)} required`;

  return `<article class="${classes}" data-reward-key="${escapeHtml(key)}">${visual}<div class="reward-row-main"><div class="reward-row-topline"><span>${escapeHtml(rewardTypeLabel(reward))}</span><span class="reward-status">${escapeHtml(reward.statusLabel)}</span></div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(reward.description)}</p>${progress}<div class="reward-row-footer"><small>${escapeHtml(detail)}</small><div class="reward-card-actions">${contextualActions.join('')}</div></div></div>${nextLabel}${inactiveLabel}</article>`;
}
