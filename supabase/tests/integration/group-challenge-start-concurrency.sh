#!/usr/bin/env bash
set -euo pipefail

database_url="${SUPABASE_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
case "$database_url" in
  postgresql://*@127.0.0.1:54322/*|postgres://*@127.0.0.1:54322/*|postgresql://*@localhost:54322/*|postgres://*@localhost:54322/*) ;;
  *) echo "Refusing to run Group-start races against a non-local database." >&2; exit 2 ;;
esac
command -v psql >/dev/null 2>&1 || { echo "psql is required." >&2; exit 2; }

test_directory="$(mktemp -d)"
actor_id="fd000000-0000-4000-8000-000000000001"
crew_request_id="fd100000-0000-4000-8000-000000000001"
activation_request_id="fd200000-0000-4000-8000-000000000001"

cleanup_fixture() {
  psql "$database_url" --set=ON_ERROR_STOP=1 --quiet <<SQL
delete from private.challenge_activation_requests where actor_id = '$actor_id';
delete from private.crew_lifecycle_requests where actor_id = '$actor_id';
delete from public.crews where created_by = '$actor_id';
delete from auth.users where id = '$actor_id';
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
  '00000000-0000-0000-0000-000000000000', '$actor_id',
  'authenticated', 'authenticated', 'group-start-race@example.test', 'fixture', now(),
  '{"provider":"email"}', '{"name":"Group Start Race"}', now(), now()
);

insert into public.profiles (user_id, name, email, time_zone)
values ('$actor_id', 'Group Start Race', 'group-start-race@example.test', 'UTC');

insert into public.entitlements (
  user_id, entitlement_key, status, source_type, source_id, starts_at, ends_at
)
values (
  '$actor_id', 'membership_active', 'active', 'test', 'group-start-race',
  now(), now() + interval '1 day'
);
SQL

combined_call() {
  local output_file="$1"
  psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align --command "
    begin;
    set local statement_timeout = '10s';
    set local role authenticated;
    set local \"request.jwt.claim.sub\" = '$actor_id';
    select public.create_crew_and_activate_group(
      '$crew_request_id',
      '$activation_request_id',
      'Concurrent Group Start',
      'Retry convergence coverage',
      current_date,
      'UTC',
      '$actor_id'
    )::text;
    commit;
  " >"$output_file" 2>&1
}

combined_call "$test_directory/one.log" &
one_pid=$!
combined_call "$test_directory/two.log" &
two_pid=$!
one_status=0; two_status=0
wait "$one_pid" || one_status=$?
wait "$two_pid" || two_status=$?
if (( one_status != 0 || two_status != 0 )); then
  cat "$test_directory/one.log" "$test_directory/two.log" >&2
  echo "Identical combined Group-start retries did not both complete." >&2
  exit 1
fi

if ! grep -q '"status": "active"' "$test_directory/one.log" \
  || ! grep -q '"status": "active"' "$test_directory/two.log"; then
  cat "$test_directory/one.log" "$test_directory/two.log" >&2
  echo "Combined retries did not both return an active activation." >&2
  exit 1
fi

read -r crew_count member_count lifecycle_count activation_count revision mode status attribution_valid <<<"$(
  psql "$database_url" --set=ON_ERROR_STOP=1 --tuples-only --no-align --field-separator=' ' --command "
    select
      (select count(*) from public.crews where created_by = '$actor_id'),
      (select count(*) from public.crew_members where user_id = '$actor_id'),
      (select count(*) from private.crew_lifecycle_requests where actor_id = '$actor_id'),
      (select count(*) from private.challenge_activation_requests where actor_id = '$actor_id'),
      profile.challenge_activation_revision,
      profile.challenge_participation_mode,
      profile.challenge_activation_status,
      exists (
        select 1
        from public.crew_members member_row
        where member_row.user_id = profile.user_id
          and member_row.crew_id = profile.challenge_group_attribution_crew_id
      )
    from public.profiles profile
    where profile.user_id = '$actor_id';
  "
)"

if [[ "$crew_count $member_count $lifecycle_count $activation_count $revision $mode $status $attribution_valid" != "1 1 1 1 1 group active t" ]]; then
  echo "Combined retries left divergent or partial state ($crew_count/$member_count/$lifecycle_count/$activation_count/$revision/$mode/$status/$attribution_valid)." >&2
  exit 1
fi

echo "Group challenge-start concurrency checks passed."
