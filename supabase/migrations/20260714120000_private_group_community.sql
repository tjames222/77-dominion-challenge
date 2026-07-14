alter table public.crew_members
  add column if not exists avatar_url text not null default '';

alter table public.community_posts
  add column if not exists avatar_url text not null default '',
  add column if not exists image_path text,
  add column if not exists image_alt text not null default '';

alter table public.community_posts
  alter column body set default '';

alter table public.post_comments
  add column if not exists avatar_url text not null default '';

update public.crew_members cm
set avatar_url = p.avatar_url
from public.profiles p
where p.user_id = cm.user_id
  and cm.avatar_url = ''
  and p.avatar_url <> '';

update public.community_posts cp
set avatar_url = p.avatar_url
from public.profiles p
where p.user_id = cp.author_id
  and cp.avatar_url = ''
  and p.avatar_url <> '';

update public.post_comments pc
set avatar_url = p.avatar_url
from public.profiles p
where p.user_id = pc.user_id
  and pc.avatar_url = ''
  and p.avatar_url <> '';

alter table public.community_posts
  drop constraint if exists community_posts_body_check;

alter table public.community_posts
  drop constraint if exists community_posts_body_or_image_check;

alter table public.community_posts
  add constraint community_posts_body_or_image_check check (
    char_length(trim(body)) <= 2000
    and (char_length(trim(body)) >= 1 or image_path is not null)
  );

alter table public.community_posts
  drop constraint if exists community_posts_image_alt_check;

alter table public.community_posts
  add constraint community_posts_image_alt_check
  check (char_length(image_alt) <= 500);

alter table public.community_posts
  drop constraint if exists community_posts_image_path_scope_check;

alter table public.community_posts
  add constraint community_posts_image_path_scope_check check (
    image_path is null
    or (
      scope = 'crew'
      and crew_id is not null
      and image_path like (crew_id::text || '/' || author_id::text || '/%')
      and char_length(image_path) > char_length(crew_id::text) + char_length(author_id::text) + 2
    )
  );

create index if not exists community_posts_crew_cursor_idx
  on public.community_posts (crew_id, created_at desc, id desc);

create index if not exists community_posts_scope_cursor_idx
  on public.community_posts (scope, created_at desc, id desc);

create or replace function public.join_crew_by_invite(invite_token text)
returns table (
  crew_id uuid,
  name text,
  description text,
  challenge_start_date date
)
language plpgsql
security definer
set search_path = public
as $$
declare
  target_crew_id uuid;
  member_name text;
  member_avatar_url text;
begin
  if auth.uid() is null then
    raise exception 'You need to log in to join this crew.';
  end if;

  if not public.has_active_entitlement('membership_active') then
    raise exception 'An active subscription is required to join a crew.';
  end if;

  select ci.crew_id
    into target_crew_id
    from public.crew_invites ci
    where ci.token = invite_token
      and ci.revoked_at is null
      and ci.expires_at > now()
    limit 1;

  if target_crew_id is null then
    raise exception 'This invite link is invalid or expired.';
  end if;

  select coalesce(nullif(p.name, ''), 'Member'), coalesce(p.avatar_url, '')
    into member_name, member_avatar_url
    from public.profiles p
    where p.user_id = auth.uid();

  insert into public.crew_members (crew_id, user_id, display_name, avatar_url, role)
  values (
    target_crew_id,
    auth.uid(),
    coalesce(member_name, 'Member'),
    coalesce(member_avatar_url, ''),
    'member'
  )
  on conflict (crew_id, user_id) do nothing;

  return query
    select c.id, c.name, c.description, c.challenge_start_date
    from public.crews c
    where c.id = target_crew_id;
end;
$$;

drop policy if exists "Authors and crew leaders can delete posts" on public.community_posts;
create policy "Authors and crew leaders can delete posts"
  on public.community_posts
  for delete
  to authenticated
  using (
    public.has_active_entitlement('membership_active')
    and (
      author_id = (select auth.uid())
      or (
        scope = 'crew'
        and public.can_manage_crew(crew_id)
      )
    )
  );

drop policy if exists "Authors and crew leaders can delete comments" on public.post_comments;
create policy "Authors and crew leaders can delete comments"
  on public.post_comments
  for delete
  to authenticated
  using (
    public.has_active_entitlement('membership_active')
    and (
      user_id = (select auth.uid())
      or exists (
        select 1
        from public.community_posts cp
        where cp.id = post_comments.post_id
          and cp.scope = 'crew'
          and public.can_manage_crew(cp.crew_id)
      )
    )
  );

revoke update on public.community_posts from authenticated;
grant select, insert, delete on public.community_posts to authenticated;
grant update (body, image_alt) on public.community_posts to authenticated;

revoke update on public.post_comments from authenticated;
grant select, insert, delete on public.post_comments to authenticated;
grant update (body) on public.post_comments to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'community-post-images',
  'community-post-images',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Crew members can read community post images" on storage.objects;
create policy "Crew members can read community post images"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'community-post-images'
    and public.has_active_entitlement('membership_active')
    and exists (
      select 1
      from public.crew_members cm
      where cm.crew_id::text = (storage.foldername(name))[1]
        and cm.user_id = (select auth.uid())
    )
  );

drop policy if exists "Crew members can upload own community post images" on storage.objects;
create policy "Crew members can upload own community post images"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'community-post-images'
    and public.has_active_entitlement('membership_active')
    and exists (
      select 1
      from public.crew_members cm
      where cm.crew_id::text = (storage.foldername(name))[1]
        and cm.user_id = (select auth.uid())
    )
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );

drop policy if exists "Authors and crew leaders can delete community post images" on storage.objects;
create policy "Authors and crew leaders can delete community post images"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'community-post-images'
    and public.has_active_entitlement('membership_active')
    and (
      (storage.foldername(name))[2] = (select auth.uid())::text
      or exists (
        select 1
        from public.crew_members cm
        where cm.crew_id::text = (storage.foldername(name))[1]
          and cm.user_id = (select auth.uid())
          and cm.role in ('owner', 'admin')
      )
    )
  );
