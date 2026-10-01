import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyBackupFailure, classifyDockerFailure, classifyPgRestoreFailure, cleanupBackupResources, decryptBackup, encryptBackup, localRestoreRoles, parseInventory, recipientKey, restoreLocalArchiveWithRoleCompatibility, selectBackupMigrationCheckpoint, LOCAL_RESTORE_ROLE_SNAPSHOT_SQL, REMOTE_BACKUP_PREFLIGHT_SQL, REMOTE_BACKUP_ROLE_SQL } from './free-production-backup.mjs';
import { CURRENT_BACKUP_MODE, LEGACY_BACKUP_MODE, currentBackupVaultProofSql, currentBackupLocalVaultRecoverySql,
  requireCurrentBackupVaultProof, requireCurrentBackupLocalVaultRecovery, currentBackupVaultRecoveryManifest } from './free-backup-current-vault.mjs';
import { verifyBackupManifest } from './verify-free-production-backup-evidence.mjs';
import { POST_EARLY_ACCESS_BACKUP_MODE, postEarlyAccessVaultRecoveryManifest } from './free-backup-post-early-access-vault.mjs';
import { POST_ADMIN_INBOX_BACKUP_MODE, POST_ORIGINAL77_BACKUP_MODE } from './free-production-backup.mjs';
import { POST_ORIGINAL77_VAULT_RECOVERY } from './production-backup-public-contract.mjs';

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
  assert.equal(classifyBackupFailure(Object.assign(new Error(secret), { diagnosticCode: 'current-vault-contract' })), 'current-vault-contract');
  assert.equal(classifyBackupFailure(Object.assign(new Error(secret), { diagnosticCode: 'post-early-access-vault-contract' })), 'post-early-access-vault-contract');
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
  { kind: 'eventTriggers', entries: [] },
];
const serialized = (records) => records.map((r) => JSON.stringify(r)).join('\n');

test('inventory requires complete core schemas and exact migration history', () => {
  assert.equal(parseInventory(serialized(fixture()), ['1', '2']).length, fixture().length);
  assert.throws(() => parseInventory(serialized(fixture()), ['1']), /checkpoint/);
  assert.throws(() => parseInventory(serialized(fixture().filter((r) => r.schema !== 'auth')), ['1', '2']), /auth/);
});

const eventTriggerFixture = () => ({
  name: 'fixture_trigger', event: 'ddl_command_end', enabled: 'O', tags: null,
  owner: 'postgres', ownerSuper: false, functionSchema: 'public',
  functionName: 'fixture_event', functionIdentityArguments: '', functionOwner: 'postgres',
});

test('event-trigger inventory is always present with complete ordered private ownership metadata', () => {
  const records = fixture();
  const inventory = records.find((record) => record.kind === 'eventTriggers');
  inventory.entries = [eventTriggerFixture()];
  assert.deepEqual(parseInventory(serialized(records), ['1', '2']), records);
  inventory.entries[0].tags = ['CREATE TABLE'];
  assert.deepEqual(parseInventory(serialized(records), ['1', '2']), records);
  for (const event of ['login', 'ddl_command_start', 'ddl_command_end', 'sql_drop', 'table_rewrite']) {
    inventory.entries[0].event = event;
    assert.deepEqual(parseInventory(serialized(records), ['1', '2']), records);
  }
  for (const broken of [
    records.filter((record) => record.kind !== 'eventTriggers'),
    [...records, structuredClone(inventory)],
  ]) assert.throws(() => parseInventory(serialized(broken), ['1', '2']), /event-trigger inventory/);
  for (const invalid of [
    null, {}, [null], [{ ...eventTriggerFixture(), ownerSuper: 'false' }],
    [{ ...eventTriggerFixture(), owner: '' }], [{ ...eventTriggerFixture(), functionOwner: null }],
    [{ ...eventTriggerFixture(), functionIdentityArguments: null }],
    [{ ...eventTriggerFixture(), tags: 'CREATE TABLE' }], [{ ...eventTriggerFixture(), tags: [1] }],
    [{ ...eventTriggerFixture(), event: 'unknown' }], [{ ...eventTriggerFixture(), enabled: 'unknown' }],
    [{ ...eventTriggerFixture(), unexpected: 'private fixture' }],
    [eventTriggerFixture(), eventTriggerFixture()],
    [{ ...eventTriggerFixture(), name: 'b' }, { ...eventTriggerFixture(), name: 'a' }],
  ]) {
    inventory.entries = invalid;
    assert.throws(() => parseInventory(serialized(records), ['1', '2']));
  }
});

const restoreRoleFixture = () => [
  { oid: '10', rolname: 'backup_restore_admin', rolsuper: true, rolinherit: true, rolcreaterole: true, rolcreatedb: true, rolcanlogin: true, rolreplication: true, rolconnlimit: -1, rolpassword: '********', rolvaliduntil: null, rolbypassrls: true, rolconfig: null },
  { oid: '20000', rolname: 'postgres', rolsuper: false, rolinherit: true, rolcreaterole: true, rolcreatedb: true, rolcanlogin: true, rolreplication: true, rolconnlimit: -1, rolpassword: '********', rolvaliduntil: null, rolbypassrls: true, rolconfig: ['search_path=public'] },
];
const localRoleHarness = (options = {}) => {
  const roles = structuredClone(options.roles ?? restoreRoleFixture());
  const calls = [];
  let snapshots = 0;
  return {
    roles, calls,
    localSql: async (sql) => {
      if (sql === LOCAL_RESTORE_ROLE_SNAPSHOT_SQL) {
        calls.push('snapshot');
        snapshots++;
        if (snapshots === 1 && 'beforeError' in options) throw options.beforeError;
        if (snapshots === 2 && 'afterError' in options) throw options.afterError;
        return JSON.stringify(roles);
      }
      if (sql === 'ALTER ROLE postgres SUPERUSER;') {
        calls.push('elevate');
        roles.find((role) => role.rolname === 'postgres').rolsuper = true;
        if ('elevateError' in options) throw options.elevateError;
        return '';
      }
      assert.equal(sql, 'ALTER ROLE postgres NOSUPERUSER;');
      calls.push('downgrade');
      if ('downgradeError' in options) throw options.downgradeError;
      roles.find((role) => role.rolname === 'postgres').rolsuper = false;
      return '';
    },
    restoreArchive: async () => {
      calls.push('restore');
      assert.equal(roles.find((role) => role.rolname === 'postgres').rolsuper, true);
      options.mutate?.(roles);
      if ('restoreError' in options) throw options.restoreError;
    },
  };
};

