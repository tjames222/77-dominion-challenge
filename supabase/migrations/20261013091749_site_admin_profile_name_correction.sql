-- FOU-1502: one canonical, name-only correction for another eligible account.
-- No Auth metadata, avatar, email, access, billing or existing timestamp rewrite.
set local lock_timeout = '5s';
set local statement_timeout = '30s';
select pg_advisory_xact_lock_shared(hashtextextended('retired-community-deletion',0));
-- EXCLUSIVE still permits ordinary SELECT, but unlike SHARE ROW EXCLUSIVE it
-- excludes SELECT FOR UPDATE. Otherwise a row-locking member could wait for
-- RowExclusive while the backfill FK check waits for that same member's row.
lock table public.profiles in exclusive mode;
lock table private.site_admin_audit in access exclusive mode;
-- Estimates are not row proof. Enforce the bounded release envelope while writes
-- are frozen; the separate metadata-only preflight also bounds physical size.
do $$ begin
  if exists(select 1 from public.profiles offset 100000 limit 1)
    or exists(select 1 from private.site_admin_audit offset 100000 limit 1) then
    raise exception using errcode='54000',message='admin_profile_migration_size_limit';
  end if;
end $$;

create table private.site_admin_profile_name_versions (
  user_id uuid primary key references public.profiles(user_id) on delete cascade,
  version uuid not null default gen_random_uuid()
);
alter table private.site_admin_profile_name_versions enable row level security;
revoke all on private.site_admin_profile_name_versions from public,anon,authenticated,service_role;
insert into private.site_admin_profile_name_versions(user_id) select user_id from public.profiles;

create function private.sync_site_admin_profile_name_version()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='INSERT' then
    insert into private.site_admin_profile_name_versions(user_id,version) values(new.user_id,gen_random_uuid());
  elsif convert_to(old.name,'UTF8') is distinct from convert_to(new.name,'UTF8') then
    update private.site_admin_profile_name_versions set version=gen_random_uuid() where user_id=new.user_id;
    if not found then raise exception using errcode='55000',message='admin_profile_version_unavailable'; end if;
  end if;
  return new;
end;
$$;
revoke all on function private.sync_site_admin_profile_name_version() from public,anon,authenticated,service_role;
create trigger sync_site_admin_profile_name_version after insert or update of name on public.profiles
  for each row execute function private.sync_site_admin_profile_name_version();

