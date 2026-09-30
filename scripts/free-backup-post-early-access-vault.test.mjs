import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { POST_EARLY_ACCESS_BACKUP_MODE, POST_EARLY_ACCESS_VAULT_NAMES,
  postEarlyAccessVaultProofSql, postEarlyAccessLocalVaultRecoverySql,
  requirePostEarlyAccessVaultProof, requirePostEarlyAccessLocalVaultRecovery,
  postEarlyAccessVaultRecoveryManifest } from './free-backup-post-early-access-vault.mjs';
import { PROFILE_PHOTO_CLEANUP_CRON_COMMAND } from './configure-production-profile-photo-cleanup-cron.mjs';
import { EARLY_ACCESS_WORKER_COMMANDS } from './configure-production-early-access-workers.mjs';

const secrets = Object.freeze({
  profilePhotoWorkerSecret: 'SYNTHETIC_PROFILE_WORKER_' + 'p'.repeat(32),
  feedbackWorkerSecret: 'SYNTHETIC_FEEDBACK_WORKER_' + 'f'.repeat(32),
  invitationWorkerSecret: 'SYNTHETIC_INVITATION_WORKER_' + 'i'.repeat(32),
});
const hash = 'a'.repeat(64);
const errorContract = { message: 'Post-Early-Access backup Vault contract failed.', diagnosticCode: 'post-early-access-vault-contract' };
const bound = sql => [...sql.matchAll(/^\\bind (.+)$/gm)].map(match => match[1].split(' ').map(value => value.slice(1, -1)));

test('post-Early-Access mode has only the exact five-setting recovery contract', () => {
  assert.equal(POST_EARLY_ACCESS_BACKUP_MODE, 'post-early-access-66');
  assert.deepEqual(POST_EARLY_ACCESS_VAULT_NAMES, ['profile_photo_project_url', 'profile_photo_worker_secret',
    'early_access_project_url', 'early_access_feedback_worker_secret', 'early_access_invitation_worker_secret']);
  assert(Object.isFrozen(POST_EARLY_ACCESS_VAULT_NAMES));
  const manifest = postEarlyAccessVaultRecoveryManifest();
  assert.deepEqual(manifest, {
    selfContained: false, source: 'protected-github-production-settings',
    requiredSettings: ['VITE_SUPABASE_URL', 'PROFILE_PHOTO_WORKER_SECRET', 'FEEDBACK_WORKER_SECRET', 'EARLY_ACCESS_INVITATION_WORKER_SECRET'],
    secretNames: [...POST_EARLY_ACCESS_VAULT_NAMES], originalCiphertextPreserved: true,
    freshKeyReconstructionVerified: true, recoveryRequiresProtectedSettings: true,
  });
  manifest.secretNames.pop();
  assert.equal(postEarlyAccessVaultRecoveryManifest().secretNames.length, 5);
});

test('proof binds protected inputs, ciphertext hash and exact existing commands without SQL interpolation', () => {
  const sql = postEarlyAccessVaultProofSql(secrets, hash);
  const [values] = bound(sql);
  assert.equal(values.length, 8);
  assert.deepEqual(values.slice(0, 4).map(value => Buffer.from(value, 'base64').toString()),
    ['https://mimolwojppbtsbvtqwpo.supabase.co', secrets.profilePhotoWorkerSecret, secrets.feedbackWorkerSecret, secrets.invitationWorkerSecret]);
  assert.equal(values[4], hash);
  assert.deepEqual(values.slice(5).map(value => Buffer.from(value, 'base64').toString()),
    [PROFILE_PHOTO_CLEANUP_CRON_COMMAND, ...EARLY_ACCESS_WORKER_COMMANDS]);
  assert.match(sql, /BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;/);
  assert.match(sql, /count\(\*\)=5 and count\(distinct name\)=5/);
  assert.match(sql, /key_id is null/);
  assert.match(sql, /count\(\*\)=3 and count\(distinct j.jobname\)=3/);
  assert.match(sql, /left join expected_jobs/);
  assert.match(sql, /e.name is not null/);
  assert.match(sql, /j.command=e.command and j.schedule='\*\/5 \* \* \* \*' and j.active/);
  assert.match(sql, /j.username='postgres' and j.database='postgres'/);
  assert.match(sql, /from vault.secrets t\)=\$5/);
  assert.match(sql, /ROLLBACK;\n$/);
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|GRANT|REVOKE)\b|vault\.(?:create|update)_secret|net\.http_post\(/i);
  for (const secret of Object.values(secrets)) assert(!sql.includes(secret));
});

