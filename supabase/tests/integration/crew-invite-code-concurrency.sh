#!/usr/bin/env bash
set -euo pipefail

database_url="${SUPABASE_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
case "$database_url" in
  postgresql://*@127.0.0.1:54322/*|postgres://*@127.0.0.1:54322/*|postgresql://*@localhost:54322/*|postgres://*@localhost:54322/*) ;;
  *) echo "Refusing to run crew invite code races against a non-local database." >&2; exit 2 ;;
esac
command -v psql >/dev/null 2>&1 || { echo "psql is required." >&2; exit 2; }

test_directory="$(mktemp -d)"
owner_id="f4450000-0000-4000-8000-000000000001"
joiner_id="f4450000-0000-4000-8000-000000000002"
authorization_joiner_id="f4450000-0000-4000-8000-000000000003"
crew_id="f4451000-0000-4000-8000-000000000001"
authorization_invite_id="f4452000-0000-4000-8000-000000000001"
authorization_invite_secret="fou1445-authorization-race-secret"

cancel_test_backends() {
  psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --command "
    select pg_catalog.pg_cancel_backend(activity.pid)
    from pg_catalog.pg_stat_activity activity
    where activity.pid <> pg_catalog.pg_backend_pid()
      and activity.application_name like 'fou1445-invite-code-%';
  " >/dev/null
}

wait_for_sleeping_backend() {
  local application_name="$1"
  local attempt
  local sleeping

  for attempt in $(seq 1 200); do
    sleeping="$(
      psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align \
        --command "
          select exists (
            select 1
            from pg_catalog.pg_stat_activity activity
            where activity.application_name = '$application_name'
              and activity.wait_event = 'PgSleep'
          );
        "
    )"
    [[ "$sleeping" == "t" ]] && return 0
    sleep 0.05
  done

  return 1
}

wait_for_lock_waiter() {
  local application_name="$1"
  local attempt
  local waiting

  for attempt in $(seq 1 200); do
    waiting="$(
      psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align \
        --command "
          select exists (
            select 1
            from pg_catalog.pg_stat_activity activity
            where activity.application_name = '$application_name'
              and activity.wait_event_type = 'Lock'
          );
        "
    )"
    [[ "$waiting" == "t" ]] && return 0
    sleep 0.05
  done

  return 1
}

cancel_backend() {
  local application_name="$1"
  local cancelled

  cancelled="$(
    psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align \
      --command "
        select coalesce(
          (
            select pg_catalog.pg_cancel_backend(activity.pid)::text
            from pg_catalog.pg_stat_activity activity
            where activity.application_name = '$application_name'
            order by activity.pid
            limit 1
          ),
          'missing'
        );
      "
  )"

  [[ "$cancelled" == "true" || "$cancelled" == "t" ]]
}

