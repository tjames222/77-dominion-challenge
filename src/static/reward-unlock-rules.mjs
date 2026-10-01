// Pure FOU-1498 catalog/evidence validation. No Auth, storage, clocks,
// grants, reconciliation, actions, or runtime imports belong in this module.
// Structurally valid evidence is NOT authenticated server evidence.
const CATALOG_KEYS = ['schemaVersion', 'manifestVersion', 'lifecycle', 'effectiveAt', 'source', 'rewards'];
const DEFINITION_KEYS = ['key', 'title', 'rewardType', 'stateModel', 'fulfillmentKey', 'challengeKey', 'targetSubmittedCheckIns', 'phase', 'sortOrder', 'active', 'released', 'unlockRule'];
const IDENTITY_KEYS = ['key', 'rewardType', 'stateModel', 'fulfillmentKey', 'challengeKey'];
const STATE_KEYS = ['userId', 'key', 'status', 'unlockedAt', 'startedAt', 'completedAt', 'ownedAt', 'celebrationSeenAt', 'grantCatalogVersion', 'grantReason'];
const CANONICAL_KEYS = ['kind', 'userId', 'challengeKey', 'instanceId', 'eventId', 'sourceCheckInId', 'submittedCount', 'targetCount', 'completedAt', 'persistedAt'];
const LEGACY_KEYS = ['kind', 'userId', 'challengeKey', 'legacyStateKey', 'completedAt', 'approvalId', 'approvedAt'];
const MAX_ITEMS = 256;
const MAX_EVIDENCE = 512;
const MAX_TARGET = 3_652_059;
const DAY_US = 86_400_000_000n;
const safeInteger = (value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && !Object.is(value, -0) && value >= minimum && value <= maximum;
const exactText = (value, pattern, maximum) => typeof value === 'string' && value.length > 0 && value.length <= maximum && pattern.exec(value)?.[0] === value;
const key = (value) => exactText(value, /^[a-z0-9][a-z0-9_.:-]*$/, 100);
const actor = (value) => exactText(value, /^[A-Za-z0-9:_-]+$/, 160);
const uuid = (value) => typeof value === 'string' && value.length === 36 && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const text = (value, maximum) => typeof value === 'string' && value.length > 0 && value.length <= maximum && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);

function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(descriptors);
  if (names.length !== keys.length || names.some((name) => typeof name !== 'string' || !keys.includes(name))) return null;
  const snapshot = {};
  for (const name of keys) {
    const descriptor = descriptors[name];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return null;
    Object.defineProperty(snapshot, name, { value: descriptor.value, enumerable: true, writable: true, configurable: true });
  }
  return snapshot;
}

function list(value, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!safeInteger(length, 0, maximum) || Reflect.ownKeys(descriptors).length !== length + 1) return null;
  const snapshot = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return null;
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

