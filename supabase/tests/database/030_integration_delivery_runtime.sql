begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(30);

insert into private.integration_destinations (
  id,
  crew_id,
  provider,
  provider_workspace_id,
  provider_destination_id,
  display_name,
  credential_ciphertext,
  credential_nonce,
  credential_key_version,
  credential_fingerprint,
  scopes,
  installed_by
) values
  (
    'c0000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000001',
    'slack',
    'T-ALPHA',
    'C-ALPHA',
    'Alpha updates',
    decode(repeat('aa', 17), 'hex'),
    decode(repeat('bb', 12), 'hex'),
    1,
    repeat('c', 64),
    array['chat:write'],
    '10000000-0000-4000-8000-000000000001'
  ),
  (
    'c0000000-0000-4000-8000-000000000002',
    'b0000000-0000-4000-8000-000000000002',
    'discord',
    'G-BRAVO',
    'C-BRAVO',
    'Bravo updates',
    decode(repeat('dd', 17), 'hex'),
    decode(repeat('ee', 12), 'hex'),
    1,
    repeat('f', 64),
    array['SendMessages'],
    '20000000-0000-4000-8000-000000000002'
  );

select is(
  has_schema_privilege('authenticated', 'private', 'USAGE'),
  false,
  'authenticated users cannot resolve the private integration schema'
);
select is(
  has_table_privilege('authenticated', 'private.integration_destinations', 'SELECT'),
  false,
  'provider destinations and encrypted credentials are not browser-readable'
);
update private.integration_destinations
set metadata = '{"provider":"slack","token":"must-redact","nested":{"authorization":"must-redact"}}'
where id = 'c0000000-0000-4000-8000-000000000001';
select is(
  (
    select metadata
    from private.integration_destinations
    where id = 'c0000000-0000-4000-8000-000000000001'
  ),
  '{"provider":"slack","token":"[redacted]","nested":{"authorization":"[redacted]"}}'::jsonb,
  'destination metadata is redacted before persistence'
);
select is(
  has_function_privilege(
    'authenticated',
    'public.enqueue_outbound_delivery(uuid,uuid,text,text,jsonb,integer,timestamptz)',
    'EXECUTE'
  ),
  false,
  'authenticated users cannot invoke the server-side enqueue RPC directly'
);
select is(
  has_function_privilege(
    'service_role',
    'public.enqueue_outbound_delivery(uuid,uuid,text,text,jsonb,integer,timestamptz)',
    'EXECUTE'
  ),
  true,
  'the Edge Function service role can invoke the enqueue contract'
);

select ok(
  public.enqueue_outbound_delivery(
    'a0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    'check_in.committed',
    'check-in:alice:2026-07-19',
    '{"text":"Alice checked in."}',
    5,
    now()
  ) is not null,
  'a valid group-scoped delivery is enqueued'
);
select is(
  public.enqueue_outbound_delivery(
    'a0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    'check_in.committed',
    'check-in:alice:2026-07-19',
    '{"text":"Alice checked in."}',
    5,
    now()
  ),
  (
    select id from private.outbound_deliveries
    where idempotency_key = 'check-in:alice:2026-07-19'
  ),
  'an exact enqueue retry returns the original delivery ID'
);
select is(
  (
    select count(*)::integer from private.outbound_deliveries
    where idempotency_key = 'check-in:alice:2026-07-19'
  ),
  1,
  'idempotent retries create one outbox row'
);
select throws_ok(
  $$
    select public.enqueue_outbound_delivery(
      'a0000000-0000-4000-8000-000000000001',
      'c0000000-0000-4000-8000-000000000001',
      'check_in.committed',
      'check-in:alice:2026-07-19',
      '{"text":"Changed content."}',
      5,
      now()
    )
  $$,
  '23505',
  'The idempotency key was reused with different delivery data.',
  'an idempotency key cannot silently represent different event data'
);
select throws_ok(
  $$
    select public.enqueue_outbound_delivery(
      'b0000000-0000-4000-8000-000000000002',
      'c0000000-0000-4000-8000-000000000001',
      'check_in.committed',
      'cross-group:test:1',
      '{"text":"Wrong group."}',
      5,
      now()
    )
  $$,
  '42501',
  'The integration destination does not belong to this group.',
  'the enqueue contract rejects a cross-group destination'
);

