#!/usr/bin/env bash
set -euo pipefail

database_url="${SUPABASE_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
case "$database_url" in
  postgresql://*@127.0.0.1:54322/*|postgres://*@127.0.0.1:54322/*|postgresql://*@localhost:54322/*|postgres://*@localhost:54322/*) ;;
  *) echo "Refusing to run crew lifecycle races against a non-local database." >&2; exit 2 ;;
esac
command -v psql >/dev/null 2>&1 || { echo "psql is required." >&2; exit 2; }

test_directory="$(mktemp -d)"
trap 'rm -rf "$test_directory"' EXIT

retry_user="91000000-0000-4000-8000-000000000001"
race_user="92000000-0000-4000-8000-000000000002"
inviter_user="93000000-0000-4000-8000-000000000003"
delete_joiner_user="94000000-0000-4000-8000-000000000004"
erasure_user="95000000-0000-4000-8000-000000000005"
retry_request="91100000-0000-4000-8000-000000000001"
race_request="92100000-0000-4000-8000-000000000001"
delete_request="94100000-0000-4000-8000-000000000001"
erasure_delete_request="95100000-0000-4000-8000-000000000001"
invite_crew="93100000-0000-4000-8000-000000000001"
erasure_crew="95100000-0000-4000-8000-000000000002"
invite_id="93200000-0000-4000-8000-000000000001"
invite_secret="crew-create-race-invite-12345"
delete_invite_id="93200000-0000-4000-8000-000000000002"
delete_invite_secret="crew-delete-race-invite-12345"

