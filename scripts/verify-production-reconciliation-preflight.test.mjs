import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { HISTORICAL_RECONCILIATION_VERSIONS } from "./prepare-reconciliation-stage.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const preflightScript = path.join(
  scriptDirectory,
  "verify-production-reconciliation-preflight.sh",
);
const stagePreparer = path.join(
  scriptDirectory,
  "prepare-reconciliation-stage.mjs",
);
const projectRef = "abcdefghijklmnopqrst";
const captureId = "capture-20260825";
const restoreId = "restore-20260825";
const postgresImage = "public.ecr.aws/supabase/postgres:17.6.1.141";
const throughVersion = HISTORICAL_RECONCILIATION_VERSIONS[0];
const writerQuiescedAt = "2026-08-25T18:00:00Z";
const captureStartedAt = "2026-08-25T18:00:01Z";
const capturedAt = "2026-08-25T18:00:02Z";
const currentTime = "2026-08-25T18:05:00Z";

function repeatedHash(character) {
  return character.repeat(64);
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(filename) {
  return sha256Bytes(await readFile(filename));
}

function run(command, argumentsList, options = {}) {
  return spawnSync(command, argumentsList, {
    cwd: repositoryRoot,
    encoding: "utf8",
    ...options,
  });
}

function git(argumentsList) {
  const result = run("git", ["--no-replace-objects", ...argumentsList]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function migrationList(localVersions, remoteVersions) {
  const count = Math.max(localVersions.length, remoteVersions.length);
  const headers = ["Local", "Remote", "Time (UTC)"];
  const values = [];
  for (let index = 0; index < count; index += 1) {
    const local = localVersions[index] ? `\`${localVersions[index]}\`` : "` `";
    const remote = remoteVersions[index] ? `\`${remoteVersions[index]}\`` : "` `";
    const version = localVersions[index] || remoteVersions[index];
    const timestamp = `${version.slice(0, 4)}-${version.slice(4, 6)}-${version.slice(6, 8)} `
      + `${version.slice(8, 10)}:${version.slice(10, 12)}:${version.slice(12, 14)}`;
    values.push([local, remote, `\`${timestamp}\``]);
  }
  const widths = headers.map((header, cellIndex) =>
    Math.max(header.length, ...values.map((row) => row[cellIndex].length))
  );
  return [
    `   ${headers.map((header, index) => header.padEnd(widths[index])).join(" | ")} `,
    `  ${widths.map((width) => "-".repeat(width + 2)).join("|")}`,
    ...values.map((row) =>
      `   ${row.map((cell, index) => cell.padEnd(widths[index])).join(" | ")} `
    ),
    "",
  ].join("\n");
}

async function makeExecutable(filename, contents) {
  await writeFile(filename, contents, { mode: 0o700 });
  await chmod(filename, 0o700);
  return filename;
}

async function makeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dominion-preflight-test-"));
  const destination = path.join(root, "encrypted-volume");
  const tools = path.join(root, "tools");
  const stage = path.join(root, "reconciliation-stage");
  const beforeHistory = path.join(root, "before-migration-history.txt");
  const approvedToolManifest = path.join(root, "approved-tool-manifest.json");
  const verifierArgumentsLog = path.join(root, "verifier-arguments.log");
  await mkdir(destination);
  await mkdir(tools);

  const releaseCommit = git(["rev-parse", "HEAD"]);
  assert.match(releaseCommit, /^[a-f0-9]{40}$/u);
  const genericToolHash = repeatedHash("5");
  const captureTools = {
    credentialValidatorSha256: repeatedHash("6"),
    dockerBinSha256: genericToolHash,
    dumpScriptTransformerSha256: repeatedHash("7"),
    edgeFunctionsInventoryHookSha256: genericToolHash,
    encryptedVolumeCheckHookSha256: genericToolHash,
    managedApplicationDdlHookSha256: genericToolHash,
    migrationHistoryHookSha256: genericToolHash,
    relationCountsHookSha256: genericToolHash,
    sourceFingerprintHookSha256: genericToolHash,
    sourceManifestHookSha256: genericToolHash,
    storageInventoryHookSha256: genericToolHash,
    supabaseCliSha256: repeatedHash("3"),
  };
  const restoreTools = {
    dockerBinSha256: genericToolHash,
    encryptedVolumeCheckHookSha256: genericToolHash,
    restoreVerificationHookSha256: genericToolHash,
  };
  const identities = {
    backupManifest: repeatedHash("a"),
    restoreEvidenceManifest: repeatedHash("b"),
    sourceManifest: repeatedHash("c"),
    sourceFingerprint: repeatedHash("d"),
    relationSequenceCounts: repeatedHash("e"),
    migrationHistory: repeatedHash("f"),
    managedApplicationDdl: repeatedHash("0"),
    captureToolset: sha256Bytes(JSON.stringify(captureTools)),
    restoreToolset: sha256Bytes(JSON.stringify(restoreTools)),
    supabaseCli: repeatedHash("3"),
    postgresImageId: `sha256:${repeatedHash("4")}`,
  };
  const stageResult = run(process.execPath, [
    stagePreparer,
    "--output",
    stage,
    "--release-commit",
    releaseCommit,
    "--through-version",
    throughVersion,
  ]);
  assert.equal(stageResult.status, 0, stageResult.stderr);
  await writeFile(
    beforeHistory,
    migrationList([throughVersion], []),
    { mode: 0o600 },
  );
  await writeFile(
    approvedToolManifest,
    `${JSON.stringify({
      schemaVersion: 1,
      artifactContract: "dominion-production-backup-approved-tools/v1",
      releaseCommit,
      captureTools,
      captureToolsetSha256: identities.captureToolset,
      restoreTools,
      restoreToolsetSha256: identities.restoreToolset,
    }, null, 2)}\n`,
    { mode: 0o600 },
  );

  const fakeVerifier = await makeExecutable(
    path.join(tools, "verify-production-backup-evidence"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" >"$FAKE_VERIFIER_ARGUMENTS_LOG"
if [[ "\${FAKE_OUTPUT_MUTATION:-}" == "reordered" ]]; then
  printf 'RESTORE_EVIDENCE_MANIFEST_SHA256=%s\\n' "$FAKE_RESTORE_EVIDENCE_MANIFEST_SHA256"
  printf 'BACKUP_MANIFEST_SHA256=%s\\n' "$FAKE_BACKUP_MANIFEST_SHA256"
elif [[ "\${FAKE_OUTPUT_MUTATION:-}" == "duplicate" ]]; then
  printf 'BACKUP_MANIFEST_SHA256=%s\\n' "$FAKE_BACKUP_MANIFEST_SHA256"
  printf 'BACKUP_MANIFEST_SHA256=%s\\n' "$FAKE_BACKUP_MANIFEST_SHA256"
else
  printf 'BACKUP_MANIFEST_SHA256=%s\\n' "$FAKE_BACKUP_MANIFEST_SHA256"
  printf 'RESTORE_EVIDENCE_MANIFEST_SHA256=%s\\n' "$FAKE_RESTORE_EVIDENCE_MANIFEST_SHA256"
fi
printf 'SOURCE_MANIFEST_SHA256=%s\\n' "$FAKE_SOURCE_MANIFEST_SHA256"
printf 'SOURCE_FINGERPRINT_SHA256=%s\\n' "$FAKE_SOURCE_FINGERPRINT_SHA256"
printf 'RELATION_SEQUENCE_COUNTS_SHA256=%s\\n' "$FAKE_RELATION_SEQUENCE_COUNTS_SHA256"
printf 'MIGRATION_HISTORY_SHA256=%s\\n' "$FAKE_MIGRATION_HISTORY_SHA256"
printf 'MANAGED_APPLICATION_DDL_SHA256=%s\\n' "$FAKE_MANAGED_APPLICATION_DDL_SHA256"
printf 'CAPTURE_TOOLSET_SHA256=%s\\n' "$FAKE_CAPTURE_TOOLSET_SHA256"
printf 'RESTORE_TOOLSET_SHA256=%s\\n' "$FAKE_RESTORE_TOOLSET_SHA256"
printf 'APPROVED_TOOL_MANIFEST_SHA256=%s\\n' "$FAKE_APPROVED_TOOL_MANIFEST_SHA256"
printf 'MIGRATION_HISTORY_STATE=%s\\n' "\${FAKE_MIGRATION_HISTORY_STATE:-absent}"
printf 'SUPABASE_CLI_SHA256=%s\\n' "$FAKE_SUPABASE_CLI_SHA256"
printf 'POSTGRES_IMAGE_ID=%s\\n' "$FAKE_POSTGRES_IMAGE_ID"
printf 'WRITER_QUIESCED_AT=%s\\n' "\${FAKE_WRITER_QUIESCED_AT:-${writerQuiescedAt}}"
printf 'CAPTURE_STARTED_AT=%s\\n' "\${FAKE_CAPTURE_STARTED_AT:-${captureStartedAt}}"
printf 'CAPTURED_AT=%s\\n' "\${FAKE_CAPTURED_AT:-${capturedAt}}"
printf 'CAPTURE_DIRECTORY=%s\\n' "$FAKE_CAPTURE_DIRECTORY"
if [[ "\${FAKE_OUTPUT_MUTATION:-}" != "missing" ]]; then
  printf 'RESTORE_DIRECTORY=%s\\n' "$FAKE_RESTORE_DIRECTORY"
fi
if [[ "\${FAKE_OUTPUT_MUTATION:-}" == "extra" ]]; then
  printf 'UNEXPECTED_KEY=not-approved\\n'
fi
`,
  );
  const fakeClock = await makeExecutable(
    path.join(tools, "preflight-test-clock"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "\${FAKE_TEST_CURRENT_TIME:-${currentTime}}"
`,
  );

  const captureDirectory = path.join(destination, captureId);
  const restoreDirectory = path.join(
    destination,
    `restore-${captureId}-${restoreId}`,
  );

  return {
    approvedToolManifest,
    approvedToolManifestSha256: await sha256File(approvedToolManifest),
    beforeHistory,
    captureDirectory,
    destination,
    fakeVerifier,
    fakeClock,
    fakeClockSha256: await sha256File(fakeClock),
    identities,
    releaseCommit,
    restoreDirectory,
    root,
    stage,
    verifierArgumentsLog,
    fakeVerifierSha256: await sha256File(fakeVerifier),
    beforeHistorySha256: await sha256File(beforeHistory),
    stageManifestSha256: await sha256File(
      path.join(stage, "reconciliation-stage.json"),
    ),
  };
}

async function preflightArguments(fixture) {
  const genericToolHash = repeatedHash("5");
  const toolPath = (name) => path.join(fixture.root, "tools", name);
  return [
    "--destination", fixture.destination,
    "--capture-id", captureId,
    "--restore-id", restoreId,
    "--project-ref", projectRef,
    "--expected-branch", "main",
    "--expected-commit", fixture.releaseCommit,
    "--supabase-cli", toolPath("supabase"),
    "--supabase-cli-sha256", fixture.identities.supabaseCli,
    "--postgres-image", postgresImage,
    "--postgres-image-id", fixture.identities.postgresImageId,
    "--passphrase-file", path.join(fixture.root, "passphrase"),
    "--passphrase-sha256", genericToolHash,
    "--encrypted-volume-check-hook", toolPath("encrypted-volume-hook"),
    "--encrypted-volume-check-hook-sha256", genericToolHash,
    "--edge-functions-inventory-hook", toolPath("edge-hook"),
    "--edge-functions-inventory-hook-sha256", genericToolHash,
    "--storage-inventory-hook", toolPath("storage-hook"),
    "--storage-inventory-hook-sha256", genericToolHash,
    "--source-manifest-hook", toolPath("source-manifest-hook"),
    "--source-manifest-hook-sha256", genericToolHash,
    "--source-fingerprint-hook", toolPath("source-fingerprint-hook"),
    "--source-fingerprint-hook-sha256", genericToolHash,
    "--relation-counts-hook", toolPath("relation-counts-hook"),
    "--relation-counts-hook-sha256", genericToolHash,
    "--migration-history-hook", toolPath("migration-history-hook"),
    "--migration-history-hook-sha256", genericToolHash,
    "--managed-application-ddl-hook", toolPath("managed-ddl-hook"),
    "--managed-application-ddl-hook-sha256", genericToolHash,
    "--credential-validator-sha256", repeatedHash("6"),
    "--dump-script-transformer-sha256", repeatedHash("7"),
    "--docker-bin", toolPath("docker"),
    "--docker-bin-sha256", genericToolHash,
    "--restore-verification-hook", toolPath("restore-verification-hook"),
    "--restore-verification-hook-sha256", genericToolHash,
    "--approved-tool-manifest", fixture.approvedToolManifest,
    "--approved-tool-manifest-sha256",
    fixture.approvedToolManifestSha256,
    "--expected-backup-manifest-sha256", fixture.identities.backupManifest,
    "--expected-restore-evidence-manifest-sha256",
    fixture.identities.restoreEvidenceManifest,
    "--expected-source-manifest-sha256", fixture.identities.sourceManifest,
    "--expected-source-fingerprint-sha256", fixture.identities.sourceFingerprint,
    "--expected-relation-sequence-counts-sha256",
    fixture.identities.relationSequenceCounts,
    "--expected-migration-history-sha256", fixture.identities.migrationHistory,
    "--expected-managed-application-ddl-sha256",
    fixture.identities.managedApplicationDdl,
    "--expected-capture-toolset-sha256", fixture.identities.captureToolset,
    "--expected-restore-toolset-sha256", fixture.identities.restoreToolset,
    "--expected-migration-history-state", "absent",
    "--writer-quiesced-at", writerQuiescedAt,
    "--max-capture-age-seconds", "600",
    "--release-commit", fixture.releaseCommit,
    "--through-version", throughVersion,
    "--reconciliation-stage", fixture.stage,
    "--expected-reconciliation-stage-manifest-sha256",
    fixture.stageManifestSha256,
    "--before-migration-history", fixture.beforeHistory,
    "--expected-before-migration-history-sha256",
    fixture.beforeHistorySha256,
  ];
}

function replaceOption(argumentsList, option, value) {
  const result = [...argumentsList];
  const index = result.indexOf(option);
  assert.notEqual(index, -1, `missing test option ${option}`);
  result[index + 1] = value;
  return result;
}

function environmentFor(fixture, extra = {}) {
  return {
    ...process.env,
    NODE_BIN: process.execPath,
    PRODUCTION_BACKUP_EVIDENCE_VERIFIER_BIN: fixture.fakeVerifier,
    PRODUCTION_BACKUP_EVIDENCE_VERIFIER_SHA256: fixture.fakeVerifierSha256,
    PRODUCTION_RECONCILIATION_PREFLIGHT_TEST_MODE: "offline-fixture-only",
    PRODUCTION_RECONCILIATION_PREFLIGHT_TEST_CLOCK_BIN: fixture.fakeClock,
    PRODUCTION_RECONCILIATION_PREFLIGHT_TEST_CLOCK_SHA256:
      fixture.fakeClockSha256,
    FAKE_VERIFIER_ARGUMENTS_LOG: fixture.verifierArgumentsLog,
    FAKE_BACKUP_MANIFEST_SHA256: fixture.identities.backupManifest,
    FAKE_RESTORE_EVIDENCE_MANIFEST_SHA256:
      fixture.identities.restoreEvidenceManifest,
    FAKE_SOURCE_MANIFEST_SHA256: fixture.identities.sourceManifest,
    FAKE_SOURCE_FINGERPRINT_SHA256: fixture.identities.sourceFingerprint,
    FAKE_RELATION_SEQUENCE_COUNTS_SHA256:
      fixture.identities.relationSequenceCounts,
    FAKE_MIGRATION_HISTORY_SHA256: fixture.identities.migrationHistory,
    FAKE_MANAGED_APPLICATION_DDL_SHA256:
      fixture.identities.managedApplicationDdl,
    FAKE_CAPTURE_TOOLSET_SHA256: fixture.identities.captureToolset,
    FAKE_RESTORE_TOOLSET_SHA256: fixture.identities.restoreToolset,
    FAKE_APPROVED_TOOL_MANIFEST_SHA256:
      fixture.approvedToolManifestSha256,
    FAKE_SUPABASE_CLI_SHA256: fixture.identities.supabaseCli,
    FAKE_POSTGRES_IMAGE_ID: fixture.identities.postgresImageId,
    FAKE_CAPTURE_DIRECTORY: fixture.captureDirectory,
    FAKE_RESTORE_DIRECTORY: fixture.restoreDirectory,
    ...extra,
  };
}

function runPreflight(fixture, argumentsList, extraEnvironment = {}) {
  return run("/bin/bash", [preflightScript, ...argumentsList], {
    env: environmentFor(fixture, extraEnvironment),
  });
}

test("binds exact evidence, freshness, immutable stage, and one pending version", async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  const argumentsList = await preflightArguments(fixture);

  const first = runPreflight(fixture, argumentsList);
  assert.equal(first.status, 0, first.stderr);
  const second = runPreflight(fixture, argumentsList);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, first.stdout, "same bound inputs must be stable");

  const lines = first.stdout.trimEnd().split("\n");
  assert.match(
    lines[0],
    /^PRODUCTION_RECONCILIATION_PREFLIGHT_SHA256=[a-f0-9]{64}$/u,
  );
  const emittedDigest = lines[0].split("=")[1];
  assert.equal(
    emittedDigest,
    sha256Bytes(`${lines.slice(1).join("\n")}\n`),
    "leading identity must cover every subsequently emitted bound field",
  );
  assert.ok(lines.includes(`RELEASE_COMMIT=${fixture.releaseCommit}`));
  assert.ok(lines.includes(`THROUGH_VERSION=${throughVersion}`));
  assert.ok(lines.includes("PREFLIGHT_SCOPE=offline-non-authorizing"));
  assert.ok(lines.includes(`CURRENT_TIME=${currentTime}`));
  assert.ok(lines.includes("CLOCK_SOURCE=test-only-hashed-override"));
  assert.ok(lines.includes(`CLOCK_SHA256=${fixture.fakeClockSha256}`));
  assert.ok(
    lines.includes(
      `APPROVED_TOOL_MANIFEST_SHA256=${fixture.approvedToolManifestSha256}`,
    ),
  );
  assert.ok(lines.includes(`WRITER_QUIESCED_AT=${writerQuiescedAt}`));
  assert.ok(lines.includes(`CAPTURE_STARTED_AT=${captureStartedAt}`));
  assert.ok(lines.includes(`CAPTURED_AT=${capturedAt}`));
  assert.ok(
    lines.includes(
      `RECONCILIATION_STAGE_MANIFEST_SHA256=${fixture.stageManifestSha256}`,
    ),
  );
  assert.doesNotMatch(first.stdout, /Prepared|Verified exactly one pending/u);

  const forwarded = (await readFile(fixture.verifierArgumentsLog, "utf8"))
    .trimEnd()
    .split("\n");
  for (const requiredFlag of [
    "--edge-functions-inventory-hook-sha256",
    "--storage-inventory-hook-sha256",
    "--source-manifest-hook-sha256",
    "--source-fingerprint-hook-sha256",
    "--relation-counts-hook-sha256",
    "--migration-history-hook-sha256",
    "--managed-application-ddl-hook-sha256",
    "--credential-validator-sha256",
    "--dump-script-transformer-sha256",
    "--docker-bin-sha256",
    "--restore-verification-hook-sha256",
    "--approved-tool-manifest",
    "--approved-tool-manifest-sha256",
  ]) {
    assert.ok(forwarded.includes(requiredFlag), `did not forward ${requiredFlag}`);
  }
  assert.ok(!forwarded.includes("--database-url"));
  assert.ok(!forwarded.includes("--database-passfile"));
  assert.ok(!forwarded.includes("--writer-quiesced-at"));
});

test("strict parser rejects duplicate, missing, extra, and reordered verifier output", async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  const argumentsList = await preflightArguments(fixture);
  for (const [mutation, pattern] of [
    ["duplicate", /stdout line 2 must be exactly RESTORE_EVIDENCE/u],
    ["reordered", /stdout line 1 must be exactly BACKUP_MANIFEST/u],
    ["missing", /emitted 17 stdout lines/u],
    ["extra", /emitted extra stdout/u],
  ]) {
    const result = runPreflight(fixture, argumentsList, {
      FAKE_OUTPUT_MUTATION: mutation,
    });
    assert.notEqual(result.status, 0, `${mutation} unexpectedly passed`);
    assert.match(result.stderr, pattern);
    assert.equal(result.stdout, "");
  }
});

