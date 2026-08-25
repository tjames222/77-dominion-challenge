begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(54);

select ok(exists (select 1 from supabase_migrations.schema_migrations where version = '20260720130000'),
  'the T0 retirement migration was replayed');
select ok(to_regclass('private.retired_community_t0_census') is not null, 'the immutable census exists');
select ok(to_regclass('private.retired_community_t0_post_inventory') is not null, 'the post inventory exists');
select ok(to_regclass('private.retired_community_t0_comment_inventory') is not null, 'the comment inventory exists');
select ok(to_regclass('private.retired_community_t0_like_inventory') is not null, 'the like inventory exists');
select ok(to_regclass('private.retired_community_t0_object_inventory') is not null, 'the object inventory exists');
select is((select count(*)::integer from private.retired_community_t0_census), 1, 'exactly one T0 row is captured');
select is((select member_export_ends_at from private.retired_community_t0_census),
  (select captured_at + interval '30 days' from private.retired_community_t0_census),
  'the authored export window ends exactly at T0 plus 30 days');
select ok((select source_sha256 ~ '^[0-9a-f]{64}$' from private.retired_community_t0_census),
  'the T0 source digest is a SHA-256');
select is((select global_post_count from private.retired_community_t0_census),
  (select count(*) from private.retired_community_t0_post_inventory where scope = 'global'),
  'the uncapped global census matches its inventory');
select is((select private_post_count from private.retired_community_t0_census),
  (select count(*) from private.retired_community_t0_post_inventory where scope = 'crew'),
  'the uncapped private-group census matches its inventory');
select is((select comment_count from private.retired_community_t0_census),
  (select count(*) from private.retired_community_t0_comment_inventory), 'comment census matches its inventory');
select is((select like_count from private.retired_community_t0_census),
  (select count(*) from private.retired_community_t0_like_inventory), 'like census matches its inventory');
select is((select referenced_image_count from private.retired_community_t0_census),
  (select count(distinct image_reference_sha256) from private.retired_community_t0_post_inventory
    where image_reference_sha256 is not null),
  'referenced-image census matches its inventory');
select is((select bucket_object_count from private.retired_community_t0_census),
  (select count(*) from private.retired_community_t0_object_inventory), 'bucket census matches its inventory');
select is((select missing_object_count from private.retired_community_t0_census),
  (select count(distinct image_reference_sha256) from private.retired_community_t0_post_inventory
    where image_reference_sha256 is not null and object_sha256 is null), 'missing-object census matches its inventory');
select is((select orphan_object_count from private.retired_community_t0_census),
  (select count(*) from private.retired_community_t0_object_inventory
    where cardinality(referenced_post_ids) = 0), 'orphan census matches its inventory');

select ok(has_function_privilege('authenticated',
  'public.export_own_retired_community_content()', 'execute'), 'authenticated members can export their authored content');
select ok(not has_function_privilege('anon',
  'public.export_own_retired_community_content()', 'execute'), 'anonymous callers cannot export authored content');
select ok(not has_function_privilege('authenticated',
  'private.build_own_retired_community_export(uuid,timestamptz)', 'execute'), 'members cannot choose an export subject or time');
select ok(not has_table_privilege('service_role', 'private.retired_community_t0_census', 'select'),
  'service role cannot bypass the export contract with direct census reads');
select ok(to_regprocedure('public.export_own_retired_community_content(uuid)') is null,
  'there is no subject-selecting public export overload');
select ok(to_regprocedure('public.execute_retired_community_retention(uuid,text,text,text)') is null,
  'P0/P1 creates no purge RPC');

create temp table journal_counts_before as
select (select count(*) from public.journal_entries) entries;

insert into public.community_posts (
  id, author_id, display_name, crew_id, scope, body, post_type, created_at, updated_at
) values (
  'f6410000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  'Bob Private Name', null, 'global', 'Bob global private body', 'message',
  '2026-07-01 11:00:00+00', '2026-07-01 11:00:00+00'
);
update public.community_posts set
  image_path = 'a0000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000001/referenced.jpg',
  image_alt = 'Alice authored image'
