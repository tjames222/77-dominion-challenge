-- FOU-564 P0/P1: immutable retirement snapshot and member-authored export.
-- No purge, approval, worker, or scheduling mechanism is created here.

create table private.retired_community_t0_comment_inventory (
  comment_id uuid primary key,
  post_id uuid not null,
  author_id uuid not null,
  created_at timestamptz not null,
  row_sha256 text not null check (row_sha256 ~ '^[0-9a-f]{64}$')
);

create table private.retired_community_t0_like_inventory (
  post_id uuid not null,
  user_id uuid not null,
  created_at timestamptz not null,
  row_sha256 text not null check (row_sha256 ~ '^[0-9a-f]{64}$'),
  primary key (post_id, user_id)
);

create table private.retired_community_t0_object_inventory (
  bucket_id text not null,
  object_name text not null,
  object_id uuid not null,
  owner_id uuid,
  referenced_post_ids uuid[] not null default '{}',
  row_sha256 text not null check (row_sha256 ~ '^[0-9a-f]{64}$'),
  primary key (bucket_id, object_name)
);

create table private.retired_community_t0_post_inventory (
  post_id uuid primary key,
  scope text not null check (scope in ('global', 'crew')),
  author_id uuid not null,
  crew_id uuid,
  created_at timestamptz not null,
  image_reference_sha256 text,
  row_sha256 text not null check (row_sha256 ~ '^[0-9a-f]{64}$'),
  children_sha256 text not null check (children_sha256 ~ '^[0-9a-f]{64}$'),
  object_sha256 text check (object_sha256 is null or object_sha256 ~ '^[0-9a-f]{64}$')
);

create table private.retired_community_t0_census (
  singleton boolean primary key default true check (singleton),
  captured_at timestamptz not null,
  member_export_ends_at timestamptz not null,
  global_post_count bigint not null check (global_post_count >= 0),
  private_post_count bigint not null check (private_post_count >= 0),
  comment_count bigint not null check (comment_count >= 0),
  like_count bigint not null check (like_count >= 0),
  referenced_image_count bigint not null check (referenced_image_count >= 0),
  bucket_object_count bigint not null check (bucket_object_count >= 0),
  missing_object_count bigint not null check (missing_object_count >= 0),
  orphan_object_count bigint not null check (orphan_object_count >= 0),
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  check (member_export_ends_at = captured_at + interval '30 days')
);

create function private.retired_community_sha256(target_value text)
returns text language sql immutable security definer
set search_path = extensions, pg_temp as $$
  select encode(extensions.digest(convert_to(coalesce(target_value, ''), 'UTF8'), 'sha256'), 'hex');
$$;

create function private.compute_retired_community_census()
returns table (
  global_post_count bigint,
  private_post_count bigint,
  comment_count bigint,
  like_count bigint,
  referenced_image_count bigint,
  bucket_object_count bigint,
  missing_object_count bigint,
  orphan_object_count bigint,
  source_sha256 text
)
language sql stable security definer
set search_path = public, private, storage, pg_temp as $$
  with source_rows(kind, source_key, row_sha256) as (
    select 'post', post_row.id::text,
      private.retired_community_sha256(to_jsonb(post_row)::text)
    from public.community_posts post_row
    union all
    select 'comment', comment_row.id::text,
      private.retired_community_sha256(to_jsonb(comment_row)::text)
    from public.post_comments comment_row
    union all
    select 'like', like_row.post_id::text || ':' || like_row.user_id::text,
      private.retired_community_sha256(to_jsonb(like_row)::text)
    from public.post_likes like_row
    union all
    select 'object', object_row.name,
      private.retired_community_sha256(to_jsonb(object_row)::text)
    from storage.objects object_row
    where object_row.bucket_id = 'community-post-images'
  ), digest_row as (
    select private.retired_community_sha256(coalesce(
      jsonb_agg(jsonb_build_array(kind, source_key, row_sha256) order by kind, source_key)::text,
      '[]'
    )) value
    from source_rows
  )
  select
    (select count(*) from public.community_posts where scope = 'global'),
    (select count(*) from public.community_posts where scope = 'crew'),
    (select count(*) from public.post_comments),
    (select count(*) from public.post_likes),
    (select count(*) from public.community_posts where image_path is not null),
    (select count(*) from storage.objects where bucket_id = 'community-post-images'),
    (select count(*) from public.community_posts post_row where post_row.image_path is not null
      and not exists (select 1 from storage.objects object_row
        where object_row.bucket_id = 'community-post-images' and object_row.name = post_row.image_path)),
    (select count(*) from storage.objects object_row where object_row.bucket_id = 'community-post-images'
      and not exists (select 1 from public.community_posts post_row
        where post_row.image_path = object_row.name)),
    digest_row.value
  from digest_row;
