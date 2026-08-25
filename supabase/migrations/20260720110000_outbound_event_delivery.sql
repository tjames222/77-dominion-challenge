-- Canonical, consent-aware outbound events for private-group Slack and Discord
-- destinations. Delivery rows carry only the minimum structured facts needed
-- by the server-side renderer; journal, prayer, post, comment, and free-form
-- content is never accepted by this event layer.

alter table private.integration_destinations
  add column if not exists check_ins_enabled boolean not null default false,
  add column if not exists streak_milestones_enabled boolean not null default false,
  add column if not exists badges_rewards_enabled boolean not null default false,
  add column if not exists membership_enabled boolean not null default false,
  add column if not exists recap_cadence text not null default 'off',
  add column if not exists include_safe_link boolean not null default true;

alter table private.integration_destinations
  drop constraint if exists integration_destinations_recap_cadence_check;
alter table private.integration_destinations
  add constraint integration_destinations_recap_cadence_check
  check (recap_cadence in ('off', 'weekly'));

alter table private.outbound_deliveries
  add column if not exists subject_user_id uuid,
  add column if not exists source_reference text;

alter table private.outbound_deliveries
  drop constraint if exists outbound_deliveries_source_reference_check;
alter table private.outbound_deliveries
  add constraint outbound_deliveries_source_reference_check check (
    source_reference is null
    or char_length(source_reference) between 1 and 240
  );

comment on column private.outbound_deliveries.subject_user_id is
  'Send-time consent subject. Deliberately has no account foreign key so queued rows can be cancelled after account deletion.';
comment on column private.outbound_deliveries.source_reference is
  'Private, non-message source identifier used for auditability and idempotency; never rendered to providers.';

create index if not exists outbound_deliveries_subject_status_idx
  on private.outbound_deliveries (subject_user_id, crew_id, status)
  where subject_user_id is not null and status in ('queued', 'retry', 'processing');

alter table private.integration_delivery_attempts
  drop constraint if exists integration_delivery_attempts_outcome_check;
alter table private.integration_delivery_attempts
  add constraint integration_delivery_attempts_outcome_check check (
    outcome in ('delivered', 'retry', 'dead_letter', 'worker_timeout', 'cancelled')
  );

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
    or jsonb_typeof(target_payload) <> 'object'
    or octet_length(target_payload::text) > 8192 then
    return false;
  end if;

  if target_event_type = 'check_in' then
    if not (target_payload ?& array['challengeDay', 'status', 'completedCount'])
      or target_payload - array['challengeDay', 'status', 'completedCount'] <> '{}'::jsonb
      or jsonb_typeof(target_payload -> 'challengeDay') <> 'number'
      or jsonb_typeof(target_payload -> 'status') <> 'string'
      or jsonb_typeof(target_payload -> 'completedCount') <> 'number'
      or (target_payload ->> 'status') not in ('complete', 'partial') then
      return false;
    end if;
    numeric_value := (target_payload ->> 'challengeDay')::numeric;
    if numeric_value <> trunc(numeric_value) or numeric_value not between 1 and 77 then
      return false;
    end if;
    numeric_value := (target_payload ->> 'completedCount')::numeric;
    return numeric_value = trunc(numeric_value) and numeric_value between 0 and 7;
  end if;

  if target_event_type = 'streak_milestone' then
    if not (target_payload ?& array['streakType', 'milestone'])
      or target_payload - array['streakType', 'milestone'] <> '{}'::jsonb
      or jsonb_typeof(target_payload -> 'streakType') <> 'string'
      or (target_payload ->> 'streakType') not in ('app', 'full_standard')
      or jsonb_typeof(target_payload -> 'milestone') <> 'number' then
      return false;
    end if;
    numeric_value := (target_payload ->> 'milestone')::numeric;
    return numeric_value = trunc(numeric_value) and numeric_value between 1 and 10000;
  end if;

  if target_event_type = 'badge_reward' then
    return target_payload ?& array['rewardKind', 'rewardName']
      and target_payload - array['rewardKind', 'rewardName'] = '{}'::jsonb
      and jsonb_typeof(target_payload -> 'rewardKind') = 'string'
      and (target_payload ->> 'rewardKind') in ('badge', 'challenge')
      and jsonb_typeof(target_payload -> 'rewardName') = 'string'
      and char_length(btrim(target_payload ->> 'rewardName')) between 1 and 100;
  end if;

  if target_event_type = 'membership' then
    return target_payload = '{}'::jsonb;
  end if;

  if target_event_type = 'leaderboard_recap' then
    if not (target_payload ?& array['periodLabel', 'memberCount', 'checkInCount', 'completedStandards'])
      or target_payload - array['periodLabel', 'memberCount', 'checkInCount', 'completedStandards'] <> '{}'::jsonb
      or jsonb_typeof(target_payload -> 'periodLabel') <> 'string'
      or char_length(btrim(target_payload ->> 'periodLabel')) not between 1 and 40
      or jsonb_typeof(target_payload -> 'memberCount') <> 'number'
      or jsonb_typeof(target_payload -> 'checkInCount') <> 'number'
      or jsonb_typeof(target_payload -> 'completedStandards') <> 'number' then
      return false;
    end if;
    numeric_value := (target_payload ->> 'memberCount')::numeric;
    if numeric_value <> trunc(numeric_value) or numeric_value not between 0 and 100000 then
      return false;
    end if;
    numeric_value := (target_payload ->> 'checkInCount')::numeric;
    if numeric_value <> trunc(numeric_value) or numeric_value not between 0 and 1000000 then
      return false;
    end if;
    numeric_value := (target_payload ->> 'completedStandards')::numeric;
    return numeric_value = trunc(numeric_value) and numeric_value between 0 and 7000000;
  end if;

  if target_event_type = 'synthetic.delivery' then
    return target_payload ? 'text'
      and target_payload - 'text' = '{}'::jsonb
      and jsonb_typeof(target_payload -> 'text') = 'string'
      and char_length(btrim(target_payload ->> 'text')) between 1 and 2000;
  end if;

  return false;
