-- FOU-1438: make challenge activation an explicit, server-owned lifecycle.
-- Existing challenge history remains authoritative; new accounts start inert.

set local lock_timeout = '10s';
set local statement_timeout = '120s';

-- Account erasure always takes this advisory lock before deleting auth users
-- and cascading into profiles. Preserve that hierarchy before the migration
-- requests the profiles schema lock, then freeze the auth parent set so the
-- legacy evidence snapshot cannot race an out-of-band auth deletion.
select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('retired-community-deletion', 0)
);
lock table auth.users in share mode;

alter table public.profiles
  add column if not exists challenge_activation_status text not null default 'not_started',
  add column if not exists challenge_participation_mode text,
  add column if not exists challenge_activation_time_zone text,
  add column if not exists challenge_group_attribution_crew_id uuid,
  add column if not exists challenge_activated_at timestamptz,
  add column if not exists challenge_confirmed_at timestamptz,
  add column if not exists challenge_activated_by uuid,
  add column if not exists challenge_confirmed_by uuid,
  add column if not exists challenge_activation_request_id uuid,
  add column if not exists challenge_activation_schema_version integer not null default 1,
  add column if not exists challenge_activation_revision bigint not null default 0,
  add column if not exists challenge_activation_review_required boolean not null default false,
  add column if not exists challenge_activation_updated_at timestamptz;

alter table public.profiles
  drop constraint if exists profiles_challenge_activation_status_check,
  drop constraint if exists profiles_challenge_participation_mode_check,
  drop constraint if exists profiles_challenge_activation_schema_version_check,
  drop constraint if exists profiles_challenge_activation_revision_check,
  drop constraint if exists profiles_challenge_activation_shape_check;

alter table public.profiles
  add constraint profiles_challenge_activation_status_check
    check (challenge_activation_status in ('not_started', 'scheduled', 'active')),
  add constraint profiles_challenge_participation_mode_check
    check (challenge_participation_mode is null or challenge_participation_mode in ('solo', 'group')),
  add constraint profiles_challenge_activation_schema_version_check
    check (challenge_activation_schema_version >= 1),
  add constraint profiles_challenge_activation_revision_check
    check (challenge_activation_revision >= 0),
  add constraint profiles_challenge_activation_shape_check
    check (
      (
        challenge_activation_status = 'not_started'
        and challenge_participation_mode is null
        and challenge_start_date is null
        and challenge_activation_time_zone is null
        and challenge_group_attribution_crew_id is null
        and challenge_activated_at is null
        and challenge_confirmed_at is null
        and challenge_activated_by is null
        and challenge_confirmed_by is null
        and challenge_activation_request_id is null
      )
      or (
        challenge_activation_status = 'scheduled'
        and challenge_participation_mode in ('solo', 'group')
        and challenge_start_date is not null
        and pg_catalog.isfinite(challenge_start_date)
        and challenge_start_date between date '0001-01-01' and date '9999-12-31'
        and challenge_activation_time_zone is not null
        and challenge_activated_at is null
        and challenge_confirmed_at is not null
        and pg_catalog.isfinite(challenge_confirmed_at)
        and challenge_confirmed_at between
          timestamptz '0001-01-01 00:00:00+00'
          and timestamptz '9999-12-31 23:59:59.999999+00'
        and challenge_activated_by is null
        and challenge_confirmed_by is not null
        and (
          (challenge_participation_mode = 'solo' and challenge_group_attribution_crew_id is null)
          or
          (challenge_participation_mode = 'group' and challenge_group_attribution_crew_id is not null)
        )
      )
      or (
        challenge_activation_status = 'active'
        and challenge_participation_mode in ('solo', 'group')
        and challenge_start_date is not null
        and pg_catalog.isfinite(challenge_start_date)
        and challenge_start_date between date '0001-01-01' and date '9999-12-31'
        and challenge_activation_time_zone is not null
        and challenge_activated_at is not null
        and pg_catalog.isfinite(challenge_activated_at)
        and challenge_activated_at between
          timestamptz '0001-01-01 00:00:00+00'
          and timestamptz '9999-12-31 23:59:59.999999+00'
        and challenge_confirmed_at is not null
        and pg_catalog.isfinite(challenge_confirmed_at)
        and challenge_confirmed_at between
          timestamptz '0001-01-01 00:00:00+00'
          and timestamptz '9999-12-31 23:59:59.999999+00'
        and challenge_activated_by is not null
        and challenge_confirmed_by is not null
        and (
          (challenge_participation_mode = 'solo' and challenge_group_attribution_crew_id is null)
          or
          (challenge_participation_mode = 'group' and challenge_group_attribution_crew_id is not null)
        )
      )
    ) not valid;

create table if not exists private.challenge_activation_requests (
  request_id uuid primary key,
  actor_id uuid not null references auth.users(id) on delete cascade,
  action text not null check (action in ('solo_activate', 'group_activate', 'date_update')),
  request_hash bytea not null check (octet_length(request_hash) = 32),
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  created_at timestamptz not null default pg_catalog.statement_timestamp()
);

create index if not exists challenge_activation_requests_actor_created_idx
  on private.challenge_activation_requests (actor_id, created_at desc);

create table if not exists private.challenge_activation_migration_reviews (
  user_id uuid primary key references auth.users(id) on delete cascade,
  reasons text[] not null check (cardinality(reasons) > 0),
  evidence jsonb not null check (jsonb_typeof(evidence) = 'object'),
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  resolved_at timestamptz,
  resolved_by uuid,
  resolution_note text,
  check ((resolved_at is null) = (resolved_by is null))
);

alter table private.challenge_activation_requests enable row level security;
alter table private.challenge_activation_migration_reviews enable row level security;

revoke all on table private.challenge_activation_requests
  from public, anon, authenticated, service_role;
revoke all on table private.challenge_activation_migration_reviews
  from public, anon, authenticated, service_role;
grant select on table private.challenge_activation_requests to service_role;
grant select, update on table private.challenge_activation_migration_reviews to service_role;

-- This prelaunch cutover is intentionally atomic. Deployment must quiesce all
-- application and worker writers first. EXCLUSIVE then drains pre-existing row
-- lockers and blocks new writers while preserving ordinary SELECT availability.
-- A lock_timeout aborts and rolls back the whole migration; retry only after
-- finding and draining the remaining writer. Keep this order aligned with the
-- mature RPC and retention lock hierarchy, and capture the clock only afterward.
lock table
  public.challenge_entries,
  public.check_ins,
  public.crews,
  private.retired_community_dr_quarantined_crews,
  public.crew_members,
  public.crew_invite_attributions,
  private.crew_lifecycle_requests,
  public.user_game_stats,
  public.game_point_events,
  public.user_reward_entitlements,
  public.user_badges
in exclusive mode;

-- The deployed trigger correctly freezes dates after a check-in, but a legacy
-- contradiction must be repairable inside this one migration. The surrounding
-- transaction already holds the profiles schema lock; recreate the same trigger
-- immediately after the deterministic backfill.
drop trigger if exists lock_challenge_start_date_after_check_in on public.profiles;

create temporary table challenge_activation_migration_clock
on commit drop
as
select pg_catalog.statement_timestamp() as authoritative_at;

