import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmod,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sourceScripts = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(sourceScripts, "..");
const nodeBin = await realpath(process.execPath);
const gitBin = await realpath(execFileSync("sh", ["-c", "command -v git"], {
  encoding: "utf8",
}).trim());
const versions = [
  "20260707170000",
  "20260708154000",
  "20260708155500",
  "20260708160000",
  "20260709163000",
  "20260710120000",
  "20260710123000",
  "20260713120000",
  "20260714120000",
  "20260715190000",
  "20260716061500",
  "20260716153000",
  "20260716163000",
];
const projectRef = "abcdefghijklmnopqrst";
const databaseHost = "aws-0-us-east-1.pooler.supabase.com";
const postgresImage = "public.ecr.aws/supabase/postgres:17.6.1.141";
const postgresImageId = `sha256:${"a".repeat(64)}`;
const zeroHash = "0".repeat(64);
const privatePassword = "canary-private-password-never-in-argv";

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256(filename) {
  return sha256Bytes(await readFile(filename));
}

async function executable(filename, contents) {
  await writeFile(filename, contents, { mode: 0o700 });
  await chmod(filename, 0o700);
  return filename;
}

async function privateFile(filename, contents) {
  await writeFile(filename, contents, { mode: 0o600 });
  await chmod(filename, 0o600);
  return filename;
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
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
  return sha256Bytes(JSON.stringify(canonicalize(value)));
}

function manifestText(state) {
  return `${JSON.stringify({
    key: "column/public.reconciliation_fixture/state",
    kind: "column",
    identity: "public.reconciliation_fixture.state",
    definition: { state, type: "integer" },
  })}\n`;
}

function fingerprintText(state) {
  return `${JSON.stringify({
    key: "data/public.reconciliation_fixture",
    kind: "data-fingerprint",
    identity: "public.reconciliation_fixture",
    definition: { rowCount: state, rowsSha256: sha256Bytes(`state-${state}`) },
  })}\n`;
}

function effectText(throughVersion) {
  const stageNumber = versions.indexOf(throughVersion) + 1;
  return canonicalJson({
    schemaVersion: 1,
    projectRef,
    throughVersion,
    passed: true,
    checks: [
      {
        name: "application-data-state",
        passed: true,
        evidenceSha256: sha256Bytes(fingerprintText(stageNumber)),
      },
      {
        name: "application-schema-state",
        passed: true,
        evidenceSha256: sha256Bytes(manifestText(stageNumber)),
      },
      {
        name: "migration-prefix-state",
        passed: true,
        evidenceSha256: sha256Bytes(JSON.stringify({
          projectRef,
          remoteVersions: versions.slice(0, stageNumber),
        })),
      },
    ],
  });
}

function relationCountsText(state) {
  return canonicalJson({
    schemaVersion: 2,
    projectRef,
    schemas: ["auth", "private", "public", "storage", "supabase_migrations"],
    relations: [{
      schema: "public",
      name: "reconciliation_fixture",
      present: true,
      rowCount: state,
      rowsSha256: sha256Bytes(`state-${state}`),
    }],
    sequences: [],
    vaultSecretsCount: 0,
  });
}

async function testCaPem() {
  for (const candidate of ["/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt"]) {
    try {
      const bundle = await readFile(candidate, "utf8");
      for (const match of bundle.matchAll(
        /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----\n?/gu,
      )) {
        try {
          if (new X509Certificate(match[0]).ca) {
            return match[0].endsWith("\n") ? match[0] : `${match[0]}\n`;
          }
        } catch { /* try the next certificate */ }
      }
    } catch { /* try the next platform bundle */ }
  }
  throw new Error("no system CA certificate is available for the offline fixture");
}

function stateSha256(state) {
  return sha256Bytes(JSON.stringify({
    relationSequenceCountsSha256: state.relationSequenceCountsSha256,
    sourceFingerprintSha256: state.sourceFingerprintSha256,
    sourceManifestSha256: state.sourceManifestSha256,
  }));
}

async function copyReleaseRepository(root, { runnerSourceTransform } = {}) {
  const repository = path.join(root, "repository");
  await mkdir(path.join(repository, "scripts"), { recursive: true });
  await mkdir(path.join(repository, "supabase", ".temp"), { recursive: true });
  await cp(path.join(sourceRoot, "supabase", "migrations"), path.join(repository, "supabase", "migrations"), {
    recursive: true,
  });
  await cp(path.join(sourceRoot, "supabase", "config.toml"), path.join(repository, "supabase", "config.toml"));
  await cp(
    path.join(sourceRoot, "supabase", ".temp", "postgres-version"),
    path.join(repository, "supabase", ".temp", "postgres-version"),
  );
  const names = [
    "compare-database-manifests.mjs",
    "offline-pgsodium-getkey.sh",
    "prepare-reconciliation-stage.mjs",
    "prepare-supabase-dump-script.mjs",
    "production-backup-artifacts.mjs",
    "production-backup-common.sh",
    "production-reconciliation-artifacts.mjs",
    "pin-production-input.mjs",
    "run-production-operator-clean.sh",
    "run-production-reconciliation-step.sh",
    "validate-postgres-credentials.mjs",
    "verify-production-backup-evidence.sh",
    "verify-production-reconciliation-preflight.sh",
    "verify-reconciliation-history.mjs",
  ];
  for (const name of names) {
    await cp(path.join(sourceScripts, name), path.join(repository, "scripts", name));
  }
  if (runnerSourceTransform) {
    const runner = path.join(
      repository,
      "scripts",
      "run-production-reconciliation-step.sh",
    );
    const original = await readFile(runner, "utf8");
    const transformed = runnerSourceTransform(original);
    assert.notEqual(transformed, original, "runner fixture transform must change the source");
    await writeFile(runner, transformed);
  }
  await chmod(path.join(repository, "scripts", "run-production-reconciliation-step.sh"), 0o700);
  await chmod(path.join(repository, "scripts", "offline-pgsodium-getkey.sh"), 0o700);
  await chmod(path.join(repository, "scripts", "run-production-operator-clean.sh"), 0o700);
  await chmod(path.join(repository, "scripts", "verify-production-backup-evidence.sh"), 0o700);
  await chmod(path.join(repository, "scripts", "verify-production-reconciliation-preflight.sh"), 0o700);
  execFileSync(gitBin, ["init", "-q", "-b", "main"], { cwd: repository });
  execFileSync(gitBin, [
    "remote", "add", "origin",
    "https://github.com/tjames222/77-dominion-challenge.git",
  ], { cwd: repository });
  execFileSync(gitBin, ["config", "user.email", "fixture@example.test"], { cwd: repository });
  execFileSync(gitBin, ["config", "user.name", "Fixture"], { cwd: repository });
  execFileSync(gitBin, ["add", "-f", "."], { cwd: repository });
  execFileSync(gitBin, ["commit", "-qm", "fixture release"], { cwd: repository });
  const commit = execFileSync(gitBin, ["rev-parse", "HEAD"], {
    cwd: repository,
    encoding: "utf8",
  }).trim();
  return { commit, repository, scripts: path.join(repository, "scripts") };
}

async function makeFakeCli(filename, stateFile, boundaryLog) {
  return executable(filename, `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("2.109.0\\n");
  process.exit(0);
}
if (args.some((value) => value.includes(${JSON.stringify(privatePassword)}))) process.exit(91);
if (process.env.PGPASSWORD || process.env.SUPABASE_DB_PASSWORD || process.env.DATABASE_URL) process.exit(92);
if (!process.env.PGPASSFILE) process.exit(93);
if (!existsSync(path.join(process.cwd(), "RECONCILIATION_INCOMPLETE.json"))) process.exit(98);
appendFileSync(${JSON.stringify(boundaryLog)}, JSON.stringify({ kind: "cli", args, cwd: process.cwd(), pgpass: process.env.PGPASSFILE }) + "\\n");
const value = (flag) => args[args.indexOf(flag) + 1];
const command = args.slice(0, 2).join(" ");
if (!["migration list", "migration up"].includes(command)) process.exit(94);
if (args.includes("--include-all") || args.includes("repair") || args.includes("push") || args.includes("reset")) process.exit(95);
const stage = value("--workdir");
const manifest = JSON.parse(readFileSync(path.join(stage, "reconciliation-stage.json"), "utf8"));
const included = manifest.includedVersions;
let applied = Number(readFileSync(${JSON.stringify(stateFile)}, "utf8"));
const time = (version) => version.slice(0, 4) + "-" + version.slice(4, 6) + "-" + version.slice(6, 8)
  + " " + version.slice(8, 10) + ":" + version.slice(10, 12) + ":" + version.slice(12, 14);
if (command === "migration list") {
  process.stdout.write(JSON.stringify({
    message: "Migrations listed",
    migrations: included.map((version, index) => ({
      local: version,
      remote: index < applied ? version : "",
      time: time(version),
    })),
  }) + "\\n");
  process.exit(0);
}
if (!args.includes("--yes") || applied !== included.length - 1) process.exit(96);
const match = manifest.files.find(({ path: candidate }) => path.basename(candidate).startsWith(included.at(-1) + "_"));
if (!match) process.exit(97);
applied += 1;
writeFileSync(${JSON.stringify(stateFile)}, String(applied));
process.stdout.write(JSON.stringify({
  applied: [path.resolve(stage, match.path)],
  message: "Migrations applied",
}) + "\\n");
`);
}

async function makeDocker(filename, boundaryLog, dockerContext) {
  return executable(filename, `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (process.env.DOCKER_HOST !== ${JSON.stringify(dockerContext.endpoint)}) process.exit(70);
appendFileSync(${JSON.stringify(boundaryLog)}, JSON.stringify({ kind: "docker", args, dockerHost: process.env.DOCKER_HOST }) + "\\n");
if (args[0] === "image" && args[1] === "inspect" && args.at(-1) === ${JSON.stringify(postgresImage)}) process.stdout.write(${JSON.stringify(postgresImageId + "\n")});
else process.exit(71);
`);
}

async function makeDatabaseHook(filename, kind, stateFile, driftFlag, boundaryLog, docker) {
  const dockerSha256 = await sha256(docker);
  return executable(filename, `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const expectedFlags = ["--database-client-contract", "--database-url-file", "--database-url-file-sha256", "--database-passfile", "--database-passfile-sha256", "--ssl-root-cert-file", "--ssl-root-cert-file-sha256", "--database-host", "--project-ref", "--docker-bin", "--docker-bin-sha256", "--docker-socket", "--docker-socket-device", "--docker-socket-inode", "--docker-socket-owner-uid", "--docker-socket-owner-mode", "--postgres-image", "--postgres-image-id", "--output"];
if (args.length !== expectedFlags.length * 2 || expectedFlags.some((flag, index) => args[index * 2] !== flag)) process.exit(61);
const value = (flag) => args[args.indexOf(flag) + 1];
if (value("--database-client-contract") !== "exact-supavisor-session-jit-pgpass-verify-full/v2"
  || value("--database-host") !== ${JSON.stringify(databaseHost)}
  || value("--project-ref") !== ${JSON.stringify(projectRef)}
  || value("--docker-bin-sha256") !== ${JSON.stringify(dockerSha256)}
  || value("--postgres-image") !== ${JSON.stringify(postgresImage)}
  || value("--postgres-image-id") !== ${JSON.stringify(postgresImageId)}) process.exit(62);
if (args.some((entry) => entry.includes(${JSON.stringify(privatePassword)}))) process.exit(63);
const output = value("--output");
if (path.dirname(output) !== process.cwd()) process.exit(64);
if (!existsSync(path.join(process.cwd(), "RECONCILIATION_INCOMPLETE.json"))) process.exit(65);
appendFileSync(${JSON.stringify(boundaryLog)}, JSON.stringify({ kind: ${JSON.stringify(kind)}, args, cwd: process.cwd() }) + "\\n");
let state = Number(readFileSync(${JSON.stringify(stateFile)}, "utf8"));
if (existsSync(${JSON.stringify(driftFlag)})) state += 50;
const sha256Bytes = (input) => require("node:crypto").createHash("sha256").update(input).digest("hex");
let valueOut;
if (${JSON.stringify(kind)} === "manifest") valueOut = ${manifestText.toString()}(state);
else if (${JSON.stringify(kind)} === "fingerprint") valueOut = ${fingerprintText.toString()}(state);
else if (${JSON.stringify(kind)} === "counts") valueOut = JSON.stringify({
  schemaVersion: 2,
  projectRef: ${JSON.stringify(projectRef)},
  schemas: ["auth", "private", "public", "storage", "supabase_migrations"],
  relations: [{ schema: "public", name: "reconciliation_fixture", present: true,
    rowCount: state, rowsSha256: sha256Bytes("state-" + state) }],
  sequences: [],
  vaultSecretsCount: 0,
}, null, 2) + "\\n";
else {
  const versions = ${JSON.stringify(versions)}.slice(0, Number(readFileSync(${JSON.stringify(stateFile)}, "utf8")));
  valueOut = JSON.stringify(versions.length === 0 ? {
    schemaVersion: 1, projectRef: ${JSON.stringify(projectRef)}, schemaPresent: false,
    tablePresent: false, rowCount: null, versions: [],
  } : {
    schemaVersion: 1, projectRef: ${JSON.stringify(projectRef)}, schemaPresent: true,
    tablePresent: true, rowCount: versions.length, versions,
  }) + "\\n";
}
writeFileSync(output, valueOut);
process.stdout.write("captured-hook-output\\n");
`);
}

