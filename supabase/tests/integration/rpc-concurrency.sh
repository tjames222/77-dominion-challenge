#!/usr/bin/env bash
set -euo pipefail

database_url="${SUPABASE_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"

case "$database_url" in
  postgresql://*@127.0.0.1:54322/*|postgres://*@127.0.0.1:54322/*|postgresql://*@localhost:54322/*|postgres://*@localhost:54322/*)
    ;;
  *)
    echo "Refusing to run the concurrency test against a non-local database." >&2
    exit 2
    ;;
esac

if ! command -v psql >/dev/null 2>&1; then
  echo "psql is required for the RPC concurrency test." >&2
  exit 2
fi

test_directory="$(mktemp -d)"
cleanup() {
  rm -rf "$test_directory"
}
trap cleanup EXIT

fixture_user="30000000-0000-4000-8000-000000000003"

psql "$database_url" --set=ON_ERROR_STOP=1 --quiet <<SQL
delete from public.game_point_events where user_id = '$fixture_user';
delete from public.user_badges where user_id = '$fixture_user';
delete from public.user_challenge_states where user_id = '$fixture_user';
delete from public.user_game_stats where user_id = '$fixture_user';
insert into public.user_game_stats (user_id) values ('$fixture_user');
SQL

rpc_call=$(cat <<SQL
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$fixture_user', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"$fixture_user","role":"authenticated","email":"carol@example.test"}',
  true
);
select * from public.record_app_visit();
commit;
SQL
)

psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --command "$rpc_call" >"$test_directory/first.log" 2>&1 &
first_pid=$!
psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --command "$rpc_call" >"$test_directory/second.log" 2>&1 &
second_pid=$!

first_status=0
second_status=0
wait "$first_pid" || first_status=$?
wait "$second_pid" || second_status=$?

if (( first_status != 0 || second_status != 0 )); then
  cat "$test_directory/first.log" >&2
  cat "$test_directory/second.log" >&2
  echo "Concurrent record_app_visit RPC calls did not both complete." >&2
  exit 1
fi

read -r event_count cached_points ledger_points current_streak <<<"$(
  psql "$database_url" --set=ON_ERROR_STOP=1 --tuples-only --no-align --field-separator=' ' --command "
    select
      count(*) filter (where event_type = 'app_visit'),
      max(stats.total_points),
      coalesce(sum(events.points), 0),
      max(stats.current_app_streak)
    from public.user_game_stats stats
    left join public.game_point_events events on events.user_id = stats.user_id
    where stats.user_id = '$fixture_user'
    group by stats.user_id;
  "
)"

if [[ "$event_count" != "1" ]]; then
  echo "Expected one app_visit ledger event after concurrent retries; found $event_count." >&2
  exit 1
fi

if [[ "$cached_points" != "$ledger_points" ]]; then
  echo "Cached points ($cached_points) diverged from the ledger ($ledger_points)." >&2
  exit 1
fi

if [[ "$current_streak" != "1" ]]; then
  echo "Expected the concurrent visit retry to advance the streak once; found $current_streak." >&2
  exit 1
fi

echo "Concurrent RPC retry preserved one ledger event, one streak advance, and a consistent point total."

invite_crew="cc000000-0000-4000-8000-000000000001"
invite_id="cc100000-0000-4000-8000-000000000001"
invite_secret="concurrent-invite-secret-12345"
alice_user="10000000-0000-4000-8000-000000000001"
bob_user="20000000-0000-4000-8000-000000000002"
carol_user="30000000-0000-4000-8000-000000000003"

psql "$database_url" --set=ON_ERROR_STOP=1 --quiet <<SQL
delete from public.crews where id = '$invite_crew';
insert into public.crews (id, name, created_by)
values ('$invite_crew', 'Concurrent Invite Crew', '$alice_user');
insert into public.crew_members (crew_id, user_id, display_name, role)
values ('$invite_crew', '$alice_user', 'Alice Example', 'owner');
insert into public.crew_invites (id, crew_id, token_hash, token_hint, created_by, expires_at)
values (
  '$invite_id',
  '$invite_crew',
  public.crew_invite_secret_hash('$invite_secret'),
  '12345',
  '$alice_user',
  now() + interval '1 day'
);
SQL

