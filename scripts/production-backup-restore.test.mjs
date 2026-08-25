import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const captureScript = path.join(scriptDirectory, "capture-production-backup.sh");
const restoreScript = path.join(
  scriptDirectory,
  "rehearse-production-backup-restore.sh",
);
const verifyScript = path.join(
  scriptDirectory,
  "verify-production-backup-evidence.sh",
);
const projectRef = "abcdefghijklmnopqrst";
const commit = "1".repeat(40);
const image = "public.ecr.aws/supabase/postgres:17.6.1.141";
const imageId = `sha256:${"2".repeat(64)}`;
const captureId = "capture-20260825";
const restoreId = "restore-20260825";
const containerId = "a".repeat(64);
const rowHash = "0".repeat(64);

async function sha256(filename) {
  return createHash("sha256").update(await readFile(filename)).digest("hex");
}

async function makeExecutable(filename, contents) {
  await writeFile(filename, contents, { mode: 0o700 });
  await chmod(filename, 0o700);
  return filename;
}

function run(script, args, fixture, extraEnv = {}) {
  return spawnSync("bash", [script, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      FAKE_BOUNDARY_LOG: fixture.log,
      FAKE_DOCKER_STATE: fixture.dockerState,
      FAKE_GIT_BRANCH: "main",
      FAKE_GIT_COMMIT: commit,
      FAKE_IMAGE_ID: imageId,
      FAKE_PROJECT_REF: projectRef,
      FAKE_CONTAINER_ID: containerId,
      GIT_BIN: fixture.git,
      NODE_BIN: process.execPath,
      ...extraEnv,
    },
  });
}

