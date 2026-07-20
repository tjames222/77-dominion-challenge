begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(54);

select ok(exists (select 1 from supabase_migrations.schema_migrations where version = '20260720130000'),
  'the retired Community retention migration was replayed');
select ok(to_regclass('private.retired_community_retention_policy') is not null, 'retention policy exists');
select ok(to_regclass('private.retired_community_export_runs') is not null, 'export runs exist');
select ok(to_regclass('private.retired_community_export_items') is not null, 'bounded export items exist');
select ok(to_regclass('private.retired_community_retention_audit') is not null, 'metadata audit exists');
select is((select purge_approved from private.retired_community_retention_policy where singleton), false,
  'destructive execution ships disabled');
select is((select maximum_batch_size from private.retired_community_retention_policy where singleton), 250,
  'policy caps cleanup at 250 posts');

select ok(not has_function_privilege('authenticated',
  'public.preview_retired_community_retention(timestamptz,integer)', 'execute'), 'members cannot preview retention');
select ok(not has_function_privilege('authenticated',
  'public.create_retired_community_export_run(text,timestamptz,integer)', 'execute'), 'members cannot create exports');
select ok(not has_function_privilege('authenticated',
  'public.export_retired_community_run(uuid)', 'execute'), 'members cannot read exports');
select ok(not has_function_privilege('authenticated',
  'public.prove_retired_community_export(uuid,text,text,integer,integer,integer,integer)', 'execute'),
  'members cannot prove exports');
select ok(not has_function_privilege('authenticated',
  'public.execute_retired_community_retention(uuid,text,text,text)', 'execute'), 'members cannot execute retention');
select ok(not has_function_privilege('authenticated',
  'public.configure_retired_community_retention(timestamptz,boolean,text,text,integer)', 'execute'),
  'members cannot change retention policy');
select ok(has_function_privilege('service_role',
  'public.preview_retired_community_retention(timestamptz,integer)', 'execute'), 'service role can preview');
select ok(has_function_privilege('service_role',
  'public.create_retired_community_export_run(text,timestamptz,integer)', 'execute'), 'service role can create exports');
select ok(has_function_privilege('service_role',
  'public.export_retired_community_run(uuid)', 'execute'), 'service role can read exports');
select ok(has_function_privilege('service_role',
  'public.prove_retired_community_export(uuid,text,text,integer,integer,integer,integer)', 'execute'),
  'service role can prove exports');
select ok(has_function_privilege('service_role',
  'public.execute_retired_community_retention(uuid,text,text,text)', 'execute'), 'service role can execute approved retention');
select ok(has_function_privilege('service_role',
  'public.configure_retired_community_retention(timestamptz,boolean,text,text,integer)', 'execute'),
  'service role can apply separately approved policy changes');
select ok(not has_table_privilege('service_role', 'private.retired_community_export_runs', 'select'),
  'service role cannot bypass the audited functions');

create temp table journal_counts_before as
select (select count(*) from public.journal_entries) entries,
  (select count(*) from public.journal_photos) photos;

insert into public.community_posts (
  id, author_id, display_name, crew_id, scope, body, post_type, image_path, image_alt, created_at, updated_at
) values (
  'f6400000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  'FOU-564 Fixture',
  'a0000000-0000-4000-8000-000000000001',
  'crew',
  'FOU-564 private body',
  'message',
  'a0000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000001/fou564.jpg',
  'FOU-564 private image',
  '2020-01-01 00:00:00+00',
  '2020-01-01 00:00:00+00'
);
insert into public.post_comments (id, post_id, user_id, display_name, body, created_at, updated_at)
values ('f6400000-0000-4000-8000-000000000002', 'f6400000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000003', 'Fixture', 'FOU-564 private comment',
  '2020-01-01 00:01:00+00', '2020-01-01 00:01:00+00');
insert into public.post_likes (post_id, user_id, created_at)
values ('f6400000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000003',
  '2020-01-01 00:02:00+00');
insert into storage.objects (id, bucket_id, name, owner)
values ('f6400000-0000-4000-8000-000000000003', 'community-post-images',
  'a0000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000001/fou564.jpg',
  '10000000-0000-4000-8000-000000000001');