-- Build one deterministic evidence row before mutating profiles. An existing
-- profile date wins because it was the deployed authority. Check-ins are next,
-- followed by an existing crew date, then timestamped activity. Any conflict
-- is retained for remediation instead of rewriting history destructively.
create temporary table challenge_activation_legacy_backfill
on commit drop
as
with evidence_users_raw as (
  select profile.user_id
  from public.profiles profile
  where profile.challenge_start_date is not null
  union
  select check_in.user_id from public.check_ins check_in
  union
  select draft.user_id from public.challenge_entries draft
  union
  select member_row.user_id
  from public.crew_members member_row
  where not exists (
    select 1
    from private.retired_community_dr_quarantined_crews quarantine
    where quarantine.crew_id = member_row.crew_id
  )
  union
  select attribution.recipient_user_id
  from public.crew_invite_attributions attribution
  where not exists (
    select 1
    from private.retired_community_dr_quarantined_crews quarantine
    where quarantine.crew_id = attribution.crew_id
  )
  union
  select crew_row.created_by
  from public.crews crew_row
  where not exists (
    select 1
    from private.retired_community_dr_quarantined_crews quarantine
    where quarantine.crew_id = crew_row.id
  )
  union
  select request_row.actor_id
  from private.crew_lifecycle_requests request_row
  where request_row.action in ('create', 'delete', 'leave')
    and not exists (
      select 1
      from private.retired_community_dr_quarantined_crews quarantine
      where quarantine.crew_id = request_row.crew_id
    )
  union
  select stats.user_id
  from public.user_game_stats stats
  where stats.total_points > 0
     or stats.challenge_points > 0
     or stats.current_app_streak > 0
     or stats.best_app_streak > 0
     or stats.current_full_day_streak > 0
     or stats.best_full_day_streak > 0
     or stats.last_seen_date is not null
     or stats.last_full_day_date is not null
  union
  select point_event.user_id from public.game_point_events point_event
  union
  select badge.user_id from public.user_badges badge
  union
  select reward.user_id from public.user_reward_entitlements reward
), evidence_users as (
  select evidence.user_id
  from evidence_users_raw evidence
  where evidence.user_id is not null
    and exists (
      select 1
      from auth.users auth_user
      where auth_user.id = evidence.user_id
    )
), check_in_normalized as (
  select
    check_in.user_id,
    case
      when pg_catalog.isfinite(check_in.entry_date)
        and check_in.entry_date between date '0001-01-01' and date '9999-12-31'
        and check_in.challenge_day between 1 and 77
      then case
        when check_in.entry_date - (check_in.challenge_day - 1)
          between date '0001-01-01' and date '9999-12-31'
          then check_in.entry_date - (check_in.challenge_day - 1)
      end
    end as inferred_start_date,
    case
      when pg_catalog.isfinite(check_in.created_at)
        and check_in.created_at between
          timestamptz '0001-01-01 00:00:00+00'
          and timestamptz '9999-12-31 23:59:59.999999+00'
        then check_in.created_at
    end as activity_at,
    case
      when not pg_catalog.isfinite(check_in.entry_date)
        or check_in.entry_date not between date '0001-01-01' and date '9999-12-31'
        or check_in.challenge_day not between 1 and 77
        then true
      else check_in.entry_date - (check_in.challenge_day - 1)
        not between date '0001-01-01' and date '9999-12-31'
    end as invalid_start_evidence,
    not (
      pg_catalog.isfinite(check_in.created_at)
      and check_in.created_at between
        timestamptz '0001-01-01 00:00:00+00'
        and timestamptz '9999-12-31 23:59:59.999999+00'
    ) as invalid_activity_timestamp
  from public.check_ins check_in
), check_in_evidence as (
  select
    check_in.user_id,
    min(check_in.inferred_start_date) as first_start_date,
    max(check_in.inferred_start_date) as last_start_date,
    count(distinct check_in.inferred_start_date)::integer as start_date_count,
    min(check_in.activity_at) as first_activity_at,
    count(*)::integer as check_in_count,
    count(*) filter (where check_in.invalid_start_evidence)::integer
      as invalid_start_evidence_count,
    count(*) filter (where check_in.invalid_activity_timestamp)::integer
      as invalid_activity_timestamp_count
  from check_in_normalized check_in
  group by check_in.user_id
), draft_evidence as (
  select
    draft.user_id,
    count(*)::integer as draft_count,
    min(draft.entry_date) filter (
      where pg_catalog.isfinite(draft.entry_date)
        and draft.entry_date between date '0001-01-01' and date '9999-12-31'
    ) as first_entry_date,
    min(draft.created_at) filter (
      where pg_catalog.isfinite(draft.created_at)
        and draft.created_at between
          timestamptz '0001-01-01 00:00:00+00'
          and timestamptz '9999-12-31 23:59:59.999999+00'
    ) as first_activity_at,
    count(*) filter (
      where not pg_catalog.isfinite(draft.entry_date)
        or draft.entry_date not between date '0001-01-01' and date '9999-12-31'
    )::integer as invalid_entry_date_count,
    count(*) filter (
      where not pg_catalog.isfinite(draft.created_at)
        or draft.created_at not between
          timestamptz '0001-01-01 00:00:00+00'
          and timestamptz '9999-12-31 23:59:59.999999+00'
    )::integer as invalid_activity_timestamp_count
  from public.challenge_entries draft
  group by draft.user_id
), group_sources as (
  select
    member_row.user_id,
    member_row.crew_id,
    1 as source_priority,
    case when pg_catalog.isfinite(member_row.joined_at)
      and member_row.joined_at between
        timestamptz '0001-01-01 00:00:00+00'
        and timestamptz '9999-12-31 23:59:59.999999+00'
      then member_row.joined_at end as evidenced_at,
    case when pg_catalog.isfinite(member_row.joined_at)
      and member_row.joined_at between
        timestamptz '0001-01-01 00:00:00+00'
        and timestamptz '9999-12-31 23:59:59.999999+00'
      then 0 else 1 end as invalid_evidence_timestamp_count
  from public.crew_members member_row
  join public.crews crew_row on crew_row.id = member_row.crew_id
  where crew_row.deleted_at is null
  union all
  select
    attribution.recipient_user_id,
    attribution.crew_id,
    2 as source_priority,
    case when pg_catalog.isfinite(attribution.created_at)
      and attribution.created_at between
        timestamptz '0001-01-01 00:00:00+00'
        and timestamptz '9999-12-31 23:59:59.999999+00'
      then attribution.created_at end as evidenced_at,
    case when pg_catalog.isfinite(attribution.created_at)
      and attribution.created_at between
        timestamptz '0001-01-01 00:00:00+00'
        and timestamptz '9999-12-31 23:59:59.999999+00'
      then 0 else 1 end as invalid_evidence_timestamp_count
  from public.crew_invite_attributions attribution
  union all
  select
    crew_row.created_by,
    crew_row.id,
    3 as source_priority,
    case when pg_catalog.isfinite(crew_row.created_at)
      and crew_row.created_at between
        timestamptz '0001-01-01 00:00:00+00'
        and timestamptz '9999-12-31 23:59:59.999999+00'
      then crew_row.created_at end as evidenced_at,
    case when pg_catalog.isfinite(crew_row.created_at)
      and crew_row.created_at between
        timestamptz '0001-01-01 00:00:00+00'
        and timestamptz '9999-12-31 23:59:59.999999+00'
      then 0 else 1 end as invalid_evidence_timestamp_count
  from public.crews crew_row
  where crew_row.created_by is not null
  union all
  select
    request_row.actor_id,
    request_row.crew_id,
    4 as source_priority,
    case when pg_catalog.isfinite(request_row.created_at)
      and request_row.created_at between
        timestamptz '0001-01-01 00:00:00+00'
        and timestamptz '9999-12-31 23:59:59.999999+00'
      then request_row.created_at end as evidenced_at,
    case when pg_catalog.isfinite(request_row.created_at)
      and request_row.created_at between
        timestamptz '0001-01-01 00:00:00+00'
        and timestamptz '9999-12-31 23:59:59.999999+00'
      then 0 else 1 end as invalid_evidence_timestamp_count
  from private.crew_lifecycle_requests request_row
  where request_row.action in ('create', 'delete', 'leave')
), group_distinct as (
  select
    source.user_id,
    source.crew_id,
    min(source.evidenced_at) as group_evidenced_at,
    min(source.source_priority) as source_priority,
    min(source.evidenced_at) as evidenced_at,
    sum(source.invalid_evidence_timestamp_count)::integer
      as invalid_evidence_timestamp_count
  from group_sources source
  group by source.user_id, source.crew_id
), group_ranked as (
  select
    source.user_id,
    source.crew_id,
    source.group_evidenced_at,
    crew_row.challenge_start_date as recorded_challenge_start_date,
    case when pg_catalog.isfinite(crew_row.challenge_start_date)
      and crew_row.challenge_start_date between date '0001-01-01' and date '9999-12-31'
      then crew_row.challenge_start_date end as challenge_start_date,
    count(*) over (partition by source.user_id)::integer as group_count,
    sum(source.invalid_evidence_timestamp_count)
      over (partition by source.user_id)::integer as invalid_evidence_timestamp_count,
    row_number() over (
      partition by source.user_id
      order by
        source.source_priority,
        source.evidenced_at is null,
        source.evidenced_at,
        source.crew_id
    ) as group_rank
  from group_distinct source
  join public.crews crew_row on crew_row.id = source.crew_id
  where not exists (
    select 1
    from private.retired_community_dr_quarantined_crews quarantine
    where quarantine.crew_id = source.crew_id
  )
), group_evidence as (
  select
    user_id,
    crew_id,
    group_evidenced_at,
    recorded_challenge_start_date,
    challenge_start_date,
    group_count,
    invalid_evidence_timestamp_count
  from group_ranked
  where group_rank = 1
), point_evidence as (
  select
    point_event.user_id,
    count(*)::integer as point_event_count,
    min(point_event.entry_date) filter (
      where pg_catalog.isfinite(point_event.entry_date)
        and point_event.entry_date between date '0001-01-01' and date '9999-12-31'
    ) as first_entry_date,
    min(point_event.created_at) filter (
      where pg_catalog.isfinite(point_event.created_at)
        and point_event.created_at between
          timestamptz '0001-01-01 00:00:00+00'
          and timestamptz '9999-12-31 23:59:59.999999+00'
    ) as first_activity_at,
    count(*) filter (
      where point_event.entry_date is not null
        and (
          not pg_catalog.isfinite(point_event.entry_date)
          or point_event.entry_date not between date '0001-01-01' and date '9999-12-31'
        )
    )::integer as invalid_entry_date_count,
    count(*) filter (
      where not pg_catalog.isfinite(point_event.created_at)
        or point_event.created_at not between
          timestamptz '0001-01-01 00:00:00+00'
          and timestamptz '9999-12-31 23:59:59.999999+00'
    )::integer as invalid_activity_timestamp_count
  from public.game_point_events point_event
  group by point_event.user_id
), badge_evidence as (
  select
    badge.user_id,
    count(*)::integer as badge_count,
    min(badge.entry_date) filter (
      where pg_catalog.isfinite(badge.entry_date)
        and badge.entry_date between date '0001-01-01' and date '9999-12-31'
    ) as first_entry_date,
    min(badge.earned_at) filter (
      where pg_catalog.isfinite(badge.earned_at)
        and badge.earned_at between
          timestamptz '0001-01-01 00:00:00+00'
          and timestamptz '9999-12-31 23:59:59.999999+00'
    ) as first_activity_at,
    count(*) filter (
      where badge.entry_date is not null
        and (
          not pg_catalog.isfinite(badge.entry_date)
          or badge.entry_date not between date '0001-01-01' and date '9999-12-31'
        )
    )::integer as invalid_entry_date_count,
    count(*) filter (
      where not pg_catalog.isfinite(badge.earned_at)
        or badge.earned_at not between
          timestamptz '0001-01-01 00:00:00+00'
          and timestamptz '9999-12-31 23:59:59.999999+00'
    )::integer as invalid_activity_timestamp_count
  from public.user_badges badge
  group by badge.user_id
), reward_evidence as (
  select
    reward.user_id,
    count(*)::integer as reward_count,
    min(reward.owned_at) filter (
      where pg_catalog.isfinite(reward.owned_at)
        and reward.owned_at between
          timestamptz '0001-01-01 00:00:00+00'
          and timestamptz '9999-12-31 23:59:59.999999+00'
    ) as first_activity_at,
    count(*) filter (
      where not pg_catalog.isfinite(reward.owned_at)
        or reward.owned_at not between
          timestamptz '0001-01-01 00:00:00+00'
          and timestamptz '9999-12-31 23:59:59.999999+00'
    )::integer as invalid_activity_timestamp_count
  from public.user_reward_entitlements reward
  group by reward.user_id
), gathered_raw as (
  select
    evidence_user.user_id,
    migration_clock.authoritative_at,
    profile.challenge_start_date as recorded_profile_start_date,
    case when pg_catalog.isfinite(profile.challenge_start_date)
      and profile.challenge_start_date between date '0001-01-01' and date '9999-12-31'
      then profile.challenge_start_date end as profile_start_date,
    profile.time_zone as profile_time_zone,
    case
      when profile.time_zone is not null and exists (
        select 1 from pg_catalog.pg_timezone_names zone where zone.name = profile.time_zone
      ) then profile.time_zone
      else 'UTC'
    end as effective_time_zone,
    case when profile.created_at is not null
      and pg_catalog.isfinite(profile.created_at)
      and profile.created_at between
        timestamptz '0001-01-01 00:00:00+00'
        and timestamptz '9999-12-31 23:59:59.999999+00'
      then profile.created_at end as profile_created_at,
    case when profile.created_at is not null
      and not (
        pg_catalog.isfinite(profile.created_at)
        and profile.created_at between
          timestamptz '0001-01-01 00:00:00+00'
          and timestamptz '9999-12-31 23:59:59.999999+00'
      ) then 1 else 0 end as invalid_profile_created_at_count,
    check_in.first_start_date as check_in_start_date,
    check_in.last_start_date as check_in_last_start_date,
    coalesce(check_in.start_date_count, 0) as check_in_start_date_count,
    check_in.first_activity_at as first_check_in_at,
    coalesce(check_in.check_in_count, 0) as check_in_count,
    coalesce(check_in.invalid_start_evidence_count, 0)
      as invalid_check_in_start_evidence_count,
    coalesce(check_in.invalid_activity_timestamp_count, 0)
      as invalid_check_in_activity_timestamp_count,
    draft.first_entry_date as first_draft_date,
    draft.first_activity_at as first_draft_at,
    coalesce(draft.draft_count, 0) as draft_count,
    coalesce(draft.invalid_entry_date_count, 0) as invalid_draft_entry_date_count,
    coalesce(draft.invalid_activity_timestamp_count, 0)
      as invalid_draft_activity_timestamp_count,
    group_state.crew_id,
    group_state.group_evidenced_at,
    group_state.recorded_challenge_start_date as recorded_crew_start_date,
    group_state.challenge_start_date as crew_start_date,
    coalesce(group_state.group_count, 0) as group_count,
    coalesce(group_state.invalid_evidence_timestamp_count, 0)
      as invalid_group_evidence_timestamp_count,
    stats.total_points,
    stats.challenge_points,
    stats.current_app_streak,
    stats.best_app_streak,
    stats.current_full_day_streak,
    stats.best_full_day_streak,
    stats.last_seen_date as recorded_last_seen_date,
    case when pg_catalog.isfinite(stats.last_seen_date)
      and stats.last_seen_date between date '0001-01-01' and date '9999-12-31'
      then stats.last_seen_date end as last_seen_date,
    case when stats.last_seen_date is not null
      and not (
        pg_catalog.isfinite(stats.last_seen_date)
        and stats.last_seen_date between date '0001-01-01' and date '9999-12-31'
      ) then 1 else 0 end as invalid_last_seen_date_count,
    stats.last_full_day_date as recorded_last_full_day_date,
    case when pg_catalog.isfinite(stats.last_full_day_date)
      and stats.last_full_day_date between date '0001-01-01' and date '9999-12-31'
      then stats.last_full_day_date end as last_full_day_date,
    case when stats.last_full_day_date is not null
      and not (
        pg_catalog.isfinite(stats.last_full_day_date)
        and stats.last_full_day_date between date '0001-01-01' and date '9999-12-31'
      ) then 1 else 0 end as invalid_last_full_day_date_count,
    point_event.first_entry_date as first_point_entry_date,
    point_event.first_activity_at as first_point_at,
    coalesce(point_event.point_event_count, 0) as point_event_count,
    coalesce(point_event.invalid_entry_date_count, 0) as invalid_point_entry_date_count,
    coalesce(point_event.invalid_activity_timestamp_count, 0)
      as invalid_point_activity_timestamp_count,
    badge.first_entry_date as first_badge_entry_date,
    badge.first_activity_at as first_badge_at,
    coalesce(badge.badge_count, 0) as badge_count,
    coalesce(badge.invalid_entry_date_count, 0) as invalid_badge_entry_date_count,
    coalesce(badge.invalid_activity_timestamp_count, 0)
      as invalid_badge_activity_timestamp_count,
    reward.first_activity_at as first_reward_at,
    coalesce(reward.reward_count, 0) as reward_count,
    coalesce(reward.invalid_activity_timestamp_count, 0)
      as invalid_reward_activity_timestamp_count
  from evidence_users evidence_user
  cross join challenge_activation_migration_clock migration_clock
  left join public.profiles profile on profile.user_id = evidence_user.user_id
  left join check_in_evidence check_in on check_in.user_id = evidence_user.user_id
  left join draft_evidence draft on draft.user_id = evidence_user.user_id
  left join group_evidence group_state on group_state.user_id = evidence_user.user_id
  left join public.user_game_stats stats on stats.user_id = evidence_user.user_id
  left join point_evidence point_event on point_event.user_id = evidence_user.user_id
  left join badge_evidence badge on badge.user_id = evidence_user.user_id
  left join reward_evidence reward on reward.user_id = evidence_user.user_id
), gathered as (
  select
    gathered_raw.*,
    coalesce(
      gathered_raw.first_point_entry_date,
      case
        when (gathered_raw.first_point_at at time zone gathered_raw.effective_time_zone)::date
          between date '0001-01-01' and date '9999-12-31'
          then (gathered_raw.first_point_at at time zone gathered_raw.effective_time_zone)::date
      end
    ) as first_point_date,
    coalesce(
      gathered_raw.first_badge_entry_date,
      case
        when (gathered_raw.first_badge_at at time zone gathered_raw.effective_time_zone)::date
          between date '0001-01-01' and date '9999-12-31'
          then (gathered_raw.first_badge_at at time zone gathered_raw.effective_time_zone)::date
      end
    ) as first_badge_date,
    case
      when (gathered_raw.first_reward_at at time zone gathered_raw.effective_time_zone)::date
        between date '0001-01-01' and date '9999-12-31'
        then (gathered_raw.first_reward_at at time zone gathered_raw.effective_time_zone)::date
    end as first_reward_date,
    case when gathered_raw.first_point_at is not null
      and (gathered_raw.first_point_at at time zone gathered_raw.effective_time_zone)::date
        not between date '0001-01-01' and date '9999-12-31'
      then 1 else 0 end as invalid_point_local_date_count,
    case when gathered_raw.first_badge_at is not null
      and (gathered_raw.first_badge_at at time zone gathered_raw.effective_time_zone)::date
        not between date '0001-01-01' and date '9999-12-31'
      then 1 else 0 end as invalid_badge_local_date_count,
    case when gathered_raw.first_reward_at is not null
      and (gathered_raw.first_reward_at at time zone gathered_raw.effective_time_zone)::date
        not between date '0001-01-01' and date '9999-12-31'
      then 1 else 0 end as invalid_reward_local_date_count,
    (gathered_raw.authoritative_at at time zone gathered_raw.effective_time_zone)::date
      as profile_user_date
  from gathered_raw
), classified as (
  select
    gathered.*,
    coalesce(
      gathered.profile_start_date,
      gathered.check_in_start_date,
      gathered.crew_start_date,
      least(
        gathered.first_draft_date,
        gathered.last_full_day_date,
        gathered.first_point_date,
        gathered.first_badge_date,
        gathered.first_reward_date
      ),
      -- An App Streak records product use, not necessarily a started challenge,
      -- so it is the weakest dated fallback.
      gathered.last_seen_date,
      gathered.profile_user_date
    ) as preferred_start_date,
    case when gathered.crew_id is null then 'solo' else 'group' end as chosen_mode,
    -- Only irreversible challenge activity overrides an explicit future date.
    -- Crew selection and App Streak visits remain valid legacy evidence, but
    -- neither proves the 77-day challenge itself began before that date.
    (
      gathered.check_in_count > 0
      or gathered.draft_count > 0
      or coalesce(gathered.total_points, 0) > 0
      or coalesce(gathered.challenge_points, 0) > 0
      or coalesce(gathered.current_full_day_streak, 0) > 0
      or coalesce(gathered.best_full_day_streak, 0) > 0
      or gathered.last_full_day_date is not null
      or gathered.point_event_count > 0
      or gathered.badge_count > 0
      or gathered.reward_count > 0
    ) as has_started_activity
  from gathered
)
select
  classified.*,
  case
    -- A future profile/crew date cannot be the gate for an account that already
    -- has deployed activity. Preserve access with the earliest non-future
    -- evidence date (with the check-in-derived date first because it encodes
    -- persisted challenge-day math), or today when only undated evidence
    -- exists, and retain the contradiction in the review queue below.
    when classified.preferred_start_date > classified.profile_user_date
      and classified.has_started_activity then coalesce(
        case when classified.check_in_start_date <= classified.profile_user_date
          then classified.check_in_start_date end,
        least(
          case when classified.first_draft_date <= classified.profile_user_date
            then classified.first_draft_date end,
          case when classified.last_full_day_date <= classified.profile_user_date
            then classified.last_full_day_date end,
          case when classified.first_point_date <= classified.profile_user_date
            then classified.first_point_date end,
          case when classified.first_badge_date <= classified.profile_user_date
            then classified.first_badge_date end,
          case when classified.first_reward_date <= classified.profile_user_date
            then classified.first_reward_date end
        ),
        classified.profile_user_date
      )
    else classified.preferred_start_date
  end as chosen_start_date,
  (
    classified.preferred_start_date > classified.profile_user_date
    and classified.has_started_activity
  ) as future_start_overridden,
  array_remove(array[
    case when classified.check_in_start_date_count > 1
      then 'check_ins_imply_multiple_start_dates' end,
    case when classified.profile_start_date is not null
      and classified.check_in_start_date is not null
      and classified.profile_start_date <> classified.check_in_start_date
      then 'profile_date_conflicts_with_check_ins' end,
    case when classified.profile_start_date is not null
      and classified.crew_start_date is not null
      and classified.profile_start_date <> classified.crew_start_date
      then 'profile_date_conflicts_with_crew' end,
    case when classified.check_in_start_date is not null
      and classified.crew_start_date is not null
      and classified.check_in_start_date <> classified.crew_start_date
      then 'check_ins_conflict_with_crew' end,
    case when classified.group_count > 1 then 'multiple_group_attributions' end,
    case when classified.crew_id is not null and classified.crew_start_date is null
      then 'group_has_no_start_date' end,
    case when classified.recorded_profile_start_date is not null
      and not pg_catalog.isfinite(classified.recorded_profile_start_date)
      then 'profile_start_date_not_finite' end,
    case when classified.recorded_profile_start_date is not null
      and pg_catalog.isfinite(classified.recorded_profile_start_date)
      and classified.recorded_profile_start_date
        not between date '0001-01-01' and date '9999-12-31'
      then 'profile_start_date_outside_supported_range' end,
    case when classified.recorded_crew_start_date is not null
      and not pg_catalog.isfinite(classified.recorded_crew_start_date)
      then 'crew_start_date_not_finite' end,
    case when classified.recorded_crew_start_date is not null
      and pg_catalog.isfinite(classified.recorded_crew_start_date)
      and classified.recorded_crew_start_date
        not between date '0001-01-01' and date '9999-12-31'
      then 'crew_start_date_outside_supported_range' end,
    case when classified.profile_time_zone is not null
      and not exists (
        select 1 from pg_catalog.pg_timezone_names zone
        where zone.name = classified.profile_time_zone
      ) then 'profile_time_zone_not_supported' end,
    case when classified.invalid_profile_created_at_count > 0
      then 'profile_created_at_not_supported' end,
    case when classified.invalid_check_in_start_evidence_count > 0
      then 'check_ins_have_invalid_start_evidence' end,
    case when classified.invalid_check_in_activity_timestamp_count > 0
      then 'check_ins_have_invalid_activity_timestamps' end,
    case when classified.invalid_draft_entry_date_count > 0
      then 'drafts_have_invalid_entry_dates' end,
    case when classified.invalid_draft_activity_timestamp_count > 0
      then 'drafts_have_invalid_activity_timestamps' end,
    case when classified.invalid_group_evidence_timestamp_count > 0
      then 'group_evidence_has_invalid_timestamps' end,
    case when classified.invalid_point_entry_date_count > 0
      then 'points_have_invalid_entry_dates' end,
    case when classified.invalid_point_activity_timestamp_count > 0
      then 'points_have_invalid_activity_timestamps' end,
    case when classified.invalid_point_local_date_count > 0
      then 'points_resolve_outside_supported_local_dates' end,
    case when classified.invalid_badge_entry_date_count > 0
      then 'badges_have_invalid_entry_dates' end,
    case when classified.invalid_badge_activity_timestamp_count > 0
      then 'badges_have_invalid_activity_timestamps' end,
    case when classified.invalid_badge_local_date_count > 0
      then 'badges_resolve_outside_supported_local_dates' end,
    case when classified.invalid_reward_activity_timestamp_count > 0
      then 'rewards_have_invalid_activity_timestamps' end,
    case when classified.invalid_reward_local_date_count > 0
      then 'rewards_resolve_outside_supported_local_dates' end,
    case when classified.invalid_last_seen_date_count > 0
      then 'stats_last_seen_date_not_supported' end,
    case when classified.invalid_last_full_day_date_count > 0
      then 'stats_last_full_day_date_not_supported' end,
    case when classified.profile_start_date is null
      and classified.check_in_start_date is null
      and classified.crew_start_date is null
      and classified.first_draft_date is null
      and classified.last_full_day_date is null
      and classified.last_seen_date is null
      and classified.first_point_date is null
      and classified.first_badge_date is null
      and classified.first_reward_date is null
      then 'activity_has_no_date_anchor' end,
    case when classified.preferred_start_date > classified.profile_user_date
      and classified.has_started_activity
      then 'future_start_date_conflicts_with_started_activity' end
  ]::text[], null) as review_reasons
