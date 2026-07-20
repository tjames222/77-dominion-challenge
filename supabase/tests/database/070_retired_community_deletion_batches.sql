begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(64);

select ok(to_regclass('private.retired_community_deletion_batches') is not null, 'sealed deletion batches exist');
select ok(to_regclass('private.retired_community_deletion_items') is not null, 'exact relational items exist');
select ok(to_regclass('private.retired_community_backup_proofs') is not null, 'named backup proofs exist');
select ok(to_regclass('private.retired_community_batch_approvals') is not null, 'independent approvals exist');
select ok(to_regclass('private.retired_community_deletion_ledger') is not null, 'append-only deletion ledger exists');
select ok(not has_table_privilege('service_role', 'private.retired_community_deletion_batches', 'select'),
  'service role cannot bypass sealed batch RPCs');
select ok(has_function_privilege('service_role',
  'public.claim_retired_community_storage_work(uuid,uuid,integer)', 'execute'), 'only the worker surface exposes exact paths');
select ok(not has_function_privilege('authenticated',
  'public.execute_retired_community_deletion_batch(uuid,text,text)', 'execute'), 'members cannot execute batches');
select ok((select proconfig[1] = 'search_path=pg_catalog, public, private, pg_temp'
  from pg_proc where oid = 'public.plan_aged_retired_community_deletion(text,boolean)'::regprocedure),
  'security-definer search paths start with pg_catalog');
select ok((select confdeltype = 'n' from pg_constraint where conname = 'crews_created_by_fkey'),
  'account deletion sets crew creator attribution to null');
select ok((select confdeltype = 'n' from pg_constraint
  where conname = 'integration_destinations_installed_by_fkey'),
  'account deletion sets integration installer attribution to null');
select throws_ok(
  $$ insert into private.retired_community_deletion_batches (
    reason, requested_by, requested_at, execute_after, t0_source_sha256, source_sha256, sealed
  ) values (
    'orphan_cleanup', 'constraint-test', clock_timestamp(), clock_timestamp(), repeat('0', 64),
    repeat('1', 64), true
  ) $$,
  '55000', 'Retired Community deletion batches must be assembled before sealing.',
  'a batch cannot bypass the assemble-then-seal lifecycle');
select throws_ok(
  $$ do $incomplete_batch$
    begin
      insert into private.retired_community_deletion_batches (
        id, reason, requested_by, requested_at, execute_after, t0_source_sha256
      ) values (
        'f6420000-0000-4000-8000-0000000000ff', 'orphan_cleanup', 'constraint-test',
        clock_timestamp(), clock_timestamp(), repeat('0', 64)
      );
      update private.retired_community_deletion_batches
      set source_sha256 = repeat('1', 64), sealed = true
      where id = 'f6420000-0000-4000-8000-0000000000ff';
    end;
  $incomplete_batch$ $$,
  '55000', 'A sealed deletion batch requires a digest and all five non-negative counts.',
  'a sealed batch requires all five complete counts');

insert into public.post_comments (id, post_id, user_id, display_name, body, created_at, updated_at) values
  ('f6420000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001', 'Alice', 'Alice on Bob', now(), now()),
  ('f6420000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002', 'Bob', 'Bob on Alice', now(), now());
insert into public.post_likes (post_id, user_id, created_at) values
  ('b2000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', now()),
  ('a2000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', now());
update public.community_posts set
  image_path = 'a0000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000001/account.jpg',
  image_alt = 'Alice account image'
where id = 'a2000000-0000-4000-8000-000000000001';
insert into storage.objects (id, bucket_id, name, owner) values (
  'f6420000-0000-4000-8000-000000000003', 'community-post-images',
  'a0000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000001/account.jpg',
  '10000000-0000-4000-8000-000000000001'
);
insert into public.journal_entries (id, user_id, entry_date, note) values
  ('f6420000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', '2026-07-02', 'Alice private journal'),
  ('f6420000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000002', '2026-07-02', 'Bob private journal');