cleanup_fixture() {
  psql "$database_url" --set=ON_ERROR_STOP=1 --quiet <<SQL
delete from private.crew_lifecycle_requests
where actor_id in ('$retry_user', '$race_user', '$inviter_user', '$delete_joiner_user', '$erasure_user');
delete from public.crews
where id in ('$invite_crew', '$erasure_crew')
   or created_by in ('$retry_user', '$race_user', '$inviter_user', '$delete_joiner_user', '$erasure_user');
delete from auth.users where id in ('$retry_user', '$race_user', '$inviter_user', '$delete_joiner_user', '$erasure_user');
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
  ('00000000-0000-0000-0000-000000000000', '$retry_user', 'authenticated', 'authenticated',
   'crew-retry@example.test', 'fixture', now(), '{"provider":"email"}', '{"name":"Retry User"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '$race_user', 'authenticated', 'authenticated',
   'crew-race@example.test', 'fixture', now(), '{"provider":"email"}', '{"name":"Race User"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '$inviter_user', 'authenticated', 'authenticated',
   'crew-inviter@example.test', 'fixture', now(), '{"provider":"email"}', '{"name":"Invite Owner"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '$delete_joiner_user', 'authenticated', 'authenticated',
   'crew-delete-joiner@example.test', 'fixture', now(), '{"provider":"email"}', '{"name":"Delete Race Joiner"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '$erasure_user', 'authenticated', 'authenticated',
   'crew-erasure@example.test', 'fixture', now(), '{"provider":"email"}', '{"name":"Erasure Race Owner"}', now(), now());

insert into public.profiles (user_id, name, email, time_zone)
values
  ('$retry_user', 'Retry User', 'crew-retry@example.test', 'UTC'),
  ('$race_user', 'Race User', 'crew-race@example.test', 'UTC'),
  ('$inviter_user', 'Invite Owner', 'crew-inviter@example.test', 'UTC'),
  ('$delete_joiner_user', 'Delete Race Joiner', 'crew-delete-joiner@example.test', 'UTC'),
  ('$erasure_user', 'Erasure Race Owner', 'crew-erasure@example.test', 'UTC')
on conflict (user_id) do update set name = excluded.name, email = excluded.email;

insert into public.entitlements (
  user_id, entitlement_key, status, source_type, source_id, starts_at, ends_at
)
values
  ('$retry_user', 'membership_active', 'active', 'test', 'crew-retry', now(), now() + interval '1 day'),
  ('$race_user', 'membership_active', 'active', 'test', 'crew-race', now(), now() + interval '1 day'),
  ('$inviter_user', 'membership_active', 'active', 'test', 'crew-inviter', now(), now() + interval '1 day'),
  ('$delete_joiner_user', 'membership_active', 'active', 'test', 'crew-delete-joiner', now(), now() + interval '1 day'),
  ('$erasure_user', 'membership_active', 'active', 'test', 'crew-erasure', now(), now() + interval '1 day');

insert into public.crews (id, name, created_by)
values
  ('$invite_crew', 'Invite Race Crew', '$inviter_user'),
  ('$erasure_crew', 'Erasure Race Crew', '$erasure_user');
insert into public.crew_members (crew_id, user_id, display_name, role)
values
  ('$invite_crew', '$inviter_user', 'Invite Owner', 'owner'),
  ('$erasure_crew', '$erasure_user', 'Erasure Race Owner', 'owner');
insert into public.crew_invites (id, crew_id, token_hash, token_hint, created_by, expires_at)
values
  (
    '$invite_id', '$invite_crew', public.crew_invite_secret_hash('$invite_secret'),
    '12345', '$inviter_user', now() + interval '1 day'
  ),
  (
    '$delete_invite_id', '$invite_crew', public.crew_invite_secret_hash('$delete_invite_secret'),
    '12345', '$inviter_user', now() + interval '1 day'
  );
SQL

create_call() {
  local user_id="$1" request_id="$2" name="$3" output="$4"
  psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align --field-separator='|' --command "
    begin;
    set local role authenticated;
    set local "request.jwt.claim.sub" = '$user_id';
    select crew_id, created_new
    from public.create_crew('$request_id', '$name', 'Concurrency coverage', '2026-07-23');
    commit;
  " >"$output" 2>&1
}

create_call "$retry_user" "$retry_request" "Retry Race Crew" "$test_directory/retry-first.log" &
first_pid=$!
create_call "$retry_user" "$retry_request" "Retry Race Crew" "$test_directory/retry-second.log" &
second_pid=$!
first_status=0; second_status=0
wait "$first_pid" || first_status=$?
wait "$second_pid" || second_status=$?
if (( first_status != 0 || second_status != 0 )); then
  cat "$test_directory/retry-first.log" "$test_directory/retry-second.log" >&2
  echo "Concurrent identical create retries did not both complete." >&2
  exit 1
fi

read -r retry_crews retry_members retry_requests <<<"$(
  psql "$database_url" --set=ON_ERROR_STOP=1 --tuples-only --no-align --field-separator=' ' --command "
    select
      (select count(*) from public.crews where created_by = '$retry_user'),
      (select count(*) from public.crew_members where user_id = '$retry_user'),
      (select count(*) from private.crew_lifecycle_requests where request_id = '$retry_request');
  "
)"
created_true="$(grep -h -E -c '^[0-9a-f-]+\|t$' "$test_directory/retry-first.log" "$test_directory/retry-second.log" | awk '{n += $1} END {print n + 0}')"
created_false="$(grep -h -E -c '^[0-9a-f-]+\|f$' "$test_directory/retry-first.log" "$test_directory/retry-second.log" | awk '{n += $1} END {print n + 0}')"
if [[ "$retry_crews $retry_members $retry_requests $created_true $created_false" != "1 1 1 1 1" ]]; then
  cat "$test_directory/retry-first.log" "$test_directory/retry-second.log" >&2
  echo "Identical create retries did not converge to one crew/member/request (found $retry_crews/$retry_members/$retry_requests; results $created_true/$created_false)." >&2
  exit 1
fi

continuation="$(
  psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align --command "
    begin;
    set local role authenticated;
    set local "request.jwt.claim.sub" = '$race_user';
    select public.preview_crew_invite('$invite_secret', null) ->> 'continuationToken';
    commit;
  " | sed -nE '/^[A-Za-z0-9_-]{16,200}$/p'
)"
[[ -n "$continuation" ]] || { echo "Invite race did not produce a continuation." >&2; exit 1; }

