#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  open,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const safeIdPattern = /^[a-z0-9][a-z0-9._-]{2,63}$/u;
const rfc3339UtcSecondPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const rehearsalArtifactNames = Object.freeze([
  "effect-verification.json",
  "post-relation-sequence-counts.json",
  "post-source-fingerprint.jsonl",
  "post-source-manifest.jsonl",
  "pre-relation-sequence-counts.json",
  "pre-source-fingerprint.jsonl",
  "pre-source-manifest.jsonl",
]);
const stateHashNames = Object.freeze([
  "relationSequenceCountsSha256",
  "sourceFingerprintSha256",
  "sourceManifestSha256",
]);
const rehearsalToolNames = Object.freeze([
  "cleanEnvironmentLauncherSha256",
  "dockerBinSha256",
  "effectVerificationHookSha256",
  "encryptedVolumeCheckHookSha256",
  "inputPinningHelperSha256",
  "macosTcbAttestationSha256",
  "nodeBinSha256",
  "offlinePgsodiumGetkeySha256",
  "operatorDispatcherSha256",
  "operatorSqlSha256",
  "rehearsalDriverSha256",
  "rehearsalWrapperSha256",
  "stageVerifierSha256",
]);
const rehearsalToolPathNames = Object.freeze(
  rehearsalToolNames.filter((name) => name !== "macosTcbAttestationSha256"),
);

