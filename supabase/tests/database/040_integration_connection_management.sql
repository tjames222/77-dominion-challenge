begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(39);

select is(
  has_table_privilege('authenticated', 'private.integration_oauth_states', 'SELECT'),
  false,
  'OAuth state records are not browser-readable'
);
select is(
  has_table_privilege('authenticated', 'private.pending_integration_connections', 'SELECT'),
  false,
  'pending encrypted provider credentials are not browser-readable'
);
select is(
  has_function_privilege(
    'authenticated',
    'public.create_integration_oauth_state(uuid,uuid,text,text,text,timestamptz)',
    'EXECUTE'
  ),
  false,
  'the browser cannot forge server-side OAuth state records'
);

select ok(
  public.create_integration_oauth_state(
    '10000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000001',
    'slack',
    repeat('a', 64),
    '/community.html',
    now() + interval '10 minutes'
  ),
  'a current group owner can begin provider authorization'
);
select throws_ok(
  $$
    select public.create_integration_oauth_state(
      '30000000-0000-4000-8000-000000000003',
      'a0000000-0000-4000-8000-000000000001',
      'slack',
      repeat('b', 64),
      '/community.html',
      now() + interval '10 minutes'
    )
  $$,
  '42501',
  'Only a group owner or admin can manage integrations.',
  'a regular group member cannot begin provider authorization'
);
select is(
  (
    select user_id
    from public.consume_integration_oauth_state('slack', repeat('a', 64))
  ),
  '10000000-0000-4000-8000-000000000001'::uuid,
  'the callback consumes state for the initiating user'
);
select ok(
  (
    select consumed_at is not null
    from private.integration_oauth_states
    where nonce_hash = repeat('a', 64)
  ),
  'consumed callback state is persisted'
);
select throws_ok(
  $$ select * from public.consume_integration_oauth_state('slack', repeat('a', 64)) $$,
  '22023',
  'Integration authorization state is invalid, expired, or already used.',
  'callback state cannot be replayed'
);

select is(
  public.create_pending_integration_connection(
    'c1000000-0000-4000-8000-000000000001',
    repeat('c', 64),
    'slack',
    'a0000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'T-ALPHA',
    'Alpha Workspace',
    decode(repeat('11', 17), 'hex'),
    decode(repeat('22', 12), 'hex'),
    1,
    repeat('d', 64),
    array['chat:write', 'channels:read', 'groups:read'],
    now() + interval '15 minutes'
  ),
  'c1000000-0000-4000-8000-000000000001'::uuid,
  'the callback stores an encrypted, expiring pending connection'
);
select throws_ok(
  $$
    select * from public.get_pending_integration_connection(
      repeat('c', 64),
      '30000000-0000-4000-8000-000000000003'
    )
  $$,
  '42501',
  'Pending integration setup is invalid or expired.',
  'a different group member cannot inspect another admin pending setup'
);
select is(
  (
    select provider_workspace_id
    from public.get_pending_integration_connection(
      repeat('c', 64),
      '10000000-0000-4000-8000-000000000001'
    )
  ),
  'T-ALPHA',
  'the initiating owner can continue pending setup'
);
select throws_ok(
  $$
    select public.prepare_integration_destination_id(
      'a0000000-0000-4000-8000-000000000001',
      'slack',
      '30000000-0000-4000-8000-000000000003'
    )
  $$,
  '42501',
  'Only a group owner or admin can manage integrations.',
  'a regular member cannot reserve a destination ID'
);

select ok(
  public.prepare_integration_destination_id(
    'a0000000-0000-4000-8000-000000000001',
    'slack',
    '10000000-0000-4000-8000-000000000001'
  ) is not null,
  'the owner receives a stable destination ID'
);

