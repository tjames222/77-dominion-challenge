-- FOU-822: persist a versioned, privacy-minimal creator walkthrough without
-- coupling onboarding progress to invitation, provider, consent, or delivery data.

set local lock_timeout = '10s';
set local statement_timeout = '120s';

create table if not exists private.crew_training_progress (
  crew_id uuid not null,
  user_id uuid not null,
  -- Version 1 is the only published syllabus. A future syllabus must ship with
  -- an explicit migration that expands this allow-list and its step bounds.
  content_version integer not null check (content_version = 1),
  status text not null check (status in ('not_started', 'in_progress', 'skipped', 'completed')),
  current_step integer not null default 0 check (current_step between 0 and 6),
  furthest_step integer not null default 0 check (furthest_step between 0 and 6),
  started_at timestamptz,
  skipped_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (user_id, crew_id, content_version),
  foreign key (crew_id, user_id)
    references public.crew_members (crew_id, user_id)
    on delete cascade,
  check (current_step <= furthest_step),
  check (status <> 'not_started' or (current_step = 0 and furthest_step = 0 and started_at is null)),
  check (status = 'not_started' or started_at is not null),
  check ((status = 'completed') = (completed_at is not null)),
  check (status <> 'completed' or (current_step = 6 and furthest_step = 6)),
  check (updated_at >= created_at)
);

create index if not exists crew_training_progress_crew_user_idx
  on private.crew_training_progress (crew_id, user_id);

alter table private.crew_training_progress enable row level security;
revoke all on table private.crew_training_progress
  from public, anon, authenticated, service_role;
grant select on table private.crew_training_progress to service_role;

