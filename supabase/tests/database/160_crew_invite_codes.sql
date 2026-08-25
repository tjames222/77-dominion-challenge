begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(56);

create temporary table crew_code_test_values (
  key text primary key,
  value text not null
);
grant select, insert, update on crew_code_test_values to anon, authenticated;

select ok(
  to_regprocedure('public.issue_crew_invite_bundle(uuid)') is not null,
  'the bundle issuance RPC exists'
);
select ok(
  to_regprocedure('public.get_active_crew_invite(uuid)') is not null,
  'the active-invite metadata RPC exists'
);
select ok(
  to_regprocedure('public.preview_crew_invite_code(text)') is not null,
  'the join-code preview RPC exists'
);
select ok(
  has_function_privilege('anon', 'public.preview_crew_invite_code(text)', 'execute'),
  'signed-out recipients can preview a valid join code'
);
select ok(
  has_function_privilege('authenticated', 'public.issue_crew_invite_bundle(uuid)', 'execute'),
  'authenticated crew leaders can invoke bundle issuance'
);
select ok(
  not has_function_privilege('anon', 'public.issue_crew_invite_bundle(uuid)', 'execute'),
  'signed-out callers cannot issue invitation bundles'
);
select ok(
  has_function_privilege('authenticated', 'public.get_active_crew_invite(uuid)', 'execute'),
  'authenticated crew leaders can read safe invitation metadata'
);
select ok(
  not has_function_privilege('anon', 'public.get_active_crew_invite(uuid)', 'execute'),
  'signed-out callers cannot read active-invite metadata'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'private.crew_invite_code_secrets'::regclass),
  'the private HMAC secret table has RLS enabled'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'private.crew_invite_rate_limits'::regclass),
  'the private rate-limit table has RLS enabled'
);
select ok(
  not has_table_privilege('anon', 'private.crew_invite_code_secrets', 'select'),
  'anonymous callers cannot read the HMAC secret'
);
select ok(
  not has_table_privilege('authenticated', 'private.crew_invite_code_secrets', 'select'),
  'authenticated callers cannot read the HMAC secret'
);
select ok(
  not has_table_privilege('service_role', 'private.crew_invite_code_secrets', 'select'),
  'the service role cannot read the HMAC secret'
);
select ok(
  not has_table_privilege('authenticated', 'private.crew_invite_rate_limits', 'select'),
  'authenticated callers cannot inspect rate-limit scopes'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'private.crew_invite_keyed_hash(text,text)',
    'execute'
  ),
  'authenticated callers cannot use the keyed-hash helper as an oracle'
);
select ok(
  not has_function_privilege(
    'service_role',
    'private.crew_invite_keyed_hash(text,text)',
    'execute'
  ),
  'the service role cannot use the keyed-hash helper as an oracle'
);
select ok(
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'crew_invites'
      and column_name = 'code_hash'
  ),
  'crew invitations store a code digest'
);
select ok(
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'crew_invites'
      and column_name = 'code_hint'
  ),
  'crew invitations store only a short code hint alongside the digest'
);
select ok(
  not has_column_privilege(
    'authenticated',
    'public.crew_invites',
    'code_hash',
    'select'
  ),
  'authenticated callers cannot select code digests directly'
);
select ok(
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'crew_invites'
      and column_name in ('code', 'invite_code', 'join_code')
  ),
  'no plaintext join-code column exists'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
set local "request.jwt.claims" = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}';

insert into crew_code_test_values (key, value)
select 'alpha_bundle', public.issue_crew_invite_bundle(
  'a0000000-0000-4000-8000-000000000001'
)::text;

select is(
  (select value::jsonb ->> 'status' from crew_code_test_values where key = 'alpha_bundle'),
  'issued',
  'an entitled crew owner can issue one invitation bundle'
);
select is(
  char_length((select value::jsonb ->> 'code' from crew_code_test_values where key = 'alpha_bundle')),
  16,
  'a join code contains exactly 16 characters'
);
select ok(
  (select value::jsonb ->> 'code' from crew_code_test_values where key = 'alpha_bundle')
    ~ '^[34679ACDEFGHJKMNPQRTUVWXY]{16}$',
  'the join code uses only the unambiguous 25-character alphabet'
);
select ok(
  (select value::jsonb ->> 'token' from crew_code_test_values where key = 'alpha_bundle')
    ~ '^[0-9a-f]{64}$',
  'bundle issuance preserves a 256-bit link credential'
);

