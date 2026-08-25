import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  return canonicalJson({
    schemaVersion: 1,
    projectRef,
    throughVersion,
    passed: true,
    checks: [{
      name: "approved-migration-effect",
      passed: true,
      evidenceSha256: sha256Bytes(`effect-${throughVersion}`),
    }],
  });
}

async function copyReleaseRepository(root) {
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
    "prepare-reconciliation-stage.mjs",
    "prepare-supabase-dump-script.mjs",
    "production-backup-artifacts.mjs",
    "production-backup-common.sh",
    "production-reconciliation-artifacts.mjs",
    "run-production-reconciliation-step.sh",
    "validate-postgres-credentials.mjs",
    "verify-production-backup-evidence.sh",
    "verify-production-reconciliation-preflight.sh",
    "verify-reconciliation-history.mjs",
  ];
  for (const name of names) {
    await cp(path.join(sourceScripts, name), path.join(repository, "scripts", name));
  }
  await chmod(path.join(repository, "scripts", "run-production-reconciliation-step.sh"), 0o700);
  await chmod(path.join(repository, "scripts", "verify-production-backup-evidence.sh"), 0o700);
  await chmod(path.join(repository, "scripts", "verify-production-reconciliation-preflight.sh"), 0o700);
  execFileSync(gitBin, ["init", "-q", "-b", "main"], { cwd: repository });
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

async function makeDocker(filename, boundaryLog) {
  return executable(filename, `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(boundaryLog)}, JSON.stringify({ kind: "docker", args }) + "\\n");
if (args[0] === "context" && args[1] === "inspect") process.stdout.write("unix:///var/run/docker.sock\\n");
else if (args[0] === "image" && args[1] === "inspect" && args.at(-1) === ${JSON.stringify(postgresImage)}) process.stdout.write(${JSON.stringify(postgresImageId + "\n")});
else process.exit(71);
`);
}

