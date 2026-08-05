-- FOU-821 / FOU-822: one active crew per user, retained crew history,
-- idempotent lifecycle RPCs, and creator-only versioned training progress.

alter table public.crews
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references auth.users(id) on delete set null;

do $$
declare
  offender_count integer;
  offender_examples text;
begin
  select count(*) into offender_count
  from (
    select cm.user_id
    from public.crew_members cm
    group by cm.user_id
    having count(*) > 1
  ) offenders;

  select string_agg(format('%s (%s crews)', user_id, crew_count), ', ' order by user_id)
    into offender_examples
  from (
    select cm.user_id, count(*) as crew_count
    from public.crew_members cm
    group by cm.user_id
    having count(*) > 1
    order by cm.user_id
    limit 20
  ) offenders;

  if offender_count > 0 then
    raise exception 'Cannot enforce one active crew per user: % account(s) have multiple crew memberships.', offender_count
      using
        errcode = '23514',
        detail = coalesce(offender_examples, 'Duplicate memberships were found.'),
        hint = 'Resolve every multi-crew account explicitly, then rerun this migration. No membership was deleted automatically.';
  end if;
end;
$$;

create unique index if not exists crew_members_one_crew_per_user_idx
  on public.crew_members (user_id);

create table if not exists public.crew_lifecycle_events (
  request_id uuid primary key,
  crew_id uuid not null,
  actor_id uuid not null,
  action text not null check (action in ('create', 'delete', 'leave')),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists crew_lifecycle_events_actor_created_idx
  on public.crew_lifecycle_events (actor_id, created_at desc);

create table if not exists public.crew_training_progress (
  crew_id uuid not null references public.crews(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  content_version integer not null check (content_version > 0),
  status text not null default 'not_started'
    check (status in ('not_started', 'in_progress', 'skipped', 'completed')),
  current_step integer not null default 0 check (current_step between 0 and 6),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (crew_id, user_id, content_version)
);

create index if not exists crew_training_progress_user_updated_idx
  on public.crew_training_progress (user_id, updated_at desc);

alter table public.crew_lifecycle_events enable row level security;
alter table public.crew_training_progress enable row level security;

revoke all on public.crew_lifecycle_events from public, anon, authenticated;
revoke all on public.crew_training_progress from public, anon, authenticated;
grant select, insert, update, delete on public.crew_lifecycle_events to service_role;
grant select, insert, update, delete on public.crew_training_progress to service_role;

create or replace function public.is_crew_member(target_crew_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.crew_members cm
    join public.crews c on c.id = cm.crew_id
    where cm.crew_id = target_crew_id
      and cm.user_id = (select auth.uid())
      and c.deleted_at is null
  );
$$;

create or replace function public.can_manage_crew(target_crew_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.crew_members cm
    join public.crews c on c.id = cm.crew_id
    where cm.crew_id = target_crew_id
      and cm.user_id = (select auth.uid())
      and cm.role in ('owner', 'admin')
      and c.deleted_at is null
  );
$$;

create or replace function public.create_crew(
  request_id uuid,
  crew_name text,
  crew_description text default '',
  crew_challenge_start_date date default null
)
returns table (
  crew_id uuid,
  name text,
  description text,
  challenge_start_date date,
  created_by uuid,
  created_at timestamptz,
  joined_at timestamptz,
  role text,
  created_new boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  existing_event public.crew_lifecycle_events%rowtype;
  created_crew public.crews%rowtype;
  member_name text;
  member_avatar_url text;
begin
  if current_user_id is null then
    raise exception 'You need to log in to create a crew.' using errcode = '28000';
  end if;
  if request_id is null then
    raise exception 'A request ID is required.' using errcode = '22023';
  end if;
  if not public.has_active_entitlement('membership_active') then
    raise exception 'An active subscription is required to create a crew.' using errcode = '42501';
  end if;
  if char_length(trim(coalesce(crew_name, ''))) not between 2 and 80 then
    raise exception 'Crew name must be between 2 and 80 characters.' using errcode = '22023';
  end if;
  if char_length(coalesce(crew_description, '')) > 2000 then
    raise exception 'Crew description must be 2,000 characters or fewer.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(current_user_id::text, 821));

  select event.* into existing_event
  from public.crew_lifecycle_events event
  where event.request_id = create_crew.request_id;

  if found then
    if existing_event.actor_id <> current_user_id or existing_event.action <> 'create' then
      raise exception 'This request ID was already used for another operation.' using errcode = '23505';
    end if;
    if existing_event.metadata ->> 'name' is distinct from trim(crew_name)
       or existing_event.metadata ->> 'description' is distinct from coalesce(crew_description, '')
       or existing_event.metadata ->> 'challenge_start_date' is distinct from crew_challenge_start_date::text then
      raise exception 'This request ID was already used with different crew data.' using errcode = '23505';
    end if;
    return query
      select c.id, c.name, c.description, c.challenge_start_date, c.created_by, c.created_at,
             cm.joined_at, cm.role, false
      from public.crews c
      join public.crew_members cm on cm.crew_id = c.id and cm.user_id = current_user_id
      where c.id = existing_event.crew_id and c.deleted_at is null;
    if not found then
      raise exception 'The original crew-creation request is no longer active.' using errcode = '55000';
    end if;
    return;
  end if;

  if exists (select 1 from public.crew_members cm where cm.user_id = current_user_id) then
    raise exception 'Leave or delete your current crew before creating another.' using errcode = '23505';
  end if;

  select coalesce(nullif(trim(p.name), ''), 'Member'), coalesce(p.avatar_url, '')
    into member_name, member_avatar_url
  from public.profiles p
  where p.user_id = current_user_id;

  insert into public.crews (name, description, challenge_start_date, created_by)
  values (trim(crew_name), coalesce(crew_description, ''), crew_challenge_start_date, current_user_id)
  returning * into created_crew;

  insert into public.crew_members (crew_id, user_id, display_name, avatar_url, role)
  values (
    created_crew.id,
    current_user_id,
    coalesce(member_name, 'Member'),
    coalesce(member_avatar_url, ''),
    'owner'
  );

  insert into public.crew_training_progress (crew_id, user_id, content_version)
  values (created_crew.id, current_user_id, 1);

  insert into public.crew_lifecycle_events (request_id, crew_id, actor_id, action, metadata)
  values (
    create_crew.request_id,
    created_crew.id,
    current_user_id,
    'create',
    pg_catalog.jsonb_build_object(
      'name', created_crew.name,
      'description', created_crew.description,
      'challenge_start_date', created_crew.challenge_start_date
    )
  );

  return query
    select created_crew.id, created_crew.name, created_crew.description,
           created_crew.challenge_start_date, created_crew.created_by, created_crew.created_at,
           cm.joined_at, cm.role, true
    from public.crew_members cm
    where cm.crew_id = created_crew.id and cm.user_id = current_user_id;
end;
$$;

create or replace function public.preview_crew_invite(invite_token text)
returns table (
  crew_id uuid,
  name text,
  inviter_name text,
  has_other_crew boolean,
  already_member boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
begin
  if current_user_id is null then
    raise exception 'You need to log in to view this invitation.' using errcode = '28000';
  end if;
  if not public.has_active_entitlement('membership_active') then
    raise exception 'An active subscription is required to join a crew.' using errcode = '42501';
  end if;

  return query
    select c.id,
           c.name,
           coalesce(nullif(trim(p.name), ''), 'A crew admin'),
           exists (
             select 1 from public.crew_members mine
             where mine.user_id = current_user_id and mine.crew_id <> c.id
           ),
           exists (
             select 1 from public.crew_members mine
             where mine.user_id = current_user_id and mine.crew_id = c.id
           )
    from public.crew_invites ci
    join public.crews c on c.id = ci.crew_id and c.deleted_at is null
    left join public.profiles p on p.user_id = ci.created_by
    where ci.token = invite_token
      and ci.revoked_at is null
      and ci.expires_at > pg_catalog.now()
    limit 1;

  if not found then
    raise exception 'This invite is invalid or expired.' using errcode = '22023';
  end if;
end;
$$;

create or replace function public.join_crew_by_invite(invite_token text)
returns table (
  crew_id uuid,
  name text,
  description text,
  challenge_start_date date
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  target_crew public.crews%rowtype;
  existing_crew_id uuid;
  member_name text;
  member_avatar_url text;
begin
  if current_user_id is null then
    raise exception 'You need to log in to join this crew.' using errcode = '28000';
  end if;
  if not public.has_active_entitlement('membership_active') then
    raise exception 'An active subscription is required to join a crew.' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(current_user_id::text, 821));

  select c.* into target_crew
  from public.crew_invites ci
  join public.crews c on c.id = ci.crew_id
  where ci.token = invite_token
    and ci.revoked_at is null
    and ci.expires_at > pg_catalog.now()
    and c.deleted_at is null
  limit 1
  for update of ci, c;

  if target_crew.id is null then
    raise exception 'This invite is invalid or expired.' using errcode = '22023';
  end if;

  select cm.crew_id into existing_crew_id
  from public.crew_members cm
  where cm.user_id = current_user_id;

  if existing_crew_id is not null and existing_crew_id <> target_crew.id then
    raise exception 'Leave or delete your current crew before joining another.' using errcode = '23505';
  end if;

  if existing_crew_id is null then
    select coalesce(nullif(trim(p.name), ''), 'Member'), coalesce(p.avatar_url, '')
      into member_name, member_avatar_url
    from public.profiles p
    where p.user_id = current_user_id;

    insert into public.crew_members (crew_id, user_id, display_name, avatar_url, role)
    values (
      target_crew.id,
      current_user_id,
      coalesce(member_name, 'Member'),
      coalesce(member_avatar_url, ''),
      'member'
    );
  end if;

  return query
    select target_crew.id, target_crew.name, target_crew.description, target_crew.challenge_start_date;
end;
$$;

-- Delete and leave intentionally require authentication and a freshly locked
-- membership role, but not an active entitlement. A lapsed subscriber must
-- still be able to remove their crew access instead of becoming trapped.
create or replace function public.delete_crew(target_crew_id uuid, request_id uuid)
returns table (crew_id uuid, action text, completed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  existing_event public.crew_lifecycle_events%rowtype;
  target_crew public.crews%rowtype;
  membership_role text;
begin
  if current_user_id is null then
    raise exception 'You need to log in to delete a crew.' using errcode = '28000';
  end if;
  if target_crew_id is null or request_id is null then
    raise exception 'Crew and request IDs are required.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(current_user_id::text, 821));

  select event.* into existing_event
  from public.crew_lifecycle_events event
  where event.request_id = delete_crew.request_id;
  if found then
    if existing_event.actor_id <> current_user_id
       or existing_event.action <> 'delete'
       or existing_event.crew_id <> target_crew_id then
      raise exception 'This request ID was already used for another operation.' using errcode = '23505';
    end if;
    return query select target_crew_id, 'delete'::text, true;
    return;
  end if;

  select c.* into target_crew
  from public.crews c
  where c.id = target_crew_id
  for update;
  if target_crew.id is null or target_crew.deleted_at is not null then
    raise exception 'This crew is no longer available.' using errcode = '22023';
  end if;

  select cm.role into membership_role
  from public.crew_members cm
  where cm.crew_id = target_crew_id and cm.user_id = current_user_id
  for update;
  if membership_role is null or membership_role not in ('owner', 'admin') then
    raise exception 'Only a crew owner or admin can delete this crew.' using errcode = '42501';
  end if;

  insert into public.crew_lifecycle_events (request_id, crew_id, actor_id, action)
  values (delete_crew.request_id, target_crew_id, current_user_id, 'delete');

  update public.crew_invites
  set revoked_at = coalesce(revoked_at, pg_catalog.now())
  where crew_id = target_crew_id and revoked_at is null;

  if pg_catalog.to_regclass('private.outbound_deliveries') is not null then
    execute $sql$
      update private.outbound_deliveries
      set status = 'cancelled',
          cancelled_at = coalesce(cancelled_at, now()),
          lock_token = null,
          locked_at = null,
          last_error_code = 'crew_deleted',
          last_error_summary = 'Delivery cancelled because the crew was deleted.',
          updated_at = now()
      where crew_id = $1 and status in ('queued', 'processing', 'retry')
    $sql$ using target_crew_id;
  end if;

  if pg_catalog.to_regclass('private.integration_destinations') is not null then
    execute $sql$
      update private.integration_destinations
      set status = 'revoked',
          disconnected_at = coalesce(disconnected_at, now()),
          last_error_code = 'crew_deleted',
          last_error_summary = 'Destination disabled because the crew was deleted.',
          updated_at = now()
      where crew_id = $1 and status <> 'revoked'
    $sql$ using target_crew_id;
  end if;

  if pg_catalog.to_regclass('private.integration_oauth_states') is not null then
    execute 'delete from private.integration_oauth_states where crew_id = $1' using target_crew_id;
  end if;
  if pg_catalog.to_regclass('private.pending_integration_connections') is not null then
    execute 'delete from private.pending_integration_connections where crew_id = $1' using target_crew_id;
  end if;

  update public.crews
  set deleted_at = pg_catalog.now(), deleted_by = current_user_id, updated_at = pg_catalog.now()
  where id = target_crew_id;

  delete from public.crew_members where crew_id = target_crew_id;

  return query select target_crew_id, 'delete'::text, true;
end;
$$;

create or replace function public.leave_crew(target_crew_id uuid, request_id uuid)
returns table (crew_id uuid, action text, completed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  existing_event public.crew_lifecycle_events%rowtype;
  membership_role text;
begin
  if current_user_id is null then
    raise exception 'You need to log in to leave a crew.' using errcode = '28000';
  end if;
  if target_crew_id is null or request_id is null then
    raise exception 'Crew and request IDs are required.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(current_user_id::text, 821));

  select event.* into existing_event
  from public.crew_lifecycle_events event
  where event.request_id = leave_crew.request_id;
  if found then
    if existing_event.actor_id <> current_user_id
       or existing_event.action <> 'leave'
       or existing_event.crew_id <> target_crew_id then
      raise exception 'This request ID was already used for another operation.' using errcode = '23505';
    end if;
    return query select target_crew_id, 'leave'::text, true;
    return;
  end if;

  perform 1
  from public.crews c
  where c.id = target_crew_id and c.deleted_at is null
  for update;
  if not found then
    raise exception 'This crew is no longer available.' using errcode = '22023';
  end if;

  select cm.role into membership_role
  from public.crew_members cm
  where cm.crew_id = target_crew_id and cm.user_id = current_user_id
  for update;
  if membership_role is null then
    raise exception 'You are not a member of this crew.' using errcode = '42501';
  end if;
  if membership_role in ('owner', 'admin') then
    raise exception 'Crew owners and admins must delete the crew instead of leaving it.' using errcode = '42501';
  end if;

  insert into public.crew_lifecycle_events (request_id, crew_id, actor_id, action)
  values (leave_crew.request_id, target_crew_id, current_user_id, 'leave');

  delete from public.crew_members
  where crew_id = target_crew_id and user_id = current_user_id;

  return query select target_crew_id, 'leave'::text, true;
end;
$$;

create or replace function public.get_crew_training_progress(
  target_crew_id uuid,
  target_version integer default 1
)
returns table (
  crew_id uuid,
  content_version integer,
  status text,
  current_step integer,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
begin
  if current_user_id is null then
    raise exception 'You need to log in to view crew training.' using errcode = '28000';
  end if;
  if target_version <= 0 then
    raise exception 'Training version must be positive.' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.crews c
    join public.crew_members cm on cm.crew_id = c.id and cm.user_id = current_user_id
    where c.id = target_crew_id
      and c.created_by = current_user_id
      and c.deleted_at is null
      and cm.role = 'owner'
  ) then
    raise exception 'Only the crew creator can access this training.' using errcode = '42501';
  end if;

  insert into public.crew_training_progress (crew_id, user_id, content_version)
  values (target_crew_id, current_user_id, target_version)
  on conflict (crew_id, user_id, content_version) do nothing;

  return query
    select progress.crew_id, progress.content_version, progress.status, progress.current_step,
           progress.started_at, progress.completed_at, progress.updated_at
    from public.crew_training_progress progress
    where progress.crew_id = target_crew_id
      and progress.user_id = current_user_id
      and progress.content_version = target_version;
end;
$$;

create or replace function public.save_crew_training_progress(
  target_crew_id uuid,
  target_version integer,
  target_status text,
  target_step integer
)
returns table (
  crew_id uuid,
  content_version integer,
  status text,
  current_step integer,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
begin
  if current_user_id is null then
    raise exception 'You need to log in to save crew training.' using errcode = '28000';
  end if;
  if target_version <= 0
     or target_status not in ('not_started', 'in_progress', 'skipped', 'completed')
     or target_step not between 0 and 6 then
    raise exception 'Invalid crew training progress.' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.crews c
    join public.crew_members cm on cm.crew_id = c.id and cm.user_id = current_user_id
    where c.id = target_crew_id
      and c.created_by = current_user_id
      and c.deleted_at is null
      and cm.role = 'owner'
  ) then
    raise exception 'Only the crew creator can update this training.' using errcode = '42501';
  end if;

  insert into public.crew_training_progress (
    crew_id, user_id, content_version, status, current_step, started_at, completed_at, updated_at
  ) values (
    target_crew_id,
    current_user_id,
    target_version,
    target_status,
    target_step,
    case when target_status = 'not_started' then null else pg_catalog.now() end,
    case when target_status = 'completed' then pg_catalog.now() else null end,
    pg_catalog.now()
  )
  on conflict (crew_id, user_id, content_version) do update
  set status = excluded.status,
      current_step = excluded.current_step,
      started_at = case
        when excluded.status = 'not_started' then null
        else coalesce(public.crew_training_progress.started_at, excluded.started_at)
      end,
      completed_at = case when excluded.status = 'completed' then pg_catalog.now() else null end,
      updated_at = pg_catalog.now();

  return query
    select progress.crew_id, progress.content_version, progress.status, progress.current_step,
           progress.started_at, progress.completed_at, progress.updated_at
    from public.crew_training_progress progress
    where progress.crew_id = target_crew_id
      and progress.user_id = current_user_id
      and progress.content_version = target_version;
end;
$$;

drop policy if exists "Users can create own crews" on public.crews;

drop policy if exists "Crew members can read crews" on public.crews;
create policy "Crew members can read crews"
  on public.crews
  for select
  to authenticated
  using (
    deleted_at is null
    and public.has_active_entitlement('membership_active')
    and public.is_crew_member(id)
  );

drop policy if exists "Crew admins can update crews" on public.crews;
create policy "Crew admins can update crews"
  on public.crews
  for update
  to authenticated
  using (
    deleted_at is null
    and public.has_active_entitlement('membership_active')
    and public.can_manage_crew(id)
  )
  with check (
    deleted_at is null
    and public.has_active_entitlement('membership_active')
    and public.can_manage_crew(id)
  );

drop policy if exists "Crew owners can add themselves" on public.crew_members;

revoke insert, delete on public.crews from authenticated;
revoke update on public.crews from authenticated;
grant select on public.crews to authenticated;
grant update (name, description, challenge_start_date) on public.crews to authenticated;

revoke insert, update, delete on public.crew_members from authenticated;
grant select on public.crew_members to authenticated;

revoke all on function public.create_crew(uuid, text, text, date) from public, anon, authenticated;
revoke all on function public.preview_crew_invite(text) from public, anon, authenticated;
revoke all on function public.join_crew_by_invite(text) from public, anon, authenticated;
revoke all on function public.delete_crew(uuid, uuid) from public, anon, authenticated;
revoke all on function public.leave_crew(uuid, uuid) from public, anon, authenticated;
revoke all on function public.get_crew_training_progress(uuid, integer) from public, anon, authenticated;
revoke all on function public.save_crew_training_progress(uuid, integer, text, integer) from public, anon, authenticated;

grant execute on function public.create_crew(uuid, text, text, date) to authenticated;
grant execute on function public.preview_crew_invite(text) to authenticated;
grant execute on function public.join_crew_by_invite(text) to authenticated;
grant execute on function public.delete_crew(uuid, uuid) to authenticated;
grant execute on function public.leave_crew(uuid, uuid) to authenticated;
grant execute on function public.get_crew_training_progress(uuid, integer) to authenticated;
grant execute on function public.save_crew_training_progress(uuid, integer, text, integer) to authenticated;
