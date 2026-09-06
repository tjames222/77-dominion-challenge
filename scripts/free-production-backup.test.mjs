import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyBackupFailure, classifyDockerFailure, decryptBackup, encryptBackup, localRestoreRoles, parseInventory, recipientKey } from './free-production-backup.mjs';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 4096,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

test('RSA-wrapped AES-GCM backup roundtrip preserves bytes and refuses overwriting', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'free-backup-test-'));
  try {
    const input = path.join(directory, 'input');
    const encrypted = path.join(directory, 'backup.enc');
    const output = path.join(directory, 'restored');
    const payload = Buffer.from('protected Auth rows\0and SQL\n');
    await writeFile(input, payload);
    const manifest = await encryptBackup(input, encrypted, publicKey);
    assert.equal(manifest.publicKeySha256, recipientKey(privateKey).fingerprint);
    assert(!(await readFile(encrypted)).includes(payload));
    await decryptBackup(encrypted, output, manifest, privateKey);
    assert.deepEqual(await readFile(output), payload);
    await assert.rejects(decryptBackup(encrypted, output, manifest, privateKey), /EEXIST/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('tampered ciphertext and GCM tag never publish plaintext', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'free-backup-test-'));
  try {
    const input = path.join(directory, 'input');
    const encrypted = path.join(directory, 'backup.enc');
    const output = path.join(directory, 'restored');
    await writeFile(input, 'sensitive fixture');
    const manifest = await encryptBackup(input, encrypted, publicKey);
    const tamperedManifest = structuredClone(manifest);
    tamperedManifest.encryption.tag = Buffer.alloc(16).toString('base64');
    await assert.rejects(decryptBackup(encrypted, output, tamperedManifest, privateKey));
    await assert.rejects(readFile(output), /ENOENT/);
    const bytes = await readFile(encrypted); bytes[0] ^= 1; await writeFile(encrypted, bytes);
    await assert.rejects(decryptBackup(encrypted, output, manifest, privateKey));
    await assert.rejects(readFile(output), /ENOENT/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('backup recipient requires RSA-4096', () => {
  const weak = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' });
  assert.throws(() => recipientKey(weak), /RSA-4096/);
});

test('diagnostics emit only fixed codes, never private response or Docker text', () => {
  const secret = 'sensitive-secret-fixture';
  assert.equal(classifyBackupFailure(new Error(secret)), 'unclassified');
  assert.equal(classifyBackupFailure(Object.assign(new Error(secret), { diagnosticCode: secret })), 'unclassified');
  assert.equal(classifyBackupFailure(Object.assign(new Error(secret), { diagnosticCode: 'login-ttl-below-900' })), 'login-ttl-below-900');
  assert.equal(classifyBackupFailure(Object.assign(new Error(secret), { diagnosticCode: 'pooler-scram' })), 'pooler-scram');
  assert.equal(classifyBackupFailure(new Error('Existing-project CLI state is invalid: the exact project pooler lookup returned HTTP 403')), 'credential-pooler-http-403');
  assert.equal(classifyBackupFailure(new Error('Existing-project CLI state is invalid: the exact project lookup request failed')), 'credential-project-network');
  assert.equal(classifyBackupFailure(new Error('Existing-project CLI state is invalid: the Management API project identity, region, health, or PostgreSQL contract does not match')), 'credential-project-contract');
  assert.equal(classifyDockerFailure(`invalid mount config: bind source path does not exist: ${secret}`), 'docker-mount-invalid');
  assert.equal(classifyDockerFailure(`permission denied while trying to connect to the docker API: ${secret}`), 'docker-daemon-permission');
  assert.equal(classifyDockerFailure(secret), 'docker-command-failed');
});

test('isolated role replay adapts only membership grantor identity', () => {
  const original = 'CREATE ROLE source_admin;\nALTER ROLE source_admin WITH SUPERUSER;\nGRANT pgsodium_keyholder TO service_role WITH INHERIT TRUE, SET TRUE GRANTED BY "source_admin";\n';
  assert.equal(localRestoreRoles(original, 'source_admin'), original.replace(' GRANTED BY "source_admin";', ' GRANTED BY backup_restore_admin;'));
  assert.match(localRestoreRoles(original, 'source_admin'), /WITH INHERIT TRUE, SET TRUE GRANTED BY backup_restore_admin;/);
  assert.equal(localRestoreRoles(original, 'different_admin'), original);
});

const fixture = () => [
  { kind: 'boundary', serverVersion: '170006', encoding: 'UTF8', bootstrapRole: 'postgres', foreignTables: 0, reservedRoleExists: false },
  ...[['public', 'profiles'], ['auth', 'users'], ['storage', 'objects'], ['storage', 's3_multipart_uploads'], ['storage', 's3_multipart_uploads_parts'], ['supabase_migrations', 'schema_migrations'], ['vault', 'secrets'], ['pgsodium', 'key']].map(([schema, name]) => ({ kind: 'table', schema, name, count: 0, sha256: 'a'.repeat(64) })),
  { kind: 'history', versions: ['1', '2'] },
];
const serialized = (records) => records.map((r) => JSON.stringify(r)).join('\n');

test('inventory requires complete core schemas and exact migration history', () => {
  assert.equal(parseInventory(serialized(fixture()), ['1', '2']).length, fixture().length);
  assert.throws(() => parseInventory(serialized(fixture()), ['1']), /checkpoint/);
  assert.throws(() => parseInventory(serialized(fixture().filter((r) => r.schema !== 'auth')), ['1', '2']), /auth/);
});

test('nonzero external or encrypted data and foreign tables fail closed', () => {
  for (const [schema, name] of [['storage', 'objects'], ['storage', 's3_multipart_uploads'], ['storage', 's3_multipart_uploads_parts'], ['vault', 'secrets'], ['pgsodium', 'key']]) {
    const records = fixture(); records.find((r) => r.schema === schema && r.name === name).count = 1;
    assert.throws(() => parseInventory(serialized(records), ['1', '2']));
  }
  const records = fixture(); records[0].foreignTables = 1;
  assert.throws(() => parseInventory(serialized(records), ['1', '2']), /Foreign data/);
});

test('workflow limits plaintext lifetime and publishes only completed encrypted output', async () => {
  const workflow = await readFile(new URL('../.github/workflows/production-backup.yml', import.meta.url), 'utf8');
  const source = await readFile(new URL('./free-production-backup.mjs', import.meta.url), 'utf8');
  const startup = await readFile(new URL('./free-backup-local-postgres.sh', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request:|push:|schedule:/);
  assert.match(workflow, /group: production-release/);
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /retention-days: 7/);
  assert.equal((workflow.match(/\/usr\/bin\/env -i/g) ?? []).length, 2);
  assert.doesNotMatch(workflow, /NODE_OPTIONS=|NODE_DEBUG=|HTTPS_PROXY=/);
  assert.match(source, /mkdtemp\('\/dev\/shm\/dominion-backup-'/);
  assert.match(source, /PGOPTIONS=-c default_transaction_read_only=on -c role=postgres/);
  assert.match(source, /'--network', 'none'/);
  assert.match(source, /'--roles-only', '--no-role-passwords'/);
  assert.match(source, /'--single-transaction', '--exit-on-error'/);
  assert.match(source, /stage\('credential-files'\)/);
  assert.match(source, /stage\('capture-container'\)/);
  assert.match(startup, /cron.launch_active_jobs=off/);
  assert.doesNotMatch(source, /supabase.*(?:db reset|migration (?:up|repair))|console\.log\((?:beforeText|token|databaseUrl)/);
});

test('all remote capture commands share the credential deadline and stop the owned container on failure', async () => {
  const source = await readFile(new URL('./free-production-backup.mjs', import.meta.url), 'utf8');
  const remote = source.slice(source.indexOf('const remote = async'), source.indexOf('const inventorySql ='));
  assert.equal((remote.match(/remainingCredentialMilliseconds\(credentialLifetime, PROJECT_REF\)/gu) ?? []).length, 2);
  assert.match(remote, /deadlineNs: credentialLifetime\.deadlineNs/u);
  assert.match(remote, /catch \(error\) \{[\s\S]*await removeContainer\(captureName\);[\s\S]*throw error;/u);
  assert.match(source, /'1800'\], \{ log, deadlineNs: credentialLifetime\.deadlineNs \}\)/u);
  const cleanup = source.slice(source.indexOf('let cleanupFailed = false;'));
  assert(cleanup.indexOf('await removeContainer(name)') < cleanup.indexOf('await revokeProductionSupabaseDatabaseCredentials'));
  for (const diagnosticCode of ['credential-lifetime-expired', 'credential-operation-timeout', 'credential-operation-interrupted']) {
    assert.equal(classifyBackupFailure({ diagnosticCode, message: 'private fixture data' }), diagnosticCode);
  }
});
