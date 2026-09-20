-- Scoped awards are distinct records, including tied legacy/scoped timestamps.
-- Only presentation identity/pagination changes; crew authorization is retained.
set local lock_timeout = '5s';

-- Read only the recognized public fields from the immutable earned snapshot.
-- Malformed/missing values fall back to bounded canonical presentation data.
create function private.member_badge_presentation(
  snapshot jsonb, definition_name text, definition_description text,
  definition_tier text, definition_icon text
) returns jsonb language sql immutable security invoker set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'name', pg_catalog.left(coalesce(
      case when pg_catalog.jsonb_typeof(snapshot->'name') = 'string' then
        nullif(pg_catalog.btrim(pg_catalog.regexp_replace(snapshot->>'name','[[:cntrl:]]','','g')),'') end,
      nullif(pg_catalog.btrim(pg_catalog.regexp_replace(definition_name,'[[:cntrl:]]','','g')),''), 'Badge'),120),
    'description', pg_catalog.left(pg_catalog.regexp_replace(coalesce(
      case when pg_catalog.jsonb_typeof(snapshot->'description') = 'string' then snapshot->>'description' end,
      definition_description,''),'[[:cntrl:]]','','g'),500),
    'tier', case when pg_catalog.jsonb_typeof(snapshot->'tier') = 'string' and snapshot->>'tier' in ('bronze','silver','gold') then snapshot->>'tier'
      when definition_tier in ('bronze','silver','gold') then definition_tier else 'bronze' end,
    'icon', case when pg_catalog.jsonb_typeof(snapshot->'icon') = 'string' and snapshot->>'icon' ~ '^[a-z0-9_-]{1,40}$' then snapshot->>'icon'
      when definition_icon ~ '^[a-z0-9_-]{1,40}$' then definition_icon else 'shield' end);
$$;
revoke all on function private.member_badge_presentation(jsonb,text,text,text,text)
  from public, anon, authenticated, service_role;

drop function public.get_crew_member_progress_profile(uuid, uuid, timestamptz, text, integer);

