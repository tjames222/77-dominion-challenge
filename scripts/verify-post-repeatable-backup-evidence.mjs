import { createHash, createPublicKey } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAX_ENCRYPTED_BYTES, POSTGRES_IMAGE, POST_ORIGINAL77_APPLICATION_ENVELOPE_RECOVERY,
  POST_REPEATABLE_BACKUP_MODE, POST_ORIGINAL77_VAULT_RECOVERY, PROJECT_REF,
  requirePostRepeatableMigrationVersions, selectPostRepeatableMigrationVersions,
} from './production-backup-public-contract.mjs';

const maximumAge = 24 * 60 * 60 * 1000;
const repository = 'tjames222/77-dominion-challenge';
const migrationsDirectory = new URL('../supabase/migrations/', import.meta.url);
const manifestKeys = Object.freeze([
  'applicationEnvelopeRecovery', 'artifactContract', 'backupMode', 'createdAt', 'encryptedBytes',
  'encryptedSha256', 'encryption', 'migrationVersions', 'pgNetSupplement', 'postgresImage',
  'postgresImageId', 'projectRef', 'publicKeySha256', 'releaseCommit', 'restoreVerified', 'runAttempt',
  'runId', 'schemaVersion', 'storageObjects', 'vaultRecovery',
].sort());
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(`Post-repeatable backup evidence is invalid: ${message}`); };

function requireRunId(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,15}$/u.test(value)) fail('backup run ID is malformed');
  return value;
}
function requireReleaseCommit(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value)) fail('release commit is malformed');
  return value;
}
function requireRunAttempt(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,5}$/u.test(value)) fail('backup run attempt is malformed');
  return Number(value);
}

function requireFresh(value, nowMs) {
  const timestamp = typeof value === 'string' && Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp > nowMs + 300000 || nowMs - timestamp > maximumAge) {
    fail('backup must be from the past 24 hours');
  }
}

export function verifyPostRepeatableBackupRun(run, { runId, releaseCommit, nowMs = Date.now() }) {
  requireRunId(runId); requireReleaseCommit(releaseCommit);
  if (!run || String(run.id) !== runId || run.head_sha !== releaseCommit || run.head_branch !== 'main'
    || run.event !== 'workflow_dispatch' || run.path !== '.github/workflows/production-backup.yml'
    || run.status !== 'completed' || run.conclusion !== 'success'
    || run.repository?.full_name !== repository || run.head_repository?.full_name !== repository
    || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) {
    fail('a successful protected-main backup run for this exact commit is required');
  }
  requireFresh(run.created_at, nowMs);
  return run;
}

export function selectPostRepeatableBackupArtifact(value, { runId, releaseCommit, nowMs = Date.now() }) {
  requireRunId(runId); requireReleaseCommit(releaseCommit);
  if (!value || !Array.isArray(value.artifacts) || value.total_count !== value.artifacts.length) {
    fail('backup artifact inventory is incomplete');
  }
  const expectedName = `production-backup-${releaseCommit}-${runId}`;
  const selected = value.artifacts.filter(artifact => artifact.name === expectedName);
  if (selected.length !== 1) fail('exactly one encrypted backup artifact is required');
  const artifact = selected[0];
  if (!Number.isSafeInteger(artifact.id) || artifact.id < 1 || artifact.expired !== false
    || !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 1
    || artifact.size_in_bytes > MAX_ENCRYPTED_BYTES || !Number.isFinite(Date.parse(artifact.expires_at))
    || Date.parse(artifact.expires_at) <= nowMs) fail('backup artifact is absent, expired, or oversized');
  requireFresh(artifact.created_at, nowMs);
  return artifact;
}
function requireBase64(value, expectedLength) {
  if (typeof value !== 'string' || Buffer.from(value, 'base64').toString('base64') !== value
    || Buffer.from(value, 'base64').length !== expectedLength) fail('encryption envelope is malformed');
}
function requirePgNetSupplement(value) {
  if (!value || Object.keys(value).sort().join(',') !==
    'contract,extensionVersion,files,format,replayRequiresIsolatedWorkerDisabledRuntime,sequence') fail('pg_net supplement is malformed');
  if (value.contract !== 'dominion-pg-net-binary-supplement/v1' || value.extensionVersion !== '0.20.3'
    || value.format !== 'postgresql-binary-copy' || value.replayRequiresIsolatedWorkerDisabledRuntime !== true
    || !Array.isArray(value.files) || value.files.length !== 2) fail('pg_net supplement is malformed');
  const names = ['pg-net-http-response.copy', 'pg-net-http-request-queue.copy'];
  for (let index = 0; index < names.length; index++) {
    const file = value.files[index];
    if (!file || Object.keys(file).sort().join(',') !== 'bytes,file,sha256' || file.file !== names[index]
      || !Number.isSafeInteger(file.bytes) || file.bytes < 21 || file.bytes > MAX_ENCRYPTED_BYTES
      || !/^[0-9a-f]{64}$/u.test(file.sha256)) fail('pg_net supplement is malformed');
  }
  const sequence = value.sequence;
  if (!sequence || Object.keys(sequence).sort().join(',') !== 'isCalled,lastValue,name,schema'
    || sequence.schema !== 'net' || sequence.name !== 'http_request_queue_id_seq'
    || typeof sequence.lastValue !== 'string' || !/^[1-9][0-9]{0,18}$/u.test(sequence.lastValue)
    || BigInt(sequence.lastValue) > 9223372036854775807n || typeof sequence.isCalled !== 'boolean') {
    fail('pg_net supplement is malformed');
  }
}

