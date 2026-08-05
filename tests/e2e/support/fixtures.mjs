export const FIXED_NOW = '2026-02-14T17:30:00.000Z';
export const FIXED_TODAY = '2026-02-14';
export const FIXED_CHALLENGE_START = '2026-02-01';
export const FIXED_CHALLENGE_DAY = 14;
export const FIXED_USER_ID = 'mock_user_e2e_77';

export const FIXED_USER = Object.freeze({
  name: 'Jordan Test',
  email: 'qa.member@example.test',
  avatarUrl: '',
  authenticated: true,
});

const ACTIVE_SUBSCRIPTION = Object.freeze({
  id: 'preview_subscription_e2e',
  productKey: 'dominion_membership',
  status: 'active',
  subscriptionActive: true,
  cancelAtPeriodEnd: false,
  currentPeriodStart: '2026-02-01T00:00:00.000Z',
  currentPeriodEnd: '2026-03-01T00:00:00.000Z',
  canceledAt: null,
  createdAt: '2026-02-01T00:00:00.000Z',
  preview: true,
});

const BASE_GAME_STATS = Object.freeze({
  totalPoints: 750,
  challengePoints: 750,
  currentAppStreak: 6,
  bestAppStreak: 12,
  currentFullDayStreak: 4,
  bestFullDayStreak: 9,
  lastSeenDate: FIXED_TODAY,
  lastFullDayDate: '2026-02-13',
});

export const BASE_BADGES = Object.freeze([
  {
    key: 'faithful_start',
    name: 'Faithful Start',
    description: 'Posted the first honest check-in.',
    tier: 'bronze',
    icon: 'shield',
    earnedAt: '2026-02-01T20:00:00.000Z',
    entryDate: '2026-02-01',
  },
  {
    key: 'first_sweat',
    name: 'First Sweat',
    description: 'Completed the first training action.',
    tier: 'bronze',
    icon: 'spark',
    earnedAt: '2026-02-02T20:00:00.000Z',
    entryDate: '2026-02-02',
  },
]);

const BASE_REWARD_ENTITLEMENTS = Object.freeze([
  {
    key: 'dominion_night_theme',
    ownedAt: '2026-02-10T18:00:00.000Z',
    celebrationSeenAt: '2026-02-10T18:05:00.000Z',
  },
]);

const BASE_CREWS = Object.freeze([
  {
    id: 'crew_e2e_alpha',
    name: 'Steady Hands',
    description: 'A deterministic private group for browser coverage.',
    challengeStartDate: FIXED_CHALLENGE_START,
    createdBy: FIXED_USER_ID,
    createdAt: '2026-02-01T12:00:00.000Z',
    role: 'owner',
    joinedAt: '2026-02-01T12:00:00.000Z',
  },
]);

const BASE_CREW_MEMBERS = Object.freeze({
  crew_e2e_alpha: [
    {
      crewId: 'crew_e2e_alpha',
      userId: FIXED_USER_ID,
      name: FIXED_USER.name,
      avatarUrl: '',
      role: 'owner',
      joinedAt: '2026-02-01T12:00:00.000Z',
    },
    {
      crewId: 'crew_e2e_alpha',
      userId: 'member_e2e_micah',
      name: 'Micah Reed',
      avatarUrl: '',
      role: 'member',
      joinedAt: '2026-02-02T12:00:00.000Z',
    },
  ],
});

const BASE_FEED = Object.freeze([
  {
    id: 'feed_e2e_1',
    name: 'Micah Reed',
    day: FIXED_CHALLENGE_DAY,
    status: 'complete',
    completedCount: 7,
    pointsAwarded: 7,
    timestamp: 'Today',
    createdAt: '2026-02-14T16:00:00.000Z',
  },
]);

const BASE_CHALLENGE_ACTIVATION = Object.freeze({
  schemaVersion: 1,
  revision: 1,
  status: 'active',
  storedStatus: 'active',
  mode: 'group',
  startDate: FIXED_CHALLENGE_START,
  timeZone: 'UTC',
  challengeDay: FIXED_CHALLENGE_DAY,
  crewId: 'crew_e2e_alpha',
  groupMembershipActive: true,
  activatedAt: '2026-02-01T12:00:00.000Z',
  confirmedAt: '2026-02-01T12:00:00.000Z',
  activatedBy: FIXED_USER_ID,
  confirmedBy: FIXED_USER_ID,
  reviewRequired: false,
  canActivateSolo: false,
  canActivateGroup: false,
  canParticipate: true,
  canMutateDailyStandards: true,
  canEditStartDate: false,
});

