#!/usr/bin/env bash
set -euo pipefail

database_url="${SUPABASE_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"

case "$database_url" in
  postgresql://*@127.0.0.1:54322/*|postgres://*@127.0.0.1:54322/*|postgresql://*@localhost:54322/*|postgres://*@localhost:54322/*)
    ;;
  *)
    echo "Refusing to run the profile-photo concurrency test against a non-local database." >&2
    exit 2
    ;;
esac

if ! command -v psql >/dev/null 2>&1; then
  echo "psql is required for the profile-photo concurrency test." >&2
  exit 2
fi

test_directory="$(mktemp -d)"
cleanup() {
  rm -rf "$test_directory"
}
trap cleanup EXIT

fail() {
  echo "$1" >&2
  exit 1
}

expect_equal() {
  local actual="$1"
  local expected="$2"
  local message="$3"
  if [[ "$actual" != "$expected" ]]; then
    fail "$message Expected '$expected'; found '$actual'."
  fi
}

authenticated_sql() {
  local user_id="$1"
  local sql="$2"
  psql "$database_url" \
    --set=ON_ERROR_STOP=1 \
    --tuples-only \
    --no-align \
    --field-separator=' ' \
    --quiet <<SQL
begin;
set local statement_timeout = '10s';
set local lock_timeout = '5s';
set local role authenticated;
set local "request.jwt.claim.sub" = '$user_id';
set local "request.jwt.claims" = '{"sub":"$user_id","role":"authenticated","email":"profile-photo-race@example.test"}';
$sql
commit;
SQL
}

create_profile_fixture() {
  local user_id="$1"
  psql "$database_url" --set=ON_ERROR_STOP=1 --quiet <<SQL
insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  '$user_id',
  'authenticated',
  'authenticated',
  '$user_id@profile-photo-race.example.test',
  '\$2b\$10\$K7L1OJ45/4Y2nIvhRVpCe.FSmR/cQF.iUFamQdki4.8/pK1gRgg7S',
  clock_timestamp(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"name":"Profile Photo Race"}'::jsonb,
  clock_timestamp(),
  clock_timestamp()
);

insert into public.profiles (
  user_id,
  name,
  email,
  challenge_start_date,
  time_zone
) values (
  '$user_id',
  'Profile Photo Race',
  '$user_id@profile-photo-race.example.test',
  current_date,
  'UTC'
);
SQL
}

register_and_upload() {
  local user_id="$1"
  local storage_path="$2"
  local object_id="$3"
  authenticated_sql "$user_id" "
select public.register_profile_photo_upload('$storage_path');
insert into storage.objects (id, bucket_id, name, owner)
values ('$object_id', 'profile-photos', '$storage_path', '$user_id');
"
}

wait_for_advisory_barrier() {
  local barrier_key="$1"
  local barrier_state
  local attempt

  for attempt in $(seq 1 100); do
    barrier_state="$(
      psql "$database_url" \
        --set=ON_ERROR_STOP=1 \
        --tuples-only \
        --no-align \
        --quiet \
        --command "
          select case
            when pg_try_advisory_lock($barrier_key)
              then pg_advisory_unlock($barrier_key)::text
            else 'blocked'
          end;
        "
    )"
    if [[ "$barrier_state" == "blocked" ]]; then
      return 0
    fi
    sleep 0.02
  done

  fail "Timed out waiting for concurrency barrier $barrier_key."
}

read -r commit_user commit_object_one commit_object_two cleanup_reinsert_object \
  commit_hash_one commit_hash_two <<<"$(
    psql "$database_url" \
      --set=ON_ERROR_STOP=1 \
      --tuples-only \
      --no-align \
      --field-separator=' ' \
      --quiet \
      --command "
        select
          gen_random_uuid(),
          gen_random_uuid(),
          gen_random_uuid(),
          gen_random_uuid(),
          encode(gen_random_bytes(16), 'hex'),
          encode(gen_random_bytes(16), 'hex');
      "
  )"

