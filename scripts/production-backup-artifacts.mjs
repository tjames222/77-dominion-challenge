#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  constants,
  createReadStream,
  lstatSync,
  realpathSync,
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const captureArtifacts = [
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
];
const restoreArtifacts = ["restore-verification.json", "restore.json"];
const requiredRestoreVerificationChecks = [
  "managed-application-ddl",
  "migration-history",
  "relation-sequence-counts",
  "roles-schema-data",
  "source-fingerprint",
  "source-manifest",
];
const storageRelations = [
  "storage.buckets",
  "storage.buckets_analytics",
  "storage.buckets_vectors",
  "storage.iceberg_namespaces",
  "storage.iceberg_tables",
  "storage.objects",
  "storage.s3_multipart_uploads",
  "storage.s3_multipart_uploads_parts",
  "storage.vector_indexes",
];
const requiredStorageRelations = new Set([
  "storage.buckets",
  "storage.buckets_analytics",
  "storage.buckets_vectors",
  "storage.objects",
  "storage.s3_multipart_uploads",
  "storage.s3_multipart_uploads_parts",
  "storage.vector_indexes",
]);
const hashPattern = /^[a-f0-9]{64}$/;
const imageIdPattern = /^sha256:[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;
const safeIdPattern = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const projectRefPattern = /^[a-z0-9]{20}$/;
const absentHistorySchema = "-- dominion migration history state: supabase_migrations schema absent\n";
const absentHistoryData = "-- dominion migration history data: supabase_migrations schema absent\n";

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const [command, ...tokens] = argv;
  const options = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      fail(`invalid argument near ${flag ?? "end of command"}`);
    }
    const key = flag.slice(2);
    if (Object.hasOwn(options, key)) {
      fail(`duplicate option --${key}`);
    }
    options[key] = value;
  }
  return { command, options };
}

function requireOption(options, name) {
  const value = options[name];
  if (!value) fail(`missing --${name}`);
  return value;
}

function requireExactOptions(options, expected) {
  const received = Object.keys(options).sort();
  const required = [...expected].sort();
  assert.deepEqual(
    received,
    required,
    `expected only ${required.map((name) => `--${name}`).join(", ")}`,
  );
}

async function parseJsonFile(filename) {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`${filename} must be a regular, non-symlink file`);
  }
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    fail(`${filename} is not valid JSON: ${error.message}`);
  }
}

