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
delete from public.user_reward_entitlements
where user_id = '$fixture_user'
   or reward_key = 'concurrency_reward';
delete from public.reward_definitions where reward_key = 'concurrency_reward';
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

if [[ "$event_count" != "0" ]]; then
  echo "Expected app visits to remain outside the seven-point ledger; found $event_count event(s)." >&2
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

psql "$database_url" --set=ON_ERROR_STOP=1 --quiet <<SQL
begin;
update public.user_game_stats
set total_points = 500,
    challenge_points = 500
where user_id = '$fixture_user';
alter table public.reward_definitions disable trigger sync_reward_definition_entitlements;
insert into public.reward_definitions (
  reward_key,
  reward_type,
  state_model,
  title,
  points_required,
  fulfillment_key,
  icon,
  sort_order
) values (
  'concurrency_reward',
  'cosmetic',
  'ownership',
  'Concurrency Reward',
  500,
  'concurrency_reward_asset',
  'gift',
  999
);
alter table public.reward_definitions enable trigger sync_reward_definition_entitlements;
commit;
SQL

grant_call="select public.grant_reward_entitlement('$fixture_user', 'concurrency_reward', 'concurrency_test', 'shared_source', false);"

psql "$database_url" --set=ON_ERROR_STOP=1 --tuples-only --no-align --quiet --command "$grant_call" >"$test_directory/grant-first.log" 2>&1 &
first_grant_pid=$!
psql "$database_url" --set=ON_ERROR_STOP=1 --tuples-only --no-align --quiet --command "$grant_call" >"$test_directory/grant-second.log" 2>&1 &
second_grant_pid=$!

first_grant_status=0
second_grant_status=0
wait "$first_grant_pid" || first_grant_status=$?
wait "$second_grant_pid" || second_grant_status=$?

if (( first_grant_status != 0 || second_grant_status != 0 )); then
  cat "$test_directory/grant-first.log" >&2
  cat "$test_directory/grant-second.log" >&2
  echo "Concurrent reward grants did not both complete." >&2
  exit 1
fi

successful_grants="$(
  { grep -h '^t$' "$test_directory/grant-first.log" "$test_directory/grant-second.log" || true; } \
    | wc -l \
    | tr -d ' '
)"
entitlement_count="$(psql "$database_url" --set=ON_ERROR_STOP=1 --tuples-only --no-align --quiet --command "
  select count(*)
  from public.user_reward_entitlements
  where user_id = '$fixture_user'
    and reward_key = 'concurrency_reward';
")"

if [[ "$successful_grants" != "1" || "$entitlement_count" != "1" ]]; then
  echo "Expected one successful concurrent grant and one entitlement; found $successful_grants grant(s) and $entitlement_count row(s)." >&2
  exit 1
fi

claim_call=$(cat <<SQL
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$fixture_user', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"$fixture_user","role":"authenticated","email":"carol@example.test"}',
  true
);
select public.claim_reward_entitlement_unlocks() -> 'claimedKeys';
commit;
SQL
)

psql "$database_url" --set=ON_ERROR_STOP=1 --tuples-only --no-align --quiet --command "$claim_call" >"$test_directory/claim-first.log" 2>&1 &
first_claim_pid=$!
psql "$database_url" --set=ON_ERROR_STOP=1 --tuples-only --no-align --quiet --command "$claim_call" >"$test_directory/claim-second.log" 2>&1 &
second_claim_pid=$!

first_claim_status=0
second_claim_status=0
wait "$first_claim_pid" || first_claim_status=$?
wait "$second_claim_pid" || second_claim_status=$?

if (( first_claim_status != 0 || second_claim_status != 0 )); then
  cat "$test_directory/claim-first.log" >&2
  cat "$test_directory/claim-second.log" >&2
  echo "Concurrent reward claims did not both complete." >&2
  exit 1
fi

claimed_occurrences="$(
  { grep -h 'concurrency_reward' "$test_directory/claim-first.log" "$test_directory/claim-second.log" || true; } \
    | wc -l \
    | tr -d ' '
)"
if [[ "$claimed_occurrences" != "1" ]]; then
  echo "Expected the concurrent celebration claim to return the reward once; found $claimed_occurrences." >&2
  exit 1
fi

echo "Concurrent RPC retries preserved one streak advance, one reward entitlement, and one unlock claim."