preview_for_user() {
  local recipient_id="$1"
  local recipient_email="$2"
  psql "$database_url" --set=ON_ERROR_STOP=1 --tuples-only --no-align --quiet --command "
    begin;
    set local role authenticated;
    with subject as materialized (
      select set_config('request.jwt.claim.sub', '$recipient_id', true)
    ), claims as materialized (
      select set_config(
        'request.jwt.claims',
        '{\"sub\":\"$recipient_id\",\"role\":\"authenticated\",\"email\":\"$recipient_email\"}',
        true
      ) from subject
    )
    select public.preview_crew_invite('$invite_secret', null) ->> 'continuationToken'
    from claims;
    commit;
  "
}

bob_continuation="$(preview_for_user "$bob_user" "bob@example.test")"
carol_continuation="$(preview_for_user "$carol_user" "carol@example.test")"

confirm_for_user() {
  local recipient_id="$1"
  local recipient_email="$2"
  local continuation="$3"
  local output_file="$4"
  psql "$database_url" --set=ON_ERROR_STOP=1 --tuples-only --no-align --quiet --command "
    begin;
    set local role authenticated;
    with subject as materialized (
      select set_config('request.jwt.claim.sub', '$recipient_id', true)
    ), claims as materialized (
      select set_config(
        'request.jwt.claims',
        '{\"sub\":\"$recipient_id\",\"role\":\"authenticated\",\"email\":\"$recipient_email\"}',
        true
      ) from subject
    )
    select public.confirm_crew_invite('$continuation') ->> 'status'
    from claims;
    commit;
  " >"$output_file" 2>&1
}

confirm_for_user "$bob_user" "bob@example.test" "$bob_continuation" "$test_directory/invite-bob.log" &
invite_bob_pid=$!
confirm_for_user "$carol_user" "carol@example.test" "$carol_continuation" "$test_directory/invite-carol.log" &
invite_carol_pid=$!

invite_bob_status=0
invite_carol_status=0
wait "$invite_bob_pid" || invite_bob_status=$?
wait "$invite_carol_pid" || invite_carol_status=$?

if (( invite_bob_status != 0 || invite_carol_status != 0 )); then
  cat "$test_directory/invite-bob.log" >&2
  cat "$test_directory/invite-carol.log" >&2
  echo "Concurrent invite confirmations did not both complete." >&2
  exit 1
fi

read -r invite_member_count invite_attribution_count invite_redeemed_count <<<"$(
  psql "$database_url" --set=ON_ERROR_STOP=1 --tuples-only --no-align --field-separator=' ' --command "
    select
      count(distinct members.user_id),
      count(distinct attributions.id),
      count(distinct invites.redeemed_by)
    from public.crews crews
    left join public.crew_members members on members.crew_id = crews.id
    left join public.crew_invite_attributions attributions on attributions.crew_id = crews.id
    left join public.crew_invites invites on invites.crew_id = crews.id
    where crews.id = '$invite_crew'
    group by crews.id;
  "
)"

joined_results="$(grep -h -c '^joined$' "$test_directory/invite-bob.log" "$test_directory/invite-carol.log" | awk '{ total += $1 } END { print total + 0 }')"
used_results="$(grep -h -c '^already_used$' "$test_directory/invite-bob.log" "$test_directory/invite-carol.log" | awk '{ total += $1 } END { print total + 0 }')"

if [[ "$invite_member_count" != "2" || "$invite_attribution_count" != "1" || "$invite_redeemed_count" != "1" ]]; then
  cat "$test_directory/invite-bob.log" >&2
  cat "$test_directory/invite-carol.log" >&2
  echo "Concurrent confirmation created an unexpected membership or attribution count." >&2
  exit 1
fi

if [[ "$joined_results" != "1" || "$used_results" != "1" ]]; then
  cat "$test_directory/invite-bob.log" >&2
  cat "$test_directory/invite-carol.log" >&2
  echo "Expected one joined result and one already_used result under invite contention." >&2
  exit 1
fi

psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --command "delete from public.crews where id = '$invite_crew';"

echo "Concurrent invite confirmation created one membership and one immutable attribution."
