#!/usr/bin/env bash
set -euo pipefail

database_url="${SUPABASE_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
case "$database_url" in
  postgresql://*@127.0.0.1:54322/*|postgres://*@127.0.0.1:54322/*|postgresql://*@localhost:54322/*|postgres://*@localhost:54322/*) ;;
  *) echo "Refusing to run site training races against a non-local database." >&2; exit 2 ;;
esac
command -v psql >/dev/null 2>&1 || { echo "psql is required." >&2; exit 2; }

test_directory="$(mktemp -d)"
race_user="e1000000-0000-4000-8000-000000000001"
erasure_user="e2000000-0000-4000-8000-000000000002"
cross_scope_user="e3000000-0000-4000-8000-000000000003"
page_id="concurrency-fixture"
program_id="concurrency-program"
same_request="e1100000-0000-4000-8000-000000000001"
next_request="e1100000-0000-4000-8000-000000000002"
stop_request="e1100000-0000-4000-8000-000000000003"
erasure_claim_request="e2100000-0000-4000-8000-000000000001"
erasure_transition_request="e2100000-0000-4000-8000-000000000002"
cross_page_claim_request="e3100000-0000-4000-8000-000000000001"
cross_overall_claim_request="e3100000-0000-4000-8000-000000000002"
cross_page_next_request="e3100000-0000-4000-8000-000000000003"
cross_overall_next_request="e3100000-0000-4000-8000-000000000004"

cleanup_fixture() {
  psql "$database_url" --set=ON_ERROR_STOP=1 --quiet <<SQL
delete from auth.users where id in ('$race_user', '$erasure_user', '$cross_scope_user');
delete from private.site_training_program_pages
where program_id = '$program_id' and program_version = 1;
delete from private.site_training_program_versions
where program_id = '$program_id' and program_version = 1;
delete from private.site_training_page_versions
where page_id = '$page_id' and content_version = 1;
SQL
}

cleanup_fixture
trap 'cleanup_fixture >/dev/null 2>&1 || true; rm -rf "$test_directory"' EXIT

psql "$database_url" --set=ON_ERROR_STOP=1 --quiet <<SQL
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000', '$race_user',
    'authenticated', 'authenticated', 'site-training-race@example.test',
    'fixture', now(), '{"provider":"email"}', '{"name":"Training Race"}', now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000', '$erasure_user',
    'authenticated', 'authenticated', 'site-training-erasure@example.test',
    'fixture', now(), '{"provider":"email"}', '{"name":"Training Erasure"}', now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000', '$cross_scope_user',
    'authenticated', 'authenticated', 'site-training-cross-scope@example.test',
    'fixture', now(), '{"provider":"email"}', '{"name":"Training Cross Scope"}', now(), now()
  );

insert into private.site_training_page_versions (
  page_id, content_version, canonical_route, step_ids
)
values ('$page_id', 1, '/concurrency-fixture', array['first', 'second', 'third']);

insert into private.site_training_program_versions (program_id, program_version, audience)
values ('$program_id', 1, 'all');

insert into private.site_training_program_pages (
  program_id, program_version, page_id, page_content_version, page_index
)
values ('$program_id', 1, '$page_id', 1, 0);
SQL

claim_training() {
  local user_id="$1" request_id="$2" output_file="$3"
  psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align --command "
    begin;
    set local statement_timeout = '10s';
    set local role authenticated;
    set local \"request.jwt.claim.sub\" = '$user_id';
    select public.claim_site_training(
      'page', '$page_id', 1, null, null, 'start',
      '$request_id', 0, 0, '$user_id'
    )::text;
    commit;
  " >"$output_file" 2>&1
}

# Identical requests from two devices must converge on one stored response.
claim_training "$race_user" "$same_request" "$test_directory/claim-one.log" &
claim_one_pid=$!
claim_training "$race_user" "$same_request" "$test_directory/claim-two.log" &
claim_two_pid=$!
claim_one_status=0
claim_two_status=0
wait "$claim_one_pid" || claim_one_status=$?
wait "$claim_two_pid" || claim_two_status=$?
if (( claim_one_status != 0 || claim_two_status != 0 )); then
  cat "$test_directory/claim-one.log" "$test_directory/claim-two.log" >&2
  echo "Concurrent site training claims did not both complete." >&2
  exit 1
fi
if ! cmp -s "$test_directory/claim-one.log" "$test_directory/claim-two.log"; then
  cat "$test_directory/claim-one.log" "$test_directory/claim-two.log" >&2
  echo "Identical site training requests returned different stored results." >&2
  exit 1
fi

