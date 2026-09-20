import { BADGE_DISPLAY_ORDER } from './badge-display-order.generated.mjs';

export const PREVIEW_BADGE_STATE_KEY = 'dominion:badgeState:v1';
const BADGE_TIERS = new Set(['bronze', 'silver', 'gold']);
const difficulties = new Set(['easy', 'medium', 'hard', 'extreme']);
const safeKey = (value) => String(value || '').trim();

export const badgeCatalogOrder = (left, right) => {
  const order = (badge) => BADGE_DISPLAY_ORDER.find(([key]) => key === badge.key)?.[1] ?? 10000;
  return order(left) - order(right) || String(left.earnedAt || '').localeCompare(String(right.earnedAt || '')) || String(left.key).localeCompare(String(right.key));
};

export function badgeCelebrationReason(badge) {
  const evidence = badge?.earningEvidence;
  if (evidence?.schemaVersion !== 1) return badge?.requirement || 'An earned part of your badge collection.';
  const count = evidence.qualifyingValue;
  if (evidence.kind === 'workout' && ['one', 'two'].includes(evidence.workout) && difficulties.has(evidence.difficulty)) {
    const label = evidence.difficulty[0].toUpperCase() + evidence.difficulty.slice(1);
    return `You completed Workout ${evidence.workout === 'one' ? 'One' : 'Two'} at ${label} difficulty.`;
  }
  if (evidence.kind === 'daily_standards' && Number.isInteger(evidence.completedCount) && evidence.completedCount >= 1 && evidence.completedCount <= 7) return `You posted ${evidence.completedCount} of the seven Daily Actions.`;
  if (!Number.isInteger(count) || count < 1) return badge?.requirement || 'An earned part of your badge collection.';
  if (evidence.kind === 'check_in') return count === 1 ? 'You posted your first check-in.' : `You posted ${count} check-ins in your challenge.`;
  if (evidence.kind === 'perfect_streak') return `You completed all seven Daily Actions for ${count} days in a row.`;
  if (evidence.kind === 'app_streak') return `You visited the app for ${count} days in a row.`;
  if (evidence.kind === 'share') return 'You completed a verified share.';
  return badge?.requirement || 'An earned part of your badge collection.';
}

export const validBadgeTimestamp = (value) => {
  if (typeof value !== 'string') return null;
  const parts = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/);
  if (!parts || Number(parts[2]) > 23 || Number(parts[3]) > 59 || Number(parts[4]) > 59) return null;
  const day = new Date(`${parts[1]}T00:00:00Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== parts[1]) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
};

export function badgeAwardIdentity(badge = {}) {
  const awardId = safeKey(badge?.awardId || badge?.id);
  if (awardId) return `award:${awardId}`;
  const key = safeKey(badge?.key || badge?.badgeKey || badge?.badge_key);
  const scope = safeKey(badge?.scopeKey || badge?.scope_key) || 'lifetime';
  return key ? `badge:${JSON.stringify([key, scope])}` : '';
}

export function normalizeEarnedBadges(badges = []) {
  const byKey = new Map();
  for (const badge of Array.isArray(badges) ? badges : []) {
    const key = safeKey(badge?.key || badge?.badgeKey || badge?.badge_key);
    if (!key) continue;
    const awardId = safeKey(badge?.awardId || badge?.id);
    const scopeKey = safeKey(badge?.scopeKey || badge?.scope_key) || 'lifetime';
    const identity = badgeAwardIdentity(badge);
    const normalized = {
      key,
      awardId,
      scopeKey,
      name: String(badge?.name || 'Badge'),
      description: String(badge?.description || 'Earned through challenge progress.'),
      category: safeKey(badge?.category) || 'challenge',
      tier: BADGE_TIERS.has(String(badge?.tier || '').toLowerCase())
        ? String(badge.tier).toLowerCase()
        : 'bronze',
      icon: String(badge?.icon || 'shield'),
      earnedAt: badge?.earnedAt || badge?.earned_at || null,
      entryDate: badge?.entryDate || badge?.entry_date || badge?.metadata?.entryDate || null,
      metadata: badge?.metadata && typeof badge.metadata === 'object' ? badge.metadata : {},
      requirement: Object.hasOwn(badge, 'requirement')
        ? String(badge.requirement || '')
        : String(badge?.metadata?.awardDefinition?.requirement || badge?.metadata?.requirement || badge?.description || ''),
      earningEvidence: badge?.earningEvidence || badge?.earning_evidence || badge?.metadata?.earningEvidence || null,
      legacy: badge?.legacy === true || badge?.metadata?.legacy === true,
      retired: badge?.retired === true || badge?.metadata?.retired === true,
      displayOrder: Number.isFinite(badge?.displayOrder) ? badge.displayOrder : 10000,
    };
    const existing = byKey.get(identity);
    if (!existing || (validBadgeTimestamp(normalized.earnedAt) ?? -Infinity) > (validBadgeTimestamp(existing.earnedAt) ?? -Infinity)) {
      byKey.set(identity, normalized);
    }
  }

  return [...byKey.values()].sort((left, right) => (
    ((validBadgeTimestamp(right.earnedAt) ?? -Infinity) - (validBadgeTimestamp(left.earnedAt) ?? -Infinity))
    || left.key.localeCompare(right.key)
    || left.scopeKey.localeCompare(right.scopeKey)
  ));
}