cleanup_fixture() {
  cancel_test_backends
  psql "$database_url" --set=ON_ERROR_STOP=1 --quiet <<SQL
delete from private.crew_invite_rate_limits
where scope_hash in (
  private.crew_invite_keyed_hash(
    'rate-v1',
    'confirmation:account:$joiner_id'
  ),
  private.crew_invite_keyed_hash(
    'rate-v1',
    'confirmation:account:$authorization_joiner_id'
  )
);
delete from public.crews
where id = '$crew_id'
   or created_by in ('$owner_id', '$joiner_id', '$authorization_joiner_id');
delete from auth.users
where id in ('$owner_id', '$joiner_id', '$authorization_joiner_id');
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
  (
    '00000000-0000-0000-0000-000000000000', '$owner_id',
    'authenticated', 'authenticated', 'invite-code-owner@example.test',
    'fixture', now(), '{"provider":"email","providers":["email"]}',
    '{"name":"Invite Code Owner"}', now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000', '$joiner_id',
    'authenticated', 'authenticated', 'invite-code-joiner@example.test',
    'fixture', now(), '{"provider":"email","providers":["email"]}',
    '{"name":"Invite Code Joiner"}', now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000', '$authorization_joiner_id',
    'authenticated', 'authenticated', 'invite-authorization-joiner@example.test',
    'fixture', now(), '{"provider":"email","providers":["email"]}',
    '{"name":"Invite Authorization Joiner"}', now(), now()
  );

insert into public.profiles (user_id, name, email, time_zone)
values
  ('$owner_id', 'Invite Code Owner', 'invite-code-owner@example.test', 'UTC'),
  ('$joiner_id', 'Invite Code Joiner', 'invite-code-joiner@example.test', 'UTC'),
  (
    '$authorization_joiner_id',
    'Invite Authorization Joiner',
    'invite-authorization-joiner@example.test',
    'UTC'
  );

insert into public.entitlements (
  user_id, entitlement_key, status, source_type, source_id, starts_at, ends_at
)
values
  (
    '$owner_id', 'membership_active', 'active', 'test',
    'invite-code-owner', now(), now() + interval '1 day'
  ),
  (
    '$joiner_id', 'membership_active', 'active', 'test',
    'invite-code-joiner', now(), now() + interval '1 day'
  ),
  (
    '$authorization_joiner_id', 'membership_active', 'active', 'test',
    'invite-authorization-joiner', now(), now() + interval '1 day'
  );

insert into public.crews (id, name, description, created_by)
values (
  '$crew_id',
  'Link and Code Race Crew',
  'Concurrent link and code confirmation coverage',
  '$owner_id'
);

insert into public.crew_members (crew_id, user_id, display_name, role)
values ('$crew_id', '$owner_id', 'Invite Code Owner', 'owner');
SQL

bundle="$(
  psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align \
    --field-separator='|' --command "
      begin;
      set local role authenticated;
      set local \"request.jwt.claim.sub\" = '$owner_id';
      select
        issued.value ->> 'status',
        issued.value ->> 'inviteId',
        issued.value ->> 'token',
        issued.value ->> 'code'
      from (
        select public.issue_crew_invite_bundle('$crew_id') as value
      ) issued;
      commit;
    "
)"

IFS='|' read -r issue_status invite_id invite_token invite_code <<<"$bundle"
if [[ "$issue_status" != "issued" \
  || ! "$invite_id" =~ ^[0-9a-f-]{36}$ \
  || ! "$invite_token" =~ ^[0-9a-f]{64}$ \
  || ! "$invite_code" =~ ^[34679ACDEFGHJKMNPQRTUVWXY]{16}$ ]]; then
  echo "The invite bundle did not contain a valid link token, code, and invite ID." >&2
  exit 1
fi

preview_as_joiner() {
  local preview_expression="$1"
  psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align --command "
    begin;
    set local role authenticated;
    set local \"request.jwt.claim.sub\" = '$joiner_id';
    select ($preview_expression) ->> 'continuationToken';
    commit;
  "
}

link_continuation="$(
  preview_as_joiner "public.preview_crew_invite('$invite_token', null)"
)"
code_continuation="$(
  preview_as_joiner "public.preview_crew_invite_code('$invite_code')"
)"

if [[ ! "$link_continuation" =~ ^[0-9a-f]{64}$ \
  || ! "$code_continuation" =~ ^[0-9a-f]{64}$ \
  || "$link_continuation" == "$code_continuation" ]]; then
  echo "Link and Code previews did not produce distinct valid continuations." >&2
  exit 1
fi

confirm_as_joiner() {
  local continuation_token="$1"
  local output_file="$2"
  psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align --command "
    begin;
    set local statement_timeout = '10s';
    set local role authenticated;
    set local \"request.jwt.claim.sub\" = '$joiner_id';
    select public.confirm_crew_invite('$continuation_token') ->> 'status';
    commit;
  " >"$output_file" 2>&1
}

confirm_as_joiner "$link_continuation" "$test_directory/link-confirm.log" &
link_pid=$!
confirm_as_joiner "$code_continuation" "$test_directory/code-confirm.log" &
code_pid=$!

link_status=0
code_status=0
wait "$link_pid" || link_status=$?
wait "$code_pid" || code_status=$?

if (( link_status != 0 || code_status != 0 )); then
  cat "$test_directory/link-confirm.log" "$test_directory/code-confirm.log" >&2
  echo "Concurrent Link and Code confirmations did not both complete." >&2
  exit 1
fi

