import { createHash, createPublicKey } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { reconciledHistoryVersions } from './verify-production-migration-cutover-plan.mjs';
import { PRODUCTION_SUPABASE_PROJECT_REF } from './production-auth-canary-policy.mjs';

const repository = 'tjames222/77-dominion-challenge';
const maximumAge = 24 * 60 * 60 * 1000;
const maximumBytes = 50 * 1024 * 1024;
function fail(message) { throw new Error(`Production backup evidence is invalid: ${message}`); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function requireId(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,15}$/u.test(value)) fail('backup run ID must be canonical');
  return value;
}
function requireSha(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value)) fail('release commit must be canonical');
  return value;
}
function requireFresh(value, nowMs) {
  const timestamp = typeof value === 'string' && Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp > nowMs + 300000 || nowMs - timestamp > maximumAge) {
    fail('backup must be from the past 24 hours');
  }
}
export function verifyBackupRun(run, { runId, releaseCommit, nowMs = Date.now() }) {
  requireId(runId); requireSha(releaseCommit);
  if (!run || String(run.id) !== runId || run.head_sha !== releaseCommit
    || run.head_branch !== 'main' || run.event !== 'workflow_dispatch'
    || run.path !== '.github/workflows/production-backup.yml'
    || run.status !== 'completed' || run.conclusion !== 'success'
    || run.repository?.full_name !== repository || run.head_repository?.full_name !== repository
    || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) {
    fail('a successful protected-main backup run for this exact commit is required');
  }
  requireFresh(run.created_at, nowMs);
  return run;
}
export function selectBackupArtifact(value, { runId, releaseCommit, nowMs = Date.now() }) {
  requireId(runId); requireSha(releaseCommit);
  if (!value || !Array.isArray(value.artifacts) || value.total_count !== value.artifacts.length) {
    fail('backup artifact inventory is incomplete');
  }
  const expectedName = `production-backup-${releaseCommit}-${runId}`;
  const selected = value.artifacts.filter(artifact => artifact.name === expectedName);
  if (selected.length !== 1) fail('exactly one encrypted backup artifact is required');
  const artifact = selected[0];
  if (!Number.isSafeInteger(artifact.id) || artifact.id < 1 || artifact.expired !== false
    || !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 1
    || artifact.size_in_bytes > maximumBytes || Date.parse(artifact.expires_at) <= nowMs
    || !Number.isFinite(Date.parse(artifact.expires_at))) fail('backup artifact is absent, expired, or oversized');
  requireFresh(artifact.created_at, nowMs);
  return artifact;
}
function requireBase64(value, expectedLength) {
  if (typeof value !== 'string' || Buffer.from(value, 'base64').toString('base64') !== value
    || Buffer.from(value, 'base64').length !== expectedLength) fail('encryption envelope is malformed');
}
export function verifyBackupManifest(manifest, encrypted, { runId, releaseCommit, publicKey, nowMs = Date.now() }) {
  requireId(runId); requireSha(releaseCommit);
  let key;
  try { key = createPublicKey(publicKey); } catch { fail('the protected backup public key is invalid'); }
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength !== 4096) fail('an RSA-4096 recovery key is required');
  if (!manifest || manifest.schemaVersion !== 1 || manifest.artifactContract !== 'dominion-free-production-backup/v1'
    || manifest.projectRef !== PRODUCTION_SUPABASE_PROJECT_REF || manifest.releaseCommit !== releaseCommit
    || manifest.runId !== runId || !Number.isSafeInteger(manifest.runAttempt) || manifest.runAttempt < 1
    || manifest.postgresImage !== 'public.ecr.aws/supabase/postgres:17.6.1.141'
    || !/^sha256:[0-9a-f]{64}$/u.test(manifest.postgresImageId)
    || manifest.restoreVerified !== true || manifest.storageObjects !== 0
    || JSON.stringify(manifest.migrationVersions) !== JSON.stringify(reconciledHistoryVersions)) {
    fail('backup manifest does not prove the exact project, release, and restored checkpoint');
  }
  requireFresh(manifest.createdAt, nowMs);
  if (manifest.publicKeySha256 !== sha256(key.export({type:'spki',format:'der'}))) fail('backup recovery key does not match production configuration');
  if (!Buffer.isBuffer(encrypted) || encrypted.length < 1 || encrypted.length > maximumBytes
    || manifest.encryptedBytes !== encrypted.length || manifest.encryptedSha256 !== sha256(encrypted)) fail('encrypted backup bytes do not match their manifest');
  if (manifest.encryption?.algorithm !== 'AES-256-GCM' || manifest.encryption?.keyWrap !== 'RSA-OAEP-SHA256') fail('backup encryption contract does not match');
  requireBase64(manifest.encryption.wrappedKey, 512);
  requireBase64(manifest.encryption.iv, 12);
  requireBase64(manifest.encryption.tag, 16);
  return { verified: true };
}
async function githubJson(endpoint, token) {
  if (!token || /[\u0000-\u0020\u007f]/u.test(token)) fail('GitHub read credential is missing or malformed');
  let response;
  try { response = await fetch(`https://api.github.com/repos/${repository}${endpoint}`, {
    headers: {Authorization: `Bearer ${token}`, Accept:'application/vnd.github+json', 'X-GitHub-Api-Version':'2022-11-28'},
    redirect:'error', signal:AbortSignal.timeout(20000),
  }); } catch { fail('GitHub backup evidence request failed'); }
  if (response.status !== 200 || response.redirected) {
    await response.body?.cancel(); fail(`GitHub backup evidence returned HTTP ${response.status}`);
  }
  try { return await response.json(); } catch { fail('GitHub backup evidence was not JSON'); }
}
async function main() {
  const runId = requireId(process.env.BACKUP_RUN_ID);
  const releaseCommit = requireSha(process.env.GITHUB_SHA);
  if (process.argv.length === 3 && process.argv[2] === '--select') {
    const run = await githubJson(`/actions/runs/${runId}`, process.env.GH_TOKEN);
    verifyBackupRun(run, {runId,releaseCommit});
    const inventory = await githubJson(`/actions/runs/${runId}/artifacts?per_page=100`, process.env.GH_TOKEN);
    const artifact = selectBackupArtifact(inventory, {runId,releaseCommit});
    console.log(artifact.id);
    return;
  }
  if (process.argv.length !== 4 || process.argv[2] !== '--directory') fail('expected --select or --directory <path>');
  const directory = path.resolve(process.argv[3]);
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('artifact directory must be ordinary');
  if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(['backup-manifest.json','backup.enc'])) fail('artifact contains unexpected files');
  for (const [name, limit] of [['backup-manifest.json',16384],['backup.enc',maximumBytes]]) {
    const entry = await lstat(path.join(directory,name));
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size < 1 || entry.size > limit) fail('artifact file is invalid');
  }
  let manifest;
  try { manifest = JSON.parse(await readFile(path.join(directory,'backup-manifest.json'),'utf8')); } catch { fail('backup manifest is not JSON'); }
  verifyBackupManifest(manifest,await readFile(path.join(directory,'backup.enc')),{
    runId,releaseCommit,publicKey:process.env.PRODUCTION_BACKUP_PUBLIC_KEY,
  });
  console.log('Verified the encrypted, restored production checkpoint for this release.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode=1; });
}
