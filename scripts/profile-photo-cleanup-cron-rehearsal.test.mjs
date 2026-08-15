import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const rehearsalPath = path.join(
  scriptDirectory,
  "rehearse-profile-photo-cleanup-cron.sh",
);
const bridgePath = path.join(
  scriptDirectory,
  "fixtures",
  "profile-photo-cleanup-supabase-bridge.ts",
);
const handlerPath = path.join(
  repositoryRoot,
  "supabase",
  "functions",
  "process-profile-photo-cleanup",
  "index.ts",
);
const cleanupOrchestratorPath = path.join(
  scriptDirectory,
  "fixtures",
  "profile-photo-cleanup-cron-cleanup.sh",
);
const faultPhases = [
  "tracking_ready",
  "fixtures_ready",
  "first_upload_stored",
  "runtime_created",
  "readiness_queued",
  "cron_scheduled",
  "worker_completed",
  "health_queued",
  "teardown_started",
  "cleanup_queued",
];
const phaseStates = {
  tracking_ready: "tracking-only",
  fixtures_ready: "fixtures-no-objects",
  first_upload_stored: "fixtures-first-object",
  runtime_created: "runtime-four-objects",
  readiness_queued: "runtime-readiness-request",
  cron_scheduled: "runtime-readiness-cron",
  worker_completed: "runtime-readiness-worker-cron-history",
  health_queued: "runtime-three-requests-drained-cron",
  teardown_started: "runtime-three-requests-drained-cron",
  cleanup_queued: "runtime-four-requests-drained-cron",
};
const fakeCleanupIntents = [
  "runtime:docker inspect fou802-profile-photo-cleanup-rehearsal",
  "runtime:docker rm --force fou802-profile-photo-cleanup-rehearsal",
  "cron:cron.unschedule 42",
  "cron:delete terminal cron.job_run_details 42",
  "pgnet:delete net.http_request_queue 101,102,103,104",
  "pgnet:delete net._http_response 101,102,103,104",
  "storage:cancel fixture erasure ledger",
  "storage:clear canonical avatar pointers",
  "storage:recover exact storage object id and transition registry to cleanup",
  "storage:claim and verify live service authorization",
  "storage:verify exact bucket path and object identity",
  "storage:DELETE JSON {\"prefixes\":[\"00000000-0000-4000-8000-000000000002/avatar-1700000000001-1123456789abcdef0123456789abcdef.webp\"]}",
  "database:delete fixture lifecycle and auth rows",
  "database:drop tracking inventory",
  "temporary:rm -rf /tmp/fou802-fake-artifacts",
];
const fakeCleanupHarness = String.raw`
set -u
exec 9>&1
source "$1"
fault_phase="$2"
fail_boundary="$3"
fake_root="$4"

runtime_container="fou802-profile-photo-cleanup-rehearsal"
cron_job_name="fou802-profile-photo-cleanup-local"
secret_table="private.fou802_profile_photo_cleanup_rehearsal"
fixture_table="private.fou802_profile_photo_cleanup_fixtures"
local_api_origin="http://127.0.0.1:54321"
fixture_path="00000000-0000-4000-8000-000000000001/avatar-1700000000000-0123456789abcdef0123456789abcdef.webp"
fixture_path_2="00000000-0000-4000-8000-000000000002/avatar-1700000000001-1123456789abcdef0123456789abcdef.webp"
fixture_path_3="00000000-0000-4000-8000-000000000003/avatar-1700000000002-2123456789abcdef0123456789abcdef.webp"
fixture_path_4="00000000-0000-4000-8000-000000000004/avatar-1700000000003-3123456789abcdef0123456789abcdef.webp"
fixture_object_id="10000000-0000-4000-8000-000000000001"
curl_config="$fake_root/curl.conf"
temporary_root="/tmp/fou802-fake-artifacts"
lock_directory="$fake_root/lock"
lock_owner_file="$lock_directory/owner"
mkdir "$lock_directory"
printf '%s\n' "$$" >"$lock_owner_file"

cron_job_id=""
readiness_request_id=""
worker_request_id=""
health_request_id=""
cleanup_request_id=""
cron_installed_by_rehearsal=false
cleanup_failed=false
runtime_cleanup_complete=false
cron_cleanup_complete=false
pgnet_cleanup_complete=false
fixture_objects_cleanup_complete=false
fixture_database_cleanup_complete=false

runtime_present=false
cron_job_present=false
cron_history_present=false
pgnet_queue_count=0
pgnet_response_count=0
fixture_present=false
tracking_present=true
fixture_authorized=false
fixture_object_residue=0
fixture_paths=""
first_cleanup_path="$fixture_path"
storage_delete_calls=0
logged_keys="|"

case "$fault_phase" in
  tracking_ready)
    phase_state="tracking-only"
    ;;
  fixtures_ready)
    phase_state="fixtures-no-objects"
    fixture_present=true
    ;;
  first_upload_stored)
    phase_state="fixtures-first-object"
    fixture_present=true
    fixture_object_residue=1
    fixture_paths="$fixture_path"
    ;;
  runtime_created)
    phase_state="runtime-four-objects"
    fixture_present=true
    fixture_object_residue=4
    fixture_paths="$fixture_path
$fixture_path_2
$fixture_path_3
$fixture_path_4"
    runtime_present=true
    ;;
  readiness_queued)
    phase_state="runtime-readiness-request"
    fixture_present=true
    fixture_object_residue=4
    fixture_paths="$fixture_path
$fixture_path_2
$fixture_path_3
$fixture_path_4"
    runtime_present=true
    readiness_request_id="101"
    pgnet_queue_count=0
    pgnet_response_count=1
    ;;
  cron_scheduled)
    phase_state="runtime-readiness-cron"
    fixture_present=true
    fixture_object_residue=4
    fixture_paths="$fixture_path
$fixture_path_2
$fixture_path_3
$fixture_path_4"
    runtime_present=true
    readiness_request_id="101"
    cron_job_id="42"
    cron_job_present=true
    pgnet_queue_count=0
    pgnet_response_count=1
    ;;
  worker_completed)
    phase_state="runtime-readiness-worker-cron-history"
    fixture_present=true
    fixture_object_residue=3
    fixture_paths="$fixture_path_2
$fixture_path_3
$fixture_path_4"
    first_cleanup_path="$fixture_path_2"
    runtime_present=true
    readiness_request_id="101"
    worker_request_id="102"
    cron_job_id="42"
    cron_job_present=true
    cron_history_present=true
    pgnet_queue_count=0
    pgnet_response_count=2
    ;;
  health_queued|teardown_started)
    phase_state="runtime-three-requests-drained-cron"
    fixture_present=true
    fixture_object_residue=3
    fixture_paths="$fixture_path_2
$fixture_path_3
$fixture_path_4"
    first_cleanup_path="$fixture_path_2"
    runtime_present=true
    readiness_request_id="101"
    worker_request_id="102"
    health_request_id="103"
    cron_job_id="42"
    cron_history_present=true
    pgnet_queue_count=0
    pgnet_response_count=3
    ;;
  cleanup_queued)
    phase_state="runtime-four-requests-drained-cron"
    fixture_present=true
    fixture_object_residue=3
    fixture_paths="$fixture_path_2
$fixture_path_3
$fixture_path_4"
    first_cleanup_path="$fixture_path_2"
    runtime_present=true
    readiness_request_id="101"
    worker_request_id="102"
    health_request_id="103"
    cleanup_request_id="104"
    cron_job_id="42"
    cron_history_present=true
    pgnet_queue_count=0
    pgnet_response_count=4
    ;;
  *)
    printf 'unknown:phase:%s\n' "$fault_phase" >&9
    exit 98
    ;;
esac

expected_delete_count="$fixture_object_residue"

if [[ "$fail_boundary" == "extension_drop" || "$fail_boundary" == "owned_extension" ]]; then
  cron_installed_by_rehearsal=true
fi

request_id_csv=""
for request_id in "$readiness_request_id" "$worker_request_id" "$health_request_id" "$cleanup_request_id"; do
  [[ -n "$request_id" ]] || continue
  if [[ -n "$request_id_csv" ]]; then
    request_id_csv="$request_id_csv,$request_id"
  else
    request_id_csv="$request_id"
  fi
done

log_once() {
  local key="$1"
  shift
  case "$logged_keys" in
    *"|$key|"*) ;;
    *)
      logged_keys="$logged_keys$key|"
      printf '%s\n' "$*" >&9
      ;;
  esac
}

# Time is an external boundary in this deterministic harness. All database
# reads already represent a completed observation interval.
sleep() { :; }

docker_command() {
  case "$1" in
    inspect)
      log_once docker_inspect "runtime:docker inspect $2"
      [[ "$fail_boundary" != "docker_inspect" && "$fail_boundary" != "docker_absence_probe" ]] || return 71
      $runtime_present
      ;;
    rm)
      log_once docker_rm "runtime:docker rm --force $3"
      [[ "$fail_boundary" != "docker_rm" ]] || return 71
      runtime_present=false
      ;;
    ps)
      log_once docker_list "runtime:docker ps exact-name absence proof"
      [[ "$fail_boundary" != "docker_absence_probe" ]] || return 71
      $runtime_present && printf '%s\n' "$runtime_container"
      return 0
      ;;
    *)
      log_once unknown_docker "unknown:docker:$*"
      return 97
      ;;
  esac
}

inspect_value() {
  log_once docker_label "runtime:verify rehearsal ownership label"
  [[ "$fail_boundary" != "docker_label" ]] || return 71
  printf '%s\n' true
}

db_query() {
  local sql=""
  [[ "$1" == "--command" ]] && sql="$2"
  case "$sql" in
    *"fou802_profile_photo_cleanup_rehearsal') is not null"*)
      log_once tracking_probe "database:probe tracking inventory"
      [[ "$fail_boundary" != "tracking_probe" ]] || return 71
      $tracking_present && printf '%s\n' t || printf '%s\n' f
      ;;
    *"fou802_profile_photo_cleanup_fixtures') is not null"*)
      log_once fixture_probe "database:probe fixture inventory"
      [[ "$fail_boundary" != "fixture_probe" ]] || return 71
      $fixture_present && printf '%s\n' t || printf '%s\n' f
      ;;
    *"select exists (select 1 from pg_extension where extname = 'pg_cron')"*)
      log_once cron_extension_probe "database:probe pg_cron extension"
      [[ "$fail_boundary" != "cron_extension_probe" ]] || return 71
      printf '%s\n' t
      ;;
    *"string_agg(jobid::text"*)
      if $cron_job_present; then printf '%s\n' 42; else printf '%s\n' ""; fi
      ;;
    *"coalesce(cron_job_id::text"*)
      printf '%s\n' "$cron_job_id"
      ;;
    *"cron.unschedule("*)
      log_once cron_unschedule "cron:cron.unschedule 42"
      [[ "$fail_boundary" != "cron_unschedule" ]] || return 71
      cron_job_present=false
      ;;
    *"from cron.job_run_details"*"end_time is null"*)
      printf '%s\n' 0
      ;;
    *"from cron.job_run_details"*)
      $cron_history_present && printf '%s\n' 1 || printf '%s\n' 0
      ;;
    *"select count(*) from cron.job"*)
      $cron_job_present && printf '%s\n' 1 || printf '%s\n' 0
      ;;
    *"unnest(array_remove(array["*)
      printf '%s\n' "$request_id_csv"
      ;;
    *"select count(distinct id)"*"from net._http_response"*)
      printf '%s\n' "$pgnet_response_count"
      ;;
    *"select count(*) from net.http_request_queue"*"select count(*) from net._http_response"*)
      printf '%s\n' "$((pgnet_queue_count + pgnet_response_count))"
      ;;
    *"select storage_path from private.fou802_profile_photo_cleanup_fixtures"*)
      log_once storage_inventory "storage:enumerate exact fixture path $fixture_path"
      printf '%s\n' "$fixture_paths"
      ;;
    *"select coalesce(object_row.id::text"*)
      log_once storage_recover "storage:recover exact object id for bucket=profile-photos path=$fixture_path"
      if [[ "$fixture_object_residue" -gt 0 ]]; then
        printf '%s\n' "$fixture_object_id"
      else
        printf '%s\n' ""
      fi
      ;;
    *"select coalesce(public.verify_profile_photo_cleanup_service"*)
      log_once storage_verify "storage:verify exact bucket path and object identity"
      $fixture_authorized && printf '%s\n' true || printf '%s\n' false
      ;;
    *"join private.fou802_profile_photo_cleanup_fixtures fixture"*"object_row.bucket_id = 'profile-photos'"*)
      printf '%s\n' "$fixture_object_residue"
      ;;
    *"select pg_cron_installed_by_rehearsal"*)
      $cron_installed_by_rehearsal && printf '%s\n' t || printf '%s\n' f
      ;;
    *)
      log_once unknown_query "unknown:query:$sql"
      return 97
      ;;
  esac
}

db_exec() {
  local sql=""
  if [[ "$#" -ge 2 && "$1" == "--command" ]]; then
    sql="$2"
  else
    sql="$(/bin/cat)"
  fi
  case "$sql" in
    *"claim_profile_photo_cleanup_service(100)"*)
      log_once storage_cancel "storage:cancel fixture erasure ledger"
      log_once storage_avatar "storage:clear canonical avatar pointers"
      log_once storage_state "storage:recover exact storage object id and transition registry to cleanup"
      log_once storage_claim "storage:claim and verify live service authorization"
      [[ "$fail_boundary" != "authorization" ]] || return 71
      fixture_authorized=true
      ;;
    *"drop table private.fou802_profile_photo_cleanup_fixtures"*)
      log_once fixture_database "database:delete fixture lifecycle and auth rows"
      [[ "$fail_boundary" != "fixture_database" ]] || return 71
      fixture_present=false
      ;;
    *"delete from cron.job_run_details"*)
      log_once cron_delete "cron:delete terminal cron.job_run_details 42"
      [[ "$fail_boundary" != "cron_delete" ]] || return 71
      cron_history_present=false
      ;;
    *"delete from net.http_request_queue"*"delete from net._http_response"*)
      log_once pgnet_queue "pgnet:delete net.http_request_queue $request_id_csv"
      log_once pgnet_response "pgnet:delete net._http_response $request_id_csv"
      [[ "$fail_boundary" != "pgnet_delete" ]] || return 71
      pgnet_queue_count=0
      pgnet_response_count=0
      ;;
    *"drop extension if exists pg_cron"*)
      log_once extension_drop "database:drop rehearsal-owned pg_cron before tracking inventory"
      [[ "$fail_boundary" != "extension_drop" ]] || return 71
      cron_installed_by_rehearsal=false
      ;;
    *"drop table if exists private.fou802_profile_photo_cleanup_rehearsal"*)
      log_once tracking_drop "database:drop tracking inventory"
      [[ "$fail_boundary" != "tracking_drop" ]] || return 71
      tracking_present=false
      ;;
    *)
      log_once unknown_exec "unknown:exec:$sql"
      return 97
      ;;
  esac
}

storage_curl() {
  storage_delete_calls=$((storage_delete_calls + 1))
  log_once storage_delete "storage:DELETE JSON {\"prefixes\":[\"$first_cleanup_path\"]}"
  log_once storage_delete_args "storage:curl args $*"
  [[ "$fail_boundary" != "storage_delete" ]] || return 71
  fixture_object_residue=$((fixture_object_residue - 1))
}

remove_tree_command() {
  log_once temporary_remove "temporary:rm -rf $1"
  [[ "$fail_boundary" != "temporary_remove" ]]
}

remove_file_command() {
  log_once lock_owner_remove "lock:rm owner $1"
  [[ "$fail_boundary" != "lock_remove" ]]
}

rmdir_command() {
  log_once lock_directory_remove "lock:rmdir $1"
  [[ "$fail_boundary" != "lock_rmdir" ]]
}

printf 'phase:%s state:%s\n' "$fault_phase" "$phase_state"
run_rehearsal_resource_cleanup
fou802_run_cleanup_steps remove_temporary_artifacts release_lock
printf 'cleanup:flags failed=%s runtime=%s cron=%s pgnet=%s objects=%s database=%s tracking=%s fixture=%s deletes=%s expected_deletes=%s\n' \
  "$cleanup_failed" "$runtime_cleanup_complete" "$cron_cleanup_complete" \
  "$pgnet_cleanup_complete" "$fixture_objects_cleanup_complete" \
  "$fixture_database_cleanup_complete" "$tracking_present" "$fixture_present" \
  "$storage_delete_calls" "$expected_delete_count"
`;