$$;

insert into private.retired_community_t0_comment_inventory (
  comment_id, post_id, author_id, created_at, row_sha256
)
select comment_row.id, comment_row.post_id, comment_row.user_id, comment_row.created_at,
  private.retired_community_sha256(to_jsonb(comment_row)::text)
from public.post_comments comment_row;

insert into private.retired_community_t0_like_inventory (
  post_id, user_id, created_at, row_sha256
)
select like_row.post_id, like_row.user_id, like_row.created_at,
  private.retired_community_sha256(to_jsonb(like_row)::text)
from public.post_likes like_row;

insert into private.retired_community_t0_object_inventory (
  bucket_id, object_name, object_id, owner_id, referenced_post_ids, row_sha256
)
select object_row.bucket_id, object_row.name, object_row.id, object_row.owner,
  coalesce((select array_agg(post_row.id order by post_row.id)
    from public.community_posts post_row where post_row.image_path = object_row.name), '{}'::uuid[]),
  private.retired_community_sha256(to_jsonb(object_row)::text)
from storage.objects object_row
where object_row.bucket_id = 'community-post-images';

insert into private.retired_community_t0_post_inventory (
  post_id, scope, author_id, crew_id, created_at, image_reference_sha256,
  row_sha256, children_sha256, object_sha256
)
select post_row.id, post_row.scope, post_row.author_id, post_row.crew_id, post_row.created_at,
  case when post_row.image_path is not null
    then private.retired_community_sha256(post_row.image_path) end,
  private.retired_community_sha256(to_jsonb(post_row)::text),
  private.retired_community_sha256(coalesce((
    select jsonb_agg(jsonb_build_array(child.kind, child.child_key, child.row_sha256)
      order by child.kind, child.child_key)::text
    from (
      select 'comment' kind, comment_item.comment_id::text child_key, comment_item.row_sha256
      from private.retired_community_t0_comment_inventory comment_item
      where comment_item.post_id = post_row.id
      union all
      select 'like', like_item.user_id::text, like_item.row_sha256
      from private.retired_community_t0_like_inventory like_item
      where like_item.post_id = post_row.id
    ) child
  ), '[]')),
  (select object_item.row_sha256
    from private.retired_community_t0_object_inventory object_item
    where object_item.bucket_id = 'community-post-images'
      and object_item.object_name = post_row.image_path)
from public.community_posts post_row;

insert into private.retired_community_t0_census (
  singleton, captured_at, member_export_ends_at, global_post_count,
  private_post_count, comment_count, like_count, referenced_image_count,
  bucket_object_count, missing_object_count, orphan_object_count, source_sha256
)
select true, statement_timestamp(), statement_timestamp() + interval '30 days',
  current_census.global_post_count, current_census.private_post_count,
  current_census.comment_count, current_census.like_count,
  current_census.referenced_image_count, current_census.bucket_object_count,
  current_census.missing_object_count, current_census.orphan_object_count,
  current_census.source_sha256
from private.compute_retired_community_census() current_census;

create function private.block_retired_community_t0_mutation()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  raise exception 'The retired Community T0 snapshot is immutable.' using errcode = '55000';
end;
$$;

create trigger block_retired_community_t0_census_mutation
  before insert or update or delete on private.retired_community_t0_census
  for each row execute function private.block_retired_community_t0_mutation();
create trigger block_retired_community_t0_post_mutation
  before insert or update or delete on private.retired_community_t0_post_inventory
  for each row execute function private.block_retired_community_t0_mutation();
create trigger block_retired_community_t0_comment_mutation
  before insert or update or delete on private.retired_community_t0_comment_inventory
  for each row execute function private.block_retired_community_t0_mutation();
create trigger block_retired_community_t0_like_mutation
  before insert or update or delete on private.retired_community_t0_like_inventory
  for each row execute function private.block_retired_community_t0_mutation();
create trigger block_retired_community_t0_object_mutation
  before insert or update or delete on private.retired_community_t0_object_inventory
  for each row execute function private.block_retired_community_t0_mutation();