export function verifyPostRepeatableBackupManifest(manifest, encrypted, {
  runId, releaseCommit, runAttempt, publicKey, expectedVersions, nowMs = Date.now(),
}) {
  requireRunId(runId); requireReleaseCommit(releaseCommit);
  if (!Number.isSafeInteger(runAttempt) || runAttempt < 1 || runAttempt > 999999) fail('backup run attempt is malformed');
  try { requirePostRepeatableMigrationVersions(expectedVersions); }
  catch { fail('reviewed migration checkpoint changed'); }
  let key;
  try { key = createPublicKey(publicKey); } catch { fail('protected backup public key is invalid'); }
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength !== 4096) fail('RSA-4096 recovery key is required');
  if (!manifest || Object.keys(manifest).sort().join(',') !== manifestKeys.join(',')
    || manifest.schemaVersion !== 3 || manifest.artifactContract !== 'dominion-free-post-early-access-backup/v1'
    || manifest.backupMode !== POST_REPEATABLE_BACKUP_MODE || manifest.projectRef !== PROJECT_REF
    || manifest.releaseCommit !== releaseCommit || manifest.runId !== runId
    || manifest.runAttempt !== runAttempt
    || manifest.postgresImage !== POSTGRES_IMAGE
    || !/^sha256:[0-9a-f]{64}$/u.test(manifest.postgresImageId)
    || manifest.restoreVerified !== true || manifest.storageObjects !== 0
    || JSON.stringify(manifest.migrationVersions) !== JSON.stringify(expectedVersions)
    || JSON.stringify(manifest.vaultRecovery) !== JSON.stringify(POST_ORIGINAL77_VAULT_RECOVERY)
    || JSON.stringify(manifest.applicationEnvelopeRecovery) !== JSON.stringify(POST_ORIGINAL77_APPLICATION_ENVELOPE_RECOVERY)) {
    fail('manifest does not prove the exact restored checkpoint');
  }
  requireFresh(manifest.createdAt, nowMs);
  if (manifest.publicKeySha256 !== sha256(key.export({ type: 'spki', format: 'der' }))) fail('recovery key does not match');
  if (!Buffer.isBuffer(encrypted) || encrypted.length < 1 || encrypted.length > MAX_ENCRYPTED_BYTES
    || manifest.encryptedBytes !== encrypted.length || manifest.encryptedSha256 !== sha256(encrypted)) fail('encrypted bytes do not match');
  if (!manifest.encryption || Object.keys(manifest.encryption).sort().join(',') !== 'algorithm,iv,keyWrap,tag,wrappedKey'
    || manifest.encryption.algorithm !== 'AES-256-GCM' || manifest.encryption.keyWrap !== 'RSA-OAEP-SHA256') {
    fail('encryption contract does not match');
  }
  requireBase64(manifest.encryption.wrappedKey, 512);
  requireBase64(manifest.encryption.iv, 12);
  requireBase64(manifest.encryption.tag, 16);
  requirePgNetSupplement(manifest.pgNetSupplement);
  return { verified: true, backupMode: POST_REPEATABLE_BACKUP_MODE };
}

async function githubJson(endpoint, token) {
  if (typeof token !== 'string' || !token || /[\u0000-\u0020\u007f]/u.test(token)) fail('GitHub read credential is missing or malformed');
  let response;
  try {
    response = await fetch(`https://api.github.com/repos/${repository}${endpoint}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28' }, redirect: 'error', signal: AbortSignal.timeout(20_000),
    });
  } catch { fail('GitHub backup evidence request failed'); }
  if (response.status !== 200 || response.redirected) {
    await response.body?.cancel();
    fail(`GitHub backup evidence returned HTTP ${response.status}`);
  }
  try { return await response.json(); } catch { fail('GitHub backup evidence was not JSON'); }
}

async function main() {
  const runId = requireRunId(process.env.BACKUP_RUN_ID);
  const releaseCommit = requireReleaseCommit(process.env.GITHUB_SHA);
  if (process.argv.length === 3 && process.argv[2] === '--select') {
    const run = await githubJson(`/actions/runs/${runId}`, process.env.GH_TOKEN);
    verifyPostRepeatableBackupRun(run, { runId, releaseCommit });
    const inventory = await githubJson(`/actions/runs/${runId}/artifacts?per_page=100`, process.env.GH_TOKEN);
    console.log(`${selectPostRepeatableBackupArtifact(inventory, { runId, releaseCommit }).id} ${run.run_attempt}`);
    return;
  }
  if (process.argv.length !== 4 || process.argv[2] !== '--directory') fail('expected --select or --directory <path>');
  const directory = path.resolve(process.argv[3]);
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('artifact directory must be ordinary');
  if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(['backup-manifest.json', 'backup.enc'])) {
    fail('artifact contains unexpected files');
  }
  for (const [name, limit] of [['backup-manifest.json', 32768], ['backup.enc', MAX_ENCRYPTED_BYTES]]) {
    const entry = await lstat(path.join(directory, name));
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size < 1 || entry.size > limit) fail('artifact file is invalid');
  }
  let manifest;
  try { manifest = JSON.parse(await readFile(path.join(directory, 'backup-manifest.json'), 'utf8')); }
  catch { fail('backup manifest is not JSON'); }
  const expectedVersions = selectPostRepeatableMigrationVersions(await readdir(migrationsDirectory));
  verifyPostRepeatableBackupManifest(manifest, await readFile(path.join(directory, 'backup.enc')), {
    runId,
    releaseCommit,
    runAttempt: requireRunAttempt(process.env.BACKUP_RUN_ATTEMPT ?? process.env.GITHUB_RUN_ATTEMPT),
    publicKey: process.env.PRODUCTION_BACKUP_PUBLIC_KEY,
    expectedVersions,
  });
  console.log('Verified encrypted exact-71 repeatable challenge backup evidence without decrypting it.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