function runFakeCleanup(faultPhase, failStep = "none") {
  const fakeRoot = mkdtempSync(path.join(tmpdir(), "fou802-cleanup-test."));
  writeFileSync(path.join(fakeRoot, "curl.conf"), "# fake local curl config\n");
  try {
    return spawnSync(
      "bash",
      [
        "-c",
        fakeCleanupHarness,
        "fou802-fake-cleanup",
        cleanupOrchestratorPath,
        faultPhase,
        failStep,
        fakeRoot,
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin" },
      },
    );
  } finally {
    rmSync(fakeRoot, { recursive: true, force: true });
  }
}

function assertIntentOrder(output, intents) {
  let previousOffset = -1;
  for (const intent of intents) {
    const offset = output.indexOf(intent);
    assert.ok(offset > previousOffset, `missing or out-of-order intent: ${intent}\n${output}`);
    previousOffset = offset;
  }
}

async function externalImportsFromGraph(entryPath) {
  const pending = [entryPath];
  const visited = new Set();
  const external = new Set();
  const importPattern = /(?:\b(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s*)?["']([^"']+)["'])|(?:\bimport\s*\(\s*["']([^"']+)["']\s*\))/g;

  while (pending.length > 0) {
    const currentPath = pending.pop();
    if (visited.has(currentPath)) continue;
    visited.add(currentPath);
    const source = await readFile(currentPath, "utf8");
    assert.doesNotMatch(source, /\brequire\s*\(/);
    assert.doesNotMatch(source, /\bimport\s*\(\s*[^"'\s]/);
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1] || match[2];
      if (!specifier.startsWith(".")) {
        external.add(specifier);
        continue;
      }
      const resolved = path.resolve(path.dirname(currentPath), specifier);
      pending.push(path.extname(resolved) ? resolved : `${resolved}.ts`);
    }
  }
  return [...external].sort();
}

test("only the two documented reset acknowledgement forms pass the gate", () => {
  const rejectedArguments = [
    [],
    ["--"],
    ["--confirm-local-reset", "extra"],
    ["--", "--confirm-local-reset", "extra"],
    ["--confirm-local-reset", "--"],
    ["--", "confirm-local-reset"],
  ];

  for (const argumentsList of rejectedArguments) {
    const result = spawnSync("bash", [rehearsalPath, ...argumentsList], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
      },
    });

    assert.equal(result.status, 2, argumentsList.join(" "));
    assert.match(result.stderr, /--confirm-local-reset/);
    assert.doesNotMatch(result.stdout + result.stderr, /resetting local database/i);
  }
});

