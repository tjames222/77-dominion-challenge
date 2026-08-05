-- FOU-1441: server-authoritative, resumable site training foundation.
--
-- Page definitions are immutable versioned records. Product-specific content is
-- deliberately registered by later migrations; this migration only establishes
-- the generic lifecycle and its authenticated RPC boundary.

create schema if not exists private;

create or replace function private.site_training_valid_step_ids(target_step_ids text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    pg_catalog.cardinality(target_step_ids) > 0
    and pg_catalog.array_position(target_step_ids, null) is null
    and not exists (
      select 1
      from pg_catalog.unnest(target_step_ids) as step_id(value)
      where step_id.value !~ '^[a-z][a-z0-9._-]{0,79}$'
         or step_id.value <> pg_catalog.btrim(step_id.value)
    )
    and (
      select pg_catalog.count(*) = pg_catalog.count(distinct step_id.value)
      from pg_catalog.unnest(target_step_ids) as step_id(value)
    ),
    false
  );
$$;

create table private.site_training_page_versions (
  page_id text not null
    check (page_id ~ '^[a-z][a-z0-9._-]{0,79}$'),
  content_version integer not null check (content_version > 0),
  canonical_route text not null
    check (canonical_route ~ '^/[A-Za-z0-9][A-Za-z0-9._/-]*$'),
  step_ids text[] not null
    check (private.site_training_valid_step_ids(step_ids)),
  is_current boolean not null default true,
  published_at timestamptz not null default pg_catalog.statement_timestamp(),
  retired_at timestamptz,
  primary key (page_id, content_version),
  check (is_current = (retired_at is null)),
  check (retired_at is null or retired_at >= published_at)
);

create unique index site_training_page_versions_current_page_idx
  on private.site_training_page_versions (page_id)
  where is_current;
create unique index site_training_page_versions_current_route_idx
  on private.site_training_page_versions (canonical_route)
  where is_current;

create table private.site_training_program_versions (
  program_id text not null
    check (program_id ~ '^[a-z][a-z0-9._-]{0,79}$'),
  program_version integer not null check (program_version > 0),
  audience text not null default 'all'
    check (audience in ('all', 'solo', 'group')),
  is_current boolean not null default true,
  published_at timestamptz not null default pg_catalog.statement_timestamp(),
  retired_at timestamptz,
  primary key (program_id, program_version),
  check (is_current = (retired_at is null)),
  check (retired_at is null or retired_at >= published_at)
);

create unique index site_training_program_versions_current_idx
  on private.site_training_program_versions (program_id)
  where is_current;

create table private.site_training_program_pages (
  program_id text not null,
  program_version integer not null,
  page_id text not null,
  page_content_version integer not null,
  page_index integer not null check (page_index >= 0),
  primary key (program_id, program_version, page_id),
  unique (program_id, program_version, page_index),
  foreign key (program_id, program_version)
    references private.site_training_program_versions (program_id, program_version)
    on delete restrict,
  foreign key (page_id, page_content_version)
    references private.site_training_page_versions (page_id, content_version)
    on delete restrict
);

create index site_training_program_pages_page_version_idx
  on private.site_training_program_pages (page_id, page_content_version);

create table private.site_training_page_progress (
  user_id uuid not null references auth.users(id) on delete cascade,
  page_id text not null,
  content_version integer not null,
  status text not null
    check (status in ('not_started', 'in_progress', 'stopped', 'completed')),
  current_step_id text not null,
  current_step_index integer not null check (current_step_index >= 0),
  furthest_step_index integer not null check (furthest_step_index >= 0),
  attempt_number integer not null default 1 check (attempt_number > 0),
  revision bigint not null default 0 check (revision >= 0),
  started_at timestamptz,
  stopped_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default pg_catalog.statement_timestamp(),
  primary key (user_id, page_id, content_version),
  foreign key (page_id, content_version)
    references private.site_training_page_versions (page_id, content_version)
    on delete restrict,
  check (current_step_index <= furthest_step_index),
  check (
    (status = 'not_started' and started_at is null and stopped_at is null and completed_at is null)
    or
    (status = 'in_progress' and started_at is not null and stopped_at is null and completed_at is null)
    or
    (status = 'stopped' and started_at is not null and stopped_at is not null and completed_at is null)
    or
    (status = 'completed' and started_at is not null and stopped_at is null and completed_at is not null)
  )
);

create index site_training_page_progress_page_version_idx
  on private.site_training_page_progress (page_id, content_version);