create or replace function private.crew_training_access_allowed(
  target_crew_id uuid,
  target_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select target_crew_id is not null
    and target_user_id is not null
    and not exists (
      select 1
      from private.retired_community_dr_quarantined_crews quarantine
      where quarantine.crew_id = target_crew_id
    )
    and exists (
      select 1
      from public.crews crew_row
      join public.crew_members member_row
        on member_row.crew_id = crew_row.id
       and member_row.user_id = target_user_id
      where crew_row.id = target_crew_id
        and crew_row.created_by = target_user_id
        and crew_row.deleted_at is null
        and member_row.role in ('owner', 'admin')
    );
$$;

create or replace function private.crew_training_progress_payload(
  target_row private.crew_training_progress,
  target_claimed_now boolean default null
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'crewId', (target_row).crew_id,
    'userId', (target_row).user_id,
    'contentVersion', (target_row).content_version,
    'status', (target_row).status,
    'currentStep', (target_row).current_step,
    'furthestStep', (target_row).furthest_step,
    'stepCount', 7,
    'startedAt', (target_row).started_at,
    'skippedAt', (target_row).skipped_at,
    'completedAt', (target_row).completed_at,
    'updatedAt', (target_row).updated_at
  ) || case
    when target_claimed_now is null then '{}'::jsonb
    else pg_catalog.jsonb_build_object('claimedNow', target_claimed_now)
  end;
$$;

create or replace function public.get_crew_training_progress(
  target_crew_id uuid,
  target_content_version integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  progress_row private.crew_training_progress%rowtype;
begin
  if caller_id is null then
    raise exception 'You need to log in to view crew training.' using errcode = '28000';
  end if;
  if target_crew_id is null
     or target_content_version is distinct from 1 then
    raise exception 'A valid crew and training version are required.' using errcode = '22023';
  end if;
  if not private.crew_training_access_allowed(target_crew_id, caller_id) then
    raise exception 'Crew training is available only to the active crew creator.' using errcode = '42501';
  end if;

  select source_row.* into progress_row
  from private.crew_training_progress source_row
  where source_row.user_id = caller_id
    and source_row.crew_id = target_crew_id
    and source_row.content_version = target_content_version;

  if found then
    return private.crew_training_progress_payload(progress_row, null);
  end if;

  return pg_catalog.jsonb_build_object(
    'crewId', target_crew_id,
    'userId', caller_id,
    'contentVersion', target_content_version,
    'status', 'not_started',
    'currentStep', 0,
    'furthestStep', 0,
    'stepCount', 7,
    'startedAt', null,
    'skippedAt', null,
    'completedAt', null,
    'updatedAt', null
  );
end;
$$;

create or replace function public.claim_crew_training(
  target_crew_id uuid,
  target_content_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  progress_row private.crew_training_progress%rowtype;
  claimed_now boolean := false;
  mutation_time timestamptz;
begin
  if caller_id is null then
    raise exception 'You need to log in to start crew training.' using errcode = '28000';
  end if;
  if target_crew_id is null
     or target_content_version is distinct from 1 then
    raise exception 'A valid crew and training version are required.' using errcode = '22023';
  end if;
  if not private.crew_training_access_allowed(target_crew_id, caller_id) then
    raise exception 'Crew training is available only to the active crew creator.' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'crew-training:' || caller_id::text || ':' || target_crew_id::text || ':' || target_content_version::text,
      822
    )
  );

  -- Revalidate after waiting so delete/account-erasure cannot leave a stale claim.
  if not private.crew_training_access_allowed(target_crew_id, caller_id) then
    raise exception 'This crew is no longer available for training.' using errcode = '42501';
  end if;

  select source_row.* into progress_row
  from private.crew_training_progress source_row
  where source_row.user_id = caller_id
    and source_row.crew_id = target_crew_id
    and source_row.content_version = target_content_version
  for update;

  mutation_time := greatest(
    coalesce(progress_row.updated_at, '-infinity'::timestamptz),
    pg_catalog.clock_timestamp()
  );

  if not found then
    insert into private.crew_training_progress (
      crew_id, user_id, content_version, status, current_step, furthest_step,
      started_at, updated_at
    ) values (
      target_crew_id, caller_id, target_content_version,
      'in_progress', 0, 0, mutation_time, mutation_time
    )
    returning * into progress_row;
    claimed_now := true;
  elsif progress_row.status = 'not_started' then
    update private.crew_training_progress
    set status = 'in_progress',
        started_at = mutation_time,
        updated_at = mutation_time
    where user_id = caller_id
      and crew_id = target_crew_id
      and content_version = target_content_version
    returning * into progress_row;
    claimed_now := true;
  end if;

  return private.crew_training_progress_payload(progress_row, claimed_now);
end;
$$;

create or replace function public.advance_crew_training(
  target_crew_id uuid,
  target_content_version integer,
  target_action text,
  target_step integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  normalized_action text := pg_catalog.lower(pg_catalog.btrim(coalesce(target_action, '')));
  progress_row private.crew_training_progress%rowtype;
  mutation_time timestamptz;
begin
  if caller_id is null then
    raise exception 'You need to log in to update crew training.' using errcode = '28000';
  end if;
  if target_crew_id is null
     or target_content_version is distinct from 1
     or target_step is null
     or target_step not between 0 and 6 then
    raise exception 'A valid crew, training version, and step are required.' using errcode = '22023';
  end if;
  if normalized_action not in ('advance', 'skip', 'resume', 'complete') then
    raise exception 'Unsupported crew training action.' using errcode = '22023';
  end if;
  if not private.crew_training_access_allowed(target_crew_id, caller_id) then
    raise exception 'Crew training is available only to the active crew creator.' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'crew-training:' || caller_id::text || ':' || target_crew_id::text || ':' || target_content_version::text,
      822
    )
  );

  if not private.crew_training_access_allowed(target_crew_id, caller_id) then
    raise exception 'This crew is no longer available for training.' using errcode = '42501';
  end if;

  select source_row.* into progress_row
  from private.crew_training_progress source_row
  where source_row.user_id = caller_id
    and source_row.crew_id = target_crew_id
    and source_row.content_version = target_content_version
  for update;

  if not found then
    raise exception 'Start crew training before updating its progress.' using errcode = '55000';
  end if;

  -- Completion is terminal for this content version. Stale tabs and retries
  -- receive the authoritative record without changing timestamps or status.
  if progress_row.status = 'completed' then
    return private.crew_training_progress_payload(progress_row, null);
  end if;

  -- clock_timestamp() is captured after both locks. Unlike now(), it cannot
  -- regress when an older transaction waits behind a newer tab or device.
  mutation_time := greatest(progress_row.updated_at, pg_catalog.clock_timestamp());

  if normalized_action = 'advance' then
    if progress_row.status <> 'in_progress' then
      raise exception 'Resume crew training before advancing.' using errcode = '55000';
    end if;
    if target_step > progress_row.furthest_step + 1 then
      raise exception 'Crew training steps must be completed in order.' using errcode = '22023';
    end if;
    if target_step <= progress_row.furthest_step then
      return private.crew_training_progress_payload(progress_row, null);
    end if;
    update private.crew_training_progress
    set current_step = target_step,
        furthest_step = target_step,
        updated_at = mutation_time
    where user_id = caller_id
      and crew_id = target_crew_id
      and content_version = target_content_version
    returning * into progress_row;

  elsif normalized_action = 'skip' then
    if progress_row.status not in ('in_progress', 'skipped') then
      raise exception 'Start crew training before skipping it.' using errcode = '55000';
    end if;
    if target_step > progress_row.furthest_step then
      raise exception 'Only the current crew training step can be skipped.' using errcode = '22023';
    end if;
    if target_step < progress_row.current_step then
      return private.crew_training_progress_payload(progress_row, null);
    end if;
    if progress_row.status = 'skipped' then
      return private.crew_training_progress_payload(progress_row, null);
    end if;
    update private.crew_training_progress
    set status = 'skipped',
        skipped_at = coalesce(skipped_at, mutation_time),
        updated_at = mutation_time
    where user_id = caller_id
      and crew_id = target_crew_id
      and content_version = target_content_version
    returning * into progress_row;

  elsif normalized_action = 'resume' then
    if progress_row.status not in ('skipped', 'in_progress') then
      raise exception 'This crew training cannot be resumed.' using errcode = '55000';
    end if;
    if target_step > progress_row.furthest_step then
      raise exception 'Crew training cannot resume beyond saved progress.' using errcode = '22023';
    end if;
    if progress_row.status = 'in_progress' then
      return private.crew_training_progress_payload(progress_row, null);
    end if;
    update private.crew_training_progress
    set status = 'in_progress',
        current_step = furthest_step,
        updated_at = mutation_time
    where user_id = caller_id
      and crew_id = target_crew_id
      and content_version = target_content_version
    returning * into progress_row;

  else
    if progress_row.status not in ('in_progress', 'skipped')
       or target_step <> 6
       or progress_row.current_step <> 6
       or progress_row.furthest_step <> 6 then
      raise exception 'Finish the final crew training step before completing it.' using errcode = '55000';
    end if;
    update private.crew_training_progress
    set status = 'completed',
        completed_at = mutation_time,
        updated_at = mutation_time
    where user_id = caller_id
      and crew_id = target_crew_id
      and content_version = target_content_version
    returning * into progress_row;
  end if;

  return private.crew_training_progress_payload(progress_row, null);
end;
$$;

revoke all on function private.crew_training_access_allowed(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.crew_training_progress_payload(private.crew_training_progress, boolean)
  from public, anon, authenticated, service_role;

revoke all on function public.get_crew_training_progress(uuid, integer)
  from public, anon, authenticated;
revoke all on function public.claim_crew_training(uuid, integer)
  from public, anon, authenticated;
revoke all on function public.advance_crew_training(uuid, integer, text, integer)
  from public, anon, authenticated;

grant execute on function public.get_crew_training_progress(uuid, integer) to authenticated;
grant execute on function public.claim_crew_training(uuid, integer) to authenticated;
grant execute on function public.advance_crew_training(uuid, integer, text, integer) to authenticated;

comment on table private.crew_training_progress is
  'Versioned, privacy-minimal creator walkthrough status. Membership deletion cascades remove stale progress.';
comment on function public.claim_crew_training(uuid, integer) is
  'Atomically claims one creator walkthrough start across retries, tabs, and devices.';
comment on function public.advance_crew_training(uuid, integer, text, integer) is
  'Persists monotonic walkthrough progress without mutating any crew, invitation, provider, consent, or delivery state.';