exception
  when numeric_value_out_of_range or invalid_text_representation then
    return false;
end;
$$;

create or replace function private.enqueue_crew_outbound_event(
  target_user_id uuid,
  target_event_type text,
  target_source_reference text,
  target_payload jsonb,
  target_only_crew_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  destination record;
  delivery_id uuid;
  queued_count integer := 0;
  delivery_key text;
begin
  if target_user_id is null
    or target_source_reference is null
    or char_length(target_source_reference) not between 1 and 240
    or target_event_type not in ('check_in', 'streak_milestone', 'badge_reward', 'membership')
    or not private.outbound_event_payload_is_safe(target_event_type, target_payload) then
    raise exception 'Invalid canonical outbound event.' using errcode = '22023';
  end if;

  delivery_key := 'canonical:' || target_event_type || ':'
    || encode(extensions.digest(target_event_type || ':' || target_source_reference, 'sha256'), 'hex');

  for destination in
    select provider_destination.id, provider_destination.crew_id
    from public.crew_members crew_member
    join public.outbound_update_preferences preference
      on preference.crew_id = crew_member.crew_id
      and preference.user_id = crew_member.user_id
    join private.integration_destinations provider_destination
      on provider_destination.crew_id = crew_member.crew_id
    where crew_member.user_id = target_user_id
      and (target_only_crew_id is null or crew_member.crew_id = target_only_crew_id)
      and preference.outbound_updates_enabled
      and provider_destination.status = 'active'
      and case target_event_type
        when 'check_in' then preference.share_check_ins and provider_destination.check_ins_enabled
        when 'streak_milestone' then preference.share_streak_milestones and provider_destination.streak_milestones_enabled
        when 'badge_reward' then preference.share_badges_rewards and provider_destination.badges_rewards_enabled
        when 'membership' then preference.share_membership_events and provider_destination.membership_enabled
        else false
      end
    order by provider_destination.id
    for key share of provider_destination
  loop
    delivery_id := null;
    insert into private.outbound_deliveries (
      crew_id,
      destination_id,
      subject_user_id,
      source_reference,
      event_type,
      idempotency_key,
      payload,
      max_attempts,
      available_at
    ) values (
      destination.crew_id,
      destination.id,
      target_user_id,
      target_source_reference,
      target_event_type,
      delivery_key,
      target_payload,
      5,
      now()
    )
    on conflict (destination_id, idempotency_key) do nothing
    returning id into delivery_id;

    if delivery_id is null then
      perform 1
      from private.outbound_deliveries existing
      where existing.destination_id = destination.id
        and existing.idempotency_key = delivery_key
        and existing.crew_id = destination.crew_id
        and existing.subject_user_id = target_user_id
        and existing.source_reference = target_source_reference
        and existing.event_type = target_event_type
        and existing.payload = target_payload;
    end if;

    if delivery_id is null and not found then
      raise exception 'Canonical event identity conflicted with an existing delivery.' using errcode = '23505';
    end if;

    queued_count := queued_count + 1;
  end loop;

  return queued_count;
end;
$$;

revoke all on function private.outbound_event_payload_is_safe(text, jsonb) from public, anon, authenticated;
revoke all on function private.enqueue_crew_outbound_event(uuid, text, text, jsonb, uuid) from public, anon, authenticated, service_role;

create or replace function private.emit_check_in_outbound_event()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  if new.status in ('complete', 'partial')
    and new.completed_count between 0 and 7 then
    perform private.enqueue_crew_outbound_event(
      new.user_id,
      'check_in',
      'check-in:' || new.id::text,
      jsonb_build_object(
        'challengeDay', new.challenge_day,
        'status', new.status,
        'completedCount', new.completed_count
      )
    );
  end if;
  return new;
end;
$$;

drop trigger if exists emit_check_in_outbound_event on public.check_ins;
create trigger emit_check_in_outbound_event
  after insert on public.check_ins
  for each row execute function private.emit_check_in_outbound_event();

create or replace function private.emit_badge_outbound_event()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  reward_name text;
begin
  select definition.name into reward_name
  from public.badge_definitions definition
  where definition.badge_key = new.badge_key;

  if reward_name is not null and char_length(btrim(reward_name)) between 1 and 100 then
    perform private.enqueue_crew_outbound_event(
      new.user_id,
      'badge_reward',
      'badge:' || new.user_id::text || ':' || new.badge_key,
      jsonb_build_object('rewardKind', 'badge', 'rewardName', reward_name)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists emit_badge_outbound_event on public.user_badges;
create trigger emit_badge_outbound_event
  after insert on public.user_badges
  for each row execute function private.emit_badge_outbound_event();

create or replace function private.emit_challenge_reward_outbound_event()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  reward_name text;
begin
  select definition.title into reward_name
  from public.challenge_definitions definition
  where definition.challenge_key = new.challenge_key;

  if reward_name is not null and char_length(btrim(reward_name)) between 1 and 100 then
    perform private.enqueue_crew_outbound_event(
      new.user_id,
      'badge_reward',
      'challenge:' || new.user_id::text || ':' || new.challenge_key,
      jsonb_build_object('rewardKind', 'challenge', 'rewardName', reward_name)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists emit_challenge_reward_outbound_event on public.user_challenge_states;
create trigger emit_challenge_reward_outbound_event
  after insert on public.user_challenge_states
  for each row execute function private.emit_challenge_reward_outbound_event();

create or replace function private.emit_streak_milestone_outbound_event()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  milestone integer;
  supported_milestones integer[] := array[3, 7, 14, 21, 28, 35, 42, 49, 56, 63, 70, 77];
begin
  foreach milestone in array supported_milestones
  loop
    if old.current_app_streak < milestone and new.current_app_streak >= milestone then
      perform private.enqueue_crew_outbound_event(
        new.user_id,
        'streak_milestone',
        'streak:' || new.user_id::text || ':app:' || milestone::text,
        jsonb_build_object('streakType', 'app', 'milestone', milestone)
      );
    end if;

    if old.current_full_day_streak < milestone and new.current_full_day_streak >= milestone then
      perform private.enqueue_crew_outbound_event(
        new.user_id,
        'streak_milestone',
        'streak:' || new.user_id::text || ':full-standard:' || milestone::text,
        jsonb_build_object('streakType', 'full_standard', 'milestone', milestone)
      );
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists emit_streak_milestone_outbound_event on public.user_game_stats;
create trigger emit_streak_milestone_outbound_event
  after update of current_app_streak, current_full_day_streak on public.user_game_stats
  for each row execute function private.emit_streak_milestone_outbound_event();

create or replace function private.apply_outbound_preference_to_deliveries()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  preference_crew_id uuid := case when tg_op = 'DELETE' then old.crew_id else new.crew_id end;
  preference_user_id uuid := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
  updates_enabled boolean := case when tg_op = 'DELETE' then false else new.outbound_updates_enabled end;
  check_ins_allowed boolean := case when tg_op = 'DELETE' then false else new.share_check_ins end;
  streaks_allowed boolean := case when tg_op = 'DELETE' then false else new.share_streak_milestones end;
  rewards_allowed boolean := case when tg_op = 'DELETE' then false else new.share_badges_rewards end;
  membership_allowed boolean := case when tg_op = 'DELETE' then false else new.share_membership_events end;
  membership_was_allowed boolean := case
    when tg_op = 'INSERT' then false
    when tg_op = 'DELETE' then old.outbound_updates_enabled and old.share_membership_events
    else old.outbound_updates_enabled and old.share_membership_events
  end;
  joined_at timestamptz;
begin
  update private.outbound_deliveries delivery
  set status = 'cancelled',
      cancelled_at = now(),
      last_error_code = case when tg_op = 'DELETE' then 'membership_or_consent_changed' else 'consent_changed' end,
      last_error_summary = 'The member no longer approves this outbound update.',
      lock_token = null,
      locked_at = null
  where delivery.crew_id = preference_crew_id
    and delivery.subject_user_id = preference_user_id
    and delivery.status in ('queued', 'retry')
    and (
      not updates_enabled
      or (delivery.event_type = 'check_in' and not check_ins_allowed)
      or (delivery.event_type = 'streak_milestone' and not streaks_allowed)
      or (delivery.event_type = 'badge_reward' and not rewards_allowed)
      or (delivery.event_type = 'membership' and not membership_allowed)
    );

  if tg_op <> 'DELETE'
    and updates_enabled
    and membership_allowed
    and not membership_was_allowed then
    select crew_member.joined_at into joined_at
    from public.crew_members crew_member
    where crew_member.crew_id = preference_crew_id
      and crew_member.user_id = preference_user_id;

    if joined_at is not null then
      if joined_at >= now() - interval '7 days' then
        perform private.enqueue_crew_outbound_event(
          preference_user_id,
          'membership',
          'membership:' || preference_crew_id::text || ':' || preference_user_id::text
            || ':' || to_char(joined_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS'),
          '{}'::jsonb,
          preference_crew_id
        );
      end if;
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists apply_outbound_preference_to_deliveries
  on public.outbound_update_preferences;
create trigger apply_outbound_preference_to_deliveries
  after insert or update or delete on public.outbound_update_preferences
  for each row execute function private.apply_outbound_preference_to_deliveries();

revoke all on function private.emit_check_in_outbound_event() from public, anon, authenticated, service_role;
revoke all on function private.emit_badge_outbound_event() from public, anon, authenticated, service_role;
revoke all on function private.emit_challenge_reward_outbound_event() from public, anon, authenticated, service_role;
revoke all on function private.emit_streak_milestone_outbound_event() from public, anon, authenticated, service_role;
revoke all on function private.apply_outbound_preference_to_deliveries() from public, anon, authenticated, service_role;

create or replace function public.queue_due_leaderboard_recaps()
returns integer
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  destination record;
  period_start date := (date_trunc('week', now() at time zone 'UTC')::date - 7);
  recap_payload jsonb;
  queued_id uuid;
  queued_count integer := 0;
begin
  for destination in
    select provider_destination.id, provider_destination.crew_id
    from private.integration_destinations provider_destination
    where provider_destination.status = 'active'
      and provider_destination.recap_cadence = 'weekly'
    order by provider_destination.id
  loop
    select jsonb_build_object(
      'periodLabel', 'Week of ' || to_char(period_start, 'YYYY-MM-DD'),
      'memberCount', (
        select count(*)::integer
        from public.crew_members crew_member
        where crew_member.crew_id = destination.crew_id
      ),
      'checkInCount', (
        select count(*)::integer
        from public.check_ins check_in
        join public.crew_members crew_member
          on crew_member.user_id = check_in.user_id
          and crew_member.crew_id = destination.crew_id
        where check_in.entry_date >= period_start
          and check_in.entry_date < period_start + 7
      ),
      'completedStandards', (
        select coalesce(sum(check_in.completed_count), 0)::integer
        from public.check_ins check_in
        join public.crew_members crew_member
          on crew_member.user_id = check_in.user_id
          and crew_member.crew_id = destination.crew_id
        where check_in.entry_date >= period_start
          and check_in.entry_date < period_start + 7
      )
    ) into recap_payload;

    if not private.outbound_event_payload_is_safe('leaderboard_recap', recap_payload) then
      raise exception 'Generated leaderboard recap was invalid.' using errcode = '22023';
    end if;

    insert into private.outbound_deliveries (
      crew_id,
      destination_id,
      subject_user_id,
      source_reference,
      event_type,
      idempotency_key,
      payload,
      max_attempts,
      available_at
    ) values (
      destination.crew_id,
      destination.id,
      null,
      'leaderboard:' || destination.crew_id::text || ':' || period_start::text,
      'leaderboard_recap',
      'leaderboard:' || period_start::text,
      recap_payload,
      5,
      now()
    )
    on conflict (destination_id, idempotency_key) do nothing
    returning id into queued_id;

    if queued_id is not null then
      queued_count := queued_count + 1;
    end if;
    queued_id := null;
  end loop;

  return queued_count;
end;
$$;

drop function public.claim_outbound_deliveries(uuid, integer);
create function public.claim_outbound_deliveries(
  worker_token uuid,
  batch_size integer default 20
)
returns table (
  delivery_id uuid,
  crew_id uuid,
  destination_id uuid,
  subject_user_id uuid,
  source_reference text,
  provider text,
  provider_workspace_id text,
  provider_destination_id text,
  event_type text,
  payload jsonb,
  attempt_number integer,
  max_attempts integer,
  credential_ciphertext bytea,
  credential_nonce bytea,
  credential_key_version integer
)
language sql
security definer
set search_path = public, private, pg_temp
as $$
  with candidates as (
    select queued.id
    from private.outbound_deliveries queued
    join private.integration_destinations destination
      on destination.id = queued.destination_id
    where queued.status in ('queued', 'retry')
      and queued.available_at <= now()
      and destination.status = 'active'
    order by queued.priority asc, queued.available_at asc, queued.created_at asc
    for update of queued skip locked
    limit least(greatest(coalesce(batch_size, 20), 1), 100)
  ), claimed as (
    update private.outbound_deliveries queued
    set status = 'processing',
        attempt_count = queued.attempt_count + 1,
        lock_token = worker_token,
        locked_at = now(),
        last_error_code = null,
        last_error_summary = null
    from candidates
    where queued.id = candidates.id
      and worker_token is not null
    returning queued.*
  )
  select
    claimed.id,
    claimed.crew_id,
    destination.id,
    claimed.subject_user_id,
    claimed.source_reference,
    destination.provider,
    destination.provider_workspace_id,
    destination.provider_destination_id,
    claimed.event_type,
    claimed.payload,
    claimed.attempt_count::integer,
    claimed.max_attempts::integer,
    destination.credential_ciphertext,
    destination.credential_nonce,
    destination.credential_key_version::integer
  from claimed
  join private.integration_destinations destination
    on destination.id = claimed.destination_id
  order by claimed.priority asc, claimed.available_at asc, claimed.created_at asc;
$$;

revoke all on function public.queue_due_leaderboard_recaps() from public, anon, authenticated;
revoke all on function public.claim_outbound_deliveries(uuid, integer) from public, anon, authenticated;
grant execute on function public.queue_due_leaderboard_recaps() to service_role;
grant execute on function public.claim_outbound_deliveries(uuid, integer) to service_role;

create or replace function public.resolve_claimed_outbound_delivery(
  target_delivery_id uuid,
  worker_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  delivery private.outbound_deliveries%rowtype;
  destination private.integration_destinations%rowtype;
  consent jsonb;
  delivery_eligible boolean := false;
  decision_reason text := 'unsupported_event';
  presentation_mode text := 'anonymous';
  subject_name text := null;
  crew_name text := null;
  event_enabled boolean := false;
begin
  select delivery_row.* into delivery
  from private.outbound_deliveries delivery_row
  where delivery_row.id = target_delivery_id
    and delivery_row.status = 'processing'
    and delivery_row.lock_token = worker_token;

  if not found then
    raise exception 'The delivery is not owned by this worker.' using errcode = '55000';
  end if;

  select destination_row.* into destination
  from private.integration_destinations destination_row
  where destination_row.id = delivery.destination_id;

  select left(nullif(btrim(group_row.name), ''), 120) into crew_name
  from public.crews group_row
  where group_row.id = delivery.crew_id;

  if destination.id is null or destination.status <> 'active' then
    decision_reason := 'destination_inactive';
  elsif destination.credential_ciphertext is null
    or destination.credential_nonce is null
    or destination.credential_key_version is null then
    decision_reason := 'destination_credentials_missing';
  elsif not private.outbound_event_payload_is_safe(delivery.event_type, delivery.payload) then
    decision_reason := case
      when delivery.event_type in (
        'check_in',
        'streak_milestone',
        'badge_reward',
        'membership',
        'leaderboard_recap',
        'synthetic.delivery'
      ) then 'invalid_payload'
      else 'unsupported_event'
    end;
  elsif delivery.event_type = 'synthetic.delivery' then
    delivery_eligible := true;
    decision_reason := 'approved';
  elsif delivery.event_type = 'leaderboard_recap' then
    if destination.recap_cadence <> 'weekly' then
      decision_reason := 'event_disabled';
    elsif delivery.subject_user_id is not null then
      decision_reason := 'subject_not_allowed';
    else
      delivery_eligible := true;
      decision_reason := 'approved';
    end if;
  elsif delivery.event_type in ('check_in', 'streak_milestone', 'badge_reward', 'membership') then
    event_enabled := case delivery.event_type
      when 'check_in' then destination.check_ins_enabled
      when 'streak_milestone' then destination.streak_milestones_enabled
      when 'badge_reward' then destination.badges_rewards_enabled
      when 'membership' then destination.membership_enabled
      else false
    end;

    if not event_enabled then
      decision_reason := 'event_disabled';
    elsif delivery.subject_user_id is null then
      decision_reason := 'subject_missing';
    elsif delivery.source_reference is null then
      decision_reason := 'source_reference_missing';
    else
      consent := public.get_current_outbound_consent(
        delivery.subject_user_id,
        delivery.crew_id,
        delivery.event_type
      );
      delivery_eligible := coalesce((consent ->> 'eligible')::boolean, false);
      decision_reason := coalesce(consent ->> 'reason', 'consent_unavailable');
      presentation_mode := case
        when consent ->> 'presentationMode' = 'named' then 'named'
        else 'anonymous'
      end;

      if delivery_eligible and presentation_mode = 'named' then
        select left(coalesce(
          nullif(btrim(profile.name), ''),
          nullif(btrim(crew_member.display_name), '')
        ), 120) into subject_name
        from public.crew_members crew_member
        left join public.profiles profile on profile.user_id = crew_member.user_id
        where crew_member.crew_id = delivery.crew_id
          and crew_member.user_id = delivery.subject_user_id;
      end if;
    end if;
  end if;

  if not delivery_eligible then
    presentation_mode := 'anonymous';
    subject_name := null;
  end if;

  return jsonb_build_object(
    'eligible', delivery_eligible,
    'reason', decision_reason,
    'presentationMode', presentation_mode,
    'subjectName', subject_name,
    'crewName', crew_name,
    'includeSafeLink', case
      when delivery.event_type = 'synthetic.delivery' then false
      else coalesce(destination.include_safe_link, false)
    end
  );
end;
$$;

create or replace function public.cancel_claimed_outbound_delivery(
  target_delivery_id uuid,
  worker_token uuid,
  target_reason text
)
returns text
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  delivery private.outbound_deliveries%rowtype;
begin
  if target_reason is null or target_reason !~ '^[a-z][a-z0-9_]{0,63}$' then
    raise exception 'Invalid delivery cancellation reason.' using errcode = '22023';
  end if;

  select * into delivery
  from private.outbound_deliveries
  where id = target_delivery_id
  for update;

  if not found or delivery.status <> 'processing' or delivery.lock_token <> worker_token then
    raise exception 'The delivery is not owned by this worker.' using errcode = '55000';
  end if;

  insert into private.integration_delivery_attempts (
    delivery_id,
    attempt_number,
    outcome,
    error_code,
    error_summary,
    started_at
  ) values (
    delivery.id,
    delivery.attempt_count,
    'cancelled',
    target_reason,
    'Current outbound delivery approval was not available.',
    coalesce(delivery.locked_at, now())
  )
  on conflict (delivery_id, attempt_number) do nothing;

  update private.outbound_deliveries
  set status = 'cancelled',
      cancelled_at = now(),
      last_error_code = target_reason,
      last_error_summary = 'Current outbound delivery approval was not available.',
      lock_token = null,
      locked_at = null
  where id = delivery.id;

  return 'cancelled';
end;
$$;

revoke all on function public.resolve_claimed_outbound_delivery(uuid, uuid) from public, anon, authenticated;
revoke all on function public.cancel_claimed_outbound_delivery(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.resolve_claimed_outbound_delivery(uuid, uuid) to service_role;
grant execute on function public.cancel_claimed_outbound_delivery(uuid, uuid, text) to service_role;

alter table private.integration_connection_audit
  drop constraint if exists integration_connection_audit_action_check;
alter table private.integration_connection_audit
  add constraint integration_connection_audit_action_check check (
    action in (
      'authorization_started',
      'authorization_completed',
      'connected',
      'reconnected',
      'test_succeeded',
      'needs_attention',
      'settings_updated',
      'disconnected'
    )
  );

create or replace function public.update_integration_destination_settings(
  target_destination_id uuid,
  target_actor_id uuid,
  target_check_ins_enabled boolean,
  target_streak_milestones_enabled boolean,
  target_badges_rewards_enabled boolean,
  target_membership_enabled boolean,
  target_recap_cadence text,
  target_include_safe_link boolean
)
returns boolean
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  destination private.integration_destinations%rowtype;
  normalized_recap_cadence text := lower(btrim(coalesce(target_recap_cadence, 'off')));
begin
  if normalized_recap_cadence not in ('off', 'weekly') then
    raise exception 'Leaderboard recap cadence must be off or weekly.' using errcode = '22023';
  end if;

  select destination_row.* into destination
  from private.integration_destinations destination_row
  join public.crew_members crew_member on crew_member.crew_id = destination_row.crew_id
  where destination_row.id = target_destination_id
    and crew_member.user_id = target_actor_id
    and crew_member.role in ('owner', 'admin')
  for update of destination_row;

  if not found then
    raise exception 'Only a group owner or admin can manage integrations.' using errcode = '42501';
  end if;

  update private.integration_destinations
  set check_ins_enabled = coalesce(target_check_ins_enabled, false),
      streak_milestones_enabled = coalesce(target_streak_milestones_enabled, false),
      badges_rewards_enabled = coalesce(target_badges_rewards_enabled, false),
      membership_enabled = coalesce(target_membership_enabled, false),
      recap_cadence = normalized_recap_cadence,
      include_safe_link = coalesce(target_include_safe_link, false)
  where id = destination.id;

  update private.outbound_deliveries delivery
  set status = 'cancelled',
      cancelled_at = now(),
      last_error_code = 'destination_settings_changed',
      last_error_summary = 'This outbound event type is no longer enabled for the destination.',
      lock_token = null,
      locked_at = null
  where delivery.destination_id = destination.id
    and delivery.status in ('queued', 'retry')
    and (
      (delivery.event_type = 'check_in' and not coalesce(target_check_ins_enabled, false))
      or (delivery.event_type = 'streak_milestone' and not coalesce(target_streak_milestones_enabled, false))
      or (delivery.event_type = 'badge_reward' and not coalesce(target_badges_rewards_enabled, false))
      or (delivery.event_type = 'membership' and not coalesce(target_membership_enabled, false))
      or (delivery.event_type = 'leaderboard_recap' and normalized_recap_cadence = 'off')
    );

  perform private.record_integration_connection_audit(
    destination.crew_id,
    destination.id,
    target_actor_id,
    destination.provider,
    'settings_updated',
    'succeeded',
    jsonb_build_object(
      'checkInsEnabled', coalesce(target_check_ins_enabled, false),
      'streakMilestonesEnabled', coalesce(target_streak_milestones_enabled, false),
      'badgesRewardsEnabled', coalesce(target_badges_rewards_enabled, false),
      'membershipEnabled', coalesce(target_membership_enabled, false),
      'recapCadence', normalized_recap_cadence,
      'includeSafeLink', coalesce(target_include_safe_link, false)
    )
  );

  return true;
end;
$$;

drop function public.list_crew_integration_destinations(uuid);
create function public.list_crew_integration_destinations(
  target_crew_id uuid
)
returns table (
  destination_id uuid,
  provider text,
  workspace_id text,
  workspace_name text,
  channel_id text,
  channel_name text,
  status text,
  last_verified_at timestamptz,
  last_tested_at timestamptz,
  last_delivered_at timestamptz,
  health_code text,
  last_error_code text,
  corrective_action text,
  check_ins_enabled boolean,
  streak_milestones_enabled boolean,
  badges_rewards_enabled boolean,
  membership_enabled boolean,
  recap_cadence text,
  include_safe_link boolean,
  can_manage boolean
)
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $$
begin
  if not public.is_crew_member(target_crew_id) then
    raise exception 'This private group is not available.' using errcode = '42501';
  end if;

  return query
    select
      destination.id,
      destination.provider,
      destination.provider_workspace_id,
      destination.provider_workspace_name,
      destination.provider_destination_id,
      destination.display_name,
      destination.status,
      destination.last_verified_at,
      destination.last_tested_at,
      destination.last_delivered_at,
      destination.last_error_code,
      destination.last_error_code,
      case
        when destination.status = 'active' and destination.last_error_code is not null
          then 'Wait for the provider and retry the test.'
        when destination.status = 'reconnect_required'
          then 'Reconnect and verify the selected channel.'
        when destination.status = 'disconnected'
          then 'Connect this provider again.'
        when destination.status = 'revoked'
          then 'Reconnect this provider before enabling updates.'
        else null
      end,
      destination.check_ins_enabled,
      destination.streak_milestones_enabled,
      destination.badges_rewards_enabled,
      destination.membership_enabled,
      destination.recap_cadence,
      destination.include_safe_link,
      public.can_manage_crew(target_crew_id)
    from private.integration_destinations destination
    where destination.crew_id = target_crew_id
    order by destination.provider;
end;
$$;

revoke all on function public.update_integration_destination_settings(uuid, uuid, boolean, boolean, boolean, boolean, text, boolean)
  from public, anon, authenticated;
revoke all on function public.list_crew_integration_destinations(uuid) from public, anon;
grant execute on function public.update_integration_destination_settings(uuid, uuid, boolean, boolean, boolean, boolean, text, boolean)
  to service_role;
grant execute on function public.list_crew_integration_destinations(uuid) to authenticated;
