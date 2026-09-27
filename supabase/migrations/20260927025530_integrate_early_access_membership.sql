-- Accepted early access is membership access, never a subscription or an
-- unrelated product entitlement. Existing legacy predicates, RPC payloads,
-- caller checks and execution grants remain intact. No person is enrolled.
set local lock_timeout = '5s';

-- Call after the existing entitlement lock phase. Every caller uses program ->
-- grants (sorted user IDs), and captures a fresh clock after its final wait.
-- No Auth row or site-admin lifecycle lock is introduced.
create function private.lock_early_access_authority(target_user_ids uuid[])
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  perform 1 from private.early_access_programs p
    where p.program_key = 'early_access_v1' for share;
  perform 1 from private.early_access_grants g
    where g.program_key = 'early_access_v1' and g.user_id = any(target_user_ids)
    order by g.user_id for share;
end;
$$;
revoke all on function private.lock_early_access_authority(uuid[])
  from public, anon, authenticated, service_role;

-- Preserve the existing public.has_active_entitlement contract.
create or replace function public.has_active_entitlement(target_entitlement_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.entitlements e
    where e.user_id = auth.uid()
      and e.entitlement_key = target_entitlement_key
      and e.status = 'active'
      and (e.ends_at is null or e.ends_at > now())
  ) or (
    coalesce(target_entitlement_key = 'membership_active', false)
    and private.early_access_active_for_user(auth.uid(), pg_catalog.statement_timestamp())
  );
$$;

