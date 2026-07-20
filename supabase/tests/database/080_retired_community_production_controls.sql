begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(103);

select ok(exists (
  select 1 from supabase_migrations.schema_migrations where version = '20260720140000'
), 'the production deletion controls migration was replayed');
select ok(to_regclass('private.retired_community_orphan_scans') is not null,
  'complete orphan scan headers exist');
select ok(to_regclass('private.retired_community_orphan_scan_items') is not null,
  'exact orphan scan identities exist');
select ok(to_regclass('private.retired_community_purge_manifests') is not null,
  'redacted purge manifests exist');
select ok(to_regclass('private.retired_community_backup_reverifications') is not null,
  'post-purge backup reverifications exist');
select ok(to_regclass('private.retired_community_dr_reapplications') is not null,
  'DR reapplication state exists');
select ok(to_regclass('private.retired_community_t0_purge_records') is not null,
  'aggregate T0 identity-purge evidence exists');
select ok(to_regclass('private.retired_community_batch_identity_redactions') is not null,
  'aggregate batch identity-redaction evidence exists');
select ok(to_regclass('private.retired_community_dr_quarantined_users') is not null,
  'restored account erasures have a database quarantine');
select ok(not has_table_privilege('service_role',
  'private.retired_community_purge_manifests', 'select'),
  'service role cannot bypass the redacted manifest RPC');
select ok(not has_table_privilege('service_role',
  'private.retired_community_t0_purge_records', 'select'),
  'service role cannot read internal T0 purge proof directly');
select ok(not has_table_privilege('service_role',
  'private.retired_community_batch_identity_redactions', 'select'),
  'service role cannot read internal batch redaction proof directly');
select ok(has_function_privilege('service_role',
  'public.record_retired_community_orphan_scan(uuid,text,jsonb)', 'execute'),
  'the service worker can record a complete scan');
select ok(not has_function_privilege('authenticated',
  'public.record_retired_community_orphan_scan(uuid,text,jsonb)', 'execute'),
  'members cannot submit bucket inventories');
select ok(has_function_privilege('service_role',
  'public.verify_retired_community_storage_work(uuid,uuid,uuid)', 'execute'),
  'the service worker can perform the pre-delete metadata recheck');
select ok(not has_function_privilege('authenticated',
  'public.verify_retired_community_storage_work(uuid,uuid,uuid)', 'execute'),
  'members cannot invoke the pre-delete metadata recheck');
select ok(has_function_privilege('authenticated',
  'public.retired_community_crew_is_quarantined(uuid)', 'execute'),
  'authenticated RLS predicates can evaluate DR quarantine safely');
select ok(has_function_privilege('authenticated',
  'public.retired_community_user_is_quarantined(uuid)', 'execute'),
  'authenticated RLS predicates can evaluate restored-user quarantine safely');
select ok(has_function_privilege('service_role',
  'public.fail_retired_community_work(text,uuid,uuid,uuid,text)', 'execute'),
  'the worker can durably record exhausted work retries');
select ok(not has_function_privilege('authenticated',
  'public.fail_retired_community_work(text,uuid,uuid,uuid,text)', 'execute'),
  'members cannot release or rewrite retention work claims');
select ok((select proconfig @> array['search_path=pg_catalog, private, pg_temp']
  from pg_proc where oid = 'public.retired_community_deletion_health()'::regprocedure),
  'worker health uses a fixed pg_catalog-first search path');
select ok(not exists (
  select 1 from information_schema.columns
  where table_schema = 'private' and table_name = 'retired_community_purge_manifests'
    and column_name in ('body', 'content', 'email', 'object_name', 'attachment_path',
      'credential_ciphertext', 'credential_nonce')
), 'purge manifests contain no content, paths, identities, or credentials');
select ok(not exists (
  select 1 from information_schema.columns
  where table_schema = 'private' and table_name = 'retired_community_t0_purge_records'
    and column_name in ('author_id', 'user_id', 'owner_id', 'crew_id', 'object_name',
      'post_id', 'comment_id', 'referenced_post_ids')
), 'T0 purge proof retains no direct identity, path, or row key');
select ok(not exists (
  select 1 from information_schema.columns
  where table_schema = 'private'
    and table_name = 'retired_community_batch_identity_redactions'
    and column_name in ('requested_by', 'subject_user_id', 'crew_id', 'actor',
      'verified_by', 'approved_by')
), 'batch redaction proof retains no requester, subject, crew, or operator identity');

-- Supabase applies the deterministic seed after migrations. Rebuild the immutable
-- T0 fixture inside this rolled-back test so cascade assertions exercise the seed.
alter table private.retired_community_t0_census
  disable trigger block_retired_community_t0_census_mutation;
alter table private.retired_community_t0_post_inventory
  disable trigger block_retired_community_t0_post_mutation;
alter table private.retired_community_t0_comment_inventory
  disable trigger block_retired_community_t0_comment_mutation;
alter table private.retired_community_t0_like_inventory
  disable trigger block_retired_community_t0_like_mutation;
alter table private.retired_community_t0_object_inventory
  disable trigger block_retired_community_t0_object_mutation;
delete from private.retired_community_t0_census;
delete from private.retired_community_t0_post_inventory;
delete from private.retired_community_t0_comment_inventory;
delete from private.retired_community_t0_like_inventory;
delete from private.retired_community_t0_object_inventory;
insert into private.retired_community_t0_comment_inventory
select id, post_id, user_id, created_at,
  private.retired_community_sha256(to_jsonb(comment_row)::text)
