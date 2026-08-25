-- FOU-821: enforce one active crew per account and expose all lifecycle
-- mutations through race-safe, idempotent RPCs.

set local lock_timeout = '10s';
set local statement_timeout = '120s';

alter table public.crews
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references auth.users(id) on delete set null;

-- Existing duplicates require an explicit product/support decision. Never make
-- that decision inside a deploy by silently discarding a membership.
do $$
declare
  offender_count integer;
  offender_examples text;
begin
  select count(*) into offender_count
  from (
    select member_row.user_id
    from public.crew_members member_row
    group by member_row.user_id
    having count(*) > 1
  ) offenders;

  select string_agg(
      format('%s (%s crews)', offender.user_id, offender.crew_count),
      ', ' order by offender.user_id
    )
    into offender_examples
  from (
    select member_row.user_id, count(*) as crew_count
    from public.crew_members member_row
    group by member_row.user_id
    having count(*) > 1
    order by member_row.user_id
    limit 20
  ) offender;

  if offender_count > 0 then
    raise exception
      'Cannot enforce one active crew per user: % account(s) have multiple crew memberships.',
      offender_count
      using
        errcode = '23514',
        detail = coalesce(offender_examples, 'Duplicate memberships were found.'),
        hint = 'Resolve every multi-crew account explicitly, then rerun this migration. No membership was deleted automatically.';
  end if;
end;
$$;

create unique index if not exists crew_members_one_crew_per_user_idx
  on public.crew_members (user_id);