update private.integration_destinations
set status = 'disconnected', disconnected_at = now()
where id = 'c0000000-0000-4000-8000-000000000002';

select throws_ok(
  $$
    select public.enqueue_outbound_delivery(
      'b0000000-0000-4000-8000-000000000002',
      'c0000000-0000-4000-8000-000000000002',
      'check_in.committed',
      'inactive:test:1',
      '{"text":"Disconnected."}',
      5,
      now()
    )
  $$,
  '55000',
  'The integration destination is not active.',
  'disconnected destinations reject new deliveries'
);

select is(
  (
    select count(*)::integer
    from public.claim_outbound_deliveries(
      'd0000000-0000-4000-8000-000000000001',
      20
    )
  ),
  1,
  'one worker atomically claims the ready delivery'
);
select is(
  (
    select status || ':' || attempt_count::text
    from private.outbound_deliveries
    where idempotency_key = 'check-in:alice:2026-07-19'
  ),
  'processing:1',
  'claiming marks the delivery processing and increments its attempt'
);
select is(
  (
    select count(*)::integer
    from public.claim_outbound_deliveries(
      'd0000000-0000-4000-8000-000000000002',
      20
    )
  ),
  0,
  'a competing worker cannot claim an active lock'
);
select throws_ok(
  $$
    select public.settle_outbound_delivery(
      (select id from private.outbound_deliveries where idempotency_key = 'check-in:alice:2026-07-19'),
      'd0000000-0000-4000-8000-000000000002',
      'delivered',
      now()
    )
  $$,
  '55000',
  'The delivery is not owned by this worker.',
  'a worker cannot settle another worker lock'
);
select is(
  public.settle_outbound_delivery(
    (select id from private.outbound_deliveries where idempotency_key = 'check-in:alice:2026-07-19'),
    'd0000000-0000-4000-8000-000000000001',
    'retry',
    now(),
    503,
    'provider-request-1',
    1,
    'provider_unavailable',
    'Temporary provider failure.',
    '{"provider":"slack","token":"must-redact","nested":{"authorization":"must-redact"}}'
  ),
  'retry',
  'a retryable provider outcome is rescheduled'
);
select is(
  (
    select status || ':' || (lock_token is null)::text
    from private.outbound_deliveries
    where idempotency_key = 'check-in:alice:2026-07-19'
  ),
  'retry:true',
  'settling a retry releases the worker lock'
);
select is(
  (
    select response_metadata ->> 'token'
    from private.integration_delivery_attempts attempt
    join private.outbound_deliveries delivery on delivery.id = attempt.delivery_id
    where delivery.idempotency_key = 'check-in:alice:2026-07-19'
  ),
  '[redacted]',
  'attempt metadata is redacted before persistence'
);

update private.outbound_deliveries
set available_at = now() - interval '1 second'
where idempotency_key = 'check-in:alice:2026-07-19';

select is(
  (
    select count(*)::integer
    from public.claim_outbound_deliveries(
      'd0000000-0000-4000-8000-000000000001',
      20
    )
  ),
  1,
  'the retry becomes claimable after its availability window'
);
select is(
  public.settle_outbound_delivery(
    (select id from private.outbound_deliveries where idempotency_key = 'check-in:alice:2026-07-19'),
    'd0000000-0000-4000-8000-000000000001',
    'delivered',
    now(),
    200,
    'provider-request-2'
  ),
  'delivered',
  'a later attempt can deliver successfully'
);
select is(
  (
    select delivery.status || ':' || count(attempt.id)::text
    from private.outbound_deliveries delivery
    join private.integration_delivery_attempts attempt on attempt.delivery_id = delivery.id
    where delivery.idempotency_key = 'check-in:alice:2026-07-19'
    group by delivery.status
  ),
  'delivered:2',
  'delivery state and immutable attempt history agree'
);

