export const CREW_TRAINING_VERSION = 1;
export const CREW_TRAINING_STEP_COUNT = 7;

const TRAINING_STATUSES = new Set(['not_started', 'in_progress', 'skipped', 'completed']);

const text = (value, fallback = '') => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || fallback;
};

const integer = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
};

const boundedStep = (value) => Math.max(
  0,
  Math.min(CREW_TRAINING_STEP_COUNT - 1, integer(value)),
);

export function normalizeCrewTrainingProgress(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const statusValue = text(source.status).toLowerCase();
  const status = TRAINING_STATUSES.has(statusValue) ? statusValue : 'not_started';
  let currentStep = boundedStep(source.currentStep ?? source.current_step);
  let furthestStep = boundedStep(source.furthestStep ?? source.furthest_step ?? currentStep);
  furthestStep = Math.max(currentStep, furthestStep);

  if (status === 'not_started') {
    currentStep = 0;
    furthestStep = 0;
  } else if (status === 'completed') {
    currentStep = CREW_TRAINING_STEP_COUNT - 1;
    furthestStep = CREW_TRAINING_STEP_COUNT - 1;
  }

  return {
    crewId: text(source.crewId ?? source.crew_id),
    userId: text(source.userId ?? source.user_id),
    contentVersion: Math.max(1, integer(
      source.contentVersion ?? source.content_version,
      CREW_TRAINING_VERSION,
    )),
    status,
    currentStep,
    furthestStep,
    stepCount: CREW_TRAINING_STEP_COUNT,
    startedAt: source.startedAt ?? source.started_at ?? null,
    skippedAt: source.skippedAt ?? source.skipped_at ?? null,
    completedAt: source.completedAt ?? source.completed_at ?? null,
    updatedAt: source.updatedAt ?? source.updated_at ?? null,
  };
}

export function crewTrainingActionLabel(progress) {
  const status = normalizeCrewTrainingProgress(progress).status;
  if (status === 'completed') return 'Replay Crew Training';
  if (status === 'in_progress' || status === 'skipped') return 'Resume Crew Training';
  return 'Start Crew Training';
}

export function buildCrewTrainingSteps({ integrationsEnabled = false, crewName = '' } = {}) {
  const name = text(crewName, 'Your crew');
  const providerSteps = integrationsEnabled
    ? [
        {
          id: 'provider-purpose',
          title: 'Keep conversation in your channel',
          description: 'Dominion manages the roster and accountability. Approved progress updates can go to Slack or Discord only with member consent; replies and conversation never sync back into Dominion.',
          targetId: 'crewIntegrationsCard',
          actionable: false,
          targetUnavailableDescription: 'External update guidance is informational until the integration area is available.',
        },
        {
          id: 'provider-connection',
          title: 'Connect deliberately',
          description: 'An authorized owner or admin can choose Slack, Discord, or both: authorize the provider, confirm the workspace or server and channel, return here, verify the status, then send a deliberate test. Reconnect and disconnect controls remain available for needs-attention states.',
          targetId: 'integrationConnectActions',
          actionable: true,
          targetUnavailableDescription: 'Connection controls may be hidden when every provider is already configured. Review existing destinations in the integration area instead.',
        },
      ]
    : [
        {
          id: 'provider-purpose',
          title: 'External updates are safely off',
          description: 'Slack and Discord connections are not currently available. No crew update leaves Dominion through a provider, and core crew training works without an external channel.',
          targetId: null,
          actionable: false,
        },
        {
          id: 'provider-connection',
          title: 'Nothing to connect right now',
          description: 'There is no authorization, destination selection, callback, or test action in safe-off mode. Continue using the private roster and leaderboard inside Dominion.',
          targetId: null,
          actionable: false,
        },
      ];

  return [
    {
      id: 'crew-ready',
      title: `${name} is ready`,
      description: 'This is your single active crew for the current product version. As its creator and owner/admin, you can manage invitations, enabled integrations, and safe crew lifecycle actions.',
      targetId: 'crewSummary',
      actionable: false,
    },
    {
      id: 'invite-people',
      title: 'Invite people privately',
      description: 'Invite links use the secure crew flow: they expire or rotate, and a recipient must review and confirm before joining. This crew is not public, and training never creates or copies an invitation.',
      targetId: 'copyInviteButton',
      actionable: false,
      targetUnavailableDescription: 'Invitation guidance remains informational until the Invite People action is available.',
    },
    {
      id: 'members-and-roles',
      title: 'Know the roster and roles',
      description: 'Owners and admins can see management controls; members have a narrower role. Every person still owns their profile, progress, points, badges, and private journal.',
      targetId: 'crewMembersCard',
      actionable: false,
      targetUnavailableDescription: 'Roster guidance remains available even while member activity is loading.',
    },
    {
      id: 'leaderboard-and-progress',
      title: 'Read progress without changing it',
      description: 'Weekly and challenge views show points, placement, podium, and prestige for current crew activity. Rank can change as members progress, but it never rewrites anyone’s underlying personal points.',
      targetId: 'crewLeaderboardCard',
      actionable: false,
      targetUnavailableDescription: 'Leaderboard guidance is informational until the crew leaderboard is available.',
    },
    ...providerSteps,
    {
      id: 'safe-management',
      title: 'Manage the crew safely',
      description: 'Routine crew controls stay above this separated lifecycle area. Owners and admins see Delete Crew; regular members see Leave Group. Either action requires its own explicit confirmation, and training never selects it.',
      targetId: 'crewLifecycleCard',
      actionable: false,
      targetUnavailableDescription: 'Lifecycle guidance remains informational when the management area is unavailable.',
    },
  ];
}