insert into private.integration_destinations (
  id, crew_id, provider, provider_workspace_id, provider_destination_id, display_name,
  credential_ciphertext, credential_nonce, credential_key_version, credential_fingerprint,
  scopes, status, installed_by
) values
  ('f6420000-0000-4000-8000-000000000006', 'a0000000-0000-4000-8000-000000000001',
    'slack', 'alpha-workspace', 'alpha-channel', 'Alpha Slack', decode(repeat('ab', 17), 'hex'),
    decode(repeat('cd', 12), 'hex'), 1, repeat('a', 64), array['chat:write'], 'active',
    '10000000-0000-4000-8000-000000000001'),
  ('f6420000-0000-4000-8000-000000000007', 'b0000000-0000-4000-8000-000000000002',
    'discord', 'bravo-workspace', 'bravo-channel', 'Bravo Discord', decode(repeat('ef', 17), 'hex'),
    decode(repeat('12', 12), 'hex'), 1, repeat('b', 64), array['messages.write'], 'active',
    '20000000-0000-4000-8000-000000000002');

alter table private.retired_community_t0_census disable trigger block_retired_community_t0_census_mutation;
alter table private.retired_community_t0_post_inventory disable trigger block_retired_community_t0_post_mutation;
alter table private.retired_community_t0_comment_inventory disable trigger block_retired_community_t0_comment_mutation;
alter table private.retired_community_t0_like_inventory disable trigger block_retired_community_t0_like_mutation;
alter table private.retired_community_t0_object_inventory disable trigger block_retired_community_t0_object_mutation;
delete from private.retired_community_t0_census;
delete from private.retired_community_t0_post_inventory;
delete from private.retired_community_t0_comment_inventory;
delete from private.retired_community_t0_like_inventory;
delete from private.retired_community_t0_object_inventory;
insert into private.retired_community_t0_comment_inventory
select id, post_id, user_id, created_at, private.retired_community_sha256(to_jsonb(comment_row)::text)
from public.post_comments comment_row;
insert into private.retired_community_t0_like_inventory
select post_id, user_id, created_at, private.retired_community_sha256(to_jsonb(like_row)::text)
from public.post_likes like_row;
insert into private.retired_community_t0_object_inventory
select object_row.bucket_id, object_row.name, object_row.id, object_row.owner,
  coalesce((select array_agg(post_row.id order by post_row.id) from public.community_posts post_row
    where post_row.image_path = object_row.name), '{}'::uuid[]),
  private.retired_community_sha256(to_jsonb(object_row)::text)
from storage.objects object_row where object_row.bucket_id = 'community-post-images';
insert into private.retired_community_t0_post_inventory
select post_row.id, post_row.scope, post_row.author_id, post_row.crew_id, post_row.created_at,
  case when post_row.image_path is not null then private.retired_community_sha256(post_row.image_path) end,
  private.retired_community_sha256(to_jsonb(post_row)::text), repeat('0', 64),
  (select object_item.row_sha256 from private.retired_community_t0_object_inventory object_item
    where object_item.object_name = post_row.image_path)
from public.community_posts post_row;
insert into private.retired_community_t0_census
select true, capture.t0, capture.t0 + interval '30 days',
  census.global_post_count, census.private_post_count, census.comment_count, census.like_count,
  census.referenced_image_count, census.bucket_object_count, census.missing_object_count,
  census.orphan_object_count, census.source_sha256
from private.compute_retired_community_census() census
cross join (select clock_timestamp() - interval '90 days' t0) capture;
alter table private.retired_community_t0_census enable trigger block_retired_community_t0_census_mutation;
alter table private.retired_community_t0_post_inventory enable trigger block_retired_community_t0_post_mutation;
alter table private.retired_community_t0_comment_inventory enable trigger block_retired_community_t0_comment_mutation;
alter table private.retired_community_t0_like_inventory enable trigger block_retired_community_t0_like_mutation;
alter table private.retired_community_t0_object_inventory enable trigger block_retired_community_t0_object_mutation;

select is((public.plan_aged_retired_community_deletion('retention-operator')->>'status'), 'dry_run',
  'aged retention defaults to a non-mutating dry run');
select is((select count(*)::integer from private.retired_community_deletion_batches), 0,
  'aged dry run creates no batch');