from public.post_comments comment_row;
insert into private.retired_community_t0_like_inventory
select post_id, user_id, created_at,
  private.retired_community_sha256(to_jsonb(like_row)::text)
from public.post_likes like_row;
insert into private.retired_community_t0_object_inventory
select object_row.bucket_id, object_row.name, object_row.id, object_row.owner,
  coalesce((select array_agg(post_row.id order by post_row.id)
    from public.community_posts post_row
    where post_row.image_path = object_row.name), '{}'::uuid[]),
  private.retired_community_sha256(to_jsonb(object_row)::text)
from storage.objects object_row where object_row.bucket_id = 'community-post-images';
insert into private.retired_community_t0_post_inventory
select post_row.id, post_row.scope, post_row.author_id, post_row.crew_id,
  post_row.created_at,
  case when post_row.image_path is not null
    then private.retired_community_sha256(post_row.image_path) end,
  private.retired_community_sha256(to_jsonb(post_row)::text),
  private.retired_community_sha256(coalesce((select jsonb_agg(jsonb_build_array(
    child.kind, child.child_key, child.row_sha256)
    order by child.kind, child.child_key)::text
    from (
      select 'comment' kind, comment_item.comment_id::text child_key,
        comment_item.row_sha256
      from private.retired_community_t0_comment_inventory comment_item
      where comment_item.post_id = post_row.id
      union all
      select 'like', like_item.user_id::text, like_item.row_sha256
      from private.retired_community_t0_like_inventory like_item
      where like_item.post_id = post_row.id
    ) child), '[]')),
  (select object_item.row_sha256
    from private.retired_community_t0_object_inventory object_item
    where object_item.bucket_id = 'community-post-images'
      and object_item.object_name = post_row.image_path)
from public.community_posts post_row;
insert into private.retired_community_t0_census
select true, captured.t0, captured.t0 + interval '30 days',
  census.global_post_count, census.private_post_count, census.comment_count,
  census.like_count, census.referenced_image_count, census.bucket_object_count,
  census.missing_object_count, census.orphan_object_count, census.source_sha256
from private.compute_retired_community_census() census
cross join (select clock_timestamp() t0) captured;
alter table private.retired_community_t0_census
  enable trigger block_retired_community_t0_census_mutation;
alter table private.retired_community_t0_post_inventory
  enable trigger block_retired_community_t0_post_mutation;
alter table private.retired_community_t0_comment_inventory
  enable trigger block_retired_community_t0_comment_mutation;
alter table private.retired_community_t0_like_inventory
  enable trigger block_retired_community_t0_like_mutation;
alter table private.retired_community_t0_object_inventory
  enable trigger block_retired_community_t0_object_mutation;

insert into private.integration_destinations (
  id, crew_id, provider, provider_workspace_id, provider_destination_id,
  display_name, credential_ciphertext, credential_nonce, credential_key_version,
  credential_fingerprint, scopes, status, installed_by
) values (
  'f6440000-0000-4000-8000-000000000040',
  'a0000000-0000-4000-8000-000000000001', 'slack', 'T-F564', 'C-F564',
  'Retention test channel', decode(repeat('11', 17), 'hex'),
  decode(repeat('22', 12), 'hex'), 1, repeat('a', 64), array['chat:write'],
  'active', '10000000-0000-4000-8000-000000000001'
);
insert into private.outbound_deliveries (
  id, crew_id, destination_id, event_type, idempotency_key, payload, status,
  subject_user_id, source_reference
) values (
  'f6440000-0000-4000-8000-000000000043',
  'a0000000-0000-4000-8000-000000000001',
  'f6440000-0000-4000-8000-000000000040', 'check_in',
  'fou-564-account-erasure-pending', '{}'::jsonb, 'queued',
  '10000000-0000-4000-8000-000000000001', 'user:alice-pending'
);
insert into storage.objects (id, bucket_id, name, owner) values
  ('f6440000-0000-4000-8000-000000000030', 'profile-photos',
    '10000000-0000-4000-8000-000000000001/avatar.jpg',
    '10000000-0000-4000-8000-000000000001'),
  ('f6440000-0000-4000-8000-000000000031', 'journal-progress',
    '10000000-0000-4000-8000-000000000001/day-1.jpg',
    '10000000-0000-4000-8000-000000000001'),
  ('f6440000-0000-4000-8000-000000000032', 'community-post-images',
    'a0000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000001/orphan.jpg',
    '10000000-0000-4000-8000-000000000001');
create temp table account_preview as
select private.preview_retired_community_deletion(
  'account_erasure', '10000000-0000-4000-8000-000000000001', null
) result;
create temp table account_due_soon as
select private.create_retired_community_deletion_batch(
  'account_erasure', 'account-requester',
  '10000000-0000-4000-8000-000000000001', null,
  statement_timestamp() - interval '23 hours'
) batch_id;
select is(
  (select (result->'counts'->>'objects')::bigint from account_preview),
  (select batch_row.object_count from private.retired_community_deletion_batches batch_row
    where batch_row.id = (select batch_id from account_due_soon)),
  'account erasure dry-run object count matches the sealed full-asset inventory');