async function buildFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dominion-backup-test-"));
  const destination = path.join(root, "encrypted-volume");
  const tools = path.join(root, "tools");
  const dockerState = path.join(root, "docker-state");
  const log = path.join(root, "boundary.log");
  await mkdir(destination);
  await mkdir(tools);
  await mkdir(dockerState);

  const passphrase = path.join(root, "passphrase");
  const databaseUrl = path.join(root, "database-url");
  const accessToken = path.join(root, "access-token");
  await writeFile(passphrase, "correct horse battery staple\n", { mode: 0o600 });
  await writeFile(
    databaseUrl,
    `postgresql://postgres.${projectRef}:database-password@aws-0-us-east-1.pooler.supabase.com:5432/postgres\n`,
    { mode: 0o600 },
  );
  await writeFile(accessToken, "supabase-access-token\n", { mode: 0o600 });
  await chmod(passphrase, 0o600);
  await chmod(databaseUrl, 0o600);
  await chmod(accessToken, 0o600);

  const git = await makeExecutable(
    path.join(tools, "git"),
    `#!/usr/bin/env bash
set -eu
if [[ "\${1:-}" == "-C" ]]; then shift 2; fi
case "\${1:-}:\${2:-}" in
  rev-parse:--abbrev-ref) printf '%s\\n' "\${FAKE_GIT_BRANCH}" ;;
  rev-parse:HEAD) printf '%s\\n' "\${FAKE_GIT_COMMIT}" ;;
  status:--porcelain) [[ "\${FAKE_GIT_DIRTY:-false}" == "true" ]] && printf '%s\\n' ' M tracked' || true ;;
  *) printf 'unexpected fake git call: %s\\n' "$*" >&2; exit 64 ;;
esac
`,
  );

  const supabase = await makeExecutable(
    path.join(tools, "supabase"),
    `#!/usr/bin/env bash
set -eu
if [[ "\${1:-}" == "--version" ]]; then printf '%s\\n' '2.109.0'; exit 0; fi
[[ "\${1:-}" == "db" && "\${2:-}" == "dump" ]] || exit 64
shift 2
if [[ " $* " == *' --dry-run '* ]]; then
  printf '%s\\n' \\
    '#!/usr/bin/env bash' \\
    'pg_dump \\' \\
    '    --data-only \\' \\
    '    --exclude-schema "information_schema|pg_*|realtime|supabase_migrations" \\' \\
    '    --exclude-table "auth.schema_migrations" \\' \\
    '    --exclude-table "storage.migrations" \\' \\
    '    --schema "*" \\' \\
    '    --exclude-table \\"storage\\".\\"buckets_vectors\\" --exclude-table \\"storage\\".\\"vector_indexes\\"'
  exit 0
fi
output=''
data_only=false
schema=''
while (( $# > 0 )); do
  case "$1" in
    --file) output="$2"; shift 2 ;;
    --schema) schema="$2"; shift 2 ;;
    --db-url|--exclude) shift 2 ;;
    --data-only) data_only=true; shift ;;
    --role-only|--use-copy) shift ;;
    *) printf 'unexpected fake supabase argument: %s\\n' "$1" >&2; exit 65 ;;
  esac
done
[[ -n "$output" ]]
printf 'remote:db-dump:%s\\n' "$output" >>"$FAKE_BOUNDARY_LOG"
if [[ "$data_only" == 'true' && -z "$schema" ]]; then
  printf '%s\\n' \\
    'COPY "auth"."users" ("id") FROM stdin;' \\
    '\\.' \\
    'COPY "storage"."buckets" ("id") FROM stdin;' \\
    '\\.' >"$output"
elif [[ "$schema" == 'supabase_migrations' ]]; then
  if [[ "\${FAKE_HISTORY_DUMP_FAIL:-false}" == 'true' ]]; then exit 75; fi
  printf '%s\\n' '-- deterministic supabase_migrations SQL' >"$output"
else
  printf '%s\\n' '-- deterministic fake SQL' >"$output"
fi
`,
  );

  const volumeHook = await makeExecutable(
    path.join(tools, "volume-hook"),
    `#!/usr/bin/env bash
set -eu
destination=''; passphrase=''
while (( $# > 0 )); do
  case "$1" in
    --destination) destination="$2"; shift 2 ;;
    --passphrase-file) passphrase="$2"; shift 2 ;;
    *) exit 64 ;;
  esac
done
[[ "$(tr -d '\\r\\n' <"$passphrase")" == 'correct horse battery staple' ]]
destination="$(cd "$destination" && pwd -P)"
printf '%s\\n' 'local:encrypted-volume-verified' >>"$FAKE_BOUNDARY_LOG"
printf 'DOMINION_ENCRYPTED_VOLUME_OK=%s\\n' "$destination"
`,
  );

  const edgeHook = await makeExecutable(
    path.join(tools, "edge-hook"),
    `#!/usr/bin/env bash
set -eu
output=''; project=''
while (( $# > 0 )); do
  case "$1" in
    --supabase-cli) shift 2 ;;
    --project-ref) project="$2"; shift 2 ;;
    --output) output="$2"; shift 2 ;;
    *) exit 64 ;;
  esac
done
[[ -n "\${SUPABASE_ACCESS_TOKEN:-}" ]]
printf 'remote:edge-inventory:%s\\n' "$output" >>"$FAKE_BOUNDARY_LOG"
printf '{"schemaVersion":1,"projectRef":"%s","functions":[{"name":"checkout","slug":"checkout","status":"ACTIVE","version":1,"verifyJwt":true}]}\\n' "$project" >"$output"
`,
  );

  const storageHook = await makeExecutable(
    path.join(tools, "storage-hook"),
    `#!/usr/bin/env bash
set -eu
output=''; project=''
while (( $# > 0 )); do
  case "$1" in
    --database-url-file) [[ -s "$2" ]]; shift 2 ;;
    --project-ref) project="$2"; shift 2 ;;
    --output) output="$2"; shift 2 ;;
    *) exit 64 ;;
  esac
done
objects="\${FAKE_STORAGE_OBJECT_COUNT:-0}"
printf 'remote:storage-inventory:%s\\n' "$output" >>"$FAKE_BOUNDARY_LOG"
printf '{"schemaVersion":1,"projectRef":"%s","relations":{"storage.buckets":{"present":true,"rowCount":1},"storage.buckets_analytics":{"present":false,"rowCount":null},"storage.buckets_vectors":{"present":false,"rowCount":null},"storage.iceberg_namespaces":{"present":false,"rowCount":null},"storage.iceberg_tables":{"present":false,"rowCount":null},"storage.objects":{"present":true,"rowCount":%s},"storage.s3_multipart_uploads":{"present":true,"rowCount":0},"storage.s3_multipart_uploads_parts":{"present":true,"rowCount":0},"storage.vector_indexes":{"present":false,"rowCount":null}},"buckets":[{"id":"journal-progress","name":"journal-progress","ownerId":null,"public":false,"fileSizeLimit":null,"allowedMimeTypes":null,"type":"STANDARD"}],"applicationPolicyCount":0,"applicationPolicies":[]}\\n' "$project" "$objects" >"$output"
`,
  );

  const sourceManifestHook = await makeExecutable(
    path.join(tools, "source-manifest-hook"),
    `#!/usr/bin/env bash
set -eu
output=''
while (( $# > 0 )); do
  case "$1" in
    --database-url-file|--project-ref) shift 2 ;;
    --output) output="$2"; shift 2 ;;
    *) exit 64 ;;
  esac
done
printf 'remote:source-manifest:%s\\n' "$output" >>"$FAKE_BOUNDARY_LOG"
printf '%s\\n' '{"key":"column/public.profiles/id","kind":"column","identity":"public.profiles.id","definition":{"type":"uuid"}}' >"$output"
`,
  );

  const sourceFingerprintHook = await makeExecutable(
    path.join(tools, "source-fingerprint-hook"),
    `#!/usr/bin/env bash
set -eu
output=''
while (( $# > 0 )); do
  case "$1" in
    --database-url-file|--project-ref) shift 2 ;;
    --output) output="$2"; shift 2 ;;
    *) exit 64 ;;
  esac
done
printf 'remote:source-fingerprint:%s\\n' "$output" >>"$FAKE_BOUNDARY_LOG"
printf '%s\\n' '{"key":"data/auth.users","kind":"data-fingerprint","identity":"auth.users","definition":{"rowCount":1,"rowsSha256":"${rowHash}"}}' >"$output"
`,
  );

  const relationCountsHook = await makeExecutable(
    path.join(tools, "relation-counts-hook"),
    `#!/usr/bin/env bash
set -eu
output=''; project=''
while (( $# > 0 )); do
  case "$1" in
    --database-url-file) shift 2 ;;
    --project-ref) project="$2"; shift 2 ;;
    --output) output="$2"; shift 2 ;;
    *) exit 64 ;;
  esac
done
printf 'remote:relation-counts:%s\\n' "$output" >>"$FAKE_BOUNDARY_LOG"
printf '{"schemaVersion":1,"projectRef":"%s","schemas":["auth","private","public","storage","supabase_migrations"],"relations":[{"schema":"auth","name":"users","present":true,"rowCount":1,"rowsSha256":"${rowHash}"}],"sequences":[{"schema":"public","name":"example_seq","present":true,"lastValue":"1","isCalled":false}]}\\n' "$project" >"$output"
`,
  );

  const migrationHistoryHook = await makeExecutable(
    path.join(tools, "migration-history-hook"),
    `#!/usr/bin/env bash
set -eu
output=''; project=''
while (( $# > 0 )); do
  case "$1" in
    --database-url-file) shift 2 ;;
    --project-ref) project="$2"; shift 2 ;;
    --output) output="$2"; shift 2 ;;
    *) exit 64 ;;
  esac
done
printf 'remote:migration-history:%s\\n' "$output" >>"$FAKE_BOUNDARY_LOG"
if [[ "\${FAKE_HISTORY_PRESENT:-false}" == 'true' ]]; then
  printf '{"schemaVersion":1,"projectRef":"%s","schemaPresent":true,"tablePresent":true,"rowCount":0,"versions":[]}\\n' "$project" >"$output"
else
  printf '{"schemaVersion":1,"projectRef":"%s","schemaPresent":false,"tablePresent":false,"rowCount":null,"versions":[]}\\n' "$project" >"$output"
fi
`,
  );

  const managedApplicationDdlHook = await makeExecutable(
    path.join(tools, "managed-application-ddl-hook"),
    `#!/usr/bin/env bash
set -eu
output=''
while (( $# > 0 )); do
  case "$1" in
    --database-url-file) [[ -s "$2" ]]; shift 2 ;;
    --project-ref) [[ "$2" == "$FAKE_PROJECT_REF" ]]; shift 2 ;;
    --output) output="$2"; shift 2 ;;
    *) exit 64 ;;
  esac
done
printf 'remote:managed-application-ddl:%s\\n' "$output" >>"$FAKE_BOUNDARY_LOG"
printf '%s\\n' \\
  '-- dominion managed application DDL v1' \\
  '-- no application-owned Auth or Storage DDL in the fixture' >"$output"
`,
  );

  const docker = await makeExecutable(
    path.join(tools, "docker"),
    `#!/usr/bin/env bash
set -eu
command="\${1:-}"; shift || true
state="$FAKE_DOCKER_STATE"
case "$command" in
  image)
    [[ "\${1:-}" == 'inspect' ]]
    printf '%s\\n' "$FAKE_IMAGE_ID"
    ;;
  container)
    [[ "\${1:-}" == 'inspect' ]] || exit 64
    shift
    [[ -f "$state/present" ]] || exit 1
    if [[ "$*" == *'--format'* ]]; then
      token="$(cat "$state/token")"
      if [[ "\${FAKE_DOCKER_OWNERSHIP_MODE:-matched}" == 'mismatch' ]]; then token='changed'; fi
      printf '%s|%s|%s|true|%s|%s|%s\\n' \
        "$FAKE_CONTAINER_ID" "$FAKE_IMAGE_ID" '${image}' \
        "$(cat "$state/capture")" "$(cat "$state/restore")" "$token"
    else
      printf '%s\\n' '[]'
    fi
    ;;
  run)
    printf 'local:docker-run' >>"$FAKE_BOUNDARY_LOG"
    capture=''; restore=''; token=''
    while (( $# > 0 )); do
      printf ':%s' "$1" >>"$FAKE_BOUNDARY_LOG"
      case "$1" in
        --label)
          case "$2" in
            com.dominion.capture-id=*) capture="\${2#*=}" ;;
            com.dominion.restore-id=*) restore="\${2#*=}" ;;
            com.dominion.ownership-token=*) token="\${2#*=}" ;;
          esac
          printf ':%s' "$2" >>"$FAKE_BOUNDARY_LOG"
          shift 2
          ;;
        --name|--mount|--tmpfs|--env|--network|--pull|--log-driver)
          printf ':%s' "$2" >>"$FAKE_BOUNDARY_LOG"
          shift 2
          ;;
        --detach) shift ;;
        *) shift ;;
      esac
    done
    printf '\\n' >>"$FAKE_BOUNDARY_LOG"
    printf '%s\\n' "$capture" >"$state/capture"
    printf '%s\\n' "$restore" >"$state/restore"
    printf '%s\\n' "$token" >"$state/token"
    : >"$state/present"
    printf '%s\\n' "$FAKE_CONTAINER_ID"
    ;;
  exec)
    printf 'local:docker-exec:%s\\n' "$*" >>"$FAKE_BOUNDARY_LOG"
    if [[ "$*" == *'show server_version_num'* ]]; then printf '%s\\n' '170006'; fi
    ;;
  rm)
    printf 'local:docker-rm:%s\\n' "$*" >>"$FAKE_BOUNDARY_LOG"
    rm -f "$state/present" "$state/capture" "$state/restore" "$state/token"
    ;;
  ps)
    [[ ! -f "$state/present" ]] || printf '%s\\n' "$FAKE_CONTAINER_ID"
    ;;
  *) printf 'unexpected fake docker command: %s\\n' "$command" >&2; exit 64 ;;
esac
`,
  );

  const restoreVerificationHook = await makeExecutable(
    path.join(tools, "restore-verification-hook"),
    `#!/usr/bin/env bash
set -eu
output=''; capture=''; restore=''; database=''
while (( $# > 0 )); do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --capture-id) capture="$2"; shift 2 ;;
    --restore-id) restore="$2"; shift 2 ;;
    --database) database="$2"; shift 2 ;;
    --docker-bin|--container|--capture-directory) shift 2 ;;
    *) exit 64 ;;
  esac
done
printf 'local:restore-verification:%s\\n' "$output" >>"$FAKE_BOUNDARY_LOG"
printf '{"schemaVersion":1,"captureId":"%s","restoreId":"%s","databaseName":"%s","checks":[{"name":"managed-application-ddl","status":"pass"},{"name":"migration-history","status":"pass"},{"name":"relation-sequence-counts","status":"pass"},{"name":"roles-schema-data","status":"pass"},{"name":"source-fingerprint","status":"pass"},{"name":"source-manifest","status":"pass"}]}\\n' "$capture" "$restore" "$database" >"$output"
`,
  );

  return {
    accessToken,
    databaseUrl,
    destination,
    docker,
    dockerState,
    edgeHook,
    git,
    log,
    managedApplicationDdlHook,
    migrationHistoryHook,
    passphrase,
    relationCountsHook,
    restoreVerificationHook,
    root,
    sourceFingerprintHook,
    sourceManifestHook,
    storageHook,
    supabase,
    volumeHook,
  };
}

