set local lock_timeout = '5s';

-- FOU-1742 partial foundation: review and deny only. No invitation, Auth account,
-- membership, testing entitlement, or billing operation is performed here.
alter table private.early_access_requests
  add column revision bigint not null default 0 check(revision>=0),
  add column invitation_sent_at timestamptz,
  add column invitation_expires_at timestamptz,
  add column accepted_at timestamptz;
-- Existing status is not evidence of delivery or acceptance. Do not backfill
-- these nullable timestamps, including for legacy non-pending requests.
create index early_access_admin_created_id_idx on private.early_access_requests(created_at,id);
create index early_access_admin_email_prefix_idx on private.early_access_requests(email text_pattern_ops);
create index early_access_admin_name_prefix_idx on private.early_access_requests(lower(name) text_pattern_ops);

alter table private.site_admin_audit
  add column early_access_request_id uuid,
  add column before_request_status text,
  add column after_request_status text;
-- Replace only the four enumerations with a typed union. The role-event branch
-- retains every previous allowlist; the immutable trigger and rows stay intact.
alter table private.site_admin_audit
  drop constraint site_admin_audit_action_check,
  drop constraint site_admin_audit_permission_check,
  drop constraint site_admin_audit_reason_code_check,
  drop constraint site_admin_audit_error_code_check,
  add constraint site_admin_audit_typed_action_check check (
    (action in ('roles.bootstrap','roles.assign') and permission='roles.manage'
      and reason_code in ('initial_admin_bootstrap','staff_access_review','approved_role_change','recovery_plan')
      and (error_code is null or error_code in ('invalid_input','revision_conflict','self_action_forbidden','target_unavailable','target_mfa_required','rate_limited','final_admin'))
      and early_access_request_id is null and before_request_status is null and after_request_status is null)
    or
    (action='early_access.deny' and permission='operations.manage' and reason_code='early_access_review'
      and before_role is null and after_role is null and target_user_id is null
      and early_access_request_id is not null
      and (before_request_status is null or before_request_status in ('pending','approved','invited','accepted','denied','expired','revoked'))
      and after_request_status is not distinct from case when outcome='success' then 'denied' else before_request_status end
      and ((outcome='success' and before_request_status is not distinct from 'pending' and error_code is null)
        or (outcome='failure' and error_code is not null and error_code in ('invalid_input','revision_conflict','target_unavailable','invalid_state'))))
  );
create index site_admin_audit_early_access_sequence_idx on private.site_admin_audit(early_access_request_id,sequence_id desc)
  where early_access_request_id is not null;

-- The existing registry has only generic actor/request/signature/result fields.
-- Keep its historical name and rows; reuse it so the unchanged role writer's
-- digest check rejects cross-kind UUID reuse in either direction, before writes.
comment on table private.site_admin_role_requests is
  'Shared private admin operation-idempotency registry; historical role_requests name. Digests are operation-domain-separated; not an authorization source.';
-- Existing intake column-level grants cannot write any of the new fields.

