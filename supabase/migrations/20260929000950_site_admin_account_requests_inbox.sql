-- FOU-1502: metadata-only account-request inbox. Existing member policies,
-- FORCE RLS, intake columns, and operator-only fulfillment remain unchanged.
-- One index serves every fixed type/status bucket in either keyset direction.
create index account_lifecycle_requests_admin_bucket_idx
  on public.account_lifecycle_requests(request_type,status,requested_at,id);

create function public.site_admin_list_account_requests(
  target_expected_actor_id uuid,
  target_limit integer default 25,
  target_request_type text default 'all',
  target_status text default 'active',
  target_sort text default 'oldest',
  target_cursor jsonb default null
)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  query_key text; request_types text[]; statuses text[];
  direction text; comparator text; after_id uuid; after_stamp timestamptz;
  ids uuid[]; items jsonb; last_id uuid; last_stamp timestamptz; next_cursor jsonb;
begin
  -- The caller's current native session, verified MFA and operations.read
  -- permission are checked before input validation or cross-account reads.
  perform private.require_site_admin('operations.read',target_expected_actor_id,false);
  if target_limit is null or target_limit not between 1 and 50
    or target_request_type is null or target_request_type not in ('all','data_export','account_deletion')
    or target_status is null or target_status not in ('active','all','requested','in_progress','fulfilled','cancelled','declined')
    or target_sort is null or target_sort not in ('oldest','newest') then
    raise exception using errcode='22023',message='admin_invalid_input';
  end if;
  query_key:=encode(sha256(convert_to(jsonb_build_array(target_request_type,target_status,target_sort)::text,'UTF8')),'hex');
  if target_cursor is not null then
    begin
      if octet_length(target_cursor::text)>2048 or jsonb_typeof(target_cursor)<>'object'
        or (select count(*) from jsonb_object_keys(target_cursor))<>5
        or target_cursor->'v' is distinct from '1'::jsonb
        or target_cursor->>'actorId' is distinct from target_expected_actor_id::text
        or target_cursor->>'query' is distinct from query_key
        or jsonb_typeof(target_cursor->'id') is distinct from 'string'
        or jsonb_typeof(target_cursor->'stamp') is distinct from 'string'
        or target_cursor->>'stamp' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$'
        then raise exception 'invalid'; end if;
      after_id:=(target_cursor->>'id')::uuid;
      after_stamp:=(target_cursor->>'stamp')::timestamptz;
      if after_id is null or after_id::text is distinct from target_cursor->>'id'
        or after_stamp is null or not isfinite(after_stamp) then raise exception 'invalid'; end if;
    exception when others then
      raise exception using errcode='22023',message='admin_invalid_cursor';
    end;
  end if;
  request_types:=case when target_request_type='all' then array['data_export','account_deletion'] else array[target_request_type] end;
  statuses:=case target_status when 'all' then array['requested','in_progress','fulfilled','cancelled','declined']
    when 'active' then array['requested','in_progress'] else array[target_status] end;
  direction:=case when target_sort='newest' then 'desc' else 'asc' end;
  comparator:=case when target_sort='newest' then '<' else '>' end;
  -- At most ten fixed buckets, each fetching <=51 ordered index entries. The
  -- final sort sees <=510 candidates, independent of queue size or page depth.
  -- Only the two allowlisted SQL tokens are formatted; every value is bound.
  execute format($query$
    select array_agg(q.id order by q.requested_at %1$s,q.id %1$s) from (
      select bucket.id,bucket.requested_at
      from unnest($1::text[]) rt(request_type)
      cross join unnest($2::text[]) st(status)
      cross join lateral (
        select r.id,r.requested_at from public.account_lifecycle_requests r
        where r.request_type=rt.request_type and r.status=st.status
          and ($3::timestamptz is null or (r.requested_at,r.id) %2$s ($3,$4::uuid))
        order by r.requested_at %1$s,r.id %1$s limit $5
      ) bucket
      order by bucket.requested_at %1$s,bucket.id %1$s limit $5
    ) q$query$,direction,comparator)
    into ids using request_types,statuses,after_stamp,after_id,target_limit+1;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id',r.id,'userId',r.user_id,'requestType',r.request_type,'status',r.status,
      'requestedAt',r.requested_at,'updatedAt',r.updated_at,'resolvedAt',r.resolved_at
    ) order by v.ordinality),'[]'::jsonb) into items
    from unnest(ids[1:target_limit]) with ordinality v(id,ordinality)
    join public.account_lifecycle_requests r on r.id=v.id;
  if cardinality(ids)>target_limit then
    last_id:=ids[target_limit];
    select requested_at into last_stamp from public.account_lifecycle_requests where id=last_id;
    next_cursor:=jsonb_build_object('v',1,'actorId',target_expected_actor_id,'query',query_key,'stamp',last_stamp,'id',last_id);
  end if;
  return jsonb_build_object('schemaVersion',1,'actorId',target_expected_actor_id,'observedAt',statement_timestamp(),
    'items',items,'nextCursor',next_cursor);
end;
$$;
revoke all on function public.site_admin_list_account_requests(uuid,integer,text,text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.site_admin_list_account_requests(uuid,integer,text,text,text,jsonb) to authenticated;