test('input validation is bounded, accessor-free and rejects missing or additional recovery authority', () => {
  for (const value of [undefined, null, [], 'invalid', {}, { ...secrets, rootKey: 'not-accepted' },
    { ...secrets, feedbackWorkerSecret: secrets.invitationWorkerSecret }]) {
    assert.throws(() => postEarlyAccessVaultProofSql(value, hash), errorContract);
    assert.throws(() => postEarlyAccessLocalVaultRecoverySql(value), errorContract);
  }
  for (const name of Object.keys(secrets)) {
    const maximum = name === 'profilePhotoWorkerSecret' ? 4096 : 512;
    for (const value of [null, 123, '', 'x'.repeat(31), 'x'.repeat(maximum + 1), 'x'.repeat(32) + '\n', 'x'.repeat(32) + ' ', 'é'.repeat(32)]) {
      assert.throws(() => postEarlyAccessLocalVaultRecoverySql({ ...secrets, [name]: value }), errorContract);
    }
    for (const length of [32, maximum]) assert.equal(typeof postEarlyAccessLocalVaultRecoverySql({ ...secrets, [name]: 'x'.repeat(length) }), 'string');
    const accessor = { ...secrets };
    Object.defineProperty(accessor, name, { get() { assert.fail('Recovery inputs must not invoke getters'); } });
    assert.throws(() => postEarlyAccessVaultProofSql(accessor, hash), errorContract);
  }
  for (const invalid of [null, '', hash.toUpperCase(), 'b'.repeat(63), 'b'.repeat(65), hash + "';select 1;"]) {
    assert.throws(() => postEarlyAccessVaultProofSql(secrets, invalid), errorContract);
  }
});

test('punctuation-bearing secrets remain base64-bound, never SQL or psql syntax', () => {
  const special = { ...secrets, feedbackWorkerSecret: "'\\:$();--".repeat(8) };
  for (const sql of [postEarlyAccessVaultProofSql(special, hash), postEarlyAccessLocalVaultRecoverySql(special)]) {
    assert(!sql.includes(special.feedbackWorkerSecret));
    for (const values of bound(sql)) assert.equal(Buffer.from(values[2], 'base64').toString(), special.feedbackWorkerSecret);
  }
});

test('all isolated restore guards precede the only exact-five delete and rolled-back recreation', () => {
  const sql = postEarlyAccessLocalVaultRecoverySql(secrets);
  const firstWrite = sql.indexOf('DELETE FROM vault.secrets');
  for (const fence of ["current_user<>'backup_restore_admin'", "current_database()<>'postgres'", 'inet_server_addr() IS NOT NULL',
    "current_setting('unix_socket_directories')<>'/restore'", "current_setting('listen_addresses')<>''",
    "current_setting('cron.launch_active_jobs')<>'off'", "current_setting('max_worker_processes')<>'0'",
    "current_setting('pg_net.batch_size')<>'0'", "current_setting('pg_net.database_name')<>'dominion_backup_disabled'",
    "datname='dominion_backup_disabled'", "backend_type ilike '%pg_net%'", "backend_type ilike '%cron%'",
    'count(*)=5 and count(distinct name)=5', 'key_id is null', "confrelid='vault.secrets'::regclass"]) {
    assert(sql.indexOf(fence) >= 0 && sql.indexOf(fence) < firstWrite, `Missing pre-write fence: ${fence}`);
  }
  assert.match(sql, /DELETE FROM vault.secrets s USING expected e WHERE s.name=e.name/);
  assert.match(sql, /RETURNING s.name,s.description/);
  assert.match(sql, /vault.create_secret\(e.value,s.name,s.description\)/);
  assert.match(sql, /ROLLBACK;\n$/);
  assert.doesNotMatch(sql, /\bCOMMIT\b|vault\.update_secret|net\.http_post|cron\.(?:schedule|alter_job)/);
  assert.equal(bound(sql).length, 2);
  assert.deepEqual(bound(sql)[0], bound(sql)[1]);
});

test('proof consumers accept only exact fixed output and expose no diagnostic data', () => {
  assert.doesNotThrow(() => requirePostEarlyAccessVaultProof('t'));
  assert.doesNotThrow(() => requirePostEarlyAccessLocalVaultRecovery('5\nt'));
  for (const output of [undefined, null, true, 'true', 'f', 't\n', 't\nsecret', '2\nt', '5\nf', '5\nt\n', 'secret']) {
    assert.throws(() => requirePostEarlyAccessVaultProof(output), errorContract);
    assert.throws(() => requirePostEarlyAccessLocalVaultRecovery(output), errorContract);
  }
});

test('helper has no environment, provider, filesystem, or application-encryption-key access', async () => {
  const source = await readFile(new URL('./free-backup-post-early-access-vault.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /process\.env|fetch\(|node:fs|node:child_process|EARLY_ACCESS_INVITATION_KEY|root\.key/);
});
