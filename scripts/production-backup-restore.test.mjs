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
  symlink,
  unlink,
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
const credentialValidator = path.join(
  scriptDirectory,
  "validate-postgres-credentials.mjs",
);
const dumpScriptTransformer = path.join(
  scriptDirectory,
  "prepare-supabase-dump-script.mjs",
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
  const environment = {
    ...process.env,
    FAKE_BOUNDARY_LOG: fixture.log,
    FAKE_DOCKER_STATE: fixture.dockerState,
    FAKE_GIT_BRANCH: "main",
    FAKE_GIT_COMMIT: commit,
    FAKE_IMAGE_ID: imageId,
    FAKE_PROJECT_REF: projectRef,
    FAKE_CONTAINER_ID: containerId,
    PATH: `${path.dirname(fixture.git)}:${process.env.PATH}`,
    ...extraEnv,
  };
  for (const name of [
    "DATABASE_URL", "PGAPPNAME", "PGCHANNELBINDING", "PGCLIENTENCODING",
    "PGCONNECT_TIMEOUT", "PGDATABASE", "PGHOST", "PGHOSTADDR", "PGOPTIONS",
    "PGPASSFILE", "PGPASSWORD", "PGPORT", "PGREQUIRESSL", "PGSERVICE",
    "PGSERVICEFILE", "PGSSLCERT", "PGSSLCRL", "PGSSLCRLDIR", "PGSSLKEY",
    "PGSSLMODE", "PGSSLROOTCERT", "PGTARGETSESSIONATTRS", "PGTZ", "PGUSER",
    "POSTGRES_PASSWORD", "SUPABASE_ACCESS_TOKEN", "SUPABASE_DB_PASSWORD",
    "BASH_ENV", "CDPATH", "DOCKER_CERT_PATH", "DOCKER_CONFIG", "DOCKER_CONTEXT",
    "DOCKER_HOST", "DOCKER_TLS_VERIFY", "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH", "ENV", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CEILING_DIRECTORIES", "GIT_CONFIG_COUNT", "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_SYSTEM", "GIT_DIR", "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY", "GIT_WORK_TREE", "LD_LIBRARY_PATH", "LD_PRELOAD",
    "NODE_OPTIONS", "NODE_PATH",
  ]) {
    if (!Object.hasOwn(extraEnv, name)) delete environment[name];
  }
  return spawnSync("bash", [script, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: environment,
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
  const databasePassfile = path.join(root, "database-passfile");
  const accessToken = path.join(root, "access-token");
  await writeFile(passphrase, "correct horse battery staple\n", { mode: 0o600 });
  await writeFile(
    databaseUrl,
    `postgresql://postgres.${projectRef}@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require\n`,
    { mode: 0o600 },
  );
  await writeFile(
    databasePassfile,
    `aws-0-us-east-1.pooler.supabase.com:5432:postgres:postgres.${projectRef}:database-password\n`,
    { mode: 0o600 },
  );
  await writeFile(accessToken, "supabase-access-token\n", { mode: 0o600 });
  await chmod(passphrase, 0o600);
  await chmod(databaseUrl, 0o600);
  await chmod(databasePassfile, 0o600);
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
boundary_log="\${FAKE_BOUNDARY_LOG:-${log}}"
if [[ "\${1:-}" == "--version" ]]; then printf '%s\\n' '2.109.0'; exit 0; fi
[[ "\${1:-}" == "db" && "\${2:-}" == "dump" ]] || exit 64
shift 2
printf 'local:supabase-argv:%s\n' "$*" >>"$boundary_log"
[[ -z "\${PGPASSWORD:-}" && -z "\${PGPASSFILE:-}" ]]
[[ "$*" != *'database-password'* ]]
if [[ " $* " == *' --dry-run '* ]]; then
  printf '%s\\n' \\
    '#!/usr/bin/env bash' \\
    'set -euo pipefail' \\
    '' \\
    'export PGHOST="aws-0-us-east-1.pooler.supabase.com"' \\
    'export PGPORT="5432"' \\
    'export PGUSER="postgres.${projectRef}"' \\
    'export PGPASSWORD=""' \\
    'export PGDATABASE="postgres"' \\
    '' \\
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
printf 'remote:db-dump:%s\\n' "$output" >>"$boundary_log"
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
output=''; project=''; access_token_file=''
printf 'remote:edge-argv:%s\\n' "$*" >>"$FAKE_BOUNDARY_LOG"
while (( $# > 0 )); do
  case "$1" in
    --supabase-cli) shift 2 ;;
    --access-token-file) access_token_file="$2"; shift 2 ;;
    --project-ref) project="$2"; shift 2 ;;
    --output) output="$2"; shift 2 ;;
    *) exit 64 ;;
  esac
