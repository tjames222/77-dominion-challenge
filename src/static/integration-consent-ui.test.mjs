import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const profileHtml = readFileSync(new URL('../../profile.html', import.meta.url), 'utf8');
const profileJs = readFileSync(new URL('./profile.js', import.meta.url), 'utf8');
const apiJs = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
const migrationSql = readFileSync(
  new URL('../../supabase/migrations/20260720100000_outbound_update_consent.sql', import.meta.url),
  'utf8',
);
const deliveryMigrationSql = readFileSync(
  new URL('../../supabase/migrations/20260720110000_outbound_event_delivery.sql', import.meta.url),
  'utf8',
);
const canonicalSchema = readFileSync(new URL('../../supabase/schema.sql', import.meta.url), 'utf8');
const integrationNotes = readFileSync(new URL('../../docs/outbound-update-consent.md', import.meta.url), 'utf8');

describe('member outbound update privacy surface', () => {
  test('exposes per-group opt-in, presentation, event, and destination controls', () => {
    [
      'integrationConsentCrew',
      'integrationDestinationList',
      'integrationUpdatesEnabled',
      'integrationShareCheckIns',
      'integrationShareStreaks',
      'integrationShareBadges',
      'integrationShareMembership',
      'saveIntegrationConsent',
    ].forEach((id) => {
      assert.match(profileHtml, new RegExp(`id=["']${id}["']`), `missing privacy control: ${id}`);
    });
    assert.match(profileHtml, /value="anonymous" checked/);
    assert.match(profileHtml, /data is sent outside Dominion/i);
    assert.match(profileHtml, /Group owners cannot opt in for you/i);
  });

  test('loads and saves preferences only after the authenticated profile hydrates', () => {
    assert.match(profileJs, /getOutboundUpdateConsent\(crewId\)/);
    assert.match(profileJs, /updateOutboundUpdateConsent\(crewId/);
    assert.match(profileJs, /if \(authenticated\) await hydrateIntegrationConsent\(\)/);
    assert.match(apiJs, /target_event_type: null/);
    assert.match(apiJs, /target_share_membership_events: settings\.events\.membership/);
  });

  test('keeps FOU-541 and FOU-553 destination dependencies behind a table-free adapter', () => {
    const adapter = apiJs.match(
      /export async function getOutboundIntegrationDestinations\(crewId\) \{([\s\S]*?)\n\}/,
    )?.[1] || '';
    assert.match(adapter, /normalizeConnectedDestinations\(\[\]\)/);
    assert.doesNotMatch(adapter, /\.from\(/);
    assert.match(integrationNotes, /When FOU-541 is integrated on top of the FOU-553 runtime/);
  });

  test('ships the stable fail-closed worker contract in migration and canonical schema', () => {
    [migrationSql, canonicalSchema].forEach((sql) => {
      assert.match(sql, /create table public\.outbound_update_preferences/);
      assert.match(sql, /outbound_updates_enabled boolean not null default false/);
      assert.match(sql, /presentation_mode text not null default 'anonymous'/);
      assert.match(sql, /references public\.crew_members \(crew_id, user_id\)\s+on delete cascade/);
      assert.match(sql, /create or replace function public\.get_current_outbound_consent/);
      assert.match(sql, /destinationCheckRequired', true/);
      assert.match(sql, /Members can read own outbound update preferences/);
      assert.match(sql, /Members can read own outbound consent audit/);
    });
    [migrationSql, deliveryMigrationSql, canonicalSchema].forEach((sql) => {
      assert.doesNotMatch(sql, /\bcrew_members\s+member\b|\bmember\./);
    });
  });

  test('keeps the immutable audit record free of event and message payload columns', () => {
    const auditTable = migrationSql.match(
      /create table public\.outbound_update_preference_audit \(([\s\S]*?)\n\);/,
    )?.[1] || '';
    assert.match(auditTable, /change_type text/);
    assert.doesNotMatch(auditTable, /\b(?:payload|message|body|event_data)\b/);
    assert.match(migrationSql, /Consent audit history is immutable/);
    assert.match(integrationNotes, /first attempt and every retry/);
  });
});
