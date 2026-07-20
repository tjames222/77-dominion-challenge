-- FOU-564: export-first lifecycle for retired private-group social data.
-- This migration is inert by default: it creates no scheduler and performs no purge.

create table private.retired_community_retention_policy (
  singleton boolean primary key default true check (singleton),
  not_before timestamptz not null,
  maximum_batch_size integer not null default 250 check (maximum_batch_size between 1 and 250),
  purge_approved boolean not null default false,
  approval_reference text,
  updated_at timestamptz not null default now(),
  updated_by text not null,
  check (not purge_approved or char_length(trim(coalesce(approval_reference, ''))) between 3 and 200)
);

insert into private.retired_community_retention_policy (
  singleton, not_before, maximum_batch_size, purge_approved, updated_by
) values (
  true, '2026-10-20 12:00:00+00', 250, false, 'migration:20260720130000'
);

create table private.retired_community_export_runs (
  id uuid primary key default gen_random_uuid(),
  requested_by text not null check (char_length(requested_by) between 3 and 120),
  requested_at timestamptz not null default now(),
  cutoff_at timestamptz not null,
  batch_size integer not null check (batch_size between 1 and 250),
  post_count integer not null default 0 check (post_count >= 0),
  comment_count integer not null default 0 check (comment_count >= 0),
  like_count integer not null default 0 check (like_count >= 0),
  image_count integer not null default 0 check (image_count >= 0),
  export_sha256 text check (export_sha256 is null or export_sha256 ~ '^[0-9a-f]{64}$'),
  export_proven_at timestamptz,
  executed_at timestamptz,
  deleted_post_count integer not null default 0 check (deleted_post_count >= 0)
);

create table private.retired_community_export_items (
  run_id uuid not null references private.retired_community_export_runs(id) on delete restrict,
  post_id uuid not null,
  author_id uuid not null,
  crew_id uuid not null,
  created_at timestamptz not null,
  image_path text,
  comment_count integer not null,
  like_count integer not null,
  primary key (run_id, post_id)
);

create unique index retired_community_export_items_active_post_idx
  on private.retired_community_export_items (post_id);

create table private.retired_community_retention_audit (
  id bigint generated always as identity primary key,
  run_id uuid references private.retired_community_export_runs(id) on delete restrict,
  actor text not null,
  event_type text not null check (event_type in ('policy_changed', 'previewed', 'export_proven', 'executed')),
  event_at timestamptz not null default now(),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object')
);

create function private.block_retired_community_audit_mutation()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  raise exception 'Retired Community retention audit is append-only.' using errcode = '55000';
end;
$$;

create trigger block_retired_community_audit_mutation
  before update or delete on private.retired_community_retention_audit
  for each row execute function private.block_retired_community_audit_mutation();

create function private.audit_retired_community_retention(uuid, text, text, jsonb)
returns void language sql security definer set search_path = private, pg_temp as $$
  insert into private.retired_community_retention_audit (run_id, actor, event_type, details)
  values ($1, $2, $3, coalesce($4, '{}'::jsonb));
$$;

create function public.configure_retired_community_retention(
  target_not_before timestamptz,
  target_purge_approved boolean,
  target_approval_reference text,
  target_actor text,
  target_maximum_batch_size integer default 250
)
returns jsonb language plpgsql security definer
set search_path = public, private, pg_temp as $$
declare policy_row private.retired_community_retention_policy%rowtype;
begin
  if target_actor !~ '^[A-Za-z0-9][A-Za-z0-9._@:+-]{2,119}$' then
    raise exception 'A valid operator identifier is required.' using errcode = '22023';
  end if;
  if target_maximum_batch_size not between 1 and 250 then
    raise exception 'The maximum batch size must be between 1 and 250.' using errcode = '22023';
  end if;
  if coalesce(target_purge_approved, false)
     and char_length(trim(coalesce(target_approval_reference, ''))) not between 3 and 200 then
    raise exception 'An approval reference is required.' using errcode = '22023';
  end if;
  update private.retired_community_retention_policy
  set not_before = target_not_before,
      maximum_batch_size = target_maximum_batch_size,
      purge_approved = coalesce(target_purge_approved, false),
      approval_reference = case when target_purge_approved then trim(target_approval_reference) end,
      updated_at = clock_timestamp(),
      updated_by = target_actor
  where singleton returning * into policy_row;
  perform private.audit_retired_community_retention(null, target_actor, 'policy_changed',
    jsonb_build_object('notBefore', policy_row.not_before, 'purgeApproved', policy_row.purge_approved,
      'approvalReference', policy_row.approval_reference, 'maximumBatchSize', policy_row.maximum_batch_size));
  return jsonb_build_object('notBefore', policy_row.not_before, 'purgeApproved', policy_row.purge_approved,
    'maximumBatchSize', policy_row.maximum_batch_size);
