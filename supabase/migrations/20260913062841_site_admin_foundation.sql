set local lock_timeout = '5s';
-- Freeze Auth writes while backfilling defaults and installing lifecycle guards.
lock table auth.users, auth.mfa_factors in share row exclusive mode;

-- FOU-1502 foundation only. No account becomes an admin during this migration.
create schema if not exists private;
create table private.site_roles (
  role_key text primary key check(role_key ~ '^[a-z][a-z0-9_]{1,39}$'),
  label text not null
);
insert into private.site_roles values('member','Member'),('site_admin','Site admin');
create table private.site_permissions (
  permission_key text primary key check(permission_key ~ '^[a-z]+\.[a-z]+$')
);
insert into private.site_permissions values ('users.read'),('users.manage'),('roles.manage'),('testing.manage'),
  ('metrics.read'),('operations.read'),('operations.manage'),('audit.read');
create table private.site_role_permissions (
  role_key text references private.site_roles,
  permission_key text references private.site_permissions,
  primary key(role_key,permission_key)
);
insert into private.site_role_permissions select 'site_admin',permission_key from private.site_permissions;
create table private.site_user_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role_key text not null default 'member' references private.site_roles,
  revision bigint not null default 0 check(revision>=0),
  updated_at timestamptz not null default clock_timestamp(),
  updated_by uuid
);
create index site_user_roles_role_idx on private.site_user_roles(role_key,user_id);
insert into private.site_user_roles(user_id) select id from auth.users;
create table private.site_admin_configuration (
  singleton boolean primary key default true check(singleton),
  environment text not null check(environment in ('production','preview','local')),
  allowed_origins text[] not null
);
insert into private.site_admin_configuration values(true,'production',array[
  'https://77dominion.com','https://www.77dominion.com','https://77-dominion-live.pages.dev']);
create table private.site_admin_audit (
  sequence_id bigint generated always as identity primary key,
  actor_id uuid,
  target_user_id uuid,
  action text not null check(action in ('roles.bootstrap','roles.assign')),
  permission text not null check(permission='roles.manage'),
  reason_code text not null check(reason_code in ('initial_admin_bootstrap','staff_access_review','approved_role_change','recovery_plan')),
  before_role text references private.site_roles,
  after_role text references private.site_roles,
  request_id uuid not null,
  correlation_id uuid not null,
  environment text not null check(environment in ('production','preview','local')),
  occurred_at timestamptz not null default clock_timestamp(),
  outcome text not null check(outcome in ('success','failure')),
  error_code text check(error_code in ('invalid_input','revision_conflict','self_action_forbidden','target_unavailable','target_mfa_required','rate_limited','final_admin')),
  unique(actor_id,request_id)
);
create index site_admin_audit_actor_time_idx on private.site_admin_audit(actor_id,occurred_at desc);
create table private.site_admin_role_requests (
  actor_id uuid not null,
  request_id uuid not null,
  signature jsonb not null,
  result jsonb not null,
  primary key(actor_id,request_id)
);
create table private.site_admin_session_blocks (
  session_id uuid primary key,
  user_id uuid not null,
  blocked_at timestamptz not null default clock_timestamp(),
  request_id uuid not null
);
create index site_admin_session_blocks_user_idx on private.site_admin_session_blocks(user_id);
create table private.site_admin_bootstrap_receipt (
  singleton boolean primary key default true check(singleton),
  target_user_id uuid not null,
  approval_id uuid not null unique,
  environment text not null,
  applied_at timestamptz not null default clock_timestamp()
);
do $$ declare relation_name text; begin
  foreach relation_name in array array['site_roles','site_permissions','site_role_permissions','site_user_roles',
    'site_admin_configuration','site_admin_audit','site_admin_role_requests','site_admin_session_blocks','site_admin_bootstrap_receipt'] loop
    execute format('alter table private.%I enable row level security',relation_name);
    execute format('revoke all on private.%I from public,anon,authenticated,service_role',relation_name);
  end loop;
end $$;
revoke all on sequence private.site_admin_audit_sequence_id_seq from public,anon,authenticated,service_role;

