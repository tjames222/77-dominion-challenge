-- New progress shares measure canonical submitted check-ins. Existing V1
-- snapshots retain their original meaning and are never rewritten.
-- Release prerequisite: deploy the compatible V1/V2 public renderer first.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.public_share_snapshots
  drop constraint public_share_snapshots_snapshot_version_check;
alter table public.public_share_snapshots
  add constraint public_share_snapshots_snapshot_version_check
  check (snapshot_version in (1, 2));

create or replace function public.build_share_snapshot_payload(
  target_user_id uuid,
  target_kind text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  stats_row public.user_game_stats%rowtype;
  original_start date;
  progress jsonb;
  submitted_count integer;
begin
  if target_user_id is null then
    raise exception 'A user is required.';
  end if;
  if target_kind is null or target_kind not in ('streak', 'progress', 'general') then
    raise exception 'Unsupported share type.';
  end if;

  if target_kind = 'streak' then
    select * into stats_row from public.user_game_stats
    where user_id = target_user_id;
    return pg_catalog.jsonb_build_object(
      'schemaVersion', 1, 'kind', 'streak',
      'appStreak', greatest(coalesce(stats_row.current_app_streak, 0), 0),
      'fullStandardStreak', greatest(coalesce(stats_row.current_full_day_streak, 0), 0)
    );
  end if;

  if target_kind = 'progress' then
    select profile.challenge_start_date into original_start
    from public.profiles profile where profile.user_id = target_user_id;
    if original_start is null or not pg_catalog.isfinite(original_start)
       or original_start not between date '0001-01-01' and date '9999-12-31' then
      raise exception 'Challenge progress is unavailable.' using errcode = 'P0001';
    end if;
    progress := private.original_77_progress_for_user(target_user_id, original_start);
    -- Do not coerce a malformed/unknown state to zero, clamp overflow, infer
    -- progress from an elapsed calendar day, or expose private event identity.
    if progress is null
       or pg_catalog.jsonb_typeof(progress) is distinct from 'object'
       or progress -> 'schemaVersion' is distinct from '1'::jsonb
       or progress ->> 'userId' is distinct from target_user_id::text
       or progress ->> 'instanceId' is distinct from
          'original77:' || pg_catalog.to_char(original_start, 'YYYY-MM-DD')
       or progress -> 'targetCount' is distinct from '77'::jsonb
       or coalesce(progress ->> 'completionState', '') not in (
         'in_progress', 'historical_provenance_pending', 'live_completed'
       )
       or pg_catalog.jsonb_typeof(progress -> 'submittedCount') is distinct from 'number'
       or coalesce(progress ->> 'submittedCount', '') !~ '^(0|[1-9][0-9]?)$' then
      raise exception 'Challenge progress is unavailable.' using errcode = 'P0001';
    end if;
    submitted_count := (progress ->> 'submittedCount')::integer;
    if submitted_count > 77
       or ((progress ->> 'completionState' = 'in_progress') is distinct from (submitted_count < 77)) then
      raise exception 'Challenge progress is unavailable.' using errcode = 'P0001';
    end if;
    return pg_catalog.jsonb_build_object(
      'schemaVersion', 2, 'kind', 'progress',
      'submittedCheckIns', submitted_count, 'targetCheckIns', 77
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'schemaVersion', 1, 'kind', 'general', 'challengeLength', 77, 'dailyStandards', 7
  );
end;
$$;

create or replace function public.preview_share_snapshot(target_kind text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  payload jsonb;
begin
  if current_user_id is null then
    raise exception 'Not authenticated.' using errcode = '42501';
  end if;
  payload := public.build_share_snapshot_payload(current_user_id, target_kind);
  return pg_catalog.jsonb_build_object(
    'schemaVersion', (payload ->> 'schemaVersion')::integer,
    'kind', target_kind, 'payload', payload, 'defaultExpirationDays', 30,
    'privacy', pg_catalog.jsonb_build_object(
      'includesIdentity', false, 'includesGroup', false, 'includesActivityHistory', false
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
set search_path = ''
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

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('share-snapshot:' || current_user_id::text, 0)
  );
  select count(*)::integer into recent_count from public.public_share_snapshots
  where user_id = current_user_id and created_at > now() - interval '1 hour';
  if recent_count >= 10 then
    raise exception 'Share link rate limit reached. Try again later.' using errcode = 'P0001';
  end if;
  select count(*)::integer into active_count from public.public_share_snapshots
  where user_id = current_user_id and revoked_at is null and expires_at > now();
  if active_count >= 25 then
    raise exception 'Revoke an existing share link before creating another.' using errcode = 'P0001';
  end if;

  payload := public.build_share_snapshot_payload(current_user_id, target_kind);
  raw_token := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.public_share_snapshots (
    user_id, public_token_digest, snapshot_version, share_kind, snapshot_payload, expires_at
  ) values (
    current_user_id, extensions.digest(raw_token, 'sha256'),
    (payload ->> 'schemaVersion')::integer, target_kind, payload, normalized_expires_at
  ) returning id into new_snapshot_id;
  return pg_catalog.jsonb_build_object(
    'schemaVersion', (payload ->> 'schemaVersion')::integer,
    'snapshotId', new_snapshot_id, 'token', raw_token,
    'kind', target_kind, 'payload', payload, 'expiresAt', normalized_expires_at
  );
end;
$$;

-- Preserve existing ownership and public-token boundaries. The builder is
-- never a browser RPC; callers only receive their own sanitized projection.
revoke all on function public.build_share_snapshot_payload(uuid, text)
  from public, anon, authenticated;
revoke all on function public.preview_share_snapshot(text) from public, anon;
revoke all on function public.create_share_snapshot(text, timestamptz) from public, anon;
grant execute on function public.preview_share_snapshot(text) to authenticated;
grant execute on function public.create_share_snapshot(text, timestamptz) to authenticated;
