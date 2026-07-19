import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

describe('scheduled miss retirement', () => {
  it('removes the planned-miss control and production client state', async () => {
    const [dashboardHtml, dashboardSource, apiSource] = await Promise.all([
      read('../../dashboard.html'),
      read('./dashboard.js'),
      read('./api.js'),
    ]);

    assert.doesNotMatch(dashboardHtml, /scheduledButton|planned ahead|scheduled miss/i);
    assert.doesNotMatch(dashboardSource, /scheduledMiss|planned ahead|status === ['"]scheduled['"]/i);
    assert.doesNotMatch(apiSource, /scheduled_miss:\s*Boolean|scheduledMiss:\s*Boolean/);
    assert.match(apiSource, /\.neq\(['"]status['"], ['"]scheduled['"]\)/);
  });

  it('blocks new scheduled drafts and Check-Ins while preserving finalized history', async () => {
    const [schema, migration] = await Promise.all([
      read('../../supabase/schema.sql'),
      read('../../supabase/migrations/20260719110000_retire_scheduled_misses.sql'),
    ]);

    assert.match(schema, /target_status not in \('complete', 'partial'\)/);
    assert.match(schema, /reject_scheduled_miss_draft/);
    assert.match(schema, /reject_scheduled_check_in/);
    assert.doesNotMatch(schema, /elsif new\.status = 'scheduled' then\s+bonus_points/);
    assert.match(migration, /not exists[\s\S]+finalized\.status = 'scheduled'/);
    assert.match(migration, /revoke insert, update on public\.challenge_entries/);
    assert.match(migration, /block_scheduled_check_in_write/);
    assert.doesNotMatch(migration, /delete from public\.check_ins|update public\.check_ins/);
  });
});