create_call "$race_user" "$race_request" "Create Invite Race" "$test_directory/race-create.log" &
create_pid=$!
psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align --command "
  begin;
  set local role authenticated;
  set local "request.jwt.claim.sub" = '$race_user';
  select public.confirm_crew_invite('$continuation') ->> 'status';
  commit;
" >"$test_directory/race-invite.log" 2>&1 &
invite_pid=$!
create_status=0; invite_status=0
wait "$create_pid" || create_status=$?
wait "$invite_pid" || invite_status=$?
if (( invite_status != 0 )); then
  cat "$test_directory/race-create.log" "$test_directory/race-invite.log" >&2
  echo "Invite side of the create-vs-invite race failed unexpectedly." >&2
  exit 1
fi

read -r race_members orphan_crews create_requests attributions <<<"$(
  psql "$database_url" --set=ON_ERROR_STOP=1 --tuples-only --no-align --field-separator=' ' --command "
    select
      (select count(*) from public.crew_members where user_id = '$race_user'),
      (select count(*) from public.crews crew_row
       where crew_row.created_by = '$race_user'
         and not exists (select 1 from public.crew_members member_row where member_row.crew_id = crew_row.id)),
      (select count(*) from private.crew_lifecycle_requests where request_id = '$race_request'),
      (select count(*) from public.crew_invite_attributions where invite_id = '$invite_id');
  "
)"
invite_result="$(grep -E '^(joined|current_crew_conflict)$' "$test_directory/race-invite.log" || true)"
if [[ "$race_members" != "1" || "$orphan_crews" != "0" || $((create_requests + attributions)) != 1 ]]; then
  cat "$test_directory/race-create.log" "$test_directory/race-invite.log" >&2
  echo "Create-vs-invite race violated the one-membership/no-orphan contract ($race_members/$orphan_crews/$create_requests/$attributions)." >&2
  exit 1
fi
if [[ "$invite_result" != "joined" && "$invite_result" != "current_crew_conflict" ]]; then
  cat "$test_directory/race-invite.log" >&2
  echo "Invite race returned an unexpected status." >&2
  exit 1
fi
if (( create_status != 0 )) && [[ "$invite_result" != "joined" ]]; then
  cat "$test_directory/race-create.log" "$test_directory/race-invite.log" >&2
  echo "The losing create must correspond to a successful invite join." >&2
  exit 1
fi

delete_continuation="$(
  psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align --command "
    begin;
    set local role authenticated;
    set local \"request.jwt.claim.sub\" = '$delete_joiner_user';
    select public.preview_crew_invite('$delete_invite_secret', null) ->> 'continuationToken';
    commit;
  " | sed -nE '/^[A-Za-z0-9_-]{16,200}$/p'
)"
[[ -n "$delete_continuation" ]] || { echo "Delete race did not produce a continuation." >&2; exit 1; }

psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align --command "
  begin;
  set local role authenticated;
  set local \"request.jwt.claim.sub\" = '$inviter_user';
  select public.delete_crew('$invite_crew', '$delete_request') ->> 'status';
  commit;
" >"$test_directory/race-delete.log" 2>&1 &
delete_pid=$!
psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align --command "
  begin;
  set local role authenticated;
  set local \"request.jwt.claim.sub\" = '$delete_joiner_user';
  select public.confirm_crew_invite('$delete_continuation') ->> 'status';
  commit;
" >"$test_directory/race-delete-invite.log" 2>&1 &
delete_invite_pid=$!
delete_status=0; delete_invite_status=0
wait "$delete_pid" || delete_status=$?
wait "$delete_invite_pid" || delete_invite_status=$?
if (( delete_status != 0 || delete_invite_status != 0 )); then
  cat "$test_directory/race-delete.log" "$test_directory/race-delete-invite.log" >&2
  echo "Delete-vs-invite race did not complete cleanly (possible lock-order regression)." >&2
  exit 1
fi