async function parseCanonicalJsonFile(filename, label) {
  const snapshot = await readAuthenticatedFile(filename, label);
  let value;
  try {
    value = JSON.parse(snapshot.contents.toString("utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
  const contents = snapshot.contents.toString("utf8");
  if (contents !== `${JSON.stringify(value, null, 2)}\n`) {
    fail(`${label} must be canonical two-space JSON with one trailing newline`);
  }
  return value;
}

async function readAuthenticatedFile(filename, label) {
  if (!path.isAbsolute(filename)) fail(`${label} path must be absolute`);
  const pathBefore = await lstat(filename, { bigint: true });
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const state = await handle.stat({ bigint: true });
    if (
      !state.isFile()
      || state.isSymbolicLink()
      || !sameInode(pathBefore, state)
    ) fail(`${label} must be the exact opened regular file`);
    assertOwnerOnly(state, label);
    if ((modeBits(state) & 0o400) !== 0o400) fail(`${label} must be owner-readable`);
    if (state.nlink !== 1n) fail(`${label} must have exactly one hard link`);
    assertNoAcl(filename, label);
    const size = Number(state.size);
    if (!Number.isSafeInteger(size)) fail(`${label} is too large to address safely`);
    const contents = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(contents, offset, size - offset, offset);
      if (bytesRead === 0) fail(`${label} changed while it was read`);
      offset += bytesRead;
    }
    const current = await handle.stat({ bigint: true });
    const currentPath = await lstat(filename, { bigint: true });
    if (!sameFileState(state, current) || !sameInode(current, currentPath)) {
      fail(`${label} changed during authenticated access`);
    }
    assertNoAcl(filename, label);
    return {
      contents,
      sha256: createHash("sha256").update(contents).digest("hex"),
    };
  } finally {
    await handle.close();
  }
}

async function readAuthenticatedCanonicalJson(filename, label) {
  const snapshot = await readAuthenticatedFile(filename, label);
  let value;
  try {
    value = JSON.parse(snapshot.contents.toString("utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
  if (snapshot.contents.toString("utf8") !== `${JSON.stringify(value, null, 2)}\n`) {
    fail(`${label} must be canonical two-space JSON with one trailing newline`);
  }
  return { ...snapshot, value };
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
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

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
}

function requireRfc3339UtcSecond(value, label) {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)
  ) {
    fail(`${label} must be an RFC3339 UTC second timestamp`);
  }
  const parsed = new Date(value);
  if (
    Number.isNaN(parsed.getTime())
    || parsed.toISOString().replace(".000Z", "Z") !== value
  ) {
    fail(`${label} must be a real RFC3339 UTC second timestamp`);
  }
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

function validateEncryptedVolumeAttestation(attestation, destination, creationRecord) {
  exactKeys(
    attestation,
    ["artifactContract", "encryption", "image", "mountedSession", "schemaVersion"],
    "encrypted-volume attestation",
  );
  if (
    attestation.schemaVersion !== 2
    || attestation.artifactContract !== "dominion-encrypted-volume-attestation/v2"
  ) fail("encrypted-volume attestation contract is not exact v2");

  exactKeys(
    attestation.encryption,
    [
      "algorithm",
      "creationRecordSha256",
      "imageInfoPlistSha256",
      "imageUuid",
      "isEncryptedPlistSha256",
    ],
    "encrypted-volume attestation encryption",
  );
  if (attestation.encryption.algorithm !== "AES-256") {
    fail("encrypted-volume attestation algorithm must be AES-256");
  }
  for (const name of [
    "creationRecordSha256",
    "imageInfoPlistSha256",
    "isEncryptedPlistSha256",
  ]) assertHash(attestation.encryption[name], `encrypted-volume ${name}`);
  if (
    typeof attestation.encryption.imageUuid !== "string"
    || !/^[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}$/u.test(
      attestation.encryption.imageUuid,
    )
  ) fail("encrypted-volume image UUID is invalid");
  exactKeys(
    creationRecord,
    [
      "argv",
      "artifactContract",
      "createdAbsentBefore",
      "createdAt",
      "hdiutilPath",
      "imagePath",
      "imageUuid",
      "schemaVersion",
    ],
    "encrypted-volume AES-256 creation record",
  );
  if (
    creationRecord.schemaVersion !== 2
    || creationRecord.artifactContract
      !== "dominion-encrypted-volume-aes256-creation-record/v2"
    || creationRecord.createdAbsentBefore !== true
    || creationRecord.hdiutilPath !== "/usr/bin/hdiutil"
    || creationRecord.imageUuid !== attestation.encryption.imageUuid
  ) fail("encrypted-volume AES-256 creation record identity is invalid");
  requireRfc3339UtcSecond(creationRecord.createdAt, "encrypted-volume creation time");

  const imageKeys = [
    "backingStoreClassName",
    "className",
    "device",
    "encrypted",
    "format",
    "formatDescription",
    "identitySha256",
    "infoBackupSha256",
    "infoPlistDevice",
    "infoPlistInode",
    "infoPlistSha256",
    "infoPlistSize",
    "inode",
    "lockSha256",
    "path",
    "tokenDevice",
    "tokenInode",
    "tokenSha256",
    "tokenSize",
  ];
  exactKeys(attestation.image, imageKeys, "encrypted-volume attestation image");
  const image = attestation.image;
  if (
    image.className !== "CSparseBundleDiskImage"
    || image.backingStoreClassName !== "CBundleBackingStore"
    || image.format !== "UDSB"
    || image.formatDescription !== "sparse"
    || image.encrypted !== true
  ) fail("encrypted-volume backing image identity is not the exact AES-256 sparsebundle contract");
  if (typeof image.path !== "string" || !path.isAbsolute(image.path)) {
    fail("encrypted-volume backing image path must be absolute");
  }
  if (
    creationRecord.imagePath !== image.path
    || JSON.stringify(creationRecord.argv) !== JSON.stringify([
      "create",
      "-size",
      "16g",
      "-type",
      "SPARSEBUNDLE",
      "-fs",
      "APFS",
      "-volname",
      "77DCProductionRelease",
      "-encryption",
      "AES-256",
      "-stdinpass",
      image.path,
    ])
  ) fail("encrypted-volume creation record does not bind the exact AES-256 create operation");
  for (const name of [
    "device",
    "inode",
    "infoPlistDevice",
    "infoPlistInode",
    "infoPlistSize",
    "tokenDevice",
    "tokenInode",
    "tokenSize",
  ]) {
    if (typeof image[name] !== "string" || !/^[0-9]+$/u.test(image[name])) {
      fail(`encrypted-volume image ${name} must be a base-10 identity string`);
    }
  }
  for (const name of [
    "infoBackupSha256",
    "infoPlistSha256",
    "lockSha256",
    "tokenSha256",
  ]) assertHash(image[name], `encrypted-volume image ${name}`);
  assertHash(image.identitySha256, "encrypted-volume image identity SHA-256");
  const imageIdentity = Object.fromEntries(
    Object.entries(image).filter(([name]) => name !== "identitySha256"),
  );
  if (sha256Object(imageIdentity) !== image.identitySha256) {
    fail("encrypted-volume image identity SHA-256 does not match");
  }

  const sessionKeys = [
    "blocksize",
    "destination",
    "identitySha256",
    "imageEncrypted",
    "imagePath",
    "imageType",
    "ownerMode",
    "ownerUid",
    "hdidPid",
    "volumeDevice",
    "volumeDeviceId",
    "volumeInode",
    "wholeDiskDevice",
    "writeable",
  ];
  exactKeys(
    attestation.mountedSession,
    sessionKeys,
    "encrypted-volume attestation mountedSession",
  );
  const session = attestation.mountedSession;
  if (
    session.destination !== destination
    || session.imagePath !== image.path
    || session.imageType !== "sparse bundle disk image"
    || session.imageEncrypted !== true
    || session.writeable !== true
    || session.blocksize !== 512
    || session.ownerUid !== process.getuid?.()
    || session.ownerMode !== 448
    || !Number.isSafeInteger(session.hdidPid)
    || session.hdidPid <= 0
  ) fail("encrypted-volume mounted session does not match the exact owner-only writable contract");
  for (const name of ["wholeDiskDevice", "volumeDevice"]) {
    if (typeof session[name] !== "string" || !/^\/dev\/disk[0-9]+(?:s[0-9]+)?$/u.test(session[name])) {
      fail(`encrypted-volume mounted session ${name} is invalid`);
    }
  }
  for (const name of ["volumeDeviceId", "volumeInode"]) {
    if (typeof session[name] !== "string" || !/^[0-9]+$/u.test(session[name])) {
      fail(`encrypted-volume mounted session ${name} must be a base-10 identity string`);
    }
  }
  assertHash(session.identitySha256, "encrypted-volume mounted-session identity SHA-256");
  const sessionIdentity = Object.fromEntries(
    Object.entries(session).filter(([name]) => name !== "identitySha256"),
  );
  if (sha256Object(sessionIdentity) !== session.identitySha256) {
    fail("encrypted-volume mounted-session identity SHA-256 does not match");
  }
}

const captureToolNames = [
  "cleanEnvironmentLauncherSha256",
  "credentialValidatorSha256",
  "dockerBinSha256",
  "dumpScriptTransformerSha256",
  "edgeFunctionsInventoryHookSha256",
  "encryptedVolumeCheckHookSha256",
  "inputPinningHelperSha256",
  "macosTcbAttestationSha256",
  "managedApplicationDdlHookSha256",
  "migrationHistoryHookSha256",
  "nodeBinSha256",
  "operatorPackCleanEnvironmentLauncherSha256",
  "relationCountsHookSha256",
  "sourceFingerprintHookSha256",
  "sourceManifestHookSha256",
  "storageInventoryHookSha256",
  "supabaseCliSha256",
];
const restoreToolNames = [
  "cleanEnvironmentLauncherSha256",
  "dockerBinSha256",
  "encryptedVolumeCheckHookSha256",
  "inputPinningHelperSha256",
  "macosTcbAttestationSha256",
  "nodeBinSha256",
  "offlinePgsodiumGetkeySha256",
  "operatorPackCleanEnvironmentLauncherSha256",
  "restoreVerificationHookSha256",
];
const captureToolOptions = [
  ["clean-environment-launcher-sha256", "cleanEnvironmentLauncherSha256"],
  ["credential-validator-sha256", "credentialValidatorSha256"],
  ["docker-bin-sha256", "dockerBinSha256"],
  ["dump-script-transformer-sha256", "dumpScriptTransformerSha256"],
  ["edge-functions-inventory-hook-sha256", "edgeFunctionsInventoryHookSha256"],
  ["encrypted-volume-check-hook-sha256", "encryptedVolumeCheckHookSha256"],
  ["input-pinning-helper-sha256", "inputPinningHelperSha256"],
  ["macos-tcb-attestation-sha256", "macosTcbAttestationSha256"],
  ["managed-application-ddl-hook-sha256", "managedApplicationDdlHookSha256"],
  ["migration-history-hook-sha256", "migrationHistoryHookSha256"],
  ["node-bin-sha256", "nodeBinSha256"],
  ["operator-pack-clean-environment-launcher-sha256", "operatorPackCleanEnvironmentLauncherSha256"],
  ["relation-counts-hook-sha256", "relationCountsHookSha256"],
  ["source-fingerprint-hook-sha256", "sourceFingerprintHookSha256"],
  ["source-manifest-hook-sha256", "sourceManifestHookSha256"],
  ["storage-inventory-hook-sha256", "storageInventoryHookSha256"],
  ["supabase-cli-sha256", "supabaseCliSha256"],
];
const restoreToolOptions = [
  ["clean-environment-launcher-sha256", "cleanEnvironmentLauncherSha256"],
  ["docker-bin-sha256", "dockerBinSha256"],
  ["encrypted-volume-check-hook-sha256", "encryptedVolumeCheckHookSha256"],
  ["input-pinning-helper-sha256", "inputPinningHelperSha256"],
  ["macos-tcb-attestation-sha256", "macosTcbAttestationSha256"],
  ["node-bin-sha256", "nodeBinSha256"],
  ["offline-pgsodium-getkey-sha256", "offlinePgsodiumGetkeySha256"],
  ["operator-pack-clean-environment-launcher-sha256", "operatorPackCleanEnvironmentLauncherSha256"],
  ["restore-verification-hook-sha256", "restoreVerificationHookSha256"],
];

function toolsetFromOptions(options, mappings) {
  return Object.fromEntries(
    mappings.map(([option, property]) => [property, requireOption(options, option)]),
  );
}

function validateToolset(tools, names, expectedHash, label) {
  requireObject(tools, `${label} tools`);
  assert.deepEqual(
    Object.keys(tools).sort(),
    names,
    `${label} tool inventory must contain the exact v2 keys`,
  );
  for (const name of names) assertHash(tools[name], `${label} ${name}`);
  assertHash(expectedHash, `${label} toolset SHA-256`);
  if (sha256Object(tools) !== expectedHash) {
    fail(`${label} toolset SHA-256 does not match its canonical tool inventory`);
  }
}

const dockerContextOptions = [
  ["docker-socket", "socketPath"],
  ["docker-socket-device", "device"],
  ["docker-socket-inode", "inode"],
  ["docker-socket-owner-uid", "ownerUid"],
  ["docker-socket-owner-mode", "ownerMode"],
];

function dockerContextFromOptions(options) {
  const context = Object.fromEntries(dockerContextOptions.map(([option, key]) => {
    const value = requireOption(options, option);
    return [key, ["ownerUid", "ownerMode"].includes(key) ? Number(value) : value];
  }));
  return { endpoint: `unix://${context.socketPath}`, ...context };
}

function validateDockerContext(context, label) {
  exactKeys(
    context,
    ["device", "endpoint", "inode", "ownerMode", "ownerUid", "socketPath"],
    label,
  );
  if (
    !path.isAbsolute(context.socketPath ?? "")
    || context.endpoint !== `unix://${context.socketPath}`
    || !/^[0-9]+$/u.test(context.device ?? "")
    || !/^[0-9]+$/u.test(context.inode ?? "")
    || !Number.isSafeInteger(context.ownerUid)
    || context.ownerUid < 0
    || context.ownerMode !== 384
  ) fail(`${label} is not an exact owner-only canonical Unix socket identity`);
  return context;
}

function validateDockerSharedHomeRoot(value, label) {
  if (!path.isAbsolute(value ?? "") || value === "/") {
    fail(`${label} must be a non-root absolute path`);
  }
  let metadata;
  let canonical;
  try {
    metadata = lstatSync(value);
    canonical = realpathSync(value);
  } catch {
    fail(`${label} must be an existing canonical directory`);
  }
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || canonical !== value
    || metadata.uid !== process.getuid()
  ) fail(`${label} must be a canonical current-user-owned real directory`);
  return value;
}

function validateApprovedToolManifest(manifest, releaseCommit) {
  requireObject(manifest, "approved tool manifest");
  assert.deepEqual(
    Object.keys(manifest).sort(),
    [
      "artifactContract",
      "captureTools",
      "captureToolsetSha256",
      "dockerContext",
      "dockerSharedHomeRoot",
      "releaseCommit",
      "restoreTools",
      "restoreToolsetSha256",
      "schemaVersion",
    ].sort(),
    "approved tool manifest must contain the exact v2 keys",
  );
  if (
    manifest.schemaVersion !== 2
    || manifest.artifactContract !== "dominion-production-backup-approved-tools/v2"
  ) {
    fail("approved tool manifest contract is not v2");
  }
  if (!commitPattern.test(manifest.releaseCommit)) {
    fail("approved tool manifest releaseCommit is invalid");
  }
  if (manifest.releaseCommit !== releaseCommit) {
    fail("approved tool manifest is not bound to the exact release commit");
  }
  validateToolset(
    manifest.captureTools,
    captureToolNames,
    manifest.captureToolsetSha256,
    "approved capture",
  );
  validateDockerContext(manifest.dockerContext, "approved Docker context");
  validateDockerSharedHomeRoot(
    manifest.dockerSharedHomeRoot,
    "approved Docker shared-home root",
  );
  validateToolset(
    manifest.restoreTools,
    restoreToolNames,
    manifest.restoreToolsetSha256,
    "approved restore",
  );
  return manifest;
}

function requireOrderedTimes(writerQuiescedAt, captureStartedAt, capturedAt) {
  requireRfc3339UtcSecond(writerQuiescedAt, "capture writerQuiescedAt");
  requireRfc3339UtcSecond(captureStartedAt, "capture captureStartedAt");
  requireRfc3339UtcSecond(capturedAt, "capture capturedAt");
  if (Date.parse(captureStartedAt) < Date.parse(writerQuiescedAt)) {
    fail("capture started before writer quiescence");
  }
  if (Date.parse(capturedAt) < Date.parse(captureStartedAt)) {
    fail("capture completion precedes capture start");
  }
}

function validateEdgeInventory(inventory, projectRef) {
  requireObject(inventory, "Edge Function inventory");
  if (inventory.schemaVersion !== 1) {
    fail("Edge Function inventory schemaVersion must be 1");
  }
  if (inventory.projectRef !== projectRef) {
    fail("Edge Function inventory projectRef does not match");
  }
  if (!Array.isArray(inventory.functions)) {
    fail("Edge Function inventory functions must be an array");
  }

  const names = new Set();
  const slugs = new Set();
  for (const [index, entry] of inventory.functions.entries()) {
    requireObject(entry, `functions[${index}]`);
    requireString(entry.name, `functions[${index}].name`);
    requireString(entry.slug, `functions[${index}].slug`);
    requireString(entry.status, `functions[${index}].status`);
    if (!Number.isSafeInteger(entry.version)) {
      fail(`functions[${index}].version must be an integer`);
    }
    if (typeof entry.verifyJwt !== "boolean") {
      fail(`functions[${index}].verifyJwt must be a boolean`);
    }
    if (names.has(entry.name) || slugs.has(entry.slug)) {
      fail("Edge Function inventory contains a duplicate name or slug");
    }
    names.add(entry.name);
    slugs.add(entry.slug);
  }
  const orderedSlugs = inventory.functions.map((entry) => entry.slug);
  assert.deepEqual(
    orderedSlugs,
    [...orderedSlugs].sort((left, right) =>
      Buffer.from(left).compare(Buffer.from(right))
    ),
    "Edge Function inventory must be bytewise slug-sorted",
  );
}

function validateStorageInventory(inventory, projectRef) {
  requireObject(inventory, "Storage inventory");
  if (inventory.schemaVersion !== 1) {
    fail("Storage inventory schemaVersion must be 1");
  }
  if (inventory.projectRef !== projectRef) {
    fail("Storage inventory projectRef does not match");
  }
  requireObject(inventory.relations, "Storage inventory relations");
  const actualRelations = Object.keys(inventory.relations).sort();
  assert.deepEqual(
    actualRelations,
    [...storageRelations].sort(),
    "Storage inventory must contain the complete pinned relation list",
  );

  for (const relationName of storageRelations) {
    const relation = inventory.relations[relationName];
    requireObject(relation, relationName);
    if (typeof relation.present !== "boolean") {
      fail(`${relationName}.present must be a boolean`);
    }
    if (relation.present) {
      if (!Number.isSafeInteger(relation.rowCount) || relation.rowCount < 0) {
        fail(`${relationName}.rowCount must be a non-negative integer`);
      }
    } else if (relation.rowCount !== null) {
      fail(`${relationName}.rowCount must be null when the relation is absent`);
    }
    if (requiredStorageRelations.has(relationName) && !relation.present) {
      fail(`${relationName} must be present for a complete blob inventory`);
    }
  }

  if (!Array.isArray(inventory.buckets)) {
    fail("Storage inventory buckets must be an array");
  }
  if (!Array.isArray(inventory.applicationPolicies)) {
    fail("Storage inventory applicationPolicies must be an array");
  }
  if (inventory.buckets.length !== inventory.relations["storage.buckets"].rowCount) {
    fail("Storage bucket inventory length does not match storage.buckets rowCount");
  }
  if (
    !Number.isSafeInteger(inventory.applicationPolicyCount)
    || inventory.applicationPolicyCount < 0
    || inventory.applicationPolicyCount !== inventory.applicationPolicies.length
  ) {
    fail("Storage applicationPolicyCount must match the complete policy inventory");
  }

  const bucketIds = [];
  for (const [index, bucket] of inventory.buckets.entries()) {
    requireObject(bucket, `buckets[${index}]`);
    requireString(bucket.id, `buckets[${index}].id`);
    requireString(bucket.name, `buckets[${index}].name`);
    if (typeof bucket.public !== "boolean") {
      fail(`buckets[${index}].public must be a boolean`);
    }
    if (bucket.ownerId !== null && typeof bucket.ownerId !== "string") {
      fail(`buckets[${index}].ownerId must be a string or null`);
    }
    if (
      bucket.fileSizeLimit !== null
      && (!Number.isSafeInteger(bucket.fileSizeLimit) || bucket.fileSizeLimit < 0)
    ) {
      fail(`buckets[${index}].fileSizeLimit must be a non-negative integer or null`);
    }
    if (
      bucket.allowedMimeTypes !== null
      && (
        !Array.isArray(bucket.allowedMimeTypes)
        || bucket.allowedMimeTypes.some((value) => typeof value !== "string")
      )
    ) {
      fail(`buckets[${index}].allowedMimeTypes must be a string array or null`);
    }
    if (bucket.type !== null && typeof bucket.type !== "string") {
      fail(`buckets[${index}].type must be a string or null`);
    }
    bucketIds.push(bucket.id);
  }
  if (new Set(bucketIds).size !== bucketIds.length) {
    fail("Storage bucket IDs must be unique");
  }
  assert.deepEqual(
    bucketIds,
    [...bucketIds].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))),
    "Storage buckets must be bytewise ID-sorted",
  );

  const policyIdentities = [];
  for (const [index, policy] of inventory.applicationPolicies.entries()) {
    requireObject(policy, `applicationPolicies[${index}]`);
    requireString(policy.table, `applicationPolicies[${index}].table`);
    requireString(policy.name, `applicationPolicies[${index}].name`);
    requireString(policy.command, `applicationPolicies[${index}].command`);
    if (
      !Array.isArray(policy.roles)
      || policy.roles.length === 0
      || policy.roles.some((role) => typeof role !== "string" || role.length === 0)
    ) {
      fail(`applicationPolicies[${index}].roles must be a non-empty string array`);
    }
    if (policy.using !== null && typeof policy.using !== "string") {
      fail(`applicationPolicies[${index}].using must be a string or null`);
    }
    if (policy.withCheck !== null && typeof policy.withCheck !== "string") {
      fail(`applicationPolicies[${index}].withCheck must be a string or null`);
    }
    policyIdentities.push(`${policy.table}/${policy.name}`);
  }
  if (new Set(policyIdentities).size !== policyIdentities.length) {
    fail("Storage application policy identities must be unique");
  }
  assert.deepEqual(
    policyIdentities,
    [...policyIdentities].sort((left, right) =>
      Buffer.from(left).compare(Buffer.from(right))
    ),
    "Storage application policies must be bytewise identity-sorted",
  );

  for (const relationName of [
    "storage.buckets_vectors",
    "storage.objects",
    "storage.s3_multipart_uploads",
    "storage.s3_multipart_uploads_parts",
    "storage.vector_indexes",
  ]) {
    if (inventory.relations[relationName].rowCount !== 0) {
      fail(
        `${relationName} is nonzero; export Storage blobs through the Storage API before retrying`,
      );
    }
  }
}