commit_path_one="$commit_user/avatar-1720000001001-$commit_hash_one.webp"
commit_path_two="$commit_user/avatar-1720000001002-$commit_hash_two.jpg"

create_profile_fixture "$commit_user"
register_and_upload "$commit_user" "$commit_path_one" "$commit_object_one"
register_and_upload "$commit_user" "$commit_path_two" "$commit_object_two"

commit_expected_at="$(
  psql "$database_url" \
    --set=ON_ERROR_STOP=1 \
    --tuples-only \
    --no-align \
    --quiet \
    --command "
      select updated_at
      from public.profiles
      where user_id = '$commit_user';
    "
)"

commit_call_one=$(cat <<SQL
begin;
set local statement_timeout = '10s';
set local lock_timeout = '5s';
set local role authenticated;
set local "request.jwt.claim.sub" = '$commit_user';
set local "request.jwt.claims" = '{"sub":"$commit_user","role":"authenticated","email":"profile-photo-race@example.test"}';
select public.commit_profile_photo_upload(
  '$commit_path_one',
  '$commit_expected_at'::timestamptz,
  false,
  null,
  null
) ->> 'committed';
commit;
SQL
)

commit_call_two=$(cat <<SQL
begin;
set local statement_timeout = '10s';
set local lock_timeout = '5s';
set local role authenticated;
set local "request.jwt.claim.sub" = '$commit_user';
set local "request.jwt.claims" = '{"sub":"$commit_user","role":"authenticated","email":"profile-photo-race@example.test"}';
select public.commit_profile_photo_upload(
  '$commit_path_two',
  '$commit_expected_at'::timestamptz,
  false,
  null,
  null
) ->> 'committed';
commit;
SQL
)

psql "$database_url" --set=ON_ERROR_STOP=1 --tuples-only --no-align --quiet \
  --command "$commit_call_one" >"$test_directory/commit-one.log" 2>&1 &
commit_one_pid=$!
psql "$database_url" --set=ON_ERROR_STOP=1 --tuples-only --no-align --quiet \
  --command "$commit_call_two" >"$test_directory/commit-two.log" 2>&1 &
commit_two_pid=$!

commit_one_status=0
commit_two_status=0
wait "$commit_one_pid" || commit_one_status=$?
wait "$commit_two_pid" || commit_two_status=$?

if (( commit_one_status != 0 || commit_two_status != 0 )); then
  cat "$test_directory/commit-one.log" >&2
  cat "$test_directory/commit-two.log" >&2
  fail "Concurrent profile-photo commits did not both complete without a deadlock."
fi

successful_commits="$(
  { grep -h '^true$' "$test_directory/commit-one.log" "$test_directory/commit-two.log" || true; } \
    | wc -l \
    | tr -d ' '
)"
stale_commits="$(
  { grep -h '^false$' "$test_directory/commit-one.log" "$test_directory/commit-two.log" || true; } \
    | wc -l \
    | tr -d ' '
)"
expect_equal "$successful_commits" "1" \
  "Exactly one simultaneous profile-photo commit must win."
expect_equal "$stale_commits" "1" \
  "Exactly one simultaneous profile-photo commit must receive the stale-profile result."

read -r canonical_count pointer_matches object_count <<<"$(
  psql "$database_url" \
    --set=ON_ERROR_STOP=1 \
    --tuples-only \
    --no-align \
    --field-separator=' ' \
    --quiet \
    --command "
      select
        count(*) filter (where registry.state = 'canonical'),
        count(*) filter (
          where registry.state = 'canonical'
            and profile.avatar_url = registry.storage_path
            and object_row.id = registry.storage_object_id
            and object_row.bucket_id = 'profile-photos'
            and object_row.name = registry.storage_path
        ),
        count(object_row.id)
      from private.profile_photo_objects registry
      join public.profiles profile on profile.user_id = registry.user_id
      left join storage.objects object_row on object_row.id = registry.storage_object_id
      where registry.user_id = '$commit_user';
    "
)"
expect_equal "$canonical_count" "1" \
  "The simultaneous commits must leave exactly one canonical registry row."