create table if not exists private.crew_lifecycle_requests (
  request_id uuid primary key,
  actor_id uuid not null,
  crew_id uuid not null,
  action text not null check (action in ('create', 'delete', 'leave')),
  request_hash bytea not null check (octet_length(request_hash) = 32),
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists crew_lifecycle_requests_actor_created_idx
  on private.crew_lifecycle_requests (actor_id, created_at desc);

alter table private.crew_lifecycle_requests enable row level security;
revoke all on table private.crew_lifecycle_requests
  from public, anon, authenticated, service_role;
grant select on table private.crew_lifecycle_requests to service_role;

create or replace function public.is_crew_member(target_crew_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1
    from private.retired_community_dr_quarantined_crews quarantine
    where quarantine.crew_id = target_crew_id
  ) and exists (
    select 1
    from public.crew_members member_row
    join public.crews crew_row on crew_row.id = member_row.crew_id
    where member_row.crew_id = target_crew_id
      and member_row.user_id = (select auth.uid())
      and crew_row.deleted_at is null
  );
$$;

create or replace function public.can_manage_crew(target_crew_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1
    from private.retired_community_dr_quarantined_crews quarantine
    where quarantine.crew_id = target_crew_id
  ) and exists (
    select 1
    from public.crew_members member_row
    join public.crews crew_row on crew_row.id = member_row.crew_id
    where member_row.crew_id = target_crew_id
      and member_row.user_id = (select auth.uid())
      and member_row.role in ('owner', 'admin')
      and crew_row.deleted_at is null
  );
$$;

create or replace function public.create_crew(
  target_request_id uuid,
  target_name text,
  target_description text default '',
  target_challenge_start_date date default null
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
  caller_id uuid := (select auth.uid());
  payload_hash bytea;
  prior_request private.crew_lifecycle_requests%rowtype;
  created_crew public.crews%rowtype;
  member_name text;
  member_avatar_url text;
  response_payload jsonb;
begin
  if caller_id is null then
    raise exception 'You need to log in to create a crew.' using errcode = '28000';
  end if;
  if target_request_id is null then
    raise exception 'A request ID is required.' using errcode = '22023';
  end if;
  if char_length(trim(coalesce(target_name, ''))) not between 2 and 80 then
    raise exception 'Crew name must be between 2 and 80 characters.' using errcode = '22023';
  end if;
  if char_length(coalesce(target_description, '')) > 2000 then
    raise exception 'Crew description must be 2,000 characters or fewer.' using errcode = '22023';
  end if;
  if not public.has_active_entitlement('membership_active') then
    raise exception 'An active subscription is required to create a crew.' using errcode = '42501';
  end if;

  payload_hash := extensions.digest(
    pg_catalog.convert_to(
      pg_catalog.jsonb_build_array(
        trim(target_name),
        coalesce(target_description, ''),
        target_challenge_start_date
      )::text,
      'UTF8'
    ),
    'sha256'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('single-crew:' || caller_id::text, 821)
  );

  select request_row.* into prior_request
  from private.crew_lifecycle_requests request_row
  where request_row.request_id = target_request_id;

  if found then
    if prior_request.actor_id <> caller_id
       or prior_request.action <> 'create'
       or prior_request.request_hash <> payload_hash then
      raise exception 'This request ID was already used for another operation.' using errcode = '23505';
    end if;

    return query
      select crew_row.id,
             crew_row.name,
             crew_row.description,
             crew_row.challenge_start_date,
             crew_row.created_by,
             crew_row.created_at,
             member_row.joined_at,
             member_row.role,
             false
      from public.crews crew_row
      join public.crew_members member_row
        on member_row.crew_id = crew_row.id and member_row.user_id = caller_id
      where crew_row.id = prior_request.crew_id and crew_row.deleted_at is null;
    if not found then
      raise exception 'The original crew-creation request is no longer active.' using errcode = '55000';
    end if;
    return;
  end if;

  if exists (
    select 1 from public.crew_members member_row where member_row.user_id = caller_id
  ) then
    raise exception 'Leave or delete your current crew before creating another.' using errcode = '23505';
  end if;

  select coalesce(nullif(trim(profile_row.name), ''), 'Member'),
         coalesce(profile_row.avatar_url, '')
    into member_name, member_avatar_url
  from public.profiles profile_row
  where profile_row.user_id = caller_id;

  insert into public.crews (name, description, challenge_start_date, created_by)
  values (
    trim(target_name),
    coalesce(target_description, ''),
    target_challenge_start_date,
    caller_id
  )
  returning * into created_crew;

  insert into public.crew_members (crew_id, user_id, display_name, avatar_url, role)
  values (
    created_crew.id,
    caller_id,
    coalesce(member_name, 'Member'),
    coalesce(member_avatar_url, ''),
    'owner'
  );

  response_payload := pg_catalog.jsonb_build_object(
    'status', 'created',
    'crewId', created_crew.id,
    'createdNew', true
  );

  insert into private.crew_lifecycle_requests (
    request_id, actor_id, crew_id, action, request_hash, result
  ) values (
    target_request_id, caller_id, created_crew.id, 'create', payload_hash, response_payload
  );

  return query
    select created_crew.id,
           created_crew.name,
           created_crew.description,
           created_crew.challenge_start_date,
           created_crew.created_by,
           created_crew.created_at,
           member_row.joined_at,
           member_row.role,
           true
    from public.crew_members member_row
    where member_row.crew_id = created_crew.id and member_row.user_id = caller_id;
end;
$$;

create or replace function public.confirm_crew_invite(continuation_token text)
returns jsonb
language plpgsql
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
  redemption_id uuid;
  member_count integer;
  preview_payload jsonb;
begin
  if caller_id is null then
    return pg_catalog.jsonb_build_object('status', 'authentication_required');
  end if;

  if continuation_token is null
    or char_length(continuation_token) < 16
    or char_length(continuation_token) > 256
    or continuation_token !~ '^[A-Za-z0-9_-]+$' then
    return pg_catalog.jsonb_build_object('status', 'invalid');
  end if;

  -- This is the same per-account lock used by create_crew. It makes an invite
  -- redemption racing a crew creation deterministic; the unique index remains
  -- the final database authority.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('single-crew:' || caller_id::text, 821)
  );

  select source_session.*
    into session_row
    from public.crew_invite_sessions source_session
    where source_session.continuation_hash = public.crew_invite_secret_hash(continuation_token)
    limit 1
    for update;

  if not found then
    return pg_catalog.jsonb_build_object('status', 'invalid');
  end if;
  if session_row.expires_at <= pg_catalog.now() then
    return pg_catalog.jsonb_build_object('status', 'session_expired');
  end if;
  if session_row.bound_user_id is not null and session_row.bound_user_id <> caller_id then
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

  select source_crew.* into crew_row
  from public.crews source_crew
  where source_crew.id = invite_row.crew_id
    and source_crew.deleted_at is null
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('status', 'invalid');
  end if;

  select split_part(coalesce(nullif(trim(profile_row.name), ''), 'Dominion member'), ' ', 1)
    into inviter_first_name
  from public.profiles profile_row
  where profile_row.user_id = invite_row.created_by;

  preview_payload := pg_catalog.jsonb_build_object(
    'groupName', crew_row.name,
    'inviterName', coalesce(inviter_first_name, 'Dominion member'),
    'expiresAt', invite_row.expires_at
  );

  if exists (
    select 1 from public.crew_members member_row
    where member_row.crew_id = invite_row.crew_id and member_row.user_id = caller_id
  ) then
    return pg_catalog.jsonb_build_object(
      'status', 'already_member', 'preview', preview_payload
    );
  end if;
  if invite_row.redeemed_by is not null then
    return pg_catalog.jsonb_build_object('status', 'already_used');
  end if;
  if not public.has_active_entitlement('membership_active') then
    return pg_catalog.jsonb_build_object('status', 'subscription_required');
  end if;

  select count(*)::integer into member_count
  from public.crew_members member_row
  where member_row.crew_id = invite_row.crew_id;
  if member_count >= crew_row.member_limit then
    return pg_catalog.jsonb_build_object('status', 'full');
  end if;

  if exists (
    select 1 from public.crew_invite_attributions attribution
    where attribution.crew_id = invite_row.crew_id
      and attribution.recipient_user_id = caller_id
  ) then
    return pg_catalog.jsonb_build_object('status', 'already_used');
  end if;

  if exists (
    select 1 from public.crew_members member_row
    where member_row.user_id = caller_id
  ) then
    return pg_catalog.jsonb_build_object(
      'status', 'current_crew_conflict',
      'preview', preview_payload
    );
  end if;

  select coalesce(nullif(profile_row.name, ''), 'Member'),
         coalesce(profile_row.avatar_url, '')
    into member_name, member_avatar_url
  from public.profiles profile_row
  where profile_row.user_id = caller_id;

  insert into public.crew_members (crew_id, user_id, display_name, avatar_url, role)
  values (
    invite_row.crew_id,
    caller_id,
    coalesce(member_name, 'Member'),
    coalesce(member_avatar_url, ''),
    'member'
  );

  insert into public.crew_invite_attributions (
    invite_id, crew_id, inviter_user_id, recipient_user_id
  ) values (
    invite_row.id, invite_row.crew_id, invite_row.created_by, caller_id
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

-- Delete and leave intentionally do not require a current entitlement. A
-- lapsed subscriber must always retain a safe path out of a crew.
create or replace function public.delete_crew(
  target_crew_id uuid,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  payload_hash bytea;
  prior_request private.crew_lifecycle_requests%rowtype;
  crew_row public.crews%rowtype;
  membership_role text;
  retention_result jsonb;
  result_payload jsonb;
begin
  if caller_id is null then
    raise exception 'You need to log in to delete a crew.' using errcode = '28000';
  end if;
  if target_crew_id is null or target_request_id is null then
    raise exception 'Crew and request IDs are required.' using errcode = '22023';
  end if;

  payload_hash := extensions.digest(
    pg_catalog.convert_to(
      pg_catalog.jsonb_build_array('delete', target_crew_id)::text,
      'UTF8'
    ),
    'sha256'
  );

  -- The retention worker always acquires this global lock before it can touch
  -- crew or membership rows during account erasure. Preserve that hierarchy
  -- here so group deletion cannot hold a crew row while waiting on retention.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('retired-community-deletion', 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('single-crew:' || caller_id::text, 821)
  );

  select request_row.* into prior_request
  from private.crew_lifecycle_requests request_row
  where request_row.request_id = target_request_id;
  if found then
    if prior_request.actor_id <> caller_id
       or prior_request.crew_id <> target_crew_id
       or prior_request.action <> 'delete'
       or prior_request.request_hash <> payload_hash then
      raise exception 'This request ID was already used for another operation.' using errcode = '23505';
    end if;
    return prior_request.result;
  end if;

  -- Confirming an invite locks invite -> crew. Authorize provisionally, then
  -- take the same lock order here so a confirmation racing deletion cannot
  -- deadlock. Authorization is repeated under row locks below before mutation.
  select member_row.role into membership_role
  from public.crew_members member_row
  join public.crews source_crew on source_crew.id = member_row.crew_id
  where member_row.crew_id = target_crew_id
    and member_row.user_id = caller_id
    and source_crew.deleted_at is null;
  if membership_role is null or membership_role not in ('owner', 'admin') then
    raise exception 'Only a crew owner or admin can delete this crew.' using errcode = '42501';
  end if;

  perform 1
  from public.crew_invites invite_row
  where invite_row.crew_id = target_crew_id
  order by invite_row.id
  for update;

  select source_crew.* into crew_row
  from public.crews source_crew
  where source_crew.id = target_crew_id
  for update;
  if not found or crew_row.deleted_at is not null then
    raise exception 'This crew is no longer available.' using errcode = '22023';
  end if;

  select member_row.role into membership_role
  from public.crew_members member_row
  where member_row.crew_id = target_crew_id
    and member_row.user_id = caller_id
  for update;
  if membership_role is null or membership_role not in ('owner', 'admin') then
    raise exception 'Only a crew owner or admin can delete this crew.' using errcode = '42501';
  end if;

  select private.retired_community_batch_result(batch_row.id)
    into retention_result
  from private.retired_community_deletion_batches batch_row
  where batch_row.reason = 'group_deletion'
    and batch_row.crew_id = target_crew_id
    and batch_row.sealed
    and not exists (
      select 1
      from private.retired_community_deletion_ledger terminal
      where terminal.batch_id = batch_row.id
        and terminal.event_type in ('cancelled', 'executed')
    )
  order by batch_row.requested_at desc
  limit 1;

  if retention_result is null then
    retention_result := public.request_retired_community_group_deletion(
      target_crew_id,
      false
    );
  end if;

  update public.crew_invites
  set revoked_at = coalesce(revoked_at, pg_catalog.now())
  where crew_id = target_crew_id and revoked_at is null;

  update private.outbound_deliveries
  set status = 'cancelled',
      cancelled_at = coalesce(cancelled_at, pg_catalog.now()),
      lock_token = null,
      locked_at = null,
      last_error_code = 'crew_deleted',
      last_error_summary = 'Delivery cancelled because the crew was deleted.',
      updated_at = pg_catalog.now()
  where crew_id = target_crew_id
    and status in ('queued', 'processing', 'retry');

  -- FOU-559 credential evidence must remain intact until the provider worker
  -- revokes and confirms it. Disable delivery now without clearing ciphertext.
  update private.integration_destinations
  set status = 'revoked',
      disconnected_at = coalesce(disconnected_at, pg_catalog.now()),
      last_error_code = 'crew_deleted',
      last_error_summary = 'Destination disabled because the crew was deleted.',
      updated_at = pg_catalog.now()
  where crew_id = target_crew_id and status <> 'revoked';

  delete from private.integration_oauth_states where crew_id = target_crew_id;
  delete from private.pending_integration_connections where crew_id = target_crew_id;

  update public.crews
  set deleted_at = pg_catalog.now(),
      deleted_by = caller_id,
      updated_at = pg_catalog.now()
  where id = target_crew_id;

  delete from public.crew_members where crew_id = target_crew_id;

  result_payload := pg_catalog.jsonb_build_object(
    'status', 'deleted',
    'crewId', target_crew_id,
    'retention', retention_result
  );

  insert into private.crew_lifecycle_requests (
    request_id, actor_id, crew_id, action, request_hash, result
  ) values (
    target_request_id,
    caller_id,
    target_crew_id,
    'delete',
    payload_hash,
    result_payload
  );

  return result_payload;
end;
$$;

create or replace function public.leave_crew(
  target_crew_id uuid,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  payload_hash bytea;
  prior_request private.crew_lifecycle_requests%rowtype;
  membership_role text;
  result_payload jsonb;
begin
  if caller_id is null then
    raise exception 'You need to log in to leave a crew.' using errcode = '28000';
  end if;
  if target_crew_id is null or target_request_id is null then
    raise exception 'Crew and request IDs are required.' using errcode = '22023';
  end if;

  payload_hash := extensions.digest(
    pg_catalog.convert_to(
      pg_catalog.jsonb_build_array('leave', target_crew_id)::text,
      'UTF8'
    ),
    'sha256'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('single-crew:' || caller_id::text, 821)
  );

  select request_row.* into prior_request
  from private.crew_lifecycle_requests request_row
  where request_row.request_id = target_request_id;
  if found then
    if prior_request.actor_id <> caller_id
       or prior_request.crew_id <> target_crew_id
       or prior_request.action <> 'leave'
       or prior_request.request_hash <> payload_hash then
      raise exception 'This request ID was already used for another operation.' using errcode = '23505';
    end if;
    return prior_request.result;
  end if;

  perform 1
  from public.crews crew_row
  where crew_row.id = target_crew_id and crew_row.deleted_at is null
  for update;
  if not found then
    raise exception 'This crew is no longer available.' using errcode = '22023';
  end if;

  select member_row.role into membership_role
  from public.crew_members member_row
  where member_row.crew_id = target_crew_id
    and member_row.user_id = caller_id
  for update;
  if membership_role is null then
    raise exception 'You are not a member of this crew.' using errcode = '42501';
  end if;
  if membership_role in ('owner', 'admin') then
    raise exception 'Crew owners and admins must delete the crew instead of leaving it.' using errcode = '42501';
  end if;

  delete from public.crew_members
  where crew_id = target_crew_id and user_id = caller_id;

  result_payload := pg_catalog.jsonb_build_object(
    'status', 'left',
    'crewId', target_crew_id
  );

  insert into private.crew_lifecycle_requests (
    request_id, actor_id, crew_id, action, request_hash, result
  ) values (
    target_request_id,
    caller_id,
    target_crew_id,
    'leave',
    payload_hash,
    result_payload
  );

  return result_payload;
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

revoke insert, update, delete on table public.crews from authenticated;
grant select on table public.crews to authenticated;
grant update (name, description, challenge_start_date) on table public.crews to authenticated;

revoke insert, update, delete on table public.crew_members from authenticated;
grant select on table public.crew_members to authenticated;

revoke all on function public.is_crew_member(uuid) from public, anon, authenticated;
revoke all on function public.can_manage_crew(uuid) from public, anon, authenticated;
revoke all on function public.create_crew(uuid, text, text, date) from public, anon, authenticated;
revoke all on function public.confirm_crew_invite(text) from public, anon, authenticated;
revoke all on function public.delete_crew(uuid, uuid) from public, anon, authenticated;
revoke all on function public.leave_crew(uuid, uuid) from public, anon, authenticated;

grant execute on function public.is_crew_member(uuid) to authenticated;
grant execute on function public.can_manage_crew(uuid) to authenticated;
grant execute on function public.create_crew(uuid, text, text, date) to authenticated;
grant execute on function public.confirm_crew_invite(text) to authenticated;
grant execute on function public.delete_crew(uuid, uuid) to authenticated;
grant execute on function public.leave_crew(uuid, uuid) to authenticated;

comment on table private.crew_lifecycle_requests is
  'Server-only idempotency and audit evidence for crew create, delete, and leave mutations.';
comment on function public.delete_crew(uuid, uuid) is
  'Immediately removes group access and delivery while retaining FOU-559 deletion evidence for the 30-day worker flow.';
