#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifestText } from "./compare-database-manifests.mjs";
import { verifyReconciliationStage } from "./prepare-reconciliation-stage.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");

const versions = Object.freeze([
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
]);
const zeroHash = "0".repeat(64);
const hashPattern = /^[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const projectRefPattern = /^[a-z0-9]{20}$/u;
const rfc3339UtcSecondPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;

const planToolNames = Object.freeze([
  "artifactHelperSha256",
  "backupArtifactVerifierSha256",
  "backupEvidenceVerifierSha256",
  "commonHelperSha256",
  "clockSha256",
  "credentialValidatorSha256",
  "dockerBinSha256",
  "dumpScriptTransformerSha256",
  "effectVerificationHookSha256",
  "encryptedVolumeCheckHookSha256",
  "gitBinSha256",
  "historyVerifierSha256",
  "manifestValidatorSha256",
  "migrationHistoryHookSha256",
  "nodeBinSha256",
  "preflightSha256",
  "runnerSha256",
  "sourceFingerprintHookSha256",
  "sourceManifestHookSha256",
  "stageVerifierSha256",
  "supabaseCliSha256",
]);

const preflightKeys = Object.freeze([
  "PRODUCTION_RECONCILIATION_PREFLIGHT_SHA256",
  "PREFLIGHT_SCHEMA",
  "PREFLIGHT_SCOPE",
  "BACKUP_EVIDENCE_VERIFIER_SHA256",
  "BACKUP_ARTIFACT_VERIFIER_SHA256",
  "RECONCILIATION_STAGE_VERIFIER_SHA256",
  "RECONCILIATION_HISTORY_VERIFIER_SHA256",
  "RELEASE_COMMIT",
  "THROUGH_VERSION",
  "PROJECT_REF",
  "EXPECTED_BRANCH",
  "BACKUP_MANIFEST_SHA256",
  "RESTORE_EVIDENCE_MANIFEST_SHA256",
  "SOURCE_MANIFEST_SHA256",
  "SOURCE_FINGERPRINT_SHA256",
  "RELATION_SEQUENCE_COUNTS_SHA256",
  "MIGRATION_HISTORY_SHA256",
  "MANAGED_APPLICATION_DDL_SHA256",
  "CAPTURE_TOOLSET_SHA256",
  "RESTORE_TOOLSET_SHA256",
  "APPROVED_TOOL_MANIFEST",
  "APPROVED_TOOL_MANIFEST_SHA256",
  "DUMP_SCRIPT_TRANSFORMER_SHA256",
  "MIGRATION_HISTORY_STATE",
  "SUPABASE_CLI_SHA256",
  "POSTGRES_IMAGE_ID",
  "WRITER_QUIESCED_AT",
  "CAPTURE_STARTED_AT",
  "CAPTURED_AT",
  "CURRENT_TIME",
  "CLOCK_SOURCE",
  "CLOCK_SHA256",
  "MAX_CAPTURE_AGE_SECONDS",
  "CAPTURE_DIRECTORY",
  "RESTORE_DIRECTORY",
  "RECONCILIATION_STAGE",
  "RECONCILIATION_STAGE_MANIFEST_SHA256",
  "BEFORE_MIGRATION_HISTORY",
  "BEFORE_MIGRATION_HISTORY_SHA256",
]);

function fail(message) {
  throw new Error(`Production reconciliation artifacts: ${message}`);
}

function requireObject(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail(`${label} must be a JSON object`);
  }
}

function exactKeys(value, keys, label) {
  requireObject(value, label);
  assert.deepEqual(
    Object.keys(value).sort(),
    [...keys].sort(),
    `${label} must contain the exact keys`,
  );
}

function targetIndex(throughVersion) {
  const index = versions.indexOf(throughVersion);
  if (index < 0) fail("through version is not in the approved 13-version history");
  return index;
}

function timestamp(version) {
  return `${version.slice(0, 4)}-${version.slice(4, 6)}-${version.slice(6, 8)} `
    + `${version.slice(8, 10)}:${version.slice(10, 12)}:${version.slice(12, 14)}`;
}

async function readJson(filename, label) {
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`${label} must be a regular, non-symlink file`);
  }
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

async function readCanonicalJson(filename, label) {
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`${label} must be a regular, non-symlink file`);
  }
  const contents = await readFile(filename, "utf8");
  let value;
  try {
    value = JSON.parse(contents);
  } catch {
    fail(`${label} is not valid JSON`);
  }
  if (contents !== `${JSON.stringify(value, null, 2)}\n`) {
    fail(`${label} must use the exact canonical two-space JSON representation`);
  }
  return { contents, value };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireHash(value, label) {
  if (!hashPattern.test(value ?? "")) fail(`${label} must be a lowercase SHA-256`);
}

function requireCommit(value, label) {
  if (!commitPattern.test(value ?? "")) fail(`${label} must be an exact commit SHA`);
}

function requireUtcSecond(value, label) {
  const parsed = Date.parse(value);
  if (
    !rfc3339UtcSecondPattern.test(value ?? "")
    || !Number.isFinite(parsed)
    || new Date(parsed).toISOString().replace(".000Z", "Z") !== value
  ) {
    fail(`${label} must be a real canonical RFC3339 UTC second`);
  }
}

function requireAbsolute(value, label) {
  if (!path.isAbsolute(value ?? "")) fail(`${label} must be an absolute path`);
}

function requireSortedExactObjectHashes(value, keys, label) {
  exactKeys(value, keys, label);
  for (const key of keys) requireHash(value[key], `${label}.${key}`);
}

function validateCliHistory(value, phase, throughVersion) {
  if (!["before", "after"].includes(phase)) fail("phase must be before or after");
  const index = targetIndex(throughVersion);
  exactKeys(value, ["message", "migrations"], "CLI history envelope");
  if (value.message !== "Migrations listed" || !Array.isArray(value.migrations)) {
    fail("CLI history envelope does not match pinned v2.109.0 JSON output");
  }
  const expectedLocal = versions.slice(0, index + 1);
  if (value.migrations.length !== expectedLocal.length) {
    fail("CLI history does not contain the exact immutable local prefix");
  }
  for (let rowIndex = 0; rowIndex < value.migrations.length; rowIndex += 1) {
    const row = value.migrations[rowIndex];
    exactKeys(row, ["local", "remote", "time"], `CLI history row ${rowIndex + 1}`);
    const expectedVersion = expectedLocal[rowIndex];
    const expectedRemote = phase === "after" || rowIndex < index
      ? expectedVersion
      : "";
    if (
      row.local !== expectedVersion
      || row.remote !== expectedRemote
      || row.time !== timestamp(expectedVersion)
    ) {
      fail(`CLI history row ${rowIndex + 1} is not the exact ${phase} state`);
    }
  }
  return value.migrations;
}

function renderPinnedTable(rows) {
  const headers = ["Local", "Remote", "Time (UTC)"];
  const cells = rows.map((row) => [
    `\`${row.local}\``,
    row.remote ? `\`${row.remote}\`` : "` `",
    `\`${row.time}\``,
  ]);
  const widths = headers.map((header, cellIndex) =>
    Math.max(header.length, ...cells.map((row) => row[cellIndex].length))
  );
  return [
    `   ${headers.map((header, index) => header.padEnd(widths[index])).join(" | ")} `,
    `  ${widths.map((width) => "-".repeat(width + 2)).join("|")}`,
    ...cells.map((row) =>
      `   ${row.map((cell, index) => cell.padEnd(widths[index])).join(" | ")} `
    ),
    "",
  ].join("\n");
}

