-- FOU-564 P4: production worker boundaries, two-scan orphan proof,
-- redacted manifests, aged-backup verification, and DR reapplication.

create function private.normalize_retired_community_operator(target_value text)
returns text language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select lower(btrim(coalesce(target_value, '')));
$$;

create function private.normalize_retired_community_batch_requester()
returns trigger language plpgsql
set search_path = pg_catalog, private, pg_temp as $$
begin
  new.requested_by := private.normalize_retired_community_operator(new.requested_by);
  return new;
end;
$$;

create trigger a_normalize_retired_community_batch_requester
  before insert on private.retired_community_deletion_batches
  for each row execute function private.normalize_retired_community_batch_requester();

create function private.normalize_retired_community_backup_verifier()
returns trigger language plpgsql
set search_path = pg_catalog, private, pg_temp as $$
begin
  new.verified_by := private.normalize_retired_community_operator(new.verified_by);
  return new;
end;
$$;

create trigger a_normalize_retired_community_backup_verifier
  before insert on private.retired_community_backup_proofs
  for each row execute function private.normalize_retired_community_backup_verifier();

create function private.normalize_retired_community_approver()
returns trigger language plpgsql
set search_path = pg_catalog, private, pg_temp as $$
begin
  new.approved_by := private.normalize_retired_community_operator(new.approved_by);
  return new;
end;
$$;

create trigger a_normalize_retired_community_approver
  before insert on private.retired_community_batch_approvals
  for each row execute function private.normalize_retired_community_approver();

create function private.normalize_retired_community_ledger_actor()
returns trigger language plpgsql
set search_path = pg_catalog, private, pg_temp as $$
begin
  new.actor := private.normalize_retired_community_operator(new.actor);
  return new;
end;
$$;

create trigger a_normalize_retired_community_ledger_actor
  before insert on private.retired_community_deletion_ledger
  for each row execute function private.normalize_retired_community_ledger_actor();

alter table private.retired_community_storage_work
  drop constraint if exists retired_community_storage_work_bucket_id_check;
alter table private.retired_community_storage_work
  add constraint retired_community_storage_work_bucket_id_check check (
    bucket_id in ('community-post-images', 'profile-photos', 'journal-progress')
  );
alter table private.retired_community_storage_work
  add column attempt_count integer not null default 0 check (attempt_count >= 0),
  add column last_failed_at timestamptz,
  add column last_error_code text check (
    last_error_code is null or last_error_code in ('storage_retry_exhausted')
  );
alter table private.retired_community_credential_work
  add column attempt_count integer not null default 0 check (attempt_count >= 0),
  add column last_failed_at timestamptz,
  add column last_error_code text check (
    last_error_code is null or last_error_code in ('credential_retry_exhausted')
  );

create function private.record_retired_community_work_attempt()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  if new.status = 'claimed' and (
    old.status is distinct from 'claimed'
    or new.claim_token is distinct from old.claim_token
  ) then
    new.attempt_count := old.attempt_count + 1;
  elsif new.status = 'confirmed' then
    new.last_error_code := null;
  end if;
  return new;
end;
$$;

create trigger record_retired_community_storage_attempt
  before update on private.retired_community_storage_work
  for each row execute function private.record_retired_community_work_attempt();
create trigger record_retired_community_credential_attempt
  before update on private.retired_community_credential_work
  for each row execute function private.record_retired_community_work_attempt();

create function private.normalize_retired_community_created_ledger_counts()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
declare batch_row private.retired_community_deletion_batches%rowtype;
begin
  if new.event_type = 'created' then
    select * into strict batch_row
    from private.retired_community_deletion_batches where id = new.batch_id;
    new.details := jsonb_build_object(
      'reason', batch_row.reason,
      'posts', batch_row.post_count,
      'comments', batch_row.comment_count,
      'likes', batch_row.like_count,
      'objects', batch_row.object_count,
      'credentials', batch_row.credential_count
    );
  end if;
  return new;
end;
$$;

create trigger b_normalize_retired_community_created_ledger_counts
  before insert on private.retired_community_deletion_ledger
  for each row execute function private.normalize_retired_community_created_ledger_counts();

create or replace function private.guard_retired_community_item_mutation()
returns trigger language plpgsql
set search_path = pg_catalog, private, pg_temp as $$
begin
  if tg_op = 'DELETE' and exists (
    select 1 from private.retired_community_purge_manifests manifest
    where manifest.batch_id = old.batch_id
      and manifest.expires_at <= clock_timestamp()
  ) then
    return old;
  end if;
  if tg_op <> 'INSERT' then
    raise exception 'Retired Community deletion items are immutable.' using errcode = '55000';
  end if;
  if (select sealed from private.retired_community_deletion_batches where id = new.batch_id) then
    raise exception 'A sealed deletion batch cannot accept items.' using errcode = '55000';
  end if;
  return new;
end;
$$;

insert into private.retired_community_deletion_ledger
  (batch_id, event_type, actor, event_at, details)
select batch_row.id, 'cancelled', 'p4-account-storage-protocol-migration', clock_timestamp(),
  jsonb_build_object('reason', 'legacy_account_batch_missing_full_asset_inventory')
from private.retired_community_deletion_batches batch_row
where batch_row.reason = 'account_erasure'
  and not exists (
    select 1 from private.retired_community_deletion_ledger terminal
    where terminal.batch_id = batch_row.id
      and terminal.event_type in ('cancelled', 'executed')
  );

create function private.retired_community_item_was_executed(
  target_batch_id uuid,
  target_item_kind text,
  target_item_key text,
  target_row_sha256 text
)
returns boolean language sql stable security definer
set search_path = pg_catalog, private, pg_temp as $$
  select exists (
      select 1
      from private.retired_community_deletion_items prior_item
      join private.retired_community_deletion_ledger prior_execution
        on prior_execution.batch_id = prior_item.batch_id
          and prior_execution.event_type = 'executed'
      where prior_item.batch_id <> target_batch_id
        and prior_item.item_kind = target_item_kind
        and prior_item.item_key = target_item_key
        and prior_item.row_sha256 = target_row_sha256
    ) or exists (
      select 1
      from private.retired_community_deletion_batches target_batch
      join private.retired_community_deletion_batches prior_batch
        on prior_batch.id <> target_batch.id
        and prior_batch.reason = 'aged_retention'
        and prior_batch.sealed
        and prior_batch.t0_source_sha256 = target_batch.t0_source_sha256
        and prior_batch.post_count = (
          select count(*) from private.retired_community_t0_post_inventory
        )
        and prior_batch.comment_count = (
          select count(*) from private.retired_community_t0_comment_inventory
        )
        and prior_batch.like_count = (
          select count(*) from private.retired_community_t0_like_inventory
        )
        and prior_batch.object_count = (
          select count(*) from private.retired_community_t0_object_inventory inventory
          where cardinality(inventory.referenced_post_ids) > 0
        )
        and prior_batch.credential_count = 0
      join private.retired_community_deletion_ledger prior_execution
        on prior_execution.batch_id = prior_batch.id
          and prior_execution.event_type = 'executed'
      where target_batch.id = target_batch_id
        and case target_item_kind
          when 'post' then exists (
            select 1 from private.retired_community_t0_post_inventory inventory
            where inventory.post_id = target_item_key::uuid
              and inventory.row_sha256 = target_row_sha256
          )
          when 'comment' then exists (
            select 1 from private.retired_community_t0_comment_inventory inventory
            where inventory.comment_id = target_item_key::uuid
              and inventory.row_sha256 = target_row_sha256
          )
          when 'like' then exists (
            select 1 from private.retired_community_t0_like_inventory inventory
            where inventory.post_id = split_part(target_item_key, ':', 1)::uuid
              and inventory.user_id = split_part(target_item_key, ':', 2)::uuid
              and inventory.row_sha256 = target_row_sha256
          )
          else false
        end
    );
$$;

create function private.retired_community_object_was_executed(
  target_batch_id uuid,
  target_bucket_id text,
  target_object_name text,
  target_row_sha256 text
)
returns boolean language sql stable security definer
set search_path = pg_catalog, private, pg_temp as $$
  select exists (
    select 1
    from private.retired_community_storage_work prior_work
    join private.retired_community_deletion_ledger prior_execution
      on prior_execution.batch_id = prior_work.batch_id
        and prior_execution.event_type = 'executed'
    where prior_work.batch_id <> target_batch_id
      and prior_work.bucket_id = target_bucket_id
      and prior_work.object_name = target_object_name
      and prior_work.expected_row_sha256 = target_row_sha256
      and prior_work.status = 'confirmed'
  ) or exists (
    select 1
    from private.retired_community_deletion_batches target_batch
    join private.retired_community_deletion_batches prior_batch
      on prior_batch.id <> target_batch.id
      and prior_batch.reason = 'aged_retention'
      and prior_batch.sealed
      and prior_batch.t0_source_sha256 = target_batch.t0_source_sha256
      and prior_batch.post_count = (
        select count(*) from private.retired_community_t0_post_inventory
      )
      and prior_batch.comment_count = (
        select count(*) from private.retired_community_t0_comment_inventory
      )
      and prior_batch.like_count = (
        select count(*) from private.retired_community_t0_like_inventory
      )
      and prior_batch.object_count = (
        select count(*) from private.retired_community_t0_object_inventory inventory
        where cardinality(inventory.referenced_post_ids) > 0
      )
      and prior_batch.credential_count = 0
    join private.retired_community_deletion_ledger prior_execution
      on prior_execution.batch_id = prior_batch.id
        and prior_execution.event_type = 'executed'
    join private.retired_community_t0_object_inventory inventory
      on inventory.bucket_id = target_bucket_id
        and inventory.object_name = target_object_name
        and inventory.row_sha256 = target_row_sha256
        and cardinality(inventory.referenced_post_ids) > 0
    where target_batch.id = target_batch_id
  );
$$;

create function private.assert_retired_community_batch_evidence_complete(
  target_batch_id uuid
)
returns void language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
declare batch_row private.retired_community_deletion_batches%rowtype;
declare posts bigint;
declare comments bigint;
declare likes bigint;
declare objects bigint;
declare credentials bigint;
declare source_digest text;
begin
  select * into strict batch_row
  from private.retired_community_deletion_batches
  where id = target_batch_id and sealed;
  select count(*) filter (where item_kind = 'post'),
    count(*) filter (where item_kind = 'comment'),
    count(*) filter (where item_kind = 'like')
  into posts, comments, likes
  from private.retired_community_deletion_items where batch_id = batch_row.id;
  select count(*) into objects
  from private.retired_community_storage_work where batch_id = batch_row.id;
  select count(*) into credentials
  from private.retired_community_credential_work where batch_id = batch_row.id;
  with sources as (
    select 'item' kind, item_kind || ':' || item_key source_key, row_sha256
    from private.retired_community_deletion_items where batch_id = batch_row.id
    union all
    select 'object', bucket_id || ':' || object_name, expected_row_sha256
    from private.retired_community_storage_work where batch_id = batch_row.id
    union all
    select 'credential', destination_id::text, expected_row_sha256
    from private.retired_community_credential_work where batch_id = batch_row.id
  )
  select private.retired_community_sha256(coalesce(
    jsonb_agg(jsonb_build_array(kind, source_key, row_sha256)
      order by kind, source_key)::text,
    '[]'
  )) into source_digest
  from sources;
  if (posts, comments, likes, objects, credentials, source_digest) is distinct from (
    batch_row.post_count, batch_row.comment_count, batch_row.like_count,
    batch_row.object_count, batch_row.credential_count, batch_row.source_sha256
  ) then
    raise exception 'The sealed deletion batch no longer has complete exact evidence.'
      using errcode = '55000';
  end if;
end;
$$;

