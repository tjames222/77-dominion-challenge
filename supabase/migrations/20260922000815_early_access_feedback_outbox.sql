-- Feedback is committed before integrations run. No delivery is enabled or
-- customer message sent by this migration. Worker RPCs are service-only.
set local lock_timeout = '5s';

create function private.feedback_utf16_length(value text)
returns integer language sql immutable strict set search_path = '' as $$
  select coalesce(sum(case when pg_catalog.ascii(c) > 65535 then 2 else 1 end), 0)::integer
  from pg_catalog.regexp_split_to_table(value, '') c;
$$;
revoke all on function private.feedback_utf16_length(text) from public, anon, authenticated, service_role;

create table private.early_access_feedback (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references auth.users(id) on delete cascade,
  operation_id uuid not null,
  reporter_email text not null,
  program_key text not null references private.early_access_programs(program_key),
  input jsonb not null check (jsonb_typeof(input) = 'object'),
  context jsonb not null check (jsonb_typeof(context) = 'object'),
  submitted_at timestamptz not null default clock_timestamp(),
  issue_id uuid not null unique default gen_random_uuid(),
  unique (actor_id, operation_id)
);
create index early_access_feedback_actor_time_idx on private.early_access_feedback(actor_id, submitted_at desc);
create table private.early_access_feedback_deliveries (
  id uuid primary key default gen_random_uuid(),
  feedback_id uuid not null references private.early_access_feedback(id) on delete cascade,
  provider text not null check (provider in ('linear', 'email')),
  status text not null default 'queued' check (status in ('queued', 'leased', 'retry', 'delivered', 'needs_review')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default clock_timestamp(),
  lease_token uuid,
  lease_until timestamptz,
  payload jsonb check (payload is null or jsonb_typeof(payload) = 'object'),
  binding_fingerprint text check (binding_fingerprint ~ '^[0-9a-f]{64}$'),
  first_dispatched_at timestamptz,
  provider_receipt_id uuid,
  issue_url text,
  last_code text,
  completed_at timestamptz,
  unique (feedback_id, provider),
  check ((payload is null) = (binding_fingerprint is null)),
  check (first_dispatched_at is null or payload is not null),
  check ((lease_token is null) = (lease_until is null)),
  check (status <> 'delivered' or (completed_at is not null and provider_receipt_id is not null))
);
create index early_access_feedback_delivery_due_idx
  on private.early_access_feedback_deliveries(provider, next_attempt_at, id)
  where status in ('queued', 'retry', 'leased');

-- Shared by feedback and invitation workers. One durable delivery reserves one
-- email, even when a same-key retry is needed. Conservative free-plan budget.
create table private.transactional_email_reservations (
  delivery_id uuid primary key,
  reserved_at timestamptz not null default clock_timestamp()
);
create index transactional_email_reservations_time_idx on private.transactional_email_reservations(reserved_at);
alter table private.early_access_feedback enable row level security;
alter table private.early_access_feedback_deliveries enable row level security;
alter table private.transactional_email_reservations enable row level security;
revoke all on private.early_access_feedback, private.early_access_feedback_deliveries,
  private.transactional_email_reservations from public, anon, authenticated, service_role;

create function private.reserve_transactional_email(target_delivery_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare as_of timestamptz;
begin
  if target_delivery_id is null then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('transactional-email-free-quota', 1803));
  as_of := clock_timestamp();
  if exists (select 1 from private.transactional_email_reservations where delivery_id = target_delivery_id) then return true; end if;
  if (select count(*) from private.transactional_email_reservations where reserved_at >= as_of - interval '24 hours') >= 90
    or (select count(*) from private.transactional_email_reservations where reserved_at >= as_of - interval '31 days') >= 2900 then return false; end if;
  insert into private.transactional_email_reservations(delivery_id, reserved_at) values (target_delivery_id, as_of);
  return true;
end;
$$;
revoke all on function private.reserve_transactional_email(uuid) from public, anon, authenticated, service_role;

create function private.submit_early_access_feedback(target_expected_actor_id uuid, target_operation_id uuid, target_input jsonb, target_context jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  sid uuid; saved private.early_access_feedback%rowtype; normalized_input jsonb;
  as_of timestamptz; reporter text;
begin
  sid := private.require_member_request_identity(target_expected_actor_id);
  if target_operation_id is null or jsonb_typeof(target_input) is distinct from 'object'
    or jsonb_typeof(target_context) is distinct from 'object' then
    raise exception using errcode = 'PT400', message = 'feedback_invalid_input';
  end if;
  -- Bound work before the UTF-16 character expansion. PostgreSQL character
  -- length is a cheap upper-bound admission check, not the final JS-unit limit.
  if pg_catalog.length(target_input->>'description') > 10000
    or pg_catalog.length(target_input->>'expectedBehavior') > 5000 then
    raise exception using errcode = 'PT400', message = 'feedback_invalid_input';
  end if;
  if (target_input - array['type','description','expectedBehavior','impact','contactAllowed']) <> '{}'::jsonb
    or not (target_input ?& array['type','description','impact','contactAllowed'])
    or jsonb_typeof(target_input->'type') is distinct from 'string'
    or target_input->>'type' not in ('bug','design_ui','ux_usability','feature_idea','performance','other')
    or jsonb_typeof(target_input->'impact') is distinct from 'string'
    or target_input->>'impact' not in ('blocking','frustrating','minor','suggestion')
    or jsonb_typeof(target_input->'contactAllowed') is distinct from 'boolean'
    or jsonb_typeof(target_input->'description') is distinct from 'string'
    or pg_catalog.btrim(target_input->>'description', E' \t\n\r\f\v' || chr(160) || chr(5760) || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197) || chr(8198) || chr(8199) || chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288) || chr(65279)) = ''
    or private.feedback_utf16_length(target_input->>'description') > 10000
    or (target_input ? 'expectedBehavior' and (jsonb_typeof(target_input->'expectedBehavior') is distinct from 'string'
      or private.feedback_utf16_length(target_input->>'expectedBehavior') > 5000)) then
    raise exception using errcode = 'PT400', message = 'feedback_invalid_input';
  end if;
  normalized_input := jsonb_build_object('type',target_input->'type','description',target_input->'description',
    'expectedBehavior',coalesce(target_input->'expectedBehavior','""'::jsonb),'impact',target_input->'impact','contactAllowed',target_input->'contactAllowed');
  if (target_context - array['route','theme','viewport','buildSha','browser','platform']) <> '{}'::jsonb
    or not (target_context ?& array['route','theme','viewport','buildSha','browser','platform'])
    or jsonb_typeof(target_context->'route') is distinct from 'string'
    or target_context->>'route' not in ('dashboard.html','badges-rewards.html','bible-reading.html','morning-prayer.html','worship.html','evening-prayer.html','workout-one.html','intentional-walk.html','workout-two.html','community.html','group-settings.html','private-journal.html','billing.html','profile.html')
    or jsonb_typeof(target_context->'theme') is distinct from 'string'
    or target_context->>'theme' not in ('light','dark','dominion-night','dominion-platinum')
    or jsonb_typeof(target_context->'browser') is distinct from 'string'
    or target_context->>'browser' not in ('chromium','firefox','safari','other','unknown')
    or jsonb_typeof(target_context->'platform') is distinct from 'string'
    or target_context->>'platform' not in ('windows','macos','linux','android','ios','other','unknown')
    or jsonb_typeof(target_context->'buildSha') is distinct from 'string'
    or target_context->>'buildSha' !~ '^[0-9a-f]{40}$'
    or jsonb_typeof(target_context->'viewport') is distinct from 'object' then
    raise exception using errcode = 'PT400', message = 'feedback_invalid_context';
  end if;
  if ((target_context->'viewport') - array['width','height']) <> '{}'::jsonb
    or not (target_context->'viewport' ?& array['width','height'])
    or jsonb_typeof(target_context->'viewport'->'width') is distinct from 'number'
    or jsonb_typeof(target_context->'viewport'->'height') is distinct from 'number'
    or (target_context->'viewport'->>'width') !~ '^[0-9]{1,5}$'
    or (target_context->'viewport'->>'height') !~ '^[0-9]{1,5}$' then
    raise exception using errcode = 'PT400', message = 'feedback_invalid_context';
  end if;
  if (target_context->'viewport'->>'width')::integer not between 1 and 16384
    or (target_context->'viewport'->>'height')::integer not between 1 and 16384 then
    raise exception using errcode = 'PT400', message = 'feedback_invalid_context';
  end if;
  -- Serialize actor rate limits/idempotency, then lock live member identity.
  -- Do not hold the admin lifecycle advisory lock while waiting for Auth rows:
  -- Auth UPDATE/DELETE triggers acquire that lock after their own row lock.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('early-access-feedback:' || target_expected_actor_id::text,1803));
  perform 1 from auth.users where id = target_expected_actor_id for share;
  perform 1 from auth.sessions where id = sid for share;
  perform 1 from auth.mfa_factors where user_id = target_expected_actor_id for share;
  perform private.require_member_request_identity(target_expected_actor_id);
  select * into saved from private.early_access_feedback where actor_id = target_expected_actor_id and operation_id = target_operation_id;
  if found then
    if saved.input <> normalized_input or saved.context <> target_context then
      raise exception using errcode = 'PT409', message = 'feedback_operation_conflict';
    end if;
  else
    perform 1 from private.early_access_programs where program_key = 'early_access_v1' for share;
    perform 1 from private.early_access_grants where user_id = target_expected_actor_id and program_key = 'early_access_v1' for share;
    as_of := clock_timestamp();
    if not private.early_access_active_for_user(target_expected_actor_id, as_of) then
      raise exception using errcode = 'PT403', message = 'feedback_early_access_required';
    end if;
    if (select count(*) from private.early_access_feedback where actor_id = target_expected_actor_id and submitted_at > as_of - interval '1 minute') >= 5
      or (select count(*) from private.early_access_feedback where actor_id = target_expected_actor_id and submitted_at > as_of - interval '24 hours') >= 50 then
      raise exception using errcode = 'PT429', message = 'feedback_rate_limited';
    end if;
    select email into reporter from auth.users where id = target_expected_actor_id;
    if reporter is null or reporter = '' then raise exception using errcode = 'PT401', message = 'member_authentication_required'; end if;
    insert into private.early_access_feedback(actor_id,operation_id,reporter_email,program_key,input,context,submitted_at)
      values(target_expected_actor_id,target_operation_id,reporter,'early_access_v1',normalized_input,target_context,as_of) returning * into saved;
    insert into private.early_access_feedback_deliveries(feedback_id,provider) values(saved.id,'linear'),(saved.id,'email');
  end if;
  perform private.require_member_request_identity(target_expected_actor_id);
  return jsonb_build_object('schemaVersion',1,'operationId',saved.operation_id,'feedbackId',saved.id,'actorId',saved.actor_id,'status','saved');
