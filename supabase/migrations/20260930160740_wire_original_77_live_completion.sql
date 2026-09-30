-- Complete the original challenge on the 77th canonical submitted check-in.
-- Calendar ordinals remain true local-date ordinals and may pass day 77 while
-- the member is still below 77 submissions. This migration never backfills a
-- completion event or award from historical rows.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.check_ins
  drop constraint if exists check_ins_challenge_day_range;
alter table public.check_ins
  add constraint check_ins_challenge_day_range
  check (challenge_day between 1 and 3652059) not valid;
alter table public.check_ins
  validate constraint check_ins_challenge_day_range;

alter table private.original_77_completion_events
  add column source_local_date date not null,
  add column source_recorded_at timestamptz not null,
  add constraint original_77_completion_events_source_local_date_check check (
    pg_catalog.isfinite(source_local_date)
    and source_local_date between date '0001-01-01' and date '9999-12-31'
  ),
  add constraint original_77_completion_events_source_recorded_at_check check (
    pg_catalog.isfinite(source_recorded_at)
    and source_recorded_at >= timestamptz '0001-01-01 00:00:00+00'
    and source_recorded_at < timestamptz '10000-01-01 00:00:00+00'
  );

comment on column private.original_77_completion_events.source_local_date is
  'Immutable copy of the qualifying check-in local date, validated against its source row.';
comment on column private.original_77_completion_events.source_recorded_at is
  'Immutable copy of the qualifying check-in timestamp, distinct from event persistence time.';

create or replace function private.original_77_submission_evidence(
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
    'bible', 'morningPrayer', 'worshipOnly', 'eveningPrayer',
    'workoutOne', 'walk', 'workoutTwo'
  ]::text[];
begin
  if target_user_id is null
     or target_challenge_start_date is null
     or not pg_catalog.isfinite(target_challenge_start_date)
     or target_challenge_start_date not between date '0001-01-01' and date '9999-12-31' then
    invalid_reason := 'invalid_activation';
  else
    select profile.challenge_start_date, profile.challenge_activation_review_required
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
         or completion_event.source_local_date is distinct from source_check_in.entry_date
         or completion_event.source_recorded_at is distinct from source_check_in.created_at
         or total_rows <> 77 then
        invalid_reason := 'invalid_completion_event';
      end if;
    end if;
  end if;

  if invalid_reason is not null then
    return pg_catalog.jsonb_build_object(
      'schemaVersion', 1, 'context', 'database_snapshot', 'valid', false,
      'reason', invalid_reason, 'userId', null, 'instanceId', null,
      'submittedCount', null, 'meetsSubmissionRule', false,
      'completionState', 'invalid_evidence', 'canonicalEvent', null,
      'historicalProvenancePending', false, 'awardAuthorized', false,
      'replayAuthorized', false
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'schemaVersion', 1,
    'context', 'database_snapshot',
    'valid', true,
    'reason', null,
    'userId', target_user_id,
    'instanceId', 'original77:' || pg_catalog.to_char(target_challenge_start_date, 'YYYY-MM-DD'),
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
        'sourceId', completion_event.source_check_in_id,
        'localDate', completion_event.source_local_date,
        'recordedAt', completion_event.source_recorded_at,
        'persistedAt', completion_event.recorded_at
      )
    end,
    'historicalProvenancePending', total_rows = 77 and completion_event.id is null,
    'awardAuthorized', false,
    'replayAuthorized', false
  );
end;
$$;

revoke all on function private.original_77_submission_evidence(uuid, date)
  from public, anon, authenticated, service_role;

