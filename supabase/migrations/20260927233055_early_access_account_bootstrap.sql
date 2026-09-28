-- NEW accounts only. No Auth account, real mail, membership or billing mutation
-- is performed by this migration. Native create/link work stays outside SQL.
set local lock_timeout='5s';

create table private.early_access_account_bootstraps (
  invitation_id uuid primary key references private.early_access_invitations(id),
  reserved_user_id uuid not null unique default gen_random_uuid(),
  delivery_id uuid not null unique default gen_random_uuid(),
  status text not null default 'queued' check(status in ('queued','leased','native_started','mail_ready','needs_review','cancelled')),
  attempts integer not null default 0 check(attempts>=0),
  lease_token uuid,
  lease_until timestamptz,
  native_operation_token uuid,
  native_started_at timestamptz,
  last_code text,
  created_at timestamptz not null default clock_timestamp(),
  check((lease_token is null)=(lease_until is null)),
  check((native_operation_token is null)=(native_started_at is null)),
  check(status not in ('native_started','mail_ready') or native_started_at is not null)
);
-- Neither reserved_user_id nor any delivery metadata references Auth: remote
-- creation may not exist yet, and lifecycle must not acquire reverse Auth FKs.
create index early_access_bootstrap_due_idx on private.early_access_account_bootstraps(created_at,invitation_id)
  where status in ('queued','leased','native_started');
create table private.early_access_account_setup_deliveries (
  id uuid primary key,
  invitation_id uuid not null unique references private.early_access_account_bootstraps(invitation_id),
  binding jsonb not null,
  envelope jsonb,
  content_fingerprint text not null check(content_fingerprint ~ '^[0-9a-f]{64}$'),
  idempotency_key text not null unique,
  expires_at timestamptz not null check(isfinite(expires_at)),
  status text not null default 'queued' check(status in ('queued','leased','retry','delivered','needs_review','cancelled')),
  attempts integer not null default 0 check(attempts>=0),
  next_attempt_at timestamptz not null default clock_timestamp(),
  lease_token uuid,
  lease_until timestamptz,
  first_dispatched_at timestamptz,
  provider_receipt_id uuid,
  completed_at timestamptz,
  last_code text,
  check((lease_token is null)=(lease_until is null)),
  check(status<>'delivered' or (first_dispatched_at is not null and provider_receipt_id is not null and completed_at is not null)),
  check(envelope is not null or status in ('delivered','cancelled'))
);
create index early_access_account_setup_delivery_due_idx on private.early_access_account_setup_deliveries(next_attempt_at,id)
  where status in ('queued','leased','retry');
alter table private.early_access_account_bootstraps enable row level security;
alter table private.early_access_account_setup_deliveries enable row level security;
revoke all on private.early_access_account_bootstraps,private.early_access_account_setup_deliveries from public,anon,authenticated,service_role;

create function private.queue_early_access_account_bootstrap()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.account_id is null and new.state='current' then
    if (private.early_access_invitation_account(new.recipient)->>'count')::integer<>0 then
      raise exception using errcode='23514',message='invitation_bootstrap_account_changed';end if;
    insert into private.early_access_account_bootstraps(invitation_id) values(new.id);
  end if;
  return new;
end;
$$;
revoke all on function private.queue_early_access_account_bootstrap() from public,anon,authenticated,service_role;
create trigger queue_early_access_account_bootstrap after insert on private.early_access_invitations
  for each row execute function private.queue_early_access_account_bootstrap();

create function private.retire_early_access_account_bootstrap()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.state<>'current' then
    update private.early_access_account_bootstraps set status='cancelled',lease_token=null,lease_until=null,last_code='generation_retired'
      where invitation_id=new.id and status<>'cancelled';
    update private.early_access_account_setup_deliveries set status='cancelled',envelope=null,lease_token=null,lease_until=null,last_code='generation_retired'
      where invitation_id=new.id and status<>'delivered';
  end if;
  return new;
end;
$$;
revoke all on function private.retire_early_access_account_bootstrap() from public,anon,authenticated,service_role;
create trigger retire_early_access_account_bootstrap after update of state on private.early_access_invitations
  for each row execute function private.retire_early_access_account_bootstrap();

