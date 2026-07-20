begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(32);

create temporary table invite_test_values (
  key text primary key,
  value text not null
);
grant select, insert, update on invite_test_values to anon, authenticated;

select ok(
  has_function_privilege('anon', 'public.preview_crew_invite(text,text)', 'execute'),
  'signed-out recipients can request a privacy-safe preview'
);
select ok(
  not has_function_privilege('anon', 'public.confirm_crew_invite(text)', 'execute'),
  'signed-out recipients cannot confirm membership'
);

set local role anon;
insert into invite_test_values (key, value)
select 'alpha_preview', public.preview_crew_invite('seed-alpha-invite', null)::text;

select is(
  (select value::jsonb ->> 'status' from invite_test_values where key = 'alpha_preview'),
  'ready',
  'opening a valid link only creates a ready preview'
);
select is(
  (select value::jsonb #>> '{preview,groupName}' from invite_test_values where key = 'alpha_preview'),
  'Alpha Crew',
  'the preview identifies the invited group'
);
select is(
  (select value::jsonb #>> '{preview,inviterName}' from invite_test_values where key = 'alpha_preview'),
  'Alice',
  'the preview exposes only the inviter first name'
);
select ok(
  not ((select value::jsonb from invite_test_values where key = 'alpha_preview') -> 'preview' ? 'description'),
  'the preview does not reveal the private description or roster'
);

reset role;
select is(
  (select count(*)::integer from public.crew_members where crew_id = 'a0000000-0000-4000-8000-000000000001' and user_id = '20000000-0000-4000-8000-000000000002'),
  0,
  'preview creates no membership row before explicit confirmation'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '20000000-0000-4000-8000-000000000002';
set local "request.jwt.claims" = '{"sub":"20000000-0000-4000-8000-000000000002","role":"authenticated","email":"bob@example.test"}';

insert into invite_test_values (key, value)
select 'alpha_authenticated_preview', public.preview_crew_invite(
  null,
  (select value::jsonb ->> 'continuationToken' from invite_test_values where key = 'alpha_preview')
)::text;

select is(
  (select value::jsonb ->> 'status' from invite_test_values where key = 'alpha_authenticated_preview'),
  'ready',
  'the short-lived continuation survives authentication and binds to the account'
);
select is(
  (select count(*)::integer from public.crew_members where crew_id = 'a0000000-0000-4000-8000-000000000001' and user_id = auth.uid()),
  0,
  'authenticated preview still does not create membership'
);

insert into invite_test_values (key, value)
select 'alpha_confirmation', public.confirm_crew_invite(
  (select value::jsonb ->> 'continuationToken' from invite_test_values where key = 'alpha_preview')
)::text;

select is(
  (select value::jsonb ->> 'status' from invite_test_values where key = 'alpha_confirmation'),
  'joined',
  'explicit confirmation joins the recipient'
);
select ok(
  char_length((select value::jsonb ->> 'redemptionId' from invite_test_values where key = 'alpha_confirmation')) > 20,
  'successful confirmation returns a stable redemption ID'
);

reset role;
select is(
  (select count(*)::integer from public.crew_members where crew_id = 'a0000000-0000-4000-8000-000000000001' and user_id = '20000000-0000-4000-8000-000000000002'),
  1,
  'confirmation creates exactly one membership row'
);
select is(
  (select count(*)::integer from public.crew_invite_attributions where recipient_user_id = '20000000-0000-4000-8000-000000000002'),
  1,
  'confirmation creates one auditable attribution'
);
select is(
  (select inviter_user_id from public.crew_invite_attributions where recipient_user_id = '20000000-0000-4000-8000-000000000002'),
  '10000000-0000-4000-8000-000000000001'::uuid,
  'attribution is permanently assigned to the issuing inviter'
);
select is(
  (select id::text from public.crew_invite_attributions where recipient_user_id = '20000000-0000-4000-8000-000000000002'),
  (select value::jsonb ->> 'redemptionId' from invite_test_values where key = 'alpha_confirmation'),
  'the response redemption ID identifies the server audit row'
);
select throws_ok(
  $$
    update public.crew_invite_attributions
    set inviter_user_id = '20000000-0000-4000-8000-000000000002'
    where recipient_user_id = '20000000-0000-4000-8000-000000000002'
  $$,
  'P0001',
  'Crew invite attribution identity is immutable.',
  'an inviter attribution cannot be reassigned'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '20000000-0000-4000-8000-000000000002';
select is(
  public.confirm_crew_invite(
    (select value::jsonb ->> 'continuationToken' from invite_test_values where key = 'alpha_preview')
  ) ->> 'status',
  'already_member',
  'replaying a confirmed continuation cannot add or attribute membership twice'
);

reset role;
insert into public.crew_invites (id, crew_id, token_hash, token_hint, created_by, expires_at, created_at)
values (
  'c1000000-0000-4000-8000-000000000003',
  'b0000000-0000-4000-8000-000000000002',
  public.crew_invite_secret_hash('wrong-account-invite-12345'),
  '12345',
  '20000000-0000-4000-8000-000000000002',
  '2099-01-01 00:00:00+00',
  '2026-07-01 12:00:00+00'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '30000000-0000-4000-8000-000000000003';
insert into invite_test_values (key, value)
select 'wrong_account_preview', public.preview_crew_invite('wrong-account-invite-12345', null)::text;

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select is(
  public.confirm_crew_invite(
    (select value::jsonb ->> 'continuationToken' from invite_test_values where key = 'wrong_account_preview')
  ) ->> 'status',
  'wrong_account',
  'a continuation bound to one account cannot be redeemed by another'
);

reset role;
insert into public.crew_invites (id, crew_id, token_hash, created_by, expires_at, revoked_at, redeemed_by, redeemed_at, created_at)
values
  (
    'd1000000-0000-4000-8000-000000000004',
    'b0000000-0000-4000-8000-000000000002',
    public.crew_invite_secret_hash('revoked-invite-secret-12345'),
    '20000000-0000-4000-8000-000000000002',
    '2099-01-01 00:00:00+00',
    now(),
    null,
    null,
    '2026-07-01 12:00:00+00'
  ),
  (
    'e1000000-0000-4000-8000-000000000005',
    'b0000000-0000-4000-8000-000000000002',
    public.crew_invite_secret_hash('expired-invite-secret-12345'),
    '20000000-0000-4000-8000-000000000002',
    now() - interval '1 minute',
    null,
    null,
    null,
    '2026-07-01 12:00:00+00'
  ),
  (
    'f1000000-0000-4000-8000-000000000006',
    'b0000000-0000-4000-8000-000000000002',
    public.crew_invite_secret_hash('used-invite-secret-12345678'),
    '20000000-0000-4000-8000-000000000002',
    '2099-01-01 00:00:00+00',
    null,
    '30000000-0000-4000-8000-000000000003',
    now(),
    '2026-07-01 12:00:00+00'
  );

set local role anon;
select is(public.preview_crew_invite('revoked-invite-secret-12345', null) ->> 'status', 'revoked', 'revoked links fail without private details');
select is(public.preview_crew_invite('expired-invite-secret-12345', null) ->> 'status', 'expired', 'expired links report a recoverable state');
select is(public.preview_crew_invite('used-invite-secret-12345678', null) ->> 'status', 'already_used', 'one-time links reject a second recipient');
select ok(
  not (public.preview_crew_invite('expired-invite-secret-12345', null) ? 'preview'),
  'invalid lifecycle states reveal no private-group preview'
);

reset role;
update public.crews set member_limit = 1 where id = 'b0000000-0000-4000-8000-000000000002';
insert into public.crew_invites (id, crew_id, token_hash, created_by, expires_at, created_at)
values (
  '11111111-0000-4000-8000-000000000007',
  'b0000000-0000-4000-8000-000000000002',
  public.crew_invite_secret_hash('full-group-invite-secret-12345'),
  '20000000-0000-4000-8000-000000000002',
  '2099-01-01 00:00:00+00',
  '2026-07-01 12:00:00+00'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
insert into invite_test_values (key, value)
select 'full_preview', public.preview_crew_invite('full-group-invite-secret-12345', null)::text;
select is((select value::jsonb ->> 'status' from invite_test_values where key = 'full_preview'), 'full', 'full groups cannot be joined');
select ok(not ((select value::jsonb from invite_test_values where key = 'full_preview') ? 'preview'), 'full-group failures do not expose group identity');
select is(
  public.confirm_crew_invite((select value::jsonb ->> 'continuationToken' from invite_test_values where key = 'full_preview')) ->> 'status',
  'full',
  'capacity is rechecked under a server lock at confirmation'
);

reset role;
insert into public.crew_invites (id, crew_id, token_hash, created_by, expires_at, created_at)
values (
  '22222222-0000-4000-8000-000000000008',
  'a0000000-0000-4000-8000-000000000001',
  public.crew_invite_secret_hash('existing-member-secret-12345'),
  '10000000-0000-4000-8000-000000000001',
  '2099-01-01 00:00:00+00',
  '2026-07-01 12:00:00+00'
);
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select is(
  public.preview_crew_invite('existing-member-secret-12345', null) ->> 'status',
  'already_member',
  'an existing member receives an idempotent state instead of another membership'
);

reset role;
update public.crews set member_limit = 50 where id = 'b0000000-0000-4000-8000-000000000002';
insert into public.crew_invites (id, crew_id, token_hash, created_by, expires_at, created_at)
values (
  '33333333-0000-4000-8000-000000000009',
  'b0000000-0000-4000-8000-000000000002',
  public.crew_invite_secret_hash('subscription-invite-secret-12345'),
  '20000000-0000-4000-8000-000000000002',
  '2099-01-01 00:00:00+00',
  '2026-07-01 12:00:00+00'
);
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
insert into invite_test_values (key, value)
select 'subscription_preview', public.preview_crew_invite('subscription-invite-secret-12345', null)::text;
reset role;
update public.entitlements
set status = 'inactive'
where user_id = '10000000-0000-4000-8000-000000000001' and entitlement_key = 'membership_active';
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select is(
  public.confirm_crew_invite((select value::jsonb ->> 'continuationToken' from invite_test_values where key = 'subscription_preview')) ->> 'status',
  'subscription_required',
  'membership access is rechecked when the recipient confirms'
);

reset role;
update public.entitlements
set status = 'active'
where user_id = '10000000-0000-4000-8000-000000000001' and entitlement_key = 'membership_active';

insert into public.crew_invites (id, crew_id, token_hash, created_by, expires_at, created_at)
values (
  '44444444-0000-4000-8000-000000000010',
  'b0000000-0000-4000-8000-000000000002',
  public.crew_invite_secret_hash('server-revoke-secret-123456'),
  '20000000-0000-4000-8000-000000000002',
  '2099-01-01 00:00:00+00',
  '2026-07-01 12:00:00+00'
);
set local role authenticated;
set local "request.jwt.claim.sub" = '20000000-0000-4000-8000-000000000002';
select is(
  public.revoke_crew_invite('44444444-0000-4000-8000-000000000010') ->> 'status',
  'revoked',
  'a group admin can revoke an invite through the authoritative RPC'
);
select is(
  public.preview_crew_invite('server-revoke-secret-123456', null) ->> 'status',
  'revoked',
  'revocation takes effect before any later confirmation'
);

reset role;
select ok(
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'crew_invites' and column_name = 'token'
  ),
  'plaintext invite tokens are not stored in the database'
);
select ok(
  to_regprocedure('public.join_crew_by_invite(text)') is null,
  'the legacy auto-join RPC is removed'
);

insert into public.crew_invites (crew_id, token_hash, created_by, expires_at, created_at)
select
  'a0000000-0000-4000-8000-000000000001',
  public.crew_invite_secret_hash('rate-limit-secret-' || sequence_number::text),
  '10000000-0000-4000-8000-000000000001',
  now() + interval '14 days',
  now() - (sequence_number || ' seconds')::interval
from generate_series(1, 10) sequence_number;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select is(
  public.issue_crew_invite('a0000000-0000-4000-8000-000000000001') ->> 'status',
  'rate_limited',
  'invite rotation rate limits are enforced on the server'
);

select * from finish();
rollback;