select ok((select count(*) = 2
  from private.retired_community_storage_work work
  where work.batch_id = (select batch_id from account_due_soon)
    and work.bucket_id in ('profile-photos', 'journal-progress')),
  'account erasure seals exact profile and journal Storage work');
select ok(exists (
  select 1 from private.retired_community_storage_work work
  where work.batch_id = (select batch_id from account_due_soon)
    and work.object_id = 'f6440000-0000-4000-8000-000000000032'
), 'account erasure includes subject-owned unreferenced Community uploads');
select ok((select status = 'cancelled' and last_error_code = 'account_erasure'
  from private.outbound_deliveries
  where id = 'f6440000-0000-4000-8000-000000000043'),
  'account erasure sealing cancels active outbound subject deliveries');
select throws_ok(
  $$ insert into private.outbound_deliveries (
    id, crew_id, destination_id, event_type, idempotency_key, payload, status,
    subject_user_id, source_reference
  ) values (
    'f6440000-0000-4000-8000-000000000044',
    'a0000000-0000-4000-8000-000000000001',
    'f6440000-0000-4000-8000-000000000040', 'check_in',
    'fou-564-account-erasure-late', '{}'::jsonb, 'queued',
    '10000000-0000-4000-8000-000000000001', 'user:alice-late') $$,
  '55000', 'Outbound delivery is blocked while account erasure is pending.',
  'new subject deliveries cannot enter the outbox during account erasure');
select throws_ok(
  $$ update private.outbound_deliveries
    set status = 'queued', subject_user_id = null, source_reference = null,
      cancelled_at = null, last_error_code = null, last_error_summary = null
    where id = 'f6440000-0000-4000-8000-000000000043' $$,
  '55000', 'Outbound delivery is blocked while account erasure is pending.',
  'an existing subject delivery cannot evade erasure by moving its identity');
select throws_ok(
  $$ insert into storage.objects (id, bucket_id, name, owner) values (
    'f6440000-0000-4000-8000-000000000033', 'profile-photos',
    '10000000-0000-4000-8000-000000000001/late-avatar.jpg',
    '10000000-0000-4000-8000-000000000001') $$,
  '55000', 'Storage assets are frozen while account erasure is pending.',
  'a pending account erasure cannot be made stale by a post-seal upload');
select is((public.retired_community_deletion_health()
  ->'counts'->>'accountErasuresDueSoon')::integer, 1,
  'health alerts when an active account erasure is within two hours of its deadline');
insert into private.retired_community_deletion_ledger
  (batch_id, event_type, actor, event_at, details)
select batch_id, 'cancelled', 'account-test-canceller', clock_timestamp(), '{}'::jsonb
from account_due_soon;
create temp table account_overdue as
select private.create_retired_community_deletion_batch(
  'account_erasure', 'account-requester-two',
  '10000000-0000-4000-8000-000000000001', null,
  statement_timestamp() - interval '25 hours'
) batch_id;
select is((public.retired_community_deletion_health()
  ->'counts'->>'accountErasuresOverdue')::integer, 1,
  'health alerts when an active account erasure has missed its 24-hour deadline');
select is(public.retired_community_deletion_health()->>'status', 'attention',
  'deadline and failure signals make health non-ok');

alter table private.retired_community_t0_object_inventory
  disable trigger block_retired_community_t0_object_mutation;
insert into private.retired_community_t0_object_inventory (
  bucket_id, object_name, object_id, owner_id, referenced_post_ids, row_sha256
)
select 'community-post-images', 'expired/reference.jpg',
  'f6440000-0000-4000-8000-000000000035',
  '10000000-0000-4000-8000-000000000001', array[inventory.post_id], repeat('8', 64)
from private.retired_community_t0_post_inventory inventory
order by inventory.post_id limit 1;
alter table private.retired_community_t0_object_inventory
  enable trigger block_retired_community_t0_object_mutation;

insert into private.retired_community_deletion_batches (
  id, reason, requested_by, requested_at, execute_after, t0_source_sha256
)
select 'f6440000-0000-4000-8000-000000000034', 'aged_retention',
  'expired-aged-retention', clock_timestamp(), clock_timestamp(), source_sha256
from private.retired_community_t0_census where singleton;
update private.retired_community_deletion_batches set
  source_sha256 = repeat('9', 64),
  post_count = (select count(*) from private.retired_community_t0_post_inventory),
  comment_count = (select count(*) from private.retired_community_t0_comment_inventory),
  like_count = (select count(*) from private.retired_community_t0_like_inventory),
  object_count = (select count(*) from private.retired_community_t0_object_inventory
    where cardinality(referenced_post_ids) > 0),
  credential_count = 0, sealed = true
where id = 'f6440000-0000-4000-8000-000000000034';
insert into private.retired_community_deletion_ledger
  (batch_id, event_type, actor, event_at, details)
values ('f6440000-0000-4000-8000-000000000034', 'executed',
  'expired-aged-retention', clock_timestamp(), '{}'::jsonb);
select ok((select private.retired_community_item_was_executed(
    (select batch_id from account_overdue), 'post', inventory.post_id::text,
    inventory.row_sha256)
  from private.retired_community_t0_post_inventory inventory
  order by inventory.post_id limit 1),
  'expired detailed evidence still retains exact T0 aged-execution knowledge');