const planToolNames = Object.freeze([
  "artifactHelperSha256",
  "backupArtifactVerifierSha256",
  "backupEvidenceVerifierSha256",
  "commonHelperSha256",
  "cleanEnvironmentLauncherSha256",
  "clockSha256",
  "credentialValidatorSha256",
  "dockerBinSha256",
  "dumpScriptTransformerSha256",
  "effectVerificationHookSha256",
  "encryptedVolumeCheckHookSha256",
  "gitBinSha256",
  "historyVerifierSha256",
  "inputPinningHelperSha256",
  "manifestValidatorSha256",
  "migrationHistoryHookSha256",
  "nodeBinSha256",
  "preflightSha256",
  "relationCountsHookSha256",
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
  "DATABASE_HOST",
  "SSL_MODE",
  "SSL_ROOT_CERT_SHA256",
  "SSL_ROOT_CERT_RELATIVE_PATH",
  "ENCRYPTED_VOLUME_ATTESTATION_SHA256",
  "DOCKER_ENDPOINT",
  "DOCKER_SOCKET",
  "DOCKER_SOCKET_DEVICE",
  "DOCKER_SOCKET_INODE",
  "DOCKER_SOCKET_OWNER_UID",
  "DOCKER_SOCKET_OWNER_MODE",
  "DOCKER_SHARED_HOME_ROOT",
  "MACOS_TCB_ATTESTATION_SHA256",
  "RELEASE_REPOSITORY",
  "EXPECTED_BRANCH",
  "RECONCILIATION_ARTIFACT_HELPER_SHA256",
  "REHEARSAL_EVIDENCE_MANIFEST_SHA256",
  "REHEARSAL_EVIDENCE_DIRECTORY",
  "REHEARSAL_CAPTURE_ID",
  "REHEARSAL_RESTORE_ID",
  "REHEARSAL_STAGE_NUMBER",
  "REHEARSAL_PRE_STATE_SHA256",
  "REHEARSAL_POST_STATE_SHA256",
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

function requireNoExtendedAcl(filename, label) {
  if (process.platform !== "darwin") return;
  const result = spawnSync("/bin/ls", ["-lde", filename], {
    encoding: "utf8",
    env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
  });
  if (result.status !== 0 || result.stdout.trimEnd().includes("\n")) {
    fail(`${label} must not have an extended ACL`);
  }
}

function sameSealedFileState(before, after) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.mode === after.mode
    && before.uid === after.uid
    && before.gid === after.gid
    && before.nlink === after.nlink
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs;
}

async function readHandleBoundFile(filename, label, {
  allowedModes,
  requireCurrentUser = false,
  requireNoAcl = false,
  requireSingleLink = false,
} = {}) {
  if (!path.isAbsolute(filename ?? "")) fail(`${label} path must be absolute`);
  if (await realpath(filename) !== filename) fail(`${label} path must already be canonical`);
  const handle = await open(
    filename,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await handle.stat({ bigint: true });
    const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : before.uid;
    const mode = Number(before.mode) & 0o777;
    if (
      !before.isFile()
      || (requireCurrentUser && before.uid !== uid)
      || (requireSingleLink && before.nlink !== 1n)
      || (allowedModes !== undefined && !allowedModes.includes(mode))
    ) {
      fail(`${label} file metadata does not match its sealed contract`);
    }
    if (requireNoAcl) requireNoExtendedAcl(filename, label);
    const contents = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathMetadata = await lstat(filename, { bigint: true });
    if (
      !sameSealedFileState(before, after)
      || before.dev !== pathMetadata.dev
      || before.ino !== pathMetadata.ino
      || BigInt(contents.length) !== before.size
    ) fail(`${label} changed while it was being read`);
    if (requireNoAcl) requireNoExtendedAcl(filename, label);
    return contents;
  } finally {
    await handle.close();
  }
}

async function readSealedFile(filename, label) {
  return readHandleBoundFile(filename, label, {
    allowedModes: [0o400, 0o600],
    requireCurrentUser: true,
    requireNoAcl: true,
    requireSingleLink: true,
  });
}

async function readJson(filename, label, expectedSha256) {
  const contents = await readSealedFile(filename, label);
  if (expectedSha256 !== undefined && sha256(contents) !== expectedSha256) {
    fail(`${label} SHA-256 does not match its sealed manifest`);
  }
  try {
    return JSON.parse(contents.toString("utf8"));
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

async function readCanonicalJson(filename, label, expectedSha256) {
  const bytes = await readSealedFile(filename, label);
  if (expectedSha256 !== undefined && sha256(bytes) !== expectedSha256) {
    fail(`${label} SHA-256 does not match its sealed manifest`);
  }
  const contents = bytes.toString("utf8");
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

function requireCanonicalAbsolutePathSyntax(value, label) {
  requireAbsolute(value, label);
  if (path.normalize(value) !== value || value === path.parse(value).root) {
    fail(`${label} must be a normalized non-root absolute path`);
  }
}

async function requireCanonicalOwnedDirectory(value, label) {
  requireCanonicalAbsolutePathSyntax(value, label);
  const metadata = await lstat(value);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail(`${label} must be a real, non-symlink directory`);
  }
  if (await realpath(value) !== value) fail(`${label} must be canonical`);
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    fail(`${label} must be owned by the current user`);
  }
  return value;
}

async function requireSealedEvidenceDirectory(value, label) {
  requireCanonicalAbsolutePathSyntax(value, label);
  const metadata = await lstat(value, { bigint: true });
  const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : metadata.uid;
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || metadata.uid !== uid
    || (Number(metadata.mode) & 0o777) !== 0o700
  ) {
    fail(`${label} must be a canonical current-user-owned mode 0700 directory`);
  }
  if (await realpath(value) !== value) fail(`${label} must already be canonical`);
  requireNoExtendedAcl(value, label);
  return { metadata, root: value };
}

async function revalidateSealedEvidenceDirectory(root, before, label) {
  const after = await lstat(root, { bigint: true });
  if (
    !after.isDirectory()
    || after.isSymbolicLink()
    || !sameSealedFileState(before, after)
    || await realpath(root) !== root
  ) fail(`${label} changed while it was being verified`);
  requireNoExtendedAcl(root, label);
}

function requireContainedPath(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (
    relative === ""
    || relative.startsWith(`..${path.sep}`)
    || relative === ".."
    || path.isAbsolute(relative)
  ) fail(`${label} must be strictly contained by ${root}`);
}

function requireSortedExactObjectHashes(value, keys, label) {
  exactKeys(value, keys, label);
  for (const key of keys) requireHash(value[key], `${label}.${key}`);
}

function validateDockerContext(value, label) {
  exactKeys(
    value,
    ["device", "endpoint", "inode", "ownerMode", "ownerUid", "socketPath"],
    label,
  );
  if (
    !path.isAbsolute(value.socketPath ?? "")
    || value.endpoint !== `unix://${value.socketPath}`
    || !/^[0-9]+$/u.test(value.device ?? "")
    || !/^[0-9]+$/u.test(value.inode ?? "")
    || !Number.isSafeInteger(value.ownerUid)
    || value.ownerUid < 0
    || value.ownerMode !== 384
  ) fail(`${label} is not an exact owner-only canonical Unix socket identity`);
  return value;
}

function validateBackupEvidence(value, label) {
  exactKeys(
    value,
    [
      "backupManifestSha256",
      "captureToolsetSha256",
      "databaseHost",
      "dockerContext",
      "dockerSharedHomeRoot",
      "encryptedVolumeAttestationSha256",
      "macosTcbAttestationSha256",
      "managedApplicationDdlSha256",
      "maxCaptureAgeSeconds",
      "migrationHistorySha256",
      "migrationHistoryState",
      "postgresImageId",
      "relationSequenceCountsSha256",
      "restoreEvidenceManifestSha256",
      "restoreToolsetSha256",
      "sslRootCertSha256",
      "sslRootCertRelativePath",
      "sourceFingerprintSha256",
      "sourceManifestSha256",
      "writerQuiescedAt",
    ],
    label,
  );
  for (const key of [
    "backupManifestSha256",
    "captureToolsetSha256",
    "encryptedVolumeAttestationSha256",
    "macosTcbAttestationSha256",
    "managedApplicationDdlSha256",
    "migrationHistorySha256",
    "relationSequenceCountsSha256",
    "restoreEvidenceManifestSha256",
    "restoreToolsetSha256",
    "sslRootCertSha256",
    "sourceFingerprintSha256",
    "sourceManifestSha256",
  ]) requireHash(value[key], `${label}.${key}`);
  if (!/^[a-z0-9-]+\.pooler\.supabase\.com$/u.test(value.databaseHost ?? "")) {
    fail(`${label}.databaseHost is invalid`);
  }
  validateDockerContext(value.dockerContext, `${label}.dockerContext`);
  requireCanonicalAbsolutePathSyntax(
    value.dockerSharedHomeRoot,
    `${label}.dockerSharedHomeRoot`,
  );
  if (value.sslRootCertRelativePath !== "private/supabase-ca/prod-ca-2021.crt") {
    fail(`${label}.sslRootCertRelativePath is not the reviewed encrypted-volume path`);
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(value.postgresImageId ?? "")) {
    fail(`${label}.postgresImageId must be an exact image ID`);
  }
  if (!["absent", "present"].includes(value.migrationHistoryState)) {
    fail(`${label}.migrationHistoryState must be absent or present`);
  }
  requireUtcSecond(value.writerQuiescedAt, `${label}.writerQuiescedAt`);
  if (
    !Number.isSafeInteger(value.maxCaptureAgeSeconds)
    || value.maxCaptureAgeSeconds <= 0
    || value.maxCaptureAgeSeconds > 3600
  ) fail(`${label}.maxCaptureAgeSeconds must be an integer from 1 through 3600`);
  return value;
}

function validateRelationSequenceCounts(value, projectRef, label) {
  exactKeys(
    value,
    ["projectRef", "relations", "schemaVersion", "schemas", "sequences", "vaultSecretsCount"],
    label,
  );
  if (value.schemaVersion !== 2 || value.projectRef !== projectRef) {
    fail(`${label} identity does not match`);
  }
  assert.deepEqual(
    value.schemas,
    ["auth", "private", "public", "storage", "supabase_migrations"],
    `${label} must cover the canonical schema list`,
  );
  if (!Array.isArray(value.relations) || value.relations.length === 0) {
    fail(`${label}.relations must be a non-empty array`);
  }
  if (!Array.isArray(value.sequences)) fail(`${label}.sequences must be an array`);
  if (value.vaultSecretsCount !== 0) {
    fail(`${label} must prove the required vault.secrets table exists and is empty`);
  }
  const relationKeys = [];
  for (const [index, relation] of value.relations.entries()) {
    exactKeys(
      relation,
      ["name", "present", "rowCount", "rowsSha256", "schema"],
      `${label}.relations[${index}]`,
    );
    if (
      typeof relation.schema !== "string"
      || typeof relation.name !== "string"
      || !value.schemas.includes(relation.schema)
      || typeof relation.present !== "boolean"
    ) fail(`${label}.relations[${index}] identity or presence is invalid`);
    if (relation.present) {
      if (
        !Number.isSafeInteger(relation.rowCount)
        || relation.rowCount < 0
        || !hashPattern.test(relation.rowsSha256 ?? "")
      ) fail(`${label}.relations[${index}] present values are invalid`);
    } else if (relation.rowCount !== null || relation.rowsSha256 !== null) {
      fail(`${label}.relations[${index}] absent values must be null`);
    }
    relationKeys.push(`${relation.schema}.${relation.name}`);
  }
  if (
    new Set(relationKeys).size !== relationKeys.length
    || JSON.stringify(relationKeys) !== JSON.stringify([...relationKeys].sort((left, right) =>
      Buffer.from(left).compare(Buffer.from(right))))
  ) fail(`${label} relation identities must be unique and bytewise sorted`);
  const sequenceKeys = [];
  for (const [index, sequence] of value.sequences.entries()) {
    exactKeys(
      sequence,
      ["isCalled", "lastValue", "name", "present", "schema"],
      `${label}.sequences[${index}]`,
    );
    if (
      typeof sequence.schema !== "string"
      || typeof sequence.name !== "string"
      || !value.schemas.includes(sequence.schema)
      || typeof sequence.present !== "boolean"
    ) fail(`${label}.sequences[${index}] identity or presence is invalid`);
    if (sequence.present) {
      if (
        typeof sequence.lastValue !== "string"
        || !/^-?[0-9]+$/u.test(sequence.lastValue)
        || typeof sequence.isCalled !== "boolean"
      ) fail(`${label}.sequences[${index}] present values are invalid`);
    } else if (sequence.lastValue !== null || sequence.isCalled !== null) {
      fail(`${label}.sequences[${index}] absent values must be null`);
    }
    sequenceKeys.push(`${sequence.schema}.${sequence.name}`);
  }
  if (
    new Set(sequenceKeys).size !== sequenceKeys.length
    || JSON.stringify(sequenceKeys) !== JSON.stringify([...sequenceKeys].sort((left, right) =>
      Buffer.from(left).compare(Buffer.from(right))))
  ) fail(`${label} sequence identities must be unique and bytewise sorted`);
}

function stateSha256(value) {
  return sha256(JSON.stringify(Object.fromEntries(
    stateHashNames.map((name) => [name, value[name]]),
  )));
}

function validateRehearsalState(value, label, includeEffect) {
  const keys = includeEffect
    ? ["effectVerificationSha256", ...stateHashNames, "stateSha256"]
    : [...stateHashNames, "stateSha256"];
  requireSortedExactObjectHashes(value, keys, label);
  if (value.stateSha256 !== stateSha256(value)) {
    fail(`${label}.stateSha256 does not bind its three canonical state hashes`);
  }
}

function validateRehearsalTools(value, label) {
  exactKeys(value, rehearsalToolNames, label);
  const names = Object.keys(value);
  if (JSON.stringify(names) !== JSON.stringify(rehearsalToolNames)) {
    fail(`${label} keys must be bytewise sorted`);
  }
  for (const name of names) {
    if (!/^[a-z][A-Za-z0-9]*Sha256$/u.test(name)) {
      fail(`${label}.${name} is not a supported tool identity key`);
    }
    requireHash(value[name], `${label}.${name}`);
  }
}

async function readAndValidateRehearsalEvidence(
  directory,
  { expectedSha256, previousDirectory } = {},
) {
  const [manifestModule, stageModule] = await Promise.all([
    import("./compare-database-manifests.mjs"),
    import("./prepare-reconciliation-stage.mjs"),
  ]);
  const { parseManifestText } = manifestModule;
  const { requireCanonicalReleaseRepository } = stageModule;
  const { metadata: rootMetadata, root } = await requireSealedEvidenceDirectory(
    directory,
    "rehearsal evidence directory",
  );
  const entries = await readdir(root, { withFileTypes: true });
  const expectedEntries = [...rehearsalArtifactNames, "rehearsal-evidence.json"].sort();
  if (
    JSON.stringify(entries.map(({ name }) => name).sort())
    !== JSON.stringify(expectedEntries)
  ) fail("rehearsal evidence directory contains missing or unexpected artifacts");
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      fail(`rehearsal evidence entry must be a regular file: ${entry.name}`);
    }
  }
  const manifestPath = path.join(root, "rehearsal-evidence.json");
  const { contents, value } = await readCanonicalJson(
    manifestPath,
    "rehearsal evidence manifest",
  );
  const manifestSha256 = sha256(contents);
  if (expectedSha256 !== undefined) {
    requireHash(expectedSha256, "expected rehearsal evidence manifest SHA-256");
    if (manifestSha256 !== expectedSha256) {
      fail("rehearsal evidence manifest SHA-256 does not match");
    }
  }
  exactKeys(
    value,
    [
      "approvedBackupToolManifestSha256",
      "artifactContract",
      "artifacts",
      "backupEvidence",
      "captureId",
      "databaseClientContract",
      "dockerContext",
      "dockerSharedHomeRoot",
      "expectedBranch",
      "includedVersions",
      "postgres",
      "postState",
      "preState",
      "previousPostStateSha256",
      "previousRehearsalEvidenceManifestSha256",
      "projectRef",
      "reconciliationStageManifestSha256",
      "releaseCommit",
      "releaseRepository",
      "restoreId",
      "schemaVersion",
      "stageNumber",
      "supabaseCli",
      "throughVersion",
      "tools",
    ],
    "rehearsal evidence manifest",
  );
  if (
    value.schemaVersion !== 2
    || value.artifactContract
      !== "dominion-production-reconciliation-rehearsal-evidence/v2"
    || value.databaseClientContract !== "exact-network-none-restored-capture/v1"
    || value.expectedBranch !== "main"
  ) fail("rehearsal evidence manifest contract or branch is invalid");
  if (!projectRefPattern.test(value.projectRef ?? "")) {
    fail("rehearsal evidence projectRef is invalid");
  }
  requireCommit(value.releaseCommit, "rehearsal evidence releaseCommit");
  if (!safeIdPattern.test(value.captureId ?? "") || !safeIdPattern.test(value.restoreId ?? "")) {
    fail("rehearsal evidence captureId or restoreId is invalid");
  }
  const index = targetIndex(value.throughVersion);
  if (value.stageNumber !== index + 1) fail("rehearsal evidence stageNumber is invalid");
  if (
    !Array.isArray(value.includedVersions)
    || JSON.stringify(value.includedVersions) !== JSON.stringify(versions.slice(0, index + 1))
  ) fail("rehearsal evidence includedVersions is not the exact immutable prefix");
  requireHash(
    value.previousRehearsalEvidenceManifestSha256,
    "rehearsal evidence previous manifest SHA-256",
  );
  requireHash(value.previousPostStateSha256, "rehearsal evidence previous post-state SHA-256");
  validateBackupEvidence(value.backupEvidence, "rehearsal evidence backupEvidence");
  validateDockerContext(value.dockerContext, "rehearsal evidence dockerContext");
  requireCanonicalAbsolutePathSyntax(
    value.dockerSharedHomeRoot,
    "rehearsal evidence dockerSharedHomeRoot",
  );
  requireCanonicalAbsolutePathSyntax(
    value.releaseRepository,
    "rehearsal evidence releaseRepository",
  );
  const dockerSharedHomeRoot = await requireCanonicalOwnedDirectory(
    value.dockerSharedHomeRoot,
    "rehearsal evidence Docker-shared home root",
  );
  requireContainedPath(
    dockerSharedHomeRoot,
    root,
    "rehearsal evidence directory",
  );
  const releaseRepository = await requireCanonicalReleaseRepository(
    value.releaseRepository,
    value.releaseCommit,
  );
  requireContainedPath(
    dockerSharedHomeRoot,
    releaseRepository,
    "rehearsal evidence release repository",
  );
  if (
    JSON.stringify(value.dockerContext)
      !== JSON.stringify(value.backupEvidence.dockerContext)
    || value.dockerSharedHomeRoot !== value.backupEvidence.dockerSharedHomeRoot
  ) fail("rehearsal evidence Docker context does not match its backup evidence");
  requireHash(
    value.approvedBackupToolManifestSha256,
    "rehearsal evidence approved backup tool manifest SHA-256",
  );
  requireHash(
    value.reconciliationStageManifestSha256,
    "rehearsal evidence reconciliation stage manifest SHA-256",
  );
  exactKeys(value.postgres, ["image", "imageId", "serverVersionNum"], "rehearsal postgres");
  if (
    value.postgres.image !== "public.ecr.aws/supabase/postgres:17.6.1.141"
    || !/^sha256:[a-f0-9]{64}$/u.test(value.postgres.imageId ?? "")
    || value.postgres.imageId !== value.backupEvidence.postgresImageId
    || value.postgres.serverVersionNum !== 170006
  ) fail("rehearsal PostgreSQL image or server identity is invalid");
  exactKeys(value.supabaseCli, ["sha256", "version"], "rehearsal Supabase CLI");
  if (value.supabaseCli.version !== "2.109.0") {
    fail("rehearsal Supabase CLI version is not the exact pin");
  }
  requireHash(value.supabaseCli.sha256, "rehearsal Supabase CLI SHA-256");
  validateRehearsalTools(value.tools, "rehearsal tools");
  if (
    value.tools.macosTcbAttestationSha256
      !== value.backupEvidence.macosTcbAttestationSha256
  ) fail("rehearsal evidence TCB identity does not match its backup evidence");
  requireSortedExactObjectHashes(
    value.artifacts,
    rehearsalArtifactNames,
    "rehearsal artifact inventory",
  );
  validateRehearsalState(value.preState, "rehearsal preState", false);
  validateRehearsalState(value.postState, "rehearsal postState", true);
  const hashes = {};
  for (const name of rehearsalArtifactNames) {
    hashes[name] = await hashSealedFile(
      path.join(root, name),
      `rehearsal artifact ${name}`,
    );
    if (hashes[name] !== value.artifacts[name]) {
      fail(`rehearsal artifact SHA-256 mismatch: ${name}`);
    }
  }
  const expectedPre = {
    relationSequenceCountsSha256: hashes["pre-relation-sequence-counts.json"],
    sourceFingerprintSha256: hashes["pre-source-fingerprint.jsonl"],
    sourceManifestSha256: hashes["pre-source-manifest.jsonl"],
  };
  const expectedPost = {
    effectVerificationSha256: hashes["effect-verification.json"],
    relationSequenceCountsSha256: hashes["post-relation-sequence-counts.json"],
    sourceFingerprintSha256: hashes["post-source-fingerprint.jsonl"],
    sourceManifestSha256: hashes["post-source-manifest.jsonl"],
  };
  for (const [key, expected] of Object.entries(expectedPre)) {
    if (value.preState[key] !== expected) fail(`rehearsal preState.${key} is not artifact-bound`);
  }
  for (const [key, expected] of Object.entries(expectedPost)) {
    if (value.postState[key] !== expected) fail(`rehearsal postState.${key} is not artifact-bound`);
  }
  for (const name of [
    "pre-source-manifest.jsonl",
    "pre-source-fingerprint.jsonl",
    "post-source-manifest.jsonl",
    "post-source-fingerprint.jsonl",
  ]) {
    const filename = path.join(root, name);
    const contents = await readSealedFile(filename, `rehearsal artifact ${name}`);
    if (sha256(contents) !== hashes[name]) {
      fail(`rehearsal artifact SHA-256 mismatch while parsing: ${name}`);
    }
    parseManifestText(contents.toString("utf8"), filename);
  }
  validateRelationSequenceCounts(
    await readJson(
      path.join(root, "pre-relation-sequence-counts.json"),
      "rehearsal pre counts",
      hashes["pre-relation-sequence-counts.json"],
    ),
    value.projectRef,
    "rehearsal pre relation/sequence counts",
  );
  validateRelationSequenceCounts(
    await readJson(
      path.join(root, "post-relation-sequence-counts.json"),
      "rehearsal post counts",
      hashes["post-relation-sequence-counts.json"],
    ),
    value.projectRef,
    "rehearsal post relation/sequence counts",
  );
  validateEffect(
    await readJson(
      path.join(root, "effect-verification.json"),
      "rehearsal effect verification",
      hashes["effect-verification.json"],
    ),
    value.projectRef,
    value.throughVersion,
    {
      applicationDataSha256: hashes["post-source-fingerprint.jsonl"],
      applicationSchemaSha256: hashes["post-source-manifest.jsonl"],
    },
  );
  if (index === 0) {
    if (
      value.previousRehearsalEvidenceManifestSha256 !== zeroHash
      || value.previousPostStateSha256 !== zeroHash
      || value.preState.sourceManifestSha256 !== value.backupEvidence.sourceManifestSha256
      || value.preState.sourceFingerprintSha256 !== value.backupEvidence.sourceFingerprintSha256
      || value.preState.relationSequenceCountsSha256
        !== value.backupEvidence.relationSequenceCountsSha256
    ) fail("stage-one rehearsal pre-state must be the verified capture and use genesis");
    if (previousDirectory !== undefined && previousDirectory !== "genesis") {
      fail("stage-one rehearsal must use the genesis previous evidence identity");
    }
  } else {
    if (
      value.previousRehearsalEvidenceManifestSha256 === zeroHash
      || value.previousPostStateSha256 === zeroHash
    ) fail("a non-first rehearsal cannot chain to genesis");
    if (previousDirectory !== undefined) {
      if (previousDirectory === "genesis") fail("a non-first rehearsal requires prior evidence");
      const previous = await readAndValidateRehearsalEvidence(previousDirectory);
      if (
        previous.manifestSha256 !== value.previousRehearsalEvidenceManifestSha256
        || previous.manifest.postState.stateSha256 !== value.previousPostStateSha256
        || previous.manifest.stageNumber !== value.stageNumber - 1
        || previous.manifest.throughVersion !== versions[index - 1]
        || previous.manifest.projectRef !== value.projectRef
        || previous.manifest.releaseCommit !== value.releaseCommit
        || previous.manifest.captureId !== value.captureId
        || previous.manifest.restoreId !== value.restoreId
        || JSON.stringify(previous.manifest.backupEvidence)
          !== JSON.stringify(value.backupEvidence)
        || previous.manifest.approvedBackupToolManifestSha256
          !== value.approvedBackupToolManifestSha256
        || previous.manifest.postState.sourceManifestSha256
          !== value.preState.sourceManifestSha256
        || previous.manifest.postState.sourceFingerprintSha256
          !== value.preState.sourceFingerprintSha256
        || previous.manifest.postState.relationSequenceCountsSha256
          !== value.preState.relationSequenceCountsSha256
      ) fail("rehearsal post(N) to pre(N+1) continuity is invalid");
    }
  }
  await revalidateSealedEvidenceDirectory(
    root,
    rootMetadata,
    "rehearsal evidence directory",
  );
  return { manifest: value, manifestPath, manifestSha256, root };
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