async function captureArguments(fixture, id = captureId) {
  return [
    "--capture-id", id,
    "--project-ref", projectRef,
    "--expected-branch", "main",
    "--expected-commit", commit,
    "--supabase-cli", fixture.supabase,
    "--supabase-cli-sha256", await sha256(fixture.supabase),
    "--database-url-file", fixture.databaseUrl,
    "--database-url-sha256", await sha256(fixture.databaseUrl),
    "--access-token-file", fixture.accessToken,
    "--access-token-sha256", await sha256(fixture.accessToken),
    "--destination", fixture.destination,
    "--passphrase-file", fixture.passphrase,
    "--passphrase-sha256", await sha256(fixture.passphrase),
    "--encrypted-volume-check-hook", fixture.volumeHook,
    "--encrypted-volume-check-hook-sha256", await sha256(fixture.volumeHook),
    "--edge-functions-inventory-hook", fixture.edgeHook,
    "--edge-functions-inventory-hook-sha256", await sha256(fixture.edgeHook),
    "--storage-inventory-hook", fixture.storageHook,
    "--storage-inventory-hook-sha256", await sha256(fixture.storageHook),
    "--source-manifest-hook", fixture.sourceManifestHook,
    "--source-manifest-hook-sha256", await sha256(fixture.sourceManifestHook),
    "--source-fingerprint-hook", fixture.sourceFingerprintHook,
    "--source-fingerprint-hook-sha256", await sha256(fixture.sourceFingerprintHook),
    "--relation-counts-hook", fixture.relationCountsHook,
    "--relation-counts-hook-sha256", await sha256(fixture.relationCountsHook),
    "--migration-history-hook", fixture.migrationHistoryHook,
    "--migration-history-hook-sha256", await sha256(fixture.migrationHistoryHook),
    "--managed-application-ddl-hook", fixture.managedApplicationDdlHook,
    "--managed-application-ddl-hook-sha256", await sha256(fixture.managedApplicationDdlHook),
    "--postgres-image", image,
    "--postgres-image-id", imageId,
    "--confirm-read-only-capture", `CAPTURE ${projectRef} ${commit}`,
  ];
}