create function private.lock_early_access_account_bootstrap(target_generation uuid)
returns private.early_access_account_bootstraps language plpgsql security definer set search_path='' as $$
declare request_id uuid; result private.early_access_account_bootstraps%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('site-admin-lifecycle',1502));
  select i.request_id into request_id from private.early_access_invitations i where i.id=target_generation;
  if request_id is null then return null;end if;
  perform 1 from private.early_access_requests r where r.id=request_id for update;
  perform 1 from private.early_access_programs where program_key='early_access_v1' for share;
  perform 1 from private.early_access_invitations where id=target_generation for update;
  select * into result from private.early_access_account_bootstraps where invitation_id=target_generation for update;
  return result;
end;
$$;
revoke all on function private.lock_early_access_account_bootstrap(uuid) from public,anon,authenticated,service_role;

create function private.early_access_account_setup_current(target_generation uuid)
returns boolean language sql volatile security definer set search_path='' as $$
  select exists(select 1 from private.early_access_invitations i
    join private.early_access_requests r on r.id=i.request_id
    join private.early_access_programs p on p.program_key='early_access_v1'
    where i.id=target_generation and i.state='current' and i.expires_at>clock_timestamp()
      and r.status in ('approved','invited') and r.email=i.recipient and p.configured
      and (p.beta_starts_at is null or p.beta_starts_at>clock_timestamp()));
$$;
revoke all on function private.early_access_account_setup_current(uuid) from public,anon,authenticated,service_role;

create function private.early_access_account_setup_material_valid(target_binding jsonb,target_envelope jsonb,
  target_fingerprint text,target_key text,target_generation uuid)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare setup private.early_access_account_bootstraps%rowtype; invitation private.early_access_invitations%rowtype;
  issued timestamptz; expires timestamptz; encrypted bytea;
begin
  select * into setup from private.early_access_account_bootstraps where invitation_id=target_generation;
  select * into invitation from private.early_access_invitations where id=target_generation;
  if setup.invitation_id is null or jsonb_typeof(target_binding) is distinct from 'object' or pg_column_size(target_binding)>2048
    or (select count(*) from jsonb_object_keys(target_binding))<>8
    or not(target_binding ?& array['requestId','generationId','deliveryId','reservedUserId','recipient','issuedAt','expiresAt','from'])
    or exists(select 1 from jsonb_each(target_binding) where jsonb_typeof(value)<>'string')
    or target_binding->>'requestId' is distinct from invitation.request_id::text
    or target_binding->>'generationId' is distinct from setup.invitation_id::text
    or target_binding->>'deliveryId' is distinct from setup.delivery_id::text
    or target_binding->>'reservedUserId' is distinct from setup.reserved_user_id::text
    or target_binding->>'recipient' is distinct from invitation.recipient
    or length(target_binding->>'from')>320 or target_binding->>'from' ~ '[[:cntrl:]]'
    or target_binding->>'from' !~ '^([A-Za-z0-9][A-Za-z0-9 .&''-]{0,63} <)?[A-Za-z0-9.!#$%&''*+/=?^_`{|}~-]+@mail[.]77dominion[.]com>?$'
    or target_binding->>'issuedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    or target_binding->>'expiresAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    or target_fingerprint is null or target_fingerprint !~ '^[0-9a-f]{64}$'
    or target_key is distinct from 'dominion-early-access-setup/'||setup.delivery_id::text then return false;end if;
  issued:=(target_binding->>'issuedAt')::timestamptz;expires:=(target_binding->>'expiresAt')::timestamptz;
  if not isfinite(issued) or not isfinite(expires) or issued<clock_timestamp()-interval '30 seconds'
    or issued>clock_timestamp()+interval '30 seconds' or expires<=issued or expires>issued+interval '3600 seconds'
    or setup.native_started_at is null or expires>setup.native_started_at+interval '3570 seconds'
    or expires>invitation.expires_at or expires<=clock_timestamp() then return false;end if;
  if jsonb_typeof(target_envelope) is distinct from 'object' or pg_column_size(target_envelope)>24000
    or (select count(*) from jsonb_object_keys(target_envelope))<>4
    or not(target_envelope ?& array['version','keyVersion','nonce','ciphertext'])
    or target_envelope->'version' is distinct from '1'::jsonb
    or jsonb_typeof(target_envelope->'keyVersion') is distinct from 'number'
    or target_envelope->>'keyVersion' !~ '^[1-9][0-9]{0,9}$' or (target_envelope->>'keyVersion')::bigint>2147483647
    or jsonb_typeof(target_envelope->'nonce') is distinct from 'string' or target_envelope->>'nonce' !~ '^[A-Za-z0-9_-]{16}$'
    or jsonb_typeof(target_envelope->'ciphertext') is distinct from 'string'
    or length(target_envelope->>'ciphertext') not between 23 and 21867 or target_envelope->>'ciphertext' !~ '^[A-Za-z0-9_-]+$' then return false;end if;
  encrypted:=decode(rpad(translate(target_envelope->>'ciphertext','-_','+/'),((length(target_envelope->>'ciphertext')+3)/4)*4,'='),'base64');
  return octet_length(encrypted) between 17 and 16400
    and replace(rtrim(translate(encode(encrypted,'base64'),'+/','-_'),'='),E'\n','')=target_envelope->>'ciphertext';
exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range or invalid_parameter_value then return false;
end;
$$;
revoke all on function private.early_access_account_setup_material_valid(jsonb,jsonb,text,text,uuid) from public,anon,authenticated,service_role;

create function public.claim_early_access_account_bootstraps(target_worker_token uuid,target_batch_size integer default 1)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare setup private.early_access_account_bootstraps%rowtype; invitation private.early_access_invitations%rowtype; target uuid;
begin
  perform private.require_early_access_invitation_worker();
  if target_worker_token is null or target_batch_size is distinct from 1 then raise exception using errcode='22023',message='invitation_worker_invalid_input';end if;
  perform pg_advisory_xact_lock(hashtextextended('site-admin-lifecycle',1502));
  for target in select id from private.early_access_invitations where state='current' and expires_at<=clock_timestamp() order by expires_at,id limit 25 loop
    perform private.expire_early_access_invitation(target);end loop;
  -- A possible native call is never reclaimed. Its result may have committed,
  -- and a stale generator must never invalidate a later frozen mailed link.
  update private.early_access_account_bootstraps set status='needs_review',lease_token=null,lease_until=null,last_code='native_result_unconfirmed'
    where invitation_id in(select invitation_id from private.early_access_account_bootstraps where status='native_started'
      and lease_until<=clock_timestamp() order by lease_until,invitation_id limit 25);
  select b.invitation_id into target from private.early_access_account_bootstraps b
    where b.status in ('queued','leased') and (b.lease_until is null or b.lease_until<=clock_timestamp())
      and private.early_access_account_setup_current(b.invitation_id) order by b.created_at,b.invitation_id limit 1;
  if target is null then return '[]'::jsonb;end if;
  setup:=private.lock_early_access_account_bootstrap(target);
  select * into invitation from private.early_access_invitations where id=target;
  if not private.early_access_account_setup_current(target) then return '[]'::jsonb;end if;
  if setup.attempts>=6 or invitation.account_id is not null or setup.native_started_at is not null
    or (private.early_access_invitation_account(invitation.recipient)->>'count')::integer<>0
    or exists(select 1 from auth.users where id=setup.reserved_user_id) then
    update private.early_access_account_bootstraps set status='needs_review',lease_token=null,lease_until=null,last_code='bootstrap_unavailable' where invitation_id=target;
    return '[]'::jsonb;end if;
  update private.early_access_account_bootstraps set status='leased',lease_token=target_worker_token,lease_until=clock_timestamp()+interval '2 minutes',attempts=attempts+1 where invitation_id=target;
  return jsonb_build_array(jsonb_build_object('requestId',invitation.request_id,'generationId',target,'reservedUserId',setup.reserved_user_id,
    'deliveryId',setup.delivery_id,'recipient',invitation.recipient,'invitationExpiresAt',invitation.expires_at));
