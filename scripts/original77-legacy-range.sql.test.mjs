import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createOriginal77FullchainFixture } from './fixtures/original77-fullchain-fixture.mjs';

test('invalid retained calendar ordinal rejects the live migration without partial DDL or history', async () => {
  const fixture = await createOriginal77FullchainFixture({ through: 67 });
  const actor = '76000000-0000-4000-8000-000000000001';
  const readMigration = name => readFile(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8');
  try {
    // Only this synthetic local legacy seed bypasses triggers. Keep the original
    // invalid row rather than normalizing data to make the new migration pass.
    fixture.queryAsBootstrap(`begin;
      insert into auth.users(id,email) values('${actor}','range-fixture@example.test');
      set local session_replication_role=replica;
      alter table public.check_ins drop constraint check_ins_challenge_day_range;
      insert into public.check_ins(user_id,entry_date,challenge_day,status,completed_count,
        completed,workout_difficulty,points_awarded,created_at)
      values('${actor}','-infinity',2147483647,'partial',0,'{}','{}',0,'-infinity');
      alter table public.check_ins add constraint check_ins_challenge_day_range
        check(challenge_day between 1 and 77) not valid;
      commit;`);
    const foundation = await readMigration('20260930152825_add_original_77_completion_evidence_foundation');
    const live = await readMigration('20260930160740_wire_original_77_live_completion');
    fixture.query(`begin;${foundation}
      insert into supabase_migrations.schema_migrations(version,name,statements)
      values('20260930152825','add_original_77_completion_evidence_foundation','{}');commit;`);
    assert.throws(() => fixture.query(`begin;${live}
      insert into supabase_migrations.schema_migrations(version,name,statements)
      values('20260930160740','wire_original_77_live_completion','{}');commit;`),
    /check constraint "check_ins_challenge_day_range" of relation "check_ins" is violated by some row/);
    const retained = JSON.parse(fixture.query(`select jsonb_build_object(
      'lastVersion',(select max(version) from supabase_migrations.schema_migrations),
      'count',(select count(*) from supabase_migrations.schema_migrations),
      'source',(select jsonb_build_object('day',challenge_day,'date',entry_date,'created',created_at)
        from public.check_ins where user_id='${actor}'),
      'constraint',(select pg_get_constraintdef(oid) from pg_constraint
        where conrelid='public.check_ins'::regclass and conname='check_ins_challenge_day_range'),
      'sourceColumns',(select count(*) from information_schema.columns
        where table_schema='private' and table_name='original_77_completion_events'
          and column_name in ('source_local_date','source_recorded_at'))
    );`));
    assert.deepEqual(retained, {
      lastVersion: '20260930152825', count: 68,
      source: { day: 2147483647, date: '-infinity', created: '-infinity' },
      constraint: 'CHECK (((challenge_day >= 1) AND (challenge_day <= 77))) NOT VALID',
      sourceColumns: 0,
    });
  } finally { fixture.close(); }
});