const NOT_STARTED_CHALLENGE_ACTIVATION = Object.freeze({
  schemaVersion: 1,
  revision: 0,
  status: 'not_started',
  storedStatus: 'not_started',
  mode: null,
  startDate: null,
  timeZone: null,
  challengeDay: null,
  crewId: null,
  groupMembershipActive: false,
  activatedAt: null,
  confirmedAt: null,
  activatedBy: null,
  confirmedBy: null,
  reviewRequired: false,
  canActivateSolo: true,
  canActivateGroup: true,
  canParticipate: false,
  canMutateDailyStandards: false,
  canEditStartDate: false,
});

const SCHEDULED_SOLO_CHALLENGE_ACTIVATION = Object.freeze({
  schemaVersion: 1,
  revision: 1,
  status: 'scheduled',
  storedStatus: 'scheduled',
  mode: 'solo',
  startDate: '2026-02-20',
  timeZone: 'UTC',
  challengeDay: null,
  crewId: null,
  groupMembershipActive: false,
  activatedAt: null,
  confirmedAt: FIXED_NOW,
  activatedBy: null,
  confirmedBy: FIXED_USER_ID,
  reviewRequired: false,
  canActivateSolo: false,
  canActivateGroup: false,
  canParticipate: false,
  canMutateDailyStandards: false,
  canEditStartDate: true,
});

const json = (value) => JSON.parse(JSON.stringify(value));

function baseMemberJson() {
  return {
    'dominion:user': json(FIXED_USER),
    'dominion:memberName': FIXED_USER.name,
    'dominion:mockUserIdsByIdentity': {
      [FIXED_USER.email.trim().toLowerCase()]: FIXED_USER_ID,
    },
    'dominion:mockSubscription': json(ACTIVE_SUBSCRIPTION),
    'dominion:startDate': FIXED_CHALLENGE_START,
    'dominion:entries': [],
    'dominion:checkInDates': {
      owner: 'mock:' + FIXED_USER.email,
      dates: [],
      challengeDays: [],
    },
    'dominion:workoutDifficulty': {},
    'dominion:feed': json(BASE_FEED),
    'dominion:gameStats': json(BASE_GAME_STATS),
    'dominion:badges': json(BASE_BADGES),
    'dominion:mockCrews': json(BASE_CREWS),
    'dominion:mockCrewMembers': json(BASE_CREW_MEMBERS),
    'dominion:mockCrewInvites': {},
    'dominion:mockJournalEntries': [],
    'dominion:mockChallengeStates': [],
    'dominion:mockChallengeActivation': {
      [FIXED_USER_ID]: json(BASE_CHALLENGE_ACTIVATION),
    },
    'dominion:mockRewardEntitlements': json(BASE_REWARD_ENTITLEMENTS),
    'dominion:previewChallenge': { enabled: false },
  };
}

function baseMemberRaw() {
  return {
    'dominion:mockUserId': FIXED_USER_ID,
    'dominion:activeCrewId': 'crew_e2e_alpha',
    'dominion:mockChallengeThresholdsVersion': '2',
  };
}