test('isolated archive compatibility elevates only local postgres and restores the complete role snapshot', async () => {
  const harness = localRoleHarness();
  await restoreLocalArchiveWithRoleCompatibility(harness);
  assert.deepEqual(harness.calls, ['snapshot', 'elevate', 'restore', 'downgrade', 'snapshot']);
  assert.deepEqual(harness.roles, restoreRoleFixture());
  assert.match(LOCAL_RESTORE_ROLE_SNAPSHOT_SQL, /jsonb_agg\(to_jsonb\(r\) ORDER BY r\.oid\)/u);
  assert.match(LOCAL_RESTORE_ROLE_SNAPSHOT_SQL, /FROM pg_catalog\.pg_roles AS r;/u);
  assert.doesNotMatch(LOCAL_RESTORE_ROLE_SNAPSHOT_SQL, /WHERE|pg_authid/u);
});

test('isolated archive compatibility rejects role precondition failures before any mutation', async () => {
  const variants = [
    (roles) => roles.splice(1, 1),
    (roles) => roles.push({ ...roles[1], oid: '20001' }),
    (roles) => { roles[1].rolsuper = true; },
    (roles) => { roles[1].rolsuper = 'false'; },
    (roles) => { roles[0].rolname = 'different_admin'; },
    (roles) => { roles[0].oid = '11'; },
    (roles) => { roles[0].oid = 10; },
    (roles) => { roles[0].rolsuper = false; },
  ];
  for (const change of variants) {
    const roles = restoreRoleFixture(); change(roles);
    const harness = localRoleHarness({ roles });
    await assert.rejects(restoreLocalArchiveWithRoleCompatibility(harness));
    assert.deepEqual(harness.calls, ['snapshot']);
  }
  for (const text of ['not JSON', '{}', 'null']) {
    const calls = [];
    await assert.rejects(restoreLocalArchiveWithRoleCompatibility({
      localSql: async (sql) => { calls.push(sql); return text; },
      restoreArchive: async () => assert.fail('Archive must not run'),
    }));
    assert.deepEqual(calls, [LOCAL_RESTORE_ROLE_SNAPSHOT_SQL]);
  }
});

test('isolated archive compatibility always attempts downgrade and preserves the primary operation error', async () => {
  const beforeError = new Error('private before snapshot fixture');
  const elevateError = new Error('private uncertain elevation fixture');
  const restoreError = Object.assign(new Error('private restore fixture'), { diagnosticCode: 'pg-restore-permission-event-trigger-owner' });
  const downgradeError = new Error('private downgrade fixture');
  const afterError = new Error('private after snapshot fixture');
  for (const [options, expectedError, expectedCalls] of [
    [{ beforeError }, beforeError, ['snapshot']],
    [{ elevateError }, elevateError, ['snapshot', 'elevate', 'downgrade']],
    [{ elevateError, downgradeError }, elevateError, ['snapshot', 'elevate', 'downgrade']],
    [{ restoreError }, restoreError, ['snapshot', 'elevate', 'restore', 'downgrade']],
    [{ restoreError, downgradeError }, restoreError, ['snapshot', 'elevate', 'restore', 'downgrade']],
    [{ restoreError: null, downgradeError }, null, ['snapshot', 'elevate', 'restore', 'downgrade']],
    [{ downgradeError }, downgradeError, ['snapshot', 'elevate', 'restore', 'downgrade']],
    [{ downgradeError: undefined }, undefined, ['snapshot', 'elevate', 'restore', 'downgrade']],
    [{ afterError }, afterError, ['snapshot', 'elevate', 'restore', 'downgrade', 'snapshot']],
  ]) {
    const harness = localRoleHarness(options);
    let reachedVerification = false;
    await assert.rejects(async () => {
      await restoreLocalArchiveWithRoleCompatibility(harness);
      reachedVerification = true;
    }, (error) => error === expectedError);
    assert.deepEqual(harness.calls, expectedCalls);
    assert.equal(reachedVerification, false);
    if (!('downgradeError' in options)) assert.equal(harness.roles[1].rolsuper, false);
  }
});

test('isolated archive compatibility rejects changes to any role after a successful downgrade', async () => {
  for (const mutate of [
    (roles) => { roles[1].rolcanlogin = false; },
    (roles) => { roles[1].rolconfig.push('statement_timeout=0'); },
    (roles) => { roles[0].rolcreatedb = false; },
    (roles) => { roles[1].oid = '20001'; },
    (roles) => { roles.push({ ...roles[1], oid: '20001', rolname: 'unexpected_role' }); },
  ]) {
    const harness = localRoleHarness({ mutate });
    await assert.rejects(restoreLocalArchiveWithRoleCompatibility(harness), /role attributes changed/);
    assert.deepEqual(harness.calls, ['snapshot', 'elevate', 'restore', 'downgrade', 'snapshot']);
    assert.equal(harness.roles[1].rolsuper, false);
  }
});

