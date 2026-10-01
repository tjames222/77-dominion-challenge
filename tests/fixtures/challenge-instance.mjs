export const INSTANCE_ACTOR = '11111111-1111-4111-8111-111111111111';
export const INSTANCE_ID = '22222222-2222-4222-8222-222222222222';
export function instanceActivationFixture() {
  return {
    schemaVersion: 2, actorId: INSTANCE_ACTOR, revision: 3, serverDate: '2026-09-30',
    status: 'active', mode: 'solo', startDate: '2026-07-01', timeZone: 'UTC', crewId: null,
    groupMembershipActive: false, reviewRequired: false, canActivateSolo: false,
    canActivateGroup: false, canParticipate: true, canMutateDailyStandards: true, canEditStartDate: false,
    currentInstance: {
      id: INSTANCE_ID, challengeKey: 'original_77', title: '77-Day Dominion Challenge',
      scopeKey: `instance:${INSTANCE_ID}`, status: 'active', startDate: '2026-07-01', timeZone: 'UTC',
      mode: 'solo', crewId: null, targetCount: 77, submittedCount: 76, calendarDay: 92,
      completedAt: null, completionEventId: null, provenance: 'live', reviewRequired: false,
    },
    originalRepeat: { challengeKey: 'original_77', targetCount: 77, available: false, canStart: false, reason: 'challenge_active' },
  };
}
export function instanceBootstrapFixture() {
  const activation = instanceActivationFixture();
  return {
    schemaVersion: 2, actorId: INSTANCE_ACTOR, instanceId: INSTANCE_ID,
    appAccess: true, asOf: '2026-09-30T12:00:00Z', timeZone: 'UTC', entryDate: '2026-09-30', activation,
    draft: {
      schemaVersion: 2, actorId: INSTANCE_ACTOR, instanceId: INSTANCE_ID,
      entry_date: '2026-09-30', completed: ['bible'], workout_difficulty: {},
      version: 1, locked: false, submitted: false, activation_status: 'active',
      activation: structuredClone(activation),
    },
  };
}
