-- FOU-1741 private request intake; this does not grant access or send invites.
create table private.early_access_requests (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 120 and name = btrim(name)),
  email text not null check (length(email) between 3 and 254 and email = lower(btrim(email))),
  user_id uuid references auth.users(id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'invited', 'accepted', 'denied', 'expired', 'revoked')),
  form_version integer not null default 1 check (form_version > 0),
  answers jsonb not null default '{}'::jsonb check (jsonb_typeof(answers) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint early_access_requests_email_unique unique (email)
);
alter table private.early_access_requests enable row level security;
revoke all on private.early_access_requests from public, anon, authenticated, service_role;
grant select on private.early_access_requests to service_role;
grant insert (name, email, user_id, created_at, updated_at) on private.early_access_requests to service_role;
grant update (user_id, updated_at) on private.early_access_requests to service_role;
create index early_access_requests_created_idx on private.early_access_requests (created_at);
create index early_access_requests_queue_idx on private.early_access_requests (status, created_at, id);
create index early_access_requests_user_idx on private.early_access_requests (user_id) where user_id is not null;
create unique index early_access_requests_pending_user_idx on private.early_access_requests (user_id)
  where user_id is not null and status = 'pending';

-- Short-lived, PII-free attempts also count duplicates. Applying the same budget
-- before lookup prevents status-code enumeration when intake is at capacity.
create table private.early_access_intake_attempts (
  id uuid primary key default gen_random_uuid(),
  attempted_at timestamptz not null default clock_timestamp()
);
alter table private.early_access_intake_attempts enable row level security;
revoke all on private.early_access_intake_attempts from public, anon, authenticated, service_role;
grant select, delete on private.early_access_intake_attempts to service_role;
grant insert (attempted_at) on private.early_access_intake_attempts to service_role;
create index early_access_intake_attempts_time_idx on private.early_access_intake_attempts (attempted_at);

-- Only the server validates optional Auth identity and invokes this operation.
-- INVOKER keeps the function from acquiring any privilege of its owner.
create function public.submit_early_access_request_service(
  p_name text,
  p_email text,
  p_user_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_name text := btrim(p_name);
  v_email text := lower(btrim(p_email));
  v_now timestamptz;
begin
  if v_name is null or length(v_name) not between 1 and 120
    or v_name ~ '[[:cntrl:]]'
    or v_email is null or length(v_email) not between 3 and 254
    or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or v_email ~ '[[:cntrl:]]'
  then
    raise exception using errcode = '22023', message = 'Invalid early-access request.';
  end if;
  if p_user_id is not null and not exists (
    select 1 from auth.users where id = p_user_id
      and lower(email) = v_email and email_confirmed_at is not null
      and not coalesce(is_anonymous, false)
  ) then
    raise exception using errcode = '42501', message = 'Verified account mismatch.';
  end if;

  -- One bounded intake lock makes both duplicate handling and the global free-
  -- tier intake budget atomic. No client-supplied IP header is trusted.
  perform pg_catalog.pg_advisory_xact_lock(1741, 1);
  v_now := clock_timestamp();
  if (select count(*) from private.early_access_intake_attempts
      where attempted_at > v_now - interval '1 minute') >= 20
    or (select count(*) from private.early_access_intake_attempts
      where attempted_at > v_now - interval '1 hour') >= 100
  then
    raise exception using errcode = 'P0001', message = 'EARLY_ACCESS_RATE_LIMIT';
  end if;
  delete from private.early_access_intake_attempts where attempted_at <= v_now - interval '1 hour';
  insert into private.early_access_intake_attempts (attempted_at) values (v_now);
  if p_user_id is not null and exists (
    select 1 from private.early_access_requests where user_id = p_user_id and status = 'pending'
  ) then
    return jsonb_build_object('received', true);
  end if;
  if exists (select 1 from private.early_access_requests where email = v_email) then
    -- An anonymous request may be associated only after that email is verified.
    update private.early_access_requests
      set user_id = p_user_id, updated_at = v_now
      where email = v_email and user_id is null and p_user_id is not null;
    return jsonb_build_object('received', true);
  end if;
  insert into private.early_access_requests (name, email, user_id, created_at, updated_at)
    values (v_name, v_email, p_user_id, v_now, v_now);
  -- Identical response for new/pending/approved/denied emails: no enumeration.
  return jsonb_build_object('received', true);
end;
$$;
revoke all on function public.submit_early_access_request_service(text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.submit_early_access_request_service(text, text, uuid)
  to service_role;