test("rejects unapproved evidence and tool identities", async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  const argumentsList = await preflightArguments(fixture);

  const wrongBackup = runPreflight(
    fixture,
    replaceOption(
      argumentsList,
      "--expected-backup-manifest-sha256",
      repeatedHash("9"),
    ),
  );
  assert.notEqual(wrongBackup.status, 0);
  assert.match(wrongBackup.stderr, /BACKUP_MANIFEST_SHA256 does not match/u);

  const wrongToolset = runPreflight(fixture, argumentsList, {
    FAKE_CAPTURE_TOOLSET_SHA256: repeatedHash("9"),
  });
  assert.notEqual(wrongToolset.status, 0);
  assert.match(wrongToolset.stderr, /CAPTURE_TOOLSET_SHA256 does not match/u);

  const wrongApprovedManifest = runPreflight(fixture, argumentsList, {
    FAKE_APPROVED_TOOL_MANIFEST_SHA256: repeatedHash("8"),
  });
  assert.notEqual(wrongApprovedManifest.status, 0);
  assert.match(
    wrongApprovedManifest.stderr,
    /APPROVED_TOOL_MANIFEST_SHA256 does not match/u,
  );

  const wrongImage = runPreflight(fixture, argumentsList, {
    FAKE_POSTGRES_IMAGE_ID: `sha256:${repeatedHash("8")}`,
  });
  assert.notEqual(wrongImage.status, 0);
  assert.match(wrongImage.stderr, /POSTGRES_IMAGE_ID does not match/u);

  const wrongReleaseApprovedManifest = JSON.parse(
    await readFile(fixture.approvedToolManifest, "utf8"),
  );
  wrongReleaseApprovedManifest.releaseCommit = "9".repeat(40);
  await writeFile(
    fixture.approvedToolManifest,
    `${JSON.stringify(wrongReleaseApprovedManifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  const wrongReleaseManifestSha256 = await sha256File(
    fixture.approvedToolManifest,
  );
  const wrongReleaseManifestArguments = replaceOption(
    argumentsList,
    "--approved-tool-manifest-sha256",
    wrongReleaseManifestSha256,
  );
  const wrongReleaseManifest = runPreflight(
    fixture,
    wrongReleaseManifestArguments,
    { FAKE_APPROVED_TOOL_MANIFEST_SHA256: wrongReleaseManifestSha256 },
  );
  assert.notEqual(wrongReleaseManifest.status, 0);
  assert.match(
    wrongReleaseManifest.stderr,
    /not bound to the exact release commit|contract verification failed/u,
  );
});

test("binds capture start to quiescence and enforces deterministic freshness", async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  const argumentsList = await preflightArguments(fixture);
  const invalidCases = [
    [
      { FAKE_WRITER_QUIESCED_AT: "2026-08-25T17:59:59Z" },
      /WRITER_QUIESCED_AT does not match/u,
    ],
    [
      { FAKE_CAPTURE_STARTED_AT: "2026-08-25T17:59:59Z" },
      /capture started before writer quiescence/u,
    ],
    [
      { FAKE_CAPTURED_AT: "2026-08-25T17:59:59Z" },
      /capture completed before it started/u,
    ],
    [
      { FAKE_CAPTURED_AT: "2026-08-25T18:05:01Z" },
      /capture completion is in the future/u,
    ],
    [
      { FAKE_CAPTURED_AT: "2026-08-25T17:00:00Z" },
      /capture completed before it started|capture evidence is stale/u,
    ],
    [
      { FAKE_CAPTURE_STARTED_AT: "2026-02-30T18:00:01Z" },
      /not a real canonical RFC3339/u,
    ],
  ];
  for (const [environment, pattern] of invalidCases) {
    const result = runPreflight(fixture, argumentsList, environment);
    assert.notEqual(result.status, 0, JSON.stringify(environment));
    assert.match(result.stderr, pattern);
    assert.equal(result.stdout, "");
  }

  const stale = runPreflight(fixture, argumentsList, {
    FAKE_TEST_CURRENT_TIME: "2026-08-25T19:00:00Z",
  });
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /capture evidence is stale/u);
});

test("requires main, one release commit, and a bounded age policy", async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  const argumentsList = await preflightArguments(fixture);
  const invalidArguments = [
    [
      replaceOption(argumentsList, "--expected-branch", "develop"),
      /must be exactly main/u,
    ],
    [
      replaceOption(argumentsList, "--release-commit", "9".repeat(40)),
      /must equal the evidence/u,
    ],
    [
      replaceOption(argumentsList, "--max-capture-age-seconds", "3601"),
      /cannot exceed 3600/u,
    ],
  ];
  for (const [candidate, pattern] of invalidArguments) {
    const result = runPreflight(fixture, candidate);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, pattern);
    assert.equal(result.stdout, "");
  }
});

test("requires approved immutable stage and exact one-pending history artifacts", async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  const argumentsList = await preflightArguments(fixture);

  const stageHashMismatch = runPreflight(
    fixture,
    replaceOption(
      argumentsList,
      "--expected-reconciliation-stage-manifest-sha256",
      repeatedHash("9"),
    ),
  );
  assert.notEqual(stageHashMismatch.status, 0);
  assert.match(stageHashMismatch.stderr, /stage manifest does not match/u);

  const historyHashMismatch = runPreflight(
    fixture,
    replaceOption(
      argumentsList,
      "--expected-before-migration-history-sha256",
      repeatedHash("9"),
    ),
  );
  assert.notEqual(historyHashMismatch.status, 0);
  assert.match(historyHashMismatch.stderr, /history snapshot does not match/u);

  await writeFile(
    fixture.beforeHistory,
    migrationList([throughVersion], [throughVersion]),
    { mode: 0o600 },
  );
  const noPendingArguments = replaceOption(
    argumentsList,
    "--expected-before-migration-history-sha256",
    await sha256File(fixture.beforeHistory),
  );
  const noPending = runPreflight(fixture, noPendingArguments);
  assert.notEqual(noPending.status, 0);
  assert.match(noPending.stderr, /exactly one pending migration/u);
});

test("hash-pins a test verifier override before executing it", async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  const argumentsList = await preflightArguments(fixture);
  const result = run("/bin/bash", [preflightScript, ...argumentsList], {
    env: environmentFor(fixture, {
      PRODUCTION_BACKUP_EVIDENCE_VERIFIER_SHA256: repeatedHash("9"),
    }),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /override evidence verifier SHA-256 does not match/u);
  assert.equal(result.stdout, "");
});

test("test clock requires an explicit hashed offline-fixture gate", async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  const argumentsList = await preflightArguments(fixture);

  const missingMode = runPreflight(fixture, argumentsList, {
    PRODUCTION_RECONCILIATION_PREFLIGHT_TEST_MODE: "",
  });
  assert.notEqual(missingMode.status, 0);
  assert.match(missingMode.stderr, /TEST_MODE=offline-fixture-only/u);

  const wrongClockHash = runPreflight(fixture, argumentsList, {
    PRODUCTION_RECONCILIATION_PREFLIGHT_TEST_CLOCK_SHA256: repeatedHash("9"),
  });
  assert.notEqual(wrongClockHash.status, 0);
  assert.match(wrongClockHash.stderr, /clock SHA-256 does not match/u);

  const productionVerifierEnvironment = environmentFor(fixture);
  delete productionVerifierEnvironment.PRODUCTION_BACKUP_EVIDENCE_VERIFIER_BIN;
  delete productionVerifierEnvironment.PRODUCTION_BACKUP_EVIDENCE_VERIFIER_SHA256;
  const productionVerifierClock = run(
    "/bin/bash",
    [preflightScript, ...argumentsList],
    { env: productionVerifierEnvironment },
  );
  assert.notEqual(productionVerifierClock.status, 0);
  assert.match(
    productionVerifierClock.stderr,
    /test clock is forbidden with the production evidence verifier/u,
  );
});
