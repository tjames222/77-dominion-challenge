import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm as removePath,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
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
const cleanLauncher = path.join(scriptDirectory, "run-production-operator-clean.sh");
const inputPinningHelper = path.join(scriptDirectory, "pin-production-input.mjs");
const offlinePgsodiumGetkey = path.join(
  scriptDirectory,
  "offline-pgsodium-getkey.sh",
);
const nodeBin = await realpath(process.execPath);
const nodeBinSha256 = await sha256(nodeBin);
const cleanLauncherSha256 = await sha256(cleanLauncher);
const dumpScriptTransformer = path.join(
  scriptDirectory,
  "prepare-supabase-dump-script.mjs",
);
const projectRef = "abcdefghijklmnopqrst";
const databaseHost = "aws-0-us-east-1.pooler.supabase.com";
const commit = "1".repeat(40);
const image = "public.ecr.aws/supabase/postgres:17.6.1.141";
const imageId = `sha256:${"2".repeat(64)}`;
const captureId = "capture-20260825";
const restoreId = "restore-20260825";
const containerId = "a".repeat(64);
const rowHash = "0".repeat(64);
const macosTcbAttestationContents = `${JSON.stringify({
  schemaVersion: 1,
  artifactContract: "offline-test-macos-tcb-attestation/v1",
}, null, 2)}\n`;
const macosTcbAttestationSha256 = createHash("sha256")
  .update(macosTcbAttestationContents)
  .digest("hex");

async function makeTreeRemovable(filename) {
  const entry = await lstat(filename).catch(() => null);
  if (!entry || entry.isSymbolicLink()) return;
  if (entry.isDirectory()) {
    await chmod(filename, 0o700).catch(() => {});
    for (const name of await readdir(filename).catch(() => [])) {
      await makeTreeRemovable(path.join(filename, name));
    }
  } else {
    await chmod(filename, 0o600).catch(() => {});
  }
}

async function rm(filename, options) {
  if (options?.recursive) await makeTreeRemovable(filename);
  return removePath(filename, options);
}

async function unsealEvidenceForTest(directory) {
  await chmod(directory, 0o700);
  for (const name of await readdir(directory)) {
    await chmod(path.join(directory, name), 0o600);
  }
}

async function sealEvidenceForTest(directory) {
  for (const name of await readdir(directory)) {
    await chmod(path.join(directory, name), 0o400);
  }
  await chmod(directory, 0o500);
}

async function runtimeDirectories(fixture, prefix) {
  return (await readdir(path.join(fixture.destination, "private")))
    .filter((name) => name.startsWith(prefix));
}

async function sha256(filename) {
  return createHash("sha256").update(await readFile(filename)).digest("hex");
}

function sha256Object(value) {
  const canonicalize = (entry) => {
    if (Array.isArray(entry)) return entry.map(canonicalize);
    if (entry && typeof entry === "object") {
      return Object.fromEntries(
        Object.keys(entry).sort().map((key) => [key, canonicalize(entry[key])]),
      );
    }
    return entry;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

async function makeExecutable(filename, contents) {
  await writeFile(filename, contents, { mode: 0o700 });
  await chmod(filename, 0o700);
  return filename;
}

async function testCaPem() {
  for (const candidate of ["/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt"]) {
    try {
      const bundle = await readFile(candidate, "utf8");
      for (const match of bundle.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----\n?/gu)) {
        try {
          if (new X509Certificate(match[0]).ca) return match[0].endsWith("\n") ? match[0] : `${match[0]}\n`;
        } catch { /* try the next certificate */ }
      }
    } catch { /* try the next platform bundle */ }
  }
  throw new Error("no system CA certificate is available for the offline fixture");
}

function runEnvironment(fixture, extraEnv = {}) {
  const environment = {
    ...process.env,
    FAKE_BOUNDARY_LOG: fixture.log,
    FAKE_DOCKER_STATE: fixture.dockerState,
    FAKE_GIT_BRANCH: "main",
    FAKE_GIT_COMMIT: commit,
    FAKE_IMAGE_ID: imageId,
    FAKE_PROJECT_REF: projectRef,
    FAKE_CONTAINER_ID: containerId,
    DOMINION_CLEAN_ENV_LAUNCHER: "dominion-production-operator/v1",
    DOMINION_CLEAN_ENV_LAUNCHER_PATH: cleanLauncher,
    DOMINION_CLEAN_ENV_LAUNCHER_SHA256: cleanLauncherSha256,
    DOMINION_MACOS_TCB_ATTESTATION_SHA256: macosTcbAttestationSha256,
    NODE_BIN: nodeBin,
    NODE_BIN_SHA256: nodeBinSha256,
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
    "NODE_EXTRA_CA_CERTS", "NODE_OPTIONS", "NODE_PATH", "ALL_PROXY", "all_proxy",
    "AWS_CA_BUNDLE", "CURL_CA_BUNDLE", "HTTPS_PROXY", "https_proxy",
    "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "REQUESTS_CA_BUNDLE",
    "SSL_CERT_DIR", "SSL_CERT_FILE", "SSLKEYLOGFILE",
  ]) {
    if (!Object.hasOwn(extraEnv, name)) delete environment[name];
  }
  for (const name of Object.keys(environment)) {
    if (
      name.startsWith("NODE_")
      && !["NODE_BIN", "NODE_BIN_SHA256"].includes(name)
      && !Object.hasOwn(extraEnv, name)
    ) delete environment[name];
  }
  return environment;
}

function run(script, args, fixture, extraEnv = {}) {
  return spawnSync("bash", [script, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: runEnvironment(fixture, extraEnv),
  });
}

function startRun(script, args, fixture, extraEnv = {}, spawnOptions = {}) {
  const child = spawn("bash", [script, ...args], {
    cwd: repositoryRoot,
    detached: spawnOptions.detached === true,
    env: runEnvironment(fixture, extraEnv),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({
      signal,
      status,
      get stderr() { return stderr; },
      get stdout() { return stdout; },
    }));
  });
  return { child, completion };
}

