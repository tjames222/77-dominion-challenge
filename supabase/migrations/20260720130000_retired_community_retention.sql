-- FOU-564 P0-P3: immutable retirement snapshot, member-authored export,
-- sealed deletion coordination, and worker-facing confirmation boundaries.
-- No scheduler or production Storage/provider worker is created here.

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
set search_path = pg_catalog, extensions, pg_temp as $$
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
set search_path = pg_catalog, public, private, storage, pg_temp as $$
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
    (select count(distinct image_path) from public.community_posts where image_path is not null),
    (select count(*) from storage.objects where bucket_id = 'community-post-images'),
    (select count(distinct post_row.image_path) from public.community_posts post_row where post_row.image_path is not null
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
set search_path = pg_catalog, public, private, pg_temp set timezone = 'UTC' as $$
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
        'attachmentPath', post_row.image_path,
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
set search_path = pg_catalog, public, private, auth, pg_temp as $$
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
  'Authenticated 30-day export of only the caller authored retired Community content; derives auth.uid and exposes only that authors attachment paths.';

-- P2/P3 deletion coordination. Identity/scope records are sealed once and all
-- state transitions are appended to the ledger. Storage objects are never
-- deleted from SQL; a worker must remove and confirm each exact object first.

alter table public.crews drop constraint if exists crews_created_by_fkey;
alter table public.crews alter column created_by drop not null;
alter table public.crews add constraint crews_created_by_fkey
  foreign key (created_by) references auth.users(id) on delete set null;

alter table private.integration_destinations
  drop constraint if exists integration_destinations_installed_by_fkey;
alter table private.integration_destinations alter column installed_by drop not null;
alter table private.integration_destinations
  add constraint integration_destinations_installed_by_fkey
  foreign key (installed_by) references auth.users(id) on delete set null;

create function private.retired_community_credential_sha256(
  target_destination private.integration_destinations
)
returns text language sql immutable security definer
set search_path = pg_catalog, private, pg_temp as $$
  select private.retired_community_sha256(jsonb_build_object(
    'id', (target_destination).id,
    'crewId', (target_destination).crew_id,
    'provider', (target_destination).provider,
    'providerWorkspaceId', (target_destination).provider_workspace_id,
    'providerDestinationId', (target_destination).provider_destination_id,
    'credentialCiphertext', (target_destination).credential_ciphertext,
    'credentialNonce', (target_destination).credential_nonce,
    'credentialKeyVersion', (target_destination).credential_key_version,
    'credentialFingerprint', (target_destination).credential_fingerprint,
    'scopes', (target_destination).scopes
  )::text);
$$;

create table private.retired_community_deletion_batches (
  id uuid primary key default gen_random_uuid(),
  reason text not null check (reason in
    ('aged_retention', 'account_erasure', 'group_deletion', 'orphan_cleanup')),
  requested_by text not null check (char_length(requested_by) between 3 and 160),
  requested_at timestamptz not null,
  execute_after timestamptz not null,
  deadline_at timestamptz,
  subject_user_id uuid,
  crew_id uuid,
  t0_source_sha256 text not null check (t0_source_sha256 ~ '^[0-9a-f]{64}$'),
  source_sha256 text check (source_sha256 is null or source_sha256 ~ '^[0-9a-f]{64}$'),
  post_count bigint,
  comment_count bigint,
  like_count bigint,
  object_count bigint,
  credential_count bigint,
  sealed boolean not null default false,
  check (not sealed or (
    source_sha256 is not null
    and post_count is not null and post_count >= 0
    and comment_count is not null and comment_count >= 0
    and like_count is not null and like_count >= 0
    and object_count is not null and object_count >= 0
    and credential_count is not null and credential_count >= 0
  )),
  check (
    (reason = 'aged_retention' and subject_user_id is null and crew_id is null and deadline_at is null)
    or (reason = 'orphan_cleanup' and subject_user_id is null and crew_id is null and deadline_at is null)
    or (reason = 'account_erasure' and subject_user_id is not null and crew_id is null
      and deadline_at = requested_at + interval '24 hours')
    or (reason = 'group_deletion' and subject_user_id is null and crew_id is not null
      and deadline_at is null and execute_after = requested_at + interval '30 days')
  )
);

create table private.retired_community_deletion_items (
  batch_id uuid not null references private.retired_community_deletion_batches(id) on delete restrict,
  item_kind text not null check (item_kind in ('post', 'comment', 'like')),
  item_key text not null,
  post_id uuid not null,
  row_sha256 text not null check (row_sha256 ~ '^[0-9a-f]{64}$'),
  primary key (batch_id, item_kind, item_key)
);

create table private.retired_community_storage_work (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references private.retired_community_deletion_batches(id) on delete restrict,
  object_id uuid not null,
  bucket_id text not null check (bucket_id = 'community-post-images'),
  object_name text not null,
  expected_row_sha256 text not null check (expected_row_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'queued' check (status in ('queued', 'claimed', 'confirmed')),
  claim_token uuid,
  claimed_at timestamptz,
  confirmed_at timestamptz,
  unique (batch_id, bucket_id, object_name)
);

create table private.retired_community_credential_work (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references private.retired_community_deletion_batches(id) on delete restrict,
  destination_id uuid not null,
  provider text not null check (provider in ('slack', 'discord')),
  expected_row_sha256 text not null check (expected_row_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'queued' check (status in ('queued', 'claimed', 'confirmed')),
  claim_token uuid,
  claimed_at timestamptz,
  confirmed_at timestamptz,
  provider_revocation_reference text,
  unique (batch_id, destination_id)
);

create table private.retired_community_backup_proofs (
  batch_id uuid primary key references private.retired_community_deletion_batches(id) on delete restrict,
  backup_name text not null check (char_length(trim(backup_name)) between 3 and 200),
  backup_version text not null check (char_length(trim(backup_version)) between 1 and 100),
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  bundle_sha256 text not null check (bundle_sha256 ~ '^[0-9a-f]{64}$'),
  bundle_bytes bigint not null check (bundle_bytes > 0),
  verified_by text not null check (char_length(verified_by) between 3 and 160),
  verified_at timestamptz not null
);

create table private.retired_community_batch_approvals (
  batch_id uuid primary key references private.retired_community_deletion_batches(id) on delete restrict,
  approved_by text not null check (char_length(approved_by) between 3 and 160),
  approved_at timestamptz not null,
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  bundle_sha256 text not null check (bundle_sha256 ~ '^[0-9a-f]{64}$'),
  post_count bigint not null,
  comment_count bigint not null,
  like_count bigint not null,
  object_count bigint not null,
  credential_count bigint not null,
  check (post_count >= 0 and comment_count >= 0 and like_count >= 0
    and object_count >= 0 and credential_count >= 0)
);

create table private.retired_community_deletion_ledger (
  id bigint generated always as identity primary key,
  batch_id uuid not null references private.retired_community_deletion_batches(id) on delete restrict,
  event_type text not null check (event_type in
    ('created', 'backup_verified', 'approved', 'storage_confirmed',
     'credential_confirmed', 'cancelled', 'executed')),
  actor text not null check (char_length(actor) between 3 and 160),
  event_at timestamptz not null,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object')
);

create index retired_community_deletion_ledger_batch_event_idx
  on private.retired_community_deletion_ledger (batch_id, event_type);

create function private.guard_retired_community_batch_mutation()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  if tg_op = 'INSERT' then
    if new.sealed then
      raise exception 'Retired Community deletion batches must be assembled before sealing.' using errcode = '55000';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' or old.sealed then
    raise exception 'Retired Community deletion batches are immutable.' using errcode = '55000';
  end if;
  if new.sealed then
    if new.source_sha256 is null or new.post_count is null or new.post_count < 0
       or new.comment_count is null or new.comment_count < 0
       or new.like_count is null or new.like_count < 0
       or new.object_count is null or new.object_count < 0
       or new.credential_count is null or new.credential_count < 0 then
      raise exception 'A sealed deletion batch requires a digest and all five non-negative counts.'
        using errcode = '55000';
    end if;
    if new.id = old.id and new.reason = old.reason
       and new.requested_by = old.requested_by and new.requested_at = old.requested_at
       and new.execute_after = old.execute_after and new.deadline_at is not distinct from old.deadline_at
       and new.subject_user_id is not distinct from old.subject_user_id
       and new.crew_id is not distinct from old.crew_id
       and new.t0_source_sha256 = old.t0_source_sha256 then
      return new;
    end if;
  end if;
  raise exception 'Retired Community deletion batches may only be sealed once.' using errcode = '55000';
end;
$$;

create trigger guard_retired_community_batch_mutation
  before insert or update or delete on private.retired_community_deletion_batches
  for each row execute function private.guard_retired_community_batch_mutation();

create function private.guard_retired_community_item_mutation()
returns trigger language plpgsql
set search_path = pg_catalog, private, pg_temp as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'Retired Community deletion items are immutable.' using errcode = '55000';
  end if;
  if (select sealed from private.retired_community_deletion_batches where id = new.batch_id) then
    raise exception 'A sealed deletion batch cannot accept items.' using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger guard_retired_community_item_mutation
  before insert or update or delete on private.retired_community_deletion_items
  for each row execute function private.guard_retired_community_item_mutation();

create function private.block_retired_community_record_mutation()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  raise exception 'Retired Community proof, approval, and ledger records are append-only.' using errcode = '55000';
end;
$$;

create trigger block_retired_community_backup_mutation
  before update or delete on private.retired_community_backup_proofs
  for each row execute function private.block_retired_community_record_mutation();
create trigger block_retired_community_approval_mutation
  before update or delete on private.retired_community_batch_approvals
  for each row execute function private.block_retired_community_record_mutation();
create trigger block_retired_community_ledger_mutation
  before update or delete on private.retired_community_deletion_ledger
  for each row execute function private.block_retired_community_record_mutation();

create function private.retired_community_batch_status(target_batch_id uuid)
returns text language sql security definer
set search_path = pg_catalog, private, pg_temp as $$
  select case
    when exists (select 1 from private.retired_community_deletion_ledger
      where batch_id = target_batch_id and event_type = 'executed') then 'executed'
    when exists (select 1 from private.retired_community_deletion_ledger
      where batch_id = target_batch_id and event_type = 'cancelled') then 'cancelled'
    when not exists (select 1 from private.retired_community_backup_proofs
      where batch_id = target_batch_id) then 'awaiting_backup'
    when not exists (select 1 from private.retired_community_batch_approvals
      where batch_id = target_batch_id) then 'awaiting_approval'
    when exists (select 1 from private.retired_community_storage_work
      where batch_id = target_batch_id and status <> 'confirmed') then 'storage_pending'
    when exists (select 1 from private.retired_community_credential_work
      where batch_id = target_batch_id and status <> 'confirmed') then 'credential_pending'
    when clock_timestamp() < (select execute_after from private.retired_community_deletion_batches
      where id = target_batch_id) then 'awaiting_execute_after'
    else 'ready'
  end;
$$;

create function private.retired_community_batch_result(target_batch_id uuid)
returns jsonb language sql security definer
set search_path = pg_catalog, private, pg_temp as $$
  select jsonb_build_object(
    'batchId', batch_row.id,
    'status', private.retired_community_batch_status(batch_row.id),
    'counts', jsonb_build_object(
      'posts', batch_row.post_count,
      'comments', batch_row.comment_count,
      'likes', batch_row.like_count,
      'objects', batch_row.object_count,
      'credentials', batch_row.credential_count
    )
  )
  from private.retired_community_deletion_batches batch_row
  where batch_row.id = target_batch_id;
$$;

create function private.create_retired_community_deletion_batch(
  target_reason text,
  target_requested_by text,
  target_subject_user_id uuid,
  target_crew_id uuid,
  target_requested_at timestamptz
)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public, private, auth, pg_temp as $$
declare census_row private.retired_community_t0_census%rowtype;
declare new_batch_id uuid := gen_random_uuid();
declare source_digest text;
declare selected_post_ids uuid[];
declare posts bigint;
declare comments bigint;
declare likes bigint;
declare objects bigint;
declare credentials bigint;
begin
  if target_reason not in ('aged_retention', 'account_erasure', 'group_deletion', 'orphan_cleanup') then
    raise exception 'Unsupported retired Community deletion reason.' using errcode = '22023';
  end if;
  if target_requested_by is null or char_length(target_requested_by) not between 3 and 160 then
    raise exception 'A named requester is required.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('retired-community-deletion', 0));
  select * into strict census_row from private.retired_community_t0_census where singleton;
  if target_reason = 'aged_retention' and clock_timestamp() < census_row.captured_at + interval '91 days' then
    raise exception 'Aged retention cannot begin before T0 plus 91 days.' using errcode = '55000';
  end if;
  if target_reason = 'account_erasure'
     and (target_subject_user_id is null or not exists
       (select 1 from auth.users where id = target_subject_user_id)) then
    raise exception 'The account erasure subject does not exist.' using errcode = '22023';
  end if;
  if target_reason = 'group_deletion'
     and (target_crew_id is null or not exists (select 1 from public.crews where id = target_crew_id)) then
    raise exception 'The group deletion target does not exist.' using errcode = '22023';
  end if;
  if exists (
    select 1 from private.retired_community_deletion_batches existing
    where existing.reason = target_reason
      and existing.subject_user_id is not distinct from target_subject_user_id
      and existing.crew_id is not distinct from target_crew_id
      and not exists (select 1 from private.retired_community_deletion_ledger terminal
        where terminal.batch_id = existing.id and terminal.event_type in ('cancelled', 'executed'))
  ) then
    raise exception 'An active deletion batch already covers this target.' using errcode = '55000';
  end if;

  insert into private.retired_community_deletion_batches (
    id, reason, requested_by, requested_at, execute_after, deadline_at,
    subject_user_id, crew_id, t0_source_sha256
  ) values (
    new_batch_id, target_reason, target_requested_by, target_requested_at,
    case when target_reason = 'group_deletion' then target_requested_at + interval '30 days'
      else target_requested_at end,
    case when target_reason = 'account_erasure' then target_requested_at + interval '24 hours' end,
    target_subject_user_id, target_crew_id, census_row.source_sha256
  );

  if target_reason = 'aged_retention' then
    insert into private.retired_community_deletion_items
      select new_batch_id, 'post', post_id::text, post_id, row_sha256
      from private.retired_community_t0_post_inventory;
    insert into private.retired_community_deletion_items
      select new_batch_id, 'comment', comment_id::text, post_id, row_sha256
      from private.retired_community_t0_comment_inventory;
    insert into private.retired_community_deletion_items
      select new_batch_id, 'like', post_id::text || ':' || user_id::text, post_id, row_sha256
      from private.retired_community_t0_like_inventory;
  elsif target_reason = 'account_erasure' then
    insert into private.retired_community_deletion_items
      select new_batch_id, 'post', post_item.post_id::text, post_item.post_id, post_item.row_sha256
      from private.retired_community_t0_post_inventory post_item
      join public.community_posts post_row on post_row.id = post_item.post_id
      where post_item.author_id = target_subject_user_id
        and private.retired_community_sha256(to_jsonb(post_row)::text) = post_item.row_sha256;
    insert into private.retired_community_deletion_items
      select distinct new_batch_id, 'comment', comment_item.comment_id::text,
        comment_item.post_id, comment_item.row_sha256
      from private.retired_community_t0_comment_inventory comment_item
      join public.post_comments comment_row on comment_row.id = comment_item.comment_id
      where private.retired_community_sha256(to_jsonb(comment_row)::text) = comment_item.row_sha256
        and (comment_item.author_id = target_subject_user_id
          or exists (select 1 from private.retired_community_t0_post_inventory post_item
            where post_item.post_id = comment_item.post_id and post_item.author_id = target_subject_user_id));
    insert into private.retired_community_deletion_items
      select distinct new_batch_id, 'like', like_item.post_id::text || ':' || like_item.user_id::text,
        like_item.post_id, like_item.row_sha256
      from private.retired_community_t0_like_inventory like_item
      join public.post_likes like_row
        on like_row.post_id = like_item.post_id and like_row.user_id = like_item.user_id
      where private.retired_community_sha256(to_jsonb(like_row)::text) = like_item.row_sha256
        and (like_item.user_id = target_subject_user_id
          or exists (select 1 from private.retired_community_t0_post_inventory post_item
            where post_item.post_id = like_item.post_id and post_item.author_id = target_subject_user_id));
  elsif target_reason = 'group_deletion' then
    insert into private.retired_community_deletion_items
      select new_batch_id, 'post', post_item.post_id::text, post_item.post_id, post_item.row_sha256
      from private.retired_community_t0_post_inventory post_item
      join public.community_posts post_row on post_row.id = post_item.post_id
      where post_item.crew_id = target_crew_id
        and private.retired_community_sha256(to_jsonb(post_row)::text) = post_item.row_sha256;
    insert into private.retired_community_deletion_items
      select new_batch_id, 'comment', comment_item.comment_id::text,
        comment_item.post_id, comment_item.row_sha256
      from private.retired_community_t0_comment_inventory comment_item
      join public.post_comments comment_row on comment_row.id = comment_item.comment_id
      where private.retired_community_sha256(to_jsonb(comment_row)::text) = comment_item.row_sha256
        and exists (select 1 from private.retired_community_t0_post_inventory post_item
          where post_item.post_id = comment_item.post_id and post_item.crew_id = target_crew_id);
    insert into private.retired_community_deletion_items
      select new_batch_id, 'like', like_item.post_id::text || ':' || like_item.user_id::text,
        like_item.post_id, like_item.row_sha256
      from private.retired_community_t0_like_inventory like_item
      join public.post_likes like_row
        on like_row.post_id = like_item.post_id and like_row.user_id = like_item.user_id
      where private.retired_community_sha256(to_jsonb(like_row)::text) = like_item.row_sha256
        and exists (select 1 from private.retired_community_t0_post_inventory post_item
          where post_item.post_id = like_item.post_id and post_item.crew_id = target_crew_id);
  end if;

  select coalesce(array_agg(split_part(item_key, ':', 1)::uuid order by item_key), '{}'::uuid[])
    into selected_post_ids from private.retired_community_deletion_items
    where batch_id = new_batch_id and item_kind = 'post';

  insert into private.retired_community_storage_work (
    batch_id, object_id, bucket_id, object_name, expected_row_sha256
  )
  select new_batch_id, object_item.object_id, object_item.bucket_id,
    object_item.object_name, object_item.row_sha256
  from private.retired_community_t0_object_inventory object_item
  where (target_reason = 'aged_retention' and cardinality(object_item.referenced_post_ids) > 0)
    or (target_reason = 'orphan_cleanup' and cardinality(object_item.referenced_post_ids) = 0)
    or (target_reason in ('account_erasure', 'group_deletion')
      and cardinality(object_item.referenced_post_ids) > 0
      and object_item.referenced_post_ids <@ selected_post_ids);

  if target_reason = 'group_deletion' then
    insert into private.retired_community_credential_work (
      batch_id, destination_id, provider, expected_row_sha256
    )
    select new_batch_id, destination.id, destination.provider,
      private.retired_community_credential_sha256(destination)
    from private.integration_destinations destination where destination.crew_id = target_crew_id;
  end if;

  select count(*) filter (where item_kind = 'post'),
    count(*) filter (where item_kind = 'comment'),
    count(*) filter (where item_kind = 'like')
  into posts, comments, likes
  from private.retired_community_deletion_items where batch_id = new_batch_id;
  select count(*) into objects from private.retired_community_storage_work
    where batch_id = new_batch_id;
  select count(*) into credentials from private.retired_community_credential_work
    where batch_id = new_batch_id;

  with sources as (
    select 'item' kind, item_kind || ':' || item_key source_key, row_sha256
    from private.retired_community_deletion_items where batch_id = new_batch_id
    union all
    select 'object', bucket_id || ':' || object_name, expected_row_sha256
    from private.retired_community_storage_work where batch_id = new_batch_id
    union all
    select 'credential', destination_id::text, expected_row_sha256
    from private.retired_community_credential_work where batch_id = new_batch_id
  )
  select private.retired_community_sha256(coalesce(
    jsonb_agg(jsonb_build_array(kind, source_key, row_sha256) order by kind, source_key)::text, '[]'))
  into source_digest from sources;

  update private.retired_community_deletion_batches set
    source_sha256 = source_digest, post_count = posts, comment_count = comments,
    like_count = likes, object_count = objects, credential_count = credentials, sealed = true
  where id = new_batch_id;
  insert into private.retired_community_deletion_ledger
    (batch_id, event_type, actor, event_at, details)
  values (new_batch_id, 'created', target_requested_by, target_requested_at,
    jsonb_build_object('reason', target_reason, 'posts', posts, 'comments', comments,
      'likes', likes, 'objects', objects, 'credentials', credentials));
  return new_batch_id;
end;
$$;

create function private.preview_retired_community_deletion(
  target_reason text,
  target_subject_user_id uuid,
  target_crew_id uuid
)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public, private, pg_temp as $$
  with selected_posts as (
    select post_item.post_id from private.retired_community_t0_post_inventory post_item
    left join public.community_posts post_row on post_row.id = post_item.post_id
    where target_reason = 'aged_retention'
      or ((target_reason = 'account_erasure' and post_item.author_id = target_subject_user_id)
        and private.retired_community_sha256(to_jsonb(post_row)::text) = post_item.row_sha256)
      or ((target_reason = 'group_deletion' and post_item.crew_id = target_crew_id)
        and private.retired_community_sha256(to_jsonb(post_row)::text) = post_item.row_sha256)
  ), post_ids as (
    select coalesce(array_agg(post_id order by post_id), '{}'::uuid[]) ids from selected_posts
  ), selected_comments as (
    select comment_item.comment_id from private.retired_community_t0_comment_inventory comment_item
    left join public.post_comments comment_row on comment_row.id = comment_item.comment_id
    where target_reason = 'aged_retention'
      or (private.retired_community_sha256(to_jsonb(comment_row)::text) = comment_item.row_sha256 and (
        (target_reason = 'account_erasure' and
        (comment_item.author_id = target_subject_user_id
          or comment_item.post_id in (select post_id from selected_posts)))
        or (target_reason = 'group_deletion' and comment_item.post_id in (select post_id from selected_posts))))
  ), selected_likes as (
    select like_item.post_id, like_item.user_id from private.retired_community_t0_like_inventory like_item
    left join public.post_likes like_row
      on like_row.post_id = like_item.post_id and like_row.user_id = like_item.user_id
    where target_reason = 'aged_retention'
      or (private.retired_community_sha256(to_jsonb(like_row)::text) = like_item.row_sha256 and (
        (target_reason = 'account_erasure' and
        (like_item.user_id = target_subject_user_id
          or like_item.post_id in (select post_id from selected_posts)))
        or (target_reason = 'group_deletion' and like_item.post_id in (select post_id from selected_posts))))
  ), selected_objects as (
    select object_id from private.retired_community_t0_object_inventory object_item, post_ids
    where (target_reason = 'aged_retention' and cardinality(object_item.referenced_post_ids) > 0)
      or (target_reason = 'orphan_cleanup' and cardinality(object_item.referenced_post_ids) = 0)
      or (target_reason in ('account_erasure', 'group_deletion')
        and cardinality(object_item.referenced_post_ids) > 0
        and object_item.referenced_post_ids <@ post_ids.ids)
  )
  select jsonb_build_object(
    'batchId', null,
    'status', 'dry_run',
    'counts', jsonb_build_object(
      'posts', (select count(*) from selected_posts),
      'comments', (select count(*) from selected_comments),
      'likes', (select count(*) from selected_likes),
      'objects', (select count(*) from selected_objects),
      'credentials', case when target_reason = 'group_deletion'
        then (select count(*) from private.integration_destinations where crew_id = target_crew_id) else 0 end
    )
  );
$$;

create function public.plan_aged_retired_community_deletion(
  target_requested_by text,
  target_dry_run boolean default true
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private, pg_temp as $$
declare new_batch_id uuid;
begin
  if coalesce(target_dry_run, true) then
    return private.preview_retired_community_deletion('aged_retention', null, null);
  end if;
  new_batch_id := private.create_retired_community_deletion_batch(
    'aged_retention', target_requested_by, null, null, clock_timestamp());
  return private.retired_community_batch_result(new_batch_id);
end;
$$;

create function public.plan_orphan_retired_community_deletion(
  target_requested_by text,
  target_dry_run boolean default true
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private, pg_temp as $$
declare new_batch_id uuid;
begin
  if coalesce(target_dry_run, true) then
    return private.preview_retired_community_deletion('orphan_cleanup', null, null);
  end if;
  new_batch_id := private.create_retired_community_deletion_batch(
    'orphan_cleanup', target_requested_by, null, null, clock_timestamp());
  return private.retired_community_batch_result(new_batch_id);
end;
$$;

create function public.request_retired_community_account_erasure(
  target_dry_run boolean default true
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private, auth, pg_temp as $$
declare subject_id uuid := auth.uid();
declare new_batch_id uuid;
begin
  if subject_id is null then raise exception 'Not authenticated.' using errcode = '42501'; end if;
  if coalesce(target_dry_run, true) then
    return private.preview_retired_community_deletion('account_erasure', subject_id, null);
  end if;
  new_batch_id := private.create_retired_community_deletion_batch(
    'account_erasure', subject_id::text, subject_id, null, clock_timestamp());
  return private.retired_community_batch_result(new_batch_id);
end;
$$;

create function public.request_retired_community_group_deletion(
  target_crew_id uuid,
  target_dry_run boolean default true
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private, auth, pg_temp as $$
declare requester_id uuid := auth.uid();
declare new_batch_id uuid;
begin
  if requester_id is null then raise exception 'Not authenticated.' using errcode = '42501'; end if;
  if not public.can_manage_crew(target_crew_id) then
    raise exception 'Only a group owner or admin can request group deletion.' using errcode = '42501';
  end if;
  if coalesce(target_dry_run, true) then
    return private.preview_retired_community_deletion('group_deletion', null, target_crew_id);
  end if;
  new_batch_id := private.create_retired_community_deletion_batch(
    'group_deletion', requester_id::text, null, target_crew_id, clock_timestamp());
  return private.retired_community_batch_result(new_batch_id);
end;
$$;

create function public.cancel_retired_community_group_deletion(target_batch_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private, auth, pg_temp as $$
declare requester_id uuid := auth.uid();
declare batch_row private.retired_community_deletion_batches%rowtype;
begin
  if requester_id is null then raise exception 'Not authenticated.' using errcode = '42501'; end if;
  select * into strict batch_row from private.retired_community_deletion_batches
    where id = target_batch_id and reason = 'group_deletion';
  if not public.can_manage_crew(batch_row.crew_id) then
    raise exception 'Only a group owner or admin can cancel group deletion.' using errcode = '42501';
  end if;
  if exists (select 1 from private.retired_community_deletion_ledger
    where batch_id = batch_row.id and event_type = 'executed') then
    raise exception 'An executed group deletion cannot be cancelled.' using errcode = '55000';
  end if;
  if clock_timestamp() >= batch_row.execute_after then
    raise exception 'The 30-day group cancellation window has closed.' using errcode = '55000';
  end if;
  if not exists (select 1 from private.retired_community_deletion_ledger
    where batch_id = batch_row.id and event_type = 'cancelled') then
    insert into private.retired_community_deletion_ledger
      (batch_id, event_type, actor, event_at, details)
    values (batch_row.id, 'cancelled', requester_id::text, clock_timestamp(), '{}'::jsonb);
  end if;
  return private.retired_community_batch_result(batch_row.id);
end;
$$;

create function public.record_retired_community_backup_proof(
  target_batch_id uuid,
  target_backup_name text,
  target_backup_version text,
  target_source_sha256 text,
  target_bundle_sha256 text,
  target_bundle_bytes bigint,
  target_verified_by text
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private, pg_temp as $$
declare batch_row private.retired_community_deletion_batches%rowtype;
begin
  select * into strict batch_row from private.retired_community_deletion_batches
    where id = target_batch_id and sealed;
  if private.retired_community_batch_status(batch_row.id) in ('cancelled', 'executed') then
    raise exception 'A terminal deletion batch cannot accept backup proof.' using errcode = '55000';
  end if;
  if target_source_sha256 is distinct from batch_row.source_sha256 then
    raise exception 'Backup source digest does not match the sealed batch.' using errcode = '22023';
  end if;
  insert into private.retired_community_backup_proofs (
    batch_id, backup_name, backup_version, source_sha256, bundle_sha256,
    bundle_bytes, verified_by, verified_at
  ) values (
    batch_row.id, target_backup_name, target_backup_version, target_source_sha256,
    target_bundle_sha256, target_bundle_bytes, target_verified_by, clock_timestamp()
  );
  insert into private.retired_community_deletion_ledger
    (batch_id, event_type, actor, event_at, details)
  values (batch_row.id, 'backup_verified', target_verified_by, clock_timestamp(),
    jsonb_build_object('backupName', target_backup_name, 'backupVersion', target_backup_version,
      'sourceSha256', target_source_sha256, 'bundleSha256', target_bundle_sha256,
      'bundleBytes', target_bundle_bytes));
  return private.retired_community_batch_result(batch_row.id);
end;
$$;

create function public.approve_retired_community_deletion_batch(
  target_batch_id uuid,
  target_approved_by text,
  target_source_sha256 text,
  target_bundle_sha256 text,
  target_post_count bigint,
  target_comment_count bigint,
  target_like_count bigint,
  target_object_count bigint,
  target_credential_count bigint
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private, pg_temp as $$
declare batch_row private.retired_community_deletion_batches%rowtype;
declare proof_row private.retired_community_backup_proofs%rowtype;
begin
  select * into strict batch_row from private.retired_community_deletion_batches
    where id = target_batch_id and sealed;
  select * into strict proof_row from private.retired_community_backup_proofs
    where batch_id = batch_row.id;
  if target_approved_by = batch_row.requested_by or target_approved_by = proof_row.verified_by then
    raise exception 'The approver must be independent from the requester and backup verifier.' using errcode = '42501';
  end if;
  if (target_source_sha256, target_bundle_sha256) is distinct from
     (batch_row.source_sha256, proof_row.bundle_sha256) then
    raise exception 'Approval digests do not match the sealed batch and verified backup.' using errcode = '22023';
  end if;
  if (target_post_count, target_comment_count, target_like_count,
      target_object_count, target_credential_count) is distinct from
     (batch_row.post_count, batch_row.comment_count, batch_row.like_count,
      batch_row.object_count, batch_row.credential_count) then
    raise exception 'Approval counts do not match the sealed batch.' using errcode = '22023';
  end if;
  insert into private.retired_community_batch_approvals (
    batch_id, approved_by, approved_at, source_sha256, bundle_sha256,
    post_count, comment_count, like_count, object_count, credential_count
  ) values (
    batch_row.id, target_approved_by, clock_timestamp(), target_source_sha256,
    target_bundle_sha256, target_post_count, target_comment_count,
    target_like_count, target_object_count, target_credential_count
  );
  insert into private.retired_community_deletion_ledger
    (batch_id, event_type, actor, event_at, details)
  values (batch_row.id, 'approved', target_approved_by, clock_timestamp(),
    jsonb_build_object('sourceSha256', target_source_sha256,
      'bundleSha256', target_bundle_sha256, 'posts', target_post_count,
      'comments', target_comment_count, 'likes', target_like_count,
      'objects', target_object_count, 'credentials', target_credential_count));
  return private.retired_community_batch_result(batch_row.id);
end;
$$;

create function public.claim_retired_community_storage_work(
  target_batch_id uuid,
  target_worker_token uuid,
  target_limit integer default 100
)
returns table (
  work_id uuid,
  bucket_id text,
  object_name text,
  expected_row_sha256 text
)
language plpgsql security definer
set search_path = pg_catalog, public, private, storage, pg_temp as $$
declare batch_row private.retired_community_deletion_batches%rowtype;
begin
  if target_worker_token is null or target_limit not between 1 and 100 then
    raise exception 'A worker token and limit from 1 to 100 are required.' using errcode = '22023';
  end if;
  select * into strict batch_row from private.retired_community_deletion_batches
    where id = target_batch_id and sealed;
  if not exists (select 1 from private.retired_community_backup_proofs where batch_id = batch_row.id)
     or not exists (select 1 from private.retired_community_batch_approvals where batch_id = batch_row.id) then
    raise exception 'Backup proof and independent approval are required before work begins.' using errcode = '55000';
  end if;
  if private.retired_community_batch_status(batch_row.id) in ('cancelled', 'executed')
     or clock_timestamp() < batch_row.execute_after then
    raise exception 'This deletion batch is not executable.' using errcode = '55000';
  end if;
  if exists (
    select 1 from private.retired_community_storage_work work
    join storage.objects object_row
      on object_row.bucket_id = work.bucket_id and object_row.name = work.object_name
    where work.batch_id = batch_row.id and work.status <> 'confirmed'
      and private.retired_community_sha256(to_jsonb(object_row)::text) <> work.expected_row_sha256
  ) then
    raise exception 'A queued Storage object no longer matches its sealed inventory.' using errcode = '55000';
  end if;
  return query
  with claims as (
    select work.id from private.retired_community_storage_work work
    where work.batch_id = batch_row.id
      and (work.status = 'queued' or (work.status = 'claimed' and
        (work.claim_token = target_worker_token
          or work.claimed_at <= clock_timestamp() - interval '15 minutes')))
    order by work.object_name limit target_limit for update skip locked
  )
  update private.retired_community_storage_work work set
    status = 'claimed', claim_token = target_worker_token, claimed_at = clock_timestamp()
  from claims where work.id = claims.id
  returning work.id, work.bucket_id, work.object_name, work.expected_row_sha256;
end;
$$;

create function public.confirm_retired_community_storage_work(
  target_batch_id uuid,
  target_work_id uuid,
  target_worker_token uuid,
  target_actor text
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private, storage, pg_temp as $$
declare work_row private.retired_community_storage_work%rowtype;
begin
  select * into strict work_row from private.retired_community_storage_work
    where id = target_work_id and batch_id = target_batch_id for update;
  if work_row.status = 'confirmed' then
    return private.retired_community_batch_result(work_row.batch_id);
  end if;
  if private.retired_community_batch_status(work_row.batch_id) in ('cancelled', 'executed') then
    raise exception 'This deletion batch is terminal.' using errcode = '55000';
  end if;
  if work_row.status <> 'claimed' or work_row.claim_token is distinct from target_worker_token then
    raise exception 'Storage work is not claimed by this worker.' using errcode = '42501';
  end if;
  if exists (select 1 from storage.objects
    where bucket_id = work_row.bucket_id and name = work_row.object_name) then
    raise exception 'The Storage object still exists.' using errcode = '55000';
  end if;
  update private.retired_community_storage_work set
    status = 'confirmed', confirmed_at = clock_timestamp()
  where id = work_row.id;
  insert into private.retired_community_deletion_ledger
    (batch_id, event_type, actor, event_at, details)
  values (work_row.batch_id, 'storage_confirmed', target_actor, clock_timestamp(),
    jsonb_build_object('workId', work_row.id));
  return private.retired_community_batch_result(work_row.batch_id);
end;
$$;

create function public.claim_retired_community_credential_work(
  target_batch_id uuid,
  target_worker_token uuid,
  target_limit integer default 20
)
returns table (
  work_id uuid,
  destination_id uuid,
  provider text,
  provider_workspace_id text,
  provider_destination_id text,
  credential_ciphertext bytea,
  credential_nonce bytea,
  credential_key_version smallint
)
language plpgsql security definer
set search_path = pg_catalog, public, private, pg_temp as $$
declare batch_row private.retired_community_deletion_batches%rowtype;
begin
  if target_worker_token is null or target_limit not between 1 and 20 then
    raise exception 'A worker token and limit from 1 to 20 are required.' using errcode = '22023';
  end if;
  select * into strict batch_row from private.retired_community_deletion_batches
    where id = target_batch_id and reason = 'group_deletion' and sealed;
  if not exists (select 1 from private.retired_community_backup_proofs where batch_id = batch_row.id)
     or not exists (select 1 from private.retired_community_batch_approvals where batch_id = batch_row.id)
     or clock_timestamp() < batch_row.execute_after
     or private.retired_community_batch_status(batch_row.id) in ('cancelled', 'executed') then
    raise exception 'This credential batch is not executable.' using errcode = '55000';
  end if;
  if exists (
    select 1 from private.retired_community_credential_work work
    left join private.integration_destinations destination on destination.id = work.destination_id
    where work.batch_id = batch_row.id and work.status <> 'confirmed'
      and (destination.id is null
        or private.retired_community_credential_sha256(destination) <> work.expected_row_sha256)
  ) then
    raise exception 'A provider destination no longer matches its sealed inventory.' using errcode = '55000';
  end if;
  return query
  with claims as (
    select work.id from private.retired_community_credential_work work
    where work.batch_id = batch_row.id
      and (work.status = 'queued' or (work.status = 'claimed' and
        (work.claim_token = target_worker_token
          or work.claimed_at <= clock_timestamp() - interval '15 minutes')))
    order by work.destination_id limit target_limit for update skip locked
  ), claimed as (
    update private.retired_community_credential_work work set
      status = 'claimed', claim_token = target_worker_token, claimed_at = clock_timestamp()
    from claims where work.id = claims.id returning work.*
  )
  select claimed.id, destination.id, destination.provider,
    destination.provider_workspace_id, destination.provider_destination_id,
    destination.credential_ciphertext, destination.credential_nonce,
    destination.credential_key_version
  from claimed join private.integration_destinations destination
    on destination.id = claimed.destination_id;
end;
$$;

create function public.confirm_retired_community_credential_work(
  target_batch_id uuid,
  target_work_id uuid,
  target_worker_token uuid,
  target_actor text,
  target_provider_revocation_reference text
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private, pg_temp as $$
declare work_row private.retired_community_credential_work%rowtype;
begin
  select * into strict work_row from private.retired_community_credential_work
    where id = target_work_id and batch_id = target_batch_id for update;
  if work_row.status = 'confirmed' then
    return private.retired_community_batch_result(work_row.batch_id);
  end if;
  if private.retired_community_batch_status(work_row.batch_id) in ('cancelled', 'executed') then
    raise exception 'This deletion batch is terminal.' using errcode = '55000';
  end if;
  if work_row.status <> 'claimed' or work_row.claim_token is distinct from target_worker_token then
    raise exception 'Credential work is not claimed by this worker.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from private.integration_destinations destination
    where destination.id = work_row.destination_id
      and private.retired_community_credential_sha256(destination) = work_row.expected_row_sha256
  ) then
    raise exception 'The provider credential no longer matches its sealed inventory.' using errcode = '55000';
  end if;
  if char_length(trim(coalesce(target_provider_revocation_reference, ''))) not between 3 and 200 then
    raise exception 'A provider revocation reference is required.' using errcode = '22023';
  end if;
  update private.integration_destinations set
    status = 'revoked', credential_ciphertext = null, credential_nonce = null,
    credential_key_version = null, credential_fingerprint = null, scopes = '{}',
    disconnected_at = clock_timestamp(), last_error_code = null, last_error_summary = null
  where id = work_row.destination_id;
  update private.retired_community_credential_work set
    status = 'confirmed', confirmed_at = clock_timestamp(),
    provider_revocation_reference = target_provider_revocation_reference
  where id = work_row.id;
  insert into private.retired_community_deletion_ledger
    (batch_id, event_type, actor, event_at, details)
  values (work_row.batch_id, 'credential_confirmed', target_actor, clock_timestamp(),
    jsonb_build_object('workId', work_row.id, 'provider', work_row.provider,
      'providerReference', target_provider_revocation_reference));
  return private.retired_community_batch_result(work_row.batch_id);
end;
$$;

create function public.execute_retired_community_deletion_batch(
  target_batch_id uuid,
  target_operator text,
  target_confirmation text
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private, auth, pg_temp as $$
declare batch_row private.retired_community_deletion_batches%rowtype;
declare census_row private.retired_community_t0_census%rowtype;
begin
  if target_confirmation is distinct from 'EXECUTE SEALED RETIRED COMMUNITY DELETION' then
    raise exception 'The exact destructive confirmation is required.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('retired-community-deletion', 0));
  select * into strict batch_row from private.retired_community_deletion_batches
    where id = target_batch_id and sealed;
  select * into strict census_row from private.retired_community_t0_census where singleton;
  if private.retired_community_batch_status(batch_row.id) = 'executed' then
    return private.retired_community_batch_result(batch_row.id);
  end if;
  if private.retired_community_batch_status(batch_row.id) <> 'ready' then
    raise exception 'The deletion batch is not ready.' using errcode = '55000';
  end if;
  if batch_row.reason = 'aged_retention'
     and clock_timestamp() < census_row.captured_at + interval '91 days' then
    raise exception 'Aged retention cannot execute before T0 plus 91 days.' using errcode = '55000';
  end if;
  if exists (
    select 1 from private.retired_community_deletion_items item
    left join public.community_posts post_row
      on item.item_kind = 'post' and post_row.id = split_part(item.item_key, ':', 1)::uuid
    where item.batch_id = batch_row.id and item.item_kind = 'post'
      and ((post_row.id is not null
          and private.retired_community_sha256(to_jsonb(post_row)::text) <> item.row_sha256)
        or (post_row.id is null and not exists (
          select 1 from private.retired_community_deletion_items prior_item
          join private.retired_community_deletion_ledger prior_execution
            on prior_execution.batch_id = prior_item.batch_id
              and prior_execution.event_type = 'executed'
          where prior_item.batch_id <> item.batch_id
            and prior_item.item_kind = item.item_kind
            and prior_item.item_key = item.item_key
            and prior_item.row_sha256 = item.row_sha256
        )))
  ) or exists (
    select 1 from private.retired_community_deletion_items item
    left join public.post_comments comment_row
      on item.item_kind = 'comment' and comment_row.id = split_part(item.item_key, ':', 1)::uuid
    where item.batch_id = batch_row.id and item.item_kind = 'comment'
      and ((comment_row.id is not null
          and private.retired_community_sha256(to_jsonb(comment_row)::text) <> item.row_sha256)
        or (comment_row.id is null and not exists (
          select 1 from private.retired_community_deletion_items prior_item
          join private.retired_community_deletion_ledger prior_execution
            on prior_execution.batch_id = prior_item.batch_id
              and prior_execution.event_type = 'executed'
          where prior_item.batch_id <> item.batch_id
            and prior_item.item_kind = item.item_kind
            and prior_item.item_key = item.item_key
            and prior_item.row_sha256 = item.row_sha256
        )))
  ) or exists (
    select 1 from private.retired_community_deletion_items item
    left join public.post_likes like_row on item.item_kind = 'like'
      and like_row.post_id = item.post_id
      and like_row.user_id = split_part(item.item_key, ':', 2)::uuid
    where item.batch_id = batch_row.id and item.item_kind = 'like'
      and ((like_row.post_id is not null
          and private.retired_community_sha256(to_jsonb(like_row)::text) <> item.row_sha256)
        or (like_row.post_id is null and not exists (
          select 1 from private.retired_community_deletion_items prior_item
          join private.retired_community_deletion_ledger prior_execution
            on prior_execution.batch_id = prior_item.batch_id
              and prior_execution.event_type = 'executed'
          where prior_item.batch_id <> item.batch_id
            and prior_item.item_kind = item.item_kind
            and prior_item.item_key = item.item_key
            and prior_item.row_sha256 = item.row_sha256
        )))
  ) then
    raise exception 'A relational source row no longer matches the sealed batch.' using errcode = '55000';
  end if;

  if batch_row.reason = 'account_erasure' then
    delete from public.post_comments comment_row using private.retired_community_deletion_items item
    where item.batch_id = batch_row.id and item.item_kind = 'comment'
      and comment_row.id = split_part(item.item_key, ':', 1)::uuid;
    delete from public.post_likes like_row using private.retired_community_deletion_items item
    where item.batch_id = batch_row.id and item.item_kind = 'like'
      and like_row.post_id = item.post_id
      and like_row.user_id = split_part(item.item_key, ':', 2)::uuid;
    delete from public.community_posts post_row using private.retired_community_deletion_items item
    where item.batch_id = batch_row.id and item.item_kind = 'post'
      and post_row.id = split_part(item.item_key, ':', 1)::uuid;
    delete from auth.users where id = batch_row.subject_user_id;
  elsif batch_row.reason = 'group_deletion' then
    delete from public.crews where id = batch_row.crew_id;
  elsif batch_row.reason = 'aged_retention' then
    delete from public.post_comments comment_row using private.retired_community_deletion_items item
    where item.batch_id = batch_row.id and item.item_kind = 'comment'
      and comment_row.id = split_part(item.item_key, ':', 1)::uuid;
    delete from public.post_likes like_row using private.retired_community_deletion_items item
    where item.batch_id = batch_row.id and item.item_kind = 'like'
      and like_row.post_id = item.post_id
      and like_row.user_id = split_part(item.item_key, ':', 2)::uuid;
    delete from public.community_posts post_row using private.retired_community_deletion_items item
    where item.batch_id = batch_row.id and item.item_kind = 'post'
      and post_row.id = split_part(item.item_key, ':', 1)::uuid;
  end if;

  insert into private.retired_community_deletion_ledger
    (batch_id, event_type, actor, event_at, details)
  values (batch_row.id, 'executed', target_operator, clock_timestamp(),
    jsonb_build_object('reason', batch_row.reason, 'posts', batch_row.post_count,
      'comments', batch_row.comment_count, 'likes', batch_row.like_count,
      'objects', batch_row.object_count, 'credentials', batch_row.credential_count));
  return private.retired_community_batch_result(batch_row.id);
end;
$$;

revoke all on private.retired_community_deletion_batches from public, anon, authenticated, service_role;
revoke all on private.retired_community_deletion_items from public, anon, authenticated, service_role;
revoke all on private.retired_community_storage_work from public, anon, authenticated, service_role;
revoke all on private.retired_community_credential_work from public, anon, authenticated, service_role;
revoke all on private.retired_community_backup_proofs from public, anon, authenticated, service_role;
revoke all on private.retired_community_batch_approvals from public, anon, authenticated, service_role;
revoke all on private.retired_community_deletion_ledger from public, anon, authenticated, service_role;
revoke all on sequence private.retired_community_deletion_ledger_id_seq
  from public, anon, authenticated, service_role;

revoke all on function private.guard_retired_community_batch_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.guard_retired_community_item_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.block_retired_community_record_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.retired_community_batch_status(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.retired_community_batch_result(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.retired_community_credential_sha256(private.integration_destinations)
  from public, anon, authenticated, service_role;
revoke all on function private.create_retired_community_deletion_batch(text,text,uuid,uuid,timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function private.preview_retired_community_deletion(text,uuid,uuid)
  from public, anon, authenticated, service_role;

revoke all on function public.plan_aged_retired_community_deletion(text,boolean)
  from public, anon, authenticated;
revoke all on function public.plan_orphan_retired_community_deletion(text,boolean)
  from public, anon, authenticated;
revoke all on function public.record_retired_community_backup_proof(uuid,text,text,text,text,bigint,text)
  from public, anon, authenticated;
revoke all on function public.approve_retired_community_deletion_batch(uuid,text,text,text,bigint,bigint,bigint,bigint,bigint)
  from public, anon, authenticated;
revoke all on function public.claim_retired_community_storage_work(uuid,uuid,integer)
  from public, anon, authenticated;
revoke all on function public.confirm_retired_community_storage_work(uuid,uuid,uuid,text)
  from public, anon, authenticated;
revoke all on function public.claim_retired_community_credential_work(uuid,uuid,integer)
  from public, anon, authenticated;
revoke all on function public.confirm_retired_community_credential_work(uuid,uuid,uuid,text,text)
  from public, anon, authenticated;
revoke all on function public.execute_retired_community_deletion_batch(uuid,text,text)
  from public, anon, authenticated;

grant execute on function public.plan_aged_retired_community_deletion(text,boolean) to service_role;
grant execute on function public.plan_orphan_retired_community_deletion(text,boolean) to service_role;
grant execute on function public.record_retired_community_backup_proof(uuid,text,text,text,text,bigint,text)
  to service_role;
grant execute on function public.approve_retired_community_deletion_batch(uuid,text,text,text,bigint,bigint,bigint,bigint,bigint)
  to service_role;
grant execute on function public.claim_retired_community_storage_work(uuid,uuid,integer) to service_role;
grant execute on function public.confirm_retired_community_storage_work(uuid,uuid,uuid,text) to service_role;
grant execute on function public.claim_retired_community_credential_work(uuid,uuid,integer) to service_role;
grant execute on function public.confirm_retired_community_credential_work(uuid,uuid,uuid,text,text)
  to service_role;
grant execute on function public.execute_retired_community_deletion_batch(uuid,text,text) to service_role;

revoke all on function public.request_retired_community_account_erasure(boolean)
  from public, anon, service_role;
revoke all on function public.request_retired_community_group_deletion(uuid,boolean)
  from public, anon, service_role;
revoke all on function public.cancel_retired_community_group_deletion(uuid)
  from public, anon, service_role;
grant execute on function public.request_retired_community_account_erasure(boolean) to authenticated;
grant execute on function public.request_retired_community_group_deletion(uuid,boolean) to authenticated;
grant execute on function public.cancel_retired_community_group_deletion(uuid) to authenticated;

comment on table private.retired_community_deletion_batches is
  'Sealed immutable deletion scopes; state is derived from append-only proof, approval, work, and ledger records.';
comment on function public.claim_retired_community_storage_work(uuid,uuid,integer) is
  'Worker-only exact Storage paths. SQL never deletes storage.objects.';
comment on function public.execute_retired_community_deletion_batch(uuid,text,text) is
  'Executes only a sealed, backed-up, independently approved batch after exact object and credential confirmation.';
