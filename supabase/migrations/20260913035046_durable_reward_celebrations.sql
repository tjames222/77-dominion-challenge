-- Delivery claims never grant/redeem rewards and never reset a seen timestamp.
set local lock_timeout = '10s';
set local statement_timeout = '60s';

create table private.reward_celebration_claims (
  user_id uuid not null,
  reward_key text not null,
  claim_token uuid not null,
  claimed_at timestamptz not null default now(),
  lease_until timestamptz not null,
  primary key(user_id, reward_key),
  foreign key(user_id, reward_key) references public.user_reward_entitlements(user_id, reward_key) on delete cascade,
  check(lease_until > claimed_at)
);
alter table private.reward_celebration_claims enable row level security;
revoke all on private.reward_celebration_claims from public, anon, authenticated, service_role;

create function private.stamp_reward_celebration_milestone()
returns trigger language plpgsql security definer set search_path = '' as $$
declare milestone integer;
begin
  -- Snapshot only new grants. Older owned rows and their seen state stay intact.
  select points_required into milestone from public.reward_definitions where reward_key = new.reward_key;
  if milestone > 0 and new.source_type in ('point_threshold','catalog_threshold','backfill') then
    new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object('celebrationMilestonePoints', milestone);
  end if;
  return new;
end $$;
revoke all on function private.stamp_reward_celebration_milestone() from public, anon, authenticated, service_role;
create trigger stamp_reward_celebration_milestone before insert on public.user_reward_entitlements
  for each row execute function private.stamp_reward_celebration_milestone();

