import progressionCatalog from './reward-progression-catalog.v2.json' with { type: 'json' };
import { validateRewardProgressionCatalog } from './reward-unlock-rules.mjs';
import { DEFAULT_OWNERSHIP_REWARD_DEFINITIONS, normalizeReward, normalizeRewardCatalog,
  ownDataRecord, validTimestamp, resolveTimestamp, safeKey } from './reward-catalog.mjs';

// Static configuration is shared with preview. Runtime grants/actions always
// come from the actor-bound server/preview transaction, not this manifest.
const validatedCatalog = validateRewardProgressionCatalog(progressionCatalog);
if (!validatedCatalog.valid || validatedCatalog.catalog.lifecycle !== 'released') throw new Error('Reward catalog configuration is invalid.');
export const REWARD_CATALOG_EFFECTIVE_AT = validatedCatalog.catalog.effectiveAt;
export const DEFAULT_REWARD_PROGRESSION_DEFINITIONS = Object.freeze(validatedCatalog.catalog.rewards.map(definition => {
  const display = DEFAULT_OWNERSHIP_REWARD_DEFINITIONS.find(reward => reward.key === definition.key);
  return Object.freeze({ ...display, ...definition,
    pointsRequired: definition.unlockRule.pointsRequired ?? null,
    // Match the released SQL catalog: permanent ownership rewards have no
    // membership requirement; starting a challenge still requires membership.
    requiredEntitlementKey: definition.stateModel === 'challenge_lifecycle' ? 'membership_active' : null,
    unlockRule: Object.freeze({ ...definition.unlockRule }),
    metadata: Object.freeze({ ...(display?.metadata || {}), ...(definition.challengeKey ? {
      durationDays: definition.targetSubmittedCheckIns, challengeType: definition.challengeKey,
    } : {}) }),
  });
}));

// These records have already been captured under an actor-bound preview
// migration. Preserve their typed grant facts; never manufacture a canonical
// instance completion/event from a legacy completed flag.
export function preserveLegacyRewardGrants(records, { actorId } = {}) {
  const fields = ['userId', 'key', 'status', 'unlockedAt', 'startedAt', 'completedAt', 'ownedAt', 'celebrationSeenAt', 'grantCatalogVersion', 'grantReason'];
  if (!Array.isArray(records) || records.length > 256) throw new Error('Preserved reward grants are invalid.');
  const ownershipRecords = []; const challengeRecords = []; const completedChallengeKeys = []; const keys = new Set();
  for (const record of records) {
    if (!ownDataRecord(record) || Object.keys(record).length !== fields.length || fields.some(field => !Object.hasOwn(record, field))
      || record.userId !== actorId || typeof record.key !== 'string' || !/^[a-z0-9][a-z0-9_.:-]{0,99}$/.test(record.key)
      || keys.has(record.key) || !['owned', 'available', 'active', 'completed'].includes(record.status)
      || !Number.isSafeInteger(record.grantCatalogVersion) || record.grantCatalogVersion < 1
      || typeof record.grantReason !== 'string' || !record.grantReason || record.grantReason.length > 120
      || ['unlockedAt', 'startedAt', 'completedAt', 'ownedAt', 'celebrationSeenAt'].some(field => record[field] !== null && !validTimestamp(record[field]))) throw new Error('Preserved reward grants are invalid.');
    if (record.status === 'owned' ? (record.ownedAt === null || record.unlockedAt !== null || record.startedAt !== null || record.completedAt !== null)
      : (record.ownedAt !== null || record.unlockedAt === null
        || (record.status === 'available' && (record.startedAt !== null || record.completedAt !== null))
        || (record.status === 'active' && (record.startedAt === null || record.completedAt !== null))
        || (record.status === 'completed' && (record.startedAt === null || record.completedAt === null)))) throw new Error('Preserved reward lifecycle is invalid.');
    keys.add(record.key);
    const retained = { ...record, grantProvenance: { type: 'legacy_preserved', catalogVersion: record.grantCatalogVersion } };
    (record.status === 'owned' ? ownershipRecords : challengeRecords).push(retained);
    if (record.status === 'completed') completedChallengeKeys.push(record.key);
  }
  return { ownershipRecords, challengeRecords, completedChallengeKeys };
}

