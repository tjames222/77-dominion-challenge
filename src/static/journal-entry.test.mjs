import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { normalizeJournalEntry, sortJournalEntries } from './journal-entry.mjs';

const communityHtml = readFileSync(new URL('../../community.html', import.meta.url), 'utf8');
const billingHtml = readFileSync(new URL('../../billing.html', import.meta.url), 'utf8');
const membershipHtml = readFileSync(new URL('../../membership.html', import.meta.url), 'utf8');
const communityCss = readFileSync(new URL('../assets/community.css', import.meta.url), 'utf8');
const apiJs = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
const communityJs = readFileSync(new URL('./community.js', import.meta.url), 'utf8');
const schemaSql = readFileSync(new URL('../../supabase/schema.sql', import.meta.url), 'utf8');
const cleanupMigrationSql = readFileSync(
  new URL('../../supabase/migrations/20260721022605_remove_journal_photo_infrastructure.sql', import.meta.url),
  'utf8',
);

describe('text-only private journal', () => {
  test('normalizes database and legacy preview records without retaining photo data', () => {
    const legacyEntry = {
      id: 'journal-one',
      entry_date: '2026-07-20',
      challenge_day: 14,
      note: 'Held the line.',
      win: 'Finished the work.',
      prayer: 'Stay faithful.',
      mood: 'Focused',
      energy: 'High',
      created_at: '2026-07-20T08:00:00.000Z',
      updated_at: '2026-07-20T09:00:00.000Z',
      photos: [{ url: 'data:image/jpeg;base64,legacy' }],
    };

    assert.deepEqual(normalizeJournalEntry(legacyEntry), {
      id: 'journal-one',
      date: '2026-07-20',
      day: 14,
      note: 'Held the line.',
      win: 'Finished the work.',
      prayer: 'Stay faithful.',
      mood: 'Focused',
      energy: 'High',
      createdAt: '2026-07-20T08:00:00.000Z',
      updatedAt: '2026-07-20T09:00:00.000Z',
    });
    assert.equal(Object.hasOwn(normalizeJournalEntry(legacyEntry), 'photos'), false);
    assert.equal(legacyEntry.photos.length, 1, 'normalization must not mutate its input');
  });

  test('keeps preview entries in reverse chronological order', () => {
    const entries = [
      normalizeJournalEntry({ id: 'older', date: '2026-07-18' }),
      normalizeJournalEntry({ id: 'newer', date: '2026-07-20' }),
    ];

    assert.deepEqual(sortJournalEntries(entries).map((entry) => entry.id), ['newer', 'older']);
    assert.deepEqual(entries.map((entry) => entry.id), ['older', 'newer']);
  });

  test('preserves every text journal field and rewrites legacy preview state', () => {
    ['journalDate', 'journalMood', 'journalEnergy', 'journalNote', 'journalWin', 'journalPrayer']
      .forEach((id) => assert.match(communityHtml, new RegExp(`id=["']${id}["']`)));
    assert.match(communityHtml, /id=["']journalForm["']/);
    assert.match(communityHtml, /id=["']journalTimeline["']/);

    assert.match(
      apiJs,
      /\.from\(['"]journal_entries['"]\)[\s\S]*?\.select\(['"]id, user_id, entry_date, challenge_day, note, win, prayer, mood, energy, created_at, updated_at['"]\)/,
    );
    assert.match(apiJs, /readJson\(MOCK_JOURNAL_KEY, \[\]\)\.map\(normalizeJournalEntry\)/);
    assert.match(apiJs, /writeJson\(MOCK_JOURNAL_KEY, entries\)/);
  });

  test('keeps membership-gated ownership RLS for journal entries', () => {
    assert.match(schemaSql, /alter table public\.journal_entries enable row level security;/);
    [
      'Users can read own journal entries',
      'Users can insert own journal entries',
      'Users can update own journal entries',
      'Users can delete own journal entries',
    ].forEach((policy) => assert.ok(schemaSql.includes(`create policy "${policy}"`), `missing ${policy}`));

    const policyStart = schemaSql.indexOf('create policy "Users can read own journal entries"');
    const policyEnd = schemaSql.indexOf('revoke all on public.profiles from anon;', policyStart);
    const journalPolicies = schemaSql.slice(policyStart, policyEnd);
    assert.ok(policyStart >= 0 && policyEnd > policyStart, 'missing journal policy section');
    assert.ok((journalPolicies.match(/public\.has_active_entitlement\('membership_active'\)/g) || []).length >= 5);
    assert.ok((journalPolicies.match(/\(select auth\.uid\(\)\)/g) || []).length >= 5);
    assert.match(schemaSql, /grant select, insert, update, delete on public\.journal_entries to authenticated;/);
  });

  test('removes journal photo hooks without disturbing responsive theme styling', () => {
    const retiredHooks = [
      'journalPhoto',
      'journalPhotoCaption',
      'uploadJournalPhoto',
      'journal_photos',
      'journal-progress',
      'journal-photos',
    ];
    const currentSources = [communityHtml, communityJs, apiJs, communityCss, schemaSql];

    retiredHooks.forEach((hook) => currentSources.forEach((source) => {
      assert.equal(source.includes(hook), false, `retired journal photo hook remains: ${hook}`);
    }));
    assert.doesNotMatch(`${billingHtml}\n${membershipHtml}`, /progress photos/i);

    assert.match(communityCss, /\.journal-form[\s\S]*?background:\s*var\(--input\);[\s\S]*?color:\s*var\(--text\);/);
    assert.match(communityCss, /\.journal-form > button\[type="submit"\][\s\S]*?grid-column:\s*1 \/ -1;/);
    assert.match(communityCss, /@media \(min-width: 720px\)[\s\S]*?\.journal-form[\s\S]*?grid-template-columns:\s*repeat\(2, 1fr\);/);
  });

  test('existing-deployment cleanup fails closed when retained photo data appears', () => {
    assert.match(cleanupMigrationSql, /lock table storage\.objects in share mode/);
    assert.match(cleanupMigrationSql, /where bucket_id = 'journal-progress'/);
    assert.match(cleanupMigrationSql, /storage\.s3_multipart_uploads/);
    assert.match(cleanupMigrationSql, /active multipart upload\(s\)/);
    assert.match(cleanupMigrationSql, /if journal_object_count > 0 then[\s\S]*?raise exception/);
    assert.match(cleanupMigrationSql, /if journal_photo_row_count > 0 then[\s\S]*?raise exception/);
    assert.doesNotMatch(cleanupMigrationSql, /delete from storage\.objects/);
    assert.match(cleanupMigrationSql, /set local storage\.allow_delete_query = 'true'/);
    assert.match(cleanupMigrationSql, /drop table if exists public\.journal_photos/);
    assert.match(cleanupMigrationSql, /delete from storage\.buckets[\s\S]*?journal-progress/);
  });
});