create temp table retention_preview as
select public.preview_retired_community_retention('2026-07-20 12:00:00+00', 1) result;
select is((select (result->>'dryRun')::boolean from retention_preview), true, 'preview is a dry run by default');
select is((select (result#>>'{counts,posts}')::integer from retention_preview), 1, 'preview is bounded to one post');
select is((select (result#>>'{counts,comments}')::integer from retention_preview), 1, 'preview counts comments');
select is((select (result#>>'{counts,likes}')::integer from retention_preview), 1, 'preview counts likes');
select is((select (result#>>'{counts,images}')::integer from retention_preview), 1, 'preview counts images');
select is((select count(*)::integer from private.retired_community_export_runs), 0,
  'read-only preview does not create an export run');
select ok(exists (select 1 from public.community_posts where id = 'f6400000-0000-4000-8000-000000000001'),
  'preview preserves the source post');
select throws_ok(
  $$ select public.preview_retired_community_retention(null, 251) $$,
  '22023', 'The preview batch size exceeds policy.', 'preview rejects batches over policy');

create temp table retention_run as
select public.create_retired_community_export_run(
  'operator@example.test', '2026-07-20 12:00:00+00', 1
) result;
select is((select (result->>'dryRun')::boolean from retention_run), true, 'creating an export still performs no deletion');
select is((select count(*)::integer from private.retired_community_export_runs), 1, 'one export run is recorded');
select is((select count(*)::integer from private.retired_community_export_items), 1, 'one immutable candidate is pinned');
select is((select post_count from private.retired_community_export_runs), 1, 'export captures the post count');
select is((select comment_count from private.retired_community_export_runs), 1, 'export captures the comment count');
select is((select like_count from private.retired_community_export_runs), 1, 'export captures the like count');
select is((select image_count from private.retired_community_export_runs), 1, 'export captures the image count');
select like((select public.export_retired_community_run((result->>'runId')::uuid)::text from retention_run),
  '%FOU-564 private body%', 'service-role export contains the retained post payload');

select throws_ok(
  $$ select public.prove_retired_community_export(
    (select (result->>'runId')::uuid from retention_run), 'operator@example.test', 'not-a-digest', 1, 1, 1, 1
  ) $$,
  '22023', 'A lowercase SHA-256 digest is required.', 'export proof requires SHA-256');
select throws_ok(
  $$ select public.prove_retired_community_export(
    (select (result->>'runId')::uuid from retention_run), 'operator@example.test', repeat('a', 64), 2, 1, 1, 1
  ) $$,
  '22023', 'Export counts do not match the recorded run.', 'export proof requires matching counts');
select is((select (public.prove_retired_community_export(
  (result->>'runId')::uuid, 'operator@example.test', repeat('a', 64), 1, 1, 1, 1
)->>'exportProven')::boolean from retention_run), true, 'matching digest and counts prove the export');

select throws_ok(
  $$ select public.execute_retired_community_retention(
    (select (result->>'runId')::uuid from retention_run), 'operator@example.test', repeat('a', 64),
    'DELETE EXPORTED RETIRED COMMUNITY DATA'
  ) $$,
  '55000', 'Deletion is not approved or its not-before window has not opened.',
  'production execution remains disabled by default');

do $configure$
begin
  perform public.configure_retired_community_retention(
    clock_timestamp() - interval '1 minute', true, 'FOU-564-test-approval', 'operator@example.test', 250
  );
end;
$configure$;
select throws_ok(
  $$ select public.execute_retired_community_retention(
    (select (result->>'runId')::uuid from retention_run), 'operator@example.test', repeat('a', 64), 'wrong'
  ) $$,
  '22023', 'The exact destructive confirmation is required.', 'execution requires exact confirmation');

create temp table storage_block as
select public.execute_retired_community_retention(
  (select (result->>'runId')::uuid from retention_run), 'operator@example.test', repeat('a', 64),
  'DELETE EXPORTED RETIRED COMMUNITY DATA'
) result;
select is((select result->>'status' from storage_block), 'storage_cleanup_required',
  'database deletion waits for Storage API cleanup');
select is((select jsonb_array_length(result->'imagePaths') from storage_block), 1,
  'the storage blocker returns a bounded path list');
select ok(exists (select 1 from public.community_posts where id = 'f6400000-0000-4000-8000-000000000001'),
  'no relational row is deleted while a real blob remains');
select is((select count(*)::integer from private.retired_community_retention_audit where event_type = 'executed'), 0,
  'blocked execution is not audited as completed');

delete from storage.objects where id = 'f6400000-0000-4000-8000-000000000003';
select is((select public.execute_retired_community_retention(
  (result->>'runId')::uuid, 'operator@example.test', repeat('a', 64),
  'DELETE EXPORTED RETIRED COMMUNITY DATA'
)->>'status' from retention_run), 'completed', 'approved export completes after Storage cleanup');
select ok(not exists (select 1 from public.community_posts where id = 'f6400000-0000-4000-8000-000000000001'),
  'the exported post is deleted');
select ok(not exists (select 1 from public.post_comments where id = 'f6400000-0000-4000-8000-000000000002'),
  'post deletion cascades comments');
select ok(not exists (select 1 from public.post_likes where post_id = 'f6400000-0000-4000-8000-000000000001'),
  'post deletion cascades likes');
select is((select count(*)::integer from private.retired_community_retention_audit where event_type = 'executed'), 1,
  'successful execution appends one audit event');
select ok(not exists (select 1 from private.retired_community_retention_audit
  where details::text like '%FOU-564 private%' or details::text like '%fou564.jpg%'),
  'audit records contain metadata, not exported content or paths');
select is((select count(*) from public.journal_entries), (select entries from journal_counts_before),
  'retention never touches journal entries');
select is((select count(*) from public.journal_photos), (select photos from journal_counts_before),
  'retention never touches journal photos');
select throws_ok(
  $$ update private.retired_community_retention_audit set details = '{}'::jsonb $$,
  '55000', 'Retired Community retention audit is append-only.', 'retention audit cannot be rewritten');

select * from finish();
rollback;