async function makeEffectHook(filename, boundaryLog, docker, stateFile) {
  const dockerSha256 = await sha256(docker);
  return executable(filename, `#!/usr/bin/env node
const { appendFileSync, existsSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const expectedFlags = ["--database-client-contract", "--database-url-file", "--database-url-file-sha256", "--database-passfile", "--database-passfile-sha256", "--ssl-root-cert-file", "--ssl-root-cert-file-sha256", "--database-host", "--project-ref", "--through-version", "--docker-bin", "--docker-bin-sha256", "--docker-socket", "--docker-socket-device", "--docker-socket-inode", "--docker-socket-owner-uid", "--docker-socket-owner-mode", "--postgres-image", "--postgres-image-id", "--output"];
if (args.length !== expectedFlags.length * 2 || expectedFlags.some((flag, index) => args[index * 2] !== flag)) process.exit(51);
const value = (flag) => args[args.indexOf(flag) + 1];
if (value("--database-client-contract") !== "exact-supavisor-session-jit-pgpass-verify-full/v2"
  || value("--database-host") !== ${JSON.stringify(databaseHost)}
  || value("--project-ref") !== ${JSON.stringify(projectRef)}
  || value("--docker-bin-sha256") !== ${JSON.stringify(dockerSha256)}
  || value("--postgres-image") !== ${JSON.stringify(postgresImage)}
  || value("--postgres-image-id") !== ${JSON.stringify(postgresImageId)}) process.exit(52);
if (args.some((entry) => entry.includes(${JSON.stringify(privatePassword)}))) process.exit(53);
const output = value("--output");
if (path.dirname(output) !== process.cwd()) process.exit(54);
if (!existsSync(path.join(process.cwd(), "RECONCILIATION_INCOMPLETE.json"))) process.exit(55);
appendFileSync(${JSON.stringify(boundaryLog)}, JSON.stringify({ kind: "effect", args, cwd: process.cwd() }) + "\\n");
const throughVersion = value("--through-version");
const versions = ${JSON.stringify(versions)};
const projectRef = ${JSON.stringify(projectRef)};
const sha256Bytes = (value) => require("node:crypto").createHash("sha256").update(value).digest("hex");
const canonicalJson = (value) => JSON.stringify(value, null, 2) + "\\n";
const manifestText = ${manifestText.toString()};
const fingerprintText = ${fingerprintText.toString()};
writeFileSync(output, (${effectText.toString()})(throughVersion));
process.stdout.write("effect-hook-output\\n");
`);
}

async function makeVolumeHook(filename, boundaryLog, { failFinal = false } = {}) {
  const countFile = `${filename}.count`;
  return executable(filename, `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args.length !== 8 || args[0] !== "--operation" || args[1] !== "verify"
  || args[2] !== "--destination" || args[4] !== "--attestation"
  || args[6] !== "--attestation-sha256") process.exit(41);
if (process.env.RECONCILIATION_AMBIENT_CANARY) process.exit(42);
const countFile = ${JSON.stringify(countFile)};
const count = existsSync(countFile) ? Number(readFileSync(countFile, "utf8")) + 1 : 1;
writeFileSync(countFile, String(count));
appendFileSync(${JSON.stringify(boundaryLog)}, JSON.stringify({ kind: "volume", args, cwd: process.cwd(), count }) + "\\n");
if (${JSON.stringify(failFinal)} && count === 2) {
  process.stderr.write("fixture final volume attestation failed\\n");
  process.exit(43);
}
process.stdout.write("DOMINION_ENCRYPTED_VOLUME_ATTESTATION_SHA256=" + args[7] + "\\n"
  + "DOMINION_ENCRYPTED_VOLUME_DESTINATION=" + args[3] + "\\n");
`);
}

async function makeOperatorPackLauncher(filename, entrypoints) {
  const mappings = Object.fromEntries(await Promise.all(
    Object.entries(entrypoints).map(async ([name, entrypoint]) => [name, {
      path: entrypoint,
      sha256: await sha256(entrypoint),
    }]),
  ));
  return executable(filename, `#!/usr/bin/env node
const { createHash } = require("node:crypto");
const { readFileSync, statSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const mappings = ${JSON.stringify(mappings)};
const hash = (filename) => createHash("sha256").update(readFileSync(filename)).digest("hex");
const fixed = [
  "--entrypoint", "--entrypoint-file-sha256",
  "--clean-environment-launcher-sha256", "--node-bin",
  "--node-bin-sha256", "--node-archive", "--node-archive-sha256",
  "--runtime-directory",
  "--macos-tcb-attestation", "--macos-tcb-attestation-sha256",
];
if (args.length < 21 || fixed.some((flag, index) => args[index * 2] !== flag)
  || args[20] !== "--") process.exit(81);
const entrypoint = mappings[args[1]];
if (!entrypoint || args[3] !== entrypoint.sha256 || hash(entrypoint.path) !== entrypoint.sha256) process.exit(82);
if (hash(process.argv[1]) !== args[5] || hash(args[7]) !== args[9]
  || hash(args[11]) !== args[13] || hash(args[17]) !== args[19]) process.exit(83);
const runtime = statSync(args[15]);
if (!runtime.isDirectory() || (runtime.mode & 0o777) !== 0o700) process.exit(84);
const child = spawnSync(entrypoint.path, args.slice(21), {
  cwd: process.cwd(),
  env: {
    PATH: process.env.PATH,
    NODE_BIN: args[7],
    NODE_BIN_SHA256: args[9],
    NODE_ARCHIVE: args[11],
    NODE_ARCHIVE_SHA256: args[13],
    DOMINION_CLEAN_ENV_LAUNCHER: "dominion-production-operator/v1",
    DOMINION_CLEAN_ENV_LAUNCHER_SHA256: args[5],
    DOMINION_MACOS_TCB_ATTESTATION_SHA256: args[19],
  },
  stdio: "inherit",
});
process.exit(child.status ?? 85);
`);
}

async function makeGenericTool(filename) {
  return executable(filename, "#!/bin/sh\nexit 0\n");
}

async function makeClock(filename, values = ["2026-08-25T19:00:02Z"]) {
  const countFile = `${filename}.count`;
  return executable(filename, `#!/usr/bin/env node
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const values = ${JSON.stringify(values)};
const countFile = ${JSON.stringify(countFile)};
const count = existsSync(countFile) ? Number(readFileSync(countFile, "utf8")) + 1 : 1;
writeFileSync(countFile, String(count));
process.stdout.write(values[Math.min(count - 1, values.length - 1)] + "\\n");
`);
}

async function makePreflight({
  filename,
  repositoryScripts,
  clockSha256,
  driftFlag,
  drift,
}) {
  const constants = {
    artifact: await sha256(path.join(repositoryScripts, "production-backup-artifacts.mjs")),
    evidence: await sha256(path.join(repositoryScripts, "verify-production-backup-evidence.sh")),
    history: await sha256(path.join(repositoryScripts, "verify-reconciliation-history.mjs")),
    stage: await sha256(path.join(repositoryScripts, "prepare-reconciliation-stage.mjs")),
    reconciliation: await sha256(path.join(repositoryScripts, "production-reconciliation-artifacts.mjs")),
  };
  return executable(filename, `#!/usr/bin/env node
const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.length % 2 !== 0) process.exit(31);
const options = {};
for (let index = 0; index < args.length; index += 2) {
  const key = args[index].slice(2);
  if (options[key] !== undefined) process.exit(32);
  options[key] = args[index + 1];
}
const rehearsal = JSON.parse(readFileSync(
  path.join(options["rehearsal-evidence-directory"], "rehearsal-evidence.json"),
  "utf8",
));
const fields = [
  ["PREFLIGHT_SCHEMA", "77-dominion-production-reconciliation-preflight/v2"],
  ["PREFLIGHT_SCOPE", "offline-non-authorizing"],
  ["BACKUP_EVIDENCE_VERIFIER_SHA256", ${JSON.stringify(constants.evidence)}],
  ["BACKUP_ARTIFACT_VERIFIER_SHA256", ${JSON.stringify(constants.artifact)}],
  ["RECONCILIATION_STAGE_VERIFIER_SHA256", ${JSON.stringify(constants.stage)}],
  ["RECONCILIATION_HISTORY_VERIFIER_SHA256", ${JSON.stringify(constants.history)}],
  ["RELEASE_COMMIT", options["release-commit"]],
  ["THROUGH_VERSION", options["through-version"]],
  ["PROJECT_REF", options["project-ref"]],
  ["DATABASE_HOST", options["database-host"]],
  ["SSL_MODE", "verify-full"],
  ["SSL_ROOT_CERT_SHA256", options["ssl-root-cert-sha256"]],
  ["SSL_ROOT_CERT_RELATIVE_PATH", "private/supabase-ca/prod-ca-2021.crt"],
  ["ENCRYPTED_VOLUME_ATTESTATION_SHA256", options["encrypted-volume-attestation-sha256"]],
  ["DOCKER_ENDPOINT", "unix://" + options["docker-socket"]],
  ["DOCKER_SOCKET", options["docker-socket"]],
  ["DOCKER_SOCKET_DEVICE", options["docker-socket-device"]],
  ["DOCKER_SOCKET_INODE", options["docker-socket-inode"]],
  ["DOCKER_SOCKET_OWNER_UID", options["docker-socket-owner-uid"]],
  ["DOCKER_SOCKET_OWNER_MODE", options["docker-socket-owner-mode"]],
  ["DOCKER_SHARED_HOME_ROOT", options["docker-shared-home-root"]],
  ["MACOS_TCB_ATTESTATION_SHA256", options["macos-tcb-attestation-sha256"]],
  ["RELEASE_REPOSITORY", options["release-repository"]],
  ["EXPECTED_BRANCH", options["expected-branch"]],
  ["RECONCILIATION_ARTIFACT_HELPER_SHA256", ${JSON.stringify(constants.reconciliation)}],
  ["REHEARSAL_EVIDENCE_MANIFEST_SHA256", options["expected-rehearsal-evidence-manifest-sha256"]],
  ["REHEARSAL_EVIDENCE_DIRECTORY", options["rehearsal-evidence-directory"]],
  ["REHEARSAL_CAPTURE_ID", options["capture-id"]],
  ["REHEARSAL_RESTORE_ID", options["restore-id"]],
  ["REHEARSAL_STAGE_NUMBER", String(${JSON.stringify(versions)}.indexOf(options["through-version"]) + 1)],
  ["REHEARSAL_PRE_STATE_SHA256", rehearsal.preState.stateSha256],
  ["REHEARSAL_POST_STATE_SHA256", rehearsal.postState.stateSha256],
  ["BACKUP_MANIFEST_SHA256", options["expected-backup-manifest-sha256"]],
  ["RESTORE_EVIDENCE_MANIFEST_SHA256", options["expected-restore-evidence-manifest-sha256"]],
  ["SOURCE_MANIFEST_SHA256", options["expected-source-manifest-sha256"]],
  ["SOURCE_FINGERPRINT_SHA256", options["expected-source-fingerprint-sha256"]],
  ["RELATION_SEQUENCE_COUNTS_SHA256", options["expected-relation-sequence-counts-sha256"]],
  ["MIGRATION_HISTORY_SHA256", options["expected-migration-history-sha256"]],
  ["MANAGED_APPLICATION_DDL_SHA256", options["expected-managed-application-ddl-sha256"]],
  ["CAPTURE_TOOLSET_SHA256", options["expected-capture-toolset-sha256"]],
  ["RESTORE_TOOLSET_SHA256", options["expected-restore-toolset-sha256"]],
  ["APPROVED_TOOL_MANIFEST", options["approved-tool-manifest"]],
  ["APPROVED_TOOL_MANIFEST_SHA256", options["approved-tool-manifest-sha256"]],
  ["DUMP_SCRIPT_TRANSFORMER_SHA256", options["dump-script-transformer-sha256"]],
  ["MIGRATION_HISTORY_STATE", options["expected-migration-history-state"]],
  ["SUPABASE_CLI_SHA256", options["supabase-cli-sha256"]],
  ["POSTGRES_IMAGE_ID", options["postgres-image-id"]],
  ["WRITER_QUIESCED_AT", options["writer-quiesced-at"]],
  ["CAPTURE_STARTED_AT", "2026-08-25T19:00:00Z"],
  ["CAPTURED_AT", "2026-08-25T19:00:01Z"],
  ["CURRENT_TIME", "2026-08-25T19:00:02Z"],
  ["CLOCK_SOURCE", "test-only-hashed-override"],
  ["CLOCK_SHA256", ${JSON.stringify(clockSha256)}],
  ["MAX_CAPTURE_AGE_SECONDS", options["max-capture-age-seconds"]],
  ["CAPTURE_DIRECTORY", options.destination + "/capture-fixture"],
  ["RESTORE_DIRECTORY", options.destination + "/restore-fixture"],
  ["RECONCILIATION_STAGE", options["reconciliation-stage"]],
  ["RECONCILIATION_STAGE_MANIFEST_SHA256", options["expected-reconciliation-stage-manifest-sha256"]],
  ["BEFORE_MIGRATION_HISTORY", options["before-migration-history"]],
  ["BEFORE_MIGRATION_HISTORY_SHA256", options["expected-before-migration-history-sha256"]],
];
const material = fields.map(([key, value]) => key + "=" + value).join("\\n") + "\\n";
const digest = createHash("sha256").update(material).digest("hex");
process.stdout.write("TEST_ONLY_RECONCILIATION_PREFLIGHT_SHA256=" + digest + "\\n" + material);
${drift ? `writeFileSync(${JSON.stringify(driftFlag)}, "drift");` : ""}
`);
}