create function private.build_own_retired_community_export(
  target_user_id uuid,
  target_exported_at timestamptz
)
returns jsonb language plpgsql stable security definer
set search_path = public, private, pg_temp set timezone = 'UTC' as $$
declare census_row private.retired_community_t0_census%rowtype;
declare export_value jsonb;
begin
  if target_user_id is null then
    raise exception 'Not authenticated.' using errcode = '42501';
  end if;
  select * into strict census_row from private.retired_community_t0_census where singleton;
  if target_exported_at < census_row.captured_at
     or target_exported_at > census_row.member_export_ends_at then
    raise exception 'The member-authored export window has closed.' using errcode = '55000';
  end if;

  if exists (
    select 1 from private.retired_community_t0_post_inventory inventory
    left join public.community_posts post_row on post_row.id = inventory.post_id
    where inventory.author_id = target_user_id
      and (post_row.id is null
        or private.retired_community_sha256(to_jsonb(post_row)::text) <> inventory.row_sha256)
  ) or exists (
    select 1 from private.retired_community_t0_comment_inventory inventory
    left join public.post_comments comment_row on comment_row.id = inventory.comment_id
    where inventory.author_id = target_user_id
      and (comment_row.id is null
        or private.retired_community_sha256(to_jsonb(comment_row)::text) <> inventory.row_sha256)
  ) or exists (
    select 1 from private.retired_community_t0_like_inventory inventory
    left join public.post_likes like_row
      on like_row.post_id = inventory.post_id and like_row.user_id = inventory.user_id
    where inventory.user_id = target_user_id
      and (like_row.post_id is null
        or private.retired_community_sha256(to_jsonb(like_row)::text) <> inventory.row_sha256)
  ) then
    raise exception 'Authored source data no longer matches the T0 inventory.' using errcode = '55000';
  end if;

  select jsonb_build_object(
    'schemaVersion', 1,
    'capturedAt', census_row.captured_at,
    'exportedAt', target_exported_at,
    'exportEndsAt', census_row.member_export_ends_at,
    'posts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'postId', post_row.id,
        'body', post_row.body,
        'type', post_row.post_type,
        'imageAlt', post_row.image_alt,
        'imageReferenceId', inventory.image_reference_sha256,
        'createdAt', post_row.created_at,
        'updatedAt', post_row.updated_at
      ) order by post_row.created_at, post_row.id)
      from private.retired_community_t0_post_inventory inventory
      join public.community_posts post_row on post_row.id = inventory.post_id
      where inventory.author_id = target_user_id
    ), '[]'::jsonb),
    'comments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'commentId', comment_row.id,
        'postId', comment_row.post_id,
        'body', comment_row.body,
        'createdAt', comment_row.created_at,
        'updatedAt', comment_row.updated_at
      ) order by comment_row.created_at, comment_row.id)
      from private.retired_community_t0_comment_inventory inventory
      join public.post_comments comment_row on comment_row.id = inventory.comment_id
      where inventory.author_id = target_user_id
    ), '[]'::jsonb),
    'likes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'postId', like_row.post_id,
        'createdAt', like_row.created_at
      ) order by like_row.created_at, like_row.post_id)
      from private.retired_community_t0_like_inventory inventory
      join public.post_likes like_row
        on like_row.post_id = inventory.post_id and like_row.user_id = inventory.user_id
      where inventory.user_id = target_user_id
    ), '[]'::jsonb)
  ) into export_value;
  return export_value;
end;
$$;

create function public.export_own_retired_community_content()
returns jsonb language plpgsql security definer
set search_path = public, private, auth, pg_temp as $$
declare current_user_id uuid;
begin
  current_user_id := auth.uid();
  if current_user_id is null then
    raise exception 'Not authenticated.' using errcode = '42501';
  end if;
  return private.build_own_retired_community_export(current_user_id, clock_timestamp());
end;
$$;

revoke all on private.retired_community_t0_census from public, anon, authenticated, service_role;
revoke all on private.retired_community_t0_post_inventory from public, anon, authenticated, service_role;
revoke all on private.retired_community_t0_comment_inventory from public, anon, authenticated, service_role;
revoke all on private.retired_community_t0_like_inventory from public, anon, authenticated, service_role;
revoke all on private.retired_community_t0_object_inventory from public, anon, authenticated, service_role;
revoke all on function private.retired_community_sha256(text) from public, anon, authenticated, service_role;
revoke all on function private.compute_retired_community_census() from public, anon, authenticated, service_role;
revoke all on function private.block_retired_community_t0_mutation() from public, anon, authenticated, service_role;
revoke all on function private.build_own_retired_community_export(uuid, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.export_own_retired_community_content()
  from public, anon, service_role;
grant execute on function public.export_own_retired_community_content() to authenticated;

comment on table private.retired_community_t0_census is
  'Immutable, uncapped T0 census for all retired global/private Community rows and image-object reconciliation.';
comment on function public.export_own_retired_community_content() is
  'Authenticated 30-day export of only the caller authored retired Community content; derives auth.uid and accepts no subject.';