from classified;

insert into public.profiles (user_id, name, email)
select
  backfill.user_id,
  coalesce(nullif(auth_user.raw_user_meta_data ->> 'name', ''), 'Member'),
  coalesce(auth_user.email, '')
from challenge_activation_legacy_backfill backfill
join auth.users auth_user on auth_user.id = backfill.user_id
left join public.profiles profile on profile.user_id = backfill.user_id
where profile.user_id is null
on conflict (user_id) do nothing;

update public.profiles profile
set
  challenge_activation_status = case
    when backfill.chosen_start_date > backfill.profile_user_date
      and not backfill.has_started_activity
      then 'scheduled'
    else 'active'
  end,
  challenge_participation_mode = backfill.chosen_mode,
  challenge_start_date = backfill.chosen_start_date,
  challenge_activation_time_zone = backfill.effective_time_zone,
  challenge_group_attribution_crew_id = backfill.crew_id,
  challenge_activated_at = case
    when backfill.chosen_start_date > backfill.profile_user_date
      and not backfill.has_started_activity
      then null
    else coalesce(
      least(
        backfill.first_check_in_at,
        backfill.first_draft_at,
        backfill.group_evidenced_at,
        backfill.first_point_at,
        backfill.first_badge_at,
        backfill.first_reward_at
      ),
      backfill.profile_created_at,
      backfill.authoritative_at
    )
  end,
  challenge_confirmed_at = backfill.authoritative_at,
  challenge_activated_by = case
    when backfill.chosen_start_date > backfill.profile_user_date
      and not backfill.has_started_activity
      then null
    else backfill.user_id
  end,
  challenge_confirmed_by = backfill.user_id,
  challenge_activation_request_id = null,
  challenge_activation_schema_version = 1,
  challenge_activation_revision = 1,
  challenge_activation_review_required = cardinality(backfill.review_reasons) > 0,
  challenge_activation_updated_at = backfill.authoritative_at