async function makeFixture({
  throughIndex = 0,
  initialApplied = throughIndex,
  drift = false,
  failFinalVolumeAttestation = false,
  clockValues,
  runnerSourceTransform,
} = {}) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "drs-")),
  );
  const release = await copyReleaseRepository(root, { runnerSourceTransform });
  const offlinePgsodiumGetkey = path.join(
    release.scripts,
    "offline-pgsodium-getkey.sh",
  );
  const tools = path.join(root, "tools");
  const destination = path.join(root, "encrypted-evidence");
  const privateDirectory = path.join(destination, "private");
  const stage = path.join(root, `stage-${throughIndex + 1}`);
  await Promise.all([
    mkdir(tools, { recursive: true }),
    mkdir(privateDirectory, { recursive: true, mode: 0o700 }),
  ]);
  await chmod(destination, 0o700);
  await chmod(privateDirectory, 0o700);
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
  execFileSync(nodeBin, [
    path.join(release.scripts, "prepare-reconciliation-stage.mjs"),
    "--output", stage,
    "--release-commit", release.commit,
    "--through-version", versions[throughIndex],
  ]);
  const stateFile = path.join(privateDirectory, "reconciliation-test-state");
  const driftFlag = path.join(root, "drift-after-preflight");
  const boundaryLog = path.join(root, "boundary.jsonl");
  await writeFile(stateFile, String(initialApplied));
  await chmod(stateFile, 0o600);
  await writeFile(boundaryLog, "");
  const clock = await makeClock(path.join(tools, "clock"), clockValues);
  const docker = await makeDocker(
    path.join(tools, "docker"),
    boundaryLog,
    dockerContext,
  );
  const supabase = await makeFakeCli(path.join(tools, "supabase"), stateFile, boundaryLog);
  const volumeHook = await makeVolumeHook(
    path.join(tools, "volume-hook"),
    boundaryLog,
    { failFinal: failFinalVolumeAttestation },
  );
  const sourceHook = await makeDatabaseHook(
    path.join(tools, "source-hook"), "manifest", stateFile, driftFlag, boundaryLog, docker,
  );
  const fingerprintHook = await makeDatabaseHook(
    path.join(tools, "fingerprint-hook"), "fingerprint", stateFile, driftFlag, boundaryLog, docker,
  );
  const relationCountsHook = await makeDatabaseHook(
    path.join(tools, "relation-counts-hook"), "counts", stateFile, driftFlag, boundaryLog, docker,
  );
  const historyHook = await makeDatabaseHook(
    path.join(tools, "history-hook"), "history", stateFile, driftFlag, boundaryLog, docker,
  );
  const effectHook = await makeEffectHook(
    path.join(tools, "effect-hook"),
    boundaryLog,
    docker,
    stateFile,
  );
  const genericTool = await makeGenericTool(path.join(tools, "generic-tool"));
  const operatorPackLauncher = await makeOperatorPackLauncher(
    path.join(tools, "operator-pack-launcher"),
    {
      "effect-verification": effectHook,
      "encrypted-volume-check": volumeHook,
      "migration-history": historyHook,
      "relation-counts": relationCountsHook,
      "source-fingerprint": fingerprintHook,
      "source-manifest": sourceHook,
    },
  );
  const preflight = await makePreflight({
    filename: path.join(tools, "preflight"),
    repositoryScripts: release.scripts,
    clockSha256: await sha256(clock),
    driftFlag,
    drift,
  });
  const sslRootCertDirectory = path.join(destination, "private", "supabase-ca");
  await mkdir(sslRootCertDirectory, { recursive: true, mode: 0o700 });
  const sslRootCert = await privateFile(
    path.join(sslRootCertDirectory, "prod-ca-2021.crt"),
    await testCaPem(),
  );
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
  const creationRecordFile = await privateFile(
    path.join(destination, "encrypted-volume-creation-record.json"),
    canonicalJson(creationRecord),
  );
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
  const encryptedVolumeAttestation = await privateFile(
    path.join(destination, "encrypted-volume-attestation.json"),
    canonicalJson({
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
    }),
  );
  const databaseUrl = await privateFile(
    path.join(privateDirectory, "database-url"),
    `postgresql://postgres.${projectRef}@${databaseHost}:5432/postgres?sslmode=verify-full&sslrootcert=${encodeURIComponent(sslRootCert)}&options=-c%20jit%3Don\n`,
  );
  const databasePassfile = await privateFile(
    path.join(privateDirectory, "database-passfile"),
    `${databaseHost}:5432:postgres:postgres.${projectRef}:${privatePassword}\n`,
  );
  const macosTcbAttestation = await privateFile(
    path.join(privateDirectory, "macos-tcb-attestation.json"),
    canonicalJson({ fixture: true }),
  );
  const macosTcbAttestationSha256 = await sha256(macosTcbAttestation);
  const nodeArchive = await privateFile(
    path.join(privateDirectory, "node-archive.fixture"),
    "offline fixture node archive\n",
  );
  const nodeArchiveSha256 = await sha256(nodeArchive);
  const captureTools = {
    cleanEnvironmentLauncherSha256: await sha256(path.join(release.scripts, "run-production-operator-clean.sh")),
    credentialValidatorSha256: await sha256(path.join(release.scripts, "validate-postgres-credentials.mjs")),
    dockerBinSha256: await sha256(docker),
    dumpScriptTransformerSha256: await sha256(path.join(release.scripts, "prepare-supabase-dump-script.mjs")),
    edgeFunctionsInventoryHookSha256: await sha256(genericTool),
    encryptedVolumeCheckHookSha256: await sha256(volumeHook),
    inputPinningHelperSha256: await sha256(path.join(release.scripts, "pin-production-input.mjs")),
    macosTcbAttestationSha256,
    managedApplicationDdlHookSha256: await sha256(genericTool),
    migrationHistoryHookSha256: await sha256(historyHook),
    nodeBinSha256: await sha256(nodeBin),
    operatorPackCleanEnvironmentLauncherSha256: await sha256(operatorPackLauncher),
    relationCountsHookSha256: await sha256(relationCountsHook),
    sourceFingerprintHookSha256: await sha256(fingerprintHook),
    sourceManifestHookSha256: await sha256(sourceHook),
    storageInventoryHookSha256: await sha256(genericTool),
    supabaseCliSha256: await sha256(supabase),
  };
  const restoreTools = {
    cleanEnvironmentLauncherSha256: captureTools.cleanEnvironmentLauncherSha256,
    dockerBinSha256: captureTools.dockerBinSha256,
    encryptedVolumeCheckHookSha256: captureTools.encryptedVolumeCheckHookSha256,
    inputPinningHelperSha256: captureTools.inputPinningHelperSha256,
    macosTcbAttestationSha256,
    nodeBinSha256: captureTools.nodeBinSha256,
    offlinePgsodiumGetkeySha256: await sha256(offlinePgsodiumGetkey),
    operatorPackCleanEnvironmentLauncherSha256: captureTools.operatorPackCleanEnvironmentLauncherSha256,
    restoreVerificationHookSha256: await sha256(genericTool),
  };
  const approvedBackupTools = await privateFile(
    path.join(privateDirectory, "approved-backup-tools.json"),
    canonicalJson({
      schemaVersion: 2,
      artifactContract: "dominion-production-backup-approved-tools/v2",
      releaseCommit: release.commit,
      dockerSharedHomeRoot: root,
      dockerContext,
      captureTools,
      captureToolsetSha256: sha256Object(captureTools),
      restoreTools,
      restoreToolsetSha256: sha256Object(restoreTools),
    }),
  );

  const planTools = {
    artifactHelperSha256: await sha256(path.join(release.scripts, "production-reconciliation-artifacts.mjs")),
    backupArtifactVerifierSha256: await sha256(path.join(release.scripts, "production-backup-artifacts.mjs")),
    backupEvidenceVerifierSha256: await sha256(path.join(release.scripts, "verify-production-backup-evidence.sh")),
    commonHelperSha256: await sha256(path.join(release.scripts, "production-backup-common.sh")),
    cleanEnvironmentLauncherSha256: await sha256(path.join(release.scripts, "run-production-operator-clean.sh")),
    clockSha256: await sha256(clock),
    credentialValidatorSha256: await sha256(path.join(release.scripts, "validate-postgres-credentials.mjs")),
    dockerBinSha256: await sha256(docker),
    dumpScriptTransformerSha256: await sha256(path.join(release.scripts, "prepare-supabase-dump-script.mjs")),
    effectVerificationHookSha256: await sha256(effectHook),
    encryptedVolumeCheckHookSha256: await sha256(volumeHook),
    gitBinSha256: await sha256(gitBin),
    historyVerifierSha256: await sha256(path.join(release.scripts, "verify-reconciliation-history.mjs")),
    inputPinningHelperSha256: await sha256(path.join(release.scripts, "pin-production-input.mjs")),
    manifestValidatorSha256: await sha256(path.join(release.scripts, "compare-database-manifests.mjs")),
    migrationHistoryHookSha256: await sha256(historyHook),
    nodeBinSha256: await sha256(nodeBin),
    preflightSha256: await sha256(preflight),
    relationCountsHookSha256: await sha256(relationCountsHook),
    runnerSha256: await sha256(path.join(release.scripts, "run-production-reconciliation-step.sh")),
    sourceFingerprintHookSha256: await sha256(fingerprintHook),
    sourceManifestHookSha256: await sha256(sourceHook),
    stageVerifierSha256: await sha256(path.join(release.scripts, "prepare-reconciliation-stage.mjs")),
    supabaseCliSha256: await sha256(supabase),
  };
  const previousCompletionSha256 = throughIndex === 0 ? zeroHash : "f".repeat(64);
  const backupEvidence = {
    backupManifestSha256: "1".repeat(64),
    captureToolsetSha256: sha256Object(captureTools),
    databaseHost,
    dockerContext,
    dockerSharedHomeRoot: root,
    encryptedVolumeAttestationSha256: await sha256(encryptedVolumeAttestation),
    macosTcbAttestationSha256,
    managedApplicationDdlSha256: "5".repeat(64),
    maxCaptureAgeSeconds: 600,
    migrationHistorySha256: "4".repeat(64),
    migrationHistoryState: "absent",
    postgresImageId,
    relationSequenceCountsSha256: sha256Bytes(relationCountsText(0)),
    restoreEvidenceManifestSha256: "2".repeat(64),
    restoreToolsetSha256: sha256Object(restoreTools),
    sslRootCertSha256: await sha256(sslRootCert),
    sslRootCertRelativePath: "private/supabase-ca/prod-ca-2021.crt",
    sourceFingerprintSha256: sha256Bytes(fingerprintText(0)),
    sourceManifestSha256: sha256Bytes(manifestText(0)),
    writerQuiescedAt: "2026-08-25T18:59:59Z",
  };
  const expectedPre = {
    relationSequenceCountsSha256: sha256Bytes(relationCountsText(initialApplied)),
    sourceFingerprintSha256: sha256Bytes(fingerprintText(initialApplied)),
    sourceManifestSha256: sha256Bytes(manifestText(initialApplied)),
  };
  const expectedPost = {
    effectVerificationSha256: sha256Bytes(effectText(versions[throughIndex])),
    relationSequenceCountsSha256: sha256Bytes(relationCountsText(initialApplied + 1)),
    sourceFingerprintSha256: sha256Bytes(fingerprintText(initialApplied + 1)),
    sourceManifestSha256: sha256Bytes(manifestText(initialApplied + 1)),
  };
  const rehearsalEvidenceDirectory = path.join(
    destination,
    `rehearsal-evidence-${throughIndex + 1}`,
  );
  await mkdir(rehearsalEvidenceDirectory, { mode: 0o700 });
  const rehearsalArtifacts = {
    "effect-verification.json": effectText(versions[throughIndex]),
    "post-relation-sequence-counts.json": relationCountsText(initialApplied + 1),
    "post-source-fingerprint.jsonl": fingerprintText(initialApplied + 1),
    "post-source-manifest.jsonl": manifestText(initialApplied + 1),
    "pre-relation-sequence-counts.json": relationCountsText(initialApplied),
    "pre-source-fingerprint.jsonl": fingerprintText(initialApplied),
    "pre-source-manifest.jsonl": manifestText(initialApplied),
  };
  for (const [name, contents] of Object.entries(rehearsalArtifacts)) {
    await privateFile(path.join(rehearsalEvidenceDirectory, name), contents);
  }
  const rehearsalArtifactHashes = Object.fromEntries(
    Object.entries(rehearsalArtifacts).map(([name, contents]) => [name, sha256Bytes(contents)]),
  );
  const rehearsalPreState = { ...expectedPre, stateSha256: stateSha256(expectedPre) };
  const rehearsalPostState = { ...expectedPost, stateSha256: stateSha256(expectedPost) };
  const rehearsalTools = {
    cleanEnvironmentLauncherSha256: await sha256(operatorPackLauncher),
    dockerBinSha256: await sha256(docker),
    effectVerificationHookSha256: await sha256(effectHook),
    encryptedVolumeCheckHookSha256: await sha256(volumeHook),
    inputPinningHelperSha256: await sha256(
      path.join(release.scripts, "pin-production-input.mjs"),
    ),
    macosTcbAttestationSha256,
    nodeBinSha256: await sha256(nodeBin),
    offlinePgsodiumGetkeySha256: await sha256(offlinePgsodiumGetkey),
    operatorDispatcherSha256: await sha256(genericTool),
    operatorSqlSha256: await sha256(genericTool),
    rehearsalDriverSha256: await sha256(genericTool),
    rehearsalWrapperSha256: await sha256(genericTool),
    stageVerifierSha256: await sha256(path.join(release.scripts, "prepare-reconciliation-stage.mjs")),
  };
  const previousRehearsalEvidenceManifestSha256 = throughIndex === 0
    ? zeroHash
    : "d".repeat(64);
  const previousPostStateSha256 = throughIndex === 0 ? zeroHash : "e".repeat(64);
  await privateFile(
    path.join(rehearsalEvidenceDirectory, "rehearsal-evidence.json"),
    canonicalJson({
      schemaVersion: 2,
      artifactContract: "dominion-production-reconciliation-rehearsal-evidence/v2",
      databaseClientContract: "exact-network-none-restored-capture/v1",
      dockerContext,
      dockerSharedHomeRoot: root,
      projectRef,
      expectedBranch: "main",
      releaseCommit: release.commit,
      releaseRepository: release.repository,
      throughVersion: versions[throughIndex],
      stageNumber: throughIndex + 1,
      includedVersions: versions.slice(0, throughIndex + 1),
      captureId: "capture-fixture",
      restoreId: "restore-fixture",
      previousRehearsalEvidenceManifestSha256,
      previousPostStateSha256,
      backupEvidence,
      approvedBackupToolManifestSha256: await sha256(approvedBackupTools),
      reconciliationStageManifestSha256: await sha256(path.join(stage, "reconciliation-stage.json")),
      postgres: { image: postgresImage, imageId: postgresImageId, serverVersionNum: 170006 },
      supabaseCli: { version: "2.109.0", sha256: await sha256(supabase) },
      tools: rehearsalTools,
      artifacts: rehearsalArtifactHashes,
      preState: rehearsalPreState,
      postState: rehearsalPostState,
    }),
  );
  const rehearsalEvidenceManifestSha256 = await sha256(
    path.join(rehearsalEvidenceDirectory, "rehearsal-evidence.json"),
  );
  const plan = {
    schemaVersion: 2,
    artifactContract: "dominion-production-reconciliation-plan/v2",
    databaseClientContract: "exact-supavisor-session-jit-pgpass-verify-full/v2",
    databaseHost,
    dockerContext,
    dockerSharedHomeRoot: root,
    macosTcbAttestationSha256,
    projectRef,
    expectedBranch: "main",
    releaseCommit: release.commit,
    releaseRepository: release.repository,
    throughVersion: versions[throughIndex],
    tls: {
      rootCertRelativePath: "private/supabase-ca/prod-ca-2021.crt",
      rootCertSha256: await sha256(sslRootCert),
      sslMode: "verify-full",
    },
    previousCompletionSha256,
    backupEvidence,
    expectedPre,
    expectedPost,
    approvedBackupToolManifestSha256: await sha256(approvedBackupTools),
    reconciliationStageManifestSha256: await sha256(path.join(stage, "reconciliation-stage.json")),
    rehearsalEvidence: {
      captureId: "capture-fixture",
      includedVersions: versions.slice(0, throughIndex + 1),
      manifestSha256: rehearsalEvidenceManifestSha256,
      postStateSha256: rehearsalPostState.stateSha256,
      preStateSha256: rehearsalPreState.stateSha256,
      previousManifestSha256: previousRehearsalEvidenceManifestSha256,
      previousPostStateSha256,
      restoreId: "restore-fixture",
      stageNumber: throughIndex + 1,
    },
    tools: planTools,
  };
  const planFile = await privateFile(path.join(privateDirectory, "approved-plan.json"), canonicalJson(plan));
  const planSha256 = await sha256(planFile);
  const preflightArguments = [
    "--destination", destination,
    "--capture-id", "capture-fixture",
    "--restore-id", "restore-fixture",
    "--project-ref", projectRef,
    "--database-host", databaseHost,
    "--ssl-root-cert-sha256", await sha256(sslRootCert),
    "--expected-branch", "main",
    "--expected-commit", release.commit,
    "--supabase-cli", supabase,
    "--supabase-cli-sha256", planTools.supabaseCliSha256,
    "--postgres-image", postgresImage,
    "--postgres-image-id", postgresImageId,
    "--encrypted-volume-attestation", encryptedVolumeAttestation,
    "--encrypted-volume-attestation-sha256", await sha256(encryptedVolumeAttestation),
    "--encrypted-volume-check-hook", volumeHook,
    "--encrypted-volume-check-hook-sha256", planTools.encryptedVolumeCheckHookSha256,
    "--edge-functions-inventory-hook", genericTool,
    "--edge-functions-inventory-hook-sha256", await sha256(genericTool),
    "--storage-inventory-hook", genericTool,
    "--storage-inventory-hook-sha256", await sha256(genericTool),
    "--source-manifest-hook", sourceHook,
    "--source-manifest-hook-sha256", planTools.sourceManifestHookSha256,
    "--source-fingerprint-hook", fingerprintHook,
    "--source-fingerprint-hook-sha256", planTools.sourceFingerprintHookSha256,
    "--relation-counts-hook", relationCountsHook,
    "--relation-counts-hook-sha256", planTools.relationCountsHookSha256,
    "--migration-history-hook", historyHook,
    "--migration-history-hook-sha256", planTools.migrationHistoryHookSha256,
    "--managed-application-ddl-hook", genericTool,
    "--managed-application-ddl-hook-sha256", await sha256(genericTool),
    "--credential-validator-sha256", planTools.credentialValidatorSha256,
    "--dump-script-transformer-sha256", planTools.dumpScriptTransformerSha256,
    "--docker-bin", docker,
    "--docker-bin-sha256", planTools.dockerBinSha256,
    "--docker-socket", dockerContext.socketPath,
    "--docker-socket-device", dockerContext.device,
    "--docker-socket-inode", dockerContext.inode,
    "--docker-socket-owner-uid", String(dockerContext.ownerUid),
    "--docker-socket-owner-mode", String(dockerContext.ownerMode),
    "--docker-shared-home-root", root,
    "--operator-pack-clean-environment-launcher", operatorPackLauncher,
    "--macos-tcb-attestation", macosTcbAttestation,
    "--macos-tcb-attestation-sha256", macosTcbAttestationSha256,
    "--release-repository", release.repository,
    "--offline-pgsodium-getkey", offlinePgsodiumGetkey,
    "--offline-pgsodium-getkey-sha256", await sha256(offlinePgsodiumGetkey),
    "--restore-verification-hook", genericTool,
    "--restore-verification-hook-sha256", await sha256(genericTool),
    "--approved-tool-manifest", approvedBackupTools,
    "--approved-tool-manifest-sha256", plan.approvedBackupToolManifestSha256,
    "--expected-backup-manifest-sha256", plan.backupEvidence.backupManifestSha256,
    "--expected-restore-evidence-manifest-sha256", plan.backupEvidence.restoreEvidenceManifestSha256,
    "--expected-source-manifest-sha256", plan.backupEvidence.sourceManifestSha256,
    "--expected-source-fingerprint-sha256", plan.backupEvidence.sourceFingerprintSha256,
    "--expected-relation-sequence-counts-sha256", plan.backupEvidence.relationSequenceCountsSha256,
    "--expected-migration-history-sha256", plan.backupEvidence.migrationHistorySha256,
    "--expected-managed-application-ddl-sha256", plan.backupEvidence.managedApplicationDdlSha256,
    "--expected-capture-toolset-sha256", plan.backupEvidence.captureToolsetSha256,
    "--expected-restore-toolset-sha256", plan.backupEvidence.restoreToolsetSha256,
    "--expected-migration-history-state", plan.backupEvidence.migrationHistoryState,
    "--writer-quiesced-at", plan.backupEvidence.writerQuiescedAt,
    "--max-capture-age-seconds", String(plan.backupEvidence.maxCaptureAgeSeconds),
    "--release-commit", release.commit,
    "--through-version", versions[throughIndex],
    "--rehearsal-evidence-directory", rehearsalEvidenceDirectory,
    "--expected-rehearsal-evidence-manifest-sha256", rehearsalEvidenceManifestSha256,
    "--reconciliation-stage", stage,
    "--expected-reconciliation-stage-manifest-sha256", plan.reconciliationStageManifestSha256,
  ];
  return {
    ...release,
    approvedBackupTools,
    boundaryLog,
    clock,
    databasePassfile,
    databaseUrl,
    destination,
    docker,
    dockerContext,
    dockerSocketServer,
    driftFlag,
    effectHook,
    encryptedVolumeAttestation,
    fingerprintHook,
    genericTool,
    historyHook,
    macosTcbAttestation,
    macosTcbAttestationSha256,
    nodeArchive,
    nodeArchiveSha256,
    operatorPackLauncher,
    operatorPackLauncherSha256: await sha256(operatorPackLauncher),
    plan,
    planTools,
    planFile,
    planSha256,
    preflight,
    preflightArguments,
    privateDirectory,
    root,
    relationCountsHook,
    rehearsalEvidenceDirectory,
    rehearsalEvidenceManifestSha256,
    stage,
    stateFile,
    sourceHook,
    sslRootCert,
    supabase,
    volumeHook,
  };
}