function dayNumber(value) {
  if (typeof value !== 'string' || value.length !== 10 || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const milliseconds = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().slice(0, 10) === value ? milliseconds / 86_400_000 : null;
}

function timestamp(value) {
  if (typeof value !== 'string' || value.length > 32) return false;
  const match = /^((?!0000)\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || match[0] !== value) return false;
  const day = dayNumber(match[1]);
  const hour = Number(match[2]); const minute = Number(match[3]); const second = Number(match[4]);
  if (day === null || hour > 23 || minute > 59 || second > 59) return false;
  let offset = 0;
  if (match[6] !== 'Z') {
    const hours = Number(match[6].slice(1, 3)); const minutes = Number(match[6].slice(4, 6));
    if (hours > 15 || minutes > 59 || match[6] === '-00:00') return false;
    offset = (hours * 3600 + minutes * 60) * (match[6][0] === '-' ? -1 : 1);
  }
  const micros = BigInt(day) * DAY_US + BigInt(hour * 3600 + minute * 60 + second - offset) * 1_000_000n + BigInt((match[5] || '').padEnd(6, '0'));
  return micros >= BigInt(dayNumber('0001-01-01')) * DAY_US && micros < (BigInt(dayNumber('9999-12-31')) + 1n) * DAY_US;
}

function frozen(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}
const failure = (reason) => frozen({ valid: false, reason, catalog: null });

function parseCatalog(input) {
  const catalog = record(input, CATALOG_KEYS);
  if (!catalog || catalog.schemaVersion !== 1 || !safeInteger(catalog.manifestVersion, 1)
    || !['draft', 'released', 'historical_reference'].includes(catalog.lifecycle)
    || (catalog.lifecycle === 'released' ? !timestamp(catalog.effectiveAt) : catalog.effectiveAt !== null)
    || !text(catalog.source, 240)) return failure('invalid_catalog');
  const rows = list(catalog.rewards, MAX_ITEMS);
  if (!rows?.length) return failure('invalid_definitions');
  const rewards = []; const keys = new Set(); const challenges = new Map();
  let previousOrder = 0; let previousThreshold = 0;
  for (const row of rows) {
    const definition = record(row, DEFINITION_KEYS);
    if (!definition || !key(definition.key) || !text(definition.title, 180) || !exactText(definition.rewardType, /^[a-z][a-z0-9_]*$/, 100)
      || !key(definition.fulfillmentKey) || typeof definition.active !== 'boolean' || typeof definition.released !== 'boolean'
      || !safeInteger(definition.sortOrder, 1) || definition.sortOrder <= previousOrder || keys.has(definition.key)
      || !['core', 'post_core'].includes(definition.phase)) return failure('invalid_definition');
    if (definition.stateModel === 'challenge_lifecycle') {
      if (definition.rewardType !== 'challenge' || !key(definition.challengeKey) || definition.fulfillmentKey !== definition.challengeKey
        || !safeInteger(definition.targetSubmittedCheckIns, 1, MAX_TARGET) || challenges.has(definition.challengeKey)) return failure('invalid_challenge_identity');
      challenges.set(definition.challengeKey, definition);
    } else if (definition.stateModel !== 'ownership' || definition.rewardType === 'challenge' || definition.challengeKey !== null
      || definition.targetSubmittedCheckIns !== null) return failure('invalid_ownership_identity');
    // Read only data descriptors before deciding the rule's discriminant.
    const ruleType = definition.unlockRule && Object.getOwnPropertyDescriptor(definition.unlockRule, 'type');
    if (!ruleType || !Object.hasOwn(ruleType, 'value')) return failure('invalid_rule');
    if (ruleType.value === 'trusted_points' || ruleType.value === 'lifetime_points') {
      const rule = record(definition.unlockRule, ['type', 'pointsRequired']);
      if (!rule || !safeInteger(rule.pointsRequired, 1) || definition.phase !== 'core'
        || (definition.active && rule.pointsRequired <= previousThreshold)) return failure('invalid_point_rule');
      if (definition.active) previousThreshold = rule.pointsRequired;
      definition.unlockRule = rule;
    } else if (ruleType.value === 'challenge_completion') {
      const rule = record(definition.unlockRule, ['type', 'prerequisiteChallengeKey', 'requiredState']);
      if (!rule || !key(rule.prerequisiteChallengeKey) || rule.requiredState !== 'completed' || definition.phase !== 'post_core'
        || definition.stateModel !== 'challenge_lifecycle') return failure('invalid_completion_rule');
      definition.unlockRule = rule;
    } else return failure('unknown_rule');
    keys.add(definition.key); previousOrder = definition.sortOrder; rewards.push(definition);
  }
  const visiting = new Set(); const visited = new Set();
  const visit = (definition) => {
    if (visiting.has(definition.key)) return false;
    if (visited.has(definition.key)) return true;
    visiting.add(definition.key);
    if (definition.unlockRule.type === 'challenge_completion') {
      const predecessor = challenges.get(definition.unlockRule.prerequisiteChallengeKey);
      if (!predecessor || (definition.active && !predecessor.active) || !visit(predecessor)
        || predecessor.sortOrder >= definition.sortOrder) return false;
    }
    visiting.delete(definition.key); visited.add(definition.key); return true;
  };
  if (!rewards.every(visit)) return failure('invalid_prerequisite_graph');
  return frozen({ valid: true, reason: null, catalog: { ...catalog, rewards } });
}

export function validateRewardProgressionCatalog(input, { previousCatalog = null } = {}) {
  try {
    const current = parseCatalog(input);
    if (!current.valid || previousCatalog === null) return current;
    const previous = parseCatalog(previousCatalog);
    if (!previous.valid) return failure('invalid_previous_catalog');
    if (current.catalog.manifestVersion <= previous.catalog.manifestVersion) return failure('nonadvancing_manifest_version');
    const currentByKey = new Map(current.catalog.rewards.map((definition) => [definition.key, definition]));
    for (const before of previous.catalog.rewards) {
      const after = currentByKey.get(before.key);
      if (!after || IDENTITY_KEYS.some((name) => before[name] !== after[name])) return failure('immutable_identity_changed');
    }
    return current;
  } catch { return failure('invalid_catalog'); }
}

const assessment = (fields) => frozen({
  valid: false, reason: 'invalid_evidence', items: [],
  evidenceAuthorityVerified: false, grantAuthorized: false, ownershipAuthorized: false,
  transitionAuthorized: false, replayAuthorized: false, ...fields,
});

// This answers only "would these supplied facts satisfy the configured rule?"
// Existing states are copied, never promoted/demoted. Neither a matching proof
// nor a preserved state is authenticated by this preview/evidence assessment.
export function assessRewardUnlockEvidence(input) {
  try {
    const args = record(input, ['catalog', 'userId', 'lifetimePoints', 'trustedDailyStandardPoints', 'completionEvidence', 'existingStates']);
    if (!args || !actor(args.userId) || !safeInteger(args.lifetimePoints)
      || (args.trustedDailyStandardPoints !== null && !safeInteger(args.trustedDailyStandardPoints))) return assessment({});
    const checked = validateRewardProgressionCatalog(args.catalog);
    if (!checked.valid) return assessment({ reason: checked.reason });
    const definitions = checked.catalog.rewards;
    const byKey = new Map(definitions.map((definition) => [definition.key, definition]));
    const byChallenge = new Map(definitions.filter((definition) => definition.challengeKey).map((definition) => [definition.challengeKey, definition]));
    const states = list(args.existingStates, MAX_ITEMS); const proofs = list(args.completionEvidence, MAX_EVIDENCE);
    if (!states || !proofs) return assessment({});
    const retained = new Map();
    for (const raw of states) {
      const state = record(raw, STATE_KEYS); const definition = state && byKey.get(state.key);
      if (!state || !definition || state.userId !== args.userId || retained.has(state.key)
        || !safeInteger(state.grantCatalogVersion, 1) || !text(state.grantReason, 120)
        || ['unlockedAt', 'startedAt', 'completedAt', 'ownedAt', 'celebrationSeenAt'].some((name) => state[name] !== null && !timestamp(state[name]))) return assessment({});
      if (definition.stateModel === 'ownership') {
        if (state.status !== 'owned' || state.ownedAt === null || state.unlockedAt !== null || state.startedAt !== null || state.completedAt !== null) return assessment({});
      } else if (!['available', 'active', 'completed'].includes(state.status) || state.unlockedAt === null || state.ownedAt !== null
        || (state.status === 'available' && (state.startedAt !== null || state.completedAt !== null))
        || (state.status === 'active' && (state.startedAt === null || state.completedAt !== null))
        || (state.status === 'completed' && (state.startedAt === null || state.completedAt === null))) return assessment({});
      retained.set(state.key, state);
    }
    const completed = new Map(); const proofIds = new Set(); const instances = new Set(); const sourceCheckIns = new Set(); const legacyStates = new Set();
    for (const raw of proofs) {
      const descriptor = raw && Object.getOwnPropertyDescriptor(raw, 'kind');
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return assessment({});
      const canonical = descriptor.value === 'canonical_instance_completion';
      const proof = canonical ? record(raw, CANONICAL_KEYS) : descriptor.value === 'approved_legacy_completed' ? record(raw, LEGACY_KEYS) : null;
      const definition = proof && byChallenge.get(proof.challengeKey);
      if (!proof || !definition || proof.userId !== args.userId || !timestamp(proof.completedAt)) return assessment({});
      const identity = canonical ? proof.eventId : proof.approvalId;
      if (!uuid(identity) || proofIds.has(identity)) return assessment({});
      proofIds.add(identity);
      if (canonical) {
        if (!uuid(proof.instanceId) || instances.has(proof.instanceId) || !uuid(proof.sourceCheckInId)
          || sourceCheckIns.has(proof.sourceCheckInId) || proof.eventId === proof.sourceCheckInId
          || proof.targetCount !== definition.targetSubmittedCheckIns || proof.submittedCount !== proof.targetCount
          || !timestamp(proof.persistedAt)) return assessment({});
        instances.add(proof.instanceId); sourceCheckIns.add(proof.sourceCheckInId);
      } else {
        const state = retained.get(definition.key);
        if (proof.legacyStateKey !== `${args.userId}:${definition.challengeKey}` || legacyStates.has(proof.legacyStateKey)
          || !timestamp(proof.approvedAt) || state?.status !== 'completed' || state.completedAt !== proof.completedAt) return assessment({});
        legacyStates.add(proof.legacyStateKey);
      }
      const matches = completed.get(proof.challengeKey) || [];
      matches.push(proof); completed.set(proof.challengeKey, matches);
    }
    const items = definitions.map((definition) => {
      const rule = definition.unlockRule;
      const preservedState = retained.get(definition.key) || null;
      if (rule.type === 'challenge_completion') {
        const matchedEvidence = completed.get(rule.prerequisiteChallengeKey) || [];
        return { key: definition.key, ruleType: rule.type, requirementSatisfied: matchedEvidence.length > 0,
          reason: matchedEvidence.length ? 'completion_evidence_matches' : 'completion_evidence_missing',
          currentPoints: null, pointsRequired: null, pointsRemaining: null, matchedEvidence, preservedState };
      }
      const points = rule.type === 'trusted_points' ? args.trustedDailyStandardPoints : args.lifetimePoints;
      return { key: definition.key, ruleType: rule.type, requirementSatisfied: points === null ? null : points >= rule.pointsRequired,
        reason: points === null ? 'trusted_points_missing' : points >= rule.pointsRequired ? 'point_requirement_matches' : 'points_remaining',
        currentPoints: points, pointsRequired: rule.pointsRequired, pointsRemaining: points === null ? null : Math.max(rule.pointsRequired - points, 0),
        matchedEvidence: [], preservedState };
    });
    return assessment({ valid: true, reason: null, items });
  } catch { return assessment({}); }
}