create function private.site_admin_immutable()
returns trigger language plpgsql security invoker set search_path='' as $$
begin raise exception using errcode='42501',message='admin_immutable_record'; end;
$$;
revoke all on function private.site_admin_immutable() from public,anon,authenticated,service_role;
create trigger site_admin_audit_immutable before update or delete or truncate on private.site_admin_audit
  for each statement execute function private.site_admin_immutable();
create trigger site_admin_bootstrap_immutable before update or delete or truncate on private.site_admin_bootstrap_receipt
  for each statement execute function private.site_admin_immutable();

create function private.initialize_site_member()
returns trigger language plpgsql security definer set search_path='' as $$
begin insert into private.site_user_roles(user_id) values(new.id) on conflict do nothing; return new; end;
$$;
revoke all on function private.initialize_site_member() from public,anon,authenticated,service_role;
create trigger initialize_site_member after insert on auth.users for each row execute function private.initialize_site_member();

create function private.site_admin_is_usable(target_user_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from private.site_user_roles r join auth.users u on u.id=r.user_id
    where r.user_id=target_user_id and r.role_key='site_admin' and u.deleted_at is null
      and not coalesce(u.is_anonymous,false) and u.email_confirmed_at is not null
      and (u.banned_until is null or u.banned_until<=statement_timestamp())
      and exists(select 1 from auth.mfa_factors f where f.user_id=u.id and f.factor_type::text='totp' and f.status::text='verified'));
$$;
revoke all on function private.site_admin_is_usable(uuid) from public,anon,authenticated,service_role;

create function private.guard_site_admin_recovery()
returns trigger language plpgsql security definer set search_path='' as $$
declare target_id uuid; removes_access boolean;
begin
  if tg_table_name='users' then target_id:=old.id; else target_id:=old.user_id; end if;
  perform pg_advisory_xact_lock(hashtextextended('site-admin-lifecycle',1502));
  if not exists(select 1 from private.site_user_roles where user_id=target_id and role_key='site_admin') then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  if tg_op='DELETE' then removes_access:=true;
  elsif tg_table_name='site_user_roles' then removes_access:=new.role_key<>'site_admin';
  else removes_access:=new.deleted_at is not null or new.email_confirmed_at is null or coalesce(new.is_anonymous,false)
    or (new.banned_until is not null and new.banned_until>statement_timestamp()); end if;
  if removes_access and not exists(select 1 from private.site_user_roles r
    where r.user_id<>target_id and private.site_admin_is_usable(r.user_id)) then
    raise exception using errcode='42501',message='admin_final_recovery_path';
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end;
$$;
revoke all on function private.guard_site_admin_recovery() from public,anon,authenticated,service_role;
create trigger guard_final_site_role before update or delete on private.site_user_roles
  for each row execute function private.guard_site_admin_recovery();
create trigger guard_final_site_admin_auth before delete or update of banned_until,deleted_at,email_confirmed_at,is_anonymous on auth.users
  for each row execute function private.guard_site_admin_recovery();

-- Auth may unenroll a factor directly, independently of the application UI.
-- Only the last verified TOTP of the last usable site admin is protected.
create function private.guard_site_admin_factor_recovery()
returns trigger language plpgsql security definer set search_path='' as $$
declare removes_factor boolean;
begin
  if old.factor_type::text is distinct from 'totp' or old.status::text is distinct from 'verified' then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  if tg_op='DELETE' then removes_factor:=true;
  else removes_factor:=new.user_id is distinct from old.user_id or new.factor_type::text is distinct from 'totp'
    or new.status::text is distinct from 'verified'; end if;
  if removes_factor then
    perform pg_advisory_xact_lock(hashtextextended('site-admin-lifecycle',1502));
    if exists(select 1 from private.site_user_roles where user_id=old.user_id and role_key='site_admin')
      and not exists(select 1 from auth.mfa_factors f where f.user_id=old.user_id and f.id<>old.id
        and f.factor_type::text='totp' and f.status::text='verified')
      and not exists(select 1 from private.site_user_roles r where r.user_id<>old.user_id and private.site_admin_is_usable(r.user_id)) then
      raise exception using errcode='42501',message='admin_final_recovery_path';
    end if;
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end;
$$;
revoke all on function private.guard_site_admin_factor_recovery() from public,anon,authenticated,service_role;
create trigger guard_final_site_admin_factor before delete or update of user_id,factor_type,status on auth.mfa_factors
  for each row execute function private.guard_site_admin_factor_recovery();

