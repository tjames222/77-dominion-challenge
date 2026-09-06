import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { HISTORICAL_RECONCILIATION_VERSIONS } from "./prepare-reconciliation-stage.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const gitBin = await realpath(execFileSync("/bin/sh", ["-c", "command -v git"], {
  encoding: "utf8",
}).trim());
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

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sourceManifestText(state) {
  return `${JSON.stringify({
    key: "column/public.fixture/state",
    kind: "column",
    identity: "public.fixture.state",
    definition: { state, type: "integer" },
  })}\n`;
}

function sourceFingerprintText(state) {
  return `${JSON.stringify({
    key: "data/public.fixture",
    kind: "data-fingerprint",
    identity: "public.fixture",
    definition: { rowCount: state, rowsSha256: sha256Bytes(`fixture-${state}`) },
  })}\n`;
}

function relationCountsText(state) {
  return canonicalJson({
    schemaVersion: 2,
    projectRef,
    schemas: ["auth", "private", "public", "storage", "supabase_migrations"],
    relations: [{
      schema: "public",
      name: "fixture",
      present: true,
      rowCount: state,
      rowsSha256: sha256Bytes(`fixture-${state}`),
    }],
    sequences: [],
    vaultSecretsCount: 0,
  });
}

function effectText() {
  const postManifestSha256 = sha256Bytes(sourceManifestText(1));
  const postFingerprintSha256 = sha256Bytes(sourceFingerprintText(1));
  return canonicalJson({
    schemaVersion: 1,
    projectRef,
    throughVersion,
    passed: true,
    checks: [
      {
        name: "application-data-state",
        passed: true,
        evidenceSha256: postFingerprintSha256,
      },
      {
        name: "application-schema-state",
        passed: true,
        evidenceSha256: postManifestSha256,
      },
      {
        name: "migration-prefix-state",
        passed: true,
        evidenceSha256: sha256Bytes(JSON.stringify({
          projectRef,
          remoteVersions: [throughVersion],
        })),
      },
    ],
  });
}

