export const DAILY_ACTOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export function dailyBootstrapFixture({ actorId = DAILY_ACTOR, entryDate = '2026-09-12',
  timeZone = 'America/Los_Angeles', status = 'active', appAccess = true, completed = [],
  version = 2, submitted = false } = {}) {
  const active = status === 'active';
  const activation = {
    schemaVersion: 1, status, storedStatus: status, mode: status === 'not_started' ? null : 'solo',
    startDate: status === 'not_started' ? null : active ? entryDate : '2026-09-20',
    timeZone: status === 'not_started' ? null : timeZone, challengeDay: active ? 1 : null,
    crewId: null, groupMembershipActive: false, activatedAt: active ? '2026-09-12T07:00:00Z' : null,
    confirmedAt: status === 'not_started' ? null : '2026-09-12T07:00:00Z',
    activatedBy: active ? actorId : null, confirmedBy: status === 'not_started' ? null : actorId,
    revision: 1, reviewRequired: false, canActivateSolo: status === 'not_started',
    canActivateGroup: status === 'not_started', canParticipate: active,
    canMutateDailyStandards: active, canEditStartDate: status !== 'not_started',
  };
  return { schemaVersion: 1, actorId, asOf: '2026-09-13T00:30:00.123456+00:00', appAccess,
    activation: appAccess ? activation : null, timeZone: appAccess ? timeZone : null,
    entryDate: appAccess ? entryDate : null, draft: appAccess ? {
      entry_date: entryDate, completed, workout_difficulty: { one: 'hard', two: 'easy' },
      version, updated_at: null, submitted, locked: submitted || !active,
      lock_reason: submitted ? 'submitted' : active ? null : 'challenge_not_active',
      activation_status: status, stale_write_reconciled: false,
    } : null };
}