async function waitForLog(filename, pattern, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const contents = await readFile(filename, "utf8").catch(() => "");
    if (pattern.test(contents)) return contents;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${pattern}`);
}

async function buildFixture(options = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "dominion-backup-test-")));
  const destination = path.join(root, "encrypted-volume");
  const tools = path.join(root, "tools");
  const dockerState = path.join(root, "docker-state");
  const log = path.join(root, "boundary.log");
  await mkdir(destination, { mode: 0o700 });
  await mkdir(tools);
  await mkdir(dockerState);
  await chmod(destination, 0o700);

  const dockerSocket = path.join(root, "docker.sock");
  const dockerSocketServer = createServer();
  await new Promise((resolve, reject) => {
    dockerSocketServer.once("error", reject);
    dockerSocketServer.listen(dockerSocket, () => {
      dockerSocketServer.off("error", reject);
      resolve();
    });
  });
  dockerSocketServer.unref();
  await chmod(dockerSocket, 0o600);
  const dockerSocketIdentity = await stat(dockerSocket);
  const dockerContext = {
    endpoint: `unix://${dockerSocket}`,
    socketPath: dockerSocket,
    device: String(dockerSocketIdentity.dev),
    inode: String(dockerSocketIdentity.ino),
    ownerUid: dockerSocketIdentity.uid,
    ownerMode: 0o600,
  };

  const encryptedPrivateDirectory = path.join(destination, "private");
  const databaseUrl = path.join(encryptedPrivateDirectory, "database-url");
  const databasePassfile = path.join(encryptedPrivateDirectory, "database-passfile");
  const accessToken = path.join(encryptedPrivateDirectory, "access-token");
  const sslRootCertDirectory = path.join(encryptedPrivateDirectory, "supabase-ca");
  const sslRootCert = path.join(sslRootCertDirectory, "prod-ca-2021.crt");
  const macosTcbAttestation = path.join(
    encryptedPrivateDirectory,
    "macos-tcb-attestation.json",
  );
  await mkdir(sslRootCertDirectory, { recursive: true, mode: 0o700 });
  await chmod(encryptedPrivateDirectory, 0o700);
  await writeFile(
    databaseUrl,
    `postgresql://postgres.${projectRef}@${databaseHost}:5432/postgres?sslmode=verify-full&sslrootcert=${encodeURIComponent(sslRootCert)}&options=-c%20jit%3Don\n`,
    { mode: 0o600 },
  );
  await writeFile(
    databasePassfile,
    `${databaseHost}:5432:postgres:postgres.${projectRef}:database-password\n`,
    { mode: 0o600 },
  );
  await writeFile(accessToken, "supabase-access-token\n", { mode: 0o600 });
  await writeFile(macosTcbAttestation, macosTcbAttestationContents, { mode: 0o600 });
  await writeFile(sslRootCert, await testCaPem(), { mode: 0o600 });
  await chmod(databaseUrl, 0o600);
  await chmod(databasePassfile, 0o600);
  await chmod(accessToken, 0o600);
  await chmod(macosTcbAttestation, 0o600);
  await chmod(sslRootCert, 0o600);

  const imagePath = path.join(root, "77dc-production-release.sparsebundle");
  const imageUuid = "12345678-1234-1234-1234-123456789ABC";
  const creationRecord = {
    schemaVersion: 2,
    artifactContract: "dominion-encrypted-volume-aes256-creation-record/v2",
    createdAbsentBefore: true,
    createdAt: "2000-01-01T00:00:00Z",
    hdiutilPath: "/usr/bin/hdiutil",
    argv: [
      "create", "-size", "16g", "-type", "SPARSEBUNDLE", "-fs", "APFS",
      "-volname", "77DCProductionRelease", "-encryption", "AES-256",
      "-stdinpass", imagePath,
    ],
    imagePath,
    imageUuid,
  };
  const creationRecordFile = path.join(
    destination,
    "encrypted-volume-creation-record.json",
  );
  await writeFile(creationRecordFile, `${JSON.stringify(creationRecord, null, 2)}\n`, {
    mode: 0o600,
  });
  const imageIdentity = {
    path: imagePath,
    device: "1",
    inode: "2",
    className: "CSparseBundleDiskImage",
    backingStoreClassName: "CBundleBackingStore",
    format: "UDSB",
    formatDescription: "sparse",
    encrypted: true,
    infoBackupSha256: "a".repeat(64),
    infoPlistDevice: "1",
    infoPlistInode: "3",
    infoPlistSha256: "b".repeat(64),
    infoPlistSize: "4096",
    lockSha256: "c".repeat(64),
    tokenDevice: "1",
    tokenInode: "4",
    tokenSha256: "d".repeat(64),
    tokenSize: "64",
  };
  const mountedSessionIdentity = {
    destination,
    imagePath,
    imageType: "sparse bundle disk image",
    imageEncrypted: true,
    blocksize: 512,
    writeable: true,
    ownerUid: process.getuid(),
    ownerMode: 0o700,
    hdidPid: 1234,
    wholeDiskDevice: "/dev/disk99",
    volumeDevice: "/dev/disk99s1",
    volumeDeviceId: "1",
    volumeInode: "5",
  };
  const encryptedVolumeAttestation = path.join(
    destination,
    "encrypted-volume-attestation.json",
  );
  await writeFile(
    encryptedVolumeAttestation,
    `${JSON.stringify({
      schemaVersion: 2,
      artifactContract: "dominion-encrypted-volume-attestation/v2",
      encryption: {
        algorithm: "AES-256",
        creationRecordSha256: await sha256(creationRecordFile),
        isEncryptedPlistSha256: "3".repeat(64),
        imageInfoPlistSha256: "4".repeat(64),
        imageUuid,
      },
      image: { ...imageIdentity, identitySha256: sha256Object(imageIdentity) },
      mountedSession: {
        ...mountedSessionIdentity,
        identitySha256: sha256Object(mountedSessionIdentity),
      },
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await chmod(creationRecordFile, 0o600);
  await chmod(encryptedVolumeAttestation, 0o600);

  const fixtureGitBranch = options.gitBranch ?? "main";
  const fixtureGitDirty = options.gitDirty === true;
  const git = await makeExecutable(
    path.join(tools, "git"),
    `#!/usr/bin/env bash
set -eu
while (( $# > 0 )); do
  case "\${1:-}" in
    --no-replace-objects) shift ;;
    -c) (( $# >= 2 )); shift 2 ;;
    -C) (( $# >= 2 )); shift 2 ;;
    *) break ;;
  esac
done
case "\${1:-}:\${2:-}" in
  rev-parse:--abbrev-ref) printf '%s\\n' '${fixtureGitBranch}' ;;
  rev-parse:HEAD) printf '%s\\n' '${commit}' ;;
  status:--porcelain*) [[ '${fixtureGitDirty}' == 'true' ]] && printf '%s\\n' ' M tracked' || true ;;
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
operation=''; destination=''; attestation=''; attestation_sha256=''
while (( $# > 0 )); do
  case "$1" in
    --operation) operation="$2"; shift 2 ;;
    --destination) destination="$2"; shift 2 ;;
    --attestation) attestation="$2"; shift 2 ;;
    --attestation-sha256) attestation_sha256="$2"; shift 2 ;;
    *) exit 64 ;;
  esac
done
[[ "$operation" == 'verify' && -s "$attestation" && "$attestation_sha256" =~ ^[a-f0-9]{64}$ ]]
destination="$(cd "$destination" && pwd -P)"
printf '%s\\n' 'local:encrypted-volume-verified' >>${JSON.stringify(log)}
printf 'DOMINION_ENCRYPTED_VOLUME_ATTESTATION_SHA256=%s\\n' "$attestation_sha256"
printf 'DOMINION_ENCRYPTED_VOLUME_DESTINATION=%s\\n' "$destination"
`,
  );

  const edgeHook = await makeExecutable(
    path.join(tools, "edge-hook"),
    `#!/usr/bin/env bash
set -eu
output=''; project=''; access_token_file=''
printf 'remote:edge-argv:%s\\n' "$*" >>"\${FAKE_BOUNDARY_LOG:-${log}}"
while (( $# > 0 )); do
  case "$1" in
    --supabase-cli|--supabase-cli-sha256) shift 2 ;;
    --access-token-file) access_token_file="$2"; shift 2 ;;
    --access-token-file-sha256) shift 2 ;;
    --project-ref) project="$2"; shift 2 ;;
    --output) output="$2"; shift 2 ;;
    *) exit 64 ;;
  esac
done
[[ -z "\${SUPABASE_ACCESS_TOKEN:-}" ]]
[[ "$(tr -d '\\r\\n' <"$access_token_file")" == 'supabase-access-token' ]]
printf 'remote:edge-inventory:%s\\n' "$output" >>"\${FAKE_BOUNDARY_LOG:-${log}}"
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
    --database-client-contract) [[ "$2" == 'exact-supavisor-session-jit-pgpass-verify-full/v2' ]]; shift 2 ;;
    --database-url-file) [[ -s "$2" ]]; shift 2 ;;
    --database-url-file-sha256) shift 2 ;;
    --database-passfile) [[ -s "$2" ]]; passfile="$2"; shift 2 ;;
    --database-passfile-sha256) shift 2 ;;
    --project-ref) project="$2"; shift 2 ;;
    --database-host|--ssl-root-cert-file|--ssl-root-cert-file-sha256|--url-ssl-root-cert-file|--docker-bin|--docker-bin-sha256|--docker-socket|--docker-socket-device|--docker-socket-inode|--docker-socket-owner-uid|--docker-socket-owner-mode|--postgres-image|--postgres-image-id) shift 2 ;;
    --output) output="$2"; shift 2 ;;
    *) exit 64 ;;
  esac
