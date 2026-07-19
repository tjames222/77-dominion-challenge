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
