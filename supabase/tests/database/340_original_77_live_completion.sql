begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(24);

select matches(
  (select pg_get_constraintdef(oid) from pg_constraint
    where conrelid='public.check_ins'::regclass and conname='check_ins_challenge_day_range'),
  '3652059',
  'check-in ordinal supports every finite product date while completion remains submission based'
);
select has_function('private','original_77_submission_evidence',array['uuid','date']);
select has_function('private','original_77_progress_for_user',array['uuid','date']);
select has_function('private','record_live_original_77_completion','{}'::text[]);
select has_function('public','start_challenge',array['text','uuid']);
select has_function('public','submit_daily_check_in_v2',array['text','text[]','jsonb','text','date','uuid','uuid']);
select ok((select attnotnull from pg_attribute
  where attrelid='private.original_77_completion_events'::regclass and attname='source_local_date'),
  'source local date copy is required');
select ok((select attnotnull from pg_attribute
  where attrelid='private.original_77_completion_events'::regclass and attname='source_recorded_at'),
  'source timestamp copy is required');
select trigger_is(
  'public','check_ins','a_record_live_original_77_completion',
  'private','record_live_original_77_completion',
  'live completion is recorded only from the committed check-in insert path'
);
select trigger_is(
  'private','original_77_completion_events','reject_original_77_completion_event_update',
  'private','reject_original_77_completion_event_update',
  'completion provenance is immutable'
);
select ok(not has_table_privilege('authenticated','private.original_77_completion_events','select'),
  'completion provenance is not browser readable');
select ok(not has_table_privilege('authenticated','private.original_77_completion_events','insert'),
  'completion provenance is not browser writable');
select ok(not has_function_privilege('authenticated','private.original_77_submission_evidence(uuid,date)','execute'),
  'raw completion evidence remains private');
select ok(not has_function_privilege('authenticated','private.original_77_progress_for_user(uuid,date)','execute'),
  'wire progress adapter remains private');
select ok(not has_function_privilege('authenticated','private.record_live_original_77_completion()','execute'),
  'live completion writer remains private');
select ok(has_function_privilege('authenticated','public.start_challenge(text,uuid)','execute'),
  'retired actor-checked Start signature remains callable only to fail closed');
select ok(not has_function_privilege('anon','public.start_challenge(text,uuid)','execute'),
  'anonymous Start remains denied');
select ok(has_function_privilege('authenticated','public.submit_daily_check_in_v2(text,text[],jsonb,text,date,uuid,uuid)','execute'),
  'actor-and-instance-checked check-in submission is available');
select ok(not has_function_privilege('service_role','public.submit_daily_check_in_v2(text,text[],jsonb,text,date,uuid,uuid)','execute'),
  'service role cannot impersonate a member check-in');
select is((select blocked from public.badge_definitions where badge_key='original_77_completed'),false,
  'Finisher rule is active');
select is((select source_event from public.badge_definitions where badge_key='original_77_completed'),'challenge_completion',
  'Finisher consumes only typed completion events');
select is((select metric from public.badge_definitions where badge_key='original_77_completed'),'original_77_completion',
  'Finisher uses the original submission-completion metric');
select is((select count(*)::integer from private.original_77_completion_events),0,
  'migration and seed never synthesize historical completion provenance');
select is((select count(*)::integer from public.user_badges where badge_key='original_77_completed'),0,
  'migration and seed never backfill a Finisher award');

select * from finish();
rollback;