select ok(private.retired_community_object_was_executed(
    (select batch_id from account_overdue), 'community-post-images',
    'expired/reference.jpg', repeat('8', 64)),
  'expired work evidence still retains exact referenced T0 object knowledge');

insert into private.retired_community_deletion_batches (
  id, reason, requested_by, requested_at, execute_after, t0_source_sha256
)
select 'f6440000-0000-4000-8000-000000000001', 'aged_retention',
  ' Request-Operator ', clock_timestamp(), clock_timestamp(), source_sha256
from private.retired_community_t0_census where singleton;
update private.retired_community_deletion_batches set
  source_sha256 = repeat('1', 64), post_count = 0, comment_count = 0,
  like_count = 0, object_count = 0, credential_count = 0, sealed = true
where id = 'f6440000-0000-4000-8000-000000000001';

select is((select requested_by from private.retired_community_deletion_batches
  where id = 'f6440000-0000-4000-8000-000000000001'), 'request-operator',
  'requester identity is case-folded and trimmed before sealing');
select throws_ok(
  $$ select public.record_retired_community_backup_proof(
    'f6440000-0000-4000-8000-000000000001', 'operator-backup', 'v1',
    repeat('1', 64), repeat('2', 64), 1024, ' REQUEST-OPERATOR ') $$,
  '42501', 'The backup verifier must be independent from the requester.',
  'case and whitespace cannot bypass requester/verifier independence');
select lives_ok(
  $$ select public.record_retired_community_backup_proof(
    'f6440000-0000-4000-8000-000000000001', 'operator-backup', 'v1',
    repeat('1', 64), repeat('2', 64), 1024, ' Backup-Operator ') $$,
  'an independent backup verifier can record proof');
select is((select verified_by from private.retired_community_backup_proofs
  where batch_id = 'f6440000-0000-4000-8000-000000000001'), 'backup-operator',
  'backup verifier identity is normalized');
select throws_ok(
  $$ select public.approve_retired_community_deletion_batch(
    'f6440000-0000-4000-8000-000000000001', ' BACKUP-OPERATOR ',
    repeat('1', 64), repeat('2', 64), 0, 0, 0, 0, 0) $$,
  '42501', 'The approver must be independent from the requester and backup verifier.',
  'case and whitespace cannot bypass verifier/approver independence');
select lives_ok(
  $$ select public.approve_retired_community_deletion_batch(
    'f6440000-0000-4000-8000-000000000001', ' Approval-Operator ',
    repeat('1', 64), repeat('2', 64), 0, 0, 0, 0, 0) $$,
  'a third normalized operator can approve the exact proof');
select is((select approved_by from private.retired_community_batch_approvals
  where batch_id = 'f6440000-0000-4000-8000-000000000001'), 'approval-operator',
  'approval identity is normalized');
insert into private.retired_community_deletion_ledger
  (batch_id, event_type, actor, event_at, details)
values ('f6440000-0000-4000-8000-000000000001', 'cancelled',
  ' Cancellation-Operator ', clock_timestamp(), '{}'::jsonb);
select throws_ok(
  $$ select public.approve_retired_community_deletion_batch(
    'f6440000-0000-4000-8000-000000000001', 'another-approver',
    repeat('1', 64), repeat('2', 64), 0, 0, 0, 0, 0) $$,
  '55000', 'A terminal deletion batch cannot be approved.',
  'approval is terminal after cancellation');
select is((select actor from private.retired_community_deletion_ledger
  where batch_id = 'f6440000-0000-4000-8000-000000000001'
    and event_type = 'cancelled'), 'cancellation-operator',
  'ledger operator identity is normalized');

insert into storage.objects (id, bucket_id, name, owner) values (
  'f6440000-0000-4000-8000-000000000010', 'community-post-images',
  'orphan/fou-564-p4.jpg', '30000000-0000-4000-8000-000000000003'
);

select throws_ok(
  $$ select public.record_retired_community_orphan_scan(
    'f6440000-0000-4000-8000-000000000011', 'scan-operator', '[]'::jsonb) $$,
  '55000', 'The worker inventory is not a complete exact bucket scan.',
  'an incomplete bucket inventory fails closed');
select throws_ok(
  $$ select public.record_retired_community_orphan_scan(
    'f6440000-0000-4000-8000-000000000011', 'scan-operator', null) $$,
  '22023', 'A scan ID and complete inventory array are required.',
  'a null scan inventory fails closed instead of becoming an empty scan');
select is((public.record_retired_community_orphan_scan(
  'f6440000-0000-4000-8000-000000000011', ' Scan-Operator ',
  (select jsonb_agg(jsonb_build_object(
    'objectId', id, 'bucketId', bucket_id, 'objectName', name) order by name)
   from storage.objects where bucket_id = 'community-post-images')
)->>'status'), 'complete', 'the first complete exact bucket scan is recorded');
select is((public.record_retired_community_orphan_scan(
  'f6440000-0000-4000-8000-000000000011', 'replacement-operator',
  (select jsonb_agg(jsonb_build_object(
    'objectId', id, 'bucketId', bucket_id, 'objectName', name) order by name)
   from storage.objects where bucket_id = 'community-post-images')
)->>'status'), 'complete', 'an unbound scan can be replaced atomically');
select is((select replacement_number from private.retired_community_orphan_scans
  where id = 'f6440000-0000-4000-8000-000000000011'), 1,
  'scan replacement is counted');