-- Preserve the existing public.reconcile_user_challenge_unlocks contract.
create or replace function public.reconcile_user_challenge_unlocks(target_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted_count integer := 0;
begin
  if target_user_id is null then
    return 0;
  end if;

  insert into public.user_challenge_states (
    user_id,
    challenge_key,
    status,
    unlock_points,
    unlocked_at
  )
  select
    stats.user_id,
    definition.challenge_key,
    'available',
    definition.points_required,
    now()
  from public.user_game_stats stats
  join public.challenge_definitions definition
    on definition.is_active
   and definition.points_required <= greatest(stats.total_points, 0)
   and (
     definition.entitlement_key is null
     or (exists (
       select 1
       from public.entitlements entitlement
       where entitlement.user_id = stats.user_id
         and entitlement.entitlement_key = definition.entitlement_key
         and entitlement.status = 'active'
         and (entitlement.starts_at is null or entitlement.starts_at <= now())
         and (entitlement.ends_at is null or entitlement.ends_at > now())
     )
    or (coalesce(definition.entitlement_key = 'membership_active', false)
      and private.early_access_active_for_user(stats.user_id, pg_catalog.statement_timestamp())))
   )
  where stats.user_id = target_user_id
  on conflict (user_id, challenge_key) do nothing;

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

-- Preserve the existing public.sync_challenge_definition_unlocks contract.
create or replace function public.sync_challenge_definition_unlocks()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not new.is_active then
    return new;
  end if;

  insert into public.user_challenge_states (
    user_id,
    challenge_key,
    status,
    unlock_points,
    unlocked_at
  )
  select
    stats.user_id,
    new.challenge_key,
    'available',
    new.points_required,
    now()
  from public.user_game_stats stats
  where greatest(stats.total_points, 0) >= new.points_required
    and (
      new.entitlement_key is null
      or (exists (
        select 1
        from public.entitlements entitlement
        where entitlement.user_id = stats.user_id
          and entitlement.entitlement_key = new.entitlement_key
          and entitlement.status = 'active'
          and (entitlement.starts_at is null or entitlement.starts_at <= now())
          and (entitlement.ends_at is null or entitlement.ends_at > now())
      )
    or (coalesce(new.entitlement_key = 'membership_active', false)
      and private.early_access_active_for_user(stats.user_id, pg_catalog.statement_timestamp())))
    )
  on conflict (user_id, challenge_key) do nothing;

  return new;
end;
$$;

-- Preserve the existing public.challenge_progression_for_user contract.
create or replace function public.challenge_progression_for_user(target_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_total_points integer := 0;
  challenge_rows jsonb := '[]'::jsonb;
  next_unlock jsonb := null;
begin
  select greatest(coalesce(stats.total_points, 0), 0)
    into current_total_points
  from public.user_game_stats stats
  where stats.user_id = target_user_id;

  current_total_points := coalesce(current_total_points, 0);

  select coalesce(jsonb_agg(catalog.challenge order by catalog.points_required, catalog.sort_order, catalog.challenge_key), '[]'::jsonb)
    into challenge_rows
  from (
    select
      definition.challenge_key,
      definition.points_required,
      definition.sort_order,
      jsonb_build_object(
        'key', definition.challenge_key,
        'title', definition.title,
        'teaser', definition.teaser,
        'type', definition.challenge_type,
        'pointsRequired', definition.points_required,
        'durationDays', definition.duration_days,
        'entitlementKey', definition.entitlement_key,
        'icon', definition.icon,
        'sortOrder', definition.sort_order,
        'metadata', definition.metadata,
        'active', definition.is_active,
        'status', coalesce(user_state.status, 'locked'),
        'canAccess',
          definition.entitlement_key is null
          or (exists (
            select 1
            from public.entitlements entitlement
            where entitlement.user_id = target_user_id
              and entitlement.entitlement_key = definition.entitlement_key
              and entitlement.status = 'active'
              and (entitlement.starts_at is null or entitlement.starts_at <= now())
              and (entitlement.ends_at is null or entitlement.ends_at > now())
          )
    or (coalesce(definition.entitlement_key = 'membership_active', false)
      and private.early_access_active_for_user(target_user_id, pg_catalog.statement_timestamp()))),
        'accessReason', case
          when definition.entitlement_key is not null and not (exists (
            select 1
            from public.entitlements entitlement
            where entitlement.user_id = target_user_id
              and entitlement.entitlement_key = definition.entitlement_key
              and entitlement.status = 'active'
              and (entitlement.starts_at is null or entitlement.starts_at <= now())
              and (entitlement.ends_at is null or entitlement.ends_at > now())
          )
    or (coalesce(definition.entitlement_key = 'membership_active', false)
      and private.early_access_active_for_user(target_user_id, pg_catalog.statement_timestamp()))) then 'membership_required'
          when user_state.challenge_key is null then 'points_required'
          else null
        end,
        'pointsRemaining', case
          when user_state.challenge_key is not null then 0
          else greatest(definition.points_required - current_total_points, 0)
        end,
        'progressPercent', case
          when user_state.challenge_key is not null or definition.points_required = 0 then 100
          else least(round((current_total_points::numeric / definition.points_required::numeric) * 100, 2), 100)
        end,
        'unlockPoints', user_state.unlock_points,
        'unlockedAt', user_state.unlocked_at,
        'startedAt', user_state.started_at,
        'completedAt', user_state.completed_at,
        'celebrationSeenAt', user_state.celebration_seen_at
      ) as challenge
    from public.challenge_definitions definition
    left join public.user_challenge_states user_state
      on user_state.user_id = target_user_id
     and user_state.challenge_key = definition.challenge_key
    where definition.is_active
  ) catalog;

  select jsonb_build_object(
      'key', definition.challenge_key,
      'title', definition.title,
      'pointsRequired', definition.points_required,
      'pointsRemaining', greatest(definition.points_required - current_total_points, 0),
      'progressPercent', case
        when definition.points_required = 0 then 100
        else least(round((current_total_points::numeric / definition.points_required::numeric) * 100, 2), 100)
      end
    )
    into next_unlock
  from public.challenge_definitions definition
  left join public.user_challenge_states user_state
    on user_state.user_id = target_user_id
   and user_state.challenge_key = definition.challenge_key
  where definition.is_active
    and user_state.challenge_key is null
    and (
      definition.entitlement_key is null
      or (exists (
        select 1
        from public.entitlements entitlement
        where entitlement.user_id = target_user_id
          and entitlement.entitlement_key = definition.entitlement_key
          and entitlement.status = 'active'
          and (entitlement.starts_at is null or entitlement.starts_at <= now())
          and (entitlement.ends_at is null or entitlement.ends_at > now())
      )
    or (coalesce(definition.entitlement_key = 'membership_active', false)
      and private.early_access_active_for_user(target_user_id, pg_catalog.statement_timestamp())))
    )
  order by definition.points_required, definition.sort_order, definition.challenge_key
  limit 1;

  return jsonb_build_object(
    'totalPoints', current_total_points,
    'challenges', challenge_rows,
    'nextUnlock', next_unlock
  );
end;
$$;

-- Preserve the existing public.claim_challenge_unlocks contract.
create or replace function public.claim_challenge_unlocks()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  claimed_keys jsonb := '[]'::jsonb;
begin
  if current_user_id is null then
    raise exception 'You need to log in to claim challenge unlocks.';
  end if;

  perform public.ensure_user_game_stats(current_user_id);
  perform public.reconcile_user_challenge_unlocks(current_user_id);

  with pending as materialized (
    select user_state.user_id, user_state.challenge_key
    from public.user_challenge_states user_state
    join public.challenge_definitions definition
      on definition.challenge_key = user_state.challenge_key
     and definition.is_active
    where user_state.user_id = current_user_id
      and user_state.celebration_seen_at is null
      and (
        definition.entitlement_key is null
        or (exists (
          select 1
          from public.entitlements entitlement
          where entitlement.user_id = current_user_id
            and entitlement.entitlement_key = definition.entitlement_key
            and entitlement.status = 'active'
            and (entitlement.starts_at is null or entitlement.starts_at <= now())
            and (entitlement.ends_at is null or entitlement.ends_at > now())
        )
    or (coalesce(definition.entitlement_key = 'membership_active', false)
      and private.early_access_active_for_user(current_user_id, pg_catalog.statement_timestamp())))
      )
    order by definition.points_required, definition.sort_order, definition.challenge_key
    for update of user_state skip locked
  ),
  claimed as (
    update public.user_challenge_states user_state
    set celebration_seen_at = now()
    from pending
    where user_state.user_id = pending.user_id
      and user_state.challenge_key = pending.challenge_key
      and user_state.celebration_seen_at is null
    returning user_state.challenge_key
  )
  select coalesce(jsonb_agg(claimed.challenge_key order by definition.points_required, definition.sort_order, claimed.challenge_key), '[]'::jsonb)
    into claimed_keys
  from claimed
  join public.challenge_definitions definition
    on definition.challenge_key = claimed.challenge_key;

  return jsonb_build_object(
    'claimedKeys', claimed_keys,
    'progression', public.challenge_progression_for_user(current_user_id)
  );
end;
$$;

-- Preserve the existing public.start_challenge contract.
create or replace function public.start_challenge(target_challenge_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  current_status text;
  definition_active boolean;
  required_entitlement_key text;
begin
  if current_user_id is null then
    raise exception 'You need to log in to start a challenge.';
  end if;

  perform public.ensure_user_game_stats(current_user_id);
  perform public.reconcile_user_challenge_unlocks(current_user_id);

  select user_state.status, definition.is_active, definition.entitlement_key
    into current_status, definition_active, required_entitlement_key
  from public.user_challenge_states user_state
  join public.challenge_definitions definition
    on definition.challenge_key = user_state.challenge_key
  where user_state.user_id = current_user_id
    and user_state.challenge_key = target_challenge_key
  for update of user_state;

  if not found then
    raise exception 'That challenge is still locked.';
  end if;

  if not definition_active then
    raise exception 'That challenge is not currently available.';
  end if;

  if current_status <> 'available' then
    raise exception 'Only an available challenge can be started.';
  end if;

  if required_entitlement_key is not null and not (exists (
    select 1
    from public.entitlements entitlement
    where entitlement.user_id = current_user_id
      and entitlement.entitlement_key = required_entitlement_key
      and entitlement.status = 'active'
      and (entitlement.starts_at is null or entitlement.starts_at <= now())
      and (entitlement.ends_at is null or entitlement.ends_at > now())
  )
    or (coalesce(required_entitlement_key = 'membership_active', false)
      and private.early_access_active_for_user(current_user_id, pg_catalog.statement_timestamp()))) then
    raise exception 'An active membership is required to start this challenge.';
  end if;

  update public.user_challenge_states
  set
    status = 'active',
    started_at = now()
  where user_id = current_user_id
    and challenge_key = target_challenge_key
    and status = 'available';

  return public.challenge_progression_for_user(current_user_id);
end;
$$;

-- Preserve the existing public.reward_catalog_item_for_user contract.
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
    select
      definition.*,
      case
        when definition.state_model = 'ownership'
          then private.reward_eligible_points(target_user_id, definition.reward_key)
        else greatest(coalesce(target_current_points, 0), 0)
      end as eligible_points,
      challenge_state.status as challenge_status,
      challenge_state.unlock_points,
      challenge_state.unlocked_at,
      challenge_state.started_at,
      challenge_state.completed_at,
      challenge_state.celebration_seen_at as challenge_celebration_seen_at,
      reward_entitlement.owned_at,
      reward_entitlement.celebration_seen_at as ownership_celebration_seen_at,
      (
        definition.required_entitlement_key is null
        or (exists (
          select 1
          from public.entitlements as access_entitlement
          where access_entitlement.user_id = target_user_id
            and access_entitlement.entitlement_key = definition.required_entitlement_key
            and access_entitlement.status = 'active'
            and (
              access_entitlement.starts_at is null
              or access_entitlement.starts_at <= pg_catalog.now()
            )
            and (
              access_entitlement.ends_at is null
              or access_entitlement.ends_at > pg_catalog.now()
            )
        )
    or (coalesce(definition.required_entitlement_key = 'membership_active', false)
      and private.early_access_active_for_user(target_user_id, pg_catalog.statement_timestamp())))
      ) as can_access,
      case
        when definition.state_model = 'challenge_lifecycle'
          then coalesce(challenge_state.status, 'locked')
        when reward_entitlement.reward_key is not null then 'owned'
        else 'locked'
      end as current_status
    from public.reward_definitions as definition
    left join public.user_challenge_states as challenge_state
      on challenge_state.user_id = target_user_id
     and challenge_state.challenge_key = definition.challenge_key
    left join public.user_reward_entitlements as reward_entitlement
      on reward_entitlement.user_id = target_user_id
     and reward_entitlement.reward_key = definition.reward_key
    where definition.reward_key = target_reward_key
  )
  select jsonb_build_object(
    'key', item.reward_key,
    'rewardType', item.reward_type,
    'stateModel', item.state_model,
    'status', item.current_status,
    'title', item.title,
    'description', item.description,
    'pointsRequired', item.points_required,
    'currentPoints', item.eligible_points,
    'pointsRemaining', case
      when item.current_status <> 'locked' then 0
      else greatest(item.points_required - item.eligible_points, 0)
    end,
    'progressPercent', case
      when item.current_status <> 'locked' or item.points_required = 0 then 100
      else least(
        round(
          item.eligible_points::numeric / item.points_required::numeric * 100,
          2
        ),
        100
      )
    end,
    'fulfillmentKey', item.fulfillment_key,
    'requiredEntitlementKey', item.required_entitlement_key,
    'icon', item.icon,
    'sortOrder', item.sort_order,
    'active', item.is_active,
    'metadata', item.display_metadata,
    'canAccess', item.can_access,
    'accessReason', case
      when not item.can_access then 'entitlement_required'
      when item.current_status = 'locked' then 'points_required'
      else null
    end,
    'allowedActions', case
      when item.state_model = 'challenge_lifecycle'
        and item.current_status = 'available'
        and item.can_access
        then jsonb_build_array('start')
      else '[]'::jsonb
    end,
    'unlockPoints', item.unlock_points,
    'unlockedAt', item.unlocked_at,
    'startedAt', item.started_at,
    'completedAt', item.completed_at,
    'ownedAt', item.owned_at,
    'celebrationSeenAt', case
      when item.state_model = 'challenge_lifecycle'
        then item.challenge_celebration_seen_at
      else item.ownership_celebration_seen_at
    end
  )
  from item;
$$;

-- Preserve the existing public.challenge_activation_payload_for_user contract.
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
begin
  select profile.* into profile_row
  from public.profiles profile
  where profile.user_id = target_user_id;

  if not found then
    return pg_catalog.jsonb_build_object(
      'schemaVersion', 1,
      'revision', 0,
      'status', 'not_started',
      'storedStatus', 'not_started',
      'mode', null,
      'startDate', null,
      'timeZone', null,
      'crewId', null,
      'groupMembershipActive', false,
      'activatedAt', null,
      'confirmedAt', null,
      'activatedBy', null,
      'confirmedBy', null,
      'reviewRequired', false,
      'challengeDay', null,
      'canActivateSolo', true,
      'canActivateGroup', true,
      'canParticipate', false,
      'canMutateDailyStandards', false,
      'canEditStartDate', false
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
     and effective_status = 'active' then
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
          select 1
          from private.retired_community_dr_quarantined_crews quarantine
          where quarantine.crew_id = crew_row.id
        )
    ) into group_membership_active;
  end if;

  select (exists (
    select 1
    from public.entitlements entitlement
    where entitlement.user_id = target_user_id
      and entitlement.entitlement_key = 'membership_active'
      and entitlement.status = 'active'
      and (
        entitlement.ends_at is null
        or entitlement.ends_at > pg_catalog.statement_timestamp()
      )
  )
    or private.early_access_active_for_user(target_user_id, pg_catalog.statement_timestamp())) into has_active_membership;

  can_edit_start_date := profile_row.challenge_participation_mode = 'solo'
    and effective_status in ('scheduled', 'active')
    and not exists (
      select 1 from public.check_ins check_in where check_in.user_id = target_user_id
    );

  return pg_catalog.jsonb_build_object(
    'schemaVersion', profile_row.challenge_activation_schema_version,
    'revision', profile_row.challenge_activation_revision,
    'status', effective_status,
    'storedStatus', profile_row.challenge_activation_status,
    'mode', profile_row.challenge_participation_mode,
    'startDate', profile_row.challenge_start_date,
    'timeZone', profile_row.challenge_activation_time_zone,
    'crewId', profile_row.challenge_group_attribution_crew_id,
    'groupMembershipActive', group_membership_active,
    'activatedAt', profile_row.challenge_activated_at,
    'confirmedAt', profile_row.challenge_confirmed_at,
    'activatedBy', profile_row.challenge_activated_by,
    'confirmedBy', profile_row.challenge_confirmed_by,
    'reviewRequired', profile_row.challenge_activation_review_required,
    'challengeDay', challenge_day,
    'canActivateSolo', effective_status = 'not_started',
    'canActivateGroup', effective_status = 'not_started',
    'canParticipate', effective_status = 'active',
    'canMutateDailyStandards', has_active_membership
      and public.challenge_activation_allows_date(target_user_id, user_date),
    'canEditStartDate', can_edit_start_date
  );
end;
$$;

-- Preserve the existing private.crew_invite_issuer_is_authorized contract.
create or replace function private.crew_invite_issuer_is_authorized(
  target_crew_id uuid,
  target_inviter_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.crews crew_row
    join public.crew_members member_row
      on member_row.crew_id = crew_row.id
     and member_row.user_id = target_inviter_id
     and member_row.role in ('owner', 'admin')
    where crew_row.id = target_crew_id
      and crew_row.deleted_at is null
      and not exists (
        select 1
        from private.retired_community_dr_quarantined_crews quarantine
        where quarantine.crew_id = crew_row.id
      )
      and (exists (
        select 1
        from public.entitlements entitlement
        where entitlement.user_id = target_inviter_id
          and entitlement.entitlement_key = 'membership_active'
          and entitlement.status = 'active'
          and (
            entitlement.starts_at is null
            or entitlement.starts_at <= pg_catalog.now()
          )
          and (
            entitlement.ends_at is null
            or entitlement.ends_at > pg_catalog.now()
          )
      )
    or private.early_access_active_for_user(target_inviter_id, pg_catalog.statement_timestamp()))
  );
$$;

-- Preserve the existing public.issue_crew_invite_bundle contract.
create or replace function public.issue_crew_invite_bundle(target_crew_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  issued_token text;
  issued_code text;
  issued_code_hash text;
  issued_invite public.crew_invites%rowtype;
  locked_membership_role text;
  recent_count integer;
  latest_created_at timestamptz;
  legacy_membership_active boolean;
  membership_checked_at timestamptz;
begin
  if caller_id is null then
    return pg_catalog.jsonb_build_object('status', 'authentication_required');
  end if;

  if not (exists (
      select 1
      from public.entitlements entitlement
      where entitlement.user_id = caller_id
        and entitlement.entitlement_key = 'membership_active'
        and entitlement.status = 'active'
        and (
          entitlement.starts_at is null
          or entitlement.starts_at <= pg_catalog.now()
        )
        and (
          entitlement.ends_at is null
          or entitlement.ends_at > pg_catalog.now()
        )
    )
    or private.early_access_active_for_user(caller_id, pg_catalog.statement_timestamp()))
    or not exists (
      select 1
      from public.crew_members member_row
      join public.crews crew_row on crew_row.id = member_row.crew_id
      where member_row.crew_id = target_crew_id
        and member_row.user_id = caller_id
        and member_row.role in ('owner', 'admin')
        and crew_row.deleted_at is null
        and not exists (
          select 1
          from private.retired_community_dr_quarantined_crews quarantine
          where quarantine.crew_id = crew_row.id
        )
    ) then
    return pg_catalog.jsonb_build_object('status', 'forbidden');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('crew-invite:' || target_crew_id::text, 0)
  );

  -- Match the deletion/confirmation hierarchy: invite -> crew -> membership
  -- -> entitlement. Authorization is repeated while those rows are locked so
  -- a role or billing change that committed while this call waited wins.
  perform 1
  from public.crew_invites invite_row
  where invite_row.crew_id = target_crew_id
  order by invite_row.id
  for update;

  perform 1
  from public.crews crew_row
  where crew_row.id = target_crew_id
    and crew_row.deleted_at is null
  for share;
  if not found then
    return pg_catalog.jsonb_build_object('status', 'forbidden');
  end if;

  select member_row.role
    into locked_membership_role
    from public.crew_members member_row
    where member_row.crew_id = target_crew_id
      and member_row.user_id = caller_id
    for share;
  if not found or locked_membership_role not in ('owner', 'admin') then
    return pg_catalog.jsonb_build_object('status', 'forbidden');
  end if;

  perform 1
  from public.entitlements entitlement
  where entitlement.user_id = caller_id
    and entitlement.entitlement_key = 'membership_active'
    and entitlement.status = 'active'
    and (
      entitlement.starts_at is null
      or entitlement.starts_at <= pg_catalog.now()
    )
    and (
      entitlement.ends_at is null
      or entitlement.ends_at > pg_catalog.now()
    )
  for share;
  legacy_membership_active := found;
  perform private.lock_early_access_authority(array[caller_id]);
  membership_checked_at := pg_catalog.clock_timestamp();
  if not (legacy_membership_active or
    private.early_access_active_for_user(caller_id, membership_checked_at)) or exists (
    select 1
    from private.retired_community_dr_quarantined_crews quarantine
    where quarantine.crew_id = target_crew_id
  ) then
    return pg_catalog.jsonb_build_object('status', 'forbidden');
  end if;

  select pg_catalog.count(*)::integer, pg_catalog.max(created_at)
    into recent_count, latest_created_at
    from public.crew_invites invite_row
    where invite_row.crew_id = target_crew_id
      and invite_row.created_by = caller_id
      and invite_row.created_at between
        pg_catalog.now() - interval '1 hour'
        and pg_catalog.now() + interval '1 minute';

  if recent_count >= 10
    or (
      latest_created_at is not null
      and latest_created_at > pg_catalog.now() - interval '5 seconds'
    ) then
    return pg_catalog.jsonb_build_object('status', 'rate_limited');
  end if;

  update public.crew_invites
  set revoked_at = pg_catalog.now()
  where crew_id = target_crew_id
    and revoked_at is null
    and redeemed_at is null;

  issued_token := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');

  loop
    issued_code := private.generate_crew_invite_code();
    issued_code_hash := private.crew_invite_keyed_hash('code-v1', issued_code);
    exit when not exists (
      select 1
      from public.crew_invites existing_invite
      where existing_invite.code_hash = issued_code_hash
    );
  end loop;

  insert into public.crew_invites (
    crew_id,
    token_hash,
    token_hint,
    code_hash,
    code_hint,
    created_by,
    expires_at
  ) values (
    target_crew_id,
    public.crew_invite_secret_hash(issued_token),
    pg_catalog.right(issued_token, 6),
    issued_code_hash,
    pg_catalog.right(issued_code, 4),
    caller_id,
    pg_catalog.now() + interval '14 days'
  )
  returning * into issued_invite;

  return pg_catalog.jsonb_build_object(
    'status', 'issued',
    'inviteId', issued_invite.id,
    'token', issued_token,
    'tokenHint', issued_invite.token_hint,
    'code', issued_code,
    'codeHint', issued_invite.code_hint,
    'expiresAt', issued_invite.expires_at
  );
end;
$$;

-- Preserve the existing public.confirm_crew_invite contract.
create or replace function public.confirm_crew_invite(continuation_token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  session_row public.crew_invite_sessions%rowtype;
  invite_row public.crew_invites%rowtype;
  crew_row public.crews%rowtype;
  member_name text;
  member_avatar_url text;
  inviter_first_name text;
  inviter_role text;
  redemption_id uuid;
  member_count integer;
  preview_payload jsonb;
  membership_checked_at timestamptz;
begin
  if caller_id is null then
    return pg_catalog.jsonb_build_object('status', 'authentication_required');
  end if;

  if continuation_token is null
    or pg_catalog.char_length(continuation_token) < 16
    or pg_catalog.char_length(continuation_token) > 256
    or continuation_token !~ '^[A-Za-z0-9_-]+$' then
    return pg_catalog.jsonb_build_object('status', 'invalid');
  end if;

  if not private.consume_crew_invite_rate_limit(
    'confirmation:account:' || caller_id::text,
    30,
    interval '15 minutes'
  ) then
    return pg_catalog.jsonb_build_object('status', 'rate_limited');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('single-crew:' || caller_id::text, 821)
  );

  select source_session.*
    into session_row
    from public.crew_invite_sessions source_session
    where source_session.continuation_hash
      = public.crew_invite_secret_hash(continuation_token)
    limit 1
    for update;

  if not found then
    return pg_catalog.jsonb_build_object('status', 'invalid');
  end if;
  if session_row.expires_at <= pg_catalog.now() then
    return pg_catalog.jsonb_build_object('status', 'session_expired');
  end if;
  if session_row.bound_user_id is not null
    and session_row.bound_user_id <> caller_id then
    return pg_catalog.jsonb_build_object('status', 'wrong_account');
  end if;
  if session_row.confirmation_attempts >= 5 then
    return pg_catalog.jsonb_build_object('status', 'rate_limited');
  end if;

  update public.crew_invite_sessions
  set bound_user_id = caller_id,
      confirmation_attempts = confirmation_attempts + 1,
      last_seen_at = pg_catalog.now()
  where id = session_row.id
  returning * into session_row;

  select source_invite.*
    into invite_row
    from public.crew_invites source_invite
    where source_invite.id = session_row.invite_id
    for update;

  if not found then
    return pg_catalog.jsonb_build_object('status', 'invalid');
  end if;
  if invite_row.revoked_at is not null then
    return pg_catalog.jsonb_build_object('status', 'revoked');
  end if;
  if invite_row.expires_at <= pg_catalog.now() then
    return pg_catalog.jsonb_build_object('status', 'expired');
  end if;
  select source_crew.*
    into crew_row
    from public.crews source_crew
    where source_crew.id = invite_row.crew_id
      and source_crew.deleted_at is null
    for update;
  if not found then
    return pg_catalog.jsonb_build_object('status', 'invalid');
  end if;

  select member_row.role
    into inviter_role
    from public.crew_members member_row
    where member_row.crew_id = invite_row.crew_id
      and member_row.user_id = invite_row.created_by
    for share;
  if not found or inviter_role not in ('owner', 'admin') then
    return pg_catalog.jsonb_build_object('status', 'invalid');
  end if;

  -- Lock both billing rows in deterministic user-ID order before checking
  -- either one. This closes issuer and recipient entitlement TOCTOU windows.
  perform 1
  from public.entitlements entitlement
  where entitlement.user_id in (invite_row.created_by, caller_id)
    and entitlement.entitlement_key = 'membership_active'
    and entitlement.status = 'active'
    and (
      entitlement.starts_at is null
      or entitlement.starts_at <= pg_catalog.now()
    )
    and (
      entitlement.ends_at is null
      or entitlement.ends_at > pg_catalog.now()
    )
  order by entitlement.user_id
  for share;
  perform private.lock_early_access_authority(array[invite_row.created_by, caller_id]);
  membership_checked_at := pg_catalog.clock_timestamp();

  if not (exists (
      select 1
      from public.entitlements entitlement
      where entitlement.user_id = invite_row.created_by
        and entitlement.entitlement_key = 'membership_active'
        and entitlement.status = 'active'
        and (entitlement.starts_at is null or entitlement.starts_at <= pg_catalog.now())
        and (entitlement.ends_at is null or entitlement.ends_at > pg_catalog.now())
    )
    or private.early_access_active_for_user(invite_row.created_by, membership_checked_at))
    or exists (
      select 1
      from private.retired_community_dr_quarantined_crews quarantine
      where quarantine.crew_id = invite_row.crew_id
    ) then
    return pg_catalog.jsonb_build_object('status', 'invalid');
  end if;

  if not (exists (
    select 1
    from public.entitlements entitlement
    where entitlement.user_id = caller_id
      and entitlement.entitlement_key = 'membership_active'
      and entitlement.status = 'active'
      and (entitlement.starts_at is null or entitlement.starts_at <= pg_catalog.now())
      and (entitlement.ends_at is null or entitlement.ends_at > pg_catalog.now())
  )
    or private.early_access_active_for_user(caller_id, membership_checked_at)) then
    return pg_catalog.jsonb_build_object('status', 'subscription_required');
  end if;

  select pg_catalog.split_part(
      coalesce(
        nullif(pg_catalog.btrim(profile_row.name), ''),
        'Dominion member'
      ),
      ' ',
      1
    )
    into inviter_first_name
    from public.profiles profile_row
    where profile_row.user_id = invite_row.created_by;

  preview_payload := pg_catalog.jsonb_build_object(
    'groupName', crew_row.name,
    'inviterName', coalesce(inviter_first_name, 'Dominion member'),
    'expiresAt', invite_row.expires_at
  );

  if exists (
    select 1
    from public.crew_members member_row
    where member_row.crew_id = invite_row.crew_id
      and member_row.user_id = caller_id
  ) then
    return pg_catalog.jsonb_build_object(
      'status', 'already_member',
      'crewId', invite_row.crew_id,
      'preview', preview_payload
    );
  end if;
  if invite_row.redeemed_by is not null then
    return pg_catalog.jsonb_build_object('status', 'already_used');
  end if;
  select pg_catalog.count(*)::integer
    into member_count
    from public.crew_members member_row
    where member_row.crew_id = invite_row.crew_id;
  if member_count >= crew_row.member_limit then
    return pg_catalog.jsonb_build_object('status', 'full');
  end if;

  if exists (
    select 1
    from public.crew_invite_attributions attribution
    where attribution.crew_id = invite_row.crew_id
      and attribution.recipient_user_id = caller_id
  ) then
    return pg_catalog.jsonb_build_object('status', 'already_used');
  end if;

  if exists (
    select 1
    from public.crew_members member_row
    where member_row.user_id = caller_id
  ) then
    return pg_catalog.jsonb_build_object(
      'status', 'current_crew_conflict',
      'preview', preview_payload
    );
  end if;

  select coalesce(
      nullif(profile_row.name, ''),
      'Member'
    ),
    coalesce(profile_row.avatar_url, '')
    into member_name, member_avatar_url
    from public.profiles profile_row
    where profile_row.user_id = caller_id;

  insert into public.crew_members (
    crew_id,
    user_id,
    display_name,
    avatar_url,
    role
  ) values (
    invite_row.crew_id,
    caller_id,
    coalesce(member_name, 'Member'),
    coalesce(member_avatar_url, ''),
    'member'
  );

  insert into public.crew_invite_attributions (
    invite_id,
    crew_id,
    inviter_user_id,
    recipient_user_id
  ) values (
    invite_row.id,
    invite_row.crew_id,
    invite_row.created_by,
    caller_id
  )
  returning id into redemption_id;

  update public.crew_invites
  set redeemed_by = caller_id,
      redeemed_at = pg_catalog.now()
  where id = invite_row.id;

  update public.crew_invite_sessions
  set confirmed_at = pg_catalog.now()
  where id = session_row.id;

  return pg_catalog.jsonb_build_object(
    'status', 'joined',
    'crewId', invite_row.crew_id,
    'redemptionId', redemption_id,
    'preview', preview_payload
  );
end;
$$;

-- Preserve the existing public.get_crew_member_progress_profile contract.
create or replace function public.get_crew_member_progress_profile(
  target_crew_id uuid,
  target_user_id uuid,
  target_badge_cursor_earned_at timestamptz default null,
  target_badge_cursor_key text default null,
  target_badge_limit integer default 12,
  target_badge_cursor_award_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  normalized_limit integer := least(
    greatest(coalesce(target_badge_limit, 12), 1),
    24
  );
  required_members integer;
  locked_members integer;
  member_name text;
  member_avatar_url text;
  member_role text;
  member_level integer;
  total_badges integer;
  badge_page jsonb := '[]'::jsonb;
  page_has_more boolean := false;
  next_cursor_earned_at timestamptz;
  next_cursor_key text;
  next_cursor_award_id uuid;
  cursor_award_id uuid := target_badge_cursor_award_id;
  cursor_matches integer;
  legacy_membership_active boolean;
  membership_checked_at timestamptz;
begin
  -- One generic response protects account and badge existence from probing.
  if caller_id is null
     or target_crew_id is null
     or target_user_id is null
     or (target_badge_cursor_award_id is not null and target_badge_cursor_earned_at is null)
     or ((target_badge_cursor_earned_at is null) <>
         (target_badge_cursor_key is null))
     or (target_badge_cursor_key is not null and (
       pg_catalog.length(target_badge_cursor_key) < 1
       or pg_catalog.length(target_badge_cursor_key) > 120
     )) then
    raise exception 'Member progress is no longer available.' using errcode = 'P0002';
  end if;

  -- Account erasure takes this key exclusively before touching memberships.
  -- Shared acquisition lets reads run together while preserving that lock
  -- hierarchy and preventing an erasure/read deadlock.
  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('retired-community-deletion', 0)
  );

  -- Lock the entitlement so a concurrent lapse either commits before this
  -- check (and is denied) or waits until this authorized read has completed.
  perform 1
  from public.entitlements entitlement
  where entitlement.user_id = caller_id
    and entitlement.entitlement_key = 'membership_active'
    and entitlement.status = 'active'
    and (entitlement.starts_at is null or entitlement.starts_at <= pg_catalog.now())
    and (entitlement.ends_at is null or entitlement.ends_at > pg_catalog.now())
  for share;
  legacy_membership_active := found;
  perform private.lock_early_access_authority(array[caller_id]);

  -- Crew and membership row locks serialize against leave/delete operations.
  perform 1
  from public.crews crew
  where crew.id = target_crew_id
    and crew.deleted_at is null
  for share;
  if not found then
    raise exception 'Member progress is no longer available.' using errcode = 'P0002';
  end if;

  perform 1
  from public.crew_members member
  where member.crew_id = target_crew_id
    and member.user_id in (caller_id, target_user_id)
  order by member.user_id
  for share;

  required_members := case when caller_id = target_user_id then 1 else 2 end;
  select pg_catalog.count(*)::integer
    into locked_members
  from public.crew_members member
  where member.crew_id = target_crew_id
    and member.user_id in (caller_id, target_user_id);
  if locked_members <> required_members then
    raise exception 'Member progress is no longer available.' using errcode = 'P0002';
  end if;

  -- Recheck EA after all blocking authority/crew/membership row locks.
  membership_checked_at := pg_catalog.clock_timestamp();
  if not (legacy_membership_active or
    private.early_access_active_for_user(caller_id, membership_checked_at)) then
    raise exception 'Member progress is no longer available.' using errcode = 'P0002';
  end if;

  select
    pg_catalog.left(
      pg_catalog.regexp_replace(
        coalesce(
          nullif(pg_catalog.btrim(profile.name), ''),
          nullif(pg_catalog.btrim(member.display_name), ''),
          'Member'
        ),
        '[[:cntrl:]]',
        '',
        'g'
      ),
      80
    ),
    pg_catalog.left(coalesce(profile.avatar_url, ''), 2048),
    case member.role
      when 'owner' then 'owner'
      when 'admin' then 'admin'
      else 'member'
    end,
    private.lifetime_level_from_points(stats.total_points)
  into member_name, member_avatar_url, member_role, member_level
  from public.crew_members member
  left join public.profiles profile on profile.user_id = member.user_id
  left join public.user_game_stats stats on stats.user_id = member.user_id
  where member.crew_id = target_crew_id
    and member.user_id = target_user_id;
  if not found then
    raise exception 'Member progress is no longer available.' using errcode = 'P0002';
  end if;


  -- Resolve an older named-argument client's cursor only when it identifies one
  -- award. Never silently skip tied lifetime/scoped rows. The caller can reload
  -- the first page and receive its stable UUID cursor.
  if target_badge_cursor_earned_at is not null then
    if cursor_award_id is null then
      select count(*)::integer, (array_agg(earned.id))[1]
        into cursor_matches, cursor_award_id
      from public.user_badges earned
      where earned.user_id = target_user_id
        and earned.earned_at = target_badge_cursor_earned_at
        and earned.badge_key = target_badge_cursor_key;
      if cursor_matches <> 1 then
        raise exception 'Badge history changed. Reload badges to start from the first page.'
          using errcode = '22023', detail = 'member_badge_cursor_restart_required';
      end if;
    elsif not exists (
      select 1 from public.user_badges earned
      where earned.user_id = target_user_id and earned.id = cursor_award_id
        and earned.earned_at = target_badge_cursor_earned_at
        and earned.badge_key = target_badge_cursor_key
    ) then
      raise exception 'Badge history changed. Reload badges to start from the first page.'
        using errcode = '22023', detail = 'member_badge_cursor_restart_required';
    end if;
  end if;

  select pg_catalog.count(*)::integer
    into total_badges
  from public.user_badges earned
  where earned.user_id = target_user_id;

  with candidate_badges as (
    select
      earned.id as award_id,
      earned.badge_key,
      earned.earned_at,
      presentation.value->>'name' as name,
      presentation.value->>'description' as description,
      presentation.value->>'tier' as tier,
      presentation.value->>'icon' as icon,
      pg_catalog.row_number() over (
        order by earned.earned_at desc, earned.badge_key asc, earned.id asc
      ) as page_position
    from public.user_badges earned
    join public.badge_definitions definition
      on definition.badge_key = earned.badge_key
    cross join lateral (select private.member_badge_presentation(
      earned.metadata->'awardDefinition', definition.name, definition.description,
      definition.tier, definition.icon) as value) presentation
    where earned.user_id = target_user_id
      and (
        target_badge_cursor_earned_at is null
        or earned.earned_at < target_badge_cursor_earned_at
        or (
          earned.earned_at = target_badge_cursor_earned_at
          and (earned.badge_key > target_badge_cursor_key
            or (earned.badge_key = target_badge_cursor_key and earned.id > cursor_award_id))
        )
      )
    order by earned.earned_at desc, earned.badge_key asc, earned.id asc
    limit normalized_limit + 1
  ), page_badges as (
    select *
    from candidate_badges
    where page_position <= normalized_limit
  )
  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'awardId', page.award_id,
          'key', pg_catalog.left(page.badge_key, 120),
          'name', pg_catalog.left(
            pg_catalog.regexp_replace(page.name, '[[:cntrl:]]', '', 'g'),
            120
          ),
          'description', pg_catalog.left(
            pg_catalog.regexp_replace(
              coalesce(page.description, ''),
              '[[:cntrl:]]',
              '',
              'g'
            ),
            500
          ),
          'tier', case page.tier
            when 'bronze' then 'bronze'
            when 'silver' then 'silver'
            when 'gold' then 'gold'
            else 'bronze'
          end,
          'icon', case
            when page.icon ~ '^[a-z0-9_-]{1,40}$' then page.icon
            else 'shield'
          end,
          'earnedAt', page.earned_at
        ) order by page.earned_at desc, page.badge_key asc, page.award_id asc
      ),
      '[]'::jsonb
    ),
    (select pg_catalog.count(*) > normalized_limit from candidate_badges),
    (select cursor_page.earned_at
       from page_badges cursor_page
       order by cursor_page.page_position desc
       limit 1),
    (select cursor_page.badge_key
       from page_badges cursor_page
       order by cursor_page.page_position desc
       limit 1),
    (select cursor_page.award_id
       from page_badges cursor_page
       order by cursor_page.page_position desc
       limit 1)
  into badge_page, page_has_more, next_cursor_earned_at, next_cursor_key, next_cursor_award_id
  from page_badges page;

  return pg_catalog.jsonb_build_object(
    'memberId', target_user_id,
    'displayName', member_name,
    'avatarUrl', member_avatar_url,
    'role', member_role,
    'level', member_level,
    'badgeCount', total_badges,
    'badges', badge_page,
    'hasMore', coalesce(page_has_more, false),
    'nextCursor', case
      when coalesce(page_has_more, false) then
        pg_catalog.jsonb_build_object(
          'earnedAt', next_cursor_earned_at,
          'badgeKey', next_cursor_key,
          'awardId', next_cursor_award_id
        )
      else null
    end
  );