async function cleanupFixture(fixture) {
  await new Promise((resolve) => fixture.dockerSocketServer.close(resolve));
  await makeTreeOwnerWritable(fixture.root);
  await rm(fixture.root, { force: true, recursive: true });
}

async function makeTreeOwnerWritable(root) {
  let metadata;
  try {
    metadata = await lstat(root);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (metadata.isSymbolicLink()) return;
  if (!metadata.isDirectory()) {
    await chmod(root, 0o600);
    return;
  }
  await chmod(root, 0o700);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    await makeTreeOwnerWritable(path.join(root, entry.name));
  }
}

function replaceOption(argumentsList, flag, value) {
  const result = [...argumentsList];
  const index = result.indexOf(flag);
  assert.notEqual(index, -1, flag);
  result[index + 1] = value;
  return result;
}

async function makeStagePlan(fixture, throughIndex, previousCompletionSha256) {
  const stage = path.join(
    fixture.destination,
    `stage-${throughIndex + 1}-${previousCompletionSha256.slice(0, 8)}`,
  );
  execFileSync(nodeBin, [
    path.join(fixture.scripts, "prepare-reconciliation-stage.mjs"),
    "--output", stage,
    "--release-commit", fixture.commit,
    "--through-version", versions[throughIndex],
  ]);
  const plan = structuredClone(fixture.plan);
  plan.throughVersion = versions[throughIndex];
  plan.previousCompletionSha256 = previousCompletionSha256;
  plan.expectedPre = {
    relationSequenceCountsSha256: sha256Bytes(relationCountsText(throughIndex)),
    sourceFingerprintSha256: sha256Bytes(fingerprintText(throughIndex)),
    sourceManifestSha256: sha256Bytes(manifestText(throughIndex)),
  };
  plan.expectedPost = {
    effectVerificationSha256: sha256Bytes(effectText(versions[throughIndex])),
    relationSequenceCountsSha256: sha256Bytes(relationCountsText(throughIndex + 1)),
    sourceFingerprintSha256: sha256Bytes(fingerprintText(throughIndex + 1)),
    sourceManifestSha256: sha256Bytes(manifestText(throughIndex + 1)),
  };
  plan.reconciliationStageManifestSha256 = await sha256(
    path.join(stage, "reconciliation-stage.json"),
  );
  const rehearsalEvidenceDirectory = path.join(
    fixture.destination,
    `rehearsal-evidence-${throughIndex + 1}-${previousCompletionSha256.slice(0, 8)}`,
  );
  await mkdir(rehearsalEvidenceDirectory, { mode: 0o700 });
  const rehearsalArtifacts = {
    "effect-verification.json": effectText(versions[throughIndex]),
    "post-relation-sequence-counts.json": relationCountsText(throughIndex + 1),
    "post-source-fingerprint.jsonl": fingerprintText(throughIndex + 1),
    "post-source-manifest.jsonl": manifestText(throughIndex + 1),
    "pre-relation-sequence-counts.json": relationCountsText(throughIndex),
    "pre-source-fingerprint.jsonl": fingerprintText(throughIndex),
    "pre-source-manifest.jsonl": manifestText(throughIndex),
  };
  for (const [name, contents] of Object.entries(rehearsalArtifacts)) {
    await privateFile(path.join(rehearsalEvidenceDirectory, name), contents);
  }
  const rehearsalArtifactHashes = Object.fromEntries(
    Object.entries(rehearsalArtifacts).map(([name, contents]) => [name, sha256Bytes(contents)]),
  );
  const priorEvidence = JSON.parse(await readFile(
    path.join(fixture.rehearsalEvidenceDirectory, "rehearsal-evidence.json"),
    "utf8",
  ));
  const rehearsalPreState = { ...plan.expectedPre, stateSha256: stateSha256(plan.expectedPre) };
  const rehearsalPostState = { ...plan.expectedPost, stateSha256: stateSha256(plan.expectedPost) };
  const evidenceManifest = {
    ...priorEvidence,
    throughVersion: versions[throughIndex],
    stageNumber: throughIndex + 1,
    includedVersions: versions.slice(0, throughIndex + 1),
    previousRehearsalEvidenceManifestSha256: fixture.rehearsalEvidenceManifestSha256,
    previousPostStateSha256: fixture.plan.rehearsalEvidence.postStateSha256,
    reconciliationStageManifestSha256: plan.reconciliationStageManifestSha256,
    artifacts: rehearsalArtifactHashes,
    preState: rehearsalPreState,
    postState: rehearsalPostState,
  };
  await privateFile(
    path.join(rehearsalEvidenceDirectory, "rehearsal-evidence.json"),
    canonicalJson(evidenceManifest),
  );
  const rehearsalEvidenceManifestSha256 = await sha256(
    path.join(rehearsalEvidenceDirectory, "rehearsal-evidence.json"),
  );
  plan.rehearsalEvidence = {
    captureId: evidenceManifest.captureId,
    includedVersions: evidenceManifest.includedVersions,
    manifestSha256: rehearsalEvidenceManifestSha256,
    postStateSha256: rehearsalPostState.stateSha256,
    preStateSha256: rehearsalPreState.stateSha256,
    previousManifestSha256: evidenceManifest.previousRehearsalEvidenceManifestSha256,
    previousPostStateSha256: evidenceManifest.previousPostStateSha256,
    restoreId: evidenceManifest.restoreId,
    stageNumber: evidenceManifest.stageNumber,
  };
  const planFile = await privateFile(
    path.join(fixture.privateDirectory, `approved-plan-${throughIndex + 1}-${previousCompletionSha256.slice(0, 8)}.json`),
    canonicalJson(plan),
  );
  const planSha256 = await sha256(planFile);
  let preflightArguments = replaceOption(
    fixture.preflightArguments,
    "--through-version",
    versions[throughIndex],
  );
  preflightArguments = replaceOption(preflightArguments, "--reconciliation-stage", stage);
  preflightArguments = replaceOption(
    preflightArguments,
    "--rehearsal-evidence-directory",
    rehearsalEvidenceDirectory,
  );
  preflightArguments = replaceOption(
    preflightArguments,
    "--expected-rehearsal-evidence-manifest-sha256",
    rehearsalEvidenceManifestSha256,
  );
  preflightArguments = replaceOption(
    preflightArguments,
    "--expected-reconciliation-stage-manifest-sha256",
    plan.reconciliationStageManifestSha256,
  );
  return {
    plan,
    planFile,
    planSha256,
    preflightArguments,
    rehearsalEvidenceDirectory,
    rehearsalEvidenceManifestSha256,
    stage,
  };
}