read -r claim_rows request_rows claim_revision <<<"$(
  psql "$database_url" --set=ON_ERROR_STOP=1 --tuples-only --no-align \
    --field-separator=' ' --command "
      select
        (select count(*) from private.site_training_page_progress
         where user_id = '$race_user' and page_id = '$page_id'),
        (select count(*) from private.site_training_transition_requests
         where actor_id = '$race_user'),
        (select revision from private.site_training_page_progress
         where user_id = '$race_user' and page_id = '$page_id');
    "
)"
if [[ "$claim_rows $request_rows $claim_revision" != "1 1 1" ]]; then
  echo "Concurrent claims did not converge to one row/request/revision ($claim_rows/$request_rows/$claim_revision)." >&2
  exit 1
fi

mutate_training() {
  local action="$1" request_id="$2" output_file="$3"
  psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align --command "
    begin;
    set local statement_timeout = '10s';
    set local role authenticated;
    set local \"request.jwt.claim.sub\" = '$race_user';
    select public.transition_site_training(
      'page', '$page_id', 1, null, null, '$action',
      '$request_id', 1, 1, '$race_user'
    )::text;
    commit;
  " >"$output_file" 2>&1
}

# Two tabs mutate the same revision. CAS permits one winner and rolls the stale
# request back without recording partial evidence.
mutate_training next "$next_request" "$test_directory/next.log" &
next_pid=$!
mutate_training stop "$stop_request" "$test_directory/stop.log" &
stop_pid=$!
next_status=0
stop_status=0
wait "$next_pid" || next_status=$?
wait "$stop_pid" || stop_status=$?
if (( (next_status == 0) == (stop_status == 0) )); then
  cat "$test_directory/next.log" "$test_directory/stop.log" >&2
  echo "The stale site training revision race did not produce exactly one winner." >&2
  exit 1
fi
if ! grep -q 'Site training changed in another session' \
  "$test_directory/next.log" "$test_directory/stop.log"; then
  cat "$test_directory/next.log" "$test_directory/stop.log" >&2
  echo "The losing site training mutation did not fail at revision CAS." >&2
  exit 1
fi

read -r raced_revision raced_requests raced_rows valid_state <<<"$(
  psql "$database_url" --set=ON_ERROR_STOP=1 --tuples-only --no-align \
    --field-separator=' ' --command "
      select progress.revision,
        (select count(*) from private.site_training_transition_requests
         where actor_id = '$race_user'),
        (select count(*) from private.site_training_page_progress
         where user_id = '$race_user' and page_id = '$page_id'),
        case
          when progress.status = 'in_progress' and progress.current_step_index = 1 then 1
          when progress.status = 'stopped' and progress.current_step_index = 0 then 1
          else 0
        end
      from private.site_training_page_progress progress
      where progress.user_id = '$race_user' and progress.page_id = '$page_id';
    "
)"
if [[ "$raced_revision $raced_requests $raced_rows $valid_state" != "2 2 1 1" ]]; then
  cat "$test_directory/next.log" "$test_directory/stop.log" >&2
  echo "The stale revision race left partial state ($raced_revision/$raced_requests/$raced_rows/$valid_state)." >&2
  exit 1
fi

psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --command "
  begin;
  set local statement_timeout = '10s';
  set local role authenticated;
  set local \"request.jwt.claim.sub\" = '$cross_scope_user';
  select public.claim_site_training(
    'page', '$page_id', 1, null, null, 'start',
    '$cross_page_claim_request', 0, 0, '$cross_scope_user'
  );
  select public.claim_site_training(
    'overall', '$page_id', 1, '$program_id', 1, 'start',
    '$cross_overall_claim_request', 0, 1, '$cross_scope_user'
  );
  commit;
" >"$test_directory/cross-claims.log" 2>&1

mutate_cross_scope_training() {
  local scope="$1" request_id="$2" output_file="$3"
  local target_program_id="null" target_program_version="null"
  if [[ "$scope" == "overall" ]]; then
    target_program_id="'$program_id'"
    target_program_version="1"
  fi
  psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align --command "
    begin;
    set local statement_timeout = '10s';
    set local role authenticated;
    set local \"request.jwt.claim.sub\" = '$cross_scope_user';
    select public.transition_site_training(
      '$scope', '$page_id', 1, $target_program_id, $target_program_version, 'next',
      '$request_id', 1, 1, '$cross_scope_user'
    )::text;
    commit;
  " >"$output_file" 2>&1
}

# Page and overall controls share one page-progress row. Their separate scope
# cursors may both be current, but the shared page CAS permits only one move.
mutate_cross_scope_training page "$cross_page_next_request" "$test_directory/cross-page.log" &
cross_page_pid=$!
mutate_cross_scope_training overall "$cross_overall_next_request" "$test_directory/cross-overall.log" &
cross_overall_pid=$!
cross_page_status=0
cross_overall_status=0
wait "$cross_page_pid" || cross_page_status=$?
wait "$cross_overall_pid" || cross_overall_status=$?
if (( (cross_page_status == 0) == (cross_overall_status == 0) )); then
  cat "$test_directory/cross-page.log" "$test_directory/cross-overall.log" >&2
  echo "The cross-scope page race did not produce exactly one winner." >&2
  exit 1