done
objects='${String(options.storageObjectCount ?? 0)}'
vectors='${String(options.storageVectorCount ?? 0)}'
vectors_present='${options.storageVectorPresent === false ? "false" : "true"}'
vectors_row_count="$vectors"
if [[ "$vectors_present" == 'false' ]]; then vectors_row_count='null'; fi
printf 'remote:storage-inventory:%s\\n' "$output" >>"\${FAKE_BOUNDARY_LOG:-${log}}"
printf '{"schemaVersion":1,"projectRef":"%s","relations":{"storage.buckets":{"present":true,"rowCount":1},"storage.buckets_analytics":{"present":true,"rowCount":0},"storage.buckets_vectors":{"present":%s,"rowCount":%s},"storage.iceberg_namespaces":{"present":false,"rowCount":null},"storage.iceberg_tables":{"present":false,"rowCount":null},"storage.objects":{"present":true,"rowCount":%s},"storage.s3_multipart_uploads":{"present":true,"rowCount":0},"storage.s3_multipart_uploads_parts":{"present":true,"rowCount":0},"storage.vector_indexes":{"present":true,"rowCount":%s}},"buckets":[{"id":"journal-progress","name":"journal-progress","ownerId":null,"public":false,"fileSizeLimit":null,"allowedMimeTypes":null,"type":"STANDARD"}],"applicationPolicyCount":0,"applicationPolicies":[]}\\n' "$project" "$vectors_present" "$vectors_row_count" "$objects" "$vectors" >"$output"
if [[ '${options.swapDatabasePassfile ? "true" : "false"}' == 'true' ]]; then
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
    --database-client-contract) [[ "$2" == 'exact-supavisor-session-jit-pgpass-verify-full/v2' ]]; shift 2 ;;
    --database-url-file|--database-url-file-sha256|--database-passfile|--database-passfile-sha256|--project-ref) shift 2 ;;
    --database-host|--ssl-root-cert-file|--ssl-root-cert-file-sha256|--url-ssl-root-cert-file|--docker-bin|--docker-bin-sha256|--docker-socket|--docker-socket-device|--docker-socket-inode|--docker-socket-owner-uid|--docker-socket-owner-mode|--postgres-image|--postgres-image-id) shift 2 ;;
    --output) output="$2"; shift 2 ;;
    *) exit 64 ;;
  esac
done
printf 'remote:source-manifest:%s\\n' "$output" >>"\${FAKE_BOUNDARY_LOG:-${log}}"
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
    --database-client-contract) [[ "$2" == 'exact-supavisor-session-jit-pgpass-verify-full/v2' ]]; shift 2 ;;
    --database-url-file|--database-url-file-sha256|--database-passfile|--database-passfile-sha256|--project-ref) shift 2 ;;
    --database-host|--ssl-root-cert-file|--ssl-root-cert-file-sha256|--url-ssl-root-cert-file|--docker-bin|--docker-bin-sha256|--docker-socket|--docker-socket-device|--docker-socket-inode|--docker-socket-owner-uid|--docker-socket-owner-mode|--postgres-image|--postgres-image-id) shift 2 ;;
    --output) output="$2"; shift 2 ;;
    *) exit 64 ;;
  esac
done
printf 'remote:source-fingerprint:%s\\n' "$output" >>"\${FAKE_BOUNDARY_LOG:-${log}}"
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
    --database-client-contract) [[ "$2" == 'exact-supavisor-session-jit-pgpass-verify-full/v2' ]]; shift 2 ;;
    --database-url-file|--database-url-file-sha256|--database-passfile|--database-passfile-sha256) shift 2 ;;
    --database-host|--ssl-root-cert-file|--ssl-root-cert-file-sha256|--url-ssl-root-cert-file|--docker-bin|--docker-bin-sha256|--docker-socket|--docker-socket-device|--docker-socket-inode|--docker-socket-owner-uid|--docker-socket-owner-mode|--postgres-image|--postgres-image-id) shift 2 ;;
    --project-ref) project="$2"; shift 2 ;;
    --output) output="$2"; shift 2 ;;
    *) exit 64 ;;
  esac
done
printf 'remote:relation-counts:%s\\n' "$output" >>"\${FAKE_BOUNDARY_LOG:-${log}}"
printf '{"schemaVersion":2,"projectRef":"%s","vaultSecretsCount":0,"schemas":["auth","private","public","storage","supabase_migrations"],"relations":[{"schema":"auth","name":"users","present":true,"rowCount":1,"rowsSha256":"${rowHash}"}],"sequences":[{"schema":"public","name":"example_seq","present":true,"lastValue":"1","isCalled":false}]}\\n' "$project" >"$output"
`,
  );

  const migrationHistoryHook = await makeExecutable(
    path.join(tools, "migration-history-hook"),
    `#!/usr/bin/env bash
set -eu
output=''; project=''
while (( $# > 0 )); do
  case "$1" in
    --database-client-contract) [[ "$2" == 'exact-supavisor-session-jit-pgpass-verify-full/v2' ]]; shift 2 ;;
    --database-url-file|--database-url-file-sha256|--database-passfile|--database-passfile-sha256) shift 2 ;;
    --database-host|--ssl-root-cert-file|--ssl-root-cert-file-sha256|--url-ssl-root-cert-file|--docker-bin|--docker-bin-sha256|--docker-socket|--docker-socket-device|--docker-socket-inode|--docker-socket-owner-uid|--docker-socket-owner-mode|--postgres-image|--postgres-image-id) shift 2 ;;
    --project-ref) project="$2"; shift 2 ;;
    --output) output="$2"; shift 2 ;;
    *) exit 64 ;;
  esac
done
printf 'remote:migration-history:%s\\n' "$output" >>"\${FAKE_BOUNDARY_LOG:-${log}}"
if [[ '${options.historyPresent ? "true" : "false"}' == 'true' ]]; then
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
    --database-client-contract) [[ "$2" == 'exact-supavisor-session-jit-pgpass-verify-full/v2' ]]; shift 2 ;;
    --database-url-file|--database-passfile) [[ -s "$2" ]]; shift 2 ;;
    --database-url-file-sha256|--database-passfile-sha256) shift 2 ;;
    --database-host|--ssl-root-cert-file|--ssl-root-cert-file-sha256|--url-ssl-root-cert-file|--docker-bin|--docker-bin-sha256|--docker-socket|--docker-socket-device|--docker-socket-inode|--docker-socket-owner-uid|--docker-socket-owner-mode|--postgres-image|--postgres-image-id) shift 2 ;;
    --project-ref) [[ "$2" == '${projectRef}' ]]; shift 2 ;;
    --output) output="$2"; shift 2 ;;
    *) exit 64 ;;
  esac