export const APP_STATES = Object.freeze({
  guest: {
    json: {},
    raw: {},
  },
  memberLocked: {
    json: {
      ...baseMemberJson(),
      'dominion:mockSubscription': null,
    },
    raw: baseMemberRaw(),
  },
  member: {
    json: baseMemberJson(),
    raw: baseMemberRaw(),
  },
  notStarted: {
    json: {
      ...baseMemberJson(),
      'dominion:startDate': null,
      'dominion:entries': [
        {
          date: FIXED_TODAY,
          completed: ['bible', 'morningPrayer', 'workoutOne'],
          workoutDifficulty: { workoutOne: 'hard' },
          workoutDifficultySelections: { workoutOne: 'hard' },
          version: 4,
        },
      ],
      'dominion:checkInDates': {
        owner: 'mock:' + FIXED_USER.email,
        dates: [],
        challengeDays: [],
      },
      'dominion:feed': [],
      'dominion:gameStats': {
        ...json(BASE_GAME_STATS),
        totalPoints: 0,
        challengePoints: 0,
        currentAppStreak: 0,
        bestAppStreak: 0,
        currentFullDayStreak: 0,
        bestFullDayStreak: 0,
        lastSeenDate: null,
        lastFullDayDate: null,
      },
      'dominion:badges': [],
      'dominion:mockCrews': [],
      'dominion:mockCrewMembers': {},
      'dominion:mockChallengeActivation': {
        [FIXED_USER_ID]: json(NOT_STARTED_CHALLENGE_ACTIVATION),
      },
    },
    raw: {
      ...baseMemberRaw(),
      'dominion:activeCrewId': null,
    },
  },
  scheduledSolo: {
    json: {
      ...baseMemberJson(),
      'dominion:startDate': '2026-02-20',
      'dominion:entries': [],
      'dominion:checkInDates': {
        owner: 'mock:' + FIXED_USER.email,
        dates: [],
        challengeDays: [],
      },
      'dominion:mockCrews': [],
      'dominion:mockCrewMembers': {},
      'dominion:mockChallengeActivation': {
        [FIXED_USER_ID]: json(SCHEDULED_SOLO_CHALLENGE_ACTIVATION),
      },
    },
    raw: {
      ...baseMemberRaw(),
      'dominion:activeCrewId': null,
    },
  },
  communityEmpty: {
    json: {
      ...baseMemberJson(),
      'dominion:mockCrews': [],
      'dominion:mockCrewMembers': {},
      'dominion:mockJournalEntries': [],
    },
    raw: {
      ...baseMemberRaw(),
      'dominion:activeCrewId': null,
    },
  },
  communityMember: {
    json: {
      ...baseMemberJson(),
      'dominion:mockCrews': [{ ...json(BASE_CREWS[0]), role: 'member' }],
      'dominion:mockCrewMembers': {
        crew_e2e_alpha: BASE_CREW_MEMBERS.crew_e2e_alpha.map((member) => (
          member.userId === FIXED_USER_ID ? { ...json(member), role: 'member' } : json(member)
        )),
      },
    },
    raw: baseMemberRaw(),
  },
  rewardsLocked: {
    json: {
      ...baseMemberJson(),
      'dominion:gameStats': {
        ...json(BASE_GAME_STATS),
        totalPoints: 28,
        challengePoints: 28,
      },
      'dominion:mockChallengeStates': [],
      'dominion:mockRewardEntitlements': [],
    },
    raw: baseMemberRaw(),
  },
  rewardsUnlocked: {
    json: {
      ...baseMemberJson(),
      'dominion:gameStats': {
        ...json(BASE_GAME_STATS),
        totalPoints: 1200,
        challengePoints: 1200,
      },
      'dominion:mockChallengeStates': [
        {
          key: 'seven_day_reset',
          status: 'available',
          unlockPoints: 126,
          unlockedAt: '2026-02-10T18:00:00.000Z',
          startedAt: null,
          completedAt: null,
          celebrationSeenAt: '2026-02-10T18:05:00.000Z',
        },
      ],
    },
    raw: baseMemberRaw(),
  },
  submitted: {
    json: {
      ...baseMemberJson(),
      'dominion:entries': [
        {
          date: FIXED_TODAY,
          completed: [
            'bible',
            'morningPrayer',
            'worshipOnly',
            'workoutOne',
            'walk',
            'workoutTwo',
            'eveningPrayer',
          ],
        },
      ],
      'dominion:checkInDates': {
        owner: 'mock:' + FIXED_USER.email,
        dates: [FIXED_TODAY],
        challengeDays: [FIXED_CHALLENGE_DAY],
      },
      'dominion:gameStats': {
        ...json(BASE_GAME_STATS),
        totalPoints: 757,
        challengePoints: 757,
        currentFullDayStreak: 5,
      },
    },
    raw: baseMemberRaw(),
  },
});

export function fixtureFor(name, theme = 'dark') {
  const state = APP_STATES[name];
  if (!state) throw new Error('Unknown browser fixture: ' + name);

  return {
    json: {
      ...json(state.json),
      'dominion:theme': theme,
      'dominion:mockThemePreferences': {
        [FIXED_USER_ID]: {
          themeKey: theme,
          updatedAt: FIXED_NOW,
        },
      },
    },
    raw: json(state.raw),
  };
}