from challenge_activation_legacy_backfill backfill
where profile.user_id = backfill.user_id;

create trigger lock_challenge_start_date_after_check_in
  before update of challenge_start_date on public.profiles
  for each row execute function public.lock_challenge_start_date_after_check_in();

insert into private.challenge_activation_migration_reviews (
  user_id, reasons, evidence, created_at
)
select
  backfill.user_id,
  backfill.review_reasons,
  jsonb_strip_nulls(jsonb_build_object(
    'profileStartDate', backfill.profile_start_date,
    'recordedProfileStartDate', backfill.recorded_profile_start_date,
    'checkInStartDate', backfill.check_in_start_date,
    'checkInLastStartDate', backfill.check_in_last_start_date,
    'checkInStartDateCount', backfill.check_in_start_date_count,
    'checkInCount', backfill.check_in_count,
    'invalidCheckInStartEvidenceCount', backfill.invalid_check_in_start_evidence_count,
    'invalidCheckInActivityTimestampCount', backfill.invalid_check_in_activity_timestamp_count,
    'draftCount', backfill.draft_count,
    'invalidDraftEntryDateCount', backfill.invalid_draft_entry_date_count,
    'invalidDraftActivityTimestampCount', backfill.invalid_draft_activity_timestamp_count,
    'crewId', backfill.crew_id,
    'crewStartDate', backfill.crew_start_date,
    'recordedCrewStartDate', backfill.recorded_crew_start_date,
    'groupCount', backfill.group_count,
    'invalidGroupEvidenceTimestampCount', backfill.invalid_group_evidence_timestamp_count,
    'chosenMode', backfill.chosen_mode,
    'preferredStartDate', backfill.preferred_start_date,
    'chosenStartDate', backfill.chosen_start_date,
    'futureStartOverridden', backfill.future_start_overridden,
    'totalPoints', backfill.total_points,
    'challengePoints', backfill.challenge_points,
    'currentAppStreak', backfill.current_app_streak,
    'bestAppStreak', backfill.best_app_streak,
    'currentFullDayStreak', backfill.current_full_day_streak,
    'bestFullDayStreak', backfill.best_full_day_streak
  ) || jsonb_build_object(
    'lastSeenDate', backfill.last_seen_date,
    'recordedLastSeenDate', backfill.recorded_last_seen_date,
    'invalidLastSeenDateCount', backfill.invalid_last_seen_date_count,
    'lastFullDayDate', backfill.last_full_day_date,
    'recordedLastFullDayDate', backfill.recorded_last_full_day_date,
    'invalidLastFullDayDateCount', backfill.invalid_last_full_day_date_count,
    'firstPointDate', backfill.first_point_date,
    'pointEventCount', backfill.point_event_count,
    'invalidPointEntryDateCount', backfill.invalid_point_entry_date_count,
    'invalidPointActivityTimestampCount', backfill.invalid_point_activity_timestamp_count,
    'invalidPointLocalDateCount', backfill.invalid_point_local_date_count,
    'firstBadgeDate', backfill.first_badge_date,
    'badgeCount', backfill.badge_count,
    'invalidBadgeEntryDateCount', backfill.invalid_badge_entry_date_count,
    'invalidBadgeActivityTimestampCount', backfill.invalid_badge_activity_timestamp_count,
    'invalidBadgeLocalDateCount', backfill.invalid_badge_local_date_count,
    'firstRewardDate', backfill.first_reward_date,
    'rewardCount', backfill.reward_count,
    'invalidRewardActivityTimestampCount', backfill.invalid_reward_activity_timestamp_count,
    'invalidRewardLocalDateCount', backfill.invalid_reward_local_date_count,
    'profileCreatedAt', backfill.profile_created_at,
    'invalidProfileCreatedAtCount', backfill.invalid_profile_created_at_count,
    'profileTimeZone', backfill.profile_time_zone,
    'effectiveTimeZone', backfill.effective_time_zone,
    'authoritativeAt', backfill.authoritative_at
  )),
  backfill.authoritative_at
