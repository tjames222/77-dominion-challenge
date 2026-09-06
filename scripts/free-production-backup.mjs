#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, createPublicKey, constants, publicEncrypt, privateDecrypt, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { prepareProductionSupabaseDatabaseCredentials, revokeProductionSupabaseDatabaseCredentials } from './prepare-existing-supabase-cli-state.mjs';

export const PROJECT_REF = 'mimolwojppbtsbvtqwpo';
export const POSTGRES_IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.141';
export const MAX_ENCRYPTED_BYTES = 49 * 1024 * 1024;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (message) => { throw new Error(message); };

export function recipientKey(pem) {
  const key = createPublicKey(pem);
  assert.equal(key.asymmetricKeyType, 'rsa', 'Backup recipient must use RSA');
  assert.equal(key.asymmetricKeyDetails.modulusLength, 4096, 'Backup recipient must use RSA-4096');
  const canonical = key.export({ type: 'spki', format: 'der' });
  return { key, fingerprint: sha256(canonical) };
}

export async function encryptBackup(input, output, publicPem) {
  const { key: publicKey, fingerprint } = recipientKey(publicPem);
  const key = randomBytes(32);
  const iv = randomBytes(12);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    await pipeline(createReadStream(input), cipher, createWriteStream(output, { flags: 'wx', mode: 0o600 }));
    const bytes = await readFile(output);
    assert(bytes.length <= MAX_ENCRYPTED_BYTES, 'Encrypted backup exceeds the free artifact size cap');
    return {
      publicKeySha256: fingerprint,
      encryptedSha256: sha256(bytes), encryptedBytes: bytes.length,
      encryption: {
        algorithm: 'AES-256-GCM', keyWrap: 'RSA-OAEP-SHA256',
        wrappedKey: publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key).toString('base64'),
        iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
      },
    };
  } finally { key.fill(0); }
}

// Recovery is intentionally file-only. It has no database endpoint or restore
// command, so opening an artifact can never write to a hosted project.
export async function decryptBackup(input, output, manifest, privatePem) {
  const ciphertext = await readFile(input);
  assert.equal(sha256(ciphertext), manifest.encryptedSha256);
  assert.equal(ciphertext.length, manifest.encryptedBytes);
  assert.equal(recipientKey(privatePem).fingerprint, manifest.publicKeySha256);
  assert.equal(manifest.encryption.algorithm, 'AES-256-GCM');
  assert.equal(manifest.encryption.keyWrap, 'RSA-OAEP-SHA256');
  const key = privateDecrypt({ key: privatePem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(manifest.encryption.wrappedKey, 'base64'));
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(manifest.encryption.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(manifest.encryption.tag, 'base64'));
    // Authenticate before publishing any plaintext.
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    try { await writeFile(output, plaintext, { flag: 'wx', mode: 0o600 }); }
    finally { plaintext.fill(0); }
  } finally { key.fill(0); }
}

export function parseInventory(text, expectedVersions) {
  const records = text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const tables = records.filter((r) => r.kind === 'table');
  const boundaries = records.filter((r) => r.kind === 'boundary');
  assert.equal(boundaries.length, 1);
  assert.equal(boundaries[0].serverVersion, '170006');
  assert.equal(boundaries[0].encoding, 'UTF8');
  assert.equal(typeof boundaries[0].bootstrapRole, 'string');
  assert(boundaries[0].bootstrapRole.length > 0 && !/[\r\n\0]/u.test(boundaries[0].bootstrapRole));
  assert.equal(boundaries[0].foreignTables, 0, 'Foreign data needs a separate backup');
  assert.equal(boundaries[0].reservedRoleExists, false, 'Reserved local restore role already exists remotely');
  for (const schema of ['public', 'auth', 'storage', 'supabase_migrations']) {
    assert(tables.some((r) => r.schema === schema), `Missing ${schema} inventory`);
  }
  for (const name of ['objects', 's3_multipart_uploads', 's3_multipart_uploads_parts']) {
    const table = tables.find((r) => r.schema === 'storage' && r.name === name);
    assert(table && table.count === 0, 'Storage blobs/multipart uploads require a separate backup');
  }
  for (const [schema, name] of [['vault', 'secrets'], ['pgsodium', 'key']]) {
    const table = tables.find((r) => r.schema === schema && r.name === name);
    if (table) assert.equal(table.count, 0, 'Encrypted Vault/pgsodium data requires the original root key');
  }
  const histories = records.filter((r) => r.kind === 'history');
  assert.equal(histories.length, 1);
  assert.deepEqual(histories[0].versions, expectedVersions, 'Backup is only approved for the exact 1–13 checkpoint');
  for (const record of tables) {
    assert(Number.isSafeInteger(record.count) && record.count >= 0);
    assert.match(record.sha256, /^[a-f0-9]{64}$/u);
  }
  return records;
}