select throws_ok(
  $$ select public.plan_aged_retired_community_deletion('retention-operator', false) $$,
  '55000', 'Aged retention cannot begin before T0 plus 91 days.', 'day 90 cannot create an aged batch');
alter table private.retired_community_t0_census disable trigger block_retired_community_t0_census_mutation;
update private.retired_community_t0_census set
  captured_at = timing.t0,
  member_export_ends_at = timing.t0 + interval '30 days'
from (select clock_timestamp() - interval '91 days 1 minute' t0) timing;
alter table private.retired_community_t0_census enable trigger block_retired_community_t0_census_mutation;
create temp table aged_batch as
select public.plan_aged_retired_community_deletion('retention-operator', false) result;
select is((select result->>'status' from aged_batch), 'awaiting_backup', 'day 91 can seal an aged batch');
select is((select count(*)::bigint from private.retired_community_deletion_items
  where batch_id = (select (result->>'batchId')::uuid from aged_batch)),
  (select post_count + comment_count + like_count from private.retired_community_deletion_batches
    where id = (select (result->>'batchId')::uuid from aged_batch)), 'aged items come only from the exact T0 inventories');

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
set local "request.jwt.claims" = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is(public.request_retired_community_account_erasure()->>'status', 'dry_run',
  'account erasure defaults to dry run');
select ok((select array_agg(key order by key) = array['batchId','counts','status']
  from jsonb_object_keys(public.request_retired_community_account_erasure()) key),
  'account dry-run output has only opaque allowlisted keys');
do $account_request$
declare response jsonb;
begin
  response := public.request_retired_community_account_erasure(false);
  perform set_config('test.account_batch_id', response->>'batchId', true);
end;
$account_request$;
reset role;

select is((select deadline_at from private.retired_community_deletion_batches
  where id = current_setting('test.account_batch_id')::uuid),
  (select requested_at + interval '24 hours' from private.retired_community_deletion_batches
    where id = current_setting('test.account_batch_id')::uuid), 'account erasure deadline is exactly 24 hours');
select is((select post_count from private.retired_community_deletion_batches
  where id = current_setting('test.account_batch_id')::uuid), 1, 'account scope has only Alice authored post');
select is((select object_count from private.retired_community_deletion_batches
  where id = current_setting('test.account_batch_id')::uuid), 1, 'account scope has only Alice exact image object');
select throws_ok(
  $$ update private.retired_community_deletion_batches set post_count = 99
    where id = current_setting('test.account_batch_id')::uuid $$,
  '55000', 'Retired Community deletion batches are immutable.', 'sealed batch scope cannot be rewritten');
select throws_ok(
  $$ delete from private.retired_community_deletion_items
    where batch_id = current_setting('test.account_batch_id')::uuid $$,
  '55000', 'Retired Community deletion items are immutable.', 'sealed exact items cannot be deleted');
select throws_ok(
  $$ select public.record_retired_community_backup_proof(
    current_setting('test.account_batch_id')::uuid, 'account-backup', 'v1', repeat('0',64),
    repeat('b',64), 1024, 'backup-verifier') $$,
  '22023', 'Backup source digest does not match the sealed batch.', 'backup proof rejects a mismatched source digest');
do $account_backup$
declare batch_row private.retired_community_deletion_batches%rowtype;
begin
  select * into strict batch_row from private.retired_community_deletion_batches
    where id = current_setting('test.account_batch_id')::uuid;
  perform public.record_retired_community_backup_proof(
    batch_row.id, 'account-backup', 'v1', batch_row.source_sha256,
    repeat('b',64), 1024, 'backup-verifier');
end;
$account_backup$;
select throws_ok(
  $$ select public.approve_retired_community_deletion_batch(
    batch_row.id, batch_row.requested_by, batch_row.source_sha256, repeat('b',64),
    batch_row.post_count, batch_row.comment_count, batch_row.like_count,
    batch_row.object_count, batch_row.credential_count)
    from private.retired_community_deletion_batches batch_row
    where batch_row.id = current_setting('test.account_batch_id')::uuid $$,
  '42501', 'The approver must be independent from the requester and backup verifier.',
  'the account requester cannot self-approve');