async function restoreArguments(fixture, capture = captureId, restore = restoreId) {
  return [
    "--capture-id", capture,
    "--restore-id", restore,
    "--project-ref", projectRef,
    "--expected-branch", "main",
    "--expected-commit", commit,
    "--supabase-cli-sha256", await sha256(fixture.supabase),
    "--destination", fixture.destination,
    "--passphrase-file", fixture.passphrase,
    "--passphrase-sha256", await sha256(fixture.passphrase),
    "--encrypted-volume-check-hook", fixture.volumeHook,
    "--encrypted-volume-check-hook-sha256", await sha256(fixture.volumeHook),
    "--docker-bin", fixture.docker,
    "--docker-bin-sha256", await sha256(fixture.docker),
    "--restore-verification-hook", fixture.restoreVerificationHook,
    "--restore-verification-hook-sha256", await sha256(fixture.restoreVerificationHook),
    "--postgres-image", image,
    "--postgres-image-id", imageId,
    "--confirm-local-restore", `RESTORE ${capture} ${restore}`,
  ];
}

async function verifyArguments(fixture, capture = captureId, restore = restoreId) {
  return [
    "--destination", fixture.destination,
    "--capture-id", capture,
    "--restore-id", restore,
    "--project-ref", projectRef,
    "--expected-branch", "main",
    "--expected-commit", commit,
    "--supabase-cli", fixture.supabase,
    "--supabase-cli-sha256", await sha256(fixture.supabase),
    "--postgres-image", image,
    "--postgres-image-id", imageId,
    "--passphrase-file", fixture.passphrase,
    "--passphrase-sha256", await sha256(fixture.passphrase),
    "--encrypted-volume-check-hook", fixture.volumeHook,
    "--encrypted-volume-check-hook-sha256", await sha256(fixture.volumeHook),
  ];
}