select is((select count(*)::integer from private.retired_community_orphan_scan_audit
  where scan_id = 'f6440000-0000-4000-8000-000000000011'), 2,
  'scan replacement retains both append-only audit events');
select throws_ok(
  $$ update private.retired_community_orphan_scan_audit set actor = 'tamper' $$,
  '55000', 'Retired Community orphan scan audit records are append-only.',
  'scan audit cannot be rewritten');

update private.retired_community_orphan_scans
set scanned_at = scanned_at - interval '8 days'
where id = 'f6440000-0000-4000-8000-000000000011';
select is((public.record_retired_community_orphan_scan(
  'f6440000-0000-4000-8000-000000000012', 'second-scan-operator',
  (select jsonb_agg(jsonb_build_object(
    'objectId', id, 'bucketId', bucket_id, 'objectName', name) order by name)
   from storage.objects where bucket_id = 'community-post-images')
)->>'status'), 'complete', 'a second complete exact scan is recorded after seven days');
select is((public.plan_orphan_retired_community_deletion('orphan-requester')->'counts'->>'objects')::integer,
  1, 'only the exact twice-unreferenced object is a dry-run candidate');

create temp table orphan_batch as
select public.plan_orphan_retired_community_deletion(' Orphan-Requester ', false) result;
select is((select result->>'status' from orphan_batch), 'awaiting_backup',
  'the two-scan protocol seals an explicit orphan batch');
select ok((select orphan_first_scan_id = 'f6440000-0000-4000-8000-000000000011'
    and orphan_second_scan_id = 'f6440000-0000-4000-8000-000000000012'
  from private.retired_community_deletion_batches
  where id = (select (result->>'batchId')::uuid from orphan_batch)),
  'the sealed batch binds both exact scan identities');
select throws_ok(
  $$ insert into public.community_posts (
    id, author_id, display_name, crew_id, scope, body, post_type,
    image_path, created_at, updated_at
  ) values (
    'f6440000-0000-4000-8000-000000000014',
    '20000000-0000-4000-8000-000000000002', 'Bob',
    'b0000000-0000-4000-8000-000000000002', 'crew',
    'late orphan reference', 'message', 'orphan/fou-564-p4.jpg',
    clock_timestamp(), clock_timestamp()) $$,
  '55000', 'Community image references are frozen while deletion is pending.',
  'a sealed Storage deletion path cannot acquire a new Community post reference');
select throws_ok(
  $$ select public.record_retired_community_orphan_scan(
    'f6440000-0000-4000-8000-000000000011', 'late-replacement',
    (select jsonb_agg(jsonb_build_object(
      'objectId', id, 'bucketId', bucket_id, 'objectName', name) order by name)
     from storage.objects where bucket_id = 'community-post-images')) $$,
  '55000', 'A scan bound to a deletion batch cannot be replaced.',
  'batch binding makes both scan proofs immutable');

do $orphan_proof$
declare batch_row private.retired_community_deletion_batches%rowtype;
begin
  select * into strict batch_row from private.retired_community_deletion_batches
  where id = (select (result->>'batchId')::uuid from orphan_batch);
  perform public.record_retired_community_backup_proof(
    batch_row.id, 'orphan-backup', 'v1', batch_row.source_sha256,
    repeat('3', 64), 2048, 'orphan-backup-verifier');
  perform public.approve_retired_community_deletion_batch(
    batch_row.id, 'orphan-approval-operator', batch_row.source_sha256,
    repeat('3', 64), batch_row.post_count, batch_row.comment_count,
    batch_row.like_count, batch_row.object_count, batch_row.credential_count);
end;
$orphan_proof$;
alter table public.community_posts
  disable trigger block_pending_retired_community_image_reference;
insert into public.community_posts (
  id, author_id, display_name, crew_id, scope, body, post_type,
  image_path, created_at, updated_at
) values (
  'f6440000-0000-4000-8000-000000000014',
  '20000000-0000-4000-8000-000000000002', 'Bob',
  'b0000000-0000-4000-8000-000000000002', 'crew',
  'privileged orphan drift', 'message', 'orphan/fou-564-p4.jpg',
  clock_timestamp(), clock_timestamp()
);
alter table public.community_posts
  enable trigger block_pending_retired_community_image_reference;
select throws_ok(
  $$ select * from public.claim_retired_community_storage_work(
    (select (result->>'batchId')::uuid from orphan_batch),
    'f6440000-0000-4000-8000-000000000013', 10) $$,
  '55000', 'Orphan deletion object acquired a current post reference.',
  'claim preflight catches a privileged reference that bypassed the freeze trigger');
delete from public.community_posts
where id = 'f6440000-0000-4000-8000-000000000014';
create temp table orphan_claim as
select * from public.claim_retired_community_storage_work(
  (select (result->>'batchId')::uuid from orphan_batch),
  'f6440000-0000-4000-8000-000000000013', 10
);
select is((select count(*)::integer from orphan_claim), 1,
  'the worker claims exactly the twice-scanned orphan');
select ok(public.verify_retired_community_storage_work(
  (select (result->>'batchId')::uuid from orphan_batch),
  (select work_id from orphan_claim),
  'f6440000-0000-4000-8000-000000000013'),
  'metadata is rechecked immediately before the Storage API boundary');
