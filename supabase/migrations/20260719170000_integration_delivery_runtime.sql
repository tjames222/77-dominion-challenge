create schema if not exists private;

revoke all on schema private from public;
revoke all on schema private from anon;
revoke all on schema private from authenticated;

create table if not exists private.integration_destinations (
  id uuid primary key default gen_random_uuid(),
  crew_id uuid not null references public.crews(id) on delete cascade,
  provider text not null check (provider in ('slack', 'discord')),
  provider_workspace_id text not null check (char_length(provider_workspace_id) between 1 and 200),
  provider_destination_id text not null check (char_length(provider_destination_id) between 1 and 200),
  display_name text not null default '' check (char_length(display_name) <= 200),
  credential_ciphertext bytea not null check (octet_length(credential_ciphertext) between 17 and 16384),
  credential_nonce bytea not null check (octet_length(credential_nonce) = 12),
  credential_key_version smallint not null check (credential_key_version > 0),
  credential_fingerprint text not null check (credential_fingerprint ~ '^[a-f0-9]{64}$'),
  scopes text[] not null default '{}',
  status text not null default 'active'
    check (status in ('active', 'reconnect_required', 'disconnected', 'revoked')),
  installed_by uuid not null references auth.users(id) on delete restrict,
  installed_at timestamptz not null default now(),
  last_verified_at timestamptz,
  disconnected_at timestamptz,
  last_error_code text check (last_error_code is null or char_length(last_error_code) <= 100),
  last_error_summary text check (last_error_summary is null or char_length(last_error_summary) <= 500),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (crew_id, provider, provider_workspace_id, provider_destination_id)
);

comment on table private.integration_destinations is
  'Server-only provider destinations. OAuth credentials are AES-256-GCM ciphertext; key material lives only in Edge Function secrets.';

create table if not exists private.outbound_deliveries (
  id uuid primary key default gen_random_uuid(),
  crew_id uuid not null references public.crews(id) on delete cascade,
  destination_id uuid not null references private.integration_destinations(id) on delete cascade,
  event_type text not null check (event_type ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 240),
  payload jsonb not null check (
    jsonb_typeof(payload) = 'object'
    and octet_length(payload::text) <= 65536
  ),
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'retry', 'delivered', 'dead_letter', 'cancelled')),
  priority smallint not null default 100 check (priority between 0 and 1000),
  available_at timestamptz not null default now(),
  attempt_count smallint not null default 0 check (attempt_count >= 0),
  max_attempts smallint not null default 5 check (max_attempts between 1 and 8),
  lock_token uuid,
  locked_at timestamptz,
  delivered_at timestamptz,
  dead_lettered_at timestamptz,
  cancelled_at timestamptz,
  last_error_code text check (last_error_code is null or char_length(last_error_code) <= 100),
  last_error_summary text check (last_error_summary is null or char_length(last_error_summary) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (destination_id, idempotency_key),
  check (
    (status = 'processing' and lock_token is not null and locked_at is not null)
    or (status <> 'processing' and lock_token is null and locked_at is null)
  )
);

comment on table private.outbound_deliveries is
  'Durable, private-group-scoped provider outbox. Publishing commits independently from provider delivery.';

create table if not exists private.integration_delivery_attempts (
  id bigint generated always as identity primary key,
  delivery_id uuid not null references private.outbound_deliveries(id) on delete cascade,
  attempt_number smallint not null check (attempt_number > 0),
  outcome text not null check (outcome in ('delivered', 'retry', 'dead_letter', 'worker_timeout')),
  http_status integer check (http_status is null or http_status between 100 and 599),
  provider_request_id text check (provider_request_id is null or char_length(provider_request_id) <= 200),
  retry_after_seconds integer check (retry_after_seconds is null or retry_after_seconds between 0 and 86400),
  error_code text check (error_code is null or char_length(error_code) <= 100),
  error_summary text check (error_summary is null or char_length(error_summary) <= 500),
  response_metadata jsonb not null default '{}'::jsonb check (
    jsonb_typeof(response_metadata) = 'object'
    and octet_length(response_metadata::text) <= 8192
  ),
  started_at timestamptz not null,
  completed_at timestamptz not null default now(),
  unique (delivery_id, attempt_number)
);

create index if not exists integration_destinations_crew_status_idx
  on private.integration_destinations (crew_id, status, provider);

create index if not exists outbound_deliveries_ready_idx
  on private.outbound_deliveries (priority, available_at, created_at)
  where status in ('queued', 'retry');