reset role;
select ok(
  (
    select invite_row.code_hash
    from public.crew_invites invite_row
    where invite_row.id = (
      select (value::jsonb ->> 'inviteId')::uuid
      from crew_code_test_values where key = 'alpha_bundle'
    )
  ) ~ '^[0-9a-f]{64}$',
  'the persisted join-code digest is a 256-bit value'
);
select isnt(
  (
    select invite_row.code_hash
    from public.crew_invites invite_row
    where invite_row.id = (
      select (value::jsonb ->> 'inviteId')::uuid
      from crew_code_test_values where key = 'alpha_bundle'
    )
  ),
  public.crew_invite_secret_hash(
    (select value::jsonb ->> 'code' from crew_code_test_values where key = 'alpha_bundle')
  ),
  'the stored code digest is keyed rather than a reusable plain SHA-256 hash'
);
select is(
  (
    select invite_row.code_hint
    from public.crew_invites invite_row
    where invite_row.id = (
      select (value::jsonb ->> 'inviteId')::uuid
      from crew_code_test_values where key = 'alpha_bundle'
    )
  ),
  right((select value::jsonb ->> 'code' from crew_code_test_values where key = 'alpha_bundle'), 4),
  'only the final four code characters are retained as a display hint'
);
select is(
  (
    select invite_row.id::text
    from public.crew_invites invite_row
    where invite_row.code_hash = private.crew_invite_keyed_hash(
      'code-v1',
      (select value::jsonb ->> 'code' from crew_code_test_values where key = 'alpha_bundle')
    )
  ),
  (select value::jsonb ->> 'inviteId' from crew_code_test_values where key = 'alpha_bundle'),
  'the code and link credentials resolve to the same invitation row'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
insert into crew_code_test_values (key, value)
select 'alpha_active', public.get_active_crew_invite(
  'a0000000-0000-4000-8000-000000000001'
)::text;
select is(
  (select value::jsonb ->> 'status' from crew_code_test_values where key = 'alpha_active'),
  'active',
  'an owner sees that one invitation is active'
);
select is(
  (select value::jsonb ->> 'inviteId' from crew_code_test_values where key = 'alpha_active'),
  (select value::jsonb ->> 'inviteId' from crew_code_test_values where key = 'alpha_bundle'),
  'active metadata identifies the bundle invite'
);
select ok(
  not ((select value::jsonb from crew_code_test_values where key = 'alpha_active') ?| array['code', 'token', 'codeHash', 'tokenHash']),
  'active metadata never returns raw credentials or digests'
);

reset role;
set local role anon;
set local "request.jwt.claim.sub" = '';
set local "request.jwt.claims" = '{}';
insert into crew_code_test_values (key, value)
select 'alpha_code_preview', public.preview_crew_invite_code(
  lower(
    substr((select value::jsonb ->> 'code' from crew_code_test_values where key = 'alpha_bundle'), 1, 4)
    || '-' || substr((select value::jsonb ->> 'code' from crew_code_test_values where key = 'alpha_bundle'), 5, 4)
    || ' ' || substr((select value::jsonb ->> 'code' from crew_code_test_values where key = 'alpha_bundle'), 9, 4)
    || '-' || substr((select value::jsonb ->> 'code' from crew_code_test_values where key = 'alpha_bundle'), 13, 4)
  )
)::text;
select is(
  (select value::jsonb ->> 'status' from crew_code_test_values where key = 'alpha_code_preview'),
  'ready',
  'code lookup normalizes harmless case, spaces, and hyphens'
);
select is(
  (select value::jsonb #>> '{preview,groupName}' from crew_code_test_values where key = 'alpha_code_preview'),
  'Alpha Crew',
  'a valid code returns the existing privacy-safe crew preview'
);

insert into crew_code_test_values (key, value)
select 'alpha_link_preview', public.preview_crew_invite(
  (select value::jsonb ->> 'token' from crew_code_test_values where key = 'alpha_bundle'),
  null
)::text;
select is(
  (select value::jsonb ->> 'status' from crew_code_test_values where key = 'alpha_link_preview'),
  'ready',
  'the link representation remains compatible with the hardened preview flow'
);
select is(
  (select value::jsonb #>> '{preview,groupName}' from crew_code_test_values where key = 'alpha_link_preview'),
  (select value::jsonb #>> '{preview,groupName}' from crew_code_test_values where key = 'alpha_code_preview'),
  'link and code reveal the same bounded preview'
);
select isnt(
  (select value::jsonb ->> 'continuationToken' from crew_code_test_values where key = 'alpha_link_preview'),
  (select value::jsonb ->> 'continuationToken' from crew_code_test_values where key = 'alpha_code_preview'),
  'each representation creates an independent high-entropy continuation'
);

reset role;
select is(
  (
    select count(*)::integer
    from public.crew_members member_row
    where member_row.crew_id = 'a0000000-0000-4000-8000-000000000001'
  ),
  2,
  'previewing link and code never mutates membership'
);

set local role anon;
set local "request.jwt.claim.sub" = '';
set local "request.jwt.claims" = '{}';
select is(
  public.preview_crew_invite_code('not-a-complete-code') ->> 'status',
  'invalid',
  'malformed code input receives a generic failure'
);

reset role;
update public.crew_invites
set preview_window_started_at = now(), preview_count = 119
where id = (
  select (value::jsonb ->> 'inviteId')::uuid
  from crew_code_test_values where key = 'alpha_bundle'
);
set local role anon;
set local "request.jwt.claim.sub" = '';
set local "request.jwt.claims" = '{}';
select is(
  public.preview_crew_invite(
    (select value::jsonb ->> 'token' from crew_code_test_values where key = 'alpha_bundle'),
    null
  ) ->> 'status',
  'ready',
  'the final shared per-invite preview allowance works through the link'
);
select is(
  public.preview_crew_invite_code(
    (select value::jsonb ->> 'code' from crew_code_test_values where key = 'alpha_bundle')
  ) ->> 'status',
  'rate_limited',
  'link and code share one authoritative per-invite preview limit'
);

reset role;
update public.crew_invites
set preview_window_started_at = null, preview_count = 0
where id = (
  select (value::jsonb ->> 'inviteId')::uuid
  from crew_code_test_values where key = 'alpha_bundle'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select is(
  public.revoke_crew_invite(
    (select (value::jsonb ->> 'inviteId')::uuid from crew_code_test_values where key = 'alpha_bundle')
  ) ->> 'status',
  'revoked',
  'an owner revokes the shared invitation lifecycle once'
);

reset role;
set local role anon;
set local "request.jwt.claim.sub" = '';
set local "request.jwt.claims" = '{}';
select is(
  public.preview_crew_invite(
    (select value::jsonb ->> 'token' from crew_code_test_values where key = 'alpha_bundle'),
    null
  ) ->> 'status',
  'revoked',
  'revocation invalidates the link representation'
);

reset role;
delete from private.crew_invite_rate_limits;
insert into private.crew_invite_rate_limits (
  scope_hash, window_started_at, attempt_count, updated_at
) values (
  private.crew_invite_keyed_hash('rate-v1', 'lookup:anonymous'),
  now(),
  49,
  now()
);
set local role anon;
set local "request.jwt.claim.sub" = '';
set local "request.jwt.claims" = '{}';
select is(
  public.preview_crew_invite_code(
    (select value::jsonb ->> 'code' from crew_code_test_values where key = 'alpha_bundle')
  ) ->> 'status',
  'invalid',
  'anonymous code failures stay generic after revocation'
);
select is(
  public.preview_crew_invite_code('3333333333333333') ->> 'status',
  'rate_limited',
  'hidden and nonexistent codes consume the same anonymous lookup bucket'
);

reset role;
delete from private.crew_invite_rate_limits;
insert into public.crew_invites (
  id, crew_id, token_hash, token_hint, code_hash, code_hint,
  created_by, expires_at, created_at
) values (
  '71600000-0000-4000-8000-000000000001',
  'b0000000-0000-4000-8000-000000000002',
  public.crew_invite_secret_hash('expired-code-link-secret-12345'),
  '12345',
  private.crew_invite_keyed_hash('code-v1', 'AAAAAAAAAAAAAAAA'),
  'AAAA',
  '20000000-0000-4000-8000-000000000002',
  now() - interval '1 minute',
  now() - interval '1 day'
);

set local role anon;
set local "request.jwt.claim.sub" = '';
set local "request.jwt.claims" = '{}';
select is(
  public.preview_crew_invite_code('AAAA-AAAA-AAAA-AAAA') ->> 'status',
  'invalid',
  'signed-out code lookup does not reveal that an invitation expired'
);

reset role;
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select is(
  public.preview_crew_invite_code('AAAAAAAAAAAAAAAA') ->> 'status',
  'expired',
  'an authenticated caller receives the established recoverable expiry state'
);

reset role;
set local role authenticated;
set local "request.jwt.claim.sub" = '20000000-0000-4000-8000-000000000002';
insert into crew_code_test_values (key, value)
select 'bravo_bundle', public.issue_crew_invite_bundle(
  'b0000000-0000-4000-8000-000000000002'
)::text;
select is(
  (select value::jsonb ->> 'status' from crew_code_test_values where key = 'bravo_bundle'),
  'issued',
  'a second crew owner can issue an independent bundle'
);

reset role;
set local role anon;
set local "request.jwt.claim.sub" = '';
set local "request.jwt.claims" = '{}';
insert into crew_code_test_values (key, value)
select 'bravo_preview', public.preview_crew_invite_code(
  (select value::jsonb ->> 'code' from crew_code_test_values where key = 'bravo_bundle')
)::text;
select is(
  (select value::jsonb ->> 'status' from crew_code_test_values where key = 'bravo_preview'),
  'ready',
  'the second crew code produces a confirmation continuation'
);

reset role;
update public.crew_members
set role = 'member'
where crew_id = 'b0000000-0000-4000-8000-000000000002'
  and user_id = '20000000-0000-4000-8000-000000000002';

set local role anon;
set local "request.jwt.claim.sub" = '';
set local "request.jwt.claims" = '{}';
select is(
  public.preview_crew_invite_code(
    (select value::jsonb ->> 'code' from crew_code_test_values where key = 'bravo_bundle')
  ) ->> 'status',
  'invalid',
  'a code fails closed after the inviter loses an authorized role'
);
select is(
  public.preview_crew_invite(
    (select value::jsonb ->> 'token' from crew_code_test_values where key = 'bravo_bundle'),
    null
  ) ->> 'status',
  'invalid',
  'the matching link fails closed after the same authorization loss'
);

reset role;
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select is(
  public.confirm_crew_invite(
    (select value::jsonb ->> 'continuationToken' from crew_code_test_values where key = 'bravo_preview')
  ) ->> 'status',
  'invalid',
  'confirmation rechecks inviter authorization under the transaction lock'
);

reset role;
update public.crew_members
set role = 'owner'
where crew_id = 'b0000000-0000-4000-8000-000000000002'
  and user_id = '20000000-0000-4000-8000-000000000002';
delete from private.crew_invite_rate_limits;

set local role authenticated;
set local "request.jwt.claim.sub" = '20000000-0000-4000-8000-000000000002';
do $$
declare
  suffix text;
begin
  foreach suffix in array string_to_array('3,4,6,7,9,A,C,D,E,F,G,H,J,K,M,N,P,Q,R,T', ',')
  loop
    perform public.preview_crew_invite_code(repeat('3', 15) || suffix);
  end loop;
end;
$$;
select is(
  public.preview_crew_invite_code('333333333333333U') ->> 'status',
  'rate_limited',
  'authenticated invalid-code guessing is bounded by an account-scoped bucket'
);
select is(
  public.preview_crew_invite_code(
    (select value::jsonb ->> 'code' from crew_code_test_values where key = 'bravo_bundle')
  ) ->> 'status',
  'already_member',
  'invalid-guess exhaustion cannot disable a known valid invitation'
);

reset role;
update public.crew_invites
set created_at = now() - interval '10 seconds'
where id = (
  select (value::jsonb ->> 'inviteId')::uuid
  from crew_code_test_values where key = 'alpha_bundle'
);
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
insert into crew_code_test_values (key, value)
select 'legacy_wrapper', public.issue_crew_invite(
  'a0000000-0000-4000-8000-000000000001'
)::text;
select is(
  (select value::jsonb ->> 'status' from crew_code_test_values where key = 'legacy_wrapper'),
  'issued',
  'the legacy issuance RPC remains compatible through the bundle lifecycle'
);
select ok(
  (select value::jsonb ->> 'code' from crew_code_test_values where key = 'legacy_wrapper')
    ~ '^[34679ACDEFGHJKMNPQRTUVWXY]{16}$',
  'legacy issuance also creates the code representation instead of a link-only invite'
);

reset role;
update public.crew_members
set role = case
  when user_id = '30000000-0000-4000-8000-000000000003' then 'admin'
  else 'member'
end
where crew_id = 'a0000000-0000-4000-8000-000000000001'
  and user_id in (
    '10000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000003'
  );
set local role authenticated;
set local "request.jwt.claim.sub" = '30000000-0000-4000-8000-000000000003';
select is(
  public.get_active_crew_invite('a0000000-0000-4000-8000-000000000001') ->> 'status',
  'none',
  'safe active metadata hides an invite after its issuer loses authorization'
);

reset role;
select * from finish();
rollback;
