begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(40);

insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select '00000000-0000-0000-0000-000000000000', ('a2500000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,
  'authenticated','authenticated','scoped-member-' || n || '@example.test','fixture',now(),'{}','{}',now(),now()
from generate_series(1,3)n;
insert into public.profiles(user_id,name,email,time_zone)
select id,'Scoped Member','scoped-member@example.test','UTC' from auth.users where id::text like 'a2500000-%';
insert into public.entitlements(user_id,entitlement_key,status,source_type,source_id,starts_at,ends_at)
values ('a2500000-0000-4000-8000-000000000001','membership_active','active','test','fou-1499-cursor',now()-interval '1 day',now()+interval '1 day');
insert into public.crews(id,name,created_by)
values ('b2500000-0000-4000-8000-000000000001','Scoped Badge Crew','a2500000-0000-4000-8000-000000000001');
insert into public.crew_members(crew_id,user_id,display_name,role)
values ('b2500000-0000-4000-8000-000000000001','a2500000-0000-4000-8000-000000000001','Caller','owner'),
       ('b2500000-0000-4000-8000-000000000001','a2500000-0000-4000-8000-000000000002','Target','member');
insert into public.badge_definitions(badge_key,name,description,category,tier,icon,sort_order)
values ('fou1499_cursor_a','Badge A','Public description','challenge','silver','shield',14991),
       ('fou1499_cursor_b','Badge B','Public description','challenge','gold','shield',14992);
insert into public.user_badges(id,user_id,badge_key,scope_key,earned_at,metadata)
values
 ('c2500000-0000-4000-8000-000000000001','a2500000-0000-4000-8000-000000000002','fou1499_cursor_a','lifetime','2026-01-07T12:00:00.123456Z','{"privateNote":"must not escape"}'),
 ('c2500000-0000-4000-8000-000000000002','a2500000-0000-4000-8000-000000000002','fou1499_cursor_a','original77:2026-01-01','2026-01-07T12:00:00.123456Z','{}'),
 ('c2500000-0000-4000-8000-000000000003','a2500000-0000-4000-8000-000000000002','fou1499_cursor_b','lifetime','2026-01-07T12:00:00.123456Z','{}'),
 ('c2500000-0000-4000-8000-000000000004','a2500000-0000-4000-8000-000000000002','fou1499_cursor_a','original77:2025-12-01','2026-01-06T12:00:00Z','{}');

create temporary table scoped_badge_pages(page integer primary key,payload jsonb);
grant all on scoped_badge_pages to authenticated;
create function pg_temp.member_data_snapshot() returns jsonb language sql as $$
  select jsonb_build_object(
    'awards',(select jsonb_agg(to_jsonb(a) order by id) from public.user_badges a),
    'profiles',(select jsonb_agg(to_jsonb(a) order by user_id) from public.profiles a),
    'stats',(select jsonb_agg(to_jsonb(a) order by user_id) from public.user_game_stats a),
    'crews',(select jsonb_agg(to_jsonb(a) order by id) from public.crews a),
    'members',(select jsonb_agg(to_jsonb(a) order by crew_id,user_id) from public.crew_members a),
    'entitlements',(select jsonb_agg(to_jsonb(a) order by user_id,entitlement_key) from public.entitlements a))
$$;
create temporary table scoped_badge_before as select pg_temp.member_data_snapshot() as snapshot;
create function pg_temp.badge_page(cursor_time timestamptz default null,cursor_key text default null,page_size integer default 1,cursor_id uuid default null)
returns jsonb language sql as $$select public.get_crew_member_progress_profile(
  'b2500000-0000-4000-8000-000000000001','a2500000-0000-4000-8000-000000000002',cursor_time,cursor_key,page_size,cursor_id)$$;

select ok(to_regprocedure('public.get_crew_member_progress_profile(uuid,uuid,timestamptz,text,integer)') is null,'old overload is removed');
select is((select count(*)::integer from pg_proc where pronamespace='public'::regnamespace and proname='get_crew_member_progress_profile'),1,'only one unambiguous live RPC remains');
select is((select pronargdefaults::integer from pg_proc where oid='public.get_crew_member_progress_profile(uuid,uuid,timestamptz,text,integer,uuid)'::regprocedure),4,'new UUID defaults null for older named-argument callers');
select ok(has_function_privilege('authenticated','public.get_crew_member_progress_profile(uuid,uuid,timestamptz,text,integer,uuid)','execute')
  and not has_function_privilege('anon','public.get_crew_member_progress_profile(uuid,uuid,timestamptz,text,integer,uuid)','execute')
  and not has_function_privilege('service_role','public.get_crew_member_progress_profile(uuid,uuid,timestamptz,text,integer,uuid)','execute'),'only authenticated clients have the RPC grant');

set local role authenticated;
set local request.jwt.claim.sub='a2500000-0000-4000-8000-000000000001';
insert into scoped_badge_pages values(1,pg_temp.badge_page());
insert into scoped_badge_pages select 2,pg_temp.badge_page((payload#>>'{nextCursor,earnedAt}')::timestamptz,payload#>>'{nextCursor,badgeKey}',1,(payload#>>'{nextCursor,awardId}')::uuid) from scoped_badge_pages where page=1;
insert into scoped_badge_pages select 3,pg_temp.badge_page((payload#>>'{nextCursor,earnedAt}')::timestamptz,payload#>>'{nextCursor,badgeKey}',1,(payload#>>'{nextCursor,awardId}')::uuid) from scoped_badge_pages where page=2;
insert into scoped_badge_pages select 4,pg_temp.badge_page((payload#>>'{nextCursor,earnedAt}')::timestamptz,payload#>>'{nextCursor,badgeKey}',1,(payload#>>'{nextCursor,awardId}')::uuid) from scoped_badge_pages where page=3;
select is((select payload#>>'{badges,0,awardId}' from scoped_badge_pages where page=1),'c2500000-0000-4000-8000-000000000001','UUID orders first timestamp/key tie');
select is((select (payload->>'badgeCount')::integer from scoped_badge_pages where page=1),4,'count includes lifetime and scoped records');
select is((select payload#>>'{badges,0,awardId}' from scoped_badge_pages where page=2),'c2500000-0000-4000-8000-000000000002','next page retains the tied scoped award');
select is((select payload#>>'{badges,0,key}' from scoped_badge_pages where page=3),'fou1499_cursor_b','badge key orders equal timestamps before older awards');
select is((select payload#>>'{badges,0,awardId}' from scoped_badge_pages where page=4),'c2500000-0000-4000-8000-000000000004','older repeat badge remains reachable');
select ok((select not (payload->>'hasMore')::boolean and payload->'nextCursor'='null'::jsonb from scoped_badge_pages where page=4),'last page has no cursor');
select is(pg_temp.badge_page(),(select payload from scoped_badge_pages where page=1),'repeated reads are stable');
select is((select count(distinct payload#>>'{badges,0,awardId}')::integer from scoped_badge_pages),4,'no tied row is skipped or repeated');
select is((select array_agg(key order by key) from jsonb_object_keys((select payload#>'{badges,0}' from scoped_badge_pages where page=1))key),
  array['awardId','description','earnedAt','icon','key','name','tier'],'only public display fields and opaque award identity escape');
reset role;
select is(pg_temp.member_data_snapshot(),(select snapshot from scoped_badge_before),'pagination writes no award, ownership, metadata, celebration, profile, stats, crew or entitlement state');
set local role authenticated;
select throws_ok($$select pg_temp.badge_page('2026-01-07T12:00:00.123456Z','fou1499_cursor_a')$$,'22023','Badge history changed. Reload badges to start from the first page.','ambiguous legacy cursor requires safe first-page refresh');
select is(pg_temp.badge_page('2026-01-07T12:00:00.123456Z','fou1499_cursor_b')#>>'{badges,0,awardId}','c2500000-0000-4000-8000-000000000004','unambiguous old named-argument cursor remains compatible');
select throws_ok($$select pg_temp.badge_page('2026-01-07T12:00:00.123456Z','fou1499_cursor_a',1,'ffffffff-ffff-4000-8000-000000000001')$$,'22023','Badge history changed. Reload badges to start from the first page.','unknown stable UUID requires first-page refresh');
select throws_ok($$select pg_temp.badge_page('2026-01-07T12:00:00.123456Z','fou1499_cursor_b',1,'c2500000-0000-4000-8000-000000000001')$$,'22023','Badge history changed. Reload badges to start from the first page.','UUID must belong to the exact time and key boundary');
select throws_ok($$select pg_temp.badge_page(null,null,1,'c2500000-0000-4000-8000-000000000001')$$,'P0002','Member progress is no longer available.','UUID without a timestamp is invalid');
select throws_ok($$select pg_temp.badge_page('2026-01-07T12:00:00Z',null)$$,'P0002','Member progress is no longer available.','timestamp without a key is invalid');
reset role;
insert into public.user_badges(user_id,badge_key,scope_key,earned_at)
select 'a2500000-0000-4000-8000-000000000002','fou1499_cursor_a','fixture:'||n,'2025-01-01'::timestamptz-n*interval '1 day' from generate_series(1,30)n;
set local role authenticated;
select is(jsonb_array_length(pg_temp.badge_page(null,null,999)->'badges'),24,'maximum page size is 24 even with many scoped records');
select is(jsonb_array_length(pg_temp.badge_page(null,null,-1)->'badges'),1,'negative page size is clamped to one');
select is(jsonb_array_length(pg_temp.badge_page(null,null,null)->'badges'),12,'null page size uses twelve');
set local request.jwt.claim.sub='a2500000-0000-4000-8000-000000000003';
select throws_ok($$select pg_temp.badge_page('2026-01-07T12:00:00.123456Z','fou1499_cursor_a')$$,'P0002','Member progress is no longer available.','unauthorized actor never receives cursor existence information');
reset role;
delete from public.crew_members where user_id='a2500000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claim.sub='a2500000-0000-4000-8000-000000000001';
select throws_ok($$select pg_temp.badge_page()$$,'P0002','Member progress is no longer available.','caller membership loss denies pagination');
reset role;
insert into public.crew_members(crew_id,user_id,display_name,role)values('b2500000-0000-4000-8000-000000000001','a2500000-0000-4000-8000-000000000001','Caller','owner');
delete from public.crew_members where user_id='a2500000-0000-4000-8000-000000000002';
set local role authenticated;
select throws_ok($$select pg_temp.badge_page()$$,'P0002','Member progress is no longer available.','target membership loss denies pagination');
reset role;
insert into public.crew_members(crew_id,user_id,display_name,role)values('b2500000-0000-4000-8000-000000000001','a2500000-0000-4000-8000-000000000002','Target','member');
update public.entitlements set status='revoked' where user_id='a2500000-0000-4000-8000-000000000001';
set local role authenticated;
select throws_ok($$select pg_temp.badge_page()$$,'P0002','Member progress is no longer available.','entitlement loss denies pagination');
reset role;
update public.entitlements set status='active' where user_id='a2500000-0000-4000-8000-000000000001';
update public.crews set deleted_at=now(),deleted_by='a2500000-0000-4000-8000-000000000001' where id='b2500000-0000-4000-8000-000000000001';
set local role authenticated;
select throws_ok($$select pg_temp.badge_page()$$,'P0002','Member progress is no longer available.','deleted crew denies pagination');
reset role;
set local role anon;
select throws_ok($$select pg_temp.badge_page()$$,'42501',null,'anonymous RPC execution is denied');
reset role;
set local role authenticated;
set local request.jwt.claim.sub='';
select throws_ok($$select pg_temp.badge_page()$$,'P0002','Member progress is no longer available.','signed-out actor is denied');

reset role;
update public.crews set deleted_at=null,deleted_by=null where id='b2500000-0000-4000-8000-000000000001';
insert into public.badge_definitions(badge_key,name,description,category,tier,icon,sort_order)
values('seven_sealed','7-Day Perfect Streak','Current public description','challenge','silver','repeat',90)
on conflict(badge_key) do update set name=excluded.name,description=excluded.description,tier=excluded.tier,icon=excluded.icon;
insert into public.user_badges(id,user_id,badge_key,scope_key,earned_at,metadata) values
 ('c2500000-0000-4000-8000-000000000101','a2500000-0000-4000-8000-000000000002','seven_sealed','lifetime','2026-09-01T12:00:00Z','{"legacy":true,"privateNote":"Never display","awardDefinition":{"name":"Seven Sealed","description":"Originally earned description","tier":"gold","icon":"crown"}}'),
 ('c2500000-0000-4000-8000-000000000102','a2500000-0000-4000-8000-000000000002','seven_sealed','original77:2026-08-01','2026-09-01T11:00:00Z','{"awardDefinition":{"name":"7-Day Perfect Streak","description":"New earned description","tier":"silver","icon":"repeat"}}'),
 ('c2500000-0000-4000-8000-000000000103','a2500000-0000-4000-8000-000000000002','seven_sealed','original77:2026-07-01','2026-09-01T10:00:00Z','{"awardDefinition":{"name":{"private":"bad"},"description":42,"tier":"platinum","icon":123}}'),
 ('c2500000-0000-4000-8000-000000000104','a2500000-0000-4000-8000-000000000002','seven_sealed','original77:2026-06-01','2026-09-01T09:00:00Z','{}');
select ok(not has_function_privilege('authenticated','private.member_badge_presentation(jsonb,text,text,text,text)','execute')
  and not has_function_privilege('anon','private.member_badge_presentation(jsonb,text,text,text,text)','execute')
  and not has_function_privilege('service_role','private.member_badge_presentation(jsonb,text,text,text,text)','execute')
  and (select not prosecdef and provolatile='i' and proconfig @> array['search_path=""'] from pg_proc where oid='private.member_badge_presentation(jsonb,text,text,text,text)'::regprocedure),
  'snapshot projection is a private immutable security-invoker helper');
set local role authenticated;
set local request.jwt.claim.sub='a2500000-0000-4000-8000-000000000001';
insert into scoped_badge_pages values(5,pg_temp.badge_page(null,null,24));
insert into scoped_badge_pages select 6,to_jsonb(row) from public.get_crew_leaderboard('b2500000-0000-4000-8000-000000000001','challenge')row where user_id='a2500000-0000-4000-8000-000000000002';
select ok((select payload#>>'{badges,0,name}'='Seven Sealed' and payload#>>'{badges,0,tier}'='gold' and payload#>>'{badges,0,description}'='Originally earned description' from scoped_badge_pages where page=5),'member view preserves the grandfathered gold seven_sealed presentation');
select ok((select payload#>>'{badges,1,name}'='7-Day Perfect Streak' and payload#>>'{badges,1,tier}'='silver' from scoped_badge_pages where page=5),'new scoped seven_sealed retains its silver presentation');
select ok((select payload#>>'{badges,2,name}'='7-Day Perfect Streak' and payload#>>'{badges,2,tier}'='silver'
  and payload#>>'{badges,2,description}'='Current public description' and payload#>>'{badges,2,icon}'='repeat'
  and payload#>>'{badges,3,name}'='7-Day Perfect Streak' and payload#>>'{badges,3,tier}'='silver'
  from scoped_badge_pages where page=5),'malformed and missing snapshots fall back to canonical member presentation');
select ok((select payload#>>'{badges,0,name}'='Seven Sealed' and payload#>>'{badges,0,tier}'='gold' and payload#>>'{badges,0,icon}'='crown' from scoped_badge_pages where page=6),'crew leaderboard preserves grandfathered name, gold tier and icon');
select ok((select payload#>>'{badges,1,name}'='7-Day Perfect Streak' and payload#>>'{badges,1,tier}'='silver' from scoped_badge_pages where page=6),'crew leaderboard preserves the new scoped silver award');
select ok((select payload#>>'{badges,2,name}'='7-Day Perfect Streak' and payload#>>'{badges,2,tier}'='silver' and payload#>>'{badges,2,icon}'='repeat' from scoped_badge_pages where page=6),'crew leaderboard rejects malformed snapshot fields');
select ok((select jsonb_array_length(payload->'badges')=3 and not payload::text like '%Never display%' from scoped_badge_pages where page=6)
  and (select array_agg(key order by key) from jsonb_object_keys((select payload#>'{badges,0}' from scoped_badge_pages where page=6))key)=array['icon','key','name','tier'],
  'crew leaderboard keeps top-three badges and its exact four-field public allowlist');
reset role;
select ok((select length(value->>'name')=120 and length(value->>'description')=500 and value->>'tier'='silver' and value->>'icon'='repeat'
  from (select private.member_badge_presentation(jsonb_build_object('name',repeat('N',200),'description',repeat('D',600),'tier',jsonb_build_object('private',true),'icon',123),'Fallback','Description','silver','repeat')value)s)
  and private.member_badge_presentation('[]','Fallback','Description','silver','repeat')->>'name'='Fallback'
  and private.member_badge_presentation(jsonb_build_object('name',chr(7),'description','A'||chr(7)||'B'),'Fallback','Description','silver','repeat')->>'description'='AB',
  'snapshot fields are typed, bounded and control-free with safe fallback');
set local role authenticated;
set local request.jwt.claim.sub='a2500000-0000-4000-8000-000000000003';
select throws_ok($$select * from public.get_crew_leaderboard('b2500000-0000-4000-8000-000000000001','challenge')$$,'P0001','Crew membership is required to view this leaderboard.','snapshot projection does not broaden leaderboard access');
select * from finish();
rollback;
