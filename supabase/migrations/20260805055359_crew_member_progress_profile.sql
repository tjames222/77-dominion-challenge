-- FOU-1451: a minimum, crew-scoped read boundary for another member's
-- lifetime level and earned-badge presentation data. Direct reads of the
-- underlying self-only tables remain unchanged.

create or replace function private.lifetime_level_from_points(
  target_total_points integer
)
returns integer
language sql
immutable
set search_path = ''
as $$
  -- Keep parity with the shared FOU-846 POINTS_PER_LEVEL contract. The
  -- Community client receives only this calculated level, never the points.
  select (greatest(coalesce(target_total_points, 0), 0) / 14) + 1;
$$;

create or replace function public.get_crew_member_progress_profile(
  target_crew_id uuid,
  target_user_id uuid,
  target_badge_cursor_earned_at timestamptz default null,
  target_badge_cursor_key text default null,
  target_badge_limit integer default 12
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
begin
  -- One generic response protects account and badge existence from probing.
  if caller_id is null
     or target_crew_id is null
     or target_user_id is null
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

  select pg_catalog.count(*)::integer
    into total_badges
  from public.user_badges earned
  where earned.user_id = target_user_id;

  with candidate_badges as (
    select
      earned.badge_key,
      earned.earned_at,
      definition.name,
      definition.description,
      definition.tier,
      definition.icon,
      pg_catalog.row_number() over (
        order by earned.earned_at desc, earned.badge_key asc
      ) as page_position
    from public.user_badges earned
    join public.badge_definitions definition
      on definition.badge_key = earned.badge_key
    where earned.user_id = target_user_id
      and (
        target_badge_cursor_earned_at is null
        or earned.earned_at < target_badge_cursor_earned_at
        or (
          earned.earned_at = target_badge_cursor_earned_at
          and earned.badge_key > target_badge_cursor_key
        )
      )
    order by earned.earned_at desc, earned.badge_key asc
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
        ) order by page.earned_at desc, page.badge_key asc
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
       limit 1)
  into badge_page, page_has_more, next_cursor_earned_at, next_cursor_key
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
          'badgeKey', next_cursor_key
        )
      else null
    end
  );
end;
$$;

revoke all on function private.lifetime_level_from_points(integer)
  from public, anon, authenticated, service_role;
revoke all on function public.get_crew_member_progress_profile(
  uuid, uuid, timestamptz, text, integer
) from public, anon, authenticated, service_role;
grant execute on function public.get_crew_member_progress_profile(
  uuid, uuid, timestamptz, text, integer
) to authenticated;
