#!/usr/bin/env bash
set -euo pipefail

database_url="${SUPABASE_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
case "$database_url" in
  postgresql://*@127.0.0.1:54322/*|postgres://*@127.0.0.1:54322/*|postgresql://*@localhost:54322/*|postgres://*@localhost:54322/*) ;;
  *) echo "Refusing to run crew training races against a non-local database." >&2; exit 2 ;;
esac
command -v psql >/dev/null 2>&1 || { echo "psql is required." >&2; exit 2; }

test_directory="$(mktemp -d)"
owner_id="b1000000-0000-4000-8000-000000000001"
crew_id="bb000000-0000-4000-8000-000000000001"

cleanup_fixture() {
  psql "$database_url" --set=ON_ERROR_STOP=1 --quiet <<SQL
delete from public.crews where id = '$crew_id';
delete from auth.users where id = '$owner_id';
SQL
}

cleanup_fixture
trap 'cleanup_fixture >/dev/null 2>&1 || true; rm -rf "$test_directory"' EXIT

psql "$database_url" --set=ON_ERROR_STOP=1 --quiet <<SQL
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values (
  '00000000-0000-0000-0000-000000000000', '$owner_id',
  'authenticated', 'authenticated', 'training-race@example.test', 'fixture', now(),
  '{"provider":"email","providers":["email"]}',
  '{"name":"Training Race Owner"}', now(), now()
);

insert into public.profiles (user_id, name, email, time_zone)
values ('$owner_id', 'Training Race Owner', 'training-race@example.test', 'UTC')
on conflict (user_id) do update
set name = excluded.name, email = excluded.email;

insert into public.crews (id, name, description, created_by)
values ('$crew_id', 'Training Race Crew', 'Concurrent claim coverage', '$owner_id');

insert into public.crew_members (crew_id, user_id, display_name, role)
values ('$crew_id', '$owner_id', 'Training Race Owner', 'owner');
SQL

claim_training() {
  local output_file="$1"
  psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align --command "
    begin;
    set local statement_timeout = '10s';
    set local role authenticated;
    set local \"request.jwt.claim.sub\" = '$owner_id';
    select public.claim_crew_training('$crew_id', 1) ->> 'claimedNow';
    commit;
  " >"$output_file" 2>&1
}

claim_training "$test_directory/claim-first.log" &
first_claim_pid=$!
claim_training "$test_directory/claim-second.log" &
second_claim_pid=$!
first_claim_status=0
second_claim_status=0
wait "$first_claim_pid" || first_claim_status=$?
wait "$second_claim_pid" || second_claim_status=$?

if (( first_claim_status != 0 || second_claim_status != 0 )); then
  cat "$test_directory/claim-first.log" "$test_directory/claim-second.log" >&2
  echo "Concurrent crew training claims did not both complete." >&2
  exit 1
fi

claimed_true="$(
  grep -h -c '^true$' "$test_directory/claim-first.log" "$test_directory/claim-second.log" \
    | awk '{ total += $1 } END { print total + 0 }'
)"
claimed_false="$(
  grep -h -c '^false$' "$test_directory/claim-first.log" "$test_directory/claim-second.log" \
    | awk '{ total += $1 } END { print total + 0 }'
)"
progress_rows="$(
  psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align --command "
    select count(*)
    from private.crew_training_progress
    where crew_id = '$crew_id' and user_id = '$owner_id' and content_version = 1;
  "
)"

if [[ "$claimed_true $claimed_false $progress_rows" != "1 1 1" ]]; then
  cat "$test_directory/claim-first.log" "$test_directory/claim-second.log" >&2
  echo "Concurrent claims did not converge to one claim and one progress row ($claimed_true/$claimed_false/$progress_rows)." >&2
  exit 1
fi

delayed_advance_two() {
  psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align --command "
    begin;
    set local statement_timeout = '10s';
    set local role authenticated;
    set local \"request.jwt.claim.sub\" = '$owner_id';
    select pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('crew-training-timestamp-race-started', 822)
    );
    select pg_catalog.pg_sleep(1);
    select public.advance_crew_training('$crew_id', 1, 'advance', 2) ->> 'updatedAt';
    commit;
  " >"$test_directory/delayed-advance.log" 2>&1
}

# Start the step-two transaction first, but make it mutate after a newer
# transaction completes step one. Transaction-scoped now() would regress the
# final timestamp; the post-lock clock must remain monotonic.
delayed_advance_two &
delayed_advance_pid=$!
older_transaction_started=0
for _attempt in {1..40}; do
  older_transaction_started="$(
    psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align --command "
      select case when not pg_catalog.pg_try_advisory_lock(
        pg_catalog.hashtextextended('crew-training-timestamp-race-started', 822)
      ) then 1 else 0 end;
    "
  )"
  [[ "$older_transaction_started" == "1" ]] && break
  sleep 0.05
