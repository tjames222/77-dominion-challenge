import catalog from './badge-catalog.v1.json' with { type: 'json' };
import { normalizeChallengeInstance } from './challenge-instance-contract.mjs';

export const BADGE_CATALOG = Object.freeze(catalog.badges.map((badge) => Object.freeze(badge)));
export const BADGE_CATALOG_VERSION = catalog.schemaVersion;
const actions = new Set(['bible', 'morningPrayer', 'worshipOnly', 'eveningPrayer', 'workoutOne', 'walk', 'workoutTwo']);
const difficulties = new Set(['easy', 'medium', 'hard', 'extreme']);
const oneDay = 86_400_000;
const minimumDay = Date.parse('0001-01-01T00:00:00Z') / oneDay;
const maximumDay = Date.parse('9999-12-31T00:00:00Z') / oneDay;
const dayNumber = (date) => {
  if (typeof date !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const value = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(value) && new Date(value).toISOString().slice(0, 10) === date ? value / oneDay : null;
};
const completed = (event) => [...new Set(Array.isArray(event.completed) ? event.completed : [])].filter((id) => actions.has(id));
const validCompleted = (event) => Array.isArray(event.completed) && event.completed.length >= 1
  && event.completed.length <= 7 && completed(event).length === event.completed.length;
const instance = (event) => {
  const date = dayNumber(event.localDate);
  if (date === null || !Number.isSafeInteger(event.challengeDay) || event.challengeDay < 1) return '';
  const start = date - event.challengeDay + 1;
  const legacy = start >= minimumDay && start <= maximumDay
    ? `original77:${new Date(start * oneDay).toISOString().slice(0, 10)}` : '';
  if (Object.hasOwn(event, 'instanceId') || Object.hasOwn(event, 'scopeKey')) {
    const id = Object.getOwnPropertyDescriptor(event, 'instanceId');
    const scope = Object.getOwnPropertyDescriptor(event, 'scopeKey');
    if (!id || !scope || !Object.hasOwn(id, 'value') || !Object.hasOwn(scope, 'value') || !completionUuid(id.value)) return '';
    return scope.value === `instance:${id.value}` || scope.value === legacy ? scope.value : '';
  }
  return legacy;
};

// Only the owner-fenced preview INSERT reducer calls this adapter. A generic
// metric/client flag, a collection read, or a serialized copy of facts cannot
// mint a completion award. This is preview integrity, not server authorization;
// production derives and persists its own event entirely inside PostgreSQL.
const liveCompletionFacts = new WeakSet();
const previewIdentity = value => typeof value === 'string' && value.length > 0
  && value.length <= 160 && !/[^A-Za-z0-9:_-]/u.test(value);
const completionUuid = value => typeof value === 'string' && value.length === 36
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const completionStamp = value => {
  if (typeof value !== 'string') return false;
  const parts = /^(?!0000)(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts || parts[0] !== value || dayNumber(parts[1]) === null || +parts[2] > 23 || +parts[3] > 59 || +parts[4] > 59
    || parts[5] === '-00:00' || (parts[5] !== 'Z' && (+parts[5].slice(1, 3) > 15 || +parts[5].slice(4, 6) > 59))) return false;
  const stamp = Date.parse(value);
  return Number.isFinite(stamp) && stamp >= minimumDay * oneDay && stamp < (maximumDay + 1) * oneDay;
};
function ownFields(value, fields, exact = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (exact && Reflect.ownKeys(descriptors).length !== fields.length) return null;
  const result = {};
  for (const field of fields) {
    if (!descriptors[field]?.enumerable || !Object.hasOwn(descriptors[field], 'value')) return null;
    result[field] = descriptors[field].value;
  }
  return result;
}
function ownList(value, length) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (descriptors.length?.value !== length || Reflect.ownKeys(descriptors).length !== length + 1) return null;
  const result = [];
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[index];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    result.push(descriptor.value);
  }
  return result;
}

export function original77CompletionBadgeFacts(input) {
  try {
    const data = ownFields(input, ['userId', 'startDate', 'event', 'priorEvents', 'completionEvent'], true);
    if (!data || !previewIdentity(data.userId) || dayNumber(data.startDate) === null) return null;
    const prior = ownList(data.priorEvents, 76);
    const completion = ownFields(data.completionEvent,
      ['id', 'userId', 'startDate', 'sourceId', 'localDate', 'recordedAt', 'persistedAt'], true);
    if (!prior || !completion || !completionUuid(completion.id) || completion.userId !== data.userId
      || completion.startDate !== data.startDate || !completionStamp(completion.persistedAt)) return null;
    const scope = `original77:${data.startDate}`;
    const ids = new Set(); const dates = new Set(); const ordinals = new Set();
    let event;
    for (const value of [...prior, data.event]) {
      const row = ownFields(value, ['source', 'sourceId', 'localDate', 'occurredAt', 'challengeDay', 'completed']);
      if (!row || row.source !== 'check_in' || !previewIdentity(row.sourceId)
        || instance(row) !== scope || !completionStamp(row.occurredAt)) return null;
      const count = Object.getOwnPropertyDescriptor(row.completed || {}, 'length')?.value;
      const actions = Number.isInteger(count) && count >= 1 && count <= 7 ? ownList(row.completed, count) : null;
      if (!actions || !validCompleted({ completed: actions }) || ids.has(row.sourceId)
        || dates.has(row.localDate) || ordinals.has(row.challengeDay)) return null;
      ids.add(row.sourceId); dates.add(row.localDate); ordinals.add(row.challengeDay);
      event = row;
    }
    if (completion.sourceId !== event.sourceId || completion.localDate !== event.localDate
      || completion.recordedAt !== event.occurredAt) return null;
    const facts = Object.freeze({ source: 'challenge_completion', sourceId: completion.id,
      occurredAt: event.occurredAt, localDate: event.localDate, instanceId: scope,
      completionKind: 'original_77_submissions', completionEventId: completion.id,
      sourceCheckInId: event.sourceId, submittedCount: 77, targetCount: 77, original_77_completion: 1 });
    liveCompletionFacts.add(facts);
    return facts;
  } catch { return null; }
}

