begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(26);

insert into public.outbound_update_preferences (
  crew_id,
  user_id,
  outbound_updates_enabled,
  presentation_mode,
  share_check_ins
) values
  ('a0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', true, 'named', true),
  ('a0000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000003', false, 'anonymous', false);

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
set local "request.jwt.claims" = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","email":"alice@example.test"}';

select is((select count(*)::integer from public.profiles), 1, 'Alice can read only her profile');
select is((select min(name) from public.profiles), 'Alice Example', 'Alice cannot read Bob or Carol profiles');
select is((select count(*)::integer from public.challenge_entries), 1, 'Alice can read only her draft entries');
select is((select count(*)::integer from public.game_point_events), 1, 'Alice can read only her point ledger');
select is((select count(*)::integer from public.crews), 1, 'Alice can read only crews she belongs to');
select is((select count(*)::integer from public.crew_members), 2, 'Alice can read her complete crew roster');
select is((select count(*)::integer from public.community_posts), 1, 'Alice cannot read another crew post');
select is((select count(*)::integer from public.crew_invites), 1, 'Alice can read invites for the crew she owns');
select is((select count(*)::integer from public.outbound_update_preferences), 1, 'Alice can read only her consent preference');
select is((select count(*)::integer from public.outbound_update_preference_audit), 1, 'Alice can read only her consent audit history');

select throws_ok(
  $$
    select public.get_current_outbound_consent(
      '30000000-0000-4000-8000-000000000003',
      'a0000000-0000-4000-8000-000000000001',
      'check_in'
    )
  $$,
  'P0001',
  'You can only read your own outbound update consent.',
  'a crew owner cannot resolve another member consent'
);

select throws_ok(
  $$
    insert into public.challenge_entries (user_id, entry_date, completed)
    values ('20000000-0000-4000-8000-000000000002', '2026-07-03', array['bible'])
  $$,
  '42501',
  'new row violates row-level security policy for table "challenge_entries"',
  'Alice cannot create a draft entry for Bob'
);

update public.profiles
set name = 'RLS tamper attempt'
where user_id = '20000000-0000-4000-8000-000000000002';

update public.outbound_update_preferences
set presentation_mode = 'named'
where user_id = '30000000-0000-4000-8000-000000000003';

reset role;
select is(
  (select name from public.profiles where user_id = '20000000-0000-4000-8000-000000000002'),
  'Bob Example',
  'Alice cannot update Bob profile through an invisible row'
);
select is(
  (
    select presentation_mode
    from public.outbound_update_preferences
    where user_id = '30000000-0000-4000-8000-000000000003'
  ),
  'anonymous',
  'a crew owner cannot change another member consent'
);

set local role authenticated;

set local "request.jwt.claim.sub" = '20000000-0000-4000-8000-000000000002';
set local "request.jwt.claims" = '{"sub":"20000000-0000-4000-8000-000000000002","role":"authenticated","email":"bob@example.test"}';

select is((select count(*)::integer from public.profiles), 1, 'Bob can read only his profile');
select is((select min(name) from public.profiles), 'Bob Example', 'Bob cannot read Alice or Carol profiles');
select is((select count(*)::integer from public.crews), 1, 'Bob cannot read the Alpha crew');
select is((select count(*)::integer from public.crew_members), 1, 'Bob cannot read the Alpha roster');
select is((select count(*)::integer from public.community_posts), 1, 'Bob cannot read the Alpha post');
select is((select count(*)::integer from public.outbound_update_preferences), 0, 'Bob cannot read another crew consent preference');
select is((select count(*)::integer from public.outbound_update_preference_audit), 0, 'Bob cannot read another member consent audit');

set local "request.jwt.claim.sub" = '30000000-0000-4000-8000-000000000003';
set local "request.jwt.claims" = '{"sub":"30000000-0000-4000-8000-000000000003","role":"authenticated","email":"carol@example.test"}';

select is((select count(*)::integer from public.crews), 1, 'a member can read her crew');
select is((select count(*)::integer from public.crew_members), 2, 'a member can read her crew roster');
select is((select count(*)::integer from public.crew_invites), 0, 'a non-admin cannot read crew invites');
select is((select count(*)::integer from public.outbound_update_preferences), 1, 'Carol can read only her consent preference');
select is((select count(*)::integer from public.outbound_update_preference_audit), 1, 'Carol can read only her consent audit history');

select * from finish();
rollback;
