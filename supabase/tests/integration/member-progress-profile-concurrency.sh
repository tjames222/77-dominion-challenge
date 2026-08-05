#!/usr/bin/env bash
set -euo pipefail

database_url="${SUPABASE_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
case "$database_url" in
  postgresql://*@127.0.0.1:54322/*|postgres://*@127.0.0.1:54322/*|postgresql://*@localhost:54322/*|postgres://*@localhost:54322/*) ;;
  *) echo "Refusing to run member-progress races against a non-local database." >&2; exit 2 ;;
esac
command -v psql >/dev/null 2>&1 || { echo "psql is required." >&2; exit 2; }

test_directory="$(mktemp -d)"
owner_user="e1451000-0000-4000-8000-000000000001"
member_user="e1451000-0000-4000-8000-000000000002"
crew_id="e1451000-0000-4000-8000-000000000003"
leave_request="e1451000-0000-4000-8000-000000000004"
delete_request="e1451000-0000-4000-8000-000000000005"

cleanup_fixture() {
  psql "$database_url" --set=ON_ERROR_STOP=1 --quiet <<SQL
delete from private.crew_lifecycle_requests
where actor_id in ('$owner_user', '$member_user');
delete from public.crews where id = '$crew_id';
delete from auth.users where id in ('$owner_user', '$member_user');
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
  ('00000000-0000-0000-0000-000000000000', '$owner_user', 'authenticated', 'authenticated',
   'member-progress-owner@example.test', 'fixture', now(), '{"provider":"email"}',
   '{"name":"Profile Owner"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '$member_user', 'authenticated', 'authenticated',
   'member-progress-member@example.test', 'fixture', now(), '{"provider":"email"}',
   '{"name":"Profile Member"}', now(), now());

insert into public.profiles (user_id, name, email, time_zone)
values
  ('$owner_user', 'Profile Owner', 'member-progress-owner@example.test', 'UTC'),
  ('$member_user', 'Profile Member', 'member-progress-member@example.test', 'UTC');

insert into public.entitlements (
  user_id, entitlement_key, status, source_type, source_id, starts_at, ends_at
)
values
  ('$owner_user', 'membership_active', 'active', 'test', 'member-progress-owner', now(), now() + interval '1 day'),
  ('$member_user', 'membership_active', 'active', 'test', 'member-progress-member', now(), now() + interval '1 day');

insert into public.crews (id, name, description, created_by)
values ('$crew_id', 'Member Progress Race Crew', 'Lock-order coverage', '$owner_user');
insert into public.crew_members (crew_id, user_id, display_name, role)
values
  ('$crew_id', '$owner_user', 'Profile Owner', 'owner'),
  ('$crew_id', '$member_user', 'Profile Member', 'member');
SQL

profile_call() {
  local caller_id="$1" target_id="$2" hold_seconds="$3" output_file="$4"
  psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align --command "
    begin;
    set local statement_timeout = '10s';
    set local role authenticated;
    set local \"request.jwt.claim.sub\" = '$caller_id';
    select public.get_crew_member_progress_profile('$crew_id', '$target_id') ->> 'memberId';
    select pg_catalog.pg_sleep($hold_seconds);
    commit;
  " >"$output_file" 2>&1
}

assert_profile_denied() {
  local caller_id="$1" target_id="$2" output_file="$3"
  local call_status=0
  profile_call "$caller_id" "$target_id" 0 "$output_file" || call_status=$?
  if (( call_status == 0 )) || ! grep -q 'Member progress is no longer available' "$output_file"; then
    cat "$output_file" >&2
    echo "An invalidated member-progress read did not fail with the generic response." >&2
    exit 1
  fi
}

# An entitlement transition must wait for an already-authorized read. Once it
# commits, a fresh call revalidates the entitlement and fails closed.
profile_call "$owner_user" "$member_user" 1 "$test_directory/entitlement-read.log" &
entitlement_read_pid=$!
sleep 0.25
psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --command "
  set statement_timeout = '10s';
  update public.entitlements
  set status = 'inactive', updated_at = pg_catalog.now()
  where user_id = '$owner_user' and entitlement_key = 'membership_active';
" >"$test_directory/entitlement-update.log" 2>&1 &
entitlement_update_pid=$!
entitlement_read_status=0; entitlement_update_status=0
wait "$entitlement_read_pid" || entitlement_read_status=$?
wait "$entitlement_update_pid" || entitlement_update_status=$?
if (( entitlement_read_status != 0 || entitlement_update_status != 0 )) \
   || ! grep -q "$member_user" "$test_directory/entitlement-read.log"; then
  cat "$test_directory/entitlement-read.log" "$test_directory/entitlement-update.log" >&2
  echo "The entitlement-vs-profile race did not serialize cleanly." >&2
  exit 1
fi
assert_profile_denied "$owner_user" "$member_user" "$test_directory/entitlement-denied.log"
psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --command "
  update public.entitlements
  set status = 'active', updated_at = pg_catalog.now()
  where user_id = '$owner_user' and entitlement_key = 'membership_active';
"

# Reciprocal reads lock the same crew and membership rows in a deterministic
# order. A simultaneous leave must wait, not deadlock, and the next read must
# observe the removed membership.
profile_call "$owner_user" "$member_user" 1 "$test_directory/a-to-b.log" &
a_to_b_pid=$!
profile_call "$member_user" "$owner_user" 1 "$test_directory/b-to-a.log" &
b_to_a_pid=$!
sleep 0.25
psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align --command "
  begin;
  set local statement_timeout = '10s';
  set local role authenticated;
  set local \"request.jwt.claim.sub\" = '$member_user';
  select public.leave_crew('$crew_id', '$leave_request') ->> 'status';
  commit;
" >"$test_directory/leave.log" 2>&1 &
leave_pid=$!
a_to_b_status=0; b_to_a_status=0; leave_status=0
wait "$a_to_b_pid" || a_to_b_status=$?
wait "$b_to_a_pid" || b_to_a_status=$?
wait "$leave_pid" || leave_status=$?
if (( a_to_b_status != 0 || b_to_a_status != 0 || leave_status != 0 )) \
   || ! grep -q "$member_user" "$test_directory/a-to-b.log" \
   || ! grep -q "$owner_user" "$test_directory/b-to-a.log" \
   || ! grep -q '^left$' "$test_directory/leave.log"; then
  cat "$test_directory/a-to-b.log" "$test_directory/b-to-a.log" "$test_directory/leave.log" >&2
  echo "Reciprocal profile reads and member removal did not complete without deadlock." >&2
  exit 1
fi
assert_profile_denied "$owner_user" "$member_user" "$test_directory/leave-denied.log"

# Recreate the target membership, then prove crew deletion contends with the
# same read locks and leaves no post-commit profile exposure.
psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --command "
  insert into public.crew_members (crew_id, user_id, display_name, role)
  values ('$crew_id', '$member_user', 'Profile Member', 'member');
"
profile_call "$owner_user" "$member_user" 1 "$test_directory/delete-read.log" &
delete_read_pid=$!
sleep 0.25
psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align --command "
  begin;
  set local statement_timeout = '10s';
  set local role authenticated;
  set local \"request.jwt.claim.sub\" = '$owner_user';
  select public.delete_crew('$crew_id', '$delete_request') ->> 'status';
  commit;
" >"$test_directory/delete.log" 2>&1 &
delete_pid=$!
delete_read_status=0; delete_status=0
wait "$delete_read_pid" || delete_read_status=$?
wait "$delete_pid" || delete_status=$?
if (( delete_read_status != 0 || delete_status != 0 )) \
   || ! grep -q "$member_user" "$test_directory/delete-read.log" \
   || ! grep -q '^deleted$' "$test_directory/delete.log"; then
  cat "$test_directory/delete-read.log" "$test_directory/delete.log" >&2
  echo "The delete-vs-profile race did not serialize cleanly." >&2
  exit 1
fi
assert_profile_denied "$owner_user" "$member_user" "$test_directory/delete-denied.log"

echo "Member-progress authorization races passed."