test("Kong HostPort validation accepts dual-stack duplicates only", () => {
  const cases = [
    ["single binding", "binding:54321\n", 0],
    ["dual-stack bindings", "binding:54321\nbinding:54321\n", 0],
    ["mixed bindings", "binding:54321\nbinding:54322\n", 1],
    ["wrong binding", "binding:54322\n", 1],
    ["missing binding", "", 1],
    ["blank first binding", "binding:\nbinding:54321\n", 1],
    [
      "blank interior binding",
      "binding:54321\nbinding:\nbinding:54321\n",
      1,
    ],
    ["blank trailing binding", "binding:54321\nbinding:\n", 1],
  ];

  for (const [label, bindings, expectedStatus] of cases) {
    const result = spawnSync("bash", [rehearsalPath, "54321", bindings], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
        FOU802_KONG_PORT_BINDING_SELF_TEST: "1",
      },
    });

    assert.equal(result.status, expectedStatus, `${label}: ${result.stderr}`);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /resetting local database|docker|supabase/i,
      label,
    );
  }
});

test("unsafe Docker endpoints fail before reset or Docker mutation", () => {
  const endpointCases = [
    ["SSH", "ssh://review.invalid"],
    ["TCP", "tcp://127.0.0.1:2375"],
    ["HTTP", "http://127.0.0.1:2375"],
    ["HTTPS", "https://127.0.0.1:2376"],
    ["named pipe", "npipe:////./pipe/docker_engine"],
    ["relative Unix", "unix://relative.sock"],
    ["missing Unix", "missing"],
    [
      "remote selected context through the pnpm argument contract",
      "context",
      ["--", "--confirm-local-reset"],
    ],
  ];

  for (const [label, endpointKind, confirmationArguments] of endpointCases) {
    const fakeRoot = mkdtempSync(path.join(tmpdir(), "fou802-endpoint-test."));
    const fakeDocker = path.join(fakeRoot, "docker");
    const fakeSupabase = path.join(fakeRoot, "supabase");
    const dockerLog = path.join(fakeRoot, "docker.log");
    const supabaseLog = path.join(fakeRoot, "supabase.log");
    writeFileSync(dockerLog, "");
    writeFileSync(supabaseLog, "");
    writeFileSync(
      fakeDocker,
      `#!/bin/bash
set -eu
printf '%s\\n' "$*" >> "$FOU802_DOCKER_LOG"
if [[ "$1" != "context" || "$2" != "inspect" ]]; then
  printf 'MUTATION:%s\\n' "$*" >> "$FOU802_DOCKER_LOG"
  exit 97
fi
if [[ -n "$DOCKER_HOST" ]]; then
  printf '%s\\n' "$DOCKER_HOST"
else
  printf '%s\\n' "$FOU802_FAKE_CONTEXT_ENDPOINT"
fi
`,
      { mode: 0o755 },
    );
    writeFileSync(
      fakeSupabase,
      `#!/bin/bash
printf '%s\\n' "$*" >> "$FOU802_SUPABASE_LOG"
exit 97
`,
      { mode: 0o755 },
    );

    const dockerHost = endpointKind === "missing"
      ? `unix://${path.join(fakeRoot, "missing.sock")}`
      : endpointKind === "context"
        ? ""
        : endpointKind;
    const contextEndpoint = endpointKind === "context"
      ? "ssh://context.invalid"
      : "unix:///should-not-be-selected.sock";
    try {
      const result = spawnSync(
        "bash",
        [
          rehearsalPath,
          ...(confirmationArguments || ["--confirm-local-reset"]),
        ],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
          env: {
            PATH: "/usr/bin:/bin",
            TMPDIR: fakeRoot,
            DOCKER_BIN: fakeDocker,
            DOCKER_HOST: dockerHost,
            DOCKER_CONTEXT: endpointKind === "context" ? "remote-review" : "",
            FOU802_DOCKER_LOG: dockerLog,
            FOU802_FAKE_CONTEXT_ENDPOINT: contextEndpoint,
            FOU802_SUPABASE_LOG: supabaseLog,
            SUPABASE_CLI_BIN: fakeSupabase,
          },
        },
      );

      assert.equal(result.status, 1, `${label}: ${result.stderr}`);
      assert.match(result.stderr, /effective Docker endpoint/, label);
      assert.doesNotMatch(result.stderr, /Re-run with --confirm-local-reset/, label);
      assert.deepEqual(
        readFileSync(dockerLog, "utf8").trim().split("\n"),
        ["context inspect --format {{.Endpoints.docker.Host}}"],
        label,
      );
      assert.equal(readFileSync(supabaseLog, "utf8"), "", label);
      assert.equal(
        existsSync(path.join(fakeRoot, "fou802-77-dominion-challenge.lock")),
        false,
        label,
      );
      assert.doesNotMatch(
        result.stdout + result.stderr,
        /resetting local database|MUTATION:/i,
        label,
      );
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  }
});

