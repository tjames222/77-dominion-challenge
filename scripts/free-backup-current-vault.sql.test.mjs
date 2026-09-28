import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { currentBackupLocalVaultRecoverySql, currentBackupVaultProofSql,
  requireCurrentBackupLocalVaultRecovery, requireCurrentBackupVaultProof } from './free-backup-current-vault.mjs';
import { PROFILE_PHOTO_CLEANUP_CRON_COMMAND } from './configure-production-profile-photo-cleanup-cron.mjs';

// Two fresh labelled, network-none, tmpfs-only clusters, never an existing
// stack. Both execute the actual backup startup script with its UID/GID,
// read-only root, capability and tmpfs restrictions; each has a fresh root key.
const fixture = `77dc-vault-cross-key-${randomUUID()}`;
const image = 'public.ecr.aws/supabase/postgres:17.6.1.141';
const containers = new Map();
const secret = 'SYNTHETIC_VAULT_WORKER_SECRET_' + 'x'.repeat(32);
const projectUrl = 'https://mimolwojppbtsbvtqwpo.supabase.co';
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
const inventorySql = `select encode(sha256(convert_to(coalesce(string_agg(encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex'),'' ORDER BY to_jsonb(t)::text COLLATE "C"),''),'UTF8')),'hex') from vault.secrets t;`;
const docker = (args, input) => spawnSync('docker', args, { input, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
function owned(kind) {
  const id = containers.get(kind); assert.match(id || '', /^[a-f0-9]{64}$/);
  const result = docker(['inspect', id, '--format', '{{index .Config.Labels "77dc.fixture"}}|{{.Name}}|{{.HostConfig.NetworkMode}}']);
  assert.equal(result.status, 0); assert.equal(result.stdout.trim(), `${fixture}|/${fixture}-${kind}|none`); return id;
}
function execute(kind, sql, role = 'backup_restore_admin') {
  return docker(['exec', '-i', owned(kind), 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', '/restore', '-U', role, '-d', 'postgres'], sql);
}
function query(kind, sql, role) {
  const result = execute(kind, sql, role);
  const errorClass = ['invalid ciphertext', 'Refused non-isolated', 'permission denied', 'no server secret key', 'syntax error']
    .find(value => result.stderr?.includes(value)) || 'output withheld';
  assert.equal(result.status, 0, `Owned Vault SQL failed: ${errorClass}.`); return result.stdout.trim();
}
const inventory = kind => query(kind, `set timezone='UTC';set datestyle='ISO,YMD';${inventorySql}`);
let sourceHash;
before(async () => {
  const startup = await readFile(new URL('./free-backup-local-postgres.sh', import.meta.url), 'utf8');
  const inspected = docker(['image', 'inspect', image, '--format', '{{.Id}}']); assert.equal(inspected.status, 0, 'Exact image must already be cached.');
  const imageId = inspected.stdout.trim(); assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
  for (const kind of ['source', 'restore']) {
    const started = docker(['run', '--detach', '--pull', 'never', '--name', `${fixture}-${kind}`, '--label', `77dc.fixture=${fixture}`,
      '--network', 'none', '--user', '100:101', '--memory', '512m', '--cpus', '1',
      '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--log-driver', 'none',
      '--tmpfs', '/restore:rw,exec,nosuid,nodev,uid=100,gid=101,mode=0700,size=512m',
      '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,uid=100,gid=101,mode=0700,size=64m',
      '--entrypoint', 'bash', imageId, '-c', startup]);
    assert.equal(started.status, 0, 'Owned Vault fixture creation failed.'); const id = started.stdout.trim(); assert.match(id, /^[a-f0-9]{64}$/); containers.set(kind, id);
    let ready = false;
    for (let count = 0; count < 100; count++) {
      if (docker(['exec', id, 'pg_isready', '-h', '/restore', '-U', 'backup_restore_admin']).status === 0) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'Owned Vault fixture did not become ready.');
    query(kind, 'create role postgres login superuser;create schema vault;create extension supabase_vault with schema vault;create extension pg_cron with schema pg_catalog;');
  }
  query('source', `select vault.create_secret(${literal(projectUrl)},'profile_photo_project_url');select vault.create_secret(${literal(secret)},'profile_photo_worker_secret');
    select cron.schedule('process-profile-photo-cleanup','*/5 * * * *',${literal(PROFILE_PHOTO_CLEANUP_CRON_COMMAND)});`, 'postgres');
  sourceHash = inventory('source'); assert.match(sourceHash, /^[a-f0-9]{64}$/);
  const ciphertext = query('source', 'select jsonb_agg(to_jsonb(t)) from vault.secrets t;');
  query('restore', `insert into vault.secrets select * from jsonb_populate_recordset(null::vault.secrets,${literal(ciphertext)}::jsonb);`);
  assert.equal(inventory('restore'), sourceHash);
});
after(() => {
  for (const kind of ['restore', 'source']) {
    if (!containers.has(kind)) continue;
    const result = docker(['rm', '--force', owned(kind)]); assert.equal(result.status, 0, 'Only the owned Vault fixture may be removed.');
  }
});
test('actual psql17 bound read-only source proof accepts exact protected settings and original ciphertext hash', () => {
  const output = query('source', currentBackupVaultProofSql(secret, sourceHash), 'postgres');
  requireCurrentBackupVaultProof(output); assert.equal(inventory('source'), sourceHash);
  assert.equal(query('source', "show cron.launch_active_jobs;"), 'off');
});
test('source proof fails closed for wrong protected secret, ciphertext hash or source role', () => {
  for (const [key, hash, role] of [[`${secret}x`, sourceHash, 'postgres'], [secret, '0'.repeat(64), 'postgres'], [secret, sourceHash, 'backup_restore_admin']]) {
    const output = query('source', currentBackupVaultProofSql(key, hash), role);
    assert.equal(output, 'f'); assert.throws(() => requireCurrentBackupVaultProof(output));
  }
  assert.equal(inventory('source'), sourceHash);
});
test('foreign-root ciphertext cannot decrypt; explicit local reconstruction verifies then rolls back unchanged', () => {
  const cannotDecrypt = execute('restore', 'select count(decrypted_secret) from vault.decrypted_secrets;');
  assert.notEqual(cannotDecrypt.status, 0, 'A genuinely different root key must reject the copied ciphertext.');
  assert.match(cannotDecrypt.stderr, /invalid ciphertext/);
  const output = query('restore', currentBackupLocalVaultRecoverySql(secret));
  requireCurrentBackupLocalVaultRecovery(output); assert.equal(inventory('restore'), sourceHash);
  assert.notEqual(execute('restore', 'select count(decrypted_secret) from vault.decrypted_secrets;').status, 0, 'ROLLBACK must preserve the original foreign-root ciphertext.');
});
test('local reconstruction rejects the wrong role before writing and preserves ciphertext', () => {
  assert.notEqual(execute('restore', currentBackupLocalVaultRecoverySql(secret), 'postgres').status, 0);
  assert.equal(inventory('restore'), sourceHash);
});
test('UUID foreign-key consumers make both source proof and local reconstruction fail closed', () => {
  for (const kind of ['source', 'restore']) query(kind, 'create table public.fixture_vault_consumer(secret_id uuid references vault.secrets(id));');
  assert.equal(query('source', currentBackupVaultProofSql(secret, sourceHash), 'postgres'), 'f');
  assert.notEqual(execute('restore', currentBackupLocalVaultRecoverySql(secret)).status, 0);
  assert.equal(inventory('source'), sourceHash); assert.equal(inventory('restore'), sourceHash);
  for (const kind of ['source', 'restore']) query(kind, 'drop table public.fixture_vault_consumer;');
});
test('unexpected additional Vault authority is never silently reconstructed', () => {
  query('restore', "select vault.create_secret('synthetic-unknown-setting','unreviewed_secret');");
  const changedHash = inventory('restore'); assert.notEqual(changedHash, sourceHash);
  assert.notEqual(execute('restore', currentBackupLocalVaultRecoverySql(secret)).status, 0);
  assert.equal(inventory('restore'), changedHash);
});