create or replace function public.get_crew_member_progress_profile(
  target_crew_id uuid,
  target_user_id uuid,
  target_badge_cursor_earned_at timestamptz default null,
  target_badge_cursor_key text default null,
  target_badge_limit integer default 12,
  target_badge_cursor_award_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  normalized_limit integer := least(
    greatest(coalesce(target_badge_limit, 12), 1),
    24
  );
  required_members integer;
  locked_members integer;
  member_name text;
  member_avatar_url text;
  member_role text;
  member_level integer;
  total_badges integer;
  badge_page jsonb := '[]'::jsonb;
  page_has_more boolean := false;
  next_cursor_earned_at timestamptz;
  next_cursor_key text;
  next_cursor_award_id uuid;
  cursor_award_id uuid := target_badge_cursor_award_id;
  cursor_matches integer;
begin
  -- One generic response protects account and badge existence from probing.
  if caller_id is null
     or target_crew_id is null
     or target_user_id is null
     or (target_badge_cursor_award_id is not null and target_badge_cursor_earned_at is null)
     or ((target_badge_cursor_earned_at is null) <>
         (target_badge_cursor_key is null))
     or (target_badge_cursor_key is not null and (
       pg_catalog.length(target_badge_cursor_key) < 1
       or pg_catalog.length(target_badge_cursor_key) > 120
     )) then
    raise exception 'Member progress is no longer available.' using errcode = 'P0002';
  end if;

  -- Account erasure takes this key exclusively before touching memberships.
  -- Shared acquisition lets reads run together while preserving that lock
  -- hierarchy and preventing an erasure/read deadlock.
  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('retired-community-deletion', 0)
  );

  -- Lock the entitlement so a concurrent lapse either commits before this
  -- check (and is denied) or waits until this authorized read has completed.
  perform 1
  from public.entitlements entitlement
  where entitlement.user_id = caller_id
    and entitlement.entitlement_key = 'membership_active'
    and entitlement.status = 'active'
    and (entitlement.starts_at is null or entitlement.starts_at <= pg_catalog.now())
    and (entitlement.ends_at is null or entitlement.ends_at > pg_catalog.now())
  for share;
  if not found then
    raise exception 'Member progress is no longer available.' using errcode = 'P0002';
  end if;

  -- Crew and membership row locks serialize against leave/delete operations.
  perform 1
  from public.crews crew
  where crew.id = target_crew_id
    and crew.deleted_at is null
  for share;
  if not found then
    raise exception 'Member progress is no longer available.' using errcode = 'P0002';
  end if;

  perform 1
  from public.crew_members member
  where member.crew_id = target_crew_id
    and member.user_id in (caller_id, target_user_id)
  order by member.user_id
  for share;

  required_members := case when caller_id = target_user_id then 1 else 2 end;
  select pg_catalog.count(*)::integer
    into locked_members
  from public.crew_members member
  where member.crew_id = target_crew_id
    and member.user_id in (caller_id, target_user_id);
  if locked_members <> required_members then
    raise exception 'Member progress is no longer available.' using errcode = 'P0002';
  end if;

  select
    pg_catalog.left(
      pg_catalog.regexp_replace(
        coalesce(
          nullif(pg_catalog.btrim(profile.name), ''),
          nullif(pg_catalog.btrim(member.display_name), ''),
          'Member'
        ),
        '[[:cntrl:]]',
        '',
        'g'
      ),
      80
    ),
    pg_catalog.left(coalesce(profile.avatar_url, ''), 2048),
    case member.role
      when 'owner' then 'owner'
      when 'admin' then 'admin'
      else 'member'
    end,
    private.lifetime_level_from_points(stats.total_points)
  into member_name, member_avatar_url, member_role, member_level
  from public.crew_members member
  left join public.profiles profile on profile.user_id = member.user_id
  left join public.user_game_stats stats on stats.user_id = member.user_id
  where member.crew_id = target_crew_id
    and member.user_id = target_user_id;
  if not found then
    raise exception 'Member progress is no longer available.' using errcode = 'P0002';
  end if;


  -- Resolve an older named-argument client's cursor only when it identifies one
  -- award. Never silently skip tied lifetime/scoped rows. The caller can reload
  -- the first page and receive its stable UUID cursor.
  if target_badge_cursor_earned_at is not null then
    if cursor_award_id is null then
      select count(*)::integer, (array_agg(earned.id))[1]
        into cursor_matches, cursor_award_id
      from public.user_badges earned
      where earned.user_id = target_user_id
        and earned.earned_at = target_badge_cursor_earned_at
        and earned.badge_key = target_badge_cursor_key;
      if cursor_matches <> 1 then
        raise exception 'Badge history changed. Reload badges to start from the first page.'
          using errcode = '22023', detail = 'member_badge_cursor_restart_required';
      end if;
    elsif not exists (
      select 1 from public.user_badges earned
      where earned.user_id = target_user_id and earned.id = cursor_award_id
        and earned.earned_at = target_badge_cursor_earned_at
        and earned.badge_key = target_badge_cursor_key
    ) then
      raise exception 'Badge history changed. Reload badges to start from the first page.'
        using errcode = '22023', detail = 'member_badge_cursor_restart_required';
    end if;
  end if;

  select pg_catalog.count(*)::integer
    into total_badges
  from public.user_badges earned
  where earned.user_id = target_user_id;

  with candidate_badges as (
    select
      earned.id as award_id,
      earned.badge_key,
      earned.earned_at,
      presentation.value->>'name' as name,
      presentation.value->>'description' as description,
      presentation.value->>'tier' as tier,
      presentation.value->>'icon' as icon,
      pg_catalog.row_number() over (
        order by earned.earned_at desc, earned.badge_key asc, earned.id asc
      ) as page_position
    from public.user_badges earned
    join public.badge_definitions definition
      on definition.badge_key = earned.badge_key
    cross join lateral (select private.member_badge_presentation(
      earned.metadata->'awardDefinition', definition.name, definition.description,
      definition.tier, definition.icon) as value) presentation
    where earned.user_id = target_user_id
      and (
        target_badge_cursor_earned_at is null
        or earned.earned_at < target_badge_cursor_earned_at
        or (
          earned.earned_at = target_badge_cursor_earned_at
          and (earned.badge_key > target_badge_cursor_key
            or (earned.badge_key = target_badge_cursor_key and earned.id > cursor_award_id))
        )
      )
    order by earned.earned_at desc, earned.badge_key asc, earned.id asc
    limit normalized_limit + 1
  ), page_badges as (
    select *
    from candidate_badges
    where page_position <= normalized_limit
  )
  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'awardId', page.award_id,
          'key', pg_catalog.left(page.badge_key, 120),
          'name', pg_catalog.left(
            pg_catalog.regexp_replace(page.name, '[[:cntrl:]]', '', 'g'),
            120
          ),
          'description', pg_catalog.left(
            pg_catalog.regexp_replace(
              coalesce(page.description, ''),
              '[[:cntrl:]]',
              '',
              'g'
            ),
            500
          ),
          'tier', case page.tier
            when 'bronze' then 'bronze'
            when 'silver' then 'silver'
            when 'gold' then 'gold'
            else 'bronze'
          end,
          'icon', case
            when page.icon ~ '^[a-z0-9_-]{1,40}$' then page.icon
            else 'shield'
          end,
          'earnedAt', page.earned_at
        ) order by page.earned_at desc, page.badge_key asc, page.award_id asc
      ),
      '[]'::jsonb
    ),
    (select pg_catalog.count(*) > normalized_limit from candidate_badges),
    (select cursor_page.earned_at
       from page_badges cursor_page
       order by cursor_page.page_position desc
       limit 1),
    (select cursor_page.badge_key
       from page_badges cursor_page
       order by cursor_page.page_position desc
       limit 1),
    (select cursor_page.award_id
       from page_badges cursor_page
       order by cursor_page.page_position desc
       limit 1)
  into badge_page, page_has_more, next_cursor_earned_at, next_cursor_key, next_cursor_award_id
  from page_badges page;

  return pg_catalog.jsonb_build_object(
    'memberId', target_user_id,
    'displayName', member_name,
    'avatarUrl', member_avatar_url,
    'role', member_role,
    'level', member_level,
    'badgeCount', total_badges,
    'badges', badge_page,
    'hasMore', coalesce(page_has_more, false),
    'nextCursor', case
      when coalesce(page_has_more, false) then
        pg_catalog.jsonb_build_object(
          'earnedAt', next_cursor_earned_at,
          'badgeKey', next_cursor_key,
          'awardId', next_cursor_award_id
        )
      else null
    end
  );