end;
$$;

create function public.preview_retired_community_retention(
  target_cutoff_at timestamptz default null,
  target_batch_size integer default 250
)
returns jsonb language plpgsql stable security definer
set search_path = public, private, pg_temp as $$
declare policy_row private.retired_community_retention_policy%rowtype;
declare cutoff_value timestamptz;
declare result jsonb;
begin
  select * into strict policy_row from private.retired_community_retention_policy where singleton;
  if target_batch_size not between 1 and policy_row.maximum_batch_size then
    raise exception 'The preview batch size exceeds policy.' using errcode = '22023';
  end if;
  cutoff_value := least(coalesce(target_cutoff_at, policy_row.not_before), '2026-07-20 12:00:00+00'::timestamptz);
  with candidates as (
    select post_row.id, post_row.image_path,
      (select count(*) from public.post_comments comment_row where comment_row.post_id = post_row.id) comments,
      (select count(*) from public.post_likes like_row where like_row.post_id = post_row.id) likes
    from public.community_posts post_row
    where post_row.scope = 'crew' and post_row.crew_id is not null
      and post_row.created_at < cutoff_value
      and not exists (select 1 from private.retired_community_export_items item where item.post_id = post_row.id)
    order by post_row.created_at, post_row.id limit target_batch_size
  )
  select jsonb_build_object('dryRun', true, 'cutoffAt', cutoff_value,
    'counts', jsonb_build_object('posts', count(*), 'comments', coalesce(sum(comments), 0),
      'likes', coalesce(sum(likes), 0), 'images', count(image_path)))
  into result from candidates;
  return result;
end;
$$;

