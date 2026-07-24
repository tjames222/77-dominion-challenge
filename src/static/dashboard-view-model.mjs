export function shouldUseZeroPointGlass({ totalPoints, prestigeRank } = {}) {
  const points = Number(totalPoints);
  const rank = Number(prestigeRank);
  const hasPodiumPrestige = Number.isInteger(rank) && rank >= 1 && rank <= 3;
  return Number.isFinite(points) && points === 0 && !hasPodiumPrestige;
}
