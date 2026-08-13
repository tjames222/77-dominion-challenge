import { POINTS_PER_LEVEL, calculateLevelProgress } from './point-economy.mjs';
import { resolveLeaderboardPrestige } from './leaderboard-prestige.mjs';
import { shouldUseZeroPointGlass } from './dashboard-view-model.mjs';

const safeRank = (value) => {
  const rank = Number(value);
  return Number.isInteger(rank) && rank > 0 ? rank : null;
};

export function buildGameProgressModel({ totalPoints = 0, privateRank = null } = {}) {
  const level = calculateLevelProgress(totalPoints);
  const normalizedRank = safeRank(privateRank);
  const resolvedPrestige = resolveLeaderboardPrestige({ privateRank: normalizedRank });
  const zeroPointGlass = shouldUseZeroPointGlass({
    totalPoints: level.totalPoints,
    prestigeRank: normalizedRank,
  });
  const prestige = zeroPointGlass ? resolveLeaderboardPrestige({}) : resolvedPrestige;
  const levelLabel = prestige.shortLabel
    ? `Level ${level.level} · ${prestige.shortLabel}`
    : `Level ${level.level}`;
  const emblemLabel = `Level ${level.level} — ${zeroPointGlass ? 'Zero-point glass coin — ' : ''}${prestige.accessibleLabel}`;
  let momentumMessage = `${level.pointsToNext.toLocaleString()} points to Level ${level.nextLevel}.`;

  if (level.totalPoints === 0) {
    momentumMessage = 'Post your first check-in to start earning points.';
  } else if (level.pointsToNext <= 3) {
    momentumMessage = `${level.pointsToNext} more ${level.pointsToNext === 1 ? 'point' : 'points'} to reach Level ${level.nextLevel}.`;
  }

  return {
    ...level,
    prestige,
    zeroPointGlass,
    levelLabel,
    emblemLabel,
    momentumMessage,
  };
}

export function renderGameProgress(root, values = {}) {
  const model = buildGameProgressModel(values);
  const byId = (id) => root?.getElementById?.(id) || root?.querySelector?.(`#${id}`) || null;
  const card = byId('gameSummaryCard');
  const emblem = byId('gameLevelEmblem');
  const crown = byId('gameLevelCrown');
  const prestigeStatus = byId('gamePrestigeStatus');
  const progress = byId('gameLevelProgress');

  if (byId('gamePointsTotal')) byId('gamePointsTotal').textContent = model.totalPoints.toLocaleString();
  if (byId('gameLevelNumber')) byId('gameLevelNumber').textContent = String(model.level);
  if (byId('gameLevelLabel')) byId('gameLevelLabel').textContent = model.levelLabel;
  if (byId('gameLevelProgressLabel')) byId('gameLevelProgressLabel').textContent = `Level ${model.level} progress`;
  if (byId('gamePointsToNext')) byId('gamePointsToNext').textContent = `${model.pointsToNext.toLocaleString()} points to Level ${model.nextLevel}`;
  if (byId('gameMomentumMessage')) byId('gameMomentumMessage').textContent = model.momentumMessage;

  if (emblem) {
    emblem.dataset.prestige = model.prestige.key;
    if (model.zeroPointGlass) emblem.dataset.material = 'zero-glass';
    else delete emblem.dataset.material;
    emblem.setAttribute('aria-label', model.emblemLabel);
    emblem.title = model.emblemLabel;
  }

  if (crown) {
    crown.hidden = !model.prestige.crown;
    if (model.prestige.crown) crown.dataset.crown = model.prestige.crown;
    else delete crown.dataset.crown;
  }

  if (prestigeStatus && prestigeStatus.textContent !== model.prestige.accessibleLabel) {
    prestigeStatus.textContent = model.prestige.accessibleLabel;
  }

  if (progress) {
    progress.setAttribute('aria-valuemax', String(POINTS_PER_LEVEL));
    progress.setAttribute('aria-valuenow', String(model.pointsIntoLevel));
    progress.setAttribute('aria-valuetext', `${model.pointsIntoLevel} of ${POINTS_PER_LEVEL} points earned toward Level ${model.nextLevel}`);
  }
  byId('gameLevelProgressFill')?.style.setProperty('--level-progress', `${model.progressPercent}%`);
  card?.setAttribute('aria-busy', 'false');

  return model;
}