select is(
  public.complete_pending_integration_connection(
    repeat('c', 64),
    '10000000-0000-4000-8000-000000000001',
    'c2000000-0000-4000-8000-000000000002',
    'C-UPDATES',
    'dominion-updates',
    decode(repeat('33', 17), 'hex'),
    decode(repeat('44', 12), 'hex'),
    1,
    repeat('e', 64)
  ),
  'c2000000-0000-4000-8000-000000000002'::uuid,
  'an approved channel is activated with destination-bound ciphertext'
);
select is(
  (
    select status || ':' || provider_destination_id
    from private.integration_destinations
    where id = 'c2000000-0000-4000-8000-000000000002'
  ),
  'active:C-UPDATES',
  'the active destination is bound to the confirmed channel'
);
select ok(
  (
    select consumed_at is not null
      and credential_ciphertext = decode(repeat('00', 17), 'hex')
    from private.pending_integration_connections
    where id = 'c1000000-0000-4000-8000-000000000001'
  ),
  'pending credentials are tombstoned immediately after confirmation'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
set local "request.jwt.claims" = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is(
  (
    select count(*)::integer
    from public.list_crew_integration_destinations('a0000000-0000-4000-8000-000000000001')
  ),
  1,
  'a group owner can read one sanitized destination'
);
select is(
  (
    select can_manage
    from public.list_crew_integration_destinations('a0000000-0000-4000-8000-000000000001')
  ),
  true,
  'sanitized status identifies the current owner as a manager'
);

set local "request.jwt.claim.sub" = '30000000-0000-4000-8000-000000000003';
set local "request.jwt.claims" = '{"sub":"30000000-0000-4000-8000-000000000003","role":"authenticated"}';
select is(
  (
    select can_manage
    from public.list_crew_integration_destinations('a0000000-0000-4000-8000-000000000001')
  ),
  false,
  'regular members can see external status but cannot manage it'
);

set local "request.jwt.claim.sub" = '20000000-0000-4000-8000-000000000002';
set local "request.jwt.claims" = '{"sub":"20000000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok(
  $$ select * from public.list_crew_integration_destinations('a0000000-0000-4000-8000-000000000001') $$,
  '42501',
  'This private group is not available.',
  'a user in another group cannot inspect destination status'
);
reset role;

select ok(
  public.mark_integration_destination_health(
    'c2000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    false,
    'provider_authorization_failed'
  ),
  'a provider authorization failure is recorded'
);
select is(
  (
    select status from private.integration_destinations
    where id = 'c2000000-0000-4000-8000-000000000002'
  ),
  'reconnect_required',
  'revoked provider access becomes visible as needs attention'
);
select throws_ok(
  $$
    select public.mark_integration_destination_health(
      'c2000000-0000-4000-8000-000000000002',
      '30000000-0000-4000-8000-000000000003',
      true,
      null
    )
  $$,
  '42501',
  'Only a group owner or admin can manage integrations.',
  'a regular member cannot overwrite provider health'
);
select ok(
  public.mark_integration_destination_health(
    'c2000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    true,
    null
  ),
  'a successful admin test restores active health'
);

select ok(
  public.enqueue_outbound_delivery(
    'a0000000-0000-4000-8000-000000000001',
    'c2000000-0000-4000-8000-000000000002',
    'check_in.committed',
    'connection:test:queued',
    '{"text":"Queued before disconnect."}',
    3,
    now()
  ) is not null,
  'an active destination accepts queued events'
);
select ok(
  public.disconnect_integration_destination(
    'c2000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001'
  ),
  'the current owner can disconnect the destination'
);
select ok(
  (
    select status = 'disconnected'
      and credential_ciphertext is null
      and credential_nonce is null
      and credential_key_version is null
    from private.integration_destinations
    where id = 'c2000000-0000-4000-8000-000000000002'
  ),
  'disconnect immediately removes stored provider authorization'
);
select is(
  (
    select status from private.outbound_deliveries
    where idempotency_key = 'connection:test:queued'
  ),
  'cancelled',
  'disconnect cancels queued external updates'
);
select throws_ok(
  $$
    select public.enqueue_outbound_delivery(
      'a0000000-0000-4000-8000-000000000001',
      'c2000000-0000-4000-8000-000000000002',
      'check_in.committed',
      'connection:test:after-disconnect',
      '{"text":"Must not queue."}',
      3,
      now()
    )
  $$,
  '55000',
  'The integration destination is not active.',
  'disconnect prevents new delivery publication'
);

update private.integration_destinations
set status = 'active',
    credential_ciphertext = decode(repeat('55', 17), 'hex'),
    credential_nonce = decode(repeat('66', 12), 'hex'),
    credential_key_version = 1,
    credential_fingerprint = repeat('f', 64),
    disconnected_at = null
where id = 'c2000000-0000-4000-8000-000000000002';

select public.enqueue_outbound_delivery(
  'a0000000-0000-4000-8000-000000000001',
  'c2000000-0000-4000-8000-000000000002',
  'synthetic.delivery',
  'connection:test:claimed-race',
  '{"text":"Claimed before disconnect."}',
  3,
  now()
);
select count(*)
from public.claim_outbound_deliveries('d1000000-0000-4000-8000-000000000001', 20);
select ok(
  public.disconnect_integration_destination(
    'c2000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001'
  ),
  'disconnect succeeds while a worker owns an in-flight row'
);
select is(
  public.validate_claimed_outbound_delivery(
    (select id from private.outbound_deliveries where idempotency_key = 'connection:test:claimed-race'),
    'd1000000-0000-4000-8000-000000000001'
  ),
  false,
  'the worker recheck blocks a send claimed just before disconnect'
);
select is(
  public.settle_outbound_delivery(
    (select id from private.outbound_deliveries where idempotency_key = 'connection:test:claimed-race'),
    'd1000000-0000-4000-8000-000000000001',
    'dead_letter',
    now(),
    null,
    null,
    null,
    'destination_disconnected',
    'The provider destination is no longer active.'
  ),
  'dead_letter',
  'the disconnected in-flight row settles without a provider send'
);

