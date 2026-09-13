set local lock_timeout = '5s';

create index site_admin_users_created_id_idx on auth.users ((coalesce(created_at,'1970-01-01T00:00:00Z'::timestamptz)),id);
create index site_admin_users_email_prefix_idx on auth.users (lower(email) text_pattern_ops);
create index site_admin_profiles_name_prefix_idx on public.profiles (lower(name) text_pattern_ops);
create index site_admin_subscriptions_latest_idx on public.subscriptions (user_id,updated_at desc,id desc);
create index site_admin_audit_target_sequence_idx on private.site_admin_audit (target_user_id,sequence_id desc);

-- Internal fixed-field serializers. They have no client EXECUTE grant and are
-- invoked only after a public boundary rechecks canonical permission and AAL2.
create function private.site_admin_user_payload(target_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_build_object(
    'id',u.id,'name',left(p.name,120),'email',left(u.email,254),
    'createdAt',u.created_at,'emailConfirmedAt',u.email_confirmed_at,'lastSignInAt',u.last_sign_in_at,
    'isAnonymous',coalesce(u.is_anonymous,false),'isSuspended',coalesce(u.banned_until>statement_timestamp(),false),
    'suspendedUntil',u.banned_until,'deletedAt',u.deleted_at,
    'role',r.role_key,'roleRevision',r.revision,
    'deletionPending',d.status is not null,'deletionRequestStatus',d.status,
    'crew',case when c.id is not null then jsonb_build_object('id',c.id,'name',left(c.name,80),'role',cm.role) else null end,
    'activationSnapshot',case when p.user_id is not null then jsonb_build_object(
      'storedStatus',p.challenge_activation_status,'mode',p.challenge_participation_mode,
      'startDate',p.challenge_start_date,'reviewRequired',p.challenge_activation_review_required,
      'recordedAt',p.challenge_activation_updated_at) else null end,
    'statsSnapshot',case when s.user_id is not null then jsonb_build_object(
      'totalPoints',s.total_points,'storedAppStreak',s.current_app_streak,'storedPerfectDayStreak',s.current_full_day_streak,
      'lastSeenLocalDate',s.last_seen_date,'recordedAt',s.updated_at) else null end,
    'subscriptionSnapshot',case when sub.id is not null then jsonb_build_object(
      'status',case when sub.status in ('incomplete','incomplete_expired','trialing','active','past_due','canceled','unpaid','paused') then sub.status else 'unknown' end,
      'currentPeriodEnd',sub.current_period_end,'cancelAtPeriodEnd',sub.cancel_at_period_end,'recordedAt',sub.updated_at) else null end
  )
  from auth.users u join private.site_user_roles r on r.user_id=u.id
  left join public.profiles p on p.user_id=u.id
  left join public.user_game_stats s on s.user_id=u.id
  left join public.crew_members cm on cm.user_id=u.id
  left join public.crews c on c.id=cm.crew_id
  left join lateral (select l.status from public.account_lifecycle_requests l where l.user_id=u.id
    and l.request_type='account_deletion' and l.status in ('requested','in_progress')
    order by l.requested_at desc,l.id desc limit 1) d on true
  left join lateral (select x.id,x.status,x.current_period_end,x.cancel_at_period_end,x.updated_at from public.subscriptions x
    where x.user_id=u.id and x.product_key='dominion_membership' order by x.updated_at desc,x.id desc limit 1) sub on true
  where u.id=target_id;
$$;
revoke all on function private.site_admin_user_payload(uuid) from public,anon,authenticated,service_role;

create function public.site_admin_get_user(target_expected_actor_id uuid,target_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare item jsonb;
begin
  perform private.require_site_admin('users.read',target_expected_actor_id,false);
  if target_user_id is null then raise exception using errcode='22023',message='admin_invalid_input'; end if;
  item:=private.site_admin_user_payload(target_user_id);
  if item is null then raise exception using errcode='PT404',message='admin_record_not_found'; end if;
  return jsonb_build_object('schemaVersion',1,'actorId',target_expected_actor_id,'observedAt',statement_timestamp(),'item',item);
end;
$$;
revoke all on function public.site_admin_get_user(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.site_admin_get_user(uuid,uuid) to authenticated;

create function public.site_admin_list_users(target_expected_actor_id uuid,target_limit integer default 25,
  target_search text default '',target_status text default 'all',target_role text default 'all',
  target_sort text default 'newest',target_cursor jsonb default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare needle text; pattern text; query_key text; after_id uuid; after_stamp timestamptz;
  ids uuid[]; items jsonb; next_cursor jsonb; last_id uuid; last_stamp timestamptz; direction text; comparator text;
begin
  perform private.require_site_admin('users.read',target_expected_actor_id,false);
  if target_limit is null or target_limit not between 1 and 50 or target_search is null or char_length(target_search)>80
    or target_search ~ '[[:cntrl:]]' or target_status is null or target_status not in ('all','confirmed','unconfirmed','suspended','deletion_pending','deleted')
    or target_role is null or target_role not in ('all','member','site_admin')
    or target_sort is null or target_sort not in ('newest','oldest') then
    raise exception using errcode='22023',message='admin_invalid_input'; end if;
  needle:=lower(btrim(target_search));
  pattern:=replace(replace(replace(needle,E'\\',E'\\\\'),'%',E'\\%'),'_',E'\\_')||'%';
  query_key:=encode(sha256(convert_to(jsonb_build_array(needle,target_status,target_role,target_sort)::text,'UTF8')),'hex');
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
  -- Only fixed, allowlisted direction/operators enter SQL text; all user values
  -- are bind parameters. No OFFSET or full-table JSON aggregation is performed.
  execute format($query$
    select array_agg(q.id order by q.stamp %1$s,q.id %1$s) from (
      select u.id,coalesce(u.created_at,'1970-01-01T00:00:00Z'::timestamptz) stamp
      from auth.users u join private.site_user_roles r on r.user_id=u.id
      where ($1='' or u.id in (
        select a.id from auth.users a where lower(a.email) like $2 escape E'\\'
        union select p.user_id from public.profiles p where lower(p.name) like $2 escape E'\\'))
        and ($3='all' or r.role_key=$3)
        and ($4='all'
          or ($4='confirmed' and u.email_confirmed_at is not null and u.deleted_at is null)
          or ($4='unconfirmed' and u.email_confirmed_at is null and u.deleted_at is null)
          or ($4='suspended' and u.banned_until>statement_timestamp() and u.deleted_at is null)
          or ($4='deleted' and u.deleted_at is not null)
          or ($4='deletion_pending' and exists(select 1 from public.account_lifecycle_requests l where l.user_id=u.id
            and l.request_type='account_deletion' and l.status in ('requested','in_progress'))))
        and ($5 is null or (coalesce(u.created_at,'1970-01-01T00:00:00Z'::timestamptz),u.id) %2$s ($5,$6))
      order by stamp %1$s,u.id %1$s limit $7
    ) q$query$,direction,comparator)
    into ids using needle,pattern,target_role,target_status,after_stamp,after_id,target_limit+1;
  select coalesce(jsonb_agg(private.site_admin_user_payload(v.id) order by v.ordinality),'[]') into items
    from unnest(ids[1:target_limit]) with ordinality v(id,ordinality);
  if cardinality(ids)>target_limit then
    last_id:=ids[target_limit];select coalesce(created_at,'1970-01-01T00:00:00Z'::timestamptz) into last_stamp from auth.users where id=last_id;
    next_cursor:=jsonb_build_object('v',1,'actorId',target_expected_actor_id,'query',query_key,'stamp',last_stamp,'id',last_id);
  end if;
  return jsonb_build_object('schemaVersion',1,'actorId',target_expected_actor_id,'observedAt',statement_timestamp(),
    'items',items,'nextCursor',next_cursor);
end;
$$;
revoke all on function public.site_admin_list_users(uuid,integer,text,text,text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.site_admin_list_users(uuid,integer,text,text,text,text,jsonb) to authenticated;

create function private.site_admin_audit_payload(target_sequence bigint)
returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('id',a.sequence_id::text,'actorId',a.actor_id,'targetUserId',a.target_user_id,
    'action',a.action,'permission',a.permission,'reasonCode',a.reason_code,'beforeRole',a.before_role,'afterRole',a.after_role,
    'requestId',a.request_id,'correlationId',a.correlation_id,'environment',a.environment,
    'occurredAt',a.occurred_at,'outcome',a.outcome,'errorCode',a.error_code)
  from private.site_admin_audit a where a.sequence_id=target_sequence;
$$;
revoke all on function private.site_admin_audit_payload(bigint) from public,anon,authenticated,service_role;

create function public.site_admin_get_audit_event(target_expected_actor_id uuid,target_event_id text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare sequence_number bigint; item jsonb;
begin
  perform private.require_site_admin('audit.read',target_expected_actor_id,false);
  begin
    if target_event_id is null or target_event_id !~ '^[1-9][0-9]{0,18}$' then raise exception 'invalid'; end if;
    sequence_number:=target_event_id::bigint;
  exception when others then raise exception using errcode='22023',message='admin_invalid_input'; end;
  item:=private.site_admin_audit_payload(sequence_number);
  if item is null then raise exception using errcode='PT404',message='admin_record_not_found'; end if;
  return jsonb_build_object('schemaVersion',1,'actorId',target_expected_actor_id,'observedAt',statement_timestamp(),'item',item);
end;
$$;
revoke all on function public.site_admin_get_audit_event(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.site_admin_get_audit_event(uuid,text) to authenticated;

create function public.site_admin_list_audit(target_expected_actor_id uuid,target_limit integer default 25,
  target_user_id uuid default null,target_action text default 'all',target_outcome text default 'all',target_cursor jsonb default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare after_sequence bigint; query_key text; ids bigint[]; items jsonb; next_cursor jsonb;
begin
  perform private.require_site_admin('audit.read',target_expected_actor_id,false);
  if target_limit is null or target_limit not between 1 and 50 or target_action is null or target_action not in ('all','roles.assign','roles.bootstrap')
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