function validateRawHistory(value, phase, throughVersion, projectRef) {
  const index = targetIndex(throughVersion);
  exactKeys(
    value,
    [
      "projectRef",
      "rowCount",
      "schemaPresent",
      "schemaVersion",
      "tablePresent",
      "versions",
    ],
    "raw migration history",
  );
  if (value.schemaVersion !== 1 || value.projectRef !== projectRef) {
    fail("raw migration history identity does not match");
  }
  const expectedVersions = phase === "before"
    ? versions.slice(0, index)
    : versions.slice(0, index + 1);
  if (expectedVersions.length === 0) {
    if (
      value.schemaPresent !== false
      || value.tablePresent !== false
      || value.rowCount !== null
      || !Array.isArray(value.versions)
      || value.versions.length !== 0
    ) {
      fail("raw migration history must prove exact schema absence before stage one");
    }
    return;
  }
  if (
    value.schemaPresent !== true
    || value.tablePresent !== true
    || value.rowCount !== expectedVersions.length
    || !Array.isArray(value.versions)
    || JSON.stringify(value.versions) !== JSON.stringify(expectedVersions)
  ) {
    fail(`raw migration history is not the exact ${phase} approved prefix`);
  }
}

function validateMigrationUp(value, manifest, stage, throughVersion) {
  exactKeys(value, ["applied", "message"], "migration-up result");
  if (value.message !== "Migrations applied" || !Array.isArray(value.applied)) {
    fail("migration-up result does not match pinned v2.109.0 JSON output");
  }
  const matches = manifest.files?.filter(({ path: filename }) =>
    filename.startsWith("supabase/migrations/")
    && path.basename(filename).startsWith(`${throughVersion}_`)
  ) ?? [];
  if (matches.length !== 1 || value.applied.length !== 1) {
    fail("migration up must report exactly the one approved pending migration");
  }
  const expected = path.resolve(stage, matches[0].path);
  if (path.resolve(value.applied[0]) !== expected) {
    fail("migration up applied a path outside the exact immutable stage");
  }
}

async function verifyMigrationUp(value, stage, throughVersion) {
  const manifest = await readJson(
    path.join(stage, "reconciliation-stage.json"),
    "reconciliation stage manifest",
  );
  validateMigrationUp(value, manifest, stage, throughVersion);
}

function validateEffect(value, projectRef, throughVersion) {
  exactKeys(
    value,
    ["checks", "passed", "projectRef", "schemaVersion", "throughVersion"],
    "effect verification",
  );
  if (
    value.schemaVersion !== 1
    || value.projectRef !== projectRef
    || value.throughVersion !== throughVersion
    || value.passed !== true
    || !Array.isArray(value.checks)
    || value.checks.length === 0
  ) {
    fail("effect verification identity or pass state is invalid");
  }
  const names = [];
  for (const [index, check] of value.checks.entries()) {
    exactKeys(check, ["evidenceSha256", "name", "passed"], `effect check ${index + 1}`);
    if (
      typeof check.name !== "string"
      || !/^[a-z0-9][a-z0-9._-]{2,63}$/u.test(check.name)
      || check.passed !== true
      || !/^[a-f0-9]{64}$/u.test(check.evidenceSha256)
    ) {
      fail(`effect check ${index + 1} is invalid or did not pass`);
    }
    names.push(check.name);
  }
  if (
    new Set(names).size !== names.length
    || JSON.stringify(names) !== JSON.stringify([...names].sort())
  ) {
    fail("effect checks must have unique bytewise-sorted names");
  }
}

function validateReconciliationPlan(plan) {
  exactKeys(
    plan,
    [
      "approvedBackupToolManifestSha256",
      "artifactContract",
      "backupEvidence",
      "databaseClientContract",
      "expectedBranch",
      "expectedPost",
      "expectedPre",
      "previousCompletionSha256",
      "projectRef",
      "reconciliationStageManifestSha256",
      "releaseCommit",
      "schemaVersion",
      "throughVersion",
      "tools",
    ],
    "approved reconciliation plan",
  );
  if (
    plan.schemaVersion !== 1
    || plan.artifactContract !== "dominion-production-reconciliation-plan/v1"
    || plan.databaseClientContract !== "exact-docker-pgpass/v1"
    || plan.expectedBranch !== "main"
  ) {
    fail("approved reconciliation plan contract, branch, or database client boundary is invalid");
  }
  if (!projectRefPattern.test(plan.projectRef ?? "")) {
    fail("approved reconciliation plan projectRef is invalid");
  }
  requireCommit(plan.releaseCommit, "approved reconciliation plan releaseCommit");
  const index = targetIndex(plan.throughVersion);
  requireHash(plan.previousCompletionSha256, "approved reconciliation plan previous completion");
  if (index === 0 && plan.previousCompletionSha256 !== zeroHash) {
    fail("the first reconciliation plan must use the all-zero genesis completion");
  }
  if (index > 0 && plan.previousCompletionSha256 === zeroHash) {
    fail("only the first reconciliation plan may use the all-zero genesis completion");
  }

  exactKeys(
    plan.backupEvidence,
    [
      "backupManifestSha256",
      "captureToolsetSha256",
      "managedApplicationDdlSha256",
      "maxCaptureAgeSeconds",
      "migrationHistorySha256",
      "migrationHistoryState",
      "postgresImageId",
      "relationSequenceCountsSha256",
      "restoreEvidenceManifestSha256",
      "restoreToolsetSha256",
      "sourceFingerprintSha256",
      "sourceManifestSha256",
      "writerQuiescedAt",
    ],
    "approved reconciliation plan backupEvidence",
  );
  for (const key of [
    "backupManifestSha256",
    "captureToolsetSha256",
    "managedApplicationDdlSha256",
    "migrationHistorySha256",
    "relationSequenceCountsSha256",
    "restoreEvidenceManifestSha256",
    "restoreToolsetSha256",
    "sourceFingerprintSha256",
    "sourceManifestSha256",
  ]) requireHash(plan.backupEvidence[key], `backupEvidence.${key}`);
  if (!/^sha256:[a-f0-9]{64}$/u.test(plan.backupEvidence.postgresImageId ?? "")) {
    fail("backupEvidence.postgresImageId must be an exact image ID");
  }
  if (!['absent', 'present'].includes(plan.backupEvidence.migrationHistoryState)) {
    fail("backupEvidence.migrationHistoryState must be absent or present");
  }
  requireUtcSecond(plan.backupEvidence.writerQuiescedAt, "backupEvidence.writerQuiescedAt");
  if (
    !Number.isSafeInteger(plan.backupEvidence.maxCaptureAgeSeconds)
    || plan.backupEvidence.maxCaptureAgeSeconds <= 0
    || plan.backupEvidence.maxCaptureAgeSeconds > 3600
  ) {
    fail("backupEvidence.maxCaptureAgeSeconds must be an integer from 1 through 3600");
  }

  requireSortedExactObjectHashes(
    plan.expectedPre,
    ["sourceFingerprintSha256", "sourceManifestSha256"],
    "approved reconciliation plan expectedPre",
  );
  requireSortedExactObjectHashes(
    plan.expectedPost,
    [
      "effectVerificationSha256",
      "sourceFingerprintSha256",
      "sourceManifestSha256",
    ],
    "approved reconciliation plan expectedPost",
  );
  requireHash(
    plan.approvedBackupToolManifestSha256,
    "approved reconciliation plan backup tool manifest",
  );
  requireHash(
    plan.reconciliationStageManifestSha256,
    "approved reconciliation plan stage manifest",
  );
  requireSortedExactObjectHashes(
    plan.tools,
    planToolNames,
    "approved reconciliation plan tools",
  );
  if (
    index === 0
    && (
      plan.expectedPre.sourceManifestSha256 !== plan.backupEvidence.sourceManifestSha256
      || plan.expectedPre.sourceFingerprintSha256
        !== plan.backupEvidence.sourceFingerprintSha256
    )
  ) fail("the first plan pre-state must equal the independently verified backup state");
  return plan;
}

async function readAndValidatePlan(filename, expectedSha256) {
  requireHash(expectedSha256, "approved reconciliation plan file SHA-256");
  const { contents, value } = await readCanonicalJson(
    filename,
    "approved reconciliation plan",
  );
  if (sha256(contents) !== expectedSha256) {
    fail("approved reconciliation plan file SHA-256 does not match");
  }
  return validateReconciliationPlan(value);
}