async function successfulCapture(fixture, id = captureId) {
  const result = run(captureScript, await captureArguments(fixture, id), fixture);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function replaceArgument(args, flag, value) {
  const copy = [...args];
  const index = copy.indexOf(flag);
  assert.notEqual(index, -1, `missing test flag ${flag}`);
  copy[index + 1] = value;
  return copy;
}

test("operator shell files parse under Bash 3.2", () => {
  const result = spawnSync(
    "bash",
    ["-n", path.join(scriptDirectory, "production-backup-common.sh"), captureScript, restoreScript, verifyScript],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const version = spawnSync("bash", ["--version"], { encoding: "utf8" });
  assert.match(version.stdout, /version 3\.2\./);
});

test("capture rejects incomplete input before any remote boundary", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  const result = run(captureScript, [], fixture);
  assert.notEqual(result.status, 0);
  const log = await readFile(fixture.log, "utf8").catch(() => "");
  assert.doesNotMatch(log, /remote:/);
});

test("branch mismatch fails before destination verification or remote access", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  const result = run(
    captureScript,
    await captureArguments(fixture),
    fixture,
    { FAKE_GIT_BRANCH: "develop" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected branch main, found develop/);
  const log = await readFile(fixture.log, "utf8").catch(() => "");
  assert.equal(log, "");
});

test("exact tool, image, credential, and passphrase mismatches all fail before remote access", async (t) => {
  const cases = [
    ["CLI hash", "--supabase-cli-sha256", "f".repeat(64)],
    ["image ref", "--postgres-image", "public.ecr.aws/supabase/postgres:17.6.1.140"],
    ["database credential hash", "--database-url-sha256", "e".repeat(64)],
    ["passphrase hash", "--passphrase-sha256", "d".repeat(64)],
    ["volume hook hash", "--encrypted-volume-check-hook-sha256", "c".repeat(64)],
    ["managed DDL hook hash", "--managed-application-ddl-hook-sha256", "b".repeat(64)],
  ];
  for (const [label, flag, value] of cases) {
    await t.test(label, async (nested) => {
      const fixture = await buildFixture();
      nested.after(() => rm(fixture.root, { force: true, recursive: true }));
      const args = replaceArgument(await captureArguments(fixture), flag, value);
      const result = run(captureScript, args, fixture);
      assert.notEqual(result.status, 0);
      const log = await readFile(fixture.log, "utf8").catch(() => "");
      assert.doesNotMatch(log, /remote:/);
    });
  }
});

test("capture writes every artifact directly under the encrypted destination and verifies it", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  const result = await successfulCapture(fixture);
  const captureDirectory = path.join(fixture.destination, captureId);
  assert.deepEqual((await readdir(captureDirectory)).sort(), [
    "CAPTURE_COMPLETE.json",
    "SHA256SUMS",
    "capture.json",
    "data.sql",
    "edge-functions.json",
    "history-data.sql",
    "history-schema.sql",
    "managed-application-ddl.sql",
    "migration-history.json",
    "relation-sequence-counts.json",
    "roles.sql",
    "schema.sql",
    "source-fingerprint.jsonl",
    "source-manifest.jsonl",
    "storage-metadata.json",
  ]);
  const marker = JSON.parse(
    await readFile(path.join(captureDirectory, "CAPTURE_COMPLETE.json"), "utf8"),
  );
  assert.equal(marker.sourceManifestSha256, await sha256(path.join(captureDirectory, "source-manifest.jsonl")));
  assert.equal(marker.sourceFingerprintSha256, await sha256(path.join(captureDirectory, "source-fingerprint.jsonl")));
  assert.equal(marker.relationSequenceCountsSha256, await sha256(path.join(captureDirectory, "relation-sequence-counts.json")));
  assert.equal(marker.migrationHistorySha256, await sha256(path.join(captureDirectory, "migration-history.json")));
  assert.equal(marker.managedApplicationDdlSha256, await sha256(path.join(captureDirectory, "managed-application-ddl.sql")));
  assert.match(
    await readFile(path.join(captureDirectory, "data.sql"), "utf8"),
    /COPY "auth"\."users"[\s\S]*COPY "storage"\."buckets"/,
  );

  const log = await readFile(fixture.log, "utf8");
  assert.ok(log.indexOf("local:encrypted-volume-verified") < log.indexOf("remote:"));
  for (const line of log.split("\n").filter((entry) => entry.startsWith("remote:db-dump:"))) {
    assert.ok(line.includes(`${captureDirectory}/.`), line);
  }
  const combined = `${result.stdout}\n${result.stderr}\n${await Promise.all(
    (await readdir(captureDirectory)).map((name) => readFile(path.join(captureDirectory, name), "utf8")),
  )}`;
  assert.doesNotMatch(combined, /database-password|supabase-access-token|correct horse/);
  assert.match(result.stdout, /BACKUP_MANIFEST_SHA256=[a-f0-9]{64}/);
});

