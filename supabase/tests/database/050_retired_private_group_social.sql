begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(26);

select ok(to_regclass('public.community_posts') is not null, 'retained Community posts still exist');
select ok(to_regclass('public.post_comments') is not null, 'retained Community comments still exist');
select ok(to_regclass('public.post_likes') is not null, 'retained Community reactions still exist');
select ok(
  exists (select 1 from storage.buckets where id = 'community-post-images'),
  'the retained private post-image bucket still exists'
);
select ok(
  (select count(*) from public.community_posts) > 0,
  'the cutover does not purge seeded historical posts'
);

select is(
  (select count(*)::integer from pg_policies where schemaname = 'public' and tablename = 'community_posts'),
  0,
  'no browser-facing post policy remains'
);
select is(
  (select count(*)::integer from pg_policies where schemaname = 'public' and tablename = 'post_comments'),
  0,
  'no browser-facing comment policy remains'
);
select is(
  (select count(*)::integer from pg_policies where schemaname = 'public' and tablename = 'post_likes'),
  0,
  'no browser-facing reaction policy remains'
);

select ok(not has_table_privilege('authenticated', 'public.community_posts', 'select'), 'authenticated cannot read posts');
select ok(not has_table_privilege('authenticated', 'public.post_comments', 'select'), 'authenticated cannot read comments');
select ok(not has_table_privilege('authenticated', 'public.post_likes', 'select'), 'authenticated cannot read reactions');
select ok(not has_table_privilege('authenticated', 'public.community_posts', 'insert'), 'authenticated cannot create posts');
select ok(not has_table_privilege('authenticated', 'public.post_comments', 'insert'), 'authenticated cannot create comments');
select ok(not has_table_privilege('authenticated', 'public.post_likes', 'insert'), 'authenticated cannot create reactions');
select ok(not has_table_privilege('authenticated', 'public.community_posts', 'update'), 'authenticated cannot edit posts');
select ok(not has_table_privilege('authenticated', 'public.post_comments', 'update'), 'authenticated cannot edit comments');
select ok(not has_table_privilege('authenticated', 'public.post_likes', 'update'), 'authenticated cannot edit reactions');
select ok(not has_table_privilege('authenticated', 'public.community_posts', 'delete'), 'authenticated cannot delete retained posts');
select ok(not has_table_privilege('authenticated', 'public.post_comments', 'delete'), 'authenticated cannot delete retained comments');
select ok(not has_table_privilege('authenticated', 'public.post_likes', 'delete'), 'authenticated cannot delete retained reactions');

select ok(
  not has_function_privilege('authenticated', 'public.can_read_community_post(uuid)', 'execute'),
  'the retired post visibility helper is not callable by members'
);
select ok(
  not has_function_privilege('authenticated', 'public.get_community_post_engagement(uuid[])', 'execute'),
  'the retired engagement reader is not callable by members'
);

select ok(
  not exists (select 1 from pg_policies where schemaname = 'storage' and policyname = 'Crew members can read community post images'),
  'members cannot read retired post images'
);
select ok(
  not exists (select 1 from pg_policies where schemaname = 'storage' and policyname = 'Crew members can upload own community post images'),
  'members cannot upload retired post images'
);
select ok(
  not exists (select 1 from pg_policies where schemaname = 'storage' and policyname = 'Authors and crew leaders can delete community post images'),
  'members cannot delete retained post images'
);
select ok(
  exists (
    select 1
    from supabase_migrations.schema_migrations
    where version = '20260720120000'
  ),
  'the private-group social retirement migration was replayed'
);

select * from finish();
rollback;
