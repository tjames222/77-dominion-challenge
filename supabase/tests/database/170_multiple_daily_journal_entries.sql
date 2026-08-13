begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(13);

select ok(exists (
  select 1
  from supabase_migrations.schema_migrations
  where version = '20260813162042'
), 'the multiple-daily-journal migration was replayed');

select ok(not exists (
  select 1
  from pg_constraint constraint_row
  where constraint_row.conrelid = 'public.journal_entries'::regclass
    and constraint_row.contype = 'u'
    and pg_get_constraintdef(constraint_row.oid) like '%user_id, entry_date%'
), 'a journal date is no longer unique per member');

select ok(to_regclass('public.journal_entries_user_date_idx') is null,
  'the non-deterministic legacy journal index is absent');

select ok(exists (
  select 1
  from pg_index index_row
  where index_row.indexrelid =
      'public.journal_entries_user_date_created_id_idx'::regclass
    and not index_row.indisunique
), 'the journal timeline index permits multiple entries per date');

select matches(
  pg_get_indexdef('public.journal_entries_user_date_created_id_idx'::regclass),
  'USING btree \(user_id, entry_date DESC, created_at DESC, id DESC\)',
  'the timeline index has deterministic date, creation-time, and id ordering'
);

select ok((select relrowsecurity
  from pg_class where oid = 'public.journal_entries'::regclass),
  'journal entries remain protected by RLS');

select ok(has_table_privilege('authenticated', 'public.journal_entries', 'insert'),
  'authenticated members retain journal creation access');

insert into public.journal_entries (
  id, user_id, entry_date, challenge_day, note, created_at, updated_at
) values (
  'fa610000-0000-4000-8000-000000000003',
  '20000000-0000-4000-8000-000000000002',
  '2026-08-13', 44, 'Bob private entry',
  '2026-08-13 08:00:00+00', '2026-08-13 08:00:00+00'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
set local "request.jwt.claims" =
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","email":"alice@example.test"}';

insert into public.journal_entries (
  id, user_id, entry_date, challenge_day, note, created_at, updated_at
) values
  (
    'fa610000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '2026-08-13', 44, 'Alice morning entry',
    '2026-08-13 07:00:00+00', '2026-08-13 07:00:00+00'
  ),
  (
    'fa610000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    '2026-08-13', 44, 'Alice evening entry',
    '2026-08-13 19:00:00+00', '2026-08-13 19:00:00+00'
  );

select is((select count(*)::integer
  from public.journal_entries where entry_date = '2026-08-13'), 2,
  'a member can create multiple entries for one date');

select is((select array_agg(id order by created_at desc, id desc)
  from public.journal_entries where entry_date = '2026-08-13'),
  array[
    'fa610000-0000-4000-8000-000000000002'::uuid,
    'fa610000-0000-4000-8000-000000000001'::uuid
  ], 'same-date entries have deterministic newest-first ordering');

update public.journal_entries
set note = 'Alice morning entry edited'
where id = 'fa610000-0000-4000-8000-000000000001';

select is((select note from public.journal_entries
  where id = 'fa610000-0000-4000-8000-000000000001'),
  'Alice morning entry edited', 'an owner can update one entry by id');

select is((select note from public.journal_entries
  where id = 'fa610000-0000-4000-8000-000000000002'),
  'Alice evening entry', 'updating one same-date entry leaves its sibling unchanged');

update public.journal_entries
set note = 'Alice tamper attempt'
where id = 'fa610000-0000-4000-8000-000000000003';

select is((select count(*)::integer from public.journal_entries), 2,
  'a member cannot read another member journal entry');

reset role;

select is((select note from public.journal_entries
  where id = 'fa610000-0000-4000-8000-000000000003'),
  'Bob private entry', 'an id-scoped update cannot modify another member entry');

select * from finish();
rollback;