async function makeDatabaseHook(filename, kind, stateFile, driftFlag, boundaryLog, docker) {
  return executable(filename, `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const expectedFlags = ["--database-client-contract", "--database-url-file", "--database-passfile", "--project-ref", "--docker-bin", "--postgres-image", "--postgres-image-id", "--output"];
if (args.length !== expectedFlags.length * 2 || expectedFlags.some((flag, index) => args[index * 2] !== flag)) process.exit(61);
const value = (flag) => args[args.indexOf(flag) + 1];
if (value("--database-client-contract") !== "exact-docker-pgpass/v1"
  || value("--project-ref") !== ${JSON.stringify(projectRef)}
  || value("--docker-bin") !== ${JSON.stringify(docker)}
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

async function makeEffectHook(filename, boundaryLog, docker) {
  return executable(filename, `#!/usr/bin/env node
const { appendFileSync, existsSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const expectedFlags = ["--database-client-contract", "--database-url-file", "--database-passfile", "--project-ref", "--through-version", "--docker-bin", "--postgres-image", "--postgres-image-id", "--output"];
if (args.length !== expectedFlags.length * 2 || expectedFlags.some((flag, index) => args[index * 2] !== flag)) process.exit(51);
const value = (flag) => args[args.indexOf(flag) + 1];
if (value("--database-client-contract") !== "exact-docker-pgpass/v1"
  || value("--project-ref") !== ${JSON.stringify(projectRef)}
  || value("--docker-bin") !== ${JSON.stringify(docker)}
  || value("--postgres-image") !== ${JSON.stringify(postgresImage)}
  || value("--postgres-image-id") !== ${JSON.stringify(postgresImageId)}) process.exit(52);
if (args.some((entry) => entry.includes(${JSON.stringify(privatePassword)}))) process.exit(53);
const output = value("--output");
if (path.dirname(output) !== process.cwd()) process.exit(54);
if (!existsSync(path.join(process.cwd(), "RECONCILIATION_INCOMPLETE.json"))) process.exit(55);
appendFileSync(${JSON.stringify(boundaryLog)}, JSON.stringify({ kind: "effect", args, cwd: process.cwd() }) + "\\n");
const throughVersion = value("--through-version");
const effect = {
  schemaVersion: 1,
  projectRef: ${JSON.stringify(projectRef)},
  throughVersion,
  passed: true,
  checks: [{ name: "approved-migration-effect", passed: true, evidenceSha256: require("node:crypto").createHash("sha256").update("effect-" + throughVersion).digest("hex") }],
};
writeFileSync(output, JSON.stringify(effect, null, 2) + "\\n");
process.stdout.write("effect-hook-output\\n");
`);
}

async function makeVolumeHook(filename, boundaryLog, { failFinal = false } = {}) {
  const countFile = `${filename}.count`;
  return executable(filename, `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--destination" || args[2] !== "--passphrase-file") process.exit(41);
if (process.env.RECONCILIATION_AMBIENT_CANARY) process.exit(42);
const countFile = ${JSON.stringify(countFile)};
const count = existsSync(countFile) ? Number(readFileSync(countFile, "utf8")) + 1 : 1;
writeFileSync(countFile, String(count));
appendFileSync(${JSON.stringify(boundaryLog)}, JSON.stringify({ kind: "volume", args, cwd: process.cwd(), count }) + "\\n");
if (${JSON.stringify(failFinal)} && count === 2) {
  process.stderr.write("fixture final volume attestation failed\\n");
  process.exit(43);
}
process.stdout.write("DOMINION_ENCRYPTED_VOLUME_OK=" + args[1] + "\\n");
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
  };
  return executable(filename, `#!/usr/bin/env node
const { createHash } = require("node:crypto");
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args.length % 2 !== 0) process.exit(31);
const options = {};
for (let index = 0; index < args.length; index += 2) {
  const key = args[index].slice(2);
  if (options[key] !== undefined) process.exit(32);
  options[key] = args[index + 1];
}
const fields = [
  ["PREFLIGHT_SCHEMA", "77-dominion-production-reconciliation-preflight/v1"],
  ["PREFLIGHT_SCOPE", "offline-non-authorizing"],
  ["BACKUP_EVIDENCE_VERIFIER_SHA256", ${JSON.stringify(constants.evidence)}],
  ["BACKUP_ARTIFACT_VERIFIER_SHA256", ${JSON.stringify(constants.artifact)}],
  ["RECONCILIATION_STAGE_VERIFIER_SHA256", ${JSON.stringify(constants.stage)}],
  ["RECONCILIATION_HISTORY_VERIFIER_SHA256", ${JSON.stringify(constants.history)}],
  ["RELEASE_COMMIT", options["release-commit"]],
  ["THROUGH_VERSION", options["through-version"]],
  ["PROJECT_REF", options["project-ref"]],
  ["EXPECTED_BRANCH", options["expected-branch"]],
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
process.stdout.write("PRODUCTION_RECONCILIATION_PREFLIGHT_SHA256=" + digest + "\\n" + material);
${drift ? `writeFileSync(${JSON.stringify(driftFlag)}, "drift");` : ""}
`);
}

async function makeFixture({
  throughIndex = 0,
  initialApplied = throughIndex,
  drift = false,
  failFinalVolumeAttestation = false,
  clockValues,
} = {}) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "dominion-reconciliation-step-test-")),
  );
  const release = await copyReleaseRepository(root);
  const tools = path.join(root, "tools");
  const privateDirectory = path.join(root, "private");
  const destination = path.join(root, "encrypted-evidence");
  const stage = path.join(root, `stage-${throughIndex + 1}`);
  await Promise.all([
    mkdir(tools, { recursive: true }),
    mkdir(privateDirectory, { recursive: true }),
    mkdir(destination, { recursive: true }),
  ]);
  execFileSync(nodeBin, [
    path.join(release.scripts, "prepare-reconciliation-stage.mjs"),
    "--output", stage,
    "--release-commit", release.commit,
    "--through-version", versions[throughIndex],
  ]);
  const stateFile = path.join(root, "database-state");
  const driftFlag = path.join(root, "drift-after-preflight");
  const boundaryLog = path.join(root, "boundary.jsonl");
  await writeFile(stateFile, String(initialApplied));
  await writeFile(boundaryLog, "");
  const clock = await makeClock(path.join(tools, "clock"), clockValues);
  const docker = await makeDocker(path.join(tools, "docker"), boundaryLog);
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
  const historyHook = await makeDatabaseHook(
    path.join(tools, "history-hook"), "history", stateFile, driftFlag, boundaryLog, docker,
  );
  const effectHook = await makeEffectHook(path.join(tools, "effect-hook"), boundaryLog, docker);
  const genericTool = await makeGenericTool(path.join(tools, "generic-tool"));
  const preflight = await makePreflight({
    filename: path.join(tools, "preflight"),
    repositoryScripts: release.scripts,
    clockSha256: await sha256(clock),
    driftFlag,
    drift,
  });
  const databaseUrl = await privateFile(
    path.join(privateDirectory, "database-url"),
    `postgresql://postgres@db.${projectRef}.supabase.co:5432/postgres?sslmode=require\n`,
  );
  const databasePassfile = await privateFile(
    path.join(privateDirectory, "database-passfile"),
    `db.${projectRef}.supabase.co:5432:postgres:postgres:${privatePassword}\n`,
  );
  const passphrase = await privateFile(path.join(privateDirectory, "backup-passphrase"), "fixture-passphrase\n");
  const approvedBackupTools = await privateFile(
    path.join(privateDirectory, "approved-backup-tools.json"),
    canonicalJson({ fixture: true }),
  );

  const planTools = {
    artifactHelperSha256: await sha256(path.join(release.scripts, "production-reconciliation-artifacts.mjs")),
    backupArtifactVerifierSha256: await sha256(path.join(release.scripts, "production-backup-artifacts.mjs")),
    backupEvidenceVerifierSha256: await sha256(path.join(release.scripts, "verify-production-backup-evidence.sh")),
    commonHelperSha256: await sha256(path.join(release.scripts, "production-backup-common.sh")),
    clockSha256: await sha256(clock),
    credentialValidatorSha256: await sha256(path.join(release.scripts, "validate-postgres-credentials.mjs")),
    dockerBinSha256: await sha256(docker),
    dumpScriptTransformerSha256: await sha256(path.join(release.scripts, "prepare-supabase-dump-script.mjs")),
    effectVerificationHookSha256: await sha256(effectHook),
    encryptedVolumeCheckHookSha256: await sha256(volumeHook),
    gitBinSha256: await sha256(gitBin),
    historyVerifierSha256: await sha256(path.join(release.scripts, "verify-reconciliation-history.mjs")),
    manifestValidatorSha256: await sha256(path.join(release.scripts, "compare-database-manifests.mjs")),
    migrationHistoryHookSha256: await sha256(historyHook),
    nodeBinSha256: await sha256(nodeBin),
    preflightSha256: await sha256(preflight),
    runnerSha256: await sha256(path.join(release.scripts, "run-production-reconciliation-step.sh")),
    sourceFingerprintHookSha256: await sha256(fingerprintHook),
    sourceManifestHookSha256: await sha256(sourceHook),
    stageVerifierSha256: await sha256(path.join(release.scripts, "prepare-reconciliation-stage.mjs")),
    supabaseCliSha256: await sha256(supabase),
  };
  const previousCompletionSha256 = throughIndex === 0 ? zeroHash : "f".repeat(64);
  const plan = {
    schemaVersion: 1,
    artifactContract: "dominion-production-reconciliation-plan/v1",
    databaseClientContract: "exact-docker-pgpass/v1",
    projectRef,
    expectedBranch: "main",
    releaseCommit: release.commit,
    throughVersion: versions[throughIndex],
    previousCompletionSha256,
    backupEvidence: {
      backupManifestSha256: "1".repeat(64),
      restoreEvidenceManifestSha256: "2".repeat(64),
      sourceManifestSha256: sha256Bytes(manifestText(0)),
      sourceFingerprintSha256: sha256Bytes(fingerprintText(0)),
      relationSequenceCountsSha256: "3".repeat(64),
      migrationHistorySha256: "4".repeat(64),
      managedApplicationDdlSha256: "5".repeat(64),
      captureToolsetSha256: "6".repeat(64),
      restoreToolsetSha256: "7".repeat(64),
      migrationHistoryState: "absent",
      postgresImageId,
      writerQuiescedAt: "2026-08-25T18:59:59Z",
      maxCaptureAgeSeconds: 600,
    },
    expectedPre: {
      sourceManifestSha256: sha256Bytes(manifestText(initialApplied)),
      sourceFingerprintSha256: sha256Bytes(fingerprintText(initialApplied)),
    },
    expectedPost: {
      sourceManifestSha256: sha256Bytes(manifestText(initialApplied + 1)),
      sourceFingerprintSha256: sha256Bytes(fingerprintText(initialApplied + 1)),
      effectVerificationSha256: sha256Bytes(effectText(versions[throughIndex])),
    },
    approvedBackupToolManifestSha256: await sha256(approvedBackupTools),
    reconciliationStageManifestSha256: await sha256(path.join(stage, "reconciliation-stage.json")),
    tools: planTools,
  };
  const planFile = await privateFile(path.join(privateDirectory, "approved-plan.json"), canonicalJson(plan));
  const planSha256 = await sha256(planFile);
  const preflightArguments = [
    "--destination", destination,
    "--capture-id", "capture-fixture",
    "--restore-id", "restore-fixture",
    "--project-ref", projectRef,
    "--expected-branch", "main",
    "--expected-commit", release.commit,
    "--supabase-cli", supabase,
    "--supabase-cli-sha256", planTools.supabaseCliSha256,
    "--postgres-image", postgresImage,
    "--postgres-image-id", postgresImageId,
    "--passphrase-file", passphrase,
    "--passphrase-sha256", await sha256(passphrase),
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
    "--relation-counts-hook", genericTool,
    "--relation-counts-hook-sha256", await sha256(genericTool),
    "--migration-history-hook", historyHook,
    "--migration-history-hook-sha256", planTools.migrationHistoryHookSha256,
    "--managed-application-ddl-hook", genericTool,
    "--managed-application-ddl-hook-sha256", await sha256(genericTool),
    "--credential-validator-sha256", planTools.credentialValidatorSha256,
    "--dump-script-transformer-sha256", planTools.dumpScriptTransformerSha256,
    "--docker-bin", docker,
    "--docker-bin-sha256", planTools.dockerBinSha256,
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
    driftFlag,
    effectHook,
    fingerprintHook,
    historyHook,
    plan,
    planTools,
    planFile,
    planSha256,
    preflight,
    preflightArguments,
    privateDirectory,
    root,
    stage,
    stateFile,
    sourceHook,
    supabase,
    volumeHook,
  };
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
    fixture.root,
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
    sourceManifestSha256: sha256Bytes(manifestText(throughIndex)),
    sourceFingerprintSha256: sha256Bytes(fingerprintText(throughIndex)),
  };
  plan.expectedPost = {
    sourceManifestSha256: sha256Bytes(manifestText(throughIndex + 1)),
    sourceFingerprintSha256: sha256Bytes(fingerprintText(throughIndex + 1)),
    effectVerificationSha256: sha256Bytes(effectText(versions[throughIndex])),
  };
  plan.reconciliationStageManifestSha256 = await sha256(
    path.join(stage, "reconciliation-stage.json"),
  );
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
    "--expected-reconciliation-stage-manifest-sha256",
    plan.reconciliationStageManifestSha256,
  );
  return { plan, planFile, planSha256, preflightArguments, stage };
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
    RECONCILIATION_AMBIENT_CANARY: "must-not-reach-reviewed-hooks",
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