create function public.create_retired_community_export_run(
  target_requested_by text,
  target_cutoff_at timestamptz default null,
  target_batch_size integer default 250
)
returns jsonb language plpgsql security definer
set search_path = public, private, storage, pg_temp as $$
declare policy_row private.retired_community_retention_policy%rowtype;
declare run_row private.retired_community_export_runs%rowtype;
declare cutoff_value timestamptz;
begin
  if target_requested_by !~ '^[A-Za-z0-9][A-Za-z0-9._@:+-]{2,119}$' then
    raise exception 'A valid operator identifier is required.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('retired-community-retention', 0));
  select * into strict policy_row from private.retired_community_retention_policy where singleton;
  if target_batch_size not between 1 and policy_row.maximum_batch_size then
    raise exception 'The export batch size exceeds policy.' using errcode = '22023';
  end if;
  cutoff_value := least(coalesce(target_cutoff_at, policy_row.not_before), '2026-07-20 12:00:00+00'::timestamptz);
  insert into private.retired_community_export_runs (requested_by, cutoff_at, batch_size)
    values (target_requested_by, cutoff_value, target_batch_size) returning * into run_row;
  insert into private.retired_community_export_items
    (run_id, post_id, author_id, crew_id, created_at, image_path, comment_count, like_count)
  select run_row.id, post_row.id, post_row.author_id, post_row.crew_id, post_row.created_at, post_row.image_path,
    (select count(*) from public.post_comments comment_row where comment_row.post_id = post_row.id),
    (select count(*) from public.post_likes like_row where like_row.post_id = post_row.id)
  from public.community_posts post_row
  where post_row.scope = 'crew' and post_row.crew_id is not null and post_row.created_at < cutoff_value
    and not exists (select 1 from private.retired_community_export_items item where item.post_id = post_row.id)
  order by post_row.created_at, post_row.id limit target_batch_size;
  if exists (
    select 1 from private.retired_community_export_items item
    where item.run_id = run_row.id and item.image_path is not null
      and item.image_path not like item.crew_id::text || '/' || item.author_id::text || '/%'
  ) or exists (
    select 1 from private.retired_community_export_items item join storage.objects object_row
      on object_row.bucket_id = 'community-post-images' and object_row.name = item.image_path
    where item.run_id = run_row.id and object_row.owner is distinct from item.author_id
  ) then
    raise exception 'A retained image fails its post ownership check.' using errcode = '42501';
  end if;
  update private.retired_community_export_runs target_run set
    post_count = summary.posts, comment_count = summary.comments, like_count = summary.likes, image_count = summary.images
  from (select count(*)::integer posts, coalesce(sum(comment_count), 0)::integer comments,
    coalesce(sum(like_count), 0)::integer likes, count(image_path)::integer images
    from private.retired_community_export_items where run_id = run_row.id) summary
  where target_run.id = run_row.id returning target_run.* into run_row;
  perform private.audit_retired_community_retention(run_row.id, target_requested_by, 'previewed',
    jsonb_build_object('cutoffAt', run_row.cutoff_at, 'posts', run_row.post_count,
      'comments', run_row.comment_count, 'likes', run_row.like_count, 'images', run_row.image_count));
  return jsonb_build_object('runId', run_row.id, 'dryRun', true, 'cutoffAt', run_row.cutoff_at,
    'counts', jsonb_build_object('posts', run_row.post_count, 'comments', run_row.comment_count,
      'likes', run_row.like_count, 'images', run_row.image_count));
end;
$$;

create function public.export_retired_community_run(target_run_id uuid)
returns jsonb language sql stable security definer
set search_path = public, private, pg_temp set timezone = 'UTC' as $$
  select jsonb_build_object('schemaVersion', 1, 'runId', run_row.id, 'cutoffAt', run_row.cutoff_at,
    'counts', jsonb_build_object('posts', run_row.post_count, 'comments', run_row.comment_count,
      'likes', run_row.like_count, 'images', run_row.image_count),
    'posts', coalesce((select jsonb_agg(jsonb_build_object(
      'id', post_row.id, 'authorId', post_row.author_id, 'displayName', post_row.display_name,
      'crewId', post_row.crew_id, 'body', post_row.body, 'postType', post_row.post_type,
      'challengeDay', post_row.challenge_day, 'status', post_row.status,
      'completedCount', post_row.completed_count, 'imagePath', post_row.image_path,
      'imageAlt', post_row.image_alt, 'createdAt', post_row.created_at, 'updatedAt', post_row.updated_at,
      'comments', coalesce((select jsonb_agg(jsonb_build_object('id', comment_row.id,
        'userId', comment_row.user_id, 'displayName', comment_row.display_name, 'body', comment_row.body,
        'createdAt', comment_row.created_at, 'updatedAt', comment_row.updated_at)
        order by comment_row.created_at, comment_row.id) from public.post_comments comment_row
        where comment_row.post_id = post_row.id), '[]'::jsonb),
      'likes', coalesce((select jsonb_agg(jsonb_build_object('userId', like_row.user_id,
        'createdAt', like_row.created_at) order by like_row.created_at, like_row.user_id)
        from public.post_likes like_row where like_row.post_id = post_row.id), '[]'::jsonb)
    ) order by post_row.created_at, post_row.id)
    from private.retired_community_export_items item
    join public.community_posts post_row on post_row.id = item.post_id
    where item.run_id = run_row.id), '[]'::jsonb))
  from private.retired_community_export_runs run_row where run_row.id = target_run_id;
