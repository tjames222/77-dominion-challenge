-- Additive evidence foundation for the original 77-submission completion rule.
-- This migration deliberately does not create a check-in trigger, replay old
-- rows, award a badge, enqueue an outbound event, or activate another track.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table private.original_77_completion_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  challenge_start_date date not null,
  completion_kind text not null default 'original_77_submissions',
  criteria_version integer not null default 1,
  source_check_in_id uuid not null unique
    references public.check_ins(id) on delete cascade,
  recorded_at timestamptz not null default clock_timestamp(),
  constraint original_77_completion_events_start_date_check check (
    pg_catalog.isfinite(challenge_start_date)
    and challenge_start_date between date '0001-01-01' and date '9999-12-31'
  ),
  constraint original_77_completion_events_kind_check check (
    completion_kind = 'original_77_submissions'
  ),
  constraint original_77_completion_events_criteria_check check (
    criteria_version = 1
  ),
  constraint original_77_completion_events_recorded_at_check check (
    pg_catalog.isfinite(recorded_at)
    and recorded_at >= timestamptz '0001-01-01 00:00:00+00'
    and recorded_at < timestamptz '10000-01-01 00:00:00+00'
  ),
  constraint original_77_completion_events_instance_unique unique (
    user_id,
    challenge_start_date,
    completion_kind
  )
);

comment on table private.original_77_completion_events is
  'Private live-event identity for an original challenge crossing exactly 77 canonical submitted check-ins. No historical rows are synthesized.';
comment on column private.original_77_completion_events.source_check_in_id is
  'The explicit newly inserted check-in that crossed the submission threshold. A future reviewed writer must establish live insertion context.';
comment on column private.original_77_completion_events.recorded_at is
  'When the private live completion event was persisted. It is never inferred from historical row order.';

create index original_77_completion_events_user_recorded_idx
  on private.original_77_completion_events (user_id, recorded_at desc, id desc);

alter table private.original_77_completion_events enable row level security;
alter table private.original_77_completion_events force row level security;

create policy original_77_completion_events_owner_read
  on private.original_77_completion_events
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

revoke all on table private.original_77_completion_events
  from public, anon, authenticated, service_role;

create function private.reject_original_77_completion_event_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception using
    errcode = '42501',
    message = 'original_77_completion_event_immutable';
end;
$$;

revoke all on function private.reject_original_77_completion_event_update()
  from public, anon, authenticated, service_role;

create trigger reject_original_77_completion_event_update
  before update on private.original_77_completion_events
  for each row execute function private.reject_original_77_completion_event_update();

