import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { parseInventory, selectBackupMigrationCheckpoint } from './free-production-backup.mjs';
import { POST73_BACKUP_MODE, POST_ORIGINAL77_VAULT_RECOVERY,
  POST_ORIGINAL77_APPLICATION_ENVELOPE_RECOVERY } from './production-backup-public-contract.mjs';
import { postEarlyAccessVaultRecoveryManifest } from './free-backup-post-early-access-vault.mjs';

const files = await readdir(new URL('../supabase/migrations/', import.meta.url));
const expected = selectBackupMigrationCheckpoint(files, POST73_BACKUP_MODE);
const fixture = () => [
  { kind: 'boundary', serverVersion: '170006', encoding: 'UTF8', bootstrapRole: 'postgres', foreignTables: 0, reservedRoleExists: false },
  ...[['public', 'profiles'], ['auth', 'users'], ['storage', 'objects'], ['storage', 's3_multipart_uploads'],
    ['storage', 's3_multipart_uploads_parts'], ['supabase_migrations', 'schema_migrations'],
    ['vault', 'secrets'], ['pgsodium', 'key']].map(([schema, name]) => ({ kind: 'table', schema, name,
      count: schema === 'vault' ? 5 : 0, sha256: 'a'.repeat(64) })),
  { kind: 'history', versions: [...expected] },
  { kind: 'eventTriggers', entries: [] },
];
const serialize = rows => rows.map(row => JSON.stringify(row)).join('\n');
const parse = (rows, versions = expected, mode = POST73_BACKUP_MODE) => parseInventory(serialize(rows), versions, mode);

test('exact73 inventory accepts only the current complete migration checkpoint, never71/72/74', () => {
  assert.equal(POST73_BACKUP_MODE, 'post-cleanup-monitor-73');
  assert.equal(expected.length, 73); assert.equal(expected.at(-1), '20261007060519');
  const records = fixture(); assert.deepEqual(parse(records), records);
  for (const versions of [expected.slice(0, 71), expected.slice(0, 72), [...expected, '20261013055744'],
    [...expected].reverse(), [...expected.slice(0, -1), expected[71]], ['20260707170001', ...expected.slice(1)]]) {
    assert.throws(() => parse(records, versions));
    const changed = fixture(); changed.find(row => row.kind === 'history').versions = versions;
    assert.throws(() => parse(changed));
  }
  for (const mode of ['legacy-thirteen-migration-cutover', 'current-production-2026-09-27',
    'post-early-access-66', 'post-admin-inbox-67', 'post-original77-70', 'post-repeatable-challenge-71', 'unknown']) {
    assert.throws(() => parse(records, expected, mode));
  }
  assert.throws(() => parse(records.filter(row => row.kind !== 'history')));
  assert.throws(() => parse([...records, { kind: 'history', versions: expected }]));
});

test('exact73 retains exactly five reconstructable Vault settings and excludes Storage/pgsodium data', () => {
  for (const mutate of [
    ...[0, 1, 2, 4, 6, 100].map(count => rows => { rows.find(row => row.schema === 'vault').count = count; }),
    rows => { rows.find(row => row.schema === 'pgsodium').count = 1; },
    ...['objects', 's3_multipart_uploads', 's3_multipart_uploads_parts'].map(name => rows => {
      rows.find(row => row.schema === 'storage' && row.name === name).count = 1;
    }),
    rows => { rows.find(row => row.kind === 'boundary').foreignTables = 1; },
    rows => { rows.find(row => row.kind === 'boundary').reservedRoleExists = true; },
    rows => { rows.find(row => row.kind === 'boundary').serverVersion = '170011'; },
    rows => { rows.find(row => row.kind === 'boundary').encoding = 'SQL_ASCII'; },
  ]) {
    const changed = fixture(); mutate(changed); assert.throws(() => parse(changed));
  }
  for (const schema of ['public', 'auth', 'storage', 'supabase_migrations', 'vault']) {
    assert.throws(() => parse(fixture().filter(row => row.schema !== schema)));
  }
  for (const name of ['objects', 's3_multipart_uploads', 's3_multipart_uploads_parts']) {
    assert.throws(() => parse(fixture().filter(row => row.schema !== 'storage' || row.name !== name)));
  }
  // The historical parser permits an absent pg_sodium key table, but never a
  // present nonempty one. This new checkpoint does not broaden that contract.
  const absentPgsodium = fixture().filter(row => row.schema !== 'pgsodium');
  assert.deepEqual(parse(absentPgsodium), absentPgsodium);
});

