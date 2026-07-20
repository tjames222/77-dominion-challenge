begin;

create extension if not exists pgcrypto with schema extensions;

-- The legacy RPC joined immediately from a reusable plaintext token. Remove it
-- before replacing the token column so opening a link can never mutate membership.
drop function if exists public.join_crew_by_invite(text);

alter table public.crews
  add column if not exists member_limit smallint not null default 50;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'crews_member_limit_check'
      and conrelid = 'public.crews'::regclass
  ) then
    alter table public.crews
      add constraint crews_member_limit_check check (member_limit between 2 and 500);
  end if;
end;
$$;

alter table public.crew_invites
  add column if not exists token_hash text,
  add column if not exists token_hint text,
  add column if not exists redeemed_by uuid references auth.users(id) on delete set null,
  add column if not exists redeemed_at timestamptz,
  add column if not exists preview_window_started_at timestamptz,
  add column if not exists preview_count integer not null default 0;

-- Preserve deployed links during migration, then remove every plaintext secret.
update public.crew_invites
set token_hash = encode(extensions.digest(token, 'sha256'), 'hex'),
    token_hint = right(token, 6)
where token_hash is null
  and token is not null;

alter table public.crew_invites
  alter column token_hash set not null;

alter table public.crew_invites
  drop column if exists token;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'crew_invites_token_hash_key'
      and conrelid = 'public.crew_invites'::regclass
  ) then
    alter table public.crew_invites
      add constraint crew_invites_token_hash_key unique (token_hash);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'crew_invites_token_hash_format_check'
      and conrelid = 'public.crew_invites'::regclass
  ) then
    alter table public.crew_invites
      add constraint crew_invites_token_hash_format_check check (token_hash ~ '^[0-9a-f]{64}$');
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'crew_invites_token_hint_format_check'
      and conrelid = 'public.crew_invites'::regclass
  ) then
    alter table public.crew_invites
      add constraint crew_invites_token_hint_format_check check (token_hint is null or token_hint ~ '^[A-Za-z0-9_-]{1,6}$');
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'crew_invites_redemption_pair_check'
      and conrelid = 'public.crew_invites'::regclass
  ) then
    alter table public.crew_invites
      add constraint crew_invites_redemption_pair_check check (
        (redeemed_by is null and redeemed_at is null)
        or (redeemed_by is not null and redeemed_at is not null)
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'crew_invites_preview_count_check'
      and conrelid = 'public.crew_invites'::regclass
  ) then
    alter table public.crew_invites
      add constraint crew_invites_preview_count_check check (preview_count >= 0);
  end if;
end;
$$;

