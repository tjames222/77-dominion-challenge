#!/usr/bin/env bash
set -euo pipefail

database_url="${SUPABASE_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
case "$database_url" in
  postgresql://*@127.0.0.1:54322/*|postgres://*@127.0.0.1:54322/*|postgresql://*@localhost:54322/*|postgres://*@localhost:54322/*) ;;
  *)
    echo "Refusing to run the activation backfill harness against a non-local database." >&2
    exit 2
    ;;
esac

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$repository_root"

if [[ -n "${SUPABASE_CLI_BIN:-}" ]]; then
  supabase_cli="$SUPABASE_CLI_BIN"
elif [[ -x "$repository_root/node_modules/.bin/supabase" ]]; then
  supabase_cli="$repository_root/node_modules/.bin/supabase"
elif command -v supabase >/dev/null 2>&1; then
  supabase_cli="$(command -v supabase)"
else
  echo "The Supabase CLI is required." >&2
  exit 2
fi

project_id="$(sed -n 's/^project_id = "\([^"]*\)"/\1/p' supabase/config.toml | head -n 1)"
if [[ -z "$project_id" ]]; then
  echo "Unable to determine the local Supabase project ID." >&2
  exit 2
fi

if command -v psql >/dev/null 2>&1; then
  psql_mode="host"
elif [[ -n "${DOCKER_BIN:-}" && -x "$DOCKER_BIN" ]]; then
  psql_mode="docker"
  docker_cli="$DOCKER_BIN"
elif command -v docker >/dev/null 2>&1; then
  psql_mode="docker"
  docker_cli="$(command -v docker)"
elif [[ -x /opt/homebrew/bin/docker ]]; then
  psql_mode="docker"
  docker_cli="/opt/homebrew/bin/docker"
else
  echo "psql or Docker is required to run the activation backfill harness." >&2
  exit 2
fi

database_container="${SUPABASE_DB_CONTAINER:-supabase_db_${project_id}}"
run_psql() {
  if [[ "$psql_mode" == "host" ]]; then
    psql "$database_url" "$@"
  else
    "$docker_cli" exec -i "$database_container" psql -U postgres -d postgres "$@"
  fi
}

export SUPABASE_TELEMETRY_DISABLED=1

lock_holder_pid=""
lock_holder_log=""
migration_failure_log=""

restore_current_schema() {
  local test_status=$?
  local restore_status

  trap - EXIT INT TERM
  if [[ -n "$lock_holder_pid" ]]; then
    kill "$lock_holder_pid" >/dev/null 2>&1 || true
    wait "$lock_holder_pid" >/dev/null 2>&1 || true
  fi
  [[ -z "$lock_holder_log" ]] || rm -f "$lock_holder_log"
  [[ -z "$migration_failure_log" ]] || rm -f "$migration_failure_log"
  echo "Restoring the current local schema and seed..."
  set +e
  bash "$repository_root/scripts/reset-local-database.sh"
  restore_status=$?
  set -e

  if (( restore_status != 0 )); then
    echo "Failed to restore the current local schema after the backfill harness." >&2
    exit "$restore_status"
  fi
  exit "$test_status"
}
trap 'exit 130' INT
trap 'exit 143' TERM
trap restore_current_schema EXIT

echo "Resetting the local database to the final pre-activation migration..."
bash "$repository_root/scripts/reset-local-database.sh" \
  --version 20260731193250 \
  --no-seed

echo "Installing legacy contradiction and malformed-evidence fixtures..."
run_psql --set=ON_ERROR_STOP=1 --quiet <<'SQL'
begin;

create temporary table activation_backfill_fixture_clock as
select (pg_catalog.statement_timestamp() at time zone 'America/Los_Angeles')::date
  as local_today;

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'e1000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'activation-backfill-contradiction@example.test',
    'fixture',
    pg_catalog.statement_timestamp(),
    '{"provider":"email"}',
    '{"name":"Backfill Contradiction"}',
    pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'e2000000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'activation-backfill-malformed@example.test',
    'fixture',
    pg_catalog.statement_timestamp(),
    '{"provider":"email"}',
    '{"name":"Backfill Malformed"}',
    pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'e3000000-0000-4000-8000-000000000003',
    'authenticated',
    'authenticated',
    'activation-backfill-fresh@example.test',
    'fixture',
    pg_catalog.statement_timestamp(),
    '{"provider":"email"}',
    '{"name":"Backfill Fresh"}',
    pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'e4000000-0000-4000-8000-000000000004',
    'authenticated',
    'authenticated',
    'activation-backfill-erased-owner@example.test',
    'fixture',
    pg_catalog.statement_timestamp(),
    '{"provider":"email"}',
    '{"name":"Backfill Erased Owner"}',
    pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'e5000000-0000-4000-8000-000000000005',
    'authenticated',
    'authenticated',
    'activation-backfill-quarantined-member@example.test',
    'fixture',
    pg_catalog.statement_timestamp(),
    '{"provider":"email"}',
    '{"name":"Backfill Quarantined Member"}',
    pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp()
  );

-- Account erasure intentionally retains crew history with a nullable creator.
-- A malformed retained crew makes this fixture fail the migration if NULL is
-- accidentally admitted as a lifecycle evidence user or group owner.
insert into public.crews (
  id,
  name,
  description,
  challenge_start_date,
  created_by
)
values (
  'ef000000-0000-4000-8000-000000000004',
  'Erased owner retained crew',
  'Nullable legacy creator regression',
  'infinity'::date,
  'e4000000-0000-4000-8000-000000000004'
);

delete from auth.users
where id = 'e4000000-0000-4000-8000-000000000004';

insert into private.crew_lifecycle_requests (
  request_id,
  actor_id,
  crew_id,
  action,
  request_hash,
  result,
  created_at
)
values (
  'e4100000-0000-4000-8000-000000000004',
  'e4000000-0000-4000-8000-000000000004',
  'ef000000-0000-4000-8000-000000000004',
  'create',
  pg_catalog.decode(pg_catalog.repeat('00', 32), 'hex'),
  '{}'::jsonb,
  'infinity'::timestamptz
);

insert into public.crews (
  id,
  name,
  description,
  challenge_start_date,
  created_by
)
values (
  'ef000000-0000-4000-8000-000000000005',
  'Quarantined retained crew',
  'Group backfill exclusion regression',
  (select local_today from activation_backfill_fixture_clock),
  'e5000000-0000-4000-8000-000000000005'
);

insert into public.crew_members (crew_id, user_id, display_name, role)
values (
  'ef000000-0000-4000-8000-000000000005',
  'e5000000-0000-4000-8000-000000000005',
  'Backfill Quarantined Member',
  'owner'
);

-- This constraint was deployed NOT VALID, so production can contain rows that
-- predate it. Recreate that state after inserting deliberately malformed
-- challenge-day evidence.
alter table public.check_ins
  drop constraint if exists check_ins_challenge_day_range;

set local session_replication_role = replica;

insert into private.retired_community_dr_quarantined_crews (
  crew_id,
  source_batch_id,
  quarantined_at
)
values (
  'ef000000-0000-4000-8000-000000000005',
  'ee000000-0000-4000-8000-000000000005',
  pg_catalog.statement_timestamp()
);

insert into public.profiles (
  user_id,
  name,
  email,
  challenge_start_date,
  time_zone,
  created_at,
  updated_at
)
select
  'e1000000-0000-4000-8000-000000000001'::uuid,
  'Backfill Contradiction',
  'activation-backfill-contradiction@example.test',
  fixture.local_today + 30,
  'America/Los_Angeles',
  pg_catalog.statement_timestamp() - interval '30 days',
  pg_catalog.statement_timestamp()
from activation_backfill_fixture_clock fixture
union all
select
  'e2000000-0000-4000-8000-000000000002'::uuid,
  'Backfill Malformed',
  'activation-backfill-malformed@example.test',
  date '0001-01-01 BC',
  'Invalid/Zone',
  'infinity'::timestamptz,
  'infinity'::timestamptz;

insert into public.check_ins (
  user_id,
  entry_date,
  challenge_day,
  status,
  completed_count,
  completed,
  workout_difficulty,
  points_awarded,
  created_at
)
select
  'e1000000-0000-4000-8000-000000000001'::uuid,
  fixture.local_today - 2,
  3,
  'partial',
  1,
  array['bible'],
  '{}'::jsonb,
  1,
  pg_catalog.statement_timestamp() - interval '2 days'
from activation_backfill_fixture_clock fixture
union all
select
  'e2000000-0000-4000-8000-000000000002'::uuid,
  '-infinity'::date,
  2147483647,
  'partial',
  0,
  '{}'::text[],
  '{}'::jsonb,
  0,
  '-infinity'::timestamptz;

insert into public.challenge_entries (
  user_id,
  entry_date,
  completed,
  scheduled_miss,
  workout_difficulty,
  version,
  created_at,
  updated_at
)
values (
  'e2000000-0000-4000-8000-000000000002',
  '-infinity'::date,
  '{}'::text[],
  false,
  '{}'::jsonb,
  0,
  'infinity'::timestamptz,
  'infinity'::timestamptz
);

insert into public.user_game_stats (
  user_id,
  total_points,
  challenge_points,
  current_app_streak,
  best_app_streak,
  current_full_day_streak,
  best_full_day_streak,
  last_seen_date,
  last_full_day_date,
  updated_at
)
values (
  'e2000000-0000-4000-8000-000000000002',
  1,
  1,
  0,
  0,
  0,
  0,
  'infinity'::date,
  date '0001-01-01 BC',
  pg_catalog.statement_timestamp()
);

insert into public.game_point_events (
  user_id,
  event_type,
  points,
  entry_date,
  challenge_day,
  metadata,
  idempotency_key,
  created_at
)
select
  'e1000000-0000-4000-8000-000000000001'::uuid,
  'legacy_fixture',
  1,
  fixture.local_today - 20,
  1,
  '{}'::jsonb,
  'activation-backfill-contradiction-point',
  pg_catalog.statement_timestamp() - interval '20 days'
from activation_backfill_fixture_clock fixture
union all
select
  'e2000000-0000-4000-8000-000000000002'::uuid,
  'legacy_fixture',
  1,
  date '10000-01-01',
  2147483647,
  '{}'::jsonb,
  'activation-backfill-malformed-point',
  'infinity'::timestamptz;

insert into public.user_badges (
  user_id,
  badge_key,
  earned_at,
  entry_date,
  metadata
)
values (
  'e2000000-0000-4000-8000-000000000002',
  'faithful_start',
  'infinity'::timestamptz,
  '-infinity'::date,
  '{}'::jsonb
);

insert into public.user_reward_entitlements (
  user_id,
  reward_key,
  owned_at,
  source_type,
  source_id,
  celebration_seen_at,
  metadata,
  created_at,
  updated_at
)
values (
  'e2000000-0000-4000-8000-000000000002',
  'dominion_night_theme',
  'infinity'::timestamptz,
  'test_fixture',
  'activation-backfill-malformed-reward',
  null,
  '{}'::jsonb,
  'infinity'::timestamptz,
  'infinity'::timestamptz
);

set local session_replication_role = origin;

alter table public.check_ins
  add constraint check_ins_challenge_day_range
  check (challenge_day between 1 and 77) not valid;

commit;
SQL

echo "Proving a non-quiesced row locker forces an atomic rollback..."
lock_holder_log="$(mktemp)"
migration_failure_log="$(mktemp)"
run_psql --set=ON_ERROR_STOP=1 --quiet >"$lock_holder_log" 2>&1 <<'SQL' &
begin;
lock table public.challenge_entries in row share mode;
select pg_catalog.pg_sleep(20);
rollback;
SQL
lock_holder_pid=$!

lock_holder_ready=false
for _ in {1..40}; do
  if [[ "$(run_psql --set=ON_ERROR_STOP=1 --tuples-only --no-align --quiet --command "
    select exists (
      select 1
      from pg_catalog.pg_locks lock_row
      where lock_row.relation = 'public.challenge_entries'::regclass
        and lock_row.mode = 'RowShareLock'
        and lock_row.granted
        and lock_row.pid <> pg_catalog.pg_backend_pid()
    );
  ")" == "t" ]]; then
    lock_holder_ready=true
    break
  fi
  sleep 0.25
done

if [[ "$lock_holder_ready" != "true" ]]; then
  cat "$lock_holder_log" >&2
  echo "The activation cutover lock fixture did not become ready." >&2
  exit 1
fi

set +e
"$supabase_cli" migration up --local >"$migration_failure_log" 2>&1
blocked_migration_status=$?
set -e

lock_holder_status=0
wait "$lock_holder_pid" || lock_holder_status=$?
lock_holder_pid=""
if (( lock_holder_status != 0 )); then
  cat "$lock_holder_log" >&2
  echo "The activation cutover lock fixture failed unexpectedly." >&2
  exit 1
fi
if (( blocked_migration_status == 0 )); then
  cat "$migration_failure_log" >&2
  echo "The activation migration bypassed a pre-existing evidence row lock." >&2
  exit 1
fi
migration_error_rendered=false
if grep -Fq '"code":"LegacyMigrationApplyError"' "$migration_failure_log" \
   || grep -Fq 'effect/sql/SqlError: Failed to execute statement' "$migration_failure_log"; then
  migration_error_rendered=true
fi

expected_lock_fragments=(
  'At statement: 17'
  'lock table'
  'public.challenge_entries,'
  'public.check_ins,'
  'public.crews,'
  'private.retired_community_dr_quarantined_crews,'
  'public.crew_members,'
  'public.crew_invite_attributions,'
  'private.crew_lifecycle_requests,'
  'public.user_game_stats,'
  'public.game_point_events,'
  'public.user_reward_entitlements,'
  'public.user_badges'
  'in exclusive mode'
)

lock_statement_rendered=true
for expected_lock_fragment in "${expected_lock_fragments[@]}"; do
  if ! grep -Fq "$expected_lock_fragment" "$migration_failure_log"; then
    lock_statement_rendered=false
    break
  fi
done

if [[ "$migration_error_rendered" != "true" || "$lock_statement_rendered" != "true" ]]; then
  cat "$migration_failure_log" >&2
  echo "The blocked activation migration did not fail at the complete evidence-table EXCLUSIVE lock." >&2
  exit 1
fi

rollback_verified="$(run_psql \
  --set=ON_ERROR_STOP=1 \
  --tuples-only \
  --no-align \
  --quiet \
  --command "
    select
      to_regclass('private.challenge_activation_requests') is null
      and not exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'profiles'
          and column_name = 'challenge_activation_status'
      )
      and not exists (
        select 1
        from supabase_migrations.schema_migrations
        where version = '20260804200019'
      );
  ")"
