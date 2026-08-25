begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(35);

delete from public.outbound_update_preferences
where user_id in (
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000003'
);
delete from public.outbound_update_preference_audit
where user_id in (
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000003'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
set local "request.jwt.claims" = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","email":"alice@example.test"}';

select is(
  public.get_current_outbound_consent(
    '10000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000001',
    'check_in'
  ) ->> 'eligible',
  'false',
  'an existing member without a preference fails closed'
);
select is(
  public.get_current_outbound_consent(
    '10000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000001',
    'check_in'
  ) ->> 'reason',
  'consent_missing',
  'missing consent has an explicit delivery denial reason'
);
select is(
  public.get_current_outbound_consent(
    '10000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000001',
    'check_in'
  ) ->> 'presentationMode',
  'anonymous',
  'missing consent defaults to anonymous presentation'
);
select is(
  public.get_current_outbound_consent(
    '10000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000001',
    'check_in'
  ) -> 'events',
  '{"checkIns":false,"streakMilestones":false,"badgesRewards":false,"membership":false}'::jsonb,
  'all event categories default off'
);

select is(
  public.set_outbound_update_consent(
    'a0000000-0000-4000-8000-000000000001',
    true,
    'named',
    true,
    false,
    false,
    false
  ) ->> 'presentationMode',
  'named',
  'a member can opt in with named presentation'
);
select is(
  public.get_current_outbound_consent(
    '10000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000001',
    'check_in'
  ) ->> 'eligible',
  'true',
  'an explicitly approved Check-In is eligible'
);
select is(
  public.get_current_outbound_consent(
    '10000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000001',
    'streak_milestone'
  ) ->> 'eligible',
  'false',
  'an event category that was not approved is denied'
);
select is(
  public.get_current_outbound_consent(
    '10000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000001',
    'future_event'
  ) ->> 'eligible',
  'false',
  'an unsupported future event fails closed'
);
select is(
  public.get_current_outbound_consent(
    '10000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000001',
    'future_event'
  ) ->> 'reason',
  'unsupported_event',
  'an unsupported event has a clear denial reason'
);

reset role;
select is(
  (select count(*)::integer from public.outbound_update_preference_audit where user_id = '10000000-0000-4000-8000-000000000001'),
  1,
  'the initial opt-in creates one audit record'
);

set local role authenticated;
select is(
  public.set_outbound_update_consent(
    'a0000000-0000-4000-8000-000000000001',
    true,
    'named',
    true,
    false,
    false,
    false
  ) ->> 'revision',
  '1',
  'an identical client retry keeps the current revision'
);
reset role;
select is(
  (select count(*)::integer from public.outbound_update_preference_audit where user_id = '10000000-0000-4000-8000-000000000001'),
  1,
  'an identical client retry does not duplicate audit history'
);

set local role authenticated;
select is(
  public.set_outbound_update_consent(
    'a0000000-0000-4000-8000-000000000001',
    true,
    'anonymous',
    true,
    true,
    true,
    true
  ) ->> 'presentationMode',
  'anonymous',
  'a member can switch to privacy-preserving presentation'
);
select is(
  public.get_current_outbound_consent(
    '10000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000001',
    'streak_milestone'
  ) ->> 'eligible',
  'true',
  'streak milestones can be approved'
);
select is(
  public.get_current_outbound_consent(
    '10000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000001',
    'badge_reward'
  ) ->> 'eligible',
  'true',
  'badge and reward events can be approved'
);
select is(
  public.get_current_outbound_consent(
    '10000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000001',
    'membership'
  ) ->> 'eligible',
  'true',
  'membership events can be approved'
);
reset role;
select is(
  (select max(revision)::integer from public.outbound_update_preference_audit where user_id = '10000000-0000-4000-8000-000000000001'),
  2,
  'an anonymization change advances the audit revision'
);

set local role authenticated;
select is(
  public.set_outbound_update_consent(
    'a0000000-0000-4000-8000-000000000001',
    false,
    'anonymous',
    true,
    true,
    true,
    true
  ) ->> 'outboundUpdatesEnabled',
  'false',
  'a member can globally opt out'
);
select is(
  public.get_current_outbound_consent(
    '10000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000001',
    'check_in'
  ) ->> 'reason',
  'updates_disabled',
  'global opt-out blocks approved categories'
);

select is(
  public.set_outbound_update_consent(
    'a0000000-0000-4000-8000-000000000001',
    true,
    'anonymous',
    true,
    true,
    true,
    true
  ) ->> 'outboundUpdatesEnabled',
  'true',
  'a queued event may begin while current consent is enabled'
);
select public.set_outbound_update_consent(
  'a0000000-0000-4000-8000-000000000001',
  false,
  'anonymous',
  true,
  true,
  true,
  true
);
select is(
  public.get_current_outbound_consent(
    '10000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000001',
    'check_in'
  ) ->> 'eligible',
  'false',
  'send-time re-evaluation blocks a queued retry after revocation'
);
reset role;
select is(
  (select max(revision)::integer from public.outbound_update_preference_audit where user_id = '10000000-0000-4000-8000-000000000001'),
  5,
  'revocation and retry state transitions remain auditable'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '30000000-0000-4000-8000-000000000003';
set local "request.jwt.claims" = '{"sub":"30000000-0000-4000-8000-000000000003","role":"authenticated","email":"carol@example.test"}';
select is(
  public.set_outbound_update_consent(
    'a0000000-0000-4000-8000-000000000001',
    true,
    'named',
    false,
    false,
    false,
    true
  ) ->> 'outboundUpdatesEnabled',
  'true',
  'a non-owner member can save her own consent'
);
reset role;

delete from public.crew_members
where crew_id = 'a0000000-0000-4000-8000-000000000001'
  and user_id = '30000000-0000-4000-8000-000000000003';

set local role service_role;
set local "request.jwt.claim.sub" = '';
set local "request.jwt.claims" = '{"role":"service_role"}';
select is(
  public.get_current_outbound_consent(
    '30000000-0000-4000-8000-000000000003',
    'a0000000-0000-4000-8000-000000000001',
    'membership'
  ) ->> 'eligible',
  'false',
  'membership removal blocks queued work at send time'
);
select is(
  public.get_current_outbound_consent(
    '30000000-0000-4000-8000-000000000003',
    'a0000000-0000-4000-8000-000000000001',
    'membership'
  ) ->> 'reason',
  'membership_missing',
  'membership removal has a terminal delivery reason'
);
reset role;
select is(
  (select count(*)::integer from public.outbound_update_preferences where user_id = '30000000-0000-4000-8000-000000000003'),
  0,
  'membership removal deletes the current preference'
);
select is(
  (
    select count(*)::integer
    from public.outbound_update_preference_audit
    where user_id = '30000000-0000-4000-8000-000000000003'
      and change_type = 'revoked'
      and outbound_updates_enabled = false
  ),
  1,
  'membership removal records a fail-closed revocation without a payload'
);

insert into public.crew_members (crew_id, user_id, display_name, role)
values (
  'a0000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000003',
  'Carol Example',
  'member'
);
set local role authenticated;
set local "request.jwt.claim.sub" = '30000000-0000-4000-8000-000000000003';
set local "request.jwt.claims" = '{"sub":"30000000-0000-4000-8000-000000000003","role":"authenticated","email":"carol@example.test"}';
select is(
  public.get_current_outbound_consent(
    '30000000-0000-4000-8000-000000000003',
    'a0000000-0000-4000-8000-000000000001',
    'membership'
  ) ->> 'eligible',
  'false',
  'a rejoined member starts opted out again'
);
select is(
  public.get_current_outbound_consent(
    '30000000-0000-4000-8000-000000000003',
    'a0000000-0000-4000-8000-000000000001',
    'membership'
  ) ->> 'reason',
  'consent_missing',
  'rejoining requires a new explicit consent choice'
);

set local "request.jwt.claim.sub" = '20000000-0000-4000-8000-000000000002';
set local "request.jwt.claims" = '{"sub":"20000000-0000-4000-8000-000000000002","role":"authenticated","email":"bob@example.test"}';
select is(
  public.set_outbound_update_consent(
    'b0000000-0000-4000-8000-000000000002',
    true,
    'named',
    true,
    false,
    false,
    false
  ) ->> 'outboundUpdatesEnabled',
  'true',
  'an account can opt in before deletion'
);
reset role;

delete from auth.users
where id = '20000000-0000-4000-8000-000000000002';

set local role service_role;
set local "request.jwt.claim.sub" = '';
set local "request.jwt.claims" = '{"role":"service_role"}';
select is(
  public.get_current_outbound_consent(
    '20000000-0000-4000-8000-000000000002',
    'b0000000-0000-4000-8000-000000000002',
    'check_in'
  ) ->> 'eligible',
  'false',
  'account deletion blocks queued work at send time'
);
select is(
  public.get_current_outbound_consent(
    '20000000-0000-4000-8000-000000000002',
    'b0000000-0000-4000-8000-000000000002',
    'check_in'
  ) ->> 'reason',
  'account_missing',
  'account deletion has a terminal delivery reason'
);
reset role;
select is(
  (select count(*)::integer from public.outbound_update_preferences where user_id = '20000000-0000-4000-8000-000000000002'),
  0,
  'account deletion removes the current preference'
);
select is(
  (
    select count(*)::integer
    from public.outbound_update_preference_audit
    where user_id = '20000000-0000-4000-8000-000000000002'
      and change_type = 'revoked'
  ),
  1,
  'account deletion records a payload-free revocation'
);

select throws_ok(
  $$
    update public.outbound_update_preference_audit
    set presentation_mode = 'named'
    where user_id = '10000000-0000-4000-8000-000000000001'
  $$,
  'P0001',
  'Consent audit history is immutable.',
  'consent audit history cannot be rewritten'
);

select * from finish();
rollback;
