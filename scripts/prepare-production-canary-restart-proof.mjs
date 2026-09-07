#!/usr/bin/env node
// Local-only receipt preparation. No database commands, plaintext files, or
// hosted writes. Only the encrypted GitHub artifact and public receipt persist.
import { constants as cryptoConstants, createDecipheriv, createPrivateKey, createPublicKey, privateDecrypt } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdtemp, open, readdir, realpath, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseInventory, MAX_ENCRYPTED_BYTES } from './free-production-backup.mjs';
import { verifyBackupRun, selectBackupArtifact, verifyBackupManifest } from './verify-free-production-backup-evidence.mjs';
import { reconciledHistoryVersions } from './verify-production-migration-cutover-plan.mjs';
import { createRestartProof } from './production-canary-restart-proof.mjs';

const REPOSITORY = 'tjames222/77-dominion-challenge';
const PRIOR_RELEASE = '877942113f1d18e73f2e51e6b467915b37b0c67b';
const SOURCE = fileURLToPath(new URL('../', import.meta.url));
const SHA = /^[a-f0-9]{40}$/u;
const ID = /^[1-9][0-9]{0,15}$/u;
const fail = () => { throw new Error('Local restart proof verification failed; private details suppressed.'); };
const requireValue = (condition) => { if (!condition) fail(); };

export function parseRestartProofArguments(args) {
  const names = ['release-sha', 'backup-run-id', 'artifact-id', 'rsa-private-key', 'signing-private-key', 'download-parent', 'output'];
  requireValue(args.length === names.length * 2);
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index].slice(2);
    requireValue(args[index] === `--${name}` && names.includes(name) && !(name in values));
    requireValue(typeof args[index + 1] === 'string' && args[index + 1].length > 0 && !/[\0\r\n]/u.test(args[index + 1]));
    values[name] = args[index + 1];
  }
  requireValue(SHA.test(values['release-sha']) && values['release-sha'] !== PRIOR_RELEASE);
  requireValue(ID.test(values['backup-run-id']) && ID.test(values['artifact-id']));
  for (const name of ['rsa-private-key', 'signing-private-key', 'download-parent', 'output']) requireValue(path.isAbsolute(values[name]));
  requireValue(values['rsa-private-key'] !== values['signing-private-key']);
  return values;
}

export async function requirePrivateDirectory(directory) {
  const stat = await lstat(directory);
  requireValue(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o700);
  return realpath(directory);
}

export async function readOwnerFile(filename, limit, { privateMode = true, makePrivate = false } = {}) {
  const before = await lstat(filename);
  const valid = (stat) => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
    && stat.uid === process.getuid() && stat.size > 0 && stat.size <= limit
    && (!privateMode || (stat.mode & 0o777) === 0o600);
  requireValue(valid(before));
  const handle = await open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    requireValue(valid(opened) && opened.dev === before.dev && opened.ino === before.ino && opened.size === before.size);
    if (makePrivate) await handle.chmod(0o600);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.nlink !== 1) {
      bytes.fill(0); fail();
    }
    return bytes;
  } finally { await handle.close(); }
}

// The producer's tar -cf emits these three regular entries. Authenticate AES-GCM
// before calling this parser; it never extracts files or executes archived SQL.
export function inspectRestartTar(bytes) {
  requireValue(Buffer.isBuffer(bytes) && bytes.length <= MAX_ENCRYPTED_BYTES && bytes.length % 512 === 0);
  const files = new Map();
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString('latin1').replace(/\0.*$/su, '');
    const octal = (value) => {
      requireValue(/^[0-7]+$/u.test(value.trim()));
      const number = Number.parseInt(value.trim(), 8);
      requireValue(Number.isSafeInteger(number));
      return number;
    };
    let checksum = 8 * 32;
    for (let index = 0; index < 512; index++) if (index < 148 || index >= 156) checksum += header[index];
    requireValue(checksum === octal(field(148, 8)));
    const name = field(0, 100);
    requireValue(['roles.sql', 'database.dump', 'inventory.jsonl'].includes(name) && !files.has(name));
    requireValue(['', '0'].includes(field(156, 1)) && field(157, 100) === '' && field(345, 155) === '');
    const size = octal(field(124, 12));
    const end = offset + 512 + size;
    const paddedEnd = offset + 512 + Math.ceil(size / 512) * 512;
    requireValue(size > 0 && size <= MAX_ENCRYPTED_BYTES && paddedEnd <= bytes.length);
    requireValue(bytes.subarray(end, paddedEnd).every((byte) => byte === 0));
    files.set(name, bytes.subarray(offset + 512, end));
    offset = paddedEnd;
  }
  requireValue(bytes.length - offset >= 1024 && bytes.subarray(offset).every((byte) => byte === 0));
  requireValue(JSON.stringify([...files.keys()].sort()) === JSON.stringify(['database.dump', 'inventory.jsonl', 'roles.sql']));
  requireValue(files.get('database.dump').subarray(0, 5).equals(Buffer.from('PGDMP')));
  return files;
}