create function private.site_admin_profile_name_valid(target_name text)
returns boolean language sql immutable security invoker set search_path='' as $$
  -- CASE, not AND evaluation order, bounds all Unicode work on legacy text.
  select case when target_name is null or octet_length(target_name) not between 1 and 480 then false
    else char_length(target_name) between 1 and 120
      and convert_to(target_name,'UTF8')=convert_to(btrim(target_name,
        U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'),'UTF8')
      and not exists(select 1 from generate_series(1,char_length(target_name)) n
        where ascii(substr(target_name,n,1)) between 0 and 31
          or ascii(substr(target_name,n,1)) between 127 and 159
          or ascii(substr(target_name,n,1)) in (8232,8233)) end;
$$;
revoke all on function private.site_admin_profile_name_valid(text) from public,anon,authenticated,service_role;

-- One fresh SQL observation, not sequential eligibility checks advertised as a
-- frozen session/deletion state. Later overlapping provider/intake changes may
-- occur; every change committed before this snapshot is observed. JWT claims
-- are request identity only; canonical role/permissions/session/factor are live.
create function private.site_admin_profile_name_snapshot(target_actor uuid,target_session uuid,
  target_user uuid,require_recent boolean)
returns table(identity_ready boolean,authority_ready boolean,target_reason text,
  profile_name text,profile_version uuid,profile_updated_at timestamptz,observed_at timestamptz)
language sql volatile security definer set search_path='' as $$
  with tick as materialized(select clock_timestamp() as at),
  claims as materialized(select auth.jwt() as jwt,auth.uid() as uid),
  origin as materialized(select coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb->>'origin' as value)
  select
    coalesce(claims.uid=target_actor and claims.jwt->>'role'='authenticated'
      and claims.jwt->>'session_id'=target_session::text
      and s.id is not null and s.user_id=target_actor and (s.not_after is null or s.not_after>tick.at)
      and actor.deleted_at is null and not coalesce(actor.is_anonymous,false)
      and actor.email_confirmed_at is not null and (actor.banned_until is null or actor.banned_until<=tick.at),false),
    coalesce(claims.jwt->>'aal'='aal2' and s.aal::text='aal2'
      and f.user_id=target_actor and f.factor_type::text='totp' and f.status::text='verified'
      and exists(select 1 from private.site_admin_configuration c where c.singleton and origin.value=any(c.allowed_origins))
      and not exists(select 1 from private.site_admin_session_blocks b where b.session_id=target_session)
      and exists(select 1 from private.site_user_roles r join private.site_role_permissions p on p.role_key=r.role_key
        where r.user_id=target_actor and p.permission_key='users.read')
      and exists(select 1 from private.site_user_roles r join private.site_role_permissions p on p.role_key=r.role_key
        where r.user_id=target_actor and p.permission_key='users.manage')
      and (not require_recent or (
        exists(select 1 from auth.mfa_amr_claims a where a.session_id=target_session and a.authentication_method='totp'
          and a.updated_at between tick.at-interval '10 minutes' and tick.at+interval '30 seconds')
        and exists(select 1 from jsonb_array_elements(case when jsonb_typeof(claims.jwt->'amr')='array' then claims.jwt->'amr' else '[]'::jsonb end) a
          where a->>'method'='totp' and case when a->>'timestamp' ~ '^[0-9]{1,12}$' then (a->>'timestamp')::bigint else 0 end
            between extract(epoch from tick.at-interval '10 minutes') and extract(epoch from tick.at+interval '30 seconds')))),false),
    case when target_user=target_actor then 'self_action_forbidden'
      when u.id is null or u.deleted_at is not null or coalesce(u.is_anonymous,false) or u.email_confirmed_at is null
        or (u.banned_until is not null and u.banned_until>tick.at)
        or exists(select 1 from public.account_lifecycle_requests l where l.user_id=target_user
          and l.request_type='account_deletion' and l.status in ('requested','in_progress'))
        or exists(select 1 from private.retired_community_dr_quarantined_users q where q.user_id=target_user)
        or exists(select 1 from private.retired_community_deletion_batches b where b.reason='account_erasure'
          and b.subject_user_id=target_user and b.sealed and not exists(
            select 1 from private.retired_community_deletion_ledger l where l.batch_id=b.id and l.event_type in ('cancelled','executed')))
        then 'target_unavailable'
      when p.user_id is null then 'missing_profile'
      when v.user_id is null then 'missing_version'
      when not private.site_admin_profile_name_valid(p.name) then 'unsupported_legacy_name'
      else null end,
    case when private.site_admin_profile_name_valid(p.name) then p.name else null end,
    v.version,p.updated_at,tick.at
  from tick cross join claims cross join origin
  left join auth.users actor on actor.id=target_actor
  left join auth.sessions s on s.id=target_session and s.user_id=actor.id
  left join auth.mfa_factors f on f.id=s.factor_id
  left join auth.users u on u.id=target_user
  left join public.profiles p on p.user_id=u.id
  left join private.site_admin_profile_name_versions v on v.user_id=p.user_id;
$$;
revoke all on function private.site_admin_profile_name_snapshot(uuid,uuid,uuid,boolean) from public,anon,authenticated,service_role;

create function public.site_admin_get_profile_name(target_expected_actor_id uuid,target_user_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare sid uuid; snapshot record;
begin
  sid:=private.require_site_admin('users.manage',target_expected_actor_id,false);
  if private.require_site_admin('users.read',target_expected_actor_id,false) is distinct from sid then
    raise exception using errcode='PT401',message='admin_authentication_required'; end if;
  if target_user_id is null then raise exception using errcode='22023',message='admin_invalid_input'; end if;
  select * into snapshot from private.site_admin_profile_name_snapshot(target_expected_actor_id,sid,target_user_id,false);
  if not snapshot.identity_ready then raise exception using errcode='PT401',message='admin_authentication_required'; end if;
  if not snapshot.authority_ready then raise exception using errcode='PT403',message='admin_permission_or_step_up_required'; end if;
  return jsonb_build_object('schemaVersion',1,'actorId',target_expected_actor_id,'observedAt',snapshot.observed_at,
    'targetUserId',target_user_id,'profile',jsonb_build_object('state',case when snapshot.target_reason is null then 'editable' else 'unavailable' end,
      'reason',snapshot.target_reason,'name',case when snapshot.target_reason is null then snapshot.profile_name else null end,
      'version',case when snapshot.target_reason is null then snapshot.profile_version else null end,
      'updatedAt',case when snapshot.target_reason is null then snapshot.profile_updated_at else null end));
end;
$$;
revoke all on function public.site_admin_get_profile_name(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.site_admin_get_profile_name(uuid,uuid) to authenticated;

alter table private.site_admin_audit
  add column before_profile_name_version uuid,
  add column after_profile_name_version uuid,
  add column profile_name_changed boolean;
-- The original five branches below are unchanged; their only additional rule
-- is that all new name metadata is NULL. No original event is reclassified.
alter table private.site_admin_audit drop constraint site_admin_audit_typed_action_check,
  add constraint site_admin_audit_typed_action_check check (
    ((
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
    ) and before_profile_name_version is null and after_profile_name_version is null and profile_name_changed is null)
    or
    (action='users.display_name.correct' and actor_id is not null and target_user_id is not null
      and permission='users.manage' and reason_code='profile_name_correction'
      and before_role is null and after_role is null and early_access_request_id is null
      and before_request_status is null and after_request_status is null
      and ((outcome='success' and actor_id<>target_user_id and error_code is null and before_profile_name_version is not null
        and after_profile_name_version is not null and profile_name_changed is not null
        and profile_name_changed=(before_profile_name_version<>after_profile_name_version))
        or (outcome='failure' and error_code is not null and error_code in
          ('invalid_input','revision_conflict','self_action_forbidden','target_unavailable','profile_unavailable','unsupported_legacy_name')
          and before_profile_name_version is null and after_profile_name_version is null and profile_name_changed is null)))
  );

create function public.site_admin_correct_profile_name(target_expected_actor_id uuid,target_user_id uuid,
  target_expected_version uuid,target_name text,target_operation_id uuid,target_correlation_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' set lock_timeout='5s' as $$
declare sid uuid; snapshot record; operation private.site_admin_role_requests%rowtype;
  signature jsonb; result jsonb; failure text; environment text; next_version uuid; changed boolean;
  deadline timestamptz:=clock_timestamp()+interval '5 seconds'; remaining_ms integer; quota_as_of timestamptz;
begin
  sid:=private.require_site_admin('users.manage',target_expected_actor_id,true);
  if private.require_site_admin('users.read',target_expected_actor_id,false) is distinct from sid then
    raise exception using errcode='PT401',message='admin_authentication_required'; end if;
  if target_user_id is null or target_expected_version is null or target_operation_id is null or target_correlation_id is null
    or target_name is null or octet_length(target_name)>480 then
    raise exception using errcode='22023',message='admin_invalid_input'; end if;
  signature:=jsonb_build_object('digest',encode(sha256(convert_to(jsonb_build_array('users.display_name.correct:v1',
    target_expected_actor_id,target_user_id,target_expected_version,target_operation_id,target_correlation_id,target_name)::text,'UTF8')),'hex'));
  -- Same order as erasure/activation and invitation acceptance. Missing target
  -- Auth rows are not an error here: exact historical replay survives deletion.
  remaining_ms:=floor(extract(epoch from(deadline-clock_timestamp()))*1000);
  if remaining_ms<=0 then raise exception using errcode='55P03',message='admin_write_busy'; end if;
  perform set_config('lock_timeout',remaining_ms::text||'ms',true);
  perform pg_advisory_xact_lock_shared(hashtextextended('retired-community-deletion',0));
  remaining_ms:=floor(extract(epoch from(deadline-clock_timestamp()))*1000);
  if remaining_ms<=0 then raise exception using errcode='55P03',message='admin_write_busy'; end if;
  perform set_config('lock_timeout',remaining_ms::text||'ms',true);
  perform 1 from auth.users where id in(target_expected_actor_id,target_user_id) order by id for key share;
  remaining_ms:=floor(extract(epoch from(deadline-clock_timestamp()))*1000);
  if remaining_ms<=0 then raise exception using errcode='55P03',message='admin_write_busy'; end if;
  perform set_config('lock_timeout',remaining_ms::text||'ms',true);
  perform pg_advisory_xact_lock(hashtextextended('site-admin-lifecycle',1502));
  perform private.require_site_admin('users.manage',target_expected_actor_id,true);
  perform private.require_site_admin('users.read',target_expected_actor_id,false);
  perform private.require_member_current_session(target_expected_actor_id,sid);
  select * into snapshot from private.site_admin_profile_name_snapshot(target_expected_actor_id,sid,target_user_id,true);
  if not snapshot.identity_ready then raise exception using errcode='PT401',message='admin_authentication_required'; end if;
  if not snapshot.authority_ready then raise exception using errcode='PT403',message='admin_permission_or_step_up_required'; end if;
  select * into operation from private.site_admin_role_requests where actor_id=target_expected_actor_id and request_id=target_operation_id;
  if operation.request_id is not null then
    if operation.signature is distinct from signature then raise exception using errcode='22023',message='admin_idempotency_conflict'; end if;
    return operation.result;
  end if;
  if exists(select 1 from private.site_admin_audit where actor_id=target_expected_actor_id and request_id=target_operation_id)
    or exists(select 1 from private.early_access_acceptance_operations where actor_id=target_expected_actor_id and operation_id=target_operation_id) then
    raise exception using errcode='22023',message='admin_idempotency_conflict'; end if;
  result:=jsonb_build_object('schemaVersion',1,'actorId',target_expected_actor_id,'targetUserId',target_user_id,
    'operationId',target_operation_id,'correlationId',target_correlation_id);
  quota_as_of:=clock_timestamp();
  if (select count(*) from(select 1 from private.site_admin_audit where actor_id=target_expected_actor_id
      and occurred_at>quota_as_of-interval '1 minute' order by occurred_at desc limit 20) q)>=20
    or (select count(*) from(select 1 from private.site_admin_audit where actor_id=target_expected_actor_id
      and occurred_at>quota_as_of-interval '1 hour' order by occurred_at desc limit 100) q)>=100 then
    return result||jsonb_build_object('ok',false,'error','rate_limited'); end if;
  remaining_ms:=floor(extract(epoch from(deadline-clock_timestamp()))*1000);
  if remaining_ms<=0 then raise exception using errcode='55P03',message='admin_write_busy'; end if;
  perform set_config('lock_timeout',remaining_ms::text||'ms',true);
  perform 1 from public.profiles where user_id=target_user_id for update;
  remaining_ms:=floor(extract(epoch from(deadline-clock_timestamp()))*1000);
  if remaining_ms<=0 then raise exception using errcode='55P03',message='admin_write_busy'; end if;
  perform set_config('lock_timeout',remaining_ms::text||'ms',true);
  perform 1 from private.site_admin_profile_name_versions where user_id=target_user_id for update;
  -- Canonical guards remain unchanged and are supplemented, not replaced, by
  -- the one consolidated fresh snapshot after ALL profile/version waits.
  perform private.require_site_admin('users.manage',target_expected_actor_id,true);
  perform private.require_site_admin('users.read',target_expected_actor_id,false);
  perform private.require_member_current_session(target_expected_actor_id,sid);
  select * into snapshot from private.site_admin_profile_name_snapshot(target_expected_actor_id,sid,target_user_id,true);
  if not snapshot.identity_ready then raise exception using errcode='PT401',message='admin_authentication_required'; end if;
  if not snapshot.authority_ready then raise exception using errcode='PT403',message='admin_permission_or_step_up_required'; end if;
  if not private.site_admin_profile_name_valid(target_name) then failure:='invalid_input';
  elsif snapshot.target_reason in ('missing_profile','missing_version') then failure:='profile_unavailable';
  elsif snapshot.target_reason is not null then failure:=snapshot.target_reason;
  elsif snapshot.profile_version is distinct from target_expected_version then failure:='revision_conflict'; end if;
  if failure is null then
    changed:=convert_to(snapshot.profile_name,'UTF8')<>convert_to(target_name,'UTF8');
    if changed then update public.profiles set name=target_name where user_id=target_user_id; end if;
    select version into strict next_version from private.site_admin_profile_name_versions where user_id=target_user_id;
    result:=result||jsonb_build_object('ok',true,'changed',changed,'version',next_version);
  else result:=result||jsonb_build_object('ok',false,'error',failure); end if;
  select c.environment into strict environment from private.site_admin_configuration c where singleton;
  insert into private.site_admin_audit(actor_id,target_user_id,action,permission,reason_code,request_id,correlation_id,
    environment,outcome,error_code,before_profile_name_version,after_profile_name_version,profile_name_changed)
    values(target_expected_actor_id,target_user_id,'users.display_name.correct','users.manage','profile_name_correction',
      target_operation_id,target_correlation_id,environment,case when failure is null then 'success' else 'failure' end,failure,
      case when failure is null then snapshot.profile_version else null end,next_version,changed);
  insert into private.site_admin_role_requests values(target_expected_actor_id,target_operation_id,signature,result);
  return result;
end;
$$;
revoke all on function public.site_admin_correct_profile_name(uuid,uuid,uuid,text,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.site_admin_correct_profile_name(uuid,uuid,uuid,text,uuid,uuid) to authenticated;

create or replace function private.site_admin_audit_payload(target_sequence bigint)
returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('id',a.sequence_id::text,'actorId',a.actor_id,'targetUserId',a.target_user_id,
    'action',a.action,'permission',a.permission,'reasonCode',a.reason_code,'beforeRole',a.before_role,'afterRole',a.after_role,
    'requestId',a.request_id,'correlationId',a.correlation_id,'environment',a.environment,
    'occurredAt',a.occurred_at,'outcome',a.outcome,'errorCode',a.error_code,
    'beforeProfileNameVersion',a.before_profile_name_version,'afterProfileNameVersion',a.after_profile_name_version,
    'profileNameChanged',a.profile_name_changed)
  from private.site_admin_audit a where a.sequence_id=target_sequence;
$$;
revoke all on function private.site_admin_audit_payload(bigint) from public,anon,authenticated,service_role;

create or replace function public.site_admin_list_audit(target_expected_actor_id uuid,target_limit integer default 25,
  target_user_id uuid default null,target_action text default 'all',target_outcome text default 'all',target_cursor jsonb default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare after_sequence bigint; query_key text; ids bigint[]; items jsonb; next_cursor jsonb;
begin
  perform private.require_site_admin('audit.read',target_expected_actor_id,false);
  if target_limit is null or target_limit not between 1 and 50 or target_action is null or target_action not in ('all','roles.assign','roles.bootstrap','users.display_name.correct')
    or target_outcome is null or target_outcome not in ('all','success','failure') then
    raise exception using errcode='22023',message='admin_invalid_input'; end if;
  query_key:=encode(sha256(convert_to(jsonb_build_array(target_user_id,target_action,target_outcome)::text,'UTF8')),'hex');
  if target_cursor is not null then
    begin
      if pg_column_size(target_cursor)>1024 or jsonb_typeof(target_cursor)<>'object' or (select count(*) from jsonb_object_keys(target_cursor))<>4
        or target_cursor->'v' is distinct from '1'::jsonb or target_cursor->>'actorId' is distinct from target_expected_actor_id::text
        or target_cursor->>'query' is distinct from query_key or jsonb_typeof(target_cursor->'id') is distinct from 'string'
        or target_cursor->>'id' !~ '^[1-9][0-9]{0,18}$' then raise exception 'invalid'; end if;
      after_sequence:=(target_cursor->>'id')::bigint;
    exception when others then raise exception using errcode='22023',message='admin_invalid_cursor'; end;
  end if;
  select array_agg(q.sequence_id order by q.sequence_id desc) into ids from (
    select a.sequence_id from private.site_admin_audit a
    where (site_admin_list_audit.target_user_id is null or a.target_user_id=site_admin_list_audit.target_user_id)
      and (target_action='all' or a.action=target_action) and (target_outcome='all' or a.outcome=target_outcome)
      and (after_sequence is null or a.sequence_id<after_sequence)
    order by a.sequence_id desc limit target_limit+1
  ) q;
  select coalesce(jsonb_agg(private.site_admin_audit_payload(v.id) order by v.ordinality),'[]') into items
    from unnest(ids[1:target_limit]) with ordinality v(id,ordinality);
  if cardinality(ids)>target_limit then next_cursor:=jsonb_build_object('v',1,'actorId',target_expected_actor_id,
    'query',query_key,'id',ids[target_limit]::text); end if;
  return jsonb_build_object('schemaVersion',1,'actorId',target_expected_actor_id,'observedAt',statement_timestamp(),
    'items',items,'nextCursor',next_cursor);
end;
$$;
revoke all on function public.site_admin_list_audit(uuid,integer,uuid,text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.site_admin_list_audit(uuid,integer,uuid,text,text,jsonb) to authenticated;