expect_equal "$pointer_matches" "1" \
  "The canonical registry row, profile pointer, and Storage identity must agree."
expect_equal "$object_count" "2" \
  "The stale commit must not delete either uploaded object."

cleanup_path="$(
  psql "$database_url" \
    --set=ON_ERROR_STOP=1 \
    --tuples-only \
    --no-align \
    --quiet \
    --command "
      select storage_path
      from private.profile_photo_objects
      where user_id = '$commit_user'
        and state = 'pending_upload';
    "
)"

read -r cleanup_job_id claimed_cleanup_path cleanup_token <<<"$(
  authenticated_sql "$commit_user" "
select public.abandon_profile_photo_upload('$cleanup_path');
select job_id, storage_path, claim_token
from public.claim_profile_photo_cleanup(20);
" | tail -n 1
)"

[[ "$cleanup_job_id" =~ ^[0-9a-f-]{36}$ ]] \
  || fail "The stale upload did not yield a cleanup job."
[[ "$cleanup_token" =~ ^[0-9a-f-]{36}$ ]] \
  || fail "The stale upload cleanup job did not yield a claim token."
expect_equal "$claimed_cleanup_path" "$cleanup_path" \
  "Cleanup claiming must return the abandoned stale upload path."

authenticated_sql "$commit_user" "
set local storage.allow_delete_query = 'true';
delete from storage.objects
where bucket_id = 'profile-photos'
  and name = '$cleanup_path';
"

cleanup_object_count="$(
  psql "$database_url" \
    --set=ON_ERROR_STOP=1 \
    --tuples-only \
    --no-align \
    --quiet \
    --command "
      select count(*)
      from storage.objects
      where bucket_id = 'profile-photos'
        and name = '$cleanup_path';
    "
)"
expect_equal "$cleanup_object_count" "0" \
  "The claimed cleanup object must be absent before confirmation."

confirm_call=$(cat <<SQL
begin;
set local statement_timeout = '10s';
set local lock_timeout = '5s';
set local role authenticated;
set local "request.jwt.claim.sub" = '$commit_user';
set local "request.jwt.claims" = '{"sub":"$commit_user","role":"authenticated","email":"profile-photo-race@example.test"}';
select public.confirm_profile_photo_cleanup(
  '$cleanup_job_id',
  '$cleanup_token'
);
commit;
SQL
)

privileged_reinsert_call=$(cat <<SQL
begin;
set local statement_timeout = '10s';
set local lock_timeout = '5s';
set local role service_role;
insert into storage.objects (id, bucket_id, name, owner)
values (
  '$cleanup_reinsert_object',
  'profile-photos',
  '$cleanup_path',
  '$commit_user'
);
commit;
SQL
)

psql "$database_url" --set=ON_ERROR_STOP=1 --tuples-only --no-align --quiet \
  --command "$confirm_call" >"$test_directory/cleanup-confirm.log" 2>&1 &
cleanup_confirm_pid=$!
psql "$database_url" --set=ON_ERROR_STOP=1 --quiet \
  --command "$privileged_reinsert_call" >"$test_directory/cleanup-reinsert.log" 2>&1 &
cleanup_reinsert_pid=$!

cleanup_confirm_status=0
cleanup_reinsert_status=0
wait "$cleanup_confirm_pid" || cleanup_confirm_status=$?
wait "$cleanup_reinsert_pid" || cleanup_reinsert_status=$?

if (( cleanup_confirm_status != 0 )); then
  cat "$test_directory/cleanup-confirm.log" >&2
  fail "Cleanup confirmation did not complete during the privileged reinsertion race."
fi
if ! grep -qx 't' "$test_directory/cleanup-confirm.log"; then
  cat "$test_directory/cleanup-confirm.log" >&2
  fail "Cleanup confirmation did not retire the exact claimed path."