test("absent migration history uses deterministic no-op restore artifacts", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  await successfulCapture(fixture);
  const captureDirectory = path.join(fixture.destination, captureId);
  const inventory = JSON.parse(
    await readFile(path.join(captureDirectory, "migration-history.json"), "utf8"),
  );
  assert.equal(inventory.schemaPresent, false);
  assert.equal(
    await readFile(path.join(captureDirectory, "history-schema.sql"), "utf8"),
    "-- dominion migration history state: supabase_migrations schema absent\n",
  );
  assert.equal(
    await readFile(path.join(captureDirectory, "history-data.sql"), "utf8"),
    "-- dominion migration history data: supabase_migrations schema absent\n",
  );
  const log = await readFile(fixture.log, "utf8");
  assert.doesNotMatch(log, /db-dump:.*history-(schema|data)\.sql/);
});

test("present empty migration history is dumped and remains distinct from absence", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  const result = run(
    captureScript,
    await captureArguments(fixture),
    fixture,
    { FAKE_HISTORY_PRESENT: "true" },
  );
  assert.equal(result.status, 0, result.stderr);
  const captureDirectory = path.join(fixture.destination, captureId);
  const inventory = JSON.parse(
    await readFile(path.join(captureDirectory, "migration-history.json"), "utf8"),
  );
  assert.equal(inventory.schemaPresent, true);
  assert.equal(inventory.tablePresent, true);
  assert.equal(inventory.rowCount, 0);
  assert.match(
    await readFile(path.join(captureDirectory, "history-schema.sql"), "utf8"),
    /supabase_migrations/,
  );
  const log = await readFile(fixture.log, "utf8");
  assert.match(log, /db-dump:.*history-schema\.sql\.partial/);
  assert.match(log, /db-dump:.*history-data\.sql\.partial/);
});