done
[[ -z "\${SUPABASE_ACCESS_TOKEN:-}" ]]
[[ "$(tr -d '\\r\\n' <"$access_token_file")" == 'supabase-access-token' ]]
printf 'remote:edge-inventory:%s\\n' "$output" >>"$FAKE_BOUNDARY_LOG"
printf '{"schemaVersion":1,"projectRef":"%s","functions":[{"name":"checkout","slug":"checkout","status":"ACTIVE","version":1,"verifyJwt":true}]}\\n' "$project" >"$output"
`,
  );

  const storageHook = await makeExecutable(
    path.join(tools, "storage-hook"),
    `#!/usr/bin/env bash
set -eu
output=''; project=''; passfile=''
while (( $# > 0 )); do
  case "$1" in
    --database-client-contract) [[ "$2" == 'exact-docker-pgpass/v1' ]]; shift 2 ;;
    --database-url-file) [[ -s "$2" ]]; shift 2 ;;
    --database-passfile) [[ -s "$2" ]]; passfile="$2"; shift 2 ;;
    --project-ref) project="$2"; shift 2 ;;
    --docker-bin|--postgres-image|--postgres-image-id) shift 2 ;;
    --output) output="$2"; shift 2 ;;
    *) exit 64 ;;
  esac
done
objects="\${FAKE_STORAGE_OBJECT_COUNT:-0}"
vectors="\${FAKE_STORAGE_VECTOR_COUNT:-0}"
vectors_present="\${FAKE_STORAGE_VECTOR_PRESENT:-true}"
vectors_row_count="$vectors"
if [[ "$vectors_present" == 'false' ]]; then vectors_row_count='null'; fi
printf 'remote:storage-inventory:%s\\n' "$output" >>"$FAKE_BOUNDARY_LOG"
printf '{"schemaVersion":1,"projectRef":"%s","relations":{"storage.buckets":{"present":true,"rowCount":1},"storage.buckets_analytics":{"present":true,"rowCount":0},"storage.buckets_vectors":{"present":%s,"rowCount":%s},"storage.iceberg_namespaces":{"present":false,"rowCount":null},"storage.iceberg_tables":{"present":false,"rowCount":null},"storage.objects":{"present":true,"rowCount":%s},"storage.s3_multipart_uploads":{"present":true,"rowCount":0},"storage.s3_multipart_uploads_parts":{"present":true,"rowCount":0},"storage.vector_indexes":{"present":true,"rowCount":%s}},"buckets":[{"id":"journal-progress","name":"journal-progress","ownerId":null,"public":false,"fileSizeLimit":null,"allowedMimeTypes":null,"type":"STANDARD"}],"applicationPolicyCount":0,"applicationPolicies":[]}\\n' "$project" "$vectors_present" "$vectors_row_count" "$objects" "$vectors" >"$output"
if [[ "\${FAKE_SWAP_DATABASE_PASSFILE:-false}" == 'true' ]]; then
  printf '%s\\n' 'swapped:5432:postgres:postgres:changed' >"$passfile"
  chmod 600 "$passfile"
fi
`,
  );

  const sourceManifestHook = await makeExecutable(
    path.join(tools, "source-manifest-hook"),
    `#!/usr/bin/env bash
