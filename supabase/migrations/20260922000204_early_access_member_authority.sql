-- Additive authority only: no person is enrolled, no invitation is sent, and
-- no existing entitlement consumer or billing flag changes in this migration.
set local lock_timeout = '5s';

create table private.early_access_programs (
  program_key text primary key check (program_key = 'early_access_v1'),
  policy_version integer not null check (policy_version = 1),
  configured boolean not null,
  free_access_rule text not null check (free_access_rule = 'until_beta'),
  beta_starts_at timestamptz check (pg_catalog.isfinite(beta_starts_at)),
  price_retention text not null check (price_retention = 'lifetime_including_returners'),
  created_at timestamptz not null default pg_catalog.clock_timestamp()
    check (pg_catalog.isfinite(created_at))
);
insert into private.early_access_programs
  (program_key, policy_version, configured, free_access_rule, beta_starts_at, price_retention)
values ('early_access_v1', 1, true, 'until_beta', null, 'lifetime_including_returners');

create table private.early_access_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  program_key text not null references private.early_access_programs(program_key),
  request_id uuid not null unique references private.early_access_requests(id),
  accepted_at timestamptz not null check (pg_catalog.isfinite(accepted_at)),
  starts_at timestamptz not null check (starts_at = accepted_at),
  revoked_at timestamptz check (pg_catalog.isfinite(revoked_at) and revoked_at >= accepted_at),
  revision bigint not null default 0 check (revision >= 0),
  unique (user_id, program_key),
  unique (id, user_id, program_key)
);

-- A permanent qualifying fact, not current free access or a subscription. Its
-- owner remains the accepted Auth UUID; email changes cannot transfer it.
create table private.early_access_price_qualifications (
  user_id uuid not null references auth.users(id) on delete cascade,
  program_key text not null,
  grant_id uuid not null unique,
  qualified_at timestamptz not null check (pg_catalog.isfinite(qualified_at)),
  policy_version integer not null check (policy_version = 1),
  currency text not null check (currency = 'usd'),
  unit_amount integer not null check (unit_amount = 350),
  recurring_interval text not null check (recurring_interval = 'month'),
  interval_count integer not null check (interval_count = 1),
  primary key (user_id, program_key),
  foreign key (grant_id, user_id, program_key)
    references private.early_access_grants(id, user_id, program_key) on delete cascade
);

alter table private.early_access_programs enable row level security;
alter table private.early_access_grants enable row level security;
alter table private.early_access_price_qualifications enable row level security;
revoke all on private.early_access_programs, private.early_access_grants,
  private.early_access_price_qualifications from public, anon, authenticated, service_role;

create function private.guard_early_access_grant()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if row(new.id, new.user_id, new.program_key, new.request_id, new.accepted_at, new.starts_at)
      is distinct from row(old.id, old.user_id, old.program_key, old.request_id, old.accepted_at, old.starts_at)
      or old.revoked_at is not null or new.revoked_at is null
      or new.revision <> old.revision + 1 then
      raise exception using errcode = '42501', message = 'early_access_grant_immutable';
    end if;
    return new;
  end if;
  if new.revoked_at is not null or new.revision <> 0
    or new.accepted_at > pg_catalog.clock_timestamp()
    or not exists (select 1 from private.early_access_programs p
      where p.program_key = new.program_key and p.configured
        and (p.beta_starts_at is null or new.accepted_at < p.beta_starts_at))
    or not exists (select 1 from private.early_access_requests r
      where r.id = new.request_id and r.user_id = new.user_id and r.status = 'accepted') then
    raise exception using errcode = '42501', message = 'early_access_accepted_request_required';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_early_access_grant() from public, anon, authenticated, service_role;
create trigger guard_early_access_grant before insert or update on private.early_access_grants
  for each row execute function private.guard_early_access_grant();

create function private.record_early_access_price_qualification()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into private.early_access_price_qualifications
    (user_id, program_key, grant_id, qualified_at, policy_version, currency, unit_amount, recurring_interval, interval_count)
  values (new.user_id, new.program_key, new.id, new.accepted_at, 1, 'usd', 350, 'month', 1);
  return new;
end;
$$;
revoke all on function private.record_early_access_price_qualification() from public, anon, authenticated, service_role;
create trigger record_early_access_price_qualification after insert on private.early_access_grants
  for each row execute function private.record_early_access_price_qualification();

create function private.guard_early_access_price_qualification()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    raise exception using errcode = '42501', message = 'early_access_price_fact_immutable';
  end if;
  if not exists (select 1 from private.early_access_grants g
    where g.id = new.grant_id and g.user_id = new.user_id and g.program_key = new.program_key
      and g.accepted_at = new.qualified_at) then
    raise exception using errcode = '42501', message = 'early_access_accepted_grant_required';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_early_access_price_qualification() from public, anon, authenticated, service_role;
create trigger guard_early_access_price_qualification before insert or update on private.early_access_price_qualifications
  for each row execute function private.guard_early_access_price_qualification();

-- Internal predicates are not arbitrary-user browser probes. Callers carrying
-- out writes must lock their authority rows and recheck after blocking waits.
create function private.early_access_active_for_user(target_user_id uuid, as_of timestamptz)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(pg_catalog.isfinite(as_of), false) and exists (
    select 1 from private.early_access_grants g
    join private.early_access_programs p on p.program_key = g.program_key
    join auth.users u on u.id = g.user_id
    where g.user_id = target_user_id and p.configured and g.starts_at <= as_of
      and g.revoked_at is null and (p.beta_starts_at is null or as_of < p.beta_starts_at)
      and u.deleted_at is null and not coalesce(u.is_anonymous, false)
      and u.email_confirmed_at is not null and (u.banned_until is null or u.banned_until <= as_of)
  );
