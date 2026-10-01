import { DAILY_ACTOR } from './daily-action-bootstrap.mjs';
import { buildMockRewardCatalogV2 } from '../../src/static/preview-reward-catalog.mjs';

export const DAILY_INSTANCE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export function dailyBootstrapV2Fixture({ actorId = DAILY_ACTOR, instanceId = DAILY_INSTANCE_ID,
  entryDate = '2026-09-12', timeZone = 'America/Los_Angeles', status = 'active', appAccess = true,
  completed = [], version = 2, submitted = false } = {}) {
  const active = status === 'active'; const started = status !== 'not_started';
  const startDate = !started ? null : active ? entryDate
    : new Date(Date.parse(`${entryDate}T00:00:00Z`) + 8 * 86400000).toISOString().slice(0, 10);
  const currentInstance = started ? { id: instanceId, challengeKey: 'original_77', title: '77-Day Dominion Challenge',
    scopeKey: `instance:${instanceId}`, status, startDate, timeZone, mode: 'solo', crewId: null,
    targetCount: 77, submittedCount: 0, calendarDay: active ? 1 : null,
    completedAt: null, completionEventId: null, provenance: 'live', reviewRequired: false } : null;
  const activation = { schemaVersion: 2, actorId, revision: 1, serverDate: entryDate,
    status, mode: started ? 'solo' : null, startDate, timeZone: started ? timeZone : null, crewId: null,
    groupMembershipActive: false, reviewRequired: false, canActivateSolo: !started, canActivateGroup: !started,
    canParticipate: active, canMutateDailyStandards: active, canEditStartDate: false, currentInstance,
    originalRepeat: { challengeKey: 'original_77', targetCount: 77, available: false, canStart: false,
      reason: started ? 'active_instance_exists' : 'original_completion_required' } };
  const draft = started ? { schemaVersion: 2, actorId, instanceId,
    entry_date: entryDate, completed: [...completed], workout_difficulty: { one: 'hard', two: 'easy' },
    version, updated_at: null, submitted, locked: submitted || !active,
    lock_reason: submitted ? 'submitted' : active ? null : 'challenge_not_active',
    activation_status: status, activation: structuredClone(activation), stale_write_reconciled: false } : null;
  return { schemaVersion: 2, actorId, instanceId: appAccess && started ? instanceId : null,
    asOf: `${entryDate}T12:00:00Z`, appAccess, activation: appAccess ? activation : null,
    timeZone: appAccess ? timeZone : null, entryDate: appAccess ? entryDate : null, draft: appAccess ? draft : null };
}

export function rewardCatalogV2Fixture(activation, { ownedThemes = false } = {}) {
  const now = `${activation.serverDate}T12:00:00Z`;
  return buildMockRewardCatalogV2({ actorId: activation.actorId, revision: activation.revision,
    snapshotVersion: 'a'.repeat(64), currentInstance: activation.currentInstance, originalRepeat: activation.originalRepeat,
    totalPoints: 0, trustedDailyStandardPoints: 0, now,
    ownershipRecords: ownedThemes ? ['dominion_night_theme', 'dominion_platinum'].map(key => ({ key, ownedAt: now, celebrationSeenAt: now })) : [],
  }).catalog;
}
