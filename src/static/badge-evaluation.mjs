import catalog from './badge-catalog.v1.json' with { type: 'json' };

export const BADGE_CATALOG = Object.freeze(catalog.badges.map((badge) => Object.freeze(badge)));
export const BADGE_CATALOG_VERSION = catalog.schemaVersion;
const actions = new Set(['bible', 'morningPrayer', 'worshipOnly', 'eveningPrayer', 'workoutOne', 'walk', 'workoutTwo']);
const difficulties = new Set(['easy', 'medium', 'hard', 'extreme']);
const oneDay = 86_400_000;
const dayNumber = (date) => {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const value = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(value) && new Date(value).toISOString().slice(0, 10) === date ? value / oneDay : null;
};
const completed = (event) => [...new Set(Array.isArray(event.completed) ? event.completed : [])].filter((id) => actions.has(id));
const validCompleted = (event) => Array.isArray(event.completed) && event.completed.length >= 1
  && event.completed.length <= 7 && completed(event).length === event.completed.length;
const instance = (event) => {
  const date = dayNumber(event.localDate);
  return date !== null && Number.isInteger(event.challengeDay) && event.challengeDay >= 1 && event.challengeDay <= 77
    ? `original77:${new Date((date - event.challengeDay + 1) * oneDay).toISOString().slice(0, 10)}` : '';
};

// This adapter accepts committed preview events, not mutable drafts or totals.
// The server independently derives the same facts from its canonical records.
export function checkInBadgeFacts(event, committed = []) {
  const scope = instance(event);
  const date = dayNumber(event.localDate);
  if (!scope || !event.sourceId || !Number.isFinite(Date.parse(event.occurredAt)) || !validCompleted(event)) return null;
  const byDate = new Map();
  for (const row of [...committed, event]) {
    if (!row.sourceId || !Number.isFinite(Date.parse(row.occurredAt)) || !validCompleted(row) || dayNumber(row.localDate) === null) continue;
    if (dayNumber(row.localDate) > date) continue;
    // Published dates are unique. Contradictory duplicates are not evidence.
    const prior = byDate.get(row.localDate);
    if (prior && prior.sourceId !== row.sourceId) return null;
    byDate.set(row.localDate, row);
  }
  const history = [...byDate.values()];
  const sameInstance = history.filter((row) => instance(row) === scope);
  const perfectDates = new Set(sameInstance.filter((row) => completed(row).length === 7).map((row) => dayNumber(row.localDate)));
  let streak = 0;
  while (perfectDates.has(date - streak)) streak += 1;
  const explicit = event.workoutDifficultySelections ?? event.workoutDifficulty ?? {};
  const workouts = {};
  for (const [id, action] of [['one', 'workoutOne'], ['two', 'workoutTwo']]) {
    if (completed(event).includes(action) && difficulties.has(explicit[id]) && !Object.hasOwn(workouts, explicit[id])) workouts[explicit[id]] = id;
  }
  return { source: 'check_in', sourceId: event.sourceId, occurredAt: event.occurredAt, localDate: event.localDate,
    instanceId: scope, check_in_count: history.length, instance_check_in_count: sameInstance.length,
    partial_count: completed(event).length < 7 ? history.filter((row) => completed(row).length < 7).length : 0,
    perfect_count: completed(event).length === 7 ? history.filter((row) => completed(row).length === 7).length : 0,
    perfect_streak: streak, completedCount: completed(event).length, workouts };
}

export function appVisitBadgeFacts(event, committed = []) {
  const date = dayNumber(event.localDate);
  if (date === null || !event.sourceId || !Number.isFinite(Date.parse(event.occurredAt))) return null;
  const dates = new Set([...committed, event].filter((row) => row.sourceId && Number.isFinite(Date.parse(row.occurredAt))).map((row) => dayNumber(row.localDate)));
  let streak = 0;
  while (dates.has(date - streak)) streak += 1;
  return { source: 'app_visit', sourceId: event.sourceId, occurredAt: event.occurredAt, localDate: event.localDate, instanceId: '', app_streak: streak };
}

export function badgeRuleMatches(rule, facts) {
  if (rule.status !== 'active' || rule.criteriaVersion !== 1 || rule.source !== facts?.source) return false;
  if (rule.scope === 'challenge_instance' && !facts.instanceId) return false;
  if (rule.metric === 'workout') return Object.hasOwn(facts.workouts || {}, rule.predicate)
    && ['one', 'two'].includes(facts.workouts[rule.predicate]);
  if (!['check_in_count', 'partial_count', 'perfect_count', 'instance_check_in_count', 'perfect_streak', 'app_streak', 'verified_share'].includes(rule.metric)) return false;
  return Number.isInteger(facts[rule.metric]) && facts[rule.metric] === rule.threshold;
}

export function badgeEarningEvidence(rule, facts) {
  if (rule.metric === 'workout') return { schemaVersion: 1, kind: 'workout', workout: facts.workouts[rule.predicate], difficulty: rule.predicate };
  if (rule.metric === 'partial_count' || rule.metric === 'perfect_count') return { schemaVersion: 1, kind: 'daily_standards', completedCount: facts.completedCount };
  const kind = { perfect_streak: 'perfect_streak', app_streak: 'app_streak', verified_share: 'share' }[rule.metric] || 'check_in';
  return { schemaVersion: 1, kind, qualifyingValue: facts[rule.metric] };
}

export function evaluateBadgeEvent(facts, earned = []) {
  if (!facts?.sourceId || dayNumber(facts.localDate) === null || !Number.isFinite(Date.parse(facts.occurredAt))) return [];
  return BADGE_CATALOG.filter((rule) => badgeRuleMatches(rule, facts)).filter((rule) => !earned.some((award) =>
    (award.key || award.badge_key) === rule.key && (award.scopeKey || award.scope_key || 'lifetime') === (rule.scope === 'lifetime' ? 'lifetime' : facts.instanceId),
  )).map((rule) => ({
    key: rule.key, name: rule.name, description: rule.description, requirement: rule.requirement,
    tier: rule.tier, icon: rule.icon, category: rule.series, displayOrder: rule.displayOrder,
    scopeKey: rule.scope === 'lifetime' ? 'lifetime' : facts.instanceId,
    earnedAt: facts.occurredAt, entryDate: facts.localDate, legacy: false, retired: false,
    earningEvidence: badgeEarningEvidence(rule, facts), celebrationSeenAt: null,
    metadata: { criteriaVersion: rule.criteriaVersion, sourceType: facts.source, sourceRecordId: facts.sourceId,
      challengeInstanceId: facts.instanceId || null, qualifyingValue: rule.metric === 'workout' ? 1 : facts[rule.metric] },
  }));
}

export const badgeCatalogOrder = (left, right) => {
  const order = (badge) => BADGE_CATALOG.find((rule) => rule.key === badge.key)?.displayOrder ?? 10000;
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
