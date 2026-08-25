#!/usr/bin/env bash
set -euo pipefail

database_url="${SUPABASE_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
case "$database_url" in
  postgresql://*@127.0.0.1:54322/*|postgres://*@127.0.0.1:54322/*|postgresql://*@localhost:54322/*|postgres://*@localhost:54322/*) ;;
  *) echo "Refusing to run challenge activation races against a non-local database." >&2; exit 2 ;;
esac
command -v psql >/dev/null 2>&1 || { echo "psql is required." >&2; exit 2; }

test_directory="$(mktemp -d)"
same_user="c1000000-0000-4000-8000-000000000001"
compatible_user="c2000000-0000-4000-8000-000000000002"
conflict_user="c3000000-0000-4000-8000-000000000003"
date_user="c4000000-0000-4000-8000-000000000004"
erasure_user="c5000000-0000-4000-8000-000000000005"
same_request="c1100000-0000-4000-8000-000000000001"
compatible_request_one="c2100000-0000-4000-8000-000000000001"
compatible_request_two="c2100000-0000-4000-8000-000000000002"
conflict_solo_request="c3100000-0000-4000-8000-000000000001"
conflict_group_request="c3100000-0000-4000-8000-000000000002"
date_activation_request="c4100000-0000-4000-8000-000000000001"
date_update_request_one="c4100000-0000-4000-8000-000000000002"
date_update_request_two="c4100000-0000-4000-8000-000000000003"
erasure_activation_request="c5100000-0000-4000-8000-000000000001"
erasure_date_request="c5100000-0000-4000-8000-000000000002"
conflict_crew="c3300000-0000-4000-8000-000000000001"

cleanup_fixture() {
  psql "$database_url" --set=ON_ERROR_STOP=1 --quiet <<SQL
delete from private.challenge_activation_requests
where actor_id in ('$same_user', '$compatible_user', '$conflict_user', '$date_user');
delete from public.crews where id = '$conflict_crew';
delete from auth.users
where id in ('$same_user', '$compatible_user', '$conflict_user', '$date_user', '$erasure_user');
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
  ('00000000-0000-0000-0000-000000000000', '$same_user', 'authenticated', 'authenticated',
   'activation-same@example.test', 'fixture', now(), '{"provider":"email"}', '{"name":"Same Retry"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '$compatible_user', 'authenticated', 'authenticated',
   'activation-compatible@example.test', 'fixture', now(), '{"provider":"email"}', '{"name":"Compatible Retry"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '$conflict_user', 'authenticated', 'authenticated',
   'activation-conflict@example.test', 'fixture', now(), '{"provider":"email"}', '{"name":"Mode Conflict"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '$date_user', 'authenticated', 'authenticated',
   'activation-date@example.test', 'fixture', now(), '{"provider":"email"}', '{"name":"Date Conflict"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '$erasure_user', 'authenticated', 'authenticated',
   'activation-erasure@example.test', 'fixture', now(), '{"provider":"email"}', '{"name":"Erasure Race"}', now(), now());

insert into public.profiles (user_id, name, email, time_zone)
values
  ('$same_user', 'Same Retry', 'activation-same@example.test', 'UTC'),
  ('$compatible_user', 'Compatible Retry', 'activation-compatible@example.test', 'UTC'),
  ('$conflict_user', 'Mode Conflict', 'activation-conflict@example.test', 'UTC'),
  ('$date_user', 'Date Conflict', 'activation-date@example.test', 'UTC'),
  ('$erasure_user', 'Erasure Race', 'activation-erasure@example.test', 'UTC');

update public.profiles
set challenge_start_date = current_date,
    challenge_activation_status = 'scheduled',
    challenge_participation_mode = 'solo',
    challenge_activation_time_zone = 'UTC',
    challenge_confirmed_at = pg_catalog.statement_timestamp() - interval '1 day',
    challenge_confirmed_by = '$compatible_user',
    challenge_activation_revision = 1,
    challenge_activation_updated_at = pg_catalog.statement_timestamp() - interval '1 day'
where user_id = '$compatible_user';

insert into public.crews (id, name, description, challenge_start_date, created_by)
values ('$conflict_crew', 'Activation Race Crew', 'Mode race coverage', current_date, '$conflict_user');
insert into public.crew_members (crew_id, user_id, display_name, role)
values ('$conflict_crew', '$conflict_user', 'Mode Conflict', 'owner');
SQL

solo_call() {
  local user_id="$1" request_id="$2" output_file="$3"
  psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align --command "
    begin;
    set local statement_timeout = '10s';
    set local role authenticated;
    set local \"request.jwt.claim.sub\" = '$user_id';
    select public.activate_solo_challenge(
      current_date,
      'UTC',
      '$request_id',
      '$user_id'
    )::text;
    commit;
  " >"$output_file" 2>&1
}

# Identical concurrent retries must return the exact stored result and produce
# one transition/request row.
solo_call "$same_user" "$same_request" "$test_directory/same-one.log" &
same_one_pid=$!
solo_call "$same_user" "$same_request" "$test_directory/same-two.log" &
same_two_pid=$!
same_one_status=0; same_two_status=0
wait "$same_one_pid" || same_one_status=$?
wait "$same_two_pid" || same_two_status=$?
if (( same_one_status != 0 || same_two_status != 0 )); then
  cat "$test_directory/same-one.log" "$test_directory/same-two.log" >&2
  echo "Identical activation retries did not both complete." >&2
  exit 1
fi
if ! cmp -s "$test_directory/same-one.log" "$test_directory/same-two.log"; then
  cat "$test_directory/same-one.log" "$test_directory/same-two.log" >&2
  echo "Identical activation retries returned different results." >&2
  exit 1
fi
read -r same_requests same_revision <<<"$(
  psql "$database_url" --set=ON_ERROR_STOP=1 --tuples-only --no-align --field-separator=' ' --command "
    select
      (select count(*) from private.challenge_activation_requests where actor_id = '$same_user'),
      (select challenge_activation_revision from public.profiles where user_id = '$same_user');
  "
)"
if [[ "$same_requests $same_revision" != "1 1" ]]; then
  echo "Identical retries did not converge to one transition ($same_requests/$same_revision)." >&2
  exit 1