fi
if (( cleanup_reinsert_status == 0 )); then
  fail "A privileged caller reinserted a retired profile-photo path."
fi
if ! grep -q 'Profile-photo upload is not registered or has expired.' \
  "$test_directory/cleanup-reinsert.log"; then
  cat "$test_directory/cleanup-reinsert.log" >&2
  fail "The privileged reinsertion failed for an unexpected reason."
fi

read -r retired_count reinserted_count canonical_after_cleanup <<<"$(
  psql "$database_url" \
    --set=ON_ERROR_STOP=1 \
    --tuples-only \
    --no-align \
    --field-separator=' ' \
    --quiet \
    --command "
      select
        count(*) filter (
          where registry.storage_path = '$cleanup_path'
            and registry.state = 'retired'
            and registry.retired_at is not null
        ),
        (select count(*) from storage.objects
          where bucket_id = 'profile-photos' and name = '$cleanup_path'),
        count(*) filter (
          where registry.state = 'canonical'
            and registry.storage_path = profile.avatar_url
        )
      from private.profile_photo_objects registry
      join public.profiles profile on profile.user_id = registry.user_id
      where registry.user_id = '$commit_user';
    "
)"
expect_equal "$retired_count" "1" \
  "Cleanup confirmation must leave one terminal registry row."
expect_equal "$reinserted_count" "0" \
  "Cleanup confirmation must not race with a privileged path resurrection."
expect_equal "$canonical_after_cleanup" "1" \
  "Cleanup confirmation must leave the canonical profile photo untouched."

read -r commit_first_user commit_first_object commit_first_hash <<<"$(
  psql "$database_url" \
    --set=ON_ERROR_STOP=1 \
    --tuples-only \
    --no-align \
    --field-separator=' ' \
    --quiet \
    --command "
      select gen_random_uuid(), gen_random_uuid(),
        encode(gen_random_bytes(16), 'hex');
    "
)"
commit_first_path="$commit_first_user/avatar-1720000002001-$commit_first_hash.webp"
create_profile_fixture "$commit_first_user"
register_and_upload "$commit_first_user" "$commit_first_path" "$commit_first_object"
commit_first_expected_at="$(
  psql "$database_url" --set=ON_ERROR_STOP=1 --tuples-only --no-align --quiet \
    --command "select updated_at from public.profiles where user_id = '$commit_first_user';"
)"

commit_first_barrier=75275901
commit_first_call=$(cat <<SQL
begin;
set local statement_timeout = '10s';
set local lock_timeout = '5s';
set local role authenticated;
set local "request.jwt.claim.sub" = '$commit_first_user';
set local "request.jwt.claims" = '{"sub":"$commit_first_user","role":"authenticated","email":"profile-photo-race@example.test"}';
select user_id from public.profiles where user_id = '$commit_first_user' for update;
select pg_advisory_xact_lock($commit_first_barrier);
select pg_sleep(1);
select public.commit_profile_photo_upload(
  '$commit_first_path',
  '$commit_first_expected_at'::timestamptz,
  false,
  null,
  null
) ->> 'committed';
commit;
SQL
)
erasure_after_commit_call=$(cat <<SQL
begin;
set local statement_timeout = '10s';
set local lock_timeout = '5s';
set local role authenticated;
set local "request.jwt.claim.sub" = '$commit_first_user';
set local "request.jwt.claims" = '{"sub":"$commit_first_user","role":"authenticated","email":"profile-photo-race@example.test"}';
select public.request_retired_community_account_erasure(false);
commit;
SQL
)

psql "$database_url" --set=ON_ERROR_STOP=1 --tuples-only --no-align --quiet \
  --command "$commit_first_call" >"$test_directory/commit-before-seal.log" 2>&1 &