function validateDumpContract(contract, historyState, cliSha256, imageId) {
  requireObject(contract, "dump contract");
  if (
    contract.schemaVersion !== 1
    || contract.supabaseCliSha256 !== cliSha256
    || contract.postgresImageId !== imageId
    || contract.migrationHistoryState !== historyState
  ) {
    fail("dump contract identity does not match the capture");
  }
  const expectedNames = historyState === "present"
    ? ["roles.sql", "schema.sql", "data.sql", "history-schema.sql", "history-data.sql"]
    : ["roles.sql", "schema.sql", "data.sql"];
  if (!Array.isArray(contract.scripts)) fail("dump contract scripts must be an array");
  assert.deepEqual(
    contract.scripts.map((entry) => entry.name),
    expectedNames,
    "dump contract scripts do not match the exact capture plan",
  );
  for (const [index, entry] of contract.scripts.entries()) {
    requireObject(entry, `dump contract scripts[${index}]`);
    assertHash(entry.supabaseDryRunSha256, "Supabase dry-run SHA-256");
    assertHash(entry.executableScriptSha256, "executable dump-script SHA-256");
  }
}

async function validateJsonLines(filename, label) {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`${filename} must be a regular, non-symlink file`);
  }
  const lines = (await readFile(filename, "utf8")).split("\n").filter(Boolean);
  if (lines.length === 0) fail(`${label} must contain at least one record`);
  const keys = [];
  for (const [index, line] of lines.entries()) {
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      fail(`${label} line ${index + 1} is not JSON: ${error.message}`);
    }
    requireObject(record, `${label} line ${index + 1}`);
    requireString(record.key, `${label} line ${index + 1}.key`);
    requireString(record.kind, `${label} line ${index + 1}.kind`);
    requireString(record.identity, `${label} line ${index + 1}.identity`);
    if (!Object.hasOwn(record, "definition")) {
      fail(`${label} line ${index + 1} is missing definition`);
    }
    keys.push(record.key);
  }
  if (new Set(keys).size !== keys.length) fail(`${label} keys must be unique`);
  const sortedKeys = [...keys].sort((left, right) =>
    Buffer.from(left).compare(Buffer.from(right))
  );
  assert.deepEqual(keys, sortedKeys, `${label} records must be bytewise key-sorted`);
}

function validateJsonLinesContents(contents, label) {
  const lines = contents.split("\n").filter(Boolean);
  if (lines.length === 0) fail(`${label} must contain at least one record`);
  const keys = [];
  for (const [index, line] of lines.entries()) {
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      fail(`${label} line ${index + 1} is not JSON: ${error.message}`);
    }
    requireObject(record, `${label} line ${index + 1}`);
    requireString(record.key, `${label} line ${index + 1}.key`);
    requireString(record.kind, `${label} line ${index + 1}.kind`);
    requireString(record.identity, `${label} line ${index + 1}.identity`);
    if (!Object.hasOwn(record, "definition")) {
      fail(`${label} line ${index + 1} is missing definition`);
    }
    keys.push(record.key);
  }
  if (new Set(keys).size !== keys.length) fail(`${label} keys must be unique`);
  assert.deepEqual(
    keys,
    [...keys].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))),
    `${label} records must be bytewise key-sorted`,
  );
}

function validateRelationSequenceCounts(inventory, projectRef) {
  requireObject(inventory, "relation/sequence inventory");
  exactKeys(
    inventory,
    ["projectRef", "relations", "schemaVersion", "schemas", "sequences", "vaultSecretsCount"],
    "relation/sequence inventory",
  );
  if (inventory.schemaVersion !== 2) {
    fail("relation/sequence inventory schemaVersion must be 2");
  }
  if (inventory.projectRef !== projectRef) {
    fail("relation/sequence inventory projectRef does not match");
  }
  assert.deepEqual(
    inventory.schemas,
    ["auth", "private", "public", "storage", "supabase_migrations"],
    "relation/sequence inventory must cover the canonical schema list",
  );
  if (!Array.isArray(inventory.relations) || inventory.relations.length === 0) {
    fail("relation/sequence inventory relations must be a non-empty array");
  }
  if (!Array.isArray(inventory.sequences)) {
    fail("relation/sequence inventory sequences must be an array");
  }
  if (inventory.vaultSecretsCount !== 0) {
    fail("relation/sequence inventory must prove the required vault.secrets table exists and is empty");
  }

  const relationKeys = [];
  for (const [index, relation] of inventory.relations.entries()) {
    requireObject(relation, `relations[${index}]`);
    requireString(relation.schema, `relations[${index}].schema`);
    requireString(relation.name, `relations[${index}].name`);
    if (!inventory.schemas.includes(relation.schema)) {
      fail(`relations[${index}] uses an unlisted schema`);
    }
    if (typeof relation.present !== "boolean") {
      fail(`relations[${index}].present must be a boolean`);
    }
    if (relation.present) {
      if (!Number.isSafeInteger(relation.rowCount) || relation.rowCount < 0) {
        fail(`relations[${index}].rowCount must be a non-negative integer`);
      }
      if (!hashPattern.test(relation.rowsSha256)) {
        fail(`relations[${index}].rowsSha256 must be a lowercase SHA-256`);
      }
    } else if (relation.rowCount !== null || relation.rowsSha256 !== null) {
      fail(`relations[${index}] absent values must be null`);
    }
    relationKeys.push(`${relation.schema}.${relation.name}`);
  }
  if (new Set(relationKeys).size !== relationKeys.length) {
    fail("relation/sequence inventory relation identities must be unique");
  }
  assert.deepEqual(
    relationKeys,
    [...relationKeys].sort((left, right) =>
      Buffer.from(left).compare(Buffer.from(right))
    ),
    "relation inventory must be bytewise identity-sorted",
  );

  const sequenceKeys = [];
  for (const [index, sequence] of inventory.sequences.entries()) {
    requireObject(sequence, `sequences[${index}]`);
    requireString(sequence.schema, `sequences[${index}].schema`);
    requireString(sequence.name, `sequences[${index}].name`);
    if (!inventory.schemas.includes(sequence.schema)) {
      fail(`sequences[${index}] uses an unlisted schema`);
    }
    if (typeof sequence.present !== "boolean") {
      fail(`sequences[${index}].present must be a boolean`);
    }
    if (sequence.present) {
      if (typeof sequence.lastValue !== "string" || !/^-?[0-9]+$/.test(sequence.lastValue)) {
        fail(`sequences[${index}].lastValue must be an integer string`);
      }
      if (typeof sequence.isCalled !== "boolean") {
        fail(`sequences[${index}].isCalled must be a boolean`);
      }
    } else if (sequence.lastValue !== null || sequence.isCalled !== null) {
      fail(`sequences[${index}] absent values must be null`);
    }
    sequenceKeys.push(`${sequence.schema}.${sequence.name}`);
  }
  if (new Set(sequenceKeys).size !== sequenceKeys.length) {
    fail("relation/sequence inventory sequence identities must be unique");
  }
  assert.deepEqual(
    sequenceKeys,
    [...sequenceKeys].sort((left, right) =>
      Buffer.from(left).compare(Buffer.from(right))
    ),
    "sequence inventory must be bytewise identity-sorted",
  );
}

function validateMigrationHistory(inventory, projectRef) {
  requireObject(inventory, "migration-history inventory");
  if (inventory.schemaVersion !== 1) {
    fail("migration-history inventory schemaVersion must be 1");
  }
  if (inventory.projectRef !== projectRef) {
    fail("migration-history inventory projectRef does not match");
  }
  if (
    typeof inventory.schemaPresent !== "boolean"
    || typeof inventory.tablePresent !== "boolean"
    || !Array.isArray(inventory.versions)
  ) {
    fail("migration-history presence fields are invalid");
  }
  if (!inventory.schemaPresent) {
    if (
      inventory.tablePresent
      || inventory.rowCount !== null
      || inventory.versions.length !== 0
    ) {
      fail("absent migration-history schema must have no table, count, or versions");
    }
    return "absent";
  }
  if (!inventory.tablePresent) {
    fail("present migration-history schema without schema_migrations is unsupported");
  }
  if (
    !Number.isSafeInteger(inventory.rowCount)
    || inventory.rowCount < 0
    || inventory.rowCount !== inventory.versions.length
  ) {
    fail("migration-history rowCount must match the complete version inventory");
  }
  if (
    inventory.versions.some((version) =>
      typeof version !== "string" || !/^[0-9]{14}$/.test(version)
    )
  ) {
    fail("migration-history versions must be 14-digit strings");
  }
  if (new Set(inventory.versions).size !== inventory.versions.length) {
    fail("migration-history versions must be unique");
  }
  assert.deepEqual(
    inventory.versions,
    [...inventory.versions].sort(),
    "migration-history versions must be sorted",
  );
  return "present";
}

async function validateManagedApplicationDdl(filename) {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail("managed application DDL must be a regular, non-symlink file");
  }
  const sql = await readFile(filename, "utf8");
  if (!sql.startsWith("-- dominion managed application DDL v1\n")) {
    fail("managed application DDL is missing its exact v1 sentinel");
  }
  if (/^\s*\\/m.test(sql)) {
    fail("managed application DDL cannot contain psql meta-commands");
  }
  if (/\b(?:alter\s+system|create\s+database|drop\s+database)\b/i.test(sql)) {
    fail("managed application DDL contains a cluster-level statement");
  }
}

function validateManagedApplicationDdlContents(sql) {
  if (!sql.startsWith("-- dominion managed application DDL v1\n")) {
    fail("managed application DDL is missing its exact v1 sentinel");
  }
  if (/^\s*\\/mu.test(sql)) {
    fail("managed application DDL cannot contain psql meta-commands");
  }
  if (/\b(?:alter\s+system|create\s+database|drop\s+database)\b/iu.test(sql)) {
    fail("managed application DDL contains a cluster-level statement");
  }
}

