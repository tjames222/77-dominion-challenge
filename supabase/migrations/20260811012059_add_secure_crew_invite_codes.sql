-- FOU-1445: add one-time human-readable codes to the hardened crew invite
-- lifecycle. Link, Code, and QR are representations of the same invite row.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

create schema if not exists private;

alter table public.crew_invites
  add column if not exists code_hash text,
  add column if not exists code_hint text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'crew_invites_code_hash_format_check'
      and conrelid = 'public.crew_invites'::regclass
  ) then
    alter table public.crew_invites
      add constraint crew_invites_code_hash_format_check
      check (code_hash is null or code_hash ~ '^[0-9a-f]{64}$');
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'crew_invites_code_hint_format_check'
      and conrelid = 'public.crew_invites'::regclass
  ) then
    alter table public.crew_invites
      add constraint crew_invites_code_hint_format_check
      check (
        code_hint is null
        or code_hint ~ '^[34679ACDEFGHJKMNPQRTUVWXY]{4}$'
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'crew_invites_code_pair_check'
      and conrelid = 'public.crew_invites'::regclass
  ) then
    alter table public.crew_invites
      add constraint crew_invites_code_pair_check
      check ((code_hash is null) = (code_hint is null));
  end if;
end;
$$;

create unique index if not exists crew_invites_code_hash_key
  on public.crew_invites (code_hash)
  where code_hash is not null;

create table if not exists private.crew_invite_code_secrets (
  singleton boolean primary key default true check (singleton),
  secret bytea not null check (octet_length(secret) = 32),
  created_at timestamptz not null default now()
);

insert into private.crew_invite_code_secrets (singleton, secret)
values (true, extensions.gen_random_bytes(32))
on conflict (singleton) do nothing;