fi

# Different request IDs carrying the same compatible activation may each be
# recorded, but the lifecycle revision may advance only once.
solo_call "$compatible_user" "$compatible_request_one" "$test_directory/compatible-one.log" &
compatible_one_pid=$!
solo_call "$compatible_user" "$compatible_request_two" "$test_directory/compatible-two.log" &
compatible_two_pid=$!
compatible_one_status=0; compatible_two_status=0
wait "$compatible_one_pid" || compatible_one_status=$?
wait "$compatible_two_pid" || compatible_two_status=$?
if (( compatible_one_status != 0 || compatible_two_status != 0 )); then
  cat "$test_directory/compatible-one.log" "$test_directory/compatible-two.log" >&2
  echo "Compatible concurrent activations did not both complete." >&2
  exit 1
fi
read -r compatible_requests compatible_revision compatible_mode compatible_status \
  compatible_activated compatible_results_active <<<"$(
  psql "$database_url" --set=ON_ERROR_STOP=1 --tuples-only --no-align --field-separator=' ' --command "
    select
      (select count(*) from private.challenge_activation_requests where actor_id = '$compatible_user'),
      challenge_activation_revision,
      challenge_participation_mode,
      challenge_activation_status,
      challenge_activated_at is not null and challenge_activated_by = '$compatible_user',
      (select bool_and(
         request_row.result ->> 'status' = 'active'
         and request_row.result ->> 'storedStatus' = 'active'
         and request_row.result ->> 'activatedAt' is not null
         and request_row.result ->> 'activatedBy' = '$compatible_user'
       )
       from private.challenge_activation_requests request_row
       where request_row.actor_id = '$compatible_user')
    from public.profiles where user_id = '$compatible_user';
  "
)"
if [[ "$compatible_requests $compatible_revision $compatible_mode $compatible_status $compatible_activated $compatible_results_active" != "2 2 solo active t t" ]]; then
  echo "Due compatible activations did not converge to one persisted promotion ($compatible_requests/$compatible_revision/$compatible_mode/$compatible_status/$compatible_activated/$compatible_results_active)." >&2
  exit 1
fi

# Solo and Group attempts from separate tabs serialize on the same user locks.
# Exactly one mode wins; the loser must fail without a request row or rewrite.
solo_call "$conflict_user" "$conflict_solo_request" "$test_directory/conflict-solo.log" &
conflict_solo_pid=$!
psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align --command "
  begin;
  set local statement_timeout = '10s';
  set local role authenticated;
  set local \"request.jwt.claim.sub\" = '$conflict_user';
  select public.activate_group_challenge(
    '$conflict_crew',
    'UTC',
    '$conflict_group_request',
    '$conflict_user'
  )::text;
  commit;
" >"$test_directory/conflict-group.log" 2>&1 &
conflict_group_pid=$!
conflict_solo_status=0; conflict_group_status=0
wait "$conflict_solo_pid" || conflict_solo_status=$?
wait "$conflict_group_pid" || conflict_group_status=$?
if (( (conflict_solo_status == 0) == (conflict_group_status == 0) )); then
  cat "$test_directory/conflict-solo.log" "$test_directory/conflict-group.log" >&2
  echo "The Solo-vs-Group race did not produce exactly one winner." >&2
  exit 1
fi
read -r conflict_requests conflict_revision conflict_status <<<"$(
  psql "$database_url" --set=ON_ERROR_STOP=1 --tuples-only --no-align --field-separator=' ' --command "
    select
      (select count(*) from private.challenge_activation_requests where actor_id = '$conflict_user'),
      challenge_activation_revision,
      challenge_activation_status
    from public.profiles where user_id = '$conflict_user';
  "
)"
if [[ "$conflict_requests $conflict_revision $conflict_status" != "1 1 active" ]]; then
  cat "$test_directory/conflict-solo.log" "$test_directory/conflict-group.log" >&2
  echo "The mode race left partial activation state ($conflict_requests/$conflict_revision/$conflict_status)." >&2
  exit 1
