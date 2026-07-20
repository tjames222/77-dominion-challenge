-- Retire global Community access without deleting historical social data.

drop function if exists public.get_global_leaderboard(text);

create or replace function public.can_read_community_post(target_post_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.community_posts cp
    where cp.id = target_post_id
      and cp.scope = 'crew'
      and public.has_active_entitlement('membership_active')
      and public.is_crew_member(cp.crew_id)
  );
$$;

drop policy if exists "Authenticated users can read visible posts" on public.community_posts;
create policy "Authenticated users can read visible posts"
  on public.community_posts
  for select
  to authenticated
  using (
    public.has_active_entitlement('membership_active')
    and scope = 'crew'
    and public.is_crew_member(crew_id)
  );

drop policy if exists "Users can create visible posts" on public.community_posts;
create policy "Users can create visible posts"
  on public.community_posts
  for insert
  to authenticated
  with check (
    author_id = (select auth.uid())
    and public.has_active_entitlement('membership_active')
    and scope = 'crew'
    and public.is_crew_member(crew_id)
  );

drop policy if exists "Authors can update own posts" on public.community_posts;
create policy "Authors can update own posts"
  on public.community_posts
  for update
  to authenticated
  using (
    author_id = (select auth.uid())
    and public.has_active_entitlement('membership_active')
    and scope = 'crew'
    and public.is_crew_member(crew_id)
  )
  with check (
    author_id = (select auth.uid())
    and public.has_active_entitlement('membership_active')
    and scope = 'crew'
    and public.is_crew_member(crew_id)
  );

drop policy if exists "Authors and crew leaders can delete posts" on public.community_posts;
create policy "Authors and crew leaders can delete posts"
  on public.community_posts
  for delete
  to authenticated
  using (
    public.has_active_entitlement('membership_active')
    and scope = 'crew'
    and (
      author_id = (select auth.uid())
      or public.can_manage_crew(crew_id)
    )
  );

drop policy if exists "Users can remove own likes" on public.post_likes;
create policy "Users can remove own likes"
  on public.post_likes
  for delete
  to authenticated
  using (
    user_id = (select auth.uid())
    and public.has_active_entitlement('membership_active')
    and public.can_read_community_post(post_id)
  );

drop policy if exists "Users can update own comments" on public.post_comments;
create policy "Users can update own comments"
  on public.post_comments
  for update
  to authenticated
  using (
    user_id = (select auth.uid())
    and public.has_active_entitlement('membership_active')
    and public.can_read_community_post(post_id)
  )
  with check (
    user_id = (select auth.uid())
    and public.has_active_entitlement('membership_active')
    and public.can_read_community_post(post_id)
  );
