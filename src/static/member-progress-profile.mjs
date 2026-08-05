import { calculateLevelProgress } from './point-economy.mjs';

export const MEMBER_PROGRESS_BADGE_PAGE_SIZE = 12;
export const MEMBER_PROGRESS_REVALIDATION_COOLDOWN_MS = 2_000;
export const MEMBER_PROGRESS_UNAVAILABLE = 'Member progress is no longer available.';

const safeText = (value, fallback = '', maxLength = 500) => {
  const normalized = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  return (normalized || fallback).slice(0, maxLength);
};

const safeWholeNumber = (value, fallback = 0) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : fallback;
};

export function memberProgressRoleLabel(role) {
  if (role === 'owner') return 'Group leader';
  if (role === 'admin') return 'Leader';
  return 'Member';
}

export function normalizeMemberProgressBadge(rawBadge = {}) {
  const key = safeText(rawBadge.key ?? rawBadge.badge_key, '', 120);
  if (!key) return null;
  const tier = ['bronze', 'silver', 'gold'].includes(rawBadge.tier)
    ? rawBadge.tier
    : 'bronze';
  const rawIcon = safeText(rawBadge.icon, 'shield', 40).toLowerCase();
  const icon = /^[a-z0-9_-]+$/.test(rawIcon) ? rawIcon : 'shield';
  const earnedAt = safeText(rawBadge.earnedAt ?? rawBadge.earned_at, '', 40);

  return {
    key,
    name: safeText(rawBadge.name, 'Badge', 120),
    description: safeText(rawBadge.description, '', 500),
    tier,
    icon,
    earnedAt: Number.isFinite(Date.parse(earnedAt)) ? new Date(earnedAt).toISOString() : '',
  };
}

export function normalizeMemberProgressProfile(rawProfile = {}, { expectedMemberId = '' } = {}) {
  const memberId = safeText(rawProfile.memberId ?? rawProfile.member_id, '', 128);
  if (!memberId || (expectedMemberId && memberId !== expectedMemberId)) {
    throw new Error(MEMBER_PROGRESS_UNAVAILABLE);
  }

  const cursor = rawProfile.nextCursor ?? rawProfile.next_cursor;
  const earnedAt = safeText(cursor?.earnedAt ?? cursor?.earned_at, '', 40);
  const badgeKey = safeText(cursor?.badgeKey ?? cursor?.badge_key, '', 120);
  const hasMore = Boolean(rawProfile.hasMore ?? rawProfile.has_more);
  const nextCursor = hasMore
    && Number.isFinite(Date.parse(earnedAt))
    && badgeKey
    ? { earnedAt: new Date(earnedAt).toISOString(), badgeKey }
    : null;
  const badges = Array.isArray(rawProfile.badges)
    ? rawProfile.badges.map(normalizeMemberProgressBadge).filter(Boolean)
    : [];
  const badgeCount = Math.max(safeWholeNumber(
    rawProfile.badgeCount ?? rawProfile.badge_count,
    badges.length,
  ), badges.length);

  return {
    memberId,
    displayName: safeText(rawProfile.displayName ?? rawProfile.display_name, 'Member', 80),
    avatarUrl: safeText(rawProfile.avatarUrl ?? rawProfile.avatar_url, '', 2048),
    role: ['owner', 'admin'].includes(rawProfile.role) ? rawProfile.role : 'member',
    level: Math.max(1, safeWholeNumber(rawProfile.level, 1)),
    badgeCount,
    badges,
    hasMore: Boolean(hasMore && nextCursor),
    nextCursor,
  };
}

export function mergeMemberProgressBadgePage(currentProfile, nextPage) {
  const current = normalizeMemberProgressProfile(currentProfile, {
    expectedMemberId: currentProfile?.memberId,
  });
  const next = normalizeMemberProgressProfile(nextPage, {
    expectedMemberId: current.memberId,
  });
  const badges = [];
  const seen = new Set();
  [...current.badges, ...next.badges].forEach((badge) => {
    if (seen.has(badge.key)) return;
    seen.add(badge.key);
    badges.push(badge);
  });

  return {
    ...current,
    displayName: next.displayName,
    avatarUrl: next.avatarUrl,
    role: next.role,
    level: next.level,
    badgeCount: Math.max(next.badgeCount, badges.length),
    badges,
    hasMore: next.hasMore,
    nextCursor: next.nextCursor,
  };
}

export function createMemberProgressRequestGate() {
  let revision = 0;
  let active = null;

  return {
    begin({ crewId, memberId, kind = 'profile' }) {
      revision += 1;
      active = {
        crewId: safeText(crewId, '', 128),
        memberId: safeText(memberId, '', 128),
        kind,
        revision,
      };
      return { ...active };
    },
    invalidate() {
      revision += 1;
      active = null;
      return revision;
    },
    isCurrent(request, { crewId, memberId } = {}) {
      if (!request || !active || request.revision !== active.revision) return false;
      if (crewId !== undefined && active.crewId !== crewId) return false;
      if (memberId !== undefined && active.memberId !== memberId) return false;
      return true;
    },
    pendingFor(crewId, memberId, kind = 'profile') {
      return Boolean(
        active
        && active.crewId === crewId
        && active.memberId === memberId
        && active.kind === kind
      );
    },
  };
}

export function createMemberProgressRevalidationGate({
  cooldownMs = MEMBER_PROGRESS_REVALIDATION_COOLDOWN_MS,
  now = () => globalThis.performance?.now?.() ?? Date.now(),
} = {}) {
  const minimumInterval = Math.max(0, Number(cooldownMs) || 0);
  let revision = 0;
  let activeRevision = 0;
  let inFlight = false;
  let lastStartedAt = Number.NEGATIVE_INFINITY;

  return {
    begin({ bypassCooldown = false } = {}) {
      const startedAt = Number(now());
      const timestamp = Number.isFinite(startedAt) ? startedAt : 0;
      if (inFlight || (!bypassCooldown && timestamp - lastStartedAt < minimumInterval)) {
        return null;
      }
      revision += 1;
      activeRevision = revision;
      inFlight = true;
      lastStartedAt = timestamp;
      return { revision };
    },
    finish(token) {
      if (!token || token.revision !== activeRevision) return false;
      inFlight = false;
      return true;
    },
    reset() {
      revision += 1;
      activeRevision = revision;
      inFlight = false;
      lastStartedAt = Number.NEGATIVE_INFINITY;
    },
    get inFlight() {
      return inFlight;
    },
  };
}

// Demo data still uses the one shared FOU-846 calculator; Community never
// owns a second level formula or points-per-level constant.
export function mockLifetimeLevel(totalPoints) {
  return calculateLevelProgress(totalPoints).level;
}