function stateSha256(state) {
  return sha256Bytes(JSON.stringify({
    relationSequenceCountsSha256: state.relationSequenceCountsSha256,
    sourceFingerprintSha256: state.sourceFingerprintSha256,
    sourceManifestSha256: state.sourceManifestSha256,
  }));
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

async function copyReleaseRepository(root) {
  const repository = path.join(root, "repository");
  await mkdir(repository, { mode: 0o700 });
  await cp(path.join(repositoryRoot, "scripts"), path.join(repository, "scripts"), {
    recursive: true,
  });
  await mkdir(path.join(repository, "supabase", ".temp"), {
    recursive: true,
    mode: 0o700,
  });
  await cp(
    path.join(repositoryRoot, "supabase", "migrations"),
    path.join(repository, "supabase", "migrations"),
    { recursive: true },
  );
  await cp(
    path.join(repositoryRoot, "supabase", "config.toml"),
    path.join(repository, "supabase", "config.toml"),
  );
  await cp(
    path.join(repositoryRoot, "supabase", ".temp", "postgres-version"),
    path.join(repository, "supabase", ".temp", "postgres-version"),
  );
  for (const name of [
    "capture-production-backup.sh",
    "rehearse-production-backup-restore.sh",
    "run-production-operator-clean.sh",
    "run-production-reconciliation-step.sh",
    "verify-production-backup-evidence.sh",
    "verify-production-reconciliation-preflight.sh",
  ]) await chmod(path.join(repository, "scripts", name), 0o700);
  execFileSync(gitBin, ["init", "-q", "-b", "main"], { cwd: repository });
  execFileSync(gitBin, [
    "remote", "add", "origin",
    "https://github.com/tjames222/77-dominion-challenge.git",
  ], { cwd: repository });
  execFileSync(gitBin, ["config", "user.email", "fixture@example.test"], { cwd: repository });
  execFileSync(gitBin, ["config", "user.name", "Fixture"], { cwd: repository });
  execFileSync(gitBin, ["add", "-f", "."], { cwd: repository });
  execFileSync(gitBin, ["commit", "-qm", "fixture release"], { cwd: repository });
  const releaseCommit = execFileSync(gitBin, ["rev-parse", "HEAD"], {
    cwd: repository,
    encoding: "utf8",
  }).trim();
  return {
    releaseCommit,
    repository,
    scripts: path.join(repository, "scripts"),
  };
}

async function makeTreeOwnerWritable(filename) {
  let metadata;
  try {
    metadata = await lstat(filename);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
  await chmod(filename, 0o700);
  for (const entry of await readdir(filename)) {
    await makeTreeOwnerWritable(path.join(filename, entry));
  }
}

async function cleanupFixture(fixture) {
  if (fixture.socketServer?.listening) {
    await new Promise((resolve, reject) => fixture.socketServer.close((error) =>
      error ? reject(error) : resolve()
    ));
  }
  await makeTreeOwnerWritable(fixture.root);
  await rm(fixture.root, { force: true, recursive: true });
}

async function makeFixture() {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "dominion-preflight-test-")),
  );
  const release = await copyReleaseRepository(root);
  const destination = path.join(root, "encrypted-volume");
  const privateDirectory = path.join(destination, "private");
  const tools = path.join(root, "tools");
  const stage = path.join(root, "reconciliation-stage");
  const beforeHistory = path.join(privateDirectory, "before-migration-history.txt");
  const approvedToolManifest = path.join(privateDirectory, "approved-tool-manifest.json");
  const verifierArgumentsLog = path.join(root, "verifier-arguments.log");
  await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
  await mkdir(tools, { mode: 0o700 });

  const releaseCommit = release.releaseCommit;
  assert.match(releaseCommit, /^[a-f0-9]{40}$/u);
  const genericToolContents = "#!/bin/bash\nexit 0\n";
  for (const name of [
    "docker",
    "edge-hook",
    "encrypted-volume-hook",
    "managed-ddl-hook",
    "migration-history-hook",
    "operator-pack-launcher",
    "relation-counts-hook",
    "restore-verification-hook",
    "source-fingerprint-hook",
    "source-manifest-hook",
    "storage-hook",
    "supabase",
  ]) await makeExecutable(path.join(tools, name), genericToolContents);
  const genericToolHash = sha256Bytes(genericToolContents);
  const nodeBin = await realpath(process.execPath);
  const nodeBinSha256 = await sha256File(nodeBin);
  const cleanLauncher = path.join(release.scripts, "run-production-operator-clean.sh");
  const cleanLauncherSha256 = await sha256File(cleanLauncher);
  const inputPinningHelperSha256 = await sha256File(
    path.join(release.scripts, "pin-production-input.mjs"),
  );
  const macosTcbAttestation = path.join(privateDirectory, "macos-tcb-attestation.json");
  await writeFile(macosTcbAttestation, canonicalJson({ fixture: true }), { mode: 0o600 });
  const macosTcbAttestationSha256 = await sha256File(macosTcbAttestation);
  const encryptedVolumeAttestation = path.join(
    privateDirectory,
    "encrypted-volume-attestation.json",
  );
  await writeFile(encryptedVolumeAttestation, canonicalJson({ fixture: true }), { mode: 0o600 });
  const encryptedVolumeAttestationSha256 = await sha256File(encryptedVolumeAttestation);
  const offlinePgsodiumGetkey = path.join(release.scripts, "offline-pgsodium-getkey.sh");
  const offlinePgsodiumGetkeySha256 = await sha256File(offlinePgsodiumGetkey);
  const operatorPackLauncher = path.join(tools, "operator-pack-launcher");
  const socketPath = path.join(root, "docker.sock");
  const socketServer = createServer();
  await new Promise((resolve, reject) => {
    socketServer.once("error", reject);
    socketServer.listen(socketPath, resolve);
  });
  socketServer.unref();
  await chmod(socketPath, 0o600);
  const socketMetadata = await lstat(socketPath);
  const dockerContext = {
    endpoint: `unix://${socketPath}`,
    socketPath,
    device: String(socketMetadata.dev),
    inode: String(socketMetadata.ino),
    ownerUid: socketMetadata.uid,
    ownerMode: 384,
  };
  const captureTools = {
    cleanEnvironmentLauncherSha256: cleanLauncherSha256,
    credentialValidatorSha256: await sha256File(
      path.join(release.scripts, "validate-postgres-credentials.mjs"),
    ),
    dockerBinSha256: genericToolHash,
    dumpScriptTransformerSha256: await sha256File(
      path.join(release.scripts, "prepare-supabase-dump-script.mjs"),
    ),
    edgeFunctionsInventoryHookSha256: genericToolHash,
    encryptedVolumeCheckHookSha256: genericToolHash,
    inputPinningHelperSha256,
    macosTcbAttestationSha256,
    managedApplicationDdlHookSha256: genericToolHash,
    migrationHistoryHookSha256: genericToolHash,
    nodeBinSha256,
    operatorPackCleanEnvironmentLauncherSha256: genericToolHash,
    relationCountsHookSha256: genericToolHash,
    sourceFingerprintHookSha256: genericToolHash,
    sourceManifestHookSha256: genericToolHash,
    storageInventoryHookSha256: genericToolHash,
    supabaseCliSha256: genericToolHash,
  };
  const restoreTools = {
    cleanEnvironmentLauncherSha256: cleanLauncherSha256,
    dockerBinSha256: genericToolHash,
    encryptedVolumeCheckHookSha256: genericToolHash,
    inputPinningHelperSha256,
    macosTcbAttestationSha256,
    nodeBinSha256,
    offlinePgsodiumGetkeySha256,
    operatorPackCleanEnvironmentLauncherSha256: genericToolHash,
    restoreVerificationHookSha256: genericToolHash,
  };
  const identities = {
    backupManifest: repeatedHash("a"),
    restoreEvidenceManifest: repeatedHash("b"),
    sourceManifest: sha256Bytes(sourceManifestText(0)),
    sourceFingerprint: sha256Bytes(sourceFingerprintText(0)),
    relationSequenceCounts: sha256Bytes(relationCountsText(0)),
    migrationHistory: repeatedHash("f"),
    managedApplicationDdl: repeatedHash("0"),
    captureToolset: sha256Bytes(JSON.stringify(captureTools)),
    restoreToolset: sha256Bytes(JSON.stringify(restoreTools)),
    supabaseCli: genericToolHash,
    postgresImageId: `sha256:${repeatedHash("4")}`,
  };
  const stageResult = spawnSync(nodeBin, [
    path.join(release.scripts, "prepare-reconciliation-stage.mjs"),
    "--output",
    stage,
    "--release-commit",
    releaseCommit,
    "--through-version",
    throughVersion,
  ], { cwd: release.repository, encoding: "utf8" });
  assert.equal(stageResult.status, 0, stageResult.stderr);
  await writeFile(
    beforeHistory,
    migrationList([throughVersion], []),
    { mode: 0o600 },
  );
  await writeFile(
    approvedToolManifest,
    `${JSON.stringify({
      schemaVersion: 2,
      artifactContract: "dominion-production-backup-approved-tools/v2",
      releaseCommit,
      dockerContext,
      dockerSharedHomeRoot: root,
      captureTools,
      captureToolsetSha256: identities.captureToolset,
      restoreTools,
      restoreToolsetSha256: identities.restoreToolset,
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const approvedToolManifestSha256 = await sha256File(approvedToolManifest);
  const stageManifestSha256 = await sha256File(
    path.join(stage, "reconciliation-stage.json"),
  );
  const rehearsalEvidenceDirectory = path.join(destination, "rehearsal-evidence");
  await mkdir(rehearsalEvidenceDirectory, { mode: 0o700 });
  const rehearsalArtifacts = {
    "effect-verification.json": effectText(),
    "post-relation-sequence-counts.json": relationCountsText(1),
    "post-source-fingerprint.jsonl": sourceFingerprintText(1),
    "post-source-manifest.jsonl": sourceManifestText(1),
    "pre-relation-sequence-counts.json": relationCountsText(0),
    "pre-source-fingerprint.jsonl": sourceFingerprintText(0),
    "pre-source-manifest.jsonl": sourceManifestText(0),
  };
  for (const [name, contents] of Object.entries(rehearsalArtifacts)) {
    await writeFile(path.join(rehearsalEvidenceDirectory, name), contents, { mode: 0o600 });
  }
  const artifactHashes = Object.fromEntries(
    Object.entries(rehearsalArtifacts).map(([name, contents]) => [name, sha256Bytes(contents)]),
  );
  const preState = {
    relationSequenceCountsSha256: artifactHashes["pre-relation-sequence-counts.json"],
    sourceFingerprintSha256: artifactHashes["pre-source-fingerprint.jsonl"],
    sourceManifestSha256: artifactHashes["pre-source-manifest.jsonl"],
  };
  preState.stateSha256 = stateSha256(preState);
  const postState = {
    effectVerificationSha256: artifactHashes["effect-verification.json"],
    relationSequenceCountsSha256: artifactHashes["post-relation-sequence-counts.json"],
    sourceFingerprintSha256: artifactHashes["post-source-fingerprint.jsonl"],
    sourceManifestSha256: artifactHashes["post-source-manifest.jsonl"],
  };
  postState.stateSha256 = stateSha256(postState);
  const rehearsalTools = {
    cleanEnvironmentLauncherSha256: genericToolHash,
    dockerBinSha256: genericToolHash,
    effectVerificationHookSha256: genericToolHash,
    encryptedVolumeCheckHookSha256: genericToolHash,
    inputPinningHelperSha256,
    macosTcbAttestationSha256,
    nodeBinSha256,
    offlinePgsodiumGetkeySha256,
    operatorDispatcherSha256: repeatedHash("5"),
    operatorSqlSha256: repeatedHash("6"),
    rehearsalDriverSha256: repeatedHash("7"),
    rehearsalWrapperSha256: repeatedHash("8"),
    stageVerifierSha256: repeatedHash("9"),
  };
  const backupEvidence = {
    backupManifestSha256: identities.backupManifest,
    captureToolsetSha256: identities.captureToolset,
    databaseHost: "aws-0-us-east-1.pooler.supabase.com",
    dockerContext,
    dockerSharedHomeRoot: root,
    encryptedVolumeAttestationSha256,
    macosTcbAttestationSha256,
    managedApplicationDdlSha256: identities.managedApplicationDdl,
    maxCaptureAgeSeconds: 600,
    migrationHistorySha256: identities.migrationHistory,
    migrationHistoryState: "absent",
    postgresImageId: identities.postgresImageId,
    relationSequenceCountsSha256: identities.relationSequenceCounts,
    restoreEvidenceManifestSha256: identities.restoreEvidenceManifest,
    restoreToolsetSha256: identities.restoreToolset,
    sslRootCertSha256: repeatedHash("c"),
    sslRootCertRelativePath: "private/supabase-ca/prod-ca-2021.crt",
    sourceFingerprintSha256: identities.sourceFingerprint,
    sourceManifestSha256: identities.sourceManifest,
    writerQuiescedAt,
  };
  await writeFile(
    path.join(rehearsalEvidenceDirectory, "rehearsal-evidence.json"),
    canonicalJson({
      schemaVersion: 2,
      artifactContract: "dominion-production-reconciliation-rehearsal-evidence/v2",
      databaseClientContract: "exact-network-none-restored-capture/v1",
      projectRef,
      expectedBranch: "main",
      releaseCommit,
      throughVersion,
      stageNumber: 1,
      includedVersions: [throughVersion],
      captureId,
      restoreId,
      previousRehearsalEvidenceManifestSha256: repeatedHash("0"),
      previousPostStateSha256: repeatedHash("0"),
      backupEvidence,
      dockerContext,
      dockerSharedHomeRoot: root,
      approvedBackupToolManifestSha256: approvedToolManifestSha256,
      reconciliationStageManifestSha256: stageManifestSha256,
      postgres: { image: postgresImage, imageId: identities.postgresImageId, serverVersionNum: 170006 },
      releaseRepository: release.repository,
      supabaseCli: { version: "2.109.0", sha256: identities.supabaseCli },
      tools: rehearsalTools,
      artifacts: artifactHashes,
      preState,
      postState,
    }),
    { mode: 0o600 },
  );
  const rehearsalEvidenceManifestSha256 = await sha256File(
    path.join(rehearsalEvidenceDirectory, "rehearsal-evidence.json"),
  );

  const fakeVerifier = await makeExecutable(
    path.join(tools, "verify-production-backup-evidence"),
    "#!/bin/bash\nexit 99\n",
  );
  const fakeClock = await makeExecutable(
    path.join(tools, "preflight-test-clock"),
    `#!/bin/bash\nprintf '%s\\n' '${currentTime}'\n`,
  );
  const nodeArchive = path.join(tools, "node-archive.fixture");
  await writeFile(nodeArchive, "offline fixture node archive\n", { mode: 0o600 });
  await chmod(nodeArchive, 0o600);

  const captureDirectory = path.join(destination, captureId);
  const restoreDirectory = path.join(
    destination,
    `restore-${captureId}-${restoreId}`,
  );

  return {
    approvedToolManifest,
    approvedToolManifestSha256,
    beforeHistory,
    captureDirectory,
    cleanLauncher,
    cleanLauncherSha256,
    captureTools,
    destination,
    dockerContext,
    dockerSharedHomeRoot: root,
    encryptedVolumeAttestation,
    encryptedVolumeAttestationSha256,
    fakeVerifier,
    fakeClock,
    fakeClockSha256: await sha256File(fakeClock),
    identities,
    macosTcbAttestation,
    macosTcbAttestationSha256,
    nodeBin,
    nodeBinSha256,
    nodeArchive,
    nodeArchiveSha256: await sha256File(nodeArchive),
    offlinePgsodiumGetkey,
    offlinePgsodiumGetkeySha256,
    operatorPackLauncher,
    operatorPackLauncherSha256: await sha256File(operatorPackLauncher),
    preflightScript: path.join(release.scripts, "verify-production-reconciliation-preflight.sh"),
    releaseRepository: release.repository,
    releaseCommit,
    restoreTools,
    rehearsalEvidenceDirectory,
    rehearsalEvidenceManifestSha256,
    restoreDirectory,
    root,
    socketServer,
    stage,
    verifierArgumentsLog,
    fakeVerifierSha256: await sha256File(fakeVerifier),
    beforeHistorySha256: await sha256File(beforeHistory),
    stageManifestSha256,
  };
}

