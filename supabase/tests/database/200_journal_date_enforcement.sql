begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(30);

select ok(exists (
  select 1
  from supabase_migrations.schema_migrations
  where version = '20260824204444'
), 'the journal date enforcement migration was replayed');

select trigger_is(
  'public',
  'journal_entries',
  'enforce_journal_entry_date',
  'private',
  'enforce_journal_entry_date',
  'journal writes have database-level future-date enforcement'
);

select ok(
  has_function_privilege('authenticated', 'public.get_journal_date_policy(uuid)', 'execute'),
  'authenticated members can read their journal date policy'
);
select ok(
  not has_function_privilege('anon', 'public.get_journal_date_policy(uuid)', 'execute'),
  'anonymous callers cannot read a journal date policy'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.create_journal_entry(date,integer,text,text,text,text,text,uuid)',
    'execute'
  ),
  'authenticated members can use the journal create RPC'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.create_journal_entry(date,integer,text,text,text,text,text,uuid)',
    'execute'
  ),
  'anonymous callers cannot use the journal create RPC'
);

select ok(
  coalesce((select with_check
            from pg_policies
            where schemaname = 'public'
              and tablename = 'journal_entries'
              and policyname = 'Users can insert own journal entries'), '')
    like '%journal_current_user_date%',
  'the insert RLS policy rejects future local dates'
);
select ok(
  coalesce((select with_check
            from pg_policies
            where schemaname = 'public'
              and tablename = 'journal_entries'
              and policyname = 'Users can update own journal entries'), '')
    like '%journal_current_user_date%',
  'the update RLS policy requires a corrected non-future date'
);

update public.profiles
set
  challenge_activation_time_zone = 'Pacific/Kiritimati',
  time_zone = 'America/Los_Angeles'
where user_id = '10000000-0000-4000-8000-000000000001';

update public.profiles
set
  challenge_activation_time_zone = 'Not/AZone',
  time_zone = 'Not/AZone'
where user_id = '20000000-0000-4000-8000-000000000002';

create temp table journal_test_clock as
select (statement_timestamp() at time zone 'Pacific/Kiritimati')::date as user_date;
grant select on journal_test_clock to authenticated;

create temp table journal_test_results (
  key text primary key,
  payload jsonb not null
);
grant select, insert, update on journal_test_results to authenticated;

-- Simulate rows that predate this migration. The migration never scans,
-- clamps, or deletes them, so members can still read and delete them. Any
-- update must correct the date first.
alter table public.journal_entries disable trigger enforce_journal_entry_date;
insert into public.journal_entries (
  id, user_id, entry_date, challenge_day, note, created_at, updated_at
) values
  (
    'fa620000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    (select user_date + 2 from journal_test_clock),
    45,
    'Legacy future entry to correct',
    statement_timestamp(),
    statement_timestamp()
  ),
  (
    'fa620000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    (select user_date + 3 from journal_test_clock),
    46,
    'Legacy future entry to delete',
    statement_timestamp(),
    statement_timestamp()
  );
alter table public.journal_entries enable trigger enforce_journal_entry_date;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
set local "request.jwt.claims" =
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","email":"alice@example.test"}';

insert into journal_test_results (key, payload)
values (
  'date-policy',
  public.get_journal_date_policy('10000000-0000-4000-8000-000000000001')
);

select is(
  (select payload ->> 'timeZone' from journal_test_results where key = 'date-policy'),
  'Pacific/Kiritimati',
  'the challenge activation timezone is the journal date boundary'
);
select is(
  (select (payload ->> 'today')::date from journal_test_results where key = 'date-policy'),
  (select user_date from journal_test_clock),
  'the journal policy returns today in the member effective timezone'
);
select is(
  (select count(*)::integer
   from public.journal_entries
   where id in (
     'fa620000-0000-4000-8000-000000000001',
     'fa620000-0000-4000-8000-000000000002'
   )),
  2,
  'pre-existing future rows remain readable'
);

select lives_ok(
  $$delete from public.journal_entries
    where id = 'fa620000-0000-4000-8000-000000000002'$$,
  'a pre-existing future row can still be deleted'
);
select is(
  (select count(*)::integer
   from public.journal_entries
   where id = 'fa620000-0000-4000-8000-000000000002'),
  0,
  'deleting one pre-existing future row removes only that row'
);

select throws_ok(
  $$insert into public.journal_entries (id, user_id, entry_date, note)
    values (
      'fa620000-0000-4000-8000-000000000003',
      '10000000-0000-4000-8000-000000000001',
      (select user_date + 1 from journal_test_clock),
      'Future direct insert'
    )$$,
  '22023',
  'Journal entries cannot be dated in the future.',
  'a direct future-dated insert fails without clamping'
);

select lives_ok(
  $$insert into public.journal_entries (id, user_id, entry_date, note)
    values (
      'fa620000-0000-4000-8000-000000000004',
      '10000000-0000-4000-8000-000000000001',
      (select user_date from journal_test_clock),
      'Valid direct insert'
    )$$,
  'a direct insert for the member local date succeeds'
);

