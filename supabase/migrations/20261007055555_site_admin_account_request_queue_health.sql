-- FOU-1502: read-only active intake queue health, not fulfillment/delivery proof.
-- Reuse account_lifecycle_requests_admin_bucket_idx; no ledger/table changes.
create function public.site_admin_get_account_request_queue_health(target_expected_actor_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare buckets jsonb;
begin
  perform private.require_site_admin('operations.read',target_expected_actor_id,false);
  -- Exactly four index prefixes and at most 1001 visible entries per prefix.
  -- The extra entry proves truncation; no unbounded count, identity or note read.
  select jsonb_agg(jsonb_build_object('requestType',rt.request_type,'status',st.status,
    'count',least(q.amount,1000),'hasMore',q.amount>1000,'oldestRequestedAt',q.oldest)
    order by rt.ordinality,st.ordinality) into buckets
  from unnest(array['data_export','account_deletion']) with ordinality rt(request_type,ordinality)
  cross join unnest(array['requested','in_progress']) with ordinality st(status,ordinality)
  cross join lateral (
    select count(*) as amount,min(bounded.requested_at) as oldest from (
      select r.requested_at from public.account_lifecycle_requests r
      where r.request_type=rt.request_type and r.status=st.status
      order by r.requested_at,r.id limit 1001
    ) bounded
  ) q;
  return jsonb_build_object('schemaVersion',1,'actorId',target_expected_actor_id,
    'observedAt',statement_timestamp(),'buckets',buckets);
end;
$$;
revoke all on function public.site_admin_get_account_request_queue_health(uuid) from public,anon,authenticated,service_role;
grant execute on function public.site_admin_get_account_request_queue_health(uuid) to authenticated;