$$;
revoke all on function private.early_access_active_for_user(uuid, timestamptz)
  from public, anon, authenticated, service_role;

create function private.require_member_current_session(target_user_id uuid, target_session_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare as_of timestamptz := pg_catalog.clock_timestamp();
begin
  if target_user_id is null or target_session_id is null or not exists (
    select 1 from auth.sessions s join auth.users u on u.id = s.user_id
    where s.id = target_session_id and s.user_id = target_user_id
      and (s.not_after is null or s.not_after > as_of)
      and s.aal::text in ('aal1', 'aal2')
      and u.deleted_at is null and not coalesce(u.is_anonymous, false)
      and u.email_confirmed_at is not null
      and (u.banned_until is null or u.banned_until <= as_of)
  ) then raise exception using errcode = 'PT401', message = 'member_authentication_required'; end if;
  if exists (select 1 from auth.mfa_factors f where f.user_id = target_user_id and f.status::text = 'verified')
    and not exists (select 1 from auth.sessions s join auth.mfa_factors f on f.id = s.factor_id
      where s.id = target_session_id and s.user_id = target_user_id and s.aal::text = 'aal2'
        and f.user_id = target_user_id and f.status::text = 'verified') then
    raise exception using errcode = 'PT403', message = 'member_mfa_required';
  end if;
end;
$$;
revoke all on function private.require_member_current_session(uuid, uuid)
  from public, anon, authenticated, service_role;

create function private.require_member_request_identity(target_expected_actor_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare actor uuid; claims jsonb; session_identifier uuid; origin text;
begin
  perform pg_catalog.set_config('response.headers',
    '[{"Cache-Control":"private, no-store"},{"Pragma":"no-cache"}]', true);
  begin
    actor := (select auth.uid());
    claims := (select auth.jwt());
    session_identifier := (claims->>'session_id')::uuid;
    origin := coalesce(nullif(pg_catalog.current_setting('request.headers', true), ''), '{}')::jsonb->>'origin';
  exception when others then
    raise exception using errcode = 'PT401', message = 'member_authentication_required';
  end;
  if actor is null or actor is distinct from target_expected_actor_id
    or claims->>'role' is distinct from 'authenticated'
    or coalesce(claims->>'aal', '') not in ('aal1', 'aal2') then
    raise exception using errcode = 'PT401', message = 'member_authentication_required';
  end if;
  -- Reuse the existing deployment allowlist, not a separate member/email list.
  if not exists (select 1 from private.site_admin_configuration c
    where c.singleton and origin = any(c.allowed_origins)) then
    raise exception using errcode = 'PT403', message = 'member_origin_forbidden';
  end if;
  perform private.require_member_current_session(actor, session_identifier);
  if claims->>'aal' <> 'aal2' and exists (
    select 1 from auth.mfa_factors f where f.user_id = actor and f.status::text = 'verified'
  ) then raise exception using errcode = 'PT403', message = 'member_mfa_required'; end if;
  return session_identifier;
end;
$$;
revoke all on function private.require_member_request_identity(uuid)
  from public, anon, authenticated, service_role;

create function private.member_access_context(target_expected_actor_id uuid)
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
  legacy_active := public.has_active_entitlement('membership_active');
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
revoke all on function private.member_access_context(uuid) from public, anon, authenticated, service_role;
create function public.get_member_access_context(target_expected_actor_id uuid)
returns jsonb language sql security definer set search_path = '' as $$
  select private.member_access_context(target_expected_actor_id);
$$;
revoke all on function public.get_member_access_context(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_member_access_context(uuid) to authenticated;

create function private.member_beta_price_eligibility(target_expected_actor_id uuid, target_session_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare eligible boolean;
begin
  -- The service caller must first verify the original bearer and pin its actor
  -- and immutable session ID. A service key alone is not member identity.
  if pg_catalog.current_setting('role', true) is distinct from 'service_role'
    or (select auth.uid()) is not null then
    raise exception using errcode = '42501', message = 'member_service_required';
  end if;
  perform pg_catalog.set_config('response.headers',
    '[{"Cache-Control":"private, no-store"},{"Pragma":"no-cache"}]', true);
  perform private.require_member_current_session(target_expected_actor_id, target_session_id);
  select exists (select 1 from private.early_access_price_qualifications q
    where q.user_id = target_expected_actor_id and q.program_key = 'early_access_v1') into eligible;
  perform private.require_member_current_session(target_expected_actor_id, target_session_id);
  return pg_catalog.jsonb_build_object('user_id', target_expected_actor_id, 'eligible', eligible);
end;
$$;
revoke all on function private.member_beta_price_eligibility(uuid, uuid) from public, anon, authenticated, service_role;
create function public.get_beta_price_eligibility(target_expected_actor_id uuid, target_session_id uuid)
returns jsonb language sql security definer set search_path = '' as $$
  select private.member_beta_price_eligibility(target_expected_actor_id, target_session_id);
$$;
revoke all on function public.get_beta_price_eligibility(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_beta_price_eligibility(uuid, uuid) to service_role;

comment on function public.get_member_access_context(uuid) is
  'Current-session, self-only access summary. No grants, roles, billing activation or private content. Private/no-store.';
comment on function public.get_beta_price_eligibility(uuid, uuid) is
  'Service-only canonical lifetime price qualification after verified original member actor/session. Does not launch billing.';
