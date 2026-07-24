const timestampValue = (value) => {
  if (!value) return Number.NEGATIVE_INFINITY;
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
};

const badgeTimestamp = (badge = {}) => (
  badge.earnedAt
  || badge.earned_at
  || badge.unlockedAt
  || badge.unlocked_at
  || ''
);

const badgeFallbackKey = (badge = {}) => [
  badge.key,
  badge.id,
  badge.name,
  badge.entryDate,
  badge.earnedDate,
].map((value) => String(value || '')).join('|');

export function compareBadgesNewestFirst(left = {}, right = {}) {
  const timestampOrder = timestampValue(badgeTimestamp(right)) - timestampValue(badgeTimestamp(left));
  if (timestampOrder) return timestampOrder;
  return badgeFallbackKey(left).localeCompare(badgeFallbackKey(right));
}

export function selectLatestBadge(badges = []) {
  return [...badges].filter(Boolean).sort(compareBadgesNewestFirst)[0] || null;
}

const accountabilityTimestamp = (post = {}) => post.createdAt || post.created_at || '';

const accountabilityFallbackKey = (post = {}) => [
  post.id,
  post.userId,
  post.date,
  post.day,
  post.name,
  post.status,
].map((value) => String(value || '')).join('|');

export function compareAccountabilityNewestFirst(left = {}, right = {}) {
  const timestampOrder = timestampValue(accountabilityTimestamp(right)) - timestampValue(accountabilityTimestamp(left));
  if (timestampOrder) return timestampOrder;
  return accountabilityFallbackKey(right).localeCompare(accountabilityFallbackKey(left));
}

export function selectLatestAccountabilityPosts(posts = [], limit = 3) {
  const safeLimit = Math.max(0, Math.floor(Number(limit) || 0));
  return [...posts].filter(Boolean).sort(compareAccountabilityNewestFirst).slice(0, safeLimit);
}

export function countCompletedToday(posts = []) {
  return posts.filter((post) => post?.status === 'complete' && post?.timestamp === 'Today').length;
}

export function completedTodayLabel(posts = [], authoritativeCount = null) {
  const parsedCount = Number(authoritativeCount);
  const count = authoritativeCount !== null
    && authoritativeCount !== undefined
    && Number.isInteger(parsedCount)
    && parsedCount >= 0
    ? parsedCount
    : countCompletedToday(posts);
  return `${count} ${count === 1 ? 'person' : 'people'} completed today`;
}

export function normalizeBadgeTier(badge = {}) {
  const tier = String(badge.tier || '').toLowerCase();
  return ['bronze', 'silver', 'gold'].includes(tier) ? tier : 'bronze';
}