done
if [[ "$older_transaction_started" != "1" ]]; then
  echo "The deliberately older training transaction did not start in time." >&2
  exit 1
fi

step_one_updated_at="$(
  psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align --command "
    begin;
    set local role authenticated;
    set local \"request.jwt.claim.sub\" = '$owner_id';
    select public.advance_crew_training('$crew_id', 1, 'advance', 1) ->> 'updatedAt';
    commit;
  "
)"
delayed_advance_status=0
wait "$delayed_advance_pid" || delayed_advance_status=$?
if (( delayed_advance_status != 0 )); then
  cat "$test_directory/delayed-advance.log" >&2
  echo "The deliberately older training transaction failed to advance step two." >&2
  exit 1
fi

read -r ordered_step timestamp_monotonic <<<"$(
  psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align \
    --field-separator=' ' --command "
      select current_step, (updated_at >= '$step_one_updated_at'::timestamptz)::integer
      from private.crew_training_progress
      where crew_id = '$crew_id' and user_id = '$owner_id' and content_version = 1;
    "
)"
if [[ "$ordered_step $timestamp_monotonic" != "2 1" ]]; then
  cat "$test_directory/delayed-advance.log" >&2
  echo "An older transaction regressed ordered training time ($ordered_step/$timestamp_monotonic)." >&2
  exit 1
fi

psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --command "
  begin;
  set local role authenticated;
  set local \"request.jwt.claim.sub\" = '$owner_id';
  select public.advance_crew_training('$crew_id', 1, 'advance', step_number)
  from generate_series(3, 6) step_number;
  commit;
" >/dev/null

mutate_training() {
  local action="$1" step="$2" output_file="$3"
  psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align --command "
    begin;
    set local statement_timeout = '10s';
    set local role authenticated;
    set local \"request.jwt.claim.sub\" = '$owner_id';
    select public.advance_crew_training('$crew_id', 1, '$action', $step) ->> 'status';
    commit;
  " >"$output_file" 2>&1
}

# A final-step skip and finish may arrive from different tabs in either order.
# The finish operation has terminal precedence: both transactions must complete,
# and the persisted row must end completed regardless of lock acquisition order.
mutate_training complete 6 "$test_directory/complete.log" &
complete_pid=$!
mutate_training skip 6 "$test_directory/stale-skip.log" &
skip_pid=$!
complete_status=0
skip_status=0
wait "$complete_pid" || complete_status=$?
wait "$skip_pid" || skip_status=$?

if (( complete_status != 0 || skip_status != 0 )); then
  cat "$test_directory/complete.log" "$test_directory/stale-skip.log" >&2
  echo "Concurrent finish and stale skip did not both complete." >&2
  exit 1
fi

read -r final_status final_current final_furthest completed_rows timestamps_ordered <<<"$(
  psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align \
    --field-separator=' ' --command "
      select status, current_step, furthest_step,
        case when completed_at is null then 0 else 1 end,
        case when completed_at >= coalesce(skipped_at, completed_at)
               and updated_at >= completed_at then 1 else 0 end
      from private.crew_training_progress
      where crew_id = '$crew_id' and user_id = '$owner_id' and content_version = 1;
    "
)"

if [[ "$final_status $final_current $final_furthest $completed_rows $timestamps_ordered" != "completed 6 6 1 1" ]]; then
  cat "$test_directory/complete.log" "$test_directory/stale-skip.log" >&2
  echo "Finish did not remain terminal and timestamp-ordered after the stale-tab race ($final_status/$final_current/$final_furthest/$completed_rows/$timestamps_ordered)." >&2
  exit 1
fi

psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --command "
  delete from public.crew_members
  where crew_id = '$crew_id' and user_id = '$owner_id';
" >/dev/null

remaining_rows="$(
  psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align --command "
    select count(*) from private.crew_training_progress
    where crew_id = '$crew_id' and user_id = '$owner_id';
  "
)"
if [[ "$remaining_rows" != "0" ]]; then
  echo "Membership removal left stale crew training progress." >&2
  exit 1
fi

if psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --command "
  begin;
  set local role authenticated;
  set local \"request.jwt.claim.sub\" = '$owner_id';
  select public.get_crew_training_progress('$crew_id', 1);
  commit;
" >"$test_directory/stale-read.log" 2>&1; then
  cat "$test_directory/stale-read.log" >&2
  echo "A stale session could still read training after membership removal." >&2
  exit 1
fi

echo "Crew training concurrency checks passed: one claim, terminal completion, and no stale post-membership progress."