create table if not exists public.crew_invite_sessions (
  id uuid primary key default gen_random_uuid(),
  invite_id uuid not null references public.crew_invites(id) on delete cascade,
  continuation_hash text not null unique check (continuation_hash ~ '^[0-9a-f]{64}$'),
  bound_user_id uuid references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  confirmation_attempts smallint not null default 0 check (confirmation_attempts between 0 and 6),
  confirmed_at timestamptz,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.crew_invite_attributions (
  id uuid primary key default gen_random_uuid(),
  invite_id uuid not null unique references public.crew_invites(id) on delete cascade,
  crew_id uuid not null references public.crews(id) on delete cascade,
  inviter_user_id uuid not null references auth.users(id) on delete cascade,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (crew_id, recipient_user_id),
  check (inviter_user_id <> recipient_user_id)
);

create or replace function public.reject_crew_invite_attribution_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.id is distinct from old.id
    or new.invite_id is distinct from old.invite_id
    or new.crew_id is distinct from old.crew_id
    or new.inviter_user_id is distinct from old.inviter_user_id
    or new.recipient_user_id is distinct from old.recipient_user_id
    or new.created_at is distinct from old.created_at then
    raise exception 'Crew invite attribution identity is immutable.';
  end if;
  return new;
end;
$$;

drop trigger if exists keep_crew_invite_attributions_immutable on public.crew_invite_attributions;
create trigger keep_crew_invite_attributions_immutable
  before update on public.crew_invite_attributions
  for each row execute function public.reject_crew_invite_attribution_mutation();

create index if not exists crew_invites_active_crew_idx
  on public.crew_invites (crew_id, created_at desc)
  where revoked_at is null and redeemed_at is null;

create index if not exists crew_invite_sessions_invite_idx
  on public.crew_invite_sessions (invite_id, created_at desc);

create index if not exists crew_invite_sessions_expiry_idx
  on public.crew_invite_sessions (expires_at);

create index if not exists crew_invite_attributions_inviter_idx
  on public.crew_invite_attributions (inviter_user_id, created_at desc);

create or replace function public.crew_invite_secret_hash(secret_value text)
returns text
language sql
immutable
strict
set search_path = public, extensions
as $$
  select encode(digest(secret_value, 'sha256'), 'hex');
$$;

create or replace function public.issue_crew_invite(target_crew_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  caller_id uuid := auth.uid();
  issued_token text;
  issued_invite public.crew_invites%rowtype;
  recent_count integer;
  latest_created_at timestamptz;
begin
  if caller_id is null then
    return jsonb_build_object('status', 'authentication_required');
  end if;

  if not public.has_active_entitlement('membership_active')
    or not public.can_manage_crew(target_crew_id) then
    return jsonb_build_object('status', 'forbidden');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('crew-invite:' || target_crew_id::text, 0));

  select count(*)::integer, max(created_at)
    into recent_count, latest_created_at
    from public.crew_invites
    where crew_id = target_crew_id
      and created_by = caller_id
      and created_at between now() - interval '1 hour' and now() + interval '1 minute';

  if recent_count >= 10
    or (latest_created_at is not null and latest_created_at > now() - interval '5 seconds') then
    return jsonb_build_object('status', 'rate_limited');
  end if;

  update public.crew_invites
  set revoked_at = now()
  where crew_id = target_crew_id
    and revoked_at is null
    and redeemed_at is null;

  issued_token := encode(gen_random_bytes(32), 'hex');
  insert into public.crew_invites (
    crew_id,
    token_hash,
    token_hint,
    created_by,
    expires_at
  ) values (
    target_crew_id,
    public.crew_invite_secret_hash(issued_token),
    right(issued_token, 6),
    caller_id,
    now() + interval '14 days'
  )
  returning * into issued_invite;

  return jsonb_build_object(
    'status', 'issued',
    'inviteId', issued_invite.id,
    'token', issued_token,
    'tokenHint', issued_invite.token_hint,
    'expiresAt', issued_invite.expires_at
  );
end;
$$;

create or replace function public.revoke_crew_invite(target_invite_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_id uuid := auth.uid();
  target_crew_id uuid;
begin
  if caller_id is null then
    return jsonb_build_object('status', 'authentication_required');
  end if;

  select crew_id
    into target_crew_id
    from public.crew_invites
    where id = target_invite_id;

  if target_crew_id is null
    or not public.has_active_entitlement('membership_active')
    or not public.can_manage_crew(target_crew_id) then
    return jsonb_build_object('status', 'forbidden');
  end if;

  update public.crew_invites
  set revoked_at = coalesce(revoked_at, now())
  where id = target_invite_id
    and redeemed_at is null;

  return jsonb_build_object('status', 'revoked');
end;
$$;

create or replace function public.preview_crew_invite(
  invite_token text default null,
  continuation_token text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  caller_id uuid := auth.uid();
  invite_row public.crew_invites%rowtype;
  session_row public.crew_invite_sessions%rowtype;
  crew_row public.crews%rowtype;
  continuation_secret text;
  inviter_first_name text;
  invite_status text;
  preview_payload jsonb;
  member_count integer;
begin
  if (invite_token is null) = (continuation_token is null) then
    return jsonb_build_object('status', 'invalid');
  end if;

  if invite_token is not null then
    if char_length(invite_token) < 16 or char_length(invite_token) > 256
      or invite_token !~ '^[A-Za-z0-9_-]+$' then
      return jsonb_build_object('status', 'invalid');
    end if;

    select *
      into invite_row
      from public.crew_invites
      where token_hash = public.crew_invite_secret_hash(invite_token)
      limit 1
      for update;

    if not found then
      return jsonb_build_object('status', 'invalid');
    end if;

    if invite_row.preview_window_started_at is null
      or invite_row.preview_window_started_at <= now() - interval '1 hour' then
      update public.crew_invites
      set preview_window_started_at = now(), preview_count = 1
      where id = invite_row.id
      returning * into invite_row;
    elsif invite_row.preview_count >= 120 then
      return jsonb_build_object('status', 'rate_limited');
    else
      update public.crew_invites
      set preview_count = preview_count + 1
      where id = invite_row.id
      returning * into invite_row;
    end if;
  else
    if char_length(continuation_token) < 16 or char_length(continuation_token) > 256
      or continuation_token !~ '^[A-Za-z0-9_-]+$' then
      return jsonb_build_object('status', 'invalid');
    end if;

    select *
      into session_row
      from public.crew_invite_sessions
      where continuation_hash = public.crew_invite_secret_hash(continuation_token)
      limit 1
      for update;

    if not found then
      return jsonb_build_object('status', 'invalid');
    end if;

    if session_row.expires_at <= now() then
      return jsonb_build_object('status', 'session_expired');
    end if;

    if caller_id is not null and session_row.bound_user_id is not null
      and session_row.bound_user_id <> caller_id then
      return jsonb_build_object('status', 'wrong_account');
    end if;

    if caller_id is not null and session_row.bound_user_id is null then
      update public.crew_invite_sessions
      set bound_user_id = caller_id, last_seen_at = now()
      where id = session_row.id
      returning * into session_row;
    else
      update public.crew_invite_sessions
      set last_seen_at = now()
      where id = session_row.id;
    end if;

    select *
      into invite_row
      from public.crew_invites
      where id = session_row.invite_id
      for update;

    if not found then
      return jsonb_build_object('status', 'invalid');
    end if;
  end if;

  if invite_row.revoked_at is not null then
    return jsonb_build_object('status', 'revoked');
  end if;

  if invite_row.expires_at <= now() then
    return jsonb_build_object('status', 'expired');
  end if;

  select * into crew_row
    from public.crews
    where id = invite_row.crew_id;
  if not found then
    return jsonb_build_object('status', 'invalid');
  end if;

  select split_part(coalesce(nullif(trim(name), ''), 'Dominion member'), ' ', 1)
    into inviter_first_name
    from public.profiles
    where user_id = invite_row.created_by;

  preview_payload := jsonb_build_object(
    'groupName', crew_row.name,
    'inviterName', coalesce(inviter_first_name, 'Dominion member'),
    'expiresAt', invite_row.expires_at
  );

  if invite_row.redeemed_by is not null then
    if caller_id = invite_row.redeemed_by and exists (
      select 1 from public.crew_members
      where crew_id = invite_row.crew_id and user_id = caller_id
    ) then
      return jsonb_build_object('status', 'already_member', 'preview', preview_payload);
    end if;
    return jsonb_build_object('status', 'already_used');
  end if;

  if caller_id is not null and exists (
    select 1 from public.crew_members
    where crew_id = invite_row.crew_id and user_id = caller_id
  ) then
    return jsonb_build_object('status', 'already_member', 'preview', preview_payload);
  end if;

  select count(*)::integer into member_count
    from public.crew_members
    where crew_id = invite_row.crew_id;

  invite_status := case when member_count >= crew_row.member_limit then 'full' else 'ready' end;

  if invite_token is not null and invite_status in ('ready', 'full') then
    continuation_secret := encode(gen_random_bytes(32), 'hex');
    insert into public.crew_invite_sessions (
      invite_id,
      continuation_hash,
      bound_user_id,
      expires_at
    ) values (
      invite_row.id,
      public.crew_invite_secret_hash(continuation_secret),
      caller_id,
      now() + interval '2 hours'
    );
  end if;

  if invite_status = 'ready' then
    return jsonb_strip_nulls(jsonb_build_object(
      'status', invite_status,
      'preview', preview_payload,
      'continuationToken', continuation_secret
    ));
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'status', invite_status,
    'continuationToken', continuation_secret
  ));
end;
$$;

create or replace function public.confirm_crew_invite(continuation_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  caller_id uuid := auth.uid();
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
    return jsonb_build_object('status', 'authentication_required');
  end if;

  if continuation_token is null
    or char_length(continuation_token) < 16
    or char_length(continuation_token) > 256
    or continuation_token !~ '^[A-Za-z0-9_-]+$' then
    return jsonb_build_object('status', 'invalid');
  end if;

  select *
    into session_row
    from public.crew_invite_sessions
    where continuation_hash = public.crew_invite_secret_hash(continuation_token)
    limit 1
    for update;

  if not found then
    return jsonb_build_object('status', 'invalid');
  end if;

  if session_row.expires_at <= now() then
    return jsonb_build_object('status', 'session_expired');
  end if;

  if session_row.bound_user_id is not null and session_row.bound_user_id <> caller_id then
    return jsonb_build_object('status', 'wrong_account');
  end if;

  if session_row.confirmation_attempts >= 5 then
    return jsonb_build_object('status', 'rate_limited');
  end if;

  update public.crew_invite_sessions
  set bound_user_id = caller_id,
      confirmation_attempts = confirmation_attempts + 1,
      last_seen_at = now()
  where id = session_row.id
  returning * into session_row;

  select *
    into invite_row
    from public.crew_invites
    where id = session_row.invite_id
    for update;

  if not found then
    return jsonb_build_object('status', 'invalid');
  end if;

  if invite_row.revoked_at is not null then
    return jsonb_build_object('status', 'revoked');
  end if;

  if invite_row.expires_at <= now() then
    return jsonb_build_object('status', 'expired');
  end if;

  select * into crew_row
    from public.crews
    where id = invite_row.crew_id
    for update;
  if not found then
    return jsonb_build_object('status', 'invalid');
  end if;

  select split_part(coalesce(nullif(trim(name), ''), 'Dominion member'), ' ', 1)
    into inviter_first_name
    from public.profiles
    where user_id = invite_row.created_by;
  preview_payload := jsonb_build_object(
    'groupName', crew_row.name,
    'inviterName', coalesce(inviter_first_name, 'Dominion member'),
    'expiresAt', invite_row.expires_at
  );

  if exists (
    select 1 from public.crew_members
    where crew_id = invite_row.crew_id and user_id = caller_id
  ) then
    return jsonb_build_object('status', 'already_member', 'preview', preview_payload);
  end if;

  if invite_row.redeemed_by is not null then
    return jsonb_build_object('status', 'already_used');
  end if;

  if not public.has_active_entitlement('membership_active') then
    return jsonb_build_object('status', 'subscription_required');
  end if;

  select count(*)::integer into member_count
    from public.crew_members
    where crew_id = invite_row.crew_id;
  if member_count >= crew_row.member_limit then
    return jsonb_build_object('status', 'full');
  end if;

  if exists (
    select 1 from public.crew_invite_attributions
    where crew_id = invite_row.crew_id and recipient_user_id = caller_id
  ) then
    return jsonb_build_object('status', 'already_used');
  end if;

  select coalesce(nullif(p.name, ''), 'Member'), coalesce(p.avatar_url, '')
    into member_name, member_avatar_url
    from public.profiles p
    where p.user_id = caller_id;

  insert into public.crew_members (crew_id, user_id, display_name, avatar_url, role)
  values (
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
      redeemed_at = now()
  where id = invite_row.id;

  update public.crew_invite_sessions
  set confirmed_at = now()
  where id = session_row.id;

  return jsonb_build_object(
    'status', 'joined',
    'crewId', invite_row.crew_id,
    'redemptionId', redemption_id,
    'preview', preview_payload
  );
end;
$$;

alter table public.crew_invite_sessions enable row level security;
alter table public.crew_invite_attributions enable row level security;

drop policy if exists "Crew admins can create invites" on public.crew_invites;
drop policy if exists "Crew admins can update invites" on public.crew_invites;

revoke all on table public.crew_invites from anon;
revoke all on table public.crew_invites from authenticated;
grant select (id, crew_id, created_by, expires_at, revoked_at, redeemed_at, created_at)
  on public.crew_invites to authenticated;

revoke all on table public.crew_invite_sessions from anon;
revoke all on table public.crew_invite_sessions from authenticated;
revoke all on table public.crew_invite_attributions from anon;
revoke all on table public.crew_invite_attributions from authenticated;

revoke execute on function public.crew_invite_secret_hash(text) from public;
revoke execute on function public.crew_invite_secret_hash(text) from anon;
revoke execute on function public.crew_invite_secret_hash(text) from authenticated;
revoke execute on function public.reject_crew_invite_attribution_mutation() from public;
revoke execute on function public.reject_crew_invite_attribution_mutation() from anon;
revoke execute on function public.reject_crew_invite_attribution_mutation() from authenticated;

revoke execute on function public.issue_crew_invite(uuid) from public;
revoke execute on function public.issue_crew_invite(uuid) from anon;
grant execute on function public.issue_crew_invite(uuid) to authenticated;

revoke execute on function public.revoke_crew_invite(uuid) from public;
revoke execute on function public.revoke_crew_invite(uuid) from anon;
grant execute on function public.revoke_crew_invite(uuid) to authenticated;

revoke execute on function public.preview_crew_invite(text, text) from public;
grant execute on function public.preview_crew_invite(text, text) to anon;
grant execute on function public.preview_crew_invite(text, text) to authenticated;

revoke execute on function public.confirm_crew_invite(text) from public;
revoke execute on function public.confirm_crew_invite(text) from anon;
grant execute on function public.confirm_crew_invite(text) to authenticated;

commit;