commit_first_pid=$!
wait_for_advisory_barrier "$commit_first_barrier"
psql "$database_url" --set=ON_ERROR_STOP=1 --tuples-only --no-align --quiet \
  --command "$erasure_after_commit_call" >"$test_directory/seal-after-commit.log" 2>&1 &
erasure_after_commit_pid=$!

commit_first_status=0
erasure_after_commit_status=0
wait "$commit_first_pid" || commit_first_status=$?
wait "$erasure_after_commit_pid" || erasure_after_commit_status=$?
if (( commit_first_status != 0 || erasure_after_commit_status != 0 )); then
  cat "$test_directory/commit-before-seal.log" >&2
  cat "$test_directory/seal-after-commit.log" >&2
  fail "Commit-first profile-photo/account-erasure coordination failed or deadlocked."
fi
if ! grep -qx 'true' "$test_directory/commit-before-seal.log"; then
  cat "$test_directory/commit-before-seal.log" >&2
  fail "The commit-first race did not commit the registered avatar."
fi

read -r commit_first_canonical commit_first_work commit_first_pending <<<"$(
  psql "$database_url" \
    --set=ON_ERROR_STOP=1 \
    --tuples-only \
    --no-align \
    --field-separator=' ' \
    --quiet \
    --command "
      select
        (select count(*) from private.profile_photo_objects registry
          where registry.user_id = '$commit_first_user'
            and registry.storage_path = '$commit_first_path'
            and registry.state = 'canonical'),
        (select count(*)
          from private.retired_community_storage_work work
          join private.retired_community_deletion_batches batch_row
            on batch_row.id = work.batch_id
          where batch_row.reason = 'account_erasure'
            and batch_row.subject_user_id = '$commit_first_user'
            and batch_row.sealed
            and work.object_id = '$commit_first_object'
            and work.bucket_id = 'profile-photos'
            and work.object_name = '$commit_first_path'
            and work.expected_row_sha256 = private.retired_community_sha256(
              (select to_jsonb(object_row)::text
                from storage.objects object_row
                where object_row.id = '$commit_first_object')
            )),
        private.retired_community_account_erasure_is_pending('$commit_first_user')::integer;
    "
)"
expect_equal "$commit_first_canonical" "1" \
  "A commit that wins the mutex must remain the exact canonical row."
expect_equal "$commit_first_work" "1" \
  "Account erasure sealing must inventory the just-committed canonical object exactly once."
expect_equal "$commit_first_pending" "1" \
  "The commit-first race must finish with account erasure pending."

read -r seal_first_user seal_first_object seal_first_hash <<<"$(
  psql "$database_url" \
    --set=ON_ERROR_STOP=1 \
    --tuples-only \
    --no-align \
    --field-separator=' ' \
    --quiet \
    --command "
      select gen_random_uuid(), gen_random_uuid(),
        encode(gen_random_bytes(16), 'hex');
    "
)"
seal_first_path="$seal_first_user/avatar-1720000003001-$seal_first_hash.jpg"
create_profile_fixture "$seal_first_user"
register_and_upload "$seal_first_user" "$seal_first_path" "$seal_first_object"
seal_first_expected_at="$(
  psql "$database_url" --set=ON_ERROR_STOP=1 --tuples-only --no-align --quiet \
    --command "select updated_at from public.profiles where user_id = '$seal_first_user';"
)"

seal_first_barrier=75275902
seal_first_call=$(cat <<SQL
begin;
set local statement_timeout = '10s';
set local lock_timeout = '5s';
set local role authenticated;
set local "request.jwt.claim.sub" = '$seal_first_user';
set local "request.jwt.claims" = '{"sub":"$seal_first_user","role":"authenticated","email":"profile-photo-race@example.test"}';
select user_id from public.profiles where user_id = '$seal_first_user' for update;
select pg_advisory_xact_lock($seal_first_barrier);
select pg_sleep(1);
select public.request_retired_community_account_erasure(false);
commit;
SQL
)
commit_after_seal_call=$(cat <<SQL
begin;
set local statement_timeout = '10s';
set local lock_timeout = '5s';
set local role authenticated;
set local "request.jwt.claim.sub" = '$seal_first_user';
set local "request.jwt.claims" = '{"sub":"$seal_first_user","role":"authenticated","email":"profile-photo-race@example.test"}';
select public.commit_profile_photo_upload(
  '$seal_first_path',
  '$seal_first_expected_at'::timestamptz,
  false,
  null,
  null
) ->> 'committed';
commit;
SQL
)

