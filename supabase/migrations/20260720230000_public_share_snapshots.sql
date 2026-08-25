-- Privacy-safe, immutable public snapshots for streak, challenge-progress, and
-- general Dominion shares. Public tokens are returned once and stored only as
-- SHA-256 digests so a database read cannot recover usable share URLs.

create table if not exists public.public_share_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  public_token_digest bytea not null unique,
  snapshot_version integer not null default 1 check (snapshot_version = 1),
  share_kind text not null check (share_kind in ('streak', 'progress', 'general')),
  snapshot_payload jsonb not null check (jsonb_typeof(snapshot_payload) = 'object'),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_reason text check (revoked_reason is null or revoked_reason in ('user', 'challenge_reset', 'safety')),
  aggregate_view_count bigint not null default 0 check (aggregate_view_count >= 0),
  last_viewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (octet_length(public_token_digest) = 32),
  check (expires_at > created_at),
  check ((revoked_at is null) = (revoked_reason is null))
);

create index if not exists public_share_snapshots_user_created_idx
  on public.public_share_snapshots (user_id, created_at desc);

create index if not exists public_share_snapshots_expiry_idx
  on public.public_share_snapshots (expires_at)
  where revoked_at is null;

alter table public.public_share_snapshots enable row level security;

revoke all on table public.public_share_snapshots from public, anon, authenticated;