create table if not exists private.crew_invite_rate_limits (
  scope_hash text primary key check (scope_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null,
  attempt_count integer not null check (attempt_count > 0),
  updated_at timestamptz not null default now()
);

create index if not exists crew_invite_rate_limits_updated_idx
  on private.crew_invite_rate_limits (updated_at);

alter table private.crew_invite_code_secrets enable row level security;
alter table private.crew_invite_rate_limits enable row level security;

revoke all on table private.crew_invite_code_secrets
  from public, anon, authenticated, service_role;
revoke all on table private.crew_invite_rate_limits
  from public, anon, authenticated, service_role;

create or replace function private.normalize_crew_invite_code(target_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.regexp_replace(
    pg_catalog.upper(coalesce(target_code, '')),
    '[[:space:]-]+',
    '',
    'g'
  );
$$;

create or replace function private.generate_crew_invite_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  alphabet constant text := '34679ACDEFGHJKMNPQRTUVWXY';
  random_batch bytea;
  random_value integer;
  generated_code text := '';
begin
  -- Reject the top six byte values so modulo 25 is uniform (250 is the
  -- largest multiple of 25 below 256). The resulting 16-character code has
  -- roughly 74 bits of entropy without ambiguous glyphs.
  while pg_catalog.char_length(generated_code) < 16 loop
    random_batch := extensions.gen_random_bytes(32);
    for character_index in 0..31 loop
      random_value := pg_catalog.get_byte(random_batch, character_index);
      if random_value < 250 then
        generated_code := generated_code || pg_catalog.substr(
          alphabet,
          (random_value % 25) + 1,
          1
        );
        exit when pg_catalog.char_length(generated_code) = 16;
      end if;
    end loop;
  end loop;

  return generated_code;
end;
$$;

create or replace function private.crew_invite_keyed_hash(
  target_domain text,
  target_value text
)
returns text
language sql
stable
strict
security definer
set search_path = ''
as $$
  select pg_catalog.encode(
    extensions.hmac(
      pg_catalog.convert_to(target_domain || ':' || target_value, 'UTF8'),
      secret_row.secret,
      'sha256'
    ),
    'hex'
  )
  from private.crew_invite_code_secrets secret_row
  where secret_row.singleton;
$$;

create or replace function private.consume_crew_invite_rate_limit(
  target_scope text,
  target_limit integer,
  target_window interval
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  scope_digest text;
  next_attempt_count integer;
begin
  if coalesce(target_scope, '') = ''
    or target_limit not between 1 and 10000
    or target_window < interval '1 minute'
    or target_window > interval '1 day' then
    raise exception 'Invalid crew invite rate-limit configuration.'
      using errcode = '22023';
  end if;

  scope_digest := private.crew_invite_keyed_hash('rate-v1', target_scope);

  insert into private.crew_invite_rate_limits (
    scope_hash,
    window_started_at,
    attempt_count,
    updated_at
  ) values (
    scope_digest,
    pg_catalog.now(),
    1,
    pg_catalog.now()
  )
  on conflict (scope_hash) do update
  set window_started_at = case
        when private.crew_invite_rate_limits.window_started_at
          <= pg_catalog.now() - target_window
          then pg_catalog.now()
        else private.crew_invite_rate_limits.window_started_at
      end,
      attempt_count = case
        when private.crew_invite_rate_limits.window_started_at
          <= pg_catalog.now() - target_window
          then 1
        else private.crew_invite_rate_limits.attempt_count + 1
      end,
      updated_at = pg_catalog.now()
  returning attempt_count into next_attempt_count;

  return next_attempt_count <= target_limit;
end;
$$;

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
      and exists (
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
  );
$$;

create or replace function private.preview_resolved_crew_invite(
  target_invite_id uuid,
  target_create_continuation boolean,
  target_hide_unauthenticated_failures boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  invite_row public.crew_invites%rowtype;
  crew_row public.crews%rowtype;
  continuation_secret text;
  inviter_first_name text;
  invite_status text;
  preview_payload jsonb;
  member_count integer;
  hide_failure boolean := target_hide_unauthenticated_failures and caller_id is null;
begin
  select source_invite.*
    into invite_row
    from public.crew_invites source_invite
    where source_invite.id = target_invite_id
    for update;

  if not found then
    return pg_catalog.jsonb_build_object('status', 'invalid');
  end if;

  if not private.crew_invite_issuer_is_authorized(
    invite_row.crew_id,
    invite_row.created_by
  ) then
    return pg_catalog.jsonb_build_object('status', 'invalid');
  end if;

  if invite_row.revoked_at is not null then
    return pg_catalog.jsonb_build_object(
      'status',
      case when hide_failure then 'invalid' else 'revoked' end
    );
  end if;

  if invite_row.expires_at <= pg_catalog.now() then
    return pg_catalog.jsonb_build_object(
      'status',
      case when hide_failure then 'invalid' else 'expired' end
    );
  end if;

  select source_crew.*
    into crew_row
    from public.crews source_crew
    where source_crew.id = invite_row.crew_id
      and source_crew.deleted_at is null;
  if not found then
    return pg_catalog.jsonb_build_object('status', 'invalid');
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

  if invite_row.redeemed_by is not null then
    if caller_id = invite_row.redeemed_by and exists (
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
    return pg_catalog.jsonb_build_object(
      'status',
      case when hide_failure then 'invalid' else 'already_used' end
    );
  end if;

  if caller_id is not null and exists (
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

  select pg_catalog.count(*)::integer
    into member_count
    from public.crew_members member_row
    where member_row.crew_id = invite_row.crew_id;

  if member_count >= crew_row.member_limit then
    invite_status := 'full';
  elsif caller_id is not null and exists (
    select 1
    from public.crew_members member_row
    where member_row.user_id = caller_id
      and member_row.crew_id <> invite_row.crew_id
  ) then
    invite_status := 'current_crew_conflict';
  else
    invite_status := 'ready';
  end if;

  if hide_failure and invite_status <> 'ready' then
    return pg_catalog.jsonb_build_object('status', 'invalid');
  end if;

  -- Hidden lifecycle failures must not touch the invite-specific bucket. The
  -- code wrapper routes them through the same keyed invalid-lookup bucket as
  -- nonexistent and malformed codes so repetition cannot become an oracle.
  if target_create_continuation then
    if invite_row.preview_window_started_at is null
      or invite_row.preview_window_started_at <= pg_catalog.now() - interval '1 hour' then
      update public.crew_invites
      set preview_window_started_at = pg_catalog.now(),
          preview_count = 1
      where id = invite_row.id
      returning * into invite_row;
    elsif invite_row.preview_count >= 120 then
      return pg_catalog.jsonb_build_object('status', 'rate_limited');
    else
      update public.crew_invites
      set preview_count = preview_count + 1
      where id = invite_row.id
      returning * into invite_row;
    end if;
  end if;

  if target_create_continuation
    and invite_status in ('ready', 'full', 'current_crew_conflict') then
    continuation_secret := pg_catalog.encode(
      extensions.gen_random_bytes(32),
      'hex'
    );
    insert into public.crew_invite_sessions (
      invite_id,
      continuation_hash,
      bound_user_id,
      expires_at
    ) values (
      invite_row.id,
      public.crew_invite_secret_hash(continuation_secret),
      caller_id,
      pg_catalog.now() + interval '2 hours'
    );
  end if;

  if invite_status in ('ready', 'current_crew_conflict') then
    return pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'status', invite_status,
      'preview', preview_payload,
      'continuationToken', continuation_secret
    ));
  end if;

  return pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'status', invite_status,
    'continuationToken', continuation_secret
  ));
end;
$$;

-- Existing invites cannot be assigned a recoverable plaintext code. Retire any
-- still-active predecessor so the next explicit generation produces all three
-- representations together.
update public.crew_invites
set revoked_at = coalesce(revoked_at, pg_catalog.now())
where code_hash is null
  and revoked_at is null
  and redeemed_at is null;

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
begin
  if caller_id is null then
    return pg_catalog.jsonb_build_object('status', 'authentication_required');
  end if;

  if not exists (
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
  if not found or exists (
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

create or replace function public.issue_crew_invite(target_crew_id uuid)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select public.issue_crew_invite_bundle(target_crew_id);
$$;

create or replace function public.get_active_crew_invite(target_crew_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  invite_row public.crew_invites%rowtype;
begin
  if caller_id is null then
    return pg_catalog.jsonb_build_object('status', 'authentication_required');
  end if;

  if not exists (
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

  select source_invite.*
    into invite_row
    from public.crew_invites source_invite
    where source_invite.crew_id = target_crew_id
      and source_invite.code_hash is not null
      and source_invite.revoked_at is null
      and source_invite.redeemed_at is null
      and source_invite.expires_at > pg_catalog.now()
      and private.crew_invite_issuer_is_authorized(
        source_invite.crew_id,
        source_invite.created_by
      )
    order by source_invite.created_at desc
    limit 1;

  if not found then
    return pg_catalog.jsonb_build_object('status', 'none');
  end if;

  return pg_catalog.jsonb_build_object(
    'status', 'active',
    'inviteId', invite_row.id,
    'codeHint', invite_row.code_hint,
    'expiresAt', invite_row.expires_at,
    'createdAt', invite_row.created_at
  );
end;
$$;

create or replace function public.preview_crew_invite(
  invite_token text default null,
  continuation_token text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  resolved_invite_id uuid;
  session_row public.crew_invite_sessions%rowtype;
begin
  if (invite_token is null) = (continuation_token is null) then
    return pg_catalog.jsonb_build_object('status', 'invalid');
  end if;

  if invite_token is not null then
    if pg_catalog.char_length(invite_token) < 16
      or pg_catalog.char_length(invite_token) > 256
      or invite_token !~ '^[A-Za-z0-9_-]+$' then
      return pg_catalog.jsonb_build_object('status', 'invalid');
    end if;

    select invite_row.id
      into resolved_invite_id
      from public.crew_invites invite_row
      where invite_row.token_hash = public.crew_invite_secret_hash(invite_token)
      limit 1;

    if not found then
      return pg_catalog.jsonb_build_object('status', 'invalid');
    end if;

    return private.preview_resolved_crew_invite(
      resolved_invite_id,
      true,
      false
    );
  end if;

  if pg_catalog.char_length(continuation_token) < 16
    or pg_catalog.char_length(continuation_token) > 256
    or continuation_token !~ '^[A-Za-z0-9_-]+$' then
    return pg_catalog.jsonb_build_object('status', 'invalid');
  end if;

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

  if caller_id is not null
    and session_row.bound_user_id is not null
    and session_row.bound_user_id <> caller_id then
    return pg_catalog.jsonb_build_object('status', 'wrong_account');
  end if;

  if caller_id is not null and session_row.bound_user_id is null then
    update public.crew_invite_sessions
    set bound_user_id = caller_id,
        last_seen_at = pg_catalog.now()
    where id = session_row.id;
  else
    update public.crew_invite_sessions
    set last_seen_at = pg_catalog.now()
    where id = session_row.id;
  end if;

  return private.preview_resolved_crew_invite(
    session_row.invite_id,
    false,
    false
  );
end;
$$;

create or replace function public.preview_crew_invite_code(invite_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  normalized_code text;
  resolved_invite_id uuid;
  lookup_scope text;
  attempt_allowed boolean;
  preview_result jsonb;
begin
  normalized_code := private.normalize_crew_invite_code(invite_code);
  lookup_scope := case
    when caller_id is null then 'lookup:anonymous'
    else 'lookup:account:' || caller_id::text
  end;

  if pg_catalog.char_length(normalized_code) <> 16
    or normalized_code !~ '^[34679ACDEFGHJKMNPQRTUVWXY]{16}$' then
    attempt_allowed := private.consume_crew_invite_rate_limit(
      lookup_scope,
      case when caller_id is null then 50 else 20 end,
      interval '15 minutes'
    );
    return pg_catalog.jsonb_build_object(
      'status',
      case when attempt_allowed then 'invalid' else 'rate_limited' end
    );
  end if;

  select invite_row.id
    into resolved_invite_id
    from public.crew_invites invite_row
    where invite_row.code_hash = private.crew_invite_keyed_hash(
      'code-v1',
      normalized_code
    )
    limit 1;

  if not found then
    attempt_allowed := private.consume_crew_invite_rate_limit(
      lookup_scope,
      case when caller_id is null then 50 else 20 end,
      interval '15 minutes'
    );
    return pg_catalog.jsonb_build_object(
      'status',
      case when attempt_allowed then 'invalid' else 'rate_limited' end
    );
  end if;

  preview_result := private.preview_resolved_crew_invite(
    resolved_invite_id,
    true,
    true
  );
  if preview_result ->> 'status' = 'invalid' then
    attempt_allowed := private.consume_crew_invite_rate_limit(
      lookup_scope,
      case when caller_id is null then 50 else 20 end,
      interval '15 minutes'
    );
    return pg_catalog.jsonb_build_object(
      'status',
      case when attempt_allowed then 'invalid' else 'rate_limited' end
    );
  end if;
  return preview_result;
end;
$$;

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

  if not exists (
      select 1
      from public.entitlements entitlement
      where entitlement.user_id = invite_row.created_by
        and entitlement.entitlement_key = 'membership_active'
        and entitlement.status = 'active'
        and (entitlement.starts_at is null or entitlement.starts_at <= pg_catalog.now())
        and (entitlement.ends_at is null or entitlement.ends_at > pg_catalog.now())
    )
    or exists (
      select 1
      from private.retired_community_dr_quarantined_crews quarantine
      where quarantine.crew_id = invite_row.crew_id
    ) then
    return pg_catalog.jsonb_build_object('status', 'invalid');
  end if;

  if not exists (
    select 1
    from public.entitlements entitlement
    where entitlement.user_id = caller_id
      and entitlement.entitlement_key = 'membership_active'
      and entitlement.status = 'active'
      and (entitlement.starts_at is null or entitlement.starts_at <= pg_catalog.now())
      and (entitlement.ends_at is null or entitlement.ends_at > pg_catalog.now())
  ) then
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

revoke execute on function private.normalize_crew_invite_code(text)
  from public, anon, authenticated, service_role;
revoke execute on function private.generate_crew_invite_code()
  from public, anon, authenticated, service_role;
revoke execute on function private.crew_invite_keyed_hash(text, text)
  from public, anon, authenticated, service_role;
revoke execute on function private.consume_crew_invite_rate_limit(text, integer, interval)
  from public, anon, authenticated, service_role;
revoke execute on function private.crew_invite_issuer_is_authorized(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke execute on function private.preview_resolved_crew_invite(uuid, boolean, boolean)
  from public, anon, authenticated, service_role;

revoke all on table public.crew_invites from anon, authenticated;
grant select (
  id,
  crew_id,
  created_by,
  expires_at,
  revoked_at,
  redeemed_at,
  created_at
) on public.crew_invites to authenticated;

revoke execute on function public.issue_crew_invite_bundle(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.issue_crew_invite_bundle(uuid) to authenticated;

revoke execute on function public.issue_crew_invite(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.issue_crew_invite(uuid) to authenticated;

revoke execute on function public.get_active_crew_invite(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_active_crew_invite(uuid) to authenticated;

revoke execute on function public.preview_crew_invite(text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.preview_crew_invite(text, text)
  to anon, authenticated;

revoke execute on function public.preview_crew_invite_code(text)
  from public, anon, authenticated, service_role;
grant execute on function public.preview_crew_invite_code(text)
  to anon, authenticated;

revoke execute on function public.confirm_crew_invite(text)
  from public, anon, authenticated, service_role;
grant execute on function public.confirm_crew_invite(text) to authenticated;

commit;