select public.enqueue_outbound_delivery(
  'a0000000-0000-4000-8000-000000000001',
  'c0000000-0000-4000-8000-000000000001',
  'synthetic.delivery',
  'max-attempt:test:1',
  '{"text":"Max attempt."}',
  1,
  now()
);
select count(*)
from public.claim_outbound_deliveries('d0000000-0000-4000-8000-000000000003', 20);

select is(
  public.settle_outbound_delivery(
    (select id from private.outbound_deliveries where idempotency_key = 'max-attempt:test:1'),
    'd0000000-0000-4000-8000-000000000003',
    'retry',
    now(),
    503,
    null,
    1,
    'provider_unavailable',
    'Temporary failure.'
  ),
  'dead_letter',
  'the database converts a retry at the attempt limit into a dead letter'
);
select is(
  (
    select status from private.outbound_deliveries
    where idempotency_key = 'max-attempt:test:1'
  ),
  'dead_letter',
  'attempt exhaustion persists dead-letter state'
);

select public.enqueue_outbound_delivery(
  'a0000000-0000-4000-8000-000000000001',
  'c0000000-0000-4000-8000-000000000001',
  'synthetic.delivery',
  'stale-lock:test:1',
  '{"text":"Stale lock."}',
  2,
  now()
);
select count(*)
from public.claim_outbound_deliveries('d0000000-0000-4000-8000-000000000004', 20);
update private.outbound_deliveries
set locked_at = now() - interval '10 minutes'
where idempotency_key = 'stale-lock:test:1';

select is(
  public.release_stale_outbound_deliveries(interval '5 minutes'),
  1,
  'the retry runner releases one expired worker lock'
);
select is(
  (
    select delivery.status || ':' || attempt.outcome
    from private.outbound_deliveries delivery
    join private.integration_delivery_attempts attempt on attempt.delivery_id = delivery.id
    where delivery.idempotency_key = 'stale-lock:test:1'
  ),
  'retry:worker_timeout',
  'a stale lock becomes a retry with an auditable timeout attempt'
);
select is(
  public.redact_integration_metadata(
    '{"token":"secret","nested":{"authorization":"secret","status":429},"items":[{"body":"secret","code":"rate"}]}'
  ),
  '{"token":"[redacted]","nested":{"authorization":"[redacted]","status":429},"items":[{"body":"[redacted]","code":"rate"}]}'::jsonb,
  'recursive redaction covers nested objects and arrays'
);
select ok(
  (public.integration_delivery_health() ->> 'deadLettersLast24Hours')::integer >= 1,
  'health signals expose recent dead-letter volume'
);

update private.outbound_deliveries
set delivered_at = now() - interval '8 days'
where idempotency_key = 'check-in:alice:2026-07-19';
update private.integration_delivery_attempts
set completed_at = now() - interval '31 days',
    response_metadata = '{"provider":"slack","request":"metadata"}',
    error_summary = 'old diagnostic'
where delivery_id = (
  select id from private.outbound_deliveries
  where idempotency_key = 'check-in:alice:2026-07-19'
);
select public.purge_integration_delivery_history();

select is(
  (
    select payload
    from private.outbound_deliveries
    where idempotency_key = 'check-in:alice:2026-07-19'
  ),
  '{"redacted":true,"eventType":"check_in.committed"}'::jsonb,
  'retention removes delivered message content after seven days'
);
select is(
  (
    select response_metadata
    from private.integration_delivery_attempts
    where delivery_id = (
      select id from private.outbound_deliveries
      where idempotency_key = 'check-in:alice:2026-07-19'
    )
    order by attempt_number
    limit 1
  ),
  '{"redacted":true}'::jsonb,
  'retention removes old provider metadata and diagnostics'
);
select throws_ok(
  $$
    select public.enqueue_outbound_delivery(
      'a0000000-0000-4000-8000-000000000001',
      'c0000000-0000-4000-8000-000000000001',
      'synthetic.delivery',
      'invalid-payload:test:1',
      '[]'::jsonb,
      3,
      now()
    )
  $$,
  '22023',
  'Invalid integration payload.',
  'the queue rejects non-object provider payloads'
);

select * from finish();
rollback;
