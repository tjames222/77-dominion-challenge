const REWARD_STATES = new Set(['locked', 'available', 'active', 'completed', 'owned']);
const BADGE_TIERS = new Set(['bronze', 'silver', 'gold']);
const ALLOWED_ICONS = new Set([
  'book',
  'calendar',
  'check',
  'crown',
  'dumbbell',
  'eye',
  'flag',
  'flame',
  'gift',
  'mountain',
  'palette',
  'repeat',
  'run',
  'shield',
  'spark',
  'star',
  'target',
]);

const safeWholeNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
};

const safePercent = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(Math.max(number, 0), 100) : 0;
};

const safeKey = (value) => String(value || '').trim();

export const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#039;',
}[character]));

export function iconClass(icon, fallback = 'target') {
  const normalized = String(icon || '').toLowerCase().replace(/[^a-z-]/g, '');
  return `icon-${ALLOWED_ICONS.has(normalized) ? normalized : fallback}`;
}

export function normalizeEarnedBadges(badges = []) {
  const byKey = new Map();
  for (const badge of Array.isArray(badges) ? badges : []) {
    const key = safeKey(badge?.key || badge?.badgeKey || badge?.badge_key);
    if (!key) continue;
    const normalized = {
      key,
      name: String(badge?.name || 'Badge'),
      description: String(badge?.description || 'Earned through faithful progress.'),
      category: safeKey(badge?.category) || 'challenge',
      tier: BADGE_TIERS.has(String(badge?.tier || '').toLowerCase())
        ? String(badge.tier).toLowerCase()
        : 'bronze',
      icon: String(badge?.icon || 'shield'),
      earnedAt: badge?.earnedAt || badge?.earned_at || null,
      entryDate: badge?.entryDate || badge?.entry_date || badge?.metadata?.entryDate || null,
      metadata: badge?.metadata && typeof badge.metadata === 'object' ? badge.metadata : {},
    };
    const existing = byKey.get(key);
    if (!existing || String(normalized.earnedAt || '') > String(existing.earnedAt || '')) {
      byKey.set(key, normalized);
    }
  }

  return [...byKey.values()].sort((left, right) => (
    String(right.earnedAt || right.entryDate || '').localeCompare(String(left.earnedAt || left.entryDate || ''))
    || left.key.localeCompare(right.key)
  ));
}