test("a present migration-history dump failure is never reinterpreted as absence", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  const result = run(
    captureScript,
    await captureArguments(fixture),
    fixture,
    { FAKE_HISTORY_DUMP_FAIL: "true", FAKE_HISTORY_PRESENT: "true" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /history-schema\.sql failed/);
  const captureDirectory = path.join(fixture.destination, captureId);
  assert.equal(
    (await readFile(path.join(captureDirectory, "CAPTURE_INCOMPLETE"), "utf8")).trim(),
    "capture did not complete",
  );
  await assert.rejects(stat(path.join(captureDirectory, "CAPTURE_COMPLETE.json")));
  await assert.rejects(stat(path.join(captureDirectory, "history-schema.sql")));
  await assert.rejects(stat(path.join(captureDirectory, "history-data.sql")));
});

test("nonzero Storage objects stop before database dumps", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  const result = run(
    captureScript,
    await captureArguments(fixture),
    fixture,
    { FAKE_STORAGE_OBJECT_COUNT: "1" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /export Storage blobs through the Storage API/);
  const log = await readFile(fixture.log, "utf8");
  assert.doesNotMatch(log, /remote:db-dump:/);
  assert.equal(
    (await readFile(path.join(fixture.destination, captureId, "CAPTURE_INCOMPLETE"), "utf8")).trim(),
    "capture did not complete",
  );
});

test("restore verifies the manifest before touching Docker", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  await successfulCapture(fixture);
  await writeFile(path.join(fixture.destination, captureId, "schema.sql"), "tampered\n");
  await writeFile(fixture.log, "");
  const result = run(restoreScript, await restoreArguments(fixture), fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SHA-256 mismatch for schema\.sql/);
  assert.equal(await readFile(fixture.log, "utf8"), "local:encrypted-volume-verified\n");
});