create table private.site_training_program_progress (
  user_id uuid not null references auth.users(id) on delete cascade,
  program_id text not null,
  program_version integer not null,
  status text not null
    check (status in ('not_started', 'in_progress', 'stopped', 'completed')),
  current_page_id text not null,
  current_page_content_version integer not null,
  current_page_index integer not null check (current_page_index >= 0),
  revision bigint not null default 0 check (revision >= 0),
  started_at timestamptz,
  stopped_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default pg_catalog.statement_timestamp(),
  primary key (user_id, program_id, program_version),
  foreign key (program_id, program_version)
    references private.site_training_program_versions (program_id, program_version)
    on delete restrict,
  foreign key (current_page_id, current_page_content_version)
    references private.site_training_page_versions (page_id, content_version)
    on delete restrict,
  check (
    (status = 'not_started' and started_at is null and stopped_at is null and completed_at is null)
    or
    (status = 'in_progress' and started_at is not null and stopped_at is null and completed_at is null)
    or
    (status = 'stopped' and started_at is not null and stopped_at is not null and completed_at is null)
    or
    (status = 'completed' and started_at is not null and stopped_at is null and completed_at is not null)
  )
);

create index site_training_program_progress_program_idx
  on private.site_training_program_progress (program_id, program_version);
create index site_training_program_progress_current_page_idx
  on private.site_training_program_progress (current_page_id, current_page_content_version);

create table private.site_training_page_completions (
  completion_id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  page_id text not null,
  content_version integer not null,
  attempt_number integer not null check (attempt_number > 0),
  completed_step_id text not null,
  completed_request_id uuid not null unique,
  completed_at timestamptz not null,
  foreign key (page_id, content_version)
    references private.site_training_page_versions (page_id, content_version)
    on delete restrict,
  unique (user_id, page_id, content_version, attempt_number)
);

create index site_training_page_completions_user_page_idx
  on private.site_training_page_completions (user_id, page_id, completed_at desc);
create index site_training_page_completions_page_version_idx
  on private.site_training_page_completions (page_id, content_version);

create or replace function private.reject_site_training_completion_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Site training completion history is immutable.'
    using errcode = '55000';
end;
$$;

create trigger reject_site_training_completion_update
  before update on private.site_training_page_completions
  for each row execute function private.reject_site_training_completion_update();

create table private.site_training_transition_requests (
  request_id uuid primary key,
  actor_id uuid not null references auth.users(id) on delete cascade,
  rpc_kind text not null check (rpc_kind in ('claim', 'transition')),
  scope text not null check (scope in ('page', 'overall')),
  action text not null
    check (action in ('start', 'resume', 'back', 'next', 'stop', 'finish')),
  request_hash bytea not null check (pg_catalog.octet_length(request_hash) = 32),
  result jsonb not null check (pg_catalog.jsonb_typeof(result) = 'object'),
  created_at timestamptz not null default pg_catalog.statement_timestamp()
);

create index site_training_transition_requests_actor_created_idx
  on private.site_training_transition_requests (actor_id, created_at desc);

alter table private.site_training_page_versions enable row level security;
alter table private.site_training_program_versions enable row level security;
alter table private.site_training_program_pages enable row level security;
alter table private.site_training_page_progress enable row level security;
alter table private.site_training_program_progress enable row level security;
alter table private.site_training_page_completions enable row level security;
alter table private.site_training_transition_requests enable row level security;

revoke all on table private.site_training_page_versions
  from public, anon, authenticated, service_role;
revoke all on table private.site_training_program_versions
  from public, anon, authenticated, service_role;
revoke all on table private.site_training_program_pages
  from public, anon, authenticated, service_role;
revoke all on table private.site_training_page_progress
  from public, anon, authenticated, service_role;
revoke all on table private.site_training_program_progress
  from public, anon, authenticated, service_role;
revoke all on table private.site_training_page_completions
  from public, anon, authenticated, service_role;
revoke all on table private.site_training_transition_requests
  from public, anon, authenticated, service_role;
revoke all on sequence private.site_training_page_completions_completion_id_seq
  from public, anon, authenticated, service_role;

grant select on table private.site_training_page_versions,
  private.site_training_program_versions,
  private.site_training_program_pages,
  private.site_training_page_progress,
  private.site_training_program_progress,
  private.site_training_page_completions,
  private.site_training_transition_requests
to service_role;