export function localRestoreRoles(original, sourceBootstrapRole) {
  // PostgreSQL 17 binds membership grantors to its bootstrap superuser. This
  // isolated cluster deliberately has a different bootstrap identity. Replay
  // identical memberships/options as that local admin; keep the original SQL
  // unchanged in the encrypted recovery archive.
  assert.equal(typeof sourceBootstrapRole, 'string');
  assert(!/[\r\n\0]/u.test(sourceBootstrapRole));
  const suffixes = [` GRANTED BY "${sourceBootstrapRole.replaceAll('"', '""')}";`];
  if (/^[a-z_][a-z0-9_$]*$/u.test(sourceBootstrapRole)) suffixes.push(` GRANTED BY ${sourceBootstrapRole};`);
  return original.split('\n').map((line) => {
    const suffix = suffixes.find((candidate) => line.startsWith('GRANT ') && line.endsWith(candidate));
    return suffix ? line.slice(0, -suffix.length) + ' GRANTED BY backup_restore_admin;' : line;
  }).join('\n');
}

const comparableInventory = (text) => JSON.stringify(text.trim().split('\n').map((line) => {
  const record = JSON.parse(line);
  if (record.kind === 'boundary') {
    delete record.reservedRoleExists;
    delete record.bootstrapRole;
  }
  return record;
}));