create function private.assert_retired_community_cascade_scope(target_batch_id uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, public, private, storage, pg_temp as $$
declare batch_row private.retired_community_deletion_batches%rowtype;
begin
  select * into strict batch_row
  from private.retired_community_deletion_batches
  where id = target_batch_id;

  if exists (
    select 1
    from private.retired_community_backup_proofs proof
    left join private.retired_community_batch_approvals approval
      on approval.batch_id = proof.batch_id
    where proof.batch_id = batch_row.id
      and (
        private.normalize_retired_community_operator(proof.verified_by)
          = private.normalize_retired_community_operator(batch_row.requested_by)
        or (approval.batch_id is not null and (
          private.normalize_retired_community_operator(approval.approved_by)
            = private.normalize_retired_community_operator(batch_row.requested_by)
          or private.normalize_retired_community_operator(approval.approved_by)
            = private.normalize_retired_community_operator(proof.verified_by)
        ))
      )
  ) then
    raise exception 'Deletion batch requester, backup verifier, and approver must be independent.'
      using errcode = '42501';
  end if;

  if batch_row.reason <> 'account_erasure' and exists (
    select 1 from private.retired_community_storage_work work
    where work.batch_id = batch_row.id
      and work.bucket_id <> 'community-post-images'
  ) then
    raise exception 'Only account erasure may contain personal asset Storage work.'
      using errcode = '55000';
  end if;

  if batch_row.reason = 'orphan_cleanup' and exists (
    select 1
    from private.retired_community_storage_work work
    join public.community_posts post_row on post_row.image_path = work.object_name
    where work.batch_id = batch_row.id
      and work.bucket_id = 'community-post-images'
  ) then
    raise exception 'Orphan deletion object acquired a current post reference.'
      using errcode = '55000';
  end if;

  if batch_row.reason not in ('account_erasure', 'group_deletion') then
    return;
  end if;

  if batch_row.reason = 'account_erasure' then
    if exists (
      select 1
      from private.retired_community_t0_post_inventory inventory
      left join public.community_posts post_row on post_row.id = inventory.post_id
      where inventory.author_id = batch_row.subject_user_id
        and (
          (post_row.id is null and not private.retired_community_item_was_executed(
            batch_row.id, 'post', inventory.post_id::text, inventory.row_sha256))
          or (post_row.id is not null
            and private.retired_community_sha256(to_jsonb(post_row)::text) <> inventory.row_sha256)
        )
    ) or exists (
      select 1
      from private.retired_community_t0_comment_inventory inventory
      left join public.post_comments comment_row on comment_row.id = inventory.comment_id
      where (inventory.author_id = batch_row.subject_user_id
          or exists (
            select 1 from private.retired_community_t0_post_inventory post_inventory
            where post_inventory.post_id = inventory.post_id
              and post_inventory.author_id = batch_row.subject_user_id
          ))
        and (
          (comment_row.id is null and not private.retired_community_item_was_executed(
            batch_row.id, 'comment', inventory.comment_id::text, inventory.row_sha256))
          or (comment_row.id is not null
            and private.retired_community_sha256(to_jsonb(comment_row)::text) <> inventory.row_sha256)
        )
    ) or exists (
      select 1
      from private.retired_community_t0_like_inventory inventory
      left join public.post_likes like_row
        on like_row.post_id = inventory.post_id and like_row.user_id = inventory.user_id
      where (inventory.user_id = batch_row.subject_user_id
          or exists (
            select 1 from private.retired_community_t0_post_inventory post_inventory
            where post_inventory.post_id = inventory.post_id
              and post_inventory.author_id = batch_row.subject_user_id
          ))
        and (
          (like_row.post_id is null and not private.retired_community_item_was_executed(
            batch_row.id, 'like', inventory.post_id::text || ':' || inventory.user_id::text,
            inventory.row_sha256))
          or (like_row.post_id is not null
            and private.retired_community_sha256(to_jsonb(like_row)::text) <> inventory.row_sha256)
        )
    ) then
      raise exception 'Account erasure source rows drifted from T0 without a prior executed deletion.'
        using errcode = '55000';
    end if;

    if exists (
      select 1 from public.community_posts post_row
      where post_row.author_id = batch_row.subject_user_id
        and not exists (
          select 1 from private.retired_community_deletion_items item
          where item.batch_id = batch_row.id and item.item_kind = 'post'
            and item.item_key = post_row.id::text
            and item.row_sha256 = private.retired_community_sha256(to_jsonb(post_row)::text)
        )
    ) or exists (
      select 1 from public.post_comments comment_row
      where (comment_row.user_id = batch_row.subject_user_id
          or exists (
            select 1 from public.community_posts post_row
            where post_row.id = comment_row.post_id
              and post_row.author_id = batch_row.subject_user_id
          ))
        and not exists (
          select 1 from private.retired_community_deletion_items item
          where item.batch_id = batch_row.id and item.item_kind = 'comment'
            and item.item_key = comment_row.id::text
            and item.row_sha256 = private.retired_community_sha256(to_jsonb(comment_row)::text)
        )
    ) or exists (
      select 1 from public.post_likes like_row
      where (like_row.user_id = batch_row.subject_user_id
          or exists (
            select 1 from public.community_posts post_row
            where post_row.id = like_row.post_id
              and post_row.author_id = batch_row.subject_user_id
          ))
        and not exists (
          select 1 from private.retired_community_deletion_items item
          where item.batch_id = batch_row.id and item.item_kind = 'like'
            and item.item_key = like_row.post_id::text || ':' || like_row.user_id::text
            and item.row_sha256 = private.retired_community_sha256(to_jsonb(like_row)::text)
        )
    ) then
      raise exception 'Account erasure would cascade beyond its sealed relational manifest.'
        using errcode = '55000';
    end if;
  else
    if exists (
      select 1
      from private.retired_community_t0_post_inventory inventory
      left join public.community_posts post_row on post_row.id = inventory.post_id
      where inventory.crew_id = batch_row.crew_id
        and (
          (post_row.id is null and not private.retired_community_item_was_executed(
            batch_row.id, 'post', inventory.post_id::text, inventory.row_sha256))
          or (post_row.id is not null
            and private.retired_community_sha256(to_jsonb(post_row)::text) <> inventory.row_sha256)
        )
    ) or exists (
      select 1
      from private.retired_community_t0_comment_inventory inventory
      left join public.post_comments comment_row on comment_row.id = inventory.comment_id
      where exists (
          select 1 from private.retired_community_t0_post_inventory post_inventory
          where post_inventory.post_id = inventory.post_id
            and post_inventory.crew_id = batch_row.crew_id
        )
        and (
          (comment_row.id is null and not private.retired_community_item_was_executed(
            batch_row.id, 'comment', inventory.comment_id::text, inventory.row_sha256))
          or (comment_row.id is not null
            and private.retired_community_sha256(to_jsonb(comment_row)::text) <> inventory.row_sha256)
        )
    ) or exists (
      select 1
      from private.retired_community_t0_like_inventory inventory
      left join public.post_likes like_row
        on like_row.post_id = inventory.post_id and like_row.user_id = inventory.user_id
      where exists (
          select 1 from private.retired_community_t0_post_inventory post_inventory
          where post_inventory.post_id = inventory.post_id
            and post_inventory.crew_id = batch_row.crew_id
        )
        and (
          (like_row.post_id is null and not private.retired_community_item_was_executed(
            batch_row.id, 'like', inventory.post_id::text || ':' || inventory.user_id::text,
            inventory.row_sha256))
          or (like_row.post_id is not null
            and private.retired_community_sha256(to_jsonb(like_row)::text) <> inventory.row_sha256)
        )
    ) then
      raise exception 'Group deletion source rows drifted from T0 without a prior executed deletion.'
        using errcode = '55000';
    end if;

    if exists (
      select 1 from public.community_posts post_row
      where post_row.crew_id = batch_row.crew_id
        and not exists (
          select 1 from private.retired_community_deletion_items item
          where item.batch_id = batch_row.id and item.item_kind = 'post'
            and item.item_key = post_row.id::text
            and item.row_sha256 = private.retired_community_sha256(to_jsonb(post_row)::text)
        )
    ) or exists (
      select 1 from public.post_comments comment_row
      join public.community_posts post_row on post_row.id = comment_row.post_id
      where post_row.crew_id = batch_row.crew_id
        and not exists (
          select 1 from private.retired_community_deletion_items item
          where item.batch_id = batch_row.id and item.item_kind = 'comment'
            and item.item_key = comment_row.id::text
            and item.row_sha256 = private.retired_community_sha256(to_jsonb(comment_row)::text)
        )
    ) or exists (
      select 1 from public.post_likes like_row
      join public.community_posts post_row on post_row.id = like_row.post_id
      where post_row.crew_id = batch_row.crew_id
        and not exists (
          select 1 from private.retired_community_deletion_items item
          where item.batch_id = batch_row.id and item.item_kind = 'like'
            and item.item_key = like_row.post_id::text || ':' || like_row.user_id::text
            and item.row_sha256 = private.retired_community_sha256(to_jsonb(like_row)::text)
        )
    ) then
      raise exception 'Group deletion would cascade beyond its sealed relational manifest.'
        using errcode = '55000';
    end if;
  end if;

  if exists (
    with selected_posts as (
      select post_row.id, post_row.image_path
      from private.retired_community_deletion_items item
      join public.community_posts post_row
        on item.item_kind = 'post' and item.item_key = post_row.id::text
      where item.batch_id = batch_row.id
    ), exclusive_paths as (
      select distinct selected.image_path
      from selected_posts selected
      where selected.image_path is not null
        and not exists (
          select 1 from public.community_posts other_post
          where other_post.image_path = selected.image_path
            and not exists (select 1 from selected_posts covered where covered.id = other_post.id)
        )
    )
    select 1
    from exclusive_paths path
    join storage.objects object_row
      on object_row.bucket_id = 'community-post-images' and object_row.name = path.image_path
    where not exists (
      select 1 from private.retired_community_storage_work work
      where work.batch_id = batch_row.id
        and work.bucket_id = object_row.bucket_id and work.object_name = object_row.name
        and work.expected_row_sha256 = private.retired_community_sha256(to_jsonb(object_row)::text)
    )
  ) or exists (
    with selected_posts as (
      select post_row.id, post_row.image_path
      from private.retired_community_deletion_items item
      join public.community_posts post_row
        on item.item_kind = 'post' and item.item_key = post_row.id::text
      where item.batch_id = batch_row.id
    )
    select 1
    from private.retired_community_storage_work work
    left join storage.objects object_row
      on object_row.bucket_id = work.bucket_id and object_row.name = work.object_name
    where work.batch_id = batch_row.id and work.bucket_id = 'community-post-images'
      and (
        (object_row.id is null and work.status <> 'confirmed'
          and not private.retired_community_object_was_executed(
            batch_row.id, work.bucket_id, work.object_name, work.expected_row_sha256))
        or (object_row.id is not null and (
          private.retired_community_sha256(to_jsonb(object_row)::text) <> work.expected_row_sha256
          or (
            not exists (
              select 1 from selected_posts selected
              where selected.image_path = work.object_name
            )
            and not (
              batch_row.reason = 'account_erasure'
              and (
                object_row.owner = batch_row.subject_user_id
                or (storage.foldername(object_row.name))[2]
                  = batch_row.subject_user_id::text
              )
              and not exists (
                select 1 from public.community_posts referenced_post
                where referenced_post.image_path = object_row.name
              )
            )
          )
          or exists (
            select 1 from public.community_posts other_post
            where other_post.image_path = work.object_name
              and not exists (select 1 from selected_posts covered where covered.id = other_post.id)
          )
        ))
      )
  ) then
    raise exception 'Account or group deletion object work does not exactly cover its cascade.'
      using errcode = '55000';
  end if;

  if batch_row.reason = 'account_erasure' and (
    exists (
      select 1 from storage.objects object_row
      where (
        (
          object_row.bucket_id in ('profile-photos', 'journal-progress')
          and (
            object_row.owner = batch_row.subject_user_id
            or (storage.foldername(object_row.name))[1] = batch_row.subject_user_id::text
          )
        ) or (
          object_row.bucket_id = 'community-post-images'
          and (
            object_row.owner = batch_row.subject_user_id
            or (storage.foldername(object_row.name))[2] = batch_row.subject_user_id::text
          )
          and not exists (
            select 1 from public.community_posts referenced_post
            where referenced_post.image_path = object_row.name
          )
        )
      )
        and not exists (
          select 1 from private.retired_community_storage_work work
          where work.batch_id = batch_row.id
            and work.object_id = object_row.id
            and work.bucket_id = object_row.bucket_id
            and work.object_name = object_row.name
            and work.expected_row_sha256 =
              private.retired_community_sha256(to_jsonb(object_row)::text)
        )
    ) or exists (
      select 1
      from private.retired_community_storage_work work
      left join storage.objects object_row
        on object_row.id = work.object_id
          and object_row.bucket_id = work.bucket_id
          and object_row.name = work.object_name
      where work.batch_id = batch_row.id
        and work.bucket_id in ('profile-photos', 'journal-progress')
        and (
          (object_row.id is null and work.status <> 'confirmed'
            and not private.retired_community_object_was_executed(
              batch_row.id, work.bucket_id, work.object_name, work.expected_row_sha256))
          or (object_row.id is not null and (
            private.retired_community_sha256(to_jsonb(object_row)::text)
              <> work.expected_row_sha256
            or not (
              object_row.owner = batch_row.subject_user_id
              or (storage.foldername(object_row.name))[1] = batch_row.subject_user_id::text
            )
          ))
        )
    )
  ) then
    raise exception 'Account erasure personal asset work does not exactly cover the subject.'
      using errcode = '55000';
  end if;

  if batch_row.reason = 'group_deletion' and (
    exists (
      select 1 from private.integration_destinations destination
      where destination.crew_id = batch_row.crew_id
        and not exists (
          select 1 from private.retired_community_credential_work work
          where work.batch_id = batch_row.id and work.destination_id = destination.id
            and (
              (work.status = 'confirmed' and destination.status = 'revoked'
                and destination.credential_ciphertext is null
                and destination.credential_nonce is null
                and destination.credential_key_version is null)
              or (work.status <> 'confirmed'
                and work.expected_row_sha256 = private.retired_community_credential_sha256(destination))
            )
        )
    ) or exists (
      select 1 from private.retired_community_credential_work work
      left join private.integration_destinations destination on destination.id = work.destination_id
      where work.batch_id = batch_row.id
        and (destination.id is null and work.status <> 'confirmed'
          or destination.id is not null and destination.crew_id <> batch_row.crew_id)
    )
  ) then
    raise exception 'Group deletion credential work does not exactly cover its cascade.'
      using errcode = '55000';
  end if;
end;
$$;

create function private.lock_retired_community_mutation_scope_when_creating()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, storage, pg_temp as $$
begin
  if new.reason in ('aged_retention', 'account_erasure', 'group_deletion', 'orphan_cleanup') then
    lock table public.community_posts in share mode;
  end if;
  if new.reason in ('aged_retention', 'account_erasure', 'group_deletion') then
    lock table public.post_comments in share mode;
    lock table public.post_likes in share mode;
  end if;
  if new.reason = 'account_erasure' then
    lock table storage.objects in share mode;
    lock table private.outbound_deliveries in share mode;
  elsif new.reason = 'group_deletion' then
    lock table storage.objects in share mode;
    lock table private.integration_destinations in share mode;
  elsif new.reason in ('aged_retention', 'orphan_cleanup') then
    lock table storage.objects in share mode;
  end if;
  return new;
end;
$$;

create trigger a_lock_retired_community_mutation_scope_when_creating
  before insert on private.retired_community_deletion_batches
  for each row execute function private.lock_retired_community_mutation_scope_when_creating();

create function private.add_retired_community_account_assets_when_sealing()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, private, storage, pg_temp as $$
begin
  if new.sealed and not old.sealed and new.reason = 'account_erasure'
     and new.requested_by <> 'dr-ledger-reapply' then
    lock table storage.objects in share mode;
    insert into private.retired_community_storage_work (
      batch_id, object_id, bucket_id, object_name, expected_row_sha256
    )
    select new.id, object_row.id, object_row.bucket_id, object_row.name,
      private.retired_community_sha256(to_jsonb(object_row)::text)
    from storage.objects object_row
    where (
        object_row.bucket_id in ('profile-photos', 'journal-progress')
        and (
          object_row.owner = new.subject_user_id
          or (storage.foldername(object_row.name))[1] = new.subject_user_id::text
        )
      ) or (
        object_row.bucket_id = 'community-post-images'
        and (
          object_row.owner = new.subject_user_id
          or (storage.foldername(object_row.name))[2] = new.subject_user_id::text
        )
        and not exists (
          select 1 from public.community_posts referenced_post
          where referenced_post.image_path = object_row.name
        )
      )
    on conflict (batch_id, bucket_id, object_name) do nothing;

    select count(*) into new.object_count
    from private.retired_community_storage_work work where work.batch_id = new.id;

    with sources as (
      select 'item' kind, item_kind || ':' || item_key source_key, row_sha256
      from private.retired_community_deletion_items where batch_id = new.id
      union all
      select 'object', bucket_id || ':' || object_name, expected_row_sha256
      from private.retired_community_storage_work where batch_id = new.id
      union all
      select 'credential', destination_id::text, expected_row_sha256
      from private.retired_community_credential_work where batch_id = new.id
    )
    select private.retired_community_sha256(coalesce(
      jsonb_agg(jsonb_build_array(kind, source_key, row_sha256)
        order by kind, source_key)::text,
      '[]'
    )) into new.source_sha256
    from sources;
  end if;
  return new;
end;
$$;

create trigger c_add_retired_community_account_assets_when_sealing
  before update of sealed on private.retired_community_deletion_batches
  for each row execute function private.add_retired_community_account_assets_when_sealing();

create function private.confirm_retired_community_credentialless_when_sealing()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
begin
  if new.sealed and not old.sealed and new.reason = 'group_deletion'
     and new.requested_by <> 'dr-ledger-reapply' then
    update private.integration_destinations destination set
      status = 'revoked', disconnected_at = coalesce(destination.disconnected_at, clock_timestamp()),
      last_error_code = null, last_error_summary = null
    from private.retired_community_credential_work work
    where work.batch_id = new.id
      and work.destination_id = destination.id
      and work.expected_row_sha256 = private.retired_community_credential_sha256(destination)
      and destination.credential_ciphertext is null
      and destination.credential_nonce is null
      and destination.credential_key_version is null;

    update private.retired_community_credential_work work set
      status = 'confirmed', confirmed_at = clock_timestamp(),
      provider_revocation_reference = 'already-credentialless'
    from private.integration_destinations destination
    where work.batch_id = new.id
      and work.destination_id = destination.id
      and destination.status = 'revoked'
      and destination.credential_ciphertext is null
      and destination.credential_nonce is null
      and destination.credential_key_version is null;
  end if;
  return new;
end;
$$;

create trigger b_confirm_retired_community_credentialless_when_sealing
  before update of sealed on private.retired_community_deletion_batches
  for each row execute function private.confirm_retired_community_credentialless_when_sealing();

create function private.cancel_retired_community_account_deliveries_when_sealing()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
begin
  if new.sealed and not old.sealed and new.reason = 'account_erasure' then
    update private.outbound_deliveries set
      status = 'cancelled', cancelled_at = clock_timestamp(),
      last_error_code = 'account_erasure',
      last_error_summary = 'Delivery cancelled because its subject requested account erasure.',
      lock_token = null, locked_at = null
    where subject_user_id = new.subject_user_id
      and status in ('queued', 'processing', 'retry');
  end if;
  return new;
end;
$$;

create trigger d_cancel_retired_community_account_deliveries_when_sealing
  before update of sealed on private.retired_community_deletion_batches
  for each row execute function private.cancel_retired_community_account_deliveries_when_sealing();

create or replace function private.preview_retired_community_deletion(
  target_reason text,
  target_subject_user_id uuid,
  target_crew_id uuid
)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public, private, storage, pg_temp as $$
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
        or (target_reason = 'group_deletion'
          and comment_item.post_id in (select post_id from selected_posts))))
  ), selected_likes as (
    select like_item.post_id, like_item.user_id
    from private.retired_community_t0_like_inventory like_item
    left join public.post_likes like_row
      on like_row.post_id = like_item.post_id and like_row.user_id = like_item.user_id
    where target_reason = 'aged_retention'
      or (private.retired_community_sha256(to_jsonb(like_row)::text) = like_item.row_sha256 and (
        (target_reason = 'account_erasure' and
        (like_item.user_id = target_subject_user_id
          or like_item.post_id in (select post_id from selected_posts)))
        or (target_reason = 'group_deletion'
          and like_item.post_id in (select post_id from selected_posts))))
  ), selected_objects as (
    select object_item.bucket_id, object_item.object_name
    from private.retired_community_t0_object_inventory object_item, post_ids
    where (target_reason = 'aged_retention' and cardinality(object_item.referenced_post_ids) > 0)
      or (target_reason = 'orphan_cleanup' and cardinality(object_item.referenced_post_ids) = 0)
      or (target_reason in ('account_erasure', 'group_deletion')
        and cardinality(object_item.referenced_post_ids) > 0
        and object_item.referenced_post_ids <@ post_ids.ids)
    union
    select object_row.bucket_id, object_row.name
    from storage.objects object_row
    where target_reason = 'account_erasure'
      and (
        (
          object_row.bucket_id in ('profile-photos', 'journal-progress')
          and (
            object_row.owner = target_subject_user_id
            or (storage.foldername(object_row.name))[1] = target_subject_user_id::text
          )
        ) or (
          object_row.bucket_id = 'community-post-images'
          and (
            object_row.owner = target_subject_user_id
            or (storage.foldername(object_row.name))[2] = target_subject_user_id::text
          )
          and not exists (
            select 1 from public.community_posts referenced_post
            where referenced_post.image_path = object_row.name
          )
        )
      )
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
        then (select count(*) from private.integration_destinations
          where crew_id = target_crew_id) else 0 end
    )
  );