create function public.claim_reward_celebrations(target_expected_actor_id uuid, target_claim_token uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare caller_id uuid := auth.uid(); result jsonb;
begin
  if caller_id is null or target_expected_actor_id is distinct from caller_id then
    raise exception 'The signed-in account changed. Try again.' using errcode = '42501';
  end if;
  if target_claim_token is null then raise exception 'A delivery token is required.' using errcode = '22023'; end if;
  perform public.ensure_user_game_stats(caller_id);
  perform public.reconcile_user_reward_entitlements(caller_id);

  with pending as materialized (
    select e.user_id, e.reward_key
    from public.user_reward_entitlements e join public.reward_definitions d using(reward_key)
    left join private.reward_celebration_claims c on c.user_id=e.user_id and c.reward_key=e.reward_key
    where e.user_id=caller_id and e.celebration_seen_at is null and d.state_model='ownership'
      and (c.reward_key is null or c.claim_token=target_claim_token or c.lease_until <= clock_timestamp())
    order by d.sort_order, d.reward_key
    for update of e skip locked
  ), leased as (
    insert into private.reward_celebration_claims(user_id,reward_key,claim_token,claimed_at,lease_until)
    select user_id,reward_key,target_claim_token,clock_timestamp(),clock_timestamp()+interval '15 minutes' from pending
    on conflict(user_id,reward_key) do update set claim_token=excluded.claim_token,
      claimed_at=excluded.claimed_at, lease_until=excluded.lease_until
    where reward_celebration_claims.claim_token=target_claim_token or reward_celebration_claims.lease_until <= clock_timestamp()
    returning reward_key
  )
  select coalesce(jsonb_agg(
    public.reward_catalog_item_for_user(caller_id,d.reward_key,coalesce(s.total_points,0)) || jsonb_build_object(
      'celebrationSourceType',e.source_type,
      'celebrationMilestonePoints',case when coalesce(e.metadata ->> 'celebrationMilestonePoints','') ~ '^[0-9]{1,9}$'
        then (e.metadata ->> 'celebrationMilestonePoints')::integer else null end
    ) order by d.sort_order,d.reward_key
  ),'[]'::jsonb) into result
  from leased l join public.reward_definitions d on d.reward_key=l.reward_key
  join public.user_reward_entitlements e on e.user_id=caller_id and e.reward_key=l.reward_key
  left join public.user_game_stats s on s.user_id=caller_id;
  return jsonb_build_object('claimedUnlocks',result,'claimToken',target_claim_token,'leaseSeconds',900);
end $$;
revoke all on function public.claim_reward_celebrations(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.claim_reward_celebrations(uuid,uuid) to authenticated;

create function public.acknowledge_reward_celebrations(target_expected_actor_id uuid, target_claim_token uuid, target_reward_keys text[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare caller_id uuid := auth.uid(); acknowledged jsonb;
begin
  if caller_id is null or target_expected_actor_id is distinct from caller_id then
    raise exception 'The signed-in account changed. Try again.' using errcode = '42501';
  end if;
  if target_claim_token is null or target_reward_keys is null or cardinality(target_reward_keys)>1000 then
    raise exception 'A valid delivery acknowledgement is required.' using errcode = '22023';
  end if;
  with seen as (
    update public.user_reward_entitlements e set celebration_seen_at=clock_timestamp(),updated_at=clock_timestamp()
    from private.reward_celebration_claims c
    where e.user_id=caller_id and e.reward_key=any(target_reward_keys) and e.celebration_seen_at is null
      and c.user_id=e.user_id and c.reward_key=e.reward_key and c.claim_token=target_claim_token
    returning e.reward_key
  ) select coalesce(jsonb_agg(reward_key order by reward_key),'[]'::jsonb) into acknowledged from seen;
  delete from private.reward_celebration_claims c
  where c.user_id=caller_id and c.claim_token=target_claim_token and c.reward_key=any(target_reward_keys)
    and exists(select 1 from public.user_reward_entitlements e where e.user_id=c.user_id and e.reward_key=c.reward_key and e.celebration_seen_at is not null);
  -- A lost success response can be safely retried even after its lease is gone.
  select coalesce(jsonb_agg(e.reward_key order by e.reward_key),'[]'::jsonb) into acknowledged
  from public.user_reward_entitlements e
  where e.user_id=caller_id and e.reward_key=any(target_reward_keys) and e.celebration_seen_at is not null;
  return jsonb_build_object('acknowledgedKeys',acknowledged);
end $$;
revoke all on function public.acknowledge_reward_celebrations(uuid,uuid,text[]) from public,anon,authenticated,service_role;
grant execute on function public.acknowledge_reward_celebrations(uuid,uuid,text[]) to authenticated;

-- Older clients may still show the inline unlock notice. Keep that contract,
-- but never let it consume a reward already leased to the durable presenter.
create or replace function public.claim_reward_entitlement_unlocks(target_expected_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare caller_id uuid := auth.uid(); claimed_keys jsonb;
begin
  if caller_id is null or target_expected_actor_id is distinct from caller_id then
    raise exception 'The signed-in account changed. Try again.' using errcode = '42501';
  end if;
  perform public.ensure_user_game_stats(caller_id);
  perform public.reconcile_user_reward_entitlements(caller_id);
  with pending as materialized (
    select e.user_id,e.reward_key
    from public.user_reward_entitlements e join public.reward_definitions d using(reward_key)
    where e.user_id=caller_id and e.celebration_seen_at is null and d.state_model='ownership'
      and not exists(select 1 from private.reward_celebration_claims c
        where c.user_id=e.user_id and c.reward_key=e.reward_key and c.lease_until>clock_timestamp())
    order by d.sort_order,d.reward_key for update of e skip locked
  ), seen as (
    update public.user_reward_entitlements e set celebration_seen_at=clock_timestamp(),updated_at=clock_timestamp()
    from pending p where e.user_id=p.user_id and e.reward_key=p.reward_key and e.celebration_seen_at is null
    returning e.reward_key
  ) select coalesce(jsonb_agg(reward_key order by reward_key),'[]'::jsonb) into claimed_keys from seen;
  return jsonb_build_object('claimedKeys',claimed_keys,'catalog',public.reward_catalog_for_user(caller_id,100,null,null));
end $$;
revoke all on function public.claim_reward_entitlement_unlocks(uuid) from public,anon,authenticated,service_role;
grant execute on function public.claim_reward_entitlement_unlocks(uuid) to authenticated;