if [[ "$rollback_verified" != "t" ]]; then
  cat "$migration_failure_log" >&2
  echo "The timed-out activation migration left partial schema or history behind." >&2
  exit 1
fi
echo "Activation cutover timeout rolled back fully; the drained retry may proceed."

echo "Applying the challenge activation lifecycle migration..."
"$supabase_cli" migration up --local

echo "Activating a fresh account on a non-UTC date boundary..."
run_psql --set=ON_ERROR_STOP=1 --quiet <<'SQL'
begin;
set local role authenticated;
set local "request.jwt.claim.sub" = 'e3000000-0000-4000-8000-000000000003';
set local "request.jwt.claims" =
  '{"sub":"e3000000-0000-4000-8000-000000000003","role":"authenticated","email":"activation-backfill-fresh@example.test","user_metadata":{"name":"Backfill Fresh"}}';

select public.activate_solo_challenge(
  (pg_catalog.statement_timestamp() at time zone 'Pacific/Kiritimati')::date,
  'Pacific/Kiritimati',
  'e3100000-0000-4000-8000-000000000001',
  'e3000000-0000-4000-8000-000000000003'
);
commit;
SQL

echo "Asserting migration precedence, review evidence, protections, and clock invariants..."
run_psql --set=ON_ERROR_STOP=1 --quiet <<'SQL'
do $$
declare
  contradiction_profile public.profiles%rowtype;
  malformed_profile public.profiles%rowtype;
  fresh_profile public.profiles%rowtype;
  contradiction_review private.challenge_activation_migration_reviews%rowtype;
  malformed_review private.challenge_activation_migration_reviews%rowtype;
  fresh_request private.challenge_activation_requests%rowtype;
  inferred_check_in_start date;
  contradiction_point_date date;
  expected_malformed_reasons text[] := array[
    'profile_start_date_outside_supported_range',
    'profile_time_zone_not_supported',
    'profile_created_at_not_supported',
    'check_ins_have_invalid_start_evidence',
    'check_ins_have_invalid_activity_timestamps',
    'drafts_have_invalid_entry_dates',
    'drafts_have_invalid_activity_timestamps',
    'points_have_invalid_entry_dates',
    'points_have_invalid_activity_timestamps',
    'badges_have_invalid_entry_dates',
    'badges_have_invalid_activity_timestamps',
    'rewards_have_invalid_activity_timestamps',
    'stats_last_seen_date_not_supported',
    'stats_last_full_day_date_not_supported',
    'activity_has_no_date_anchor'
  ]::text[];
  start_date_lock_fired boolean := false;