psql "$database_url" --set=ON_ERROR_STOP=1 --tuples-only --no-align --quiet \
  --command "$seal_first_call" >"$test_directory/seal-before-commit.log" 2>&1 &
seal_first_pid=$!
wait_for_advisory_barrier "$seal_first_barrier"
psql "$database_url" --set=ON_ERROR_STOP=1 --tuples-only --no-align --quiet \
  --command "$commit_after_seal_call" >"$test_directory/commit-after-seal.log" 2>&1 &
commit_after_seal_pid=$!

seal_first_status=0
commit_after_seal_status=0
wait "$seal_first_pid" || seal_first_status=$?
wait "$commit_after_seal_pid" || commit_after_seal_status=$?
if (( seal_first_status != 0 )); then
  cat "$test_directory/seal-before-commit.log" >&2
  fail "Seal-first account erasure did not complete without a deadlock."
fi
if (( commit_after_seal_status == 0 )); then
  cat "$test_directory/commit-after-seal.log" >&2
  fail "A profile-photo commit succeeded after account-erasure sealing won the mutex."
fi
if ! grep -q 'Profile assets are frozen while account erasure is pending.' \
  "$test_directory/commit-after-seal.log"; then
  cat "$test_directory/commit-after-seal.log" >&2
  fail "The post-seal profile-photo commit failed for an unexpected reason."
fi

read -r seal_first_pending_registry seal_first_canonical seal_first_avatar \
  seal_first_work seal_first_pending <<<"$(
    psql "$database_url" \
      --set=ON_ERROR_STOP=1 \
      --tuples-only \
      --no-align \
      --field-separator=' ' \
      --quiet \
      --command "
        select
          (select count(*) from private.profile_photo_objects registry
            where registry.user_id = '$seal_first_user'
              and registry.storage_path = '$seal_first_path'
              and registry.state = 'pending_upload'),
          (select count(*) from private.profile_photo_objects registry
            where registry.user_id = '$seal_first_user'
              and registry.state = 'canonical'),
          (select count(*) from public.profiles profile
            where profile.user_id = '$seal_first_user'
              and coalesce(profile.avatar_url, '') <> ''),
          (select count(*)
            from private.retired_community_storage_work work
            join private.retired_community_deletion_batches batch_row
              on batch_row.id = work.batch_id
            where batch_row.reason = 'account_erasure'
              and batch_row.subject_user_id = '$seal_first_user'
              and batch_row.sealed
              and work.object_id = '$seal_first_object'
              and work.bucket_id = 'profile-photos'
              and work.object_name = '$seal_first_path'
              and work.expected_row_sha256 = private.retired_community_sha256(
                (select to_jsonb(object_row)::text
                  from storage.objects object_row
                  where object_row.id = '$seal_first_object')
              )),
          private.retired_community_account_erasure_is_pending('$seal_first_user')::integer;
      "
  )"
expect_equal "$seal_first_pending_registry" "1" \
  "A seal-first race must leave the uncommitted registration pending for governed erasure."
expect_equal "$seal_first_canonical" "0" \
  "A seal-first race must not create a canonical registry row."
expect_equal "$seal_first_avatar" "0" \
  "A seal-first race must not write the profile avatar pointer."
expect_equal "$seal_first_work" "1" \
  "Seal-first account erasure must inventory the pending uploaded object exactly once."
expect_equal "$seal_first_pending" "1" \
  "The seal-first race must finish with account erasure pending."

echo "Profile-photo concurrency tests passed."