from challenge_activation_legacy_backfill backfill
where cardinality(backfill.review_reasons) > 0
on conflict (user_id) do update
set reasons = excluded.reasons,
    evidence = excluded.evidence,
    created_at = excluded.created_at,
    resolved_at = null,
    resolved_by = null,
    resolution_note = null;

alter table public.profiles
  validate constraint profiles_challenge_activation_shape_check;

create index if not exists profiles_challenge_activation_status_idx
  on public.profiles (challenge_activation_status, challenge_start_date)
  where challenge_activation_status <> 'not_started';

create or replace function public.challenge_activation_user_date(target_user_id uuid)
returns date
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  target_time_zone text;
begin
  select profile.challenge_activation_time_zone
    into target_time_zone
  from public.profiles profile
  where profile.user_id = target_user_id;

  if target_time_zone is null or not exists (
    select 1 from pg_catalog.pg_timezone_names zone where zone.name = target_time_zone
  ) then
    target_time_zone := 'UTC';
  end if;

  return (pg_catalog.statement_timestamp() at time zone target_time_zone)::date;
end;
$$;

-- A due schedule must be persisted as active before any lifecycle mutation
-- builds its response. Keeping this transition in one row-conditional helper
-- makes compatible retries and no-op date edits converge under the same user
-- advisory lock without fabricating an effective-only active payload.
create or replace function private.promote_due_challenge_activation(
  target_user_id uuid,
  target_actor_id uuid,
  target_authoritative_at timestamptz
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  promoted_rows integer := 0;
begin
  update public.profiles profile
  set challenge_activation_status = 'active',
      challenge_activated_at = coalesce(
        profile.challenge_activated_at,
        target_authoritative_at
      ),
      challenge_activated_by = coalesce(
        profile.challenge_activated_by,
        profile.challenge_confirmed_by,
        target_actor_id
      ),
      challenge_activation_revision = profile.challenge_activation_revision + 1,
      challenge_activation_updated_at = target_authoritative_at
  where profile.user_id = target_user_id
    and profile.challenge_activation_status = 'scheduled'
    and profile.challenge_start_date is not null
    and profile.challenge_start_date <=
      public.challenge_activation_user_date(target_user_id);

  get diagnostics promoted_rows = row_count;
  return promoted_rows = 1;
end;
$$;

-- Request evidence references auth.users. Lock that parent row before any
-- profile row so account erasure (auth parent, then cascading profile) and
-- activation mutations always acquire the same parent-to-child lock order.
create or replace function private.lock_challenge_activation_actor(target_actor_id uuid)
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
      using errcode = '28000', detail = 'challenge_activation_actor_missing';
  end if;
end;
$$;

create or replace function public.challenge_activation_allows_date(
  target_user_id uuid,
  target_entry_date date
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select profile.challenge_activation_status in ('scheduled', 'active')
      and profile.challenge_start_date is not null
      and public.challenge_activation_user_date(target_user_id) >= profile.challenge_start_date
      and target_entry_date = public.daily_standard_user_date(target_user_id)
      and target_entry_date - profile.challenge_start_date + 1 between 1 and 77
    from public.profiles profile
    where profile.user_id = target_user_id
  ), false);
$$;