delete from storage.objects where id = 'f6440000-0000-4000-8000-000000000010';
select is((public.confirm_retired_community_storage_work(
  (select (result->>'batchId')::uuid from orphan_batch),
  (select work_id from orphan_claim),
  'f6440000-0000-4000-8000-000000000013', 'storage-worker'
)->>'status'), 'ready', 'absence is confirmed only after the Storage object is gone');
select is((public.execute_retired_community_deletion_batch(
  (select (result->>'batchId')::uuid from orphan_batch), 'execution-operator',
  'EXECUTE SEALED RETIRED COMMUNITY DELETION')->>'status'), 'executed',
  'the approved and fully confirmed orphan batch executes');

select ok(exists (
  select 1 from private.retired_community_purge_manifests
  where batch_id = (select (result->>'batchId')::uuid from orphan_batch)
    and expires_at = executed_at + interval '180 days'
    and manifest_sha256 ~ '^[0-9a-f]{64}$'
), 'execution creates a digest-only manifest for exactly 180 days');
select throws_ok(
  $$ update private.retired_community_purge_manifests set post_count = 99 $$,
  '55000', 'Retired Community purge manifests are immutable for 180 days.',
  'an unexpired purge manifest cannot be rewritten');
select throws_ok(
  $$ select public.verify_retired_community_backup_after_30_days(
    (select (result->>'batchId')::uuid from orphan_batch), repeat('3', 64),
    repeat('4', 64), 'age-verifier') $$,
  '55000', 'Backup age verification cannot be recorded before purge plus 30 days.',
  'backup age verification cannot be recorded early');

create temp table exported_manifest as
select manifest
from jsonb_array_elements(public.export_retired_community_dr_ledger()) as exported(manifest)
where manifest->>'batchId' = (select result->>'batchId' from orphan_batch);
select is((select count(*)::integer from exported_manifest), 1,
  'the executed purge is present in the DR ledger export');
select unlike((select manifest::text from exported_manifest), 'objectName',
  'the DR ledger contains no Storage path');
select unlike((select manifest::text from exported_manifest), 'credentialCiphertext',
  'the DR ledger contains no provider credential material');
select is((select manifest->'counts'->>'objects' from exported_manifest), '1',
  'the DR ledger preserves aggregate deletion evidence');
select throws_ok(
  $$ select public.import_retired_community_dr_manifest(
    (select jsonb_set(manifest, '{counts,objects}', '99'::jsonb) from exported_manifest),
    'dr-importer') $$,
  '22023', 'The DR manifest does not match the local sealed batch.',
  'a changed DR manifest cannot be reapplied');
create temp table dr_import as
select public.import_retired_community_dr_manifest(
  (select manifest from exported_manifest), ' DR-Importer ') result;
select is((select result->>'status' from dr_import), 'ready',
  'a verified DR manifest creates an immediate reapplication batch');
select is((public.import_retired_community_dr_manifest(
  (select manifest from exported_manifest), 'dr-importer')->>'batchId'),
  (select result->>'batchId' from dr_import),
  'reapplying the same signed manifest is idempotent');

alter table private.retired_community_purge_manifests
  disable trigger guard_retired_community_purge_manifest_mutation;
update private.retired_community_purge_manifests
set executed_at = statement_timestamp() - interval '31 days',
    expires_at = statement_timestamp() - interval '31 days' + interval '180 days'
where batch_id = (select (result->>'batchId')::uuid from orphan_batch);
alter table private.retired_community_purge_manifests
  enable trigger guard_retired_community_purge_manifest_mutation;
select is((public.verify_retired_community_backup_after_30_days(
  (select (result->>'batchId')::uuid from orphan_batch), repeat('3', 64),
  repeat('4', 64), ' Age-Verifier '
)->>'status'), 'executed', 'the same backup is reverified after purge plus 30 days');
select ok((select verifier_identity_sha256 ~ '^[0-9a-f]{64}$'
  from private.retired_community_backup_reverifications
  where batch_id = (select (result->>'batchId')::uuid from orphan_batch)),
  'post-purge verifier identity is retained only as a digest');
select throws_ok(
  $$ update private.retired_community_backup_reverifications
    set verification_reference_sha256 = repeat('5', 64) $$,
  '55000', 'Retired Community backup reverifications are append-only.',
  'post-purge verification evidence cannot be rewritten');

insert into private.outbound_deliveries (
  id, crew_id, destination_id, event_type, idempotency_key, payload, status,
  subject_user_id, source_reference
) values (
  'f6440000-0000-4000-8000-000000000041',
  'a0000000-0000-4000-8000-000000000001',
  'f6440000-0000-4000-8000-000000000040', 'check_in',
  'fou-564-account-erasure-history', '{}'::jsonb, 'delivered',
  '10000000-0000-4000-8000-000000000001', 'user:alice'
);
select private.anonymize_retired_community_outbound_subject(
  '10000000-0000-4000-8000-000000000001'
);
select ok((select subject_user_id is null and source_reference is null
  from private.outbound_deliveries
  where id = 'f6440000-0000-4000-8000-000000000041'),
  'account erasure removes subject identity from terminal outbound history');