$$;

create function private.assert_retired_community_scope_when_sealed()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
begin
  if new.sealed and not old.sealed and new.reason in ('account_erasure', 'group_deletion') then
    perform private.assert_retired_community_cascade_scope(new.id);
  end if;
  return new;
end;
$$;

create trigger assert_retired_community_scope_when_sealed
  after update of sealed on private.retired_community_deletion_batches
  for each row execute function private.assert_retired_community_scope_when_sealed();

create or replace function public.record_retired_community_backup_proof(
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
declare normalized_verifier text := private.normalize_retired_community_operator(target_verified_by);
begin
  perform pg_advisory_xact_lock(hashtextextended('retired-community-deletion', 0));
  select * into strict batch_row from private.retired_community_deletion_batches
    where id = target_batch_id and sealed for update;
  if private.retired_community_batch_status(batch_row.id) in ('cancelled', 'executed') then
    raise exception 'A terminal deletion batch cannot accept backup proof.' using errcode = '55000';
  end if;
  if normalized_verifier = private.normalize_retired_community_operator(batch_row.requested_by) then
    raise exception 'The backup verifier must be independent from the requester.' using errcode = '42501';
  end if;
  if target_source_sha256 is distinct from batch_row.source_sha256 then
    raise exception 'Backup source digest does not match the sealed batch.' using errcode = '22023';
  end if;
  insert into private.retired_community_backup_proofs (
    batch_id, backup_name, backup_version, source_sha256, bundle_sha256,
    bundle_bytes, verified_by, verified_at
  ) values (
    batch_row.id, target_backup_name, target_backup_version, target_source_sha256,
    target_bundle_sha256, target_bundle_bytes, normalized_verifier, clock_timestamp()
  );
  insert into private.retired_community_deletion_ledger
    (batch_id, event_type, actor, event_at, details)
  values (batch_row.id, 'backup_verified', normalized_verifier, clock_timestamp(),
    jsonb_build_object('backupName', target_backup_name, 'backupVersion', target_backup_version,
      'sourceSha256', target_source_sha256, 'bundleSha256', target_bundle_sha256,
      'bundleBytes', target_bundle_bytes));
  return private.retired_community_batch_result(batch_row.id);
end;
$$;

create or replace function public.approve_retired_community_deletion_batch(
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
declare normalized_approver text := private.normalize_retired_community_operator(target_approved_by);
begin
  perform pg_advisory_xact_lock(hashtextextended('retired-community-deletion', 0));
  select * into strict batch_row from private.retired_community_deletion_batches
    where id = target_batch_id and sealed for update;
  if private.retired_community_batch_status(batch_row.id) in ('cancelled', 'executed') then
    raise exception 'A terminal deletion batch cannot be approved.' using errcode = '55000';
  end if;
  select * into strict proof_row from private.retired_community_backup_proofs
    where batch_id = batch_row.id;
  if private.normalize_retired_community_operator(proof_row.verified_by)
      = private.normalize_retired_community_operator(batch_row.requested_by) then
    raise exception 'The backup verifier must be independent from the requester.'
      using errcode = '42501';
  end if;
  if normalized_approver = private.normalize_retired_community_operator(batch_row.requested_by)
     or normalized_approver = private.normalize_retired_community_operator(proof_row.verified_by) then
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
    batch_row.id, normalized_approver, clock_timestamp(), target_source_sha256,
    target_bundle_sha256, target_post_count, target_comment_count,
    target_like_count, target_object_count, target_credential_count
  );
  insert into private.retired_community_deletion_ledger
    (batch_id, event_type, actor, event_at, details)
  values (batch_row.id, 'approved', normalized_approver, clock_timestamp(),
    jsonb_build_object('sourceSha256', target_source_sha256,
      'bundleSha256', target_bundle_sha256, 'posts', target_post_count,
      'comments', target_comment_count, 'likes', target_like_count,
      'objects', target_object_count, 'credentials', target_credential_count));
  return private.retired_community_batch_result(batch_row.id);
end;
$$;

create or replace function public.cancel_retired_community_group_deletion(target_batch_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private, auth, pg_temp as $$
declare requester_id uuid := auth.uid();
declare batch_row private.retired_community_deletion_batches%rowtype;
begin
  if requester_id is null then
    raise exception 'Not authenticated.' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('retired-community-deletion', 0));
  select * into strict batch_row from private.retired_community_deletion_batches
    where id = target_batch_id and reason = 'group_deletion' for update;
  if not public.can_manage_crew(batch_row.crew_id) then
    raise exception 'Only a group owner or admin can cancel group deletion.' using errcode = '42501';
  end if;
  if private.retired_community_batch_status(batch_row.id) = 'executed' then
    raise exception 'An executed group deletion cannot be cancelled.' using errcode = '55000';
  end if;
  if clock_timestamp() >= batch_row.execute_after then
    raise exception 'The 30-day group cancellation window has closed.' using errcode = '55000';
  end if;
  if private.retired_community_batch_status(batch_row.id) <> 'cancelled' then
    insert into private.retired_community_deletion_ledger
      (batch_id, event_type, actor, event_at, details)
    values (batch_row.id, 'cancelled', requester_id::text, clock_timestamp(), '{}'::jsonb);
  end if;
  return private.retired_community_batch_result(batch_row.id);
end;
$$;

create table private.retired_community_orphan_scans (
  id uuid primary key,
  scanned_at timestamptz not null,
  recorded_at timestamptz not null,
  recorded_by text not null check (char_length(recorded_by) between 3 and 160),
  object_count bigint not null check (object_count >= 0),
  inventory_sha256 text not null check (inventory_sha256 ~ '^[0-9a-f]{64}$'),
  replacement_number integer not null default 0 check (replacement_number >= 0)
);

create table private.retired_community_orphan_scan_items (
  scan_id uuid not null references private.retired_community_orphan_scans(id) on delete cascade,
  object_id uuid not null,
  bucket_id text not null check (bucket_id = 'community-post-images'),
  object_name text not null,
  expected_row_sha256 text not null check (expected_row_sha256 ~ '^[0-9a-f]{64}$'),
  referenced_post_count bigint not null check (referenced_post_count >= 0),
  primary key (scan_id, bucket_id, object_name),
  unique (scan_id, object_id)
);

create table private.retired_community_orphan_scan_audit (
  id bigint generated always as identity primary key,
  scan_id uuid not null references private.retired_community_orphan_scans(id) on delete restrict,
  event_type text not null check (event_type in ('recorded', 'replaced')),
  actor text not null check (char_length(actor) between 3 and 160),
  event_at timestamptz not null,
  object_count bigint not null check (object_count >= 0),
  inventory_sha256 text not null check (inventory_sha256 ~ '^[0-9a-f]{64}$')
);

alter table private.retired_community_deletion_batches
  add column orphan_first_scan_id uuid references private.retired_community_orphan_scans(id) on delete restrict,
  add column orphan_second_scan_id uuid references private.retired_community_orphan_scans(id) on delete restrict;

insert into private.retired_community_deletion_ledger
  (batch_id, event_type, actor, event_at, details)
select batch_row.id, 'cancelled', 'p4-scan-protocol-migration', clock_timestamp(),
  jsonb_build_object('reason', 'legacy_orphan_batch_missing_two_scan_proof')
from private.retired_community_deletion_batches batch_row
where batch_row.reason = 'orphan_cleanup'
  and batch_row.orphan_first_scan_id is null
  and batch_row.orphan_second_scan_id is null
  and not exists (
    select 1 from private.retired_community_deletion_ledger terminal
    where terminal.batch_id = batch_row.id
      and terminal.event_type in ('cancelled', 'executed')
  );

alter table private.retired_community_deletion_batches
  add constraint retired_community_deletion_batches_orphan_scans_check check (
    (reason = 'orphan_cleanup' and (
      (not sealed and orphan_first_scan_id is null and orphan_second_scan_id is null)
      or (orphan_first_scan_id is not null and orphan_second_scan_id is not null
        and orphan_first_scan_id <> orphan_second_scan_id)
    ))
    or (reason <> 'orphan_cleanup' and orphan_first_scan_id is null and orphan_second_scan_id is null)
  ) not valid;

do $retired_community_validate_orphan_scan_constraint$
begin
  if not exists (
    select 1 from private.retired_community_deletion_batches
    where reason = 'orphan_cleanup' and sealed
      and (orphan_first_scan_id is null or orphan_second_scan_id is null)
  ) then
    execute 'alter table private.retired_community_deletion_batches '
      || 'validate constraint retired_community_deletion_batches_orphan_scans_check';
  end if;
end;
$retired_community_validate_orphan_scan_constraint$;

create function private.block_retired_community_orphan_scan_audit_mutation()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  raise exception 'Retired Community orphan scan audit records are append-only.' using errcode = '55000';
end;
$$;

create trigger block_retired_community_orphan_scan_audit_mutation
  before update or delete on private.retired_community_orphan_scan_audit
  for each row execute function private.block_retired_community_orphan_scan_audit_mutation();

create function public.record_retired_community_orphan_scan(
  target_scan_id uuid,
  target_recorded_by text,
  target_inventory jsonb
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private, storage, pg_temp as $$
declare normalized_actor text := private.normalize_retired_community_operator(target_recorded_by);
declare input_count bigint;
declare current_count bigint;
declare replacement integer := 0;
declare inventory_digest text;
declare scan_time timestamptz := clock_timestamp();
begin
  if target_scan_id is null or target_inventory is null
     or jsonb_typeof(target_inventory) is distinct from 'array'
     or jsonb_array_length(target_inventory) > 100000 then
    raise exception 'A scan ID and complete inventory array are required.' using errcode = '22023';
  end if;
  if char_length(normalized_actor) not between 3 and 160 then
    raise exception 'A named scan operator is required.' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(target_inventory) entry
    where jsonb_typeof(entry) <> 'object'
      or not (entry ?& array['objectId', 'bucketId', 'objectName'])
      or entry - array['objectId', 'bucketId', 'objectName'] <> '{}'::jsonb
  ) then
    raise exception 'Scan inventory entries must contain only exact object identity fields.' using errcode = '22023';
  end if;

  select count(*),
    count(distinct source."objectId"),
    count(distinct source."bucketId" || ':' || source."objectName")
  into input_count, current_count, replacement
  from jsonb_to_recordset(target_inventory) as source(
    "objectId" uuid, "bucketId" text, "objectName" text
  );
  if input_count <> current_count or input_count <> replacement
     or exists (
       select 1 from jsonb_to_recordset(target_inventory) as source(
         "objectId" uuid, "bucketId" text, "objectName" text
       )
       where source."bucketId" <> 'community-post-images'
         or source."objectName" is null or source."objectName" = ''
     ) then
    raise exception 'Scan inventory contains duplicate or invalid object identities.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('retired-community-orphan-scan', 0));
  lock table storage.objects in share mode;
  lock table public.community_posts in share mode;
  select count(*) into current_count from storage.objects
    where bucket_id = 'community-post-images';
  if input_count <> current_count
     or exists (
       select 1
       from jsonb_to_recordset(target_inventory) as source(
         "objectId" uuid, "bucketId" text, "objectName" text
       )
       left join storage.objects object_row
         on object_row.id = source."objectId" and object_row.bucket_id = source."bucketId"
           and object_row.name = source."objectName"
       where object_row.id is null
     )
     or exists (
       select 1 from storage.objects object_row
       where object_row.bucket_id = 'community-post-images'
         and not exists (
           select 1 from jsonb_to_recordset(target_inventory) as source(
             "objectId" uuid, "bucketId" text, "objectName" text
           )
           where source."objectId" = object_row.id
             and source."bucketId" = object_row.bucket_id
             and source."objectName" = object_row.name
         )
     ) then
    raise exception 'The worker inventory is not a complete exact bucket scan.' using errcode = '55000';
  end if;

  if exists (select 1 from private.retired_community_orphan_scans where id = target_scan_id) then
    select replacement_number + 1 into replacement
      from private.retired_community_orphan_scans where id = target_scan_id for update;
    if exists (
      select 1 from private.retired_community_deletion_batches
      where orphan_first_scan_id = target_scan_id or orphan_second_scan_id = target_scan_id
    ) then
      raise exception 'A scan bound to a deletion batch cannot be replaced.' using errcode = '55000';
    end if;
    delete from private.retired_community_orphan_scan_items where scan_id = target_scan_id;
    update private.retired_community_orphan_scans set
      scanned_at = scan_time, recorded_at = scan_time, recorded_by = normalized_actor,
      object_count = 0, inventory_sha256 = repeat('0', 64), replacement_number = replacement
    where id = target_scan_id;
  else
    replacement := 0;
    insert into private.retired_community_orphan_scans (
      id, scanned_at, recorded_at, recorded_by, object_count, inventory_sha256, replacement_number
    ) values (
      target_scan_id, scan_time, scan_time, normalized_actor, 0, repeat('0', 64), replacement
    );
  end if;

  insert into private.retired_community_orphan_scan_items (
    scan_id, object_id, bucket_id, object_name, expected_row_sha256, referenced_post_count
  )
  select target_scan_id, object_row.id, object_row.bucket_id, object_row.name,
    private.retired_community_sha256(to_jsonb(object_row)::text),
    (select count(*) from public.community_posts post_row where post_row.image_path = object_row.name)
  from storage.objects object_row
  join jsonb_to_recordset(target_inventory) as source(
    "objectId" uuid, "bucketId" text, "objectName" text
  ) on source."objectId" = object_row.id and source."bucketId" = object_row.bucket_id
    and source."objectName" = object_row.name
  where object_row.bucket_id = 'community-post-images';

  select private.retired_community_sha256(coalesce(
    jsonb_agg(jsonb_build_array(object_id, bucket_id, object_name,
      expected_row_sha256, referenced_post_count) order by bucket_id, object_name)::text,
    '[]'))
  into inventory_digest
  from private.retired_community_orphan_scan_items where scan_id = target_scan_id;

  update private.retired_community_orphan_scans set
    object_count = input_count, inventory_sha256 = inventory_digest
  where id = target_scan_id;
  insert into private.retired_community_orphan_scan_audit (
    scan_id, event_type, actor, event_at, object_count, inventory_sha256
  ) values (
    target_scan_id, case when replacement = 0 then 'recorded' else 'replaced' end,
    normalized_actor, scan_time, input_count, inventory_digest
  );
  return jsonb_build_object('scanId', target_scan_id, 'status', 'complete',
    'counts', jsonb_build_object('objects', input_count));
end;
$$;

create function private.retired_community_orphan_scan_pair()
returns table (first_scan_id uuid, second_scan_id uuid)
language sql security definer
set search_path = pg_catalog, private, pg_temp set timezone = 'UTC' as $$
  with second_scan as (
    select scan.id, scan.scanned_at
    from private.retired_community_orphan_scans scan
    where scan.scanned_at >= statement_timestamp() - interval '24 hours'
      and scan.object_count = (
        select count(*) from private.retired_community_orphan_scan_items item
        where item.scan_id = scan.id
      )
    order by scan.scanned_at desc, scan.id desc limit 1
  )
  select first_scan.id, second_scan.id
  from second_scan
  join lateral (
    select scan.id
    from private.retired_community_orphan_scans scan
    where scan.scanned_at <= second_scan.scanned_at - interval '7 days'
      and scan.object_count = (
        select count(*) from private.retired_community_orphan_scan_items item
        where item.scan_id = scan.id
      )
    order by scan.scanned_at desc, scan.id desc limit 1
  ) first_scan on true;
$$;

create or replace function private.preview_retired_community_orphan_deletion()
returns jsonb language sql security definer
set search_path = pg_catalog, public, private, storage, pg_temp as $$
  with pair as (
    select * from private.retired_community_orphan_scan_pair()
  ), candidates as (
    select second_item.object_id
    from pair
    join private.retired_community_orphan_scan_items first_item
      on first_item.scan_id = pair.first_scan_id
    join private.retired_community_orphan_scan_items second_item
      on second_item.scan_id = pair.second_scan_id
      and second_item.object_id = first_item.object_id
      and second_item.bucket_id = first_item.bucket_id
      and second_item.object_name = first_item.object_name
      and second_item.expected_row_sha256 = first_item.expected_row_sha256
    join storage.objects object_row
      on object_row.id = second_item.object_id and object_row.bucket_id = second_item.bucket_id
        and object_row.name = second_item.object_name
        and private.retired_community_sha256(to_jsonb(object_row)::text) = second_item.expected_row_sha256
    where first_item.referenced_post_count = 0 and second_item.referenced_post_count = 0
      and not exists (
        select 1 from public.community_posts post_row
        where post_row.image_path = second_item.object_name
      )
      and not exists (
        select 1
        from private.retired_community_storage_work active_work
        join private.retired_community_deletion_batches active_batch
          on active_batch.id = active_work.batch_id
        where active_work.bucket_id = second_item.bucket_id
          and active_work.object_name = second_item.object_name
          and not exists (
            select 1 from private.retired_community_deletion_ledger terminal
            where terminal.batch_id = active_batch.id
              and terminal.event_type in ('cancelled', 'executed')
          )
      )
  )
  select jsonb_build_object(
    'batchId', null,
    'status', case when exists (select 1 from pair) then 'dry_run' else 'awaiting_scan' end,
    'counts', jsonb_build_object(
      'posts', 0, 'comments', 0, 'likes', 0,
      'objects', (select count(*) from candidates), 'credentials', 0
    )
  );
$$;

create or replace function private.create_retired_community_orphan_batch(
  target_requested_by text,
  target_requested_at timestamptz
)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public, private, storage, pg_temp as $$
declare census_row private.retired_community_t0_census%rowtype;
declare pair_row record;
declare new_batch_id uuid := gen_random_uuid();
declare normalized_requester text := private.normalize_retired_community_operator(target_requested_by);
declare source_digest text;
declare objects bigint;
begin
  if char_length(normalized_requester) not between 3 and 160 then
    raise exception 'A named requester is required.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('retired-community-deletion', 0));
  perform pg_advisory_xact_lock(hashtextextended('retired-community-orphan-scan', 0));
  select * into strict census_row from private.retired_community_t0_census where singleton;
  select * into pair_row from private.retired_community_orphan_scan_pair();
  if pair_row.first_scan_id is null or pair_row.second_scan_id is null then
    raise exception 'Two complete bucket scans at least seven days apart are required.' using errcode = '55000';
  end if;
  if exists (
    select 1 from private.retired_community_deletion_batches batch_row
    where batch_row.reason = 'orphan_cleanup'
      and not exists (
        select 1 from private.retired_community_deletion_ledger terminal
        where terminal.batch_id = batch_row.id and terminal.event_type in ('cancelled', 'executed')
      )
  ) then
    raise exception 'An active deletion batch already covers this target.' using errcode = '55000';
  end if;

  insert into private.retired_community_deletion_batches (
    id, reason, requested_by, requested_at, execute_after, t0_source_sha256,
    orphan_first_scan_id, orphan_second_scan_id
  ) values (
    new_batch_id, 'orphan_cleanup', normalized_requester, target_requested_at,
    target_requested_at, census_row.source_sha256,
    pair_row.first_scan_id, pair_row.second_scan_id
  );

  insert into private.retired_community_storage_work (
    batch_id, object_id, bucket_id, object_name, expected_row_sha256
  )
  select new_batch_id, second_item.object_id, second_item.bucket_id,
    second_item.object_name, second_item.expected_row_sha256
  from private.retired_community_orphan_scan_items first_item
  join private.retired_community_orphan_scan_items second_item
    on second_item.scan_id = pair_row.second_scan_id
      and second_item.object_id = first_item.object_id
      and second_item.bucket_id = first_item.bucket_id
      and second_item.object_name = first_item.object_name
      and second_item.expected_row_sha256 = first_item.expected_row_sha256
  join storage.objects object_row
    on object_row.id = second_item.object_id and object_row.bucket_id = second_item.bucket_id
      and object_row.name = second_item.object_name
      and private.retired_community_sha256(to_jsonb(object_row)::text) = second_item.expected_row_sha256
  where first_item.scan_id = pair_row.first_scan_id
    and first_item.referenced_post_count = 0 and second_item.referenced_post_count = 0
    and not exists (
      select 1 from public.community_posts post_row
      where post_row.image_path = second_item.object_name
    )
    and not exists (
      select 1
      from private.retired_community_storage_work active_work
      join private.retired_community_deletion_batches active_batch
        on active_batch.id = active_work.batch_id
      where active_work.bucket_id = second_item.bucket_id
        and active_work.object_name = second_item.object_name
        and active_batch.id <> new_batch_id
        and not exists (
          select 1 from private.retired_community_deletion_ledger terminal
          where terminal.batch_id = active_batch.id
            and terminal.event_type in ('cancelled', 'executed')
        )
    );

  select count(*) into objects from private.retired_community_storage_work
    where batch_id = new_batch_id;
  select private.retired_community_sha256(coalesce(
    jsonb_agg(jsonb_build_array('object', bucket_id || ':' || object_name,
      expected_row_sha256) order by bucket_id, object_name)::text, '[]'))
  into source_digest from private.retired_community_storage_work where batch_id = new_batch_id;
  update private.retired_community_deletion_batches set
    source_sha256 = source_digest, post_count = 0, comment_count = 0,
    like_count = 0, object_count = objects, credential_count = 0, sealed = true
  where id = new_batch_id;
  insert into private.retired_community_deletion_ledger
    (batch_id, event_type, actor, event_at, details)
  values (new_batch_id, 'created', normalized_requester, target_requested_at,
    jsonb_build_object('reason', 'orphan_cleanup', 'posts', 0, 'comments', 0,
      'likes', 0, 'objects', objects, 'credentials', 0));
  return new_batch_id;
end;
$$;

create or replace function public.plan_orphan_retired_community_deletion(
  target_requested_by text,
  target_dry_run boolean default true
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private, pg_temp as $$
declare new_batch_id uuid;
begin
  if coalesce(target_dry_run, true) then
    return private.preview_retired_community_orphan_deletion();
  end if;
  new_batch_id := private.create_retired_community_orphan_batch(
    target_requested_by, clock_timestamp());
  return private.retired_community_batch_result(new_batch_id);
end;
$$;

create table private.retired_community_purge_manifests (
  batch_id uuid primary key references private.retired_community_deletion_batches(id) on delete restrict,
  reason text not null check (reason in
    ('aged_retention', 'account_erasure', 'group_deletion', 'orphan_cleanup')),
  executed_at timestamptz not null,
  expires_at timestamptz not null,
  t0_source_sha256 text not null check (t0_source_sha256 ~ '^[0-9a-f]{64}$'),
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  bundle_sha256 text not null check (bundle_sha256 ~ '^[0-9a-f]{64}$'),
  post_count bigint not null check (post_count >= 0),
  comment_count bigint not null check (comment_count >= 0),
  like_count bigint not null check (like_count >= 0),
  object_count bigint not null check (object_count >= 0),
  credential_count bigint not null check (credential_count >= 0),
  manifest_sha256 text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  check (expires_at = executed_at + interval '180 days')
);

create table private.retired_community_backup_reverifications (
  batch_id uuid primary key references private.retired_community_purge_manifests(batch_id) on delete cascade,
  verified_at timestamptz not null,
  bundle_sha256 text not null check (bundle_sha256 ~ '^[0-9a-f]{64}$'),
  verification_reference_sha256 text not null check (verification_reference_sha256 ~ '^[0-9a-f]{64}$'),
  verifier_identity_sha256 text not null check (verifier_identity_sha256 ~ '^[0-9a-f]{64}$')
);

create table private.retired_community_t0_purge_records (
  singleton boolean primary key default true check (singleton),
  aged_batch_id uuid not null unique
    references private.retired_community_deletion_batches(id) on delete restrict,
  purged_at timestamptz not null,
  t0_source_sha256 text not null check (t0_source_sha256 ~ '^[0-9a-f]{64}$'),
  post_count bigint not null check (post_count >= 0),
  comment_count bigint not null check (comment_count >= 0),
  like_count bigint not null check (like_count >= 0),
  total_object_count bigint not null check (total_object_count >= 0),
  referenced_object_count bigint not null check (referenced_object_count >= 0),
  record_sha256 text not null check (record_sha256 ~ '^[0-9a-f]{64}$')
);

create table private.retired_community_batch_identity_redactions (
  batch_id uuid primary key
    references private.retired_community_deletion_batches(id) on delete restrict,
  reason text not null check (reason in
    ('aged_retention', 'account_erasure', 'group_deletion', 'orphan_cleanup')),
  redacted_at timestamptz not null,
  subject_identity_removed boolean not null,
  crew_identity_removed boolean not null,
  record_sha256 text not null check (record_sha256 ~ '^[0-9a-f]{64}$')
);

create trigger block_retired_community_t0_purge_record_mutation
  before update or delete on private.retired_community_t0_purge_records
  for each row execute function private.block_retired_community_record_mutation();
create trigger block_retired_community_batch_identity_redaction_mutation
  before update or delete on private.retired_community_batch_identity_redactions
  for each row execute function private.block_retired_community_record_mutation();

create or replace function private.guard_retired_community_batch_mutation()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.sealed then
      raise exception 'Retired Community deletion batches must be assembled before sealing.' using errcode = '55000';
    end if;
    return new;
  end if;
  if tg_op = 'UPDATE' and old.sealed
     and exists (
       select 1 from private.retired_community_batch_identity_redactions redaction
       where redaction.batch_id = old.id
     )
     and new.requested_by = 'redacted-after-retention'
     and new.subject_user_id is not distinct from (case
       when old.reason = 'account_erasure'
         then '00000000-0000-0000-0000-000000000000'::uuid
       else null::uuid end)
     and new.crew_id is not distinct from (case
       when old.reason = 'group_deletion'
         then '00000000-0000-0000-0000-000000000000'::uuid
       else null::uuid end)
     and (to_jsonb(new) - 'requested_by' - 'subject_user_id' - 'crew_id')
       = (to_jsonb(old) - 'requested_by' - 'subject_user_id' - 'crew_id') then
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

create or replace function private.block_retired_community_record_mutation()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
begin
  if tg_op = 'UPDATE' and tg_table_name = 'retired_community_deletion_ledger'
     and (to_jsonb(new) ->> 'actor') = 'redacted-after-retention'
     and (to_jsonb(new) - 'actor') = (to_jsonb(old) - 'actor')
     and exists (
       select 1 from private.retired_community_batch_identity_redactions redaction
       where redaction.batch_id = old.batch_id
     ) then
    return new;
  end if;
  if tg_op = 'DELETE'
     and tg_table_name in ('retired_community_backup_proofs',
       'retired_community_batch_approvals')
     and exists (
       select 1 from private.retired_community_batch_identity_redactions redaction
       where redaction.batch_id = old.batch_id
     ) then
    return old;
  end if;
  raise exception 'Retired Community proof, approval, and ledger records are append-only.'
    using errcode = '55000';
end;
$$;

create or replace function private.block_retired_community_t0_mutation()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
begin
  if tg_op = 'DELETE'
     and tg_table_name <> 'retired_community_t0_census'
     and exists (select 1 from private.retired_community_t0_purge_records) then
    return old;
  end if;
  raise exception 'The retired Community T0 snapshot is immutable.' using errcode = '55000';
end;
$$;

create function private.retired_community_evidence_is_releasable(target_batch_id uuid)
returns boolean language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
begin
  return exists (
    select 1
    from private.retired_community_purge_manifests manifest
    where manifest.batch_id = target_batch_id
      and manifest.expires_at <= clock_timestamp()
      and not exists (
        select 1 from private.retired_community_dr_reapplications reapplication
        where reapplication.source_batch_id = manifest.batch_id
          and reapplication.reapplied_at is null
      )
      and (
        manifest.reason <> 'aged_retention'
        or exists (select 1 from private.retired_community_t0_purge_records)
        or not exists (
          select 1 from private.retired_community_deletion_batches active_batch
          where not exists (
            select 1 from private.retired_community_deletion_ledger terminal
            where terminal.batch_id = active_batch.id
              and terminal.event_type in ('cancelled', 'executed')
          )
        )
      )
  ) or exists (
    select 1
    from private.retired_community_deletion_batches batch_row
    join private.retired_community_deletion_ledger cancellation
      on cancellation.batch_id = batch_row.id and cancellation.event_type = 'cancelled'
    where batch_row.id = target_batch_id
      and batch_row.sealed
      and cancellation.event_at + interval '180 days' <= clock_timestamp()
      and not exists (
        select 1 from private.retired_community_deletion_ledger execution
        where execution.batch_id = batch_row.id and execution.event_type = 'executed'
      )
  );
end;
$$;

create or replace function private.guard_retired_community_item_mutation()
returns trigger language plpgsql
set search_path = pg_catalog, private, pg_temp as $$
begin
  if tg_op = 'DELETE'
     and private.retired_community_evidence_is_releasable(old.batch_id) then
    return old;
  end if;
  if tg_op <> 'INSERT' then
    raise exception 'Retired Community deletion items are immutable.' using errcode = '55000';
  end if;
  if (select sealed from private.retired_community_deletion_batches where id = new.batch_id) then
    raise exception 'A sealed deletion batch cannot accept items.' using errcode = '55000';
  end if;
  return new;
end;
$$;

create function private.guard_retired_community_work_delete()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
begin
  if private.retired_community_evidence_is_releasable(old.batch_id) then
    return old;
  end if;
  raise exception 'Retired Community exact work cannot be deleted before its retention hold closes.'
    using errcode = '55000';
end;
$$;

create trigger guard_retired_community_storage_work_delete
  before delete on private.retired_community_storage_work
  for each row execute function private.guard_retired_community_work_delete();
create trigger guard_retired_community_credential_work_delete
  before delete on private.retired_community_credential_work
  for each row execute function private.guard_retired_community_work_delete();

create function private.retired_community_manifest_payload(
  target_batch_id uuid,
  target_executed_at timestamptz
)
returns jsonb language sql stable security definer
set search_path = pg_catalog, private, pg_temp set timezone = 'UTC' as $$
  select jsonb_build_object(
    'schemaVersion', 1,
    'batchId', batch_row.id,
    'reason', batch_row.reason,
    'executedAt', target_executed_at,
    'expiresAt', target_executed_at + interval '180 days',
    't0SourceSha256', batch_row.t0_source_sha256,
    'sourceSha256', batch_row.source_sha256,
    'bundleSha256', proof.bundle_sha256,
    'counts', jsonb_build_object(
      'posts', batch_row.post_count,
      'comments', batch_row.comment_count,
      'likes', batch_row.like_count,
      'objects', batch_row.object_count,
      'credentials', batch_row.credential_count
    )
  )
  from private.retired_community_deletion_batches batch_row
  join private.retired_community_backup_proofs proof on proof.batch_id = batch_row.id
  where batch_row.id = target_batch_id;
$$;

create function private.record_retired_community_purge_manifest(
  target_batch_id uuid,
  target_executed_at timestamptz
)
returns void language plpgsql security definer
set search_path = pg_catalog, private, pg_temp set timezone = 'UTC' as $$
declare payload jsonb;
begin
  payload := private.retired_community_manifest_payload(target_batch_id, target_executed_at);
  if payload is null then
    raise exception 'A verified backup is required before recording a purge manifest.' using errcode = '55000';
  end if;
  insert into private.retired_community_purge_manifests (
    batch_id, reason, executed_at, expires_at, t0_source_sha256, source_sha256,
    bundle_sha256, post_count, comment_count, like_count, object_count,
    credential_count, manifest_sha256
  )
  select batch_row.id, batch_row.reason, target_executed_at,
    target_executed_at + interval '180 days', batch_row.t0_source_sha256,
    batch_row.source_sha256, proof.bundle_sha256, batch_row.post_count,
    batch_row.comment_count, batch_row.like_count, batch_row.object_count,
    batch_row.credential_count, private.retired_community_sha256(payload::text)
  from private.retired_community_deletion_batches batch_row
  join private.retired_community_backup_proofs proof on proof.batch_id = batch_row.id
  where batch_row.id = target_batch_id
  on conflict (batch_id) do nothing;
end;
$$;

do $retired_community_manifest_backfill$
declare execution record;
begin
  for execution in
    select ledger.batch_id, min(ledger.event_at) as executed_at
    from private.retired_community_deletion_ledger ledger
    join private.retired_community_backup_proofs proof on proof.batch_id = ledger.batch_id
    where ledger.event_type = 'executed'
    group by ledger.batch_id
  loop
    perform private.record_retired_community_purge_manifest(
      execution.batch_id,
      execution.executed_at
    );
  end loop;
end;
$retired_community_manifest_backfill$;

create function private.guard_retired_community_purge_manifest_mutation()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  if tg_op = 'UPDATE' or old.expires_at > clock_timestamp() then
    raise exception 'Retired Community purge manifests are immutable for 180 days.' using errcode = '55000';
  end if;
  return old;
end;
$$;

create trigger guard_retired_community_purge_manifest_mutation
  before update or delete on private.retired_community_purge_manifests
  for each row execute function private.guard_retired_community_purge_manifest_mutation();

create function private.block_retired_community_backup_reverification_mutation()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
begin
  if tg_op = 'DELETE' and (
    not exists (
      select 1 from private.retired_community_purge_manifests manifest
      where manifest.batch_id = old.batch_id
    ) or exists (
      select 1 from private.retired_community_purge_manifests manifest
      where manifest.batch_id = old.batch_id and manifest.expires_at <= clock_timestamp()
    )
  ) then
    return old;
  end if;
  raise exception 'Retired Community backup reverifications are append-only.' using errcode = '55000';
end;
$$;

create trigger block_retired_community_backup_reverification_mutation
  before update or delete on private.retired_community_backup_reverifications
  for each row execute function private.block_retired_community_backup_reverification_mutation();

create function public.verify_retired_community_backup_after_30_days(
  target_batch_id uuid,
  target_bundle_sha256 text,
  target_verification_reference_sha256 text,
  target_verified_by text
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, private, pg_temp set timezone = 'UTC' as $$
declare manifest_row private.retired_community_purge_manifests%rowtype;
declare normalized_verifier text := private.normalize_retired_community_operator(target_verified_by);
begin
  select * into strict manifest_row from private.retired_community_purge_manifests
    where batch_id = target_batch_id;
  if clock_timestamp() < manifest_row.executed_at + interval '30 days' then
    raise exception 'Backup age verification cannot be recorded before purge plus 30 days.' using errcode = '55000';
  end if;
  if target_bundle_sha256 is distinct from manifest_row.bundle_sha256 then
    raise exception 'Backup age verification does not match the purged bundle.' using errcode = '22023';
  end if;
  if target_verification_reference_sha256 !~ '^[0-9a-f]{64}$'
     or char_length(normalized_verifier) not between 3 and 160 then
    raise exception 'A verification reference and named verifier are required.' using errcode = '22023';
  end if;
  insert into private.retired_community_backup_reverifications (
    batch_id, verified_at, bundle_sha256, verification_reference_sha256,
    verifier_identity_sha256
  ) values (
    target_batch_id, clock_timestamp(), target_bundle_sha256,
    target_verification_reference_sha256,
    private.retired_community_sha256(normalized_verifier)
  );
  return private.retired_community_batch_result(target_batch_id);
end;
$$;

create function public.purge_expired_retired_community_manifests()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
declare expired_batch_ids uuid[];
declare affected_count bigint;
declare evidence_deleted bigint := 0;
declare scan_items_deleted bigint := 0;
declare manifests_deleted bigint := 0;
declare t0_batch_id uuid;
declare t0_source_sha text;
declare t0_post_count bigint := 0;
declare t0_comment_count bigint := 0;
declare t0_like_count bigint := 0;
declare t0_total_object_count bigint := 0;
declare t0_referenced_object_count bigint := 0;
declare t0_identity_rows_deleted bigint := 0;
declare t0_record_payload jsonb;
declare evidence_batch_id uuid;
declare identity_rows_redacted bigint := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended('retired-community-deletion', 0));
  perform pg_advisory_xact_lock(hashtextextended('retired-community-orphan-scan', 0));
  select coalesce(array_agg(batch_row.id order by batch_row.id), '{}'::uuid[])
  into expired_batch_ids
  from private.retired_community_deletion_batches batch_row
  where private.retired_community_evidence_is_releasable(batch_row.id)
    and not exists (
      select 1 from private.retired_community_batch_identity_redactions redaction
      where redaction.batch_id = batch_row.id
    );

  select batch_row.id into t0_batch_id
  from private.retired_community_deletion_batches batch_row
  where batch_row.id = any(expired_batch_ids)
    and batch_row.reason = 'aged_retention'
    and not exists (select 1 from private.retired_community_t0_purge_records)
    and exists (
      select 1 from private.retired_community_purge_manifests manifest
      where manifest.batch_id = batch_row.id
        and manifest.reason = 'aged_retention'
        and manifest.expires_at <= clock_timestamp()
    )
  order by batch_row.requested_at, batch_row.id
  limit 1;

  foreach evidence_batch_id in array expired_batch_ids loop
    perform private.assert_retired_community_batch_evidence_complete(evidence_batch_id);
  end loop;

  if t0_batch_id is not null then
    select census.source_sha256 into strict t0_source_sha
    from private.retired_community_t0_census census where census.singleton;
    select count(*) into t0_post_count
    from private.retired_community_t0_post_inventory;
    select count(*) into t0_comment_count
    from private.retired_community_t0_comment_inventory;
    select count(*) into t0_like_count
    from private.retired_community_t0_like_inventory;
    select count(*), count(*) filter (where cardinality(referenced_post_ids) > 0)
    into t0_total_object_count, t0_referenced_object_count
    from private.retired_community_t0_object_inventory;
    if not exists (
      select 1 from private.retired_community_deletion_batches batch_row
      where batch_row.id = t0_batch_id
        and batch_row.sealed
        and batch_row.t0_source_sha256 = t0_source_sha
        and batch_row.post_count = t0_post_count
        and batch_row.comment_count = t0_comment_count
        and batch_row.like_count = t0_like_count
        and batch_row.object_count = t0_referenced_object_count
        and batch_row.credential_count = 0
        and exists (
          select 1 from private.retired_community_deletion_ledger execution
          where execution.batch_id = batch_row.id and execution.event_type = 'executed'
        )
    ) then
      raise exception 'T0 identity retention cannot close without the exact executed aged batch.'
        using errcode = '55000';
    end if;
  end if;

  insert into private.retired_community_batch_identity_redactions (
    batch_id, reason, redacted_at, subject_identity_removed,
    crew_identity_removed, record_sha256
  )
  select batch_row.id, batch_row.reason, clock_timestamp(),
    batch_row.subject_user_id is not null, batch_row.crew_id is not null,
    private.retired_community_sha256(jsonb_build_object(
      'batchId', batch_row.id,
      'reason', batch_row.reason,
      'subjectIdentityRemoved', batch_row.subject_user_id is not null,
      'crewIdentityRemoved', batch_row.crew_id is not null,
      'posts', batch_row.post_count,
      'comments', batch_row.comment_count,
      'likes', batch_row.like_count,
      'objects', batch_row.object_count,
      'credentials', batch_row.credential_count
    )::text)
  from private.retired_community_deletion_batches batch_row
  where batch_row.id = any(expired_batch_ids)
  on conflict (batch_id) do nothing;

  update private.retired_community_deletion_ledger
  set actor = 'redacted-after-retention'
  where batch_id = any(expired_batch_ids)
    and actor <> 'redacted-after-retention';
  get diagnostics affected_count = row_count;
  identity_rows_redacted := identity_rows_redacted + affected_count;
  delete from private.retired_community_backup_proofs
  where batch_id = any(expired_batch_ids);
  get diagnostics affected_count = row_count;
  identity_rows_redacted := identity_rows_redacted + affected_count;
  evidence_deleted := evidence_deleted + affected_count;
  delete from private.retired_community_batch_approvals
  where batch_id = any(expired_batch_ids);
  get diagnostics affected_count = row_count;
  identity_rows_redacted := identity_rows_redacted + affected_count;
  evidence_deleted := evidence_deleted + affected_count;
  update private.retired_community_deletion_batches set
    requested_by = 'redacted-after-retention',
    subject_user_id = case when reason = 'account_erasure'
      then '00000000-0000-0000-0000-000000000000'::uuid else null end,
    crew_id = case when reason = 'group_deletion'
      then '00000000-0000-0000-0000-000000000000'::uuid else null end
  where id = any(expired_batch_ids)
    and requested_by <> 'redacted-after-retention';
  get diagnostics affected_count = row_count;
  identity_rows_redacted := identity_rows_redacted + affected_count;

  delete from private.retired_community_deletion_items
  where batch_id = any(expired_batch_ids);
  get diagnostics affected_count = row_count;
  evidence_deleted := evidence_deleted + affected_count;
  delete from private.retired_community_storage_work
  where batch_id = any(expired_batch_ids);
  get diagnostics affected_count = row_count;
  evidence_deleted := evidence_deleted + affected_count;
  delete from private.retired_community_credential_work
  where batch_id = any(expired_batch_ids);
  get diagnostics affected_count = row_count;
  evidence_deleted := evidence_deleted + affected_count;

  delete from private.retired_community_orphan_scan_items scan_item
  where exists (
      select 1 from private.retired_community_orphan_scans scan
      where scan.id = scan_item.scan_id
        and scan.scanned_at <= clock_timestamp() - interval '180 days'
    )
    and not exists (
      select 1
      from private.retired_community_deletion_batches batch_row
      where (batch_row.orphan_first_scan_id = scan_item.scan_id
          or batch_row.orphan_second_scan_id = scan_item.scan_id)
        and (
          not exists (
            select 1 from private.retired_community_deletion_ledger terminal
            where terminal.batch_id = batch_row.id
              and terminal.event_type in ('cancelled', 'executed')
          )
          or exists (
            select 1 from private.retired_community_purge_manifests manifest
            where manifest.batch_id = batch_row.id
              and manifest.expires_at > clock_timestamp()
          )
        )
    );
  get diagnostics scan_items_deleted = row_count;

  if t0_batch_id is not null then
    t0_record_payload := jsonb_build_object(
      'agedBatchId', t0_batch_id,
      't0SourceSha256', t0_source_sha,
      'posts', t0_post_count,
      'comments', t0_comment_count,
      'likes', t0_like_count,
      'totalObjects', t0_total_object_count,
      'referencedObjects', t0_referenced_object_count
    );
    insert into private.retired_community_t0_purge_records (
      singleton, aged_batch_id, purged_at, t0_source_sha256,
      post_count, comment_count, like_count, total_object_count,
      referenced_object_count, record_sha256
    ) values (
      true, t0_batch_id, clock_timestamp(), t0_source_sha,
      t0_post_count, t0_comment_count, t0_like_count, t0_total_object_count,
      t0_referenced_object_count,
      private.retired_community_sha256(t0_record_payload::text)
    );
    delete from private.retired_community_t0_comment_inventory;
    get diagnostics affected_count = row_count;
    t0_identity_rows_deleted := t0_identity_rows_deleted + affected_count;
    delete from private.retired_community_t0_like_inventory;
    get diagnostics affected_count = row_count;
    t0_identity_rows_deleted := t0_identity_rows_deleted + affected_count;
    delete from private.retired_community_t0_object_inventory;
    get diagnostics affected_count = row_count;
    t0_identity_rows_deleted := t0_identity_rows_deleted + affected_count;
    delete from private.retired_community_t0_post_inventory;
    get diagnostics affected_count = row_count;
    t0_identity_rows_deleted := t0_identity_rows_deleted + affected_count;
  end if;

  delete from private.retired_community_purge_manifests
  where batch_id = any(expired_batch_ids);
  get diagnostics manifests_deleted = row_count;
  return jsonb_build_object('status', 'complete',
    'counts', jsonb_build_object(
      'manifestsDeleted', manifests_deleted,
      'exactEvidenceRowsDeleted', evidence_deleted,
      'orphanScanItemsDeleted', scan_items_deleted,
      'identityRowsRedacted', identity_rows_redacted,
      't0IdentityRowsDeleted', t0_identity_rows_deleted,
      't0SnapshotPurged', t0_batch_id is not null
    ));
end;
$$;

create table private.retired_community_dr_reapplications (
  source_batch_id uuid not null references private.retired_community_deletion_batches(id) on delete restrict,
  reapply_batch_id uuid primary key references private.retired_community_deletion_batches(id) on delete restrict,
  imported_manifest_sha256 text not null check (imported_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  imported_at timestamptz not null,
  reapplied_at timestamptz,
  unique (source_batch_id, imported_manifest_sha256)
);

create table private.retired_community_dr_quarantined_crews (
  crew_id uuid primary key references public.crews(id) on delete cascade,
  source_batch_id uuid not null references private.retired_community_deletion_batches(id) on delete restrict,
  quarantined_at timestamptz not null
);

create table private.retired_community_dr_quarantined_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  source_batch_id uuid not null references private.retired_community_deletion_batches(id) on delete restrict,
  quarantined_at timestamptz not null
);

create function private.validate_retired_community_dr_quarantine()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
begin
  if not exists (
    select 1
    from private.retired_community_deletion_batches batch_row
    join private.retired_community_deletion_ledger execution
      on execution.batch_id = batch_row.id and execution.event_type = 'executed'
    where batch_row.id = new.source_batch_id
      and batch_row.sealed
      and batch_row.reason = 'group_deletion'
      and batch_row.crew_id = new.crew_id
  ) then
    raise exception 'DR quarantine must match an executed group deletion batch.'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger validate_retired_community_dr_quarantine
  before insert or update on private.retired_community_dr_quarantined_crews
  for each row execute function private.validate_retired_community_dr_quarantine();

create function private.validate_retired_community_dr_user_quarantine()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
begin
  if not exists (
    select 1
    from private.retired_community_deletion_batches batch_row
    join private.retired_community_deletion_ledger execution
      on execution.batch_id = batch_row.id and execution.event_type = 'executed'
    where batch_row.id = new.source_batch_id
      and batch_row.sealed
      and batch_row.reason = 'account_erasure'
      and batch_row.subject_user_id = new.user_id
  ) then
    raise exception 'DR user quarantine must match an executed account erasure batch.'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger validate_retired_community_dr_user_quarantine
  before insert or update on private.retired_community_dr_quarantined_users
  for each row execute function private.validate_retired_community_dr_user_quarantine();

create function private.block_retired_community_dr_reapplication_mutation()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  if old.reapplied_at is null and new.reapplied_at is not null
     and new.source_batch_id = old.source_batch_id
     and new.reapply_batch_id = old.reapply_batch_id
     and new.imported_manifest_sha256 = old.imported_manifest_sha256
     and new.imported_at = old.imported_at then
    return new;
  end if;
  raise exception 'Retired Community DR reapplication state is immutable.' using errcode = '55000';
end;
$$;

create trigger block_retired_community_dr_reapplication_mutation
  before update or delete on private.retired_community_dr_reapplications
  for each row execute function private.block_retired_community_dr_reapplication_mutation();

create or replace function public.is_crew_member(target_crew_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, private, auth, pg_temp as $$
  select not exists (
    select 1 from private.retired_community_dr_quarantined_crews quarantine
    where quarantine.crew_id = target_crew_id
  ) and exists (
    select 1 from public.crew_members member_row
    where member_row.crew_id = target_crew_id and member_row.user_id = auth.uid()
  );
$$;

create or replace function public.can_manage_crew(target_crew_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, private, auth, pg_temp as $$
  select not exists (
    select 1 from private.retired_community_dr_quarantined_crews quarantine
    where quarantine.crew_id = target_crew_id
  ) and exists (
    select 1 from public.crew_members member_row
    where member_row.crew_id = target_crew_id and member_row.user_id = auth.uid()
      and member_row.role in ('owner', 'admin')
  );
$$;

create function public.retired_community_crew_is_quarantined(target_crew_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, private, pg_temp as $$
  select exists (
    select 1 from private.retired_community_dr_quarantined_crews quarantine
    where quarantine.crew_id = target_crew_id
  );
$$;

create function public.retired_community_user_is_quarantined(target_user_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, private, pg_temp as $$
  select exists (
    select 1 from private.retired_community_dr_quarantined_users quarantine
    where quarantine.user_id = target_user_id
  );
$$;

create function private.retired_community_account_erasure_is_pending(target_user_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, private, pg_temp as $$
  select exists (
    select 1 from private.retired_community_deletion_batches batch_row
    where batch_row.reason = 'account_erasure'
      and batch_row.subject_user_id = target_user_id
      and batch_row.sealed
      and not exists (
        select 1 from private.retired_community_deletion_ledger terminal
        where terminal.batch_id = batch_row.id
          and terminal.event_type in ('cancelled', 'executed')
      )
  );
$$;

create function public.retired_community_current_account_erasure_is_pending()
returns boolean language sql stable security definer
set search_path = pg_catalog, private, auth, pg_temp as $$
  select auth.uid() is not null
    and private.retired_community_account_erasure_is_pending(auth.uid());
$$;

create function private.retired_community_group_deletion_is_pending(target_crew_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, private, pg_temp as $$
  select exists (
    select 1 from private.retired_community_deletion_batches batch_row
    where batch_row.reason = 'group_deletion'
      and batch_row.crew_id = target_crew_id
      and batch_row.sealed
      and not exists (
        select 1 from private.retired_community_deletion_ledger terminal
        where terminal.batch_id = batch_row.id
          and terminal.event_type in ('cancelled', 'executed')
      )
  );
$$;

create function private.block_retired_community_pending_account_storage_write()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, storage, pg_temp as $$
begin
  if (
    new.bucket_id in ('community-post-images', 'profile-photos', 'journal-progress')
    and exists (
      select 1 from private.retired_community_deletion_batches batch_row
      where private.retired_community_account_erasure_is_pending(batch_row.subject_user_id)
        and (
          new.owner = batch_row.subject_user_id
          or (new.bucket_id in ('profile-photos', 'journal-progress')
            and (storage.foldername(new.name))[1] = batch_row.subject_user_id::text)
          or (new.bucket_id = 'community-post-images'
            and (storage.foldername(new.name))[2] = batch_row.subject_user_id::text)
        )
    )
  ) or (
    tg_op = 'UPDATE'
    and old.bucket_id in ('community-post-images', 'profile-photos', 'journal-progress')
    and exists (
      select 1 from private.retired_community_deletion_batches batch_row
      where private.retired_community_account_erasure_is_pending(batch_row.subject_user_id)
        and (
          old.owner = batch_row.subject_user_id
          or (old.bucket_id in ('profile-photos', 'journal-progress')
            and (storage.foldername(old.name))[1] = batch_row.subject_user_id::text)
          or (old.bucket_id = 'community-post-images'
            and (storage.foldername(old.name))[2] = batch_row.subject_user_id::text)
        )
    )
  ) then
    raise exception 'Storage assets are frozen while account erasure is pending.'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger block_pending_account_storage_write
  before insert or update on storage.objects
  for each row execute function private.block_retired_community_pending_account_storage_write();

create function private.block_retired_community_pending_image_reference()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, private, pg_temp as $$
begin
  if new.image_path is not null
     and (tg_op = 'INSERT' or new.image_path is distinct from old.image_path)
     and exists (
       select 1
       from private.retired_community_storage_work work
       join private.retired_community_deletion_batches batch_row on batch_row.id = work.batch_id
       where work.bucket_id = 'community-post-images'
         and work.object_name = new.image_path
         and batch_row.sealed
         and not exists (
           select 1 from private.retired_community_deletion_ledger terminal
           where terminal.batch_id = batch_row.id
             and terminal.event_type in ('cancelled', 'executed')
         )
     ) then
    raise exception 'Community image references are frozen while deletion is pending.'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger block_pending_retired_community_image_reference
  before insert or update of image_path on public.community_posts
  for each row execute function private.block_retired_community_pending_image_reference();

create policy "Pending account erasure blocks personal asset uploads"
  on storage.objects as restrictive for insert to authenticated
  with check (
    bucket_id not in ('profile-photos', 'journal-progress')
    or not public.retired_community_current_account_erasure_is_pending()
  );

create policy "Pending account erasure freezes personal asset updates"
  on storage.objects as restrictive for update to authenticated
  using (
    bucket_id not in ('profile-photos', 'journal-progress')
    or not public.retired_community_current_account_erasure_is_pending()
  )
  with check (
    bucket_id not in ('profile-photos', 'journal-progress')
    or not public.retired_community_current_account_erasure_is_pending()
  );

create function private.block_retired_community_quarantined_crew_write()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
begin
  if exists (
    select 1 from private.retired_community_dr_quarantined_crews quarantine
    where quarantine.crew_id = new.crew_id
  ) or (tg_op = 'UPDATE' and exists (
    select 1 from private.retired_community_dr_quarantined_crews quarantine
    where quarantine.crew_id = old.crew_id
  )) then
    raise exception 'This restored group is quarantined pending deletion reapplication.'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger block_quarantined_crew_member_write
  before insert or update on public.crew_members
  for each row execute function private.block_retired_community_quarantined_crew_write();
create trigger block_quarantined_crew_invite_write
  before insert or update on public.crew_invites
  for each row execute function private.block_retired_community_quarantined_crew_write();

create function private.block_retired_community_quarantined_user_membership_write()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
begin
  if exists (
    select 1 from private.retired_community_dr_quarantined_users quarantine
    where quarantine.user_id = new.user_id
  ) or (tg_op = 'UPDATE' and exists (
    select 1 from private.retired_community_dr_quarantined_users quarantine
    where quarantine.user_id = old.user_id
  )) then
    raise exception 'This restored account is quarantined pending deletion reapplication.'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger block_quarantined_user_membership_write
  before insert or update on public.crew_members
  for each row execute function private.block_retired_community_quarantined_user_membership_write();

create function private.block_retired_community_quarantined_inviter_write()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
begin
  if exists (
    select 1 from private.retired_community_dr_quarantined_users quarantine
    where quarantine.user_id = new.created_by
  ) or (tg_op = 'UPDATE' and exists (
    select 1 from private.retired_community_dr_quarantined_users quarantine
    where quarantine.user_id = old.created_by
  )) then
    raise exception 'This restored account cannot create invitations while quarantined.'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger block_quarantined_inviter_write
  before insert or update on public.crew_invites
  for each row execute function private.block_retired_community_quarantined_inviter_write();

create function private.block_retired_community_quarantined_destination_write()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
declare old_crew_id uuid;
declare new_crew_id uuid;
declare old_pending boolean := false;
declare new_pending boolean := false;
declare old_quarantined boolean := false;
declare new_quarantined boolean := false;
begin
  if tg_op <> 'INSERT' then
    old_crew_id := old.crew_id;
    old_pending := private.retired_community_group_deletion_is_pending(old_crew_id);
    old_quarantined := exists (
      select 1 from private.retired_community_dr_quarantined_crews quarantine
      where quarantine.crew_id = old_crew_id
    );
  end if;
  if tg_op <> 'DELETE' then
    new_crew_id := new.crew_id;
    new_pending := private.retired_community_group_deletion_is_pending(new_crew_id);
    new_quarantined := exists (
      select 1 from private.retired_community_dr_quarantined_crews quarantine
      where quarantine.crew_id = new_crew_id
    );
  end if;

  if tg_op = 'DELETE' then
    if old_pending and not exists (
      select 1
      from private.retired_community_deletion_batches batch_row
      join private.retired_community_credential_work work
        on work.batch_id = batch_row.id and work.destination_id = old.id
      where batch_row.reason = 'group_deletion'
        and batch_row.crew_id = old_crew_id
        and batch_row.sealed
        and work.status = 'confirmed'
        and not exists (
          select 1 from private.retired_community_deletion_ledger terminal
          where terminal.batch_id = batch_row.id
            and terminal.event_type in ('cancelled', 'executed')
        )
    ) then
      raise exception 'Integration credentials are frozen while group deletion is pending.'
        using errcode = '55000';
    end if;
    if old_quarantined and not old_pending then
      raise exception 'This restored group cannot change an integration while quarantined.'
        using errcode = '55000';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' and old_crew_id is distinct from new_crew_id
     and (old_pending or new_pending or old_quarantined or new_quarantined) then
    if old_quarantined or new_quarantined then
      raise exception 'This restored group cannot change an integration while quarantined.'
        using errcode = '55000';
    end if;
    raise exception 'Integration credentials are frozen while group deletion is pending.'
      using errcode = '55000';
  end if;

  if new_pending then
    if tg_op = 'INSERT' then
      raise exception 'Integration credentials are frozen while group deletion is pending.'
        using errcode = '55000';
    elsif row(
      new.id, new.crew_id, new.provider, new.provider_workspace_id,
      new.provider_destination_id, new.credential_ciphertext,
      new.credential_nonce, new.credential_key_version,
      new.credential_fingerprint, new.scopes
    ) is distinct from row(
      old.id, old.crew_id, old.provider, old.provider_workspace_id,
      old.provider_destination_id, old.credential_ciphertext,
      old.credential_nonce, old.credential_key_version,
      old.credential_fingerprint, old.scopes
    ) and not (
      new.status = 'revoked'
      and row(
        new.id, new.crew_id, new.provider,
        new.provider_workspace_id, new.provider_destination_id
      ) is not distinct from row(
        old.id, old.crew_id, old.provider,
        old.provider_workspace_id, old.provider_destination_id
      )
      and new.credential_ciphertext is null
      and new.credential_nonce is null
      and new.credential_key_version is null
      and new.credential_fingerprint is null
      and new.scopes = '{}'
    ) then
      raise exception 'Integration credentials are frozen while group deletion is pending.'
        using errcode = '55000';
    end if;
  end if;
  if old_quarantined or new_quarantined then
    if tg_op = 'INSERT'
       or (new.status = 'active' and old.status is distinct from 'active') then
      raise exception 'This restored group cannot activate an integration while quarantined.'
        using errcode = '55000';
    end if;
    if row(
      new.id, new.crew_id, new.provider, new.provider_workspace_id,
      new.provider_destination_id, new.credential_ciphertext,
      new.credential_nonce, new.credential_key_version,
      new.credential_fingerprint, new.scopes
    ) is distinct from row(
      old.id, old.crew_id, old.provider, old.provider_workspace_id,
      old.provider_destination_id, old.credential_ciphertext,
      old.credential_nonce, old.credential_key_version,
      old.credential_fingerprint, old.scopes
    ) and not (
      new.status = 'revoked'
      and row(
        new.id, new.crew_id, new.provider,
        new.provider_workspace_id, new.provider_destination_id
      ) is not distinct from row(
        old.id, old.crew_id, old.provider,
        old.provider_workspace_id, old.provider_destination_id
      )
      and new.credential_ciphertext is null
      and new.credential_nonce is null
      and new.credential_key_version is null
      and new.credential_fingerprint is null
      and new.scopes = '{}'
    ) then
      raise exception 'This restored group cannot change an integration while quarantined.'
        using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;

create trigger block_quarantined_integration_destination_write
  before insert or update or delete on private.integration_destinations
  for each row execute function private.block_retired_community_quarantined_destination_write();

create function private.block_retired_community_quarantined_preference_write()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
begin
  if exists (
    select 1 from private.retired_community_dr_quarantined_crews quarantine
    where quarantine.crew_id = new.crew_id
  ) or exists (
    select 1 from private.retired_community_dr_quarantined_users quarantine
    where quarantine.user_id = new.user_id
  ) or (tg_op = 'UPDATE' and exists (
    select 1 from private.retired_community_dr_quarantined_crews quarantine
    where quarantine.crew_id = old.crew_id
  )) or (tg_op = 'UPDATE' and exists (
    select 1 from private.retired_community_dr_quarantined_users quarantine
    where quarantine.user_id = old.user_id
  )) then
    raise exception 'Outbound consent cannot be enabled while deletion reapplication is quarantined.'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger block_quarantined_outbound_preference_write
  before insert or update on public.outbound_update_preferences
  for each row execute function private.block_retired_community_quarantined_preference_write();

create function private.block_retired_community_quarantined_delivery_write()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
begin
  if new.status in ('queued', 'processing', 'retry')
     and (
       (new.subject_user_id is not null
        and private.retired_community_account_erasure_is_pending(new.subject_user_id))
       or (tg_op = 'UPDATE' and old.subject_user_id is not null
        and private.retired_community_account_erasure_is_pending(old.subject_user_id))
     ) then
    raise exception 'Outbound delivery is blocked while account erasure is pending.'
      using errcode = '55000';
  end if;
  if new.status in ('queued', 'processing', 'retry') and (
    exists (
      select 1 from private.retired_community_dr_quarantined_crews quarantine
      where quarantine.crew_id = new.crew_id
    ) or (
      new.subject_user_id is not null and exists (
        select 1 from private.retired_community_dr_quarantined_users quarantine
        where quarantine.user_id = new.subject_user_id
      )
    ) or (tg_op = 'UPDATE' and exists (
      select 1 from private.retired_community_dr_quarantined_crews quarantine
      where quarantine.crew_id = old.crew_id
    )) or (tg_op = 'UPDATE' and old.subject_user_id is not null and exists (
      select 1 from private.retired_community_dr_quarantined_users quarantine
      where quarantine.user_id = old.subject_user_id
    ))
  ) then
    raise exception 'Outbound delivery is blocked while deletion reapplication is quarantined.'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger block_quarantined_outbound_delivery_write
  before insert or update on private.outbound_deliveries
  for each row execute function private.block_retired_community_quarantined_delivery_write();

create function private.anonymize_retired_community_outbound_subject(target_user_id uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
begin
  update private.outbound_deliveries set
    status = 'cancelled', cancelled_at = clock_timestamp(),
    last_error_code = 'account_erasure',
    last_error_summary = 'Delivery cancelled because its subject account was erased.',
    lock_token = null, locked_at = null
  where subject_user_id = target_user_id
    and status in ('queued', 'processing', 'retry');
  update private.outbound_deliveries set
    subject_user_id = null, source_reference = null
  where subject_user_id = target_user_id;
end;
$$;

create policy "DR quarantine hides restored crews"
  on public.crews as restrictive for all to authenticated
  using (not public.retired_community_crew_is_quarantined(id))
  with check (not public.retired_community_crew_is_quarantined(id));

create policy "DR quarantine hides restored crew members"
  on public.crew_members as restrictive for all to authenticated
  using (not public.retired_community_crew_is_quarantined(crew_id))
  with check (not public.retired_community_crew_is_quarantined(crew_id));

create policy "DR quarantine hides restored crew invites"
  on public.crew_invites as restrictive for all to authenticated
  using (not public.retired_community_crew_is_quarantined(crew_id))
  with check (not public.retired_community_crew_is_quarantined(crew_id));

create policy "DR quarantine hides restored account feed activity"
  on public.community_feed_items as restrictive for all to authenticated
  using (not public.retired_community_user_is_quarantined(user_id))
  with check (not public.retired_community_user_is_quarantined(user_id));

create policy "DR quarantine hides restored account memberships"
  on public.crew_members as restrictive for all to authenticated
  using (not public.retired_community_user_is_quarantined(user_id))
  with check (not public.retired_community_user_is_quarantined(user_id));

create function public.export_retired_community_dr_ledger()
returns jsonb language sql stable security definer
set search_path = pg_catalog, private, pg_temp set timezone = 'UTC' as $$
  select coalesce(jsonb_agg(
    private.retired_community_manifest_payload(manifest.batch_id, manifest.executed_at)
      || jsonb_build_object('manifestSha256', manifest.manifest_sha256)
    order by manifest.executed_at, manifest.batch_id
  ), '[]'::jsonb)
  from private.retired_community_purge_manifests manifest;
$$;

create function public.import_retired_community_dr_manifest(
  target_manifest jsonb,
  target_imported_by text
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private, storage, auth, pg_temp as $$
declare source_batch private.retired_community_deletion_batches%rowtype;
declare source_proof private.retired_community_backup_proofs%rowtype;
declare source_approval private.retired_community_batch_approvals%rowtype;
declare source_batch_id uuid;
declare source_executed_at timestamptz;
declare expected_payload jsonb;
declare expected_manifest_sha text;
declare new_batch_id uuid := gen_random_uuid();
declare request_time timestamptz := clock_timestamp();
declare normalized_importer text := private.normalize_retired_community_operator(target_imported_by);
declare existing_batch_id uuid;
begin
  if jsonb_typeof(target_manifest) <> 'object'
     or not (target_manifest ?& array['batchId', 'executedAt', 'manifestSha256'])
     or char_length(normalized_importer) not between 3 and 160 then
    raise exception 'A redacted DR manifest and named importer are required.' using errcode = '22023';
  end if;
  source_batch_id := (target_manifest->>'batchId')::uuid;
  source_executed_at := (target_manifest->>'executedAt')::timestamptz;
  perform pg_advisory_xact_lock(hashtextextended('retired-community-deletion', 0));
  perform pg_advisory_xact_lock(hashtextextended('retired-community-orphan-scan', 0));
  select * into strict source_batch from private.retired_community_deletion_batches
    where id = source_batch_id and sealed;
  select * into strict source_proof from private.retired_community_backup_proofs
    where batch_id = source_batch.id;
  select * into strict source_approval from private.retired_community_batch_approvals
    where batch_id = source_batch.id;
  expected_payload := private.retired_community_manifest_payload(source_batch.id, source_executed_at);
  expected_manifest_sha := private.retired_community_sha256(expected_payload::text);
  if target_manifest - 'manifestSha256' is distinct from expected_payload
     or target_manifest->>'manifestSha256' is distinct from expected_manifest_sha then
    raise exception 'The DR manifest does not match the local sealed batch.' using errcode = '22023';
  end if;

  select reapplication.reapply_batch_id into existing_batch_id
  from private.retired_community_dr_reapplications reapplication
  where reapplication.source_batch_id = source_batch.id
    and reapplication.imported_manifest_sha256 = expected_manifest_sha;
  if existing_batch_id is not null then
    return private.retired_community_batch_result(existing_batch_id);
  end if;
  perform private.assert_retired_community_batch_evidence_complete(source_batch.id);
  if not exists (
    select 1 from private.retired_community_deletion_ledger
    where batch_id = source_batch.id and event_type = 'executed'
  ) then
    insert into private.retired_community_deletion_ledger
      (batch_id, event_type, actor, event_at, details)
    values (source_batch.id, 'executed', normalized_importer, source_executed_at,
      jsonb_build_object('reason', source_batch.reason, 'posts', source_batch.post_count,
        'comments', source_batch.comment_count, 'likes', source_batch.like_count,
        'objects', source_batch.object_count, 'credentials', source_batch.credential_count,
        'drLedgerImported', true));
  end if;
  perform private.record_retired_community_purge_manifest(
    source_batch.id,
    source_executed_at
  );
  if not exists (
    select 1 from private.retired_community_purge_manifests manifest
    where manifest.batch_id = source_batch.id
      and manifest.executed_at = source_executed_at
      and manifest.manifest_sha256 = expected_manifest_sha
  ) then
    raise exception 'The DR manifest conflicts with retained local purge evidence.'
      using errcode = '55000';
  end if;

  insert into private.retired_community_deletion_batches (
    id, reason, requested_by, requested_at, execute_after, deadline_at,
    subject_user_id, crew_id, t0_source_sha256, orphan_first_scan_id,
    orphan_second_scan_id
  ) values (
    new_batch_id, source_batch.reason, 'dr-ledger-reapply',
    case when source_batch.reason = 'group_deletion' then request_time - interval '30 days'
      else request_time end,
    request_time,
    case when source_batch.reason = 'account_erasure' then request_time + interval '24 hours' end,
    source_batch.subject_user_id, source_batch.crew_id, source_batch.t0_source_sha256,
    source_batch.orphan_first_scan_id, source_batch.orphan_second_scan_id
  );

  insert into private.retired_community_deletion_items
    (batch_id, item_kind, item_key, post_id, row_sha256)
  select new_batch_id, item_kind, item_key, post_id, row_sha256
  from private.retired_community_deletion_items where batch_id = source_batch.id;

  insert into private.retired_community_storage_work (
    batch_id, object_id, bucket_id, object_name, expected_row_sha256,
    status, confirmed_at
  )
  select new_batch_id, work.object_id, work.bucket_id, work.object_name,
    work.expected_row_sha256,
    case when object_row.id is null then 'confirmed' else 'queued' end,
    case when object_row.id is null then request_time end
  from private.retired_community_storage_work work
  left join storage.objects object_row
    on object_row.bucket_id = work.bucket_id and object_row.name = work.object_name
  where work.batch_id = source_batch.id;

  update private.integration_destinations destination set
    status = 'revoked', credential_ciphertext = null, credential_nonce = null,
    credential_key_version = null, credential_fingerprint = null, scopes = '{}',
    last_error_code = null, last_error_summary = null
  from private.retired_community_credential_work source_work
  where source_batch.reason = 'group_deletion'
    and source_work.batch_id = source_batch.id
    and source_work.destination_id = destination.id
    and destination.credential_ciphertext is null
    and destination.credential_nonce is null
    and destination.credential_key_version is null;

  insert into private.retired_community_credential_work (
    batch_id, destination_id, provider, expected_row_sha256, status, confirmed_at,
    provider_revocation_reference
  )
  select new_batch_id, work.destination_id, work.provider, work.expected_row_sha256,
    case when destination.id is null or destination.credential_ciphertext is null
      then 'confirmed' else 'queued' end,
    case when destination.id is null or destination.credential_ciphertext is null
      then request_time end,
    case when destination.id is null or destination.credential_ciphertext is null
      then 'dr-already-revoked' end
  from private.retired_community_credential_work work
  left join private.integration_destinations destination on destination.id = work.destination_id
  where work.batch_id = source_batch.id;

  update private.retired_community_deletion_batches set
    source_sha256 = source_batch.source_sha256,
    post_count = source_batch.post_count,
    comment_count = source_batch.comment_count,
    like_count = source_batch.like_count,
    object_count = source_batch.object_count,
    credential_count = source_batch.credential_count,
    sealed = true
  where id = new_batch_id;

  insert into private.retired_community_backup_proofs (
    batch_id, backup_name, backup_version, source_sha256, bundle_sha256,
    bundle_bytes, verified_by, verified_at
  ) values (
    new_batch_id, 'dr-ledger-reapply', 'manifest-v1', source_batch.source_sha256,
    source_proof.bundle_sha256, source_proof.bundle_bytes, 'dr-ledger-verifier', request_time
  );
  insert into private.retired_community_batch_approvals (
    batch_id, approved_by, approved_at, source_sha256, bundle_sha256,
    post_count, comment_count, like_count, object_count, credential_count
  ) values (
    new_batch_id, 'dr-ledger-approver', request_time, source_batch.source_sha256,
    source_proof.bundle_sha256, source_batch.post_count, source_batch.comment_count,
    source_batch.like_count, source_batch.object_count, source_batch.credential_count
  );
  insert into private.retired_community_deletion_ledger
    (batch_id, event_type, actor, event_at, details)
  values
    (new_batch_id, 'created', 'dr-ledger-reapply', request_time,
      jsonb_build_object('reason', source_batch.reason, 'posts', source_batch.post_count,
        'comments', source_batch.comment_count, 'likes', source_batch.like_count,
        'objects', source_batch.object_count, 'credentials', source_batch.credential_count)),
    (new_batch_id, 'backup_verified', 'dr-ledger-verifier', request_time,
      jsonb_build_object('sourceSha256', source_batch.source_sha256,
        'bundleSha256', source_proof.bundle_sha256, 'drLedgerImported', true)),
    (new_batch_id, 'approved', 'dr-ledger-approver', request_time,
      jsonb_build_object('sourceSha256', source_batch.source_sha256,
        'bundleSha256', source_proof.bundle_sha256, 'drLedgerImported', true));
  insert into private.retired_community_dr_reapplications (
    source_batch_id, reapply_batch_id, imported_manifest_sha256, imported_at
  ) values (source_batch.id, new_batch_id, expected_manifest_sha, request_time);

  if source_batch.reason = 'group_deletion' then
    insert into private.retired_community_dr_quarantined_crews (
      crew_id, source_batch_id, quarantined_at
    ) select source_batch.crew_id, source_batch.id, request_time
    where exists (select 1 from public.crews where id = source_batch.crew_id)
    on conflict (crew_id) do nothing;
    update private.integration_destinations set
      status = 'reconnect_required',
      last_error_code = 'dr_reapplication_quarantine',
      last_error_summary = 'Destination disabled while a restored purge is reapplied.'
    where crew_id = source_batch.crew_id and status = 'active';
    update private.outbound_deliveries set
      status = 'cancelled', cancelled_at = request_time,
      last_error_code = 'dr_reapplication_quarantine',
      last_error_summary = 'Delivery cancelled while a restored purge is reapplied.',
      lock_token = null, locked_at = null
    where crew_id = source_batch.crew_id and status in ('queued', 'processing', 'retry');
    delete from private.integration_oauth_states where crew_id = source_batch.crew_id;
    delete from private.pending_integration_connections where crew_id = source_batch.crew_id;
    delete from public.crew_invites where crew_id = source_batch.crew_id;
    delete from public.crew_members where crew_id = source_batch.crew_id;
  elsif source_batch.reason = 'account_erasure' then
    insert into private.retired_community_dr_quarantined_users (
      user_id, source_batch_id, quarantined_at
    ) select source_batch.subject_user_id, source_batch.id, request_time
    where exists (select 1 from auth.users where id = source_batch.subject_user_id)
    on conflict (user_id) do nothing;
    update auth.users set banned_until = 'infinity'::timestamptz
    where id = source_batch.subject_user_id;
    perform private.anonymize_retired_community_outbound_subject(
      source_batch.subject_user_id
    );
    delete from private.integration_oauth_states
      where initiated_by = source_batch.subject_user_id;
    delete from private.pending_integration_connections
      where initiated_by = source_batch.subject_user_id;
    delete from public.crew_invites where created_by = source_batch.subject_user_id;
    delete from public.crew_members where user_id = source_batch.subject_user_id;
    update public.crews set created_by = null
      where created_by = source_batch.subject_user_id;
    update private.integration_destinations set installed_by = null
      where installed_by = source_batch.subject_user_id;
  end if;
  return private.retired_community_batch_result(new_batch_id);
end;
$$;

create function private.guard_retired_community_orphan_scan_identity()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  if new.orphan_first_scan_id is distinct from old.orphan_first_scan_id
     or new.orphan_second_scan_id is distinct from old.orphan_second_scan_id then
    raise exception 'A deletion batch cannot change its orphan scan proof while sealing.'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger b_guard_retired_community_orphan_scan_identity
  before update on private.retired_community_deletion_batches
  for each row execute function private.guard_retired_community_orphan_scan_identity();

create function private.preflight_retired_community_work_claim()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
begin
  return new;
end;
$$;

create trigger preflight_retired_community_storage_claim
  before update of status on private.retired_community_storage_work
  for each row execute function private.preflight_retired_community_work_claim();
create trigger preflight_retired_community_credential_claim
  before update of status on private.retired_community_credential_work
  for each row execute function private.preflight_retired_community_work_claim();

create or replace function public.claim_retired_community_storage_work(
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
  perform private.assert_retired_community_batch_evidence_complete(batch_row.id);
  perform private.assert_retired_community_cascade_scope(batch_row.id);
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

create function public.verify_retired_community_storage_work(
  target_batch_id uuid,
  target_work_id uuid,
  target_worker_token uuid
)
returns boolean language plpgsql security definer
set search_path = pg_catalog, private, storage, pg_temp as $$
declare work_row private.retired_community_storage_work%rowtype;
begin
  select * into strict work_row from private.retired_community_storage_work
    where id = target_work_id and batch_id = target_batch_id for update;
  if work_row.status <> 'claimed' or work_row.claim_token is distinct from target_worker_token then
    raise exception 'Storage work is not claimed by this worker.' using errcode = '42501';
  end if;
  if private.retired_community_batch_status(work_row.batch_id) in ('cancelled', 'executed') then
    raise exception 'This deletion batch is terminal.' using errcode = '55000';
  end if;
  perform private.assert_retired_community_cascade_scope(work_row.batch_id);
  if not exists (
    select 1 from storage.objects object_row
    where object_row.bucket_id = work_row.bucket_id and object_row.name = work_row.object_name
      and private.retired_community_sha256(to_jsonb(object_row)::text) = work_row.expected_row_sha256
  ) then
    raise exception 'The Storage object no longer matches its claimed inventory.' using errcode = '55000';
  end if;
  return true;
end;
$$;

create or replace function public.claim_retired_community_credential_work(
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
    where id = target_batch_id and sealed;
  if batch_row.reason <> 'group_deletion' then
    return;
  end if;
  if not exists (select 1 from private.retired_community_backup_proofs where batch_id = batch_row.id)
     or not exists (select 1 from private.retired_community_batch_approvals where batch_id = batch_row.id)
     or clock_timestamp() < batch_row.execute_after
     or private.retired_community_batch_status(batch_row.id) in ('cancelled', 'executed') then
    raise exception 'This credential batch is not executable.' using errcode = '55000';
  end if;
  perform private.assert_retired_community_batch_evidence_complete(batch_row.id);
  perform private.assert_retired_community_cascade_scope(batch_row.id);
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

create function public.fail_retired_community_work(
  target_work_kind text,
  target_batch_id uuid,
  target_work_id uuid,
  target_worker_token uuid,
  target_error_code text
)
returns boolean language plpgsql security definer
set search_path = pg_catalog, private, pg_temp as $$
begin
  if target_work_kind = 'storage'
     and target_error_code = 'storage_retry_exhausted' then
    update private.retired_community_storage_work set
      status = 'queued', claim_token = null, claimed_at = null,
      last_failed_at = clock_timestamp(), last_error_code = target_error_code
    where id = target_work_id and batch_id = target_batch_id
      and status = 'claimed' and claim_token = target_worker_token;
    if found then return true; end if;
    if exists (
      select 1 from private.retired_community_storage_work
      where id = target_work_id and batch_id = target_batch_id
        and (status = 'confirmed'
          or (status = 'queued' and last_error_code = target_error_code))
    ) then return true; end if;
  elsif target_work_kind = 'credential'
        and target_error_code = 'credential_retry_exhausted' then
    update private.retired_community_credential_work set
      status = 'queued', claim_token = null, claimed_at = null,
      last_failed_at = clock_timestamp(), last_error_code = target_error_code
    where id = target_work_id and batch_id = target_batch_id
      and status = 'claimed' and claim_token = target_worker_token;
    if found then return true; end if;
    if exists (
      select 1 from private.retired_community_credential_work
      where id = target_work_id and batch_id = target_batch_id
        and (status = 'confirmed'
          or (status = 'queued' and last_error_code = target_error_code))
    ) then return true; end if;
  else
    raise exception 'Invalid retention work failure code.' using errcode = '22023';
  end if;
  raise exception 'Retention work is not claimed by this worker.' using errcode = '42501';
end;
$$;

create function public.retired_community_deletion_health()
returns jsonb language sql security definer
set search_path = pg_catalog, private, pg_temp as $$
  with active_batches as materialized (
    select batch_row.*
    from private.retired_community_deletion_batches batch_row
    where not exists (
      select 1 from private.retired_community_deletion_ledger terminal
      where terminal.batch_id = batch_row.id
        and terminal.event_type in ('cancelled', 'executed')
    )
  ), metrics as (
    select
      (select count(*) from active_batches) as active_batches,
      (select count(*)
        from private.retired_community_storage_work work
        join active_batches batch_row on batch_row.id = work.batch_id
        where work.status <> 'confirmed') as storage_pending,
      (select count(*)
        from private.retired_community_credential_work work
        join active_batches batch_row on batch_row.id = work.batch_id
        where work.status <> 'confirmed') as credential_pending,
      ((select count(*)
        from private.retired_community_storage_work work
        join active_batches batch_row on batch_row.id = work.batch_id
        where work.status = 'claimed'
          and work.claimed_at <= clock_timestamp() - interval '15 minutes')
       + (select count(*)
        from private.retired_community_credential_work work
        join active_batches batch_row on batch_row.id = work.batch_id
        where work.status = 'claimed'
          and work.claimed_at <= clock_timestamp() - interval '15 minutes')) as stale_claims,
      ((select count(*)
        from private.retired_community_storage_work work
        join active_batches batch_row on batch_row.id = work.batch_id
        where work.status <> 'confirmed' and work.last_failed_at is not null)
       + (select count(*)
        from private.retired_community_credential_work work
        join active_batches batch_row on batch_row.id = work.batch_id
        where work.status <> 'confirmed' and work.last_failed_at is not null)) as work_failures,
      ((select count(*)
        from private.retired_community_storage_work work
        join active_batches batch_row on batch_row.id = work.batch_id
        where work.status <> 'confirmed' and work.attempt_count >= 3)
       + (select count(*)
        from private.retired_community_credential_work work
        join active_batches batch_row on batch_row.id = work.batch_id
        where work.status <> 'confirmed' and work.attempt_count >= 3)) as repeated_failures,
      (select count(*) from active_batches batch_row
        where batch_row.reason = 'account_erasure'
          and batch_row.deadline_at <= clock_timestamp()) as account_erasures_overdue,
      (select count(*) from active_batches batch_row
        where batch_row.reason = 'account_erasure'
          and batch_row.deadline_at > clock_timestamp()
          and batch_row.deadline_at <= clock_timestamp() + interval '2 hours')
        as account_erasures_due_soon,
      (select count(*)
        from private.retired_community_purge_manifests manifest
        where manifest.executed_at + interval '30 days' <= clock_timestamp()
          and not exists (
            select 1 from private.retired_community_backup_reverifications verification
            where verification.batch_id = manifest.batch_id
          )) as backup_reverification_due,
      (select count(*) from private.retired_community_purge_manifests manifest
        where manifest.expires_at > clock_timestamp()
          and manifest.expires_at <= clock_timestamp() + interval '7 days')
        as manifests_expiring_soon,
      (select count(*) from private.retired_community_purge_manifests manifest
        where manifest.expires_at <= clock_timestamp()) as expired_manifests,
      (select count(*)
        from private.retired_community_deletion_batches batch_row
        join private.retired_community_deletion_ledger cancellation
          on cancellation.batch_id = batch_row.id and cancellation.event_type = 'cancelled'
        where cancellation.event_at + interval '180 days' <= clock_timestamp()
          and not exists (
            select 1 from private.retired_community_batch_identity_redactions redaction
            where redaction.batch_id = batch_row.id
          )) as cancelled_evidence_due,
      ((select count(*) from private.retired_community_t0_post_inventory)
       + (select count(*) from private.retired_community_t0_comment_inventory)
       + (select count(*) from private.retired_community_t0_like_inventory)
       + (select count(*) from private.retired_community_t0_object_inventory))
        as t0_identity_rows_retained,
      (select count(*) from private.retired_community_t0_purge_records)
        as t0_snapshot_purged,
      (select count(*) from private.retired_community_dr_reapplications
        where reapplied_at is null) as dr_reapplications_pending,
      (select count(*) from private.retired_community_dr_quarantined_crews)
        as dr_quarantined_crews,
      (select count(*) from private.retired_community_dr_quarantined_users)
        as dr_quarantined_users,
      (select count(*) from active_batches batch_row
        where batch_row.reason = 'orphan_cleanup' and batch_row.sealed
          and (batch_row.orphan_first_scan_id is null
            or batch_row.orphan_second_scan_id is null)) as legacy_orphan_batches
  )
  select jsonb_build_object(
    'status', case when
      metrics.stale_claims > 0
      or metrics.work_failures > 0
      or metrics.account_erasures_due_soon > 0
      or metrics.account_erasures_overdue > 0
      or metrics.backup_reverification_due > 0
      or metrics.manifests_expiring_soon > 0
      or metrics.expired_manifests > 0
      or metrics.cancelled_evidence_due > 0
      or metrics.dr_reapplications_pending > 0
      or metrics.dr_quarantined_crews > 0
      or metrics.dr_quarantined_users > 0
      or metrics.legacy_orphan_batches > 0
      then 'attention' else 'ok' end,
    'counts', jsonb_build_object(
      'activeBatches', metrics.active_batches,
      'storagePending', metrics.storage_pending,
      'credentialPending', metrics.credential_pending,
      'staleClaims', metrics.stale_claims,
      'workFailures', metrics.work_failures,
      'repeatedFailures', metrics.repeated_failures,
      'accountErasuresDueSoon', metrics.account_erasures_due_soon,
      'accountErasuresOverdue', metrics.account_erasures_overdue,
      'backupReverificationDue', metrics.backup_reverification_due,
      'manifestsExpiringSoon', metrics.manifests_expiring_soon,
      'expiredManifests', metrics.expired_manifests,
      'cancelledEvidenceDue', metrics.cancelled_evidence_due,
      't0IdentityRowsRetained', metrics.t0_identity_rows_retained,
      't0SnapshotPurged', metrics.t0_snapshot_purged,
      'drReapplicationsPending', metrics.dr_reapplications_pending,
      'drQuarantinedCrews', metrics.dr_quarantined_crews,
      'drQuarantinedUsers', metrics.dr_quarantined_users,
      'legacyOrphanBatches', metrics.legacy_orphan_batches
    ),
    'orphanScan', jsonb_build_object(
      'pairReady', exists (select 1 from private.retired_community_orphan_scan_pair()),
      'latestCompletedAt', (select max(scanned_at)
        from private.retired_community_orphan_scans)
    )
  ) from metrics;
$$;

create or replace function public.execute_retired_community_deletion_batch(
  target_batch_id uuid,
  target_operator text,
  target_confirmation text
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private, auth, pg_temp as $$
declare batch_row private.retired_community_deletion_batches%rowtype;
declare census_row private.retired_community_t0_census%rowtype;
declare executed_time timestamptz;
declare normalized_operator text := private.normalize_retired_community_operator(target_operator);
begin
  if target_confirmation is distinct from 'EXECUTE SEALED RETIRED COMMUNITY DELETION' then
    raise exception 'The exact destructive confirmation is required.' using errcode = '22023';
  end if;
  if char_length(normalized_operator) not between 3 and 160 then
    raise exception 'A named execution operator is required.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('retired-community-deletion', 0));
  select * into strict batch_row from private.retired_community_deletion_batches
    where id = target_batch_id and sealed for update;
  select * into strict census_row from private.retired_community_t0_census where singleton;
  if private.retired_community_batch_status(batch_row.id) = 'executed' then
    return private.retired_community_batch_result(batch_row.id);
  end if;
  if private.retired_community_batch_status(batch_row.id) <> 'ready' then
    raise exception 'The deletion batch is not ready.' using errcode = '55000';
  end if;
  perform private.assert_retired_community_batch_evidence_complete(batch_row.id);
  if batch_row.reason = 'aged_retention'
     and clock_timestamp() < census_row.captured_at + interval '91 days' then
    raise exception 'Aged retention cannot execute before T0 plus 91 days.' using errcode = '55000';
  end if;
  perform private.assert_retired_community_cascade_scope(batch_row.id);
  if exists (
    select 1 from private.retired_community_deletion_items item
    left join public.community_posts post_row
      on item.item_kind = 'post' and post_row.id = split_part(item.item_key, ':', 1)::uuid
    where item.batch_id = batch_row.id and item.item_kind = 'post'
      and ((post_row.id is not null
          and private.retired_community_sha256(to_jsonb(post_row)::text) <> item.row_sha256)
        or (post_row.id is null and not private.retired_community_item_was_executed(
          batch_row.id, item.item_kind, item.item_key, item.row_sha256)))
  ) or exists (
    select 1 from private.retired_community_deletion_items item
    left join public.post_comments comment_row
      on item.item_kind = 'comment' and comment_row.id = split_part(item.item_key, ':', 1)::uuid
    where item.batch_id = batch_row.id and item.item_kind = 'comment'
      and ((comment_row.id is not null
          and private.retired_community_sha256(to_jsonb(comment_row)::text) <> item.row_sha256)
        or (comment_row.id is null and not private.retired_community_item_was_executed(
          batch_row.id, item.item_kind, item.item_key, item.row_sha256)))
  ) or exists (
    select 1 from private.retired_community_deletion_items item
    left join public.post_likes like_row on item.item_kind = 'like'
      and like_row.post_id = item.post_id
      and like_row.user_id = split_part(item.item_key, ':', 2)::uuid
    where item.batch_id = batch_row.id and item.item_kind = 'like'
      and ((like_row.post_id is not null
          and private.retired_community_sha256(to_jsonb(like_row)::text) <> item.row_sha256)
        or (like_row.post_id is null and not private.retired_community_item_was_executed(
          batch_row.id, item.item_kind, item.item_key, item.row_sha256)))
  ) then
    raise exception 'A relational source row no longer matches the sealed batch.' using errcode = '55000';
  end if;

  if batch_row.reason = 'account_erasure' then
    perform private.anonymize_retired_community_outbound_subject(
      batch_row.subject_user_id
    );
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

  executed_time := clock_timestamp();
  insert into private.retired_community_deletion_ledger
    (batch_id, event_type, actor, event_at, details)
  values (batch_row.id, 'executed', normalized_operator, executed_time,
    jsonb_build_object('reason', batch_row.reason, 'posts', batch_row.post_count,
      'comments', batch_row.comment_count, 'likes', batch_row.like_count,
      'objects', batch_row.object_count, 'credentials', batch_row.credential_count));
  perform private.record_retired_community_purge_manifest(batch_row.id, executed_time);
  update private.retired_community_dr_reapplications set reapplied_at = executed_time
  where reapply_batch_id = batch_row.id and reapplied_at is null;
  return private.retired_community_batch_result(batch_row.id);
end;
$$;

create index retired_community_orphan_scans_scanned_idx
  on private.retired_community_orphan_scans (scanned_at desc);
create index retired_community_purge_manifests_expires_idx
  on private.retired_community_purge_manifests (expires_at);
create index retired_community_dr_reapplications_pending_idx
  on private.retired_community_dr_reapplications (imported_at)
  where reapplied_at is null;
create index retired_community_storage_failures_idx
  on private.retired_community_storage_work (last_failed_at desc)
  where status <> 'confirmed' and last_failed_at is not null;
create index retired_community_credential_failures_idx
  on private.retired_community_credential_work (last_failed_at desc)
  where status <> 'confirmed' and last_failed_at is not null;

revoke all on private.retired_community_orphan_scans
  from public, anon, authenticated, service_role;
revoke all on private.retired_community_orphan_scan_items
  from public, anon, authenticated, service_role;
revoke all on private.retired_community_orphan_scan_audit
  from public, anon, authenticated, service_role;
revoke all on private.retired_community_purge_manifests
  from public, anon, authenticated, service_role;
revoke all on private.retired_community_backup_reverifications
  from public, anon, authenticated, service_role;
revoke all on private.retired_community_t0_purge_records
  from public, anon, authenticated, service_role;
revoke all on private.retired_community_batch_identity_redactions
  from public, anon, authenticated, service_role;
revoke all on private.retired_community_dr_reapplications
  from public, anon, authenticated, service_role;
revoke all on private.retired_community_dr_quarantined_crews
  from public, anon, authenticated, service_role;
revoke all on private.retired_community_dr_quarantined_users
  from public, anon, authenticated, service_role;
revoke all on sequence private.retired_community_orphan_scan_audit_id_seq
  from public, anon, authenticated, service_role;

revoke all on function private.normalize_retired_community_operator(text)
  from public, anon, authenticated, service_role;
revoke all on function private.block_retired_community_t0_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.guard_retired_community_batch_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.block_retired_community_record_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.retired_community_evidence_is_releasable(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.guard_retired_community_item_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.guard_retired_community_work_delete()
  from public, anon, authenticated, service_role;
revoke all on function private.normalize_retired_community_batch_requester()
  from public, anon, authenticated, service_role;
revoke all on function private.normalize_retired_community_backup_verifier()
  from public, anon, authenticated, service_role;
revoke all on function private.normalize_retired_community_approver()
  from public, anon, authenticated, service_role;
revoke all on function private.normalize_retired_community_ledger_actor()
  from public, anon, authenticated, service_role;
revoke all on function private.record_retired_community_work_attempt()
  from public, anon, authenticated, service_role;
revoke all on function private.normalize_retired_community_created_ledger_counts()
  from public, anon, authenticated, service_role;
revoke all on function private.retired_community_item_was_executed(uuid,text,text,text)
  from public, anon, authenticated, service_role;
revoke all on function private.retired_community_object_was_executed(uuid,text,text,text)
  from public, anon, authenticated, service_role;
revoke all on function private.assert_retired_community_batch_evidence_complete(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.assert_retired_community_cascade_scope(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.assert_retired_community_scope_when_sealed()
  from public, anon, authenticated, service_role;
revoke all on function private.add_retired_community_account_assets_when_sealing()
  from public, anon, authenticated, service_role;
revoke all on function private.lock_retired_community_mutation_scope_when_creating()
  from public, anon, authenticated, service_role;
revoke all on function private.confirm_retired_community_credentialless_when_sealing()
  from public, anon, authenticated, service_role;
revoke all on function private.cancel_retired_community_account_deliveries_when_sealing()
  from public, anon, authenticated, service_role;
revoke all on function private.block_retired_community_orphan_scan_audit_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.retired_community_orphan_scan_pair()
  from public, anon, authenticated, service_role;
revoke all on function private.preview_retired_community_orphan_deletion()
  from public, anon, authenticated, service_role;
revoke all on function private.create_retired_community_orphan_batch(text,timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function private.retired_community_manifest_payload(uuid,timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function private.record_retired_community_purge_manifest(uuid,timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function private.guard_retired_community_purge_manifest_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.block_retired_community_backup_reverification_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.block_retired_community_dr_reapplication_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.validate_retired_community_dr_quarantine()
  from public, anon, authenticated, service_role;
revoke all on function private.validate_retired_community_dr_user_quarantine()
  from public, anon, authenticated, service_role;
revoke all on function private.guard_retired_community_orphan_scan_identity()
  from public, anon, authenticated, service_role;
revoke all on function private.preflight_retired_community_work_claim()
  from public, anon, authenticated, service_role;
revoke all on function private.block_retired_community_quarantined_crew_write()
  from public, anon, authenticated, service_role;
revoke all on function private.block_retired_community_quarantined_user_membership_write()
  from public, anon, authenticated, service_role;
revoke all on function private.block_retired_community_quarantined_inviter_write()
  from public, anon, authenticated, service_role;
revoke all on function private.retired_community_account_erasure_is_pending(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.retired_community_group_deletion_is_pending(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.block_retired_community_pending_account_storage_write()
  from public, anon, authenticated, service_role;
revoke all on function private.block_retired_community_pending_image_reference()
  from public, anon, authenticated, service_role;
revoke all on function private.block_retired_community_quarantined_destination_write()
  from public, anon, authenticated, service_role;
revoke all on function private.block_retired_community_quarantined_preference_write()
  from public, anon, authenticated, service_role;
revoke all on function private.block_retired_community_quarantined_delivery_write()
  from public, anon, authenticated, service_role;
revoke all on function private.anonymize_retired_community_outbound_subject(uuid)
  from public, anon, authenticated, service_role;

revoke all on function public.record_retired_community_orphan_scan(uuid,text,jsonb)
  from public, anon, authenticated;
revoke all on function public.verify_retired_community_storage_work(uuid,uuid,uuid)
  from public, anon, authenticated;
revoke all on function public.verify_retired_community_backup_after_30_days(uuid,text,text,text)
  from public, anon, authenticated;
revoke all on function public.purge_expired_retired_community_manifests()
  from public, anon, authenticated;
revoke all on function public.retired_community_deletion_health()
  from public, anon, authenticated;
revoke all on function public.export_retired_community_dr_ledger()
  from public, anon, authenticated;
revoke all on function public.import_retired_community_dr_manifest(jsonb,text)
  from public, anon, authenticated;
revoke all on function public.fail_retired_community_work(text,uuid,uuid,uuid,text)
  from public, anon, authenticated;
revoke all on function public.retired_community_crew_is_quarantined(uuid)
  from public, anon, service_role;
revoke all on function public.retired_community_user_is_quarantined(uuid)
  from public, anon, service_role;
revoke all on function public.retired_community_current_account_erasure_is_pending()
  from public, anon, service_role;

grant execute on function public.record_retired_community_orphan_scan(uuid,text,jsonb)
  to service_role;
grant execute on function public.verify_retired_community_storage_work(uuid,uuid,uuid)
  to service_role;
grant execute on function public.verify_retired_community_backup_after_30_days(uuid,text,text,text)
  to service_role;
grant execute on function public.purge_expired_retired_community_manifests()
  to service_role;
grant execute on function public.retired_community_deletion_health()
  to service_role;
grant execute on function public.export_retired_community_dr_ledger()
  to service_role;
grant execute on function public.import_retired_community_dr_manifest(jsonb,text)
  to service_role;
grant execute on function public.fail_retired_community_work(text,uuid,uuid,uuid,text)
  to service_role;
grant execute on function public.retired_community_crew_is_quarantined(uuid)
  to authenticated;
grant execute on function public.retired_community_user_is_quarantined(uuid)
  to authenticated;
grant execute on function public.retired_community_current_account_erasure_is_pending()
  to authenticated;

comment on table private.retired_community_orphan_scans is
  'Complete exact community-post-images inventories; a scan may be atomically replaced only before batch binding.';
comment on table private.retired_community_purge_manifests is
  'Redacted count/digest-only purge manifests retained for exactly 180 days.';
comment on table private.retired_community_t0_purge_records is
  'Aggregate proof that direct identifiers and object paths were removed from the T0 inventory after the global aged-purge evidence window.';
comment on table private.retired_community_batch_identity_redactions is
  'Count/digest-only proof that requester, subject, crew, and operator identities were removed after exact evidence retention closed.';
comment on function public.record_retired_community_orphan_scan(uuid,text,jsonb) is
  'Worker-only atomic replacement of one complete, exact Storage bucket inventory.';
comment on function public.verify_retired_community_storage_work(uuid,uuid,uuid) is
  'Rechecks claimed Storage identity and metadata immediately before the worker calls the Storage API.';
comment on function public.export_retired_community_dr_ledger() is
  'Exports only redacted count/digest manifests for HMAC signing and off-platform DR custody.';
comment on function public.import_retired_community_dr_manifest(jsonb,text) is
  'Validates an Edge-verified DR manifest, quarantines restored product access, and creates an immediate reapplication batch.';
comment on function public.fail_retired_community_work(text,uuid,uuid,uuid,text) is
  'Worker-only release and durable aggregate telemetry after an exact Storage or credential claim exhausts retries.';
