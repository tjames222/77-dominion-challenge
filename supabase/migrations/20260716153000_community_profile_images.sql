create or replace function public.get_community_post_engagement(target_post_ids uuid[])
returns table (
  post_id uuid,
  display_name text,
  avatar_url text,
  like_count integer,
  liked_by_me boolean,
  reactions jsonb,
  comments jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null then
    raise exception 'You need to log in to view Community activity.';
  end if;

  if coalesce(cardinality(target_post_ids), 0) = 0 then
    return;
  end if;

  if cardinality(target_post_ids) > 25 then
    raise exception 'Community activity can be loaded for at most 25 posts at a time.';
  end if;

  return query
    select
      cp.id as post_id,
      case
        when author_profile.user_id is not null
          then coalesce(nullif(author_profile.name, ''), 'Member')
        else coalesce(nullif(cp.display_name, ''), 'Member')
      end as display_name,
      case
        when author_profile.user_id is not null then coalesce(author_profile.avatar_url, '')
        else coalesce(cp.avatar_url, '')
      end as avatar_url,
      (select count(*)::integer from public.post_likes pl where pl.post_id = cp.id) as like_count,
      exists (
        select 1
        from public.post_likes own_like
        where own_like.post_id = cp.id
          and own_like.user_id = current_user_id
      ) as liked_by_me,
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'user_id', recent.user_id,
            'display_name', recent.display_name,
            'avatar_url', recent.avatar_url,
            'created_at', recent.created_at
          )
          order by recent.created_at desc, recent.user_id
        )
        from (
          select
            pl.user_id,
            coalesce(nullif(liker_profile.name, ''), 'Member') as display_name,
            coalesce(liker_profile.avatar_url, '') as avatar_url,
            pl.created_at
          from public.post_likes pl
          left join public.profiles liker_profile on liker_profile.user_id = pl.user_id
          where pl.post_id = cp.id
          order by pl.created_at desc, pl.user_id
          limit 3
        ) recent
      ), '[]'::jsonb) as reactions,
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', pc.id,
            'post_id', pc.post_id,
            'user_id', pc.user_id,
            'display_name', case
              when commenter_profile.user_id is not null
                then coalesce(nullif(commenter_profile.name, ''), 'Member')
              else coalesce(nullif(pc.display_name, ''), 'Member')
            end,
            'avatar_url', case
              when commenter_profile.user_id is not null then coalesce(commenter_profile.avatar_url, '')
              else coalesce(pc.avatar_url, '')
            end,
            'body', pc.body,
            'created_at', pc.created_at
          )
          order by pc.created_at, pc.id
        )
        from public.post_comments pc
        left join public.profiles commenter_profile on commenter_profile.user_id = pc.user_id
        where pc.post_id = cp.id
      ), '[]'::jsonb) as comments
    from public.community_posts cp
    left join public.profiles author_profile on author_profile.user_id = cp.author_id
    where cp.id = any(target_post_ids)
      and public.can_read_community_post(cp.id);
end;
$$;

create or replace function public.get_crew_members_with_profiles(target_crew_id uuid)
returns table (
  crew_id uuid,
  user_id uuid,
  display_name text,
  avatar_url text,
  role text,
  joined_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'You need to log in to view crew members.';
  end if;

  if not public.has_active_entitlement('membership_active') or not public.is_crew_member(target_crew_id) then
    raise exception 'Crew membership is required to view these members.';
  end if;

  return query
    select
      cm.crew_id,
      cm.user_id,
      case
        when p.user_id is not null then coalesce(nullif(p.name, ''), 'Member')
        else coalesce(nullif(cm.display_name, ''), 'Member')
      end as display_name,
      case
        when p.user_id is not null then coalesce(p.avatar_url, '')
        else coalesce(cm.avatar_url, '')
      end as avatar_url,
      cm.role,
      cm.joined_at
    from public.crew_members cm
    left join public.profiles p on p.user_id = cm.user_id
    where cm.crew_id = target_crew_id
    order by cm.joined_at, cm.user_id;
end;
$$;

drop function if exists public.get_global_leaderboard(text);

create function public.get_global_leaderboard(target_window text default 'week')
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
    raise exception 'You need to log in to view the leaderboard.';
  end if;

  if not public.has_active_entitlement('membership_active') then
    raise exception 'An active subscription is required to view the leaderboard.';
  end if;

  return query
    with point_totals as (
      select
        g.user_id as leader_user_id,
        sum(g.points)::integer as points
      from public.game_point_events g
      where g.created_at >= starts_at
      group by g.user_id
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
          'name', bd.name,
          'tier', bd.tier,
          'icon', bd.icon
        ) order by recent.earned_at desc)
        from (
          select ub.badge_key, ub.earned_at
          from public.user_badges ub
          where ub.user_id = pt.leader_user_id
          order by ub.earned_at desc
          limit 3
        ) recent
        join public.badge_definitions bd on bd.badge_key = recent.badge_key
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

drop function if exists public.get_crew_leaderboard(uuid, text);

create function public.get_crew_leaderboard(target_crew_id uuid, target_window text default 'week')
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
          'name', bd.name,
          'tier', bd.tier,
          'icon', bd.icon
        ) order by recent.earned_at desc)
        from (
          select ub.badge_key, ub.earned_at
          from public.user_badges ub
          where ub.user_id = pt.leader_user_id
          order by ub.earned_at desc
          limit 3
        ) recent
        join public.badge_definitions bd on bd.badge_key = recent.badge_key
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

revoke execute on function public.get_community_post_engagement(uuid[]) from public;
revoke execute on function public.get_community_post_engagement(uuid[]) from anon;
grant execute on function public.get_community_post_engagement(uuid[]) to authenticated;

revoke execute on function public.get_crew_members_with_profiles(uuid) from public;
revoke execute on function public.get_crew_members_with_profiles(uuid) from anon;
grant execute on function public.get_crew_members_with_profiles(uuid) to authenticated;

revoke execute on function public.get_global_leaderboard(text) from public;
revoke execute on function public.get_global_leaderboard(text) from anon;
grant execute on function public.get_global_leaderboard(text) to authenticated;

revoke execute on function public.get_crew_leaderboard(uuid, text) from public;
revoke execute on function public.get_crew_leaderboard(uuid, text) from anon;
grant execute on function public.get_crew_leaderboard(uuid, text) to authenticated;