create or replace function private.site_training_lock_actor(target_actor_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform 1
  from auth.users auth_user
  where auth_user.id = target_actor_id
  for key share;

  if not found then
    raise exception 'The signed-in account no longer exists. Refresh and try again.'
      using errcode = '28000', detail = 'site_training_actor_missing';
  end if;
end;
$$;

create or replace function private.site_training_reconcile_page(
  target_user_id uuid,
  target_page_id text,
  target_content_version integer,
  target_mutation_time timestamptz
)
returns private.site_training_page_progress
language plpgsql
set search_path = ''
as $$
declare
  target_definition private.site_training_page_versions%rowtype;
  exact_progress private.site_training_page_progress%rowtype;
  prior_progress private.site_training_page_progress%rowtype;
  reconciled_index integer;
begin
  select definition.* into target_definition
  from private.site_training_page_versions definition
  where definition.page_id = target_page_id
    and definition.content_version = target_content_version
    and definition.is_current;
  if not found then
    raise exception 'A current published page training version is required.'
      using errcode = '22023', detail = 'site_training_page_version_invalid';
  end if;

  select progress.* into exact_progress
  from private.site_training_page_progress progress
  where progress.user_id = target_user_id
    and progress.page_id = target_page_id
    and progress.content_version = target_content_version
  for update;
  if found then
    return exact_progress;
  end if;

  select progress.* into prior_progress
  from private.site_training_page_progress progress
  where progress.user_id = target_user_id
    and progress.page_id = target_page_id
    and progress.content_version <> target_content_version
    and progress.status in ('in_progress', 'stopped')
  order by progress.updated_at desc, progress.content_version desc
  limit 1
  for update;

  if not found then
    return null::private.site_training_page_progress;
  end if;

  reconciled_index := coalesce(
    pg_catalog.array_position(target_definition.step_ids, prior_progress.current_step_id),
    1
  ) - 1;

  insert into private.site_training_page_progress (
    user_id,
    page_id,
    content_version,
    status,
    current_step_id,
    current_step_index,
    furthest_step_index,
    attempt_number,
    revision,
    started_at,
    stopped_at,
    completed_at,
    updated_at
  ) values (
    target_user_id,
    target_page_id,
    target_content_version,
    'stopped',
    target_definition.step_ids[reconciled_index + 1],
    reconciled_index,
    reconciled_index,
    prior_progress.attempt_number,
    1,
    coalesce(prior_progress.started_at, target_mutation_time),
    target_mutation_time,
    null,
    target_mutation_time
  )
  returning * into exact_progress;

  return exact_progress;
end;
$$;

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

create or replace function private.site_training_overall_payload(
  target_user_id uuid,
  target_program_id text,
  target_program_version integer
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  progress private.site_training_program_progress%rowtype;
  first_page private.site_training_program_pages%rowtype;
begin
  if target_program_id is null and target_program_version is null then
    return null;
  end if;

  select page.* into first_page
  from private.site_training_program_pages page
  where page.program_id = target_program_id
    and page.program_version = target_program_version
  order by page.page_index
  limit 1;
  if not found then
    raise exception 'A published training program with at least one page is required.'
      using errcode = '22023';
  end if;

  select source.* into progress
  from private.site_training_program_progress source
  where source.user_id = target_user_id
    and source.program_id = target_program_id
    and source.program_version = target_program_version;

  return pg_catalog.jsonb_build_object(
    'programId', target_program_id,
    'programVersion', target_program_version,
    'status', case when found then progress.status else 'not_started' end,
    'currentPageId', case when found then progress.current_page_id else first_page.page_id end,
    'currentPageContentVersion',
      case when found then progress.current_page_content_version else first_page.page_content_version end,
    'currentPageIndex', case when found then progress.current_page_index else first_page.page_index end,
    'revision', case when found then progress.revision else 0 end,
    'startedAt', case when found then progress.started_at else null end,
    'stoppedAt', case when found then progress.stopped_at else null end,
    'completedAt', case when found then progress.completed_at else null end,
    'updatedAt', case when found then progress.updated_at else null end
  );
end;
$$;

create or replace function private.site_training_state_payload(
  target_user_id uuid,
  target_page_id text,
  target_content_version integer,
  target_program_id text,
  target_program_version integer,
  target_transition jsonb
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'schemaVersion', 1,
    'actorId', target_user_id,
    'claimedNow', coalesce(
      target_transition ->> 'action' = 'start'
      and (target_transition ->> 'applied')::boolean,
      false
    ),
    'page', private.site_training_page_payload(
      target_user_id,
      target_page_id,
      target_content_version
    ),
    'overall', private.site_training_overall_payload(
      target_user_id,
      target_program_id,
      target_program_version
    ),
    'transition', target_transition
  );
$$;

create or replace function public.get_site_training_state(
  target_page_id text,
  target_page_content_version integer,
  target_program_id text,
  target_program_version integer,
  target_expected_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  mutation_time timestamptz;
begin
  if caller_id is null then
    raise exception 'You need to log in to view site training.' using errcode = '28000';
  end if;
  if target_expected_actor_id is distinct from caller_id then
    raise exception 'The signed-in account changed. Refresh and try again.'
      using errcode = '40001', detail = 'site_training_actor_changed';
  end if;
  if (target_program_id is null) <> (target_program_version is null) then
    raise exception 'Program ID and version must be supplied together.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('site-training:' || caller_id::text, 1441)
  );
  perform private.site_training_lock_actor(caller_id);
  mutation_time := pg_catalog.clock_timestamp();

  perform private.site_training_reconcile_page(
    caller_id,
    target_page_id,
    target_page_content_version,
    mutation_time
  );

  if target_program_id is not null then
    if not exists (
      select 1
      from private.site_training_program_versions program
      join private.site_training_program_pages page
        on page.program_id = program.program_id
       and page.program_version = program.program_version
      where program.program_id = target_program_id
        and program.program_version = target_program_version
        and program.is_current
        and page.page_id = target_page_id
        and page.page_content_version = target_page_content_version
    ) then
      raise exception 'The page is not part of the current training program.'
        using errcode = '22023';
    end if;
  end if;

  return private.site_training_state_payload(
    caller_id,
    target_page_id,
    target_page_content_version,
    target_program_id,
    target_program_version,
    null
  );
end;
$$;

create or replace function private.mutate_site_training(
  target_rpc_kind text,
  target_scope text,
  target_page_id text,
  target_page_content_version integer,
  target_program_id text,
  target_program_version integer,
  target_action text,
  target_request_id uuid,
  target_expected_revision bigint,
  target_expected_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  normalized_rpc_kind text := pg_catalog.lower(pg_catalog.btrim(coalesce(target_rpc_kind, '')));
  normalized_scope text := pg_catalog.lower(pg_catalog.btrim(coalesce(target_scope, '')));
  normalized_action text := pg_catalog.lower(pg_catalog.btrim(coalesce(target_action, '')));
  request_hash bytea;
  prior_request private.site_training_transition_requests%rowtype;
  page_definition private.site_training_page_versions%rowtype;
  page_progress private.site_training_page_progress%rowtype;
  overall_progress private.site_training_program_progress%rowtype;
  expected_program_page private.site_training_program_pages%rowtype;
  next_program_page private.site_training_program_pages%rowtype;
  mutation_time timestamptz;
  current_revision bigint;
  last_step_index integer;
  applied boolean := false;
  page_applied boolean := false;
  response_page_id text := target_page_id;
  response_content_version integer := target_page_content_version;
  transition_payload jsonb;
  result_payload jsonb;
begin
  if caller_id is null then
    raise exception 'You need to log in to update site training.' using errcode = '28000';
  end if;
  if target_expected_actor_id is distinct from caller_id then
    raise exception 'The signed-in account changed. Refresh and try again.'
      using errcode = '40001', detail = 'site_training_actor_changed';
  end if;
  if normalized_rpc_kind not in ('claim', 'transition')
     or normalized_scope not in ('page', 'overall')
     or target_request_id is null
     or target_expected_revision is null
     or target_expected_revision < 0 then
    raise exception 'A valid scope, request ID, and expected revision are required.'
      using errcode = '22023';
  end if;
  if normalized_rpc_kind = 'claim' and normalized_action not in ('start', 'resume') then
    raise exception 'Claim actions must be start or resume.' using errcode = '22023';
  end if;
  if normalized_rpc_kind = 'transition'
     and normalized_action not in ('back', 'next', 'stop', 'finish') then
    raise exception 'Unsupported site training transition.' using errcode = '22023';
  end if;
  if normalized_scope = 'overall'
     and (target_program_id is null or target_program_version is null) then
    raise exception 'Overall training requires a program ID and version.' using errcode = '22023';
  end if;
  if normalized_scope = 'page'
     and ((target_program_id is null) <> (target_program_version is null)) then
    raise exception 'Program ID and version must be supplied together.' using errcode = '22023';
  end if;

  request_hash := extensions.digest(
    pg_catalog.convert_to(
      pg_catalog.jsonb_build_array(
        normalized_rpc_kind,
        normalized_scope,
        target_page_id,
        target_page_content_version,
        target_program_id,
        target_program_version,
        normalized_action,
        target_expected_revision
      )::text,
      'UTF8'
    ),
    'sha256'
  );

  -- All site-training mutations use one user lock. The request lock additionally
  -- serializes the astronomically unlikely case where two accounts reuse one UUID.
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
       or prior_request.rpc_kind <> normalized_rpc_kind
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
  last_step_index := pg_catalog.cardinality(page_definition.step_ids) - 1;

  -- Overall operations lock the overall cursor before the page row. Every RPC
  -- shares the user advisory lock, and this explicit parent-to-child row order
  -- stays safe if later program orchestration introduces additional relations.
  if normalized_scope = 'overall' then
    select program_page.* into expected_program_page
    from private.site_training_program_versions program
    join private.site_training_program_pages program_page
      on program_page.program_id = program.program_id
     and program_page.program_version = program.program_version
    where program.program_id = target_program_id
      and program.program_version = target_program_version
      and program.is_current
    order by program_page.page_index
    limit 1;
    if not found then
      raise exception 'A current training program with at least one page is required.'
        using errcode = '22023';
    end if;

    select progress.* into overall_progress
    from private.site_training_program_progress progress
    where progress.user_id = caller_id
      and progress.program_id = target_program_id
      and progress.program_version = target_program_version
    for update;
    current_revision := case when found then overall_progress.revision else 0 end;

    if found then
      select program_page.* into expected_program_page
      from private.site_training_program_pages program_page
      where program_page.program_id = target_program_id
        and program_page.program_version = target_program_version
        and program_page.page_id = overall_progress.current_page_id
        and program_page.page_content_version = overall_progress.current_page_content_version
        and program_page.page_index = overall_progress.current_page_index;
      if not found then
        raise exception 'Saved overall training points to an invalid program page.'
          using errcode = '55000';
      end if;
    end if;

    if target_expected_revision <> current_revision then
      raise exception 'Site training changed in another session. Refresh and try again.'
        using errcode = '40001', detail = 'site_training_stale_revision';
    end if;
    if target_page_id <> expected_program_page.page_id
       or target_page_content_version <> expected_program_page.page_content_version then
      raise exception 'Overall training moved to another page. Refresh and try again.'
        using errcode = '40001', detail = 'site_training_stale_page';
    end if;
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

  if normalized_scope = 'page' then
    current_revision := case when found then page_progress.revision else 0 end;
    if target_expected_revision <> current_revision then
      raise exception 'Site training changed in another session. Refresh and try again.'
        using errcode = '40001', detail = 'site_training_stale_revision';
    end if;

    if normalized_action = 'start' then
      if not found then
        insert into private.site_training_page_progress (
          user_id, page_id, content_version, status, current_step_id,
          current_step_index, furthest_step_index, attempt_number, revision,
          started_at, stopped_at, completed_at, updated_at
        ) values (
          caller_id, target_page_id, target_page_content_version, 'in_progress',
          page_definition.step_ids[1], 0, 0, 1, 1,
          mutation_time, null, null, mutation_time
        ) returning * into page_progress;
        applied := true;
      elsif page_progress.status = 'not_started' then
        update private.site_training_page_progress
        set status = 'in_progress',
            started_at = mutation_time,
            stopped_at = null,
            revision = revision + 1,
            updated_at = mutation_time
        where user_id = caller_id
          and page_id = target_page_id
          and content_version = target_page_content_version
        returning * into page_progress;
        applied := true;
      elsif page_progress.status <> 'in_progress' then
        raise exception 'Use Resume for stopped training; completed training replays locally.'
          using errcode = '55000';
      end if;

    elsif normalized_action = 'resume' then
      if not found or page_progress.status = 'not_started' then
        raise exception 'Start page training before resuming it.' using errcode = '55000';
      elsif page_progress.status = 'stopped' then
        update private.site_training_page_progress
        set status = 'in_progress',
            stopped_at = null,
            revision = revision + 1,
            updated_at = mutation_time
        where user_id = caller_id
          and page_id = target_page_id
          and content_version = target_page_content_version
        returning * into page_progress;
        applied := true;
      elsif page_progress.status <> 'in_progress' then
        raise exception 'Completed training replays locally without changing history.'
          using errcode = '55000';
      end if;

    elsif normalized_action = 'back' then
      if not found or page_progress.status <> 'in_progress' then
        raise exception 'Start or resume page training before going back.' using errcode = '55000';
      elsif page_progress.current_step_index > 0 then
        update private.site_training_page_progress
        set current_step_index = current_step_index - 1,
            current_step_id = page_definition.step_ids[current_step_index],
            revision = revision + 1,
            updated_at = mutation_time
        where user_id = caller_id
          and page_id = target_page_id
          and content_version = target_page_content_version
        returning * into page_progress;
        applied := true;
      end if;

    elsif normalized_action = 'next' then
      if not found or page_progress.status <> 'in_progress' then
        raise exception 'Start or resume page training before continuing.' using errcode = '55000';
      elsif page_progress.current_step_index >= last_step_index then
        raise exception 'Finish page training from its final step.' using errcode = '55000';
      else
        update private.site_training_page_progress
        set current_step_index = current_step_index + 1,
            current_step_id = page_definition.step_ids[current_step_index + 2],
            furthest_step_index = greatest(
              furthest_step_index,
              current_step_index + 1
            ),
            revision = revision + 1,
            updated_at = mutation_time
        where user_id = caller_id
          and page_id = target_page_id
          and content_version = target_page_content_version
        returning * into page_progress;
        applied := true;
      end if;

    elsif normalized_action = 'stop' then
      if not found or page_progress.status = 'not_started' then
        raise exception 'Start page training before stopping it.' using errcode = '55000';
      elsif page_progress.status = 'in_progress' then
        update private.site_training_page_progress
        set status = 'stopped',
            stopped_at = mutation_time,
            revision = revision + 1,
            updated_at = mutation_time
        where user_id = caller_id
          and page_id = target_page_id
          and content_version = target_page_content_version
        returning * into page_progress;
        applied := true;
      elsif page_progress.status = 'completed' then
        raise exception 'Completed training cannot be stopped.' using errcode = '55000';
      end if;

    else
      if not found
         or page_progress.status <> 'in_progress'
         or page_progress.current_step_index <> last_step_index then
        raise exception 'Reach the final page training step before finishing.' using errcode = '55000';
      end if;
      update private.site_training_page_progress
      set status = 'completed',
          stopped_at = null,
          completed_at = mutation_time,
          revision = revision + 1,
          updated_at = mutation_time
      where user_id = caller_id
        and page_id = target_page_id
        and content_version = target_page_content_version
      returning * into page_progress;
      insert into private.site_training_page_completions (
        user_id, page_id, content_version, attempt_number,
        completed_step_id, completed_request_id, completed_at
      ) values (
        caller_id, target_page_id, target_page_content_version,
        page_progress.attempt_number, page_progress.current_step_id,
        target_request_id, mutation_time
      );
      applied := true;
    end if;

  else
    if normalized_action = 'start' then
      if overall_progress.user_id is null then
        insert into private.site_training_program_progress (
          user_id, program_id, program_version, status, current_page_id,
          current_page_content_version, current_page_index, revision,
          started_at, stopped_at, completed_at, updated_at
        ) values (
          caller_id, target_program_id, target_program_version, 'in_progress',
          target_page_id, target_page_content_version, expected_program_page.page_index,
          1, mutation_time, null, null, mutation_time
        ) returning * into overall_progress;
        applied := true;
      elsif overall_progress.status = 'not_started' then
        update private.site_training_program_progress
        set status = 'in_progress',
            started_at = mutation_time,
            stopped_at = null,
            revision = revision + 1,
            updated_at = mutation_time
        where user_id = caller_id
          and program_id = target_program_id
          and program_version = target_program_version
        returning * into overall_progress;
        applied := true;
      elsif overall_progress.status <> 'in_progress' then
        raise exception 'Use Resume for stopped training; completed training replays locally.'
          using errcode = '55000';
      end if;

      if page_progress.user_id is null then
        insert into private.site_training_page_progress (
          user_id, page_id, content_version, status, current_step_id,
          current_step_index, furthest_step_index, attempt_number, revision,
          started_at, stopped_at, completed_at, updated_at
        ) values (
          caller_id, target_page_id, target_page_content_version, 'in_progress',
          page_definition.step_ids[1], 0, 0, 1, 1,
          mutation_time, null, null, mutation_time
        ) returning * into page_progress;
        page_applied := true;
      elsif page_progress.status = 'not_started' then
        update private.site_training_page_progress
        set status = 'in_progress', started_at = mutation_time, stopped_at = null,
            revision = revision + 1, updated_at = mutation_time
        where user_id = caller_id and page_id = target_page_id
          and content_version = target_page_content_version
        returning * into page_progress;
        page_applied := true;
      elsif page_progress.status = 'stopped' then
        update private.site_training_page_progress
        set status = 'in_progress', stopped_at = null,
            revision = revision + 1, updated_at = mutation_time
        where user_id = caller_id and page_id = target_page_id
          and content_version = target_page_content_version
        returning * into page_progress;
        page_applied := true;
      end if;
      if page_applied and not applied then
        update private.site_training_program_progress
        set revision = revision + 1,
            updated_at = mutation_time
        where user_id = caller_id
          and program_id = target_program_id
          and program_version = target_program_version
        returning * into overall_progress;
      end if;
      applied := applied or page_applied;

    elsif normalized_action = 'resume' then
      if overall_progress.user_id is null or overall_progress.status = 'not_started' then
        raise exception 'Start overall training before resuming it.' using errcode = '55000';
      elsif overall_progress.status = 'stopped' then
        update private.site_training_program_progress
        set status = 'in_progress', stopped_at = null,
            revision = revision + 1, updated_at = mutation_time
        where user_id = caller_id and program_id = target_program_id
          and program_version = target_program_version
        returning * into overall_progress;
        applied := true;
      elsif overall_progress.status <> 'in_progress' then
        raise exception 'Completed training replays locally without changing history.'
          using errcode = '55000';
      end if;
      if page_progress.status = 'stopped' then
        update private.site_training_page_progress
        set status = 'in_progress', stopped_at = null,
            revision = revision + 1, updated_at = mutation_time
        where user_id = caller_id and page_id = target_page_id
          and content_version = target_page_content_version
        returning * into page_progress;
        page_applied := true;
      end if;
      if page_applied and not applied then
        update private.site_training_program_progress
        set revision = revision + 1,
            updated_at = mutation_time
        where user_id = caller_id
          and program_id = target_program_id
          and program_version = target_program_version
        returning * into overall_progress;
      end if;
      applied := applied or page_applied;

    elsif normalized_action = 'back' then
      if overall_progress.status <> 'in_progress'
         or page_progress.status <> 'in_progress' then
        raise exception 'Start or resume overall training before going back.' using errcode = '55000';
      elsif page_progress.current_step_index > 0 then
        update private.site_training_page_progress
        set current_step_index = current_step_index - 1,
            current_step_id = page_definition.step_ids[current_step_index],
            revision = revision + 1, updated_at = mutation_time
        where user_id = caller_id and page_id = target_page_id
          and content_version = target_page_content_version
        returning * into page_progress;
        update private.site_training_program_progress
        set revision = revision + 1, updated_at = mutation_time
        where user_id = caller_id and program_id = target_program_id
          and program_version = target_program_version
        returning * into overall_progress;
        applied := true;
      end if;

    elsif normalized_action = 'next' then
      if overall_progress.status <> 'in_progress'
         or page_progress.status <> 'in_progress' then
        raise exception 'Start or resume overall training before continuing.' using errcode = '55000';
      elsif page_progress.current_step_index >= last_step_index then
        raise exception 'Finish page training from its final step.' using errcode = '55000';
      else
        update private.site_training_page_progress
        set current_step_index = current_step_index + 1,
            current_step_id = page_definition.step_ids[current_step_index + 2],
            furthest_step_index = greatest(furthest_step_index, current_step_index + 1),
            revision = revision + 1, updated_at = mutation_time
        where user_id = caller_id and page_id = target_page_id
          and content_version = target_page_content_version
        returning * into page_progress;
        update private.site_training_program_progress
        set revision = revision + 1, updated_at = mutation_time
        where user_id = caller_id and program_id = target_program_id
          and program_version = target_program_version
        returning * into overall_progress;
        applied := true;
      end if;

    elsif normalized_action = 'stop' then
      if overall_progress.user_id is null or overall_progress.status = 'not_started' then
        raise exception 'Start overall training before stopping it.' using errcode = '55000';
      elsif overall_progress.status = 'in_progress' then
        update private.site_training_program_progress
        set status = 'stopped', stopped_at = mutation_time,
            revision = revision + 1, updated_at = mutation_time
        where user_id = caller_id and program_id = target_program_id
          and program_version = target_program_version
        returning * into overall_progress;
        if page_progress.status = 'in_progress' then
          update private.site_training_page_progress
          set status = 'stopped', stopped_at = mutation_time,
              revision = revision + 1, updated_at = mutation_time
          where user_id = caller_id and page_id = target_page_id
            and content_version = target_page_content_version
          returning * into page_progress;
        end if;
        applied := true;
      elsif overall_progress.status = 'completed' then
        raise exception 'Completed training cannot be stopped.' using errcode = '55000';
      end if;

    else
      if overall_progress.status <> 'in_progress'
         or page_progress.status not in ('in_progress', 'completed')
         or (
           page_progress.status = 'in_progress'
           and page_progress.current_step_index <> last_step_index
         ) then
        raise exception 'Reach the final page training step before finishing.' using errcode = '55000';
      end if;

      if page_progress.status = 'in_progress' then
        update private.site_training_page_progress
        set status = 'completed', stopped_at = null, completed_at = mutation_time,
            revision = revision + 1, updated_at = mutation_time
        where user_id = caller_id and page_id = target_page_id
          and content_version = target_page_content_version
        returning * into page_progress;
        insert into private.site_training_page_completions (
          user_id, page_id, content_version, attempt_number,
          completed_step_id, completed_request_id, completed_at
        ) values (
          caller_id, target_page_id, target_page_content_version,
          page_progress.attempt_number, page_progress.current_step_id,
          target_request_id, mutation_time
        );
      end if;

      select program_page.* into next_program_page
      from private.site_training_program_pages program_page
      where program_page.program_id = target_program_id
        and program_page.program_version = target_program_version
        and program_page.page_index = expected_program_page.page_index + 1;
      if found then
        update private.site_training_program_progress
        set current_page_id = next_program_page.page_id,
            current_page_content_version = next_program_page.page_content_version,
            current_page_index = next_program_page.page_index,
            revision = revision + 1,
            updated_at = mutation_time
        where user_id = caller_id and program_id = target_program_id
          and program_version = target_program_version
        returning * into overall_progress;
        perform private.site_training_reconcile_page(
          caller_id,
          next_program_page.page_id,
          next_program_page.page_content_version,
          mutation_time
        );
        response_page_id := next_program_page.page_id;
        response_content_version := next_program_page.page_content_version;
      else
        update private.site_training_program_progress
        set status = 'completed', stopped_at = null, completed_at = mutation_time,
            revision = revision + 1, updated_at = mutation_time
        where user_id = caller_id and program_id = target_program_id
          and program_version = target_program_version
        returning * into overall_progress;
      end if;
      applied := true;
    end if;
  end if;

  transition_payload := pg_catalog.jsonb_build_object(
    'action', normalized_action,
    'scope', normalized_scope,
    'applied', applied
  );
  if normalized_scope = 'overall' and normalized_action = 'finish' then
    transition_payload := transition_payload || pg_catalog.jsonb_build_object(
      'completedPageId', target_page_id,
      'nextRoute', case
        when response_page_id = target_page_id then null
        else (
          select definition.canonical_route
          from private.site_training_page_versions definition
          where definition.page_id = response_page_id
            and definition.content_version = response_content_version
        )
      end
    );
  end if;

  result_payload := private.site_training_state_payload(
    caller_id,
    response_page_id,
    response_content_version,
    target_program_id,
    target_program_version,
    transition_payload
  );

  insert into private.site_training_transition_requests (
    request_id, actor_id, rpc_kind, scope, action, request_hash, result, created_at
  ) values (
    target_request_id, caller_id, normalized_rpc_kind, normalized_scope,
    normalized_action, request_hash, result_payload, mutation_time
  );

  return result_payload;
end;
$$;

create or replace function public.claim_site_training(
  target_scope text,
  target_page_id text,
  target_page_content_version integer,
  target_program_id text,
  target_program_version integer,
  target_action text,
  target_request_id uuid,
  target_expected_revision bigint,
  target_expected_actor_id uuid
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.mutate_site_training(
    'claim',
    target_scope,
    target_page_id,
    target_page_content_version,
    target_program_id,
    target_program_version,
    target_action,
    target_request_id,
    target_expected_revision,
    target_expected_actor_id
  );
$$;

create or replace function public.transition_site_training(
  target_scope text,
  target_page_id text,
  target_page_content_version integer,
  target_program_id text,
  target_program_version integer,
  target_action text,
  target_request_id uuid,
  target_expected_revision bigint,
  target_expected_actor_id uuid
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.mutate_site_training(
    'transition',
    target_scope,
    target_page_id,
    target_page_content_version,
    target_program_id,
    target_program_version,
    target_action,
    target_request_id,
    target_expected_revision,
    target_expected_actor_id
  );
$$;

revoke all on function private.site_training_valid_step_ids(text[])
  from public, anon, authenticated, service_role;
revoke all on function private.reject_site_training_completion_update()
  from public, anon, authenticated, service_role;
revoke all on function private.site_training_lock_actor(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.site_training_reconcile_page(uuid, text, integer, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function private.site_training_page_payload(uuid, text, integer)
  from public, anon, authenticated, service_role;
revoke all on function private.site_training_overall_payload(uuid, text, integer)
  from public, anon, authenticated, service_role;
revoke all on function private.site_training_state_payload(uuid, text, integer, text, integer, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.mutate_site_training(
  text, text, text, integer, text, integer, text, uuid, bigint, uuid
) from public, anon, authenticated, service_role;

revoke all on function public.get_site_training_state(text, integer, text, integer, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.claim_site_training(
  text, text, integer, text, integer, text, uuid, bigint, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.transition_site_training(
  text, text, integer, text, integer, text, uuid, bigint, uuid
) from public, anon, authenticated, service_role;

grant execute on function public.get_site_training_state(text, integer, text, integer, uuid)
  to authenticated;
grant execute on function public.claim_site_training(
  text, text, integer, text, integer, text, uuid, bigint, uuid
) to authenticated;
grant execute on function public.transition_site_training(
  text, text, integer, text, integer, text, uuid, bigint, uuid
) to authenticated;