create or replace function public.challenge_activation_payload_for_user(target_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  profile_row public.profiles%rowtype;
  effective_status text := 'not_started';
  user_date date;
  challenge_day integer;
  group_membership_active boolean := false;
  has_active_membership boolean := false;
  can_edit_start_date boolean := false;
begin
  select profile.* into profile_row
  from public.profiles profile
  where profile.user_id = target_user_id;

  if not found then
    return pg_catalog.jsonb_build_object(
      'schemaVersion', 1,
      'revision', 0,
      'status', 'not_started',
      'storedStatus', 'not_started',
      'mode', null,
      'startDate', null,
      'timeZone', null,
      'crewId', null,
      'groupMembershipActive', false,
      'activatedAt', null,
      'confirmedAt', null,
      'activatedBy', null,
      'confirmedBy', null,
      'reviewRequired', false,
      'challengeDay', null,
      'canActivateSolo', true,
      'canActivateGroup', true,
      'canParticipate', false,
      'canMutateDailyStandards', false,
      'canEditStartDate', false
    );
  end if;

  user_date := public.challenge_activation_user_date(target_user_id);
  effective_status := profile_row.challenge_activation_status;
  if effective_status = 'scheduled'
     and profile_row.challenge_start_date is not null
     and user_date >= profile_row.challenge_start_date then
    effective_status := 'active';
  end if;

  if profile_row.challenge_start_date is not null
     and effective_status = 'active' then
    challenge_day := user_date - profile_row.challenge_start_date + 1;
  end if;

  if profile_row.challenge_participation_mode = 'group'
     and profile_row.challenge_group_attribution_crew_id is not null then
    select exists (
      select 1
      from public.crew_members member_row
      join public.crews crew_row on crew_row.id = member_row.crew_id
      where member_row.user_id = target_user_id
        and member_row.crew_id = profile_row.challenge_group_attribution_crew_id
        and crew_row.deleted_at is null
        and not exists (
          select 1
          from private.retired_community_dr_quarantined_crews quarantine
          where quarantine.crew_id = crew_row.id
        )
    ) into group_membership_active;
  end if;

  select exists (
    select 1
    from public.entitlements entitlement
    where entitlement.user_id = target_user_id
      and entitlement.entitlement_key = 'membership_active'
      and entitlement.status = 'active'
      and (
        entitlement.ends_at is null
        or entitlement.ends_at > pg_catalog.statement_timestamp()
      )
  ) into has_active_membership;

  can_edit_start_date := profile_row.challenge_participation_mode = 'solo'
    and effective_status in ('scheduled', 'active')
    and not exists (
      select 1 from public.check_ins check_in where check_in.user_id = target_user_id
    );

  return pg_catalog.jsonb_build_object(
    'schemaVersion', profile_row.challenge_activation_schema_version,
    'revision', profile_row.challenge_activation_revision,
    'status', effective_status,
    'storedStatus', profile_row.challenge_activation_status,
    'mode', profile_row.challenge_participation_mode,
    'startDate', profile_row.challenge_start_date,
    'timeZone', profile_row.challenge_activation_time_zone,
    'crewId', profile_row.challenge_group_attribution_crew_id,
    'groupMembershipActive', group_membership_active,
    'activatedAt', profile_row.challenge_activated_at,
    'confirmedAt', profile_row.challenge_confirmed_at,
    'activatedBy', profile_row.challenge_activated_by,
    'confirmedBy', profile_row.challenge_confirmed_by,
    'reviewRequired', profile_row.challenge_activation_review_required,
    'challengeDay', challenge_day,
    'canActivateSolo', effective_status = 'not_started',
    'canActivateGroup', effective_status = 'not_started',
    'canParticipate', effective_status = 'active',
    'canMutateDailyStandards', has_active_membership
      and public.challenge_activation_allows_date(target_user_id, user_date),
    'canEditStartDate', can_edit_start_date
  );
end;
$$;

-- Once a challenge is confirmed, its activation timezone is the one date
-- boundary used by both lifecycle reads and Daily Standards mutations.
create or replace function public.daily_standard_user_date(target_user_id uuid)
returns date
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  target_time_zone text;
begin
  select coalesce(
      nullif(profile.challenge_activation_time_zone, ''),
      nullif(profile.time_zone, '')
    )
    into target_time_zone
  from public.profiles profile
  where profile.user_id = target_user_id;

  if target_time_zone is null or not exists (
    select 1 from pg_catalog.pg_timezone_names zone where zone.name = target_time_zone
  ) then
    target_time_zone := 'UTC';
  end if;

  return (pg_catalog.statement_timestamp() at time zone target_time_zone)::date;
end;
$$;

create or replace function public.get_challenge_activation(target_expected_actor_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  authoritative_at timestamptz := pg_catalog.statement_timestamp();
  profile_row public.profiles%rowtype;
begin
  if caller_id is null then
    raise exception 'You need to log in to view challenge activation.' using errcode = '28000';
  end if;
  if target_expected_actor_id is distinct from caller_id then
    raise exception 'The signed-in account changed. Refresh and try again.'
      using errcode = '40001', detail = 'challenge_activation_actor_changed';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('single-crew:' || caller_id::text, 821)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('challenge-activation:' || caller_id::text, 1438)
  );
  perform private.lock_challenge_activation_actor(caller_id);

  insert into public.profiles (user_id, name, email)
  values (
    caller_id,
    coalesce(nullif((select auth.jwt()) -> 'user_metadata' ->> 'name', ''), 'Member'),
    coalesce((select auth.jwt()) ->> 'email', '')
  )
  on conflict (user_id) do nothing;

  select profile.* into profile_row
  from public.profiles profile
  where profile.user_id = caller_id
  for update;

  perform private.promote_due_challenge_activation(
    caller_id,
    caller_id,
    authoritative_at
  );

  return public.challenge_activation_payload_for_user(caller_id);
end;
$$;

create or replace function public.activate_solo_challenge(
  target_start_date date,
  target_time_zone text,
  target_request_id uuid,
  target_expected_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  authoritative_at timestamptz := pg_catalog.statement_timestamp();
  requested_time_zone text := nullif(pg_catalog.btrim(target_time_zone), '');
  user_date date;
  request_hash bytea;
  prior_request private.challenge_activation_requests%rowtype;
  profile_row public.profiles%rowtype;
  result_payload jsonb;
  next_status text;
begin
  if caller_id is null then
    raise exception 'You need to log in to start your challenge.' using errcode = '28000';
  end if;
  if target_expected_actor_id is distinct from caller_id then
    raise exception 'The signed-in account changed. Refresh and try again.'
      using errcode = '40001', detail = 'challenge_activation_actor_changed';
  end if;
  if target_request_id is null then
    raise exception 'A request ID is required.' using errcode = '22023';
  end if;
  request_hash := extensions.digest(
    pg_catalog.convert_to(
      pg_catalog.jsonb_build_array('solo', target_start_date, requested_time_zone)::text,
      'UTF8'
    ),
    'sha256'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('single-crew:' || caller_id::text, 821)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('challenge-activation:' || caller_id::text, 1438)
  );
  perform private.lock_challenge_activation_actor(caller_id);

  select request_row.* into prior_request
  from private.challenge_activation_requests request_row
  where request_row.request_id = target_request_id;
  if found then
    if prior_request.actor_id <> caller_id
       or prior_request.action <> 'solo_activate'
       or prior_request.request_hash <> request_hash then
      raise exception 'This request ID was already used for another operation.'
        using errcode = '23505';
    end if;
    return prior_request.result;
  end if;

  if requested_time_zone is null or not exists (
    select 1 from pg_catalog.pg_timezone_names zone where zone.name = requested_time_zone
  ) then
    raise exception 'Choose a valid time zone.' using errcode = '22023';
  end if;
  user_date := (authoritative_at at time zone requested_time_zone)::date;
  if target_start_date is null
     or not pg_catalog.isfinite(target_start_date)
     or target_start_date not between date '0001-01-01' and date '9999-12-31' then
    raise exception 'Choose a valid challenge start date.' using errcode = '22023';
  end if;
  if target_start_date < user_date - 76 then
    raise exception 'Choose a start date within the current 77-day challenge window.'
      using errcode = '22023';
  end if;

  insert into public.profiles (user_id, name, email, time_zone)
  values (
    caller_id,
    coalesce(nullif((select auth.jwt()) -> 'user_metadata' ->> 'name', ''), 'Member'),
    coalesce((select auth.jwt()) ->> 'email', ''),
    requested_time_zone
  )
  on conflict (user_id) do nothing;

  select profile.* into profile_row
  from public.profiles profile
  where profile.user_id = caller_id
  for update;

  if profile_row.challenge_activation_status <> 'not_started' then
    if profile_row.challenge_participation_mode <> 'solo'
       or profile_row.challenge_start_date <> target_start_date
       or profile_row.challenge_activation_time_zone <> requested_time_zone then
      raise exception 'Challenge activation conflicts with the existing participation history.'
        using errcode = '55000', detail = 'challenge_activation_conflict';
    end if;
  else
    next_status := case when target_start_date > user_date then 'scheduled' else 'active' end;
    update public.profiles
    set challenge_activation_status = next_status,
        challenge_participation_mode = 'solo',
        challenge_start_date = target_start_date,
        challenge_activation_time_zone = requested_time_zone,
        time_zone = requested_time_zone,
        challenge_group_attribution_crew_id = null,
        challenge_activated_at = case when next_status = 'active' then authoritative_at else null end,
        challenge_confirmed_at = authoritative_at,
        challenge_activated_by = case when next_status = 'active' then caller_id else null end,
        challenge_confirmed_by = caller_id,
        challenge_activation_request_id = target_request_id,
        challenge_activation_schema_version = 1,
        challenge_activation_revision = challenge_activation_revision + 1,
        challenge_activation_review_required = false,
        challenge_activation_updated_at = authoritative_at
    where user_id = caller_id;
  end if;

  perform private.promote_due_challenge_activation(
    caller_id,
    caller_id,
    authoritative_at
  );

  result_payload := public.challenge_activation_payload_for_user(caller_id);
  insert into private.challenge_activation_requests (
    request_id, actor_id, action, request_hash, result, created_at
  ) values (
    target_request_id,
    caller_id,
    'solo_activate',
    request_hash,
    result_payload,
    authoritative_at
  );

  return result_payload;
end;
$$;

create or replace function public.activate_group_challenge(
  target_crew_id uuid,
  target_time_zone text,
  target_request_id uuid,
  target_expected_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  authoritative_at timestamptz := pg_catalog.statement_timestamp();
  requested_time_zone text := nullif(pg_catalog.btrim(target_time_zone), '');
  user_date date;
  request_hash bytea;
  prior_request private.challenge_activation_requests%rowtype;
  profile_row public.profiles%rowtype;
  crew_row public.crews%rowtype;
  result_payload jsonb;
  next_status text;
begin
  if caller_id is null then
    raise exception 'You need to log in to start your challenge.' using errcode = '28000';
  end if;
  if target_expected_actor_id is distinct from caller_id then
    raise exception 'The signed-in account changed. Refresh and try again.'
      using errcode = '40001', detail = 'challenge_activation_actor_changed';
  end if;
  if target_crew_id is null or target_request_id is null then
    raise exception 'Crew and request IDs are required.' using errcode = '22023';
  end if;
  request_hash := extensions.digest(
    pg_catalog.convert_to(
      pg_catalog.jsonb_build_array('group', target_crew_id, requested_time_zone)::text,
      'UTF8'
    ),
    'sha256'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('single-crew:' || caller_id::text, 821)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('challenge-activation:' || caller_id::text, 1438)
  );
  perform private.lock_challenge_activation_actor(caller_id);

  select request_row.* into prior_request
  from private.challenge_activation_requests request_row
  where request_row.request_id = target_request_id;
  if found then
    if prior_request.actor_id <> caller_id
       or prior_request.action <> 'group_activate'
       or prior_request.request_hash <> request_hash then
      raise exception 'This request ID was already used for another operation.'
        using errcode = '23505';
    end if;
    return prior_request.result;
  end if;

  if requested_time_zone is null or not exists (
    select 1 from pg_catalog.pg_timezone_names zone where zone.name = requested_time_zone
  ) then
    raise exception 'Choose a valid time zone.' using errcode = '22023';
  end if;

  insert into public.profiles (user_id, name, email, time_zone)
  values (
    caller_id,
    coalesce(nullif((select auth.jwt()) -> 'user_metadata' ->> 'name', ''), 'Member'),
    coalesce((select auth.jwt()) ->> 'email', ''),
    requested_time_zone
  )
  on conflict (user_id) do nothing;

  select source_crew.* into crew_row
  from public.crews source_crew
  join public.crew_members member_row
    on member_row.crew_id = source_crew.id
   and member_row.user_id = caller_id
  where source_crew.id = target_crew_id
    and source_crew.deleted_at is null
    and not exists (
      select 1
      from private.retired_community_dr_quarantined_crews quarantine
      where quarantine.crew_id = source_crew.id
    )
  for update of source_crew, member_row;

  if not found then
    raise exception 'Current crew membership is required for Group activation.'
      using errcode = '42501';
  end if;
  if crew_row.challenge_start_date is null
     or not pg_catalog.isfinite(crew_row.challenge_start_date)
     or crew_row.challenge_start_date
       not between date '0001-01-01' and date '9999-12-31' then
    raise exception 'Choose the crew challenge start date before activation.'
      using errcode = '22023';
  end if;

  user_date := (authoritative_at at time zone requested_time_zone)::date;
  if crew_row.challenge_start_date < user_date - 76 then
    raise exception 'The crew start date is outside the current 77-day challenge window.'
      using errcode = '22023';
  end if;

  select profile.* into profile_row
  from public.profiles profile
  where profile.user_id = caller_id
  for update;

  if profile_row.challenge_activation_status <> 'not_started' then
    if profile_row.challenge_participation_mode <> 'group'
       or profile_row.challenge_start_date <> crew_row.challenge_start_date
       or profile_row.challenge_activation_time_zone <> requested_time_zone
       or profile_row.challenge_group_attribution_crew_id <> target_crew_id then
      raise exception 'Challenge activation conflicts with the existing participation history.'
        using errcode = '55000', detail = 'challenge_activation_conflict';
    end if;
  else
    next_status := case
      when crew_row.challenge_start_date > user_date then 'scheduled'
      else 'active'
    end;
    update public.profiles
    set challenge_activation_status = next_status,
        challenge_participation_mode = 'group',
        challenge_start_date = crew_row.challenge_start_date,
        challenge_activation_time_zone = requested_time_zone,
        time_zone = requested_time_zone,
        challenge_group_attribution_crew_id = target_crew_id,
        challenge_activated_at = case when next_status = 'active' then authoritative_at else null end,
        challenge_confirmed_at = authoritative_at,
        challenge_activated_by = case when next_status = 'active' then caller_id else null end,
        challenge_confirmed_by = caller_id,
        challenge_activation_request_id = target_request_id,
        challenge_activation_schema_version = 1,
        challenge_activation_revision = challenge_activation_revision + 1,
        challenge_activation_review_required = false,
        challenge_activation_updated_at = authoritative_at
    where user_id = caller_id;
  end if;

  perform private.promote_due_challenge_activation(
    caller_id,
    caller_id,
    authoritative_at
  );

  result_payload := public.challenge_activation_payload_for_user(caller_id);
  insert into private.challenge_activation_requests (
    request_id, actor_id, action, request_hash, result, created_at
  ) values (
    target_request_id,
    caller_id,
    'group_activate',
    request_hash,
    result_payload,
    authoritative_at
  );

  return result_payload;
end;
$$;

create or replace function public.set_challenge_start_date(
  target_start_date date,
  target_time_zone text,
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
  authoritative_at timestamptz := pg_catalog.statement_timestamp();
  requested_time_zone text := nullif(pg_catalog.btrim(target_time_zone), '');
  user_date date;
  request_hash bytea;
  prior_request private.challenge_activation_requests%rowtype;
  profile_row public.profiles%rowtype;
  result_payload jsonb;
  next_status text;
begin
  if caller_id is null then
    raise exception 'You need to log in to change your challenge start date.' using errcode = '28000';
  end if;
  if target_expected_actor_id is distinct from caller_id then
    raise exception 'The signed-in account changed. Refresh and try again.'
      using errcode = '40001', detail = 'challenge_activation_actor_changed';
  end if;
  if target_request_id is null then
    raise exception 'A request ID is required.' using errcode = '22023';
  end if;
  request_hash := extensions.digest(
    pg_catalog.convert_to(
      pg_catalog.jsonb_build_array(
        'date_update', target_start_date, requested_time_zone, target_expected_revision
      )::text,
      'UTF8'
    ),
    'sha256'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('single-crew:' || caller_id::text, 821)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('challenge-activation:' || caller_id::text, 1438)
  );
  perform private.lock_challenge_activation_actor(caller_id);

  select request_row.* into prior_request
  from private.challenge_activation_requests request_row
  where request_row.request_id = target_request_id;
  if found then
    if prior_request.actor_id <> caller_id
       or prior_request.action <> 'date_update'
       or prior_request.request_hash <> request_hash then
      raise exception 'This request ID was already used for another operation.'
        using errcode = '23505';
    end if;
    return prior_request.result;
  end if;

  if requested_time_zone is null or not exists (
    select 1 from pg_catalog.pg_timezone_names zone where zone.name = requested_time_zone
  ) then
    raise exception 'Choose a valid time zone.' using errcode = '22023';
  end if;
  user_date := (authoritative_at at time zone requested_time_zone)::date;
  if target_start_date is null
     or not pg_catalog.isfinite(target_start_date)
     or target_start_date not between date '0001-01-01' and date '9999-12-31' then
    raise exception 'Choose a valid challenge start date.' using errcode = '22023';
  end if;
  if target_start_date < user_date - 76 then
    raise exception 'Choose a start date within the current 77-day challenge window.'
      using errcode = '22023';
  end if;

  select profile.* into profile_row
  from public.profiles profile
  where profile.user_id = caller_id
  for update;
  if not found or profile_row.challenge_activation_status = 'not_started' then
    raise exception 'Start your challenge before changing its start date.'
      using errcode = '55000';
  end if;

  if profile_row.challenge_participation_mode <> 'solo' then
    raise exception 'A Group challenge start date is owned by the crew.'
      using errcode = '55000';
  end if;
  if exists (
    select 1 from public.check_ins check_in where check_in.user_id = caller_id
  ) then
    raise exception 'The challenge start date is locked after the first check-in.'
      using errcode = '55000';
  end if;
  if target_expected_revision is not null
     and target_expected_revision <> profile_row.challenge_activation_revision
     and (
       profile_row.challenge_start_date <> target_start_date
       or profile_row.challenge_activation_time_zone <> requested_time_zone
     ) then
    raise exception 'The challenge timeline changed in another session. Refresh and try again.'
      using errcode = '40001', detail = 'challenge_activation_stale_revision';
  end if;

  if profile_row.challenge_start_date <> target_start_date
     or profile_row.challenge_activation_time_zone <> requested_time_zone then
    next_status := case when target_start_date > user_date then 'scheduled' else 'active' end;
    update public.profiles
    set challenge_activation_status = next_status,
        challenge_start_date = target_start_date,
        challenge_activation_time_zone = requested_time_zone,
        time_zone = requested_time_zone,
        challenge_activated_at = case
          when next_status = 'active' then coalesce(challenge_activated_at, authoritative_at)
          else null
        end,
        challenge_activated_by = case
          when next_status = 'active' then coalesce(challenge_activated_by, caller_id)
          else null
        end,
        challenge_activation_revision = challenge_activation_revision + 1,
        challenge_activation_updated_at = authoritative_at
    where user_id = caller_id;
  end if;

  perform private.promote_due_challenge_activation(
    caller_id,
    caller_id,
    authoritative_at
  );

  result_payload := public.challenge_activation_payload_for_user(caller_id);
  insert into private.challenge_activation_requests (
    request_id, actor_id, action, request_hash, result, created_at
  ) values (
    target_request_id,
    caller_id,
    'date_update',
    request_hash,
    result_payload,
    authoritative_at
  );

  return result_payload;
end;
$$;

create or replace function public.daily_standard_draft_payload(
  target_user_id uuid,
  target_entry_date date,
  stale_write_reconciled boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  draft public.challenge_entries%rowtype;
  was_submitted boolean;
  activation_payload jsonb;
  activation_allowed boolean;
  lock_reason text;
begin
  if (select auth.uid()) is not null and (select auth.uid()) <> target_user_id then
    raise exception 'Challenge drafts can only be read for the signed-in account.'
      using errcode = '42501';
  end if;

  select * into draft
  from public.challenge_entries entry
  where entry.user_id = target_user_id
    and entry.entry_date = target_entry_date;

  select exists (
    select 1 from public.check_ins check_in
    where check_in.user_id = target_user_id
      and check_in.entry_date = target_entry_date
  ) into was_submitted;

  activation_payload := public.challenge_activation_payload_for_user(target_user_id);
  activation_allowed := public.challenge_activation_allows_date(target_user_id, target_entry_date);
  lock_reason := case
    when was_submitted then 'submitted'
    when target_entry_date <> public.daily_standard_user_date(target_user_id) then 'date_locked'
    when activation_payload ->> 'status' <> 'active' then 'challenge_not_active'
    when not activation_allowed then 'challenge_complete'
    else null
  end;

  return pg_catalog.jsonb_build_object(
    'entry_date', target_entry_date,
    'completed', coalesce(draft.completed, '{}'::text[]),
    'workout_difficulty', coalesce(draft.workout_difficulty, '{}'::jsonb),
    'version', coalesce(draft.version, 0),
    'updated_at', draft.updated_at,
    'submitted', was_submitted,
    'locked', lock_reason is not null,
    'lock_reason', lock_reason,
    'activation_status', activation_payload ->> 'status',
    'stale_write_reconciled', stale_write_reconciled
  );
end;
$$;

revoke all on function public.daily_standard_draft_payload(uuid, date, boolean)
  from public, anon, authenticated, service_role;

-- Preserve the mature draft/check-in implementations behind private names and
-- put one lifecycle gate in front of each client mutation. This avoids
-- duplicating point, badge, feed, and stale-write behavior.
alter function public.bootstrap_daily_standard_time_zone(text)
  rename to bootstrap_daily_standard_time_zone_pre_activation;
alter function public.mutate_daily_standard_draft(date, text, boolean, bigint)
  rename to mutate_daily_standard_draft_pre_activation;
alter function public.set_daily_standard_workout_difficulty(date, text, text, bigint)
  rename to set_daily_standard_workout_difficulty_pre_activation;
alter function public.submit_daily_check_in(text, text[], jsonb, text, date)
  rename to submit_daily_check_in_pre_activation;
alter function public.record_app_visit()
  rename to record_app_visit_pre_activation;

revoke all on function public.bootstrap_daily_standard_time_zone_pre_activation(text)
  from public, anon, authenticated, service_role;
revoke all on function public.mutate_daily_standard_draft_pre_activation(date, text, boolean, bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.set_daily_standard_workout_difficulty_pre_activation(date, text, text, bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.submit_daily_check_in_pre_activation(text, text[], jsonb, text, date)
  from public, anon, authenticated, service_role;
revoke all on function public.record_app_visit_pre_activation()
  from public, anon, authenticated, service_role;

create or replace function public.bootstrap_daily_standard_time_zone(
  target_time_zone text,
  target_expected_actor_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
begin
  if caller_id is null then
    raise exception 'You need to log in to set your Daily Standards time zone.'
      using errcode = '28000';
  end if;
  if target_expected_actor_id is distinct from caller_id then
    raise exception 'The signed-in account changed. Refresh and try again.'
      using errcode = '40001', detail = 'challenge_activation_actor_changed';
  end if;
  perform private.lock_challenge_activation_actor(caller_id);
  return public.bootstrap_daily_standard_time_zone_pre_activation(target_time_zone);
end;
$$;

create or replace function public.mutate_daily_standard_draft(
  target_entry_date date,
  target_action_id text,
  target_completed boolean,
  target_expected_version bigint,
  target_expected_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  activation_payload jsonb;
begin
  if caller_id is null then
    raise exception 'You need to log in to update Daily Standards.' using errcode = '28000';
  end if;
  if target_expected_actor_id is distinct from caller_id then
    raise exception 'The signed-in account changed. Refresh and try again.'
      using errcode = '40001', detail = 'challenge_activation_actor_changed';
  end if;
  activation_payload := public.get_challenge_activation(caller_id);
  if activation_payload ->> 'status' <> 'active' then
    raise exception 'An active challenge is required before changing Daily Standards.'
      using errcode = '55000', detail = 'challenge_activation_required';
  end if;
  if not public.challenge_activation_allows_date(caller_id, target_entry_date) then
    if target_entry_date is null
       or target_entry_date <> public.daily_standard_user_date(caller_id) then
      raise exception 'That Daily Standards date is locked.' using errcode = '22023';
    end if;
    raise exception 'The 77-day challenge is complete.' using errcode = '22023';
  end if;
  return public.mutate_daily_standard_draft_pre_activation(
    target_entry_date,
    target_action_id,
    target_completed,
    target_expected_version
  );
end;
$$;

create or replace function public.set_daily_standard_workout_difficulty(
  target_entry_date date,
  target_workout_id text,
  target_difficulty text,
  target_expected_version bigint,
  target_expected_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  activation_payload jsonb;
begin
  if caller_id is null then
    raise exception 'You need to log in to update workout difficulty.' using errcode = '28000';
  end if;
  if target_expected_actor_id is distinct from caller_id then
    raise exception 'The signed-in account changed. Refresh and try again.'
      using errcode = '40001', detail = 'challenge_activation_actor_changed';
  end if;
  activation_payload := public.get_challenge_activation(caller_id);
  if activation_payload ->> 'status' <> 'active' then
    raise exception 'An active challenge is required before changing Daily Standards.'
      using errcode = '55000', detail = 'challenge_activation_required';
  end if;
  if not public.challenge_activation_allows_date(caller_id, target_entry_date) then
    if target_entry_date is null
       or target_entry_date <> public.daily_standard_user_date(caller_id) then
      raise exception 'That Daily Standards date is locked.' using errcode = '22023';
    end if;
    raise exception 'The 77-day challenge is complete.' using errcode = '22023';
  end if;
  return public.set_daily_standard_workout_difficulty_pre_activation(
    target_entry_date,
    target_workout_id,
    target_difficulty,
    target_expected_version
  );
end;
$$;

create or replace function public.submit_daily_check_in(
  target_status text,
  target_completed text[],
  target_workout_difficulty jsonb,
  target_time_zone text,
  target_expected_date date,
  target_expected_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  authoritative_date date;
  authoritative_time_zone text;
  activation_payload jsonb;
begin
  if caller_id is null then
    raise exception 'You need to log in to post a check-in.' using errcode = '28000';
  end if;
  if target_expected_actor_id is distinct from caller_id then
    raise exception 'The signed-in account changed. Refresh and try again.'
      using errcode = '40001', detail = 'challenge_activation_actor_changed';
  end if;

  activation_payload := public.get_challenge_activation(caller_id);
  authoritative_date := public.daily_standard_user_date(caller_id);
  if target_expected_date is not null and target_expected_date <> authoritative_date then
    raise exception 'The check-in date changed. Refresh and try again.' using errcode = '22023';
  end if;
  if activation_payload ->> 'status' <> 'active' then
    raise exception 'An active challenge is required before posting a check-in.'
      using errcode = '55000', detail = 'challenge_activation_required';
  end if;
  if not public.challenge_activation_allows_date(caller_id, authoritative_date) then
    raise exception 'The check-in date is outside the active 77-day challenge.'
      using errcode = '22023';
  end if;

  select profile.challenge_activation_time_zone
    into authoritative_time_zone
  from public.profiles profile
  where profile.user_id = caller_id;

  return public.submit_daily_check_in_pre_activation(
    target_status,
    target_completed,
    target_workout_difficulty,
    authoritative_time_zone,
    authoritative_date
  );
end;
$$;

create or replace function public.record_app_visit(target_expected_actor_id uuid)
returns table (
  total_points integer,
  current_app_streak integer,
  best_app_streak integer,
  new_badges jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
begin
  if caller_id is null then
    raise exception 'You need to log in to record app activity.' using errcode = '28000';
  end if;
  if target_expected_actor_id is distinct from caller_id then
    raise exception 'The signed-in account changed. Refresh and try again.'
      using errcode = '40001', detail = 'challenge_activation_actor_changed';
  end if;
  perform private.lock_challenge_activation_actor(caller_id);
  return query select * from public.record_app_visit_pre_activation();
end;
$$;

-- Only lifecycle RPCs may set or edit challenge dates. Existing safe profile
-- text and timezone writes, photo RPCs, and crew text edits remain unchanged.
revoke insert (challenge_start_date) on table public.profiles from authenticated;
revoke update (challenge_start_date) on table public.profiles from authenticated;
revoke update (challenge_start_date) on table public.crews from authenticated;

revoke all on function public.challenge_activation_user_date(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.promote_due_challenge_activation(uuid, uuid, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function private.lock_challenge_activation_actor(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.challenge_activation_allows_date(uuid, date)
  from public, anon, authenticated, service_role;
revoke all on function public.challenge_activation_payload_for_user(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.daily_standard_user_date(uuid)
  from public, anon, authenticated, service_role;

revoke all on function public.get_challenge_activation(uuid)
  from public, anon, authenticated;
revoke all on function public.activate_solo_challenge(date, text, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.activate_group_challenge(uuid, text, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.set_challenge_start_date(date, text, uuid, bigint, uuid)
  from public, anon, authenticated;
revoke all on function public.bootstrap_daily_standard_time_zone(text, uuid)
  from public, anon, authenticated;
revoke all on function public.mutate_daily_standard_draft(date, text, boolean, bigint, uuid)
  from public, anon, authenticated;
revoke all on function public.set_daily_standard_workout_difficulty(date, text, text, bigint, uuid)
  from public, anon, authenticated;
revoke all on function public.submit_daily_check_in(text, text[], jsonb, text, date, uuid)
  from public, anon, authenticated;
revoke all on function public.record_app_visit(uuid)
  from public, anon, authenticated;

grant execute on function public.get_challenge_activation(uuid) to authenticated;
grant execute on function public.activate_solo_challenge(date, text, uuid, uuid) to authenticated;
grant execute on function public.activate_group_challenge(uuid, text, uuid, uuid) to authenticated;
grant execute on function public.set_challenge_start_date(date, text, uuid, bigint, uuid) to authenticated;
grant execute on function public.bootstrap_daily_standard_time_zone(text, uuid) to authenticated;
grant execute on function public.mutate_daily_standard_draft(date, text, boolean, bigint, uuid) to authenticated;
grant execute on function public.set_daily_standard_workout_difficulty(date, text, text, bigint, uuid) to authenticated;
grant execute on function public.submit_daily_check_in(text, text[], jsonb, text, date, uuid) to authenticated;
grant execute on function public.record_app_visit(uuid) to authenticated;

comment on column public.profiles.challenge_activation_status is
  'Server-owned Dominion challenge lifecycle: not_started, scheduled, or active.';
comment on column public.profiles.challenge_group_attribution_crew_id is
  'Immutable crew attribution for a Group start; retained after leave or soft deletion.';
comment on table private.challenge_activation_requests is
  'Server-only idempotency and audit evidence for activation and date changes.';
comment on table private.challenge_activation_migration_reviews is
  'Contradictory legacy activation evidence requiring explicit operational remediation.';
comment on function public.get_challenge_activation(uuid) is
  'Returns the signed-in actor''s authoritative activation contract and promotes due schedules only when the expected actor still matches.';