function runStep(
  fixture,
  {
    bundle = fixture,
    reconciliationId = "stage-one-fixture",
    previousCompletionEvidence = "genesis",
    leadingSeparator = true,
    ambientEnvironment = {},
  } = {},
) {
  const runner = path.join(fixture.scripts, "run-production-reconciliation-step.sh");
  const args = [
    ...(leadingSeparator ? ["--"] : []),
    "--reconciliation-id", reconciliationId,
    "--database-url-file", fixture.databaseUrl,
    "--database-url-file-sha256", sha256Bytes(execFileSync("/bin/cat", [fixture.databaseUrl])),
    "--database-passfile", fixture.databasePassfile,
    "--database-passfile-sha256", sha256Bytes(execFileSync("/bin/cat", [fixture.databasePassfile])),
    "--ssl-root-cert-file", fixture.sslRootCert,
    "--ssl-root-cert-file-sha256", sha256Bytes(
      execFileSync("/bin/cat", [fixture.sslRootCert]),
    ),
    "--previous-completion-evidence", previousCompletionEvidence,
    "--approved-reconciliation-plan", bundle.planFile,
    "--approved-reconciliation-plan-sha256", bundle.planSha256,
    "--effect-verification-hook", fixture.effectHook,
    "--confirm-one-version",
    `${fixture.commit}:${bundle.plan.throughVersion}:${bundle.planSha256}`,
    "--",
    ...bundle.preflightArguments,
  ];
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    PRODUCTION_RECONCILIATION_STEP_TEST_MODE: "offline-fixture-only",
    PRODUCTION_RECONCILIATION_STEP_TEST_PREFLIGHT_BIN: fixture.preflight,
    PRODUCTION_RECONCILIATION_STEP_TEST_CLOCK_BIN: fixture.clock,
    PRODUCTION_RECONCILIATION_STEP_TEST_STATE_FILE: fixture.stateFile,
    RECONCILIATION_AMBIENT_CANARY: "must-not-reach-reviewed-hooks",
    DOMINION_CLEAN_ENV_LAUNCHER: "dominion-production-operator/v1",
    DOMINION_CLEAN_ENV_LAUNCHER_PATH: path.join(
      fixture.scripts,
      "run-production-operator-clean.sh",
    ),
    DOMINION_CLEAN_ENV_LAUNCHER_SHA256: fixture.planTools.cleanEnvironmentLauncherSha256,
    DOMINION_ENTRYPOINT_SHA256: fixture.planTools.cleanEnvironmentLauncherSha256,
    DOMINION_MACOS_TCB_ATTESTATION_SHA256: fixture.macosTcbAttestationSha256,
    DOMINION_OPERATOR_PACK_LAUNCHER_SHA256: fixture.operatorPackLauncherSha256,
    DOMINION_RELEASE_COMMIT: fixture.commit,
    DOMINION_RELEASE_REPOSITORY: fixture.repository,
    DOMINION_REPOSITORY_OPERATION: "reconcile",
    DOMINION_REPOSITORY_OPERATOR_CHILD: "dominion-repository-operator-clean/v1",
    NODE_BIN: nodeBin,
    NODE_BIN_SHA256: fixture.planTools.nodeBinSha256,
    NODE_ARCHIVE: fixture.nodeArchive,
    NODE_ARCHIVE_SHA256: fixture.nodeArchiveSha256,
    ...ambientEnvironment,
  };
  return spawnSync(runner, args, {
    cwd: fixture.repository,
    encoding: "utf8",
    env,
    maxBuffer: 20 * 1024 * 1024,
    timeout: 120_000,
  });
}

async function runnerFailureRuntimes(fixture) {
  return (await readdir(fixture.privateDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()
      && entry.name.startsWith("dominion-production-reconciliation-step."))
    .map((entry) => path.join(fixture.privateDirectory, entry.name));
}

async function assertPathAbsent(filename) {
  await assert.rejects(lstat(filename), { code: "ENOENT" });
}

function stdoutField(stdout, key) {
  const line = stdout.split("\n").find((candidate) => candidate.startsWith(`${key}=`));
  assert.ok(line, `${key}: ${stdout}`);
  return line.slice(key.length + 1);
}

function verifyCompletion(fixture, evidenceDirectory, completionSha256) {
  return spawnSync(nodeBin, [
    path.join(fixture.scripts, "production-reconciliation-artifacts.mjs"),
    "verify-test-only-completion",
    "--evidence-directory", evidenceDirectory,
    "--phase", "complete",
    "--completion-sha256", completionSha256,
    "--project-ref", projectRef,
    "--release-commit", fixture.commit,
    "--through-version", fixture.plan.throughVersion,
    "--approved-plan-sha256", fixture.planSha256,
  ], { encoding: "utf8" });
}

async function rewrapCompletionEvidence(
  evidenceDirectory,
  { changedArtifacts = [], mutateManifest = () => {} } = {},
) {
  const manifestPath = path.join(evidenceDirectory, "reconciliation.json");
  const markerPath = path.join(evidenceDirectory, "RECONCILIATION_COMPLETE.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  for (const name of changedArtifacts) {
    manifest.artifacts[name] = await sha256(path.join(evidenceDirectory, name));
  }
  mutateManifest(manifest);
  await writeFile(manifestPath, canonicalJson(manifest));
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  marker.reconciliationManifestSha256 = await sha256(manifestPath);
  await writeFile(markerPath, canonicalJson(marker));
  return sha256(markerPath);
}

async function rewritePreflightField(filename, key, value) {
  const lines = (await readFile(filename, "utf8")).trimEnd().split("\n");
  const index = lines.findIndex((line) => line.startsWith(`${key}=`));
  assert.notEqual(index, -1, key);
  lines[index] = `${key}=${value}`;
  const material = `${lines.slice(1).join("\n")}\n`;
  const digest = sha256Bytes(material);
  const identityKey = lines[0].slice(0, lines[0].indexOf("="));
  lines[0] = `${identityKey}=${digest}`;
  await writeFile(filename, `${lines.join("\n")}\n`);
  return digest;
}

test("deterministically prepares the reviewed stage plan from exact local rehearsal artifacts", async (t) => {
  const fixture = await makeFixture();
  t.after(() => cleanupFixture(fixture));
  const preManifest = await privateFile(
    path.join(fixture.privateDirectory, "rehearsal-pre-manifest.jsonl"),
    manifestText(0),
  );
  const preFingerprint = await privateFile(
    path.join(fixture.privateDirectory, "rehearsal-pre-fingerprint.jsonl"),
    fingerprintText(0),
  );
  const postManifest = await privateFile(
    path.join(fixture.privateDirectory, "rehearsal-post-manifest.jsonl"),
    manifestText(1),
  );
  const postFingerprint = await privateFile(
    path.join(fixture.privateDirectory, "rehearsal-post-fingerprint.jsonl"),
    fingerprintText(1),
  );
  const effect = await privateFile(
    path.join(fixture.privateDirectory, "rehearsal-effect.json"),
    effectText(versions[0]),
  );
  const fixed = (name) => path.join(fixture.scripts, name);
  const toolPaths = {
    artifactHelperSha256: fixed("production-reconciliation-artifacts.mjs"),
    backupArtifactVerifierSha256: fixed("production-backup-artifacts.mjs"),
    backupEvidenceVerifierSha256: fixed("verify-production-backup-evidence.sh"),
    commonHelperSha256: fixed("production-backup-common.sh"),
    cleanEnvironmentLauncherSha256: fixed("run-production-operator-clean.sh"),
    clockSha256: fixture.clock,
    credentialValidatorSha256: fixed("validate-postgres-credentials.mjs"),
    dockerBinSha256: fixture.docker,
    dumpScriptTransformerSha256: fixed("prepare-supabase-dump-script.mjs"),
    effectVerificationHookSha256: fixture.effectHook,
    encryptedVolumeCheckHookSha256: fixture.volumeHook,
    gitBinSha256: gitBin,
    historyVerifierSha256: fixed("verify-reconciliation-history.mjs"),
    inputPinningHelperSha256: fixed("pin-production-input.mjs"),
    manifestValidatorSha256: fixed("compare-database-manifests.mjs"),
    migrationHistoryHookSha256: fixture.historyHook,
    nodeBinSha256: nodeBin,
    preflightSha256: fixture.preflight,
    relationCountsHookSha256: fixture.relationCountsHook,
    runnerSha256: fixed("run-production-reconciliation-step.sh"),
    sourceFingerprintHookSha256: fixture.fingerprintHook,
    sourceManifestHookSha256: fixture.sourceHook,
    stageVerifierSha256: fixed("prepare-reconciliation-stage.mjs"),
    supabaseCliSha256: fixture.supabase,
  };
  const contract = {
    schemaVersion: 2,
    artifactContract: "dominion-production-reconciliation-local-rehearsal/v2",
    databaseClientContract: "exact-supavisor-session-jit-pgpass-verify-full/v2",
    databaseHost,
    projectRef,
    expectedBranch: "main",
    releaseCommit: fixture.commit,
    releaseRepository: fixture.repository,
    macosTcbAttestation: fixture.macosTcbAttestation,
    macosTcbAttestationSha256: fixture.macosTcbAttestationSha256,
    throughVersion: versions[0],
    previousCompletionSha256: zeroHash,
    backupEvidence: fixture.plan.backupEvidence,
    rehearsalEvidenceDirectory: fixture.rehearsalEvidenceDirectory,
    previousRehearsalEvidenceDirectory: "genesis",
    rehearsalSupabaseCli: fixture.supabase,
    rehearsalToolPaths: {
      cleanEnvironmentLauncherSha256: fixture.operatorPackLauncher,
      dockerBinSha256: fixture.docker,
      effectVerificationHookSha256: fixture.effectHook,
      encryptedVolumeCheckHookSha256: fixture.volumeHook,
      inputPinningHelperSha256: fixed("pin-production-input.mjs"),
      nodeBinSha256: nodeBin,
      offlinePgsodiumGetkeySha256: fixed("offline-pgsodium-getkey.sh"),
      operatorDispatcherSha256: fixture.genericTool,
      operatorSqlSha256: fixture.genericTool,
      rehearsalDriverSha256: fixture.genericTool,
      rehearsalWrapperSha256: fixture.genericTool,
      stageVerifierSha256: fixed("prepare-reconciliation-stage.mjs"),
    },
    approvedBackupToolManifest: fixture.approvedBackupTools,
    reconciliationStage: fixture.stage,
    tls: fixture.plan.tls,
    toolPaths,
  };
  const contractFile = await privateFile(
    path.join(fixture.privateDirectory, "rehearsal-contract.json"),
    canonicalJson(contract),
  );
  const outputs = [path.join(fixture.root, "prepared-plan-one.json"), path.join(fixture.root, "prepared-plan-two.json")];
  const digests = [];
  for (const output of outputs) {
    const result = spawnSync(nodeBin, [
      fixed("production-reconciliation-artifacts.mjs"),
      "prepare-plan",
      "--",
      "--rehearsal-contract", contractFile,
      "--output", output,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    digests.push(stdoutField(result.stdout, "APPROVED_RECONCILIATION_PLAN_SHA256"));
    assert.equal(stdoutField(result.stdout, "REHEARSAL_CONTRACT_SHA256"), await sha256(contractFile));
  }
  assert.equal(digests[0], digests[1]);
  assert.equal(await sha256(outputs[0]), digests[0]);
  assert.deepEqual(JSON.parse(await readFile(outputs[0], "utf8")), fixture.plan);
});

test("approved-plan bootstrap rejects an atomic path swap after its handle read", async (t) => {
  const fixture = await makeFixture();
  t.after(() => cleanupFixture(fixture));
  const runner = path.join(
    fixture.scripts,
    "run-production-reconciliation-step.sh",
  );
  const raceBoundary = `// Deterministic tests replace only this comment in a private fixture copy to
// atomically swap the caller path after the handle read.`;
  const runnerSource = await readFile(runner, "utf8");
  assert.ok(runnerSource.includes(raceBoundary));
  await writeFile(
    runner,
    runnerSource.replace(
      raceBoundary,
      `require("node:fs").renameSync(
  process.env.RECONCILIATION_PLAN_SWAP_FIXTURE,
  planPath,
);`,
    ),
  );
  await chmod(runner, 0o700);

  const plan = structuredClone(fixture.plan);
  plan.tools.runnerSha256 = await sha256(runner);
  await writeFile(fixture.planFile, canonicalJson(plan));
  await chmod(fixture.planFile, 0o600);
  const replacement = await privateFile(
    path.join(fixture.privateDirectory, "approved-plan-swap.json"),
    canonicalJson(plan),
  );
  const bundle = {
    ...fixture,
    plan,
    planFile: fixture.planFile,
    planSha256: await sha256(fixture.planFile),
  };
  const result = runStep(fixture, {
    bundle,
    reconciliationId: "plan-path-swap-fixture",
    ambientEnvironment: {
      RECONCILIATION_PLAN_SWAP_FIXTURE: replacement,
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /approved reconciliation plan bootstrap validation failed/u);
  assert.equal(await readFile(fixture.boundaryLog, "utf8"), "");
  assert.equal(await readFile(fixture.stateFile, "utf8"), "0");
});

test("failed operator-pack calls preserve every failed launcher HOME", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pack-runtime-")));
  t.after(async () => {
    await makeTreeOwnerWritable(root);
    await rm(root, { force: true, recursive: true });
  });
  const runtimeParent = path.join(root, "runtime");
  await mkdir(runtimeParent, { mode: 0o700 });
  const tcb = await privateFile(path.join(root, "tcb.json"), "{}\n");
  const evidence = path.join(root, "nonsecret-evidence.txt");
  const launcher = await executable(path.join(root, "pack-launcher"), `#!${nodeBin}
const { writeFileSync } = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const runtime = args[args.indexOf("--runtime-directory") + 1];
const separator = args.indexOf("--");
const outputFlag = args.indexOf("--fixture-evidence", separator + 1);
writeFileSync(args[outputFlag + 1], "nonsecret evidence retained\\n", { mode: 0o600 });
if (process.env.FAKE_PACK_PRESERVE_AUTHORITY === "1") {
  writeFileSync(path.join(runtime, "container-recovery.json"), "{\\"status\\":\\"unresolved\\"}\\n", { mode: 0o600 });
}
process.exit(73);
`);
  const common = path.join(sourceScripts, "production-backup-common.sh");
  const launcherSha256 = await sha256(launcher);
  const tcbSha256 = await sha256(tcb);
  const nodeSha256 = await sha256(nodeBin);
  const invoke = (extraEnvironment = {}) => spawnSync("/bin/bash", [
    "--noprofile", "--norc", "-c", `
source "$1"
production_backup_run_operator_pack_entrypoint \\
  "$2" "$3" fixture "$4" "$5" "$6" "$7" \\
  --fixture-evidence "$8"
`, "fixture", common, launcher, launcherSha256, "a".repeat(64),
    runtimeParent, tcb, tcbSha256, evidence,
  ], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      NODE_BIN: nodeBin,
      NODE_BIN_SHA256: nodeSha256,
      NODE_ARCHIVE: tcb,
      NODE_ARCHIVE_SHA256: tcbSha256,
      DOMINION_OPERATOR_PACK_LAUNCHER_SHA256: launcherSha256,
      ...extraEnvironment,
    },
  });

  let result = invoke();
  assert.equal(result.status, 73, result.stderr);
  assert.match(result.stderr, /preserved failed operator-pack runtime/u);
  let retained = await readdir(runtimeParent);
  assert.equal(retained.length, 1);
  assert.deepEqual(await readdir(path.join(runtimeParent, retained[0])), []);
  assert.equal(await readFile(evidence, "utf8"), "nonsecret evidence retained\n");
  await rm(path.join(runtimeParent, retained[0]), { force: true, recursive: true });

  result = invoke({ FAKE_PACK_PRESERVE_AUTHORITY: "1" });
  assert.equal(result.status, 73, result.stderr);
  assert.match(result.stderr, /preserved failed operator-pack runtime/u);
  retained = await readdir(runtimeParent);
  assert.equal(retained.length, 1);
  assert.equal(
    JSON.parse(await readFile(
      path.join(runtimeParent, retained[0], "container-recovery.json"),
      "utf8",
    )).status,
    "unresolved",
  );
});

test("successful operator-pack cleanup fails closed when the runtime remains", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pack-success-cleanup-")));
  t.after(async () => {
    await makeTreeOwnerWritable(root);
    await rm(root, { force: true, recursive: true });
  });
  const runtimeParent = path.join(root, "runtime");
  await mkdir(runtimeParent, { mode: 0o700 });
  const tcb = await privateFile(path.join(root, "tcb.json"), "{}\n");
  const evidence = path.join(root, "nonsecret-evidence.txt");
  const launcher = await executable(path.join(root, "pack-launcher"), `#!${nodeBin}
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const separator = args.indexOf("--");
const outputFlag = args.indexOf("--fixture-evidence", separator + 1);
writeFileSync(args[outputFlag + 1], "nonsecret evidence retained\\n", { mode: 0o600 });
process.exit(0);
`);
  const commonSource = await readFile(
    path.join(sourceScripts, "production-backup-common.sh"),
    "utf8",
  );
  const removalLine = '    if ! /bin/rm -rf -- "$production_backup_pack_runtime"; then';
  assert.ok(commonSource.includes(removalLine));
  const common = path.join(root, "production-backup-common.failing-cleanup.sh");
  await writeFile(
    common,
    commonSource.replace(
      removalLine,
      `    if [[ "\${FAKE_PACK_RUNTIME_RM_FAIL:-}" == "1" ]]; then
      production_backup_pack_runtime_removed=false
    elif ! /bin/rm -rf -- "$production_backup_pack_runtime"; then`,
    ),
    { mode: 0o600 },
  );
  const launcherSha256 = await sha256(launcher);
  const tcbSha256 = await sha256(tcb);
  const nodeSha256 = await sha256(nodeBin);
  const result = spawnSync("/bin/bash", [
    "--noprofile", "--norc", "-c", `
source "$1"
production_backup_run_operator_pack_entrypoint \\
  "$2" "$3" fixture "$4" "$5" "$6" "$7" \\
  --fixture-evidence "$8"
`, "fixture", common, launcher, launcherSha256, "a".repeat(64),
    runtimeParent, tcb, tcbSha256, evidence,
  ], {
    encoding: "utf8",
    env: {
      FAKE_PACK_RUNTIME_RM_FAIL: "1",
      PATH: process.env.PATH,
      NODE_BIN: nodeBin,
      NODE_BIN_SHA256: nodeSha256,
      NODE_ARCHIVE: tcb,
      NODE_ARCHIVE_SHA256: tcbSha256,
      DOMINION_OPERATOR_PACK_LAUNCHER_SHA256: launcherSha256,
    },
  });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /could not remove successful operator-pack runtime/u);
  const retained = await readdir(runtimeParent);
  assert.equal(retained.length, 1);
  assert.equal(await readFile(evidence, "utf8"), "nonsecret evidence retained\n");
});

