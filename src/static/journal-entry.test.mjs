import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  groupJournalEntriesByDate,
  normalizeJournalEntry,
  sortJournalEntries,
} from './journal-entry.mjs';

const privateJournalHtml = readFileSync(new URL('../../private-journal.html', import.meta.url), 'utf8');
const billingHtml = readFileSync(new URL('../../billing.html', import.meta.url), 'utf8');
const membershipHtml = readFileSync(new URL('../../membership.html', import.meta.url), 'utf8');
const communityCss = readFileSync(new URL('../assets/community.css', import.meta.url), 'utf8');
const apiJs = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
const privateJournalJs = readFileSync(new URL('./private-journal.js', import.meta.url), 'utf8');
const journalFormJs = readFileSync(new URL('./journal-form.mjs', import.meta.url), 'utf8');
const canonicalSchema = readFileSync(new URL('../../supabase/schema.sql', import.meta.url), 'utf8');
const cleanupMigration = readFileSync(
  new URL('../../supabase/migrations/20260722152953_remove_journal_photo_infrastructure.sql', import.meta.url),
  'utf8',
);
const multipleEntriesMigration = readFileSync(
  new URL('../../supabase/migrations/20260813162042_allow_multiple_daily_journal_entries.sql', import.meta.url),
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

  test('groups same-date entries once and orders them deterministically', () => {
    const entries = [
      normalizeJournalEntry({
        id: 'morning', date: '2026-08-13', createdAt: '2026-08-13T08:00:00.000Z',
      }),
      normalizeJournalEntry({
        id: 'yesterday', date: '2026-08-12', createdAt: '2026-08-12T20:00:00.000Z',
      }),
      normalizeJournalEntry({
        id: 'evening', date: '2026-08-13', createdAt: '2026-08-13T19:00:00.000Z',
      }),
    ];

    assert.deepEqual(groupJournalEntriesByDate(entries), [
      { date: '2026-08-13', entries: [entries[2], entries[0]] },
      { date: '2026-08-12', entries: [entries[1]] },
    ]);
    assert.deepEqual(entries.map((entry) => entry.id), ['morning', 'yesterday', 'evening']);
  });

  test('preserves all six journal fields and their text-only API path', () => {
    ['date', 'mood', 'energy', 'note', 'win', 'prayer']
      .forEach((name) => assert.match(privateJournalHtml, new RegExp(`name=["']${name}["']`)));
    assert.match(privateJournalHtml, /id=["']journalFormTemplate["']/);
    assert.match(privateJournalHtml, /id=["']journalTimeline["']/);
    assert.match(journalFormJs, /field\.id = `\$\{idPrefix \|\| 'journal'\}\$\{suffix\}`/);
    assert.match(apiJs, /\.from\('journal_entries'\)/);
    assert.match(apiJs, /readMockUserValue\(MOCK_JOURNAL_KEY, \[\]\)\.map\(normalizeJournalEntry\)/);
    assert.match(apiJs, /writeMockUserValue\(MOCK_JOURNAL_KEY, entries\)/);
  });

  test('creates append-only entries and edits only an explicit entry id', () => {
    assert.match(apiJs, /export async function createJournalEntry\(entry\)/);
    assert.match(apiJs, /\.insert\(\{[\s\S]*?user_id: user\.id/);
    assert.doesNotMatch(apiJs, /\.upsert\([\s\S]*?onConflict:\s*['"]user_id,entry_date/);
    assert.match(apiJs, /export async function updateJournalEntry\(entryId, entry\)/);
    assert.match(apiJs, /\.update\(journalEntryWritePayload\(entry\)\)[\s\S]*?\.eq\('id', targetId\)[\s\S]*?\.eq\('user_id', user\.id\)/);
    assert.match(apiJs, /findIndex\(\(item\) => item\.id === targetId\)/);
    assert.doesNotMatch(apiJs, /findIndex\(\(item\) => item\.date === entry\.date\)/);
  });

  test('reuses the journal form for create and modal edit without mutating the create form', () => {
    assert.match(privateJournalJs, /createJournalForm\(journalFormTemplate,[\s\S]*?formId: 'journalForm'/);
    assert.match(privateJournalJs, /createJournalForm\(journalFormTemplate,[\s\S]*?formId: 'journalEditForm'/);
    assert.match(privateJournalJs, /createDialog\(\{[\s\S]*?id: 'journalEditDialog'/);
    assert.match(privateJournalJs, /updateJournalEntry\(entryId/);
    assert.match(privateJournalJs, /groupJournalEntriesByDate\(state\.journalEntries\)/);
    assert.doesNotMatch(privateJournalJs, /fillJournalFormForDate|addEventListener\('change', fill/);
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
      for (const source of [privateJournalHtml, privateJournalJs, apiJs, communityCss]) {
        assert.equal(source.includes(hook), false, `retired journal photo hook remains: ${hook}`);
      }
    }
    assert.doesNotMatch(`${billingHtml}\n${membershipHtml}`, /progress photos/i);
    assert.match(communityCss, /\.journal-form-actions[\s\S]*grid-column:\s*1 \/ -1/);
    assert.match(communityCss, /@media \(min-width: 720px\)[\s\S]*\.journal-form[\s\S]*repeat\(2, 1fr\)/);
  });

  test('removes the one-entry-per-date constraint and adds a deterministic timeline index', () => {
    assert.match(multipleEntriesMigration, /drop constraint if exists journal_entries_user_id_entry_date_key/);
    assert.match(multipleEntriesMigration, /journal_entries_user_date_created_id_idx[\s\S]*user_id,[\s\S]*entry_date desc,[\s\S]*created_at desc,[\s\S]*id desc/);
    assert.doesNotMatch(multipleEntriesMigration, /delete\s+from\s+public\.journal_entries/i);
    assert.match(canonicalSchema, /20260813162042_allow_multiple_daily_journal_entries\.sql/);
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