// New UUID-run insertion adapter. The same 77-submission rule is preserved,
// but its award is scoped to this immutable run, not a reconstructed date.
export function instanceCompletionBadgeFacts(input) {
  try {
    const data = ownFields(input, ['userId', 'run', 'event', 'priorInstanceCheckIns', 'completionEvidence'], true);
    if (!data || !previewIdentity(data.userId)) return null;
    const run = normalizeChallengeInstance(data.run, { preview: true });
    if (!run || run.challengeKey !== 'original_77' || run.status !== 'completed' || run.reviewRequired
      || run.provenance === 'legacy_completed' || run.targetCount !== 77 || run.submittedCount !== 77) return null;
    const prior = ownList(data.priorInstanceCheckIns, 76);
    const proof = ownFields(data.completionEvidence, ['kind', 'userId', 'challengeKey', 'instanceId', 'eventId',
      'sourceCheckInId', 'submittedCount', 'targetCount', 'completedAt', 'persistedAt'], true);
    if (!prior || !proof || proof.kind !== 'canonical_instance_completion' || proof.userId !== data.userId
      || proof.instanceId !== run.id || proof.challengeKey !== run.challengeKey || proof.submittedCount !== 77 || proof.targetCount !== 77
      || proof.eventId !== run.completionEventId || !completionUuid(proof.eventId) || proof.eventId === proof.sourceCheckInId
      || proof.completedAt !== run.completedAt || !completionStamp(proof.persistedAt)) return null;
    const ids = new Set(); const dates = new Set(); const ordinals = new Set(); let current;
    for (const raw of [...prior, data.event]) {
      const row = ownFields(raw, ['source', 'sourceId', 'localDate', 'occurredAt', 'challengeDay', 'completed', 'instanceId', 'scopeKey']);
      if (!row || row.source !== 'check_in' || !completionUuid(row.sourceId) || row.instanceId !== run.id || instance(row) !== run.scopeKey
        || !completionStamp(row.occurredAt) || dayNumber(row.localDate) - row.challengeDay + 1 !== dayNumber(run.startDate)
        || ids.has(row.sourceId) || dates.has(row.localDate) || ordinals.has(row.challengeDay)) return null;
      const count = Object.getOwnPropertyDescriptor(row.completed || {}, 'length')?.value;
      const entries = Number.isInteger(count) && count >= 1 && count <= 7 ? ownList(row.completed, count) : null;
      if (!entries || !validCompleted({ completed: entries })) return null;
      ids.add(row.sourceId); dates.add(row.localDate); ordinals.add(row.challengeDay); current = row;
    }
    if (current.sourceId !== proof.sourceCheckInId || current.occurredAt !== proof.completedAt
      || current.challengeDay !== run.calendarDay) return null;
    const facts = Object.freeze({ source: 'challenge_completion', sourceId: proof.eventId,
      occurredAt: current.occurredAt, localDate: current.localDate, instanceId: run.scopeKey,
      completionKind: 'original_77_submissions', completionEventId: proof.eventId,
      sourceCheckInId: current.sourceId, submittedCount: 77, targetCount: 77, original_77_completion: 1 });
    liveCompletionFacts.add(facts); return facts;
  } catch { return null; }
}

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
  if (rule.metric === 'original_77_completion') return liveCompletionFacts.has(facts)
    && rule.threshold === 1 && facts.original_77_completion === 1;
  if (!['check_in_count', 'partial_count', 'perfect_count', 'instance_check_in_count', 'perfect_streak', 'app_streak', 'verified_share'].includes(rule.metric)) return false;
  return Number.isInteger(facts[rule.metric]) && facts[rule.metric] === rule.threshold;
}

export function badgeEarningEvidence(rule, facts) {
  if (rule.metric === 'original_77_completion') return { schemaVersion: 1, kind: 'challenge_completion',
    completionKind: facts.completionKind, completionEventId: facts.completionEventId,
    sourceCheckInId: facts.sourceCheckInId, submittedCount: facts.submittedCount, targetCount: facts.targetCount };
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
      challengeInstanceId: facts.instanceId || null, qualifyingValue: rule.metric === 'workout' ? 1 : facts[rule.metric],
      ...(rule.metric === 'original_77_completion' ? { sourceCheckInId: facts.sourceCheckInId } : {}) },
  }));
}

export { badgeCatalogOrder, badgeCelebrationReason } from './badge-data-contract.mjs';
