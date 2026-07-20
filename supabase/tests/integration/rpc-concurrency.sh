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
delete from public.sharing_reward_intents where user_id = '$fixture_user';
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

read -r legacy_point_count cached_points ledger_points current_streak <<<"$(
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

if [[ "$legacy_point_count" != "0" ]]; then
  echo "Expected app visits to remain outside the simplified point ledger; found $legacy_point_count event(s)." >&2
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

sharing_token="$(
  psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align --command "
    begin;
    set local role authenticated;
    set local \"request.jwt.claim.sub\" = '$fixture_user';
    set local \"request.jwt.claims\" = '{\"sub\":\"$fixture_user\",\"role\":\"authenticated\",\"email\":\"carol@example.test\"}';
    select public.create_sharing_reward_intent('copy_link') ->> 'completionToken';
    commit;
  " | sed -nE '/^[0-9a-f]{64}$/p'
)"

if [[ ! "$sharing_token" =~ ^[0-9a-f]{64}$ ]]; then
  echo "The Sharing intent did not return a valid completion token." >&2
  exit 1
fi

sharing_rpc_call=$(cat <<SQL
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$fixture_user', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"$fixture_user","role":"authenticated","email":"carol@example.test"}',
  true
);
select public.complete_sharing_reward('$sharing_token');
commit;
SQL
)

psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --command "$sharing_rpc_call" >"$test_directory/sharing-first.log" 2>&1 &
sharing_first_pid=$!
psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --command "$sharing_rpc_call" >"$test_directory/sharing-second.log" 2>&1 &
sharing_second_pid=$!

sharing_first_status=0
sharing_second_status=0
wait "$sharing_first_pid" || sharing_first_status=$?
wait "$sharing_second_pid" || sharing_second_status=$?

if (( sharing_first_status != 0 || sharing_second_status != 0 )); then
  cat "$test_directory/sharing-first.log" >&2
  cat "$test_directory/sharing-second.log" >&2
  echo "Concurrent Sharing reward completions did not both complete." >&2
  exit 1
fi

read -r sharing_event_count sharing_badge_count sharing_grant_count sharing_evidence_count cached_points ledger_points <<<"$(
  psql "$database_url" --set=ON_ERROR_STOP=1 --tuples-only --no-align --field-separator=' ' --command "
    select
      (select count(*) from public.game_point_events where user_id = '$fixture_user' and event_type = 'sharing_bonus'),
      (select count(*) from public.user_badges where user_id = '$fixture_user' and badge_key = 'sharing'),
      (select count(*) from public.sharing_reward_grants where user_id = '$fixture_user'),
      (select count(*) from public.sharing_reward_evidence where user_id = '$fixture_user'),
      (select total_points from public.user_game_stats where user_id = '$fixture_user'),
      (select coalesce(sum(points), 0) from public.game_point_events where user_id = '$fixture_user');
  "
)"

if [[ "$sharing_event_count" != "1" || "$sharing_badge_count" != "1" || "$sharing_grant_count" != "1" || "$sharing_evidence_count" != "1" ]]; then
  echo "Concurrent Sharing completions must produce one event, badge, grant, and evidence record; found $sharing_event_count/$sharing_badge_count/$sharing_grant_count/$sharing_evidence_count." >&2
  exit 1
fi

if [[ "$cached_points" != "14" || "$ledger_points" != "14" ]]; then
  echo "Concurrent Sharing completions must add exactly 14 points; cached=$cached_points ledger=$ledger_points." >&2
  exit 1
fi

echo "Concurrent RPC retries preserved one streak advance and one atomic 14-point Sharing reward."