async function preflightArguments(fixture) {
  const genericToolHash = fixture.identities.supabaseCli;
  const toolPath = (name) => path.join(fixture.root, "tools", name);
  return [
    "--destination", fixture.destination,
    "--capture-id", captureId,
    "--restore-id", restoreId,
    "--project-ref", projectRef,
    "--database-host", "aws-0-us-east-1.pooler.supabase.com",
    "--ssl-root-cert-sha256", repeatedHash("c"),
    "--expected-branch", "main",
    "--expected-commit", fixture.releaseCommit,
    "--supabase-cli", toolPath("supabase"),
    "--supabase-cli-sha256", fixture.identities.supabaseCli,
    "--postgres-image", postgresImage,
    "--postgres-image-id", fixture.identities.postgresImageId,
    "--encrypted-volume-attestation", fixture.encryptedVolumeAttestation,
    "--encrypted-volume-attestation-sha256",
    fixture.encryptedVolumeAttestationSha256,
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
    "--credential-validator-sha256", fixture.captureTools.credentialValidatorSha256,
    "--dump-script-transformer-sha256", fixture.captureTools.dumpScriptTransformerSha256,
    "--docker-bin", toolPath("docker"),
    "--docker-bin-sha256", genericToolHash,
    "--docker-socket", fixture.dockerContext.socketPath,
    "--docker-socket-device", fixture.dockerContext.device,
    "--docker-socket-inode", fixture.dockerContext.inode,
    "--docker-socket-owner-uid", String(fixture.dockerContext.ownerUid),
    "--docker-socket-owner-mode", String(fixture.dockerContext.ownerMode),
    "--docker-shared-home-root", fixture.dockerSharedHomeRoot,
    "--operator-pack-clean-environment-launcher", fixture.operatorPackLauncher,
    "--macos-tcb-attestation", fixture.macosTcbAttestation,
    "--macos-tcb-attestation-sha256", fixture.macosTcbAttestationSha256,
    "--release-repository", fixture.releaseRepository,
    "--offline-pgsodium-getkey", fixture.offlinePgsodiumGetkey,
    "--offline-pgsodium-getkey-sha256", fixture.offlinePgsodiumGetkeySha256,
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
    "--rehearsal-evidence-directory", fixture.rehearsalEvidenceDirectory,
    "--expected-rehearsal-evidence-manifest-sha256",
    fixture.rehearsalEvidenceManifestSha256,
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

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function environmentFor(fixture, extra = {}) {
  const fixtureValue = (name, fallback) =>
    Object.hasOwn(extra, name) ? extra[name] : fallback;
  const lines = [
    `BACKUP_MANIFEST_SHA256=${fixtureValue("FAKE_BACKUP_MANIFEST_SHA256", fixture.identities.backupManifest)}`,
    `RESTORE_EVIDENCE_MANIFEST_SHA256=${fixtureValue("FAKE_RESTORE_EVIDENCE_MANIFEST_SHA256", fixture.identities.restoreEvidenceManifest)}`,
    `SOURCE_MANIFEST_SHA256=${fixtureValue("FAKE_SOURCE_MANIFEST_SHA256", fixture.identities.sourceManifest)}`,
    `SOURCE_FINGERPRINT_SHA256=${fixtureValue("FAKE_SOURCE_FINGERPRINT_SHA256", fixture.identities.sourceFingerprint)}`,
    `RELATION_SEQUENCE_COUNTS_SHA256=${fixtureValue("FAKE_RELATION_SEQUENCE_COUNTS_SHA256", fixture.identities.relationSequenceCounts)}`,
    `MIGRATION_HISTORY_SHA256=${fixtureValue("FAKE_MIGRATION_HISTORY_SHA256", fixture.identities.migrationHistory)}`,
    `MANAGED_APPLICATION_DDL_SHA256=${fixtureValue("FAKE_MANAGED_APPLICATION_DDL_SHA256", fixture.identities.managedApplicationDdl)}`,
    `CAPTURE_TOOLSET_SHA256=${fixtureValue("FAKE_CAPTURE_TOOLSET_SHA256", fixture.identities.captureToolset)}`,
    `RESTORE_TOOLSET_SHA256=${fixtureValue("FAKE_RESTORE_TOOLSET_SHA256", fixture.identities.restoreToolset)}`,
    `APPROVED_TOOL_MANIFEST_SHA256=${fixtureValue("FAKE_APPROVED_TOOL_MANIFEST_SHA256", fixture.approvedToolManifestSha256)}`,
    `MIGRATION_HISTORY_STATE=${fixtureValue("FAKE_MIGRATION_HISTORY_STATE", "absent")}`,
    `SUPABASE_CLI_SHA256=${fixtureValue("FAKE_SUPABASE_CLI_SHA256", fixture.identities.supabaseCli)}`,
    `POSTGRES_IMAGE_ID=${fixtureValue("FAKE_POSTGRES_IMAGE_ID", fixture.identities.postgresImageId)}`,
    `WRITER_QUIESCED_AT=${fixtureValue("FAKE_WRITER_QUIESCED_AT", writerQuiescedAt)}`,
    `CAPTURE_STARTED_AT=${fixtureValue("FAKE_CAPTURE_STARTED_AT", captureStartedAt)}`,
    `CAPTURED_AT=${fixtureValue("FAKE_CAPTURED_AT", capturedAt)}`,
    `CAPTURE_DIRECTORY=${fixture.captureDirectory}`,
    `RESTORE_DIRECTORY=${fixture.restoreDirectory}`,
    "DATABASE_HOST=aws-0-us-east-1.pooler.supabase.com",
    `SSL_ROOT_CERT_SHA256=${repeatedHash("c")}`,
    "SSL_ROOT_CERT_RELATIVE_PATH=private/supabase-ca/prod-ca-2021.crt",
    `ENCRYPTED_VOLUME_ATTESTATION_SHA256=${fixture.encryptedVolumeAttestationSha256}`,
    `DOCKER_SHARED_HOME_ROOT=${fixture.dockerSharedHomeRoot}`,
    `MACOS_TCB_ATTESTATION_SHA256=${fixture.macosTcbAttestationSha256}`,
  ];
  switch (extra.FAKE_OUTPUT_MUTATION) {
    case "reordered": [lines[0], lines[1]] = [lines[1], lines[0]]; break;
    case "duplicate": lines[1] = lines[0]; break;
    case "missing": lines.splice(17, 1); break;
    case "extra": lines.push("UNEXPECTED_KEY=not-approved"); break;
  }
  const verifierContents = [
    "#!/bin/bash",
    "set -euo pipefail",
    `printf '%s\\n' \"$@\" >${shellQuote(fixture.verifierArgumentsLog)}`,
    `printf '%s\\n' ${lines.map(shellQuote).join(" ")}`,
    "",
  ].join("\n");
  writeFileSync(fixture.fakeVerifier, verifierContents, { mode: 0o700 });
  chmodSync(fixture.fakeVerifier, 0o700);
  fixture.fakeVerifierSha256 = sha256Bytes(verifierContents);

  const clockValue = fixtureValue("FAKE_TEST_CURRENT_TIME", currentTime);
  const clockContents = `#!/bin/bash\nprintf '%s\\n' ${shellQuote(clockValue)}\n`;
  writeFileSync(fixture.fakeClock, clockContents, { mode: 0o700 });
  chmodSync(fixture.fakeClock, 0o700);
  fixture.fakeClockSha256 = sha256Bytes(clockContents);

  const environment = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    DOMINION_CLEAN_ENV_LAUNCHER: "dominion-production-operator/v1",
    DOMINION_CLEAN_ENV_LAUNCHER_PATH: fixture.cleanLauncher,
    DOMINION_CLEAN_ENV_LAUNCHER_SHA256: fixture.cleanLauncherSha256,
    DOMINION_ENTRYPOINT_SHA256: fixture.cleanLauncherSha256,
    DOMINION_MACOS_TCB_ATTESTATION_SHA256: fixture.macosTcbAttestationSha256,
    DOMINION_OPERATOR_PACK_LAUNCHER_SHA256: fixture.operatorPackLauncherSha256,
    DOMINION_RELEASE_COMMIT: fixture.releaseCommit,
    DOMINION_RELEASE_REPOSITORY: fixture.releaseRepository,
    DOMINION_REPOSITORY_OPERATION: "preflight",
    DOMINION_REPOSITORY_OPERATOR_CHILD: "dominion-repository-operator-clean/v1",
    NODE_BIN: fixture.nodeBin,
    NODE_BIN_SHA256: fixture.nodeBinSha256,
    NODE_ARCHIVE: fixture.nodeArchive,
    NODE_ARCHIVE_SHA256: fixture.nodeArchiveSha256,
    PRODUCTION_BACKUP_EVIDENCE_VERIFIER_BIN: fixture.fakeVerifier,
    PRODUCTION_BACKUP_EVIDENCE_VERIFIER_SHA256: fixture.fakeVerifierSha256,
    PRODUCTION_RECONCILIATION_PREFLIGHT_TEST_MODE: "offline-fixture-only",
    PRODUCTION_RECONCILIATION_PREFLIGHT_TEST_CLOCK_BIN: fixture.fakeClock,
    PRODUCTION_RECONCILIATION_PREFLIGHT_TEST_CLOCK_SHA256: fixture.fakeClockSha256,
  };
  for (const name of [
    "PRODUCTION_BACKUP_EVIDENCE_VERIFIER_BIN",
    "PRODUCTION_BACKUP_EVIDENCE_VERIFIER_SHA256",
    "PRODUCTION_RECONCILIATION_PREFLIGHT_TEST_MODE",
    "PRODUCTION_RECONCILIATION_PREFLIGHT_TEST_CLOCK_BIN",
    "PRODUCTION_RECONCILIATION_PREFLIGHT_TEST_CLOCK_SHA256",
  ]) {
    if (Object.hasOwn(extra, name)) environment[name] = extra[name];
  }
  return environment;
}

function runPreflight(fixture, argumentsList, extraEnvironment = {}) {
  return spawnSync("/bin/bash", [fixture.preflightScript, ...argumentsList], {
    cwd: fixture.releaseRepository,
    encoding: "utf8",
    env: environmentFor(fixture, extraEnvironment),
  });
}

test("binds exact evidence, freshness, immutable stage, and one pending version", async (t) => {
  const fixture = await makeFixture();
  t.after(() => cleanupFixture(fixture));
  const argumentsList = await preflightArguments(fixture);

  const first = runPreflight(fixture, argumentsList);
  assert.equal(first.status, 0, first.stderr);
  const second = runPreflight(fixture, argumentsList);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, first.stdout, "same bound inputs must be stable");

  const lines = first.stdout.trimEnd().split("\n");
  assert.match(
    lines[0],
    /^TEST_ONLY_RECONCILIATION_PREFLIGHT_SHA256=[a-f0-9]{64}$/u,
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
  t.after(() => cleanupFixture(fixture));
  const argumentsList = await preflightArguments(fixture);
  for (const [mutation, pattern] of [
    ["duplicate", /stdout line 2 must be exactly RESTORE_EVIDENCE/u],
    ["reordered", /stdout line 1 must be exactly BACKUP_MANIFEST/u],
    ["missing", /stdout line 18 must be exactly RESTORE_DIRECTORY/u],
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

test("rejects a tampered or loose sealed rehearsal directory before backup verification", async (t) => {
  const fixture = await makeFixture();
  t.after(() => cleanupFixture(fixture));
  const argumentsList = await preflightArguments(fixture);
  const artifact = path.join(
    fixture.rehearsalEvidenceDirectory,
    "post-relation-sequence-counts.json",
  );
  const pristine = await readFile(artifact);
  await writeFile(artifact, Buffer.concat([pristine, Buffer.from(" ")]));
  let result = runPreflight(fixture, argumentsList);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /sealed offline rehearsal evidence verification failed/u);
  assert.equal(result.stdout, "");
  await writeFile(artifact, pristine);

  const unencrypted = path.join(fixture.root, "unencrypted-rehearsal-evidence");
  await cp(fixture.rehearsalEvidenceDirectory, unencrypted, { recursive: true });
  result = runPreflight(
    fixture,
    replaceOption(argumentsList, "--rehearsal-evidence-directory", unencrypted),
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /contained by the encrypted destination/u);

  const loose = path.join(fixture.rehearsalEvidenceDirectory, "legacy-result.json");
  await writeFile(loose, "{}\n");
  result = runPreflight(fixture, argumentsList);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing or unexpected artifacts/u);
  assert.equal(result.stdout, "");
  await assert.rejects(readFile(fixture.verifierArgumentsLog), { code: "ENOENT" });
});

test("rejects unapproved evidence and tool identities", async (t) => {
  const fixture = await makeFixture();
  t.after(() => cleanupFixture(fixture));
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
  t.after(() => cleanupFixture(fixture));
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
  t.after(() => cleanupFixture(fixture));
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
  t.after(() => cleanupFixture(fixture));
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
  t.after(() => cleanupFixture(fixture));
  const argumentsList = await preflightArguments(fixture);
  const result = run("/bin/bash", [fixture.preflightScript, ...argumentsList], {
    cwd: fixture.releaseRepository,
    env: environmentFor(fixture, {
      PRODUCTION_BACKUP_EVIDENCE_VERIFIER_SHA256: repeatedHash("9"),
    }),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /override evidence verifier SHA-256 does not match/u);
  assert.equal(result.stdout, "");

  const productionLabelAttempt = environmentFor(fixture);
  delete productionLabelAttempt.PRODUCTION_RECONCILIATION_PREFLIGHT_TEST_MODE;
  delete productionLabelAttempt.PRODUCTION_RECONCILIATION_PREFLIGHT_TEST_CLOCK_BIN;
  delete productionLabelAttempt.PRODUCTION_RECONCILIATION_PREFLIGHT_TEST_CLOCK_SHA256;
  const withoutOfflineBoundary = run(
    "/bin/bash",
    [fixture.preflightScript, ...argumentsList],
    { cwd: fixture.releaseRepository, env: productionLabelAttempt },
  );
  assert.notEqual(withoutOfflineBoundary.status, 0);
  assert.match(
    withoutOfflineBoundary.stderr,
    /evidence-verifier override requires PRODUCTION_RECONCILIATION_PREFLIGHT_TEST_MODE=offline-fixture-only/u,
  );
  assert.equal(withoutOfflineBoundary.stdout, "");
});

test("test clock requires an explicit hashed offline-fixture gate", async (t) => {
  const fixture = await makeFixture();
  t.after(() => cleanupFixture(fixture));
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
    [fixture.preflightScript, ...argumentsList],
    { cwd: fixture.releaseRepository, env: productionVerifierEnvironment },
  );
  assert.notEqual(productionVerifierClock.status, 0);
  assert.match(
    productionVerifierClock.stderr,
    /test clock is forbidden with the production evidence verifier/u,
  );
});
