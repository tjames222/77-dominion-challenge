-- One focused Daily Action read. Activation/time-zone reconciliation is a
-- transaction-local write, so this is deliberately VOLATILE and POST-only.
create function private.daily_action_bootstrap(
  target_expected_actor_id uuid,
  target_time_zone text,
  target_entry_date date
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
  as_of timestamptz := pg_catalog.statement_timestamp();
  requested_zone text := nullif(pg_catalog.btrim(target_time_zone), '');
  activation jsonb;
  time_zone text;
  entry_date date;
begin
  if actor is null then
    raise exception 'You need to log in to view this Daily Action.' using errcode = '28000';
  end if;
  if target_expected_actor_id is distinct from actor then
    raise exception 'The signed-in account changed. Refresh and try again.'
      using errcode = '40001', detail = 'daily_action_actor_changed';
  end if;
  if not exists (select 1 from auth.users u where u.id = actor) then
    raise exception 'The signed-in account no longer exists. Refresh and try again.' using errcode = '28000';
  end if;
  if requested_zone is null or pg_catalog.length(requested_zone) > 100
    or not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = requested_zone)
    or (target_entry_date is not null and (
      not pg_catalog.isfinite(target_entry_date)
      or target_entry_date < date '0001-01-01' or target_entry_date > date '9999-12-31'
    )) then
    raise exception 'Choose a valid Daily Action date and time zone.' using errcode = '22023';
  end if;
  perform pg_catalog.set_config('response.headers',
    '[{"Cache-Control":"private, no-store"},{"Pragma":"no-cache"}]', true);

  -- Preserve the old billing gate: denied members get no private draft,
  -- activation promotion, profile creation, or time-zone mutation.
  if not public.has_active_entitlement('membership_active') then
    return pg_catalog.jsonb_build_object('schemaVersion', 1, 'actorId', actor,
      'asOf', as_of, 'appAccess', false, 'activation', null, 'timeZone', null,
      'entryDate', null, 'draft', null);
  end if;

  -- Existing order: single-crew advisory -> activation advisory -> Auth parent
  -- -> profile row. Never initialize the time zone before those locks.
  perform public.get_challenge_activation(actor);
  perform public.bootstrap_daily_standard_time_zone(requested_zone, actor);
  activation := public.challenge_activation_payload_for_user(actor);
  select coalesce(nullif(p.challenge_activation_time_zone, ''), nullif(p.time_zone, ''))
    into time_zone from public.profiles p where p.user_id = actor;
  if time_zone is null or not exists (
    select 1 from pg_catalog.pg_timezone_names z where z.name = time_zone
  ) then time_zone := 'UTC'; end if;
  entry_date := coalesce(target_entry_date, public.daily_standard_user_date(actor));

  return pg_catalog.jsonb_build_object('schemaVersion', 1, 'actorId', actor,
    'asOf', as_of, 'appAccess', true, 'activation', activation, 'timeZone', time_zone,
    'entryDate', entry_date, 'draft', public.daily_standard_draft_payload(actor, entry_date));
end;
$$;
revoke all on function private.daily_action_bootstrap(uuid, text, date)
  from public, anon, authenticated, service_role;

-- The exposed boundary needs owner privileges only to invoke the private
-- implementation; no private-schema grants or table privileges are added.
create function public.get_daily_action_bootstrap(
  target_expected_actor_id uuid,
  target_time_zone text,
  target_entry_date date default null
)
returns jsonb language sql security definer set search_path = ''
as $$
  select private.daily_action_bootstrap(target_expected_actor_id, target_time_zone, target_entry_date);
$$;
revoke all on function public.get_daily_action_bootstrap(uuid, text, date)
  from public, anon, authenticated, service_role;
grant execute on function public.get_daily_action_bootstrap(uuid, text, date) to authenticated;
comment on function public.get_daily_action_bootstrap(uuid, text, date) is
  'Actor-bound Daily Action bootstrap only. asOf is statement start; no Dashboard, feed, history, stats or badge payload. POST/private no-store.';