async function sha256File(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function validateDataDump(filename) {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail("data dump must be a regular, non-symlink file");
  }
  let authUsers = false;
  let storageBuckets = false;
  let tail = "";
  for await (const chunk of createReadStream(filename, { encoding: "utf8" })) {
    const window = tail + chunk;
    authUsers ||= /COPY\s+"auth"\."users"\s*\(/.test(window);
    storageBuckets ||= /COPY\s+"storage"\."buckets"\s*\(/.test(window);
    tail = window.slice(-512);
  }
  if (!authUsers) fail("data dump does not contain the Auth users table");
  if (!storageBuckets) fail("data dump does not contain the Storage buckets table");
}

async function validateDataDumpEvidence(session) {
  const entry = session.handles.get("data.sql");
  let authUsers = false;
  let storageBuckets = false;
  let tail = "";
  const stream = entry.handle.createReadStream({
    autoClose: false,
    encoding: "utf8",
    start: 0,
  });
  for await (const chunk of stream) {
    const window = tail + chunk;
    authUsers ||= /COPY\s+"auth"\."users"\s*\(/u.test(window);
    storageBuckets ||= /COPY\s+"storage"\."buckets"\s*\(/u.test(window);
    tail = window.slice(-512);
  }
  if (!authUsers) fail("data dump does not contain the Auth users table");
  if (!storageBuckets) fail("data dump does not contain the Storage buckets table");
}

function expectedArtifacts(kind) {
  if (kind === "capture") return captureArtifacts;
  if (kind === "restore") return restoreArtifacts;
  fail("--kind must be capture or restore");
}

function completionMarker(kind) {
  return kind === "capture" ? "CAPTURE_COMPLETE.json" : "RESTORE_COMPLETE.json";
}

function incompleteMarker(kind) {
  return kind === "capture" ? "CAPTURE_INCOMPLETE" : "RESTORE_INCOMPLETE";
}

function modeBits(stat) {
  return Number(stat.mode & 0o777n);
}

function sameInode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileState(left, right) {
  return sameInode(left, right)
    && left.uid === right.uid
    && left.nlink === right.nlink
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function assertOwner(stat, label) {
  if (typeof process.getuid === "function" && stat.uid !== BigInt(process.getuid())) {
    fail(`${label} must be owned by the current operator`);
  }
}

function assertOwnerOnly(stat, label, expectedMode = null) {
  assertOwner(stat, label);
  const mode = modeBits(stat);
  if ((mode & 0o077) !== 0) fail(`${label} must be owner-only`);
  if (expectedMode !== null && mode !== expectedMode) {
    fail(`${label} mode must be ${expectedMode.toString(8)}`);
  }
}

function assertNoAcl(filename, label) {
  const detailed = spawnSync("/bin/ls", ["-lde", filename], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  });
  const fallback = detailed.status === 0
    ? detailed
    : spawnSync("/bin/ls", ["-ld", filename], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    });
  if (fallback.status !== 0) fail(`could not inspect ${label} ACL state`);
  const permissionToken = fallback.stdout.trimStart().split(/\s+/u)[0] ?? "";
  if (permissionToken.includes("+")) fail(`${label} must not have an ACL`);
}

function evidenceInventory(kind, includeManifest, includeComplete, allowIncomplete, names) {
  const expected = [
    ...expectedArtifacts(kind),
    ...(includeManifest ? ["SHA256SUMS"] : []),
    ...(includeComplete ? [completionMarker(kind)] : []),
  ];
  const incomplete = incompleteMarker(kind);
  if (allowIncomplete && names.includes(incomplete)) expected.push(incomplete);
  return expected.sort();
}

async function openEvidenceSession(
  directory,
  kind,
  {
    allowIncomplete = false,
    includeManifest = true,
    includeComplete = true,
    sealed = true,
  } = {},
) {
  if (!path.isAbsolute(directory)) fail("evidence directory must be absolute");
  const rootPathBefore = await lstat(directory, { bigint: true });
  if (!rootPathBefore.isDirectory() || rootPathBefore.isSymbolicLink()) {
    fail("evidence root must be a regular, non-symlink directory");
  }
  const root = await open(
    directory,
    constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_DIRECTORY ?? 0),
  );
  const handles = new Map();
  try {
    const rootState = await root.stat({ bigint: true });
    if (!rootState.isDirectory() || !sameInode(rootPathBefore, rootState)) {
      fail("evidence root changed while it was opened");
    }
    assertOwnerOnly(rootState, "evidence root", sealed ? 0o500 : null);
    if (!sealed && (modeBits(rootState) & 0o500) !== 0o500) {
      fail("evidence root must remain owner-readable and searchable");
    }
    assertNoAcl(directory, "evidence root");

    const names = (await readdir(directory)).sort();
    assert.deepEqual(
      names,
      evidenceInventory(kind, includeManifest, includeComplete, allowIncomplete, names),
      `${kind} artifact inventory does not match the v1 contract`,
    );
    for (const name of names) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)) {
        fail(`unsafe artifact name: ${name}`);
      }
      const filename = path.join(directory, name);
      const pathBefore = await lstat(filename, { bigint: true });
      const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      handles.set(name, { handle, path: filename, state: null });
      const state = await handle.stat({ bigint: true });
      if (
        !state.isFile()
        || state.isSymbolicLink()
        || !sameInode(pathBefore, state)
      ) fail(`${name} must be the exact opened regular file`);
      assertOwnerOnly(state, name, sealed ? 0o400 : null);
      if (!sealed && (modeBits(state) & 0o400) !== 0o400) {
        fail(`${name} must remain owner-readable`);
      }
      if (state.nlink !== 1n) fail(`${name} must have exactly one hard link`);
      assertNoAcl(filename, name);
      handles.get(name).state = state;
    }
    const session = {
      allowIncomplete,
      directory,
      handles,
      includeComplete,
      includeManifest,
      kind,
      names,
      root,
      rootState,
      sealed,
    };
    await assertEvidenceSessionUnchanged(session);
    return session;
  } catch (error) {
    await Promise.allSettled([...handles.values()].map(({ handle }) => handle.close()));
    await root.close().catch(() => {});
    throw error;
  }
}

async function assertEvidenceSessionUnchanged(session) {
  const currentRoot = await session.root.stat({ bigint: true });
  const currentRootPath = await lstat(session.directory, { bigint: true });
  if (
    !sameFileState(session.rootState, currentRoot)
    || !sameInode(currentRoot, currentRootPath)
  ) fail("evidence root changed during authenticated access");
  assertOwnerOnly(currentRoot, "evidence root", session.sealed ? 0o500 : null);
  assertNoAcl(session.directory, "evidence root");
  const currentNames = (await readdir(session.directory)).sort();
  assert.deepEqual(
    currentNames,
    session.names,
    `${session.kind} artifact inventory changed during authenticated access`,
  );
  for (const name of session.names) {
    const entry = session.handles.get(name);
    const current = await entry.handle.stat({ bigint: true });
    const currentPath = await lstat(entry.path, { bigint: true });
    if (!sameFileState(entry.state, current) || !sameInode(current, currentPath)) {
      fail(`${name} changed during authenticated access`);
    }
    assertOwnerOnly(current, name, session.sealed ? 0o400 : null);
    if (current.nlink !== 1n) fail(`${name} must have exactly one hard link`);
    assertNoAcl(entry.path, name);
  }
}

async function closeEvidenceSession(session) {
  await Promise.allSettled(
    [...session.handles.values()].map(({ handle }) => handle.close()),
  );
  await session.root.close().catch(() => {});
}

async function readEvidenceFile(session, name, encoding = null) {
  const entry = session.handles.get(name);
  if (!entry) fail(`missing authenticated evidence file ${name}`);
  const size = Number(entry.state.size);
  if (!Number.isSafeInteger(size)) fail(`${name} is too large to address safely`);
  const contents = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await entry.handle.read(contents, offset, size - offset, offset);
    if (bytesRead === 0) fail(`${name} changed while it was read`);
    offset += bytesRead;
  }
  return encoding ? contents.toString(encoding) : contents;
}

async function sha256EvidenceFile(session, name) {
  const entry = session.handles.get(name);
  if (!entry) fail(`missing authenticated evidence file ${name}`);
  const hash = createHash("sha256");
  const stream = entry.handle.createReadStream({ autoClose: false, start: 0 });
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function parseEvidenceJson(session, name) {
  try {
    return JSON.parse(await readEvidenceFile(session, name, "utf8"));
  } catch (error) {
    fail(`${name} is not valid JSON: ${error.message}`);
  }
}

async function verifyEvidenceManifest(session) {
  const lines = (await readEvidenceFile(session, "SHA256SUMS", "utf8"))
    .split("\n")
    .filter(Boolean);
  const expectedNames = expectedArtifacts(session.kind);
  if (lines.length !== expectedNames.length) {
    fail("SHA256SUMS entry count does not match the artifact contract");
  }
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/u.exec(lines[index]);
    if (!match || match[2] !== expectedNames[index]) {
      fail("SHA256SUMS is malformed or not canonically ordered");
    }
    if (await sha256EvidenceFile(session, match[2]) !== match[1]) {
      fail(`SHA-256 mismatch for ${match[2]}`);
    }
  }
  return sha256EvidenceFile(session, "SHA256SUMS");
}

async function evidenceIdentity(session) {
  const hash = createHash("sha256");
  hash.update(`${session.rootState.dev}:${session.rootState.ino}\n`);
  for (const name of session.names) {
    const state = session.handles.get(name).state;
    hash.update(`${name}\0${state.dev}:${state.ino}:${state.size}:`);
    hash.update(await sha256EvidenceFile(session, name));
    hash.update("\n");
  }
  await assertEvidenceSessionUnchanged(session);
  return hash.digest("hex");
}

async function evidenceContentIdentity(session) {
  const hash = createHash("sha256");
  for (const name of session.names) {
    hash.update(`${name}\0${await sha256EvidenceFile(session, name)}\n`);
  }
  await assertEvidenceSessionUnchanged(session);
  return hash.digest("hex");
}

async function assertArtifactInventory(
  directory,
  kind,
  includeManifest,
  allowIncomplete = false,
) {
  const allowedMarkers = kind === "capture"
    ? [
      "CAPTURE_COMPLETE.json",
      ...(allowIncomplete ? ["CAPTURE_INCOMPLETE"] : []),
    ]
    : [
      "RESTORE_COMPLETE.json",
      ...(allowIncomplete ? ["RESTORE_INCOMPLETE"] : []),
    ];
  const expected = [
    ...expectedArtifacts(kind),
    ...(includeManifest ? ["SHA256SUMS"] : []),
  ].sort();
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (allowedMarkers.includes(entry.name)) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        fail(`invalid evidence marker: ${entry.name}`);
      }
      continue;
    }
    if (!entry.isFile() || entry.isSymbolicLink()) {
      fail(`unexpected non-regular artifact: ${entry.name}`);
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name)) {
      fail(`unsafe artifact name: ${entry.name}`);
    }
    files.push(entry.name);
  }
  assert.deepEqual(
    files.sort(),
    expected,
    `${kind} artifact inventory does not match the v1 contract`,
  );
}

