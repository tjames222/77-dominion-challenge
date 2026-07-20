begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(21);

select ok(
  not has_table_privilege('authenticated', 'public.crew_invite_sessions', 'select'),
  'authenticated clients cannot read invite continuations directly'
);
select ok(
  not has_table_privilege('authenticated', 'public.crew_invite_attributions', 'select'),
  'authenticated clients cannot read invite attribution identities directly'
);

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
select is((select count(id)::integer from public.crew_invites), 1, 'Alice can read invites for the crew she owns');

select throws_ok(
  $$
    insert into public.crew_invites (crew_id, token_hash, created_by)
    values (
      'a0000000-0000-4000-8000-000000000001',
      repeat('a', 64),
      '10000000-0000-4000-8000-000000000001'
    )
  $$,
  '42501',
  'permission denied for table crew_invites',
  'invite creation cannot bypass the rate-limited issuance RPC'
);

select throws_ok(
  $$
    insert into public.challenge_entries (user_id, entry_date, completed)
    values ('20000000-0000-4000-8000-000000000002', '2026-07-03', array['bible'])
  $$,
  '42501',
  'permission denied for table challenge_entries',
  'authenticated clients cannot bypass trusted Daily Standard draft mutations'
);

update public.profiles
set name = 'RLS tamper attempt'
where user_id = '20000000-0000-4000-8000-000000000002';

reset role;
select is(
  (select name from public.profiles where user_id = '20000000-0000-4000-8000-000000000002'),
  'Bob Example',
  'Alice cannot update Bob profile through an invisible row'
);

set local role authenticated;

set local "request.jwt.claim.sub" = '20000000-0000-4000-8000-000000000002';
set local "request.jwt.claims" = '{"sub":"20000000-0000-4000-8000-000000000002","role":"authenticated","email":"bob@example.test"}';

select is((select count(*)::integer from public.profiles), 1, 'Bob can read only his profile');
select is((select min(name) from public.profiles), 'Bob Example', 'Bob cannot read Alice or Carol profiles');
select is((select count(*)::integer from public.crews), 1, 'Bob cannot read the Alpha crew');
select is((select count(*)::integer from public.crew_members), 1, 'Bob cannot read the Alpha roster');
select is((select count(*)::integer from public.community_posts), 1, 'Bob cannot read the Alpha post');

set local "request.jwt.claim.sub" = '30000000-0000-4000-8000-000000000003';
set local "request.jwt.claims" = '{"sub":"30000000-0000-4000-8000-000000000003","role":"authenticated","email":"carol@example.test"}';

select is((select count(*)::integer from public.crews), 1, 'a member can read her crew');
select is((select count(*)::integer from public.crew_members), 2, 'a member can read her crew roster');
select is((select count(id)::integer from public.crew_invites), 0, 'a non-admin cannot read crew invites');

select * from finish();
rollback;
