-- Application invitations are not native Auth login credentials. This migration
-- creates no account, sends no mail and enrolls no person. The Edge issuer must
-- use the ORIGINAL administrator bearer; service_role cannot invoke its writer.
set local lock_timeout = '5s';

-- Pin verified intake identity before intake's own advisory/request locks.
-- Otherwise intake(request -> Auth FK), deletion(Auth -> lifecycle), and an
-- admin writer(lifecycle -> request) can form a three-way deadlock. Preserve
-- the original service-only boolean contract and its existing ACL unchanged.
create or replace function private.early_access_verified_identity_matches(p_user_id uuid, p_email text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
begin
  if current_setting('role',true) is distinct from 'service_role' or auth.uid() is not null
    or p_user_id is null or p_email is null then return false;end if;
  perform 1 from auth.users u where u.id=p_user_id and lower(u.email)=p_email
    and u.email_confirmed_at is not null and not coalesce(u.is_anonymous,false)
    and u.deleted_at is null and (u.banned_until is null or u.banned_until<=clock_timestamp())
    for key share;
  return found;
end;
$$;

create table private.early_access_invitations (
  id uuid primary key,
  request_id uuid not null references private.early_access_requests(id),
  recipient text not null,
  -- Historical immutable UUID, deliberately no new Auth FK: insertion happens
  -- under lifecycle and must not take an implicit Auth row lock in reverse order.
  account_id uuid,
  token_digest text not null unique check (token_digest ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz not null check (isfinite(issued_at)),
  expires_at timestamptz not null check (isfinite(expires_at) and expires_at = issued_at + interval '7 days'),
  state text not null default 'current' check (state in ('current','superseded','revoked','expired','accepted')),
  closed_at timestamptz,
  accepted_by uuid,
  created_by uuid not null,
  operation_id uuid not null,
  check ((state = 'current') = (closed_at is null)),
  check ((state = 'accepted') = (accepted_by is not null))
);
create unique index early_access_invitation_current_idx on private.early_access_invitations(request_id) where state = 'current';
create index early_access_invitation_request_idx on private.early_access_invitations(request_id, issued_at desc, id);
create index early_access_invitation_account_idx on private.early_access_invitations(account_id) where account_id is not null;
create index early_access_invitation_expiry_idx on private.early_access_invitations(expires_at,id) where state = 'current';

create table private.early_access_invitation_deliveries (
  id uuid primary key,
  invitation_id uuid not null unique references private.early_access_invitations(id),
  binding jsonb not null,
  envelope jsonb,
  content_fingerprint text not null check (content_fingerprint ~ '^[0-9a-f]{64}$'),
  idempotency_key text not null unique,
  status text not null default 'queued' check (status in ('queued','leased','retry','delivered','needs_review','cancelled')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default clock_timestamp(),
  lease_token uuid,
  lease_until timestamptz,
  validated_at timestamptz,
  first_dispatched_at timestamptz,
  provider_receipt_id uuid,
  completed_at timestamptz,
  last_code text,
  check ((lease_token is null) = (lease_until is null)),
  check ((first_dispatched_at is null) = (validated_at is null)),
  check (status <> 'delivered' or (first_dispatched_at is not null and provider_receipt_id is not null and completed_at is not null)),
  check (envelope is not null or status in ('delivered','cancelled'))
);
create index early_access_invitation_delivery_due_idx on private.early_access_invitation_deliveries(next_attempt_at,id)
  where status in ('queued','leased','retry');
create table private.early_access_acceptance_operations (
  actor_id uuid not null references auth.users(id) on delete cascade,
  operation_id uuid not null,
  signature text not null check (signature ~ '^[0-9a-f]{64}$'),
  result jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key(actor_id,operation_id)
);
create index early_access_acceptance_actor_time_idx on private.early_access_acceptance_operations(actor_id,created_at);
alter table private.early_access_invitations enable row level security;
alter table private.early_access_invitation_deliveries enable row level security;
alter table private.early_access_acceptance_operations enable row level security;
revoke all on private.early_access_invitations, private.early_access_invitation_deliveries,
  private.early_access_acceptance_operations from public,anon,authenticated,service_role;

-- Preserve existing role and denial branches exactly. Acceptance and scheduled
-- expiry are typed member/system events, not claims that those actors are admins.
alter table private.site_admin_audit drop constraint site_admin_audit_typed_action_check,
  add constraint site_admin_audit_typed_action_check check (
    (action in ('roles.bootstrap','roles.assign') and permission='roles.manage'
      and reason_code in ('initial_admin_bootstrap','staff_access_review','approved_role_change','recovery_plan')
      and (error_code is null or error_code in ('invalid_input','revision_conflict','self_action_forbidden','target_unavailable','target_mfa_required','rate_limited','final_admin'))
      and early_access_request_id is null and before_request_status is null and after_request_status is null)
    or
    (action='early_access.deny' and permission='operations.manage' and reason_code='early_access_review'
      and before_role is null and after_role is null and target_user_id is null and early_access_request_id is not null
      and (before_request_status is null or before_request_status in ('pending','approved','invited','accepted','denied','expired','revoked'))
      and after_request_status is not distinct from case when outcome='success' then 'denied' else before_request_status end
      and ((outcome='success' and before_request_status is not distinct from 'pending' and error_code is null)
        or (outcome='failure' and error_code is not null and error_code in ('invalid_input','revision_conflict','target_unavailable','invalid_state'))))
    or
    (action in ('early_access.approve','early_access.resend','early_access.revoke')
      and actor_id is not null and permission='operations.manage' and reason_code='early_access_review'
      and early_access_request_id is not null and target_user_id is null and before_role is null and after_role is null
      and (before_request_status is null or before_request_status in ('pending','approved','invited','accepted','denied','expired','revoked'))
      and ((outcome='success' and error_code is null and (
        (action='early_access.approve' and before_request_status='pending' and after_request_status='approved') or
        (action='early_access.resend' and before_request_status in ('approved','invited','expired') and after_request_status='approved') or
        (action='early_access.revoke' and before_request_status in ('approved','invited') and after_request_status='revoked')))
        or (outcome='failure' and after_request_status is not distinct from before_request_status
          and error_code in ('invalid_input','revision_conflict','target_unavailable','invalid_state','account_unavailable','account_recovery_required','program_unavailable'))))
    or
    (action='early_access.accept' and actor_id is not null and target_user_id=actor_id
      and permission='early_access.accept' and reason_code='invitation_acceptance'
      and early_access_request_id is not null and before_role is null and after_role is null
      and ((outcome='success' and error_code is null and before_request_status in ('approved','invited') and after_request_status='accepted')
        or (outcome='failure' and after_request_status is not distinct from before_request_status
          and error_code in ('invitation_unavailable','account_setup_required','account_unavailable','delivery_not_ready','program_unavailable','already_qualified'))))
    or
    (action='early_access.expire' and actor_id is null and target_user_id is null
      and permission='early_access.lifecycle' and reason_code='invitation_expiry'
      and early_access_request_id is not null and before_role is null and after_role is null
      and outcome='success' and error_code is null and before_request_status in ('approved','invited') and after_request_status='expired')
  );

create function private.require_early_access_invitation_admin(target_actor uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare sid uuid; as_of timestamptz;
begin
  sid := private.require_site_admin('operations.manage',target_actor,true);
  -- Foundation helpers use statement time. These additional fresh checks are
  -- necessary after lifecycle/quota/row waits; they do not weaken older guards.
  perform private.require_member_current_session(target_actor,sid);
  as_of := clock_timestamp();
  if not exists (select 1 from auth.mfa_amr_claims a where a.session_id=sid and a.authentication_method='totp'
      and a.updated_at between as_of-interval '10 minutes' and as_of+interval '30 seconds')
    or not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(auth.jwt()->'amr')='array' then auth.jwt()->'amr' else '[]'::jsonb end) a
      where a->>'method'='totp' and case when a->>'timestamp' ~ '^[0-9]{1,12}$' then (a->>'timestamp')::bigint else 0 end
        between extract(epoch from as_of-interval '10 minutes') and extract(epoch from as_of+interval '30 seconds')) then
    raise exception using errcode='PT403',message='admin_permission_or_step_up_required';
  end if;
  return sid;
end;
$$;
revoke all on function private.require_early_access_invitation_admin(uuid) from public,anon,authenticated,service_role;

create function private.early_access_invitation_account(target_email text)
returns jsonb language sql volatile security definer set search_path='' as $$
  select jsonb_build_object('count',count(*),'id',case when count(*)=1 then (array_agg(u.id))[1] else null end,
    'healthy',coalesce(bool_and(u.deleted_at is null and not coalesce(u.is_anonymous,false)
      and (u.banned_until is null or u.banned_until<=clock_timestamp())),false),
    'confirmed',coalesce(bool_and(u.email_confirmed_at is not null),false))
  from (select u.id,u.deleted_at,u.is_anonymous,u.banned_until,u.email_confirmed_at
    from private.site_admin_user_directory d join auth.users u on u.id=d.user_id
    where d.email=target_email and lower(u.email)=target_email order by u.id limit 2) u;
$$;
revoke all on function private.early_access_invitation_account(text) from public,anon,authenticated,service_role;

create function private.early_access_invitation_token_digest(target_token text)
returns text language plpgsql immutable security invoker set search_path='' as $$
declare raw bytea;
begin
  if target_token is null or target_token !~ '^[A-Za-z0-9_-]{43}$' then return null; end if;
  raw:=decode(translate(target_token,'-_','+/')||'=','base64');
  if octet_length(raw)<>32 or rtrim(translate(encode(raw,'base64'),'+/','-_'),'=')<>target_token then return null; end if;
  return encode(sha256(raw),'hex');
end;
$$;
revoke all on function private.early_access_invitation_token_digest(text) from public,anon,authenticated,service_role;

create function private.early_access_invitation_material_valid(target_binding jsonb,target_envelope jsonb,
  target_token_digest text,target_content_fingerprint text,target_idempotency_key text,target_request uuid,target_email text)
returns boolean language plpgsql volatile security invoker set search_path='' as $$
declare issued timestamptz; expires timestamptz; nonce bytea; encrypted bytea; as_of timestamptz:=clock_timestamp();
begin
  if jsonb_typeof(target_binding) is distinct from 'object' or pg_column_size(target_binding)>2048 then return false; end if;
  if (select count(*) from jsonb_object_keys(target_binding))<>7
    or not (target_binding ?& array['requestId','generationId','deliveryId','recipient','issuedAt','expiresAt','from']) then return false; end if;
  if exists (select 1 from jsonb_each(target_binding) where jsonb_typeof(value)<>'string')
    or target_binding->>'requestId' is distinct from target_request::text
    or target_binding->>'recipient' is distinct from target_email
    or target_binding->>'generationId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or target_binding->>'deliveryId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or length(target_binding->>'from')>320 or target_binding->>'from' ~ '[[:cntrl:]]'
    or target_binding->>'from' !~ '^([A-Za-z0-9][A-Za-z0-9 .&''-]{0,63} <)?[A-Za-z0-9.!#$%&''*+/=?^_`{|}~-]+@mail[.]77dominion[.]com>?$'
    or target_binding->>'issuedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    or target_binding->>'expiresAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    or target_token_digest is null or target_token_digest !~ '^[0-9a-f]{64}$'
    or target_content_fingerprint is null or target_content_fingerprint !~ '^[0-9a-f]{64}$'
    or target_idempotency_key is distinct from 'dominion-early-access/'||(target_binding->>'deliveryId') then return false; end if;
  issued:=(target_binding->>'issuedAt')::timestamptz;expires:=(target_binding->>'expiresAt')::timestamptz;
  if not isfinite(issued) or not isfinite(expires) or expires<>issued+interval '7 days'
    or issued<as_of-interval '30 seconds' or issued>as_of+interval '30 seconds' then return false; end if;
  if jsonb_typeof(target_envelope) is distinct from 'object' or pg_column_size(target_envelope)>12000
    or (select count(*) from jsonb_object_keys(target_envelope))<>4
    or not (target_envelope ?& array['version','keyVersion','nonce','ciphertext'])
    or target_envelope->'version' is distinct from '1'::jsonb
    or jsonb_typeof(target_envelope->'keyVersion') is distinct from 'number'
    or (target_envelope->>'keyVersion') !~ '^[1-9][0-9]{0,9}$'
    or (target_envelope->>'keyVersion')::bigint>2147483647
    or jsonb_typeof(target_envelope->'nonce') is distinct from 'string'
    or target_envelope->>'nonce' !~ '^[A-Za-z0-9_-]{16}$'
    or jsonb_typeof(target_envelope->'ciphertext') is distinct from 'string'
    or length(target_envelope->>'ciphertext') not between 23 and 10944
    or target_envelope->>'ciphertext' !~ '^[A-Za-z0-9_-]+$' then return false; end if;
  nonce:=decode(translate(target_envelope->>'nonce','-_','+/'),'base64');
  encrypted:=decode(rpad(translate(target_envelope->>'ciphertext','-_','+/'),((length(target_envelope->>'ciphertext')+3)/4)*4,'='),'base64');
  return octet_length(nonce)=12 and octet_length(encrypted) between 17 and 8208
    and replace(rtrim(translate(encode(encrypted,'base64'),'+/','-_'),'='),E'\n','')=target_envelope->>'ciphertext';
exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range or invalid_parameter_value then return false;
end;
$$;
revoke all on function private.early_access_invitation_material_valid(jsonb,jsonb,text,text,text,uuid,text) from public,anon,authenticated,service_role;

create function private.write_early_access_invitation(target_expected_actor_id uuid,target_action text,target_request_id uuid,
  target_expected_revision bigint,target_operation_id uuid,target_correlation_id uuid,target_binding jsonb,target_token_digest text,
  target_content_fingerprint text,target_idempotency_key text,target_envelope jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare sid uuid; prior private.early_access_requests%rowtype; operation private.site_admin_role_requests%rowtype;
  signature jsonb; result jsonb; failure text; environment text; account jsonb; next_status text; as_of timestamptz;
begin
  sid:=private.require_early_access_invitation_admin(target_expected_actor_id);
  if target_action is null or target_action not in ('approve','resend','revoke')
    or target_request_id is null or target_operation_id is null or target_correlation_id is null then
    raise exception using errcode='22023',message='admin_request_identity_required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('site-admin-lifecycle',1502));
  if private.require_early_access_invitation_admin(target_expected_actor_id) is distinct from sid then
    raise exception using errcode='PT401',message='admin_authentication_required'; end if;
  signature:=jsonb_build_object('digest',encode(sha256(convert_to(jsonb_build_array('early_access.invitation:v1',target_action,
    target_request_id,target_expected_revision,target_correlation_id)::text,'UTF8')),'hex'));
  select * into operation from private.site_admin_role_requests where actor_id=target_expected_actor_id and request_id=target_operation_id;
  if operation.request_id is not null then
    if operation.signature is distinct from signature then raise exception using errcode='22023',message='admin_idempotency_conflict'; end if;
    return operation.result;
  end if;
  if exists(select 1 from private.site_admin_audit where actor_id=target_expected_actor_id and request_id=target_operation_id)
    or exists(select 1 from private.early_access_acceptance_operations where actor_id=target_expected_actor_id and operation_id=target_operation_id) then
    raise exception using errcode='22023',message='admin_idempotency_conflict'; end if;
  if (select count(*) from private.site_admin_audit where actor_id=target_expected_actor_id and occurred_at>clock_timestamp()-interval '1 minute')>=20
    or (select count(*) from private.site_admin_audit where actor_id=target_expected_actor_id and occurred_at>clock_timestamp()-interval '1 hour')>=100 then
    return jsonb_build_object('ok',false,'errorCode','rate_limited'); end if;
  select c.environment into strict environment from private.site_admin_configuration c where singleton;
  select * into prior from private.early_access_requests where id=target_request_id for update;
  -- This row can block independently of the lifecycle lock (intake owns only
  -- its historical fields). Revalidate the same actor and fresh MFA afterward.
  if private.require_early_access_invitation_admin(target_expected_actor_id) is distinct from sid then
    raise exception using errcode='PT401',message='admin_authentication_required'; end if;
  if target_expected_revision is null or target_expected_revision<0 then failure:='invalid_input';
  elsif prior.id is null then failure:='target_unavailable';
  elsif prior.revision<>target_expected_revision then failure:='revision_conflict';
  elsif (target_action='approve' and prior.status<>'pending')
    or (target_action='resend' and prior.status not in ('approved','invited','expired'))
    or (target_action='revoke' and prior.status not in ('approved','invited')) then failure:='invalid_state';
  elsif target_action='revoke' then
    if target_binding is not null or target_token_digest is not null or target_content_fingerprint is not null
      or target_idempotency_key is not null or target_envelope is not null then failure:='invalid_input';
    elsif not exists(select 1 from private.early_access_invitations where request_id=prior.id and state='current') then failure:='invalid_state'; end if;
  else
    if not private.early_access_invitation_material_valid(target_binding,target_envelope,target_token_digest,
      target_content_fingerprint,target_idempotency_key,prior.id,prior.email) then failure:='invalid_input';
    elsif exists(select 1 from private.early_access_invitations where id=(target_binding->>'generationId')::uuid or token_digest=target_token_digest)
      or exists(select 1 from private.early_access_invitation_deliveries where id=(target_binding->>'deliveryId')::uuid) then failure:='invalid_input';
    else
      account:=private.early_access_invitation_account(prior.email);
      if (account->>'count')::integer>1 or ((account->>'count')::integer=1 and not (account->>'healthy')::boolean) then failure:='account_unavailable';
      elsif (account->>'count')::integer=1 and not (account->>'confirmed')::boolean then failure:='account_recovery_required'; end if;
    end if;
    if failure is null then
      perform 1 from private.early_access_programs where program_key='early_access_v1' for share;
      if private.require_early_access_invitation_admin(target_expected_actor_id) is distinct from sid then
        raise exception using errcode='PT401',message='admin_authentication_required'; end if;
      as_of:=clock_timestamp();
      if not exists(select 1 from private.early_access_programs where program_key='early_access_v1' and configured
        and (beta_starts_at is null or beta_starts_at>as_of)) then failure:='program_unavailable';
      elsif not private.early_access_invitation_material_valid(target_binding,target_envelope,target_token_digest,
        target_content_fingerprint,target_idempotency_key,prior.id,prior.email) then failure:='invalid_input';
      elsif account is distinct from private.early_access_invitation_account(prior.email) then failure:='account_unavailable'; end if;
    end if;
  end if;
  if failure is null then
    as_of:=clock_timestamp();next_status:=case when target_action='revoke' then 'revoked' else 'approved' end;
    update private.early_access_invitations set state=case when target_action='revoke' then 'revoked' else 'superseded' end,closed_at=as_of
      where request_id=prior.id and state='current';
    update private.early_access_invitation_deliveries d set status='cancelled',envelope=null,lease_token=null,lease_until=null,
      last_code=case when target_action='revoke' then 'invitation_revoked' else 'invitation_superseded' end
      from private.early_access_invitations i where i.id=d.invitation_id and i.request_id=prior.id
        and i.state in ('revoked','superseded') and d.status<>'delivered';
    if target_action<>'revoke' then
      insert into private.early_access_invitations(id,request_id,recipient,account_id,token_digest,issued_at,expires_at,created_by,operation_id)
        values((target_binding->>'generationId')::uuid,prior.id,prior.email,(account->>'id')::uuid,target_token_digest,
          (target_binding->>'issuedAt')::timestamptz,(target_binding->>'expiresAt')::timestamptz,target_expected_actor_id,target_operation_id);
      insert into private.early_access_invitation_deliveries(id,invitation_id,binding,envelope,content_fingerprint,idempotency_key)
        values((target_binding->>'deliveryId')::uuid,(target_binding->>'generationId')::uuid,target_binding,target_envelope,target_content_fingerprint,target_idempotency_key);
    end if;
    update private.early_access_requests set status=next_status,revision=revision+1,updated_at=as_of,
      invitation_sent_at=case when target_action='revoke' then invitation_sent_at else null end,
      invitation_expires_at=case when target_action='revoke' then invitation_expires_at else (target_binding->>'expiresAt')::timestamptz end
      where id=prior.id;
    result:=jsonb_build_object('ok',true,'requestId',prior.id,'status',next_status,'revision',(prior.revision+1)::text);
  else result:=jsonb_build_object('ok',false,'errorCode',failure); end if;
  insert into private.site_admin_audit(actor_id,action,permission,reason_code,early_access_request_id,before_request_status,
    after_request_status,request_id,correlation_id,environment,outcome,error_code)
    values(target_expected_actor_id,'early_access.'||target_action,'operations.manage','early_access_review',target_request_id,prior.status,
      case when failure is null then next_status else prior.status end,target_operation_id,target_correlation_id,environment,
      case when failure is null then 'success' else 'failure' end,failure);
  insert into private.site_admin_role_requests values(target_expected_actor_id,target_operation_id,signature,result);
  return result;
end;
$$;
revoke all on function private.write_early_access_invitation(uuid,text,uuid,bigint,uuid,uuid,jsonb,text,text,text,jsonb) from public,anon,authenticated,service_role;
create function public.site_admin_write_early_access_invitation(target_expected_actor_id uuid,target_action text,target_request_id uuid,
  target_expected_revision bigint,target_operation_id uuid,target_correlation_id uuid,target_binding jsonb default null,target_token_digest text default null,
  target_content_fingerprint text default null,target_idempotency_key text default null,target_envelope jsonb default null)
returns jsonb language sql security definer set search_path='' as $$
  select private.write_early_access_invitation(target_expected_actor_id,target_action,target_request_id,target_expected_revision,target_operation_id,
    target_correlation_id,target_binding,target_token_digest,target_content_fingerprint,target_idempotency_key,target_envelope);
$$;
revoke all on function public.site_admin_write_early_access_invitation(uuid,text,uuid,bigint,uuid,uuid,jsonb,text,text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.site_admin_write_early_access_invitation(uuid,text,uuid,bigint,uuid,uuid,jsonb,text,text,text,jsonb) to authenticated;

-- All lifecycle mutations take lifecycle -> request -> program -> invitation ->
-- delivery -> grant (where present). Acceptance takes its actor Auth KEY SHARE
-- before that sequence; no Auth row locks are acquired afterward. No provider
-- network call occurs inside these transactions. Member consumers use program->grant.
create function private.expire_early_access_invitation(target_invitation uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare item private.early_access_invitations%rowtype; prior private.early_access_requests%rowtype; environment text; as_of timestamptz;
begin
  select * into item from private.early_access_invitations where id=target_invitation;
  if not found then return false; end if;
  if item.state<>'current' or item.expires_at>clock_timestamp() then return false;end if;
  select * into prior from private.early_access_requests where id=item.request_id for update;
  select * into item from private.early_access_invitations where id=target_invitation for update;
  as_of:=clock_timestamp();
  if item.state<>'current' or item.expires_at>as_of or prior.status not in ('approved','invited') then return false; end if;
  update private.early_access_invitations set state='expired',closed_at=as_of where id=item.id;
  update private.early_access_invitation_deliveries set status='cancelled',envelope=null,lease_token=null,lease_until=null,last_code='invitation_expired'
    where invitation_id=item.id and status<>'delivered';
  update private.early_access_requests set status='expired',revision=revision+1,updated_at=as_of where id=prior.id;
  select c.environment into strict environment from private.site_admin_configuration c where singleton;
  insert into private.site_admin_audit(actor_id,action,permission,reason_code,early_access_request_id,before_request_status,after_request_status,
    request_id,correlation_id,environment,outcome)
    values(null,'early_access.expire','early_access.lifecycle','invitation_expiry',prior.id,prior.status,'expired',gen_random_uuid(),gen_random_uuid(),environment,'success');
  return true;
end;
$$;
revoke all on function private.expire_early_access_invitation(uuid) from public,anon,authenticated,service_role;

create function private.accept_early_access_invitation(target_expected_actor_id uuid,target_generation_id uuid,target_token text,
  target_operation_id uuid,target_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare sid uuid; digest text; signature text; saved private.early_access_acceptance_operations%rowtype;
  invitation private.early_access_invitations%rowtype; prior private.early_access_requests%rowtype;
  result jsonb; failure text; as_of timestamptz; account jsonb; environment text;
begin
  sid:=private.require_member_request_identity(target_expected_actor_id);
  digest:=private.early_access_invitation_token_digest(target_token);
  if target_generation_id is null or digest is null or target_operation_id is null or target_correlation_id is null then
    raise exception using errcode='22023',message='invitation_invalid_input'; end if;
  -- Existing grant/qualification/receipt FKs reference the actor. Take their
  -- KEY SHARE first: native Auth DELETE obtains its row lock before lifecycle.
  perform 1 from auth.users where id=target_expected_actor_id for key share;
  perform pg_advisory_xact_lock(hashtextextended('site-admin-lifecycle',1502));
  if private.require_member_request_identity(target_expected_actor_id) is distinct from sid then
    raise exception using errcode='PT401',message='member_authentication_required'; end if;
  signature:=encode(sha256(convert_to(jsonb_build_array('early_access.accept:v1',target_generation_id,digest,target_correlation_id)::text,'UTF8')),'hex');
  select * into saved from private.early_access_acceptance_operations where actor_id=target_expected_actor_id and operation_id=target_operation_id;
  if found then
    if saved.signature<>signature then raise exception using errcode='22023',message='invitation_idempotency_conflict'; end if;
    return saved.result;
  end if;
  if exists(select 1 from private.site_admin_role_requests where actor_id=target_expected_actor_id and request_id=target_operation_id)
    or exists(select 1 from private.site_admin_audit where actor_id=target_expected_actor_id and request_id=target_operation_id) then
    raise exception using errcode='22023',message='invitation_idempotency_conflict'; end if;
  if (select count(*) from private.early_access_acceptance_operations where actor_id=target_expected_actor_id and created_at>clock_timestamp()-interval '1 minute')>=10
    or (select count(*) from private.early_access_acceptance_operations where actor_id=target_expected_actor_id and created_at>clock_timestamp()-interval '1 hour')>=50 then
    return jsonb_build_object('ok',false,'errorCode','rate_limited'); end if;
  select * into invitation from private.early_access_invitations where id=target_generation_id and token_digest=digest;
  if found then
    perform private.expire_early_access_invitation(invitation.id);
    select * into prior from private.early_access_requests where id=invitation.request_id for update;
    perform 1 from private.early_access_programs where program_key='early_access_v1' for share;
    select * into invitation from private.early_access_invitations where id=target_generation_id for update;
    perform 1 from private.early_access_grants where user_id=target_expected_actor_id and program_key='early_access_v1' for update;
    if private.require_member_request_identity(target_expected_actor_id) is distinct from sid then
      raise exception using errcode='PT401',message='member_authentication_required'; end if;
    as_of:=clock_timestamp();
    account:=private.early_access_invitation_account(invitation.recipient);
    if invitation.state<>'current' or invitation.expires_at<=as_of or prior.status not in ('approved','invited') then failure:='invitation_unavailable';
    elsif account->>'id' is distinct from target_expected_actor_id::text or not (account->>'healthy')::boolean
      or not (account->>'confirmed')::boolean then failure:='account_unavailable';
    elsif invitation.account_id is null then failure:='account_setup_required';
    elsif invitation.account_id<>target_expected_actor_id then failure:='account_unavailable';
    elsif not exists(select 1 from private.early_access_invitation_deliveries where invitation_id=invitation.id
      and validated_at is not null and first_dispatched_at is not null) then failure:='delivery_not_ready';
    elsif not exists(select 1 from private.early_access_programs where program_key='early_access_v1' and configured
      and (beta_starts_at is null or beta_starts_at>as_of)) then failure:='program_unavailable';
    elsif exists(select 1 from private.early_access_grants where user_id=target_expected_actor_id and program_key='early_access_v1') then failure:='already_qualified'; end if;
  else failure:='invitation_unavailable'; end if;
  if failure is null then
    update private.early_access_requests set status='accepted',user_id=target_expected_actor_id,accepted_at=as_of,
      revision=revision+1,updated_at=as_of where id=prior.id;
    insert into private.early_access_grants(user_id,program_key,request_id,accepted_at,starts_at)
      values(target_expected_actor_id,'early_access_v1',prior.id,as_of,as_of);
    -- The final fresh checks are the authorization linearization point. Native
    -- changes committed before them must deny; overlapping changes afterward
    -- may order after acceptance. No new triggers couple native Auth's parent /
    -- child FK lock graph to lifecycle. Failure rolls back request + grant/fact.
    account:=private.early_access_invitation_account(invitation.recipient);
    if private.require_member_request_identity(target_expected_actor_id) is distinct from sid
      or invitation.account_id is distinct from target_expected_actor_id
      or account->>'id' is distinct from invitation.account_id::text
      or not (account->>'healthy')::boolean or not (account->>'confirmed')::boolean
      or invitation.expires_at<=clock_timestamp()
      or not exists(select 1 from private.early_access_programs where program_key='early_access_v1' and configured
        and (beta_starts_at is null or beta_starts_at>clock_timestamp())) then
      raise exception using errcode='PT401',message='member_authentication_required';end if;
    update private.early_access_invitations set state='accepted',closed_at=as_of,accepted_by=target_expected_actor_id where id=invitation.id;
    update private.early_access_invitation_deliveries set status='cancelled',envelope=null,lease_token=null,lease_until=null,last_code='invitation_accepted'
      where invitation_id=invitation.id and status<>'delivered';
    result:=jsonb_build_object('ok',true,'status','accepted','actorId',target_expected_actor_id,'program','early_access_v1');
  else result:=jsonb_build_object('ok',false,'errorCode',failure); end if;
  -- Invalid/unknown capabilities get a bounded, non-enumerating operation
  -- receipt, not an audit row containing a guessed request or a raw token.
  if prior.id is not null then
    select c.environment into strict environment from private.site_admin_configuration c where singleton;
    insert into private.site_admin_audit(actor_id,target_user_id,action,permission,reason_code,early_access_request_id,
      before_request_status,after_request_status,request_id,correlation_id,environment,outcome,error_code)
      values(target_expected_actor_id,target_expected_actor_id,'early_access.accept','early_access.accept','invitation_acceptance',prior.id,
        prior.status,case when failure is null then 'accepted' else prior.status end,target_operation_id,target_correlation_id,environment,
        case when failure is null then 'success' else 'failure' end,failure);
  end if;
  insert into private.early_access_acceptance_operations(actor_id,operation_id,signature,result) values(target_expected_actor_id,target_operation_id,signature,result);
  -- Share the historical operation registry so the unchanged role/deny writers
  -- also reject cross-kind UUID reuse, including unknown-token failure receipts.
  insert into private.site_admin_role_requests values(target_expected_actor_id,target_operation_id,jsonb_build_object('digest',signature),result);
  return result;
end;
$$;
revoke all on function private.accept_early_access_invitation(uuid,uuid,text,uuid,uuid) from public,anon,authenticated,service_role;
create function public.accept_early_access_invitation(target_expected_actor_id uuid,target_generation_id uuid,target_token text,
  target_operation_id uuid,target_correlation_id uuid)
returns jsonb language sql security definer set search_path='' as $$
  select private.accept_early_access_invitation(target_expected_actor_id,target_generation_id,target_token,target_operation_id,target_correlation_id);
$$;
revoke all on function public.accept_early_access_invitation(uuid,uuid,text,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.accept_early_access_invitation(uuid,uuid,text,uuid,uuid) to authenticated;

create function private.require_early_access_invitation_worker()
returns void language plpgsql security definer set search_path='' as $$
begin
  if current_setting('role',true) is distinct from 'service_role' or auth.uid() is not null then
    raise exception using errcode='42501',message='invitation_worker_required'; end if;
  perform set_config('response.headers','[{"Cache-Control":"private, no-store"},{"Pragma":"no-cache"}]',true);
end;
$$;
revoke all on function private.require_early_access_invitation_worker() from public,anon,authenticated,service_role;

create function public.claim_early_access_invitation_deliveries(target_worker_token uuid,target_batch_size integer default 1)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare delivery private.early_access_invitation_deliveries%rowtype; invitation private.early_access_invitations%rowtype;
  expiring uuid; result jsonb:='[]';
begin
  perform private.require_early_access_invitation_worker();
  if target_worker_token is null or target_batch_size is distinct from 1 then
    raise exception using errcode='22023',message='invitation_worker_invalid_input'; end if;
  perform pg_advisory_xact_lock(hashtextextended('site-admin-lifecycle',1502));
  for expiring in select id from private.early_access_invitations where state='current' and expires_at<=clock_timestamp()
    order by expires_at,id limit 25 loop
    perform private.expire_early_access_invitation(expiring);
  end loop;
  select d.* into delivery from private.early_access_invitation_deliveries d
    join private.early_access_invitations i on i.id=d.invitation_id
    join private.early_access_requests r on r.id=i.request_id
    where d.status in ('queued','leased','retry') and d.next_attempt_at<=clock_timestamp()
      and (d.lease_until is null or d.lease_until<=clock_timestamp())
      and i.state='current' and i.expires_at>clock_timestamp() and r.status in ('approved','invited')
      and i.account_id is not null and exists(select 1 from auth.users u where u.id=i.account_id
        and lower(u.email)=i.recipient and u.email_confirmed_at is not null and u.deleted_at is null
        and not coalesce(u.is_anonymous,false) and (u.banned_until is null or u.banned_until<=clock_timestamp()))
    order by d.next_attempt_at,d.id limit 1;
  if not found then return result; end if;
  select * into invitation from private.early_access_invitations where id=delivery.invitation_id;
  perform 1 from private.early_access_requests where id=invitation.request_id for update;
  perform 1 from private.early_access_invitations where id=invitation.id for update;
  select * into delivery from private.early_access_invitation_deliveries where id=delivery.id for update;
  if delivery.attempts>=12 or delivery.first_dispatched_at<=clock_timestamp()-interval '23 hours' then
    update private.early_access_invitation_deliveries set status='needs_review',lease_token=null,lease_until=null,last_code='retry_window_exhausted'
      where id=delivery.id;
    return result;
  end if;
  if invitation.expires_at<=clock_timestamp() then perform private.expire_early_access_invitation(invitation.id);return result;end if;
  update private.early_access_invitation_deliveries set status='leased',lease_token=target_worker_token,
    lease_until=clock_timestamp()+interval '2 minutes',attempts=attempts+1 where id=delivery.id returning * into delivery;
  return jsonb_build_array(jsonb_build_object('deliveryId',delivery.id,'binding',delivery.binding,'envelope',delivery.envelope,
    'tokenDigest',invitation.token_digest,'contentFingerprint',delivery.content_fingerprint,'idempotencyKey',delivery.idempotency_key,
    'firstDispatchedAt',delivery.first_dispatched_at));
end;
$$;
revoke all on function public.claim_early_access_invitation_deliveries(uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.claim_early_access_invitation_deliveries(uuid,integer) to service_role;

create function public.mark_early_access_invitation_dispatched(target_delivery_id uuid,target_worker_token uuid,
  target_content_fingerprint text,target_token_digest text)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare delivery private.early_access_invitation_deliveries%rowtype; invitation private.early_access_invitations%rowtype;
  prior private.early_access_requests%rowtype; as_of timestamptz; account jsonb;
begin
  perform private.require_early_access_invitation_worker();
  perform pg_advisory_xact_lock(hashtextextended('site-admin-lifecycle',1502));
  select * into delivery from private.early_access_invitation_deliveries where id=target_delivery_id;
  if not found then return null;end if;
  select * into invitation from private.early_access_invitations where id=delivery.invitation_id;
  select * into prior from private.early_access_requests where id=invitation.request_id for update;
  perform 1 from private.early_access_programs where program_key='early_access_v1' for share;
  select * into invitation from private.early_access_invitations where id=delivery.invitation_id for update;
  select * into delivery from private.early_access_invitation_deliveries where id=target_delivery_id for update;
  if delivery.status<>'leased' or delivery.lease_token is distinct from target_worker_token or delivery.lease_until<=clock_timestamp()
    or delivery.envelope is null or delivery.content_fingerprint is distinct from target_content_fingerprint
    or invitation.token_digest is distinct from target_token_digest or invitation.state<>'current'
    or invitation.expires_at<=clock_timestamp() or prior.status not in ('approved','invited')
    or prior.email<>invitation.recipient then return null;end if;
  -- The worker supplies these matching fingerprints only AFTER authenticated
  -- decryption, strict message binding and raw-token digest validation. A queued
  -- ciphertext or an admin-generated token digest alone is never grant authority.
  begin
    if delivery.first_dispatched_at<=clock_timestamp()-interval '23 hours'
      or not private.reserve_transactional_email(delivery.id) then return null;end if;
    as_of:=clock_timestamp();account:=private.early_access_invitation_account(invitation.recipient);
    if delivery.lease_until<=as_of or delivery.first_dispatched_at<=as_of-interval '23 hours' or invitation.expires_at<=as_of
      or not exists(select 1 from private.early_access_programs where program_key='early_access_v1' and configured
        and (beta_starts_at is null or beta_starts_at>as_of))
      or invitation.account_id is null or account->>'id' is distinct from invitation.account_id::text
      or not (account->>'healthy')::boolean or not (account->>'confirmed')::boolean then
      raise exception using errcode='PEI01',message='invitation_dispatch_authority_changed';
    end if;
  exception when sqlstate 'PEI01' then return null;
  end;
  update private.early_access_invitation_deliveries set first_dispatched_at=coalesce(first_dispatched_at,as_of),
    validated_at=coalesce(validated_at,as_of) where id=delivery.id returning * into delivery;
  return jsonb_build_object('deliveryId',delivery.id,'idempotencyKey',delivery.idempotency_key,
    'bindingFingerprint',delivery.content_fingerprint,'firstDispatchedAt',delivery.first_dispatched_at);
end;
$$;
revoke all on function public.mark_early_access_invitation_dispatched(uuid,uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.mark_early_access_invitation_dispatched(uuid,uuid,text,text) to service_role;

create function public.settle_early_access_invitation_delivery(target_delivery_id uuid,target_worker_token uuid,target_outcome text,
  target_code text default null,target_receipt_id uuid default null)
returns boolean language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare delivery private.early_access_invitation_deliveries%rowtype; invitation private.early_access_invitations%rowtype;
  prior private.early_access_requests%rowtype; as_of timestamptz;
begin
  perform private.require_early_access_invitation_worker();
  if target_outcome is null or target_outcome not in ('accepted','retryable','uncertain','needs_review')
    or (target_code is not null and (length(target_code)>80 or target_code !~ '^[a-z0-9_]+$')) then
    raise exception using errcode='22023',message='invitation_delivery_invalid_outcome'; end if;
  perform pg_advisory_xact_lock(hashtextextended('site-admin-lifecycle',1502));
  select * into delivery from private.early_access_invitation_deliveries where id=target_delivery_id;
  if not found then return false;end if;
  select * into invitation from private.early_access_invitations where id=delivery.invitation_id;
  select * into prior from private.early_access_requests where id=invitation.request_id for update;
  select * into invitation from private.early_access_invitations where id=delivery.invitation_id for update;
  select * into delivery from private.early_access_invitation_deliveries where id=target_delivery_id for update;
  as_of:=clock_timestamp();
  if delivery.status<>'leased' or delivery.lease_token is distinct from target_worker_token or delivery.lease_until<=as_of then return false;end if;
  if target_outcome='accepted' then
    if delivery.first_dispatched_at is null or delivery.validated_at is null or target_receipt_id is null or target_code is not null then
      raise exception using errcode='22023',message='invitation_delivery_invalid_receipt';end if;
    update private.early_access_invitation_deliveries set status='delivered',envelope=null,provider_receipt_id=target_receipt_id,
      completed_at=as_of,lease_token=null,lease_until=null,last_code=null where id=delivery.id;
    -- Record truthful provider acceptance even if expiry crossed while HTTP was
    -- in flight. It cannot restore a superseded/revoked/accepted request.
    if invitation.state='current' and prior.status in ('approved','invited') then
      update private.early_access_requests set status='invited',invitation_sent_at=as_of,revision=revision+1,updated_at=as_of where id=prior.id;
      perform private.expire_early_access_invitation(invitation.id);
    end if;
  else
    if target_receipt_id is not null then raise exception using errcode='22023',message='invitation_delivery_invalid_receipt';end if;
    update private.early_access_invitation_deliveries set status=case when target_outcome='needs_review' or attempts>=12
        or first_dispatched_at<=as_of-interval '23 hours' then 'needs_review' else 'retry' end,
      next_attempt_at=as_of+interval '5 minutes',lease_token=null,lease_until=null,last_code=target_code where id=delivery.id;
  end if;
  return true;
end;
$$;
revoke all on function public.settle_early_access_invitation_delivery(uuid,uuid,text,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.settle_early_access_invitation_delivery(uuid,uuid,text,text,uuid) to service_role;

comment on table private.early_access_invitations is 'Seven-day application capabilities; hashes only, never native Auth session tokens. Unbound new accounts require a separate provenance-safe native Auth bootstrap.';
comment on table private.early_access_invitation_deliveries is 'Frozen AES-GCM encrypted mail, separate runtime key; only validated worker dispatch makes acceptance ready. No plaintext invite payloads.';
comment on function public.site_admin_write_early_access_invitation(uuid,text,uuid,bigint,uuid,uuid,jsonb,text,text,text,jsonb) is 'Original authenticated admin bearer and fresh MFA only; atomic immutable issuance/resend/revoke, no Auth or billing operations.';