select throws_ok(
  $$ select public.approve_retired_community_deletion_batch(
    batch_row.id, 'independent-approver', repeat('0',64), repeat('b',64),
    batch_row.post_count, batch_row.comment_count, batch_row.like_count,
    batch_row.object_count, batch_row.credential_count)
    from private.retired_community_deletion_batches batch_row
    where batch_row.id = current_setting('test.account_batch_id')::uuid $$,
  '22023', 'Approval digests do not match the sealed batch and verified backup.',
  'approval rejects mismatched proof digests');
select throws_ok(
  $$ select public.approve_retired_community_deletion_batch(
    batch_row.id, 'independent-approver', batch_row.source_sha256, repeat('b',64),
    batch_row.post_count + 1, batch_row.comment_count, batch_row.like_count,
    batch_row.object_count, batch_row.credential_count)
    from private.retired_community_deletion_batches batch_row
    where batch_row.id = current_setting('test.account_batch_id')::uuid $$,
  '22023', 'Approval counts do not match the sealed batch.', 'approval is bound to exact counts');
do $account_approval$
declare batch_row private.retired_community_deletion_batches%rowtype;
begin
  select * into strict batch_row from private.retired_community_deletion_batches
    where id = current_setting('test.account_batch_id')::uuid;
  perform public.approve_retired_community_deletion_batch(
    batch_row.id, 'independent-approver', batch_row.source_sha256, repeat('b',64),
    batch_row.post_count, batch_row.comment_count, batch_row.like_count,
    batch_row.object_count, batch_row.credential_count);
end;
$account_approval$;
select throws_ok(
  $$ select public.execute_retired_community_deletion_batch(
    current_setting('test.account_batch_id')::uuid, 'execution-operator',
    'EXECUTE SEALED RETIRED COMMUNITY DELETION') $$,
  '55000', 'The deletion batch is not ready.', 'relational deletion waits for real Storage confirmation');

create temp table account_storage_claim as
select * from public.claim_retired_community_storage_work(
  current_setting('test.account_batch_id')::uuid,
  'f6420000-0000-4000-8000-000000000008', 10
);
select is((select count(*)::integer from account_storage_claim), 1, 'worker claims the exact account object');
select like((select object_name from account_storage_claim), '%/account.jpg',
  'only the worker claim exposes the exact Storage path');
delete from storage.objects where id = 'f6420000-0000-4000-8000-000000000003';
select ok((select array_agg(key order by key) = array['batchId','counts','status']
  from jsonb_object_keys(public.confirm_retired_community_storage_work(
    current_setting('test.account_batch_id')::uuid,
    (select work_id from account_storage_claim),
    'f6420000-0000-4000-8000-000000000008', 'storage-worker')) key),
  'Storage confirmation returns only opaque allowlisted keys');
select ok(not exists (select 1 from storage.objects
  where id = 'f6420000-0000-4000-8000-000000000003'),
  'the worker removes the real object before SQL can delete relational rows');
select throws_ok(
  $$ select public.execute_retired_community_deletion_batch(
    current_setting('test.account_batch_id')::uuid, 'execution-operator', 'wrong') $$,
  '22023', 'The exact destructive confirmation is required.', 'execution requires exact confirmation');
select is(public.execute_retired_community_deletion_batch(
  current_setting('test.account_batch_id')::uuid, 'execution-operator',
  'EXECUTE SEALED RETIRED COMMUNITY DELETION')->>'status', 'executed',
  'approved account erasure executes after object confirmation');
select ok((select array_agg(key order by key) = array['batchId','counts','status']
  from jsonb_object_keys(public.execute_retired_community_deletion_batch(
    current_setting('test.account_batch_id')::uuid, 'execution-operator',
    'EXECUTE SEALED RETIRED COMMUNITY DELETION')) key),
  'idempotent execute output has only opaque allowlisted keys');
select ok(not exists (select 1 from auth.users where id = '10000000-0000-4000-8000-000000000001'),
  'account erasure removes the subject account');
select ok(exists (select 1 from auth.users where id = '20000000-0000-4000-8000-000000000002'),
  'account erasure preserves another account');