end;
$$;
revoke all on function private.submit_early_access_feedback(uuid,uuid,jsonb,jsonb) from public,anon,authenticated,service_role;
create function public.submit_early_access_feedback(target_expected_actor_id uuid, target_operation_id uuid, target_input jsonb, target_context jsonb)
returns jsonb language sql security definer set search_path = '' as $$
  select private.submit_early_access_feedback(target_expected_actor_id,target_operation_id,target_input,target_context);
$$;
revoke all on function public.submit_early_access_feedback(uuid,uuid,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.submit_early_access_feedback(uuid,uuid,jsonb,jsonb) to authenticated;

create function private.require_feedback_worker()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if pg_catalog.current_setting('role',true) is distinct from 'service_role' or (select auth.uid()) is not null then
    raise exception using errcode='42501',message='feedback_worker_required';
  end if;
end;
$$;
revoke all on function private.require_feedback_worker() from public,anon,authenticated,service_role;

create function public.claim_early_access_feedback_deliveries(target_worker_token uuid, target_provider text, target_batch_size integer default 5)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare delivery private.early_access_feedback_deliveries%rowtype; result jsonb := '[]'; source private.early_access_feedback%rowtype; linear_state jsonb;
begin
  perform private.require_feedback_worker();
  if target_worker_token is null or target_provider is null or target_provider not in ('linear','email')
    or target_batch_size is null or target_batch_size not between 1 and 10 then
    raise exception using errcode='22023',message='feedback_worker_invalid_input'; end if;
  for delivery in select * from private.early_access_feedback_deliveries
    where provider=target_provider and status in ('queued','retry','leased') and next_attempt_at<=clock_timestamp()
      and (lease_until is null or lease_until<=clock_timestamp())
    order by next_attempt_at,id for update skip locked limit target_batch_size
  loop
    if delivery.attempts>=12 or (delivery.provider='email' and delivery.first_dispatched_at<=clock_timestamp()-interval '23 hours') then
      update private.early_access_feedback_deliveries set status='needs_review',lease_token=null,lease_until=null,last_code='retry_window_exhausted' where id=delivery.id;
      continue;
    end if;
    update private.early_access_feedback_deliveries set status='leased',lease_token=target_worker_token,
      lease_until=clock_timestamp()+interval '2 minutes',attempts=attempts+1 where id=delivery.id returning * into delivery;
    select * into strict source from private.early_access_feedback where id=delivery.feedback_id;
    select case when status='delivered' then
        jsonb_build_object('state','delivered','issueId',provider_receipt_id,'issueUrl',issue_url)
      when status='needs_review' then jsonb_build_object('state','failed')
      else jsonb_build_object('state','pending') end
      into linear_state from private.early_access_feedback_deliveries where feedback_id=source.id and provider='linear';
    result := result || jsonb_build_array(jsonb_build_object('deliveryId',delivery.id,'provider',delivery.provider,
      'firstDispatchedAt',delivery.first_dispatched_at,'payload',delivery.payload,'bindingFingerprint',delivery.binding_fingerprint,
      'feedback',jsonb_build_object('schemaVersion',1,'feedbackId',source.id,'issueId',source.issue_id,'actorId',source.actor_id,'reporterEmail',source.reporter_email,
        'cohort',source.program_key,'input',source.input,'context',source.context,'submittedAt',source.submitted_at),'linear',linear_state));
  end loop;
  return result;
end;
$$;
revoke all on function public.claim_early_access_feedback_deliveries(uuid,text,integer) from public,anon,authenticated,service_role;
grant execute on function public.claim_early_access_feedback_deliveries(uuid,text,integer) to service_role;

create function public.bind_early_access_feedback_delivery(target_delivery_id uuid,target_worker_token uuid,target_payload jsonb,target_binding_fingerprint text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare delivery private.early_access_feedback_deliveries%rowtype;
begin
  perform private.require_feedback_worker();
  if jsonb_typeof(target_payload) is distinct from 'object' or octet_length(target_payload::text)>131072
    or target_binding_fingerprint is null or target_binding_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='22023',message='feedback_delivery_invalid_binding'; end if;
  select * into delivery from private.early_access_feedback_deliveries where id=target_delivery_id for update;
  if not found or delivery.status<>'leased' or delivery.lease_token is distinct from target_worker_token
    or delivery.lease_until<=clock_timestamp() then return false; end if;
  if delivery.payload is not null then return delivery.payload=target_payload and delivery.binding_fingerprint=target_binding_fingerprint; end if;
  update private.early_access_feedback_deliveries set payload=target_payload,binding_fingerprint=target_binding_fingerprint where id=target_delivery_id;
  return true;
end;
$$;
revoke all on function public.bind_early_access_feedback_delivery(uuid,uuid,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.bind_early_access_feedback_delivery(uuid,uuid,jsonb,text) to service_role;

create function public.mark_early_access_feedback_dispatched(target_delivery_id uuid,target_worker_token uuid,target_binding_fingerprint text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare delivery private.early_access_feedback_deliveries%rowtype; as_of timestamptz;
begin
  perform private.require_feedback_worker();
  select * into delivery from private.early_access_feedback_deliveries where id=target_delivery_id for update;
  if not found or delivery.status<>'leased' or delivery.lease_token is distinct from target_worker_token
    or delivery.lease_until<=clock_timestamp() or delivery.payload is null
    or delivery.binding_fingerprint is distinct from target_binding_fingerprint then return null; end if;
  if delivery.provider='linear' and delivery.first_dispatched_at is not null then return null; end if;
  if delivery.provider='email' then
    -- A quota lock can outlast the worker lease or provider retry window.
    -- Roll back only this block's new reservation if that happens; never erase
    -- an earlier valid reservation or authorize a stale worker to send.
    begin
      if delivery.first_dispatched_at<=clock_timestamp()-interval '23 hours'
        or not private.reserve_transactional_email(delivery.id) then return null; end if;
      as_of := clock_timestamp();
      if delivery.lease_until<=as_of or delivery.first_dispatched_at<=as_of-interval '23 hours' then
        raise exception using errcode='PFD01',message='feedback_dispatch_window_expired';
      end if;
    exception when sqlstate 'PFD01' then return null;
    end;
  end if;
  update private.early_access_feedback_deliveries set first_dispatched_at=coalesce(first_dispatched_at,clock_timestamp())
    where id=target_delivery_id returning * into delivery;
  return jsonb_build_object('deliveryId',delivery.id,'idempotencyKey','dominion-feedback/'||delivery.id::text,
    'bindingFingerprint',delivery.binding_fingerprint,'firstDispatchedAt',delivery.first_dispatched_at);
end;
$$;
revoke all on function public.mark_early_access_feedback_dispatched(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.mark_early_access_feedback_dispatched(uuid,uuid,text) to service_role;

create function public.settle_early_access_feedback_delivery(target_delivery_id uuid,target_worker_token uuid,target_outcome text,
  target_code text default null,target_receipt_id uuid default null,target_issue_url text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare delivery private.early_access_feedback_deliveries%rowtype; expected_issue uuid;
begin
  perform private.require_feedback_worker();
  if target_outcome is null or target_outcome not in ('delivered','accepted','retryable','uncertain','needs_review')
    or (target_code is not null and (length(target_code)>80 or target_code !~ '^[a-z0-9_]+$')) then
    raise exception using errcode='22023',message='feedback_delivery_invalid_outcome'; end if;
  select * into delivery from private.early_access_feedback_deliveries where id=target_delivery_id for update;
  if not found or delivery.status<>'leased' or delivery.lease_token is distinct from target_worker_token
    or delivery.lease_until<=clock_timestamp() then return false; end if;
  if target_outcome in ('delivered','accepted') then
    if delivery.first_dispatched_at is null or target_receipt_id is null
      or (delivery.provider='email' and (target_outcome<>'accepted' or target_issue_url is not null))
      or (delivery.provider='linear' and target_outcome<>'delivered') then
      raise exception using errcode='22023',message='feedback_delivery_invalid_receipt'; end if;
    if delivery.provider='linear' then
      select issue_id into expected_issue from private.early_access_feedback where id=delivery.feedback_id;
      if expected_issue is distinct from target_receipt_id or target_issue_url is null or length(target_issue_url)>512
        or target_issue_url !~ '^https://linear[.]app/[A-Za-z0-9_-]+/issue/[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)?$' then
        raise exception using errcode='22023',message='feedback_delivery_invalid_receipt'; end if;
    end if;
    update private.early_access_feedback_deliveries set status='delivered',provider_receipt_id=target_receipt_id,
      issue_url=target_issue_url,completed_at=clock_timestamp(),lease_token=null,lease_until=null,last_code=null where id=target_delivery_id;
  else
    update private.early_access_feedback_deliveries set status=case when target_outcome='needs_review' or attempts>=12 then 'needs_review' else 'retry' end,
      next_attempt_at=clock_timestamp()+interval '5 minutes',lease_token=null,lease_until=null,last_code=target_code where id=target_delivery_id;
  end if;
  return true;
end;
$$;
revoke all on function public.settle_early_access_feedback_delivery(uuid,uuid,text,text,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.settle_early_access_feedback_delivery(uuid,uuid,text,text,uuid,text) to service_role;
