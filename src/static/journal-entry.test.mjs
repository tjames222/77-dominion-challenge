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
const canonicalSchema = readFileSync(new URL('../../supabase/schema.sql', import.meta.url), 'utf8');
const cleanupMigration = readFileSync(
  new URL('../../supabase/migrations/20260722152953_remove_journal_photo_infrastructure.sql', import.meta.url),
  'utf8',
);

describe('text-only private journal', () => {
  test('normalizes database and legacy preview records without retaining photo data', () => {
    const legacy = {
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
    const normalized = normalizeJournalEntry(legacy);
    assert.equal(Object.hasOwn(normalized, 'photos'), false);
    assert.equal(normalized.note, 'Held the line.');
    assert.equal(normalized.day, 14);
    assert.equal(legacy.photos.length, 1, 'normalization must not mutate its input');
  });

  test('keeps preview entries in reverse chronological order', () => {
    const entries = [
      normalizeJournalEntry({ id: 'older', date: '2026-07-18' }),
      normalizeJournalEntry({ id: 'newer', date: '2026-07-20' }),
    ];
    assert.deepEqual(sortJournalEntries(entries).map((entry) => entry.id), ['newer', 'older']);
    assert.deepEqual(entries.map((entry) => entry.id), ['older', 'newer']);
  });

  test('preserves all six journal fields and their text-only API path', () => {
    ['journalDate', 'journalMood', 'journalEnergy', 'journalNote', 'journalWin', 'journalPrayer']
      .forEach((id) => assert.match(communityHtml, new RegExp(`id=["']${id}["']`)));
    assert.match(communityHtml, /id=["']journalForm["']/);
    assert.match(communityHtml, /id=["']journalTimeline["']/);
    assert.match(apiJs, /\.from\('journal_entries'\)/);
    assert.match(apiJs, /readJson\(MOCK_JOURNAL_KEY, \[\]\)\.map\(normalizeJournalEntry\)/);
    assert.match(apiJs, /writeJson\(MOCK_JOURNAL_KEY, entries\)/);
  });

  test('removes every supported photo hook while retaining responsive layout', () => {
    const retiredHooks = [
      'journalPhoto',
      'journalPhotoCaption',
      'uploadJournalPhoto',
      'journal_photos',
      'journal-progress',
      'journal-photos',
    ];
    for (const hook of retiredHooks) {
      for (const source of [communityHtml, communityJs, apiJs, communityCss]) {
        assert.equal(source.includes(hook), false, `retired journal photo hook remains: ${hook}`);
      }
    }
    assert.doesNotMatch(`${billingHtml}\n${membershipHtml}`, /progress photos/i);
    assert.match(communityCss, /\.journal-form > button\[type="submit"\][\s\S]*grid-column:\s*1 \/ -1/);
    assert.match(communityCss, /@media \(min-width: 720px\)[\s\S]*\.journal-form[\s\S]*repeat\(2, 1fr\)/);
  });

  test('cleanup fails closed on every live data and retention-work dimension', () => {
    assert.match(cleanupMigration, /lock table storage\.objects in share mode/);
    assert.match(cleanupMigration, /lock table private\.retired_community_deletion_batches in share mode/);
    assert.match(cleanupMigration, /lock table private\.retired_community_storage_work in share mode/);
    assert.match(cleanupMigration, /storage\.s3_multipart_uploads/);
    assert.match(cleanupMigration, /journal_object_count > 0/);
    assert.match(cleanupMigration, /journal_photo_row_count > 0/);
    assert.match(cleanupMigration, /nonterminal_work_count > 0/);
    assert.match(cleanupMigration, /terminal\.event_type in \('cancelled', 'executed'\)/);
    assert.doesNotMatch(cleanupMigration, /delete\s+from\s+storage\.objects/i);
    assert.match(cleanupMigration, /drop table if exists public\.journal_photos/);
    assert.match(cleanupMigration, /delete from storage\.buckets where id = 'journal-progress'/);
  });

  test('canonical replay applies the final cleanup while preserving DR compatibility elsewhere', () => {
    assert.match(canonicalSchema, /20260722152953_remove_journal_photo_infrastructure\.sql/);
    assert.match(canonicalSchema, /'profile-photos', 'journal-progress'/);
  });
});