where id = 'a2000000-0000-4000-8000-000000000001';
update public.community_posts set
  image_path = 'b0000000-0000-4000-8000-000000000002/20000000-0000-4000-8000-000000000002/missing.jpg',
  image_alt = 'Bob missing image'
where id = 'b2000000-0000-4000-8000-000000000002';
insert into public.post_comments (id, post_id, user_id, display_name, body, created_at, updated_at) values
  ('f6410000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001', 'Alice Private Name', 'Alice comment on Bob',
    '2026-07-01 12:01:00+00', '2026-07-01 12:01:00+00'),
  ('f6410000-0000-4000-8000-000000000003', 'a2000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002', 'Bob Private Name', 'Bob comment on Alice',
    '2026-07-01 12:02:00+00', '2026-07-01 12:02:00+00');
insert into public.post_likes (post_id, user_id, created_at) values
  ('b2000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
    '2026-07-01 12:03:00+00'),
  ('a2000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002',
    '2026-07-01 12:04:00+00');
insert into storage.objects (id, bucket_id, name, owner) values
  ('f6410000-0000-4000-8000-000000000004', 'community-post-images',
    'a0000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000001/referenced.jpg',
    '10000000-0000-4000-8000-000000000001'),
  ('f6410000-0000-4000-8000-000000000005', 'community-post-images',
    'orphan/fou564.jpg', '30000000-0000-4000-8000-000000000003');

create temp table current_census as select * from private.compute_retired_community_census();
select is((select global_post_count from current_census),
  (select count(*) from public.community_posts where scope = 'global'), 'current census includes every global post');
select is((select private_post_count from current_census),
  (select count(*) from public.community_posts where scope = 'crew'), 'current census includes every private-group post');
select is((select comment_count from current_census), (select count(*) from public.post_comments),
  'current census includes every comment');
select is((select like_count from current_census), (select count(*) from public.post_likes),
  'current census includes every reaction');
select is((select referenced_image_count from current_census), 2::bigint, 'current census counts all image references');
select is((select bucket_object_count from current_census), 2::bigint, 'current census counts the full image bucket');
select is((select missing_object_count from current_census), 1::bigint, 'current census counts missing objects');
select is((select orphan_object_count from current_census), 1::bigint, 'current census counts orphan objects');

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
  coalesce((select array_agg(post_row.id order by post_row.id)
    from public.community_posts post_row where post_row.image_path = object_row.name), '{}'::uuid[]),
  private.retired_community_sha256(to_jsonb(object_row)::text)
from storage.objects object_row where object_row.bucket_id = 'community-post-images';
insert into private.retired_community_t0_post_inventory
select post_row.id, post_row.scope, post_row.author_id, post_row.crew_id, post_row.created_at,
  case when post_row.image_path is not null then private.retired_community_sha256(post_row.image_path) end,
  private.retired_community_sha256(to_jsonb(post_row)::text),
  private.retired_community_sha256(coalesce((select jsonb_agg(jsonb_build_array(
    child.kind, child.child_key, child.row_sha256) order by child.kind, child.child_key)::text
    from (select 'comment' kind, comment_item.comment_id::text child_key, comment_item.row_sha256
      from private.retired_community_t0_comment_inventory comment_item where comment_item.post_id = post_row.id
      union all select 'like', like_item.user_id::text, like_item.row_sha256
      from private.retired_community_t0_like_inventory like_item where like_item.post_id = post_row.id) child), '[]')),
  (select object_item.row_sha256 from private.retired_community_t0_object_inventory object_item
    where object_item.bucket_id = 'community-post-images' and object_item.object_name = post_row.image_path)
from public.community_posts post_row;
insert into private.retired_community_t0_census
select true, capture.captured_at, capture.captured_at + interval '30 days',
  global_post_count, private_post_count, comment_count, like_count, referenced_image_count,
  bucket_object_count, missing_object_count, orphan_object_count, source_sha256
from current_census cross join (select clock_timestamp() captured_at) capture;

