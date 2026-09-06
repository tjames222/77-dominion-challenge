import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { reconciledHistoryVersions } from './verify-production-migration-cutover-plan.mjs';
import { verifyBackupRun, selectBackupArtifact, verifyBackupManifest } from './verify-free-production-backup-evidence.mjs';

const releaseCommit = 'a'.repeat(40);
const runId = '123456';
const nowMs = Date.parse('2026-09-06T01:00:00Z');
const createdAt = '2026-09-06T00:30:00Z';
const options = { releaseCommit, runId, nowMs };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const { publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 4096,
  publicKeyEncoding: { type:'spki', format:'pem' },
  privateKeyEncoding: { type:'pkcs8', format:'pem' },
});
const run = {
  id:123456, head_sha:releaseCommit, head_branch:'main', event:'workflow_dispatch',
  path:'.github/workflows/production-backup.yml', status:'completed', conclusion:'success',
  repository:{full_name:'tjames222/77-dominion-challenge'},
  head_repository:{full_name:'tjames222/77-dominion-challenge'}, run_attempt:1, created_at:createdAt,
};
const artifact = {
  id:789, name:`production-backup-${releaseCommit}-${runId}`, expired:false,
  size_in_bytes:4096, created_at:createdAt, expires_at:'2026-09-13T00:30:00Z',
};
const encrypted = Buffer.from('encrypted fixture');
const manifest = {
  schemaVersion:1, artifactContract:'dominion-free-production-backup/v1',
  projectRef:'mimolwojppbtsbvtqwpo', releaseCommit, runId, runAttempt:1, createdAt,
  postgresImage:'public.ecr.aws/supabase/postgres:17.6.1.141', postgresImageId:`sha256:${'a'.repeat(64)}`,
  encryptedSha256:hash(encrypted), encryptedBytes:encrypted.length,
  publicKeySha256:hash(createPublicKey(publicKey).export({type:'spki',format:'der'})),
  encryption:{algorithm:'AES-256-GCM',keyWrap:'RSA-OAEP-SHA256',wrappedKey:Buffer.alloc(512,1).toString('base64'),iv:Buffer.alloc(12,2).toString('base64'),tag:Buffer.alloc(16,3).toString('base64')},
  restoreVerified:true, storageObjects:0, migrationVersions:[...reconciledHistoryVersions],
};

test('accepts successful exact-main backup run only', () => {
  assert.equal(verifyBackupRun(run,options),run);
  for (const patch of [
    {id:99}, {head_sha:'b'.repeat(40)}, {head_branch:'develop'}, {event:'pull_request'},
    {path:'.github/workflows/deploy.yml'}, {status:'in_progress'}, {conclusion:'failure'},
    {repository:{full_name:'other/repository'}}, {head_repository:{full_name:'fork/repository'}},
    {run_attempt:0}, {created_at:'2026-09-04T00:00:00Z'}, {created_at:'2026-09-07T00:00:00Z'},
  ]) assert.throws(() => verifyBackupRun({...run,...patch},options),/invalid/u);
  for (const bad of ['0','0123456','123456\n','1;echo injected',undefined]) {
    assert.throws(() => verifyBackupRun(run,{...options,runId:bad}),/canonical/u);
  }
});

test('requires unique complete fresh unexpired bounded artifact inventory', () => {
  assert.equal(selectBackupArtifact({total_count:1,artifacts:[artifact]},options),artifact);
  for (const inventory of [
    {}, {total_count:2,artifacts:[artifact]}, {total_count:0,artifacts:[]},
    {total_count:2,artifacts:[artifact,artifact]},
  ]) assert.throws(() => selectBackupArtifact(inventory,options),/invalid/u);
  for (const patch of [
    {name:'other'}, {id:0}, {expired:true}, {size_in_bytes:0}, {size_in_bytes:51*1024*1024},
    {expires_at:createdAt}, {expires_at:'not-a-date'}, {created_at:'2026-09-04T00:00:00Z'},
  ]) assert.throws(() => selectBackupArtifact({total_count:1,artifacts:[{...artifact,...patch}]},options),/invalid/u);
});

test('binds restored manifest to exact release, recovery key, and encrypted bytes', () => {
  const configuration = {...options,publicKey};
  assert.deepEqual(verifyBackupManifest(manifest,encrypted,configuration),{verified:true});
  for (const patch of [
    {schemaVersion:2}, {artifactContract:'other'}, {projectRef:'other'},
    {releaseCommit:'b'.repeat(40)}, {runId:'99'}, {runId:123456}, {runAttempt:0}, {runAttempt:'1'},
    {postgresImage:'postgres:latest'}, {postgresImageId:'latest'},
    {restoreVerified:false}, {storageObjects:1}, {migrationVersions:reconciledHistoryVersions.slice(1)},
    {createdAt:'2026-09-04T00:00:00Z'}, {encryptedBytes:1}, {encryptedSha256:'b'.repeat(64)},
    {publicKeySha256:'b'.repeat(64)},
  ]) assert.throws(() => verifyBackupManifest({...manifest,...patch},encrypted,configuration),/invalid/u);
  for (const patch of [
    {algorithm:'AES-256-CBC'}, {keyWrap:'none'}, {wrappedKey:'bad'}, {iv:'bad'}, {tag:'bad'},
  ]) assert.throws(() => verifyBackupManifest({...manifest,encryption:{...manifest.encryption,...patch}},encrypted,configuration),/invalid/u);
  assert.throws(() => verifyBackupManifest(manifest,Buffer.from('modified'),configuration),/bytes/u);
  assert.throws(() => verifyBackupManifest(manifest,encrypted,{...options,publicKey:'bad'}),/key/u);
});

test('release workflow requires the initial backup before compatibility without blocking later full releases', () => {
  const workflow = readFileSync(new URL('../.github/workflows/deploy.yml',import.meta.url),'utf8');
  const compatibility = workflow.split('\n  compatibility-guards:\n')[1].split(/\n  [a-z][a-z-]*:\n/u)[0];
  assert.match(compatibility,/needs:\n(?:      - [a-z-]+\n)*      - backup-evidence\n/u);
  const backup = workflow.split('\n  backup-evidence:\n')[1].split(/\n  [a-z][a-z-]*:\n/u)[0];
  assert.match(backup,/if: inputs.release_scope == 'compatibility-cutover'/u);
  const backend = workflow.split('\n  backend:\n')[1].split(/\n  [a-z][a-z-]*:\n/u)[0];
  assert.doesNotMatch(backend,/      - backup-evidence/u);
  assert.match(backend,/compatibility-cutover|compatibility_frontend_run_id/u);
  assert.match(workflow,/repository: tjames222\/77-dominion-challenge/u);
  assert.match(workflow,/node scripts\/verify-free-production-backup-evidence\.mjs --select/u);
  assert.match(workflow,/PRODUCTION_BACKUP_PUBLIC_KEY: \$\{\{ vars\.PRODUCTION_BACKUP_PUBLIC_KEY \}\}/u);
});