create function private.original_77_submission_evidence(
  target_user_id uuid,
  target_challenge_start_date date
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  profile_start_date date;
  profile_review_required boolean;
  total_rows integer := 0;
  canonical_rows integer := 0;
  distinct_ids integer := 0;
  distinct_dates integer := 0;
  distinct_days integer := 0;
  completion_event private.original_77_completion_events%rowtype;
  source_check_in public.check_ins%rowtype;
  invalid_reason text;
  allowed_actions constant text[] := array[
    'bible',
    'morningPrayer',
    'worshipOnly',
    'eveningPrayer',
    'workoutOne',
    'walk',
    'workoutTwo'
  ]::text[];
begin
  if target_user_id is null
     or target_challenge_start_date is null
     or not pg_catalog.isfinite(target_challenge_start_date)
     or target_challenge_start_date not between date '0001-01-01' and date '9999-12-31' then
    invalid_reason := 'invalid_activation';
  else
    select
      profile.challenge_start_date,
      profile.challenge_activation_review_required
    into profile_start_date, profile_review_required
    from public.profiles profile
    where profile.user_id = target_user_id;

    if not found
       or profile_start_date is distinct from target_challenge_start_date
       or profile_start_date is null
       or not pg_catalog.isfinite(profile_start_date) then
      invalid_reason := 'invalid_activation';
    elsif profile_review_required is distinct from false then
      invalid_reason := 'activation_review_required';
    end if;
  end if;

  if invalid_reason is null then
    select
      count(*)::integer,
      count(*) filter (
        where case
          when pg_catalog.isfinite(check_in.entry_date)
            and check_in.entry_date between date '0001-01-01' and date '9999-12-31'
            and check_in.challenge_day > 0
          then check_in.challenge_day =
            check_in.entry_date - target_challenge_start_date + 1
          else false
        end
          and check_in.status in ('complete', 'partial')
          and pg_catalog.cardinality(check_in.completed) between 1 and 7
          and pg_catalog.array_ndims(check_in.completed) = 1
          and pg_catalog.array_lower(check_in.completed, 1) = 1
          and pg_catalog.array_position(check_in.completed, null) is null
          and check_in.completed <@ allowed_actions
          and pg_catalog.cardinality(check_in.completed) = (
            select count(distinct completed_action)::integer
            from pg_catalog.unnest(check_in.completed) completed_action
          )
          and pg_catalog.isfinite(check_in.created_at)
          and check_in.created_at >= timestamptz '0001-01-01 00:00:00+00'
          and check_in.created_at < timestamptz '10000-01-01 00:00:00+00'
      )::integer,
      count(distinct check_in.id)::integer,
      count(distinct check_in.entry_date)::integer,
      count(distinct check_in.challenge_day)::integer
    into total_rows, canonical_rows, distinct_ids, distinct_dates, distinct_days
    from (
      -- The production user/date index leads this bounded actor snapshot. The
      -- 78th row is sufficient to reject overflow without scanning a lifetime.
      select check_in.*
      from public.check_ins check_in
      where check_in.user_id = target_user_id
      order by check_in.entry_date
      limit 78
    ) check_in;

    if total_rows > 77
       or canonical_rows <> total_rows
       or distinct_ids <> total_rows
       or distinct_dates <> total_rows
       or distinct_days <> total_rows then
      invalid_reason := 'invalid_check_in';
    end if;
  end if;

  if invalid_reason is null then
    select completion.* into completion_event
    from private.original_77_completion_events completion
    where completion.user_id = target_user_id
      and completion.challenge_start_date = target_challenge_start_date
      and completion.completion_kind = 'original_77_submissions';

    if completion_event.id is not null then
      select check_in.* into source_check_in
      from public.check_ins check_in
      where check_in.id = completion_event.source_check_in_id;

      if source_check_in.id is null
         or source_check_in.user_id is distinct from target_user_id
         or not (case
           when pg_catalog.isfinite(source_check_in.entry_date)
             and source_check_in.entry_date between date '0001-01-01' and date '9999-12-31'
             and source_check_in.challenge_day > 0
           then source_check_in.challenge_day =
             source_check_in.entry_date - target_challenge_start_date + 1
           else false
         end)
         or source_check_in.status not in ('complete', 'partial')
         or pg_catalog.cardinality(source_check_in.completed) not between 1 and 7
         or pg_catalog.array_ndims(source_check_in.completed) <> 1
         or pg_catalog.array_lower(source_check_in.completed, 1) <> 1
         or pg_catalog.array_position(source_check_in.completed, null) is not null
         or not (source_check_in.completed <@ allowed_actions)
         or pg_catalog.cardinality(source_check_in.completed) <> (
           select count(distinct completed_action)::integer
           from pg_catalog.unnest(source_check_in.completed) completed_action
         )
         or not pg_catalog.isfinite(source_check_in.created_at)
         or source_check_in.created_at < timestamptz '0001-01-01 00:00:00+00'
         or source_check_in.created_at >= timestamptz '10000-01-01 00:00:00+00'
         or total_rows <> 77 then
        invalid_reason := 'invalid_completion_event';
      end if;
    end if;
  end if;

  if invalid_reason is not null then
    return pg_catalog.jsonb_build_object(
      'schemaVersion', 1,
      'context', 'database_snapshot',
      'valid', false,
      'reason', invalid_reason,
      'userId', null,
      'instanceId', null,
      'submittedCount', null,
      'meetsSubmissionRule', false,
      'completionState', 'invalid_evidence',
      'canonicalEvent', null,
      'historicalProvenancePending', false,
      'awardAuthorized', false,
      'replayAuthorized', false
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'schemaVersion', 1,
    'context', 'database_snapshot',
    'valid', true,
    'reason', null,
    'userId', target_user_id,
    'instanceId', 'original77:' ||
      pg_catalog.to_char(target_challenge_start_date, 'YYYY-MM-DD'),
    'submittedCount', total_rows,
    'meetsSubmissionRule', total_rows = 77,
    'completionState', case
      when completion_event.id is not null then 'live_completed'
      when total_rows = 77 then 'historical_provenance_pending'
      else 'in_progress'
    end,
    'canonicalEvent', case
      when completion_event.id is null then null
      else pg_catalog.jsonb_build_object(
        'id', completion_event.id,
        'sourceId', source_check_in.id,
        'localDate', source_check_in.entry_date,
        'recordedAt', source_check_in.created_at,
        'persistedAt', completion_event.recorded_at
      )
    end,
    'historicalProvenancePending',
      total_rows = 77 and completion_event.id is null,
    'awardAuthorized', false,
    'replayAuthorized', false
  );
end;
$$;

comment on function private.original_77_submission_evidence(uuid, date) is
  'Strict read-only assessment of the single original challenge scope. It never creates completion provenance, awards, notifications, or successor state.';

revoke all on function private.original_77_submission_evidence(uuid, date)
  from public, anon, authenticated, service_role;