joined_results="$(
  grep -h -c '^joined$' \
    "$test_directory/link-confirm.log" "$test_directory/code-confirm.log" \
    | awk '{ total += $1 } END { print total + 0 }'
)"
already_member_results="$(
  grep -h -c '^already_member$' \
    "$test_directory/link-confirm.log" "$test_directory/code-confirm.log" \
    | awk '{ total += $1 } END { print total + 0 }'
)"

if [[ "$joined_results $already_member_results" != "1 1" ]]; then
  cat "$test_directory/link-confirm.log" "$test_directory/code-confirm.log" >&2
  echo "Expected Link and Code confirmations to converge to joined/already_member." >&2
  exit 1
fi

read -r member_count attribution_count redeemed_by_matches session_count confirmed_session_count \
  evidence_count grant_count point_event_count badge_count cached_points ledger_points <<<"$(
  psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align \
    --field-separator=' ' --command "
      select
        (select count(*) from public.crew_members
         where crew_id = '$crew_id' and user_id = '$joiner_id'),
        (select count(*) from public.crew_invite_attributions
         where invite_id = '$invite_id'
           and crew_id = '$crew_id'
           and inviter_user_id = '$owner_id'
           and recipient_user_id = '$joiner_id'),
        (select count(*) from public.crew_invites
         where id = '$invite_id' and redeemed_by = '$joiner_id'),
        (select count(*) from public.crew_invite_sessions
         where invite_id = '$invite_id' and bound_user_id = '$joiner_id'),
        (select count(*) from public.crew_invite_sessions
         where invite_id = '$invite_id'
           and bound_user_id = '$joiner_id'
           and confirmed_at is not null),
        (select count(*) from public.sharing_reward_evidence
         where user_id = '$owner_id'
           and evidence_kind = 'confirmed_group_invite'),
        (select count(*) from public.sharing_reward_grants
         where user_id = '$owner_id'),
        (select count(*) from public.game_point_events
         where user_id = '$owner_id' and event_type = 'sharing_bonus'),
        (select count(*) from public.user_badges
         where user_id = '$owner_id' and badge_key = 'sharing'),
        (select total_points from public.user_game_stats
         where user_id = '$owner_id'),
        (select coalesce(sum(points), 0) from public.game_point_events
         where user_id = '$owner_id');
    "
)"

if [[ "$member_count $attribution_count $redeemed_by_matches" != "1 1 1" ]]; then
  echo "Link and Code contention produced duplicate or missing membership evidence ($member_count/$attribution_count/$redeemed_by_matches)." >&2
  exit 1
fi

if [[ "$session_count $confirmed_session_count" != "2 1" ]]; then
  echo "Expected two representation-specific sessions and one confirmed session; found $session_count/$confirmed_session_count." >&2
  exit 1
fi

if [[ "$evidence_count $grant_count $point_event_count $badge_count" != "1 1 1 1" ]]; then
  echo "Invite contention must produce one Sharing evidence, grant, event, and badge; found $evidence_count/$grant_count/$point_event_count/$badge_count." >&2
  exit 1
fi

if [[ "$cached_points $ledger_points" != "14 14" ]]; then
  echo "Invite contention must award exactly 14 Sharing points; cached=$cached_points ledger=$ledger_points." >&2
  exit 1
fi

echo "Concurrent Link and Code confirmations produced one membership, attribution, and 14-point Sharing reward."

