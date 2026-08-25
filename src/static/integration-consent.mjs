export const OUTBOUND_EVENT_TYPES = Object.freeze({
  checkIns: 'check_in',
  streakMilestones: 'streak_milestone',
  badgesRewards: 'badge_reward',
  membership: 'membership',
});

export const OUTBOUND_PRESENTATION_MODES = Object.freeze(['anonymous', 'named']);

const eventKeys = Object.freeze(Object.keys(OUTBOUND_EVENT_TYPES));
const asBoolean = (value) => value === true;
const asString = (value) => String(value || '').trim();

export function defaultOutboundConsent(overrides = {}) {
  return {
    schemaVersion: 1,
    consentId: null,
    userId: asString(overrides.userId),
    crewId: asString(overrides.crewId),
    eventType: null,
    accountActive: asBoolean(overrides.accountActive),
    membershipActive: asBoolean(overrides.membershipActive),
    consentRecorded: false,
    outboundUpdatesEnabled: false,
    presentationMode: 'anonymous',
    events: {
      checkIns: false,
      streakMilestones: false,
      badgesRewards: false,
      membership: false,
    },
    eventRecognized: false,
    eventAllowed: false,
    eligible: false,
    reason: 'consent_missing',
    revision: 0,
    changedAt: null,
    evaluatedAt: null,
    destinationCheckRequired: true,
  };
}

export function outboundEventAllowed(consent, eventType) {
  const eventKey = eventKeys.find((key) => OUTBOUND_EVENT_TYPES[key] === eventType);
  if (!eventKey) return false;
  return asBoolean(consent?.events?.[eventKey]);
}

function reasonFor(consent) {
  if (!consent.accountActive) return 'account_missing';
  if (!consent.membershipActive) return 'membership_missing';
  if (!consent.consentRecorded) return 'consent_missing';
  if (!consent.outboundUpdatesEnabled) return 'updates_disabled';
  if (!consent.eventType) return 'event_required';
  if (!consent.eventRecognized) return 'unsupported_event';
  if (!consent.eventAllowed) return 'event_not_approved';
  return 'approved';
}

export function normalizeOutboundConsent(input = {}, overrides = {}) {
  const defaults = defaultOutboundConsent({
    userId: overrides.userId ?? input.userId,
    crewId: overrides.crewId ?? input.crewId,
    accountActive: overrides.accountActive ?? input.accountActive,
    membershipActive: overrides.membershipActive ?? input.membershipActive,
  });
  const presentationMode = OUTBOUND_PRESENTATION_MODES.includes(input.presentationMode)
    ? input.presentationMode
    : 'anonymous';
  const eventType = asString(input.eventType) || null;
  const events = Object.fromEntries(eventKeys.map((key) => [key, asBoolean(input.events?.[key])]));
  const normalized = {
    ...defaults,
    schemaVersion: Number(input.schemaVersion) === 1 ? 1 : defaults.schemaVersion,
    consentId: asString(input.consentId) || null,
    userId: asString(overrides.userId ?? input.userId),
    crewId: asString(overrides.crewId ?? input.crewId),
    eventType,
    accountActive: asBoolean(overrides.accountActive ?? input.accountActive),
    membershipActive: asBoolean(overrides.membershipActive ?? input.membershipActive),
    consentRecorded: asBoolean(input.consentRecorded),
    outboundUpdatesEnabled: asBoolean(input.outboundUpdatesEnabled),
    presentationMode,
    events,
    revision: Math.max(0, Number.parseInt(input.revision, 10) || 0),
    changedAt: input.changedAt || null,
    evaluatedAt: input.evaluatedAt || null,
    destinationCheckRequired: input.destinationCheckRequired !== false,
  };

  normalized.eventRecognized = Object.values(OUTBOUND_EVENT_TYPES).includes(eventType);
  normalized.eventAllowed = outboundEventAllowed(normalized, eventType);
  normalized.eligible = normalized.accountActive
    && normalized.membershipActive
    && normalized.consentRecorded
    && normalized.outboundUpdatesEnabled
    && normalized.eventRecognized
    && normalized.eventAllowed;
  normalized.reason = reasonFor(normalized);
  return normalized;
}

export function outboundConsentWritePayload(input = {}) {
  return {
    outboundUpdatesEnabled: asBoolean(input.outboundUpdatesEnabled),
    presentationMode: OUTBOUND_PRESENTATION_MODES.includes(input.presentationMode)
      ? input.presentationMode
      : 'anonymous',
    events: Object.fromEntries(eventKeys.map((key) => [key, asBoolean(input.events?.[key])])),
  };
}

export function outboundConsentSettingsEqual(left, right) {
  const normalizedLeft = outboundConsentWritePayload(left);
  const normalizedRight = outboundConsentWritePayload(right);
  return normalizedLeft.outboundUpdatesEnabled === normalizedRight.outboundUpdatesEnabled
    && normalizedLeft.presentationMode === normalizedRight.presentationMode
    && eventKeys.every((key) => normalizedLeft.events[key] === normalizedRight.events[key]);
}

export function normalizeConnectedDestinations(destinations = []) {
  if (!Array.isArray(destinations)) return [];

  return destinations.flatMap((destination) => {
    const platform = asString(destination?.platform || destination?.provider).toLowerCase();
    const connected = destination?.connected === true || ['connected', 'active'].includes(destination?.status);
    if (!connected || !['slack', 'discord'].includes(platform)) return [];

    const name = asString(
      destination.channelName
      || destination.destinationName
      || destination.name
      || (platform === 'slack' ? 'Slack channel' : 'Discord channel'),
    );
    const context = asString(destination.workspaceName || destination.serverName || destination.context);
    return [{
      id: asString(destination.id) || `${platform}:${context}:${name}`,
      platform,
      name,
      context,
      connected: true,
    }];
  });
}