set -eu
output=''
while (( $# > 0 )); do
  case "$1" in
    --database-client-contract) [[ "$2" == 'exact-docker-pgpass/v1' ]]; shift 2 ;;
    --database-url-file|--database-passfile|--project-ref) shift 2 ;;
    --docker-bin|--postgres-image|--postgres-image-id) shift 2 ;;
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
    --database-client-contract) [[ "$2" == 'exact-docker-pgpass/v1' ]]; shift 2 ;;
    --database-url-file|--database-passfile|--project-ref) shift 2 ;;
    --docker-bin|--postgres-image|--postgres-image-id) shift 2 ;;
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
    --database-client-contract) [[ "$2" == 'exact-docker-pgpass/v1' ]]; shift 2 ;;
    --database-url-file|--database-passfile) shift 2 ;;
    --docker-bin|--postgres-image|--postgres-image-id) shift 2 ;;
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
    --database-client-contract) [[ "$2" == 'exact-docker-pgpass/v1' ]]; shift 2 ;;
    --database-url-file|--database-passfile) shift 2 ;;
    --docker-bin|--postgres-image|--postgres-image-id) shift 2 ;;
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
    --database-client-contract) [[ "$2" == 'exact-docker-pgpass/v1' ]]; shift 2 ;;
    --database-url-file|--database-passfile) [[ -s "$2" ]]; shift 2 ;;
    --docker-bin|--postgres-image|--postgres-image-id) shift 2 ;;
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
  context)
    [[ "\${1:-}" == 'inspect' ]]
    printf '%s\\n' "\${FAKE_DOCKER_ENDPOINT:-unix:///var/run/docker.sock}"
    ;;
  image)
    [[ "\${1:-}" == 'inspect' ]]
    printf '%s\\n' "$FAKE_IMAGE_ID"
    ;;
  container)
    [[ "\${1:-}" == 'inspect' ]] || exit 64
    shift
    target="\${1:-}"; shift || true
    [[ -f "$state/present" ]] || exit 1
    [[ "$target" == "$FAKE_CONTAINER_ID" || "$target" == dominion-restore-* ]] || exit 66
    if [[ "$*" == *'--format'* ]]; then
      token="$(cat "$state/token")"
      if [[ "\${FAKE_DOCKER_OWNERSHIP_MODE:-matched}" == 'mismatch' ]]; then token='changed'; fi
      printf '%s|%s|%s|true|%s|%s|%s\\n' \
        "$FAKE_CONTAINER_ID" "$FAKE_IMAGE_ID" "$FAKE_IMAGE_ID" \
        "$(cat "$state/capture")" "$(cat "$state/restore")" "$token"
    else
      printf '%s\\n' '[]'
    fi
    ;;
  run)
    original_args="$*"
    [[ "$original_args" != *'database-password'* ]]
    if [[ "$original_args" == *'/dominion-dump/run.sh'* ]]; then
      printf 'remote:docker-dump:%s\\n' "$original_args" >>"$FAKE_BOUNDARY_LOG"
      [[ "$original_args" == *"$FAKE_IMAGE_ID /dominion-dump/run.sh"* ]]
      [[ "$original_args" == *'target=/dominion-private/pgpass,readonly'* ]]
      [[ "$original_args" == *'PGPASSFILE=/dominion-private/pgpass'* ]]
      dump_script=''
      for argument in "$@"; do
        case "$argument" in
          type=bind,source=*,target=/dominion-dump/run.sh,readonly)
            dump_script="\${argument#*source=}"
            dump_script="\${dump_script%%,target=*}"
            ;;
        esac
      done
      [[ -s "$dump_script" ]]
      grep -F 'unset PGPASSWORD' "$dump_script" >/dev/null
      grep -F 'export PGPASSFILE="/dominion-private/pgpass"' "$dump_script" >/dev/null
      ! grep -F 'database-password' "$dump_script" >/dev/null
      if [[ "$original_args" == *'.history-'* && "\${FAKE_HISTORY_DUMP_FAIL:-false}" == 'true' ]]; then
        exit 75
      fi
      if [[ "$original_args" == *'.data.sql.run.sh'* ]]; then
        printf '%s\\n' \\
          'COPY "auth"."users" ("id") FROM stdin;' \\
          '\\.' \\
          'COPY "storage"."buckets" ("id") FROM stdin;' \\
          '\\.'
      elif [[ "$original_args" == *'.history-'* ]]; then
        printf '%s\\n' '-- deterministic supabase_migrations SQL'
      else
        printf '%s\\n' '-- deterministic fake SQL'
      fi
      exit 0
    fi
    printf 'local:docker-run' >>"$FAKE_BOUNDARY_LOG"
    capture=''; restore=''; token=''; cidfile=''
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
        --cidfile)
          cidfile="$2"
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
    [[ -n "$cidfile" ]]
    if [[ "\${FAKE_DOCKER_SKIP_CIDFILE:-false}" != 'true' ]]; then
      printf '%s\\n' "$FAKE_CONTAINER_ID" >"$cidfile"
    fi
    if [[ "\${FAKE_DOCKER_RUN_FAIL_AFTER_CREATE:-false}" == 'true' ]]; then
      exit 75
    fi
    printf '%s\\n' "$FAKE_CONTAINER_ID"
    ;;
  exec)
    printf 'local:docker-exec:%s\\n' "$*" >>"$FAKE_BOUNDARY_LOG"
    if [[ "$*" == *'show server_version_num'* ]]; then printf '%s\\n' '170006'; fi
    ;;
  rm)
    [[ "$*" == "--force $FAKE_CONTAINER_ID" ]] || exit 67
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

  const captureTools = {
    credentialValidatorSha256: await sha256(credentialValidator),
    dockerBinSha256: await sha256(docker),
    dumpScriptTransformerSha256: await sha256(dumpScriptTransformer),
    edgeFunctionsInventoryHookSha256: await sha256(edgeHook),
    encryptedVolumeCheckHookSha256: await sha256(volumeHook),
    managedApplicationDdlHookSha256: await sha256(managedApplicationDdlHook),
    migrationHistoryHookSha256: await sha256(migrationHistoryHook),
    relationCountsHookSha256: await sha256(relationCountsHook),
    sourceFingerprintHookSha256: await sha256(sourceFingerprintHook),
    sourceManifestHookSha256: await sha256(sourceManifestHook),
    storageInventoryHookSha256: await sha256(storageHook),
    supabaseCliSha256: await sha256(supabase),
  };
  const restoreTools = {
    dockerBinSha256: await sha256(docker),
    encryptedVolumeCheckHookSha256: await sha256(volumeHook),
    restoreVerificationHookSha256: await sha256(restoreVerificationHook),
  };
  const hashObject = (value) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const approvedToolManifest = path.join(root, "approved-tool-manifest.json");
  await writeFile(
    approvedToolManifest,
    `${JSON.stringify({
      schemaVersion: 1,
      artifactContract: "dominion-production-backup-approved-tools/v1",
      releaseCommit: commit,
      captureTools,
      captureToolsetSha256: hashObject(captureTools),
      restoreTools,
      restoreToolsetSha256: hashObject(restoreTools),
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await chmod(approvedToolManifest, 0o600);

  return {
    accessToken,
    approvedToolManifest,
    databasePassfile,
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
    "--database-passfile", fixture.databasePassfile,
    "--database-passfile-sha256", await sha256(fixture.databasePassfile),
    "--credential-validator-sha256", await sha256(credentialValidator),
    "--docker-bin", fixture.docker,
    "--docker-bin-sha256", await sha256(fixture.docker),
    "--dump-script-transformer-sha256", await sha256(dumpScriptTransformer),
    "--approved-tool-manifest", fixture.approvedToolManifest,
    "--approved-tool-manifest-sha256", await sha256(fixture.approvedToolManifest),
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
    "--writer-quiesced-at", "2000-01-01T00:00:00Z",
    "--confirm-read-only-capture", `CAPTURE ${projectRef} ${commit}`,
  ];
}

async function restoreArguments(fixture, capture = captureId, restore = restoreId) {
  const captureMetadata = JSON.parse(
    await readFile(path.join(fixture.destination, capture, "capture.json"), "utf8"),
  );
  return [
    "--capture-id", capture,
    "--restore-id", restore,
    "--project-ref", projectRef,
    "--expected-branch", "main",
    "--expected-commit", commit,
    "--supabase-cli-sha256", await sha256(fixture.supabase),
    "--capture-toolset-sha256", captureMetadata.captureToolsetSha256,
    "--approved-tool-manifest", fixture.approvedToolManifest,
    "--approved-tool-manifest-sha256", await sha256(fixture.approvedToolManifest),
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
    "--credential-validator-sha256", await sha256(credentialValidator),
    "--dump-script-transformer-sha256", await sha256(dumpScriptTransformer),
    "--approved-tool-manifest", fixture.approvedToolManifest,
    "--approved-tool-manifest-sha256", await sha256(fixture.approvedToolManifest),
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
    "--passphrase-file", fixture.passphrase,
    "--passphrase-sha256", await sha256(fixture.passphrase),
    "--encrypted-volume-check-hook", fixture.volumeHook,
    "--encrypted-volume-check-hook-sha256", await sha256(fixture.volumeHook),
    "--docker-bin", fixture.docker,
    "--docker-bin-sha256", await sha256(fixture.docker),
    "--restore-verification-hook", fixture.restoreVerificationHook,
    "--restore-verification-hook-sha256", await sha256(fixture.restoreVerificationHook),
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

test("package argument separators reach all three operator parsers", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  for (const script of [captureScript, restoreScript, verifyScript]) {
    const result = run(script, ["--", "--capture-id", captureId], fixture);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /^Usage:/mu);
  }
  assert.equal(await readFile(fixture.log, "utf8").catch(() => ""), "");
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

test("capture rejects ambient database credentials before any tool boundary", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  const result = run(
    captureScript,
    await captureArguments(fixture),
    fixture,
    { PGPASSWORD: "ambient-secret" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unset ambient PGPASSWORD/);
  assert.equal(await readFile(fixture.log, "utf8").catch(() => ""), "");
});

test("capture rejects ambient runtime injection before Node or Git", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  const result = run(
    captureScript,
    await captureArguments(fixture),
    fixture,
    { NODE_OPTIONS: "--require=/definitely-not-loaded.js" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unset ambient NODE_OPTIONS/);
  assert.equal(await readFile(fixture.log, "utf8").catch(() => ""), "");
});

test("capture rejects a remote Docker context before image or hosted access", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  const result = run(
    captureScript,
    await captureArguments(fixture),
    fixture,
    { FAKE_DOCKER_ENDPOINT: "ssh://remote-builder" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /local unix-socket context/);
  assert.doesNotMatch(await readFile(fixture.log, "utf8"), /remote:/);
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

test("credential scope rejects argv passwords and noncanonical pgpass escapes before remote access", async (t) => {
  for (const mode of ["url-password", "noncanonical-pgpass"]) {
    await t.test(mode, async (nested) => {
      const fixture = await buildFixture();
      nested.after(() => rm(fixture.root, { force: true, recursive: true }));
      if (mode === "url-password") {
        await writeFile(
          fixture.databaseUrl,
          `postgresql://postgres.${projectRef}:database-password@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require\n`,
          { mode: 0o600 },
        );
      } else {
        await writeFile(
          fixture.databasePassfile,
          `aws-0-us-east-1.pooler.supabase.com:5432:postgres:postgres.${projectRef}:bad\\q\n`,
          { mode: 0o600 },
        );
      }
      const result = run(captureScript, await captureArguments(fixture), fixture);
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        mode === "url-password" ? /must not contain a password/ : /noncanonical escape/,
      );
      assert.doesNotMatch(await readFile(fixture.log, "utf8").catch(() => ""), /remote:/);
    });
  }
});