create or replace function public.build_share_snapshot_payload(
  target_user_id uuid,
  target_kind text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  stats_row public.user_game_stats%rowtype;
  current_challenge_day integer := 0;
begin
  if target_user_id is null then
    raise exception 'A user is required.';
  end if;
  if target_kind is null or target_kind not in ('streak', 'progress', 'general') then
    raise exception 'Unsupported share type.';
  end if;

  if target_kind = 'streak' then
    select *
      into stats_row
      from public.user_game_stats
     where user_id = target_user_id;

    return jsonb_build_object(
      'schemaVersion', 1,
      'kind', 'streak',
      'appStreak', greatest(coalesce(stats_row.current_app_streak, 0), 0),
      'fullStandardStreak', greatest(coalesce(stats_row.current_full_day_streak, 0), 0)
    );
  end if;

  if target_kind = 'progress' then
    select least(greatest(coalesce(max(challenge_day), 0), 0), 77)
      into current_challenge_day
      from public.check_ins
     where user_id = target_user_id;

    return jsonb_build_object(
      'schemaVersion', 1,
      'kind', 'progress',
      'currentChallengeDay', current_challenge_day,
      'challengeLength', 77,
      'percentComplete', round((current_challenge_day::numeric / 77::numeric) * 100, 1)
    );
  end if;

  return jsonb_build_object(
    'schemaVersion', 1,
    'kind', 'general',
    'challengeLength', 77,
    'dailyStandards', 7
  );
end;
$$;

create or replace function public.preview_share_snapshot(target_kind text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null then
    raise exception 'Not authenticated.' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'schemaVersion', 1,
    'kind', target_kind,
    'payload', public.build_share_snapshot_payload(current_user_id, target_kind),
    'defaultExpirationDays', 30,
    'privacy', jsonb_build_object(
      'includesIdentity', false,
      'includesGroup', false,
      'includesActivityHistory', false
    )
  );
end;
$$;

create or replace function public.create_share_snapshot(
  target_kind text,
  target_expires_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  current_user_id uuid := auth.uid();
  raw_token text;
  new_snapshot_id uuid;
  normalized_expires_at timestamptz := coalesce(target_expires_at, now() + interval '30 days');
  payload jsonb;
  recent_count integer;
  active_count integer;
begin
  if current_user_id is null then
    raise exception 'Not authenticated.' using errcode = '42501';
  end if;
  if target_kind is null or target_kind not in ('streak', 'progress', 'general') then
    raise exception 'Unsupported share type.';
  end if;
  if normalized_expires_at < now() + interval '1 hour'
     or normalized_expires_at > now() + interval '90 days' then
    raise exception 'Share expiration must be between one hour and 90 days.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('share-snapshot:' || current_user_id::text, 0));

  select count(*)::integer
    into recent_count
    from public.public_share_snapshots
   where user_id = current_user_id
     and created_at > now() - interval '1 hour';
  if recent_count >= 10 then
    raise exception 'Share link rate limit reached. Try again later.' using errcode = 'P0001';
  end if;

  select count(*)::integer
    into active_count
    from public.public_share_snapshots
   where user_id = current_user_id
     and revoked_at is null
     and expires_at > now();
  if active_count >= 25 then
    raise exception 'Revoke an existing share link before creating another.' using errcode = 'P0001';
  end if;

  payload := public.build_share_snapshot_payload(current_user_id, target_kind);
  raw_token := encode(gen_random_bytes(32), 'hex');

  insert into public.public_share_snapshots (
    user_id,
    public_token_digest,
    snapshot_version,
    share_kind,
    snapshot_payload,
    expires_at
  ) values (
    current_user_id,
    digest(raw_token, 'sha256'),
    1,
    target_kind,
    payload,
    normalized_expires_at
  )
  returning id into new_snapshot_id;

  return jsonb_build_object(
    'schemaVersion', 1,
    'snapshotId', new_snapshot_id,
    'token', raw_token,
    'kind', target_kind,
    'payload', payload,
    'expiresAt', normalized_expires_at
  );
end;
$$;

create or replace function public.revoke_share_snapshot(target_snapshot_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  current_user_id uuid := auth.uid();
  changed_count integer := 0;
begin
  if current_user_id is null then
    raise exception 'Not authenticated.' using errcode = '42501';
  end if;

  update public.public_share_snapshots
     set revoked_at = now(),
         revoked_reason = 'user',
         updated_at = now()
   where id = target_snapshot_id
     and user_id = current_user_id
     and revoked_at is null;
  get diagnostics changed_count = row_count;
  return changed_count = 1;
end;
$$;

create or replace function public.get_public_share_snapshot(target_token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  result jsonb;
begin
  -- Invalid, revoked, expired, and unknown links intentionally share one null
  -- response so callers cannot distinguish or enumerate owner state.
  if target_token is null or target_token !~ '^[0-9a-f]{64}$' then
    return null;
  end if;

  update public.public_share_snapshots
     set aggregate_view_count = case
           when aggregate_view_count < 9223372036854775807 then aggregate_view_count + 1
           else aggregate_view_count
         end,
         last_viewed_at = now(),
         updated_at = now()
   where public_token_digest = digest(target_token, 'sha256')
     and revoked_at is null
     and expires_at > now()
  returning jsonb_build_object(
    'schemaVersion', snapshot_version,
    'kind', share_kind,
    'payload', snapshot_payload,
    'expiresAt', expires_at
  ) into result;

  return result;
end;
$$;

create or replace function public.revoke_share_snapshots_after_challenge_reset()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if new.challenge_start_date is distinct from old.challenge_start_date then
    update public.public_share_snapshots
       set revoked_at = now(),
           revoked_reason = 'challenge_reset',
           updated_at = now()
     where user_id = new.user_id
       and share_kind in ('streak', 'progress')
       and revoked_at is null;
  end if;
  return new;
end;
$$;

drop trigger if exists revoke_share_snapshots_after_challenge_reset on public.profiles;
create trigger revoke_share_snapshots_after_challenge_reset
  after update of challenge_start_date on public.profiles
  for each row
  execute function public.revoke_share_snapshots_after_challenge_reset();

create or replace function public.purge_retired_share_snapshots(
  target_retention interval default interval '30 days'
)
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  deleted_count bigint;
begin
  if target_retention < interval '1 day' or target_retention > interval '365 days' then
    raise exception 'Share retention must be between one and 365 days.';
  end if;

  delete from public.public_share_snapshots
   where (expires_at <= now() or revoked_at is not null)
     and coalesce(revoked_at, expires_at) <= now() - target_retention;
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.build_share_snapshot_payload(uuid, text) from public, anon, authenticated;
revoke all on function public.preview_share_snapshot(text) from public, anon;
revoke all on function public.create_share_snapshot(text, timestamptz) from public, anon;
revoke all on function public.revoke_share_snapshot(uuid) from public, anon;
revoke all on function public.get_public_share_snapshot(text) from public;
revoke all on function public.revoke_share_snapshots_after_challenge_reset() from public, anon, authenticated;
revoke all on function public.purge_retired_share_snapshots(interval) from public, anon, authenticated;

grant execute on function public.preview_share_snapshot(text) to authenticated;
grant execute on function public.create_share_snapshot(text, timestamptz) to authenticated;
grant execute on function public.revoke_share_snapshot(uuid) to authenticated;
grant execute on function public.get_public_share_snapshot(text) to anon, authenticated, service_role;
grant execute on function public.purge_retired_share_snapshots(interval) to service_role;