function cleanEnvironment() {
  return { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8' };
}

const safeDiagnosticCodes = new Set([
  'login-response-shape', 'login-role-format', 'login-password-format',
  'login-ttl-format', 'login-ttl-below-300', 'login-ttl-below-900',
  'login-ttl-below-3600', 'login-ttl-above-7200',
  'pooler-response-shape', 'pooler-primary-none', 'pooler-primary-multiple', 'pooler-identifier',
  'pooler-db-user', 'pooler-db-user-unqualified', 'pooler-db-name', 'pooler-scram',
  'pooler-alias-mismatch', 'pooler-alias-snake-only', 'pooler-alias-camel-only',
  'pooler-default-pool-size', 'pooler-max-client-count', 'pooler-port-mode',
  'pooler-url-format', 'pooler-url-protocol', 'pooler-url-user',
  'pooler-url-endpoint', 'pooler-metadata-url-mismatch', 'pooler-normalized-boundary',
  'docker-daemon-permission', 'docker-daemon-unavailable', 'docker-mount-invalid',
  'docker-runtime-permission', 'docker-container-exists', 'docker-resource-limit',
  'docker-command-failed', 'executable-unavailable',
]);

export function classifyDockerFailure(stderr, spawnErrorCode) {
  if (spawnErrorCode === 'ENOENT') return 'executable-unavailable';
  if (/permission denied while trying to connect to the docker|permission denied.*docker.sock/iu.test(stderr)) return 'docker-daemon-permission';
  if (/cannot connect to the docker daemon|is the docker daemon running/iu.test(stderr)) return 'docker-daemon-unavailable';
  if (/invalid mount config|bind source path does not exist|error mounting/iu.test(stderr)) return 'docker-mount-invalid';
  if (/permission denied|operation not permitted/iu.test(stderr)) return 'docker-runtime-permission';
  if (/container name.*already in use/iu.test(stderr)) return 'docker-container-exists';
  if (/no space left on device|cannot allocate memory|out of memory/iu.test(stderr)) return 'docker-resource-limit';
  return 'docker-command-failed';
}

export function classifyBackupFailure(error) {
  if (safeDiagnosticCodes.has(error?.diagnosticCode)) return error.diagnosticCode;
  const message = typeof error?.message === 'string' ? error.message : '';
  const prefix = 'Existing-project CLI state is invalid: ';
  if (message.startsWith(prefix)) {
    const detail = message.slice(prefix.length);
    for (const [label, code] of [
      ['the exact project lookup', 'project'],
      ['the exact project pooler lookup', 'pooler'],
      ['the temporary database login request', 'login'],
    ]) {
      const status = detail.match(new RegExp(`^${label} returned HTTP ([1-5][0-9]{2})$`, 'u'));
      if (status) return `credential-${code}-http-${status[1]}`;
      if (detail === `${label} request failed` || detail === `${label} failed`) return `credential-${code}-network`;
      if (detail === `${label} returned a redirect`) return `credential-${code}-redirect`;
      if (detail === `${label} did not return JSON`) return `credential-${code}-json`;
    }
    if (detail === 'the Management API project identity, region, health, or PostgreSQL contract does not match') return 'credential-project-contract';
    if (/^(the primary pooler|the pooler response|the pooler Management API|the normalized pooler)/u.test(detail)) return 'credential-pooler-contract';
    if (detail === 'the temporary database login did not become ready') return 'credential-login-readiness';
    if (/credential.directory|credential directory/u.test(detail)) return 'credential-directory-contract';
    if (/supabase-home|isolated Supabase home/u.test(detail)) return 'credential-home-contract';
    if (/probe-workdir/u.test(detail)) return 'credential-probe-directory-contract';
    if (detail === 'SUPABASE_ACCESS_TOKEN is missing or malformed') return 'credential-token-contract';
    return 'credential-helper-contract';
  }
  if (['EACCES', 'EPERM'].includes(error?.code)) return 'filesystem-permission';
  if (error?.code === 'ENOENT') return 'filesystem-path-missing';
  if (error?.code === 'ENOSPC') return 'filesystem-space';
  if (error?.code === 'ERR_ASSERTION') return 'boundary-assertion';
  return 'unclassified';
}

async function command(executable, args, { output, log, env = cleanEnvironment(), input } = {}) {
  const child = spawn(executable, args, { env, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  const errors = createWriteStream(log, { flags: 'a', mode: 0o600 });
  let privateStderr = '';
  child.stderr.on('data', (chunk) => {
    if (privateStderr.length < 32_768) privateStderr += chunk.toString().slice(0, 32_768 - privateStderr.length);
  });
  child.stderr.pipe(errors, { end: false });
  let captured = '';
  let piping;
  if (output) piping = pipeline(child.stdout, createWriteStream(output, { flags: 'wx', mode: 0o600 }));
  else child.stdout.on('data', (chunk) => { captured += chunk; if (captured.length > 1024 * 1024) child.kill(); });
  if (input) {
    child.stdin.on('error', () => {});
    createReadStream(input).pipe(child.stdin);
  }
  let spawnErrorCode;
  const status = await new Promise((resolve) => {
    child.once('error', (error) => { spawnErrorCode = error.code; resolve(-1); }); child.once('close', resolve);
  });
  await piping;
  await new Promise((resolve) => errors.end(resolve));
  if (status !== 0) {
    const error = new Error('Backup subprocess failed; private diagnostics are suppressed');
    if (executable === 'docker') error.diagnosticCode = classifyDockerFailure(privateStderr, spawnErrorCode);
    else if (spawnErrorCode === 'ENOENT') error.diagnosticCode = 'executable-unavailable';
    throw error;
  }
  return captured.trim();
}

export async function runBackup() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
  assert.equal(process.env.SUPABASE_PROJECT_REF, PROJECT_REF);
  const releaseCommit = process.env.GITHUB_SHA;
  assert.match(releaseCommit, /^[a-f0-9]{40}$/u);
  assert.match(process.env.GITHUB_RUN_ID, /^[1-9][0-9]*$/u);
  assert.match(process.env.GITHUB_RUN_ATTEMPT, /^[1-9][0-9]*$/u);
  const publicPem = process.env.PRODUCTION_BACKUP_PUBLIC_KEY;
  recipientKey(publicPem);
  const repository = process.cwd();
  const expectedVersions = (await readdir(path.join(repository, 'supabase/migrations'))).filter((f) => f.endsWith('.sql')).sort().slice(0, 13).map((f) => f.split('_')[0]);
  const runtime = await mkdtemp('/dev/shm/dominion-backup-');
  await chmod(runtime, 0o700);
  const log = path.join(runtime, 'private.log');
  const capture = path.join(runtime, 'capture');
  const credentials = path.join(runtime, 'credentials');
  const supabaseHome = path.join(runtime, 'home');
  const probeWorkdir = path.join(runtime, 'probe');
  for (const directory of [capture, credentials, supabaseHome, probeWorkdir]) await mkdir(directory, { mode: 0o700 });
  const artifactDirectory = path.join(process.env.RUNNER_TEMP, `production-backup-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`);
  await mkdir(artifactDirectory, { mode: 0o700 });
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const containers = [];
  const ownershipToken = randomBytes(16).toString('hex');
  async function removeContainer(name) {
    const found = await command('docker', ['ps', '--all', '--quiet', '--filter', `name=^/${name}$`], { log });
    if (found === '') return;
    const actualOwner = await command('docker', ['inspect', name, '--format', '{{index .Config.Labels "com.dominion.backup-owner"}}'], { log });
    assert.equal(actualOwner, ownershipToken, 'Refused cleanup of an unowned container');
    await command('docker', ['rm', '--force', name], { log });
    const remaining = await command('docker', ['ps', '--all', '--quiet', '--filter', `name=^/${name}$`], { log });
    assert.equal(remaining, '', 'Owned container remains after cleanup');
  }
  let minted = false;
  let success = false;
  let phase = 'release-validation';
  const stage = (name) => { phase = name; console.log(`Backup stage: ${name}`); };
  try {
    const head = await command('git', ['rev-parse', 'HEAD'], { log });
    assert.equal(head, releaseCommit);
    const status = await command('git', ['status', '--porcelain', '--untracked-files=no'], { log });
    assert.equal(status, '');
    await command('docker', ['pull', POSTGRES_IMAGE], { log });
    const imageId = await command('docker', ['image', 'inspect', POSTGRES_IMAGE, '--format', '{{.Id}}'], { log });
    assert.match(imageId, /^sha256:[a-f0-9]{64}$/u);
    stage('temporary-credentials');
    minted = true;
    await prepareProductionSupabaseDatabaseCredentials({
      accessToken: token, credentialDirectory: credentials, projectRef: PROJECT_REF,
      supabaseHome, probeWorkdir,
    });
    stage('credential-files');
    const databaseUrl = new URL((await readFile(path.join(credentials, 'database-url'), 'utf8')).trim());
    assert.equal(databaseUrl.password, '');
    const passfile = path.join(credentials, 'database-passfile');
    assert.equal((await lstat(passfile)).mode & 0o777, 0o600);
    const owner = `${process.getuid()}:${process.getgid()}`;
    const captureName = `dominion-backup-capture-${randomBytes(12).toString('hex')}`;
    containers.push(captureName);
    stage('capture-container');
    await command('docker', ['run', '--detach', '--name', captureName, '--label', `com.dominion.backup-owner=${ownershipToken}`, '--pull', 'never', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--log-driver', 'none', '--user', owner, '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=64m', '--mount', `type=bind,source=${runtime},target=${runtime},readonly`, '--entrypoint', 'sleep', imageId, '1800'], { log });
    const remoteEnv = [
      '-e', `PGHOST=${databaseUrl.hostname}`, '-e', 'PGPORT=5432',
      '-e', `PGUSER=${decodeURIComponent(databaseUrl.username)}`, '-e', 'PGDATABASE=postgres',
      '-e', `PGPASSFILE=${passfile}`, '-e', 'PGSSLMODE=require', '-e', 'PGCONNECT_TIMEOUT=10',
      '-e', 'PGOPTIONS=-c default_transaction_read_only=on -c role=postgres',
    ];
    const remote = (args, output) => command('docker', ['exec', ...remoteEnv, captureName, ...args], { log, output });
    const inventorySql = path.join(runtime, 'inventory.sql');
    await writeFile(inventorySql, await readFile(path.join(repository, 'scripts/free-backup-inventory.sql')), { flag: 'wx', mode: 0o600 });
    const before = path.join(capture, 'inventory.jsonl');
    stage('inventory-before');
    await remote(['psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', inventorySql], before);
    const beforeText = await readFile(before, 'utf8');
    const inventory = parseInventory(beforeText, expectedVersions);
    const sourceBootstrapRole = inventory.find((r) => r.kind === 'boundary').bootstrapRole;
    console.log('Production checkpoint verified; capturing a read-only logical backup.');
    stage('roles-capture');
    await remote(['pg_dumpall', '--roles-only', '--no-role-passwords'], path.join(capture, 'roles.sql'));
    stage('database-dump');
    await remote(['pg_dump', '--format=custom', '--compress=0', '--lock-wait-timeout=15000'], path.join(capture, 'database.dump'));
    const after = path.join(runtime, 'after.jsonl');
    stage('inventory-after');
    await remote(['psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', inventorySql], after);
    assert.equal(await readFile(after, 'utf8'), beforeText, 'Source database changed during backup');
    await revokeProductionSupabaseDatabaseCredentials({ accessToken: token, projectRef: PROJECT_REF });
    minted = false;
    await removeContainer(captureName);
    containers.splice(containers.indexOf(captureName), 1);
    // The restore receives only backup bytes and reviewed local startup code.
    // It has no network, credential mount, or access to the hosted endpoint.
    const restoreName = `dominion-backup-restore-${randomBytes(12).toString('hex')}`;
    containers.push(restoreName);
    stage('local-init');
    await command('docker', ['run', '--detach', '--name', restoreName, '--label', `com.dominion.backup-owner=${ownershipToken}`, '--pull', 'never', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--log-driver', 'none', '--user', '100:101', '--tmpfs', '/restore:rw,exec,nosuid,nodev,uid=100,gid=101,mode=0700,size=512m', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,uid=100,gid=101,mode=0700,size=64m', '--mount', `type=bind,source=${path.join(repository, 'scripts/free-backup-local-postgres.sh')},target=/startup.sh,readonly`, '--entrypoint', 'bash', imageId, '/startup.sh'], { log });
    const local = (args, options = {}) => command('docker', ['exec', ...(options.input ? ['-i'] : []), restoreName, ...args], { log, ...options });
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { await local(['pg_isready', '-h', '/restore', '-U', 'backup_restore_admin', '-d', 'postgres']); ready = true; break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 1000)); }
    }
    assert(ready, 'Isolated PostgreSQL did not start');
    const psql = ['psql', '-X', '-q', '-h', '/restore', '-U', 'backup_restore_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'];
    assert.equal(await local([...psql, '-At', '-c', 'show server_version_num']), '170006');
    stage('roles-restore');
    const localRoles = path.join(runtime, 'local-roles.sql');
    await writeFile(localRoles, localRestoreRoles(await readFile(path.join(capture, 'roles.sql'), 'utf8'), sourceBootstrapRole), { flag: 'wx', mode: 0o600 });
    await local([...psql, '--single-transaction'], { input: localRoles });
    stage('archive-restore');
    await local(['pg_restore', '--host=/restore', '--username=backup_restore_admin', '--dbname=postgres', '--single-transaction', '--exit-on-error'], { input: path.join(capture, 'database.dump') });
    const restored = path.join(runtime, 'restored.jsonl');
    stage('content-verify');
    await local(psql, { input: inventorySql, output: restored });
    const restoredText = await readFile(restored, 'utf8');
    assert.equal(comparableInventory(restoredText), comparableInventory(beforeText), 'Restored contents, sequences, or migration history differ');
    await removeContainer(restoreName);
    containers.splice(containers.indexOf(restoreName), 1);
    console.log('Isolated restore reproduced all captured table contents, sequences, and migration history.');
    const tarball = path.join(runtime, 'backup.tar');
    await command('tar', ['-cf', tarball, '-C', capture, 'roles.sql', 'database.dump', 'inventory.jsonl'], { log });
    stage('encryption');
    const encrypted = await encryptBackup(tarball, path.join(artifactDirectory, 'backup.enc'), publicPem);
    const manifest = {
      schemaVersion: 1, artifactContract: 'dominion-free-production-backup/v1',
      projectRef: PROJECT_REF, releaseCommit, runId: process.env.GITHUB_RUN_ID,
      runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT), createdAt: new Date().toISOString(),
      postgresImage: POSTGRES_IMAGE, postgresImageId: imageId, ...encrypted,
      restoreVerified: true, storageObjects: 0, migrationVersions: expectedVersions,
    };
    await writeFile(path.join(artifactDirectory, 'backup-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, `artifact_directory=${artifactDirectory}\n`, { flag: 'a' });
    success = true;
  } catch (error) {
    fail(`Backup failed at stage ${phase} (${classifyBackupFailure(error)}); no private diagnostic text is emitted`);
  } finally {
    let cleanupFailed = false;
    if (minted) {
      try { await revokeProductionSupabaseDatabaseCredentials({ accessToken: token, projectRef: PROJECT_REF }); }
      catch { cleanupFailed = true; }
    }
    for (const name of containers) {
      try { await removeContainer(name); }
      catch { cleanupFailed = true; }
    }
    await rm(runtime, { recursive: true, force: true });
    if (!success || cleanupFailed) await rm(artifactDirectory, { recursive: true, force: true });
    if (cleanupFailed) fail('Backup cleanup failed; no completed backup artifact will be published');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === 'decrypt' && process.argv.length === 7) {
      await decryptBackup(process.argv[3], process.argv[4], JSON.parse(await readFile(process.argv[5], 'utf8')), await readFile(process.argv[6], 'utf8'));
      console.log('Backup authenticated and decrypted to the new private local file.');
    } else if (process.argv.length === 2) await runBackup();
    else fail('Use no arguments in Actions, or decrypt <backup.enc> <new-output.tar> <manifest.json> <private-key.pem>');
  } catch (error) {
    console.error(/^Backup failed at stage [a-z-]+ \([a-z0-9-]+\); no private diagnostic text is emitted$/u.test(error.message)
      ? error.message : 'Production backup failed; no data, SQL, credentials, or private diagnostics are emitted.');
    process.exitCode = 1;
  }
}