create or replace function private.original_77_progress_for_user(
  target_user_id uuid,
  target_challenge_start_date date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  evidence jsonb;
begin
  evidence := private.original_77_submission_evidence(
    target_user_id,
    target_challenge_start_date
  );

  return pg_catalog.jsonb_build_object(
    'schemaVersion', 1,
    'userId', target_user_id,
    'instanceId', case
      when target_challenge_start_date is null then null
      else 'original77:' || pg_catalog.to_char(target_challenge_start_date, 'YYYY-MM-DD')
    end,
    'targetCount', 77,
    'submittedCount', case
      when coalesce((evidence ->> 'valid')::boolean, false)
        then (evidence ->> 'submittedCount')::integer
      else null
    end,
    'completionState', case
      when coalesce((evidence ->> 'valid')::boolean, false)
        then evidence ->> 'completionState'
      else 'invalid_evidence'
    end,
    'canonicalEvent', case
      when coalesce((evidence ->> 'valid')::boolean, false)
        then evidence -> 'canonicalEvent'
      else null
    end
  );
end;
$$;

comment on function private.original_77_progress_for_user(uuid, date) is
  'Private strict wire projection for the authenticated activation payload. It performs no writes or replay.';
revoke all on function private.original_77_progress_for_user(uuid, date)
  from public, anon, authenticated, service_role;

create or replace function public.challenge_activation_allows_date(
  target_user_id uuid,
  target_entry_date date
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  profile_row public.profiles%rowtype;
  progress jsonb;
  ordinal integer;
begin
  if target_user_id is null
     or target_entry_date is null
     or not pg_catalog.isfinite(target_entry_date)
     or target_entry_date not between date '0001-01-01' and date '9999-12-31' then
    return false;
  end if;

  select profile.* into profile_row
  from public.profiles profile
  where profile.user_id = target_user_id;

  if not found
     or profile_row.challenge_activation_status not in ('scheduled', 'active')
     or profile_row.challenge_activation_review_required is distinct from false
     or profile_row.challenge_start_date is null
     or not pg_catalog.isfinite(profile_row.challenge_start_date)
     or public.challenge_activation_user_date(target_user_id) < profile_row.challenge_start_date
     or target_entry_date <> public.daily_standard_user_date(target_user_id) then
    return false;
  end if;

  ordinal := target_entry_date - profile_row.challenge_start_date + 1;
  if ordinal not between 1 and 3652059 then
    return false;
  end if;

  progress := private.original_77_progress_for_user(
    target_user_id,
    profile_row.challenge_start_date
  );
  return progress ->> 'completionState' = 'in_progress'
    and (progress ->> 'submittedCount')::integer between 0 and 76;
end;
$$;

revoke all on function public.challenge_activation_allows_date(uuid, date)
  from public, anon, authenticated, service_role;

create or replace function private.outbound_event_payload_is_safe(
  target_event_type text,
  target_payload jsonb
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = public, private, pg_temp
as $$
declare
  numeric_value numeric;
begin
  if target_payload is null
    or pg_catalog.jsonb_typeof(target_payload) <> 'object'
    or pg_catalog.octet_length(target_payload::text) > 8192 then return false; end if;
  if target_event_type = 'check_in' then
    if not (target_payload ?& array['challengeDay','status','completedCount'])
      or target_payload - array['challengeDay','status','completedCount'] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(target_payload->'challengeDay') <> 'number'
      or pg_catalog.jsonb_typeof(target_payload->'status') <> 'string'
      or pg_catalog.jsonb_typeof(target_payload->'completedCount') <> 'number'
      or target_payload->>'status' not in ('complete','partial') then return false; end if;
    numeric_value := (target_payload->>'challengeDay')::numeric;
    if numeric_value <> pg_catalog.trunc(numeric_value)
       or numeric_value not between 1 and 3652059 then return false; end if;
    numeric_value := (target_payload->>'completedCount')::numeric;
    return numeric_value = pg_catalog.trunc(numeric_value) and numeric_value between 0 and 7;
  elsif target_event_type = 'streak_milestone' then
    if not (target_payload ?& array['streakType','milestone'])
      or target_payload - array['streakType','milestone'] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(target_payload->'streakType') <> 'string'
      or target_payload->>'streakType' not in ('app','full_standard')
      or pg_catalog.jsonb_typeof(target_payload->'milestone') <> 'number' then return false; end if;
    numeric_value := (target_payload->>'milestone')::numeric;
    return numeric_value = pg_catalog.trunc(numeric_value) and numeric_value between 1 and 10000;
  elsif target_event_type = 'badge_reward' then
    return target_payload ?& array['rewardKind','rewardName']
      and target_payload - array['rewardKind','rewardName'] = '{}'::jsonb
      and pg_catalog.jsonb_typeof(target_payload->'rewardKind') = 'string'
      and target_payload->>'rewardKind' in ('badge','challenge')
      and pg_catalog.jsonb_typeof(target_payload->'rewardName') = 'string'
      and pg_catalog.char_length(pg_catalog.btrim(target_payload->>'rewardName')) between 1 and 100;
  elsif target_event_type = 'membership' then
    return target_payload = '{}'::jsonb;
  elsif target_event_type = 'leaderboard_recap' then
    if not (target_payload ?& array['periodLabel','memberCount','checkInCount','completedStandards'])
      or target_payload - array['periodLabel','memberCount','checkInCount','completedStandards'] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(target_payload->'periodLabel') <> 'string'
      or pg_catalog.char_length(pg_catalog.btrim(target_payload->>'periodLabel')) not between 1 and 40
      or pg_catalog.jsonb_typeof(target_payload->'memberCount') <> 'number'
      or pg_catalog.jsonb_typeof(target_payload->'checkInCount') <> 'number'
      or pg_catalog.jsonb_typeof(target_payload->'completedStandards') <> 'number' then return false; end if;
    numeric_value := (target_payload->>'memberCount')::numeric;
    if numeric_value <> pg_catalog.trunc(numeric_value) or numeric_value not between 0 and 100000 then return false; end if;
    numeric_value := (target_payload->>'checkInCount')::numeric;
    if numeric_value <> pg_catalog.trunc(numeric_value) or numeric_value not between 0 and 1000000 then return false; end if;
    numeric_value := (target_payload->>'completedStandards')::numeric;
    return numeric_value = pg_catalog.trunc(numeric_value) and numeric_value between 0 and 7000000;
  elsif target_event_type = 'synthetic.delivery' then
    return target_payload ? 'text'
      and target_payload - 'text' = '{}'::jsonb
      and pg_catalog.jsonb_typeof(target_payload->'text') = 'string'
      and pg_catalog.char_length(pg_catalog.btrim(target_payload->>'text')) between 1 and 2000;
  end if;
  return false;
exception
  when numeric_value_out_of_range or invalid_text_representation then return false;
end;
$$;

revoke all on function private.outbound_event_payload_is_safe(text, jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.challenge_activation_payload_for_user(target_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  profile_row public.profiles%rowtype;
  effective_status text := 'not_started';
  user_date date;
  challenge_day integer;
  group_membership_active boolean := false;
  has_active_membership boolean := false;
  can_edit_start_date boolean := false;
  original_progress jsonb := null;
begin
  select profile.* into profile_row
  from public.profiles profile
  where profile.user_id = target_user_id;

  if not found then
    return pg_catalog.jsonb_build_object(
      'schemaVersion',1,'revision',0,'status','not_started','storedStatus','not_started',
      'mode',null,'startDate',null,'timeZone',null,'crewId',null,
      'groupMembershipActive',false,'activatedAt',null,'confirmedAt',null,
      'activatedBy',null,'confirmedBy',null,'reviewRequired',false,'challengeDay',null,
      'canActivateSolo',true,'canActivateGroup',true,'canParticipate',false,
      'canMutateDailyStandards',false,'canEditStartDate',false,'originalProgress',null
    );
  end if;

  user_date := public.challenge_activation_user_date(target_user_id);
  effective_status := profile_row.challenge_activation_status;
  if effective_status = 'scheduled'
     and profile_row.challenge_start_date is not null
     and user_date >= profile_row.challenge_start_date then
    effective_status := 'active';
  end if;

  if profile_row.challenge_start_date is not null
     and profile_row.challenge_activation_status in ('scheduled','active') then
    original_progress := private.original_77_progress_for_user(
      target_user_id, profile_row.challenge_start_date
    );
  end if;

  if profile_row.challenge_start_date is not null and effective_status = 'active' then
    challenge_day := user_date - profile_row.challenge_start_date + 1;
  end if;

  if profile_row.challenge_participation_mode = 'group'
     and profile_row.challenge_group_attribution_crew_id is not null then
    select exists (
      select 1
      from public.crew_members member_row
      join public.crews crew_row on crew_row.id = member_row.crew_id
      where member_row.user_id = target_user_id
        and member_row.crew_id = profile_row.challenge_group_attribution_crew_id
        and crew_row.deleted_at is null
        and not exists (
          select 1 from private.retired_community_dr_quarantined_crews quarantine
          where quarantine.crew_id = crew_row.id
        )
    ) into group_membership_active;
  end if;

  select (
    exists (
      select 1 from public.entitlements entitlement
      where entitlement.user_id = target_user_id
        and entitlement.entitlement_key = 'membership_active'
        and entitlement.status = 'active'
        and (entitlement.starts_at is null or entitlement.starts_at <= pg_catalog.statement_timestamp())
        and (entitlement.ends_at is null or entitlement.ends_at > pg_catalog.statement_timestamp())
    )
    or private.early_access_active_for_user(target_user_id, pg_catalog.statement_timestamp())
  ) into has_active_membership;

  can_edit_start_date := profile_row.challenge_participation_mode = 'solo'
    and effective_status in ('scheduled','active')
    and original_progress ->> 'completionState' = 'in_progress'
    and (original_progress ->> 'submittedCount')::integer = 0;

  return pg_catalog.jsonb_build_object(
    'schemaVersion',profile_row.challenge_activation_schema_version,
    'revision',profile_row.challenge_activation_revision,
    'status',effective_status,'storedStatus',profile_row.challenge_activation_status,
    'mode',profile_row.challenge_participation_mode,'startDate',profile_row.challenge_start_date,
    'timeZone',profile_row.challenge_activation_time_zone,
    'crewId',profile_row.challenge_group_attribution_crew_id,
    'groupMembershipActive',group_membership_active,
    'activatedAt',profile_row.challenge_activated_at,'confirmedAt',profile_row.challenge_confirmed_at,
    'activatedBy',profile_row.challenge_activated_by,'confirmedBy',profile_row.challenge_confirmed_by,
    'reviewRequired',profile_row.challenge_activation_review_required,'challengeDay',challenge_day,
    'canActivateSolo',effective_status = 'not_started','canActivateGroup',effective_status = 'not_started',
    'canParticipate',effective_status = 'active'
      and original_progress ->> 'completionState' = 'in_progress',
    'canMutateDailyStandards',has_active_membership
      and public.challenge_activation_allows_date(target_user_id,user_date),
    'canEditStartDate',can_edit_start_date,
    'originalProgress',original_progress
  );
end;
$$;

revoke all on function public.challenge_activation_payload_for_user(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.reward_catalog_item_for_user(
  target_user_id uuid,
  target_reward_key text,
  target_current_points integer
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with item as (
    select definition.*,
      case when definition.state_model='ownership'
        then private.reward_eligible_points(target_user_id,definition.reward_key)
        else greatest(coalesce(target_current_points,0),0) end as eligible_points,
      challenge_state.status as challenge_status,
      challenge_state.unlock_points,challenge_state.unlocked_at,challenge_state.started_at,
      challenge_state.completed_at,
      challenge_state.celebration_seen_at as challenge_celebration_seen_at,
      reward_entitlement.owned_at,
      reward_entitlement.celebration_seen_at as ownership_celebration_seen_at,
      (definition.required_entitlement_key is null or exists (
        select 1 from public.entitlements access_entitlement
        where access_entitlement.user_id=target_user_id
          and access_entitlement.entitlement_key=definition.required_entitlement_key
          and access_entitlement.status='active'
          and (access_entitlement.starts_at is null or access_entitlement.starts_at<=pg_catalog.now())
          and (access_entitlement.ends_at is null or access_entitlement.ends_at>pg_catalog.now())
      ) or (coalesce(definition.required_entitlement_key='membership_active',false)
        and private.early_access_active_for_user(target_user_id,pg_catalog.statement_timestamp()))) as can_access,
      case when definition.state_model='challenge_lifecycle'
        then coalesce(challenge_state.status,'locked')
        when reward_entitlement.reward_key is not null then 'owned' else 'locked' end as current_status
    from public.reward_definitions definition
    left join public.user_challenge_states challenge_state
      on challenge_state.user_id=target_user_id and challenge_state.challenge_key=definition.challenge_key
    left join public.user_reward_entitlements reward_entitlement
      on reward_entitlement.user_id=target_user_id and reward_entitlement.reward_key=definition.reward_key
    where definition.reward_key=target_reward_key
  )
  select pg_catalog.jsonb_build_object(
    'key',item.reward_key,'rewardType',item.reward_type,'stateModel',item.state_model,
    'status',item.current_status,'title',item.title,'description',item.description,
    'pointsRequired',item.points_required,'currentPoints',item.eligible_points,
    'pointsRemaining',case when item.current_status<>'locked' then 0
      else greatest(item.points_required-item.eligible_points,0) end,
    'progressPercent',case when item.current_status<>'locked' or item.points_required=0 then 100
      else least(pg_catalog.round(item.eligible_points::numeric/item.points_required::numeric*100,2),100) end,
    'fulfillmentKey',item.fulfillment_key,'requiredEntitlementKey',item.required_entitlement_key,
    'icon',item.icon,'sortOrder',item.sort_order,'active',item.is_active,
    'metadata',item.display_metadata,'canAccess',item.can_access,
    'accessReason',case when not item.can_access then 'entitlement_required'
      when item.current_status='locked' then 'points_required' else null end,
    'allowedActions','[]'::jsonb,
    'unlockPoints',item.unlock_points,'unlockedAt',item.unlocked_at,
    'startedAt',item.started_at,'completedAt',item.completed_at,'ownedAt',item.owned_at,
    'celebrationSeenAt',case when item.state_model='challenge_lifecycle'
      then item.challenge_celebration_seen_at else item.ownership_celebration_seen_at end
  ) from item;
$$;

revoke all on function public.reward_catalog_item_for_user(uuid, text, integer)
  from public, anon, authenticated, service_role;

create or replace function public.start_challenge(target_challenge_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'You need to log in to start a challenge.' using errcode='28000';
  end if;
  raise exception 'This challenge is not ready to start yet.'
    using errcode='55000', detail='challenge_instances_not_available';
end;
$$;

revoke all on function public.start_challenge(text) from public, anon;
grant execute on function public.start_challenge(text) to authenticated;

create or replace function public.start_challenge(
  target_challenge_key text,
  target_expected_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
begin
  if caller_id is null then
    raise exception 'You need to log in to start a challenge.' using errcode='28000';
  end if;
  if target_expected_actor_id is distinct from caller_id then
    raise exception 'The signed-in account changed. Refresh and try again.'
      using errcode='40001', detail='challenge_activation_actor_changed';
  end if;
  raise exception 'This challenge is not ready to start yet.'
    using errcode='55000', detail='challenge_instances_not_available';
end;
$$;

revoke all on function public.start_challenge(text,uuid) from public, anon;
grant execute on function public.start_challenge(text,uuid) to authenticated;

create or replace function public.daily_standard_draft_payload(
  target_user_id uuid,
  target_entry_date date,
  stale_write_reconciled boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  draft public.challenge_entries%rowtype;
  was_submitted boolean;
  activation_payload jsonb;
  activation_allowed boolean;
  lock_reason text;
begin
  if (select auth.uid()) is not null and (select auth.uid()) <> target_user_id then
    raise exception 'Challenge drafts can only be read for the signed-in account.'
      using errcode='42501';
  end if;
  select * into draft from public.challenge_entries entry
  where entry.user_id=target_user_id and entry.entry_date=target_entry_date;
  select exists(select 1 from public.check_ins check_in
    where check_in.user_id=target_user_id and check_in.entry_date=target_entry_date)
    into was_submitted;
  activation_payload:=public.challenge_activation_payload_for_user(target_user_id);
  activation_allowed:=public.challenge_activation_allows_date(target_user_id,target_entry_date);
  lock_reason:=case
    when was_submitted then 'submitted'
    when target_entry_date<>public.daily_standard_user_date(target_user_id) then 'date_locked'
    when activation_payload->>'status'<>'active' then 'challenge_not_active'
    when not activation_allowed then 'challenge_complete'
    else null
  end;
  return jsonb_build_object(
    'entry_date',target_entry_date,
    'completed',coalesce(draft.completed,'{}'::text[]),
    'workout_difficulty',coalesce(draft.workout_difficulty,'{}'::jsonb),
    'version',coalesce(draft.version,0),'updated_at',draft.updated_at,
    'submitted',was_submitted,'locked',lock_reason is not null,
    'lock_reason',lock_reason,'activation_status',activation_payload->>'status',
    'stale_write_reconciled',stale_write_reconciled
  );
end;
$$;

revoke all on function public.daily_standard_draft_payload(uuid,date,boolean)
  from public, anon, authenticated, service_role;

create or replace function public.mutate_daily_standard_draft_pre_activation(
  target_entry_date date,
  target_action_id text,
  target_completed boolean,
  target_expected_version bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor uuid := auth.uid();
  draft public.challenge_entries%rowtype;
  valid_action_ids constant text[] := array[
    'bible','morningPrayer','worshipOnly','eveningPrayer','workoutOne','walk','workoutTwo'
  ]::text[];
  stale_write boolean := false;
  state_changed boolean := false;
begin
  if actor is null then raise exception 'You need to log in to update Daily Standards.'; end if;
  if not public.has_active_entitlement('membership_active') then
    raise exception 'An active membership is required to update Daily Standards.';
  end if;
  if not public.challenge_activation_allows_date(actor,target_entry_date) then
    raise exception 'The original challenge is complete or that Daily Standards date is locked.'
      using errcode='22023';
  end if;
  if target_action_id is null or not(target_action_id=any(valid_action_ids)) then
    raise exception 'Choose a valid Daily Standard.' using errcode='22023';
  end if;
  if target_completed is null then
    raise exception 'Choose whether the action is complete.' using errcode='22023';
  end if;
  if exists(select 1 from public.check_ins check_in
    where check_in.user_id=actor and check_in.entry_date=target_entry_date) then
    raise exception 'This Check-In is already submitted.' using errcode='55000';
  end if;
  insert into public.challenge_entries(user_id,entry_date,completed)
    values(actor,target_entry_date,'{}'::text[]) on conflict(user_id,entry_date) do nothing;
  select * into draft from public.challenge_entries entry
    where entry.user_id=actor and entry.entry_date=target_entry_date for update;
  if not public.challenge_activation_allows_date(actor,target_entry_date) then
    raise exception 'The original challenge is complete or that Daily Standards date is locked.'
      using errcode='22023';
  end if;
  if exists(select 1 from public.check_ins check_in
    where check_in.user_id=actor and check_in.entry_date=target_entry_date) then
    raise exception 'This Check-In is already submitted.' using errcode='55000';
  end if;
  stale_write := target_expected_version is not null and target_expected_version<>draft.version;
  state_changed := (target_action_id=any(draft.completed)) is distinct from target_completed;
  if state_changed then
    update public.challenge_entries set
      completed=case when target_completed then array_append(completed,target_action_id)
        else array_remove(completed,target_action_id) end,
      version=version+1
    where user_id=actor and entry_date=target_entry_date;
  end if;
  return public.daily_standard_draft_payload(actor,target_entry_date,stale_write);
end;
$$;

revoke all on function public.mutate_daily_standard_draft_pre_activation(date,text,boolean,bigint)
  from public, anon, authenticated, service_role;

create or replace function public.set_daily_standard_workout_difficulty_pre_activation(
  target_entry_date date,
  target_workout_id text,
  target_difficulty text,
  target_expected_version bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor uuid := auth.uid();
  draft public.challenge_entries%rowtype;
  stale_write boolean := false;
  current_difficulty text;
begin
  if actor is null then raise exception 'You need to log in to update workout difficulty.'; end if;
  if not public.has_active_entitlement('membership_active') then
    raise exception 'An active membership is required to update workout difficulty.';
  end if;
  if not public.challenge_activation_allows_date(actor,target_entry_date) then
    raise exception 'The original challenge is complete or that Daily Standards date is locked.'
      using errcode='22023';
  end if;
  if target_workout_id is null or target_workout_id not in ('one','two') then
    raise exception 'Choose a valid workout.' using errcode='22023';
  end if;
  if target_difficulty is null or target_difficulty not in ('easy','medium','hard','extreme') then
    raise exception 'Choose a valid workout difficulty.' using errcode='22023';
  end if;
  if exists(select 1 from public.check_ins check_in
    where check_in.user_id=actor and check_in.entry_date=target_entry_date) then
    raise exception 'This Check-In is already submitted.' using errcode='55000';
  end if;
  insert into public.challenge_entries(user_id,entry_date,completed)
    values(actor,target_entry_date,'{}'::text[]) on conflict(user_id,entry_date) do nothing;
  select * into draft from public.challenge_entries entry
    where entry.user_id=actor and entry.entry_date=target_entry_date for update;
  if not public.challenge_activation_allows_date(actor,target_entry_date) then
    raise exception 'The original challenge is complete or that Daily Standards date is locked.'
      using errcode='22023';
  end if;
  if exists(select 1 from public.check_ins check_in
    where check_in.user_id=actor and check_in.entry_date=target_entry_date) then
    raise exception 'This Check-In is already submitted.' using errcode='55000';
  end if;
  stale_write := target_expected_version is not null and target_expected_version<>draft.version;
  current_difficulty := draft.workout_difficulty->>target_workout_id;
  if current_difficulty is distinct from target_difficulty then
    update public.challenge_entries set
      workout_difficulty=jsonb_set(coalesce(workout_difficulty,'{}'::jsonb),
        array[target_workout_id],to_jsonb(target_difficulty),true),
      version=version+1
    where user_id=actor and entry_date=target_entry_date;
  end if;
  return public.daily_standard_draft_payload(actor,target_entry_date,stale_write);
end;
$$;

revoke all on function public.set_daily_standard_workout_difficulty_pre_activation(date,text,text,bigint)
  from public, anon, authenticated, service_role;

create or replace function public.submit_daily_check_in_pre_activation(
  target_status text,
  target_completed text[] default '{}'::text[],
  target_workout_difficulty jsonb default '{}'::jsonb,
  target_time_zone text default 'UTC',
  target_expected_date date default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor uuid := auth.uid();
  requested_time_zone text := coalesce(nullif(btrim(target_time_zone),''),'UTC');
  effective_time_zone text;
  target_entry_date date;
  target_challenge_day integer;
  challenge_start date;
  normalized_completed text[];
  effective_status text;
  draft public.challenge_entries%rowtype;
  inserted_check_in public.check_ins%rowtype;
begin
  if actor is null then raise exception 'You need to log in to post a check-in.'; end if;
  if not public.has_active_entitlement('membership_active') then
    raise exception 'An active membership is required to post a check-in.';
  end if;
  if target_status is null or target_status not in ('complete','partial') then
    raise exception 'Choose a valid check-in status.' using errcode='22023';
  end if;
  if not exists(select 1 from pg_catalog.pg_timezone_names where name=requested_time_zone) then
    raise exception 'Choose a valid time zone.' using errcode='22023';
  end if;

  select profile.challenge_activation_time_zone,profile.challenge_start_date
    into effective_time_zone,challenge_start
  from public.profiles profile
  where profile.user_id=actor
  for update;
  if not found or challenge_start is null then
    raise exception 'Activate the original challenge before posting a check-in.'
      using errcode='55000',detail='challenge_activation_required';
  end if;
  effective_time_zone := coalesce(nullif(effective_time_zone,''),requested_time_zone);
  if not exists(select 1 from pg_catalog.pg_timezone_names where name=effective_time_zone) then
    raise exception 'Choose a valid activation time zone.' using errcode='22023';
  end if;
  target_entry_date := (clock_timestamp() at time zone effective_time_zone)::date;
  if target_expected_date is not null and target_expected_date<>target_entry_date then
    raise exception 'The challenge day changed. Review today''s actions and post again.'
      using errcode='22023';
  end if;
  if not public.challenge_activation_allows_date(actor,target_entry_date) then
    raise exception 'The original challenge is complete or today is outside its active dates.'
      using errcode='22023';
  end if;

  select * into draft from public.challenge_entries entry
  where entry.user_id=actor and entry.entry_date=target_entry_date for update;
  if not found then raise exception 'Complete at least one action before posting.' using errcode='22023'; end if;
  if not public.challenge_activation_allows_date(actor,target_entry_date) then
    raise exception 'The original challenge is complete or today is outside its active dates.'
      using errcode='22023';
  end if;
  normalized_completed := public.normalize_daily_standard_completed(draft.completed);
  if cardinality(normalized_completed)=0 then
    raise exception 'Complete at least one action before posting.' using errcode='22023';
  end if;
  if draft.completed is distinct from normalized_completed then
    update public.challenge_entries set completed=normalized_completed,version=version+1
    where user_id=actor and entry_date=target_entry_date;
  end if;
  effective_status := case when cardinality(normalized_completed)=7 then 'complete' else 'partial' end;
  target_challenge_day := target_entry_date-challenge_start+1;
  if target_challenge_day not between 1 and 3652059 then
    raise exception 'The check-in date is outside the supported original challenge range.' using errcode='22023';
  end if;
  insert into public.check_ins(
    user_id,entry_date,challenge_day,status,completed_count,completed,workout_difficulty
  ) values(
    actor,target_entry_date,target_challenge_day,effective_status,
    cardinality(normalized_completed),normalized_completed,coalesce(draft.workout_difficulty,'{}'::jsonb)
  ) returning * into inserted_check_in;
  return jsonb_build_object(
    'id',inserted_check_in.id,'entry_date',inserted_check_in.entry_date,
    'challenge_day',inserted_check_in.challenge_day,'status',inserted_check_in.status,
    'completed_count',inserted_check_in.completed_count,'points_awarded',inserted_check_in.points_awarded,
    'created_at',inserted_check_in.created_at
  );
end;
$$;

revoke all on function public.submit_daily_check_in_pre_activation(text,text[],jsonb,text,date)
  from public, anon, authenticated, service_role;

create or replace function public.submit_daily_check_in(
  target_status text,
  target_completed text[],
  target_workout_difficulty jsonb,
  target_time_zone text,
  target_expected_date date,
  target_expected_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  authoritative_date date;
  authoritative_time_zone text;
  activation_payload jsonb;
  result_payload jsonb;
begin
  if caller_id is null then raise exception 'You need to log in to post a check-in.' using errcode='28000'; end if;
  if target_expected_actor_id is distinct from caller_id then
    raise exception 'The signed-in account changed. Refresh and try again.'
      using errcode='40001',detail='challenge_activation_actor_changed';
  end if;
  activation_payload := public.get_challenge_activation(caller_id);
  authoritative_date := public.daily_standard_user_date(caller_id);
  if target_expected_date is not null and target_expected_date<>authoritative_date then
    raise exception 'The check-in date changed. Refresh and try again.' using errcode='22023';
  end if;
  if activation_payload->>'status'<>'active' then
    raise exception 'An active challenge is required before posting a check-in.'
      using errcode='55000',detail='challenge_activation_required';
  end if;
  if not public.challenge_activation_allows_date(caller_id,authoritative_date) then
    raise exception 'The original challenge is complete or today is outside its active dates.'
      using errcode='22023';
  end if;
  select profile.challenge_activation_time_zone into authoritative_time_zone
  from public.profiles profile where profile.user_id=caller_id;
  result_payload := public.submit_daily_check_in_pre_activation(
    target_status,target_completed,target_workout_difficulty,
    authoritative_time_zone,authoritative_date
  );
  return result_payload || pg_catalog.jsonb_build_object(
    'activation',public.challenge_activation_payload_for_user(caller_id)
  );
end;
$$;

revoke all on function public.submit_daily_check_in(text,text[],jsonb,text,date,uuid)
  from public, anon, service_role;
grant execute on function public.submit_daily_check_in(text,text[],jsonb,text,date,uuid)
  to authenticated;

update public.badge_definitions set
  name='77-Day Finisher',
  description='Submit 77 check-ins in your original challenge; partial check-ins count.',
  requirement='Submit 77 check-ins in your original challenge; partial check-ins count.',
  category='completion',tier='gold',tier_rank=3,icon='crown',sort_order=900,
  criteria_version=1,source_event='challenge_completion',metric='original_77_completion',
  threshold=1,predicate=null,scope='challenge_instance',visibility='public',
  show_progress=false,celebration='queue',retired=false,blocked=false
where badge_key='original_77_completed'
  and source_event='challenge_completion'
  and metric='original_77_completion'
  and criteria_version=1;

do $$
begin
  if not exists (
    select 1 from public.badge_definitions definition
    where definition.badge_key='original_77_completed'
      and definition.source_event='challenge_completion'
      and definition.metric='original_77_completion'
      and definition.criteria_version=1
      and not definition.retired
      and not definition.blocked
  ) then
    raise exception 'Canonical original_77_completed definition is missing.' using errcode='23514';
  end if;
end;
$$;

create or replace function private.badge_rule_matches(
  rule_metric text,rule_threshold integer,rule_predicate text,facts jsonb
) returns boolean
language sql immutable security invoker set search_path=''
as $$
  select case
    when rule_metric='workout' then facts->'workouts'->>rule_predicate in ('one','two')
    when rule_metric='original_77_completion' then
      rule_threshold=1
      and facts->>'kind'='challenge_completion'
      and facts->>'completionKind'='original_77_submissions'
      and (facts->>'submittedCount')::integer=77
      and (facts->>'targetCount')::integer=77
      and (facts->>'original_77_completion')::integer=1
      and facts->>'completionEventId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and facts->>'sourceCheckInId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and facts->>'instanceId' ~ '^original77:[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    when rule_metric in ('check_in_count','partial_count','perfect_count','instance_check_in_count',
      'perfect_streak','app_streak','verified_share')
      then (facts->>rule_metric)::integer=rule_threshold
    else false end;
$$;

revoke all on function private.badge_rule_matches(text,integer,text,jsonb)
  from public,anon,authenticated,service_role;

create or replace function private.persist_badge_event(
  actor uuid,event_source text,source_id uuid,instance_id text,
  local_date date,occurred_at timestamptz,facts jsonb,reconciled boolean default false
) returns jsonb
language plpgsql security invoker set search_path=''
as $$
declare
  rule public.badge_definitions%rowtype;
  scope_identity text;
  evidence jsonb;
  award_id uuid;
  result jsonb := '[]'::jsonb;
begin
  if actor is null or source_id is null or local_date is null or occurred_at is null then
    raise exception 'Canonical badge event required.' using errcode='22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(actor::text,1499));
  for rule in select * from public.badge_definitions
    where not retired and not blocked and criteria_version=1 and source_event=event_source
    order by sort_order,badge_key
  loop
    if rule.scope='challenge_instance' and coalesce(instance_id,'')='' then continue; end if;
    if not coalesce(private.badge_rule_matches(rule.metric,rule.threshold,rule.predicate,facts),false)
      then continue; end if;
    scope_identity := case when rule.scope='lifetime' then 'lifetime' else instance_id end;
    evidence := case
      when rule.metric='workout' then pg_catalog.jsonb_build_object(
        'schemaVersion',1,'kind','workout','workout',facts->'workouts'->>rule.predicate,
        'difficulty',rule.predicate)
      when rule.metric in ('partial_count','perfect_count') then pg_catalog.jsonb_build_object(
        'schemaVersion',1,'kind','daily_standards','completedCount',facts->'completedCount')
      when rule.metric='original_77_completion' then pg_catalog.jsonb_build_object(
        'schemaVersion',1,'kind','challenge_completion',
        'completionKind',facts->>'completionKind',
        'completionEventId',facts->>'completionEventId',
        'sourceCheckInId',facts->>'sourceCheckInId',
        'submittedCount',(facts->>'submittedCount')::integer,
        'targetCount',(facts->>'targetCount')::integer)
      else pg_catalog.jsonb_build_object(
        'schemaVersion',1,'kind',case rule.metric
          when 'perfect_streak' then 'perfect_streak' when 'app_streak' then 'app_streak'
          when 'verified_share' then 'share' else 'check_in' end,
        'qualifyingValue',facts->rule.metric)
    end;
    insert into public.user_badges(
      user_id,badge_key,scope_key,entry_date,earned_at,metadata,celebration_seen_at
    ) values(
      actor,rule.badge_key,scope_identity,local_date,occurred_at,
      pg_catalog.jsonb_build_object(
        'legacy',false,'reconciled',reconciled,'criteriaVersion',1,
        'sourceType',event_source,'sourceRecordId',source_id,
        'challengeInstanceId',nullif(instance_id,''),
        'qualifyingValue',case when rule.metric='workout' then '1'::jsonb else facts->rule.metric end,
        'earningEvidence',evidence,
        'awardDefinition',pg_catalog.jsonb_build_object(
          'name',rule.name,'description',rule.description,'requirement',rule.requirement,
          'tier',rule.tier,'icon',rule.icon,'category',rule.category,'displayOrder',rule.sort_order))
        || case when rule.metric='original_77_completion'
          then pg_catalog.jsonb_build_object('sourceCheckInId',facts->'sourceCheckInId')
          else '{}'::jsonb end,
      case when reconciled or rule.celebration='none' then occurred_at else null end
    ) on conflict(user_id,badge_key,scope_key) do nothing returning id into award_id;
    if award_id is not null then result:=result||pg_catalog.jsonb_build_array(award_id); end if;
  end loop;
  return result;
end;
$$;

revoke all on function private.persist_badge_event(uuid,text,uuid,text,date,timestamptz,jsonb,boolean)
  from public,anon,authenticated,service_role;

create or replace function public.process_check_in_game_rewards()
returns trigger
language plpgsql security definer set search_path=''
as $$
declare
  points_inserted boolean;
  action_points integer;
  profile_start date;
  evidence jsonb;
  allowed_actions constant text[] := array[
    'bible','morningPrayer','worshipOnly','eveningPrayer','workoutOne','walk','workoutTwo'
  ]::text[];
begin
  if (select auth.uid()) is distinct from new.user_id then
    raise exception 'Check-in actor mismatch.' using errcode='42501';
  end if;
  if new.status='scheduled' then
    raise exception 'Scheduled miss Check-Ins are no longer supported.' using errcode='22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.user_id::text,0));
  select profile.challenge_start_date into profile_start from public.profiles profile
    where profile.user_id=new.user_id
      and profile.challenge_activation_review_required is false;
  if not found or profile_start is null
     or new.challenge_day not between 1 and 3652059
     or new.status not in ('complete','partial')
     or not (case when pg_catalog.isfinite(new.entry_date)
       and new.entry_date between date '0001-01-01' and date '9999-12-31'
       then new.challenge_day=new.entry_date-profile_start+1 else false end)
     or pg_catalog.cardinality(new.completed) not between 1 and 7
     or pg_catalog.array_ndims(new.completed)<>1
     or pg_catalog.array_lower(new.completed,1)<>1
     or pg_catalog.array_position(new.completed,null) is not null
     or not(new.completed<@allowed_actions)
     or pg_catalog.cardinality(new.completed)<>(
       select count(distinct action)::integer from pg_catalog.unnest(new.completed) action)
     or not pg_catalog.isfinite(new.created_at)
     or new.created_at<timestamptz '0001-01-01 00:00:00+00'
     or new.created_at>=timestamptz '10000-01-01 00:00:00+00' then
    raise exception 'Invalid check-in.' using errcode='22023';
  end if;
  evidence:=private.original_77_submission_evidence(new.user_id,profile_start);
  if not coalesce((evidence->>'valid')::boolean,false)
     or evidence->>'completionState'<>'in_progress'
     or (evidence->>'submittedCount')::integer not between 0 and 76 then
    raise exception 'The original challenge is complete or its evidence is invalid.' using errcode='22023';
  end if;
  new.completed_count:=pg_catalog.cardinality(new.completed);
  action_points:=least(greatest(new.completed_count,0),7);
  points_inserted:=public.add_game_points(
    new.user_id,'check_in',action_points,new.entry_date,new.challenge_day,null,
    pg_catalog.jsonb_build_object('status',new.status,'completedCount',new.completed_count,
      'completed',new.completed,'workoutDifficulty',new.workout_difficulty,'actionPoints',action_points),
    'checkin:'||new.user_id::text||':'||new.entry_date::text
  );
  new.points_awarded:=case when points_inserted then action_points else 0 end;
  return new;
end;
$$;

revoke all on function public.process_check_in_game_rewards()
  from public,anon,authenticated,service_role;

create or replace function private.record_live_original_77_completion()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare
  profile_start date;
  evidence jsonb;
  completion private.original_77_completion_events%rowtype;
  completion_facts jsonb;
  award_ids jsonb;
begin
  if (select auth.uid()) is distinct from new.user_id then
    raise exception 'Check-in actor mismatch.' using errcode='42501';
  end if;
  select profile.challenge_start_date into profile_start
  from public.profiles profile
  where profile.user_id=new.user_id
    and profile.challenge_activation_review_required is false;
  if not found or profile_start is null then
    raise exception 'Canonical original challenge is required.' using errcode='22023';
  end if;
  evidence:=private.original_77_submission_evidence(new.user_id,profile_start);
  if not coalesce((evidence->>'valid')::boolean,false) then
    raise exception 'Canonical original challenge evidence is required.' using errcode='22023';
  end if;
  if (evidence->>'submittedCount')::integer<77 then return new; end if;
  if (evidence->>'submittedCount')::integer<>77
     or evidence->>'completionState'<>'historical_provenance_pending'
     or evidence->'canonicalEvent'<>'null'::jsonb then
    raise exception 'Original challenge completion provenance is invalid.' using errcode='22023';
  end if;

  insert into private.original_77_completion_events(
    user_id,challenge_start_date,completion_kind,criteria_version,
    source_check_in_id,source_local_date,source_recorded_at
  ) values(
    new.user_id,profile_start,'original_77_submissions',1,
    new.id,new.entry_date,new.created_at
  ) returning * into completion;

  completion_facts:=pg_catalog.jsonb_build_object(
    'kind','challenge_completion','instanceId','original77:'||profile_start::text,
    'completionKind','original_77_submissions','completionEventId',completion.id,
    'sourceCheckInId',new.id,'submittedCount',77,'targetCount',77,
    'original_77_completion',1
  );
  award_ids:=private.persist_badge_event(
    new.user_id,'challenge_completion',completion.id,
    'original77:'||profile_start::text,new.entry_date,new.created_at,completion_facts,false
  );
  if pg_catalog.jsonb_array_length(award_ids)<>1
     and not exists (
       select 1 from public.user_badges award
       where award.user_id=new.user_id
         and award.badge_key='original_77_completed'
         and award.scope_key='original77:'||profile_start::text
         and award.metadata->>'sourceType'='challenge_completion'
         and award.metadata->>'sourceRecordId'=completion.id::text
     ) then
    raise exception 'The canonical Finisher award was not persisted.' using errcode='23514';
  end if;
  return new;
end;
$$;

revoke all on function private.record_live_original_77_completion()
  from public,anon,authenticated,service_role;

drop trigger if exists a_record_live_original_77_completion on public.check_ins;
create trigger a_record_live_original_77_completion
  after insert on public.check_ins
  for each row execute function private.record_live_original_77_completion();

create or replace function private.check_in_badge_facts(event_id uuid)
returns jsonb
language plpgsql stable security invoker set search_path=''
as $$
declare
  event public.check_ins%rowtype;
  start_date date;
  evidence jsonb;
  actions constant text[]:=array[
    'bible','morningPrayer','worshipOnly','eveningPrayer','workoutOne','walk','workoutTwo'
  ]::text[];
  all_count integer;
  partial_count integer;
  perfect_count integer;
  completed_count integer;
  streak integer:=0;
  check_date date;
  workouts jsonb:='{}'::jsonb;
begin
  select * into event from public.check_ins where id=event_id;
  if event.id is null or event.challenge_day not between 1 and 3652059 then return null; end if;
  select profile.challenge_start_date into start_date from public.profiles profile
  where profile.user_id=event.user_id and profile.challenge_activation_review_required is false;
  if not found or start_date is null
     or event.challenge_day<>event.entry_date-start_date+1 then return null; end if;
  evidence:=private.original_77_submission_evidence(event.user_id,start_date);
  if not coalesce((evidence->>'valid')::boolean,false) then return null; end if;
  select count(distinct action)::integer into completed_count
  from pg_catalog.unnest(event.completed) action where action=any(actions);
  if completed_count<1 or completed_count<>pg_catalog.cardinality(event.completed)
     or event.status not in ('complete','partial') then return null; end if;
  all_count:=(evidence->>'submittedCount')::integer;
  select
    count(*) filter(where pg_catalog.cardinality(c.completed)<7)::integer,
    count(*) filter(where pg_catalog.cardinality(c.completed)=7 and c.completed@>actions)::integer
    into partial_count,perfect_count
  from public.check_ins c
  where c.user_id=event.user_id and c.entry_date<=event.entry_date;
  check_date:=event.entry_date;
  while exists(select 1 from public.check_ins c
    where c.user_id=event.user_id and c.entry_date=check_date
      and c.challenge_day=c.entry_date-start_date+1
      and c.status in ('complete','partial')
      and pg_catalog.cardinality(c.completed)=7 and c.completed@>actions)
  loop streak:=streak+1; check_date:=check_date-1; end loop;
  if 'workoutOne'=any(event.completed)
     and event.workout_difficulty->>'one' in ('easy','medium','hard','extreme') then
    workouts:=workouts||pg_catalog.jsonb_build_object(event.workout_difficulty->>'one','one');
  end if;
  if 'workoutTwo'=any(event.completed)
     and event.workout_difficulty->>'two' in ('easy','medium','hard','extreme')
     and not(workouts?(event.workout_difficulty->>'two')) then
    workouts:=workouts||pg_catalog.jsonb_build_object(event.workout_difficulty->>'two','two');
  end if;
  return pg_catalog.jsonb_build_object(
    'instanceId','original77:'||start_date::text,
    'check_in_count',all_count,'instance_check_in_count',all_count,
    'partial_count',case when completed_count<7 then partial_count else 0 end,
    'perfect_count',case when completed_count=7 then perfect_count else 0 end,
    'perfect_streak',streak,'completedCount',completed_count,'workouts',workouts
  );
end;
$$;

revoke all on function private.check_in_badge_facts(uuid)
  from public,anon,authenticated,service_role;

comment on function private.record_live_original_77_completion() is
  'Records only the actual newly inserted 77th canonical original check-in and its scoped Finisher award. It never replays historical qualification.';
