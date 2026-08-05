begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table public.profiles
  add column if not exists avatar_url text not null default '';

create or replace function public.enforce_owned_profile_avatar_url()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_user_id uuid;
  jwt_issuer text;
  expected_origin text;
  expected_prefix text;
  avatar_url_without_query text;
  avatar_object_name text;
begin
  if tg_op = 'UPDATE' then
    if new.avatar_url is not distinct from old.avatar_url then
      return new;
    end if;
  end if;

  if coalesce(new.avatar_url, '') = '' then
    return new;
  end if;

  request_user_id := auth.uid();
  if request_user_id is null then
    -- Trusted migration/service operations have no end-user JWT. Client writes
    -- are still constrained by the authenticated role and the trigger below.
    return new;
  end if;

  if new.user_id is distinct from request_user_id then
    raise exception using
      errcode = '23514',
      message = 'Profile photo must belong to the authenticated user.';
  end if;

  jwt_issuer := coalesce(auth.jwt() ->> 'iss', '');
  expected_origin := regexp_replace(jwt_issuer, '/auth/v1/?$', '');
  expected_prefix := expected_origin || '/storage/v1/object/public/profile-photos/';
  avatar_url_without_query := split_part(new.avatar_url, '?', 1);

  if expected_origin = ''
     or position('#' in avatar_url_without_query) > 0
     or left(avatar_url_without_query, char_length(expected_prefix)) <> expected_prefix then
    raise exception using
      errcode = '23514',
      message = 'Profile photo URL must use this project''s profile-photos bucket.';
  end if;

  avatar_object_name := substring(
    avatar_url_without_query
    from char_length(expected_prefix) + 1
  );

  if avatar_object_name !~* (
    '^' || new.user_id::text || '/avatar-[a-z0-9_-]+[.](jpg|webp)$'
  ) or not exists (
    select 1
    from storage.objects
    where bucket_id = 'profile-photos'
      and name = avatar_object_name
  ) then
    raise exception using
      errcode = '23514',
      message = 'Profile photo must reference an uploaded owned thumbnail.';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_owned_profile_avatar_url() from public;
revoke all on function public.enforce_owned_profile_avatar_url() from anon;
revoke all on function public.enforce_owned_profile_avatar_url() from authenticated;

drop trigger if exists enforce_owned_profile_avatar_url on public.profiles;
create trigger enforce_owned_profile_avatar_url
  before insert or update on public.profiles
  for each row execute function public.enforce_owned_profile_avatar_url();

revoke update on public.profiles from authenticated;
grant update (user_id, name, email, avatar_url, challenge_start_date)
  on public.profiles to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'profile-photos',
  'profile-photos',
  true,
  153600,
  array['image/jpeg', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Public buckets are readable by object URL without a broad storage.objects
-- SELECT policy. The client uses immutable paths, so UPDATE is unnecessary.
drop policy if exists "Profile photos are publicly readable" on storage.objects;
drop policy if exists "Users can update own profile photo objects" on storage.objects;

drop policy if exists "Users can upload own profile photo objects" on storage.objects;
create policy "Users can upload own profile photo objects"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'profile-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users can delete own profile photo objects" on storage.objects;
create policy "Users can delete own profile photo objects"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'profile-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

commit;