insert into private.integration_destinations (
  id, crew_id, provider, provider_workspace_id, provider_destination_id,
  display_name, credential_ciphertext, credential_nonce, credential_key_version,
  credential_fingerprint, scopes, status, installed_by
) values (
  'f6440000-0000-4000-8000-000000000042',
  'a0000000-0000-4000-8000-000000000001', 'discord', 'G-F564', 'D-F564',
  'Already disconnected', null, null, null, null, '{}', 'disconnected',
  '10000000-0000-4000-8000-000000000001'
);
do $quarantine_source$
declare batch_id uuid;
begin
  batch_id := private.create_retired_community_deletion_batch(
    'group_deletion', 'dr-source-operator', null,
    'a0000000-0000-4000-8000-000000000001',
    clock_timestamp() - interval '30 days'
  );
  perform set_config('test.quarantine_source_batch_id', batch_id::text, true);
end;
$quarantine_source$;
select ok((select destination.status = 'revoked'
    and work.status = 'confirmed'
    and work.provider_revocation_reference = 'already-credentialless'
  from private.integration_destinations destination
  join private.retired_community_credential_work work
    on work.destination_id = destination.id
  where destination.id = 'f6440000-0000-4000-8000-000000000042'
    and work.batch_id = current_setting('test.quarantine_source_batch_id')::uuid),
  'normal group sealing safely confirms an already-credentialless destination');
select throws_ok(
  $$ update private.integration_destinations
    set crew_id = 'b0000000-0000-4000-8000-000000000002'
    where id = 'f6440000-0000-4000-8000-000000000040' $$,
  '55000', 'Integration credentials are frozen while group deletion is pending.',
  'a destination cannot move out of a sealed group deletion scope');
select throws_ok(
  $$ delete from private.integration_destinations
    where id = 'f6440000-0000-4000-8000-000000000040' $$,
  '55000', 'Integration credentials are frozen while group deletion is pending.',
  'a destination with unconfirmed revocation work cannot be deleted');
select throws_ok(
  $$ update private.integration_destinations set credential_fingerprint = repeat('b', 64)
    where id = 'f6440000-0000-4000-8000-000000000040' $$,
  '55000', 'Integration credentials are frozen while group deletion is pending.',
  'an immutable group deletion scope cannot be drifted during its 30-day window');
select throws_ok(
  $$ update private.integration_destinations set
      provider_workspace_id = 'T-EVADE', status = 'revoked',
      credential_ciphertext = null, credential_nonce = null,
      credential_key_version = null, credential_fingerprint = null, scopes = '{}'
    where id = 'f6440000-0000-4000-8000-000000000040' $$,
  '55000', 'Integration credentials are frozen while group deletion is pending.',
  'the provider identity cannot change during an otherwise valid revocation transition');
select lives_ok(
  $$ update private.integration_destinations
    set display_name = 'changed', last_verified_at = clock_timestamp()
    where id = 'f6440000-0000-4000-8000-000000000040' $$,
  'non-credential destination health metadata remains writable while deletion is pending');
insert into private.retired_community_deletion_ledger
  (batch_id, event_type, actor, event_at, details)
values (current_setting('test.quarantine_source_batch_id')::uuid,
  'executed', 'dr-source-operator', clock_timestamp(),
  jsonb_build_object('testFixture', true));
insert into private.retired_community_dr_quarantined_crews
  (crew_id, source_batch_id, quarantined_at)
values ('a0000000-0000-4000-8000-000000000001',
  current_setting('test.quarantine_source_batch_id')::uuid, clock_timestamp());
select lives_ok(
  $$ update private.integration_destinations set installed_by = null
    where id = 'f6440000-0000-4000-8000-000000000040' $$,
  'account erasure may clear installer identity on an already-active quarantined destination');
select throws_ok(
  $$ update private.integration_destinations
    set crew_id = 'b0000000-0000-4000-8000-000000000002'
    where id = 'f6440000-0000-4000-8000-000000000040' $$,
  '55000', 'This restored group cannot change an integration while quarantined.',
  'a destination cannot move out of a quarantined restored group');
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
set local "request.jwt.claims" =
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}';
select ok(public.retired_community_crew_is_quarantined(
  'a0000000-0000-4000-8000-000000000001'),
  'authenticated RLS can evaluate the security-definer quarantine predicate');
select is((select count(*)::integer from public.crews
  where id = 'a0000000-0000-4000-8000-000000000001'), 0,
  'a quarantined restored group is hidden from product access');
select is((select count(*)::integer from public.crew_members
  where crew_id = 'a0000000-0000-4000-8000-000000000001'), 0,
  'a quarantined restored membership is hidden from product access');
reset role;
select throws_ok(
  $$ insert into public.crew_members (
    crew_id, user_id, display_name, avatar_url, role
  ) values (
    'a0000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002', 'Bob', '', 'member'
  ) $$,
  '55000', 'This restored group is quarantined pending deletion reapplication.',
  'a table-owner or security-definer write cannot bypass restored-group quarantine');
delete from private.retired_community_dr_quarantined_crews
where crew_id = 'a0000000-0000-4000-8000-000000000001';

insert into private.retired_community_deletion_batches (
  id, reason, requested_by, requested_at, execute_after, t0_source_sha256
)
select 'f6440000-0000-4000-8000-000000000045', 'aged_retention',
  'cancelled-retention-requester', statement_timestamp() - interval '181 days',
  statement_timestamp() - interval '181 days', source_sha256