update private.integration_destinations
set status = 'active',
    credential_ciphertext = decode(repeat('77', 17), 'hex'),
    credential_nonce = decode(repeat('88', 12), 'hex'),
    credential_key_version = 1,
    credential_fingerprint = repeat('9', 64),
    disconnected_at = null
where id = 'c2000000-0000-4000-8000-000000000002';
select public.enqueue_outbound_delivery(
  'a0000000-0000-4000-8000-000000000001',
  'c2000000-0000-4000-8000-000000000002',
  'synthetic.delivery',
  'connection:test:delivered',
  '{"text":"Delivery health."}',
  3,
  now()
);
select count(*)
from public.claim_outbound_deliveries('d1000000-0000-4000-8000-000000000002', 20);
select is(
  public.settle_outbound_delivery(
    (select id from private.outbound_deliveries where idempotency_key = 'connection:test:delivered'),
    'd1000000-0000-4000-8000-000000000002',
    'delivered',
    now(),
    200,
    'provider-request-success'
  ),
  'delivered',
  'a connected destination records a successful delivery'
);
select ok(
  (
    select last_delivered_at is not null
    from private.integration_destinations
    where id = 'c2000000-0000-4000-8000-000000000002'
  ),
  'member-visible status tracks the last successful delivery'
);

select public.enqueue_outbound_delivery(
  'a0000000-0000-4000-8000-000000000001',
  'c2000000-0000-4000-8000-000000000002',
  'synthetic.delivery',
  'connection:test:revoked',
  '{"text":"Revoked provider authorization."}',
  1,
  now()
);
select count(*)
from public.claim_outbound_deliveries('d1000000-0000-4000-8000-000000000003', 20);
select is(
  public.settle_outbound_delivery(
    (select id from private.outbound_deliveries where idempotency_key = 'connection:test:revoked'),
    'd1000000-0000-4000-8000-000000000003',
    'dead_letter',
    now(),
    401,
    null,
    null,
    'provider_authorization_failed',
    'Provider authorization was revoked.'
  ),
  'dead_letter',
  'a revoked provider authorization is recorded as a terminal delivery'
);
select is(
  (
    select status || ':' || last_error_code
    from private.integration_destinations
    where id = 'c2000000-0000-4000-8000-000000000002'
  ),
  'reconnect_required:provider_authorization_failed',
  'worker-detected revocation becomes a member-visible needs-attention state'
);

select private.record_integration_connection_audit(
  'a0000000-0000-4000-8000-000000000001',
  'c2000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000001',
  'slack',
  'test_succeeded',
  'succeeded',
  '{"token":"must-redact","nested":{"authorization":"must-redact"}}'
);
select is(
  (
    select metadata ->> 'token'
    from private.integration_connection_audit
    where action = 'test_succeeded'
      and metadata ? 'token'
    order by id desc
    limit 1
  ),
  '[redacted]',
  'connection audit metadata cannot retain credentials'
);
select ok(
  (
    select count(*) >= 5
    from private.integration_connection_audit
    where crew_id = 'a0000000-0000-4000-8000-000000000001'
  ),
  'connection lifecycle changes leave a server-only audit trail'
);
select throws_ok(
  $$
    insert into private.integration_destinations (
      crew_id,
      provider,
      provider_workspace_id,
      provider_destination_id,
      display_name,
      credential_ciphertext,
      credential_nonce,
      credential_key_version,
      credential_fingerprint,
      installed_by
    ) values (
      'a0000000-0000-4000-8000-000000000001',
      'slack',
      'T-OTHER',
      'C-OTHER',
      'other',
      decode(repeat('aa', 17), 'hex'),
      decode(repeat('bb', 12), 'hex'),
      1,
      repeat('c', 64),
      '10000000-0000-4000-8000-000000000001'
    )
  $$,
  '23505',
  'duplicate key value violates unique constraint "integration_destinations_crew_provider_unique"',
  'a private group can connect at most one channel per provider'
);

select * from finish();
rollback;