select ok(exists (select 1 from public.crews where id = 'a0000000-0000-4000-8000-000000000001'),
  'account erasure preserves the subject-created group');
select ok((select created_by is null from public.crews where id = 'a0000000-0000-4000-8000-000000000001'),
  'preserved group creator attribution is nulled safely');
select ok((select installed_by is null and status = 'active' from private.integration_destinations
  where id = 'f6420000-0000-4000-8000-000000000006'),
  'unrelated group integration survives with installer attribution nulled');
select ok(exists (select 1 from public.community_posts where id = 'b2000000-0000-4000-8000-000000000002'),
  'another member post is preserved');
select ok(not exists (select 1 from public.post_comments where id = 'f6420000-0000-4000-8000-000000000001'),
  'account erasure deletes the subject comment on another post');
select ok(not exists (select 1 from public.post_comments where id = 'f6420000-0000-4000-8000-000000000002'),
  'account post deletion cascades another member comment');
select ok(not exists (select 1 from public.journal_entries where id = 'f6420000-0000-4000-8000-000000000004'),
  'account erasure cascades the subject private Journal');
select ok(exists (select 1 from public.journal_entries where id = 'f6420000-0000-4000-8000-000000000005'),
  'account erasure preserves another member private Journal');

set local role authenticated;
set local "request.jwt.claim.sub" = '20000000-0000-4000-8000-000000000002';
set local "request.jwt.claims" = '{"sub":"20000000-0000-4000-8000-000000000002","role":"authenticated"}';
do $group_request$
declare response jsonb;
begin
  response := public.request_retired_community_group_deletion(
    'b0000000-0000-4000-8000-000000000002', false);
  perform set_config('test.cancelled_group_batch_id', response->>'batchId', true);
end;
$group_request$;
reset role;
select is((select execute_after from private.retired_community_deletion_batches
  where id = current_setting('test.cancelled_group_batch_id')::uuid),
  (select requested_at + interval '30 days' from private.retired_community_deletion_batches
    where id = current_setting('test.cancelled_group_batch_id')::uuid),
  'group deletion execute-after is exactly 30 days');
do $cancelled_group_backup$
declare batch_row private.retired_community_deletion_batches%rowtype;
begin
  select * into strict batch_row from private.retired_community_deletion_batches
    where id = current_setting('test.cancelled_group_batch_id')::uuid;
  perform public.record_retired_community_backup_proof(batch_row.id, 'group-backup', 'v1',
    batch_row.source_sha256, repeat('c',64), 2048, 'group-backup-verifier');
  perform public.approve_retired_community_deletion_batch(batch_row.id, 'group-independent-approver',
    batch_row.source_sha256, repeat('c',64), batch_row.post_count, batch_row.comment_count,
    batch_row.like_count, batch_row.object_count, batch_row.credential_count);
end;
$cancelled_group_backup$;
select throws_ok(
  $$ select * from public.claim_retired_community_credential_work(
    current_setting('test.cancelled_group_batch_id')::uuid,
    'f6420000-0000-4000-8000-000000000009', 10) $$,
  '55000', 'This credential batch is not executable.', 'provider credentials cannot be touched before day 30');
set local role authenticated;
set local "request.jwt.claim.sub" = '20000000-0000-4000-8000-000000000002';
set local "request.jwt.claims" = '{"sub":"20000000-0000-4000-8000-000000000002","role":"authenticated"}';
select is(public.cancel_retired_community_group_deletion(
  current_setting('test.cancelled_group_batch_id')::uuid)->>'status', 'cancelled',
  'a group owner can cancel during the 30-day window');
reset role;
select ok(exists (select 1 from public.crews where id = 'b0000000-0000-4000-8000-000000000002'),
  'cancelling preserves the group');
select ok(exists (select 1 from private.integration_destinations
  where id = 'f6420000-0000-4000-8000-000000000007' and status = 'active'),
  'cancelling preserves active provider credentials');

do $day30_group$
declare batch_id uuid;
begin
  batch_id := private.create_retired_community_deletion_batch(
    'group_deletion', 'group-operator', null,
    'b0000000-0000-4000-8000-000000000002', clock_timestamp() - interval '30 days');
  perform set_config('test.day30_group_batch_id', batch_id::text, true);