test("credential files fail closed on wrong scope, wildcard, duplicate, permissions, and symlink", async (t) => {
  const cases = [
    ["wrong project scope", async (fixture) => {
      await writeFile(
        fixture.databaseUrl,
        "postgresql://postgres.wrongprojectref0000@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require\n",
        { mode: 0o600 },
      );
    }],
    ["mismatched passfile", async (fixture) => {
      await writeFile(
        fixture.databasePassfile,
        `other.pooler.supabase.com:5432:postgres:postgres.${projectRef}:fixture\n`,
        { mode: 0o600 },
      );
    }],
    ["wildcard passfile", async (fixture) => {
      await writeFile(fixture.databasePassfile, "*:5432:postgres:postgres:fixture\n", { mode: 0o600 });
    }],
    ["multiple passfile rows", async (fixture) => {
      const row = `aws-0-us-east-1.pooler.supabase.com:5432:postgres:postgres.${projectRef}:fixture`;
      await writeFile(fixture.databasePassfile, `${row}\n${row}\n`, { mode: 0o600 });
    }],
    ["bad permissions", async (fixture) => chmod(fixture.databasePassfile, 0o644)],
    ["symlink", async (fixture) => {
      const target = `${fixture.databasePassfile}.target`;
      await writeFile(target, await readFile(fixture.databasePassfile), { mode: 0o600 });
      await unlink(fixture.databasePassfile);
      await symlink(target, fixture.databasePassfile);
    }],
  ];
  for (const [label, mutate] of cases) {
    await t.test(label, async (nested) => {
      const fixture = await buildFixture();
      nested.after(() => rm(fixture.root, { force: true, recursive: true }));
      await mutate(fixture);
      const result = run(captureScript, await captureArguments(fixture), fixture);
      assert.notEqual(result.status, 0);
      assert.equal(await readFile(fixture.log, "utf8").catch(() => ""), "");
      await assert.rejects(stat(path.join(fixture.destination, captureId)));
    });
  }
});