async function writeManifest(directory, kind) {
  await assertArtifactInventory(directory, kind, false, true);
  const lines = [];
  for (const name of expectedArtifacts(kind)) {
    lines.push(`${await sha256File(path.join(directory, name))}  ${name}`);
  }
  const temporary = path.join(directory, `.SHA256SUMS.${process.pid}.tmp`);
  await writeFile(temporary, `${lines.join("\n")}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, path.join(directory, "SHA256SUMS"));
}

async function verifyManifest(directory, kind, allowIncomplete = false) {
  await assertArtifactInventory(directory, kind, true, allowIncomplete);
  const manifestPath = path.join(directory, "SHA256SUMS");
  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    fail("SHA256SUMS must be a regular, non-symlink file");
  }
  const lines = (await readFile(manifestPath, "utf8"))
    .split("\n")
    .filter(Boolean);
  const expectedNames = expectedArtifacts(kind);
  if (lines.length !== expectedNames.length) {
    fail("SHA256SUMS entry count does not match the artifact contract");
  }
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(
      lines[index],
    );
    if (!match || match[2] !== expectedNames[index]) {
      fail("SHA256SUMS is malformed or not canonically ordered");
    }
    const actual = await sha256File(path.join(directory, match[2]));
    if (actual !== match[1]) {
      fail(`SHA-256 mismatch for ${match[2]}`);
    }
  }
  return sha256File(manifestPath);
}

async function sealEvidence(directory, kind) {
  const session = await openEvidenceSession(directory, kind, {
    sealed: false,
  });
  try {
    await verifyEvidenceManifest(session);
    for (const name of session.names) {
      const entry = session.handles.get(name);
      await entry.handle.chmod(0o400);
      const pathState = await lstat(entry.path, { bigint: true });
      const handleState = await entry.handle.stat({ bigint: true });
      if (!sameInode(pathState, handleState)) {
        fail(`${name} changed while evidence was sealed`);
      }
    }
    await session.root.chmod(0o500);
    const rootPath = await lstat(directory, { bigint: true });
    const rootHandle = await session.root.stat({ bigint: true });
    if (!sameInode(rootPath, rootHandle)) {
      fail("evidence root changed while it was sealed");
    }
  } finally {
    await closeEvidenceSession(session);
  }
  const sealed = await openEvidenceSession(directory, kind, { sealed: true });
  try {
    await verifyEvidenceManifest(sealed);
    return await evidenceContentIdentity(sealed);
  } finally {
    await closeEvidenceSession(sealed);
  }
}

async function unsealEvidence(directory, kind, expectedIdentity) {
  assertHash(expectedIdentity, "evidence identity");
  const session = await openEvidenceSession(directory, kind, { sealed: true });
  try {
    await verifyEvidenceManifest(session);
    if (await evidenceIdentity(session) !== expectedIdentity) {
      fail("refusing to unseal evidence with a changed identity");
    }
    for (const name of session.names) {
      const entry = session.handles.get(name);
      await entry.handle.chmod(0o600);
      const pathState = await lstat(entry.path, { bigint: true });
      const handleState = await entry.handle.stat({ bigint: true });
      if (!sameInode(pathState, handleState)) {
        fail(`${name} changed while pinned evidence was released`);
      }
    }
    await session.root.chmod(0o700);
    const rootPath = await lstat(directory, { bigint: true });
    const rootHandle = await session.root.stat({ bigint: true });
    if (!sameInode(rootPath, rootHandle)) {
      fail("evidence root changed while pinned evidence was released");
    }
  } finally {
    await closeEvidenceSession(session);
  }
}

async function copyHandle(source, destination, size, name) {
  const buffer = Buffer.alloc(Math.min(1024 * 1024, Math.max(1, Number(size))));
  let offset = 0;
  while (offset < Number(size)) {
    const length = Math.min(buffer.length, Number(size) - offset);
    const { bytesRead } = await source.read(buffer, 0, length, offset);
    if (bytesRead === 0) fail(`${name} changed while it was pinned`);
    let written = 0;
    while (written < bytesRead) {
      const result = await destination.write(
        buffer,
        written,
        bytesRead - written,
        offset + written,
      );
      if (result.bytesWritten === 0) fail(`could not pin ${name}`);
      written += result.bytesWritten;
    }
    offset += bytesRead;
  }
}

async function pinEvidence(sourceDirectory, destinationDirectory, kind) {
  const source = await openEvidenceSession(sourceDirectory, kind, { sealed: true });
  let destinationRoot;
  try {
    await verifyEvidenceManifest(source);
    const sourceContentIdentity = await evidenceContentIdentity(source);
    await mkdir(destinationDirectory, { mode: 0o700 });
    const rootPath = await lstat(destinationDirectory, { bigint: true });
    destinationRoot = await open(
      destinationDirectory,
      constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_DIRECTORY ?? 0),
    );
    const rootState = await destinationRoot.stat({ bigint: true });
    if (!rootState.isDirectory() || !sameInode(rootPath, rootState)) {
      fail("pinned evidence root changed while it was opened");
    }
    assertOwnerOnly(rootState, "pinned evidence root", 0o700);
    assertNoAcl(destinationDirectory, "pinned evidence root");
    assert.deepEqual(await readdir(destinationDirectory), [], "pinned evidence root must be empty");

    for (const name of source.names) {
      const sourceEntry = source.handles.get(name);
      const destinationPath = path.join(destinationDirectory, name);
      const destination = await open(
        destinationPath,
        constants.O_WRONLY
          | constants.O_CREAT
          | constants.O_EXCL
          | constants.O_NOFOLLOW,
        0o400,
      );
      try {
        await copyHandle(sourceEntry.handle, destination, sourceEntry.state.size, name);
        await destination.chmod(0o400);
        const destinationState = await destination.stat({ bigint: true });
        const destinationPathState = await lstat(destinationPath, { bigint: true });
        if (
          !destinationState.isFile()
          || !sameInode(destinationState, destinationPathState)
          || destinationState.nlink !== 1n
        ) fail(`${name} was not pinned as a single-link regular file`);
      } finally {
        await destination.close();
      }
    }
    await destinationRoot.chmod(0o500);
    await assertEvidenceSessionUnchanged(source);
    await destinationRoot.close();
    destinationRoot = null;

    const pinned = await openEvidenceSession(destinationDirectory, kind, { sealed: true });
    try {
      await verifyEvidenceManifest(pinned);
      const pinnedContentIdentity = await evidenceContentIdentity(pinned);
      if (pinnedContentIdentity !== sourceContentIdentity) {
        fail("pinned evidence bytes do not match the authenticated source");
      }
      return pinnedContentIdentity;
    } finally {
      await closeEvidenceSession(pinned);
    }
  } finally {
    if (destinationRoot) await destinationRoot.close().catch(() => {});
    await closeEvidenceSession(source);
  }
}

function validateCaptureMetadata(metadata, expected) {
  requireObject(metadata, "capture metadata");
  if (metadata.schemaVersion !== 1) fail("capture schemaVersion must be 1");
  for (const [field, value] of Object.entries(expected)) {
    if (metadata[field] !== value) {
      fail(`capture ${field} does not match`);
    }
  }
  if (metadata.supabaseCli.version !== "2.109.0") {
    fail("capture Supabase CLI version must be 2.109.0");
  }
  if (
    metadata.databaseClientContract
      !== "exact-supavisor-session-jit-pgpass-verify-full/v2"
    || !/^[a-z0-9-]+\.pooler\.supabase\.com$/u.test(metadata.databaseHost ?? "")
  ) fail("capture database client or host contract is invalid");
  assertHash(
    metadata.encryptedVolumeAttestationSha256,
    "capture encrypted-volume attestation SHA-256",
  );
  validateDockerContext(metadata.dockerContext, "capture Docker context");
  validateDockerSharedHomeRoot(
    metadata.dockerSharedHomeRoot,
    "capture Docker shared-home root",
  );
  requireObject(metadata.tls, "capture TLS identity");
  assert.deepEqual(
    Object.keys(metadata.tls).sort(),
    ["rootCertRelativePath", "rootCertSha256", "sslMode"],
    "capture TLS identity must contain exact keys",
  );
  assertHash(metadata.tls.rootCertSha256, "capture TLS root certificate SHA-256");
  if (metadata.tls.rootCertRelativePath !== "private/supabase-ca/prod-ca-2021.crt") {
    fail("capture TLS root certificate relative path is invalid");
  }
  if (metadata.tls.sslMode !== "verify-full") fail("capture TLS mode must be verify-full");
  if (!hashPattern.test(metadata.supabaseCli.sha256)) {
    fail("capture Supabase CLI SHA-256 is invalid");
  }
  if (!imageIdPattern.test(metadata.postgres.imageId)) {
    fail("capture PostgreSQL image ID is invalid");
  }
  requireOrderedTimes(
    metadata.writerQuiescedAt,
    metadata.captureStartedAt,
    metadata.capturedAt,
  );
  validateToolset(
    metadata.operatorTools,
    captureToolNames,
    metadata.captureToolsetSha256,
    "capture",
  );
  assertHash(
    metadata.approvedToolManifestSha256,
    "capture approved tool manifest SHA-256",
  );
}

function validateRestoreVerification(verification, expected) {
  requireObject(verification, "restore verification");
  if (
    verification.schemaVersion !== 1
    || verification.captureId !== expected.captureId
    || verification.restoreId !== expected.restoreId
    || verification.databaseName !== expected.databaseName
  ) {
    fail("restore verification identity does not match");
  }
  if (!Array.isArray(verification.checks) || verification.checks.length === 0) {
    fail("restore verification must contain at least one check");
  }
  const checkNames = new Set();
  const orderedCheckNames = [];
  for (const [index, check] of verification.checks.entries()) {
    requireObject(check, `checks[${index}]`);
    requireString(check.name, `checks[${index}].name`);
    if (check.status !== "pass") {
      fail(`restore verification check did not pass: ${check.name}`);
    }
    if (checkNames.has(check.name)) {
      fail("restore verification check names must be unique");
    }
    checkNames.add(check.name);
    orderedCheckNames.push(check.name);
  }
  assert.deepEqual(
    orderedCheckNames,
    requiredRestoreVerificationChecks,
    "restore verification must contain the exact ordered v1 checks",
  );
}

async function writeMarker(directory, kind, identity) {
  const session = await openEvidenceSession(directory, kind, {
    allowIncomplete: true,
    includeComplete: false,
    sealed: false,
  });
  try {
    const manifestSha256 = await verifyEvidenceManifest(session);
    const marker = kind === "capture"
      ? {
      schemaVersion: 1,
      artifactContract: "dominion-production-backup/v1",
      captureId: identity.captureId,
      writerQuiescedAt: identity.writerQuiescedAt,
      captureStartedAt: identity.captureStartedAt,
      capturedAt: identity.capturedAt,
      projectRef: identity.projectRef,
      gitCommit: identity.gitCommit,
      manifestSha256,
      captureToolsetSha256: identity.captureToolsetSha256,
      approvedToolManifestSha256: identity.approvedToolManifestSha256,
      dumpContractSha256: await sha256EvidenceFile(session, "dump-contract.json"),
      sourceManifestSha256: await sha256EvidenceFile(session, "source-manifest.jsonl"),
      sourceFingerprintSha256: await sha256EvidenceFile(session, "source-fingerprint.jsonl"),
      relationSequenceCountsSha256: await sha256EvidenceFile(
        session,
        "relation-sequence-counts.json",
      ),
      migrationHistorySha256: await sha256EvidenceFile(session, "migration-history.json"),
      managedApplicationDdlSha256: await sha256EvidenceFile(
        session,
        "managed-application-ddl.sql",
      ),
      }
      : {
      schemaVersion: 1,
      artifactContract: "dominion-production-restore/v1",
      captureId: identity.captureId,
      restoreId: identity.restoreId,
      backupManifestSha256: identity.backupManifestSha256,
      restoreToolsetSha256: identity.restoreToolsetSha256,
      approvedToolManifestSha256: identity.approvedToolManifestSha256,
      manifestSha256,
      };
    await assertEvidenceSessionUnchanged(session);
    const filename = completionMarker(kind);
    await writeFile(path.join(directory, filename), `${JSON.stringify(marker, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } finally {
    await closeEvidenceSession(session);
  }
}

function assertHash(value, label) {
  if (!hashPattern.test(value)) fail(`${label} must be a lowercase SHA-256`);
}

function assertImageId(value) {
  if (!imageIdPattern.test(value)) fail("image ID must be sha256 plus 64 lowercase hex characters");
}

const { command, options } = parseArguments(process.argv.slice(2));

switch (command) {
  case "validate-encrypted-volume-attestation": {
    requireExactOptions(options, ["creation-record", "destination", "file", "file-sha256"]);
    const filename = requireOption(options, "file");
    const expectedSha256 = requireOption(options, "file-sha256");
    const destination = requireOption(options, "destination");
    assertHash(expectedSha256, "encrypted-volume attestation SHA-256");
    if (!path.isAbsolute(destination)) {
      fail("encrypted-volume destination must be absolute");
    }
    const attestationSnapshot = await readAuthenticatedCanonicalJson(
      filename,
      "encrypted-volume attestation",
    );
    if (attestationSnapshot.sha256 !== expectedSha256) {
      fail("encrypted-volume attestation SHA-256 does not match");
    }
    const attestation = attestationSnapshot.value;
    const creationRecordFile = requireOption(options, "creation-record");
    const creationRecordSnapshot = await readAuthenticatedCanonicalJson(
      creationRecordFile,
      "encrypted-volume AES-256 creation record",
    );
    if (
      creationRecordSnapshot.sha256
      !== attestation.encryption?.creationRecordSha256
    ) fail("encrypted-volume AES-256 creation record SHA-256 does not match the attestation");
    validateEncryptedVolumeAttestation(
      attestation,
      destination,
      creationRecordSnapshot.value,
    );
    process.stdout.write(`${expectedSha256}\n`);
    break;
  }
  case "validate-timestamp": {
    requireExactOptions(options, ["value"]);
    requireRfc3339UtcSecond(requireOption(options, "value"), "timestamp");
    break;
  }
  case "validate-capture-time-order": {
    requireExactOptions(options, [
      "capture-started-at",
      "captured-at",
      "writer-quiesced-at",
    ]);
    requireOrderedTimes(
      requireOption(options, "writer-quiesced-at"),
      requireOption(options, "capture-started-at"),
      requireOption(options, "captured-at"),
    );
    break;
  }
  case "validate-inventories": {
    requireExactOptions(options, [
      "counts",
      "edge",
      "fingerprint",
      "history",
      "managed-ddl",
      "manifest",
      "project-ref",
      "storage",
    ]);
    const projectRef = requireOption(options, "project-ref");
    validateEdgeInventory(
      await parseJsonFile(requireOption(options, "edge")),
      projectRef,
    );
    validateStorageInventory(
      await parseJsonFile(requireOption(options, "storage")),
      projectRef,
    );
    await validateJsonLines(requireOption(options, "manifest"), "source manifest");
    await validateJsonLines(requireOption(options, "fingerprint"), "source fingerprint");
    validateRelationSequenceCounts(
      await parseJsonFile(requireOption(options, "counts")),
      projectRef,
    );
    validateMigrationHistory(
      await parseJsonFile(requireOption(options, "history")),
      projectRef,
    );
    await validateManagedApplicationDdl(requireOption(options, "managed-ddl"));
    break;
  }
  case "history-state": {
    requireExactOptions(options, ["file", "project-ref"]);
    process.stdout.write(`${validateMigrationHistory(
      await parseJsonFile(requireOption(options, "file")),
      requireOption(options, "project-ref"),
    )}\n`);
    break;
  }
  case "write-absent-history": {
    requireExactOptions(options, ["data-output", "inventory", "project-ref", "schema-output"]);
    const state = validateMigrationHistory(
      await parseJsonFile(requireOption(options, "inventory")),
      requireOption(options, "project-ref"),
    );
    if (state !== "absent") fail("cannot write absence artifacts for present history");
    await writeFile(requireOption(options, "schema-output"), absentHistorySchema, {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(requireOption(options, "data-output"), absentHistoryData, {
      flag: "wx",
      mode: 0o600,
    });
    break;
  }
  case "validate-history-artifacts": {
    requireExactOptions(options, ["data", "inventory", "project-ref", "schema"]);
    const state = validateMigrationHistory(
      await parseJsonFile(requireOption(options, "inventory")),
      requireOption(options, "project-ref"),
    );
    const schema = await readFile(requireOption(options, "schema"), "utf8");
    const data = await readFile(requireOption(options, "data"), "utf8");
    if (state === "absent") {
      if (schema !== absentHistorySchema || data !== absentHistoryData) {
        fail("absent migration history must use the deterministic absence artifacts");
      }
    } else if (
      !schema.includes("supabase_migrations")
      || !data.includes("supabase_migrations")
    ) {
      fail("present migration-history dumps must identify supabase_migrations");
    }
    process.stdout.write(`${state}\n`);
    break;
  }
  case "validate-data-dump": {
    requireExactOptions(options, ["file"]);
    await validateDataDump(requireOption(options, "file"));
    break;
  }
  case "write-dump-contract": {
    requireExactOptions(options, [
      "cli-sha256",
      "history-state",
      "input",
      "output",
      "postgres-image-id",
    ]);
    const cliSha256 = requireOption(options, "cli-sha256");
    const imageId = requireOption(options, "postgres-image-id");
    const historyState = requireOption(options, "history-state");
    assertHash(cliSha256, "Supabase CLI SHA-256");
    assertImageId(imageId);
    if (!["absent", "present"].includes(historyState)) fail("invalid history state");
    const lines = (await readFile(requireOption(options, "input"), "utf8"))
      .split("\n")
      .filter(Boolean);
    const scripts = lines.map((line) => {
      const match = /^([a-z-]+\.sql)\t([a-f0-9]{64})\t([a-f0-9]{64})$/u.exec(line);
      if (!match) fail("dump contract entry is malformed");
      return {
        name: match[1],
        supabaseDryRunSha256: match[2],
        executableScriptSha256: match[3],
      };
    });
    const contract = {
      schemaVersion: 1,
      supabaseCliSha256: cliSha256,
      postgresImageId: imageId,
      migrationHistoryState: historyState,
      scripts,
    };
    validateDumpContract(contract, historyState, cliSha256, imageId);
    await writeFile(
      requireOption(options, "output"),
      `${JSON.stringify(contract, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    break;
  }
  case "capture-timestamp": {
    requireExactOptions(options, ["directory"]);
    const metadata = await parseJsonFile(
      path.join(requireOption(options, "directory"), "capture.json"),
    );
    requireRfc3339UtcSecond(metadata.capturedAt, "capture capturedAt");
    process.stdout.write(`${metadata.capturedAt}\n`);
    break;
  }
  case "capture-database-host": {
    requireExactOptions(options, ["directory"]);
    const metadata = await parseJsonFile(
      path.join(requireOption(options, "directory"), "capture.json"),
    );
    validateCaptureMetadata(metadata, {
      captureId: metadata.captureId,
      projectRef: metadata.projectRef,
      gitBranch: metadata.gitBranch,
      gitCommit: metadata.gitCommit,
    });
    process.stdout.write(`${metadata.databaseHost}\n`);
    break;
  }
  case "capture-ssl-root-cert-sha256": {
    requireExactOptions(options, ["directory"]);
    const metadata = await parseJsonFile(
      path.join(requireOption(options, "directory"), "capture.json"),
    );
    validateCaptureMetadata(metadata, {
      captureId: metadata.captureId,
      projectRef: metadata.projectRef,
      gitBranch: metadata.gitBranch,
      gitCommit: metadata.gitCommit,
    });
    process.stdout.write(`${metadata.tls.rootCertSha256}\n`);
    break;
  }
  case "capture-ssl-root-cert-relative-path": {
    requireExactOptions(options, ["directory"]);
    const metadata = await parseJsonFile(
      path.join(requireOption(options, "directory"), "capture.json"),
    );
    validateCaptureMetadata(metadata, {
      captureId: metadata.captureId,
      projectRef: metadata.projectRef,
      gitBranch: metadata.gitBranch,
      gitCommit: metadata.gitCommit,
    });
    process.stdout.write(`${metadata.tls.rootCertRelativePath}\n`);
    break;
  }
  case "capture-encrypted-volume-attestation-sha256": {
    requireExactOptions(options, ["directory"]);
    const metadata = await parseJsonFile(
      path.join(requireOption(options, "directory"), "capture.json"),
    );
    validateCaptureMetadata(metadata, {
      captureId: metadata.captureId,
      projectRef: metadata.projectRef,
      gitBranch: metadata.gitBranch,
      gitCommit: metadata.gitCommit,
    });
    process.stdout.write(`${metadata.encryptedVolumeAttestationSha256}\n`);
    break;
  }
  case "capture-start-timestamp": {
    requireExactOptions(options, ["directory"]);
    const metadata = await parseJsonFile(
      path.join(requireOption(options, "directory"), "capture.json"),
    );
    requireRfc3339UtcSecond(metadata.captureStartedAt, "capture captureStartedAt");
    process.stdout.write(`${metadata.captureStartedAt}\n`);
    break;
  }
  case "capture-quiesced-timestamp": {
    requireExactOptions(options, ["directory"]);
    const metadata = await parseJsonFile(
      path.join(requireOption(options, "directory"), "capture.json"),
    );
    requireRfc3339UtcSecond(metadata.writerQuiescedAt, "capture writerQuiescedAt");
    process.stdout.write(`${metadata.writerQuiescedAt}\n`);
    break;
  }
  case "capture-toolset-sha256": {
    requireExactOptions(options, captureToolOptions.map(([name]) => name));
    const tools = toolsetFromOptions(options, captureToolOptions);
    for (const name of captureToolNames) assertHash(tools[name], name);
    process.stdout.write(`${sha256Object(tools)}\n`);
    break;
  }
  case "restore-toolset-sha256": {
    requireExactOptions(options, restoreToolOptions.map(([name]) => name));
    const tools = toolsetFromOptions(options, restoreToolOptions);
    for (const name of restoreToolNames) assertHash(tools[name], name);
    process.stdout.write(`${sha256Object(tools)}\n`);
    break;
  }
  case "approved-tool-hash": {
    requireExactOptions(options, [
      "file",
      "file-sha256",
      "name",
      "release-commit",
      "toolset",
    ]);
    const filename = requireOption(options, "file");
    const expectedFileSha256 = requireOption(options, "file-sha256");
    assertHash(expectedFileSha256, "approved tool manifest SHA-256");
    const approvedManifestSnapshot = await readAuthenticatedCanonicalJson(
      filename,
      "approved tool manifest",
    );
    const actualFileSha256 = approvedManifestSnapshot.sha256;
    if (actualFileSha256 !== expectedFileSha256) {
      fail("approved tool manifest SHA-256 does not match");
    }
    const manifest = validateApprovedToolManifest(
      approvedManifestSnapshot.value,
      requireOption(options, "release-commit"),
    );
    const toolset = requireOption(options, "toolset");
    if (!["capture", "restore"].includes(toolset)) {
      fail("--toolset must be exactly capture or restore");
    }
    const name = requireOption(options, "name");
    const tools = toolset === "capture" ? manifest.captureTools : manifest.restoreTools;
    if (!Object.hasOwn(tools, name)) {
      fail(`approved ${toolset} tool inventory does not contain ${name}`);
    }
    process.stdout.write(`${tools[name]}\n`);
    break;
  }
  case "verify-approved-tool-manifest": {
    const expectedOptions = [
      "capture-toolset-sha256",
      ...dockerContextOptions.map(([name]) => name),
      "docker-shared-home-root",
      "file",
      "file-sha256",
      "release-commit",
    ];
    if (Object.hasOwn(options, "restore-toolset-sha256")) {
      expectedOptions.push("restore-toolset-sha256");
    }
    requireExactOptions(options, expectedOptions);
    const filename = requireOption(options, "file");
    const expectedFileSha256 = requireOption(options, "file-sha256");
    assertHash(expectedFileSha256, "approved tool manifest SHA-256");
    const approvedManifestSnapshot = await readAuthenticatedCanonicalJson(
      filename,
      "approved tool manifest",
    );
    const actualFileSha256 = approvedManifestSnapshot.sha256;
    if (actualFileSha256 !== expectedFileSha256) {
      fail("approved tool manifest SHA-256 does not match");
    }
    const manifest = validateApprovedToolManifest(
      approvedManifestSnapshot.value,
      requireOption(options, "release-commit"),
    );
    assert.deepEqual(
      manifest.dockerContext,
      dockerContextFromOptions(options),
      "actual Docker context is not the independently approved context",
    );
    if (
      manifest.dockerSharedHomeRoot
      !== validateDockerSharedHomeRoot(
        requireOption(options, "docker-shared-home-root"),
        "actual Docker shared-home root",
      )
    ) fail("actual Docker shared-home root is not independently approved");
    if (
      manifest.captureToolsetSha256
      !== requireOption(options, "capture-toolset-sha256")
    ) {
      fail("actual capture toolset is not the independently approved toolset");
    }
    if (
      Object.hasOwn(options, "restore-toolset-sha256")
      && manifest.restoreToolsetSha256
        !== requireOption(options, "restore-toolset-sha256")
    ) {
      fail("actual restore toolset is not the independently approved toolset");
    }
    process.stdout.write(`${actualFileSha256}\n`);
    break;
  }
  case "write-capture-metadata": {
    requireExactOptions(options, [
      "approved-tool-manifest-sha256",
      "capture-id",
      "capture-started-at",
      "capture-toolset-sha256",
      "captured-at",
      "cli-sha256",
      "database-host",
      ...dockerContextOptions.map(([name]) => name),
      "docker-shared-home-root",
      "encrypted-volume-attestation-sha256",
      ...captureToolOptions
        .map(([name]) => name)
        .filter((name) => name !== "supabase-cli-sha256"),
      "git-branch",
      "git-commit",
      "output",
      "postgres-image",
      "postgres-image-id",
      "project-ref",
      "ssl-root-cert-sha256",
      "ssl-root-cert-relative-path",
      "writer-quiesced-at",
    ]);
    const captureId = requireOption(options, "capture-id");
    const projectRef = requireOption(options, "project-ref");
    const gitCommit = requireOption(options, "git-commit");
    const cliSha256 = requireOption(options, "cli-sha256");
    const postgresImageId = requireOption(options, "postgres-image-id");
    if (!safeIdPattern.test(captureId)) fail("invalid capture ID");
    if (!projectRefPattern.test(projectRef)) fail("invalid project ref");
    if (!commitPattern.test(gitCommit)) fail("invalid git commit");
    assertHash(cliSha256, "CLI SHA-256");
    assertImageId(postgresImageId);
    const operatorTools = toolsetFromOptions({
      ...options,
      "supabase-cli-sha256": cliSha256,
    }, captureToolOptions);
    const captureToolsetSha256 = requireOption(options, "capture-toolset-sha256");
    validateToolset(
      operatorTools,
      captureToolNames,
      captureToolsetSha256,
      "capture",
    );
    const metadata = {
      schemaVersion: 1,
      artifactContract: "dominion-production-backup/v1",
      captureId,
      writerQuiescedAt: requireOption(options, "writer-quiesced-at"),
      captureStartedAt: requireOption(options, "capture-started-at"),
      capturedAt: requireOption(options, "captured-at"),
      projectRef,
      databaseClientContract: "exact-supavisor-session-jit-pgpass-verify-full/v2",
      databaseHost: requireOption(options, "database-host"),
      dockerContext: validateDockerContext(
        dockerContextFromOptions(options),
        "capture Docker context",
      ),
      dockerSharedHomeRoot: validateDockerSharedHomeRoot(
        requireOption(options, "docker-shared-home-root"),
        "capture Docker shared-home root",
      ),
      encryptedVolumeAttestationSha256: requireOption(
        options,
        "encrypted-volume-attestation-sha256",
      ),
      gitBranch: requireOption(options, "git-branch"),
      gitCommit,
      supabaseCli: { version: "2.109.0", sha256: cliSha256 },
      operatorTools,
      captureToolsetSha256,
      approvedToolManifestSha256: requireOption(
        options,
        "approved-tool-manifest-sha256",
      ),
      tls: {
        rootCertSha256: requireOption(options, "ssl-root-cert-sha256"),
        rootCertRelativePath: requireOption(options, "ssl-root-cert-relative-path"),
        sslMode: "verify-full",
      },
      postgres: {
        image: requireOption(options, "postgres-image"),
        imageId: postgresImageId,
        serverVersionNum: 170006,
      },
    };
    requireOrderedTimes(
      metadata.writerQuiescedAt,
      metadata.captureStartedAt,
      metadata.capturedAt,
    );
    await writeFile(
      requireOption(options, "output"),
      `${JSON.stringify(metadata, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    break;
  }
  case "write-manifest": {
    requireExactOptions(options, ["directory", "kind"]);
    await writeManifest(
      requireOption(options, "directory"),
      requireOption(options, "kind"),
    );
    break;
  }
  case "seal-evidence": {
    requireExactOptions(options, ["directory", "kind"]);
    const contentSha256 = await sealEvidence(
      requireOption(options, "directory"),
      requireOption(options, "kind"),
    );
    process.stdout.write(`${contentSha256}\n`);
    break;
  }
  case "evidence-identity": {
    requireExactOptions(options, ["directory", "kind"]);
    const session = await openEvidenceSession(
      requireOption(options, "directory"),
      requireOption(options, "kind"),
      { sealed: true },
    );
    try {
      await verifyEvidenceManifest(session);
      process.stdout.write(`${await evidenceIdentity(session)}\n`);
    } finally {
      await closeEvidenceSession(session);
    }
    break;
  }
  case "capture-summary": {
    requireExactOptions(options, ["directory", "project-ref"]);
    const projectRef = requireOption(options, "project-ref");
    const session = await openEvidenceSession(
      requireOption(options, "directory"),
      "capture",
      { sealed: true },
    );
    try {
      const manifestSha256 = await verifyEvidenceManifest(session);
      const metadata = await parseEvidenceJson(session, "capture.json");
      const marker = await parseEvidenceJson(session, "CAPTURE_COMPLETE.json");
      const migrationHistoryState = validateMigrationHistory(
        await parseEvidenceJson(session, "migration-history.json"),
        projectRef,
      );
      if (marker.manifestSha256 !== manifestSha256) {
        fail("capture marker does not bind the authenticated manifest");
      }
      const summary = [
        ["BACKUP_MANIFEST_SHA256", manifestSha256],
        ["SOURCE_MANIFEST_SHA256", await sha256EvidenceFile(session, "source-manifest.jsonl")],
        ["SOURCE_FINGERPRINT_SHA256", await sha256EvidenceFile(session, "source-fingerprint.jsonl")],
        ["RELATION_SEQUENCE_COUNTS_SHA256", await sha256EvidenceFile(session, "relation-sequence-counts.json")],
        ["MIGRATION_HISTORY_SHA256", await sha256EvidenceFile(session, "migration-history.json")],
        ["MANAGED_APPLICATION_DDL_SHA256", await sha256EvidenceFile(session, "managed-application-ddl.sql")],
        ["MIGRATION_HISTORY_STATE", migrationHistoryState],
        ["WRITER_QUIESCED_AT", metadata.writerQuiescedAt],
        ["CAPTURE_STARTED_AT", metadata.captureStartedAt],
        ["CAPTURED_AT", metadata.capturedAt],
        ["DATABASE_HOST", metadata.databaseHost],
        ["SSL_ROOT_CERT_SHA256", metadata.tls.rootCertSha256],
        ["SSL_ROOT_CERT_RELATIVE_PATH", metadata.tls.rootCertRelativePath],
        ["ENCRYPTED_VOLUME_ATTESTATION_SHA256", metadata.encryptedVolumeAttestationSha256],
      ];
      for (const [name, value] of summary) {
        if (typeof value !== "string" || value.length === 0 || /[\r\n]/u.test(value)) {
          fail(`${name} is not safe summary output`);
        }
      }
      await assertEvidenceSessionUnchanged(session);
      process.stdout.write(`${summary.map(([name, value]) => `${name}=${value}`).join("\n")}\n`);
    } finally {
      await closeEvidenceSession(session);
    }
    break;
  }
  case "pin-evidence": {
    requireExactOptions(options, ["destination", "kind", "source"]);
    const contentSha256 = await pinEvidence(
      requireOption(options, "source"),
      requireOption(options, "destination"),
      requireOption(options, "kind"),
    );
    process.stdout.write(`${contentSha256}\n`);
    break;
  }
  case "unseal-evidence": {
    requireExactOptions(options, ["directory", "expected-identity", "kind"]);
    await unsealEvidence(
      requireOption(options, "directory"),
      requireOption(options, "kind"),
      requireOption(options, "expected-identity"),
    );
    break;
  }
  case "write-capture-marker": {
    requireExactOptions(options, [
      "approved-tool-manifest-sha256",
      "capture-id",
      "capture-started-at",
      "capture-toolset-sha256",
      "captured-at",
      "directory",
      "git-commit",
      "project-ref",
      "writer-quiesced-at",
    ]);
    await writeMarker(requireOption(options, "directory"), "capture", {
      captureId: requireOption(options, "capture-id"),
      writerQuiescedAt: requireOption(options, "writer-quiesced-at"),
      captureStartedAt: requireOption(options, "capture-started-at"),
      captureToolsetSha256: requireOption(options, "capture-toolset-sha256"),
      approvedToolManifestSha256: requireOption(
        options,
        "approved-tool-manifest-sha256",
      ),
      capturedAt: requireOption(options, "captured-at"),
      gitCommit: requireOption(options, "git-commit"),
      projectRef: requireOption(options, "project-ref"),
    });
    break;
  }
  case "verify-capture": {
    const expectedOptions = [
      "approved-tool-manifest-sha256",
      "capture-id",
      "capture-toolset-sha256",
      "cli-sha256",
      "directory",
      "docker-shared-home-root",
      "git-branch",
      "git-commit",
      "postgres-image",
      "postgres-image-id",
      "project-ref",
    ];
    const allowIncomplete = Object.hasOwn(options, "allow-incomplete-marker");
    if (allowIncomplete) expectedOptions.push("allow-incomplete-marker");
    requireExactOptions(options, expectedOptions);
    if (allowIncomplete && options["allow-incomplete-marker"] !== "true") {
      fail("--allow-incomplete-marker must be exactly true");
    }
    const directory = requireOption(options, "directory");
    const session = await openEvidenceSession(directory, "capture", {
      allowIncomplete,
      sealed: !allowIncomplete,
    });
    try {
    const expected = {
      captureId: requireOption(options, "capture-id"),
      projectRef: requireOption(options, "project-ref"),
      gitBranch: requireOption(options, "git-branch"),
      gitCommit: requireOption(options, "git-commit"),
    };
    const metadata = await parseEvidenceJson(session, "capture.json");
    validateCaptureMetadata(metadata, expected);
    if (metadata.supabaseCli.sha256 !== requireOption(options, "cli-sha256")) {
      fail("capture Supabase CLI SHA-256 does not match");
    }
    if (
      metadata.captureToolsetSha256
      !== requireOption(options, "capture-toolset-sha256")
    ) {
      fail("capture toolset SHA-256 does not match");
    }
    const approvedToolManifestSha256 = requireOption(
      options,
      "approved-tool-manifest-sha256",
    );
    if (metadata.approvedToolManifestSha256 !== approvedToolManifestSha256) {
      fail("capture approved tool manifest SHA-256 does not match");
    }
    if (
      await sha256EvidenceFile(session, "approved-tool-manifest.json")
      !== approvedToolManifestSha256
    ) {
      fail("captured approved tool manifest SHA-256 does not match");
    }
    const approvedManifest = validateApprovedToolManifest(
      await parseEvidenceJson(session, "approved-tool-manifest.json"),
      expected.gitCommit,
    );
    assert.deepEqual(
      metadata.dockerContext,
      approvedManifest.dockerContext,
      "capture Docker context is not the independently approved context",
    );
    if (
      metadata.dockerSharedHomeRoot
        !== requireOption(options, "docker-shared-home-root")
      || metadata.dockerSharedHomeRoot !== approvedManifest.dockerSharedHomeRoot
    ) fail("capture Docker shared-home root is not independently approved");
    if (approvedManifest.captureToolsetSha256 !== metadata.captureToolsetSha256) {
      fail("capture toolset is not the independently approved toolset");
    }
    if (metadata.postgres.image !== requireOption(options, "postgres-image")) {
      fail("capture PostgreSQL image does not match");
    }
    if (metadata.postgres.imageId !== requireOption(options, "postgres-image-id")) {
      fail("capture PostgreSQL image ID does not match");
    }
    validateEdgeInventory(
      await parseEvidenceJson(session, "edge-functions.json"),
      expected.projectRef,
    );
    validateStorageInventory(
      await parseEvidenceJson(session, "storage-metadata.json"),
      expected.projectRef,
    );
    validateJsonLinesContents(
      await readEvidenceFile(session, "source-manifest.jsonl", "utf8"),
      "source manifest",
    );
    validateJsonLinesContents(
      await readEvidenceFile(session, "source-fingerprint.jsonl", "utf8"),
      "source fingerprint",
    );
    validateRelationSequenceCounts(
      await parseEvidenceJson(session, "relation-sequence-counts.json"),
      expected.projectRef,
    );
    const verifiedHistoryState = validateMigrationHistory(
      await parseEvidenceJson(session, "migration-history.json"),
      expected.projectRef,
    );
    validateDumpContract(
      await parseEvidenceJson(session, "dump-contract.json"),
      verifiedHistoryState,
      metadata.supabaseCli.sha256,
      metadata.postgres.imageId,
    );
    validateManagedApplicationDdlContents(
      await readEvidenceFile(session, "managed-application-ddl.sql", "utf8"),
    );
    await (async () => {
      const state = validateMigrationHistory(
        await parseEvidenceJson(session, "migration-history.json"),
        expected.projectRef,
      );
      const historySchema = await readEvidenceFile(session, "history-schema.sql", "utf8");
      const historyData = await readEvidenceFile(session, "history-data.sql", "utf8");
      if (state === "absent") {
        if (historySchema !== absentHistorySchema || historyData !== absentHistoryData) {
          fail("verified absent history artifacts are not deterministic");
        }
      } else if (
        !historySchema.includes("supabase_migrations")
        || !historyData.includes("supabase_migrations")
      ) {
        fail("verified present history artifacts do not identify supabase_migrations");
      }
    })();
    await validateDataDumpEvidence(session);
    const manifestSha256 = await verifyEvidenceManifest(session);
    const marker = await parseEvidenceJson(session, "CAPTURE_COMPLETE.json");
    requireObject(marker, "capture marker");
    if (
      marker.schemaVersion !== 1
      || marker.artifactContract !== "dominion-production-backup/v1"
      || marker.captureId !== expected.captureId
      || marker.writerQuiescedAt !== metadata.writerQuiescedAt
      || marker.captureStartedAt !== metadata.captureStartedAt
      || marker.capturedAt !== metadata.capturedAt
      || marker.projectRef !== expected.projectRef
      || marker.gitCommit !== expected.gitCommit
      || marker.manifestSha256 !== manifestSha256
      || marker.captureToolsetSha256 !== metadata.captureToolsetSha256
      || marker.approvedToolManifestSha256 !== approvedToolManifestSha256
      || marker.dumpContractSha256 !== await sha256EvidenceFile(session, "dump-contract.json")
      || marker.sourceManifestSha256 !== await sha256EvidenceFile(session, "source-manifest.jsonl")
      || marker.sourceFingerprintSha256 !== await sha256EvidenceFile(session, "source-fingerprint.jsonl")
      || marker.relationSequenceCountsSha256 !== await sha256EvidenceFile(
        session,
        "relation-sequence-counts.json",
      )
      || marker.migrationHistorySha256 !== await sha256EvidenceFile(
        session,
        "migration-history.json",
      )
      || marker.managedApplicationDdlSha256 !== await sha256EvidenceFile(
        session,
        "managed-application-ddl.sql",
      )
    ) {
      fail("CAPTURE_COMPLETE.json does not match the verified capture");
    }
    await assertEvidenceSessionUnchanged(session);
    process.stdout.write(`${manifestSha256}\n`);
    } finally {
      await closeEvidenceSession(session);
    }
    break;
  }
  case "validate-restore-verification": {
    requireExactOptions(options, [
      "capture-id",
      "database-name",
      "file",
      "restore-id",
    ]);
    const verification = await parseJsonFile(requireOption(options, "file"));
    validateRestoreVerification(verification, {
      captureId: requireOption(options, "capture-id"),
      restoreId: requireOption(options, "restore-id"),
      databaseName: requireOption(options, "database-name"),
    });
    break;
  }
  case "write-restore-metadata": {
    requireExactOptions(options, [
      "approved-tool-manifest-sha256",
      "backup-manifest-sha256",
      "capture-id",
      "completed-at",
      "database-name",
      ...dockerContextOptions.map(([name]) => name),
      "docker-shared-home-root",
      ...restoreToolOptions.map(([name]) => name),
      "output",
      "postgres-image",
      "postgres-image-id",
      "project-ref",
      "restore-id",
      "restore-toolset-sha256",
    ]);
    const backupManifestSha256 = requireOption(options, "backup-manifest-sha256");
    assertHash(backupManifestSha256, "backup manifest SHA-256");
    const imageId = requireOption(options, "postgres-image-id");
    assertImageId(imageId);
    const operatorTools = toolsetFromOptions(options, restoreToolOptions);
    const restoreToolsetSha256 = requireOption(options, "restore-toolset-sha256");
    validateToolset(
      operatorTools,
      restoreToolNames,
      restoreToolsetSha256,
      "restore",
    );
    const metadata = {
      schemaVersion: 1,
      artifactContract: "dominion-production-restore/v1",
      captureId: requireOption(options, "capture-id"),
      restoreId: requireOption(options, "restore-id"),
      completedAt: requireOption(options, "completed-at"),
      projectRef: requireOption(options, "project-ref"),
      backupManifestSha256,
      dockerContext: validateDockerContext(
        dockerContextFromOptions(options),
        "restore Docker context",
      ),
      dockerSharedHomeRoot: validateDockerSharedHomeRoot(
        requireOption(options, "docker-shared-home-root"),
        "restore Docker shared-home root",
      ),
      operatorTools,
      restoreToolsetSha256,
      approvedToolManifestSha256: requireOption(
        options,
        "approved-tool-manifest-sha256",
      ),
      postgres: {
        image: requireOption(options, "postgres-image"),
        imageId,
        serverVersionNum: 170006,
      },
      databaseName: requireOption(options, "database-name"),
      cleanupOwnershipVerified: true,
      containerRemoved: true,
    };
    requireRfc3339UtcSecond(metadata.completedAt, "restore completedAt");
    await writeFile(
      requireOption(options, "output"),
      `${JSON.stringify(metadata, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    break;
  }
  case "write-restore-marker": {
    requireExactOptions(options, [
      "approved-tool-manifest-sha256",
      "backup-manifest-sha256",
      "capture-id",
      "directory",
      "restore-id",
      "restore-toolset-sha256",
    ]);
    await writeMarker(requireOption(options, "directory"), "restore", {
      backupManifestSha256: requireOption(options, "backup-manifest-sha256"),
      captureId: requireOption(options, "capture-id"),
      restoreId: requireOption(options, "restore-id"),
      restoreToolsetSha256: requireOption(options, "restore-toolset-sha256"),
      approvedToolManifestSha256: requireOption(
        options,
        "approved-tool-manifest-sha256",
      ),
    });
    break;
  }
  case "verify-restore": {
    const expectedOptions = [
      "approved-tool-manifest-sha256",
      "backup-manifest-sha256",
      "capture-id",
      "database-name",
      "directory",
      ...dockerContextOptions.map(([name]) => name),
      "docker-shared-home-root",
      "postgres-image",
      "postgres-image-id",
      "project-ref",
      "restore-id",
      "restore-toolset-sha256",
    ];
    const allowIncomplete = Object.hasOwn(options, "allow-incomplete-marker");
    if (allowIncomplete) expectedOptions.push("allow-incomplete-marker");
    requireExactOptions(options, expectedOptions);
    if (allowIncomplete && options["allow-incomplete-marker"] !== "true") {
      fail("--allow-incomplete-marker must be exactly true");
    }
    const directory = requireOption(options, "directory");
    const session = await openEvidenceSession(directory, "restore", {
      allowIncomplete,
      sealed: !allowIncomplete,
    });
    try {
    const manifestSha256 = await verifyEvidenceManifest(session);
    const metadata = await parseEvidenceJson(session, "restore.json");
    const expectedPairs = {
      captureId: requireOption(options, "capture-id"),
      restoreId: requireOption(options, "restore-id"),
      projectRef: requireOption(options, "project-ref"),
      backupManifestSha256: requireOption(options, "backup-manifest-sha256"),
      databaseName: requireOption(options, "database-name"),
    };
    for (const [field, value] of Object.entries(expectedPairs)) {
      if (metadata[field] !== value) fail(`restore ${field} does not match`);
    }
    if (
      metadata.schemaVersion !== 1
      || metadata.artifactContract !== "dominion-production-restore/v1"
      || metadata.postgres.image !== requireOption(options, "postgres-image")
      || metadata.postgres.imageId !== requireOption(options, "postgres-image-id")
      || metadata.postgres.serverVersionNum !== 170006
      || metadata.cleanupOwnershipVerified !== true
      || metadata.containerRemoved !== true
      || JSON.stringify(metadata.dockerContext)
        !== JSON.stringify(dockerContextFromOptions(options))
      || metadata.dockerSharedHomeRoot
        !== validateDockerSharedHomeRoot(
          requireOption(options, "docker-shared-home-root"),
          "restore Docker shared-home root",
        )
    ) {
      fail("restore metadata does not satisfy the v1 contract");
    }
    const approvedToolManifestSha256 = requireOption(
      options,
      "approved-tool-manifest-sha256",
    );
    if (metadata.approvedToolManifestSha256 !== approvedToolManifestSha256) {
      fail("restore approved tool manifest SHA-256 does not match");
    }
    validateToolset(
      metadata.operatorTools,
      restoreToolNames,
      metadata.restoreToolsetSha256,
      "restore",
    );
    if (
      metadata.restoreToolsetSha256
      !== requireOption(options, "restore-toolset-sha256")
    ) {
      fail("restore toolset SHA-256 does not match");
    }
    requireRfc3339UtcSecond(metadata.completedAt, "restore completedAt");
    validateRestoreVerification(
      await parseEvidenceJson(session, "restore-verification.json"),
      {
        captureId: expectedPairs.captureId,
        restoreId: expectedPairs.restoreId,
        databaseName: expectedPairs.databaseName,
      },
    );
    const marker = await parseEvidenceJson(session, "RESTORE_COMPLETE.json");
    if (
      marker.schemaVersion !== 1
      || marker.artifactContract !== "dominion-production-restore/v1"
      || marker.captureId !== expectedPairs.captureId
      || marker.restoreId !== expectedPairs.restoreId
      || marker.backupManifestSha256 !== expectedPairs.backupManifestSha256
      || marker.restoreToolsetSha256 !== metadata.restoreToolsetSha256
      || marker.approvedToolManifestSha256 !== approvedToolManifestSha256
      || marker.manifestSha256 !== manifestSha256
    ) {
      fail("RESTORE_COMPLETE.json does not match the verified restore evidence");
    }
    await assertEvidenceSessionUnchanged(session);
    process.stdout.write(`${manifestSha256}\n`);
    } finally {
      await closeEvidenceSession(session);
    }
    break;
  }
  default:
    fail("unknown production backup artifact command");
}