test("credential scrubbing survives a second signal and precedes later cleanup failure", async (t) => {
  const cleanupLine = '        rm -rf -- "$bootstrap_runtime_directory" || cleanup_failed=true';
  const ignoredSignals = "  trap '' HUP INT QUIT TERM";
  const fixture = await makeFixture({
    drift: true,
    runnerSourceTransform(source) {
      assert.ok(source.includes(cleanupLine));
      assert.ok(source.includes(ignoredSignals));
      return source.replace(
        ignoredSignals,
        () => `${ignoredSignals}\n  /bin/kill -TERM "$$"`,
      ).replace(
        cleanupLine,
        `${cleanupLine}\n        /usr/bin/false || cleanup_failed=true`,
      );
    },
  });
  t.after(() => cleanupFixture(fixture));
  const result = runStep(fixture, {
    reconciliationId: "bootstrap-cleanup-failure-fixture",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /one or more cleanup operations failed/u);
  const runtimes = await runnerFailureRuntimes(fixture);
  assert.equal(runtimes.length, 1);
  for (const sensitiveName of [
    "database-url", "pgpass", "supabase-ca.crt", "home", "config",
  ]) {
    await assertPathAbsent(path.join(runtimes[0], sensitiveName));
  }
  assert.equal(await readFile(fixture.stateFile, "utf8"), "0");
});

test("one failed credential unlink cannot skip later sensitive paths", async (t) => {
  const boundary = "# A second fully independent live capture closes the potentially long offline";
  const fixture = await makeFixture({
    runnerSourceTransform(source) {
      assert.ok(source.includes(boundary));
      return source.replace(boundary, `/bin/rm -f -- "$database_url_file"
/bin/mkdir -m 700 "$database_url_file"
printf '%s\\n' retained-first-path >"$database_url_file/blocker"
${boundary}`);
    },
  });
  t.after(() => cleanupFixture(fixture));
  const result = runStep(fixture, {
    reconciliationId: "credential-scrub-continues-fixture",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /attempted every exact credential scrub/u);
  const runtimes = await runnerFailureRuntimes(fixture);
  assert.equal(runtimes.length, 1);
  assert.equal(
    await readFile(path.join(runtimes[0], "database-url", "blocker"), "utf8"),
    "retained-first-path\n",
  );
  for (const sensitiveName of [
    "pgpass", "supabase-ca.crt", "home", "config",
  ]) {
    await assertPathAbsent(path.join(runtimes[0], sensitiveName));
  }
  assert.equal(await readFile(fixture.stateFile, "utf8"), "0");
});

test("fails closed on tampered, missing, extra, or legacy loose rehearsal evidence before boundary access", async (t) => {
  const fixture = await makeFixture();
  t.after(() => cleanupFixture(fixture));
  const preManifest = path.join(
    fixture.rehearsalEvidenceDirectory,
    "pre-source-manifest.jsonl",
  );
  const pristinePreManifest = await readFile(preManifest);
  await writeFile(preManifest, Buffer.concat([pristinePreManifest, Buffer.from("tamper\n")]));
  let result = runStep(fixture, { reconciliationId: "tampered-rehearsal" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /sealed offline rehearsal evidence failed verification/u);
  await writeFile(preManifest, pristinePreManifest);

  await chmod(fixture.rehearsalEvidenceDirectory, 0o755);
  result = runStep(fixture, { reconciliationId: "loose-rehearsal-directory" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /mode 0700 directory/u);
  await chmod(fixture.rehearsalEvidenceDirectory, 0o700);

  await chmod(preManifest, 0o644);
  result = runStep(fixture, { reconciliationId: "loose-rehearsal-artifact" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /file metadata does not match its sealed contract/u);
  await chmod(preManifest, 0o600);

  const externalHardlink = path.join(fixture.privateDirectory, "rehearsal-hardlink.jsonl");
  await link(preManifest, externalHardlink);
  result = runStep(fixture, { reconciliationId: "hardlinked-rehearsal-artifact" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /file metadata does not match its sealed contract/u);
  await rm(externalHardlink);

  const externalSymlinkTarget = await privateFile(
    path.join(fixture.privateDirectory, "rehearsal-symlink-target.jsonl"),
    pristinePreManifest,
  );
  await rm(preManifest);
  await symlink(externalSymlinkTarget, preManifest);
  result = runStep(fixture, { reconciliationId: "symlinked-rehearsal-artifact" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be a regular file|path must already be canonical/u);
  await rm(preManifest);
  await privateFile(preManifest, pristinePreManifest);

  if (process.platform === "darwin") {
    const username = execFileSync("/usr/bin/id", ["-un"], { encoding: "utf8" }).trim();
    execFileSync("/bin/chmod", ["+a", `${username} allow read`, preManifest]);
    result = runStep(fixture, { reconciliationId: "acl-rehearsal-artifact" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must not have an extended ACL/u);
    execFileSync("/bin/chmod", ["-N", preManifest]);
  }

  const effect = path.join(fixture.rehearsalEvidenceDirectory, "effect-verification.json");
  const pristineEffect = await readFile(effect);
  await rm(effect);
  result = runStep(fixture, { reconciliationId: "missing-rehearsal" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing or unexpected artifacts/u);
  await writeFile(effect, pristineEffect, { mode: 0o600 });

  const loose = path.join(fixture.rehearsalEvidenceDirectory, "legacy-loose-result.json");
  await writeFile(loose, "{}\n", { mode: 0o600 });
  result = runStep(fixture, { reconciliationId: "loose-rehearsal" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing or unexpected artifacts/u);
  await rm(loose);

  const unencryptedEvidence = path.join(fixture.root, "unencrypted-rehearsal-evidence");
  await cp(fixture.rehearsalEvidenceDirectory, unencryptedEvidence, { recursive: true });
  const unencryptedBundle = {
    ...fixture,
    preflightArguments: replaceOption(
      fixture.preflightArguments,
      "--rehearsal-evidence-directory",
      unencryptedEvidence,
    ),
  };
  result = runStep(fixture, {
    bundle: unencryptedBundle,
    reconciliationId: "unencrypted-rehearsal",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /contained by the attested encrypted destination/u);

  const legacyPlan = structuredClone(fixture.plan);
  legacyPlan.schemaVersion = 1;
  legacyPlan.artifactContract = "dominion-production-reconciliation-plan/v1";
  const legacyPlanFile = await privateFile(
    path.join(fixture.privateDirectory, "legacy-plan.json"),
    canonicalJson(legacyPlan),
  );
  const legacyBundle = {
    ...fixture,
    plan: legacyPlan,
    planFile: legacyPlanFile,
    planSha256: await sha256(legacyPlanFile),
  };
  result = runStep(fixture, {
    bundle: legacyBundle,
    reconciliationId: "legacy-plan",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /approved reconciliation plan schema verification failed/u);
  const localBoundaryEntries = (await readFile(fixture.boundaryLog, "utf8"))
    .trim().split("\n").filter(Boolean).map(JSON.parse);
  assert.ok(localBoundaryEntries.every(({ kind }) => kind === "volume"));
  assert.equal(await readFile(fixture.stateFile, "utf8"), "0");
});

test("plan preparation requires exact post(N) to pre(N+1) sealed-evidence continuity", async (t) => {
  const fixture = await makeFixture();
  t.after(() => cleanupFixture(fixture));
  const stageTwo = await makeStagePlan(fixture, 1, "a".repeat(64));
  const fixed = (name) => path.join(fixture.scripts, name);
  const contract = {
    schemaVersion: 2,
    artifactContract: "dominion-production-reconciliation-local-rehearsal/v2",
    databaseClientContract: "exact-supavisor-session-jit-pgpass-verify-full/v2",
    databaseHost,
    projectRef,
    expectedBranch: "main",
    releaseCommit: fixture.commit,
    releaseRepository: fixture.repository,
    macosTcbAttestation: fixture.macosTcbAttestation,
    macosTcbAttestationSha256: fixture.macosTcbAttestationSha256,
    throughVersion: versions[1],
    previousCompletionSha256: "a".repeat(64),
    backupEvidence: fixture.plan.backupEvidence,
    rehearsalEvidenceDirectory: stageTwo.rehearsalEvidenceDirectory,
    previousRehearsalEvidenceDirectory: fixture.rehearsalEvidenceDirectory,
    rehearsalSupabaseCli: fixture.supabase,
    rehearsalToolPaths: {
      cleanEnvironmentLauncherSha256: fixture.operatorPackLauncher,
      dockerBinSha256: fixture.docker,
      effectVerificationHookSha256: fixture.effectHook,
      encryptedVolumeCheckHookSha256: fixture.volumeHook,
      inputPinningHelperSha256: fixed("pin-production-input.mjs"),
      nodeBinSha256: nodeBin,
      offlinePgsodiumGetkeySha256: fixed("offline-pgsodium-getkey.sh"),
      operatorDispatcherSha256: fixture.genericTool,
      operatorSqlSha256: fixture.genericTool,
      rehearsalDriverSha256: fixture.genericTool,
      rehearsalWrapperSha256: fixture.genericTool,
      stageVerifierSha256: fixed("prepare-reconciliation-stage.mjs"),
    },
    approvedBackupToolManifest: fixture.approvedBackupTools,
    reconciliationStage: stageTwo.stage,
    tls: fixture.plan.tls,
    toolPaths: {
      artifactHelperSha256: fixed("production-reconciliation-artifacts.mjs"),
      backupArtifactVerifierSha256: fixed("production-backup-artifacts.mjs"),
      backupEvidenceVerifierSha256: fixed("verify-production-backup-evidence.sh"),
      commonHelperSha256: fixed("production-backup-common.sh"),
      cleanEnvironmentLauncherSha256: fixed("run-production-operator-clean.sh"),
      clockSha256: fixture.clock,
      credentialValidatorSha256: fixed("validate-postgres-credentials.mjs"),
      dockerBinSha256: fixture.docker,
      dumpScriptTransformerSha256: fixed("prepare-supabase-dump-script.mjs"),
      effectVerificationHookSha256: fixture.effectHook,
      encryptedVolumeCheckHookSha256: fixture.volumeHook,
      gitBinSha256: gitBin,
      historyVerifierSha256: fixed("verify-reconciliation-history.mjs"),
      inputPinningHelperSha256: fixed("pin-production-input.mjs"),
      manifestValidatorSha256: fixed("compare-database-manifests.mjs"),
      migrationHistoryHookSha256: fixture.historyHook,
      nodeBinSha256: nodeBin,
      preflightSha256: fixture.preflight,
      relationCountsHookSha256: fixture.relationCountsHook,
      runnerSha256: fixed("run-production-reconciliation-step.sh"),
      sourceFingerprintHookSha256: fixture.fingerprintHook,
      sourceManifestHookSha256: fixture.sourceHook,
      stageVerifierSha256: fixed("prepare-reconciliation-stage.mjs"),
      supabaseCliSha256: fixture.supabase,
    },
  };
  const contractFile = await privateFile(
    path.join(fixture.privateDirectory, "stage-two-contract.json"),
    canonicalJson(contract),
  );
  let result = spawnSync(nodeBin, [
    fixed("production-reconciliation-artifacts.mjs"),
    "prepare-plan",
    "--rehearsal-contract", contractFile,
    "--output", path.join(fixture.root, "stage-two-plan.json"),
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const manifestFile = path.join(
    stageTwo.rehearsalEvidenceDirectory,
    "rehearsal-evidence.json",
  );
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  manifest.previousPostStateSha256 = "b".repeat(64);
  await writeFile(manifestFile, canonicalJson(manifest));
  result = spawnSync(nodeBin, [
    fixed("production-reconciliation-artifacts.mjs"),
    "prepare-plan",
    "--rehearsal-contract", contractFile,
    "--output", path.join(fixture.root, "discontinuous-stage-two-plan.json"),
  ], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /post\(N\) to pre\(N\+1\) continuity is invalid/u);
});

test("executes one fake-boundary stage, preserves real v2.109.0 envelopes, and finalizes verified evidence", async (t) => {
  const fixture = await makeFixture();
  t.after(() => cleanupFixture(fixture));
  const result = runStep(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.doesNotMatch(result.stdout, /captured-hook-output|effect-hook-output/u);
  assert.equal(await readFile(fixture.stateFile, "utf8"), "1");
  const evidenceDirectory = stdoutField(result.stdout, "EVIDENCE_DIRECTORY");
  const completionSha256 = stdoutField(
    result.stdout,
    "TEST_ONLY_RECONCILIATION_COMPLETION_SHA256",
  );
  await assert.rejects(
    readFile(path.join(evidenceDirectory, "RECONCILIATION_INCOMPLETE.json")),
    { code: "ENOENT" },
  );
  assert.equal(
    await sha256(path.join(evidenceDirectory, "RECONCILIATION_COMPLETE.json")),
    completionSha256,
  );
  assert.equal(
    await readFile(path.join(evidenceDirectory, "pre-source-manifest.stdout"), "utf8"),
    "captured-hook-output\n",
  );
  const helperResult = spawnSync(nodeBin, [
    path.join(fixture.scripts, "production-reconciliation-artifacts.mjs"),
    "verify-test-only-completion",
    "--",
    "--evidence-directory", evidenceDirectory,
    "--phase", "complete",
    "--completion-sha256", completionSha256,
    "--project-ref", projectRef,
    "--release-commit", fixture.commit,
    "--through-version", versions[0],
    "--approved-plan-sha256", fixture.planSha256,
  ], { encoding: "utf8" });
  assert.equal(helperResult.status, 0, helperResult.stderr);
  assert.equal(
    helperResult.stdout,
    `TEST_ONLY_RECONCILIATION_COMPLETION_SHA256=${completionSha256}\n`,
  );

  const productionVerifier = spawnSync(nodeBin, [
    path.join(fixture.scripts, "production-reconciliation-artifacts.mjs"),
    "verify-completion",
    "--evidence-directory", evidenceDirectory,
    "--phase", "complete",
    "--completion-sha256", completionSha256,
    "--project-ref", projectRef,
    "--release-commit", fixture.commit,
    "--through-version", versions[0],
    "--approved-plan-sha256", fixture.planSha256,
  ], { encoding: "utf8" });
  assert.notEqual(productionVerifier.status, 0);
  assert.match(productionVerifier.stderr, /completion evidence must use the system-utc clock source/u);

  await chmod(evidenceDirectory, 0o755);
  let metadataFailure = verifyCompletion(fixture, evidenceDirectory, completionSha256);
  assert.notEqual(metadataFailure.status, 0);
  assert.match(metadataFailure.stderr, /mode 0700 directory/u);
  await chmod(evidenceDirectory, 0o700);

  const sealedCompletionArtifact = path.join(evidenceDirectory, "pre-source-manifest.jsonl");
  await chmod(sealedCompletionArtifact, 0o644);
  metadataFailure = verifyCompletion(fixture, evidenceDirectory, completionSha256);
  assert.notEqual(metadataFailure.status, 0);
  assert.match(metadataFailure.stderr, /file metadata does not match its sealed contract/u);
  await chmod(sealedCompletionArtifact, 0o600);

  const completionHardlink = path.join(fixture.privateDirectory, "completion-hardlink.jsonl");
  await link(sealedCompletionArtifact, completionHardlink);
  metadataFailure = verifyCompletion(fixture, evidenceDirectory, completionSha256);
  assert.notEqual(metadataFailure.status, 0);
  assert.match(metadataFailure.stderr, /file metadata does not match its sealed contract/u);
  await rm(completionHardlink);

  if (process.platform === "darwin") {
    const username = execFileSync("/usr/bin/id", ["-un"], { encoding: "utf8" }).trim();
    execFileSync("/bin/chmod", ["+a", `${username} allow read`, sealedCompletionArtifact]);
    metadataFailure = verifyCompletion(fixture, evidenceDirectory, completionSha256);
    assert.notEqual(metadataFailure.status, 0);
    assert.match(metadataFailure.stderr, /must not have an extended ACL/u);
    execFileSync("/bin/chmod", ["-N", sealedCompletionArtifact]);
  }

  const boundary = await readFile(fixture.boundaryLog, "utf8");
  assert.doesNotMatch(boundary, new RegExp(privatePassword, "u"));
  const entries = boundary.trim().split("\n").map(JSON.parse);
  const up = entries.filter(({ kind, args }) =>
    kind === "cli" && args[0] === "migration" && args[1] === "up"
  );
  assert.equal(up.length, 0);
  const volumeAttestations = entries.filter(({ kind }) => kind === "volume");
  assert.deepEqual(volumeAttestations.map(({ count }) => count), [1, 2]);
  assert.equal(volumeAttestations[1].cwd, evidenceDirectory);
  assert.equal(
    await readFile(
      path.join(evidenceDirectory, "final-encrypted-volume-attestation.stdout"),
      "utf8",
    ),
    `DOMINION_ENCRYPTED_VOLUME_ATTESTATION_SHA256=${fixture.plan.backupEvidence.encryptedVolumeAttestationSha256}\n`
      + `DOMINION_ENCRYPTED_VOLUME_DESTINATION=${fixture.destination}\n`,
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(path.join(evidenceDirectory, "mutation-boundary-freshness.json"), "utf8"),
    ),
    {
      schemaVersion: 1,
      artifactContract:
        "dominion-production-reconciliation-mutation-boundary-freshness/v1",
      preflightSha256: JSON.parse(
        await readFile(path.join(evidenceDirectory, "reconciliation.json"), "utf8"),
      ).preflightSha256,
      capturedAt: "2026-08-25T19:00:01Z",
      preflightCurrentTime: "2026-08-25T19:00:02Z",
      mutationBoundaryAt: "2026-08-25T19:00:02Z",
      maxCaptureAgeSeconds: 600,
      captureAgeSeconds: 1,
    },
  );
  assert.ok(entries.filter(({ kind }) => kind === "cli").every(({ cwd }) => cwd === evidenceDirectory));
  assert.ok(entries.filter(({ kind }) => ["manifest", "fingerprint", "history", "effect"].includes(kind))
    .every(({ cwd }) => cwd === evidenceDirectory));
  const migrationUpEvidence = JSON.parse(
    await readFile(path.join(evidenceDirectory, "migration-up.json"), "utf8"),
  );
  assert.equal(migrationUpEvidence.message, "Migrations applied");
  assert.equal(migrationUpEvidence.applied.length, 1);
  const encryptedPrivateRelative = path.relative(
    path.join(fixture.destination, "private"),
    migrationUpEvidence.applied[0],
  );
  assert.ok(!encryptedPrivateRelative.startsWith("..") && !path.isAbsolute(encryptedPrivateRelative));
  assert.match(
    migrationUpEvidence.applied[0],
    new RegExp(`/reconciliation-stage/supabase/migrations/${versions[0]}_[^/]+\\.sql$`, "u"),
  );
  assert.ok(!migrationUpEvidence.applied[0].startsWith(`${fixture.stage}${path.sep}`));

  const protectedFiles = [
    "final-encrypted-volume-attestation.stdout",
    "mutation-boundary-freshness.json",
    "mutation-boundary-freshness.stdout",
    "preflight-record.txt",
    "migration-up.json",
    "reconciliation.json",
    "RECONCILIATION_COMPLETE.json",
  ];
  const pristine = Object.fromEntries(await Promise.all(protectedFiles.map(async (name) => [
    name,
    await readFile(path.join(evidenceDirectory, name)),
  ])));
  const restorePristine = async () => {
    await Promise.all(protectedFiles.map((name) =>
      writeFile(path.join(evidenceDirectory, name), pristine[name])
    ));
  };

  const preflightPath = path.join(evidenceDirectory, "preflight-record.txt");
  const rewrittenPreflightSha256 = await rewritePreflightField(
    preflightPath,
    "PROJECT_REF",
    "bbbbbbbbbbbbbbbbbbbb",
  );
  let rewrappedSha256 = await rewrapCompletionEvidence(evidenceDirectory, {
    changedArtifacts: ["preflight-record.txt"],
    mutateManifest: (manifest) => {
      manifest.preflightSha256 = rewrittenPreflightSha256;
    },
  });
  let rewrapped = verifyCompletion(fixture, evidenceDirectory, rewrappedSha256);
  assert.notEqual(rewrapped.status, 0);
  assert.match(rewrapped.stderr, /preflight release, project, branch, or schema identity/u);
  await restorePristine();

  const migrationUpPath = path.join(evidenceDirectory, "migration-up.json");
  const migrationUp = JSON.parse(await readFile(migrationUpPath, "utf8"));
  migrationUp.applied = ["/tmp/not-the-approved-stage.sql"];
  await writeFile(migrationUpPath, canonicalJson(migrationUp));
  rewrappedSha256 = await rewrapCompletionEvidence(evidenceDirectory, {
    changedArtifacts: ["migration-up.json"],
  });
  rewrapped = verifyCompletion(fixture, evidenceDirectory, rewrappedSha256);
  assert.notEqual(rewrapped.status, 0);
  assert.match(rewrapped.stderr, /migration up applied a path outside the exact immutable stage/u);
  await restorePristine();

  rewrappedSha256 = await rewrapCompletionEvidence(evidenceDirectory, {
    mutateManifest: (manifest) => {
      manifest.clock.sha256 = "e".repeat(64);
    },
  });
  rewrapped = verifyCompletion(fixture, evidenceDirectory, rewrappedSha256);
  assert.notEqual(rewrapped.status, 0);
  assert.match(rewrapped.stderr, /completion clock or writer-quiescence identity/u);
  await restorePristine();

  rewrappedSha256 = await rewrapCompletionEvidence(evidenceDirectory, {
    mutateManifest: (manifest) => {
      manifest.writerQuiescedAt = "2026-08-25T18:59:58Z";
    },
  });
  rewrapped = verifyCompletion(fixture, evidenceDirectory, rewrappedSha256);
  assert.notEqual(rewrapped.status, 0);
  assert.match(rewrapped.stderr, /completion clock or writer-quiescence identity/u);
  await restorePristine();

  const freshnessPath = path.join(evidenceDirectory, "mutation-boundary-freshness.json");
  const freshness = JSON.parse(await readFile(freshnessPath, "utf8"));
  freshness.mutationBoundaryAt = "2026-08-25T20:00:02Z";
  freshness.captureAgeSeconds = 3601;
  await writeFile(freshnessPath, canonicalJson(freshness));
  await writeFile(
    path.join(evidenceDirectory, "mutation-boundary-freshness.stdout"),
    `MUTATION_BOUNDARY_FRESHNESS_SHA256=${await sha256(freshnessPath)}\n`,
  );
  rewrappedSha256 = await rewrapCompletionEvidence(evidenceDirectory, {
    changedArtifacts: [
      "mutation-boundary-freshness.json",
      "mutation-boundary-freshness.stdout",
    ],
  });
  rewrapped = verifyCompletion(fixture, evidenceDirectory, rewrappedSha256);
  assert.notEqual(rewrapped.status, 0);
  assert.match(rewrapped.stderr, /mutation-boundary freshness evidence is stale/u);
  await restorePristine();

  await writeFile(
    path.join(evidenceDirectory, "final-encrypted-volume-attestation.stdout"),
    "DOMINION_ENCRYPTED_VOLUME_OK=/tmp/not-the-evidence-destination\n",
  );
  rewrappedSha256 = await rewrapCompletionEvidence(evidenceDirectory, {
    changedArtifacts: ["final-encrypted-volume-attestation.stdout"],
  });
  rewrapped = verifyCompletion(fixture, evidenceDirectory, rewrappedSha256);
  assert.notEqual(rewrapped.status, 0);
  assert.match(rewrapped.stderr, /final encrypted-volume attestation does not bind/u);
  await restorePristine();

  await writeFile(
    path.join(evidenceDirectory, "pre-source-manifest.jsonl"),
    `${manifestText(0)}tamper\n`,
  );
  const tampered = spawnSync(nodeBin, [
    path.join(fixture.scripts, "production-reconciliation-artifacts.mjs"),
    "verify-test-only-completion",
    "--evidence-directory", evidenceDirectory,
    "--phase", "complete",
    "--completion-sha256", completionSha256,
    "--project-ref", projectRef,
    "--release-commit", fixture.commit,
    "--through-version", versions[0],
    "--approved-plan-sha256", fixture.planSha256,
  ], { encoding: "utf8" });
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /artifact SHA-256 mismatch/u);
});

test("preflight-to-apply drift fails before migration and retains encrypted incomplete evidence", async (t) => {
  const fixture = await makeFixture({ drift: true });
  t.after(() => cleanupFixture(fixture));
  const result = runStep(fixture, { reconciliationId: "drift-fixture" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /target drifted between preflight and apply/u);
  assert.equal(await readFile(fixture.stateFile, "utf8"), "0");
  const evidenceDirectory = path.join(fixture.destination, "reconciliation-drift-fixture");
  assert.equal(
    JSON.parse(await readFile(path.join(evidenceDirectory, "RECONCILIATION_INCOMPLETE.json"), "utf8")).status,
    "incomplete",
  );
  await assert.rejects(
    readFile(path.join(evidenceDirectory, "RECONCILIATION_COMPLETE.json")),
    { code: "ENOENT" },
  );
  const failureRuntimes = await runnerFailureRuntimes(fixture);
  assert.equal(failureRuntimes.length, 1);
  for (const sensitiveName of [
    "database-url",
    "pgpass",
    "supabase-ca.crt",
    "home",
    "config",
  ]) {
    await assertPathAbsent(path.join(failureRuntimes[0], sensitiveName));
  }
  assert.equal(
    JSON.parse(await readFile(
      path.join(failureRuntimes[0], "RECONCILIATION_INCOMPLETE.json"),
      "utf8",
    )).status,
    "incomplete",
  );
  const entries = (await readFile(fixture.boundaryLog, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(entries.filter(({ kind, args }) => kind === "cli" && args[1] === "up").length, 0);
});

test("ambient database and runtime overrides fail before any boundary access", async (t) => {
  const fixture = await makeFixture();
  t.after(() => cleanupFixture(fixture));
  const result = runStep(fixture, {
    reconciliationId: "ambient-runtime-fixture",
    ambientEnvironment: { DOCKER_HOST: "tcp://unreviewed.example.test:2375" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unset ambient DOCKER_HOST/u);
  assert.equal(await readFile(fixture.stateFile, "utf8"), "0");
  assert.equal(await readFile(fixture.boundaryLog, "utf8"), "");
  await assert.rejects(
    readFile(path.join(
      fixture.destination,
      "reconciliation-ambient-runtime-fixture",
      "RECONCILIATION_INCOMPLETE.json",
    )),
    { code: "ENOENT" },
  );
});

test("capture freshness is re-enforced at the exact migration boundary", async (t) => {
  const fixture = await makeFixture({
    clockValues: ["2026-08-25T19:00:02Z", "2026-08-25T19:20:02Z"],
  });
  t.after(() => cleanupFixture(fixture));
  const result = runStep(fixture, { reconciliationId: "stale-at-boundary-fixture" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /backup evidence became stale before the migration boundary/u);
  assert.equal(await readFile(fixture.stateFile, "utf8"), "0");
  const evidenceDirectory = path.join(
    fixture.destination,
    "reconciliation-stale-at-boundary-fixture",
  );
  assert.equal(
    JSON.parse(
      await readFile(path.join(evidenceDirectory, "RECONCILIATION_INCOMPLETE.json"), "utf8"),
    ).status,
    "incomplete",
  );
  await assert.rejects(
    readFile(path.join(evidenceDirectory, "RECONCILIATION_COMPLETE.json")),
    { code: "ENOENT" },
  );
  const entries = (await readFile(fixture.boundaryLog, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(entries.filter(({ kind, args }) => kind === "cli" && args[1] === "up").length, 0);
});

test("an approved-effect mismatch fails after the one migration and never finalizes evidence", async (t) => {
  const fixture = await makeFixture();
  t.after(() => cleanupFixture(fixture));
  const plan = structuredClone(fixture.plan);
  plan.expectedPost.effectVerificationSha256 = "d".repeat(64);
  const planFile = await privateFile(
    path.join(fixture.privateDirectory, "effect-mismatch-plan.json"),
    canonicalJson(plan),
  );
  const bundle = {
    plan,
    planFile,
    planSha256: await sha256(planFile),
    preflightArguments: fixture.preflightArguments,
  };
  const result = runStep(fixture, {
    bundle,
    reconciliationId: "effect-mismatch-fixture",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /effect verification does not match the independently approved/u);
  assert.equal(await readFile(fixture.stateFile, "utf8"), "1");
  const evidenceDirectory = path.join(
    fixture.destination,
    "reconciliation-effect-mismatch-fixture",
  );
  assert.equal(
    JSON.parse(await readFile(path.join(evidenceDirectory, "RECONCILIATION_INCOMPLETE.json"), "utf8")).status,
    "incomplete",
  );
  await assert.rejects(
    readFile(path.join(evidenceDirectory, "RECONCILIATION_COMPLETE.json")),
    { code: "ENOENT" },
  );
});

test("completion is withheld when the encrypted destination cannot be re-attested", async (t) => {
  const fixture = await makeFixture({ failFinalVolumeAttestation: true });
  t.after(() => cleanupFixture(fixture));
  const result = runStep(fixture, { reconciliationId: "final-volume-failure-fixture" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /encrypted destination re-attestation failed before completion/u);
  assert.equal(await readFile(fixture.stateFile, "utf8"), "1");
  const evidenceDirectory = path.join(
    fixture.destination,
    "reconciliation-final-volume-failure-fixture",
  );
  assert.equal(
    JSON.parse(
      await readFile(path.join(evidenceDirectory, "RECONCILIATION_INCOMPLETE.json"), "utf8"),
    ).status,
    "incomplete",
  );
  assert.match(
    await readFile(
      path.join(evidenceDirectory, "final-encrypted-volume-attestation.stderr"),
      "utf8",
    ),
    /encrypted destination verification hook failed/u,
  );
  await assert.rejects(
    readFile(path.join(evidenceDirectory, "RECONCILIATION_COMPLETE.json")),
    { code: "ENOENT" },
  );
});

test("stage two rejects genesis, arbitrary chain hashes, and an unrelated marker", async (t) => {
  const fixture = await makeFixture();
  t.after(() => cleanupFixture(fixture));
  const first = runStep(fixture, { reconciliationId: "chain-stage-one" });
  assert.equal(first.status, 0, first.stderr);
  const firstEvidence = stdoutField(first.stdout, "EVIDENCE_DIRECTORY");
  const firstCompletion = stdoutField(first.stdout, "TEST_ONLY_RECONCILIATION_COMPLETION_SHA256");

  const genesisPlan = await makeStagePlan(fixture, 1, zeroHash);
  const genesis = runStep(fixture, {
    bundle: genesisPlan,
    reconciliationId: "chain-stage-two-genesis",
    previousCompletionEvidence: "genesis",
  });
  assert.notEqual(genesis.status, 0);
  assert.match(genesis.stderr, /only the first reconciliation plan may use the all-zero genesis/u);

  const arbitraryPlan = await makeStagePlan(fixture, 1, "e".repeat(64));
  const arbitrary = runStep(fixture, {
    bundle: arbitraryPlan,
    reconciliationId: "chain-stage-two-arbitrary",
    previousCompletionEvidence: firstEvidence,
  });
  assert.notEqual(arbitrary.status, 0);
  assert.match(arbitrary.stderr, /prior completion chain verification failed/u);

  const validPlan = await makeStagePlan(fixture, 1, firstCompletion);
  const stageTwoEvidenceManifest = path.join(
    validPlan.rehearsalEvidenceDirectory,
    "rehearsal-evidence.json",
  );
  const pristineStageTwoEvidence = await readFile(stageTwoEvidenceManifest);
  const forgedEvidence = JSON.parse(pristineStageTwoEvidence);
  forgedEvidence.previousRehearsalEvidenceManifestSha256 = "b".repeat(64);
  await writeFile(stageTwoEvidenceManifest, canonicalJson(forgedEvidence));
  const forgedEvidenceSha256 = await sha256(stageTwoEvidenceManifest);
  const forgedPlan = structuredClone(validPlan.plan);
  forgedPlan.rehearsalEvidence.manifestSha256 = forgedEvidenceSha256;
  forgedPlan.rehearsalEvidence.previousManifestSha256 = "b".repeat(64);
  const forgedPlanFile = await privateFile(
    path.join(fixture.privateDirectory, "forged-rehearsal-chain-plan.json"),
    canonicalJson(forgedPlan),
  );
  const forgedBundle = {
    ...validPlan,
    plan: forgedPlan,
    planFile: forgedPlanFile,
    planSha256: await sha256(forgedPlanFile),
    preflightArguments: replaceOption(
      validPlan.preflightArguments,
      "--expected-rehearsal-evidence-manifest-sha256",
      forgedEvidenceSha256,
    ),
  };
  const forged = runStep(fixture, {
    bundle: forgedBundle,
    reconciliationId: "chain-stage-two-forged-rehearsal",
    previousCompletionEvidence: firstEvidence,
  });
  assert.notEqual(forged.status, 0);
  assert.match(forged.stderr, /prior completion chain verification failed/u);
  await writeFile(stageTwoEvidenceManifest, pristineStageTwoEvidence);

  const unrelatedEvidence = path.join(fixture.destination, "reconciliation-unrelated");
  await cp(firstEvidence, unrelatedEvidence, { recursive: true });
  const unrelatedMarker = JSON.parse(
    await readFile(path.join(unrelatedEvidence, "RECONCILIATION_COMPLETE.json"), "utf8"),
  );
  unrelatedMarker.completedAt = "2026-08-25T19:00:03Z";
  await writeFile(
    path.join(unrelatedEvidence, "RECONCILIATION_COMPLETE.json"),
    canonicalJson(unrelatedMarker),
  );
  const unrelated = runStep(fixture, {
    bundle: validPlan,
    reconciliationId: "chain-stage-two-unrelated",
    previousCompletionEvidence: unrelatedEvidence,
  });
  assert.notEqual(unrelated.status, 0);
  assert.match(unrelated.stderr, /prior completion chain verification failed/u);

  const divergentToolsPlan = structuredClone(validPlan.plan);
  divergentToolsPlan.tools.sourceManifestHookSha256 = "7".repeat(64);
  const divergentToolsPlanFile = await privateFile(
    path.join(fixture.privateDirectory, "stage-two-divergent-tools-plan.json"),
    canonicalJson(divergentToolsPlan),
  );
  const divergentTools = spawnSync(nodeBin, [
    path.join(fixture.scripts, "production-reconciliation-artifacts.mjs"),
    "verify-previous-chain",
    "--destination", fixture.destination,
    "--tip-evidence-directory", firstEvidence,
    "--approved-plan", divergentToolsPlanFile,
    "--approved-plan-sha256", await sha256(divergentToolsPlanFile),
  ], { encoding: "utf8" });
  assert.notEqual(divergentTools.status, 0);
  assert.match(
    divergentTools.stderr,
    /every completed stage must bind the identical full reconciliation toolset/u,
  );

  const fakeClockChain = spawnSync(nodeBin, [
    path.join(fixture.scripts, "production-reconciliation-artifacts.mjs"),
    "verify-previous-chain",
    "--destination", fixture.destination,
    "--tip-evidence-directory", firstEvidence,
    "--approved-plan", validPlan.planFile,
    "--approved-plan-sha256", validPlan.planSha256,
  ], { encoding: "utf8" });
  assert.notEqual(fakeClockChain.status, 0);
  assert.match(
    fakeClockChain.stderr,
    /prior completed stage must use the system-utc clock source/u,
  );

  const second = runStep(fixture, {
    bundle: validPlan,
    reconciliationId: "chain-stage-two-test-clock-refused",
    previousCompletionEvidence: firstEvidence,
  });
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /prior completion chain verification failed/u);
  assert.equal(await readFile(fixture.stateFile, "utf8"), "1");
});

test("approved plan and preflight hard-reject capture ages above one hour", async (t) => {
  const fixture = await makeFixture();
  t.after(() => cleanupFixture(fixture));
  const plan = structuredClone(fixture.plan);
  plan.backupEvidence.maxCaptureAgeSeconds = 3601;
  const filename = await privateFile(path.join(fixture.privateDirectory, "too-stale-plan.json"), canonicalJson(plan));
  const result = spawnSync(nodeBin, [
    path.join(fixture.scripts, "production-reconciliation-artifacts.mjs"),
    "verify-plan",
    "--input", filename,
    "--input-sha256", await sha256(filename),
  ], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /1 through 3600/u);
});