$$;

create function public.prove_retired_community_export(
  target_run_id uuid,
  target_requested_by text,
  target_export_sha256 text,
  target_post_count integer,
  target_comment_count integer,
  target_like_count integer,
  target_image_count integer
)
returns jsonb language plpgsql security definer
set search_path = public, private, pg_temp as $$
declare run_row private.retired_community_export_runs%rowtype;
begin
  select * into strict run_row from private.retired_community_export_runs
    where id = target_run_id for update;
  if run_row.requested_by is distinct from target_requested_by then
    raise exception 'Only the operator who created the export can prove it.' using errcode = '42501';
  end if;
  if target_export_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'A lowercase SHA-256 digest is required.' using errcode = '22023';
  end if;
  if (run_row.post_count, run_row.comment_count, run_row.like_count, run_row.image_count)
    is distinct from (target_post_count, target_comment_count, target_like_count, target_image_count) then
    raise exception 'Export counts do not match the recorded run.' using errcode = '22023';
  end if;
  if run_row.post_count = 0 then
    raise exception 'An empty export cannot be approved for deletion.' using errcode = '55000';
  end if;
  update private.retired_community_export_runs set export_sha256 = target_export_sha256,
    export_proven_at = clock_timestamp() where id = run_row.id;
  perform private.audit_retired_community_retention(run_row.id, target_requested_by, 'export_proven',
    jsonb_build_object('sha256', target_export_sha256, 'posts', target_post_count,
      'comments', target_comment_count, 'likes', target_like_count, 'images', target_image_count));
  return jsonb_build_object('runId', run_row.id, 'exportProven', true, 'sha256', target_export_sha256);
end;
$$;

create function public.execute_retired_community_retention(
  target_run_id uuid,
  target_requested_by text,
  target_export_sha256 text,
  target_confirmation text
)
returns jsonb language plpgsql security definer
set search_path = public, private, storage, pg_temp as $$
declare policy_row private.retired_community_retention_policy%rowtype;
declare run_row private.retired_community_export_runs%rowtype;
declare remaining_paths text[];
declare removed_posts integer;
begin
  if target_confirmation is distinct from 'DELETE EXPORTED RETIRED COMMUNITY DATA' then
    raise exception 'The exact destructive confirmation is required.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('retired-community-retention', 0));
  select * into strict policy_row from private.retired_community_retention_policy where singleton;
  select * into strict run_row from private.retired_community_export_runs where id = target_run_id for update;
  if run_row.executed_at is not null then
    return jsonb_build_object('runId', run_row.id, 'status', 'completed',
      'deletedPosts', run_row.deleted_post_count);
  end if;
  if run_row.requested_by is distinct from target_requested_by then
    raise exception 'Only the operator who created the export can execute it.' using errcode = '42501';
  end if;
  if not policy_row.purge_approved or clock_timestamp() < policy_row.not_before then
    raise exception 'Deletion is not approved or its not-before window has not opened.' using errcode = '55000';
  end if;
  if run_row.export_proven_at is null or run_row.export_sha256 is distinct from target_export_sha256 then
    raise exception 'The proven export digest does not match.' using errcode = '22023';
  end if;
  if exists (select 1 from private.retired_community_export_items item
    left join public.community_posts post_row on post_row.id = item.post_id
    where item.run_id = run_row.id and (post_row.id is null or post_row.scope <> 'crew'
      or post_row.author_id is distinct from item.author_id or post_row.crew_id is distinct from item.crew_id
      or post_row.created_at is distinct from item.created_at or post_row.image_path is distinct from item.image_path
      or (select count(*) from public.post_comments c where c.post_id = item.post_id) <> item.comment_count
      or (select count(*) from public.post_likes l where l.post_id = item.post_id) <> item.like_count)) then
    raise exception 'Retained data changed after export.' using errcode = '55000';
  end if;
  select coalesce(array_agg(object_row.name order by object_row.name), '{}'::text[])
    into remaining_paths from storage.objects object_row
    join private.retired_community_export_items item
      on item.image_path = object_row.name and object_row.bucket_id = 'community-post-images'
    where item.run_id = run_row.id;
  if cardinality(remaining_paths) > 0 then
    return jsonb_build_object('runId', run_row.id, 'status', 'storage_cleanup_required',
      'deletedPosts', 0, 'imagePaths', to_jsonb(remaining_paths));
  end if;
  delete from public.community_posts post_row using private.retired_community_export_items item
    where item.run_id = run_row.id and item.post_id = post_row.id and post_row.scope = 'crew'
      and post_row.author_id = item.author_id and post_row.crew_id = item.crew_id
      and post_row.created_at = item.created_at and post_row.image_path is not distinct from item.image_path;
  get diagnostics removed_posts = row_count;
  if removed_posts <> run_row.post_count then
    raise exception 'The bounded deletion did not match the export run.' using errcode = '55000';
  end if;
  update private.retired_community_export_runs set executed_at = clock_timestamp(),
    deleted_post_count = removed_posts where id = run_row.id;
  perform private.audit_retired_community_retention(run_row.id, target_requested_by, 'executed',
    jsonb_build_object('posts', removed_posts, 'comments', run_row.comment_count,
      'likes', run_row.like_count, 'images', run_row.image_count,
      'approvalReference', policy_row.approval_reference));
  return jsonb_build_object('runId', run_row.id, 'status', 'completed', 'deletedPosts', removed_posts,
    'deletedComments', run_row.comment_count, 'deletedLikes', run_row.like_count,
    'deletedImages', run_row.image_count);