run_issue_authorization_revocation_race() {
  local revocation_kind="$1"
  local holder_application="fou1445-invite-code-issue-$revocation_kind-holder"
  local issue_application="fou1445-invite-code-issue-$revocation_kind-waiter"
  local holder_log="$test_directory/issue-$revocation_kind-holder.log"
  local issue_log="$test_directory/issue-$revocation_kind-result.log"
  local invites_before
  local invites_after
  local holder_pid
  local issue_pid
  local issue_process_status=0

  invites_before="$(
    psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align \
      --command "select count(*) from public.crew_invites where crew_id = '$crew_id';"
  )"

  psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --command "
    begin;
    set local statement_timeout = '45s';
    set local application_name = '$holder_application';
    select pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('crew-invite:' || '$crew_id'::text, 0)
    );
    select pg_catalog.pg_sleep(30);
    rollback;
  " >"$holder_log" 2>&1 &
  holder_pid=$!

  if ! wait_for_sleeping_backend "$holder_application"; then
    cat "$holder_log" >&2
    echo "The $revocation_kind issuance lock holder did not become ready." >&2
    exit 1
  fi

  psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align \
    --command "
      begin;
      set local statement_timeout = '15s';
      set local application_name = '$issue_application';
      set local role authenticated;
      set local \"request.jwt.claim.sub\" = '$owner_id';
      select public.issue_crew_invite_bundle('$crew_id') ->> 'status';
      commit;
    " >"$issue_log" 2>&1 &
  issue_pid=$!

  if ! wait_for_lock_waiter "$issue_application"; then
    cat "$holder_log" "$issue_log" >&2
    echo "Issuance did not wait on the crew-invite mutex before the $revocation_kind revocation." >&2
    exit 1
  fi

  case "$revocation_kind" in
    role)
      psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --command "
        update public.crew_members
        set role = 'member'
        where crew_id = '$crew_id' and user_id = '$owner_id';
      "
      ;;
    entitlement)
      psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --command "
        update public.entitlements
        set status = 'revoked', updated_at = pg_catalog.now()
        where user_id = '$owner_id'
          and entitlement_key = 'membership_active';
      "
      ;;
    *)
      echo "Unknown issuance authorization revocation: $revocation_kind." >&2
      exit 2
      ;;
  esac

  if ! cancel_backend "$holder_application"; then
    echo "The $revocation_kind issuance lock holder could not be released." >&2
    exit 1
  fi
  wait "$holder_pid" >/dev/null 2>&1 || true
  wait "$issue_pid" || issue_process_status=$?

  if (( issue_process_status != 0 )) || ! grep -qx 'forbidden' "$issue_log"; then
    cat "$holder_log" "$issue_log" >&2
    echo "Issuance did not fail closed after the inviter $revocation_kind changed." >&2
    exit 1
  fi

  invites_after="$(
    psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align \
      --command "select count(*) from public.crew_invites where crew_id = '$crew_id';"
  )"
  if [[ "$invites_after" != "$invites_before" ]]; then
    echo "Forbidden issuance created or retired an invite after the $revocation_kind revocation." >&2
    exit 1
  fi

  case "$revocation_kind" in
    role)
      psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --command "
        update public.crew_members
        set role = 'owner'
        where crew_id = '$crew_id' and user_id = '$owner_id';
      "
      ;;
    entitlement)
      psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --command "
        update public.entitlements
        set status = 'active', updated_at = pg_catalog.now()
        where user_id = '$owner_id'
          and entitlement_key = 'membership_active';
      "
      ;;
  esac
}

run_issue_authorization_revocation_race role
run_issue_authorization_revocation_race entitlement

echo "Invite issuance revalidated inviter role and entitlement after the crew-invite mutex."

psql "$database_url" --set=ON_ERROR_STOP=1 --quiet <<SQL
insert into public.crew_invites (
  id,
  crew_id,
  token_hash,
  token_hint,
  code_hash,
  code_hint,
  created_by,
  expires_at
)
values (
  '$authorization_invite_id',
  '$crew_id',
  public.crew_invite_secret_hash('$authorization_invite_secret'),
  pg_catalog.right('$authorization_invite_secret', 6),
  private.crew_invite_keyed_hash('code-v1', 'ACDEFGHJKMNPQRTU'),
  'QRTU',
  '$owner_id',
  pg_catalog.now() + interval '1 day'
);
SQL

authorization_continuation="$(
  psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align \
    --command "
      begin;
      set local role authenticated;
      set local \"request.jwt.claim.sub\" = '$authorization_joiner_id';
      select public.preview_crew_invite(
        '$authorization_invite_secret',
        null
      ) ->> 'continuationToken';
      commit;
    "
)"

if [[ ! "$authorization_continuation" =~ ^[0-9a-f]{64}$ ]]; then
  echo "The authorization race did not produce a valid continuation." >&2
  exit 1
fi

crew_holder_application="fou1445-invite-code-confirm-crew-holder"
confirmation_application="fou1445-invite-code-confirm-crew-waiter"
crew_holder_log="$test_directory/confirm-crew-holder.log"
confirmation_log="$test_directory/confirm-authorization-result.log"

psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --command "
  begin;
  set local statement_timeout = '45s';
  set local application_name = '$crew_holder_application';
  select id
  from public.crews
  where id = '$crew_id'
  for update;
  select pg_catalog.pg_sleep(30);
  rollback;
" >"$crew_holder_log" 2>&1 &
crew_holder_pid=$!

if ! wait_for_sleeping_backend "$crew_holder_application"; then
  cat "$crew_holder_log" >&2
  echo "The confirmation crew-row lock holder did not become ready." >&2
  exit 1
fi

psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align \
  --command "
    begin;
    set local statement_timeout = '15s';
    set local application_name = '$confirmation_application';
    set local role authenticated;
    set local \"request.jwt.claim.sub\" = '$authorization_joiner_id';
    select public.confirm_crew_invite('$authorization_continuation') ->> 'status';
    commit;
  " >"$confirmation_log" 2>&1 &
confirmation_pid=$!

if ! wait_for_lock_waiter "$confirmation_application"; then
  cat "$crew_holder_log" "$confirmation_log" >&2
  echo "Confirmation did not wait on the crew row before inviter authorization changed." >&2
  exit 1
fi

psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --command "
  update public.entitlements
  set status = 'revoked', updated_at = pg_catalog.now()
  where user_id = '$owner_id'
    and entitlement_key = 'membership_active';
"

if ! cancel_backend "$crew_holder_application"; then
  echo "The confirmation crew-row lock holder could not be released." >&2
  exit 1
fi
wait "$crew_holder_pid" >/dev/null 2>&1 || true
confirmation_process_status=0
wait "$confirmation_pid" || confirmation_process_status=$?

psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --command "
  update public.entitlements
  set status = 'active', updated_at = pg_catalog.now()
  where user_id = '$owner_id'
    and entitlement_key = 'membership_active';
"

if (( confirmation_process_status != 0 )) || ! grep -qx 'invalid' "$confirmation_log"; then
  cat "$crew_holder_log" "$confirmation_log" >&2
  echo "Confirmation did not fail closed after inviter authorization changed." >&2
  exit 1
fi

read -r authorization_members authorization_attributions authorization_redemptions \
  authorization_confirmed_sessions authorization_evidence authorization_grants \
  authorization_point_events authorization_badges authorization_cached_points \
  authorization_ledger_points <<<"$(
  psql "$database_url" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align \
    --field-separator=' ' --command "
      select
        (select count(*) from public.crew_members
         where crew_id = '$crew_id' and user_id = '$authorization_joiner_id'),
        (select count(*) from public.crew_invite_attributions
         where invite_id = '$authorization_invite_id'
           or recipient_user_id = '$authorization_joiner_id'),
        (select count(*) from public.crew_invites
         where id = '$authorization_invite_id' and redeemed_by is not null),
        (select count(*) from public.crew_invite_sessions
         where invite_id = '$authorization_invite_id'
           and confirmed_at is not null),
        (select count(*) from public.sharing_reward_evidence
         where user_id = '$owner_id'
           and evidence_kind = 'confirmed_group_invite'),
        (select count(*) from public.sharing_reward_grants
         where user_id = '$owner_id'),
        (select count(*) from public.game_point_events
         where user_id = '$owner_id' and event_type = 'sharing_bonus'),
        (select count(*) from public.user_badges
         where user_id = '$owner_id' and badge_key = 'sharing'),
        (select total_points from public.user_game_stats
         where user_id = '$owner_id'),
        (select coalesce(sum(points), 0) from public.game_point_events
         where user_id = '$owner_id');
    "
)"

if [[ "$authorization_members $authorization_attributions $authorization_redemptions $authorization_confirmed_sessions" != "0 0 0 0" ]]; then
  echo "Revoked inviter authorization still produced confirmation side effects ($authorization_members/$authorization_attributions/$authorization_redemptions/$authorization_confirmed_sessions)." >&2
  exit 1
fi

if [[ "$authorization_evidence $authorization_grants $authorization_point_events $authorization_badges" != "1 1 1 1" \
  || "$authorization_cached_points $authorization_ledger_points" != "14 14" ]]; then
  echo "Failed confirmation changed the inviter Sharing reward state unexpectedly." >&2
  exit 1
fi

echo "Confirmation revalidated inviter authorization after the crew-row lock without creating membership or reward side effects."