test("restore uses a unique no-network exact-image tmpfs container and records verified cleanup", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  await successfulCapture(fixture);
  const result = run(restoreScript, await restoreArguments(fixture), fixture);
  assert.equal(result.status, 0, result.stderr);
  const log = await readFile(fixture.log, "utf8");
  assert.match(log, /local:docker-run:[^\n]*:--pull:never/);
  assert.match(log, /local:docker-run:[^\n]*:--network:none/);
  assert.match(log, /local:docker-run:[^\n]*:--log-driver:none/);
  assert.match(log, /target=\/dominion-backup,readonly/);
  assert.match(log, /\/var\/lib\/postgresql\/data:rw,nosuid,nodev/);
  assert.match(log, /local:docker-rm:--force dominion-restore-restore-20260825/);
  assert.match(log, /--file \/dominion-backup\/managed-application-ddl\.sql/);
  await assert.rejects(stat(path.join(fixture.dockerState, "present")));

  const evidence = path.join(
    fixture.destination,
    `restore-${captureId}-${restoreId}`,
  );
  assert.deepEqual((await readdir(evidence)).sort(), [
    "RESTORE_COMPLETE.json",
    "SHA256SUMS",
    "restore-verification.json",
    "restore.json",
  ]);
  const metadata = JSON.parse(await readFile(path.join(evidence, "restore.json"), "utf8"));
  assert.equal(metadata.postgres.serverVersionNum, 170006);
  assert.equal(metadata.cleanupOwnershipVerified, true);
  assert.equal(metadata.containerRemoved, true);
});

test("ownership mismatch refuses destructive container cleanup", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  await successfulCapture(fixture);
  const result = run(
    restoreScript,
    await restoreArguments(fixture),
    fixture,
    { FAKE_DOCKER_OWNERSHIP_MODE: "mismatch" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing an unverified container left by the create attempt/);
  const log = await readFile(fixture.log, "utf8");
  assert.doesNotMatch(log, /local:docker-rm:/);
  await stat(path.join(fixture.dockerState, "present"));
});

test("standalone verifier emits stable evidence identities without Docker access", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  await successfulCapture(fixture);
  const restore = run(restoreScript, await restoreArguments(fixture), fixture);
  assert.equal(restore.status, 0, restore.stderr);
  await writeFile(fixture.log, "");
  const result = run(verifyScript, await verifyArguments(fixture), fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^BACKUP_MANIFEST_SHA256=[a-f0-9]{64}$/m);
  assert.match(result.stdout, /^RESTORE_EVIDENCE_MANIFEST_SHA256=[a-f0-9]{64}$/m);
  assert.match(result.stdout, /^SOURCE_MANIFEST_SHA256=[a-f0-9]{64}$/m);
  assert.match(result.stdout, /^SOURCE_FINGERPRINT_SHA256=[a-f0-9]{64}$/m);
  assert.match(result.stdout, /^RELATION_SEQUENCE_COUNTS_SHA256=[a-f0-9]{64}$/m);
  assert.match(result.stdout, /^MIGRATION_HISTORY_SHA256=[a-f0-9]{64}$/m);
  assert.match(result.stdout, /^MANAGED_APPLICATION_DDL_SHA256=[a-f0-9]{64}$/m);
  assert.match(result.stdout, /^MIGRATION_HISTORY_STATE=absent$/m);
  assert.match(result.stdout, new RegExp(`^SUPABASE_CLI_SHA256=${await sha256(fixture.supabase)}$`, "m"));
  assert.match(result.stdout, new RegExp(`^POSTGRES_IMAGE_ID=${imageId}$`, "m"));
  assert.match(result.stdout, /^CAPTURED_AT=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m);
  assert.doesNotMatch(await readFile(fixture.log, "utf8"), /docker/);
});

test("package commands expose capture, restore, verification, and fake-boundary tests", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  assert.equal(
    packageJson.scripts["capture:production-backup"],
    "bash scripts/capture-production-backup.sh",
  );
  assert.equal(
    packageJson.scripts["rehearse:production-backup-restore"],
    "bash scripts/rehearse-production-backup-restore.sh",
  );
  assert.equal(
    packageJson.scripts["verify:production-backup-evidence"],
    "bash scripts/verify-production-backup-evidence.sh",
  );
  assert.equal(
    packageJson.scripts["test:production-backup-restore"],
    "node --test scripts/production-backup-restore.test.mjs",
  );
});