test("the rehearsal is pinned, local-only, one-shot, and self-cleaning", async () => {
  const source = await readFile(rehearsalPath, "utf8");
  const cleanupSource = await readFile(cleanupOrchestratorPath, "utf8");
  const implementation = `${source}\n${cleanupSource}`;

  const gateOffset = source.indexOf('"--confirm-local-reset"');
  const endpointGuardOffset = source.indexOf(
    "context inspect --format '{{.Endpoints.docker.Host}}'",
  );
  const firstContainerInspection = source.indexOf(
    'assert_local_container "$database_container"',
  );
  const resetOffset = source.indexOf('bash "$script_directory/reset-local-database.sh"');
  const lockOffset = source.indexOf('mkdir "$lock_directory"');
  assert.ok(
    gateOffset >= 0
      && endpointGuardOffset > gateOffset
      && firstContainerInspection > endpointGuardOffset
      && lockOffset > endpointGuardOffset
      && resetOffset > lockOffset,
  );
  assert.match(source, /unix:\/\/\/\*[\s\S]*\[\[ -S "\$docker_socket_path" \]\]/);
  assert.match(
    source,
    /export DOCKER_HOST="\$effective_docker_endpoint"[\s\S]*unset DOCKER_CONTEXT/,
  );
  assert.match(
    source,
    /while IFS= read -r binding_record; do[\s\S]*binding:\$\{expected_port\}[\s\S]*binding_count > 0/,
  );
  assert.match(source, /binding_records="\$\("\$@"\)"/);
  assert.match(source, /printf "binding:%s\\n" \.HostPort/);
  assert.equal(
    source.match(/^assert_kong_api_port_bindings$/gm)?.length,
    2,
  );
  assert.match(source, /--database-only-runtime-check/);
  assert.match(source, /project_id="77-dominion-challenge"/);
  assert.match(source, /http:\/\/127\.0\.0\.1:54321/);
  assert.match(
    source,
    /container_api_origin="http:\/\/\$\{kong_container\}:8000"/,
  );
  assert.match(source, /edge-runtime:v1\.74\.2/);
  assert.match(source, /postgrest:v14\.14/);
  assert.match(source, /rest_container="supabase_rest_/);
  assert.match(source, /NetworkSettings\.Ports "8000\/tcp"/);
  assert.match(source, /--pull=never/);
  assert.match(source, /--network "\$network_name"/);
  assert.match(source, /--network-alias "\$runtime_alias"/);
  assert.match(source, /--read-only/);
  assert.match(source, /create extension pg_cron/i);
  assert.match(source, /cron_extension_state="unknown"/);
  assert.match(source, /cron_installed_by_rehearsal=false/);
  assert.match(source, /pg_cron_installed_by_rehearsal boolean not null/);
  assert.match(source, /cron\.schedule\(/);
  assert.match(source, /net\.http_post\(/);
  assert.match(source, /cron\.job_run_details/);
  assert.match(implementation, /and end_time is null/);
  assert.doesNotMatch(implementation, /status in \('starting', 'running'\)/);
  assert.match(cleanupSource, /quiet_observations/);
  assert.match(cleanupSource, /net\.http_request_queue/);
  assert.match(source, /rehearsal\.worker_secret/);
  assert.match(source, /and rehearsal\.invoked_at is null/);
  assert.match(source, /return_message = 'UPDATE 1'/);
  assert.match(source, /wrong_identity/);
  assert.match(source, /account_erasure/);
  assert.match(source, /aggregate health entered an alerting state/);
  assert.match(source, /body := '\{\\"mode\\":\\"health\\"\}'::jsonb/);
  assert.match(source, /health ->> 'oldestReadyAt' is null/);
  assert.match(source, /response_created_at is null/);
  assert.match(source, /interval '15 minutes'/);
  assert.match(source, /readiness_request_id bigint/);
  assert.match(source, /worker_request_id bigint/);
  assert.match(source, /health_request_id bigint/);
  assert.match(source, /cleanup_request_id bigint/);
  assert.match(cleanupSource, /object_row\.bucket_id = 'profile-photos'/);
  assert.match(cleanupSource, /object_row\.name = fixture\.storage_path/);
  assert.match(cleanupSource, /--json "\{\\"prefixes\\"/);
  assert.match(cleanupSource, /claim_profile_photo_cleanup_service\(100\)/);
  assert.match(cleanupSource, /verify_profile_photo_cleanup_service/);
  assert.match(cleanupSource, /fixture_objects_cleanup_complete/);
  assert.match(source, /"\$curl_cli" --disable --config/);
  assert.match(source, /--noproxy '\*'/);
  assert.match(source, /--proxy ''/);
  assert.match(source, /--proto '=http'/);
  assert.match(source, /--proto-redir '=http'/);
  assert.match(source, /--max-redirs 0/);
  assert.match(source, /printf 'http_proxy=\\n'/);
  assert.match(source, /printf 'HTTP_PROXY=\\n'/);
  assert.match(source, /assert_pg_net_alias_bypasses_proxy/);
  assert.match(source, /grep -Fq -- "\$sensitive_value" "\$stdout_capture"/);
  assert.match(source, /grep -Fq -- "\$sensitive_value" "\$stderr_capture"/);
  assert.match(source, /for sensitive_value in "\$worker_secret" "\$service_role_key"/);
  assert.match(source, /mkdir "\$lock_directory"/);
  assert.ok(lockOffset < resetOffset);
  assert.match(cleanupSource, /docker_command rm --force "\$runtime_container"/);
  assert.match(source, /source "\$cleanup_orchestrator"/);
  assert.doesNotMatch(source, /remove_exact_runtime_container\(\)/);
  assert.doesNotMatch(source, /runtime_started=/);
  assert.doesNotMatch(source, /fixtures_created=/);
  assert.doesNotMatch(source, /cron_was_installed=/);
  assert.doesNotMatch(source, /insert into \$secret_table[^;]*\$worker_secret/is);
  assert.doesNotMatch(source, /set -e\n\}/);
  assert.doesNotMatch(source, /supabase\s+functions\s+serve/);
  assert.doesNotMatch(source, /supabase\s+(?:link|db push)/);
  assert.doesNotMatch(source, /docker_cli" volume (?:rm|prune)/);
  assert.doesNotMatch(source, /rm\s+-rf\s+[^\n]*docker\/volumes/);
});

test("every cleanup fault checkpoint executes before destructive test work", async () => {
  const source = await readFile(rehearsalPath, "utf8");
  for (const phase of faultPhases) {
    const result = spawnSync("bash", [rehearsalPath, phase], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
        FOU802_REHEARSAL_FAULT_SELF_TEST: "1",
      },
    });
    assert.equal(result.status, 86, `${phase}: ${result.stderr}`);
    assert.match(result.stderr, new RegExp(`after ${phase}\\.`));
    assert.match(source, new RegExp(`maybe_inject_fault ${phase}(?:\\n|$)`));
  }
});

test("every fault phase executes the production cleanup behind fake boundaries", () => {
  assert.doesNotMatch(fakeCleanupHarness, /remove_exact_runtime_container\(\)/);
  assert.doesNotMatch(fakeCleanupHarness, /recover_and_remove_fixture_objects\(\)/);
  assert.doesNotMatch(fakeCleanupHarness, /remove_fixture_database_state\(\)/);
  for (const phase of faultPhases) {
    const result = runFakeCleanup(phase);
    assert.equal(result.status, 0, `${phase}: ${result.stderr}`);
    assert.doesNotMatch(result.stdout, /unknown:(?:query|exec|docker)/);
    assert.match(result.stdout, new RegExp(`phase:${phase} state:${phaseStates[phase]}`));
    assert.match(result.stdout, /database:drop tracking inventory/);
    assert.match(result.stdout, /temporary:rm -rf \/tmp\/fou802-fake-artifacts/);
    assert.match(result.stdout, /lock:rm owner/);
    assert.match(result.stdout, /lock:rmdir/);

    const hasRuntime = faultPhases.indexOf(phase) >= faultPhases.indexOf("runtime_created");
    const hasFixtures = faultPhases.indexOf(phase) >= faultPhases.indexOf("fixtures_ready");
    const hasObjects = faultPhases.indexOf(phase) >= faultPhases.indexOf("first_upload_stored");
    const hasRequests = faultPhases.indexOf(phase) >= faultPhases.indexOf("readiness_queued");
    const hasCronId = faultPhases.indexOf(phase) >= faultPhases.indexOf("cron_scheduled");
    if (hasRuntime) {
      assert.match(result.stdout, /runtime:docker rm --force/);
      assert.doesNotMatch(result.stdout, /runtime:docker ps exact-name absence proof/);
    } else {
      assert.match(result.stdout, /runtime:docker ps exact-name absence proof/);
      assert.doesNotMatch(result.stdout, /runtime:docker rm --force/);
    }
    if (hasFixtures) assert.match(result.stdout, /storage:claim and verify live service authorization/);
    else assert.doesNotMatch(result.stdout, /storage:claim and verify live service authorization/);
    if (hasObjects) {
      const expectedDeletes = phase === "first_upload_stored"
        ? 1
        : faultPhases.indexOf(phase) >= faultPhases.indexOf("worker_completed")
          ? 3
          : 4;
      assert.match(result.stdout, /storage:DELETE JSON/);
      assert.match(
        result.stdout,
        new RegExp(`deletes=${expectedDeletes} expected_deletes=${expectedDeletes}`),
      );
    } else {
      assert.doesNotMatch(result.stdout, /storage:DELETE JSON/);
      assert.match(result.stdout, /deletes=0 expected_deletes=0/);
    }
    if (hasRequests) assert.match(result.stdout, /pgnet:delete net\._http_response/);
    else assert.doesNotMatch(result.stdout, /pgnet:delete net\._http_response/);
    if (hasCronId) assert.match(result.stdout, /cron:cron\.unschedule 42/);
    else assert.doesNotMatch(result.stdout, /cron:cron\.unschedule 42/);

    if (phase === "cleanup_queued") {
      assertIntentOrder(
        result.stdout,
        [`phase:${phase}`, ...fakeCleanupIntents, "lock:rm owner", "lock:rmdir"],
      );
    }
    assert.match(
      result.stdout,
      /cleanup:flags failed=false runtime=true cron=true pgnet=true objects=true database=true tracking=false fixture=false/,
    );
    assert.doesNotMatch(result.stdout + result.stderr, /resetting local database/i);
  }
});

test("production cleanup continues and preserves recovery inventory on boundary failures", () => {
  const continuedFailures = [
    ["docker_rm", /runtime=false/, /storage:DELETE JSON/, /tracking=true/],
    ["docker_inspect", /runtime=false/, /runtime:docker ps exact-name absence proof/, /tracking=true/],
    ["docker_absence_probe", /runtime=false/, /runtime:docker ps exact-name absence proof/, /tracking=true/],
    ["docker_label", /runtime=false/, /runtime:verify rehearsal ownership label/, /tracking=true/],
    ["cron_delete", /cron=false/, /pgnet:delete net\._http_response/, /tracking=true/],
    ["pgnet_delete", /pgnet=false/, /storage:DELETE JSON/, /tracking=true/],
    ["fixture_database", /database=false/, /temporary:rm -rf/, /tracking=true/],
    ["tracking_drop", /database=true/, /temporary:rm -rf/, /tracking=true/],
    ["temporary_remove", /failed=true/, /lock:rm owner/, /lock:rmdir/],
    ["lock_remove", /failed=true/, /lock:rmdir/, /database=true/],
    ["lock_rmdir", /failed=true/, /database=true/, /fixture=false/],
  ];
  for (const [boundary, ...evidence] of continuedFailures) {
    const result = runFakeCleanup("cleanup_queued", boundary);
    assert.equal(result.status, 0, `${boundary}: ${result.stderr}`);
    assert.doesNotMatch(result.stdout, /unknown:(?:query|exec|docker)/);
    for (const pattern of evidence) assert.match(result.stdout, pattern, boundary);
    assert.match(result.stdout, /lock:rmdir/, boundary);
    assert.match(result.stdout, /cleanup:flags failed=true/, boundary);
  }

  const unscheduleFailure = runFakeCleanup("cron_scheduled", "cron_unschedule");
  assert.equal(unscheduleFailure.status, 0, unscheduleFailure.stderr);
  assert.match(unscheduleFailure.stdout, /cron=false/);
  assert.match(unscheduleFailure.stdout, /storage:DELETE JSON/);
  assert.match(unscheduleFailure.stdout, /tracking=true/);
  assert.doesNotMatch(unscheduleFailure.stdout, /database:drop tracking inventory/);

  for (const boundary of ["authorization", "storage_delete"]) {
    const result = runFakeCleanup("cleanup_queued", boundary);
    assert.equal(result.status, 0, `${boundary}: ${result.stderr}`);
    assert.match(result.stdout, /temporary:rm -rf/);
    assert.match(result.stdout, /lock:rmdir/);
    assert.match(result.stdout, /objects=false database=false tracking=true fixture=true/);
    assert.doesNotMatch(result.stdout, /database:delete fixture lifecycle and auth rows/);
    assert.doesNotMatch(result.stdout, /database:drop tracking inventory/);
  }

  for (const boundary of ["tracking_probe", "fixture_probe", "cron_extension_probe"]) {
    const result = runFakeCleanup("cleanup_queued", boundary);
    assert.equal(result.status, 0, `${boundary}: ${result.stderr}`);
    assert.match(result.stdout, /cleanup:flags failed=true/);
    assert.match(result.stdout, /tracking=true/);
    assert.doesNotMatch(result.stdout, /database:drop tracking inventory/);
    assert.match(result.stdout, /temporary:rm -rf/);
    assert.match(result.stdout, /lock:rmdir/);
  }

  const extensionFailure = runFakeCleanup("cleanup_queued", "extension_drop");
  assert.equal(extensionFailure.status, 0, extensionFailure.stderr);
  assert.match(
    extensionFailure.stdout,
    /database:drop rehearsal-owned pg_cron before tracking inventory/,
  );
  assert.doesNotMatch(extensionFailure.stdout, /database:drop tracking inventory/);
  assert.match(extensionFailure.stdout, /tracking=true fixture=false/);

  const ownedExtension = runFakeCleanup("cleanup_queued", "owned_extension");
  assert.equal(ownedExtension.status, 0, ownedExtension.stderr);
  assertIntentOrder(ownedExtension.stdout, [
    "database:drop rehearsal-owned pg_cron before tracking inventory",
    "database:drop tracking inventory",
  ]);
  assert.match(ownedExtension.stdout, /cleanup:flags failed=false/);

  const preExistingExtension = runFakeCleanup("cleanup_queued");
  assert.equal(preExistingExtension.status, 0, preExistingExtension.stderr);
  assert.doesNotMatch(
    preExistingExtension.stdout,
    /database:drop rehearsal-owned pg_cron before tracking inventory/,
  );
});

test("the real handler import graph has one pinned local bridge boundary", async () => {
  assert.deepEqual(
    await externalImportsFromGraph(handlerPath),
    ["jsr:@supabase/supabase-js@2.110.7"],
  );
  const rehearsal = await readFile(rehearsalPath, "utf8");
  const cleanupSource = await readFile(cleanupOrchestratorPath, "utf8");
  assert.match(
    rehearsal,
    /"jsr:@supabase\/supabase-js@2\.110\.7": "\.\.\/_rehearsal\/supabase-js-bridge\.ts"/,
  );
  assert.match(rehearsal, /_shared\/supabase\.ts/);
  assert.match(rehearsal, /_shared\/http\.ts/);
  assert.doesNotMatch(rehearsal, /cp -R .*supabase\/functions\/_shared/);
  assert.match(
    cleanupSource,
    /fou802_run_cleanup_steps \\\n+    remove_exact_runtime_container \\\n+    unschedule_and_drain_rehearsal_jobs \\\n+    drain_and_delete_tracked_requests \\\n+    recover_and_remove_fixture_objects \\\n+    remove_fixture_database_state/,
  );
  assert.match(
    rehearsal,
    /fou802_run_cleanup_steps remove_temporary_artifacts release_lock/,
  );
});

test("the local client bridge cannot address a hosted origin", async () => {
  const source = await readFile(bridgePath, "utf8");

  assert.match(
    source,
    /http:\/\/supabase_kong_77-dominion-challenge:8000/,
  );
  assert.match(source, /parsed\.origin !== allowedOrigin/);
  assert.match(source, /redirect: "error"/);
  assert.match(source, /bucket !== "profile-photos"/);
  assert.doesNotMatch(source, /https:\/\//);
  assert.doesNotMatch(source, /from\s+["'](?:jsr:|npm:|https?:)/);
});

test("package, CI, reset, and runbook expose the acknowledged proof", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  const ciWorkflow = await readFile(
    path.join(repositoryRoot, ".github", "workflows", "ci.yml"),
    "utf8",
  );
  const resetHelper = await readFile(
    path.join(repositoryRoot, "scripts", "reset-local-database.sh"),
    "utf8",
  );
  const runbook = await readFile(
    path.join(repositoryRoot, "docs", "profile-photo-cleanup-runbook.md"),
    "utf8",
  );

  assert.equal(
    packageJson.scripts["rehearse:profile-photo-cleanup-cron"],
    "bash scripts/rehearse-profile-photo-cleanup-cron.sh",
  );
  assert.equal(
    packageJson.scripts["test:profile-photo-cleanup-cron"],
    "node --test scripts/profile-photo-cleanup-cron-rehearsal.test.mjs",
  );
  assert.match(packageJson.scripts["check:backend"], /test:profile-photo-cleanup-cron/);

  const cronTest = ciWorkflow.indexOf(
    "run: pnpm run test:profile-photo-cleanup-cron",
  );
  const supabaseStart = ciWorkflow.indexOf("run: pnpm run supabase:start");
  assert.ok(cronTest !== -1 && supabaseStart !== -1 && cronTest < supabaseStart);

  const stagedStop = resetHelper.indexOf(
    '"$supabase_cli" stop --workdir "$staging_root"',
  );
  const repositoryStart = resetHelper.indexOf(
    '"$supabase_cli" start "${start_arguments[@]}"',
  );
  const databaseOnlyVerify = resetHelper.indexOf(
    "runtime_check_arguments+=(--database-only)",
  );
  const runtimeVerify = resetHelper.indexOf(
    'bash "$repository_root/scripts/verify-local-supabase-runtime.sh"',
  );
  assert.ok(
    stagedStop !== -1
      && repositoryStart !== -1
      && databaseOnlyVerify !== -1
      && runtimeVerify !== -1
      && stagedStop < repositoryStart
      && repositoryStart < databaseOnlyVerify
      && databaseOnlyVerify < runtimeVerify,
  );
  assert.match(resetHelper, /start_arguments=\(--workdir "\$repository_root"\)/);
  assert.match(
    resetHelper,
    /CI:-.*true[\s\S]*--exclude inbucket[\s\S]*"\$supabase_cli" start/,
  );
  assert.equal(resetHelper.match(/--database-only(?=[)\s])/g)?.length, 1);
  assert.match(
    runbook,
    /rehearse:profile-photo-cleanup-cron -- --confirm-local-reset/,
  );
  assert.match(runbook, /never deletes a Docker volume/i);
  assert.match(runbook, /cannot address a hosted origin/i);
});