create index if not exists outbound_deliveries_crew_created_idx
  on private.outbound_deliveries (crew_id, created_at desc);

create index if not exists outbound_deliveries_dead_letter_idx
  on private.outbound_deliveries (dead_lettered_at desc)
  where status = 'dead_letter';

create index if not exists integration_delivery_attempts_delivery_idx
  on private.integration_delivery_attempts (delivery_id, attempt_number desc);

alter table private.integration_destinations enable row level security;
alter table private.outbound_deliveries enable row level security;
alter table private.integration_delivery_attempts enable row level security;

revoke all on all tables in schema private from public;
revoke all on all tables in schema private from anon;
revoke all on all tables in schema private from authenticated;
revoke all on all sequences in schema private from public;
revoke all on all sequences in schema private from anon;
revoke all on all sequences in schema private from authenticated;

drop trigger if exists set_integration_destinations_updated_at on private.integration_destinations;
create trigger set_integration_destinations_updated_at
  before update on private.integration_destinations
  for each row execute function public.set_updated_at();

drop trigger if exists set_outbound_deliveries_updated_at on private.outbound_deliveries;
create trigger set_outbound_deliveries_updated_at
  before update on private.outbound_deliveries
  for each row execute function public.set_updated_at();

create or replace function public.redact_integration_metadata(input jsonb)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = public, pg_temp
as $$
declare
  output jsonb;
begin
  if input is null then
    return '{}'::jsonb;
  end if;

  if jsonb_typeof(input) = 'object' then
    select coalesce(
      jsonb_object_agg(
        item.key,
        case
          when lower(item.key) ~ '(authorization|credential|secret|token|webhook|content|payload|body)'
            then '"[redacted]"'::jsonb
          else public.redact_integration_metadata(item.value)
        end
      ),
      '{}'::jsonb
    )
    into output
    from jsonb_each(input) item;
    return output;
  end if;

  if jsonb_typeof(input) = 'array' then
    select coalesce(jsonb_agg(public.redact_integration_metadata(item.value)), '[]'::jsonb)
    into output
    from jsonb_array_elements(input) item;
    return output;
  end if;

  return input;
end;
$$;

create or replace function private.redact_integration_destination_metadata()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  new.metadata := public.redact_integration_metadata(new.metadata);
  return new;
end;
$$;

drop trigger if exists redact_integration_destination_metadata
  on private.integration_destinations;
create trigger redact_integration_destination_metadata
  before insert or update of metadata on private.integration_destinations
  for each row execute function private.redact_integration_destination_metadata();

