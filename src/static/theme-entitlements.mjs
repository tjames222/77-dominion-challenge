import { DOMINION_NIGHT_THEME_REWARD } from './reward-catalog.mjs';

const safeNumber = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : fallback;
};

const rewardItems = (catalog) => Array.isArray(catalog?.items) ? catalog.items : [];

const rewardFulfillmentKey = (reward) => String(
  reward?.fulfillmentKey || reward?.fulfillment_key || '',
).trim();

const rewardStateModel = (reward) => reward?.stateModel || reward?.state_model;

const rewardForTheme = (catalog, themeId) => rewardItems(catalog)
  .find((reward) => rewardFulfillmentKey(reward) === themeId) || null;

const fallbackRewardForTheme = (themeId) => (
  themeId === DOMINION_NIGHT_THEME_REWARD.fulfillmentKey
    ? DOMINION_NIGHT_THEME_REWARD
    : null
);

const isOwnedReward = (reward) => Boolean(
  reward &&
  reward.active !== false &&
  rewardStateModel(reward) === 'ownership' &&
  reward.status === 'owned',
);

export function deriveAuthorizedThemeIds(catalog, registry = []) {
  if (!catalog || !Array.isArray(registry)) return [];

  return registry
    .filter((theme) => theme?.availability?.enabled && theme.availability.requiresEntitlement)
    .filter((theme) => isOwnedReward(rewardForTheme(catalog, theme.id)))
    .map((theme) => theme.id);
}

export function buildThemeOptionModels(catalog, registry = []) {
  const authorizedThemeIds = new Set(deriveAuthorizedThemeIds(catalog, registry));
  const totalPoints = safeNumber(catalog?.totalPoints ?? catalog?.total_points);
  const thresholds = rewardItems(catalog)
    .filter((reward) => reward?.active !== false)
    .map((reward) => safeNumber(reward?.pointsRequired ?? reward?.points_required))
    .filter((points) => points > 0);
  const lowestThreshold = thresholds.length ? Math.min(...thresholds) : null;

  return (Array.isArray(registry) ? registry : []).map((theme) => {
    const requiresEntitlement = Boolean(theme?.availability?.requiresEntitlement);
    const catalogReward = rewardForTheme(catalog, theme?.id);
    const reward = catalogReward || fallbackRewardForTheme(theme?.id);
    const pointsRequired = safeNumber(reward?.pointsRequired ?? reward?.points_required);
    const currentPoints = safeNumber(
      catalogReward?.currentPoints ?? catalogReward?.current_points,
      totalPoints,
    );
    const pointsRemaining = catalogReward
      ? safeNumber(
        catalogReward.pointsRemaining ?? catalogReward.points_remaining,
        Math.max(pointsRequired - currentPoints, 0),
      )
      : Math.max(pointsRequired - currentPoints, 0);
    const progressPercent = catalogReward
      ? Math.min(100, safeNumber(
        catalogReward.progressPercent ?? catalogReward.progress_percent,
        pointsRequired ? currentPoints / pointsRequired * 100 : 100,
      ))
      : Math.min(100, pointsRequired ? currentPoints / pointsRequired * 100 : 100);
    const featureEnabled = Boolean(theme?.availability?.enabled);
    const owned = authorizedThemeIds.has(theme?.id);
    const available = featureEnabled && (!requiresEntitlement || owned);
    const locked = requiresEntitlement && !owned;

    let reason = null;
    if (!featureEnabled) reason = 'This theme is not available in this release.';
    else if (requiresEntitlement && !catalogReward) reason = 'Theme ownership could not be verified.';
    else if (locked) reason = `${pointsRemaining} points to unlock.`;

    return {
      themeId: theme?.id || '',
      label: theme?.label || 'Theme',
      status: requiresEntitlement ? (owned ? 'owned' : 'locked') : 'public',
      available,
      locked,
      progressPercent: owned ? 100 : progressPercent,
      pointsRemaining: owned ? 0 : pointsRemaining,
      pointsRequired,
      currentPoints: owned ? pointsRequired : Math.min(currentPoints, pointsRequired || currentPoints),
      isLowestPointUnlock: Boolean(pointsRequired && lowestThreshold === pointsRequired),
      reason,
    };
  });
}