create function private.site_admin_request_identity(expected_actor_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); claims jsonb:=(select auth.jwt()); session_identifier uuid; origin text;
begin
  perform set_config('response.headers','[{"Cache-Control":"private, no-store"},{"Pragma":"no-cache"}]',true);
  if actor is null or actor is distinct from expected_actor_id or claims->>'role' is distinct from 'authenticated' then
    raise exception using errcode='PT401',message='admin_authentication_required'; end if;
  begin session_identifier:=(claims->>'session_id')::uuid;
    origin:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb->>'origin';
  exception when others then raise exception using errcode='PT401',message='admin_authentication_required'; end;
  if not exists(select 1 from private.site_admin_configuration c where c.singleton and origin=any(c.allowed_origins)) then
    raise exception using errcode='PT403',message='admin_origin_forbidden'; end if;
  if not exists(select 1 from auth.sessions s join auth.users u on u.id=s.user_id
    where s.id=session_identifier and s.user_id=actor and (s.not_after is null or s.not_after>statement_timestamp())
      and u.deleted_at is null and not coalesce(u.is_anonymous,false) and u.email_confirmed_at is not null
      and (u.banned_until is null or u.banned_until<=statement_timestamp())) then
    raise exception using errcode='PT401',message='admin_authentication_required'; end if;
  return session_identifier;
end;
$$;
revoke all on function private.site_admin_request_identity(uuid) from public,anon,authenticated,service_role;

create function private.site_admin_mfa_ready(target_user_id uuid,target_session_id uuid,require_recent boolean default false)
returns boolean language sql stable security definer set search_path='' as $$
  select coalesce((select auth.jwt())->>'aal'='aal2',false)
    and exists(select 1 from auth.sessions s join auth.mfa_factors f on f.id=s.factor_id
      where s.id=target_session_id and s.user_id=target_user_id and s.aal::text='aal2'
        and f.user_id=target_user_id and f.factor_type::text='totp' and f.status::text='verified')
    and not exists(select 1 from private.site_admin_session_blocks b where b.session_id=target_session_id)
    and (not require_recent or (
      exists(select 1 from auth.mfa_amr_claims a where a.session_id=target_session_id and a.authentication_method='totp'
        and a.updated_at between statement_timestamp()-interval '10 minutes' and statement_timestamp()+interval '30 seconds')
      and exists(select 1 from jsonb_array_elements(case when jsonb_typeof((select auth.jwt())->'amr')='array'
        then (select auth.jwt())->'amr' else '[]'::jsonb end) a
        where a->>'method'='totp' and case when a->>'timestamp' ~ '^[0-9]{1,12}$' then (a->>'timestamp')::bigint else 0 end
          between extract(epoch from statement_timestamp()-interval '10 minutes') and extract(epoch from statement_timestamp()+interval '30 seconds'))
    ));
$$;
revoke all on function private.site_admin_mfa_ready(uuid,uuid,boolean) from public,anon,authenticated,service_role;

create function private.require_site_admin(permission_key text,expected_actor_id uuid,require_recent boolean default false)
returns uuid language plpgsql security definer set search_path='' as $$
declare session_identifier uuid;
begin
  session_identifier:=private.site_admin_request_identity(expected_actor_id);
  if not exists(select 1 from private.site_user_roles r join private.site_role_permissions p on p.role_key=r.role_key
    where r.user_id=expected_actor_id and p.permission_key=require_site_admin.permission_key)
    or not private.site_admin_mfa_ready(expected_actor_id,session_identifier,require_recent) then
    raise exception using errcode='PT403',message='admin_permission_or_step_up_required'; end if;
  return session_identifier;
end;
$$;
revoke all on function private.require_site_admin(text,uuid,boolean) from public,anon,authenticated,service_role;

