import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { POST_ORIGINAL77_APPLICATION_ENVELOPE_RECOVERY, POST_ORIGINAL77_BACKUP_MODE,
  POST_ORIGINAL77_VAULT_RECOVERY, selectPostOriginal77MigrationVersions,
} from './production-backup-public-contract.mjs';
import { selectPostOriginal77BackupArtifact, verifyPostOriginal77BackupManifest,
  verifyPostOriginal77BackupRun } from './verify-post-original77-backup-evidence.mjs';

const { publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 4096,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const secondPublicKey = generateKeyPairSync('rsa', {
  modulusLength: 4096,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
}).publicKey;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const encrypted = Buffer.from('synthetic encrypted exact70 archive bytes');
const runId = '36788015554';
const releaseCommit = 'a'.repeat(40);
const nowMs = Date.parse('2026-09-30T20:00:00.000Z');
const versions = selectPostOriginal77MigrationVersions(await readdir(new URL('../supabase/migrations/', import.meta.url)));

function manifest() {
  return {
    schemaVersion: 3,
    artifactContract: 'dominion-free-post-early-access-backup/v1',
    projectRef: 'mimolwojppbtsbvtqwpo',
    releaseCommit,
    runId,
    runAttempt: 2,
    createdAt: '2026-09-30T19:55:00.000Z',
    postgresImage: 'public.ecr.aws/supabase/postgres:17.6.1.141',
    postgresImageId: `sha256:${'b'.repeat(64)}`,
    publicKeySha256: sha256(createPublicKey(publicKey).export({ type: 'spki', format: 'der' })),
    encryptedSha256: sha256(encrypted),
    encryptedBytes: encrypted.length,
    encryption: {
      algorithm: 'AES-256-GCM',
      keyWrap: 'RSA-OAEP-SHA256',
      wrappedKey: Buffer.alloc(512, 7).toString('base64'),
      iv: Buffer.alloc(12, 8).toString('base64'),
      tag: Buffer.alloc(16, 9).toString('base64'),
    },
    restoreVerified: true,
    storageObjects: 0,
    migrationVersions: [...versions],
    backupMode: POST_ORIGINAL77_BACKUP_MODE,
    vaultRecovery: structuredClone(POST_ORIGINAL77_VAULT_RECOVERY),
    pgNetSupplement: {
      contract: 'dominion-pg-net-binary-supplement/v1', extensionVersion: '0.20.3', format: 'postgresql-binary-copy',
      files: [
        { file: 'pg-net-http-response.copy', bytes: 21, sha256: 'c'.repeat(64) },
        { file: 'pg-net-http-request-queue.copy', bytes: 22, sha256: 'd'.repeat(64) },
      ],
      sequence: { schema: 'net', name: 'http_request_queue_id_seq', lastValue: '71', isCalled: true },
      replayRequiresIsolatedWorkerDisabledRuntime: true,
    },
    applicationEnvelopeRecovery: structuredClone(POST_ORIGINAL77_APPLICATION_ENVELOPE_RECOVERY),
  };
}

const verify = (value = manifest(), bytes = encrypted, overrides = {}) => verifyPostOriginal77BackupManifest(value, bytes, {
  runId, releaseCommit, runAttempt: 2, publicKey, expectedVersions: versions, nowMs, ...overrides,
});

function backupRun(overrides = {}) {
  return { id: Number(runId), head_sha: releaseCommit, head_branch: 'main', event: 'workflow_dispatch',
    path: '.github/workflows/production-backup.yml', status: 'completed', conclusion: 'success', run_attempt: 2,
    created_at: '2026-09-30T19:50:00.000Z', repository: { full_name: 'tjames222/77-dominion-challenge' },
    head_repository: { full_name: 'tjames222/77-dominion-challenge' }, ...overrides };
}

function artifact(overrides = {}) {
  return { id: 11130209950, name: `production-backup-${releaseCommit}-${runId}`, expired: false,
    size_in_bytes: 1_000_000, created_at: '2026-09-30T19:56:00.000Z', expires_at: '2026-10-07T19:56:00.000Z',
    ...overrides };
}

test('selects one fresh successful protected-main exact-commit backup artifact', () => {
  assert.equal(verifyPostOriginal77BackupRun(backupRun(), { runId, releaseCommit, nowMs }).run_attempt, 2);
  assert.equal(selectPostOriginal77BackupArtifact({ total_count: 1, artifacts: [artifact()] },
    { runId, releaseCommit, nowMs }).id, 11130209950);
  for (const changed of [
    backupRun({ head_sha: 'b'.repeat(40) }), backupRun({ head_branch: 'develop' }),
    backupRun({ conclusion: 'failure' }), backupRun({ path: '.github/workflows/deploy.yml' }),
    backupRun({ created_at: '2026-09-29T19:00:00.000Z' }),
  ]) assert.throws(() => verifyPostOriginal77BackupRun(changed, { runId, releaseCommit, nowMs }));
  for (const changed of [
    { total_count: 0, artifacts: [] },
    { total_count: 2, artifacts: [artifact(), artifact({ id: 2 })] },
    { total_count: 1, artifacts: [artifact({ name: 'wrong' })] },
    { total_count: 1, artifacts: [artifact({ expired: true })] },
    { total_count: 1, artifacts: [artifact({ size_in_bytes: 50 * 1024 * 1024 })] },
  ]) assert.throws(() => selectPostOriginal77BackupArtifact(changed, { runId, releaseCommit, nowMs }));
});

test('exact70 evidence accepts only the encrypted restored original77 checkpoint', () => {
  assert.deepEqual(verify(), { verified: true, backupMode: POST_ORIGINAL77_BACKUP_MODE });
  assert.equal(versions.length, 70); assert.equal(versions.at(-1), '20260930161218');
});

test('exact70 evidence rejects checkpoint, identity, encryption and external-recovery drift', () => {
  const mutations = [
    value => { value.backupMode = 'post-admin-inbox-67'; },
    value => { value.schemaVersion = 2; },
    value => { value.runAttempt = 3; },
    value => { value.artifactContract = 'dominion-free-production-backup/v1'; },
    value => { value.migrationVersions.pop(); },
    value => { value.migrationVersions.push('99999999999999'); },
    value => { value.restoreVerified = false; },
    value => { value.storageObjects = 1; },
    value => { value.applicationEnvelopeRecovery.decryptionVerified = true; },
    value => { value.applicationEnvelopeRecovery.requiredExternalSettings.pop(); },
    value => { value.vaultRecovery.secretNames.pop(); },
    value => { value.encryption.tag = Buffer.alloc(15).toString('base64'); },
    value => { value.unreviewed = true; },
    value => { value.createdAt = '2026-09-29T19:00:00.000Z'; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(manifest()); mutate(changed); assert.throws(() => verify(changed));
  }
  assert.throws(() => verify(manifest(), Buffer.from('different')));
  assert.throws(() => verify(manifest(), encrypted, { publicKey: secondPublicKey }));
  assert.throws(() => verify(manifest(), encrypted, { expectedVersions: versions.slice(0, 69) }));
});

test('exact70 evidence validates every pg_net member and sequence boundary', () => {
  const mutations = [
    value => { value.pgNetSupplement.files.reverse(); },
    value => { value.pgNetSupplement.files[0].bytes = 20; },
    value => { value.pgNetSupplement.files[0].sha256 = 'not-a-hash'; },
    value => { value.pgNetSupplement.sequence.lastValue = '0'; },
    value => { value.pgNetSupplement.sequence.lastValue = '9223372036854775808'; },
    value => { value.pgNetSupplement.sequence.isCalled = 'true'; },
    value => { value.pgNetSupplement.unreviewed = true; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(manifest()); mutate(changed); assert.throws(() => verify(changed));
  }
});

test('exact70 verifier cannot decrypt, restore, spawn, or read a private recovery key', async () => {
  const source = (await Promise.all([
    readFile(new URL('./verify-post-original77-backup-evidence.mjs', import.meta.url), 'utf8'),
    readFile(new URL('./production-backup-public-contract.mjs', import.meta.url), 'utf8'),
  ])).join('\n');
  assert.doesNotMatch(source, /privateDecrypt|decryptBackup|private[-_ ]?key|child_process|spawn|execFile|pg_restore|SUPABASE_ACCESS_TOKEN/iu);
  assert.match(source, /decryptionVerified: false/u);
  assert.match(source, /expected --select or --directory <path>/u);
});