function planMachineLines(plan, planSha256) {
  const backup = plan.backupEvidence;
  const lines = [
    ["APPROVED_RECONCILIATION_PLAN_SHA256", planSha256],
    ["PROJECT_REF", plan.projectRef],
    ["EXPECTED_BRANCH", plan.expectedBranch],
    ["RELEASE_COMMIT", plan.releaseCommit],
    ["THROUGH_VERSION", plan.throughVersion],
    ["PREVIOUS_COMPLETION_SHA256", plan.previousCompletionSha256],
    ["EXPECTED_PRE_SOURCE_MANIFEST_SHA256", plan.expectedPre.sourceManifestSha256],
    ["EXPECTED_PRE_SOURCE_FINGERPRINT_SHA256", plan.expectedPre.sourceFingerprintSha256],
    ["EXPECTED_POST_SOURCE_MANIFEST_SHA256", plan.expectedPost.sourceManifestSha256],
    ["EXPECTED_POST_SOURCE_FINGERPRINT_SHA256", plan.expectedPost.sourceFingerprintSha256],
    ["EXPECTED_EFFECT_VERIFICATION_SHA256", plan.expectedPost.effectVerificationSha256],
    ["BACKUP_MANIFEST_SHA256", backup.backupManifestSha256],
    ["RESTORE_EVIDENCE_MANIFEST_SHA256", backup.restoreEvidenceManifestSha256],
    ["BACKUP_SOURCE_MANIFEST_SHA256", backup.sourceManifestSha256],
    ["BACKUP_SOURCE_FINGERPRINT_SHA256", backup.sourceFingerprintSha256],
    ["BACKUP_RELATION_SEQUENCE_COUNTS_SHA256", backup.relationSequenceCountsSha256],
    ["BACKUP_MIGRATION_HISTORY_SHA256", backup.migrationHistorySha256],
    ["BACKUP_MANAGED_APPLICATION_DDL_SHA256", backup.managedApplicationDdlSha256],
    ["CAPTURE_TOOLSET_SHA256", backup.captureToolsetSha256],
    ["RESTORE_TOOLSET_SHA256", backup.restoreToolsetSha256],
    ["BACKUP_MIGRATION_HISTORY_STATE", backup.migrationHistoryState],
    ["POSTGRES_IMAGE_ID", backup.postgresImageId],
    ["WRITER_QUIESCED_AT", backup.writerQuiescedAt],
    ["MAX_CAPTURE_AGE_SECONDS", String(backup.maxCaptureAgeSeconds)],
    ["APPROVED_BACKUP_TOOL_MANIFEST_SHA256", plan.approvedBackupToolManifestSha256],
    ["RECONCILIATION_STAGE_MANIFEST_SHA256", plan.reconciliationStageManifestSha256],
    ["RUNNER_SHA256", plan.tools.runnerSha256],
    ["COMMON_HELPER_SHA256", plan.tools.commonHelperSha256],
    ["CLOCK_SHA256", plan.tools.clockSha256],
    ["ARTIFACT_HELPER_SHA256", plan.tools.artifactHelperSha256],
    ["BACKUP_ARTIFACT_VERIFIER_SHA256", plan.tools.backupArtifactVerifierSha256],
    ["BACKUP_EVIDENCE_VERIFIER_SHA256", plan.tools.backupEvidenceVerifierSha256],
    ["DUMP_SCRIPT_TRANSFORMER_SHA256", plan.tools.dumpScriptTransformerSha256],
    ["PREFLIGHT_SHA256", plan.tools.preflightSha256],
    ["STAGE_VERIFIER_SHA256", plan.tools.stageVerifierSha256],
    ["HISTORY_VERIFIER_SHA256", plan.tools.historyVerifierSha256],
    ["MANIFEST_VALIDATOR_SHA256", plan.tools.manifestValidatorSha256],
    ["CREDENTIAL_VALIDATOR_SHA256", plan.tools.credentialValidatorSha256],
    ["NODE_BIN_SHA256", plan.tools.nodeBinSha256],
    ["GIT_BIN_SHA256", plan.tools.gitBinSha256],
    ["SUPABASE_CLI_SHA256", plan.tools.supabaseCliSha256],
    ["DOCKER_BIN_SHA256", plan.tools.dockerBinSha256],
    ["SOURCE_MANIFEST_HOOK_SHA256", plan.tools.sourceManifestHookSha256],
    ["SOURCE_FINGERPRINT_HOOK_SHA256", plan.tools.sourceFingerprintHookSha256],
    ["MIGRATION_HISTORY_HOOK_SHA256", plan.tools.migrationHistoryHookSha256],
    ["ENCRYPTED_VOLUME_CHECK_HOOK_SHA256", plan.tools.encryptedVolumeCheckHookSha256],
    ["EFFECT_VERIFICATION_HOOK_SHA256", plan.tools.effectVerificationHookSha256],
  ];
  return `${lines.map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}

async function preparePlanFromRehearsal(contractFilename, outputFilename) {
  const { contents: contractContents, value: contract } = await readCanonicalJson(
    contractFilename,
    "reconciliation rehearsal contract",
  );
  exactKeys(
    contract,
    [
      "approvedBackupToolManifest",
      "artifactContract",
      "backupEvidence",
      "databaseClientContract",
      "expectedBranch",
      "expectedPostArtifacts",
      "expectedPreArtifacts",
      "previousCompletionSha256",
      "projectRef",
      "reconciliationStage",
      "releaseCommit",
      "schemaVersion",
      "throughVersion",
      "toolPaths",
    ],
    "reconciliation rehearsal contract",
  );
  if (
    contract.schemaVersion !== 1
    || contract.artifactContract
      !== "dominion-production-reconciliation-local-rehearsal/v1"
    || contract.databaseClientContract !== "exact-docker-pgpass/v1"
    || contract.expectedBranch !== "main"
  ) fail("reconciliation rehearsal contract identity is invalid");
  exactKeys(
    contract.expectedPreArtifacts,
    ["sourceFingerprint", "sourceManifest"],
    "rehearsal expectedPreArtifacts",
  );
  exactKeys(
    contract.expectedPostArtifacts,
    ["effectVerification", "sourceFingerprint", "sourceManifest"],
    "rehearsal expectedPostArtifacts",
  );
  exactKeys(contract.toolPaths, planToolNames, "rehearsal toolPaths");
  requireAbsolute(outputFilename, "approved plan output");
  const outputParent = await realpath(path.dirname(outputFilename));
  const output = path.join(outputParent, path.basename(outputFilename));
  const repository = await realpath(repositoryRoot);
  const relativeOutput = path.relative(repository, output);
  if (
    relativeOutput === ""
    || (!relativeOutput.startsWith("..") && !path.isAbsolute(relativeOutput))
  ) fail("approved plan output must be outside the release repository");
  try {
    await lstat(output);
    fail("approved plan output already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const artifactPaths = {
    preSourceManifest: contract.expectedPreArtifacts.sourceManifest,
    preSourceFingerprint: contract.expectedPreArtifacts.sourceFingerprint,
    postSourceManifest: contract.expectedPostArtifacts.sourceManifest,
    postSourceFingerprint: contract.expectedPostArtifacts.sourceFingerprint,
    effectVerification: contract.expectedPostArtifacts.effectVerification,
  };
  for (const [label, filename] of Object.entries(artifactPaths)) {
    requireAbsolute(filename, `rehearsal ${label}`);
    await hashFile(filename, `rehearsal ${label}`);
  }
  for (const label of [
    "preSourceManifest",
    "preSourceFingerprint",
    "postSourceManifest",
    "postSourceFingerprint",
  ]) {
    parseManifestText(await readFile(artifactPaths[label], "utf8"), artifactPaths[label]);
  }
  validateEffect(
    await readJson(artifactPaths.effectVerification, "rehearsal effect verification"),
    contract.projectRef,
    contract.throughVersion,
  );
  requireAbsolute(contract.reconciliationStage, "reconciliation stage");
  const stageRoot = await realpath(contract.reconciliationStage);
  await verifyReconciliationStage({
    stage: stageRoot,
    releaseCommit: contract.releaseCommit,
    throughVersion: contract.throughVersion,
  });
  const stageManifest = await readJson(
    path.join(stageRoot, "reconciliation-stage.json"),
    "reconciliation stage manifest",
  );
  if (
    stageManifest.releaseCommit !== contract.releaseCommit
    || stageManifest.throughVersion !== contract.throughVersion
  ) fail("reconciliation stage does not match the rehearsal release/version");
  requireAbsolute(contract.approvedBackupToolManifest, "approved backup tool manifest");
  const toolHashes = {};
  for (const name of planToolNames) {
    requireAbsolute(contract.toolPaths[name], `rehearsal toolPaths.${name}`);
    toolHashes[name] = await hashFile(
      contract.toolPaths[name],
      `rehearsal toolPaths.${name}`,
    );
  }
  const plan = validateReconciliationPlan({
    schemaVersion: 1,
    artifactContract: "dominion-production-reconciliation-plan/v1",
    databaseClientContract: contract.databaseClientContract,
    projectRef: contract.projectRef,
    expectedBranch: contract.expectedBranch,
    releaseCommit: contract.releaseCommit,
    throughVersion: contract.throughVersion,
    previousCompletionSha256: contract.previousCompletionSha256,
    backupEvidence: contract.backupEvidence,
    expectedPre: {
      sourceManifestSha256: await hashFile(
        artifactPaths.preSourceManifest,
        "rehearsal pre source manifest",
      ),
      sourceFingerprintSha256: await hashFile(
        artifactPaths.preSourceFingerprint,
        "rehearsal pre source fingerprint",
      ),
    },
    expectedPost: {
      sourceManifestSha256: await hashFile(
        artifactPaths.postSourceManifest,
        "rehearsal post source manifest",
      ),
      sourceFingerprintSha256: await hashFile(
        artifactPaths.postSourceFingerprint,
        "rehearsal post source fingerprint",
      ),
      effectVerificationSha256: await hashFile(
        artifactPaths.effectVerification,
        "rehearsal effect verification",
      ),
    },
    approvedBackupToolManifestSha256: await hashFile(
      contract.approvedBackupToolManifest,
      "approved backup tool manifest",
    ),
    reconciliationStageManifestSha256: await hashFile(
      path.join(stageRoot, "reconciliation-stage.json"),
      "reconciliation stage manifest",
    ),
    tools: toolHashes,
  });
  const planContents = `${JSON.stringify(plan, null, 2)}\n`;
  await writeFile(output, planContents, { flag: "wx", mode: 0o600 });
  return {
    contractSha256: sha256(contractContents),
    output,
    planSha256: sha256(planContents),
  };
}

async function validatePreflightRecord({
  filename,
  plan,
  planSha256,
  stage,
  beforeHistory,
  beforeHistorySha256,
  allowedClockSource,
}) {
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail("preflight record must be a regular, non-symlink file");
  }
  const contents = await readFile(filename, "utf8");
  if (!contents.endsWith("\n") || contents.includes("\r")) {
    fail("preflight record must be LF-terminated machine output");
  }
  const lines = contents.slice(0, -1).split("\n");
  if (lines.length !== preflightKeys.length) {
    fail(`preflight record must contain exactly ${preflightKeys.length} lines`);
  }
  const fields = {};
  for (let index = 0; index < lines.length; index += 1) {
    const separator = lines[index].indexOf("=");
    const key = lines[index].slice(0, separator);
    const value = lines[index].slice(separator + 1);
    if (separator < 1 || key !== preflightKeys[index] || value.length === 0) {
      fail(`preflight record line ${index + 1} must be exactly ${preflightKeys[index]}=<value>`);
    }
    fields[key] = value;
  }
  const computed = sha256(`${lines.slice(1).join("\n")}\n`);
  requireHash(fields.PRODUCTION_RECONCILIATION_PREFLIGHT_SHA256, "preflight digest");
  if (computed !== fields.PRODUCTION_RECONCILIATION_PREFLIGHT_SHA256) {
    fail("preflight record digest does not cover its exact machine output");
  }
  for (const key of [
    "BACKUP_EVIDENCE_VERIFIER_SHA256",
    "BACKUP_ARTIFACT_VERIFIER_SHA256",
    "RECONCILIATION_STAGE_VERIFIER_SHA256",
    "RECONCILIATION_HISTORY_VERIFIER_SHA256",
    "BACKUP_MANIFEST_SHA256",
    "RESTORE_EVIDENCE_MANIFEST_SHA256",
    "SOURCE_MANIFEST_SHA256",
    "SOURCE_FINGERPRINT_SHA256",
    "RELATION_SEQUENCE_COUNTS_SHA256",
    "MIGRATION_HISTORY_SHA256",
    "MANAGED_APPLICATION_DDL_SHA256",
    "CAPTURE_TOOLSET_SHA256",
    "RESTORE_TOOLSET_SHA256",
    "APPROVED_TOOL_MANIFEST_SHA256",
    "DUMP_SCRIPT_TRANSFORMER_SHA256",
    "SUPABASE_CLI_SHA256",
    "CLOCK_SHA256",
    "RECONCILIATION_STAGE_MANIFEST_SHA256",
    "BEFORE_MIGRATION_HISTORY_SHA256",
  ]) requireHash(fields[key], `preflight ${key}`);
  if (
    fields.PREFLIGHT_SCHEMA !== "77-dominion-production-reconciliation-preflight/v1"
    || fields.PREFLIGHT_SCOPE !== "offline-non-authorizing"
    || fields.RELEASE_COMMIT !== plan.releaseCommit
    || fields.THROUGH_VERSION !== plan.throughVersion
    || fields.PROJECT_REF !== plan.projectRef
    || fields.EXPECTED_BRANCH !== plan.expectedBranch
  ) fail("preflight release, project, branch, or schema identity does not match the approved plan");
  const expected = {
    BACKUP_MANIFEST_SHA256: plan.backupEvidence.backupManifestSha256,
    RESTORE_EVIDENCE_MANIFEST_SHA256: plan.backupEvidence.restoreEvidenceManifestSha256,
    SOURCE_MANIFEST_SHA256: plan.backupEvidence.sourceManifestSha256,
    SOURCE_FINGERPRINT_SHA256: plan.backupEvidence.sourceFingerprintSha256,
    RELATION_SEQUENCE_COUNTS_SHA256: plan.backupEvidence.relationSequenceCountsSha256,
    MIGRATION_HISTORY_SHA256: plan.backupEvidence.migrationHistorySha256,
    MANAGED_APPLICATION_DDL_SHA256: plan.backupEvidence.managedApplicationDdlSha256,
    CAPTURE_TOOLSET_SHA256: plan.backupEvidence.captureToolsetSha256,
    RESTORE_TOOLSET_SHA256: plan.backupEvidence.restoreToolsetSha256,
    APPROVED_TOOL_MANIFEST_SHA256: plan.approvedBackupToolManifestSha256,
    MIGRATION_HISTORY_STATE: plan.backupEvidence.migrationHistoryState,
    SUPABASE_CLI_SHA256: plan.tools.supabaseCliSha256,
    POSTGRES_IMAGE_ID: plan.backupEvidence.postgresImageId,
    WRITER_QUIESCED_AT: plan.backupEvidence.writerQuiescedAt,
    MAX_CAPTURE_AGE_SECONDS: String(plan.backupEvidence.maxCaptureAgeSeconds),
    RECONCILIATION_STAGE_MANIFEST_SHA256: plan.reconciliationStageManifestSha256,
    RECONCILIATION_STAGE_VERIFIER_SHA256: plan.tools.stageVerifierSha256,
    RECONCILIATION_HISTORY_VERIFIER_SHA256: plan.tools.historyVerifierSha256,
    BACKUP_EVIDENCE_VERIFIER_SHA256: plan.tools.backupEvidenceVerifierSha256,
    BACKUP_ARTIFACT_VERIFIER_SHA256: plan.tools.backupArtifactVerifierSha256,
    DUMP_SCRIPT_TRANSFORMER_SHA256: plan.tools.dumpScriptTransformerSha256,
    CLOCK_SHA256: plan.tools.clockSha256,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (fields[key] !== value) fail(`preflight ${key} does not match the approved plan`);
  }
  requireAbsolute(fields.APPROVED_TOOL_MANIFEST, "preflight approved tool manifest");
  requireAbsolute(fields.CAPTURE_DIRECTORY, "preflight capture directory");
  requireAbsolute(fields.RESTORE_DIRECTORY, "preflight restore directory");
  requireAbsolute(fields.RECONCILIATION_STAGE, "preflight reconciliation stage");
  requireAbsolute(fields.BEFORE_MIGRATION_HISTORY, "preflight before-history");
  if (
    (stage !== undefined && fields.RECONCILIATION_STAGE !== stage)
    || fields.BEFORE_MIGRATION_HISTORY !== beforeHistory
    || fields.BEFORE_MIGRATION_HISTORY_SHA256 !== beforeHistorySha256
  ) fail("preflight stage or live before-history identity does not match");
  if (fields.CLOCK_SOURCE !== allowedClockSource) {
    fail("preflight clock source is not allowed by this runner mode");
  }
  for (const key of ["CAPTURE_STARTED_AT", "CAPTURED_AT", "CURRENT_TIME", "WRITER_QUIESCED_AT"]) {
    requireUtcSecond(fields[key], `preflight ${key}`);
  }
  const writerQuiescedAt = Date.parse(fields.WRITER_QUIESCED_AT);
  const captureStartedAt = Date.parse(fields.CAPTURE_STARTED_AT);
  const capturedAt = Date.parse(fields.CAPTURED_AT);
  const currentTime = Date.parse(fields.CURRENT_TIME);
  const maxCaptureAgeSeconds = Number(fields.MAX_CAPTURE_AGE_SECONDS);
  if (
    !Number.isSafeInteger(maxCaptureAgeSeconds)
    || maxCaptureAgeSeconds !== plan.backupEvidence.maxCaptureAgeSeconds
    || captureStartedAt < writerQuiescedAt
    || capturedAt < captureStartedAt
    || currentTime < capturedAt
    || (currentTime - capturedAt) / 1000 > maxCaptureAgeSeconds
  ) fail("preflight capture chronology or freshness is invalid");
  return { fields, sha256: computed };
}

async function recordMutationBoundaryFreshness({
  preflightRecord,
  plan,
  planSha256,
  stage,
  beforeHistory,
  beforeHistorySha256,
  allowedClockSource,
  mutationBoundaryAt,
  output,
}) {
  requireUtcSecond(mutationBoundaryAt, "mutation boundary time");
  requireAbsolute(output, "mutation boundary freshness output");
  const preflight = await validatePreflightRecord({
    filename: preflightRecord,
    plan,
    planSha256,
    stage,
    beforeHistory,
    beforeHistorySha256,
    allowedClockSource,
  });
  const capturedAtMs = Date.parse(preflight.fields.CAPTURED_AT);
  const preflightCurrentTimeMs = Date.parse(preflight.fields.CURRENT_TIME);
  const mutationBoundaryAtMs = Date.parse(mutationBoundaryAt);
  const captureAgeSeconds = (mutationBoundaryAtMs - capturedAtMs) / 1000;
  if (
    mutationBoundaryAtMs < preflightCurrentTimeMs
    || captureAgeSeconds < 0
    || !Number.isSafeInteger(captureAgeSeconds)
    || captureAgeSeconds > plan.backupEvidence.maxCaptureAgeSeconds
  ) fail("backup capture is future-dated or stale at the mutation boundary");
  const evidence = {
    schemaVersion: 1,
    artifactContract:
      "dominion-production-reconciliation-mutation-boundary-freshness/v1",
    preflightSha256: preflight.sha256,
    capturedAt: preflight.fields.CAPTURED_AT,
    preflightCurrentTime: preflight.fields.CURRENT_TIME,
    mutationBoundaryAt,
    maxCaptureAgeSeconds: plan.backupEvidence.maxCaptureAgeSeconds,
    captureAgeSeconds,
  };
  const contents = `${JSON.stringify(evidence, null, 2)}\n`;
  await writeFile(output, contents, { flag: "wx", mode: 0o600 });
  return sha256(contents);
}

function validateMutationBoundaryFreshnessEvidence(value, { preflight, plan, manifest }) {
  exactKeys(
    value,
    [
      "artifactContract",
      "captureAgeSeconds",
      "capturedAt",
      "maxCaptureAgeSeconds",
      "mutationBoundaryAt",
      "preflightCurrentTime",
      "preflightSha256",
      "schemaVersion",
    ],
    "mutation-boundary freshness evidence",
  );
  if (
    value.schemaVersion !== 1
    || value.artifactContract
      !== "dominion-production-reconciliation-mutation-boundary-freshness/v1"
    || value.preflightSha256 !== preflight.sha256
    || value.capturedAt !== preflight.fields.CAPTURED_AT
    || value.preflightCurrentTime !== preflight.fields.CURRENT_TIME
    || value.maxCaptureAgeSeconds !== plan.backupEvidence.maxCaptureAgeSeconds
  ) fail("mutation-boundary freshness evidence identity is invalid");
  requireHash(value.preflightSha256, "mutation-boundary preflight SHA-256");
  requireUtcSecond(value.capturedAt, "mutation-boundary capturedAt");
  requireUtcSecond(value.preflightCurrentTime, "mutation-boundary preflightCurrentTime");
  requireUtcSecond(value.mutationBoundaryAt, "mutation-boundary timestamp");
  const capturedAtMs = Date.parse(value.capturedAt);
  const preflightCurrentTimeMs = Date.parse(value.preflightCurrentTime);
  const mutationBoundaryAtMs = Date.parse(value.mutationBoundaryAt);
  const expectedAgeSeconds = (mutationBoundaryAtMs - capturedAtMs) / 1000;
  if (
    !Number.isSafeInteger(value.captureAgeSeconds)
    || value.captureAgeSeconds !== expectedAgeSeconds
    || value.captureAgeSeconds < 0
    || value.captureAgeSeconds > value.maxCaptureAgeSeconds
    || mutationBoundaryAtMs < preflightCurrentTimeMs
    || mutationBoundaryAtMs < Date.parse(manifest.startedAt)
    || mutationBoundaryAtMs > Date.parse(manifest.completedAt)
  ) fail("mutation-boundary freshness evidence is stale or chronologically invalid");
}

const requiredCompletionArtifacts = Object.freeze([
  "approved-reconciliation-plan.json",
  "boundary-cli-history.json",
  "boundary-cli-history.stderr",
  "boundary-raw-history.json",
  "boundary-raw-history.stderr",
  "boundary-raw-history.stdout",
  "boundary-source-fingerprint.jsonl",
  "boundary-source-fingerprint.stderr",
  "boundary-source-fingerprint.stdout",
  "boundary-source-manifest.jsonl",
  "boundary-source-manifest.stderr",
  "boundary-source-manifest.stdout",
  "boundary-stage-verification.stderr",
  "boundary-stage-verification.stdout",
  "effect-verification.json",
  "effect-verification.stderr",
  "effect-verification.stdout",
  "final-encrypted-volume-attestation.stderr",
  "final-encrypted-volume-attestation.stdout",
  "migration-up.json",
  "migration-up.stderr",
  "mutation-boundary-freshness.json",
  "mutation-boundary-freshness.stderr",
  "mutation-boundary-freshness.stdout",
  "post-cli-history.json",
  "post-cli-history.stderr",
  "post-raw-history.json",
  "post-raw-history.stderr",
  "post-raw-history.stdout",
  "post-source-fingerprint.jsonl",
  "post-source-fingerprint.stderr",
  "post-source-fingerprint.stdout",
  "post-source-manifest.jsonl",
  "post-source-manifest.stderr",
  "post-source-manifest.stdout",
  "pre-cli-history.json",
  "pre-cli-history.pinned.txt",
  "pre-cli-history.stderr",
  "pre-raw-history.json",
  "pre-raw-history.stderr",
  "pre-raw-history.stdout",
  "pre-source-fingerprint.jsonl",
  "pre-source-fingerprint.stderr",
  "pre-source-fingerprint.stdout",
  "pre-source-manifest.jsonl",
  "pre-source-manifest.stderr",
  "pre-source-manifest.stdout",
  "preflight-record.txt",
  "preflight.stderr",
  "reconciliation-stage.json",
]);

async function hashFile(filename, label) {
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`${label} must be a regular, non-symlink file`);
  }
  return sha256(await readFile(filename));
}

async function validateCompletionEvidence({
  directory,
  phase,
  expectedCompletionSha256,
  expectedProjectRef,
  expectedReleaseCommit,
  expectedThroughVersion,
  expectedPlanSha256,
}) {
  if (!path.isAbsolute(directory ?? "")) fail("completion evidence directory must be absolute");
  if (!['before-finalize', 'complete'].includes(phase)) {
    fail("completion verification phase must be before-finalize or complete");
  }
  const directoryMetadata = await lstat(directory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    fail("completion evidence must be a real directory");
  }
  const root = await realpath(directory);
  const markerPath = path.join(root, "RECONCILIATION_COMPLETE.json");
  const manifestPath = path.join(root, "reconciliation.json");
  const incompletePath = path.join(root, "RECONCILIATION_INCOMPLETE.json");
  const [{ contents: markerContents, value: marker }, { contents: manifestContents, value: manifest }] =
    await Promise.all([
      readCanonicalJson(markerPath, "reconciliation completion marker"),
      readCanonicalJson(manifestPath, "reconciliation evidence manifest"),
    ]);
  const completionSha256 = sha256(markerContents);
  const manifestSha256 = sha256(manifestContents);
  if (expectedCompletionSha256 !== undefined) {
    requireHash(expectedCompletionSha256, "expected completion SHA-256");
    if (completionSha256 !== expectedCompletionSha256) {
      fail("completion marker SHA-256 does not match the expected chain identity");
    }
  }
  if (expectedPlanSha256 !== undefined) requireHash(expectedPlanSha256, "expected plan SHA-256");

  exactKeys(
    marker,
    [
      "approvedReconciliationPlanSha256",
      "artifactContract",
      "completedAt",
      "previousCompletionSha256",
      "projectRef",
      "reconciliationManifestSha256",
      "releaseCommit",
      "schemaVersion",
      "status",
      "throughVersion",
    ],
    "reconciliation completion marker",
  );
  exactKeys(
    manifest,
    [
      "approvedBackupToolManifestSha256",
      "approvedReconciliationPlanSha256",
      "artifactContract",
      "artifacts",
      "clock",
      "completedAt",
      "expectedBranch",
      "preflightSha256",
      "previousCompletionSha256",
      "projectRef",
      "reconciliationId",
      "reconciliationStageManifestSha256",
      "releaseCommit",
      "schemaVersion",
      "startedAt",
      "status",
      "throughVersion",
      "writerQuiescedAt",
    ],
    "reconciliation evidence manifest",
  );
  if (
    marker.schemaVersion !== 2
    || marker.artifactContract !== "dominion-production-reconciliation-completion/v2"
    || marker.status !== "complete"
    || manifest.schemaVersion !== 2
    || manifest.artifactContract !== "dominion-production-reconciliation-step/v2"
    || manifest.status !== "verified"
    || manifest.expectedBranch !== "main"
  ) fail("completion marker or reconciliation evidence manifest contract is invalid");
  requireCommit(marker.releaseCommit, "completion releaseCommit");
  if (!projectRefPattern.test(marker.projectRef ?? "")) fail("completion projectRef is invalid");
  const index = targetIndex(marker.throughVersion);
  for (const [label, value] of [
    ["completion previousCompletionSha256", marker.previousCompletionSha256],
    ["completion reconciliationManifestSha256", marker.reconciliationManifestSha256],
    ["completion approvedReconciliationPlanSha256", marker.approvedReconciliationPlanSha256],
    ["manifest previousCompletionSha256", manifest.previousCompletionSha256],
    ["manifest approvedReconciliationPlanSha256", manifest.approvedReconciliationPlanSha256],
    ["manifest preflightSha256", manifest.preflightSha256],
    ["manifest approvedBackupToolManifestSha256", manifest.approvedBackupToolManifestSha256],
    ["manifest reconciliationStageManifestSha256", manifest.reconciliationStageManifestSha256],
  ]) requireHash(value, label);
  requireUtcSecond(marker.completedAt, "completion completedAt");
  requireUtcSecond(manifest.startedAt, "manifest startedAt");
  requireUtcSecond(manifest.completedAt, "manifest completedAt");
  requireUtcSecond(manifest.writerQuiescedAt, "manifest writerQuiescedAt");
  if (Date.parse(manifest.completedAt) < Date.parse(manifest.startedAt)) {
    fail("completion precedes reconciliation start");
  }
  if (
    manifestSha256 !== marker.reconciliationManifestSha256
    || manifest.projectRef !== marker.projectRef
    || manifest.releaseCommit !== marker.releaseCommit
    || manifest.throughVersion !== marker.throughVersion
    || manifest.previousCompletionSha256 !== marker.previousCompletionSha256
    || manifest.approvedReconciliationPlanSha256 !== marker.approvedReconciliationPlanSha256
    || manifest.completedAt !== marker.completedAt
  ) fail("completion marker does not bind the exact reconciliation manifest");
  if (index === 0 && marker.previousCompletionSha256 !== zeroHash) {
    fail("the first completion must chain to the all-zero genesis identity");
  }
  if (index > 0 && marker.previousCompletionSha256 === zeroHash) {
    fail("a non-first completion cannot chain to genesis");
  }
  if (
    (expectedProjectRef !== undefined && marker.projectRef !== expectedProjectRef)
    || (expectedReleaseCommit !== undefined && marker.releaseCommit !== expectedReleaseCommit)
    || (expectedThroughVersion !== undefined && marker.throughVersion !== expectedThroughVersion)
    || (expectedPlanSha256 !== undefined && marker.approvedReconciliationPlanSha256 !== expectedPlanSha256)
  ) fail("completion evidence does not match its expected project, release, version, or plan");

  const planPath = path.join(root, "approved-reconciliation-plan.json");
  const plan = await readAndValidatePlan(planPath, marker.approvedReconciliationPlanSha256);
  if (
    plan.projectRef !== marker.projectRef
    || plan.releaseCommit !== marker.releaseCommit
    || plan.throughVersion !== marker.throughVersion
    || plan.previousCompletionSha256 !== marker.previousCompletionSha256
    || plan.approvedBackupToolManifestSha256 !== manifest.approvedBackupToolManifestSha256
    || plan.reconciliationStageManifestSha256 !== manifest.reconciliationStageManifestSha256
  ) fail("copied approved plan does not match the completed reconciliation");

  exactKeys(manifest.clock, ["sha256", "source"], "reconciliation clock");
  requireHash(manifest.clock.sha256, "reconciliation clock SHA-256");
  if (!['system-utc', 'test-only-hashed-override'].includes(manifest.clock.source)) {
    fail("reconciliation clock source is invalid");
  }
  if (
    manifest.writerQuiescedAt !== plan.backupEvidence.writerQuiescedAt
    || manifest.clock.sha256 !== plan.tools.clockSha256
  ) fail("completion clock or writer-quiescence identity does not match the approved plan");
  exactKeys(manifest.artifacts, requiredCompletionArtifacts, "reconciliation artifact inventory");
  const expectedDirectoryEntries = [
    ...requiredCompletionArtifacts,
    "RECONCILIATION_COMPLETE.json",
    "reconciliation.json",
    ...(phase === "before-finalize" ? ["RECONCILIATION_INCOMPLETE.json"] : []),
  ].sort();
  const entries = await readdir(root, { withFileTypes: true });
  const actualDirectoryEntries = entries.map(({ name }) => name).sort();
  if (JSON.stringify(actualDirectoryEntries) !== JSON.stringify(expectedDirectoryEntries)) {
    fail("completion evidence directory contains missing or unexpected artifacts");
  }
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      fail(`completion evidence entry must be a regular file: ${entry.name}`);
    }
  }
  for (const name of requiredCompletionArtifacts) {
    requireHash(manifest.artifacts[name], `artifact inventory ${name}`);
    if (await hashFile(path.join(root, name), `reconciliation artifact ${name}`) !== manifest.artifacts[name]) {
      fail(`reconciliation artifact SHA-256 mismatch: ${name}`);
    }
  }
  if (manifest.artifacts["approved-reconciliation-plan.json"] !== marker.approvedReconciliationPlanSha256) {
    fail("artifact inventory does not bind the copied approved plan");
  }
  if (manifest.artifacts["reconciliation-stage.json"] !== plan.reconciliationStageManifestSha256) {
    fail("artifact inventory does not bind the exact approved reconciliation stage manifest");
  }
  if (
    manifest.artifacts["pre-source-manifest.jsonl"] !== plan.expectedPre.sourceManifestSha256
    || manifest.artifacts["pre-source-fingerprint.jsonl"] !== plan.expectedPre.sourceFingerprintSha256
    || manifest.artifacts["post-source-manifest.jsonl"] !== plan.expectedPost.sourceManifestSha256
    || manifest.artifacts["post-source-fingerprint.jsonl"] !== plan.expectedPost.sourceFingerprintSha256
    || manifest.artifacts["effect-verification.json"] !== plan.expectedPost.effectVerificationSha256
  ) fail("approved pre/post/effect result hashes do not match completion artifacts");
  for (const name of ["source-manifest.jsonl", "source-fingerprint.jsonl", "raw-history.json", "cli-history.json"]) {
    if (manifest.artifacts[`pre-${name}`] !== manifest.artifacts[`boundary-${name}`]) {
      fail(`preflight-to-apply boundary drift is recorded for ${name}`);
    }
  }
  const beforeHistoryPath = path.join(root, "pre-cli-history.pinned.txt");
  const beforeHistorySha256 = await hashFile(beforeHistoryPath, "pinned before-history");
  const preflight = await validatePreflightRecord({
    filename: path.join(root, "preflight-record.txt"),
    plan,
    planSha256: marker.approvedReconciliationPlanSha256,
    stage: undefined,
    beforeHistory: beforeHistoryPath,
    beforeHistorySha256,
    allowedClockSource: manifest.clock.source,
  });
  if (preflight.sha256 !== manifest.preflightSha256) {
    fail("completion manifest does not bind the strictly verified preflight record");
  }
  const { value: freshnessEvidence } = await readCanonicalJson(
    path.join(root, "mutation-boundary-freshness.json"),
    "mutation-boundary freshness evidence",
  );
  validateMutationBoundaryFreshnessEvidence(freshnessEvidence, { preflight, plan, manifest });
  const freshnessStdout = await readFile(
    path.join(root, "mutation-boundary-freshness.stdout"),
    "utf8",
  );
  const freshnessSha256 = await hashFile(
    path.join(root, "mutation-boundary-freshness.json"),
    "mutation-boundary freshness evidence",
  );
  if (freshnessStdout !== `MUTATION_BOUNDARY_FRESHNESS_SHA256=${freshnessSha256}\n`) {
    fail("mutation-boundary freshness helper output is invalid");
  }
  const finalVolumeOutput = await readFile(
    path.join(root, "final-encrypted-volume-attestation.stdout"),
    "utf8",
  );
  if (finalVolumeOutput !== `DOMINION_ENCRYPTED_VOLUME_OK=${path.dirname(root)}\n`) {
    fail("final encrypted-volume attestation does not bind the evidence destination");
  }
  const stageManifest = await readJson(
    path.join(root, "reconciliation-stage.json"),
    "copied reconciliation stage manifest",
  );
  validateMigrationUp(
    await readJson(path.join(root, "migration-up.json"), "migration-up result"),
    stageManifest,
    preflight.fields.RECONCILIATION_STAGE,
    marker.throughVersion,
  );
  validateCliHistory(
    await readJson(path.join(root, "pre-cli-history.json"), "pre CLI history"),
    "before",
    marker.throughVersion,
  );
  validateCliHistory(
    await readJson(path.join(root, "boundary-cli-history.json"), "boundary CLI history"),
    "before",
    marker.throughVersion,
  );
  validateCliHistory(
    await readJson(path.join(root, "post-cli-history.json"), "post CLI history"),
    "after",
    marker.throughVersion,
  );
  validateRawHistory(
    await readJson(path.join(root, "pre-raw-history.json"), "pre raw history"),
    "before",
    marker.throughVersion,
    marker.projectRef,
  );
  validateRawHistory(
    await readJson(path.join(root, "boundary-raw-history.json"), "boundary raw history"),
    "before",
    marker.throughVersion,
    marker.projectRef,
  );
  validateRawHistory(
    await readJson(path.join(root, "post-raw-history.json"), "post raw history"),
    "after",
    marker.throughVersion,
    marker.projectRef,
  );
  validateEffect(
    await readJson(path.join(root, "effect-verification.json"), "effect verification"),
    marker.projectRef,
    marker.throughVersion,
  );
  if (phase === "before-finalize") {
    const { value: incomplete } = await readCanonicalJson(
      incompletePath,
      "reconciliation incomplete marker",
    );
    exactKeys(
      incomplete,
      [
        "approvedReconciliationPlanSha256",
        "artifactContract",
        "projectRef",
        "reconciliationId",
        "releaseCommit",
        "schemaVersion",
        "startedAt",
        "status",
        "throughVersion",
      ],
      "reconciliation incomplete marker",
    );
    if (
      incomplete.schemaVersion !== 1
      || incomplete.artifactContract !== "dominion-production-reconciliation-incomplete/v1"
      || incomplete.status !== "incomplete"
      || incomplete.projectRef !== marker.projectRef
      || incomplete.releaseCommit !== marker.releaseCommit
      || incomplete.throughVersion !== marker.throughVersion
      || incomplete.approvedReconciliationPlanSha256 !== marker.approvedReconciliationPlanSha256
      || incomplete.reconciliationId !== manifest.reconciliationId
      || incomplete.startedAt !== manifest.startedAt
    ) fail("incomplete marker does not bind the reconciliation being finalized");
  }
  return { completionSha256, manifest, marker, plan, root };
}

async function findCompletionByHash(destination, digest) {
  const matches = [];
  for (const entry of await readdir(destination, { withFileTypes: true })) {
    if (!entry.name.startsWith("reconciliation-") || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidate = path.join(destination, entry.name, "RECONCILIATION_COMPLETE.json");
    try {
      if (await hashFile(candidate, "candidate completion marker") === digest) {
        matches.push(path.dirname(candidate));
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (matches.length !== 1) {
    fail(`expected exactly one prior completion matching ${digest}; found ${matches.length}`);
  }
  return matches[0];
}

async function validatePreviousChain({
  destination,
  tipDirectory,
  expectedTipSha256,
  plan,
}) {
  const destinationRoot = await realpath(destination);
  const tipRoot = await realpath(tipDirectory);
  if (path.dirname(tipRoot) !== destinationRoot) {
    fail("prior completion evidence must be a direct child of the same encrypted destination");
  }
  const target = targetIndex(plan.throughVersion);
  if (target === 0) fail("the first stage must use genesis, not a prior completion directory");
  if (plan.previousCompletionSha256 !== expectedTipSha256) {
    fail("prior completion argument does not match the approved plan chain identity");
  }
  let expectedIndex = target - 1;
  let currentDirectory = tipRoot;
  let currentSha256 = expectedTipSha256;
  while (expectedIndex >= 0) {
    const evidence = await validateCompletionEvidence({
      directory: currentDirectory,
      phase: "complete",
      expectedCompletionSha256: currentSha256,
      expectedProjectRef: plan.projectRef,
      expectedReleaseCommit: plan.releaseCommit,
      expectedThroughVersion: versions[expectedIndex],
    });
    if (expectedIndex === target - 1) {
      if (
        evidence.manifest.artifacts["post-source-manifest.jsonl"]
          !== plan.expectedPre.sourceManifestSha256
        || evidence.manifest.artifacts["post-source-fingerprint.jsonl"]
          !== plan.expectedPre.sourceFingerprintSha256
      ) fail("approved next-stage pre-state does not equal the verified prior completion result");
    }
    if (expectedIndex === 0) {
      if (evidence.marker.previousCompletionSha256 !== zeroHash) {
        fail("completion chain does not terminate at genesis");
      }
      break;
    }
    currentSha256 = evidence.marker.previousCompletionSha256;
    if (currentSha256 === zeroHash) fail("completion chain reaches genesis before stage one");
    currentDirectory = await findCompletionByHash(destinationRoot, currentSha256);
    expectedIndex -= 1;
  }
  return expectedTipSha256;
}

function parseArguments(tokens) {
  const options = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (!flag?.startsWith("--") || value === undefined) fail("invalid arguments");
    const key = flag.slice(2);
    if (Object.hasOwn(options, key)) fail(`duplicate --${key}`);
    options[key] = value;
  }
  return options;
}

function requireExactOptions(options, names) {
  assert.deepEqual(
    Object.keys(options).sort(),
    [...names].sort(),
    "command received unsupported or missing options",
  );
}

const [command, ...rawTokens] = process.argv.slice(2);
const tokens = rawTokens[0] === "--" ? rawTokens.slice(1) : rawTokens;
const options = parseArguments(tokens);

try {
switch (command) {
  case "prepare-plan": {
    requireExactOptions(options, ["output", "rehearsal-contract"]);
    const result = await preparePlanFromRehearsal(
      options["rehearsal-contract"],
      options.output,
    );
    process.stdout.write([
      `APPROVED_RECONCILIATION_PLAN_SHA256=${result.planSha256}`,
      `REHEARSAL_CONTRACT_SHA256=${result.contractSha256}`,
      `OUTPUT=${result.output}`,
      "",
    ].join("\n"));
    break;
  }
  case "verify-plan": {
    requireExactOptions(options, ["input", "input-sha256"]);
    const plan = await readAndValidatePlan(options.input, options["input-sha256"]);
    process.stdout.write(planMachineLines(plan, options["input-sha256"]));
    break;
  }
  case "verify-preflight-record": {
    requireExactOptions(options, [
      "allowed-clock-source",
      "before-history",
      "before-history-sha256",
      "input",
      "plan",
      "plan-sha256",
      "stage",
    ]);
    const plan = await readAndValidatePlan(options.plan, options["plan-sha256"]);
    requireHash(options["before-history-sha256"], "before-history SHA-256");
    const result = await validatePreflightRecord({
      filename: options.input,
      plan,
      planSha256: options["plan-sha256"],
      stage: options.stage,
      beforeHistory: options["before-history"],
      beforeHistorySha256: options["before-history-sha256"],
      allowedClockSource: options["allowed-clock-source"],
    });
    process.stdout.write(`PRODUCTION_RECONCILIATION_PREFLIGHT_SHA256=${result.sha256}\n`);
    break;
  }
  case "record-mutation-boundary-freshness": {
    requireExactOptions(options, [
      "allowed-clock-source",
      "before-history",
      "before-history-sha256",
      "mutation-boundary-at",
      "output",
      "plan",
      "plan-sha256",
      "preflight-record",
      "stage",
    ]);
    const plan = await readAndValidatePlan(options.plan, options["plan-sha256"]);
    requireHash(options["before-history-sha256"], "before-history SHA-256");
    const result = await recordMutationBoundaryFreshness({
      preflightRecord: options["preflight-record"],
      plan,
      planSha256: options["plan-sha256"],
      stage: options.stage,
      beforeHistory: options["before-history"],
      beforeHistorySha256: options["before-history-sha256"],
      allowedClockSource: options["allowed-clock-source"],
      mutationBoundaryAt: options["mutation-boundary-at"],
      output: options.output,
    });
    process.stdout.write(`MUTATION_BOUNDARY_FRESHNESS_SHA256=${result}\n`);
    break;
  }
  case "verify-completion": {
    requireExactOptions(options, [
      "approved-plan-sha256",
      "completion-sha256",
      "evidence-directory",
      "phase",
      "project-ref",
      "release-commit",
      "through-version",
    ]);
    const result = await validateCompletionEvidence({
      directory: options["evidence-directory"],
      phase: options.phase,
      expectedCompletionSha256: options["completion-sha256"],
      expectedProjectRef: options["project-ref"],
      expectedReleaseCommit: options["release-commit"],
      expectedThroughVersion: options["through-version"],
      expectedPlanSha256: options["approved-plan-sha256"],
    });
    process.stdout.write(
      `PRODUCTION_RECONCILIATION_COMPLETION_SHA256=${result.completionSha256}\n`,
    );
    break;
  }
  case "verify-previous-chain": {
    requireExactOptions(options, [
      "approved-plan",
      "approved-plan-sha256",
      "destination",
      "tip-evidence-directory",
    ]);
    const plan = await readAndValidatePlan(
      options["approved-plan"],
      options["approved-plan-sha256"],
    );
    const result = await validatePreviousChain({
      destination: options.destination,
      tipDirectory: options["tip-evidence-directory"],
      expectedTipSha256: plan.previousCompletionSha256,
      plan,
    });
    process.stdout.write(`PREVIOUS_COMPLETION_SHA256=${result}\n`);
    break;
  }
  case "verify-cli-history": {
    requireExactOptions(options, ["input", "phase", "through-version"]);
    validateCliHistory(
      await readJson(options.input, "CLI history"),
      options.phase,
      options["through-version"],
    );
    break;
  }
  case "render-pinned-history": {
    requireExactOptions(options, ["input", "output", "phase", "through-version"]);
    const rows = validateCliHistory(
      await readJson(options.input, "CLI history"),
      options.phase,
      options["through-version"],
    );
    await writeFile(options.output, renderPinnedTable(rows), {
      flag: "wx",
      mode: 0o600,
    });
    break;
  }
  case "verify-raw-history": {
    requireExactOptions(options, ["input", "phase", "project-ref", "through-version"]);
    validateRawHistory(
      await readJson(options.input, "raw migration history"),
      options.phase,
      options["through-version"],
      options["project-ref"],
    );
    break;
  }
  case "verify-migration-up": {
    requireExactOptions(options, ["input", "stage", "through-version"]);
    await verifyMigrationUp(
      await readJson(options.input, "migration-up result"),
      options.stage,
      options["through-version"],
    );
    break;
  }
  case "verify-effect": {
    requireExactOptions(options, ["input", "project-ref", "through-version"]);
    validateEffect(
      await readJson(options.input, "effect verification"),
      options["project-ref"],
      options["through-version"],
    );
    break;
  }
  default:
    fail(`unsupported command: ${command ?? "<missing>"}`);
}
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