done
printf 'remote:managed-application-ddl:%s\\n' "$output" >>"\${FAKE_BOUNDARY_LOG:-${log}}"
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
state="\${FAKE_DOCKER_STATE:-${dockerState}}"
fake_image_id="\${FAKE_IMAGE_ID:-${imageId}}"
fake_container_id="\${FAKE_CONTAINER_ID:-${containerId}}"
boundary_log="\${FAKE_BOUNDARY_LOG:-${log}}"
[[ "\${DOCKER_HOST:-}" == 'unix://${dockerSocket}' ]]
case "$command" in
  context)
    [[ "\${1:-}" == 'inspect' ]]
    printf '%s\\n' "\${FAKE_DOCKER_ENDPOINT:-unix:///var/run/docker.sock}"
    ;;
  image)
    [[ "\${1:-}" == 'inspect' ]]
    printf '%s\\n' "$fake_image_id"
    ;;
  container)
    [[ "\${1:-}" == 'inspect' ]] || exit 64
    shift
    target="\${1:-}"; shift || true
    [[ -f "$state/present" ]] || exit 1
    [[ "$target" == "$fake_container_id" || "$target" == dominion-restore-* || "$target" == dominion-dump-* || "$target" == dominion-client-* ]] || exit 66
    if [[ "$*" == *'--format'* ]]; then
      token="$(cat "$state/token")"
      if [[ "\${FAKE_DOCKER_OWNERSHIP_MODE:-matched}" == 'mismatch' ]]; then token='changed'; fi
      if [[ "$*" == *'production-backup-capture'* ]]; then
        printf '%s|%s|%s|true|%s|%s|%s\\n' \
          "$fake_container_id" "$fake_image_id" "$fake_image_id" \
          "$(cat "$state/capture")" "$token" "$(cat "$state/operation")"
      elif [[ "$*" == *'production-client'* ]]; then
        printf '%s|%s|%s|true|%s|%s|database-manifest\\n' \
          "$fake_container_id" "$fake_image_id" "$fake_image_id" \
          "$(cat "$state/project")" "$token"
      else
        printf '%s|%s|%s|true|%s|%s|%s\\n' \
          "$fake_container_id" "$fake_image_id" "$fake_image_id" \
          "$(cat "$state/capture")" "$(cat "$state/restore")" "$token"
      fi
    else
      printf '%s\\n' '[]'
    fi
    ;;
  run)
    original_args="$*"
    [[ "$original_args" != *'database-password'* ]]
    capture=''; restore=''; project=''; token=''; operation=''; cidfile=''; name=''
    parse_run_args() {
      while (( $# > 0 )); do
        case "$1" in
          --label)
            case "$2" in
              com.dominion.capture-id=*) capture="\${2#*=}" ;;
              com.dominion.restore-id=*) restore="\${2#*=}" ;;
              com.dominion.project-ref=*) project="\${2#*=}" ;;
              com.dominion.ownership-token=*) token="\${2#*=}" ;;
              com.dominion.operation=*) operation="\${2#*=}" ;;
            esac
            shift 2 ;;
          --cidfile) cidfile="$2"; shift 2 ;;
          --name) name="$2"; shift 2 ;;
          *) shift ;;
        esac
      done
    }
    parse_run_args "$@"
    materialize_fake_container() {
      printf '%s\\n' "$capture" >"$state/capture"
      printf '%s\\n' "$restore" >"$state/restore"
      printf '%s\\n' "$project" >"$state/project"
      printf '%s\\n' "$token" >"$state/token"
      printf '%s\\n' "$operation" >"$state/operation"
      : >"$state/present"
      if [[ "\${FAKE_DOCKER_SKIP_CIDFILE:-false}" != 'true' ]]; then
        printf '%s\\n' "$fake_container_id" >"$cidfile"
      fi
    }
    if [[ -n "$cidfile" ]]; then
      case "\${FAKE_DOCKER_CREATE_MODE:-normal}" in
        unresolved)
          printf 'local:docker-create-unresolved:%s\\n' "$name" >>"$boundary_log"
          exit 75
          ;;
        delayed)
          (
            sleep 0.2
            printf 'local:docker-create-delay-window:%s\\n' "$name" >>"$boundary_log"
            sleep 0.4
            materialize_fake_container
          ) >/dev/null 2>&1 &
          printf 'local:docker-create-delayed:%s\\n' "$name" >>"$boundary_log"
          exit 75
          ;;
        normal) materialize_fake_container ;;
        *) exit 69 ;;
      esac
    fi
    if [[ "$original_args" == *'/tmp/dominion/run.sh'* ]]; then
      printf 'remote:docker-dump:%s\\n' "$original_args" >>"$boundary_log"
      [[ "$original_args" == *"$fake_image_id /tmp/dominion/run.sh"* ]]
      [[ "$original_args" == *'target=/tmp/dominion/pgpass,readonly'* ]]
      [[ "$original_args" == *'PGPASSFILE=/tmp/dominion/pgpass'* ]]
      dump_script=''
      for argument in "$@"; do
        case "$argument" in
          type=bind,source=*,target=/tmp/dominion/run.sh,readonly)
            dump_script="\${argument#*source=}"
            dump_script="\${dump_script%%,target=*}"
            ;;
        esac
      done
      [[ -s "$dump_script" ]]
      grep -F 'unset PGPASSWORD' "$dump_script" >/dev/null
      grep -F 'export PGPASSFILE="/tmp/dominion/pgpass"' "$dump_script" >/dev/null
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
    printf 'local:docker-run' >>"$boundary_log"
    while (( $# > 0 )); do
      printf ':%s' "$1" >>"$boundary_log"
      case "$1" in
        --label)
          case "$2" in
            com.dominion.capture-id=*) capture="\${2#*=}" ;;
            com.dominion.restore-id=*) restore="\${2#*=}" ;;
            com.dominion.ownership-token=*) token="\${2#*=}" ;;
          esac
          printf ':%s' "$2" >>"$boundary_log"
          shift 2
          ;;
        --cidfile)
          cidfile="$2"
          printf ':%s' "$2" >>"$boundary_log"
          shift 2
          ;;
        --name|--mount|--tmpfs|--env|--network|--pull|--log-driver|--security-opt|--cap-drop|--cap-add|--stop-timeout|--user)
          printf ':%s' "$2" >>"$boundary_log"
          shift 2
          ;;
        --detach) shift ;;
        *) shift ;;
      esac
    done
    printf '\\n' >>"$boundary_log"
    [[ -n "$cidfile" ]]
    if [[ "\${FAKE_DOCKER_RUN_FAIL_AFTER_CREATE:-false}" == 'true' ]]; then
      exit 75
    fi
    printf '%s\\n' "$fake_container_id"
    ;;
  exec)
    printf 'local:docker-exec:%s\\n' "$*" >>"$boundary_log"
    if [[ -n "\${FAKE_MUTATE_CAPTURE_ON_EXEC:-}" \
      && ! -e "$state/capture-mutated" ]]; then
      case "$FAKE_MUTATE_CAPTURE_ON_EXEC" in
        path-swap)
          mv "$FAKE_CAPTURE_DIRECTORY" "$FAKE_CAPTURE_DIRECTORY.swapped"
          mkdir "$FAKE_CAPTURE_DIRECTORY"
          chmod 500 "$FAKE_CAPTURE_DIRECTORY"
          ;;
        hardlink)
          ln "$FAKE_CAPTURE_DIRECTORY/schema.sql" \
            "$FAKE_CAPTURE_HARDLINK_DESTINATION"
          ;;
        *) exit 69 ;;
      esac
      : >"$state/capture-mutated"
    fi
    if [[ "$*" == *'show server_version_num'* ]]; then printf '%s\\n' '170006'; fi
    ;;
  rm)
    [[ "$*" == "--force $fake_container_id" ]] || exit 67
    printf 'local:docker-rm:%s\\n' "$*" >>"$boundary_log"
    if [[ "\${FAKE_DOCKER_RM_DELAY:-false}" == 'true' ]]; then
      printf 'local:docker-rm-cleanup-window:%s\\n' "$fake_container_id" >>"$boundary_log"
      sleep 0.5
    fi
    rm -f "$state/present" "$state/capture" "$state/restore" "$state/project" "$state/token" "$state/operation"
    ;;
  diff)
    [[ "$*" == "$fake_container_id" ]] || exit 68
    [[ "\${FAKE_DOCKER_DIFF:-empty}" == 'empty' ]] || printf '%s\\n' 'C /tmp/unexpected'
    ;;
  ps)
    if [[ "\${FAKE_DOCKER_ABSENCE_QUERY_FAIL:-false}" == 'true' \
      && "$*" == *'--filter id='* ]]; then
      exit 75
    fi
    [[ ! -f "$state/present" ]] || printf '%s\\n' "$fake_container_id"
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
    --docker-bin|--docker-bin-sha256|--docker-socket|--docker-socket-device|--docker-socket-inode|--docker-socket-owner-uid|--docker-socket-owner-mode|--container|--capture-directory) shift 2 ;;
    *) exit 64 ;;
  esac
done
printf 'local:restore-verification:%s\\n' "$output" >>"\${FAKE_BOUNDARY_LOG:-${log}}"
printf '{"schemaVersion":1,"captureId":"%s","restoreId":"%s","databaseName":"%s","checks":[{"name":"managed-application-ddl","status":"pass"},{"name":"migration-history","status":"pass"},{"name":"relation-sequence-counts","status":"pass"},{"name":"roles-schema-data","status":"pass"},{"name":"source-fingerprint","status":"pass"},{"name":"source-manifest","status":"pass"}]}\\n' "$capture" "$restore" "$database" >"$output"
`,
  );

  const operatorPackLauncher = await makeExecutable(
    path.join(tools, "operator-pack-clean-launcher"),
    `#!/usr/bin/env bash
set -euo pipefail
[[ "\${1:-}" == '--entrypoint' ]]; entrypoint="$2"; shift 2
[[ "\${1:-}" == '--entrypoint-file-sha256' ]]; shift 2
[[ "\${1:-}" == '--clean-environment-launcher-sha256' ]]; shift 2
[[ "\${1:-}" == '--node-bin' ]]; shift 2
[[ "\${1:-}" == '--node-bin-sha256' ]]; shift 2
[[ "\${1:-}" == '--runtime-directory' && -d "$2" ]]; runtime="$2"; shift 2
[[ "\${1:-}" == '--macos-tcb-attestation' ]]; shift 2
[[ "\${1:-}" == '--macos-tcb-attestation-sha256' ]]; shift 2
[[ "\${1:-}" == '--' ]]; shift
if [[ "\${FAKE_OPERATOR_PACK_ABRUPT_EMPTY_ENTRYPOINT:-}" == "$entrypoint" ]]; then
  kill -TERM "$PPID"
  exit 75
fi
if [[ "\${FAKE_OPERATOR_PACK_EMPTY_FAILURE_ENTRYPOINT:-}" == "$entrypoint" ]]; then
  exit 75