from private.retired_community_t0_census where singleton;
insert into private.retired_community_storage_work (
  id, batch_id, object_id, bucket_id, object_name, expected_row_sha256
) values (
  'f6440000-0000-4000-8000-000000000046',
  'f6440000-0000-4000-8000-000000000045',
  'f6440000-0000-4000-8000-000000000047',
  'community-post-images', 'cancelled/exact-evidence.jpg', repeat('7', 64)
);
update private.retired_community_deletion_batches set
  source_sha256 = (
    select private.retired_community_sha256(jsonb_agg(jsonb_build_array(
      'object', work.bucket_id || ':' || work.object_name,
      work.expected_row_sha256) order by work.bucket_id, work.object_name)::text)
    from private.retired_community_storage_work work
    where work.batch_id = 'f6440000-0000-4000-8000-000000000045'
  ),
  post_count = 0, comment_count = 0, like_count = 0,
  object_count = 1, credential_count = 0, sealed = true
where id = 'f6440000-0000-4000-8000-000000000045';
insert into private.retired_community_deletion_ledger (
  batch_id, event_type, actor, event_at, details
) values (
  'f6440000-0000-4000-8000-000000000045', 'cancelled',
  'cancelled-retention-operator', statement_timestamp() - interval '181 days', '{}'
);

alter table private.retired_community_purge_manifests
  disable trigger guard_retired_community_purge_manifest_mutation;
update private.retired_community_purge_manifests
set executed_at = statement_timestamp() - interval '181 days',
    expires_at = statement_timestamp() - interval '1 day'
where batch_id = (select (result->>'batchId')::uuid from orphan_batch);
alter table private.retired_community_purge_manifests
  enable trigger guard_retired_community_purge_manifest_mutation;
select is((public.purge_expired_retired_community_manifests()
  ->'counts'->>'manifestsDeleted')::integer, 0,
  'manifest maintenance retains source evidence while DR reapplication is pending');
select ok(exists (
  select 1 from private.retired_community_storage_work
  where batch_id = (select (result->>'batchId')::uuid from orphan_batch)
), 'a pending DR reapplication keeps the source exact-path evidence it needs');
select is((public.execute_retired_community_deletion_batch(
  (select (result->>'batchId')::uuid from dr_import), 'dr-execution-operator',
  'EXECUTE SEALED RETIRED COMMUNITY DELETION')->>'status'), 'executed',
  'the DR reapplication can complete using retained source evidence');
select is((public.purge_expired_retired_community_manifests()
  ->'counts'->>'manifestsDeleted')::integer, 1,
  'manifest maintenance expires source evidence after DR reapplication completes');
select ok(not exists (
  select 1 from private.retired_community_storage_work
  where batch_id = (select (result->>'batchId')::uuid from orphan_batch)
), 'manifest maintenance removes expired exact-path work evidence');
select ok(not exists (
  select 1 from private.retired_community_backup_reverifications
  where batch_id = (select (result->>'batchId')::uuid from orphan_batch)
), 'expired backup reverification evidence is removed with its manifest');
select is((select requested_by from private.retired_community_deletion_batches
  where id = (select (result->>'batchId')::uuid from orphan_batch)),
  'redacted-after-retention',
  'expired batch requester identity is replaced with a fixed sentinel');
select ok(not exists (
  select 1 from private.retired_community_backup_proofs proof
  where proof.batch_id = (select (result->>'batchId')::uuid from orphan_batch)
) and not exists (
  select 1 from private.retired_community_batch_approvals approval
  where approval.batch_id = (select (result->>'batchId')::uuid from orphan_batch)
), 'expired backup and approval operator identities are removed');
select ok(not exists (
  select 1 from private.retired_community_deletion_ledger ledger
  where ledger.batch_id = (select (result->>'batchId')::uuid from orphan_batch)
    and ledger.actor <> 'redacted-after-retention'
), 'expired ledger operator identities are replaced with a fixed sentinel');
select ok(not exists (
  select 1 from private.retired_community_storage_work
  where batch_id = 'f6440000-0000-4000-8000-000000000045'
), 'cancelled batch exact work is removed at cancellation plus 180 days');
select is((select requested_by from private.retired_community_deletion_batches
  where id = 'f6440000-0000-4000-8000-000000000045'),
  'redacted-after-retention',
  'cancelled batch requester identity is redacted at its retention boundary');
select ok(exists (
  select 1 from private.retired_community_batch_identity_redactions
  where batch_id = 'f6440000-0000-4000-8000-000000000045'
), 'cancelled batch cleanup leaves aggregate redaction proof');
select ok(public.retired_community_deletion_health() ?&
  array['status', 'counts', 'orphanScan'],
  'health exposes only aggregate operational signals');

insert into public.community_posts (
  id, author_id, display_name, crew_id, scope, body, post_type, created_at, updated_at
) values (
  'f6440000-0000-4000-8000-000000000020',
  '10000000-0000-4000-8000-000000000001', 'Alice',
  'a0000000-0000-4000-8000-000000000001', 'crew',
  'post-T0 cascade drift', 'message', clock_timestamp(), clock_timestamp()
);
select throws_ok(
  $$ select private.create_retired_community_deletion_batch(
    'group_deletion', 'group-operator', null,
    'a0000000-0000-4000-8000-000000000001',
    clock_timestamp() - interval '30 days') $$,
  '55000', 'Group deletion would cascade beyond its sealed relational manifest.',
  'a post-T0 cascade row makes group batch sealing fail closed');

select * from finish();
rollback;