delete_result="$(grep -E '^deleted$' "$test_directory/race-delete.log" || true)"
delete_invite_result="$(grep -E '^(joined|revoked|invalid)$' "$test_directory/race-delete-invite.log" || true)"
read -r deleted_crews remaining_members unrevoked_invites delete_requests <<<"$(
  psql "$database_url" --set=ON_ERROR_STOP=1 --tuples-only --no-align --field-separator=' ' --command "
    select
      (select count(*) from public.crews where id = '$invite_crew' and deleted_at is not null),
      (select count(*) from public.crew_members where crew_id = '$invite_crew'),
      (select count(*) from public.crew_invites where crew_id = '$invite_crew' and revoked_at is null),
      (select count(*) from private.crew_lifecycle_requests where request_id = '$delete_request');
  "
)"
if [[ "$delete_result" != "deleted" || -z "$delete_invite_result" || "$deleted_crews $remaining_members $unrevoked_invites $delete_requests" != "1 0 0 1" ]]; then
  cat "$test_directory/race-delete.log" "$test_directory/race-delete-invite.log" >&2
  echo "Delete-vs-invite race did not converge to one deleted inaccessible crew ($deleted_crews/$remaining_members/$unrevoked_invites/$delete_requests)." >&2
  exit 1
fi

# Reproduce the account-erasure worker's critical lock order in a real second
# transaction: global retention advisory lock, then membership/crew mutations.
# Rolling that transaction back preserves the fixture while still proving that
# delete_crew never holds either row lock while waiting for retention.
psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align --command "
  begin;
  set local statement_timeout = '10s';
  select pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('retired-community-deletion', 0)
  );
  select pg_catalog.pg_sleep(1);
  delete from public.crew_members where user_id = '$erasure_user';
  update public.crews set created_by = null where created_by = '$erasure_user';
  rollback;
" >"$test_directory/race-erasure.log" 2>&1 &
erasure_pid=$!
sleep 0.25
psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align --command "
  begin;
  set local statement_timeout = '10s';
  set local role authenticated;
  set local \"request.jwt.claim.sub\" = '$erasure_user';
  select public.delete_crew('$erasure_crew', '$erasure_delete_request') ->> 'status';
  commit;
" >"$test_directory/race-delete-erasure.log" 2>&1 &
delete_erasure_pid=$!
erasure_status=0; delete_erasure_status=0
wait "$erasure_pid" || erasure_status=$?
wait "$delete_erasure_pid" || delete_erasure_status=$?
if (( erasure_status != 0 || delete_erasure_status != 0 )) \
  || grep -Eqi '40P01|deadlock detected' "$test_directory/race-erasure.log" "$test_directory/race-delete-erasure.log"; then
  cat "$test_directory/race-erasure.log" "$test_directory/race-delete-erasure.log" >&2
  echo "Delete-vs-account-erasure lock ordering did not complete cleanly." >&2
  exit 1
fi

erasure_delete_result="$(grep -E '^deleted$' "$test_directory/race-delete-erasure.log" || true)"
read -r erasure_deleted erasure_members erasure_requests <<<"$(
  psql "$database_url" --set=ON_ERROR_STOP=1 --tuples-only --no-align --field-separator=' ' --command "
    select
      (select count(*) from public.crews where id = '$erasure_crew' and deleted_at is not null),
      (select count(*) from public.crew_members where crew_id = '$erasure_crew'),
      (select count(*) from private.crew_lifecycle_requests where request_id = '$erasure_delete_request');
  "
)"
if [[ "$erasure_delete_result" != "deleted" || "$erasure_deleted $erasure_members $erasure_requests" != "1 0 1" ]]; then
  cat "$test_directory/race-erasure.log" "$test_directory/race-delete-erasure.log" >&2
  echo "Delete-vs-account-erasure race did not converge to one deleted crew ($erasure_deleted/$erasure_members/$erasure_requests)." >&2
  exit 1
fi

echo "Crew lifecycle races preserved one membership, idempotent creation, and deadlock-free invite and account-erasure deletion."
