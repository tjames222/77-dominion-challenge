alter table private.integration_destinations
  alter column credential_ciphertext drop not null,
  alter column credential_nonce drop not null,
  alter column credential_key_version drop not null,
  alter column credential_fingerprint drop not null;

alter table private.integration_destinations
  add column if not exists provider_workspace_name text not null default ''
    check (char_length(provider_workspace_name) <= 200),
  add column if not exists last_tested_at timestamptz,
  add column if not exists last_delivered_at timestamptz;

alter table private.integration_destinations
  drop constraint if exists integration_destinations_active_credentials_check;
alter table private.integration_destinations
  add constraint integration_destinations_active_credentials_check check (
    status <> 'active'
    or (
      credential_ciphertext is not null
      and credential_nonce is not null
      and credential_key_version is not null
      and credential_fingerprint is not null
    )
  );

create unique index if not exists integration_destinations_crew_provider_unique
  on private.integration_destinations (crew_id, provider);

create table if not exists private.integration_oauth_states (
  nonce_hash text primary key check (nonce_hash ~ '^[a-f0-9]{64}$'),
  provider text not null check (provider in ('slack', 'discord')),
  crew_id uuid not null references public.crews(id) on delete cascade,
  initiated_by uuid not null references auth.users(id) on delete cascade,
  return_path text not null default '/community.html'
    check (return_path = '/community.html'),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists private.pending_integration_connections (
  id uuid primary key,
  setup_token_hash text not null unique check (setup_token_hash ~ '^[a-f0-9]{64}$'),
  provider text not null check (provider in ('slack', 'discord')),
  crew_id uuid not null references public.crews(id) on delete cascade,
  initiated_by uuid not null references auth.users(id) on delete cascade,
  provider_workspace_id text not null check (char_length(provider_workspace_id) between 1 and 200),
  provider_workspace_name text not null default '' check (char_length(provider_workspace_name) <= 200),
  credential_ciphertext bytea not null check (octet_length(credential_ciphertext) between 17 and 16384),
  credential_nonce bytea not null check (octet_length(credential_nonce) = 12),
  credential_key_version smallint not null check (credential_key_version > 0),
  credential_fingerprint text not null check (credential_fingerprint ~ '^[a-f0-9]{64}$'),
  scopes text[] not null default '{}',
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists private.integration_connection_audit (
  id bigint generated always as identity primary key,
  crew_id uuid not null references public.crews(id) on delete cascade,
  destination_id uuid references private.integration_destinations(id) on delete set null,
  actor_id uuid references auth.users(id) on delete set null,
  provider text not null check (provider in ('slack', 'discord')),
  action text not null check (
    action in (
      'authorization_started',
      'authorization_completed',
      'connected',
      'reconnected',
      'test_succeeded',
      'needs_attention',
      'disconnected'
    )
  ),
  outcome text not null default 'succeeded' check (outcome in ('succeeded', 'failed')),
  metadata jsonb not null default '{}'::jsonb check (
    jsonb_typeof(metadata) = 'object'
    and octet_length(metadata::text) <= 8192
  ),
  created_at timestamptz not null default now()
);

create index if not exists integration_oauth_states_expires_idx
  on private.integration_oauth_states (expires_at);
create index if not exists pending_integration_connections_expires_idx
  on private.pending_integration_connections (expires_at);
create index if not exists integration_connection_audit_crew_created_idx
  on private.integration_connection_audit (crew_id, created_at desc);

alter table private.integration_oauth_states enable row level security;
alter table private.pending_integration_connections enable row level security;
alter table private.integration_connection_audit enable row level security;

revoke all on private.integration_oauth_states from public, anon, authenticated;
revoke all on private.pending_integration_connections from public, anon, authenticated;
revoke all on private.integration_connection_audit from public, anon, authenticated;
revoke all on sequence private.integration_connection_audit_id_seq from public, anon, authenticated;

create or replace function private.record_integration_connection_audit(
  target_crew_id uuid,
  target_destination_id uuid,
  target_actor_id uuid,
  target_provider text,
  target_action text,
  target_outcome text default 'succeeded',
  target_metadata jsonb default '{}'::jsonb
)
returns void
language sql
security definer
set search_path = public, private, pg_temp
as $$
  insert into private.integration_connection_audit (
    crew_id,
    destination_id,
    actor_id,
    provider,
    action,
    outcome,
    metadata
  ) values (
    target_crew_id,
    target_destination_id,
    target_actor_id,
    target_provider,
    target_action,
    target_outcome,
    public.redact_integration_metadata(coalesce(target_metadata, '{}'::jsonb))
  );
$$;

create or replace function public.create_integration_oauth_state(
  target_user_id uuid,
  target_crew_id uuid,
  target_provider text,
  target_nonce_hash text,
  target_return_path text,
  target_expires_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  if target_provider not in ('slack', 'discord')
    or target_nonce_hash !~ '^[a-f0-9]{64}$'
    or target_return_path <> '/community.html'
    or target_expires_at < now() + interval '1 minute'
    or target_expires_at > now() + interval '15 minutes' then
    raise exception 'Invalid integration authorization state.' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.crew_members member
    where member.crew_id = target_crew_id
      and member.user_id = target_user_id
      and member.role in ('owner', 'admin')
  ) then
    raise exception 'Only a group owner or admin can manage integrations.' using errcode = '42501';
  end if;

  delete from private.integration_oauth_states
  where expires_at < now() - interval '1 day';

  insert into private.integration_oauth_states (
    nonce_hash,
    provider,
    crew_id,
    initiated_by,
    return_path,
    expires_at
  ) values (
    target_nonce_hash,
    target_provider,
    target_crew_id,
    target_user_id,
    target_return_path,
    target_expires_at
  );

  perform private.record_integration_connection_audit(
    target_crew_id,
    null,
    target_user_id,
    target_provider,
    'authorization_started'
  );
  return true;
end;
$$;

create or replace function public.consume_integration_oauth_state(
  target_provider text,
  target_nonce_hash text
)
returns table (
  user_id uuid,
  crew_id uuid,
  return_path text
)
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  authorization private.integration_oauth_states%rowtype;
begin
  update private.integration_oauth_states
  set consumed_at = now()
  where nonce_hash = target_nonce_hash
    and provider = target_provider
    and consumed_at is null
    and expires_at > now()
  returning * into authorization;

  if not found then
    raise exception 'Integration authorization state is invalid, expired, or already used.' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.crew_members member
    where member.crew_id = authorization.crew_id
      and member.user_id = authorization.initiated_by
      and member.role in ('owner', 'admin')
  ) then
    raise exception 'Integration administrator access is no longer active.' using errcode = '42501';
  end if;

  return query select
    authorization.initiated_by,
    authorization.crew_id,
    authorization.return_path;
end;
$$;

create or replace function public.create_pending_integration_connection(
  target_pending_id uuid,
  target_setup_token_hash text,
  target_provider text,
  target_crew_id uuid,
  target_user_id uuid,
  target_workspace_id text,
  target_workspace_name text,
  target_credential_ciphertext bytea,
  target_credential_nonce bytea,
  target_credential_key_version integer,
  target_credential_fingerprint text,
  target_scopes text[],
  target_expires_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  if target_provider not in ('slack', 'discord')
    or target_setup_token_hash !~ '^[a-f0-9]{64}$'
    or target_expires_at < now() + interval '1 minute'
    or target_expires_at > now() + interval '20 minutes' then
    raise exception 'Invalid pending integration connection.' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.crew_members member
    where member.crew_id = target_crew_id
      and member.user_id = target_user_id
      and member.role in ('owner', 'admin')
  ) then
    raise exception 'Integration administrator access is no longer active.' using errcode = '42501';
  end if;

  delete from private.pending_integration_connections
  where expires_at < now() - interval '1 day';

  insert into private.pending_integration_connections (
    id,
    setup_token_hash,
    provider,
    crew_id,
    initiated_by,
    provider_workspace_id,
    provider_workspace_name,
    credential_ciphertext,
    credential_nonce,
    credential_key_version,
    credential_fingerprint,
    scopes,
    expires_at
  ) values (
    target_pending_id,
    target_setup_token_hash,
    target_provider,
    target_crew_id,
    target_user_id,
    target_workspace_id,
    coalesce(target_workspace_name, ''),
    target_credential_ciphertext,
    target_credential_nonce,
    target_credential_key_version,
    target_credential_fingerprint,
    coalesce(target_scopes, '{}'),
    target_expires_at
  );

  perform private.record_integration_connection_audit(
    target_crew_id,
    null,
    target_user_id,
    target_provider,
    'authorization_completed'
  );
  return target_pending_id;
end;
$$;

create or replace function public.get_pending_integration_connection(
  target_setup_token_hash text,
  target_user_id uuid
)
returns table (
  pending_id uuid,
  provider text,
  crew_id uuid,
  provider_workspace_id text,
  provider_workspace_name text,
  credential_ciphertext bytea,
  credential_nonce bytea,
  credential_key_version integer,
  credential_fingerprint text,
  scopes text[]
)
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  if not exists (
    select 1
    from private.pending_integration_connections pending
    join public.crew_members member
      on member.crew_id = pending.crew_id
     and member.user_id = target_user_id
     and member.role in ('owner', 'admin')
    where pending.setup_token_hash = target_setup_token_hash
      and pending.initiated_by = target_user_id
      and pending.consumed_at is null
      and pending.expires_at > now()
  ) then
    raise exception 'Pending integration setup is invalid or expired.' using errcode = '42501';
  end if;

  return query
    select
      pending.id,
      pending.provider,
      pending.crew_id,
      pending.provider_workspace_id,
      pending.provider_workspace_name,
      pending.credential_ciphertext,
      pending.credential_nonce,
      pending.credential_key_version::integer,
      pending.credential_fingerprint,
      pending.scopes
    from private.pending_integration_connections pending
    where pending.setup_token_hash = target_setup_token_hash
      and pending.initiated_by = target_user_id
      and pending.consumed_at is null
      and pending.expires_at > now();
end;
$$;

create or replace function public.prepare_integration_destination_id(
  target_crew_id uuid,
  target_provider text,
  target_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  destination_id uuid;
begin
  if not exists (
    select 1 from public.crew_members member
    where member.crew_id = target_crew_id
      and member.user_id = target_user_id
      and member.role in ('owner', 'admin')
  ) then
    raise exception 'Only a group owner or admin can manage integrations.' using errcode = '42501';
  end if;

  select destination.id into destination_id
  from private.integration_destinations destination
  where destination.crew_id = target_crew_id
    and destination.provider = target_provider;

  return coalesce(destination_id, gen_random_uuid());
end;
$$;

create or replace function public.complete_pending_integration_connection(
  target_setup_token_hash text,
  target_user_id uuid,
  target_destination_id uuid,
  target_provider_destination_id text,
  target_destination_name text,
  target_credential_ciphertext bytea,
  target_credential_nonce bytea,
  target_credential_key_version integer,
  target_credential_fingerprint text
)
returns uuid
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  pending private.pending_integration_connections%rowtype;
  existing_id uuid;
  connection_action text;
begin
  select * into pending
  from private.pending_integration_connections
  where setup_token_hash = target_setup_token_hash
    and initiated_by = target_user_id
    and consumed_at is null
    and expires_at > now()
  for update;

  if not found then
    raise exception 'Pending integration setup is invalid or expired.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.crew_members member
    where member.crew_id = pending.crew_id
      and member.user_id = target_user_id
      and member.role in ('owner', 'admin')
  ) then
    raise exception 'Integration administrator access is no longer active.' using errcode = '42501';
  end if;

  select destination.id into existing_id
  from private.integration_destinations destination
  where destination.crew_id = pending.crew_id
    and destination.provider = pending.provider;

  if existing_id is not null and existing_id <> target_destination_id then
    raise exception 'The integration destination changed during confirmation.' using errcode = '40001';
  end if;
  connection_action := case when existing_id is null then 'connected' else 'reconnected' end;

  insert into private.integration_destinations (
    id,
    crew_id,
    provider,
    provider_workspace_id,
    provider_workspace_name,
    provider_destination_id,
    display_name,
    credential_ciphertext,
    credential_nonce,
    credential_key_version,
    credential_fingerprint,
    scopes,
    status,
    installed_by,
    installed_at,
    last_verified_at,
    disconnected_at,
    last_error_code,
    last_error_summary
  ) values (
    target_destination_id,
    pending.crew_id,
    pending.provider,
    pending.provider_workspace_id,
    pending.provider_workspace_name,
    target_provider_destination_id,
    coalesce(target_destination_name, ''),
    target_credential_ciphertext,
    target_credential_nonce,
    target_credential_key_version,
    target_credential_fingerprint,
    pending.scopes,
    'active',
    target_user_id,
    now(),
    now(),
    null,
    null,
    null
  )
  on conflict (crew_id, provider) do update set
    provider_workspace_id = excluded.provider_workspace_id,
    provider_workspace_name = excluded.provider_workspace_name,
    provider_destination_id = excluded.provider_destination_id,
    display_name = excluded.display_name,
    credential_ciphertext = excluded.credential_ciphertext,
    credential_nonce = excluded.credential_nonce,
    credential_key_version = excluded.credential_key_version,
    credential_fingerprint = excluded.credential_fingerprint,
    scopes = excluded.scopes,
    status = 'active',
    installed_by = excluded.installed_by,
    installed_at = now(),
    last_verified_at = now(),
    disconnected_at = null,
    last_error_code = null,
    last_error_summary = null;

  update private.pending_integration_connections
  set consumed_at = now(),
      credential_ciphertext = decode(repeat('00', 17), 'hex'),
      credential_nonce = decode(repeat('00', 12), 'hex'),
      credential_fingerprint = repeat('0', 64),
      scopes = '{}'
  where id = pending.id;

  perform private.record_integration_connection_audit(
    pending.crew_id,
    target_destination_id,
    target_user_id,
    pending.provider,
    connection_action,
    'succeeded',
    jsonb_build_object(
      'workspaceId', pending.provider_workspace_id,
      'destinationId', target_provider_destination_id
    )
  );
  return target_destination_id;
end;
$$;

create or replace function public.list_crew_integration_destinations(
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
      public.can_manage_crew(target_crew_id)
    from private.integration_destinations destination
    where destination.crew_id = target_crew_id
    order by destination.provider;
end;
$$;

create or replace function public.get_integration_destination_secret(
  target_destination_id uuid,
  target_user_id uuid
)
returns table (
  destination_id uuid,
  crew_id uuid,
  provider text,
  provider_workspace_id text,
  provider_destination_id text,
  status text,
  credential_ciphertext bytea,
  credential_nonce bytea,
  credential_key_version integer,
  credential_fingerprint text,
  revoke_safe boolean
)
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  if not exists (
    select 1
    from private.integration_destinations destination
    join public.crew_members member on member.crew_id = destination.crew_id
    where destination.id = target_destination_id
      and member.user_id = target_user_id
      and member.role in ('owner', 'admin')
  ) then
    raise exception 'Only a group owner or admin can manage integrations.' using errcode = '42501';
  end if;

  return query
    select
      destination.id,
      destination.crew_id,
      destination.provider,
      destination.provider_workspace_id,
      destination.provider_destination_id,
      destination.status,
      destination.credential_ciphertext,
      destination.credential_nonce,
      destination.credential_key_version::integer,
      destination.credential_fingerprint,
      not exists (
        select 1
        from private.integration_destinations other
        where other.id <> destination.id
          and other.provider = destination.provider
          and other.provider_workspace_id = destination.provider_workspace_id
          and other.status = 'active'
      )
    from private.integration_destinations destination
    where destination.id = target_destination_id;
end;
$$;

create or replace function public.mark_integration_destination_health(
  target_destination_id uuid,
  target_user_id uuid,
  target_healthy boolean,
  target_error_code text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  destination private.integration_destinations%rowtype;
begin
  select destination_row.* into destination
  from private.integration_destinations destination_row
  join public.crew_members member on member.crew_id = destination_row.crew_id
  where destination_row.id = target_destination_id
    and member.user_id = target_user_id
    and member.role in ('owner', 'admin')
  for update of destination_row;

  if not found then
    raise exception 'Only a group owner or admin can manage integrations.' using errcode = '42501';
  end if;

  update private.integration_destinations
  set status = case when target_healthy then 'active' else 'reconnect_required' end,
      last_tested_at = case when target_healthy then now() else last_tested_at end,
      last_verified_at = case when target_healthy then now() else last_verified_at end,
      last_error_code = case when target_healthy then null else left(coalesce(target_error_code, 'provider_unavailable'), 100) end,
      last_error_summary = null
  where id = target_destination_id;

  perform private.record_integration_connection_audit(
    destination.crew_id,
    destination.id,
    target_user_id,
    destination.provider,
    case when target_healthy then 'test_succeeded' else 'needs_attention' end,
    case when target_healthy then 'succeeded' else 'failed' end,
    jsonb_build_object('errorCode', target_error_code)
  );
  return true;
end;
$$;

create or replace function public.disconnect_integration_destination(
  target_destination_id uuid,
  target_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  destination private.integration_destinations%rowtype;
begin
  select destination_row.* into destination
  from private.integration_destinations destination_row
  join public.crew_members member on member.crew_id = destination_row.crew_id
  where destination_row.id = target_destination_id
    and member.user_id = target_user_id
    and member.role in ('owner', 'admin')
  for update of destination_row;

  if not found then
    raise exception 'Only a group owner or admin can manage integrations.' using errcode = '42501';
  end if;

  update private.integration_destinations
  set status = 'disconnected',
      credential_ciphertext = null,
      credential_nonce = null,
      credential_key_version = null,
      credential_fingerprint = null,
      scopes = '{}',
      disconnected_at = now(),
      last_error_code = null,
      last_error_summary = null
  where id = target_destination_id;

  update private.outbound_deliveries
  set status = 'cancelled',
      cancelled_at = now(),
      last_error_code = 'destination_disconnected',
      last_error_summary = 'The integration destination was disconnected.'
  where destination_id = target_destination_id
    and status in ('queued', 'retry');

  perform private.record_integration_connection_audit(
    destination.crew_id,
    destination.id,
    target_user_id,
    destination.provider,
    'disconnected'
  );
  return true;
end;
$$;

create or replace function public.validate_claimed_outbound_delivery(
  target_delivery_id uuid,
  worker_token uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select exists (
    select 1
    from private.outbound_deliveries delivery
    join private.integration_destinations destination
      on destination.id = delivery.destination_id
    where delivery.id = target_delivery_id
      and delivery.status = 'processing'
      and delivery.lock_token = worker_token
      and destination.status = 'active'
      and destination.credential_ciphertext is not null
  );
$$;

create or replace function private.record_integration_delivery_health()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  if new.status = 'delivered' and old.status is distinct from new.status then
    update private.integration_destinations
    set last_delivered_at = coalesce(new.delivered_at, now()),
        last_verified_at = coalesce(new.delivered_at, now()),
        last_error_code = null,
        last_error_summary = null
    where id = new.destination_id
      and status = 'active';
  elsif new.status = 'dead_letter'
    and old.status is distinct from new.status
    and new.last_error_code in (
      'provider_authorization_failed',
      'provider_destination_missing',
      'provider_rejected'
    ) then
    update private.integration_destinations
    set status = 'reconnect_required',
        last_error_code = new.last_error_code,
        last_error_summary = null
    where id = new.destination_id
      and status = 'active';

    if found then
      perform private.record_integration_connection_audit(
        new.crew_id,
        new.destination_id,
        null,
        (select provider from private.integration_destinations where id = new.destination_id),
        'needs_attention',
        'failed',
        jsonb_build_object('errorCode', new.last_error_code)
      );
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists record_integration_delivery_health
  on private.outbound_deliveries;
create trigger record_integration_delivery_health
  after update of status on private.outbound_deliveries
  for each row execute function private.record_integration_delivery_health();

create or replace function public.purge_integration_connection_setup()
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  deleted_states integer;
  deleted_pending integer;
begin
  delete from private.integration_oauth_states
  where expires_at < now() - interval '1 day';
  get diagnostics deleted_states = row_count;

  delete from private.pending_integration_connections
  where expires_at < now() - interval '1 day';
  get diagnostics deleted_pending = row_count;

  return jsonb_build_object(
    'deletedOAuthStates', deleted_states,
    'deletedPendingConnections', deleted_pending
  );
end;
$$;

revoke all on function private.record_integration_connection_audit(uuid, uuid, uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.create_integration_oauth_state(uuid, uuid, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.consume_integration_oauth_state(text, text) from public, anon, authenticated;
revoke all on function public.create_pending_integration_connection(uuid, text, text, uuid, uuid, text, text, bytea, bytea, integer, text, text[], timestamptz) from public, anon, authenticated;
revoke all on function public.get_pending_integration_connection(text, uuid) from public, anon, authenticated;
revoke all on function public.prepare_integration_destination_id(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.complete_pending_integration_connection(text, uuid, uuid, text, text, bytea, bytea, integer, text) from public, anon, authenticated;
revoke all on function public.list_crew_integration_destinations(uuid) from public, anon;
revoke all on function public.get_integration_destination_secret(uuid, uuid) from public, anon, authenticated;
revoke all on function public.mark_integration_destination_health(uuid, uuid, boolean, text) from public, anon, authenticated;
revoke all on function public.disconnect_integration_destination(uuid, uuid) from public, anon, authenticated;
revoke all on function public.validate_claimed_outbound_delivery(uuid, uuid) from public, anon, authenticated;
revoke all on function private.record_integration_delivery_health() from public, anon, authenticated;
revoke all on function public.purge_integration_connection_setup() from public, anon, authenticated;

grant execute on function public.create_integration_oauth_state(uuid, uuid, text, text, text, timestamptz) to service_role;
grant execute on function public.consume_integration_oauth_state(text, text) to service_role;
grant execute on function public.create_pending_integration_connection(uuid, text, text, uuid, uuid, text, text, bytea, bytea, integer, text, text[], timestamptz) to service_role;
grant execute on function public.get_pending_integration_connection(text, uuid) to service_role;
grant execute on function public.prepare_integration_destination_id(uuid, text, uuid) to service_role;
grant execute on function public.complete_pending_integration_connection(text, uuid, uuid, text, text, bytea, bytea, integer, text) to service_role;
grant execute on function public.list_crew_integration_destinations(uuid) to authenticated;
grant execute on function public.get_integration_destination_secret(uuid, uuid) to service_role;
grant execute on function public.mark_integration_destination_health(uuid, uuid, boolean, text) to service_role;
grant execute on function public.disconnect_integration_destination(uuid, uuid) to service_role;
grant execute on function public.validate_claimed_outbound_delivery(uuid, uuid) to service_role;
grant execute on function public.purge_integration_connection_setup() to service_role;