end;
$$;
revoke all on function public.claim_early_access_account_bootstraps(uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.claim_early_access_account_bootstraps(uuid,integer) to service_role;

create function public.start_early_access_account_bootstrap(target_generation_id uuid,target_worker_token uuid)
returns boolean language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare setup private.early_access_account_bootstraps%rowtype; invitation private.early_access_invitations%rowtype;
begin
  perform private.require_early_access_invitation_worker();setup:=private.lock_early_access_account_bootstrap(target_generation_id);
  select * into invitation from private.early_access_invitations where id=target_generation_id;
  if setup.invitation_id is null or setup.status<>'leased' or setup.lease_token is distinct from target_worker_token
    or setup.lease_until<=clock_timestamp() or setup.native_started_at is not null or invitation.account_id is not null
    or not private.early_access_account_setup_current(target_generation_id)
    or (private.early_access_invitation_account(invitation.recipient)->>'count')::integer<>0
    or exists(select 1 from auth.users where id=setup.reserved_user_id) then return false;end if;
  update private.early_access_account_bootstraps set status='native_started',native_started_at=clock_timestamp(),native_operation_token=target_worker_token
    where invitation_id=target_generation_id;
  return true;
end;
$$;
revoke all on function public.start_early_access_account_bootstrap(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.start_early_access_account_bootstrap(uuid,uuid) to service_role;

create function public.persist_early_access_account_setup(target_generation_id uuid,target_worker_token uuid,target_binding jsonb,
  target_envelope jsonb,target_content_fingerprint text,target_idempotency_key text)
returns boolean language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare setup private.early_access_account_bootstraps%rowtype; invitation private.early_access_invitations%rowtype;
  delivery private.early_access_account_setup_deliveries%rowtype; account jsonb;
begin
  perform private.require_early_access_invitation_worker();setup:=private.lock_early_access_account_bootstrap(target_generation_id);
  if setup.invitation_id is null or setup.native_operation_token is distinct from target_worker_token
    or not private.early_access_account_setup_current(target_generation_id) then return false;end if;
  if setup.status='mail_ready' then
    select * into delivery from private.early_access_account_setup_deliveries where invitation_id=target_generation_id;
    return delivery.binding=target_binding and delivery.content_fingerprint=target_content_fingerprint and delivery.idempotency_key=target_idempotency_key
      and (delivery.envelope=target_envelope or delivery.status in ('delivered','cancelled'));
  end if;
  select * into invitation from private.early_access_invitations where id=target_generation_id;
  account:=private.early_access_invitation_account(invitation.recipient);
  if setup.status<>'native_started' or setup.lease_token is distinct from target_worker_token or setup.lease_until<=clock_timestamp()
    or invitation.account_id is not null or account->>'id' is distinct from setup.reserved_user_id::text
    or not(account->>'healthy')::boolean or (account->>'confirmed')::boolean
    or not private.early_access_account_setup_material_valid(target_binding,target_envelope,target_content_fingerprint,target_idempotency_key,target_generation_id) then return false;end if;
  insert into private.early_access_account_setup_deliveries(id,invitation_id,binding,envelope,content_fingerprint,idempotency_key,expires_at)
    values(setup.delivery_id,target_generation_id,target_binding,target_envelope,target_content_fingerprint,target_idempotency_key,(target_binding->>'expiresAt')::timestamptz);
  -- Recheck after any outbox FK/unique/trigger wait before publishing the UUID
  -- pin. A failure must roll back the inserted mail, not return a partial receipt.
  account:=private.early_access_invitation_account(invitation.recipient);
  if setup.lease_until<=clock_timestamp() or not private.early_access_account_setup_current(target_generation_id)
    or account->>'id' is distinct from setup.reserved_user_id::text or not(account->>'healthy')::boolean
    or (account->>'confirmed')::boolean or (target_binding->>'expiresAt')::timestamptz<=clock_timestamp() then
    raise exception using errcode='PEI01',message='invitation_bootstrap_authority_changed';end if;
  update private.early_access_invitations set account_id=setup.reserved_user_id where id=target_generation_id;
  update private.early_access_account_bootstraps set status='mail_ready',lease_token=null,lease_until=null,last_code=null where invitation_id=target_generation_id;
  return true;
end;
$$;
revoke all on function public.persist_early_access_account_setup(uuid,uuid,jsonb,jsonb,text,text) from public,anon,authenticated,service_role;
grant execute on function public.persist_early_access_account_setup(uuid,uuid,jsonb,jsonb,text,text) to service_role;

create function public.settle_early_access_account_bootstrap(target_generation_id uuid,target_worker_token uuid,target_code text)
returns boolean language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare setup private.early_access_account_bootstraps%rowtype;
begin
  perform private.require_early_access_invitation_worker();
  if target_code is null or length(target_code)>80 or target_code !~ '^[a-z0-9_]+$' then raise exception using errcode='22023',message='invitation_delivery_invalid_outcome';end if;
  setup:=private.lock_early_access_account_bootstrap(target_generation_id);
  if setup.invitation_id is null or setup.status not in ('leased','native_started') or setup.lease_token is distinct from target_worker_token
    or setup.lease_until<=clock_timestamp() then return false;end if;
  update private.early_access_account_bootstraps set status='needs_review',lease_token=null,lease_until=null,last_code=target_code where invitation_id=target_generation_id;
  return true;
end;
$$;
revoke all on function public.settle_early_access_account_bootstrap(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.settle_early_access_account_bootstrap(uuid,uuid,text) to service_role;

create function public.claim_early_access_account_setup_deliveries(target_worker_token uuid,target_batch_size integer default 1)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare delivery private.early_access_account_setup_deliveries%rowtype; setup private.early_access_account_bootstraps%rowtype;
  invitation private.early_access_invitations%rowtype; account jsonb; target uuid;
begin
  perform private.require_early_access_invitation_worker();
  if target_worker_token is null or target_batch_size is distinct from 1 then raise exception using errcode='22023',message='invitation_worker_invalid_input';end if;
  perform pg_advisory_xact_lock(hashtextextended('site-admin-lifecycle',1502));
  select id into target from private.early_access_account_setup_deliveries d where d.status in ('queued','leased','retry')
    and d.next_attempt_at<=clock_timestamp() and (d.lease_until is null or d.lease_until<=clock_timestamp()) order by d.next_attempt_at,d.id limit 1;
  if target is null then return '[]'::jsonb;end if;
  select * into delivery from private.early_access_account_setup_deliveries where id=target;
  setup:=private.lock_early_access_account_bootstrap(delivery.invitation_id);
  select * into invitation from private.early_access_invitations where id=delivery.invitation_id;
  select * into delivery from private.early_access_account_setup_deliveries where id=target for update;
  account:=private.early_access_invitation_account(invitation.recipient);
  if not private.early_access_account_setup_current(invitation.id) then
    update private.early_access_account_setup_deliveries set status='cancelled',envelope=null,lease_token=null,lease_until=null,last_code='generation_unavailable' where id=target;
    return '[]'::jsonb;end if;
  if setup.status<>'mail_ready' or invitation.account_id is distinct from setup.reserved_user_id
    or account->>'id' is distinct from setup.reserved_user_id::text or not(account->>'healthy')::boolean
    or delivery.attempts>=12 or delivery.expires_at<=clock_timestamp() or delivery.first_dispatched_at<=clock_timestamp()-interval '23 hours' then
    update private.early_access_account_setup_deliveries set status='needs_review',lease_token=null,lease_until=null,last_code='setup_unavailable' where id=target;
    return '[]'::jsonb;end if;
  if (account->>'confirmed')::boolean then
    update private.early_access_account_setup_deliveries set status='cancelled',envelope=null,lease_token=null,lease_until=null,last_code='setup_already_complete' where id=target;
    return '[]'::jsonb;end if;
  update private.early_access_account_setup_deliveries set status='leased',lease_token=target_worker_token,lease_until=clock_timestamp()+interval '2 minutes',attempts=attempts+1
    where id=target returning * into delivery;
  return jsonb_build_array(jsonb_build_object('deliveryId',delivery.id,'binding',delivery.binding,'envelope',delivery.envelope,
    'contentFingerprint',delivery.content_fingerprint,'idempotencyKey',delivery.idempotency_key,'firstDispatchedAt',delivery.first_dispatched_at));
end;
$$;
revoke all on function public.claim_early_access_account_setup_deliveries(uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.claim_early_access_account_setup_deliveries(uuid,integer) to service_role;

create function public.mark_early_access_account_setup_dispatched(target_delivery_id uuid,target_worker_token uuid,target_content_fingerprint text)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare delivery private.early_access_account_setup_deliveries%rowtype; setup private.early_access_account_bootstraps%rowtype;
  invitation private.early_access_invitations%rowtype; account jsonb; as_of timestamptz;
begin
  perform private.require_early_access_invitation_worker();
  select * into delivery from private.early_access_account_setup_deliveries where id=target_delivery_id;
  if not found then return null;end if;
  setup:=private.lock_early_access_account_bootstrap(delivery.invitation_id);
  select * into invitation from private.early_access_invitations where id=delivery.invitation_id;
  select * into delivery from private.early_access_account_setup_deliveries where id=target_delivery_id for update;
  if delivery.status<>'leased' or delivery.lease_token is distinct from target_worker_token or delivery.lease_until<=clock_timestamp()
    or delivery.envelope is null or delivery.content_fingerprint is distinct from target_content_fingerprint
    or setup.status<>'mail_ready' or invitation.account_id is distinct from setup.reserved_user_id then return null;end if;
  -- Called only after strict native_recovery AES/AAD/message validation. A
  -- service claim alone cannot send or exchange the native token on the user's behalf.
  begin
    if delivery.first_dispatched_at<=clock_timestamp()-interval '23 hours' or not private.reserve_transactional_email(delivery.id) then return null;end if;
    as_of:=clock_timestamp();account:=private.early_access_invitation_account(invitation.recipient);
    if not private.early_access_account_setup_current(invitation.id) or delivery.lease_until<=as_of or delivery.expires_at<=as_of
      or delivery.first_dispatched_at<=as_of-interval '23 hours' or account->>'id' is distinct from setup.reserved_user_id::text
      or not(account->>'healthy')::boolean or (account->>'confirmed')::boolean then
      raise exception using errcode='PEI01',message='invitation_dispatch_authority_changed';end if;
  exception when sqlstate 'PEI01' then return null;end;
  update private.early_access_account_setup_deliveries set first_dispatched_at=coalesce(first_dispatched_at,as_of) where id=delivery.id returning * into delivery;
  return jsonb_build_object('deliveryId',delivery.id,'idempotencyKey',delivery.idempotency_key,'bindingFingerprint',delivery.content_fingerprint,'firstDispatchedAt',delivery.first_dispatched_at);
end;
$$;
revoke all on function public.mark_early_access_account_setup_dispatched(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.mark_early_access_account_setup_dispatched(uuid,uuid,text) to service_role;

create function public.settle_early_access_account_setup_delivery(target_delivery_id uuid,target_worker_token uuid,target_outcome text,
  target_code text default null,target_receipt_id uuid default null)
returns boolean language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare delivery private.early_access_account_setup_deliveries%rowtype; as_of timestamptz;
begin
  perform private.require_early_access_invitation_worker();
  if target_outcome is null or target_outcome not in ('accepted','retryable','uncertain','needs_review')
    or (target_code is not null and (length(target_code)>80 or target_code !~ '^[a-z0-9_]+$')) then raise exception using errcode='22023',message='invitation_delivery_invalid_outcome';end if;
  select * into delivery from private.early_access_account_setup_deliveries where id=target_delivery_id;
  if not found then return false;end if;
  perform private.lock_early_access_account_bootstrap(delivery.invitation_id);
  select * into delivery from private.early_access_account_setup_deliveries where id=target_delivery_id for update;as_of:=clock_timestamp();
  if delivery.status<>'leased' or delivery.lease_token is distinct from target_worker_token or delivery.lease_until<=as_of then return false;end if;
  if target_outcome='accepted' then
    if delivery.first_dispatched_at is null or target_receipt_id is null or target_code is not null then raise exception using errcode='22023',message='invitation_delivery_invalid_receipt';end if;
    update private.early_access_account_setup_deliveries set status='delivered',envelope=null,provider_receipt_id=target_receipt_id,completed_at=as_of,
      lease_token=null,lease_until=null,last_code=null where id=delivery.id;
  else
    if target_receipt_id is not null then raise exception using errcode='22023',message='invitation_delivery_invalid_receipt';end if;
    update private.early_access_account_setup_deliveries set status=case when target_outcome='needs_review' or attempts>=12
        or expires_at<=as_of or first_dispatched_at<=as_of-interval '23 hours' then 'needs_review' else 'retry' end,
      next_attempt_at=as_of+interval '5 minutes',lease_token=null,lease_until=null,last_code=target_code where id=delivery.id;
  end if;
  return true;
end;
$$;
revoke all on function public.settle_early_access_account_setup_delivery(uuid,uuid,text,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.settle_early_access_account_setup_delivery(uuid,uuid,text,text,uuid) to service_role;

comment on table private.early_access_account_bootstraps is 'Create-only private UUID provenance for approved NEW accounts. Native-start uncertainty is terminal review, never a blind link-regeneration retry.';
comment on table private.early_access_account_setup_deliveries is 'Separate short-lived native_recovery encrypted message; frozen retries, shared free quota, never a seven-day native token exchange.';