select throws_ok(
  $$update public.journal_entries
    set note = 'Content-only edit must fail'
    where id = 'fa620000-0000-4000-8000-000000000001'$$,
  '22023',
  'Journal entries cannot be dated in the future.',
  'an existing future row must be corrected before any edit save'
);
select is(
  (select note from public.journal_entries
   where id = 'fa620000-0000-4000-8000-000000000001'),
  'Legacy future entry to correct',
  'a rejected edit preserves the existing future row content'
);
select lives_ok(
  $$update public.journal_entries
    set
      entry_date = (select user_date from journal_test_clock),
      note = 'Legacy future entry corrected'
    where id = 'fa620000-0000-4000-8000-000000000001'$$,
  'an existing future row can be corrected and edited atomically'
);
select is(
  (select entry_date from public.journal_entries
   where id = 'fa620000-0000-4000-8000-000000000001'),
  (select user_date from journal_test_clock),
  'the corrected row stores the chosen valid date without clamping'
);

select throws_ok(
  $$select public.create_journal_entry(
      (select user_date + 1 from journal_test_clock),
      47,
      'Future RPC entry',
      '',
      '',
      'Focused',
      'High',
      '10000000-0000-4000-8000-000000000001'
    )$$,
  '22023',
  'Journal entries cannot be dated in the future.',
  'the create RPC rejects a future date'
);

select lives_ok(
  $$insert into journal_test_results (key, payload)
    values (
      'created-entry',
      public.create_journal_entry(
        (select user_date from journal_test_clock),
        47,
        'RPC entry',
        'Held the line',
        'Keep going',
        'Focused',
        'High',
        '10000000-0000-4000-8000-000000000001'
      )
    )$$,
  'the create RPC saves a valid local date'
);
select is(
  (select (payload ->> 'entry_date')::date
   from journal_test_results where key = 'created-entry'),
  (select user_date from journal_test_clock),
  'the create RPC returns the persisted journal date'
);

select throws_ok(
  $$select public.update_journal_entry(
      (select (payload ->> 'id')::uuid
       from journal_test_results where key = 'created-entry'),
      (select user_date + 1 from journal_test_clock),
      47,
      'Future RPC edit',
      'Held the line',
      'Keep going',
      'Focused',
      'High',
      '10000000-0000-4000-8000-000000000001'
    )$$,
  '22023',
  'Journal entries cannot be dated in the future.',
  'the update RPC rejects a future date'
);

select lives_ok(
  $$insert into journal_test_results (key, payload)
    values (
      'updated-entry',
      public.update_journal_entry(
        (select (payload ->> 'id')::uuid
         from journal_test_results where key = 'created-entry'),
        (select user_date from journal_test_clock),
        47,
        'RPC entry updated',
        'Held the line',
        'Keep going',
        'Grateful',
        'Medium',
        '10000000-0000-4000-8000-000000000001'
      )
    )$$,
  'the update RPC saves a valid edit'
);
select is(
  (select payload ->> 'note' from journal_test_results where key = 'updated-entry'),
  'RPC entry updated',
  'the update RPC returns the edited content'
);

select throws_ok(
  $$select public.get_journal_date_policy(
      '20000000-0000-4000-8000-000000000002'
    )$$,
  '40001',
  'The signed-in account changed. Try again.',
  'the date policy fails closed if the authenticated actor changes'
);

set local "request.jwt.claim.sub" = '20000000-0000-4000-8000-000000000002';
set local "request.jwt.claims" =
  '{"sub":"20000000-0000-4000-8000-000000000002","role":"authenticated","email":"bob@example.test"}';

select throws_ok(
  $$select public.update_journal_entry(
      (select (payload ->> 'id')::uuid
       from journal_test_results where key = 'created-entry'),
      (statement_timestamp() at time zone 'UTC')::date,
      47,
      'Cross-account edit',
      '',
      '',
      '',
      '',
      '20000000-0000-4000-8000-000000000002'
    )$$,
  '42501',
  'This journal entry is no longer available.',
  'a member cannot update another member journal entry through the RPC'
);

insert into journal_test_results (key, payload)
values (
  'fallback-policy',
  public.get_journal_date_policy('20000000-0000-4000-8000-000000000002')
);
select is(
  (select payload ->> 'timeZone' from journal_test_results where key = 'fallback-policy'),
  'UTC',
  'an unsupported profile timezone fails closed to UTC'
);

reset role;

select throws_ok(
  $$insert into public.journal_entries (id, user_id, entry_date, note)
    values (
      'fa620000-0000-4000-8000-000000000005',
      '20000000-0000-4000-8000-000000000002',
      (statement_timestamp() at time zone 'UTC')::date + 1,
      'Privileged future insert'
    )$$,
  '22023',
  'Journal entries cannot be dated in the future.',
  'the trigger rejects future dates even when RLS is bypassed'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'private.journal_effective_time_zone(uuid)',
    'execute'
  ),
  'authenticated callers cannot execute the private timezone helper'
);

select * from finish();
rollback;