// Preview-only transaction projection. It consumes persisted evidence and
// returns replacement grant arrays for the caller's atomic owner-bound write.
// Pages must not call this to infer production ownership from points.
export function buildMockRewardCatalogV2({ actorId, catalogVersion = 2, effectiveAt = REWARD_CATALOG_EFFECTIVE_AT, revision, snapshotVersion,
  currentInstance = null, originalRepeat, definitions = DEFAULT_REWARD_PROGRESSION_DEFINITIONS,
  totalPoints = 0, trustedDailyStandardPoints = 0, ownershipRecords = [], challengeRecords = [],
  completionEvidence = [], preservedLegacyRecords = [], now, membershipActive = true } = {}) {
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  const timestamp = validTimestamp;
  if (typeof actorId !== 'string' || !actorId || !integer(totalPoints) || !integer(trustedDailyStandardPoints)
    || !Array.isArray(definitions) || !Array.isArray(ownershipRecords) || !Array.isArray(challengeRecords)
    || !Array.isArray(completionEvidence) || definitions.length > 256 || completionEvidence.length > 10000
    || ownershipRecords.length > 256 || challengeRecords.length > 256 || typeof membershipActive !== 'boolean') throw new Error('Preview reward evidence is invalid.');
  const at = resolveTimestamp(now);
  if (!timestamp(at)) throw new Error('Preview reward time is invalid.');
  if (definitions.some(definition => !ownDataRecord(definition) || !ownDataRecord(definition.unlockRule))) throw new Error('Preview reward catalog is invalid.');
  const rows = definitions.map(definition => ({ ...definition, unlockRule: { ...definition.unlockRule } }))
    .sort((left, right) => left.sortOrder - right.sortOrder || left.key.localeCompare(right.key));
  const canAccessReward = definition => definition.requiredEntitlementKey == null
    || (definition.requiredEntitlementKey === 'membership_active' && membershipActive);
  const byKey = new Map(); const byChallenge = new Map();
  for (const definition of rows) {
    if (!safeKey(definition.key) || byKey.has(definition.key) || !Number.isFinite(definition.sortOrder)
      || !['ownership', 'challenge_lifecycle'].includes(definition.stateModel)
      || !['trusted_points', 'lifetime_points', 'challenge_completion'].includes(definition.unlockRule.type)) throw new Error('Preview reward catalog is invalid.');
    if (definition.unlockRule.type !== 'challenge_completion' && (!integer(definition.unlockRule.pointsRequired) || definition.unlockRule.pointsRequired < 1)) throw new Error('Preview reward threshold is invalid.');
    byKey.set(definition.key, definition);
    if (definition.stateModel === 'challenge_lifecycle') {
      const challengeKey = definition.challengeKey || definition.key;
      if (byChallenge.has(challengeKey) || !integer(definition.targetSubmittedCheckIns) || !definition.targetSubmittedCheckIns) throw new Error('Preview challenge identity is invalid.');
      byChallenge.set(challengeKey, definition);
    }
  }
  for (const definition of rows) if (definition.unlockRule.type === 'challenge_completion') {
    const predecessor = byChallenge.get(definition.unlockRule.prerequisiteChallengeKey);
    if (!predecessor || predecessor.sortOrder >= definition.sortOrder || definition.unlockRule.requiredState !== 'completed') throw new Error('Preview reward prerequisite is invalid.');
  }
  const owners = new Map(); const challenges = new Map();
  const preserve = (records, map, stateModel) => {
    for (const row of records) {
      if (!ownDataRecord(row)) throw new Error('Preview grant ownership is invalid.');
      const key = safeKey(row.key || row.rewardKey || row.challengeKey || row.reward_key || row.challenge_key);
      const definition = byKey.get(key);
      if (!key || map.has(key) || (row.userId && row.userId !== actorId) || (row.actorId && row.actorId !== actorId)) throw new Error('Preview grant ownership is invalid.');
      // Removed/inactive definitions must not erase durable ownership history.
      if (definition && definition.stateModel !== stateModel) throw new Error('Preview grant identity changed.');
      if (stateModel === 'challenge_lifecycle' && !['available', 'active', 'completed'].includes(row.status)) throw new Error('Preview challenge grant is invalid.');
      if (stateModel === 'ownership' && !timestamp(row.ownedAt || row.owned_at)) throw new Error('Preview ownership time is invalid.');
      if (row.celebrationSeenAt != null && !timestamp(row.celebrationSeenAt)) throw new Error('Preview acknowledgement is invalid.');
      map.set(key, { ...structuredClone(row), key });
    }
  };
  preserve(ownershipRecords, owners, 'ownership'); preserve(challengeRecords, challenges, 'challenge_lifecycle');
  const legacy = preserveLegacyRewardGrants(preservedLegacyRecords, { actorId });
  const preservedProvenance = new Map([...legacy.ownershipRecords, ...legacy.challengeRecords]
    .map(record => [record.key, record.grantProvenance]));
  for (const [records, map] of [[legacy.ownershipRecords, owners], [legacy.challengeRecords, challenges]]) {
    for (const record of records) if (!map.has(record.key)) map.set(record.key, record);
  }
  const completed = new Set(legacy.completedChallengeKeys); const events = new Set(); const instances = new Set(); const sources = new Set();
  for (const proof of completionEvidence) {
    if (!ownDataRecord(proof)) throw new Error('Preview completion evidence is invalid.');
    const definition = byChallenge.get(proof?.challengeKey);
    const target = definition?.targetSubmittedCheckIns ?? (proof?.challengeKey === 'original_77' ? 77 : null);
    if (!ownDataRecord(proof) || proof.kind !== 'canonical_instance_completion' || proof.userId !== actorId
      || !uuid(proof.instanceId) || !uuid(proof.eventId) || !uuid(proof.sourceCheckInId)
      || proof.eventId === proof.sourceCheckInId || events.has(proof.eventId) || instances.has(proof.instanceId) || sources.has(proof.sourceCheckInId)
      || target === null || proof.targetCount !== target || proof.submittedCount !== target
      || !timestamp(proof.completedAt) || !timestamp(proof.persistedAt)) throw new Error('Preview completion evidence is invalid.');
    events.add(proof.eventId); instances.add(proof.instanceId); sources.add(proof.sourceCheckInId); completed.add(proof.challengeKey);
  }
  for (const definition of rows) {
    if (definition.active === false || definition.released === false || !canAccessReward(definition)) continue;
    const rule = definition.unlockRule;
    const satisfied = rule.type === 'challenge_completion' ? completed.has(rule.prerequisiteChallengeKey)
      : (rule.type === 'trusted_points' ? trustedDailyStandardPoints : totalPoints) >= rule.pointsRequired;
    const map = definition.stateModel === 'ownership' ? owners : challenges;
    if (!satisfied || map.has(definition.key)) continue;
    map.set(definition.key, { key: definition.key, userId: actorId,
      ...(definition.stateModel === 'ownership' ? { ownedAt: at } : { status: 'available', unlockedAt: at, startedAt: null, completedAt: null }),
      celebrationSeenAt: null, grantCatalogVersion: catalogVersion,
      grantReason: rule.type, grantProvenance: { type: 'rule_earned', catalogVersion },
      celebrationSourceType: rule.type === 'challenge_completion' ? 'challenge_completion' : 'points',
      celebrationMilestonePoints: rule.pointsRequired ?? null });
  }
  const blocked = currentInstance?.reviewRequired ? 'review_required'
    : !currentInstance ? 'original_completion_required' : currentInstance.status !== 'completed' ? 'active_instance_exists' : null;
  const items = rows.map(definition => {
    const canAccess = canAccessReward(definition);
    const rule = definition.unlockRule;
    const record = (definition.stateModel === 'ownership' ? owners : challenges).get(definition.key);
    const runMatches = currentInstance && definition.stateModel === 'challenge_lifecycle'
      && (definition.challengeKey || definition.key) === currentInstance.challengeKey;
    const status = record ? definition.stateModel === 'ownership' ? 'owned'
      : runMatches ? currentInstance.status === 'completed' ? 'completed' : 'active' : record.status : 'locked';
    const points = rule.type === 'trusted_points' ? trustedDailyStandardPoints : totalPoints;
    const requirement = rule.type === 'challenge_completion'
      ? { ...rule, prerequisiteTitle: byChallenge.get(rule.prerequisiteChallengeKey)?.title || '', satisfied: completed.has(rule.prerequisiteChallengeKey) }
      : { ...rule, currentPoints: points, pointsRemaining: Math.max(rule.pointsRequired - points, 0), progressPercent: Math.min(100, points / rule.pointsRequired * 100) };
    return normalizeReward({ ...definition, ...record, requirement,
      // Derive wire provenance from validated import evidence without replacing
      // or decorating the original durable grant/celebration metadata records.
      grantProvenance: preservedProvenance.get(definition.key) ?? record?.grantProvenance ?? null,
      pointsRequired: rule.pointsRequired ?? null, currentPoints: rule.type === 'challenge_completion' ? null : points,
      pointsRemaining: requirement.pointsRemaining ?? null, progressPercent: requirement.progressPercent ?? null,
      status, canAccess, requiredEntitlementKey: definition.requiredEntitlementKey ?? null,
      accessReason: canAccess ? null : 'entitlement_required',
      blockedReason: definition.stateModel === 'challenge_lifecycle' && record ? blocked : null,
      allowedActions: definition.active !== false && definition.released !== false && canAccess && record
        && definition.stateModel === 'challenge_lifecycle' && ['available', 'completed'].includes(status) && !blocked ? ['start'] : [] });
  });
  const visible = items.filter(item => item.active && item.released && item.canAccess);
  const available = currentInstance?.status === 'completed'
    ? visible.filter(item => item.allowedActions.includes('start') && item.status === 'available') : [];
  // Match the server projection: the just-completed run's immediate successor
  // takes precedence over older available grants. Locked completion-only tracks
  // are never presented as the next point-unlock target.
  const nextUnlock = available.find(item => item.requirement.type === 'challenge_completion'
    && item.requirement.prerequisiteChallengeKey === currentInstance.challengeKey)
    || available[0] || visible.find(item => item.phase === 'core' && item.status === 'locked') || null;
  return { catalog: normalizeRewardCatalog({ schemaVersion: 2, actorId, catalogVersion, effectiveAt, revision, snapshotVersion,
    totalPoints, currentInstance, originalRepeat, items, nextUnlock,
    page: { limit: items.length, totalItems: items.length, hasMore: false, nextCursor: null } }, { preview: true }),
  ownershipRecords: [...owners.values()], challengeRecords: [...challenges.values()], challengeUnlockedKeys: [...challenges.keys()] };
}