create or replace function public.enqueue_outbound_delivery(
  target_crew_id uuid,
  target_destination_id uuid,
  target_event_type text,
  target_idempotency_key text,
  target_payload jsonb,
  target_max_attempts integer default 5,
  target_available_at timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  destination private.integration_destinations%rowtype;
  existing private.outbound_deliveries%rowtype;
  delivery_id uuid;
begin
  if target_crew_id is null or target_destination_id is null then
    raise exception 'A crew and destination are required.' using errcode = '22023';
  end if;
  if target_event_type is null or target_event_type !~ '^[a-z][a-z0-9_.-]{1,79}$' then
    raise exception 'Invalid integration event type.' using errcode = '22023';
  end if;
  if target_idempotency_key is null or char_length(target_idempotency_key) not between 8 and 240 then
    raise exception 'Invalid integration idempotency key.' using errcode = '22023';
  end if;
  if target_payload is null or jsonb_typeof(target_payload) <> 'object'
    or octet_length(target_payload::text) > 65536 then
    raise exception 'Invalid integration payload.' using errcode = '22023';
  end if;
  if target_max_attempts not between 1 and 8 then
    raise exception 'Invalid maximum attempt count.' using errcode = '22023';
  end if;

  select * into destination
  from private.integration_destinations
  where id = target_destination_id;

  if not found or destination.crew_id <> target_crew_id then
    raise exception 'The integration destination does not belong to this group.' using errcode = '42501';
  end if;
  if destination.status <> 'active' then
    raise exception 'The integration destination is not active.' using errcode = '55000';
  end if;

  select * into existing
  from private.outbound_deliveries
  where destination_id = target_destination_id
    and idempotency_key = target_idempotency_key;

  if found then
    if existing.crew_id <> target_crew_id
      or existing.event_type <> target_event_type
      or existing.payload <> target_payload then
      raise exception 'The idempotency key was reused with different delivery data.' using errcode = '23505';
    end if;
    return existing.id;
  end if;

  insert into private.outbound_deliveries (
    crew_id,
    destination_id,
    event_type,
    idempotency_key,
    payload,
    max_attempts,
    available_at
  ) values (
    target_crew_id,
    target_destination_id,
    target_event_type,
    target_idempotency_key,
    target_payload,
    target_max_attempts,
    coalesce(target_available_at, now())
  )
  on conflict (destination_id, idempotency_key) do nothing
  returning id into delivery_id;

  if delivery_id is not null then
    return delivery_id;
  end if;

  select * into existing
  from private.outbound_deliveries
  where destination_id = target_destination_id
    and idempotency_key = target_idempotency_key;

  if existing.crew_id <> target_crew_id
    or existing.event_type <> target_event_type
    or existing.payload <> target_payload then
    raise exception 'The idempotency key was reused with different delivery data.' using errcode = '23505';
  end if;
  return existing.id;
end;
$$;

create or replace function public.claim_outbound_deliveries(
  worker_token uuid,
  batch_size integer default 20
)
returns table (
  delivery_id uuid,
  crew_id uuid,
  destination_id uuid,
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

create or replace function public.settle_outbound_delivery(
  target_delivery_id uuid,
  worker_token uuid,
  target_outcome text,
  target_started_at timestamptz,
  target_http_status integer default null,
  target_provider_request_id text default null,
  target_retry_after_seconds integer default null,
  target_error_code text default null,
  target_error_summary text default null,
  target_response_metadata jsonb default '{}'::jsonb
)
returns text
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  delivery private.outbound_deliveries%rowtype;
  final_outcome text;
  retry_seconds integer;
begin
  if target_outcome not in ('delivered', 'retry', 'dead_letter') then
    raise exception 'Invalid delivery outcome.' using errcode = '22023';
  end if;
  if target_http_status is not null and target_http_status not between 100 and 599 then
    raise exception 'Invalid provider status.' using errcode = '22023';
  end if;

  select * into delivery
  from private.outbound_deliveries
  where id = target_delivery_id
  for update;

  if not found or delivery.status <> 'processing' or delivery.lock_token <> worker_token then
    raise exception 'The delivery is not owned by this worker.' using errcode = '55000';
  end if;

  final_outcome := target_outcome;
  if target_outcome = 'retry' and delivery.attempt_count >= delivery.max_attempts then
    final_outcome := 'dead_letter';
  end if;

  retry_seconds := case
    when final_outcome = 'retry' then least(
      greatest(
        coalesce(target_retry_after_seconds, (30 * power(2, delivery.attempt_count - 1))::integer),
        1
      ),
      86400
    )
    else null
  end;

  insert into private.integration_delivery_attempts (
    delivery_id,
    attempt_number,
    outcome,
    http_status,
    provider_request_id,
    retry_after_seconds,
    error_code,
    error_summary,
    response_metadata,
    started_at
  ) values (
    delivery.id,
    delivery.attempt_count,
    final_outcome,
    target_http_status,
    left(target_provider_request_id, 200),
    retry_seconds,
    left(target_error_code, 100),
    left(target_error_summary, 500),
    public.redact_integration_metadata(coalesce(target_response_metadata, '{}'::jsonb)),
    coalesce(target_started_at, delivery.locked_at, now())
  )
  on conflict (delivery_id, attempt_number) do nothing;

  update private.outbound_deliveries
  set status = case final_outcome
        when 'delivered' then 'delivered'
        when 'retry' then 'retry'
        else 'dead_letter'
      end,
      available_at = case when final_outcome = 'retry' then now() + make_interval(secs => retry_seconds) else available_at end,
      delivered_at = case when final_outcome = 'delivered' then now() else null end,
      dead_lettered_at = case when final_outcome = 'dead_letter' then now() else null end,
      last_error_code = case when final_outcome = 'delivered' then null else left(target_error_code, 100) end,
      last_error_summary = case when final_outcome = 'delivered' then null else left(target_error_summary, 500) end,
      lock_token = null,
      locked_at = null
  where id = delivery.id;

  return final_outcome;
end;
$$;

create or replace function public.release_stale_outbound_deliveries(
  stale_after interval default interval '5 minutes'
)
returns integer
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  delivery private.outbound_deliveries%rowtype;
  released integer := 0;
  release_outcome text;
begin
  if stale_after < interval '1 minute' or stale_after > interval '1 day' then
    raise exception 'Invalid stale-delivery window.' using errcode = '22023';
  end if;

  for delivery in
    select *
    from private.outbound_deliveries
    where status = 'processing'
      and locked_at < now() - stale_after
    order by locked_at asc
    for update skip locked
  loop
    release_outcome := case
      when delivery.attempt_count >= delivery.max_attempts then 'dead_letter'
      else 'worker_timeout'
    end;

    insert into private.integration_delivery_attempts (
      delivery_id,
      attempt_number,
      outcome,
      retry_after_seconds,
      error_code,
      error_summary,
      started_at
    ) values (
      delivery.id,
      delivery.attempt_count,
      release_outcome,
      case when release_outcome = 'worker_timeout' then 60 else null end,
      'worker_timeout',
      'The delivery worker did not settle its lock before the timeout.',
      delivery.locked_at
    )
    on conflict (delivery_id, attempt_number) do nothing;

    update private.outbound_deliveries
    set status = case when release_outcome = 'dead_letter' then 'dead_letter' else 'retry' end,
        available_at = case when release_outcome = 'dead_letter' then available_at else now() + interval '1 minute' end,
        dead_lettered_at = case when release_outcome = 'dead_letter' then now() else null end,
        last_error_code = 'worker_timeout',
        last_error_summary = 'The delivery worker did not settle its lock before the timeout.',
        lock_token = null,
        locked_at = null
    where id = delivery.id;

    released := released + 1;
  end loop;

  return released;
end;
$$;

create or replace function public.integration_delivery_health()
returns jsonb
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select jsonb_build_object(
    'queued', count(*) filter (where status in ('queued', 'retry')),
    'processing', count(*) filter (where status = 'processing'),
    'deadLettersLast24Hours', count(*) filter (
      where status = 'dead_letter' and dead_lettered_at >= now() - interval '24 hours'
    ),
    'oldestReadyAt', min(available_at) filter (
      where status in ('queued', 'retry') and available_at <= now()
    ),
    'generatedAt', now()
  )
  from private.outbound_deliveries;
$$;

create or replace function public.purge_integration_delivery_history()
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  redacted_payloads integer;
  redacted_attempts integer;
  deleted_deliveries integer;
begin
  update private.outbound_deliveries
  set payload = jsonb_build_object('redacted', true, 'eventType', event_type)
  where status = 'delivered'
    and delivered_at < now() - interval '7 days'
    and payload <> jsonb_build_object('redacted', true, 'eventType', event_type);
  get diagnostics redacted_payloads = row_count;

  update private.integration_delivery_attempts
  set response_metadata = '{"redacted":true}'::jsonb,
      error_summary = null
  where completed_at < now() - interval '30 days'
    and (response_metadata <> '{"redacted":true}'::jsonb or error_summary is not null);
  get diagnostics redacted_attempts = row_count;

  delete from private.outbound_deliveries
  where status in ('delivered', 'dead_letter', 'cancelled')
    and coalesce(delivered_at, dead_lettered_at, cancelled_at, updated_at) < now() - interval '90 days';
  get diagnostics deleted_deliveries = row_count;

  return jsonb_build_object(
    'redactedPayloads', redacted_payloads,
    'redactedAttempts', redacted_attempts,
    'deletedDeliveries', deleted_deliveries
  );
end;
$$;

revoke all on function public.redact_integration_metadata(jsonb) from public, anon, authenticated;
revoke all on function private.redact_integration_destination_metadata() from public, anon, authenticated;
revoke all on function public.enqueue_outbound_delivery(uuid, uuid, text, text, jsonb, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.claim_outbound_deliveries(uuid, integer) from public, anon, authenticated;
revoke all on function public.settle_outbound_delivery(uuid, uuid, text, timestamptz, integer, text, integer, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.release_stale_outbound_deliveries(interval) from public, anon, authenticated;
revoke all on function public.integration_delivery_health() from public, anon, authenticated;
revoke all on function public.purge_integration_delivery_history() from public, anon, authenticated;

grant execute on function public.enqueue_outbound_delivery(uuid, uuid, text, text, jsonb, integer, timestamptz) to service_role;
grant execute on function public.claim_outbound_deliveries(uuid, integer) to service_role;
grant execute on function public.settle_outbound_delivery(uuid, uuid, text, timestamptz, integer, text, integer, text, text, jsonb) to service_role;
grant execute on function public.release_stale_outbound_deliveries(interval) to service_role;
grant execute on function public.integration_delivery_health() to service_role;
grant execute on function public.purge_integration_delivery_history() to service_role;
