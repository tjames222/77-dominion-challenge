export const CREW_TRAINING_VERSION = 1;

const ADMIN_ROLES = new Set(['owner', 'admin']);
const TRAINING_STATUSES = new Set(['not_started', 'in_progress', 'skipped', 'completed']);

export function isCrewAdmin(role = '') {
  return ADMIN_ROLES.has(String(role));
}

export function crewLifecycleAction(role = '') {
  return isCrewAdmin(role) ? 'delete' : 'leave';
}

export function assertSingleCrew(crews = []) {
  const items = Array.isArray(crews) ? crews.filter(Boolean) : [];
  if (items.length > 1) {
    throw new Error('This account has more than one active crew. Contact support before continuing so no membership is discarded.');
  }
  return items;
}

export function crewViewState({ loaded = false, crew = null, createFormOpen = false } = {}) {
  return {
    showCreateCard: Boolean(loaded && !crew),
    showCreateButton: Boolean(loaded && !crew && !createFormOpen),
    showCreateForm: Boolean(loaded && !crew && createFormOpen),
    showActiveCrew: Boolean(loaded && crew),
  };
}

export function integrationsEnabled(value) {
  return value === true || String(value || '').trim().toLowerCase() === 'true';
}

export function normalizeCrewTrainingProgress(progress, { version = CREW_TRAINING_VERSION } = {}) {
  const status = TRAINING_STATUSES.has(progress?.status) ? progress.status : 'not_started';
  const rawStep = Number(progress?.currentStep ?? progress?.current_step ?? 0);
  return {
    crewId: progress?.crewId || progress?.crew_id || '',
    version: Number(progress?.version || version) || version,
    status,
    currentStep: Number.isFinite(rawStep) ? Math.max(0, Math.min(6, Math.trunc(rawStep))) : 0,
    startedAt: progress?.startedAt || progress?.started_at || null,
    completedAt: progress?.completedAt || progress?.completed_at || null,
    updatedAt: progress?.updatedAt || progress?.updated_at || null,
  };
}

export function shouldAutoStartCrewTraining({ createdNew = false, role = '', progress = null } = {}) {
  const normalized = normalizeCrewTrainingProgress(progress);
  return Boolean(createdNew && isCrewAdmin(role) && normalized.status === 'not_started');
}

export function crewTrainingActionLabel(progress) {
  const status = normalizeCrewTrainingProgress(progress).status;
  if (status === 'completed') return 'Replay Crew Training';
  if (status === 'in_progress' || status === 'skipped') return 'Resume Crew Training';
  return 'Start Crew Training';
}

export function buildCrewTrainingSteps({ crewName = 'Your crew', providersEnabled = false } = {}) {
  const safeCrewName = String(crewName || 'Your crew');
  const providerConnectionCopy = providersEnabled
    ? 'Authorize Slack or Discord, choose the workspace or server and channel, return to Dominion, verify the connection, then send a deliberate test. Connected, disconnected, and needs-attention states always stay visible.'
    : 'Slack and Discord connections are currently unavailable. No provider controls, authorization links, or test actions are exposed while integrations are safely off.';

  return [
    {
      id: 'crew-ready',
      title: `${safeCrewName} is ready`,
      body: 'This is your one active crew. As its creator, you can manage invitations, integrations when available, and the crew lifecycle.',
      targetId: 'crewSummary',
    },
    {
      id: 'invite-people',
      title: 'Invite people privately',
      body: 'Invite links are for people you know. Recipients confirm before joining, and nobody is added automatically.',
      targetId: 'copyInviteButton',
    },
    {
      id: 'members-and-roles',
      title: 'Know the room and the roles',
      body: 'The roster identifies owners, admins, and members. Admin-only controls stay restricted, while every person keeps ownership of their profile, progress, points, badges, and journal.',
      targetId: 'crewMembersCard',
    },
    {
      id: 'leaderboard',
      title: 'Read crew progress',
      body: 'Switch between weekly and challenge views to compare current crew activity. Placement can change, but ranking never changes anyone\'s underlying personal points.',
      targetId: 'crewLeaderboardCard',
    },
    {
      id: 'provider-purpose',
      title: 'Keep conversation where it belongs',
      body: 'Dominion manages membership and accountability. When enabled and consented, approved progress updates can go to a connected Slack or Discord channel; replies and conversation never sync back into Dominion.',
      targetId: providersEnabled ? 'crewIntegrationsCard' : '',
    },
    {
      id: 'provider-connect',
      title: providersEnabled ? 'Connect Slack or Discord deliberately' : 'Provider connections are safely off',
      body: providerConnectionCopy,
      targetId: providersEnabled ? 'integrationConnectActions' : '',
    },
    {
      id: 'manage-safely',
      title: 'Manage the crew safely',
      body: 'Routine actions stay above. Destructive controls are separated at the bottom: owners and admins can delete the crew, while members can leave. Both require explicit confirmation.',
      targetId: 'crewLifecycleCard',
    },
  ];
}
