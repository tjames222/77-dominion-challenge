import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  normalizeConnectedDestinations,
  normalizeOutboundConsent,
  outboundConsentSettingsEqual,
} from './integration-consent.mjs';

const activeContext = {
  userId: 'user-1',
  crewId: 'crew-1',
  accountActive: true,
  membershipActive: true,
};

describe('outbound integration consent', () => {
  test('fails closed when an existing or new member has no saved preference', () => {
    const consent = normalizeOutboundConsent({}, activeContext);

    assert.equal(consent.consentRecorded, false);
    assert.equal(consent.outboundUpdatesEnabled, false);
    assert.equal(consent.presentationMode, 'anonymous');
    assert.deepEqual(consent.events, {
      checkIns: false,
      streakMilestones: false,
      badgesRewards: false,
      membership: false,
    });
    assert.equal(consent.eligible, false);
  });

  test('allows only the explicitly approved event and preserves named presentation', () => {
    const checkInConsent = normalizeOutboundConsent({
      ...activeContext,
      eventType: 'check_in',
      consentRecorded: true,
      outboundUpdatesEnabled: true,
      presentationMode: 'named',
      events: { checkIns: true },
    });
    const badgeConsent = normalizeOutboundConsent({
      ...checkInConsent,
      eventType: 'badge_reward',
    });

    assert.equal(checkInConsent.presentationMode, 'named');
    assert.equal(checkInConsent.eligible, true);
    assert.equal(checkInConsent.reason, 'approved');
    assert.equal(badgeConsent.eligible, false);
    assert.equal(badgeConsent.reason, 'event_not_approved');
  });

  test('supports privacy-preserving presentation and immediate global opt-out', () => {
    const anonymous = normalizeOutboundConsent({
      ...activeContext,
      eventType: 'streak_milestone',
      consentRecorded: true,
      outboundUpdatesEnabled: true,
      presentationMode: 'not-a-mode',
      events: { streakMilestones: true },
    });
    const optedOut = normalizeOutboundConsent({
      ...anonymous,
      outboundUpdatesEnabled: false,
    });

    assert.equal(anonymous.presentationMode, 'anonymous');
    assert.equal(anonymous.eligible, true);
    assert.equal(optedOut.eligible, false);
    assert.equal(optedOut.reason, 'updates_disabled');
  });

  test('revokes eligibility when membership or the account disappears before retry', () => {
    const queuedAttempt = {
      ...activeContext,
      eventType: 'membership',
      consentRecorded: true,
      outboundUpdatesEnabled: true,
      events: { membership: true },
    };

    assert.equal(normalizeOutboundConsent(queuedAttempt).eligible, true);
    assert.equal(normalizeOutboundConsent({ ...queuedAttempt, membershipActive: false }).eligible, false);
    assert.equal(normalizeOutboundConsent({ ...queuedAttempt, accountActive: false }).eligible, false);
  });

  test('treats identical client retries as the same preference settings', () => {
    const first = {
      outboundUpdatesEnabled: true,
      presentationMode: 'named',
      events: { checkIns: true, membership: true },
    };
    const retry = {
      outboundUpdatesEnabled: true,
      presentationMode: 'named',
      events: { checkIns: true, membership: true },
    };

    assert.equal(outboundConsentSettingsEqual(first, retry), true);
    assert.equal(outboundConsentSettingsEqual(first, { ...retry, presentationMode: 'anonymous' }), false);
  });

  test('shows only currently connected Slack and Discord destinations', () => {
    assert.deepEqual(normalizeConnectedDestinations([
      { id: '1', platform: 'slack', status: 'connected', channelName: '#wins', workspaceName: 'Dominion Men' },
      { id: '2', provider: 'discord', status: 'active', channelName: 'daily-check-ins', workspaceName: 'Alpha' },
      { id: '3', platform: 'slack', status: 'disconnected', channelName: '#old' },
      { id: '4', platform: 'email', status: 'connected', name: 'Not supported' },
    ]), [
      { id: '1', platform: 'slack', name: '#wins', context: 'Dominion Men', connected: true },
      { id: '2', platform: 'discord', name: 'daily-check-ins', context: 'Alpha', connected: true },
    ]);
  });
});
