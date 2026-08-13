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
  if (status === 'completed') return 'Replay Group Training';
  if (status === 'in_progress' || status === 'skipped') return 'Resume Group Training';
  return 'Start Group Training';
}

export function buildCrewTrainingSteps({ integrationsEnabled = false, crewName = '' } = {}) {
  const name = text(crewName, 'Your group');
  const providerSteps = integrationsEnabled
    ? [
        {
          id: 'provider-purpose',
          title: 'Keep conversation in your channel',
          description: 'Dominion manages the roster and accountability. Open Group Settings when you want to review Slack or Discord connections. Approved progress updates leave Dominion only with member consent; replies and conversation never sync back.',
          targetId: 'crewSettingsButton',
          actionable: false,
          targetUnavailableDescription: 'External update guidance is informational until the integration area is available.',
        },
        {
          id: 'provider-connection',
          title: 'Connect a channel',
          description: 'In Group Settings, an owner or admin can connect Slack or Discord, check the selected channel, send a test, reconnect, or disconnect.',
          targetId: 'crewSettingsButton',
          actionable: false,
          targetUnavailableDescription: 'Connection controls may be hidden when every provider is already configured. Review existing destinations in the integration area instead.',
        },
      ]
    : [
        {
          id: 'provider-purpose',
          title: 'External updates are off',
          description: 'Slack and Discord connections aren’t available right now. Group updates stay inside Dominion, and the rest of this walkthrough still works.',
          targetId: null,
          actionable: false,
        },
        {
          id: 'provider-connection',
          title: 'Nothing to connect right now',
          description: 'Continue using the private member list and leaderboard inside Dominion. There’s no external channel to set up right now.',
          targetId: null,
          actionable: false,
        },
      ];

  return [
    {
      id: 'crew-ready',
      title: `${name} is ready`,
      description: 'This is your active private group. As its creator and owner or admin, you can manage invitations, connected channels, and group access.',
      targetId: 'crewSummary',
      actionable: false,
    },
    {
      id: 'invite-people',
      title: 'Invite people privately',
      description: 'Private invitations expire or can be replaced. Each person reviews the invitation before joining. This walkthrough won’t create or copy one.',
      targetId: 'copyInviteButton',
      actionable: false,
      targetUnavailableDescription: 'Invitation guidance remains informational until the Invite People action is available.',
    },
    {
      id: 'members-and-roles',
      title: 'Know the roster and roles',
      description: 'Owners and admins can see management controls; members have a narrower role. Every person still owns their profile, progress, points, badges, and private journal.',
      targetId: 'crewMembersTitle',
      actionable: false,
      targetUnavailableDescription: 'Roster guidance remains available even while member activity is loading.',
    },
    {
      id: 'leaderboard-and-progress',
      title: 'Read progress without changing it',
      description: 'Weekly and challenge views show each member’s points and rank. Rankings can change, but no one’s personal point total is changed by the leaderboard.',
      targetId: 'crewLeaderboardTitle',
      actionable: false,
      targetUnavailableDescription: 'Leaderboard guidance is informational until the crew leaderboard is available.',
    },
    ...providerSteps,
    {
      id: 'safe-management',
      title: 'Manage group access',
      description: 'Use Group Settings to leave or delete the group. Both actions ask for confirmation, and this walkthrough won’t select either one.',
      targetId: 'crewSettingsButton',
      actionable: false,
      targetUnavailableDescription: 'Lifecycle guidance remains informational when the management area is unavailable.',
    },
  ];
}