create function private.site_admin_early_access_payload(target_request_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('id',r.id,'name',r.name,'email',r.email,'status',r.status,
    'revision',r.revision::text,'requestedAt',r.created_at,'updatedAt',r.updated_at,
    'invitationSentAt',r.invitation_sent_at,'invitationExpiresAt',r.invitation_expires_at,'acceptedAt',r.accepted_at,
    'account',jsonb_build_object('status',case when a.count=0 then 'none' when a.count>1 then 'ambiguous'
      when a.deleted then 'deleted' when a.anonymous then 'anonymous' when a.suspended then 'suspended'
      when a.confirmed then 'confirmed' else 'unconfirmed' end,
      'userId',case when a.count=1 then a.ids[1] else null end))
  from private.early_access_requests r
  -- The intake's historical user_id is not proof of today's account/email match.
  -- Read at most two exact canonical Auth matches; ambiguous matches fail closed.
  cross join lateral (
    select count(*) count,array_agg(u.id) ids,bool_or(u.deleted_at is not null) deleted,
      bool_or(coalesce(u.is_anonymous,false)) anonymous,bool_or(coalesce(u.banned_until>statement_timestamp(),false)) suspended,
      bool_or(u.email_confirmed_at is not null) confirmed
    from (select u.id,u.deleted_at,u.is_anonymous,u.banned_until,u.email_confirmed_at
      from private.site_admin_user_directory d join auth.users u on u.id=d.user_id
      where d.email=r.email and lower(u.email)=r.email order by u.id limit 2) u
  ) a where r.id=target_request_id;
$$;
revoke all on function private.site_admin_early_access_payload(uuid) from public,anon,authenticated,service_role;

create function public.site_admin_get_early_access_request(target_expected_actor_id uuid,target_request_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare item jsonb;
begin
  perform private.require_site_admin('operations.read',target_expected_actor_id,false);
  if target_request_id is null then raise exception using errcode='22023',message='admin_invalid_input'; end if;
  item:=private.site_admin_early_access_payload(target_request_id);
  if item is null then raise exception using errcode='PT404',message='admin_record_not_found'; end if;
  return jsonb_build_object('schemaVersion',1,'actorId',target_expected_actor_id,'observedAt',statement_timestamp(),'item',item);
end;
$$;
revoke all on function public.site_admin_get_early_access_request(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.site_admin_get_early_access_request(uuid,uuid) to authenticated;

create function public.site_admin_list_early_access_requests(target_expected_actor_id uuid,target_limit integer default 25,
  target_search text default '',target_status text default 'all',target_sort text default 'newest',target_cursor jsonb default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare needle text; pattern text; query_key text; after_id uuid; after_stamp timestamptz;
  ids uuid[]; items jsonb; next_cursor jsonb; last_id uuid; last_stamp timestamptz; direction text; comparator text;
begin
  perform private.require_site_admin('operations.read',target_expected_actor_id,false);
  if target_limit is null or target_limit not between 1 and 50 or target_search is null or char_length(target_search)>80
    or target_search ~ '[[:cntrl:]]' or target_status is null or target_status not in ('all','pending','approved','invited','accepted','denied','expired','revoked')
    or target_sort is null or target_sort not in ('newest','oldest') then
    raise exception using errcode='22023',message='admin_invalid_input'; end if;
  needle:=lower(btrim(target_search));
  pattern:=replace(replace(replace(needle,E'\\',E'\\\\'),'%',E'\\%'),'_',E'\\_')||'%';
  query_key:=encode(sha256(convert_to(jsonb_build_array('early-access',needle,target_status,target_sort)::text,'UTF8')),'hex');
  if target_cursor is not null then
    begin
      if pg_column_size(target_cursor)>1024 or jsonb_typeof(target_cursor)<>'object' or (select count(*) from jsonb_object_keys(target_cursor))<>5
        or target_cursor->'v' is distinct from '1'::jsonb or target_cursor->>'actorId' is distinct from target_expected_actor_id::text
        or target_cursor->>'query' is distinct from query_key or jsonb_typeof(target_cursor->'id') is distinct from 'string'
        or jsonb_typeof(target_cursor->'stamp') is distinct from 'string' then raise exception 'invalid'; end if;
      after_id:=(target_cursor->>'id')::uuid;after_stamp:=(target_cursor->>'stamp')::timestamptz;
      if after_id is null or after_stamp is null or not isfinite(after_stamp) then raise exception 'invalid'; end if;
    exception when others then raise exception using errcode='22023',message='admin_invalid_cursor'; end;
  end if;
  direction:=case when target_sort='newest' then 'desc' else 'asc' end;
  comparator:=case when target_sort='newest' then '<' else '>' end;
  execute format($queue_query$
    select array_agg(q.id order by q.created_at %1$s,q.id %1$s) from (
      select r.id,r.created_at from private.early_access_requests r
      where ($1='' or r.id in (
        select e.id from private.early_access_requests e where e.email like $2 escape E'\\'
        union select n.id from private.early_access_requests n where lower(n.name) like $2 escape E'\\'))
        and ($3='all' or r.status=$3)
        and ($4 is null or (r.created_at,r.id) %2$s ($4,$5))
      order by r.created_at %1$s,r.id %1$s limit $6
    ) q$queue_query$,direction,comparator)
    into ids using needle,pattern,target_status,after_stamp,after_id,target_limit+1;
  select coalesce(jsonb_agg(private.site_admin_early_access_payload(v.id) order by v.ordinality),'[]') into items
    from unnest(ids[1:target_limit]) with ordinality v(id,ordinality);
  if cardinality(ids)>target_limit then
    last_id:=ids[target_limit];select created_at into last_stamp from private.early_access_requests where id=last_id;
    next_cursor:=jsonb_build_object('v',1,'actorId',target_expected_actor_id,'query',query_key,'stamp',last_stamp,'id',last_id);
  end if;
  return jsonb_build_object('schemaVersion',1,'actorId',target_expected_actor_id,'observedAt',statement_timestamp(),
    'items',items,'nextCursor',next_cursor);
end;
$$;
revoke all on function public.site_admin_list_early_access_requests(uuid,integer,text,text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.site_admin_list_early_access_requests(uuid,integer,text,text,text,jsonb) to authenticated;

create function public.site_admin_list_early_access_history(target_expected_actor_id uuid,target_request_id uuid,
  target_limit integer default 25,target_cursor jsonb default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare after_sequence bigint; query_key text; ids bigint[]; items jsonb; next_cursor jsonb;
begin
  perform private.require_site_admin('operations.read',target_expected_actor_id,false);
  if target_request_id is null or target_limit is null or target_limit not between 1 and 50 then
    raise exception using errcode='22023',message='admin_invalid_input'; end if;
  query_key:=encode(sha256(convert_to(jsonb_build_array('early-access-history',target_request_id)::text,'UTF8')),'hex');
  if target_cursor is not null then
    begin
      if pg_column_size(target_cursor)>1024 or jsonb_typeof(target_cursor)<>'object' or (select count(*) from jsonb_object_keys(target_cursor))<>4
        or target_cursor->'v' is distinct from '1'::jsonb or target_cursor->>'actorId' is distinct from target_expected_actor_id::text
        or target_cursor->>'query' is distinct from query_key or jsonb_typeof(target_cursor->'id') is distinct from 'string'
        or (target_cursor->>'id') !~ '^[1-9][0-9]{0,18}$' then raise exception 'invalid'; end if;
      after_sequence:=(target_cursor->>'id')::bigint;
    exception when others then raise exception using errcode='22023',message='admin_invalid_cursor'; end;
  end if;
  if not exists(select 1 from private.early_access_requests where id=target_request_id) then
    raise exception using errcode='PT404',message='admin_record_not_found'; end if;
  select array_agg(q.sequence_id order by q.sequence_id desc) into ids from (
    select sequence_id from private.site_admin_audit where early_access_request_id=target_request_id
      and (after_sequence is null or sequence_id<after_sequence) order by sequence_id desc limit target_limit+1
  ) q;
  select coalesce(jsonb_agg(jsonb_build_object('id',a.sequence_id::text,'actorId',a.actor_id,
    'requestId',a.early_access_request_id,'action',a.action,'permission',a.permission,'reasonCode',a.reason_code,
    'beforeStatus',a.before_request_status,'afterStatus',a.after_request_status,'operationId',a.request_id,
    'correlationId',a.correlation_id,'environment',a.environment,'occurredAt',a.occurred_at,'outcome',a.outcome,'errorCode',a.error_code)
    order by v.ordinality),'[]') into items from unnest(ids[1:target_limit]) with ordinality v(id,ordinality)
      join private.site_admin_audit a on a.sequence_id=v.id;
  if cardinality(ids)>target_limit then
    next_cursor:=jsonb_build_object('v',1,'actorId',target_expected_actor_id,'query',query_key,'id',ids[target_limit]::text);
  end if;
  return jsonb_build_object('schemaVersion',1,'actorId',target_expected_actor_id,'observedAt',statement_timestamp(),
    'items',items,'nextCursor',next_cursor);
end;
$$;
revoke all on function public.site_admin_list_early_access_history(uuid,uuid,integer,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.site_admin_list_early_access_history(uuid,uuid,integer,jsonb) to authenticated;

create function public.site_admin_deny_early_access_request(target_expected_actor_id uuid,target_request_id uuid,
  target_expected_revision bigint,target_operation_id uuid,target_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare prior private.early_access_requests%rowtype; operation private.site_admin_role_requests%rowtype;
  signature jsonb; result jsonb; failure text; environment text;
begin
  perform private.require_site_admin('operations.manage',target_expected_actor_id,true);
  -- Share the role-management lock: recheck authority and the cross-operation
  -- budget after waiting; concurrent role changes cannot race this transition.
  perform pg_advisory_xact_lock(hashtextextended('site-admin-lifecycle',1502));
  perform private.require_site_admin('operations.manage',target_expected_actor_id,true);
  if target_request_id is null or target_operation_id is null or target_correlation_id is null then
    raise exception using errcode='22023',message='admin_request_identity_required'; end if;
  signature:=jsonb_build_object('digest',encode(sha256(convert_to(jsonb_build_array('early_access.deny:v1',
    target_request_id,target_expected_revision,target_correlation_id)::text,'UTF8')),'hex'));
  select * into operation from private.site_admin_role_requests
    where actor_id=target_expected_actor_id and request_id=target_operation_id;
  if operation.request_id is not null then
    if operation.signature is distinct from signature then raise exception using errcode='22023',message='admin_idempotency_conflict'; end if;
    return operation.result;
  end if;
  if exists(select 1 from private.site_admin_audit where actor_id=target_expected_actor_id and request_id=target_operation_id) then
    raise exception using errcode='22023',message='admin_idempotency_conflict'; end if;
  if (select count(*) from private.site_admin_audit where actor_id=target_expected_actor_id and occurred_at>clock_timestamp()-interval '1 minute')>=20
    or (select count(*) from private.site_admin_audit where actor_id=target_expected_actor_id and occurred_at>clock_timestamp()-interval '1 hour')>=100 then
    return jsonb_build_object('ok',false,'errorCode','rate_limited'); end if;
  select c.environment into environment from private.site_admin_configuration c where singleton;
  select * into prior from private.early_access_requests where id=target_request_id for update;
  if target_expected_revision is null or target_expected_revision<0 then failure:='invalid_input';
  elsif prior.id is null then failure:='target_unavailable';
  elsif prior.revision<>target_expected_revision then failure:='revision_conflict';
  elsif prior.status<>'pending' then failure:='invalid_state'; end if;
  if failure is null then
    update private.early_access_requests set status='denied',revision=revision+1,updated_at=clock_timestamp() where id=target_request_id;
    result:=jsonb_build_object('ok',true,'requestId',target_request_id,'status','denied','revision',(prior.revision+1)::text);
  else result:=jsonb_build_object('ok',false,'errorCode',failure); end if;
  insert into private.site_admin_audit(actor_id,action,permission,reason_code,early_access_request_id,
    before_request_status,after_request_status,request_id,correlation_id,environment,outcome,error_code)
    values(target_expected_actor_id,'early_access.deny','operations.manage','early_access_review',target_request_id,
      prior.status,case when failure is null then 'denied' else prior.status end,target_operation_id,target_correlation_id,
      environment,case when failure is null then 'success' else 'failure' end,failure);
  insert into private.site_admin_role_requests values(target_expected_actor_id,target_operation_id,signature,result);
  return result;
end;
$$;
revoke all on function public.site_admin_deny_early_access_request(uuid,uuid,bigint,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.site_admin_deny_early_access_request(uuid,uuid,bigint,uuid,uuid) to authenticated;