end;
$$;

revoke all on function public.get_crew_member_progress_profile(
  uuid, uuid, timestamptz, text, integer, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.get_crew_member_progress_profile(
  uuid, uuid, timestamptz, text, integer, uuid
) to authenticated;

-- Preserve the crew leaderboard's existing authorization, scoring, limits and
-- four-field badge allowlist; only its earned presentation source changes.
create or replace function public.get_crew_leaderboard(target_crew_id uuid, target_window text default 'week')
returns table (
  rank_position bigint,
  user_id uuid,
  display_name text,
  avatar_url text,
  points integer,
  current_app_streak integer,
  badges jsonb,
  latest_challenge_day integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  starts_at timestamptz := case when target_window = 'challenge' then '-infinity'::timestamptz else date_trunc('week', now()) end;
begin
  if current_user_id is null then
    raise exception 'You need to log in to view the crew leaderboard.';
  end if;

  if not public.has_active_entitlement('membership_active') or not public.is_crew_member(target_crew_id) then
    raise exception 'Crew membership is required to view this leaderboard.';
  end if;

  return query
    with point_totals as (
      select
        cm.user_id as leader_user_id,
        coalesce(sum(g.points), 0)::integer as points
      from public.crew_members cm
      left join public.game_point_events g
        on g.user_id = cm.user_id
        and g.created_at >= starts_at
      where cm.crew_id = target_crew_id
      group by cm.user_id
    )
    select
      row_number() over (order by pt.points desc, coalesce(nullif(p.name, ''), 'Member') asc) as rank_position,
      pt.leader_user_id as user_id,
      coalesce(nullif(p.name, ''), 'Member') as display_name,
      coalesce(p.avatar_url, '') as avatar_url,
      pt.points,
      coalesce(s.current_app_streak, 0) as current_app_streak,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'key', recent.badge_key,
          'name', presentation.value->>'name',
          'tier', presentation.value->>'tier',
          'icon', presentation.value->>'icon'
        ) order by recent.earned_at desc, recent.badge_key, recent.id)
        from (
          select ub.id, ub.badge_key, ub.earned_at, ub.metadata
          from public.user_badges ub
          where ub.user_id = pt.leader_user_id
          order by ub.earned_at desc, ub.badge_key, ub.id
          limit 3
        ) recent
        join public.badge_definitions bd on bd.badge_key = recent.badge_key
        cross join lateral (select private.member_badge_presentation(
          recent.metadata->'awardDefinition', bd.name, bd.description, bd.tier, bd.icon
        ) as value) presentation
      ), '[]'::jsonb) as badges,
      coalesce((
        select max(c.challenge_day)
        from public.check_ins c
        where c.user_id = pt.leader_user_id
      ), 0) as latest_challenge_day
    from point_totals pt
    left join public.profiles p on p.user_id = pt.leader_user_id
    left join public.user_game_stats s on s.user_id = pt.leader_user_id
    order by pt.points desc, coalesce(nullif(p.name, ''), 'Member') asc
    limit 25;
end;
$$;
