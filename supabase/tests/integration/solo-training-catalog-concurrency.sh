#!/usr/bin/env bash
set -euo pipefail

database_url="${SUPABASE_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
case "$database_url" in
  postgresql://*@127.0.0.1:54322/*|postgres://*@127.0.0.1:54322/*|postgresql://*@localhost:54322/*|postgres://*@localhost:54322/*) ;;
  *) echo "Refusing to run Solo training races against a non-local database." >&2; exit 2 ;;
esac
psql_bin="${PSQL_BIN:-$(command -v psql || true)}"
[[ -x "$psql_bin" ]] || { echo "psql is required." >&2; exit 2; }
psql() { "$psql_bin" "$@"; }

test_directory="$(mktemp -d)"
primary_user="f3000000-0000-4000-8000-000000000003"
isolated_user="f4000000-0000-4000-8000-000000000004"
shared_request="f3100000-0000-4000-8000-000000000001"
isolated_request="f4100000-0000-4000-8000-000000000001"
next_request="f3100000-0000-4000-8000-000000000002"
stop_request="f3100000-0000-4000-8000-000000000003"

cleanup_fixture() {
  psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --command "
    delete from auth.users
    where id in ('$primary_user', '$isolated_user');
  "
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
    '00000000-0000-0000-0000-000000000000', '$primary_user',
    'authenticated', 'authenticated', 'solo-training-race@example.test',
    'fixture', now(), '{"provider":"email"}', '{"name":"Solo Training Race"}',
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000', '$isolated_user',
    'authenticated', 'authenticated', 'solo-training-isolated-race@example.test',
    'fixture', now(), '{"provider":"email"}', '{"name":"Solo Training Isolated"}',
    now(), now()
  );
SQL

claim_overall_training() {
  local user_id="$1" request_id="$2" output_file="$3"
  psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align --command "
    begin;
    set local statement_timeout = '10s';
    set local role authenticated;
    set local \"request.jwt.claim.sub\" = '$user_id';
    select public.claim_site_training(
      'overall', 'dashboard', 1, 'solo-first-run', 1, 'start',
      '$request_id', 0, 0, '$user_id'
    )::text;
    commit;
  " >"$output_file" 2>&1
}

# A retry racing the original request must converge on the one durable response.
claim_overall_training "$primary_user" "$shared_request" "$test_directory/claim-one.log" &
claim_one_pid=$!
claim_overall_training "$primary_user" "$shared_request" "$test_directory/claim-two.log" &
claim_two_pid=$!
claim_one_status=0
claim_two_status=0
wait "$claim_one_pid" || claim_one_status=$?
wait "$claim_two_pid" || claim_two_status=$?
if (( claim_one_status != 0 || claim_two_status != 0 )); then
  cat "$test_directory/claim-one.log" "$test_directory/claim-two.log" >&2
  echo "Concurrent Solo training claims did not both complete." >&2
  exit 1
fi
if ! cmp -s "$test_directory/claim-one.log" "$test_directory/claim-two.log"; then
  cat "$test_directory/claim-one.log" "$test_directory/claim-two.log" >&2
  echo "Concurrent Solo training retries returned different stored responses." >&2
  exit 1
fi

claim_overall_training "$isolated_user" "$isolated_request" "$test_directory/isolated.log"

read -r primary_program primary_page primary_requests isolated_program isolated_page \
  isolated_requests <<<"$(
  psql "$database_url" --set=ON_ERROR_STOP=1 --tuples-only --no-align \
    --field-separator=' ' --command "
      select
        (select count(*) from private.site_training_program_progress
         where user_id = '$primary_user' and program_id = 'solo-first-run'),
        (select count(*) from private.site_training_page_progress
         where user_id = '$primary_user' and page_id = 'dashboard'),
        (select count(*) from private.site_training_transition_requests
         where actor_id = '$primary_user'),
        (select count(*) from private.site_training_program_progress
         where user_id = '$isolated_user' and program_id = 'solo-first-run'),
        (select count(*) from private.site_training_page_progress
         where user_id = '$isolated_user' and page_id = 'dashboard'),
        (select count(*) from private.site_training_transition_requests
         where actor_id = '$isolated_user');
    "
)"
if [[ "$primary_program $primary_page $primary_requests $isolated_program $isolated_page $isolated_requests" \
    != "1 1 1 1 1 1" ]]; then
  echo "Solo training claims did not remain singular and actor-isolated." >&2
  exit 1
