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

export function resolveLeaderboardPrestige({ privateRank } = {}) {
  const normalizedPrivateRank = normalizeLeaderboardRank(privateRank);

  if (normalizedPrivateRank && normalizedPrivateRank <= 3) {
    return {
      key: `private-${normalizedPrivateRank}`,
      scope: 'private',
      rank: normalizedPrivateRank,
      crown: normalizedPrivateRank === 1 ? 'private' : null,
      shortLabel: `Crew #${normalizedPrivateRank}`,
      accessibleLabel: `Private group leaderboard, ${ordinal(normalizedPrivateRank)} place`,
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