test('exact73 recovery declaration stays conditional on the same three existing worker secrets', () => {
  assert.deepEqual(postEarlyAccessVaultRecoveryManifest(), POST_ORIGINAL77_VAULT_RECOVERY);
  assert.deepEqual(POST_ORIGINAL77_VAULT_RECOVERY, {
    selfContained: false, source: 'protected-github-production-settings',
    requiredSettings: ['VITE_SUPABASE_URL', 'PROFILE_PHOTO_WORKER_SECRET', 'FEEDBACK_WORKER_SECRET', 'EARLY_ACCESS_INVITATION_WORKER_SECRET'],
    secretNames: ['profile_photo_project_url', 'profile_photo_worker_secret', 'early_access_project_url',
      'early_access_feedback_worker_secret', 'early_access_invitation_worker_secret'],
    originalCiphertextPreserved: true, freshKeyReconstructionVerified: true, recoveryRequiresProtectedSettings: true,
  });
  assert.deepEqual(POST_ORIGINAL77_APPLICATION_ENVELOPE_RECOVERY, {
    encryptedInvitationPayloadsPreserved: true, decryptionVerified: false,
    requiredExternalSettings: ['EARLY_ACCESS_INVITATION_KEY', 'EARLY_ACCESS_INVITATION_KEY_VERSION'],
    requiresSeparateRecoveryReview: true,
  });
});

test('exact73 source pins are checked before recovery inputs or temporary credential minting', async () => {
  const source = await readFile(new URL('./free-production-backup.mjs', import.meta.url), 'utf8');
  const check = source.indexOf('verifyPost73ReleaseSources({ migrationFilenames, migrationSourceHashes });');
  assert(check >= 0);
  for (const marker of ['const postEarlyAccessSecrets =', 'postEarlyAccessLocalVaultRecoverySql(postEarlyAccessSecrets)',
    "stage('temporary-credentials')"]) assert(check < source.indexOf(marker), marker);
  const recovery = source.slice(source.indexOf('const postEarlyAccessSecrets ='), source.indexOf('// Validate the protected recovery input'));
  assert.deepEqual([...recovery.matchAll(/process\.env\.([A-Z_]+)/g)].map(match => match[1]).sort(),
    ['EARLY_ACCESS_INVITATION_WORKER_SECRET', 'FEEDBACK_WORKER_SECRET', 'PROFILE_PHOTO_WORKER_SECRET']);
  assert.doesNotMatch(source, /process\.env\.(?:EARLY_ACCESS_INVITATION_KEY|EARLY_ACCESS_INVITATION_KEY_VERSION|RESEND_API_KEY|LINEAR_FEEDBACK_API_KEY|PRODUCTION_BACKUP_PRIVATE_KEY|BACKUP_PRIVATE_KEY|VAULT_KEY|PGSODIUM_KEY)\b/);
  assert.match(source, /schemaVersion: usesPostEarlyAccessRecovery \? 3/);
  assert.match(source, /artifactContract: usesPostEarlyAccessRecovery \? 'dominion-free-post-early-access-backup\/v1'/);
  assert.match(source, /encryptedInvitationPayloadsPreserved: true,\s*decryptionVerified: false/);
});

test('exact73 protected backup workflow receives no additional secret or decryption capability', async () => {
  const workflow = await readFile(new URL('../.github/workflows/production-backup.yml', import.meta.url), 'utf8');
  assert.deepEqual([...new Set([...workflow.matchAll(/secrets\.([A-Z_]+)/g)].map(match => match[1]))].sort(),
    ['EARLY_ACCESS_INVITATION_WORKER_SECRET', 'FEEDBACK_WORKER_SECRET', 'PROFILE_PHOTO_WORKER_SECRET', 'SUPABASE_ACCESS_TOKEN']);
  for (const key of ['EARLY_ACCESS_INVITATION_WORKER_SECRET', 'FEEDBACK_WORKER_SECRET', 'PROFILE_PHOTO_WORKER_SECRET']) {
    assert.match(workflow.split('\n').find(line => line.trimStart().startsWith(`${key}:`)),
      /inputs\.backup_mode == 'post-cleanup-monitor-73'/);
  }
  assert.match(workflow, /if: inputs\.backup_mode == 'post-cleanup-monitor-73'[\s\S]*verify-post73-backup-evidence\.mjs/);
  assert.doesNotMatch(workflow, /privateDecrypt|decryptBackup|private[-_]key|VAULT_KEY|PGSODIUM_KEY/);
});