create function public.get_site_admin_context(target_expected_actor_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare session_identifier uuid; assigned_role text; role_revision bigint; permissions jsonb; ready boolean;
begin
  session_identifier:=private.site_admin_request_identity(target_expected_actor_id);
  select role_key,revision into assigned_role,role_revision from private.site_user_roles where user_id=target_expected_actor_id;
  if assigned_role is distinct from 'site_admin' then
    return jsonb_build_object('schemaVersion',1,'actorId',target_expected_actor_id,'role',coalesce(assigned_role,'member'),'adminReady',false);
  end if;
  ready:=private.site_admin_mfa_ready(target_expected_actor_id,session_identifier,false);
  if not ready then return jsonb_build_object('schemaVersion',1,'actorId',target_expected_actor_id,'role','site_admin',
    'adminReady',false,'reason',case when exists(select 1 from private.site_admin_session_blocks where session_id=session_identifier)
      then 'reauthentication_required' else 'mfa_required' end); end if;
  select jsonb_agg(permission_key order by permission_key) into permissions from private.site_role_permissions where role_key=assigned_role;
  return jsonb_build_object('schemaVersion',1,'actorId',target_expected_actor_id,'role',assigned_role,'roleRevision',role_revision,
    'adminReady',true,'permissions',permissions,'stepUpRequired',not private.site_admin_mfa_ready(target_expected_actor_id,session_identifier,true));
end;
$$;
revoke all on function public.get_site_admin_context(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_site_admin_context(uuid) to authenticated;

-- This primitive is not a public RPC and is never invoked by the migration.
create function private.bootstrap_site_admin(target_user_id uuid,approval_id uuid,target_environment text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare receipt private.site_admin_bootstrap_receipt%rowtype; environment text;
begin
  if current_user<>'postgres' or target_user_id is null or approval_id is null then
    raise exception using errcode='42501',message='admin_operator_required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('site-admin-lifecycle',1502));
  select c.environment into environment from private.site_admin_configuration c where singleton;
  if environment is distinct from target_environment then raise exception using errcode='22023',message='admin_environment_mismatch'; end if;
  select * into receipt from private.site_admin_bootstrap_receipt where singleton;
  if receipt.singleton then
    if receipt.target_user_id=target_user_id and receipt.approval_id=bootstrap_site_admin.approval_id
      and receipt.environment=target_environment then return jsonb_build_object('applied',false,'alreadyApplied',true); end if;
    raise exception using errcode='42501',message='admin_bootstrap_already_used';
  end if;
  if exists(select 1 from private.site_user_roles where role_key='site_admin') then
    raise exception using errcode='42501',message='admin_bootstrap_not_empty'; end if;
  if not exists(select 1 from auth.users u where u.id=target_user_id and u.deleted_at is null
    and not coalesce(u.is_anonymous,false) and u.email_confirmed_at is not null
    and (u.banned_until is null or u.banned_until<=statement_timestamp())
    and exists(select 1 from auth.mfa_factors f where f.user_id=u.id and f.status::text='verified' and f.factor_type::text='totp')) then
    raise exception using errcode='42501',message='admin_bootstrap_verified_mfa_required'; end if;
  update private.site_user_roles set role_key='site_admin',revision=revision+1,updated_at=clock_timestamp() where user_id=target_user_id;
  if not found then raise exception using errcode='42501',message='admin_target_unavailable'; end if;
  insert into private.site_admin_session_blocks(session_id,user_id,request_id)
    select id,user_id,approval_id from auth.sessions where user_id=target_user_id on conflict do nothing;
  insert into private.site_admin_bootstrap_receipt values(true,target_user_id,approval_id,target_environment,clock_timestamp());
  insert into private.site_admin_audit(actor_id,target_user_id,action,permission,reason_code,before_role,after_role,
    request_id,correlation_id,environment,outcome)
    values(null,target_user_id,'roles.bootstrap','roles.manage','initial_admin_bootstrap','member','site_admin',
      approval_id,approval_id,target_environment,'success');
  return jsonb_build_object('applied',true,'alreadyApplied',false,'reauthenticationRequired',true);
end;
$$;
revoke all on function private.bootstrap_site_admin(uuid,uuid,text) from public,anon,authenticated,service_role;

create function public.site_admin_assign_role(target_expected_actor_id uuid,target_user_id uuid,target_role text,
  target_expected_revision bigint,target_request_id uuid,target_correlation_id uuid,target_reason_code text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare prior private.site_user_roles%rowtype; request private.site_admin_role_requests%rowtype;
  signature jsonb; result jsonb; failure text; environment text;
begin
  perform private.require_site_admin('roles.manage',target_expected_actor_id,true);
  perform pg_advisory_xact_lock(hashtextextended('site-admin-lifecycle',1502));
  perform private.require_site_admin('roles.manage',target_expected_actor_id,true);
  if target_request_id is null or target_correlation_id is null then
    raise exception using errcode='22023',message='admin_request_identity_required'; end if;
  -- Never retain arbitrary text from an invalid request. The digest preserves
  -- exact retry/conflict behavior without storing a raw request or free text.
  signature:=jsonb_build_object('digest',encode(sha256(convert_to(jsonb_build_array(target_user_id,target_role,
    target_expected_revision,target_reason_code,target_correlation_id)::text,'UTF8')),'hex'));
  select * into request from private.site_admin_role_requests where actor_id=target_expected_actor_id and request_id=target_request_id;
  if request.request_id is not null then
    if request.signature is distinct from signature then raise exception using errcode='22023',message='admin_idempotency_conflict'; end if;
    return request.result;
  end if;
  select c.environment into environment from private.site_admin_configuration c where singleton;
  if (select count(*) from private.site_admin_audit where actor_id=target_expected_actor_id and occurred_at>clock_timestamp()-interval '1 minute')>=20
    or (select count(*) from private.site_admin_audit where actor_id=target_expected_actor_id and occurred_at>clock_timestamp()-interval '1 hour')>=100 then
    -- Rejected before mutation; do not let rejected traffic grow the ledger.
    return jsonb_build_object('ok',false,'errorCode','rate_limited');
  end if;
  select * into prior from private.site_user_roles where user_id=target_user_id for update;
  if target_role is null or target_role not in ('member','site_admin') or target_expected_revision is null or target_expected_revision<0
    or target_reason_code is null or target_reason_code not in ('staff_access_review','approved_role_change','recovery_plan') then failure:='invalid_input';
  elsif target_user_id=target_expected_actor_id then failure:='self_action_forbidden';
  elsif prior.user_id is null or not exists(select 1 from auth.users u where u.id=target_user_id and u.deleted_at is null
    and not coalesce(u.is_anonymous,false) and u.email_confirmed_at is not null
    and (u.banned_until is null or u.banned_until<=statement_timestamp())) then failure:='target_unavailable';
  elsif prior.revision<>target_expected_revision then failure:='revision_conflict';
  elsif target_role='site_admin' and not exists(select 1 from auth.mfa_factors f where f.user_id=target_user_id
    and f.factor_type::text='totp' and f.status::text='verified') then failure:='target_mfa_required'; end if;
  if failure is null then
    update private.site_user_roles set role_key=target_role,revision=revision+1,updated_at=clock_timestamp(),updated_by=target_expected_actor_id
      where user_id=target_user_id;
    insert into private.site_admin_session_blocks(session_id,user_id,request_id)
      select id,user_id,target_request_id from auth.sessions where user_id=target_user_id on conflict do nothing;
    result:=jsonb_build_object('ok',true,'role',target_role,'revision',prior.revision+1,'reauthenticationRequired',true);
  else result:=jsonb_build_object('ok',false,'errorCode',failure); end if;
  insert into private.site_admin_audit(actor_id,target_user_id,action,permission,reason_code,before_role,after_role,
    request_id,correlation_id,environment,outcome,error_code)
    values(target_expected_actor_id,target_user_id,'roles.assign','roles.manage',
      case when target_reason_code in ('staff_access_review','approved_role_change','recovery_plan') then target_reason_code else 'staff_access_review' end,
      prior.role_key,case when failure is null then target_role else prior.role_key end,target_request_id,target_correlation_id,
      environment,case when failure is null then 'success' else 'failure' end,failure);
  insert into private.site_admin_role_requests values(target_expected_actor_id,target_request_id,signature,result);
  return result;
end;
$$;
revoke all on function public.site_admin_assign_role(uuid,uuid,text,bigint,uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.site_admin_assign_role(uuid,uuid,text,bigint,uuid,uuid,text) to authenticated;
