-- FOU-1443: connect Group challenge activation to the existing single-crew
-- lifecycle without allowing a partially-created owner crew.

set local lock_timeout = '10s';
set local statement_timeout = '120s';

create or replace function public.create_crew_and_activate_group(
  target_crew_request_id uuid,
  target_activation_request_id uuid,
  target_name text,
  target_description text,
  target_challenge_start_date date,
  target_time_zone text,
  target_expected_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  created_crew record;
  activation_payload jsonb;
begin
  if caller_id is null then
    raise exception 'You need to log in to create and start a crew.'
      using errcode = '28000';
  end if;
  if target_expected_actor_id is distinct from caller_id then
    raise exception 'The signed-in account changed. Refresh and try again.'
      using errcode = '40001', detail = 'challenge_activation_actor_changed';
  end if;
  if target_crew_request_id is null or target_activation_request_id is null then
    raise exception 'Crew and activation request IDs are required.'
      using errcode = '22023';
  end if;

  -- Match every crew/activation boundary's global order. These locks are
  -- transaction-scoped and re-entrant when the existing RPCs acquire them.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('single-crew:' || caller_id::text, 821)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('challenge-activation:' || caller_id::text, 1438)
  );
  perform private.lock_challenge_activation_actor(caller_id);

  select created.*
    into strict created_crew
  from public.create_crew(
    target_crew_request_id,
    target_name,
    target_description,
    target_challenge_start_date
  ) created;

  activation_payload := public.activate_group_challenge(
    created_crew.crew_id,
    target_time_zone,
    target_activation_request_id,
    caller_id
  );

  return pg_catalog.jsonb_build_object(
    'crew', pg_catalog.jsonb_build_object(
      'crewId', created_crew.crew_id,
      'name', created_crew.name,
      'description', created_crew.description,
      'challengeStartDate', created_crew.challenge_start_date,
      'createdBy', created_crew.created_by,
      'createdAt', created_crew.created_at,
      'joinedAt', created_crew.joined_at,
      'role', created_crew.role,
      'createdNew', created_crew.created_new
    ),
    'activation', activation_payload
  );
end;
$$;

revoke all on function public.create_crew_and_activate_group(
  uuid, uuid, text, text, date, text, uuid
) from public, anon, authenticated;

grant execute on function public.create_crew_and_activate_group(
  uuid, uuid, text, text, date, text, uuid
) to authenticated;

comment on function public.create_crew_and_activate_group(
  uuid, uuid, text, text, date, text, uuid
) is
  'Atomically creates one owner crew and binds the authenticated actor to its Group challenge date with independent retry-safe request evidence.';