alter table private.retired_community_t0_census enable trigger block_retired_community_t0_census_mutation;
alter table private.retired_community_t0_post_inventory enable trigger block_retired_community_t0_post_mutation;
alter table private.retired_community_t0_comment_inventory enable trigger block_retired_community_t0_comment_mutation;
alter table private.retired_community_t0_like_inventory enable trigger block_retired_community_t0_like_mutation;
alter table private.retired_community_t0_object_inventory enable trigger block_retired_community_t0_object_mutation;

select is((select source_sha256 from private.retired_community_t0_census),
  (select source_sha256 from current_census), 'the captured source digest covers the complete current source');
select ok((select bool_and(row_sha256 ~ '^[0-9a-f]{64}$') from private.retired_community_t0_post_inventory),
  'every post has a full-row hash');
select ok((select bool_and(children_sha256 ~ '^[0-9a-f]{64}$') from private.retired_community_t0_post_inventory),
  'every post has an exact child-set hash');
select ok((select bool_and(row_sha256 ~ '^[0-9a-f]{64}$') from private.retired_community_t0_object_inventory),
  'every bucket object has a full metadata-row hash');
select throws_ok(
  $$ update private.retired_community_t0_census set source_sha256 = repeat('0', 64) $$,
  '55000', 'The retired Community T0 snapshot is immutable.', 'the T0 census cannot be updated');
select throws_ok(
  $$ delete from private.retired_community_t0_post_inventory $$,
  '55000', 'The retired Community T0 snapshot is immutable.', 'the T0 post inventory cannot be deleted');
select throws_ok(
  $$ insert into private.retired_community_t0_object_inventory
    (bucket_id, object_name, object_id, row_sha256)
    values ('community-post-images', 'tamper', gen_random_uuid(), repeat('0', 64)) $$,
  '55000', 'The retired Community T0 snapshot is immutable.', 'the T0 object inventory cannot be extended');

select is(jsonb_array_length(private.build_own_retired_community_export(
  '10000000-0000-4000-8000-000000000001',
  (select captured_at + interval '30 days' from private.retired_community_t0_census)
)->'posts'), 1, 'the authored export remains available through day 30');
select throws_ok(
  $$ select private.build_own_retired_community_export(
    '10000000-0000-4000-8000-000000000001',
    (select captured_at + interval '31 days' from private.retired_community_t0_census)
  ) $$,
  '55000', 'The member-authored export window has closed.', 'the authored export is closed on day 31');

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
set local "request.jwt.claims" = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is(jsonb_array_length(public.export_own_retired_community_content()->'posts'), 1,
  'auth.uid scopes the export to Alice authored posts');
select alike(public.export_own_retired_community_content()::text, '%Alpha fixture post%',
  'Alice receives her own post body');
select alike(public.export_own_retired_community_content()::text, '%referenced.jpg%',
  'Alice receives a usable path for only her own attachment');
select is(jsonb_array_length(public.export_own_retired_community_content()->'comments'), 1,
  'auth.uid scopes the export to Alice authored comments');
select alike(public.export_own_retired_community_content()::text, '%Alice comment on Bob%',
  'Alice receives her own comment body with opaque parent context');
select is(jsonb_array_length(public.export_own_retired_community_content()->'likes'), 1,
  'auth.uid scopes the export to Alice reactions');
select unalike(public.export_own_retired_community_content()::text, '%Bravo fixture post%',
  'another member post body never leaks');
select unalike(public.export_own_retired_community_content()::text, '%Bob comment on Alice%',
  'another member comment body never leaks even on Alice post');
select unalike(public.export_own_retired_community_content()::text, '%Bob global private body%',
  'another member global post body never leaks');
select unalike(public.export_own_retired_community_content()::text, '%missing.jpg%',
  'another member attachment path never leaks');
select unalike(public.export_own_retired_community_content()::text, '%Bob Private Name%',
  'another member display data never leaks');
select ok(public.export_own_retired_community_content()::text
  !~ '"(authorId|userId|displayName|avatar|email|crewId)"', 'the export omits profile and subject fields');
reset role;

select is((select count(*) from public.journal_entries), (select entries from journal_counts_before),
  'the T0 and export workflow preserves private Journal entries');
select ok(to_regclass('public.journal_photos') is null,
  'the independent FOU-753 decision leaves no Journal photo table');

select * from finish();
rollback;
