import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyBackupFailure, classifyDockerFailure, classifyPgRestoreFailure, decryptBackup, encryptBackup, localRestoreRoles, parseInventory, recipientKey, restoreLocalArchiveWithRoleCompatibility, LOCAL_RESTORE_ROLE_SNAPSHOT_SQL, REMOTE_BACKUP_PREFLIGHT_SQL, REMOTE_BACKUP_ROLE_SQL } from './free-production-backup.mjs';

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
  assert.match(source, /finally \{\s+let cleanupFailed = false;\s+for \(const name of containers\) \{\s+try \{ await removeContainer\(name\); \}/u);
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
  assert(cleanup.indexOf('await removeContainer(name)') < cleanup.indexOf('await revokeProductionSupabaseDatabaseCredentials'));
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
