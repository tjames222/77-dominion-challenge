begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(33);

create temporary table member_progress_results (
  key text primary key,
  payload jsonb not null
);
grant select, insert, update on member_progress_results to authenticated;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  ('00000000-0000-0000-0000-000000000000', 'a1510000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'progress-caller@example.test', 'fixture', now(), '{"provider":"email"}', '{"name":"Progress Caller"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'a1510000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'progress-target@example.test', 'fixture', now(), '{"provider":"email"}', '{"name":"Progress Target"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'a1510000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'progress-cross@example.test', 'fixture', now(), '{"provider":"email"}', '{"name":"Cross Crew Target"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'a1510000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'progress-cross-owner@example.test', 'fixture', now(), '{"provider":"email"}', '{"name":"Cross Crew Owner"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'a1510000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', 'progress-no-crew@example.test', 'fixture', now(), '{"provider":"email"}', '{"name":"No Crew"}', now(), now());

insert into public.profiles (user_id, name, email, time_zone)
values
  ('a1510000-0000-4000-8000-000000000001', 'Progress Caller', 'progress-caller@example.test', 'UTC'),
  ('a1510000-0000-4000-8000-000000000002', 'Progress Target', 'progress-target@example.test', 'UTC'),
  ('a1510000-0000-4000-8000-000000000003', 'Cross Crew Target', 'progress-cross@example.test', 'UTC'),
  ('a1510000-0000-4000-8000-000000000004', 'Cross Crew Owner', 'progress-cross-owner@example.test', 'UTC'),
  ('a1510000-0000-4000-8000-000000000005', 'No Crew', 'progress-no-crew@example.test', 'UTC');

insert into public.entitlements (
  user_id, entitlement_key, status, source_type, source_id, starts_at, ends_at
)
select user_id, 'membership_active', 'active', 'test', 'fou-1451', now() - interval '1 day', now() + interval '1 day'
from public.profiles
where user_id::text like 'a1510000-%';

insert into public.crews (id, name, created_by)
values
  ('b1510000-0000-4000-8000-000000000001', 'Member Progress Crew', 'a1510000-0000-4000-8000-000000000001'),
  ('b1510000-0000-4000-8000-000000000002', 'Other Progress Crew', 'a1510000-0000-4000-8000-000000000004');

insert into public.crew_members (crew_id, user_id, display_name, role)
values
  ('b1510000-0000-4000-8000-000000000001', 'a1510000-0000-4000-8000-000000000001', 'Progress Caller', 'owner'),
  ('b1510000-0000-4000-8000-000000000001', 'a1510000-0000-4000-8000-000000000002', 'Progress Target', 'member'),
  ('b1510000-0000-4000-8000-000000000002', 'a1510000-0000-4000-8000-000000000003', 'Cross Crew Target', 'member'),
  ('b1510000-0000-4000-8000-000000000002', 'a1510000-0000-4000-8000-000000000004', 'Cross Crew Owner', 'owner');

insert into public.user_game_stats (user_id, total_points, challenge_points)
values ('a1510000-0000-4000-8000-000000000002', 420, 7);

insert into public.badge_definitions (
  badge_key, name, description, category, tier, icon, sort_order
)
select
  'fou1451_badge_' || pg_catalog.lpad(series::text, 2, '0'),
  'Progress Badge ' || pg_catalog.lpad(series::text, 2, '0'),
  'Safe progress badge description ' || series::text,
  'challenge',
  case when series <= 4 then 'gold' when series <= 9 then 'silver' else 'bronze' end,
  case when series <= 4 then 'crown' else 'shield' end,
  1400 + series
from pg_catalog.generate_series(1, 14) series;

insert into public.user_badges (user_id, badge_key, earned_at, metadata)
select
  'a1510000-0000-4000-8000-000000000002',
  'fou1451_badge_' || pg_catalog.lpad(series::text, 2, '0'),
  '2026-08-05T12:00:00Z'::timestamptz - (series || ' days')::interval,
  pg_catalog.jsonb_build_object('privateNote', 'must not escape', 'series', series)
from pg_catalog.generate_series(1, 14) series;

select ok(
  has_function_privilege(
    'authenticated',
    'public.get_crew_member_progress_profile(uuid,uuid,timestamptz,text,integer)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'public.get_crew_member_progress_profile(uuid,uuid,timestamptz,text,integer)',
    'execute'
  )
  and not has_function_privilege(
    'service_role',
    'public.get_crew_member_progress_profile(uuid,uuid,timestamptz,text,integer)',
    'execute'
  ),
  'only authenticated clients can execute the narrow member-progress RPC'
);

select ok(
  (select prosecdef and provolatile = 'v' and proconfig @> array['search_path=""']
   from pg_proc
   where oid = 'public.get_crew_member_progress_profile(uuid,uuid,timestamptz,text,integer)'::regprocedure),
  'the lock-taking RPC is a volatile security-definer boundary with an empty search path'
);

select ok(
  not has_function_privilege('authenticated', 'private.lifetime_level_from_points(integer)', 'execute')
  and not has_function_privilege('anon', 'private.lifetime_level_from_points(integer)', 'execute')
  and not has_function_privilege('service_role', 'private.lifetime_level_from_points(integer)', 'execute'),
  'the lifetime-level helper is not a client API'
);

select ok(
  position('pg_advisory_xact_lock_shared' in pg_get_functiondef(
    'public.get_crew_member_progress_profile(uuid,uuid,timestamptz,text,integer)'::regprocedure
  )) > 0
  and position('for share' in lower(pg_get_functiondef(
    'public.get_crew_member_progress_profile(uuid,uuid,timestamptz,text,integer)'::regprocedure
  ))) > 0,
  'the RPC serializes entitlement, crew, membership, and account-erasure races'
);

set local role authenticated;
set local "request.jwt.claim.sub" = 'a1510000-0000-4000-8000-000000000001';
set local "request.jwt.claims" = '{"sub":"a1510000-0000-4000-8000-000000000001","role":"authenticated"}';

select is((select count(*)::integer from public.profiles where user_id = 'a1510000-0000-4000-8000-000000000002'), 0,
  'direct reads of another member profile remain denied');
select is((select count(*)::integer from public.user_game_stats where user_id = 'a1510000-0000-4000-8000-000000000002'), 0,
  'direct reads of another member stats remain denied');
select is((select count(*)::integer from public.game_point_events where user_id = 'a1510000-0000-4000-8000-000000000002'), 0,
  'direct reads of another member point events remain denied');
select is((select count(*)::integer from public.user_badges where user_id = 'a1510000-0000-4000-8000-000000000002'), 0,
  'direct reads of another member raw badges remain denied');

insert into member_progress_results (key, payload)
values (
  'first',
  public.get_crew_member_progress_profile(
    'b1510000-0000-4000-8000-000000000001',
    'a1510000-0000-4000-8000-000000000002'
  )
);

select is(
  (select pg_catalog.array_agg(key order by key)
   from pg_catalog.jsonb_object_keys((select payload from member_progress_results where key = 'first')) key),
  array['avatarUrl','badgeCount','badges','displayName','hasMore','level','memberId','nextCursor','role'],
  'the top-level response contains only the minimum display contract'
);

select ok(
  (select payload ->> 'memberId' = 'a1510000-0000-4000-8000-000000000002'
      and payload ->> 'displayName' = 'Progress Target'
      and payload ->> 'role' = 'member'
   from member_progress_results where key = 'first'),
  'the response identifies only the requested same-crew member and role'
);

select is((select (payload ->> 'level')::integer from member_progress_results where key = 'first'), 31,
  '420 authoritative lifetime points return Level 31 under the FOU-846 cadence');

select ok(
  (select not payload ?| array[
    'points', 'totalPoints', 'pointEvents', 'email', 'billing', 'journal',
    'checkIns', 'streaks', 'integrations', 'accountSettings'
  ] from member_progress_results where key = 'first'),
  'the response excludes exact points and all unrelated private data'
);

select is((select (payload ->> 'badgeCount')::integer from member_progress_results where key = 'first'), 14,
  'the response includes the complete earned-badge count');
select is((select pg_catalog.jsonb_array_length(payload -> 'badges') from member_progress_results where key = 'first'), 12,
  'the default response is bounded to twelve badges');
select ok(
  (select payload #>> '{badges,0,key}' = 'fou1451_badge_01'
      and payload #>> '{badges,11,key}' = 'fou1451_badge_12'
   from member_progress_results where key = 'first'),
  'badges are deterministically newest first');
select ok(
  (select (payload ->> 'hasMore')::boolean
      and payload #>> '{nextCursor,badgeKey}' = 'fou1451_badge_12'
      and payload #>> '{nextCursor,earnedAt}' is not null
   from member_progress_results where key = 'first'),
  'the first page returns a stable keyset cursor');

select is(
  (select pg_catalog.array_agg(key order by key)
   from pg_catalog.jsonb_object_keys(
     (select payload #> '{badges,0}' from member_progress_results where key = 'first')
   ) key),
  array['description','earnedAt','icon','key','name','tier'],
  'badge rows contain presentation fields and ordering data only'
);
select ok(
  (select not pg_catalog.jsonb_path_exists(payload, '$.badges[*].metadata')
   from member_progress_results where key = 'first'),
  'raw user_badges metadata never crosses the RPC boundary'
);

insert into member_progress_results (key, payload)
select 'second', public.get_crew_member_progress_profile(
  'b1510000-0000-4000-8000-000000000001',
  'a1510000-0000-4000-8000-000000000002',
  (payload #>> '{nextCursor,earnedAt}')::timestamptz,
  payload #>> '{nextCursor,badgeKey}',
  12
)
from member_progress_results where key = 'first';

select ok(
  (select pg_catalog.jsonb_array_length(payload -> 'badges') = 2
      and payload #>> '{badges,0,key}' = 'fou1451_badge_13'
      and payload #>> '{badges,1,key}' = 'fou1451_badge_14'
   from member_progress_results where key = 'second'),
  'the cursor returns the remaining badges without overlap');
select ok(
  (select not (payload ->> 'hasMore')::boolean and payload -> 'nextCursor' = 'null'::jsonb
   from member_progress_results where key = 'second'),
  'the final badge page closes pagination');

select ok(
  (public.get_crew_member_progress_profile(
    'b1510000-0000-4000-8000-000000000001',
    'a1510000-0000-4000-8000-000000000001'
  ) @> '{"memberId":"a1510000-0000-4000-8000-000000000001","level":1,"badgeCount":0,"badges":[]}'::jsonb),
  'the caller can open the same safe zero-badge profile for themselves');

reset role;
update public.user_game_stats set total_points = 13 where user_id = 'a1510000-0000-4000-8000-000000000002';
set local role authenticated;
set local "request.jwt.claim.sub" = 'a1510000-0000-4000-8000-000000000001';
select is((public.get_crew_member_progress_profile(
  'b1510000-0000-4000-8000-000000000001', 'a1510000-0000-4000-8000-000000000002'
) ->> 'level')::integer, 1, 'thirteen lifetime points remain Level 1');

reset role;
update public.user_game_stats set total_points = 14 where user_id = 'a1510000-0000-4000-8000-000000000002';
insert into public.game_point_events (
  user_id, event_type, points, crew_id, idempotency_key, created_at
) values (
  'a1510000-0000-4000-8000-000000000002', 'test_window_points', 777,
  'b1510000-0000-4000-8000-000000000001', 'fou1451-window-points', now()
);
set local role authenticated;
set local "request.jwt.claim.sub" = 'a1510000-0000-4000-8000-000000000001';
select is((public.get_crew_member_progress_profile(
  'b1510000-0000-4000-8000-000000000001', 'a1510000-0000-4000-8000-000000000002'
) ->> 'level')::integer, 2, 'fourteen lifetime points cross exactly into Level 2');
select ok(
  (select points = 777 from public.get_crew_leaderboard(
    'b1510000-0000-4000-8000-000000000001', 'week'
  ) where user_id = 'a1510000-0000-4000-8000-000000000002')
  and (public.get_crew_member_progress_profile(
    'b1510000-0000-4000-8000-000000000001', 'a1510000-0000-4000-8000-000000000002'
  ) ->> 'level')::integer = 2,
  'weekly leaderboard points cannot alter the authoritative lifetime level');
select is(
  pg_catalog.jsonb_array_length(public.get_crew_member_progress_profile(
    'b1510000-0000-4000-8000-000000000001',
    'a1510000-0000-4000-8000-000000000002', null, null, 999
  ) -> 'badges'),
  14,
  'oversized page requests are capped by the server and remain bounded');

select throws_ok(
  $$select public.get_crew_member_progress_profile(
    'b1510000-0000-4000-8000-000000000001', 'a1510000-0000-4000-8000-000000000003'
  )$$,
  'P0002', 'Member progress is no longer available.',
  'a target in another crew is denied without existence disclosure'
);
select throws_ok(
  $$select public.get_crew_member_progress_profile(
    'b1510000-0000-4000-8000-000000000001', 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  )$$,
  'P0002', 'Member progress is no longer available.',
  'an arbitrary user ID receives the same generic denial'
);

reset role;
update public.entitlements set status = 'revoked' where user_id = 'a1510000-0000-4000-8000-000000000001';
set local role authenticated;
set local "request.jwt.claim.sub" = 'a1510000-0000-4000-8000-000000000001';
select throws_ok(
  $$select public.get_crew_member_progress_profile(
    'b1510000-0000-4000-8000-000000000001', 'a1510000-0000-4000-8000-000000000002'
  )$$,
  'P0002', 'Member progress is no longer available.',
  'an entitlement lapse is denied generically'
);

reset role;
update public.entitlements set status = 'active' where user_id = 'a1510000-0000-4000-8000-000000000001';
delete from public.crew_members where crew_id = 'b1510000-0000-4000-8000-000000000001' and user_id = 'a1510000-0000-4000-8000-000000000001';
set local role authenticated;
set local "request.jwt.claim.sub" = 'a1510000-0000-4000-8000-000000000001';
select throws_ok(
  $$select public.get_crew_member_progress_profile(
    'b1510000-0000-4000-8000-000000000001', 'a1510000-0000-4000-8000-000000000002'
  )$$,
  'P0002', 'Member progress is no longer available.',
  'a caller who left is denied generically'
);

reset role;
insert into public.crew_members (crew_id, user_id, display_name, role)
values ('b1510000-0000-4000-8000-000000000001', 'a1510000-0000-4000-8000-000000000001', 'Progress Caller', 'owner');
delete from public.crew_members where crew_id = 'b1510000-0000-4000-8000-000000000001' and user_id = 'a1510000-0000-4000-8000-000000000002';
set local role authenticated;
set local "request.jwt.claim.sub" = 'a1510000-0000-4000-8000-000000000001';
select throws_ok(
  $$select public.get_crew_member_progress_profile(
    'b1510000-0000-4000-8000-000000000001', 'a1510000-0000-4000-8000-000000000002'
  )$$,
  'P0002', 'Member progress is no longer available.',
  'a target who left is denied immediately and generically'
);

reset role;
insert into public.crew_members (crew_id, user_id, display_name, role)
values ('b1510000-0000-4000-8000-000000000001', 'a1510000-0000-4000-8000-000000000002', 'Progress Target', 'member');
update public.crews set deleted_at = now(), deleted_by = 'a1510000-0000-4000-8000-000000000001'
where id = 'b1510000-0000-4000-8000-000000000001';
set local role authenticated;
set local "request.jwt.claim.sub" = 'a1510000-0000-4000-8000-000000000001';
select throws_ok(
  $$select public.get_crew_member_progress_profile(
    'b1510000-0000-4000-8000-000000000001', 'a1510000-0000-4000-8000-000000000002'
  )$$,
  'P0002', 'Member progress is no longer available.',
  'a deleted crew is denied without disclosing retained rows'
);

reset role;
set local role authenticated;
set local "request.jwt.claim.sub" = '';
set local "request.jwt.claims" = '{"role":"authenticated"}';
select throws_ok(
  $$select public.get_crew_member_progress_profile(
    'b1510000-0000-4000-8000-000000000001', 'a1510000-0000-4000-8000-000000000002'
  )$$,
  'P0002', 'Member progress is no longer available.',
  'a signed-out request fails closed through the authenticated entry point'
);

set local "request.jwt.claim.sub" = 'a1510000-0000-4000-8000-000000000001';
select throws_ok(
  $$select public.get_crew_member_progress_profile(
    'b1510000-0000-4000-8000-000000000001',
    'a1510000-0000-4000-8000-000000000002',
    now(), null, 12
  )$$,
  'P0002', 'Member progress is no longer available.',
  'a malformed cursor pair fails with the same privacy-safe response'
);

select * from finish();
rollback;