fi
if [[ "\${FAKE_OPERATOR_PACK_RECOVERY_ENTRYPOINT:-}" == "$entrypoint" ]]; then
  printf '%s\n' '{"artifactContract":"offline-test-container-recovery/v1"}' \
    >"$runtime/container-recovery.json"
  chmod 600 "$runtime/container-recovery.json"
  exit 75
fi
case "$entrypoint" in
  encrypted-volume-check) exec '${volumeHook}' "$@" ;;
  edge-functions-inventory) exec '${edgeHook}' "$@" ;;
  storage-inventory) exec '${storageHook}' "$@" ;;
  source-manifest) exec '${sourceManifestHook}' "$@" ;;
  source-fingerprint) exec '${sourceFingerprintHook}' "$@" ;;
  relation-counts) exec '${relationCountsHook}' "$@" ;;
  migration-history) exec '${migrationHistoryHook}' "$@" ;;
  managed-application-ddl) exec '${managedApplicationDdlHook}' "$@" ;;
  restore-verification) exec '${restoreVerificationHook}' "$@" ;;
  *) exit 64 ;;
esac
`,
  );

  const captureTools = {
    cleanEnvironmentLauncherSha256: cleanLauncherSha256,
    credentialValidatorSha256: await sha256(credentialValidator),
    dockerBinSha256: await sha256(docker),
    dumpScriptTransformerSha256: await sha256(dumpScriptTransformer),
    edgeFunctionsInventoryHookSha256: await sha256(edgeHook),
    encryptedVolumeCheckHookSha256: await sha256(volumeHook),
    inputPinningHelperSha256: await sha256(inputPinningHelper),
    macosTcbAttestationSha256,
    managedApplicationDdlHookSha256: await sha256(managedApplicationDdlHook),
    migrationHistoryHookSha256: await sha256(migrationHistoryHook),
    nodeBinSha256,
    operatorPackCleanEnvironmentLauncherSha256: await sha256(operatorPackLauncher),
    relationCountsHookSha256: await sha256(relationCountsHook),
    sourceFingerprintHookSha256: await sha256(sourceFingerprintHook),
    sourceManifestHookSha256: await sha256(sourceManifestHook),
    storageInventoryHookSha256: await sha256(storageHook),
    supabaseCliSha256: await sha256(supabase),
  };
  const restoreTools = {
    cleanEnvironmentLauncherSha256: cleanLauncherSha256,
    dockerBinSha256: await sha256(docker),
    encryptedVolumeCheckHookSha256: await sha256(volumeHook),
    inputPinningHelperSha256: await sha256(inputPinningHelper),
    macosTcbAttestationSha256,
    nodeBinSha256,
    offlinePgsodiumGetkeySha256: await sha256(offlinePgsodiumGetkey),
    operatorPackCleanEnvironmentLauncherSha256: await sha256(operatorPackLauncher),
    restoreVerificationHookSha256: await sha256(restoreVerificationHook),
  };
  const hashObject = (value) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const approvedToolManifest = path.join(root, "approved-tool-manifest.json");
  await writeFile(
    approvedToolManifest,
    `${JSON.stringify({
      schemaVersion: 2,
      artifactContract: "dominion-production-backup-approved-tools/v2",
      releaseCommit: commit,
      dockerSharedHomeRoot: root,
      dockerContext,
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
    dockerContext,
    dockerSocket,
    dockerSocketServer,
    dockerState,
    edgeHook,
    git,
    log,
    macosTcbAttestation,
    managedApplicationDdlHook,
    migrationHistoryHook,
    encryptedVolumeAttestation,
    creationRecordFile,
    offlinePgsodiumGetkey,
    operatorPackLauncher,
    relationCountsHook,
    restoreVerificationHook,
    root,
    sourceFingerprintHook,
    sourceManifestHook,
    storageHook,
    sslRootCert,
    supabase,
    volumeHook,
  };
}

async function captureArguments(fixture, id = captureId) {
  return [
    "--capture-id", id,
    "--project-ref", projectRef,
    "--database-host", databaseHost,
    "--expected-branch", "main",
    "--expected-commit", commit,
    "--supabase-cli", fixture.supabase,
    "--supabase-cli-sha256", await sha256(fixture.supabase),
    "--database-url-file", fixture.databaseUrl,
    "--database-url-sha256", await sha256(fixture.databaseUrl),
    "--database-passfile", fixture.databasePassfile,
    "--database-passfile-sha256", await sha256(fixture.databasePassfile),
    "--ssl-root-cert-file", fixture.sslRootCert,
    "--ssl-root-cert-file-sha256", await sha256(fixture.sslRootCert),
    "--credential-validator-sha256", await sha256(credentialValidator),
    "--docker-bin", fixture.docker,
    "--docker-bin-sha256", await sha256(fixture.docker),
    "--docker-socket", fixture.dockerContext.socketPath,
    "--docker-socket-device", fixture.dockerContext.device,
    "--docker-socket-inode", fixture.dockerContext.inode,
    "--docker-socket-owner-uid", String(fixture.dockerContext.ownerUid),
    "--docker-socket-owner-mode", String(fixture.dockerContext.ownerMode),
    "--docker-shared-home-root", fixture.root,
    "--dump-script-transformer-sha256", await sha256(dumpScriptTransformer),
    "--approved-tool-manifest", fixture.approvedToolManifest,
    "--approved-tool-manifest-sha256", await sha256(fixture.approvedToolManifest),
    "--operator-pack-clean-environment-launcher", fixture.operatorPackLauncher,
    "--macos-tcb-attestation", fixture.macosTcbAttestation,
    "--access-token-file", fixture.accessToken,
    "--access-token-sha256", await sha256(fixture.accessToken),
    "--destination", fixture.destination,
    "--encrypted-volume-attestation", fixture.encryptedVolumeAttestation,
    "--encrypted-volume-attestation-sha256", await sha256(fixture.encryptedVolumeAttestation),
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
    "--operator-pack-clean-environment-launcher", fixture.operatorPackLauncher,
    "--macos-tcb-attestation", fixture.macosTcbAttestation,
    "--destination", fixture.destination,
    "--encrypted-volume-attestation", fixture.encryptedVolumeAttestation,
    "--encrypted-volume-attestation-sha256", await sha256(fixture.encryptedVolumeAttestation),
    "--encrypted-volume-check-hook", fixture.volumeHook,
    "--encrypted-volume-check-hook-sha256", await sha256(fixture.volumeHook),
    "--docker-bin", fixture.docker,
    "--docker-bin-sha256", await sha256(fixture.docker),
    "--docker-socket", fixture.dockerContext.socketPath,
    "--docker-socket-device", fixture.dockerContext.device,
    "--docker-socket-inode", fixture.dockerContext.inode,
    "--docker-socket-owner-uid", String(fixture.dockerContext.ownerUid),
    "--docker-socket-owner-mode", String(fixture.dockerContext.ownerMode),
    "--docker-shared-home-root", fixture.root,
    "--offline-pgsodium-getkey", fixture.offlinePgsodiumGetkey,
    "--offline-pgsodium-getkey-sha256", await sha256(fixture.offlinePgsodiumGetkey),
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
    "--operator-pack-clean-environment-launcher", fixture.operatorPackLauncher,
    "--macos-tcb-attestation", fixture.macosTcbAttestation,
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
    "--encrypted-volume-attestation", fixture.encryptedVolumeAttestation,
    "--encrypted-volume-attestation-sha256", await sha256(fixture.encryptedVolumeAttestation),
    "--encrypted-volume-check-hook", fixture.volumeHook,
    "--encrypted-volume-check-hook-sha256", await sha256(fixture.volumeHook),
    "--docker-bin", fixture.docker,
    "--docker-bin-sha256", await sha256(fixture.docker),
    "--docker-socket", fixture.dockerContext.socketPath,
    "--docker-socket-device", fixture.dockerContext.device,
    "--docker-socket-inode", fixture.dockerContext.inode,
    "--docker-socket-owner-uid", String(fixture.dockerContext.ownerUid),
    "--docker-socket-owner-mode", String(fixture.dockerContext.ownerMode),
    "--docker-shared-home-root", fixture.root,
    "--offline-pgsodium-getkey", fixture.offlinePgsodiumGetkey,
    "--offline-pgsodium-getkey-sha256", await sha256(fixture.offlinePgsodiumGetkey),
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

test("operator shell files parse under Bash 3.2 or newer", () => {
  const result = spawnSync(
    "bash",
    ["-n", path.join(scriptDirectory, "production-backup-common.sh"), captureScript, restoreScript, verifyScript],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const version = spawnSync("bash", ["--version"], { encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  const match = version.stdout.match(/version (\d+)\.(\d+)\./);
  assert.ok(match, `unable to parse Bash version: ${version.stdout}`);
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  assert.ok(major > 3 || (major === 3 && minor >= 2));
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
  const fixture = await buildFixture({ gitBranch: "develop" });
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  const result = run(captureScript, await captureArguments(fixture), fixture);
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

test("capture rejects a mismatched Docker socket identity before image or hosted access", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  const args = replaceArgument(
    await captureArguments(fixture),
    "--docker-socket-inode",
    String(BigInt(fixture.dockerContext.inode) + 1n),
  );
  const result = run(captureScript, args, fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exact owner-only reviewed socket/);
  assert.doesNotMatch(
    await readFile(fixture.log, "utf8").catch(() => ""),
    /remote:/,
  );
});

test("exact tool, image, credential, and attestation mismatches all fail before remote access", async (t) => {
  const cases = [
    ["CLI hash", "--supabase-cli-sha256", "f".repeat(64)],
    ["image ref", "--postgres-image", "public.ecr.aws/supabase/postgres:17.6.1.140"],
    ["database credential hash", "--database-url-sha256", "e".repeat(64)],
    ["attestation hash", "--encrypted-volume-attestation-sha256", "d".repeat(64)],
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
      const boundaryLog = await readFile(fixture.log, "utf8").catch(() => "");
      assert.equal(boundaryLog, "local:encrypted-volume-verified\n");
      assert.doesNotMatch(boundaryLog, /remote:/u);
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

test("trust roots reject deterministic path swaps and hard links before access", async (t) => {
  for (const mutation of ["path-swap", "hardlink"]) {
    await t.test(mutation, async (nested) => {
      const fixture = await buildFixture();
      nested.after(() => rm(fixture.root, { force: true, recursive: true }));
      const args = await captureArguments(fixture);
      if (mutation === "path-swap") {
        const original = `${fixture.approvedToolManifest}.original`;
        await rename(fixture.approvedToolManifest, original);
        await symlink(original, fixture.approvedToolManifest);
      } else {
        await link(
          fixture.approvedToolManifest,
          `${fixture.approvedToolManifest}.hardlink`,
        );
      }
      const result = run(captureScript, args, fixture);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /symbolic link|non-symlink|too many levels|exactly one hard link|exact opened regular file/iu);
      assert.doesNotMatch(await readFile(fixture.log, "utf8").catch(() => ""), /remote:/u);
    });
  }
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
  assert.equal((await stat(captureDirectory)).mode & 0o777, 0o500);
  assert.deepEqual(
    await runtimeDirectories(fixture, "dominion-production-capture."),
    [],
    "successful capture must leave no private operator runtime",
  );
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
  for (const name of await readdir(captureDirectory)) {
    const artifact = await stat(path.join(captureDirectory, name));
    assert.equal(artifact.mode & 0o777, 0o400, `${name} must be sealed read-only`);
    assert.equal(artifact.nlink, 1, `${name} must have one hard link`);
  }
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
    assert.ok(
      line.includes(`${fixture.destination}/private/dominion-production-capture.`),
      `credential-bearing Docker mounts escaped the encrypted runtime: ${line}`,
    );
  }
  assert.doesNotMatch(log, /\/tmp\/dominion-production-capture\./u);
  const combined = `${result.stdout}\n${result.stderr}\n${log}\n${await Promise.all(
    (await readdir(captureDirectory)).map((name) => readFile(path.join(captureDirectory, name), "utf8")),
  )}`;
  assert.doesNotMatch(combined, /database-password|supabase-access-token/);
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
  const fixture = await buildFixture({ historyPresent: true });
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  const result = run(
    captureScript,
    await captureArguments(fixture),
    fixture,
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
  const fixture = await buildFixture({ historyPresent: true });
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  const result = run(
    captureScript,
    await captureArguments(fixture),
    fixture,
    { FAKE_HISTORY_DUMP_FAIL: "true" },
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
  const fixture = await buildFixture({ storageObjectCount: 1 });
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  const result = run(
    captureScript,
    await captureArguments(fixture),
    fixture,
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
  for (const fixtureOptions of [
    { storageVectorCount: 1 },
    { storageVectorPresent: false },
  ]) {
    await t.test(JSON.stringify(fixtureOptions), async (nested) => {
      const fixture = await buildFixture(fixtureOptions);
      nested.after(() => rm(fixture.root, { force: true, recursive: true }));
      const result = run(
        captureScript,
        await captureArguments(fixture),
        fixture,
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
  const fixture = await buildFixture({ swapDatabasePassfile: true });
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  const result = run(
    captureScript,
    await captureArguments(fixture),
    fixture,
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
  await unsealEvidenceForTest(path.join(fixture.destination, captureId));
  await writeFile(path.join(fixture.destination, captureId, "schema.sql"), "tampered\n");
  await sealEvidenceForTest(path.join(fixture.destination, captureId));
  await writeFile(fixture.log, "");
  const result = run(restoreScript, await restoreArguments(fixture), fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SHA-256 mismatch for schema\.sql/);
  const boundaryLog = await readFile(fixture.log, "utf8");
  assert.equal(
    boundaryLog,
    "local:encrypted-volume-verified\nlocal:encrypted-volume-verified\n",
  );
  assert.doesNotMatch(boundaryLog, /docker/u);
});

test("restore rejects hard-linked capture evidence before touching Docker", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  await successfulCapture(fixture);
  await link(
    path.join(fixture.destination, captureId, "schema.sql"),
    path.join(fixture.destination, "private", "schema-hardlink"),
  );
  await writeFile(fixture.log, "");
  const result = run(restoreScript, await restoreArguments(fixture), fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exactly one hard link/);
  assert.doesNotMatch(await readFile(fixture.log, "utf8"), /docker/u);
});

test("restore detects capture path swaps and hardlink mutation around pinned consumption", async (t) => {
  for (const mutation of ["path-swap", "hardlink"]) {
    await t.test(mutation, async (nested) => {
      const fixture = await buildFixture();
      nested.after(() => rm(fixture.root, { force: true, recursive: true }));
      await successfulCapture(fixture);
      const captureDirectory = path.join(fixture.destination, captureId);
      const result = run(
        restoreScript,
        await restoreArguments(fixture),
        fixture,
        {
          FAKE_CAPTURE_DIRECTORY: captureDirectory,
          FAKE_CAPTURE_HARDLINK_DESTINATION: path.join(
            fixture.destination,
            "private",
            "consumption-hardlink",
          ),
          FAKE_MUTATE_CAPTURE_ON_EXEC: mutation,
        },
      );
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        /changed during isolated restore consumption|exactly one hard link|artifact inventory/u,
      );
      const log = await readFile(fixture.log, "utf8");
      assert.match(log, /authenticated-backup,target=\/tmp\/dominion-runtime\/backup,readonly/u);
      assert.doesNotMatch(
        log,
        new RegExp(`source=${captureDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")},target=/tmp/dominion-runtime/backup`),
      );
      assert.match(log, new RegExp(`local:docker-rm:--force ${containerId}`));
      const runtimes = await runtimeDirectories(
        fixture,
        "dominion-production-restore.",
      );
      assert.deepEqual(
        runtimes,
        [],
        "proven container cleanup must remove credential-bearing runtime",
      );
    });
  }
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
      await unsealEvidenceForTest(path.join(fixture.destination, captureId));
      await tamper(path.join(fixture.destination, captureId, artifact));
      await sealEvidenceForTest(path.join(fixture.destination, captureId));
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
  assert.match(log, /local:docker-run:[^\n]*:--read-only/);
  assert.match(log, /local:docker-run:[^\n]*:--cap-drop:ALL/);
  assert.match(log, /local:docker-run:[^\n]*:--security-opt:no-new-privileges/);
  assert.match(log, /local:docker-run:[^\n]*:--user:100:101/);
  assert.match(log, /local:docker-run:[^\n]*:--cidfile:/);
  assert.match(
    log,
    new RegExp(`${fixture.destination.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/private/dominion-production-restore\\.`),
  );
  assert.doesNotMatch(log, /\/tmp\/dominion-production-restore\./u);
  assert.match(log, new RegExp(`local:docker-run:[^\\n]*:${imageId.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}`));
  assert.match(log, /target=\/tmp\/dominion-runtime\/backup,readonly/);
  assert.match(
    log,
    /source=.*\/private\/dominion-production-restore\.[^,]*\/authenticated-backup,target=\/tmp\/dominion-runtime\/backup,readonly/u,
  );
  assert.doesNotMatch(
    log,
    new RegExp(`source=${path.join(fixture.destination, captureId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")},target=/tmp/dominion-runtime/backup`),
  );
  assert.match(log, /\/var\/lib\/postgresql\/data:rw,nosuid,nodev/);
  assert.match(log, new RegExp(`local:docker-rm:--force ${containerId}`));
  assert.doesNotMatch(log, /local:docker-rm:--force dominion-restore-/);
  assert.match(log, /--file \/tmp\/dominion-runtime\/backup\/managed-application-ddl\.sql/);
  await assert.rejects(stat(path.join(fixture.dockerState, "present")));
  assert.deepEqual(
    await runtimeDirectories(fixture, "dominion-production-restore."),
    [],
    "successful restore must leave no private restore runtime",
  );

  const evidence = path.join(
    fixture.destination,
    `restore-${captureId}-${restoreId}`,
  );
  assert.equal((await stat(evidence)).mode & 0o777, 0o500);
  assert.deepEqual((await readdir(evidence)).sort(), [
    "RESTORE_COMPLETE.json",
    "SHA256SUMS",
    "restore-verification.json",
    "restore.json",
  ]);
  for (const name of await readdir(evidence)) {
    const artifact = await stat(path.join(evidence, name));
    assert.equal(artifact.mode & 0o777, 0o400);
    assert.equal(artifact.nlink, 1);
  }
  const metadata = JSON.parse(await readFile(path.join(evidence, "restore.json"), "utf8"));
  assert.equal(metadata.postgres.serverVersionNum, 170006);
  assert.equal(metadata.cleanupOwnershipVerified, true);
  assert.equal(metadata.containerRemoved, true);
});

test("ownership mismatch refuses destructive container cleanup", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  await successfulCapture(fixture);
  await writeFile(fixture.log, "");
  const result = run(
    restoreScript,
    await restoreArguments(fixture),
    fixture,
    { FAKE_DOCKER_OWNERSHIP_MODE: "mismatch" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /failed the ownership and image inspection/);
  assert.match(result.stderr, /refusing an unverified container left by the create attempt/);
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

test("a validated returned container ID remains cleanup authority when its cidfile is missing", async (t) => {
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
  assert.match(result.stderr, /Docker cidfile did not bind the exact full container ID/);
  const log = await readFile(fixture.log, "utf8");
  assert.match(log, new RegExp("local:docker-rm:--force " + containerId));
  assert.doesNotMatch(log, /local:docker-rm:--force dominion-restore-/);
  await assert.rejects(stat(path.join(fixture.dockerState, "present")));
});

test("capture SIGQUIT late-adopts an exact delayed container and removes its runtime", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  const operation = startRun(
    captureScript,
    await captureArguments(fixture),
    fixture,
    { FAKE_DOCKER_CREATE_MODE: "delayed" },
  );
  await waitForLog(fixture.log, /local:docker-create-delay-window:/u);
  operation.child.kill("SIGQUIT");
  const result = await operation.completion;
  assert.notEqual(result.status, 0, result.stderr);
  const log = await readFile(fixture.log, "utf8");
  assert.match(log, new RegExp(`local:docker-rm:--force ${containerId}`));
  await assert.rejects(stat(path.join(fixture.dockerState, "present")));
  assert.deepEqual(
    await runtimeDirectories(fixture, "dominion-production-capture."),
    [],
  );
});

test("capture cleanup survives a second process-group signal", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  const operation = startRun(
    captureScript,
    await captureArguments(fixture),
    fixture,
    {
      FAKE_DOCKER_CREATE_MODE: "delayed",
      FAKE_DOCKER_RM_DELAY: "true",
    },
    { detached: true },
  );
  t.after(() => {
    try {
      process.kill(-operation.child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  });
  await waitForLog(fixture.log, /local:docker-create-delay-window:/u);
  operation.child.kill("SIGQUIT");
  await waitForLog(fixture.log, /local:docker-rm-cleanup-window:/u);
  process.kill(-operation.child.pid, "SIGTERM");
  const result = await operation.completion;
  assert.notEqual(result.status, 0, result.stderr);
  const log = await readFile(fixture.log, "utf8");
  assert.match(log, new RegExp(`local:docker-rm:--force ${containerId}`));
  await assert.rejects(stat(path.join(fixture.dockerState, "present")));
  assert.deepEqual(
    await runtimeDirectories(fixture, "dominion-production-capture."),
    [],
  );
});

test("restore SIGTERM late-adopts an exact delayed container and removes its runtime", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  await successfulCapture(fixture);
  await writeFile(fixture.log, "");
  const operation = startRun(
    restoreScript,
    await restoreArguments(fixture),
    fixture,
    { FAKE_DOCKER_CREATE_MODE: "delayed" },
  );
  await waitForLog(fixture.log, /local:docker-create-delay-window:/u);
  operation.child.kill("SIGTERM");
  const result = await operation.completion;
  assert.notEqual(result.status, 0, result.stderr);
  const log = await readFile(fixture.log, "utf8");
  assert.match(log, new RegExp(`local:docker-rm:--force ${containerId}`));
  await assert.rejects(stat(path.join(fixture.dockerState, "present")));
  assert.deepEqual(
    await runtimeDirectories(fixture, "dominion-production-restore."),
    [],
  );
});

test("restore cleanup survives a second process-group signal", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  await successfulCapture(fixture);
  await writeFile(fixture.log, "");
  const operation = startRun(
    restoreScript,
    await restoreArguments(fixture),
    fixture,
    {
      FAKE_DOCKER_CREATE_MODE: "delayed",
      FAKE_DOCKER_RM_DELAY: "true",
    },
    { detached: true },
  );
  t.after(() => {
    try {
      process.kill(-operation.child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  });
  await waitForLog(fixture.log, /local:docker-create-delay-window:/u);
  operation.child.kill("SIGTERM");
  await waitForLog(fixture.log, /local:docker-rm-cleanup-window:/u);
  process.kill(-operation.child.pid, "SIGQUIT");
  const result = await operation.completion;
  assert.notEqual(result.status, 0, result.stderr);
  const log = await readFile(fixture.log, "utf8");
  assert.match(log, new RegExp(`local:docker-rm:--force ${containerId}`));
  await assert.rejects(stat(path.join(fixture.dockerState, "present")));
  assert.deepEqual(
    await runtimeDirectories(fixture, "dominion-production-restore."),
    [],
  );
});

test("capture preserves nested operator-pack recovery authority", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  const result = run(
    captureScript,
    await captureArguments(fixture),
    fixture,
    { FAKE_OPERATOR_PACK_RECOVERY_ENTRYPOINT: "source-manifest" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /preserved encrypted capture recovery state/u);
  const runtimes = await runtimeDirectories(
    fixture,
    "dominion-production-capture.",
  );
  assert.equal(runtimes.length, 1);
  const runtime = path.join(fixture.destination, "private", runtimes[0]);
  const children = (await readdir(runtime))
    .filter((name) => name.startsWith("operator-pack-entrypoint."));
  assert.equal(children.length, 1);
  await stat(path.join(runtime, children[0], "container-recovery.json"));
  await stat(path.join(runtime, "database-url"));
  await stat(path.join(runtime, "pgpass"));
});

test("capture preserves an abruptly abandoned empty pack runtime", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  const result = run(
    captureScript,
    await captureArguments(fixture),
    fixture,
    { FAKE_OPERATOR_PACK_ABRUPT_EMPTY_ENTRYPOINT: "source-manifest" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /preserved encrypted capture recovery state/u);
  const runtimes = await runtimeDirectories(
    fixture,
    "dominion-production-capture.",
  );
  assert.equal(runtimes.length, 1);
  const runtime = path.join(fixture.destination, "private", runtimes[0]);
  const children = (await readdir(runtime))
    .filter((name) => name.startsWith("operator-pack-entrypoint."));
  assert.equal(children.length, 1);
  assert.deepEqual(await readdir(path.join(runtime, children[0])), []);
});

test("capture preserves an ordinary failed empty pack runtime", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  const result = run(
    captureScript,
    await captureArguments(fixture),
    fixture,
    { FAKE_OPERATOR_PACK_EMPTY_FAILURE_ENTRYPOINT: "source-manifest" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /preserved encrypted capture recovery state/u);
  const runtimes = await runtimeDirectories(
    fixture,
    "dominion-production-capture.",
  );
  assert.equal(runtimes.length, 1);
  const runtime = path.join(fixture.destination, "private", runtimes[0]);
  const children = (await readdir(runtime))
    .filter((name) => name.startsWith("operator-pack-entrypoint."));
  assert.equal(children.length, 1);
  assert.deepEqual(await readdir(path.join(runtime, children[0])), []);
});

test("restore preserves nested operator-pack recovery authority", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  await successfulCapture(fixture);
  await writeFile(fixture.log, "");
  const result = run(
    restoreScript,
    await restoreArguments(fixture),
    fixture,
    { FAKE_OPERATOR_PACK_RECOVERY_ENTRYPOINT: "restore-verification" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /preserved encrypted restore recovery state/u);
  await assert.rejects(stat(path.join(fixture.dockerState, "present")));
  const runtimes = await runtimeDirectories(
    fixture,
    "dominion-production-restore.",
  );
  assert.equal(runtimes.length, 1);
  const runtime = path.join(fixture.destination, "private", runtimes[0]);
  const children = (await readdir(runtime))
    .filter((name) => name.startsWith("operator-pack-entrypoint."));
  assert.equal(children.length, 1);
  await stat(path.join(runtime, children[0], "container-recovery.json"));
  await stat(path.join(runtime, "authenticated-backup"));
});

test("restore preserves an abruptly abandoned empty pack runtime", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  await successfulCapture(fixture);
  await writeFile(fixture.log, "");
  const result = run(
    restoreScript,
    await restoreArguments(fixture),
    fixture,
    { FAKE_OPERATOR_PACK_ABRUPT_EMPTY_ENTRYPOINT: "restore-verification" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /preserved encrypted restore recovery state/u);
  await assert.rejects(stat(path.join(fixture.dockerState, "present")));
  const runtimes = await runtimeDirectories(
    fixture,
    "dominion-production-restore.",
  );
  assert.equal(runtimes.length, 1);
  const runtime = path.join(fixture.destination, "private", runtimes[0]);
  const children = (await readdir(runtime))
    .filter((name) => name.startsWith("operator-pack-entrypoint."));
  assert.equal(children.length, 1);
  assert.deepEqual(await readdir(path.join(runtime, children[0])), []);
});

test("restore preserves an ordinary failed empty pack runtime", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  await successfulCapture(fixture);
  await writeFile(fixture.log, "");
  const result = run(
    restoreScript,
    await restoreArguments(fixture),
    fixture,
    { FAKE_OPERATOR_PACK_EMPTY_FAILURE_ENTRYPOINT: "restore-verification" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /preserved encrypted restore recovery state/u);
  await assert.rejects(stat(path.join(fixture.dockerState, "present")));
  const runtimes = await runtimeDirectories(
    fixture,
    "dominion-production-restore.",
  );
  assert.equal(runtimes.length, 1);
  const runtime = path.join(fixture.destination, "private", runtimes[0]);
  const children = (await readdir(runtime))
    .filter((name) => name.startsWith("operator-pack-entrypoint."));
  assert.equal(children.length, 1);
  assert.deepEqual(await readdir(path.join(runtime, children[0])), []);
});

test("capture preserves recovery authority when the absence query fails", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  const result = run(
    captureScript,
    await captureArguments(fixture),
    fixture,
    { FAKE_DOCKER_ABSENCE_QUERY_FAIL: "true" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /preserved encrypted capture recovery state/u);
  const runtimes = await runtimeDirectories(
    fixture,
    "dominion-production-capture.",
  );
  assert.equal(runtimes.length, 1);
  await stat(path.join(
    fixture.destination,
    "private",
    runtimes[0],
    "container-roles.sql",
    "container-recovery.json",
  ));
});

test("unresolved capture creation preserves exact sealed recovery authority", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  const result = run(
    captureScript,
    await captureArguments(fixture),
    fixture,
    { FAKE_DOCKER_CREATE_MODE: "unresolved" },
  );
  assert.notEqual(result.status, 0);
  const runtimes = await runtimeDirectories(
    fixture,
    "dominion-production-capture.",
  );
  assert.equal(runtimes.length, 1);
  const runtime = path.join(fixture.destination, "private", runtimes[0]);
  const recoveryFile = path.join(runtime, "container-roles.sql", "container-recovery.json");
  const recovery = JSON.parse(await readFile(recoveryFile, "utf8"));
  assert.equal((await stat(recoveryFile)).mode & 0o777, 0o600);
  assert.equal(recovery.captureId, captureId);
  assert.equal(recovery.status, "create-pending");
  assert.equal(recovery.imageId, imageId);
  assert.deepEqual(recovery.mounts.dumpScript, {
    source: path.join(fixture.destination, captureId, ".roles.sql.run.sh"),
    target: "/tmp/dominion/run.sh",
    readOnly: true,
  });
  assert.equal(recovery.mounts.passfile.target, "/tmp/dominion/pgpass");
  assert.equal(recovery.mounts.passfile.readOnly, true);
  assert.equal(recovery.mounts.rootCert.target, "/tmp/dominion/supabase-ca.crt");
  assert.equal(recovery.mounts.rootCert.readOnly, true);
});

test("unresolved restore creation preserves exact sealed recovery authority", async (t) => {
  const fixture = await buildFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  await successfulCapture(fixture);
  const result = run(
    restoreScript,
    await restoreArguments(fixture),
    fixture,
    { FAKE_DOCKER_CREATE_MODE: "unresolved" },
  );
  assert.notEqual(result.status, 0);
  const runtimes = await runtimeDirectories(
    fixture,
    "dominion-production-restore.",
  );
  assert.equal(runtimes.length, 1);
  const runtime = path.join(fixture.destination, "private", runtimes[0]);
  const recoveryFile = path.join(runtime, "restore-container-recovery.json");
  const recovery = JSON.parse(await readFile(recoveryFile, "utf8"));
  assert.equal((await stat(recoveryFile)).mode & 0o777, 0o600);
  assert.equal(recovery.captureId, captureId);
  assert.equal(recovery.restoreId, restoreId);
  assert.equal(recovery.status, "create-pending");
  assert.equal(recovery.imageId, imageId);
  assert.deepEqual(recovery.mounts.backupDirectory, {
    source: path.join(runtime, "authenticated-backup"),
    target: "/tmp/dominion-runtime/backup",
    readOnly: true,
  });
  assert.equal(
    recovery.mounts.getkeyHelper.target,
    "/tmp/dominion-runtime/bin/offline-pgsodium-getkey",
  );
  assert.equal(recovery.mounts.getkeyHelper.readOnly, true);
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
  assert.match(result.stdout, new RegExp(`^DOCKER_SHARED_HOME_ROOT=${fixture.root}$`, "m"));
  assert.match(
    result.stdout,
    new RegExp(`^MACOS_TCB_ATTESTATION_SHA256=${macosTcbAttestationSha256}$`, "m"),
  );
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
  await unsealEvidenceForTest(path.dirname(verification));
  await writeFile(verification, "{}\n");
  await sealEvidenceForTest(path.dirname(verification));
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
  await unsealEvidenceForTest(path.dirname(captureIncomplete));
  await writeFile(captureIncomplete, "capture did not complete\n", { mode: 0o600 });
  await sealEvidenceForTest(path.dirname(captureIncomplete));
  let result = run(verifyScript, args, fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /artifact inventory does not match/);
  await unsealEvidenceForTest(path.dirname(captureIncomplete));
  await unlink(captureIncomplete);
  await sealEvidenceForTest(path.dirname(captureIncomplete));

  const restoreIncomplete = path.join(
    fixture.destination,
    `restore-${captureId}-${restoreId}`,
    "RESTORE_INCOMPLETE",
  );
  await unsealEvidenceForTest(path.dirname(restoreIncomplete));
  await writeFile(restoreIncomplete, "restore did not complete\n", { mode: 0o600 });
  await sealEvidenceForTest(path.dirname(restoreIncomplete));
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