end;
$$;

-- Preserve the existing private.member_access_context contract.
create or replace function private.member_access_context(target_expected_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  as_of timestamptz := pg_catalog.statement_timestamp();
  legacy_active boolean;
  paid_active boolean;
  early_active boolean;
  early_ends timestamptz;
  price_eligible boolean;
begin
  perform private.require_member_request_identity(target_expected_actor_id);
  -- Preserve the established legacy gate, including its existing start-time
  -- semantics. A testing/canary entitlement is not a paid subscription or EA.
  legacy_active := exists (
    select 1 from public.entitlements e
    where e.user_id = target_expected_actor_id
      and e.entitlement_key = 'membership_active' and e.status = 'active'
      and (e.ends_at is null or e.ends_at > pg_catalog.now())
  );
  select legacy_active and exists (select 1 from public.entitlements e
    where e.user_id = target_expected_actor_id and e.entitlement_key = 'membership_active'
      and e.status = 'active' and e.source_type = 'subscription'
      and nullif(e.source_id, '') is not null
      and (e.starts_at is null or e.starts_at <= as_of)
      and (e.ends_at is null or e.ends_at > as_of)) into paid_active;
  early_active := private.early_access_active_for_user(target_expected_actor_id, as_of);
  if early_active then
    select p.beta_starts_at into early_ends from private.early_access_programs p
      where p.program_key = 'early_access_v1';
  end if;
  select exists (select 1 from private.early_access_price_qualifications q
    where q.user_id = target_expected_actor_id and q.program_key = 'early_access_v1') into price_eligible;
  -- Recheck live identity before releasing the self-only allowlisted payload.
  perform private.require_member_request_identity(target_expected_actor_id);
  return pg_catalog.jsonb_build_object('schemaVersion', 1, 'actorId', target_expected_actor_id,
    'asOf', as_of, 'appAccess', legacy_active or early_active,
    'legacyMembershipActive', legacy_active, 'paidSubscriptionActive', paid_active,
    'earlyAccessActive', early_active, 'earlyAccessProgram', case when early_active then 'early_access_v1' else null end,
    'earlyAccessEndsAt', early_ends, 'betaPriceEligible', price_eligible);
end;
$$;