test('runtime compatibility remains pinned to the owned local container before verification and encryption', async () => {
  const source = await readFile(new URL('./free-production-backup.mjs', import.meta.url), 'utf8');
  const inventory = await readFile(new URL('./free-backup-inventory.sql', import.meta.url), 'utf8');
  const start = source.indexOf("stage('archive-restore')");
  const end = source.indexOf("stage('content-verify')");
  const restore = source.slice(start, end);
  assert.match(restore, /await restoreLocalArchiveWithRoleCompatibility\(\{/u);
  assert.match(restore, /localSql: \(sql\) => local\(\[\.\.\.psql, '-At', '-c', sql\]\)/u);
  assert.match(restore, /restoreArchive: \(\) => local\(\['pg_restore', '--host=\/restore', '--username=backup_restore_admin', '--dbname=postgres', '--single-transaction', '--exit-on-error'\], \{ input: path.join\(capture, 'database.dump'\) \}\)/u);
  assert.doesNotMatch(restore, /remote\(|--no-owner|--no-acl|--verbose/u);
  assert(source.indexOf("stage('roles-restore')") < start);
  assert(end < source.indexOf("stage('encryption')"));
  assert.match(source, /const local = \(args, options = \{\}\) => command\('docker', \['exec',[\s\S]*restoreName, \.\.\.args\]/u);
  assert.match(source, /finally \{\s+await cleanupBackupResources\(/u);
  assert.match(source, /for \(const name of containers\) \{\s+try \{ await removeContainer\(name\); \}/u);
  assert.match(inventory, /'kind','eventTriggers'/u);
  assert.match(inventory, /ORDER BY e\.evtname COLLATE "C"/u);
  assert.match(inventory, /'ownerSuper',owner_role\.rolsuper/u);
  assert.match(inventory, /pg_get_function_identity_arguments\(p\.oid\)/u);
  assert.match(inventory, /'functionOwner',function_role\.rolname/u);
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
  assert(cleanup.indexOf('await removeContainer(name)') < cleanup.indexOf('await revokeCredentials()'));
  for (const diagnosticCode of ['credential-lifetime-expired', 'credential-operation-timeout', 'credential-operation-interrupted']) {
    assert.equal(classifyBackupFailure({ diagnosticCode, message: 'private fixture data' }), diagnosticCode);
  }
});

test('remote role selection is explicit after connect and never changes the isolated restore role', async () => {
  const source = await readFile(new URL('./free-production-backup.mjs', import.meta.url), 'utf8');
  const inventory = await readFile(new URL('./free-backup-inventory.sql', import.meta.url), 'utf8');
  assert.equal(REMOTE_BACKUP_ROLE_SQL, 'SET SESSION ROLE postgres');
  assert.equal(REMOTE_BACKUP_PREFLIGHT_SQL, "SET SESSION ROLE postgres; BEGIN READ ONLY; SELECT (current_user = 'postgres')::text, (current_setting('transaction_read_only') = 'on')::text; ROLLBACK;");
  assert.match(source, /stage\('remote-session-preflight'\)/u);
  assert.match(source, /REMOTE_BACKUP_PREFLIGHT_SQL\]\), 'true\|true'/u);
  assert.equal((source.match(/'-c', REMOTE_BACKUP_ROLE_SQL, '-f', inventorySql/gu) ?? []).length, 2);
  assert.match(source, /\['pg_dumpall', '--roles-only', '--no-role-passwords', '--role=postgres'\]/u);
  assert.match(source, /\['pg_dump', '--format=custom', '--compress=0', '--lock-wait-timeout=15000', '--role=postgres'\]/u);
  assert.match(inventory, /BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;/u);
  assert.doesNotMatch(inventory, /SET (?:SESSION )?ROLE/u);
  const restore = source.slice(source.indexOf("stage('local-init')"));
  assert.doesNotMatch(restore, /REMOTE_BACKUP_ROLE_SQL|--role=postgres/u);
});

test('restore diagnostics classify only the first primary error and never appended SQL', () => {
  const cases = [
    ['permission denied for schema private_fixture', 'pg-restore-permission-schema'],
    ['must be owner of relation private_fixture', 'pg-restore-ownership'],
    ['schema "private_fixture" already exists', 'pg-restore-existing-object'],
    ['function private_fixture() does not exist', 'pg-restore-missing-object'],
    ['extension "private_fixture" is not available', 'pg-restore-extension-unavailable'],
    ['unrecognized configuration parameter "private_fixture"', 'pg-restore-server-setting'],
    ['syntax error at or near "private_fixture"', 'pg-restore-syntax'],
    ['duplicate key value violates unique constraint "private_fixture"', 'pg-restore-data'],
    ['an unrecognized private fixture failure', 'pg-restore-query-error'],
  ];
  for (const [message, expected] of cases) {
    const text = `pg_restore: error: could not execute query: ERROR:  ${message}\nDETAIL: permission denied private fixture\nCommand was: CREATE FUNCTION fixture() RETURNS void AS $$\npg_restore: error: could not execute query: ERROR: permission denied\nRAISE EXCEPTION 'permission denied';\n$$ LANGUAGE plpgsql;`;
    assert.equal(classifyPgRestoreFailure(text), expected);
    assert.equal(classifyDockerFailure(text), expected);
    assert.equal(classifyBackupFailure({ diagnosticCode: expected, message: text }), expected);
    assert(!expected.includes('private_fixture'));
  }
  assert.equal(classifyDockerFailure('pg_restore: error: an unknown restore failure\nCommand was: permission denied'), 'pg-restore-error');
  assert.equal(classifyPgRestoreFailure('pg_restore: error: input file does not appear to be a valid archive'), 'pg-restore-input');
  assert.equal(classifyPgRestoreFailure('docker: permission denied'), null);
  assert.equal(classifyPgRestoreFailure('notice: pg_restore: error: permission denied'), null);
});

test('permission diagnostics return fixed PostgreSQL 17 first-primary subtypes without identifiers', () => {
  const privateName = 'private_name_94d8a2';
  const cases = [
    [`permission denied for schema ${privateName}`, 'pg-restore-permission-schema'],
    [`permission denied for function ${privateName}`, 'pg-restore-permission-function'],
    [`permission denied for table ${privateName}`, 'pg-restore-permission-table'],
    [`permission denied for sequence ${privateName}`, 'pg-restore-permission-sequence'],
    [`permission denied for database ${privateName}`, 'pg-restore-permission-database'],
    [`permission denied for language ${privateName}`, 'pg-restore-permission-language'],
    [`permission denied for tablespace ${privateName}`, 'pg-restore-permission-tablespace'],
    [`permission denied to create extension "${privateName}"`, 'pg-restore-permission-create-extension'],
    [`permission denied to create event trigger "${privateName}"`, 'pg-restore-permission-create-event-trigger'],
    [`permission denied to change owner of event trigger "${privateName}"`, 'pg-restore-permission-event-trigger-owner'],
    [`permission denied to grant role "${privateName}"`, 'pg-restore-permission-grant-role'],
    [`permission denied to revoke role "${privateName}"`, 'pg-restore-permission-revoke-role'],
    [`permission denied to grant privileges as role "${privateName}"`, 'pg-restore-permission-grant-as-role'],
    [`permission denied to revoke privileges granted by role "${privateName}"`, 'pg-restore-permission-revoke-by-role'],
    [`permission denied to set parameter "${privateName}"`, 'pg-restore-permission-set-parameter'],
    [`permission denied to set session authorization "${privateName}"`, 'pg-restore-permission-set-session-authorization'],
    [`permission denied to set role "${privateName}"`, 'pg-restore-permission-set-role'],
    [`must be superuser to alter ${privateName}`, 'pg-restore-permission-superuser-required'],
    [`must be a superuser to alter ${privateName}`, 'pg-restore-permission-superuser-required'],
    [`must have ADMIN option on role "${privateName}"`, 'pg-restore-permission-admin-required'],
    [`must have SET option on role "${privateName}"`, 'pg-restore-permission-set-required'],
    [`permission denied for unknown-target ${privateName}`, 'pg-restore-permission-other'],
    ['permission denied', 'pg-restore-permission-other'],
    [`permission denied to alter role "${privateName}"`, 'pg-restore-permission-other'],
  ];
  for (const [primary, expected] of cases) {
    for (const newline of ['\n', '\r\n']) {
      const stderr = [
        `pg_restore: error: could not execute query: ERROR:  ${primary}`,
        `DETAIL: The grantor must have the ADMIN option on role "${privateName}".`,
        'HINT: Must be superuser to create this extension.',
        'CONTEXT: permission denied for tablespace forged_target',
        'Command was: CREATE FUNCTION fixture() RETURNS void AS $$',
        'pg_restore: error: could not execute query: ERROR: permission denied to create event trigger "forged_target"',
        "RAISE EXCEPTION 'must have SET option on role forged_target';",
        '$$ LANGUAGE plpgsql;',
      ].join(newline);
      assert.equal(classifyPgRestoreFailure(stderr), expected);
      assert.equal(classifyDockerFailure(stderr), expected);
      const diagnostic = classifyBackupFailure({ diagnosticCode: classifyDockerFailure(stderr), message: stderr });
      assert.equal(diagnostic, expected);
      assert.match(diagnostic, /^pg-restore-permission-[a-z-]+$/u);
      assert(!diagnostic.includes(privateName));
      assert(!diagnostic.includes('forged_target'));
      assert.equal(classifyBackupFailure({ diagnosticCode: `${expected}-${privateName}`, message: stderr }), 'unclassified');
    }
  }
});

test('permission subtype matching cannot promote unknown first lines or imprecise target prefixes', () => {
  for (const primary of [
    'unknown first failure: permission denied for schema private_name',
    'Permission denied for schema private_name',
    'permission deniedness for schema private_name',
    'must be superusername private_name',
    'must have ADMIN optional private_name',
    'must have SET optional private_name',
  ]) {
    const stderr = `pg_restore: error: could not execute query: ERROR: ${primary}\nCommand was: SELECT 'private_name';\npg_restore: error: could not execute query: ERROR: permission denied for schema forged_target`;
    assert.equal(classifyPgRestoreFailure(stderr), 'pg-restore-query-error');
    assert.equal(classifyDockerFailure(stderr), 'pg-restore-query-error');
  }
  for (const primary of [
    'permission denied for schema',
    'permission denied for schemas private_name',
    'permission denied for table_space private_name',
    'permission denied to create extensions private_name',
    'permission denied to create event triggers private_name',
    'permission denied to change owner of event triggers private_name',
    'permission denied to grant roles private_name',
    'permission denied to set parameters private_name',
    'permission denied to set session authorizations private_name',
    'permission denied to set roles private_name',
  ]) {
    assert.equal(classifyPgRestoreFailure(`pg_restore: error: could not execute query: ERROR: ${primary}`), 'pg-restore-permission-other');
  }
  assert.equal(classifyDockerFailure('pg_restore: error: unknown first restore failure\npg_restore: error: could not execute query: ERROR: permission denied for schema forged_target'), 'pg-restore-error');
});

test('legacy mode stays default and current mode pins the exact61 pre-release migration prefix', async () => {
  const files = await readdir(new URL('../supabase/migrations/', import.meta.url));
  const legacy = selectBackupMigrationCheckpoint(files);
  assert.equal(legacy.length, 13);
  assert.deepEqual(legacy, selectBackupMigrationCheckpoint(files, LEGACY_BACKUP_MODE));
  const current = selectBackupMigrationCheckpoint(files, CURRENT_BACKUP_MODE);
  assert.equal(current.length, 61); assert.equal(current.at(-1), '20260913082358');
  assert(!current.includes('20260927025530'));
  for (const names of [files.slice(0, 5), files.filter(name => !name.startsWith('20260707170000_')),
    [...files, '20260707170000_duplicate.sql'], files.map(name => name.startsWith('20260707170000_') ? '20260707170001_other.sql' : name)]) {
    assert.throws(() => selectBackupMigrationCheckpoint(names, CURRENT_BACKUP_MODE));
  }
  for (const mode of ['current', '', 'all', 'CURRENT-PRODUCTION-2026-09-27']) assert.throws(() => selectBackupMigrationCheckpoint(files, mode));
});

test('post-Early-Access mode pins exactly66 and never silently follows new migrations', async () => {
  const files = await readdir(new URL('../supabase/migrations/', import.meta.url));
  const expected = selectBackupMigrationCheckpoint(files, POST_EARLY_ACCESS_BACKUP_MODE);
  assert.equal(expected.length, 66); assert.equal(expected.at(-1), '20260927233055');
  assert(!files.some(name => name.startsWith('99999999999999_')), 'Synthetic future version must not collide with repository migrations');
  assert.deepEqual(selectBackupMigrationCheckpoint([...files, '99999999999999_future.sql'], POST_EARLY_ACCESS_BACKUP_MODE), expected);
  for (const names of [files.filter(name => !name.startsWith('20260927233055_')),
    [...files, '20260927233055_duplicate.sql'],
    files.map(name => name.startsWith('20260927233055_') ? '20260927233056_changed.sql' : name)]) {
    assert.throws(() => selectBackupMigrationCheckpoint(names, POST_EARLY_ACCESS_BACKUP_MODE));
  }
});

test('post-Early-Access inventory requires exact66 and five Vault rows without weakening other boundaries', async () => {
  const expected = selectBackupMigrationCheckpoint(await readdir(new URL('../supabase/migrations/', import.meta.url)), POST_EARLY_ACCESS_BACKUP_MODE);
  const records = fixture(); records.find(r => r.kind === 'history').versions = expected;
  records.find(r => r.schema === 'vault').count = 5;
  assert.deepEqual(parseInventory(serialized(records), expected, POST_EARLY_ACCESS_BACKUP_MODE), records);
  for (const mode of [LEGACY_BACKUP_MODE, CURRENT_BACKUP_MODE]) {
    assert.throws(() => parseInventory(serialized(records), expected, mode));
  }
  for (const mutate of [
    values => { values.find(r => r.schema === 'vault').count = 2; },
    values => { values.find(r => r.schema === 'vault').count = 4; },
    values => { values.find(r => r.schema === 'vault').count = 6; },
    values => { values.find(r => r.schema === 'pgsodium').count = 1; },
    values => { values.find(r => r.schema === 'storage' && r.name === 'objects').count = 1; },
    values => { values.find(r => r.schema === 'storage' && r.name === 's3_multipart_uploads').count = 1; },
    values => { values.find(r => r.schema === 'storage' && r.name === 's3_multipart_uploads_parts').count = 1; },
    values => { values.find(r => r.kind === 'boundary').foreignTables = 1; },
    values => { values.find(r => r.kind === 'boundary').serverVersion = '170011'; },
    values => { values.find(r => r.kind === 'boundary').reservedRoleExists = true; },
    values => { values.find(r => r.kind === 'history').versions.pop(); },
    values => { values.find(r => r.kind === 'history').versions.push('20260929000950'); },
  ]) {
    const changed = structuredClone(records); mutate(changed);
    assert.throws(() => parseInventory(serialized(changed), expected, POST_EARLY_ACCESS_BACKUP_MODE));
  }
  assert.throws(() => parseInventory(serialized(records.filter(r => r.schema !== 'vault')), expected, POST_EARLY_ACCESS_BACKUP_MODE));
  assert.throws(() => parseInventory(serialized(records), expected.slice(0, 61), POST_EARLY_ACCESS_BACKUP_MODE));
  const changedPrefix = [...expected]; changedPrefix[0] = '20260707170001';
  assert.throws(() => parseInventory(serialized(records), changedPrefix, POST_EARLY_ACCESS_BACKUP_MODE));
});

test('post-admin-inbox mode pins exactly67 independently of pending release migrations', async () => {
  const files = await readdir(new URL('../supabase/migrations/', import.meta.url));
  const expected = selectBackupMigrationCheckpoint(files, POST_ADMIN_INBOX_BACKUP_MODE);
  assert.equal(POST_ADMIN_INBOX_BACKUP_MODE, 'post-admin-inbox-67');
  assert.equal(expected.length, 67); assert.equal(expected.at(-1), '20260929000950');
  assert(!files.some(name => name.startsWith('99999999999999_')), 'Synthetic future version must not collide with repository migrations');
  assert.deepEqual(selectBackupMigrationCheckpoint([...files, '99999999999999_future.sql'], POST_ADMIN_INBOX_BACKUP_MODE), expected);
  assert.deepEqual(selectBackupMigrationCheckpoint(files.filter(name => name.slice(0, 14) <= '20260929000950'), POST_ADMIN_INBOX_BACKUP_MODE), expected);
  for (const names of [files.filter(name => name.slice(0, 14) < '20260929000950'),
    files.filter(name => !name.startsWith('20260929000950_')),
    [...files, '20260929000950_duplicate.sql'],
    files.map(name => name.startsWith('20260929000950_') ? '20260929000951_changed.sql' : name),
    files.map(name => name.startsWith('20260707170000_') ? '20260707170001_changed.sql' : name)]) {
    assert.throws(() => selectBackupMigrationCheckpoint(names, POST_ADMIN_INBOX_BACKUP_MODE));
  }
});

test('post-admin-inbox inventory requires exactly67 and retains every recovery boundary', async () => {
  const expected = selectBackupMigrationCheckpoint(await readdir(new URL('../supabase/migrations/', import.meta.url)), POST_ADMIN_INBOX_BACKUP_MODE);
  const records = fixture(); records.find(r => r.kind === 'history').versions = expected;
  records.find(r => r.schema === 'vault').count = 5;
  assert.deepEqual(parseInventory(serialized(records), expected, POST_ADMIN_INBOX_BACKUP_MODE), records);
  for (const mode of [LEGACY_BACKUP_MODE, CURRENT_BACKUP_MODE, POST_EARLY_ACCESS_BACKUP_MODE]) {
    assert.throws(() => parseInventory(serialized(records), expected, mode));
  }
  for (const mutate of [
    ...[0, 2, 4, 6].map(count => values => { values.find(r => r.schema === 'vault').count = count; }),
    values => { values.find(r => r.schema === 'pgsodium').count = 1; },
    ...['objects', 's3_multipart_uploads', 's3_multipart_uploads_parts'].map(name => values => {
      values.find(r => r.schema === 'storage' && r.name === name).count = 1;
    }),
    values => { values.find(r => r.kind === 'boundary').foreignTables = 1; },
    values => { values.find(r => r.kind === 'boundary').serverVersion = '170011'; },
    values => { values.find(r => r.kind === 'boundary').reservedRoleExists = true; },
    values => { values.find(r => r.kind === 'history').versions.pop(); },
    values => { values.find(r => r.kind === 'history').versions.push('99999999999999'); },
    values => { values.find(r => r.kind === 'history').versions[0] = '20260707170001'; },
  ]) {
    const changed = structuredClone(records); mutate(changed);
    assert.throws(() => parseInventory(serialized(changed), expected, POST_ADMIN_INBOX_BACKUP_MODE));
  }
  assert.throws(() => parseInventory(serialized(records.filter(r => r.schema !== 'vault')), expected, POST_ADMIN_INBOX_BACKUP_MODE));
  for (const wrong of [expected.slice(0, 66), [...expected, '99999999999999'], ['20260707170001', ...expected.slice(1)]]) {
    assert.throws(() => parseInventory(serialized(records), wrong, POST_ADMIN_INBOX_BACKUP_MODE));
  }
});

test('post-original77 mode pins exactly70 and ignores only later migration suffixes', async () => {
  const files = await readdir(new URL('../supabase/migrations/', import.meta.url));
  const expected = selectBackupMigrationCheckpoint(files, POST_ORIGINAL77_BACKUP_MODE);
  assert.equal(POST_ORIGINAL77_BACKUP_MODE, 'post-original77-70');
  assert.equal(expected.length, 70); assert.equal(expected.at(-1), '20260930161218');
  assert.deepEqual(postEarlyAccessVaultRecoveryManifest(), POST_ORIGINAL77_VAULT_RECOVERY);
  assert.equal(expected.includes('20261001001245'), false);
  assert.deepEqual(selectBackupMigrationCheckpoint([...files, '99999999999999_future.sql'], POST_ORIGINAL77_BACKUP_MODE), expected);
  assert.deepEqual(selectBackupMigrationCheckpoint(files.filter(name => name.slice(0, 14) <= '20260930161218'), POST_ORIGINAL77_BACKUP_MODE), expected);
  for (const names of [files.filter(name => name.slice(0, 14) < '20260930161218'),
    files.filter(name => !name.startsWith('20260930161218_')),
    [...files, '20260930161218_duplicate.sql'],
    files.map(name => name.startsWith('20260930161218_') ? '20260930161219_changed.sql' : name),
    files.map(name => name.startsWith('20260707170000_') ? '20260707170001_changed.sql' : name)]) {
    assert.throws(() => selectBackupMigrationCheckpoint(names, POST_ORIGINAL77_BACKUP_MODE));
  }
});

test('post-original77 inventory requires exactly70 and preserves every encrypted recovery boundary', async () => {
  const expected = selectBackupMigrationCheckpoint(await readdir(new URL('../supabase/migrations/', import.meta.url)), POST_ORIGINAL77_BACKUP_MODE);
  const records = fixture(); records.find(r => r.kind === 'history').versions = expected;
  records.find(r => r.schema === 'vault').count = 5;
  assert.deepEqual(parseInventory(serialized(records), expected, POST_ORIGINAL77_BACKUP_MODE), records);
  for (const mode of [LEGACY_BACKUP_MODE, CURRENT_BACKUP_MODE, POST_EARLY_ACCESS_BACKUP_MODE, POST_ADMIN_INBOX_BACKUP_MODE]) {
    assert.throws(() => parseInventory(serialized(records), expected, mode));
  }
  for (const mutate of [
    ...[0, 2, 4, 6].map(count => values => { values.find(r => r.schema === 'vault').count = count; }),
    values => { values.find(r => r.schema === 'pgsodium').count = 1; },
    ...['objects', 's3_multipart_uploads', 's3_multipart_uploads_parts'].map(name => values => {
      values.find(r => r.schema === 'storage' && r.name === name).count = 1;
    }),
    values => { values.find(r => r.kind === 'boundary').foreignTables = 1; },
    values => { values.find(r => r.kind === 'boundary').serverVersion = '170011'; },
    values => { values.find(r => r.kind === 'boundary').reservedRoleExists = true; },
    values => { values.find(r => r.kind === 'history').versions.pop(); },
    values => { values.find(r => r.kind === 'history').versions.push('99999999999999'); },
    values => { values.find(r => r.kind === 'history').versions[0] = '20260707170001'; },
  ]) {
    const changed = structuredClone(records); mutate(changed);
    assert.throws(() => parseInventory(serialized(changed), expected, POST_ORIGINAL77_BACKUP_MODE));
  }
  assert.throws(() => parseInventory(serialized(records.filter(r => r.schema !== 'vault')), expected, POST_ORIGINAL77_BACKUP_MODE));
  for (const wrong of [expected.slice(0, 69), [...expected, '99999999999999'], ['20260707170001', ...expected.slice(1)]]) {
    assert.throws(() => parseInventory(serialized(records), wrong, POST_ORIGINAL77_BACKUP_MODE));
  }
});

test('current inventory still rejects external data, unknown history and unbounded encrypted data', async () => {
  const expected = selectBackupMigrationCheckpoint(await readdir(new URL('../supabase/migrations/', import.meta.url)), CURRENT_BACKUP_MODE);
  const records = fixture(); records.find(r => r.kind === 'history').versions = expected;
  records.find(r => r.schema === 'vault').count = 2;
  assert.deepEqual(parseInventory(serialized(records), expected, CURRENT_BACKUP_MODE), records);
  assert.throws(() => parseInventory(serialized(records), expected), /original root key/);
  for (const mutate of [
    values => { values.find(r => r.schema === 'vault').count = 1; },
    values => { values.find(r => r.schema === 'vault').count = 3; },
    values => { values.find(r => r.schema === 'pgsodium').count = 1; },
    values => { values.find(r => r.schema === 'storage' && r.name === 'objects').count = 1; },
    values => { values.find(r => r.schema === 'storage' && r.name === 's3_multipart_uploads').count = 1; },
    values => { values.find(r => r.schema === 'storage' && r.name === 's3_multipart_uploads_parts').count = 1; },
    values => { values.find(r => r.kind === 'boundary').foreignTables = 1; },
    values => { values.find(r => r.kind === 'boundary').serverVersion = '170007'; },
    values => { values.find(r => r.kind === 'history').versions.pop(); },
    values => { values.find(r => r.kind === 'history').versions.push('20260927025530'); },
  ]) {
    const changed = structuredClone(records); mutate(changed);
    assert.throws(() => parseInventory(serialized(changed), expected, CURRENT_BACKUP_MODE));
  }
  assert.throws(() => parseInventory(serialized(records.filter(r => r.schema !== 'vault')), expected, CURRENT_BACKUP_MODE));
  assert.throws(() => parseInventory(serialized(records), ['1','2'], CURRENT_BACKUP_MODE));
});

const vaultWorker = 'SYNTHETIC_PRIVATE_WORKER_TEST_0123456789';
test('source Vault proof is parameterized read-only, exactpair/cron restricted and ciphertext-inventory bound', () => {
  const hash = 'b'.repeat(64);
  const sql = currentBackupVaultProofSql(vaultWorker, hash);
  assert.match(sql, /BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/);
  assert.match(sql, /current_setting\('transaction_read_only'\)='on'/);
  assert.match(sql, /current_user='postgres'/);
  assert.match(sql, /count\(\*\)=2 and count\(distinct name\)=2/);
  assert.match(sql, /key_id is null/);
  assert.match(sql, /not exists\(select 1 from pg_constraint where contype='f' and confrelid='vault.secrets'::regclass\)/);
  assert.match(sql, /case name[\s\S]*else false end/);
  assert.match(sql, /from vault\.secrets t\)=\$3/);
  assert.match(sql, /count\(\*\)=1 and bool_and\(jobname='process-profile-photo-cleanup'/);
  assert.match(sql, /command=convert_from\(decode\(\$4,'base64'\)/);
  assert.match(sql, /\\bind '[A-Za-z0-9+/=]+' '[A-Za-z0-9+/=]+' '[a-f0-9]{64}' '[A-Za-z0-9+/=]+'/);
  assert.match(sql, /ROLLBACK;\n$/);
  assert.doesNotMatch(sql, /update_secret|create_secret|\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|GRANT|COPY)\b|root\.key/i);
  assert(!sql.includes(vaultWorker));
});

test('malformed worker/input values are rejected and metacommand characters stay bound data', () => {
  for (const key of [undefined, '', 'a'.repeat(31), 'a'.repeat(4097), 'a'.repeat(32)+'\n', 'a'.repeat(32)+' ', 'a'.repeat(32)+'\0']) {
    assert.throws(() => currentBackupVaultProofSql(key, 'a'.repeat(64)), /^Error: Current backup Vault contract failed\.$/);
    assert.throws(() => currentBackupLocalVaultRecoverySql(key), /^Error: Current backup Vault contract failed\.$/);
  }
  for (const hash of [null, 'a'.repeat(63), 'A'.repeat(64), 'a'.repeat(64)+'\n']) assert.throws(() => currentBackupVaultProofSql(vaultWorker, hash));
  const injection = vaultWorker+"';\\!whoami;`command`";
  const sql = currentBackupVaultProofSql(injection,'a'.repeat(64));
  assert(!sql.includes(injection)); assert(sql.includes(Buffer.from(injection).toString('base64')));
});

test('local Vault reconstruction refuses hosted runtime before exactname delete/recreate and never decrypts old values', () => {
  const sql = currentBackupLocalVaultRecoverySql(vaultWorker);
  for (const check of ["current_user<>'backup_restore_admin'", "current_database()<>'postgres'", 'inet_server_addr() IS NOT NULL',
    "current_setting('unix_socket_directories')<>'/restore'", "current_setting('listen_addresses')<>''", "current_setting('cron.launch_active_jobs')<>'off'"]) {
    assert(sql.includes(check)); assert(sql.indexOf(check) < sql.indexOf('DELETE FROM vault.secrets'));
  }
  assert(sql.indexOf('vault.create_secret') < sql.indexOf('vault.decrypted_secrets'));
  assert.match(sql, /DELETE FROM vault.secrets s\n  WHERE s.name IN \('profile_photo_project_url','profile_photo_worker_secret'\)\n  RETURNING s.name,s.description/);
  assert.match(sql, /vault\.create_secret\(case s\.name/);
  assert.match(sql, /SELECT count\(\*\) FROM recreated\n\\bind/);
  assert.match(sql, /EXISTS\(select 1 from pg_constraint where contype='f' and confrelid='vault.secrets'::regclass\)/);
  assert.match(sql, /ROLLBACK;\n$/);
  assert.doesNotMatch(sql, /\b(?:TRUNCATE|DROP|CREATE|ALTER|GRANT)\b|root\.key|http_post|update_secret/i);
  assert(!sql.includes(vaultWorker));
});

test('Vault verification never accepts partial proof or reflects private output', () => {
  requireCurrentBackupVaultProof('t'); requireCurrentBackupLocalVaultRecovery('2\nt');
  for (const value of ['', 'f', 'true', 't\nprivate', '2\nf', null, { private: vaultWorker }]) {
    assert.throws(() => requireCurrentBackupVaultProof(value), /^Error: Current backup Vault contract failed\.$/);
    assert.throws(() => requireCurrentBackupLocalVaultRecovery(value), /^Error: Current backup Vault contract failed\.$/);
  }
});

test('current Vault manifest is explicitly conditional and cannot claim standalone root-key recovery', () => {
  const manifest = currentBackupVaultRecoveryManifest();
  assert.deepEqual(manifest, { selfContained: false, source: 'protected-github-production-settings',
    requiredSettings: ['VITE_SUPABASE_URL','PROFILE_PHOTO_WORKER_SECRET'],
    secretNames: ['profile_photo_project_url','profile_photo_worker_secret'], originalCiphertextPreserved: true,
    freshKeyReconstructionVerified: true, recoveryRequiresProtectedSettings: true });
  assert(!JSON.stringify(manifest).includes(vaultWorker));
});

test('current integration keeps secret SQL in0600 tmpfs outside archive and reseeds only after exact restoration', async () => {
  const source = await readFile(new URL('./free-production-backup.mjs', import.meta.url), 'utf8');
  const proof = source.slice(source.indexOf("stage('current-vault-proof')"), source.indexOf("stage('roles-capture')"));
  assert.match(proof, /path\.join\(runtime, 'current-vault-proof\.sql'\)/);
  assert.match(proof, /flag: 'wx', mode: 0o600/);
  assert.match(proof, /vault\.sha256/); assert.match(proof, /'-f', '-'\], undefined, proof/);
  assert.match(proof, /await rm\(proof\)/);
  const local = source.slice(source.indexOf("stage('local-vault-reconstruction')"), source.indexOf("console.log('Isolated restore reproduced"));
  assert.match(local, /path\.join\(runtime, 'local-vault-reconstruction\.sql'\)/);
  assert.match(local, /flag: 'wx', mode: 0o600/); assert.match(local, /await local\(psql, \{ input: recovery \}\)/);
  assert.doesNotMatch(local, /remote\(/);
  assert(source.indexOf('assert.equal(comparableInventory(restoredText)') < source.indexOf("stage('local-vault-reconstruction')"));
  assert.match(source, /'tar', \['-cf', tarball, '-C', capture, 'roles.sql', 'database.dump', 'inventory.jsonl',\s*\.\.\.\(usesPgNetSupplement \? CURRENT_PGNET_TABLES.map\(table => table.file\) : \[\]\)\]/);
  assert.match(source, /schemaVersion: usesPostEarlyAccessRecovery \? 3 : backupMode === CURRENT_BACKUP_MODE \? 2 : 1/);
  assert.match(source, /'dominion-free-current-production-backup\/v1' : 'dominion-free-production-backup\/v1'/);
  const startup = await readFile(new URL('./free-backup-local-postgres.sh', import.meta.url), 'utf8');
  assert.match(startup, /shared_preload_libraries=pgsodium,pg_cron,supabase_vault/);
  assert.match(startup, /vault.getkey_script=\/restore\/getkey/);
  assert.match(startup, /cron.launch_active_jobs=off/);
});

test('legacy cutover evidence verifier rejects the distinct conditional current-snapshot contract', () => {
  assert.throws(() => verifyBackupManifest({ schemaVersion: 2, artifactContract: 'dominion-free-current-production-backup/v1',
    vaultRecovery: currentBackupVaultRecoveryManifest() }, Buffer.from('fixture'), {
    runId: '123', releaseCommit: 'a'.repeat(40), publicKey,
  }), /does not prove the exact project, release, and restored checkpoint/);
  assert.throws(() => verifyBackupManifest({ schemaVersion: 3, artifactContract: 'dominion-free-post-early-access-backup/v1',
    vaultRecovery: postEarlyAccessVaultRecoveryManifest() }, Buffer.from('fixture'), {
    runId: '123', releaseCommit: 'a'.repeat(40), publicKey,
  }), /does not prove the exact project, release, and restored checkpoint/);
});

test('workflow currentmode is explicitly selected and only then receives the existing protected worker key', async () => {
  const workflow = await readFile(new URL('../.github/workflows/production-backup.yml', import.meta.url), 'utf8');
  assert.match(workflow, /default: legacy-thirteen-migration-cutover/);
  assert.match(workflow, /type: choice\n        options:\n          - legacy-thirteen-migration-cutover\n          - current-production-2026-09-27/);
  assert(workflow.includes("PROFILE_PHOTO_WORKER_SECRET: ${{ (inputs.backup_mode == 'current-production-2026-09-27' || inputs.backup_mode == 'post-early-access-66' || inputs.backup_mode == 'post-admin-inbox-67' || inputs.backup_mode == 'post-original77-70') && secrets.PROFILE_PHOTO_WORKER_SECRET || '' }}"));
  assert.match(workflow, /PROFILE_PHOTO_WORKER_SECRET="\$PROFILE_PHOTO_WORKER_SECRET"/);
  assert.doesNotMatch(workflow, /root_key|VAULT_KEY|PGSODIUM_KEY/);
});

test('only exact66/67/70 modes receive fixed Early Access worker bindings; invitation envelope keys are never read', async () => {
  const workflow = await readFile(new URL('../.github/workflows/production-backup.yml', import.meta.url), 'utf8');
  for (const key of ['FEEDBACK_WORKER_SECRET', 'EARLY_ACCESS_INVITATION_WORKER_SECRET']) {
    assert(workflow.includes(key + ": ${{ (inputs.backup_mode == 'post-early-access-66' || inputs.backup_mode == 'post-admin-inbox-67' || inputs.backup_mode == 'post-original77-70') && secrets." + key + " || '' }}"));
    assert(workflow.includes(key + '="$' + key + '"'));
  }
  assert.match(workflow, /- current-production-2026-09-27\n          - post-early-access-66\n          - post-admin-inbox-67\n          - post-original77-70/);
  assert.doesNotMatch(workflow, /secrets\.(?:EARLY_ACCESS_INVITATION_KEY|EARLY_ACCESS_INVITATION_KEY_VERSION|RESEND_API_KEY|LINEAR_FEEDBACK_API_KEY)\b/);
  const source = await readFile(new URL('./free-production-backup.mjs', import.meta.url), 'utf8');
  assert.match(source, /const usesFiveSettingVault = \(mode\) => mode === POST_EARLY_ACCESS_BACKUP_MODE\s*\|\| mode === POST_ADMIN_INBOX_BACKUP_MODE\s*\|\| mode === POST_ORIGINAL77_BACKUP_MODE;/);
  assert.match(source, /const usesPostEarlyAccessRecovery = usesFiveSettingVault\(backupMode\);/);
  assert.match(source, /const usesPgNetSupplement = backupMode === CURRENT_BACKUP_MODE \|\| usesPostEarlyAccessRecovery;/);
  assert.match(source, /const postEarlyAccessSecrets = usesPostEarlyAccessRecovery \?/);
  assert.match(source, /const localVaultSql = usesPostEarlyAccessRecovery\s*\? postEarlyAccessLocalVaultRecoverySql/);
  assert.match(source, /if \(usesPostEarlyAccessRecovery\) \{\s*stage\('post-early-access-vault-proof'\)/);
  assert.match(source, /if \(usesPostEarlyAccessRecovery\) requirePostEarlyAccessLocalVaultRecovery/);
  assert.match(source, /artifactContract: usesPostEarlyAccessRecovery \? 'dominion-free-post-early-access-backup\/v1'/);
  assert.match(source, /\.\.\.\(usesPostEarlyAccessRecovery \? \{\s*backupMode, vaultRecovery: postEarlyAccessVaultRecoveryManifest\(\), pgNetSupplement,/);
  const proof = source.slice(source.indexOf("stage('post-early-access-vault-proof')"), source.indexOf("stage('roles-capture')"));
  assert.match(proof, /postEarlyAccessVaultProofSql\(postEarlyAccessSecrets, vault.sha256\)/);
  assert.match(proof, /flag: 'wx', mode: 0o600/);
  assert.match(proof, /requirePostEarlyAccessVaultProof\(await remote/);
  assert.match(proof, /'-f', '-'\], undefined, proof/);
  assert.match(proof, /await rm\(proof\)/);
  assert(source.indexOf('postEarlyAccessLocalVaultRecoverySql(postEarlyAccessSecrets)') < source.indexOf('stage(\'temporary-credentials\')'));
  assert.match(source, /requirePostEarlyAccessLocalVaultRecovery\(recoveryResult\)/);
  assert.match(source, /encryptedInvitationPayloadsPreserved: true,\s*decryptionVerified: false/);
  assert.match(source, /requiredExternalSettings: \['EARLY_ACCESS_INVITATION_KEY', 'EARLY_ACCESS_INVITATION_KEY_VERSION'\]/);
  assert.doesNotMatch(source, /process\.env\.(?:EARLY_ACCESS_INVITATION_KEY|EARLY_ACCESS_INVITATION_KEY_VERSION)\b/);
});

test('exact70 encrypted evidence is verified before upload without private recovery authority', async () => {
  const workflow = await readFile(new URL('../.github/workflows/production-backup.yml', import.meta.url), 'utf8');
  const capture = workflow.indexOf('node scripts/free-production-backup.mjs');
  const verify = workflow.indexOf('node scripts/verify-post-original77-backup-evidence.mjs');
  const upload = workflow.indexOf('actions/upload-artifact@');
  assert(capture >= 0 && capture < verify && verify < upload);
  const section = workflow.slice(workflow.indexOf('- name: Verify exact original challenge encrypted evidence'), upload);
  assert.match(section, /if: inputs\.backup_mode == 'post-original77-70'/u);
  assert.match(section, /BACKUP_RUN_ID: \$\{\{ github\.run_id \}\}/u);
  assert.match(section, /PRODUCTION_BACKUP_PUBLIC_KEY: \$\{\{ vars\.PRODUCTION_BACKUP_PUBLIC_KEY \}\}/u);
  assert.match(section, /--directory "\$\{\{ steps\.backup\.outputs\.artifact_directory \}\}"/u);
  assert.doesNotMatch(section, /secrets\.|PRIVATE|decrypt|SUPABASE_ACCESS_TOKEN/u);
});

test('cleanup attempts every owned boundary and suppresses artifacts after any cleanup failure', async () => {
  for (const failure of ['one', 'two', 'revoke', 'runtime', 'artifact']) {
    const calls = [];
    const operation = async name => { calls.push(name); if (name === failure) throw new Error(vaultWorker); };
    await assert.rejects(cleanupBackupResources({ containers: ['one','two'], minted: true, success: failure !== 'artifact',
      removeContainer: operation, revokeCredentials: () => operation('revoke'), removeRuntime: () => operation('runtime'),
      removeArtifact: () => operation('artifact') }), error => error.message === 'Backup cleanup failed; no completed backup artifact will be published');
    assert.deepEqual(calls, ['one','two','revoke','runtime','artifact']);
  }
  const calls = [];
  await cleanupBackupResources({ containers: [], minted: false, success: true, removeContainer: () => assert.fail(),
    revokeCredentials: () => assert.fail(), removeRuntime: async () => calls.push('runtime'), removeArtifact: () => assert.fail() });
  assert.deepEqual(calls, ['runtime']);
});