function stdoutField(stdout, key) {
  const line = stdout.split("\n").find((candidate) => candidate.startsWith(`${key}=`));
  assert.ok(line, `${key}: ${stdout}`);
  return line.slice(key.length + 1);
}

function verifyCompletion(fixture, evidenceDirectory, completionSha256) {
  return spawnSync(nodeBin, [
    path.join(fixture.scripts, "production-reconciliation-artifacts.mjs"),
    "verify-completion",
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
  lines[0] = `PRODUCTION_RECONCILIATION_PREFLIGHT_SHA256=${digest}`;
  await writeFile(filename, `${lines.join("\n")}\n`);
  return digest;
}

test("deterministically prepares the reviewed stage plan from exact local rehearsal artifacts", async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
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
    clockSha256: fixture.clock,
    credentialValidatorSha256: fixed("validate-postgres-credentials.mjs"),
    dockerBinSha256: fixture.docker,
    dumpScriptTransformerSha256: fixed("prepare-supabase-dump-script.mjs"),
    effectVerificationHookSha256: fixture.effectHook,
    encryptedVolumeCheckHookSha256: fixture.volumeHook,
    gitBinSha256: gitBin,
    historyVerifierSha256: fixed("verify-reconciliation-history.mjs"),
    manifestValidatorSha256: fixed("compare-database-manifests.mjs"),
    migrationHistoryHookSha256: fixture.historyHook,
    nodeBinSha256: nodeBin,
    preflightSha256: fixture.preflight,
    runnerSha256: fixed("run-production-reconciliation-step.sh"),
    sourceFingerprintHookSha256: fixture.fingerprintHook,
    sourceManifestHookSha256: fixture.sourceHook,
    stageVerifierSha256: fixed("prepare-reconciliation-stage.mjs"),
    supabaseCliSha256: fixture.supabase,
  };
  const contract = {
    schemaVersion: 1,
    artifactContract: "dominion-production-reconciliation-local-rehearsal/v1",
    databaseClientContract: "exact-docker-pgpass/v1",
    projectRef,
    expectedBranch: "main",
    releaseCommit: fixture.commit,
    throughVersion: versions[0],
    previousCompletionSha256: zeroHash,
    backupEvidence: fixture.plan.backupEvidence,
    expectedPreArtifacts: {
      sourceManifest: preManifest,
      sourceFingerprint: preFingerprint,
    },
    expectedPostArtifacts: {
      sourceManifest: postManifest,
      sourceFingerprint: postFingerprint,
      effectVerification: effect,
    },
    approvedBackupToolManifest: fixture.approvedBackupTools,
    reconciliationStage: fixture.stage,
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

test("executes one fake-boundary stage, preserves real v2.109.0 envelopes, and finalizes verified evidence", async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  const result = runStep(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.doesNotMatch(result.stdout, /captured-hook-output|effect-hook-output/u);
  assert.equal(await readFile(fixture.stateFile, "utf8"), "1");
  const evidenceDirectory = stdoutField(result.stdout, "EVIDENCE_DIRECTORY");
  const completionSha256 = stdoutField(
    result.stdout,
    "PRODUCTION_RECONCILIATION_COMPLETION_SHA256",
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
    "verify-completion",
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
    `PRODUCTION_RECONCILIATION_COMPLETION_SHA256=${completionSha256}\n`,
  );
  const boundary = await readFile(fixture.boundaryLog, "utf8");
  assert.doesNotMatch(boundary, new RegExp(privatePassword, "u"));
  const entries = boundary.trim().split("\n").map(JSON.parse);
  const up = entries.filter(({ kind, args }) =>
    kind === "cli" && args[0] === "migration" && args[1] === "up"
  );
  assert.equal(up.length, 1);
  const volumeAttestations = entries.filter(({ kind }) => kind === "volume");
  assert.deepEqual(volumeAttestations.map(({ count }) => count), [1, 2]);
  assert.equal(volumeAttestations[1].cwd, evidenceDirectory);
  assert.equal(
    await readFile(
      path.join(evidenceDirectory, "final-encrypted-volume-attestation.stdout"),
      "utf8",
    ),
    `DOMINION_ENCRYPTED_VOLUME_OK=${fixture.destination}\n`,
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
  assert.deepEqual(
    JSON.parse(await readFile(path.join(evidenceDirectory, "migration-up.json"), "utf8")),
    {
      applied: [path.resolve(
        fixture.stage,
        fixture.plan.throughVersion === versions[0]
          ? (JSON.parse(await readFile(path.join(fixture.stage, "reconciliation-stage.json"), "utf8")))
            .files.find(({ path: filename }) => path.basename(filename).startsWith(`${versions[0]}_`)).path
          : "",
      )],
      message: "Migrations applied",
    },
  );

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
    "verify-completion",
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
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
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
  const entries = (await readFile(fixture.boundaryLog, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(entries.filter(({ kind, args }) => kind === "cli" && args[1] === "up").length, 0);
});

test("ambient database and runtime overrides fail before any boundary access", async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
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
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
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
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
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
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
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
    /fixture final volume attestation failed/u,
  );
  await assert.rejects(
    readFile(path.join(evidenceDirectory, "RECONCILIATION_COMPLETE.json")),
    { code: "ENOENT" },
  );
});

test("stage two rejects genesis, arbitrary chain hashes, and an unrelated marker", async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  const first = runStep(fixture, { reconciliationId: "chain-stage-one" });
  assert.equal(first.status, 0, first.stderr);
  const firstEvidence = stdoutField(first.stdout, "EVIDENCE_DIRECTORY");
  const firstCompletion = stdoutField(first.stdout, "PRODUCTION_RECONCILIATION_COMPLETION_SHA256");

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

  const second = runStep(fixture, {
    bundle: validPlan,
    reconciliationId: "chain-stage-two-valid",
    previousCompletionEvidence: firstEvidence,
  });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(await readFile(fixture.stateFile, "utf8"), "2");
});

test("approved plan and preflight hard-reject capture ages above one hour", async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
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