export function verifyRestartBackupMetadata({ run, artifacts, releaseSha, runId, artifactId, nowMs = Date.now() }) {
  try {
    requireValue(SHA.test(releaseSha) && releaseSha !== PRIOR_RELEASE && ID.test(runId) && ID.test(artifactId));
    verifyBackupRun(run, { runId, releaseCommit: releaseSha, nowMs });
    requireValue(Number.isSafeInteger(run.id) && run.id > 0
      && Number.isSafeInteger(run.repository.id) && run.repository.id > 0
      && Number.isSafeInteger(run.head_repository.id) && run.head_repository.id > 0);
    const artifact = selectBackupArtifact(artifacts, { runId, releaseCommit: releaseSha, nowMs });
    requireValue(String(artifact.id) === artifactId);
    requireValue(artifact.workflow_run?.id === run.id && artifact.workflow_run?.head_sha === releaseSha
      && artifact.workflow_run?.head_branch === 'main' && artifact.workflow_run?.repository_id === run.repository.id
      && artifact.workflow_run?.head_repository_id === run.head_repository.id);
    return { run, artifact };
  } catch { fail(); }
}

export function createProofFromEncryptedBackup({ run, artifacts, releaseSha, runId, artifactId, manifest, encrypted,
  rsaPrivatePem, signingPrivatePem, backupPublicKey, signingPublicKey, nowMs = Date.now() }) {
  let key, partial, final, plaintext;
  try {
    const verified = verifyRestartBackupMetadata({ run, artifacts, releaseSha, runId, artifactId, nowMs });
    const rsaPrivate = createPrivateKey(rsaPrivatePem);
    const edPrivate = createPrivateKey(signingPrivatePem);
    requireValue(rsaPrivate.asymmetricKeyType === 'rsa' && rsaPrivate.asymmetricKeyDetails?.modulusLength === 4096);
    requireValue(edPrivate.asymmetricKeyType === 'ed25519');
    for (const value of [backupPublicKey, signingPublicKey]) {
      requireValue(typeof value === 'string' && value.trim().startsWith('-----BEGIN PUBLIC KEY-----') && !value.includes('PRIVATE KEY'));
    }
    const spki = (value) => createPublicKey(value).export({ type: 'spki', format: 'der' });
    requireValue(spki(rsaPrivate).equals(spki(backupPublicKey)) && spki(edPrivate).equals(spki(signingPublicKey)));
    verifyBackupManifest(manifest, encrypted, { runId, releaseCommit: releaseSha, publicKey: backupPublicKey, nowMs });
    requireValue(manifest.runAttempt === verified.run.run_attempt && encrypted.length <= MAX_ENCRYPTED_BYTES);
    requireValue(typeof manifest.createdAt === 'string' && new Date(manifest.createdAt).toISOString() === manifest.createdAt);
    key = privateDecrypt({ key: rsaPrivate, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(manifest.encryption.wrappedKey, 'base64'));
    requireValue(key.length === 32);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(manifest.encryption.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(manifest.encryption.tag, 'base64'));
    partial = decipher.update(encrypted);
    final = decipher.final(); // Authentication must complete before tar/JSON parsing.
    plaintext = Buffer.concat([partial, final]);
    const entries = inspectRestartTar(plaintext);
    const inventory = parseInventory(new TextDecoder('utf-8', { fatal: true }).decode(entries.get('inventory.jsonl')), reconciledHistoryVersions);
    const entitlements = inventory.filter((record) => record.kind === 'table' && record.schema === 'public' && record.name === 'entitlements');
    requireValue(entitlements.length === 1 && entitlements[0].count === 1 && /^[a-f0-9]{64}$/u.test(entitlements[0].sha256));
    const metadata = {
      schemaVersion: 1, artifactContract: 'dominion-production-canary-restart-proof/v1', priorReleaseSha: PRIOR_RELEASE,
      releaseSha, backupRunId: runId, backupRunAttempt: verified.run.run_attempt, artifactId,
      encryptedSha256: manifest.encryptedSha256, publicKeySha256: manifest.publicKeySha256, createdAt: manifest.createdAt,
    };
    return createRestartProof({ metadata, entitlementsFingerprint: { count: 1, sha256: entitlements[0].sha256 }, signingPrivateKey: edPrivate });
  } catch { fail(); }
  finally {
    // KeyObjects and JSON strings are process-memory-only and become unreachable;
    // all mutable copies of decrypted bytes and the AES key are explicitly wiped.
    for (const bytes of [key, partial, final, plaintext]) bytes?.fill(0);
  }
}

export function restartSubprocessEnvironment(env = process.env) {
  const clean = { HOME: os.homedir(), PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin', LANG: 'C',
    GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_PAGER: 'cat',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  // Authentication only; no proxy, NODE_OPTIONS, shell, debug, or host overrides.
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN']) if (env[name]) clean[name] = env[name];
  return clean;
}
function command(program, args, { timeout = 30000, maxBuffer = 1024 * 1024 } = {}) {
  return execFileSync(program, args, { cwd: SOURCE, env: restartSubprocessEnvironment(), timeout, maxBuffer, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function githubJson(suffix) {
  return JSON.parse(command('gh', ['api', `repos/${REPOSITORY}/${suffix}`]));
}
function requireReviewedCheckout(releaseSha) {
  requireValue(command('git', ['-c', 'core.fsmonitor=false', 'rev-parse', 'HEAD']).trim() === releaseSha);
  requireValue(command('git', ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '--untracked-files=no']).trim() === '');
}

export async function writeNewRestartProof(filename, proof) {
  const parent = await requirePrivateDirectory(path.dirname(filename));
  const target = path.join(parent, path.basename(filename));
  const handle = await open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    const stat = await handle.stat();
    requireValue(stat.isFile() && stat.uid === process.getuid() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600);
    await handle.writeFile(`${JSON.stringify(proof)}\n`);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(target); // Only this just-created exclusive file, never a caller file.
    throw error;
  }
  await handle.close();
  return target;
}

async function main() {
  const options = parseRestartProofArguments(process.argv.slice(2));
  const releaseSha = options['release-sha'], runId = options['backup-run-id'], artifactId = options['artifact-id'];
  requireReviewedCheckout(releaseSha);
  const parent = await requirePrivateDirectory(options['download-parent']);
  await requirePrivateDirectory(path.dirname(options.output));
  try { await lstat(options.output); fail(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let rsaPrivatePem, signingPrivatePem;
  try {
    rsaPrivatePem = await readOwnerFile(options['rsa-private-key'], 16384);
    signingPrivatePem = await readOwnerFile(options['signing-private-key'], 4096);
    const run = githubJson(`actions/runs/${runId}`);
    const artifacts = githubJson(`actions/runs/${runId}/artifacts?per_page=100`);
    const selected = verifyRestartBackupMetadata({ run, artifacts, releaseSha, runId, artifactId }).artifact;
    const backupPublicKey = githubJson('environments/production/variables/PRODUCTION_BACKUP_PUBLIC_KEY').value;
    const signingPublicKey = githubJson('environments/production/variables/PRODUCTION_CANARY_RESTART_PUBLIC_KEY').value;
    const directory = await mkdtemp(path.join(parent, 'restart-backup-'));
    await requirePrivateDirectory(directory);
    // Retain this owned directory even on later failure; only encrypted content
    // is downloaded, and callers can inspect/reuse it for ordinary recovery.
    command('gh', ['run', 'download', runId, '--repo', REPOSITORY, '--name', selected.name, '--dir', directory], { timeout: 60000 });
    requireValue(JSON.stringify((await readdir(directory)).sort()) === JSON.stringify(['backup-manifest.json', 'backup.enc']));
    const manifestBytes = await readOwnerFile(path.join(directory, 'backup-manifest.json'), 16384, { privateMode: false, makePrivate: true });
    const encrypted = await readOwnerFile(path.join(directory, 'backup.enc'), MAX_ENCRYPTED_BYTES, { privateMode: false, makePrivate: true });
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const freshRun = githubJson(`actions/runs/${runId}`);
    const freshArtifacts = githubJson(`actions/runs/${runId}/artifacts?per_page=100`);
    const fresh = verifyRestartBackupMetadata({ run: freshRun, artifacts: freshArtifacts, releaseSha, runId, artifactId });
    requireValue(freshRun.run_attempt === run.run_attempt && JSON.stringify(fresh.artifact) === JSON.stringify(selected));
    requireReviewedCheckout(releaseSha);
    const mainRef = githubJson('git/ref/heads/main');
    requireValue(mainRef.ref === 'refs/heads/main' && mainRef.object?.type === 'commit' && mainRef.object?.sha === releaseSha);
    const proof = createProofFromEncryptedBackup({ run: freshRun, artifacts: freshArtifacts, releaseSha, runId, artifactId,
      manifest, encrypted, rsaPrivatePem, signingPrivatePem, backupPublicKey, signingPublicKey });
    const proofPath = await writeNewRestartProof(options.output, proof);
    console.log(JSON.stringify({ verified: true, privateKeyRecoveryVerified: true, freshDownloadVerified: true,
      plaintextWritten: false, databaseContacted: false, proofPath, artifactDirectory: directory, runId }));
  } finally {
    for (const bytes of [rsaPrivatePem, signingPrivatePem]) bytes?.fill(0);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Local restart proof verification failed; private details suppressed.'); process.exitCode = 1; });
}
