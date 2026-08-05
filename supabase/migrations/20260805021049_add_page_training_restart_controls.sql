-- FOU-1444: expose attempt parity and add an explicit page-only restart.
-- Restart begins a fresh attempt for unfinished current content without
-- mutating overall-program progress or immutable completion evidence.

alter table private.site_training_transition_requests
  drop constraint site_training_transition_requests_action_check;
alter table private.site_training_transition_requests
  add constraint site_training_transition_requests_action_check
  check (action in ('start', 'resume', 'restart', 'back', 'next', 'stop', 'finish'));

update private.site_training_transition_requests request
set result = pg_catalog.jsonb_set(
  request.result,
  '{page,attemptNumber}',
  pg_catalog.to_jsonb(
    case
      when request.result #>> '{page,status}' = 'not_started' then 0
      else 1
    end
  ),
  true
)
where request.result #> '{page,attemptNumber}' is null;

create or replace function private.site_training_page_payload(
  target_user_id uuid,
  target_page_id text,
  target_content_version integer
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  definition private.site_training_page_versions%rowtype;
  progress private.site_training_page_progress%rowtype;
  completion_count integer;
  has_progress boolean := false;
begin
  select source.* into definition
  from private.site_training_page_versions source
  where source.page_id = target_page_id
    and source.content_version = target_content_version;
  if not found then
    raise exception 'A published page training version is required.'
      using errcode = '22023';
  end if;

  select source.* into progress
  from private.site_training_page_progress source
  where source.user_id = target_user_id
    and source.page_id = target_page_id
    and source.content_version = target_content_version;
  has_progress := found;

  select pg_catalog.count(*)::integer into completion_count
  from private.site_training_page_completions completion
  where completion.user_id = target_user_id
    and completion.page_id = target_page_id;

  return pg_catalog.jsonb_build_object(
    'pageId', target_page_id,
    'route', definition.canonical_route,
    'contentVersion', target_content_version,
    'stepIds', pg_catalog.to_jsonb(definition.step_ids),
    'status', case when has_progress then progress.status else 'not_started' end,
    'currentStepId', case when has_progress then progress.current_step_id else definition.step_ids[1] end,
    'currentStepIndex', case when has_progress then progress.current_step_index else 0 end,
    'furthestStepIndex', case when has_progress then progress.furthest_step_index else 0 end,
    'attemptNumber', case when has_progress then progress.attempt_number else 0 end,
    'revision', case when has_progress then progress.revision else 0 end,
    'startedAt', case when has_progress then progress.started_at else null end,
    'stoppedAt', case when has_progress then progress.stopped_at else null end,
    'completedAt', case when has_progress then progress.completed_at else null end,
    'updatedAt', case when has_progress then progress.updated_at else null end,
    'everCompleted', completion_count > 0,
    'completionCount', completion_count
  );
end;
$$;

revoke all on function private.site_training_page_payload(uuid, text, integer)
  from public, anon, authenticated, service_role;

create or replace function private.restart_site_training_page(
  target_scope text,
  target_page_id text,
  target_page_content_version integer,
  target_program_id text,
  target_program_version integer,
  target_action text,
  target_request_id uuid,
  target_expected_revision bigint,
  target_expected_page_revision bigint,
  target_expected_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  normalized_scope text := pg_catalog.lower(pg_catalog.btrim(coalesce(target_scope, '')));
  normalized_action text := pg_catalog.lower(pg_catalog.btrim(coalesce(target_action, '')));
  request_hash bytea;
  prior_request private.site_training_transition_requests%rowtype;
  page_definition private.site_training_page_versions%rowtype;
  page_progress private.site_training_page_progress%rowtype;
  mutation_time timestamptz;
  has_progress boolean := false;
  result_payload jsonb;
begin
  if caller_id is null then
    raise exception 'You need to log in to update site training.' using errcode = '28000';
  end if;
  if target_expected_actor_id is distinct from caller_id then
    raise exception 'The signed-in account changed. Refresh and try again.'
      using errcode = '40001', detail = 'site_training_actor_changed';
  end if;
  if normalized_scope <> 'page' or normalized_action <> 'restart' then
    raise exception 'Restart is available only for current page training.'
      using errcode = '22023', detail = 'site_training_restart_scope_invalid';
  end if;
  if target_request_id is null
     or target_expected_revision is null
     or target_expected_revision < 0
     or target_expected_page_revision is null
     or target_expected_page_revision < 0 then
    raise exception 'A valid request ID and expected page revisions are required.'
      using errcode = '22023';
  end if;
  if (target_program_id is null) <> (target_program_version is null) then
    raise exception 'Program ID and version must be supplied together.' using errcode = '22023';
  end if;

  request_hash := extensions.digest(
    pg_catalog.convert_to(
      pg_catalog.jsonb_build_array(
        'transition',
        normalized_scope,
        target_page_id,
        target_page_content_version,
        target_program_id,
        target_program_version,
        normalized_action,
        target_expected_revision,
        target_expected_page_revision
      )::text,
      'UTF8'
    ),
    'sha256'
  );

  -- Match the framework's actor -> request -> auth parent -> progress order so
  -- restart serializes with every existing page and overall transition.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('site-training:' || caller_id::text, 1441)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('site-training-request:' || target_request_id::text, 1441)
  );
  perform private.site_training_lock_actor(caller_id);

  select request.* into prior_request
  from private.site_training_transition_requests request
  where request.request_id = target_request_id;
  if found then
    if prior_request.actor_id <> caller_id
       or prior_request.rpc_kind <> 'transition'
       or prior_request.scope <> normalized_scope
       or prior_request.action <> normalized_action
       or prior_request.request_hash <> request_hash then
      raise exception 'This request ID was already used for another operation.'
        using errcode = '23505', detail = 'site_training_request_collision';
    end if;
    return prior_request.result;
  end if;

  mutation_time := pg_catalog.clock_timestamp();
  select definition.* into page_definition
  from private.site_training_page_versions definition
  where definition.page_id = target_page_id
    and definition.content_version = target_page_content_version
    and definition.is_current;
  if not found then
    raise exception 'A current published page training version is required.'
      using errcode = '22023', detail = 'site_training_page_version_invalid';
  end if;

  perform private.site_training_reconcile_page(
    caller_id,
    target_page_id,
    target_page_content_version,
    mutation_time
  );
  select progress.* into page_progress
  from private.site_training_page_progress progress
  where progress.user_id = caller_id
    and progress.page_id = target_page_id
    and progress.content_version = target_page_content_version
  for update;
  has_progress := found;

  if target_expected_revision <> (case when has_progress then page_progress.revision else 0 end)
     or target_expected_page_revision <> (case when has_progress then page_progress.revision else 0 end) then
    raise exception 'Site training changed in another session. Refresh and try again.'
      using errcode = '40001', detail = 'site_training_stale_revision';
  end if;
  if not has_progress or page_progress.status not in ('in_progress', 'stopped') then
    raise exception 'Only unfinished page training can be restarted.' using errcode = '55000';
  end if;

  update private.site_training_page_progress
  set status = 'in_progress',
      current_step_id = page_definition.step_ids[1],
      current_step_index = 0,
      furthest_step_index = 0,
      attempt_number = attempt_number + 1,
      revision = revision + 1,
      started_at = mutation_time,
      stopped_at = null,
      completed_at = null,
      updated_at = mutation_time
  where user_id = caller_id
    and page_id = target_page_id
    and content_version = target_page_content_version
  returning * into page_progress;

  result_payload := private.site_training_state_payload(
    caller_id,
    target_page_id,
    target_page_content_version,
    target_program_id,
    target_program_version,
    pg_catalog.jsonb_build_object(
      'action', 'restart',
      'scope', 'page',
      'applied', true
    )
  );

  insert into private.site_training_transition_requests (
    request_id, actor_id, rpc_kind, scope, action, request_hash, result, created_at
  ) values (
    target_request_id, caller_id, 'transition', 'page', 'restart',
    request_hash, result_payload, mutation_time
  );

  return result_payload;
end;
$$;

revoke all on function private.restart_site_training_page(
  text, text, integer, text, integer, text, uuid, bigint, bigint, uuid
) from public, anon, authenticated, service_role;

create or replace function public.transition_site_training(
  target_scope text,
  target_page_id text,
  target_page_content_version integer,
  target_program_id text,
  target_program_version integer,
  target_action text,
  target_request_id uuid,
  target_expected_revision bigint,
  target_expected_page_revision bigint,
  target_expected_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if pg_catalog.lower(pg_catalog.btrim(coalesce(target_action, ''))) = 'restart' then
    return private.restart_site_training_page(
      target_scope,
      target_page_id,
      target_page_content_version,
      target_program_id,
      target_program_version,
      target_action,
      target_request_id,
      target_expected_revision,
      target_expected_page_revision,
      target_expected_actor_id
    );
  end if;

  return private.mutate_site_training(
    'transition',
    target_scope,
    target_page_id,
    target_page_content_version,
    target_program_id,
    target_program_version,
    target_action,
    target_request_id,
    target_expected_revision,
    target_expected_page_revision,
    target_expected_actor_id
  );
end;
$$;

revoke all on function public.transition_site_training(
  text, text, integer, text, integer, text, uuid, bigint, bigint, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.transition_site_training(
  text, text, integer, text, integer, text, uuid, bigint, bigint, uuid
) to authenticated;

comment on function private.restart_site_training_page(
  text, text, integer, text, integer, text, uuid, bigint, bigint, uuid
) is 'Starts a fresh attempt for unfinished current page training without mutating overall progress or completion evidence.';