const safeAppRoute = (value) => {
  const route = String(value || '').trim();
  if (!/^(?:\.\/)?[a-z0-9-]+\.html(?:#[a-z0-9_-]+)?$/i.test(route)) return null;
  return route.startsWith('./') ? route : `./${route}`;
};

const readableDate = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
};

const rewardStatusLabel = (reward) => ({
  locked: reward.canAccess === false ? 'Access required' : 'Locked',
  available: 'Available',
  active: 'Active',
  completed: 'Completed',
  owned: 'Owned',
})[reward.status] || 'Locked';

export function rewardViewModel(reward = {}, nextRewardKey = '') {
  const stateModel = reward.stateModel || reward.state_model || 'ownership';
  const rawStatus = String(reward.status || 'locked');
  const status = REWARD_STATES.has(rawStatus) ? rawStatus : 'locked';
  const pointsRequired = safeWholeNumber(reward.pointsRequired ?? reward.points_required);
  const currentPoints = safeWholeNumber(reward.currentPoints ?? reward.current_points);
  const pointsRemaining = status === 'locked'
    ? safeWholeNumber(reward.pointsRemaining ?? reward.points_remaining ?? Math.max(pointsRequired - currentPoints, 0))
    : 0;
  const progressPercent = status === 'locked'
    ? safePercent(
      reward.progressPercent ?? reward.progress_percent
        ?? (pointsRequired ? currentPoints / pointsRequired * 100 : 100),
    )
    : 100;
  const metadata = reward.metadata && typeof reward.metadata === 'object' ? reward.metadata : {};
  const canAccess = reward.canAccess ?? reward.can_access ?? true;
  const allowedActions = Array.isArray(reward.allowedActions || reward.allowed_actions)
    ? reward.allowedActions || reward.allowed_actions
    : [];
  const ownedDate = readableDate(reward.ownedAt || reward.owned_at);
  const unlockedDate = readableDate(reward.unlockedAt || reward.unlocked_at);
  const startedDate = readableDate(reward.startedAt || reward.started_at);
  const completedDate = readableDate(reward.completedAt || reward.completed_at);
  let detail;

  if (!canAccess) {
    detail = 'Membership access is required for this reward.';
  } else if (status === 'locked') {
    detail = `${pointsRemaining.toLocaleString()} ${pointsRemaining === 1 ? 'point' : 'points'} remaining`;
  } else if (status === 'available') {
    detail = unlockedDate ? `Unlocked ${unlockedDate}` : 'Unlocked and ready to start';
  } else if (status === 'active') {
    detail = startedDate ? `Started ${startedDate}` : 'Challenge in progress';
  } else if (status === 'completed') {
    detail = completedDate ? `Completed ${completedDate}` : 'Challenge completed';
  } else {
    detail = ownedDate ? `Permanently owned · Unlocked ${ownedDate}` : 'Permanently owned';
  }

  return {
    key: safeKey(reward.key || reward.rewardKey || reward.reward_key),
    title: String(reward.title || 'Reward'),
    description: String(reward.description || ''),
    rewardType: safeKey(reward.rewardType || reward.reward_type) || 'reward',
    stateModel,
    status,
    statusLabel: rewardStatusLabel({ status, canAccess }),
    pointsRequired,
    currentPoints,
    pointsRemaining,
    progressPercent,
    detail,
    iconClass: iconClass(reward.icon, stateModel === 'ownership' ? 'gift' : 'target'),
    sortOrder: Number(reward.sortOrder ?? reward.sort_order) || 0,
    isNext: safeKey(reward.key || reward.rewardKey || reward.reward_key) === safeKey(nextRewardKey),
    canStart: stateModel === 'challenge_lifecycle'
      && status === 'available'
      && canAccess
      && allowedActions.includes('start'),
    selectionHref: stateModel === 'ownership' && status === 'owned' && reward.active !== false
      ? safeAppRoute(metadata.selectionRoute || metadata.selection_route)
      : null,
    selectionLabel: String(metadata.selectionLabel || metadata.selection_label || 'Select in Profile'),
    metadata,
    active: reward.active ?? reward.isActive ?? reward.is_active ?? true,
  };
}

export function badgeViewModel(badge = {}) {
  const [normalized] = normalizeEarnedBadges([badge]);
  if (!normalized) return null;
  const metadata = normalized.metadata;
  const details = [];
  const challengeDay = safeWholeNumber(metadata.challengeDay ?? metadata.challenge_day);
  const streak = safeWholeNumber(metadata.streak ?? metadata.appStreak ?? metadata.app_streak);
  const completedCount = safeWholeNumber(metadata.completedCount ?? metadata.completed_count);
  if (challengeDay) details.push(`Challenge Day ${challengeDay}`);
  if (streak) details.push(`${streak}-day streak`);
  if (completedCount) details.push(`${completedCount} of 7 standards`);

  return {
    ...normalized,
    iconClass: iconClass(normalized.icon, 'shield'),
    tierLabel: `${normalized.tier.charAt(0).toUpperCase()}${normalized.tier.slice(1)} badge`,
    earnedLabel: readableDate(normalized.earnedAt || normalized.entryDate),
    achievementDetails: details,
  };
}

export function buildBadgesRewardsPageModel({ catalog = {}, badges = [] } = {}) {
  const catalogItems = Array.isArray(catalog.items) ? catalog.items : [];
  const nextKey = safeKey(catalog.nextUnlock?.key || catalog.next_unlock?.key);
  const rewards = catalogItems
    .map((reward) => rewardViewModel(reward, nextKey))
    .filter((reward) => reward.key)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.key.localeCompare(right.key));
  const nextUnlock = rewards.find((reward) => reward.key === nextKey) || null;
  const lockedRewards = rewards.filter((reward) => reward.status === 'locked');
  const unlockedCount = rewards.length - lockedRewards.length;
  const normalizedBadges = normalizeEarnedBadges(badges)
    .map(badgeViewModel)
    .filter(Boolean);
  let summaryMode = 'progress';
  if (!rewards.length) summaryMode = 'empty';
  else if (!lockedRewards.length) summaryMode = 'complete';
  else if (!nextUnlock) summaryMode = 'access';

  return {
    totalPoints: safeWholeNumber(catalog.totalPoints ?? catalog.total_points),
    rewards,
    badges: normalizedBadges,
    nextUnlock,
    unlockedCount,
    summaryMode,
  };
}