fi

# Two stale date editors share revision 1. Only the first serialized update may
# commit; the other must fail with no second date-update request.
solo_call "$date_user" "$date_activation_request" "$test_directory/date-activate.log"
date_update_call() {
  local request_id="$1" days_back="$2" output_file="$3"
  psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align --command "
    begin;
    set local statement_timeout = '10s';
    set local role authenticated;
    set local \"request.jwt.claim.sub\" = '$date_user';
    select public.set_challenge_start_date(
      current_date - $days_back,
      'UTC',
      '$request_id',
      1,
      '$date_user'
    )::text;
    commit;
  " >"$output_file" 2>&1
}
date_update_call "$date_update_request_one" 1 "$test_directory/date-one.log" &
date_one_pid=$!
date_update_call "$date_update_request_two" 2 "$test_directory/date-two.log" &
date_two_pid=$!
date_one_status=0; date_two_status=0
wait "$date_one_pid" || date_one_status=$?
wait "$date_two_pid" || date_two_status=$?
if (( (date_one_status == 0) == (date_two_status == 0) )); then
  cat "$test_directory/date-one.log" "$test_directory/date-two.log" >&2
  echo "The stale revision race did not produce exactly one winner." >&2
  exit 1
fi
read -r date_requests date_revision <<<"$(
  psql "$database_url" --set=ON_ERROR_STOP=1 --tuples-only --no-align --field-separator=' ' --command "
    select
      (select count(*) from private.challenge_activation_requests
       where actor_id = '$date_user' and action = 'date_update'),
      challenge_activation_revision
    from public.profiles where user_id = '$date_user';
  "
)"
if [[ "$date_requests $date_revision" != "1 2" ]]; then
  cat "$test_directory/date-one.log" "$test_directory/date-two.log" >&2
  echo "The stale date race did not preserve one update ($date_requests/$date_revision)." >&2
  exit 1
fi

# Account erasure locks auth.users before cascading to profiles. Activation
# mutations must take the same parent-to-child order before they can edit the
# profile or insert auth-FK request evidence; otherwise these two sessions can
# deadlock with each holding the row the other needs.
solo_call "$erasure_user" "$erasure_activation_request" "$test_directory/erasure-activate.log"
psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --command "
  begin;
  set local statement_timeout = '10s';
  select id from auth.users
  where id = '$erasure_user'
  for update;
  select pg_sleep(1.5) /* challenge-activation-erasure-parent-lock */;
  delete from auth.users where id = '$erasure_user';
  commit;
" >"$test_directory/erasure-delete.log" 2>&1 &
erasure_delete_pid=$!

erasure_parent_locked=false
for _attempt in $(seq 1 100); do
  if [[ "$(psql "$database_url" --set=ON_ERROR_STOP=1 --tuples-only --no-align --command "
    select exists (
      select 1
      from pg_catalog.pg_stat_activity activity
      where activity.query like '%challenge-activation-erasure-parent-lock%'
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

psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align --command "
  begin;
  set local statement_timeout = '10s';
  set local role authenticated;
  set local \"request.jwt.claim.sub\" = '$erasure_user';
  select public.set_challenge_start_date(
    current_date - 1,
    'UTC',
    '$erasure_date_request',
    1,
    '$erasure_user'
  )::text;
  commit;
" >"$test_directory/erasure-mutation.log" 2>&1 &
erasure_mutation_pid=$!

erasure_delete_status=0; erasure_mutation_status=0
wait "$erasure_delete_pid" || erasure_delete_status=$?
wait "$erasure_mutation_pid" || erasure_mutation_status=$?
if (( erasure_delete_status != 0 || erasure_mutation_status == 0 )); then
  cat "$test_directory/erasure-delete.log" "$test_directory/erasure-mutation.log" >&2
  echo "Account erasure and activation mutation did not serialize safely." >&2
  exit 1
fi
if ! grep -q 'challenge_activation_actor_missing' "$test_directory/erasure-mutation.log"; then
  cat "$test_directory/erasure-mutation.log" >&2
  echo "The post-erasure mutation did not fail at the auth-parent guard." >&2
  exit 1
fi
read -r erased_auth erased_profile erased_requests <<<"$(
  psql "$database_url" --set=ON_ERROR_STOP=1 --tuples-only --no-align --field-separator=' ' --command "
    select
      exists (select 1 from auth.users where id = '$erasure_user'),
      exists (select 1 from public.profiles where user_id = '$erasure_user'),
      exists (select 1 from private.challenge_activation_requests where actor_id = '$erasure_user');
  "
)"
if [[ "$erased_auth $erased_profile $erased_requests" != "f f f" ]]; then
  echo "Account erasure left activation state behind ($erased_auth/$erased_profile/$erased_requests)." >&2
  exit 1
fi

echo "Challenge activation concurrency checks passed."