fi

mutate_overall_training() {
  local action="$1" request_id="$2" output_file="$3"
  psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align --command "
    begin;
    set local statement_timeout = '10s';
    set local role authenticated;
    set local \"request.jwt.claim.sub\" = '$primary_user';
    select public.transition_site_training(
      'overall', 'dashboard', 1, 'solo-first-run', 1, '$action',
      '$request_id', 1, 1, '$primary_user'
    )::text;
    commit;
  " >"$output_file" 2>&1
}

# Two tabs share the same program/page revisions. Exactly one mutation wins;
# the loser must fail before persisting request evidence or partial state.
mutate_overall_training next "$next_request" "$test_directory/next.log" &
next_pid=$!
mutate_overall_training stop "$stop_request" "$test_directory/stop.log" &
stop_pid=$!
next_status=0
stop_status=0
wait "$next_pid" || next_status=$?
wait "$stop_pid" || stop_status=$?
if (( (next_status == 0) == (stop_status == 0) )); then
  cat "$test_directory/next.log" "$test_directory/stop.log" >&2
  echo "The Solo training stale-revision race did not produce one winner." >&2
  exit 1
fi
if ! grep -q 'Site training changed in another session' \
  "$test_directory/next.log" "$test_directory/stop.log"; then
  cat "$test_directory/next.log" "$test_directory/stop.log" >&2
  echo "The losing Solo training mutation did not fail at revision CAS." >&2
  exit 1
fi

read -r page_revision page_index page_status program_revision program_status request_rows <<<"$(
  psql "$database_url" --set=ON_ERROR_STOP=1 --tuples-only --no-align \
    --field-separator=' ' --command "
      select page.revision, page.current_step_index, page.status,
        program.revision, program.status,
        (select count(*) from private.site_training_transition_requests
         where actor_id = '$primary_user')
      from private.site_training_page_progress page
      join private.site_training_program_progress program
        on program.user_id = page.user_id
       and program.program_id = 'solo-first-run'
       and program.program_version = 1
      where page.user_id = '$primary_user'
        and page.page_id = 'dashboard'
        and page.content_version = 1;
    "
)"
valid_winner=false
if [[ "$page_status $page_index $program_status" == "in_progress 1 in_progress" \
    || "$page_status $page_index $program_status" == "stopped 0 stopped" ]]; then
  valid_winner=true
fi
if [[ "$page_revision $program_revision $request_rows $valid_winner" != "2 2 2 true" ]]; then
  cat "$test_directory/next.log" "$test_directory/stop.log" >&2
  echo "The Solo training race left partial state ($page_revision/$program_revision/$request_rows/$valid_winner)." >&2
  exit 1
fi

# Removing one account must cascade only that actor's durable training rows.
psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --command "
  delete from auth.users where id = '$isolated_user';
"

read -r isolated_auth isolated_page_rows isolated_program_rows isolated_request_rows \
  primary_rows product_rows <<<"$(
  psql "$database_url" --set=ON_ERROR_STOP=1 --tuples-only --no-align \
    --field-separator=' ' --command "
      select
        exists (select 1 from auth.users where id = '$isolated_user'),
        exists (select 1 from private.site_training_page_progress
                where user_id = '$isolated_user'),
        exists (select 1 from private.site_training_program_progress
                where user_id = '$isolated_user'),
        exists (select 1 from private.site_training_transition_requests
                where actor_id = '$isolated_user'),
        (select count(*) from private.site_training_page_progress
         where user_id = '$primary_user'),
        ((select count(*) from public.challenge_entries
          where user_id in ('$primary_user', '$isolated_user'))
         + (select count(*) from public.check_ins
            where user_id in ('$primary_user', '$isolated_user'))
         + (select count(*) from public.game_point_events
            where user_id in ('$primary_user', '$isolated_user')));
    "
)"
if [[ "$isolated_auth $isolated_page_rows $isolated_program_rows $isolated_request_rows" \
    != "f f f f" ]]; then
  echo "Account deletion left isolated Solo training state behind." >&2
  exit 1
fi
if [[ "$primary_rows $product_rows" != "1 0" ]]; then
  echo "Account deletion affected the retained actor or training mutated product state ($primary_rows/$product_rows)." >&2
  exit 1
fi

echo "Solo training catalog concurrency checks passed: exact replay, CAS, actor isolation, deletion, and product-state isolation."