end;
$$;

revoke all on private.retired_community_retention_policy from public, anon, authenticated, service_role;
revoke all on private.retired_community_export_runs from public, anon, authenticated, service_role;
revoke all on private.retired_community_export_items from public, anon, authenticated, service_role;
revoke all on private.retired_community_retention_audit from public, anon, authenticated, service_role;
revoke all on sequence private.retired_community_retention_audit_id_seq
  from public, anon, authenticated, service_role;
revoke all on function private.block_retired_community_audit_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.audit_retired_community_retention(uuid, text, text, jsonb)
  from public, anon, authenticated, service_role;

revoke all on function public.configure_retired_community_retention(timestamptz, boolean, text, text, integer)
  from public, anon, authenticated;
revoke all on function public.preview_retired_community_retention(timestamptz, integer)
  from public, anon, authenticated;
revoke all on function public.create_retired_community_export_run(text, timestamptz, integer)
  from public, anon, authenticated;
revoke all on function public.export_retired_community_run(uuid)
  from public, anon, authenticated;
revoke all on function public.prove_retired_community_export(uuid, text, text, integer, integer, integer, integer)
  from public, anon, authenticated;
revoke all on function public.execute_retired_community_retention(uuid, text, text, text)
  from public, anon, authenticated;

grant execute on function public.configure_retired_community_retention(timestamptz, boolean, text, text, integer)
  to service_role;
grant execute on function public.preview_retired_community_retention(timestamptz, integer)
  to service_role;
grant execute on function public.create_retired_community_export_run(text, timestamptz, integer)
  to service_role;
grant execute on function public.export_retired_community_run(uuid)
  to service_role;
grant execute on function public.prove_retired_community_export(uuid, text, text, integer, integer, integer, integer)
  to service_role;
grant execute on function public.execute_retired_community_retention(uuid, text, text, text)
  to service_role;

comment on table private.retired_community_retention_policy is
  'Service-only policy. Purge is disabled by default and no scheduler invokes it.';
comment on table private.retired_community_retention_audit is
  'Append-only operational metadata; export content and image paths are never written here.';
comment on function public.preview_retired_community_retention(timestamptz, integer) is
  'Read-only dry-run preview capped by the service-only retention policy.';
comment on function public.execute_retired_community_retention(uuid, text, text, text) is
  'Deletes only a proven, approved export batch; returns remaining Storage paths without deleting rows.';