function validateEffect(value, projectRef, throughVersion, expectedState) {
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
  const expectedChecks = [
    ["application-data-state", expectedState.applicationDataSha256],
    ["application-schema-state", expectedState.applicationSchemaSha256],
    [
      "migration-prefix-state",
      sha256(JSON.stringify({
        projectRef,
        remoteVersions: versions.slice(0, targetIndex(throughVersion) + 1),
      })),
    ],
  ];
  if (value.checks.length !== expectedChecks.length) {
    fail("effect verification must contain the exact three state checks");
  }
  for (const [index, check] of value.checks.entries()) {
    exactKeys(check, ["evidenceSha256", "name", "passed"], `effect check ${index + 1}`);
    const [expectedName, expectedEvidenceSha256] = expectedChecks[index];
    if (
      check.name !== expectedName
      || check.passed !== true
      || check.evidenceSha256 !== expectedEvidenceSha256
    ) {
      fail(`effect check ${index + 1} does not bind the exact approved post-state`);
    }
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
      "databaseHost",
      "dockerContext",
      "dockerSharedHomeRoot",
      "expectedBranch",
      "expectedPost",
      "expectedPre",
      "previousCompletionSha256",
      "projectRef",
      "reconciliationStageManifestSha256",
      "rehearsalEvidence",
      "releaseCommit",
      "releaseRepository",
      "schemaVersion",
      "throughVersion",
      "tls",
      "tools",
      "macosTcbAttestationSha256",
    ],
    "approved reconciliation plan",
  );
  if (
    plan.schemaVersion !== 2
    || plan.artifactContract !== "dominion-production-reconciliation-plan/v2"
    || plan.databaseClientContract !== "exact-supavisor-session-jit-pgpass-verify-full/v2"
    || plan.expectedBranch !== "main"
  ) {
    fail("approved reconciliation plan contract, branch, or database client boundary is invalid");
  }
  if (!projectRefPattern.test(plan.projectRef ?? "")) {
    fail("approved reconciliation plan projectRef is invalid");
  }
  if (!/^[a-z0-9-]+\.pooler\.supabase\.com$/u.test(plan.databaseHost ?? "")) {
    fail("approved reconciliation plan databaseHost is invalid");
  }
  validateDockerContext(plan.dockerContext, "approved reconciliation plan dockerContext");
  requireCanonicalAbsolutePathSyntax(
    plan.dockerSharedHomeRoot,
    "approved reconciliation plan dockerSharedHomeRoot",
  );
  requireCanonicalAbsolutePathSyntax(
    plan.releaseRepository,
    "approved reconciliation plan releaseRepository",
  );
  requireHash(
    plan.macosTcbAttestationSha256,
    "approved reconciliation plan macOS TCB attestation SHA-256",
  );
  exactKeys(
    plan.tls,
    ["rootCertRelativePath", "rootCertSha256", "sslMode"],
    "approved reconciliation plan tls",
  );
  requireHash(plan.tls.rootCertSha256, "approved reconciliation plan TLS root certificate");
  if (plan.tls.sslMode !== "verify-full") fail("approved reconciliation plan TLS mode is invalid");
  if (plan.tls.rootCertRelativePath !== "private/supabase-ca/prod-ca-2021.crt") {
    fail("approved reconciliation plan TLS root certificate path is invalid");
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

  validateBackupEvidence(plan.backupEvidence, "approved reconciliation plan backupEvidence");

  requireSortedExactObjectHashes(
    plan.expectedPre,
    stateHashNames,
    "approved reconciliation plan expectedPre",
  );
  requireSortedExactObjectHashes(
    plan.expectedPost,
    [
      "effectVerificationSha256",
      ...stateHashNames,
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
  exactKeys(
    plan.rehearsalEvidence,
    [
      "captureId",
      "includedVersions",
      "manifestSha256",
      "postStateSha256",
      "preStateSha256",
      "previousManifestSha256",
      "previousPostStateSha256",
      "restoreId",
      "stageNumber",
    ],
    "approved reconciliation plan rehearsalEvidence",
  );
  if (
    !safeIdPattern.test(plan.rehearsalEvidence.captureId ?? "")
    || !safeIdPattern.test(plan.rehearsalEvidence.restoreId ?? "")
    || plan.rehearsalEvidence.stageNumber !== index + 1
    || !Array.isArray(plan.rehearsalEvidence.includedVersions)
    || JSON.stringify(plan.rehearsalEvidence.includedVersions)
      !== JSON.stringify(versions.slice(0, index + 1))
  ) fail("approved reconciliation plan rehearsal identity is invalid");
  for (const name of [
    "manifestSha256",
    "postStateSha256",
    "preStateSha256",
    "previousManifestSha256",
    "previousPostStateSha256",
  ]) requireHash(plan.rehearsalEvidence[name], `rehearsalEvidence.${name}`);
  if (
    (index === 0 && (
      plan.rehearsalEvidence.previousManifestSha256 !== zeroHash
      || plan.rehearsalEvidence.previousPostStateSha256 !== zeroHash
    ))
    || (index > 0 && (
      plan.rehearsalEvidence.previousManifestSha256 === zeroHash
      || plan.rehearsalEvidence.previousPostStateSha256 === zeroHash
    ))
  ) fail("approved reconciliation plan rehearsal chain genesis is invalid");
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
      || plan.expectedPre.relationSequenceCountsSha256
        !== plan.backupEvidence.relationSequenceCountsSha256
    )
  ) fail("the first plan pre-state must equal the independently verified backup state");
  if (
    plan.rehearsalEvidence.preStateSha256 !== stateSha256(plan.expectedPre)
    || plan.rehearsalEvidence.postStateSha256 !== stateSha256(plan.expectedPost)
  ) fail("approved plan expected state hashes do not match its rehearsal evidence binding");
  if (
    plan.databaseHost !== plan.backupEvidence.databaseHost
    || JSON.stringify(plan.dockerContext)
      !== JSON.stringify(plan.backupEvidence.dockerContext)
    || plan.dockerSharedHomeRoot !== plan.backupEvidence.dockerSharedHomeRoot
    || plan.macosTcbAttestationSha256
      !== plan.backupEvidence.macosTcbAttestationSha256
    || plan.tls.rootCertSha256 !== plan.backupEvidence.sslRootCertSha256
    || plan.tls.rootCertRelativePath !== plan.backupEvidence.sslRootCertRelativePath
  ) fail("approved plan database/TLS identity must equal the verified backup identity");
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
    ["DATABASE_HOST", plan.databaseHost],
    ["EXPECTED_BRANCH", plan.expectedBranch],
    ["RELEASE_COMMIT", plan.releaseCommit],
    ["THROUGH_VERSION", plan.throughVersion],
    ["PREVIOUS_COMPLETION_SHA256", plan.previousCompletionSha256],
    ["EXPECTED_PRE_SOURCE_MANIFEST_SHA256", plan.expectedPre.sourceManifestSha256],
    ["EXPECTED_PRE_SOURCE_FINGERPRINT_SHA256", plan.expectedPre.sourceFingerprintSha256],
    ["EXPECTED_PRE_RELATION_SEQUENCE_COUNTS_SHA256", plan.expectedPre.relationSequenceCountsSha256],
    ["EXPECTED_POST_SOURCE_MANIFEST_SHA256", plan.expectedPost.sourceManifestSha256],
    ["EXPECTED_POST_SOURCE_FINGERPRINT_SHA256", plan.expectedPost.sourceFingerprintSha256],
    ["EXPECTED_POST_RELATION_SEQUENCE_COUNTS_SHA256", plan.expectedPost.relationSequenceCountsSha256],
    ["EXPECTED_EFFECT_VERIFICATION_SHA256", plan.expectedPost.effectVerificationSha256],
    ["REHEARSAL_EVIDENCE_MANIFEST_SHA256", plan.rehearsalEvidence.manifestSha256],
    ["REHEARSAL_CAPTURE_ID", plan.rehearsalEvidence.captureId],
    ["REHEARSAL_RESTORE_ID", plan.rehearsalEvidence.restoreId],
    ["REHEARSAL_STAGE_NUMBER", String(plan.rehearsalEvidence.stageNumber)],
    ["REHEARSAL_PRE_STATE_SHA256", plan.rehearsalEvidence.preStateSha256],
    ["REHEARSAL_POST_STATE_SHA256", plan.rehearsalEvidence.postStateSha256],
    ["PREVIOUS_REHEARSAL_EVIDENCE_MANIFEST_SHA256", plan.rehearsalEvidence.previousManifestSha256],
    ["PREVIOUS_REHEARSAL_POST_STATE_SHA256", plan.rehearsalEvidence.previousPostStateSha256],
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
    ["SSL_MODE", plan.tls.sslMode],
    ["SSL_ROOT_CERT_SHA256", plan.tls.rootCertSha256],
    ["APPROVED_BACKUP_TOOL_MANIFEST_SHA256", plan.approvedBackupToolManifestSha256],
    ["RECONCILIATION_STAGE_MANIFEST_SHA256", plan.reconciliationStageManifestSha256],
    ["RUNNER_SHA256", plan.tools.runnerSha256],
    ["COMMON_HELPER_SHA256", plan.tools.commonHelperSha256],
    ["CLEAN_ENVIRONMENT_LAUNCHER_SHA256", plan.tools.cleanEnvironmentLauncherSha256],
    ["CLOCK_SHA256", plan.tools.clockSha256],
    ["ARTIFACT_HELPER_SHA256", plan.tools.artifactHelperSha256],
    ["BACKUP_ARTIFACT_VERIFIER_SHA256", plan.tools.backupArtifactVerifierSha256],
    ["BACKUP_EVIDENCE_VERIFIER_SHA256", plan.tools.backupEvidenceVerifierSha256],
    ["DUMP_SCRIPT_TRANSFORMER_SHA256", plan.tools.dumpScriptTransformerSha256],
    ["PREFLIGHT_SHA256", plan.tools.preflightSha256],
    ["RELATION_COUNTS_HOOK_SHA256", plan.tools.relationCountsHookSha256],
    ["STAGE_VERIFIER_SHA256", plan.tools.stageVerifierSha256],
    ["HISTORY_VERIFIER_SHA256", plan.tools.historyVerifierSha256],
    ["INPUT_PINNING_HELPER_SHA256", plan.tools.inputPinningHelperSha256],
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
    ["SSL_ROOT_CERT_RELATIVE_PATH", plan.tls.rootCertRelativePath],
    ["ENCRYPTED_VOLUME_ATTESTATION_SHA256", backup.encryptedVolumeAttestationSha256],
    ["DOCKER_ENDPOINT", plan.dockerContext.endpoint],
    ["DOCKER_SOCKET", plan.dockerContext.socketPath],
    ["DOCKER_SOCKET_DEVICE", plan.dockerContext.device],
    ["DOCKER_SOCKET_INODE", plan.dockerContext.inode],
    ["DOCKER_SOCKET_OWNER_UID", String(plan.dockerContext.ownerUid)],
    ["DOCKER_SOCKET_OWNER_MODE", String(plan.dockerContext.ownerMode)],
    ["DOCKER_SHARED_HOME_ROOT", plan.dockerSharedHomeRoot],
    ["MACOS_TCB_ATTESTATION_SHA256", plan.macosTcbAttestationSha256],
    ["RELEASE_REPOSITORY", plan.releaseRepository],
  ];
  return `${lines.map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}

async function preparePlanFromRehearsal(contractFilename, outputFilename) {
  const {
    requireCanonicalReleaseRepository,
    verifyReconciliationStage,
  } = await import("./prepare-reconciliation-stage.mjs");
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
      "databaseHost",
      "expectedBranch",
      "previousCompletionSha256",
      "previousRehearsalEvidenceDirectory",
      "projectRef",
      "reconciliationStage",
      "releaseRepository",
      "macosTcbAttestation",
      "macosTcbAttestationSha256",
      "rehearsalEvidenceDirectory",
      "rehearsalSupabaseCli",
      "rehearsalToolPaths",
      "releaseCommit",
      "schemaVersion",
      "throughVersion",
      "tls",
      "toolPaths",
    ],
    "reconciliation rehearsal contract",
  );
  if (
    contract.schemaVersion !== 2
    || contract.artifactContract
      !== "dominion-production-reconciliation-local-rehearsal/v2"
    || contract.databaseClientContract !== "exact-supavisor-session-jit-pgpass-verify-full/v2"
    || contract.expectedBranch !== "main"
  ) fail("reconciliation rehearsal contract identity is invalid");
  if (!/^[a-z0-9-]+\.pooler\.supabase\.com$/u.test(contract.databaseHost ?? "")) {
    fail("reconciliation rehearsal contract databaseHost is invalid");
  }
  exactKeys(
    contract.tls,
    ["rootCertRelativePath", "rootCertSha256", "sslMode"],
    "reconciliation rehearsal TLS",
  );
  requireHash(contract.tls.rootCertSha256, "reconciliation rehearsal TLS root certificate");
  if (contract.tls.sslMode !== "verify-full") fail("reconciliation rehearsal TLS mode is invalid");
  if (contract.tls.rootCertRelativePath !== "private/supabase-ca/prod-ca-2021.crt") {
    fail("reconciliation rehearsal TLS root certificate path is invalid");
  }
  exactKeys(contract.toolPaths, planToolNames, "rehearsal toolPaths");
  exactKeys(
    contract.rehearsalToolPaths,
    rehearsalToolPathNames,
    "rehearsal tool identity paths",
  );
  requireAbsolute(contract.macosTcbAttestation, "macOS TCB attestation");
  requireHash(contract.macosTcbAttestationSha256, "macOS TCB attestation SHA-256");
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

  const rehearsal = await readAndValidateRehearsalEvidence(
    contract.rehearsalEvidenceDirectory,
    { previousDirectory: contract.previousRehearsalEvidenceDirectory },
  );
  const evidenceRelative = path.relative(repository, rehearsal.root);
  if (
    evidenceRelative === ""
    || (!evidenceRelative.startsWith("..") && !path.isAbsolute(evidenceRelative))
  ) fail("sealed rehearsal evidence must be outside the release repository");
  const evidence = rehearsal.manifest;
  if (
    evidence.projectRef !== contract.projectRef
    || evidence.expectedBranch !== contract.expectedBranch
    || evidence.releaseCommit !== contract.releaseCommit
    || evidence.throughVersion !== contract.throughVersion
    || JSON.stringify(evidence.backupEvidence) !== JSON.stringify(contract.backupEvidence)
  ) fail("sealed rehearsal evidence does not match the plan request identity");
  requireAbsolute(contract.reconciliationStage, "reconciliation stage");
  const stageRoot = await realpath(contract.reconciliationStage);
  const releaseRepository = await requireCanonicalReleaseRepository(
    contract.releaseRepository,
    contract.releaseCommit,
  );
  if (
    evidence.releaseRepository !== releaseRepository
    || evidence.dockerSharedHomeRoot !== contract.backupEvidence.dockerSharedHomeRoot
  ) fail("sealed rehearsal evidence does not bind the release repository or shared root");
  await verifyReconciliationStage({
    stage: stageRoot,
    releaseCommit: contract.releaseCommit,
    throughVersion: contract.throughVersion,
    root: releaseRepository,
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
  const approvedBackupToolManifestSha256 = await hashFile(
    contract.approvedBackupToolManifest,
    "approved backup tool manifest",
  );
  const reconciliationStageManifestSha256 = await hashFile(
    path.join(stageRoot, "reconciliation-stage.json"),
    "reconciliation stage manifest",
  );
  if (
    evidence.approvedBackupToolManifestSha256 !== approvedBackupToolManifestSha256
    || evidence.reconciliationStageManifestSha256 !== reconciliationStageManifestSha256
  ) fail("sealed rehearsal evidence does not bind the supplied backup tools or stage");
  requireAbsolute(contract.rehearsalSupabaseCli, "rehearsal Supabase CLI");
  if (
    await hashFile(contract.rehearsalSupabaseCli, "rehearsal Supabase CLI")
      !== evidence.supabaseCli.sha256
  ) fail("sealed rehearsal evidence Supabase CLI identity does not match its binary");
  let rehearsalToolHashes = {};
  for (const name of rehearsalToolPathNames) {
    requireAbsolute(contract.rehearsalToolPaths[name], `rehearsalToolPaths.${name}`);
    rehearsalToolHashes[name] = await hashFile(
      contract.rehearsalToolPaths[name],
      `rehearsalToolPaths.${name}`,
    );
  }
  rehearsalToolHashes.macosTcbAttestationSha256 = await hashFile(
    contract.macosTcbAttestation,
    "macOS TCB attestation",
  );
  if (
    rehearsalToolHashes.macosTcbAttestationSha256
      !== contract.macosTcbAttestationSha256
  ) fail("macOS TCB attestation SHA-256 does not match its private artifact");
  rehearsalToolHashes = Object.fromEntries(
    Object.entries(rehearsalToolHashes).sort(([left], [right]) =>
      Buffer.from(left).compare(Buffer.from(right))),
  );
  if (JSON.stringify(rehearsalToolHashes) !== JSON.stringify(evidence.tools)) {
    fail("sealed rehearsal evidence tool identities do not match the supplied tools");
  }
  const toolHashes = {};
  for (const name of planToolNames) {
    requireAbsolute(contract.toolPaths[name], `rehearsal toolPaths.${name}`);
    toolHashes[name] = await hashFile(
      contract.toolPaths[name],
      `rehearsal toolPaths.${name}`,
    );
  }
  const plan = validateReconciliationPlan({
    schemaVersion: 2,
    artifactContract: "dominion-production-reconciliation-plan/v2",
    databaseClientContract: contract.databaseClientContract,
    databaseHost: contract.databaseHost,
    dockerContext: contract.backupEvidence.dockerContext,
    dockerSharedHomeRoot: evidence.dockerSharedHomeRoot,
    macosTcbAttestationSha256: contract.macosTcbAttestationSha256,
    projectRef: contract.projectRef,
    expectedBranch: contract.expectedBranch,
    releaseCommit: contract.releaseCommit,
    releaseRepository,
    throughVersion: contract.throughVersion,
    tls: contract.tls,
    previousCompletionSha256: contract.previousCompletionSha256,
    backupEvidence: contract.backupEvidence,
    expectedPre: {
      relationSequenceCountsSha256: evidence.preState.relationSequenceCountsSha256,
      sourceFingerprintSha256: evidence.preState.sourceFingerprintSha256,
      sourceManifestSha256: evidence.preState.sourceManifestSha256,
    },
    expectedPost: {
      effectVerificationSha256: evidence.postState.effectVerificationSha256,
      relationSequenceCountsSha256: evidence.postState.relationSequenceCountsSha256,
      sourceFingerprintSha256: evidence.postState.sourceFingerprintSha256,
      sourceManifestSha256: evidence.postState.sourceManifestSha256,
    },
    approvedBackupToolManifestSha256,
    reconciliationStageManifestSha256,
    rehearsalEvidence: {
      captureId: evidence.captureId,
      includedVersions: evidence.includedVersions,
      manifestSha256: rehearsal.manifestSha256,
      postStateSha256: evidence.postState.stateSha256,
      preStateSha256: evidence.preState.stateSha256,
      previousManifestSha256: evidence.previousRehearsalEvidenceManifestSha256,
      previousPostStateSha256: evidence.previousPostStateSha256,
      restoreId: evidence.restoreId,
      stageNumber: evidence.stageNumber,
    },
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
  rehearsalEvidenceDirectory,
  beforeHistory,
  beforeHistorySha256,
  allowedClockSource,
  expectedFileSha256,
}) {
  const preflightIdentityKey = allowedClockSource === "system-utc"
    ? "PRODUCTION_RECONCILIATION_PREFLIGHT_SHA256"
    : allowedClockSource === "test-only-hashed-override"
      ? "TEST_ONLY_RECONCILIATION_PREFLIGHT_SHA256"
      : fail("preflight clock source is not a supported verification boundary");
  const expectedPreflightKeys = [preflightIdentityKey, ...preflightKeys.slice(1)];
  const contentsBuffer = await readSealedFile(filename, "preflight record");
  if (expectedFileSha256 !== undefined && sha256(contentsBuffer) !== expectedFileSha256) {
    fail("preflight record SHA-256 does not match its sealed manifest");
  }
  const contents = contentsBuffer.toString("utf8");
  if (!contents.endsWith("\n") || contents.includes("\r")) {
    fail("preflight record must be LF-terminated machine output");
  }
  const lines = contents.slice(0, -1).split("\n");
  if (lines.length !== expectedPreflightKeys.length) {
    fail(`preflight record must contain exactly ${expectedPreflightKeys.length} lines`);
  }
  const fields = {};
  for (let index = 0; index < lines.length; index += 1) {
    const separator = lines[index].indexOf("=");
    const key = lines[index].slice(0, separator);
    const value = lines[index].slice(separator + 1);
    if (separator < 1 || key !== expectedPreflightKeys[index] || value.length === 0) {
      fail(`preflight record line ${index + 1} must be exactly ${expectedPreflightKeys[index]}=<value>`);
    }
    fields[key] = value;
  }
  const computed = sha256(`${lines.slice(1).join("\n")}\n`);
  requireHash(fields[preflightIdentityKey], "preflight digest");
  if (computed !== fields[preflightIdentityKey]) {
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
    "RECONCILIATION_ARTIFACT_HELPER_SHA256",
    "REHEARSAL_EVIDENCE_MANIFEST_SHA256",
    "REHEARSAL_PRE_STATE_SHA256",
    "REHEARSAL_POST_STATE_SHA256",
    "SSL_ROOT_CERT_SHA256",
    "ENCRYPTED_VOLUME_ATTESTATION_SHA256",
    "MACOS_TCB_ATTESTATION_SHA256",
  ]) requireHash(fields[key], `preflight ${key}`);
  if (
    fields.PREFLIGHT_SCHEMA !== "77-dominion-production-reconciliation-preflight/v2"
    || fields.PREFLIGHT_SCOPE !== "offline-non-authorizing"
    || fields.RELEASE_COMMIT !== plan.releaseCommit
    || fields.THROUGH_VERSION !== plan.throughVersion
    || fields.PROJECT_REF !== plan.projectRef
    || fields.DATABASE_HOST !== plan.databaseHost
    || fields.SSL_MODE !== plan.tls.sslMode
    || fields.SSL_ROOT_CERT_RELATIVE_PATH !== plan.tls.rootCertRelativePath
    || fields.DOCKER_ENDPOINT !== plan.dockerContext.endpoint
    || fields.DOCKER_SHARED_HOME_ROOT !== plan.dockerSharedHomeRoot
    || fields.RELEASE_REPOSITORY !== plan.releaseRepository
    || fields.EXPECTED_BRANCH !== plan.expectedBranch
  ) fail("preflight release, project, branch, or schema identity does not match the approved plan");
  const expected = {
    RECONCILIATION_ARTIFACT_HELPER_SHA256: plan.tools.artifactHelperSha256,
    REHEARSAL_EVIDENCE_MANIFEST_SHA256: plan.rehearsalEvidence.manifestSha256,
    REHEARSAL_CAPTURE_ID: plan.rehearsalEvidence.captureId,
    REHEARSAL_RESTORE_ID: plan.rehearsalEvidence.restoreId,
    REHEARSAL_STAGE_NUMBER: String(plan.rehearsalEvidence.stageNumber),
    REHEARSAL_PRE_STATE_SHA256: plan.rehearsalEvidence.preStateSha256,
    REHEARSAL_POST_STATE_SHA256: plan.rehearsalEvidence.postStateSha256,
    DATABASE_HOST: plan.databaseHost,
    SSL_MODE: plan.tls.sslMode,
    SSL_ROOT_CERT_SHA256: plan.tls.rootCertSha256,
    SSL_ROOT_CERT_RELATIVE_PATH: plan.tls.rootCertRelativePath,
    ENCRYPTED_VOLUME_ATTESTATION_SHA256:
      plan.backupEvidence.encryptedVolumeAttestationSha256,
    DOCKER_ENDPOINT: plan.dockerContext.endpoint,
    DOCKER_SOCKET: plan.dockerContext.socketPath,
    DOCKER_SOCKET_DEVICE: plan.dockerContext.device,
    DOCKER_SOCKET_INODE: plan.dockerContext.inode,
    DOCKER_SOCKET_OWNER_UID: String(plan.dockerContext.ownerUid),
    DOCKER_SOCKET_OWNER_MODE: String(plan.dockerContext.ownerMode),
    DOCKER_SHARED_HOME_ROOT: plan.dockerSharedHomeRoot,
    MACOS_TCB_ATTESTATION_SHA256: plan.macosTcbAttestationSha256,
    RELEASE_REPOSITORY: plan.releaseRepository,
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
  requireAbsolute(fields.DOCKER_SHARED_HOME_ROOT, "preflight Docker-shared home root");
  requireAbsolute(fields.RELEASE_REPOSITORY, "preflight release repository");
  requireAbsolute(fields.REHEARSAL_EVIDENCE_DIRECTORY, "preflight rehearsal evidence directory");
  requireAbsolute(fields.CAPTURE_DIRECTORY, "preflight capture directory");
  requireAbsolute(fields.RESTORE_DIRECTORY, "preflight restore directory");
  requireAbsolute(fields.RECONCILIATION_STAGE, "preflight reconciliation stage");
  requireAbsolute(fields.BEFORE_MIGRATION_HISTORY, "preflight before-history");
  if (
    (stage !== undefined && fields.RECONCILIATION_STAGE !== stage)
    || (rehearsalEvidenceDirectory !== undefined
      && fields.REHEARSAL_EVIDENCE_DIRECTORY !== rehearsalEvidenceDirectory)
    || fields.BEFORE_MIGRATION_HISTORY !== beforeHistory
    || fields.BEFORE_MIGRATION_HISTORY_SHA256 !== beforeHistorySha256
  ) fail("preflight stage or live before-history identity does not match");
  if (rehearsalEvidenceDirectory !== undefined) {
    await readAndValidateRehearsalEvidence(rehearsalEvidenceDirectory, {
      expectedSha256: plan.rehearsalEvidence.manifestSha256,
    });
  }
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
  rehearsalEvidenceDirectory,
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
    rehearsalEvidenceDirectory,
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
  "boundary-relation-sequence-counts.json",
  "boundary-relation-sequence-counts.stderr",
  "boundary-relation-sequence-counts.stdout",
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
  "post-relation-sequence-counts.json",
  "post-relation-sequence-counts.stderr",
  "post-relation-sequence-counts.stdout",
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
  "pre-relation-sequence-counts.json",
  "pre-relation-sequence-counts.stderr",
  "pre-relation-sequence-counts.stdout",
  "pre-source-fingerprint.jsonl",
  "pre-source-fingerprint.stderr",
  "pre-source-fingerprint.stdout",
  "pre-source-manifest.jsonl",
  "pre-source-manifest.stderr",
  "pre-source-manifest.stdout",
  "preflight-record.txt",
  "preflight.stderr",
  "reconciliation-stage.json",
  "rehearsal-evidence.json",
]);

async function hashFile(filename, label) {
  return sha256(await readHandleBoundFile(filename, label));
}

async function hashSealedFile(filename, label) {
  return sha256(await readSealedFile(filename, label));
}

async function validateCompletionEvidence({
  directory,
  phase,
  expectedCompletionSha256,
  expectedProjectRef,
  expectedReleaseCommit,
  expectedThroughVersion,
  expectedPlanSha256,
  requiredClockSource,
}) {
  if (!['before-finalize', 'complete'].includes(phase)) {
    fail("completion verification phase must be before-finalize or complete");
  }
  const { metadata: rootMetadata, root } = await requireSealedEvidenceDirectory(
    directory,
    "completion evidence directory",
  );
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
      "rehearsalEvidenceManifestSha256",
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
    || manifest.schemaVersion !== 3
    || manifest.artifactContract !== "dominion-production-reconciliation-step/v3"
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
    ["manifest rehearsalEvidenceManifestSha256", manifest.rehearsalEvidenceManifestSha256],
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
    || plan.rehearsalEvidence.manifestSha256 !== manifest.rehearsalEvidenceManifestSha256
  ) fail("copied approved plan does not match the completed reconciliation");

  exactKeys(manifest.clock, ["sha256", "source"], "reconciliation clock");
  requireHash(manifest.clock.sha256, "reconciliation clock SHA-256");
  if (!['system-utc', 'test-only-hashed-override'].includes(manifest.clock.source)) {
    fail("reconciliation clock source is invalid");
  }
  if (
    requiredClockSource !== undefined
    && manifest.clock.source !== requiredClockSource
  ) {
    fail(`completion evidence must use the ${requiredClockSource} clock source`);
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
    if (
      await hashSealedFile(path.join(root, name), `reconciliation artifact ${name}`)
        !== manifest.artifacts[name]
    ) {
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
    manifest.artifacts["rehearsal-evidence.json"] !== plan.rehearsalEvidence.manifestSha256
  ) fail("artifact inventory does not bind the sealed rehearsal evidence manifest");
  if (
    manifest.artifacts["pre-source-manifest.jsonl"] !== plan.expectedPre.sourceManifestSha256
    || manifest.artifacts["pre-source-fingerprint.jsonl"] !== plan.expectedPre.sourceFingerprintSha256
    || manifest.artifacts["pre-relation-sequence-counts.json"]
      !== plan.expectedPre.relationSequenceCountsSha256
    || manifest.artifacts["post-source-manifest.jsonl"] !== plan.expectedPost.sourceManifestSha256
    || manifest.artifacts["post-source-fingerprint.jsonl"] !== plan.expectedPost.sourceFingerprintSha256
    || manifest.artifacts["post-relation-sequence-counts.json"]
      !== plan.expectedPost.relationSequenceCountsSha256
    || manifest.artifacts["effect-verification.json"] !== plan.expectedPost.effectVerificationSha256
  ) fail("approved pre/post/effect result hashes do not match completion artifacts");
  for (const name of [
    "source-manifest.jsonl",
    "source-fingerprint.jsonl",
    "relation-sequence-counts.json",
    "raw-history.json",
    "cli-history.json",
  ]) {
    if (manifest.artifacts[`pre-${name}`] !== manifest.artifacts[`boundary-${name}`]) {
      fail(`preflight-to-apply boundary drift is recorded for ${name}`);
    }
  }
  const beforeHistoryPath = path.join(root, "pre-cli-history.pinned.txt");
  const beforeHistorySha256 = await hashSealedFile(beforeHistoryPath, "pinned before-history");
  const preflight = await validatePreflightRecord({
    filename: path.join(root, "preflight-record.txt"),
    plan,
    planSha256: marker.approvedReconciliationPlanSha256,
    stage: undefined,
    beforeHistory: beforeHistoryPath,
    beforeHistorySha256,
    allowedClockSource: manifest.clock.source,
    expectedFileSha256: manifest.artifacts["preflight-record.txt"],
  });
  if (preflight.sha256 !== manifest.preflightSha256) {
    fail("completion manifest does not bind the strictly verified preflight record");
  }
  const { value: freshnessEvidence } = await readCanonicalJson(
    path.join(root, "mutation-boundary-freshness.json"),
    "mutation-boundary freshness evidence",
    manifest.artifacts["mutation-boundary-freshness.json"],
  );
  validateMutationBoundaryFreshnessEvidence(freshnessEvidence, { preflight, plan, manifest });
  const freshnessStdoutBytes = await readSealedFile(
    path.join(root, "mutation-boundary-freshness.stdout"),
    "mutation-boundary freshness stdout",
  );
  if (
    sha256(freshnessStdoutBytes)
      !== manifest.artifacts["mutation-boundary-freshness.stdout"]
  ) fail("mutation-boundary freshness stdout SHA-256 does not match its sealed manifest");
  const freshnessStdout = freshnessStdoutBytes.toString("utf8");
  const freshnessSha256 = manifest.artifacts["mutation-boundary-freshness.json"];
  if (freshnessStdout !== `MUTATION_BOUNDARY_FRESHNESS_SHA256=${freshnessSha256}\n`) {
    fail("mutation-boundary freshness helper output is invalid");
  }
  const finalVolumeOutputBytes = await readSealedFile(
    path.join(root, "final-encrypted-volume-attestation.stdout"),
    "final encrypted-volume attestation stdout",
  );
  if (
    sha256(finalVolumeOutputBytes)
      !== manifest.artifacts["final-encrypted-volume-attestation.stdout"]
  ) fail("final encrypted-volume attestation stdout SHA-256 does not match its sealed manifest");
  const finalVolumeOutput = finalVolumeOutputBytes.toString("utf8");
  if (
    finalVolumeOutput
      !== `DOMINION_ENCRYPTED_VOLUME_ATTESTATION_SHA256=${plan.backupEvidence.encryptedVolumeAttestationSha256}\nDOMINION_ENCRYPTED_VOLUME_DESTINATION=${path.dirname(root)}\n`
  ) {
    fail("final encrypted-volume attestation does not bind the evidence destination");
  }
  const stageManifest = await readJson(
    path.join(root, "reconciliation-stage.json"),
    "copied reconciliation stage manifest",
    manifest.artifacts["reconciliation-stage.json"],
  );
  validateMigrationUp(
    await readJson(
      path.join(root, "migration-up.json"),
      "migration-up result",
      manifest.artifacts["migration-up.json"],
    ),
    stageManifest,
    preflight.fields.RECONCILIATION_STAGE,
    marker.throughVersion,
  );
  validateCliHistory(
    await readJson(
      path.join(root, "pre-cli-history.json"),
      "pre CLI history",
      manifest.artifacts["pre-cli-history.json"],
    ),
    "before",
    marker.throughVersion,
  );
  validateCliHistory(
    await readJson(
      path.join(root, "boundary-cli-history.json"),
      "boundary CLI history",
      manifest.artifacts["boundary-cli-history.json"],
    ),
    "before",
    marker.throughVersion,
  );
  validateCliHistory(
    await readJson(
      path.join(root, "post-cli-history.json"),
      "post CLI history",
      manifest.artifacts["post-cli-history.json"],
    ),
    "after",
    marker.throughVersion,
  );
  validateRawHistory(
    await readJson(
      path.join(root, "pre-raw-history.json"),
      "pre raw history",
      manifest.artifacts["pre-raw-history.json"],
    ),
    "before",
    marker.throughVersion,
    marker.projectRef,
  );
  validateRawHistory(
    await readJson(
      path.join(root, "boundary-raw-history.json"),
      "boundary raw history",
      manifest.artifacts["boundary-raw-history.json"],
    ),
    "before",
    marker.throughVersion,
    marker.projectRef,
  );
  validateRawHistory(
    await readJson(
      path.join(root, "post-raw-history.json"),
      "post raw history",
      manifest.artifacts["post-raw-history.json"],
    ),
    "after",
    marker.throughVersion,
    marker.projectRef,
  );
  for (const phaseName of ["pre", "boundary", "post"]) {
    validateRelationSequenceCounts(
      await readJson(
        path.join(root, `${phaseName}-relation-sequence-counts.json`),
        `${phaseName} relation/sequence counts`,
        manifest.artifacts[`${phaseName}-relation-sequence-counts.json`],
      ),
      marker.projectRef,
      `${phaseName} relation/sequence counts`,
    );
  }
  validateEffect(
    await readJson(
      path.join(root, "effect-verification.json"),
      "effect verification",
      manifest.artifacts["effect-verification.json"],
    ),
    marker.projectRef,
    marker.throughVersion,
    {
      applicationDataSha256: manifest.artifacts["post-source-fingerprint.jsonl"],
      applicationSchemaSha256: manifest.artifacts["post-source-manifest.jsonl"],
    },
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
  await revalidateSealedEvidenceDirectory(
    root,
    rootMetadata,
    "completion evidence directory",
  );
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
    if (
      JSON.stringify(evidence.plan.backupEvidence) !== JSON.stringify(plan.backupEvidence)
      || evidence.plan.approvedBackupToolManifestSha256
        !== plan.approvedBackupToolManifestSha256
    ) {
      fail("every completed stage must bind the identical full backup evidence and approved backup tool manifest");
    }
    if (JSON.stringify(evidence.plan.tools) !== JSON.stringify(plan.tools)) {
      fail("every completed stage must bind the identical full reconciliation toolset");
    }
    if (evidence.manifest.clock.source !== "system-utc") {
      fail("a prior completed stage must use the system-utc clock source");
    }
    if (expectedIndex === target - 1) {
      if (
        evidence.plan.rehearsalEvidence.manifestSha256
          !== plan.rehearsalEvidence.previousManifestSha256
        || evidence.plan.rehearsalEvidence.postStateSha256
          !== plan.rehearsalEvidence.previousPostStateSha256
        || evidence.manifest.artifacts["post-source-manifest.jsonl"]
          !== plan.expectedPre.sourceManifestSha256
        || evidence.manifest.artifacts["post-source-fingerprint.jsonl"]
          !== plan.expectedPre.sourceFingerprintSha256
        || evidence.manifest.artifacts["post-relation-sequence-counts.json"]
          !== plan.expectedPre.relationSequenceCountsSha256
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
  case "verify-rehearsal-evidence": {
    requireExactOptions(options, ["directory", "expected-sha256"]);
    const result = await readAndValidateRehearsalEvidence(options.directory, {
      expectedSha256: options["expected-sha256"],
    });
    const evidence = result.manifest;
    process.stdout.write([
      `REHEARSAL_EVIDENCE_MANIFEST_SHA256=${result.manifestSha256}`,
      `PROJECT_REF=${evidence.projectRef}`,
      `EXPECTED_BRANCH=${evidence.expectedBranch}`,
      `RELEASE_COMMIT=${evidence.releaseCommit}`,
      `THROUGH_VERSION=${evidence.throughVersion}`,
      `STAGE_NUMBER=${evidence.stageNumber}`,
      `CAPTURE_ID=${evidence.captureId}`,
      `RESTORE_ID=${evidence.restoreId}`,
      `PRE_STATE_SHA256=${evidence.preState.stateSha256}`,
      `POST_STATE_SHA256=${evidence.postState.stateSha256}`,
      `DOCKER_SHARED_HOME_ROOT=${evidence.dockerSharedHomeRoot}`,
      `MACOS_TCB_ATTESTATION_SHA256=${evidence.tools.macosTcbAttestationSha256}`,
      `RELEASE_REPOSITORY=${evidence.releaseRepository}`,
      "",
    ].join("\n"));
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
      "rehearsal-evidence-directory",
      "stage",
    ]);
    const plan = await readAndValidatePlan(options.plan, options["plan-sha256"]);
    requireHash(options["before-history-sha256"], "before-history SHA-256");
    const result = await validatePreflightRecord({
      filename: options.input,
      plan,
      planSha256: options["plan-sha256"],
      stage: options.stage,
      rehearsalEvidenceDirectory: options["rehearsal-evidence-directory"],
      beforeHistory: options["before-history"],
      beforeHistorySha256: options["before-history-sha256"],
      allowedClockSource: options["allowed-clock-source"],
    });
    const identityKey = options["allowed-clock-source"] === "system-utc"
      ? "PRODUCTION_RECONCILIATION_PREFLIGHT_SHA256"
      : "TEST_ONLY_RECONCILIATION_PREFLIGHT_SHA256";
    process.stdout.write(`${identityKey}=${result.sha256}\n`);
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
      "rehearsal-evidence-directory",
      "stage",
    ]);
    const plan = await readAndValidatePlan(options.plan, options["plan-sha256"]);
    requireHash(options["before-history-sha256"], "before-history SHA-256");
    const result = await recordMutationBoundaryFreshness({
      preflightRecord: options["preflight-record"],
      plan,
      planSha256: options["plan-sha256"],
      stage: options.stage,
      rehearsalEvidenceDirectory: options["rehearsal-evidence-directory"],
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
      requiredClockSource: "system-utc",
    });
    process.stdout.write(
      `PRODUCTION_RECONCILIATION_COMPLETION_SHA256=${result.completionSha256}\n`,
    );
    break;
  }
  case "verify-test-only-completion": {
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
      requiredClockSource: "test-only-hashed-override",
    });
    process.stdout.write(
      `TEST_ONLY_RECONCILIATION_COMPLETION_SHA256=${result.completionSha256}\n`,
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
  case "verify-relation-counts": {
    requireExactOptions(options, ["input", "project-ref"]);
    validateRelationSequenceCounts(
      await readJson(options.input, "relation/sequence counts"),
      options["project-ref"],
      "relation/sequence counts",
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
    requireExactOptions(options, [
      "input",
      "post-source-fingerprint-sha256",
      "post-source-manifest-sha256",
      "project-ref",
      "through-version",
    ]);
    requireHash(options["post-source-fingerprint-sha256"], "post source fingerprint SHA-256");
    requireHash(options["post-source-manifest-sha256"], "post source manifest SHA-256");
    validateEffect(
      await readJson(options.input, "effect verification"),
      options["project-ref"],
      options["through-version"],
      {
        applicationDataSha256: options["post-source-fingerprint-sha256"],
        applicationSchemaSha256: options["post-source-manifest-sha256"],
      },
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
