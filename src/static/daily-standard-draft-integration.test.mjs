import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

describe('Daily Standard draft integration', () => {
  it('uses action-scoped shared client mutations instead of direct snapshot writes', async () => {
    const [api, dashboard] = await Promise.all([
      read('./api.js'),
      read('./dashboard.js'),
    ]);

    assert.match(api, /rpcDraft\('mutate_daily_standard_draft'/);
    assert.match(api, /rpcDraft\('set_daily_standard_workout_difficulty'/);
    assert.doesNotMatch(api, /\.from\('challenge_entries'\)[\s\S]{0,180}\.upsert\(/);
    assert.match(dashboard, /mutateDailyStandardDraft/);
    assert.match(dashboard, /await entrySaveQueue;[\s\S]+getDailyStandardDraft/);
    assert.match(dashboard, /visibilitychange[\s\S]+hydrateDashboardFromApi|hydrateDashboardFromApi[\s\S]+visibilitychange/);
  });

  it('locks and merges drafts in trusted RPCs while revoking direct writes', async () => {
    const [schema, migration] = await Promise.all([
      read('../../supabase/schema.sql'),
      read('../../supabase/migrations/20260719130000_atomic_daily_standard_drafts.sql'),
    ]);

    for (const sql of [schema, migration]) {
      assert.match(sql, /create or replace function public\.mutate_daily_standard_draft/);
      assert.match(sql, /for update/);
      assert.match(sql, /array_append\(completed, target_action_id\)/);
      assert.match(sql, /array_remove\(completed, target_action_id\)/);
      assert.match(sql, /stale_write_reconciled/);
      assert.match(sql, /create or replace function public\.set_daily_standard_workout_difficulty/);
      assert.match(sql, /This Check-In is already submitted/);
      assert.match(sql, /revoke insert, update, delete on public\.challenge_entries from authenticated/);
      assert.match(sql, /a_apply_authoritative_daily_standard_draft/);
    }
  });
});