end;
$day30_group$;
select is((select credential_count from private.retired_community_deletion_batches
  where id = current_setting('test.day30_group_batch_id')::uuid), 1,
  'day-30 group batch inventories its provider credential');
do $day30_group_proof$
declare batch_row private.retired_community_deletion_batches%rowtype;
begin
  select * into strict batch_row from private.retired_community_deletion_batches
    where id = current_setting('test.day30_group_batch_id')::uuid;
  perform public.record_retired_community_backup_proof(batch_row.id, 'group-backup', 'v2',
    batch_row.source_sha256, repeat('d',64), 4096, 'group-backup-verifier');
  perform public.approve_retired_community_deletion_batch(batch_row.id, 'group-independent-approver',
    batch_row.source_sha256, repeat('d',64), batch_row.post_count, batch_row.comment_count,
    batch_row.like_count, batch_row.object_count, batch_row.credential_count);
end;
$day30_group_proof$;
update private.integration_destinations set last_delivered_at = clock_timestamp()
where id = 'f6420000-0000-4000-8000-000000000007';
create temp table group_credential_claim as
select * from public.claim_retired_community_credential_work(
  current_setting('test.day30_group_batch_id')::uuid,
  'f6420000-0000-4000-8000-00000000000a', 10
);
select is((select count(*)::integer from group_credential_claim), 1,
  'day 30 releases the exact credential despite routine delivery timestamp changes');
select ok((select credential_ciphertext is not null and credential_nonce is not null
  from group_credential_claim), 'credential claim contains the encrypted provider material');
update private.integration_destinations set credential_ciphertext = decode(repeat('aa', 17), 'hex')
where id = 'f6420000-0000-4000-8000-000000000007';
select throws_ok(
  $$ select public.confirm_retired_community_credential_work(
    current_setting('test.day30_group_batch_id')::uuid,
    (select work_id from group_credential_claim),
    'f6420000-0000-4000-8000-00000000000a', 'credential-worker', 'discord-revocation-1') $$,
  '55000', 'The provider credential no longer matches its sealed inventory.',
  'confirmation cannot erase credential material rotated after claim');
update private.integration_destinations set credential_ciphertext = decode(repeat('ef', 17), 'hex')
where id = 'f6420000-0000-4000-8000-000000000007';
select ok((select array_agg(key order by key) = array['batchId','counts','status']
  from jsonb_object_keys(public.confirm_retired_community_credential_work(
    current_setting('test.day30_group_batch_id')::uuid,
    (select work_id from group_credential_claim),
    'f6420000-0000-4000-8000-00000000000a', 'credential-worker', 'discord-revocation-1')) key),
  'credential confirmation returns only opaque allowlisted keys');
select ok((select status = 'revoked' and credential_ciphertext is null
  from private.integration_destinations where id = 'f6420000-0000-4000-8000-000000000007'),
  'confirmed provider credential is locally revoked and erased');
select is(public.execute_retired_community_deletion_batch(
  current_setting('test.day30_group_batch_id')::uuid, 'execution-operator',
  'EXECUTE SEALED RETIRED COMMUNITY DELETION')->>'status', 'executed',
  'group deletion executes on day 30 after credential revocation');
select ok(not exists (select 1 from public.crews where id = 'b0000000-0000-4000-8000-000000000002'),
  'group deletion removes only the approved group');
select ok(not exists (select 1 from public.community_posts where id = 'b2000000-0000-4000-8000-000000000002'),
  'group deletion cascades the approved group post');
select ok(exists (select 1 from auth.users where id = '20000000-0000-4000-8000-000000000002'),
  'group deletion preserves its owner account');
select ok(exists (select 1 from public.journal_entries where id = 'f6420000-0000-4000-8000-000000000005'),
  'group deletion preserves the owner private Journal');
select throws_ok(
  $$ update private.retired_community_deletion_ledger set details = '{}'::jsonb $$,
  '55000', 'Retired Community proof, approval, and ledger records are append-only.',
  'deletion ledger cannot be rewritten');

select * from finish();
rollback;