test("approved tool manifest is release-bound and checked before remote access", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  const manifest = JSON.parse(await readFile(fixture.approvedToolManifest, "utf8"));
  manifest.releaseCommit = "3".repeat(40);
  await writeFile(
    fixture.approvedToolManifest,
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  const result = run(captureScript, await captureArguments(fixture), fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not bound to the exact release commit/);
  assert.equal(await readFile(fixture.log, "utf8").catch(() => ""), "");
});

test("capture start cannot precede the explicit writer-quiescence boundary", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  const args = replaceArgument(
    await captureArguments(fixture),
    "--writer-quiesced-at",
    "2999-01-01T00:00:00Z",
  );
  const result = run(captureScript, args, fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /capture started before writer quiescence/);
  assert.doesNotMatch(await readFile(fixture.log, "utf8"), /remote:/);
});

test("capture writes every artifact directly under the encrypted destination and verifies it", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  const result = await successfulCapture(fixture);
  const captureDirectory = path.join(fixture.destination, captureId);
  assert.deepEqual((await readdir(captureDirectory)).sort(), [
    "CAPTURE_COMPLETE.json",
    "SHA256SUMS",
    "approved-tool-manifest.json",
    "capture.json",
    "data.sql",
    "dump-contract.json",
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
  assert.match(log, /local:supabase-argv:--db-url postgresql:\/\/postgres\./);
  assert.match(log, /local:supabase-argv:[^\n]*--dry-run/);
  for (const line of log.split("\n").filter((entry) => entry.startsWith("remote:docker-dump:"))) {
    assert.ok(line.includes(`${captureDirectory}/.`), line);
  }
  const combined = `${result.stdout}\n${result.stderr}\n${log}\n${await Promise.all(
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
  assert.doesNotMatch(log, /docker-dump:.*history-(schema|data)\.sql/);
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
  assert.match(log, /docker-dump:.*history-schema\.sql\.run\.sh/);
  assert.match(log, /docker-dump:.*history-data\.sql\.run\.sh/);
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
  assert.doesNotMatch(log, /remote:docker-dump:/);
  assert.equal(
    (await readFile(path.join(fixture.destination, captureId, "CAPTURE_INCOMPLETE"), "utf8")).trim(),
    "capture did not complete",
  );
});

test("nonzero excluded vector data and missing mandatory vector relations stop before dumps", async (t) => {
  for (const extraEnv of [
    { FAKE_STORAGE_VECTOR_COUNT: "1" },
    { FAKE_STORAGE_VECTOR_PRESENT: "false" },
  ]) {
    await t.test(JSON.stringify(extraEnv), async (nested) => {
      const fixture = await buildFixture();
      nested.after(() => rm(fixture.root, { force: true, recursive: true }));
      const result = run(
        captureScript,
        await captureArguments(fixture),
        fixture,
        extraEnv,
      );
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        /export Storage blobs through the Storage API|must be present for a complete blob inventory/,
      );
      assert.doesNotMatch(await readFile(fixture.log, "utf8"), /remote:docker-dump:/);
    });
  }
});

test("credential file swap after inventory is detected before any dump", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  const result = run(
    captureScript,
    await captureArguments(fixture),
    fixture,
    { FAKE_SWAP_DATABASE_PASSFILE: "true" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /database passfile changed during inventory/);
  assert.doesNotMatch(await readFile(fixture.log, "utf8"), /remote:docker-dump:/);
  const captureDirectory = path.join(fixture.destination, captureId);
  await stat(path.join(captureDirectory, "CAPTURE_INCOMPLETE"));
  await assert.rejects(stat(path.join(captureDirectory, "CAPTURE_COMPLETE.json")));
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

test("dump contract, toolset, and quiescence tampering all fail before Docker", async (t) => {
  const cases = [
    ["dump contract", "dump-contract.json", async (filename) => writeFile(filename, "{}\n")],
    ["capture toolset", "capture.json", async (filename) => {
      const metadata = JSON.parse(await readFile(filename, "utf8"));
      metadata.captureToolsetSha256 = "f".repeat(64);
      await writeFile(filename, `${JSON.stringify(metadata, null, 2)}\n`);
    }],
    ["writer quiescence", "capture.json", async (filename) => {
      const metadata = JSON.parse(await readFile(filename, "utf8"));
      metadata.writerQuiescedAt = "2999-01-01T00:00:00Z";
      await writeFile(filename, `${JSON.stringify(metadata, null, 2)}\n`);
    }],
  ];
  for (const [label, artifact, tamper] of cases) {
    await t.test(label, async (nested) => {
      const fixture = await buildFixture();
      nested.after(() => rm(fixture.root, { force: true, recursive: true }));
      await successfulCapture(fixture);
      const restoreArgs = await restoreArguments(fixture);
      await tamper(path.join(fixture.destination, captureId, artifact));
      await writeFile(fixture.log, "");
      const result = run(restoreScript, restoreArgs, fixture);
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        /SHA-256 mismatch|dump contract identity|toolset SHA-256|capture started before writer quiescence/,
      );
      assert.doesNotMatch(await readFile(fixture.log, "utf8"), /docker/);
    });
  }
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
  assert.match(log, /local:docker-run:[^\n]*:--cidfile:/);
  assert.match(log, new RegExp(`local:docker-run:[^\\n]*:${imageId.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}`));
  assert.match(log, /target=\/dominion-backup,readonly/);
  assert.match(log, /\/var\/lib\/postgresql\/data:rw,nosuid,nodev/);
  assert.match(log, new RegExp(`local:docker-rm:--force ${containerId}`));
  assert.doesNotMatch(log, /local:docker-rm:--force dominion-restore-/);
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
  assert.match(result.stderr, /refusing cleanup because container ownership changed/);
  const log = await readFile(fixture.log, "utf8");
  assert.doesNotMatch(log, /local:docker-rm:/);
  await stat(path.join(fixture.dockerState, "present"));
});

test("failed container creation adopts only the private full-ID cidfile for cleanup", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  await successfulCapture(fixture);
  const result = run(
    restoreScript,
    await restoreArguments(fixture),
    fixture,
    { FAKE_DOCKER_RUN_FAIL_AFTER_CREATE: "true" },
  );
  assert.notEqual(result.status, 0);
  const log = await readFile(fixture.log, "utf8");
  assert.match(log, new RegExp("local:docker-rm:--force " + containerId));
  assert.doesNotMatch(log, /local:docker-rm:--force dominion-restore-/);
  await assert.rejects(stat(path.join(fixture.dockerState, "present")));
  const evidence = path.join(
    fixture.destination,
    "restore-" + captureId + "-" + restoreId,
  );
  await stat(path.join(evidence, "RESTORE_INCOMPLETE"));
  await assert.rejects(stat(path.join(evidence, "RESTORE_COMPLETE.json")));
});

test("a create attempt without the private cidfile is never adopted by name", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  await successfulCapture(fixture);
  const result = run(
    restoreScript,
    await restoreArguments(fixture),
    fixture,
    { FAKE_DOCKER_SKIP_CIDFILE: "true" },
  );
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /refusing an unverified container left by the create attempt/,
  );
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
  assert.match(result.stdout, /^CAPTURE_TOOLSET_SHA256=[a-f0-9]{64}$/m);
  assert.match(result.stdout, /^RESTORE_TOOLSET_SHA256=[a-f0-9]{64}$/m);
  assert.match(
    result.stdout,
    new RegExp(`^APPROVED_TOOL_MANIFEST_SHA256=${await sha256(fixture.approvedToolManifest)}$`, "m"),
  );
  assert.match(result.stdout, /^MIGRATION_HISTORY_STATE=absent$/m);
  assert.match(result.stdout, new RegExp(`^SUPABASE_CLI_SHA256=${await sha256(fixture.supabase)}$`, "m"));
  assert.match(result.stdout, new RegExp(`^POSTGRES_IMAGE_ID=${imageId}$`, "m"));
  assert.match(result.stdout, /^WRITER_QUIESCED_AT=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m);
  assert.match(result.stdout, /^CAPTURE_STARTED_AT=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m);
  assert.match(result.stdout, /^CAPTURED_AT=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m);
  assert.doesNotMatch(await readFile(fixture.log, "utf8"), /docker/);
});

test("standalone verifier rejects restore-evidence tampering", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  await successfulCapture(fixture);
  const restore = run(restoreScript, await restoreArguments(fixture), fixture);
  assert.equal(restore.status, 0, restore.stderr);
  const verification = path.join(
    fixture.destination,
    `restore-${captureId}-${restoreId}`,
    "restore-verification.json",
  );
  await writeFile(verification, "{}\n");
  await writeFile(fixture.log, "");
  const result = run(verifyScript, await verifyArguments(fixture), fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SHA-256 mismatch/);
  assert.doesNotMatch(await readFile(fixture.log, "utf8"), /docker/);
});

test("standalone verifier rejects incomplete markers beside completion evidence", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  await successfulCapture(fixture);
  const restore = run(restoreScript, await restoreArguments(fixture), fixture);
  assert.equal(restore.status, 0, restore.stderr);
  const args = await verifyArguments(fixture);

  const captureIncomplete = path.join(
    fixture.destination,
    captureId,
    "CAPTURE_INCOMPLETE",
  );
  await writeFile(captureIncomplete, "capture did not complete\n", { mode: 0o600 });
  let result = run(verifyScript, args, fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /artifact inventory does not match/);
  await unlink(captureIncomplete);

  const restoreIncomplete = path.join(
    fixture.destination,
    `restore-${captureId}-${restoreId}`,
    "RESTORE_INCOMPLETE",
  );
  await writeFile(restoreIncomplete, "restore did not complete\n", { mode: 0o600 });
  result = run(verifyScript, args, fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /artifact inventory does not match/);
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
  assert.equal(
    packageJson.scripts["test:production-reconciliation"],
    "node --test scripts/verify-production-reconciliation-preflight.test.mjs scripts/run-production-reconciliation-step.test.mjs",
  );
  assert.equal(
    packageJson.scripts["run:production-reconciliation-step"],
    "bash scripts/run-production-reconciliation-step.sh",
  );
  assert.equal(
    packageJson.scripts["prepare:production-reconciliation-plan"],
    "node scripts/production-reconciliation-artifacts.mjs prepare-plan",
  );
  assert.equal(
    packageJson.scripts["verify:production-reconciliation-completion"],
    "node scripts/production-reconciliation-artifacts.mjs verify-completion",
  );
  assert.match(
    packageJson.scripts["check:database"],
    /pnpm run test:reconciliation-stage && pnpm run test:production-backup-restore && pnpm run test:production-reconciliation && pnpm run test:database-manifest/u,
  );
  const ciWorkflow = await readFile(
    path.join(repositoryRoot, ".github", "workflows", "ci.yml"),
    "utf8",
  );
  assert.match(
    ciWorkflow,
    /Test production backup and restore evidence boundaries\n\s+run: pnpm run test:production-backup-restore/u,
  );
  assert.match(
    ciWorkflow,
    /Test production one-version reconciliation boundaries\n\s+run: pnpm run test:production-reconciliation/u,
  );
});
