-- Retire private-group conversation features without deleting historical rows
-- or objects. Service-role retention/export jobs remain possible, while every
-- supported browser/API path fails closed at the database and storage layers.

drop policy if exists "Authenticated users can read visible posts" on public.community_posts;
drop policy if exists "Users can create visible posts" on public.community_posts;
drop policy if exists "Authors can update own posts" on public.community_posts;
drop policy if exists "Authors and crew leaders can delete posts" on public.community_posts;

drop policy if exists "Users can read likes on visible posts" on public.post_likes;
drop policy if exists "Users can like visible posts" on public.post_likes;
drop policy if exists "Users can remove own likes" on public.post_likes;

drop policy if exists "Users can read comments on visible posts" on public.post_comments;
drop policy if exists "Users can comment on visible posts" on public.post_comments;
drop policy if exists "Users can update own comments" on public.post_comments;
drop policy if exists "Authors and crew leaders can delete comments" on public.post_comments;

revoke all on public.community_posts from public, anon, authenticated;
revoke all on public.post_likes from public, anon, authenticated;
revoke all on public.post_comments from public, anon, authenticated;

revoke execute on function public.can_read_community_post(uuid)
  from public, anon, authenticated;
revoke execute on function public.get_community_post_engagement(uuid[])
  from public, anon, authenticated;

drop policy if exists "Crew members can read community post images" on storage.objects;
drop policy if exists "Crew members can upload own community post images" on storage.objects;
drop policy if exists "Authors and crew leaders can delete community post images" on storage.objects;

comment on table public.community_posts is
  'Retained retired Community post history. Product/API access ended at the private-group social cutover; service-only retention controls apply.';
comment on table public.post_comments is
  'Retained retired Community comment history. No client role has access after the private-group social cutover.';
comment on table public.post_likes is
  'Retained retired Community reaction history. No client role has access after the private-group social cutover.';