begin
  select * into strict contradiction_profile
  from public.profiles
  where user_id = 'e1000000-0000-4000-8000-000000000001';

  select check_in.entry_date - (check_in.challenge_day - 1)
    into strict inferred_check_in_start
  from public.check_ins check_in
  where check_in.user_id = 'e1000000-0000-4000-8000-000000000001';

  select point_event.entry_date into strict contradiction_point_date
  from public.game_point_events point_event
  where point_event.idempotency_key = 'activation-backfill-contradiction-point';

  if contradiction_profile.challenge_activation_status <> 'active'
     or contradiction_profile.challenge_participation_mode <> 'solo'
     or contradiction_profile.challenge_start_date <> inferred_check_in_start
     or contradiction_profile.challenge_activation_time_zone <> 'America/Los_Angeles'
     or not contradiction_profile.challenge_activation_review_required then
    raise exception 'The future-profile contradiction did not backfill to the check-in timeline: %',
      pg_catalog.row_to_json(contradiction_profile);
  end if;

  if contradiction_point_date >= contradiction_profile.challenge_start_date then
    raise exception 'The precedence fixture no longer proves check-in evidence wins over an earlier point date.';
  end if;

  select * into strict contradiction_review
  from private.challenge_activation_migration_reviews
  where user_id = contradiction_profile.user_id;

  if not array[
      'profile_date_conflicts_with_check_ins',
      'future_start_date_conflicts_with_started_activity'
    ]::text[] <@ contradiction_review.reasons
     or pg_catalog.cardinality(contradiction_review.reasons) <> 2
     or contradiction_review.evidence ->> 'checkInStartDate'
        <> inferred_check_in_start::text
     or contradiction_review.evidence ->> 'chosenStartDate'
        <> inferred_check_in_start::text
     or (contradiction_review.evidence ->> 'futureStartOverridden')::boolean is not true then
    raise exception 'The contradiction review did not retain exact precedence evidence: % / %',
      contradiction_review.reasons,
      contradiction_review.evidence;
  end if;

  select * into strict malformed_profile
  from public.profiles
  where user_id = 'e2000000-0000-4000-8000-000000000002';

  if malformed_profile.challenge_activation_status <> 'active'
     or malformed_profile.challenge_participation_mode <> 'solo'
     or malformed_profile.challenge_activation_time_zone <> 'UTC'
     or not malformed_profile.challenge_activation_review_required
     or not pg_catalog.isfinite(malformed_profile.challenge_start_date)
     or malformed_profile.challenge_start_date
        not between date '0001-01-01' and date '9999-12-31'
     or not pg_catalog.isfinite(malformed_profile.challenge_activated_at)
     or not pg_catalog.isfinite(malformed_profile.challenge_confirmed_at)
     or malformed_profile.challenge_activated_at not between
        timestamptz '0001-01-01 00:00:00+00'
        and timestamptz '9999-12-31 23:59:59.999999+00'
     or malformed_profile.challenge_confirmed_at not between
        timestamptz '0001-01-01 00:00:00+00'
        and timestamptz '9999-12-31 23:59:59.999999+00' then
    raise exception 'Malformed legacy evidence did not normalize to a supported lifecycle shape: %',
      pg_catalog.row_to_json(malformed_profile);
  end if;

  select * into strict malformed_review
  from private.challenge_activation_migration_reviews
  where user_id = malformed_profile.user_id;

  if not expected_malformed_reasons <@ malformed_review.reasons
     or pg_catalog.cardinality(malformed_review.reasons)
        <> pg_catalog.cardinality(expected_malformed_reasons) then
    raise exception 'Malformed evidence review reasons differ: expected %, found %',
      expected_malformed_reasons,
      malformed_review.reasons;
  end if;

  if (malformed_review.evidence ->> 'invalidCheckInStartEvidenceCount')::integer <> 1
     or (malformed_review.evidence ->> 'invalidCheckInActivityTimestampCount')::integer <> 1
     or (malformed_review.evidence ->> 'invalidDraftEntryDateCount')::integer <> 1
     or (malformed_review.evidence ->> 'invalidDraftActivityTimestampCount')::integer <> 1
     or (malformed_review.evidence ->> 'invalidPointEntryDateCount')::integer <> 1
     or (malformed_review.evidence ->> 'invalidPointActivityTimestampCount')::integer <> 1
     or (malformed_review.evidence ->> 'invalidBadgeEntryDateCount')::integer <> 1
     or (malformed_review.evidence ->> 'invalidBadgeActivityTimestampCount')::integer <> 1
     or (malformed_review.evidence ->> 'invalidRewardActivityTimestampCount')::integer <> 1
     or (malformed_review.evidence ->> 'invalidLastSeenDateCount')::integer <> 1
     or (malformed_review.evidence ->> 'invalidLastFullDayDateCount')::integer <> 1
     or (malformed_review.evidence ->> 'invalidProfileCreatedAtCount')::integer <> 1 then
    raise exception 'Malformed evidence counts were not preserved exactly: %',
      malformed_review.evidence;
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = 'public.profiles'::regclass
      and constraint_row.conname = 'profiles_challenge_activation_shape_check'
      and constraint_row.convalidated
  ) then
    raise exception 'The activation shape constraint was not validated.';
  end if;

  if not exists (
    select 1
    from public.crews crew_row
    where crew_row.id = 'ef000000-0000-4000-8000-000000000004'
      and crew_row.created_by is null
  ) then
    raise exception 'The erased-owner crew fixture was not retained with a nullable creator.';
  end if;

  if not exists (
    select 1
    from private.crew_lifecycle_requests request_row
    where request_row.request_id = 'e4100000-0000-4000-8000-000000000004'
      and request_row.actor_id = 'e4000000-0000-4000-8000-000000000004'
      and not exists (
        select 1
        from auth.users auth_user
        where auth_user.id = request_row.actor_id
      )
  ) then
    raise exception 'The orphan lifecycle audit fixture was not preserved.';
  end if;

  if not exists (
       select 1
       from private.retired_community_dr_quarantined_crews quarantine
       where quarantine.crew_id = 'ef000000-0000-4000-8000-000000000005'
     )
     or exists (
       select 1
       from public.profiles profile
       where profile.user_id = 'e5000000-0000-4000-8000-000000000005'
     )
     or exists (
       select 1
       from private.challenge_activation_migration_reviews review_row
       where review_row.user_id = 'e5000000-0000-4000-8000-000000000005'
     ) then
    raise exception 'Quarantined Group evidence was restored into challenge activation.';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.profiles'::regclass
      and trigger_row.tgname = 'lock_challenge_start_date_after_check_in'
      and not trigger_row.tgisinternal
      and trigger_row.tgenabled <> 'D'
  ) then
    raise exception 'The post-check-in challenge-date lock trigger was not restored.';
  end if;

  begin
    update public.profiles
    set challenge_start_date = challenge_start_date - 1
    where user_id = contradiction_profile.user_id;
  exception
    when raise_exception then
      if sqlerrm <> 'The challenge start date is locked after the first check-in.' then
        raise;
      end if;
      start_date_lock_fired := true;
  end;
  if not start_date_lock_fired then
    raise exception 'The restored post-check-in challenge-date trigger allowed a rewrite.';
  end if;

  if pg_catalog.has_column_privilege(
       'authenticated', 'public.profiles', 'challenge_start_date', 'insert'
     )
     or pg_catalog.has_column_privilege(
       'authenticated', 'public.profiles', 'challenge_start_date', 'update'
     )
     or pg_catalog.has_column_privilege(
       'authenticated', 'public.crews', 'challenge_start_date', 'update'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.mutate_daily_standard_draft_pre_activation(date,text,boolean,bigint)',
       'execute'
     )
     or not pg_catalog.has_column_privilege(
       'authenticated', 'public.profiles', 'name', 'update'
     )
     or not pg_catalog.has_column_privilege(
       'authenticated', 'public.crews', 'name', 'update'
     )
     or not pg_catalog.has_function_privilege(
       'authenticated',
       'public.mutate_daily_standard_draft(date,text,boolean,bigint,uuid)',
       'execute'
     ) then
    raise exception 'The selective direct-write/function grants were not restored.';
  end if;

  select * into strict fresh_profile
  from public.profiles
  where user_id = 'e3000000-0000-4000-8000-000000000003';

  select * into strict fresh_request
  from private.challenge_activation_requests
  where request_id = 'e3100000-0000-4000-8000-000000000001';

  if fresh_profile.challenge_activation_status <> 'active'
     or fresh_profile.challenge_participation_mode <> 'solo'
     or fresh_profile.challenge_activation_time_zone <> 'Pacific/Kiritimati'
     or fresh_profile.challenge_start_date <>
        (fresh_profile.challenge_confirmed_at at time zone
          fresh_profile.challenge_activation_time_zone)::date
     or fresh_profile.challenge_activated_at <> fresh_profile.challenge_confirmed_at
     or fresh_profile.challenge_confirmed_at <> fresh_profile.challenge_activation_updated_at
     or fresh_profile.challenge_confirmed_at <> fresh_request.created_at
     or fresh_profile.challenge_activation_request_id <> fresh_request.request_id
     or fresh_request.actor_id <> fresh_profile.user_id
     or fresh_request.action <> 'solo_activate'
     or fresh_request.result ->> 'status' <> 'active'
     or fresh_request.result ->> 'mode' <> 'solo'
     or fresh_request.result ->> 'startDate' <> fresh_profile.challenge_start_date::text
     or (fresh_request.result ->> 'challengeDay')::integer <> 1 then
    raise exception 'The non-UTC activation did not use one authoritative statement time: % / %',
      pg_catalog.row_to_json(fresh_profile),
      pg_catalog.row_to_json(fresh_request);
  end if;
end;
$$;
SQL

echo "Challenge activation pre-migration backfill checks passed."
