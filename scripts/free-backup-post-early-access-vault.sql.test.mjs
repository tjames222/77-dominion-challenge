import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { POST_EARLY_ACCESS_VAULT_NAMES, postEarlyAccessVaultProofSql, postEarlyAccessLocalVaultRecoverySql,
  requirePostEarlyAccessVaultProof, requirePostEarlyAccessLocalVaultRecovery } from './free-backup-post-early-access-vault.mjs';
import { PROFILE_PHOTO_CLEANUP_CRON_COMMAND } from './configure-production-profile-photo-cleanup-cron.mjs';
import { EARLY_ACCESS_WORKER_COMMANDS } from './configure-production-early-access-workers.mjs';
import { CURRENT_PGNET_TABLES, currentBackupPgNetCaptureSql, currentBackupPgNetLocalReplaySql,
  currentBackupPgNetSequence, currentBackupPgNetLocalSequenceSql, currentBackupPgNetManifest } from './free-backup-current-pgnet.mjs';

const fixture = `77dc-vault66-${randomUUID()}`;
const image = 'public.ecr.aws/supabase/postgres:17.6.1.141';
const containers = new Map();
const secrets = Object.freeze({
  profilePhotoWorkerSecret: 'SYNTHETIC_PROFILE_WORKER_' + 'p'.repeat(32),
  feedbackWorkerSecret: 'SYNTHETIC_FEEDBACK_WORKER_' + 'f'.repeat(32),
  invitationWorkerSecret: 'SYNTHETIC_INVITATION_WORKER_' + 'i'.repeat(32),
});
const projectUrl = 'https://mimolwojppbtsbvtqwpo.supabase.co';
const values = [projectUrl, secrets.profilePhotoWorkerSecret, projectUrl, secrets.feedbackWorkerSecret, secrets.invitationWorkerSecret];
const jobNames = ['process-profile-photo-cleanup', 'process-early-access-feedback', 'process-early-access-invitations'];
const commands = [PROFILE_PHOTO_CLEANUP_CRON_COMMAND, ...EARLY_ACCESS_WORKER_COMMANDS];
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
const inventorySql = `select encode(sha256(convert_to(coalesce(string_agg(encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex'),'' ORDER BY to_jsonb(t)::text COLLATE "C"),''),'UTF8')),'hex') from vault.secrets t;`;
const docker = (args, input, encoding = 'utf8') => spawnSync('docker', args, { input, encoding, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
let startup; let imageId; let sourceHash; let originalCiphertext; let originalJobs;

function owned(kind) {
  const { id } = containers.get(kind) || {};
  assert.match(id || '', /^[a-f0-9]{64}$/);
  const result = docker(['inspect', id, '--format', '{{index .Config.Labels "77dc.fixture"}}|{{.Name}}|{{.HostConfig.NetworkMode}}|{{.HostConfig.ReadonlyRootfs}}']);
  assert.equal(result.status, 0, 'Owned fixture inspection failed.');
  assert.equal(result.stdout.trim(), `${fixture}|/${fixture}-${kind}|none|true`);
  return id;
}
function execute(kind, sql, { role = 'backup_restore_admin', database = 'postgres', host } = {}) {
  return docker(['exec', '-i', owned(kind), 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
    '-h', host || containers.get(kind).host, '-U', role, '-d', database], sql);
}
function query(kind, sql, options) {
  const result = execute(kind, sql, options);
  const errorClass = ['invalid ciphertext', 'Refused non-isolated', 'permission denied', 'no server secret key', 'syntax error']
    .find(value => result.stderr?.includes(value)) || 'output withheld';
  assert.equal(result.status, 0, `Owned Vault SQL failed: ${errorClass}.`);
  return result.stdout.trim();
}
const inventory = kind => query(kind, `set timezone='UTC';set datestyle='ISO,YMD';${inventorySql}`);
const jobs = kind => query(kind, 'select jsonb_agg(to_jsonb(t) order by jobid) from cron.job t;');
function resetVault(kind) {
  query(kind, `truncate vault.secrets;insert into vault.secrets select * from jsonb_populate_recordset(null::vault.secrets,${literal(originalCiphertext)}::jsonb);`);
}
function resetJobs() {
  query('source', `truncate cron.job;insert into cron.job select * from jsonb_populate_recordset(null::cron.job,${literal(originalJobs)}::jsonb);`);
}
async function start(kind, { options = '', host = '/restore', initializeExtensions = true } = {}) {
  const launched = docker(['run', '--detach', '--pull', 'never', '--name', `${fixture}-${kind}`, '--label', `77dc.fixture=${fixture}`,
    '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--log-driver', 'none',
    '--user', '100:101', '--memory', '512m', '--cpus', '1',
    '--tmpfs', '/restore:rw,exec,nosuid,nodev,uid=100,gid=101,mode=0700,size=512m',
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,uid=100,gid=101,mode=0700,size=64m',
    '-e', 'DOMINION_BACKUP_CURRENT_PG_NET=1', '--entrypoint', 'bash', imageId, '-c', startup.trimEnd() + ' ' + options]);
  assert.equal(launched.status, 0, 'Owned Vault fixture creation failed.');
  const id = launched.stdout.trim(); assert.match(id, /^[a-f0-9]{64}$/); containers.set(kind, { id, host });
  let ready = false;
  for (let count = 0; count < 100; count++) {
    if (docker(['exec', id, 'pg_isready', '-h', host, '-U', 'backup_restore_admin']).status === 0) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, 'Owned Vault fixture did not become ready.');
  query(kind, 'create role postgres login superuser;'
    + (initializeExtensions ? 'create schema vault;create extension supabase_vault with schema vault;create extension pg_cron with schema pg_catalog;create extension pg_net;' : ''));
}
function remove(kind) {
  assert.equal(docker(['rm', '--force', owned(kind)]).status, 0, 'Only the owned Vault fixture may be removed.');
  containers.delete(kind);
}
before(async () => {
  startup = await readFile(new URL('./free-backup-local-postgres.sh', import.meta.url), 'utf8');
  const inspected = docker(['image', 'inspect', image, '--format', '{{.Id}}']);
  assert.equal(inspected.status, 0, 'Exact PostgreSQL image must already be cached.');
  imageId = inspected.stdout.trim(); assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
  await start('source'); await start('restore');
  query('source', POST_EARLY_ACCESS_VAULT_NAMES.map((name, index) => `select vault.create_secret(${literal(values[index])},${literal(name)},${literal(`Fixture description ${index}`)});`).join('\n')
    + jobNames.map((name, index) => `select cron.schedule(${literal(name)},'*/5 * * * *',${literal(commands[index])});`).join('\n'), { role: 'postgres' });
  sourceHash = inventory('source');
  originalCiphertext = query('source', 'select jsonb_agg(to_jsonb(t)) from vault.secrets t;');
  originalJobs = jobs('source');
  resetVault('restore'); assert.equal(inventory('restore'), sourceHash);
  query('restore', `insert into net.http_request_queue(id,method,url,headers,body,timeout_milliseconds)
    values(42,'POST','https://fixture.invalid/no-delivery','{"synthetic":"header"}'::jsonb,decode('000aff','hex'),1000);
    select setval('net.http_request_queue_id_seq',42,true);`);
});
after(() => { for (const kind of [...containers.keys()].reverse()) remove(kind); });

test('native read-only proof accepts exactly five protected settings and three fixed jobs without source changes', () => {
  const output = query('source', postEarlyAccessVaultProofSql(secrets, sourceHash), { role: 'postgres' });
  requirePostEarlyAccessVaultProof(output);
  assert.equal(inventory('source'), sourceHash); assert.equal(jobs('source'), originalJobs);
  assert.equal(query('source', "select current_setting('cron.launch_active_jobs'),current_setting('max_worker_processes'),current_setting('pg_net.batch_size');"), 'off|0|0');
});

test('native source proof refuses each wrong protected secret, wrong hash and wrong source role', () => {
  const cases = Object.keys(secrets).map(name => [{ ...secrets, [name]: secrets[name] + 'x' }, sourceHash, 'postgres']);
  cases.push([secrets, '0'.repeat(64), 'postgres'], [secrets, sourceHash, 'backup_restore_admin']);
  for (const [input, hash, role] of cases) {
    const output = query('source', postEarlyAccessVaultProofSql(input, hash), { role });
    assert.equal(output, 'f'); assert.throws(() => requirePostEarlyAccessVaultProof(output));
  }
  assert.equal(inventory('source'), sourceHash);
});

test('every fixed Cron job refuses missing, extra, renamed, changed-command, schedule, active, owner and database states', () => {
  for (const name of jobNames) {
    for (const mutation of [
      `delete from cron.job where jobname=${literal(name)}`,
      `update cron.job set jobname='unexpected-job' where jobname=${literal(name)}`,
      `update cron.job set command=command||' ' where jobname=${literal(name)}`,
      `update cron.job set schedule='* * * * *' where jobname=${literal(name)}`,
      `update cron.job set active=false where jobname=${literal(name)}`,
      `update cron.job set username='backup_restore_admin' where jobname=${literal(name)}`,
      `update cron.job set database='template1' where jobname=${literal(name)}`,
    ]) {
      try {
        query('source', mutation); const changed = jobs('source');
        assert.equal(query('source', postEarlyAccessVaultProofSql(secrets, sourceHash), { role: 'postgres' }), 'f');
        assert.equal(jobs('source'), changed); assert.equal(inventory('source'), sourceHash);
      } finally { resetJobs(); }
    }
  }
  try {
    query('source', "select cron.schedule('unexpected-extra-job','*/5 * * * *','select 1');", { role: 'postgres' });
    assert.equal(query('source', postEarlyAccessVaultProofSql(secrets, sourceHash), { role: 'postgres' }), 'f');
  } finally { resetJobs(); }
});

test('duplicate Cron names with distinct owners cannot substitute for a missing expected job', () => {
  try {
    query('source', `update cron.job set jobname='process-profile-photo-cleanup',username='backup_restore_admin'
      where jobname='process-early-access-feedback';`);
    assert.equal(query('source', postEarlyAccessVaultProofSql(secrets, sourceHash), { role: 'postgres' }), 'f');
  } finally { resetJobs(); }
});

test('native fresh-root reconstruction verifies all five values and descriptions then rolls back unchanged', () => {
  const cannotDecrypt = execute('restore', 'select count(decrypted_secret) from vault.decrypted_secrets;');
  assert.notEqual(cannotDecrypt.status, 0); assert.match(cannotDecrypt.stderr, /invalid ciphertext/);
  const queueBefore = query('restore', 'select jsonb_agg(to_jsonb(t)) from net.http_request_queue t;select last_value,is_called from net.http_request_queue_id_seq;');
  const output = query('restore', postEarlyAccessLocalVaultRecoverySql(secrets));
  requirePostEarlyAccessLocalVaultRecovery(output);
  assert.equal(inventory('restore'), sourceHash);
  const descriptions = POST_EARLY_ACCESS_VAULT_NAMES.map((name, index) => `when ${literal(name)} then ${literal(`Fixture description ${index}`)}`).join('\n');
  const inspectDescriptions = postEarlyAccessLocalVaultRecoverySql(secrets).replace(/ROLLBACK;\n$/, `SELECT count(*)=5 AND bool_and(description=case name ${descriptions} end) FROM vault.secrets;\nROLLBACK;\n`);
  assert.equal(query('restore', inspectDescriptions), '5\nt\nt');
  assert.equal(inventory('restore'), sourceHash);
  assert.equal(query('restore', 'select jsonb_agg(to_jsonb(t)) from net.http_request_queue t;select last_value,is_called from net.http_request_queue_id_seq;'), queueBefore);
  assert.notEqual(execute('restore', 'select count(decrypted_secret) from vault.decrypted_secrets;').status, 0);
});

test('source and local proof reject missing, unknown or extra Vault names without dropping them', () => {
  for (const kind of ['source', 'restore']) {
    const changes = POST_EARLY_ACCESS_VAULT_NAMES.flatMap(name => [
      `delete from vault.secrets where name=${literal(name)}`,
      `update vault.secrets set name='unexpected-setting' where name=${literal(name)}`,
    ]);
    changes.push("select vault.create_secret('SYNTHETIC_UNKNOWN_SETTING','unexpected-setting');");
    for (const mutation of changes) {
      try {
        query(kind, mutation); const changed = inventory(kind);
        if (kind === 'source') {
          assert.equal(query(kind, postEarlyAccessVaultProofSql(secrets, changed), { role: 'postgres' }), 'f');
        } else {
          const result = execute(kind, postEarlyAccessLocalVaultRecoverySql(secrets));
          assert.notEqual(result.status, 0); assert.match(result.stderr, /Refused non-isolated or unexpected Vault reconstruction/);
        }
        assert.equal(inventory(kind), changed);
      } finally { resetVault(kind); }
    }
  }
});

test('non-null key IDs and Vault UUID foreign-key consumers fail closed without source or local writes', () => {
  for (const kind of ['source', 'restore']) {
    try {
      query(kind, "update vault.secrets set key_id='00000000-0000-4000-8000-000000000001' where name='early_access_feedback_worker_secret';");
      const changed = inventory(kind);
      const result = execute(kind, kind === 'source' ? postEarlyAccessVaultProofSql(secrets, changed) : postEarlyAccessLocalVaultRecoverySql(secrets),
        { role: kind === 'source' ? 'postgres' : 'backup_restore_admin' });
      assert(result.status !== 0 || result.stdout.trim() === 'f'); assert.equal(inventory(kind), changed);
    } finally { resetVault(kind); }
    try {
      query(kind, 'create table public.fixture_vault_consumer(secret_id uuid references vault.secrets(id));');
      if (kind === 'source') assert.equal(query(kind, postEarlyAccessVaultProofSql(secrets, sourceHash), { role: 'postgres' }), 'f');
      else assert.notEqual(execute(kind, postEarlyAccessLocalVaultRecoverySql(secrets)).status, 0);
      assert.equal(inventory(kind), sourceHash);
    } finally { query(kind, 'drop table if exists public.fixture_vault_consumer;'); }
  }
});

test('local reconstruction refuses wrong role, database and reserved worker database', () => {
  const wrongRole = execute('restore', postEarlyAccessLocalVaultRecoverySql(secrets), { role: 'postgres' });
  assert.notEqual(wrongRole.status, 0); assert.match(wrongRole.stderr, /Refused non-isolated/);
  for (const name of ['fixture_wrong_database', 'dominion_backup_disabled']) {
    try {
      query('restore', `create database ${name} template postgres;`);
      const result = execute('restore', postEarlyAccessLocalVaultRecoverySql(secrets),
        name === 'fixture_wrong_database' ? { database: name } : {});
      assert.notEqual(result.status, 0); assert.match(result.stderr, /Refused non-isolated/);
      assert.equal(inventory('restore'), sourceHash);
    } finally { query('restore', `drop database if exists ${name};`); }
  }
});

for (const [kind, options, host] of [
  ['socket', '-k /tmp', '/tmp'],
  ['listener', '-c listen_addresses=127.0.0.1', '/restore'],
  ['cron', '-c cron.launch_active_jobs=on', '/restore'],
  ['workers', '-c max_worker_processes=1', '/restore'],
  ['batch', '-c pg_net.batch_size=1', '/restore'],
  ['worker-database', '-c pg_net.database_name=other_disabled_database', '/restore'],
]) {
  test(`native local reconstruction refuses unsafe ${kind} runtime before a write`, async () => {
    await start(kind, { options, host });
    try {
      resetVault(kind);
      query(kind, `create function public.fixture_forbid_delete() returns trigger language plpgsql as $$begin
        raise exception 'FIXTURE_UNEXPECTED_DELETE';end$$;
        create trigger fixture_forbid_delete before delete on vault.secrets for each statement execute function public.fixture_forbid_delete();`);
      const result = execute(kind, postEarlyAccessLocalVaultRecoverySql(secrets));
      assert.notEqual(result.status, 0); assert.match(result.stderr, /Refused non-isolated or unexpected Vault reconstruction/);
      assert(!result.stderr.includes('FIXTURE_UNEXPECTED_DELETE'));
      assert.equal(inventory(kind), sourceHash);
      if (kind === 'listener') {
        const tcp = execute(kind, postEarlyAccessLocalVaultRecoverySql(secrets), { host: '127.0.0.1' });
        assert.notEqual(tcp.status, 0); assert.match(tcp.stderr, /Refused non-isolated/);
        assert.equal(inventory(kind), sourceHash);
      }
    } finally { remove(kind); }
  });
}

test('native full archive preserves synthetic Early Access rows, all original Vault ciphertext and unchanged pg_net supplements', async () => {
  const ordinaryTables = ['transactional_email_reservations', 'early_access_feedback_deliveries', 'early_access_invitation_deliveries',
    'early_access_account_bootstraps', 'early_access_account_setup_deliveries'];
  // Synthetic ordinary rows exercise lossless capture, not application-schema
  // migration validation or application-envelope decryption.
  const versions = (await readdir(new URL('../supabase/migrations/', import.meta.url)))
    .filter(name => name.endsWith('.sql')).sort().slice(0, 66).map(name => name.split('_')[0]);
  assert.equal(versions.length, 66); assert.equal(versions.at(-1), '20260927233055');
  query('source', `create schema private;create schema supabase_migrations;
    create table supabase_migrations.schema_migrations(version text primary key);
    insert into supabase_migrations.schema_migrations values ${versions.map(value => `(${literal(value)})`).join(',')};`
    + ordinaryTables.map(name => `create table private.${name}(id integer primary key,payload jsonb,optional_note text);
      alter table private.${name} enable row level security;
      insert into private.${name} values(1,'{"state":"pending","opaqueEnvelope":"SYNTHETIC_CIPHERTEXT","text":"雪"}',null),
      (2,'{"state":"delivered","receipt":"synthetic-receipt"}',E'line\\nfixture');`).join('\n')
    + `insert into net.http_request_queue(id,method,url,headers,body,timeout_milliseconds)
      values(71,'POST','https://fixture.invalid/no-delivery','{"synthetic":"private-header"}'::jsonb,decode('000aff','hex'),1000);
      insert into net._http_response(id,status_code,content_type,headers,content,timed_out,error_msg,created)
      values(70,200,'application/json',null,'synthetic old response',false,null,'2000-01-01T00:00:00Z');
      select setval('net.http_request_queue_id_seq',71,true);`);
  const allInventorySql = await readFile(new URL('./free-backup-inventory.sql', import.meta.url), 'utf8');
  const before = query('source', allInventorySql);
  const sequence = currentBackupPgNetSequence(before.split('\n').map(JSON.parse));
  const captures = CURRENT_PGNET_TABLES.map(table => {
    const result = docker(['exec', owned('source'), 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', '/restore', '-U', 'postgres', '-d', 'postgres',
      '-c', 'SET SESSION ROLE postgres', '-c', currentBackupPgNetCaptureSql(table.name)], undefined, null);
    assert.equal(result.status, 0, 'Owned pg_net read-only capture failed.'); return { file: table.file, bytes: result.stdout };
  });
  const supplement = currentBackupPgNetManifest(captures, sequence);
  const archive = docker(['exec', owned('source'), 'pg_dump', '--host=/restore', '--username=postgres', '--dbname=postgres',
    '--format=custom', '--compress=0', '--lock-wait-timeout=15000', '--role=postgres'], undefined, null);
  assert.equal(archive.status, 0, 'Owned full archive capture failed.');
  assert.equal(query('source', allInventorySql), before);
  await start('archive', { initializeExtensions: false });
  try {
    const restored = docker(['exec', '-i', owned('archive'), 'pg_restore', '--host=/restore', '--username=backup_restore_admin',
      '--dbname=postgres', '--single-transaction', '--exit-on-error'], archive.stdout);
    assert.equal(restored.status, 0, 'Owned full archive restore failed.');
    for (let index = 0; index < CURRENT_PGNET_TABLES.length; index++) {
      const result = docker(['exec', '-i', owned('archive'), 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', '/restore', '-U', 'backup_restore_admin',
        '-d', 'postgres', '-c', currentBackupPgNetLocalReplaySql(CURRENT_PGNET_TABLES[index].name)], captures[index].bytes);
      assert.equal(result.status, 0, 'Owned pg_net local replay failed.');
    }
    query('archive', currentBackupPgNetLocalSequenceSql(sequence));
    assert.equal(query('archive', allInventorySql), before);
    requirePostEarlyAccessLocalVaultRecovery(query('archive', postEarlyAccessLocalVaultRecoverySql(secrets)));
    assert.equal(query('archive', allInventorySql), before);
    assert.equal(inventory('archive'), sourceHash);
    for (const name of ordinaryTables) assert.equal(query('archive', `select count(*) from private.${name};`), '2');
    assert.deepEqual(currentBackupPgNetManifest(captures, sequence), supplement);
    assert.equal(query('archive', "select current_setting('max_worker_processes'),current_setting('cron.launch_active_jobs'),current_setting('pg_net.batch_size'),(select count(*) from pg_stat_activity where backend_type ilike '%pg_net%' or backend_type ilike '%cron%');"), '0|off|0|0');
    assert.equal(query('source', allInventorySql), before);
  } finally { remove('archive'); }
});