fi
if ! grep -q 'Site training changed in another session' \
  "$test_directory/cross-page.log" "$test_directory/cross-overall.log"; then
  cat "$test_directory/cross-page.log" "$test_directory/cross-overall.log" >&2
  echo "The losing cross-scope mutation did not fail at the shared page CAS." >&2
  exit 1
fi

read -r cross_page_revision cross_page_index cross_page_status_value \
  cross_overall_revision cross_request_rows <<<"$(
  psql "$database_url" --set=ON_ERROR_STOP=1 --tuples-only --no-align \
    --field-separator=' ' --command "
      select page.revision, page.current_step_index, page.status, overall_progress.revision,
        (select count(*) from private.site_training_transition_requests
         where actor_id = '$cross_scope_user')
      from private.site_training_page_progress page
      join private.site_training_program_progress overall_progress
        on overall_progress.user_id = page.user_id
       and overall_progress.program_id = '$program_id'
       and overall_progress.program_version = 1
      where page.user_id = '$cross_scope_user'
        and page.page_id = '$page_id' and page.content_version = 1;
    "
)"
if [[ "$cross_page_revision $cross_page_index $cross_page_status_value $cross_request_rows" \
    != "2 1 in_progress 3" \
    || ( "$cross_overall_revision" != "1" && "$cross_overall_revision" != "2" ) ]]; then
  cat "$test_directory/cross-page.log" "$test_directory/cross-overall.log" >&2
  echo "The cross-scope race skipped or partially stored progress ($cross_page_revision/$cross_page_index/$cross_page_status_value/$cross_overall_revision/$cross_request_rows)." >&2
  exit 1
fi

claim_training "$erasure_user" "$erasure_claim_request" "$test_directory/erasure-claim.log"

# Account erasure takes the auth parent lock first. A training mutation that
# starts second must wait, observe the deleted actor, and leave no orphan rows.
psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --command "
  begin;
  set local statement_timeout = '10s';
  select id from auth.users where id = '$erasure_user' for update;
  select pg_sleep(1.5) /* site-training-erasure-parent-lock */;
  delete from auth.users where id = '$erasure_user';
  commit;
" >"$test_directory/erasure-delete.log" 2>&1 &
erasure_delete_pid=$!

erasure_parent_locked=false
for _attempt in $(seq 1 100); do
  if [[ "$(psql "$database_url" --set=ON_ERROR_STOP=1 --tuples-only --no-align --command "
    select exists (
      select 1 from pg_catalog.pg_stat_activity activity
      where activity.query like '%site-training-erasure-parent-lock%'
        and activity.wait_event = 'PgSleep'
    );
  ")" == "t" ]]; then
    erasure_parent_locked=true
    break
  fi
  sleep 0.05
done
if [[ "$erasure_parent_locked" != "true" ]]; then
  cat "$test_directory/erasure-delete.log" >&2
  echo "The account-erasure fixture did not acquire its auth parent lock." >&2
  exit 1
fi

psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --command "
  begin;
  set local statement_timeout = '10s';
  set local role authenticated;
  set local \"request.jwt.claim.sub\" = '$erasure_user';
  select public.transition_site_training(
    'page', '$page_id', 1, null, null, 'next',
    '$erasure_transition_request', 1, 1, '$erasure_user'
  );
  commit;
" >"$test_directory/erasure-mutation.log" 2>&1 &
erasure_mutation_pid=$!

erasure_delete_status=0
erasure_mutation_status=0
wait "$erasure_delete_pid" || erasure_delete_status=$?
wait "$erasure_mutation_pid" || erasure_mutation_status=$?
if (( erasure_delete_status != 0 || erasure_mutation_status == 0 )); then
  cat "$test_directory/erasure-delete.log" "$test_directory/erasure-mutation.log" >&2
  echo "Account erasure and site training mutation did not serialize safely." >&2
  exit 1
fi
if ! grep -q 'site_training_actor_missing' "$test_directory/erasure-mutation.log"; then
  cat "$test_directory/erasure-mutation.log" >&2
  echo "The post-erasure mutation did not fail at the auth-parent guard." >&2
  exit 1
fi

read -r erased_auth erased_progress erased_requests <<<"$(
  psql "$database_url" --set=ON_ERROR_STOP=1 --tuples-only --no-align \
    --field-separator=' ' --command "
      select
        exists (select 1 from auth.users where id = '$erasure_user'),
        exists (select 1 from private.site_training_page_progress where user_id = '$erasure_user'),
        exists (select 1 from private.site_training_transition_requests where actor_id = '$erasure_user');
    "
)"
if [[ "$erased_auth $erased_progress $erased_requests" != "f f f" ]]; then
  echo "Account erasure left site training state behind ($erased_auth/$erased_progress/$erased_requests)." >&2
  exit 1
fi

echo "Site training concurrency checks passed: exact replay, same-scope and cross-scope CAS, and account-erasure serialization."
