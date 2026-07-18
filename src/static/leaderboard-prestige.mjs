const ordinal = (rank) => {
  if (rank === 1) return '1st';
  if (rank === 2) return '2nd';
  return '3rd';
};

export function normalizeLeaderboardRank(value) {
  if (!['number', 'string'].includes(typeof value)) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const rank = Number(value);
  return Number.isInteger(rank) && rank > 0 ? rank : null;
}

export function resolveLeaderboardPrestige({ globalRank, privateRank } = {}) {
  const normalizedGlobalRank = normalizeLeaderboardRank(globalRank);
  const normalizedPrivateRank = normalizeLeaderboardRank(privateRank);

  if (normalizedGlobalRank && normalizedGlobalRank <= 3) {
    return {
      key: `global-${normalizedGlobalRank}`,
      scope: 'global',
      rank: normalizedGlobalRank,
      crown: normalizedGlobalRank === 1 ? 'global' : null,
      shortLabel: `Global #${normalizedGlobalRank}`,
      accessibleLabel: `Global leaderboard, ${ordinal(normalizedGlobalRank)} place`,
    };
  }

  if (normalizedPrivateRank && normalizedPrivateRank <= 3) {
    return {
      key: `private-${normalizedPrivateRank}`,
      scope: 'private',
      rank: normalizedPrivateRank,
      crown: normalizedPrivateRank === 1 ? 'private' : null,
      shortLabel: `Crew #${normalizedPrivateRank}`,
      accessibleLabel: `Private leaderboard, ${ordinal(normalizedPrivateRank)} place`,
    };
  }

  return {
    key: 'default',
    scope: null,
    rank: null,
    crown: null,
    shortLabel: '',
    accessibleLabel: 'No top-three leaderboard placement',
  };
}
