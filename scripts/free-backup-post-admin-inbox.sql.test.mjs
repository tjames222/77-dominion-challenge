import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { POST_ADMIN_INBOX_BACKUP_MODE, POSTGRES_IMAGE, selectBackupMigrationCheckpoint,
  restoreLocalArchiveWithRoleCompatibility } from './free-production-backup.mjs';
import { POST_EARLY_ACCESS_VAULT_NAMES, postEarlyAccessVaultProofSql, postEarlyAccessLocalVaultRecoverySql,
  requirePostEarlyAccessVaultProof, requirePostEarlyAccessLocalVaultRecovery } from './free-backup-post-early-access-vault.mjs';
import { PROFILE_PHOTO_CLEANUP_CRON_COMMAND } from './configure-production-profile-photo-cleanup-cron.mjs';
import { EARLY_ACCESS_WORKER_COMMANDS } from './configure-production-early-access-workers.mjs';
import { CURRENT_PGNET_TABLES, currentBackupPgNetCaptureSql, currentBackupPgNetLocalReplaySql,
  currentBackupPgNetSequence, currentBackupPgNetLocalSequenceSql, currentBackupPgNetManifest } from './free-backup-current-pgnet.mjs';

// A separate exact-67 archive fixture, not an expansion of the frozen 66 fixture.
// Only these three actual migrations need application stubs for catalog capture;
// the 67-entry history models the selected backup boundary, not a full replay of
// all application migrations. No Auth guard/RPC is invoked or real actor used.
const migrationDirectory = new URL('../supabase/migrations/', import.meta.url);
const migrationFiles = [
  '20260813163428_add_account_lifecycle_requests.sql',
  '20260913062841_site_admin_foundation.sql',
  '20260929000950_site_admin_account_requests_inbox.sql',
];
const fixture = `77dc-inbox67-archive-${randomUUID()}`;
const containers = new Map();
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const secrets = Object.freeze({
  profilePhotoWorkerSecret: 'SYNTHETIC_PROFILE_WORKER_' + 'p'.repeat(32),
  feedbackWorkerSecret: 'SYNTHETIC_FEEDBACK_WORKER_' + 'f'.repeat(32),
  invitationWorkerSecret: 'SYNTHETIC_INVITATION_WORKER_' + 'i'.repeat(32),
});
const projectUrl = 'https://mimolwojppbtsbvtqwpo.supabase.co';
const values = [projectUrl, secrets.profilePhotoWorkerSecret, projectUrl, secrets.feedbackWorkerSecret, secrets.invitationWorkerSecret];
const jobNames = ['process-profile-photo-cleanup', 'process-early-access-feedback', 'process-early-access-invitations'];
const commands = [PROFILE_PHOTO_CLEANUP_CRON_COMMAND, ...EARLY_ACCESS_WORKER_COMMANDS];
const ownerAcl = [['postgres', 'postgres', 'EXECUTE', false]];
const expectedFunctions = [
  ['private.require_site_admin(text,uuid,boolean)', '4e98707e44e76b72a7a3b6448cf50c31e7bf85fc70735eb893b75e44d630113f',
    'plpgsql', 'v', 'permission_key text, expected_actor_id uuid, require_recent boolean DEFAULT false', 'uuid', ownerAcl],
  ['private.site_admin_mfa_ready(uuid,uuid,boolean)', '4c51dab04fa4de7f6c8db5c80fd50cb47528ab0e173d83d1b8e99d3e50c4bfa0',
    'sql', 's', 'target_user_id uuid, target_session_id uuid, require_recent boolean DEFAULT false', 'boolean', ownerAcl],
  ['private.site_admin_request_identity(uuid)', 'ed181f29c93e7b2cb347b8e834bf247996523101a7b6ecca5603ab47b441858b',
    'plpgsql', 'v', 'expected_actor_id uuid', 'uuid', ownerAcl],
  ['public.site_admin_list_account_requests(uuid,integer,text,text,text,jsonb)', 'b13ed2cf6c57c9e8bdebff7cc94841d3f101c860c991ca07acfeb36554370b4f',
    'plpgsql', 's', "target_expected_actor_id uuid, target_limit integer DEFAULT 25, target_request_type text DEFAULT 'all'::text, target_status text DEFAULT 'active'::text, target_sort text DEFAULT 'oldest'::text, target_cursor jsonb DEFAULT NULL::jsonb",
    'jsonb', [['authenticated', 'postgres', 'EXECUTE', false], ...ownerAcl]],
];
const expectedIndexHashes = [
  ['account_lifecycle_requests_admin_bucket_idx', '2b258237151472288395bf3a9e45ffd1932037ed1597c7decbcf751e1fc9a303'],
  ['account_lifecycle_requests_one_active_kind_idx', '4d54296c560de36a2122e6a856bb7a163a0b3b2989746b3d6193705bb78c85b1'],
  ['account_lifecycle_requests_pkey', '8ca195b51fbb66694506e5c176eecad56cb5e61b3d5ddd653c8299b32cd0906d'],
  ['account_lifecycle_requests_user_requested_idx', 'b44090c53edc7871e5f153f77bceedf1393119de8670b60246304707f48c5706'],
];
const aclSql = expression => `coalesce((select jsonb_agg(jsonb_build_array(
  case when x.grantee=0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end,
  pg_get_userbyid(x.grantor),x.privilege_type,x.is_grantable)
  order by (case when x.grantee=0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end) collate "C",
  pg_get_userbyid(x.grantor) collate "C",x.privilege_type collate "C",x.is_grantable)
  from aclexplode(${expression}) x),'[]'::jsonb)`;
// Fixed catalog-only snapshot independent of the next release's history gate.
// Canonical deparsing and named ACL tuples avoid cross-cluster OID differences.
const catalogSql = `begin read only;
set local search_path=pg_catalog;set local timezone='UTC';set local datestyle='ISO,YMD';
select jsonb_build_object(
 'functions',(select jsonb_agg(to_jsonb(f) order by f.signature collate "C") from (
   select p.oid::regprocedure::text signature,encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') hash,
   pg_get_userbyid(p.proowner) owner,l.lanname language,p.provolatile volatility,
   pg_get_function_arguments(p.oid) arguments,pg_get_function_result(p.oid) result,
   p.prokind kind,p.prosecdef definer,p.proretset returns_set,p.proisstrict strict,p.proleakproof leakproof,
   p.proparallel parallel,p.procost cost,p.prorows rows,p.proconfig config,
   has_function_privilege('anon',p.oid,'EXECUTE') anon_execute,
   has_function_privilege('service_role',p.oid,'EXECUTE') service_execute,
   has_function_privilege('authenticated',p.oid,'EXECUTE') member_execute,
   (select count(*) from pg_proc other where other.proname=p.proname and other.pronamespace=p.pronamespace) overloads,
   ${aclSql("coalesce(p.proacl,acldefault('f',p.proowner))")} acl
   from pg_proc p join pg_language l on l.oid=p.prolang
   where p.oid in (${expectedFunctions.map(([signature]) => `to_regprocedure(${literal(signature)})`).join(',')})
 ) f),
 'indexes',(select jsonb_agg(to_jsonb(x) order by x.name collate "C") from (
   select c.relname name,pg_get_indexdef(c.oid) definition,
   encode(sha256(convert_to(pg_get_indexdef(c.oid),'UTF8')),'hex') hash,pg_get_userbyid(c.relowner) owner,
   c.relkind kind,am.amname method,i.indisvalid valid,i.indisready ready,i.indislive live,
   i.indisunique unique_index,i.indisprimary primary_index,i.indnatts attributes,i.indnkeyatts keys,
   i.indkey::text column_numbers,i.indoption::text options,
   pg_get_expr(i.indexprs,i.indrelid) expressions,pg_get_expr(i.indpred,i.indrelid) predicate
   from pg_index i join pg_class c on c.oid=i.indexrelid join pg_am am on am.oid=c.relam
   where i.indrelid='public.account_lifecycle_requests'::regclass
 ) x),
 'ledger',(select jsonb_build_object('owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,
   'forceRls',c.relforcerowsecurity,'kind',c.relkind,'persistence',c.relpersistence,
   'anonAny',has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'),
   'memberSelect',has_table_privilege('authenticated',c.oid,'SELECT'),
   'memberOther',has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'),
   'memberInsertColumns',(select jsonb_agg(a.attname order by a.attnum) from pg_attribute a
     where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
       and has_column_privilege('authenticated',c.oid,a.attnum,'INSERT')),
   'acl',${aclSql("coalesce(c.relacl,acldefault('r',c.relowner))")})
   from pg_class c where c.oid='public.account_lifecycle_requests'::regclass),
 'columns',(select jsonb_agg(jsonb_build_array(a.attnum,a.attname,format_type(a.atttypid,a.atttypmod),
   a.attnotnull,${aclSql('a.attacl')}) order by a.attnum) from pg_attribute a
   where a.attrelid='public.account_lifecycle_requests'::regclass and a.attnum>0 and not a.attisdropped),
 'policies',(select jsonb_agg(jsonb_build_array(p.polname,p.polcmd,p.polpermissive,
   (select jsonb_agg(pg_get_userbyid(r) order by pg_get_userbyid(r) collate "C") from unnest(p.polroles) r),
   pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid)) order by p.polname collate "C")
   from pg_policy p where p.polrelid='public.account_lifecycle_requests'::regclass),
 'constraints',(select jsonb_agg(jsonb_build_array(conname,pg_get_constraintdef(oid)) order by conname collate "C")
   from pg_constraint where conrelid='public.account_lifecycle_requests'::regclass),
 'triggers',(select jsonb_agg(jsonb_build_array(tgname,tgenabled,pg_get_triggerdef(oid)) order by tgname collate "C")
   from pg_trigger where tgrelid='public.account_lifecycle_requests'::regclass and not tgisinternal)
);rollback;`;
const vaultHashSql = `select encode(sha256(convert_to(coalesce(string_agg(encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex'),'' ORDER BY to_jsonb(t)::text COLLATE "C"),''),'UTF8')),'hex') from vault.secrets t;`;
const docker = (args, input, encoding = 'utf8') => spawnSync('docker', args, {
  input, encoding, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
});
let startup; let imageId; let inventorySql; let sourceInventory; let sourceCatalog; let sourceVaultHash;
let sourceCiphertext; let history; let captures; let sequence; let supplement;

function owned(kind) {
  const id = containers.get(kind);
  assert.match(id || '', /^[a-f0-9]{64}$/);
  const result = docker(['inspect', id, '--format', '{{index .Config.Labels "77dc.fixture"}}|{{.Name}}|{{.HostConfig.NetworkMode}}|{{.HostConfig.ReadonlyRootfs}}']);
  assert.equal(result.status, 0, 'Owned exact-67 fixture inspection failed.');
  assert.equal(result.stdout.trim(), `${fixture}|/${fixture}-${kind}|none|true`);
  return id;
}
function execute(kind, sql, role = 'backup_restore_admin') {
  return docker(['exec', '-i', owned(kind), 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
    '-h', '/restore', '-U', role, '-d', 'postgres'], sql);
}
function query(kind, sql, role) {
  const result = execute(kind, sql, role);
  assert.equal(result.status, 0, `Owned exact-67 fixture SQL failed: ${result.stderr || result.error?.message || 'output unavailable'}`);
  return result.stdout.trim();
}
async function start(kind) {
  const launched = docker(['run', '--detach', '--pull', 'never', '--name', `${fixture}-${kind}`, '--label', `77dc.fixture=${fixture}`,
    '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--log-driver', 'none',
    '--user', '100:101', '--memory', '512m', '--cpus', '1',
    '--tmpfs', '/restore:rw,exec,nosuid,nodev,uid=100,gid=101,mode=0700,size=512m',
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,uid=100,gid=101,mode=0700,size=64m',
    '-e', 'DOMINION_BACKUP_CURRENT_PG_NET=1', '--entrypoint', 'bash', imageId, '-c', startup]);
  assert.equal(launched.status, 0, 'Owned exact-67 fixture creation failed.');
  const id = launched.stdout.trim(); assert.match(id, /^[a-f0-9]{64}$/); containers.set(kind, id);
  let ready = false;
  for (let count = 0; count < 100; count++) {
    if (docker(['exec', owned(kind), 'pg_isready', '-h', '/restore', '-U', 'backup_restore_admin']).status === 0) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, 'Owned exact-67 fixture did not become ready.');
  query(kind, `create role postgres login ${kind === 'source' ? 'superuser' : 'nosuperuser'};
    create role anon;create role authenticated;create role service_role bypassrls;`);
}
function assertCatalog(catalog) {
  assert.deepEqual(catalog.functions, expectedFunctions.map(([signature, hash, language, volatility, args, result, acl]) => ({
    signature, hash, owner: 'postgres', language, volatility, arguments: args, result, acl,
    kind: 'f', definer: true, returns_set: false, strict: false, leakproof: false, parallel: 'u',
    cost: 100, rows: 0, config: ['search_path=""'], overloads: 1,
    anon_execute: false, service_execute: false, member_execute: signature.startsWith('public.'),
  })));
  assert.deepEqual(catalog.indexes.map(row => [row.name, row.hash]), expectedIndexHashes);
  for (const index of catalog.indexes) {
    assert.equal(index.owner, 'postgres'); assert.equal(index.kind, 'i'); assert.equal(index.method, 'btree');
    assert.equal(index.valid, true); assert.equal(index.ready, true); assert.equal(index.live, true);
  }
  assert.deepEqual(catalog.indexes[0], { ...catalog.indexes[0], unique_index: false, primary_index: false,
    attributes: 4, keys: 4, column_numbers: '3 4 5 1', options: '0 0 0 0', expressions: null, predicate: null });
  const privileges = ['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE'];
  assert.deepEqual(catalog.ledger, { owner: 'postgres', rls: true, forceRls: true, kind: 'r', persistence: 'p',
    anonAny: false, memberSelect: true, memberOther: false, memberInsertColumns: ['user_id', 'request_type'],
    acl: [['authenticated', 'postgres', 'SELECT', false],
      ...['postgres', 'service_role'].flatMap(grantee => privileges.map(privilege => [grantee, 'postgres', privilege, false]))] });
  assert.deepEqual(catalog.columns, [
    [1, 'id', 'uuid', true, []], [2, 'user_id', 'uuid', false, [['authenticated', 'postgres', 'INSERT', false]]],
    [3, 'request_type', 'text', true, [['authenticated', 'postgres', 'INSERT', false]]], [4, 'status', 'text', true, []],
    [5, 'requested_at', 'timestamp with time zone', true, []], [6, 'updated_at', 'timestamp with time zone', true, []],
    [7, 'resolved_at', 'timestamp with time zone', false, []], [8, 'operator_note', 'text', false, []],
  ]);
  assert.deepEqual(catalog.policies, [
    ['Members can create own account requests', 'a', true, ['authenticated'], null,
      "((( SELECT auth.uid() AS uid) = user_id) AND (status = 'requested'::text) AND (resolved_at IS NULL) AND (operator_note IS NULL))"],
    ['Members can read own account requests', 'r', true, ['authenticated'], '(( SELECT auth.uid() AS uid) = user_id)', null],
  ]);
  assert(catalog.constraints.length >= 4); assert.equal(catalog.triggers.length, 1);
}

before(async () => {
  const names = (await readdir(migrationDirectory)).filter(name => name.endsWith('.sql')).sort();
  const versions = selectBackupMigrationCheckpoint(names, POST_ADMIN_INBOX_BACKUP_MODE);
  assert.equal(versions.length, 67);
  assert.equal(sha256(JSON.stringify(versions)), 'fea508a9d28234417a250bfd23825eb418265957c8c1e11b7365750acafb1358');
  history = names.slice(0, 67).map(name => ({ version: name.slice(0, 14), name: name.slice(15, -4) }));
  assert.deepEqual(history.at(-1), { version: '20260929000950', name: 'site_admin_account_requests_inbox' });
  const migrations = await Promise.all(migrationFiles.map(file => readFile(new URL(file, migrationDirectory), 'utf8')));
  startup = await readFile(new URL('./free-backup-local-postgres.sh', import.meta.url), 'utf8');
  inventorySql = await readFile(new URL('./free-backup-inventory.sql', import.meta.url), 'utf8');
  const inspected = docker(['image', 'inspect', POSTGRES_IMAGE, '--format', '{{.Id}}']);
  assert.equal(inspected.status, 0, 'Exact PostgreSQL image must already be cached; this fixture never downloads it.');
  imageId = inspected.stdout.trim(); assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
  await start('source');
  query('source', 'create schema vault;create extension supabase_vault with schema vault;create extension pg_cron with schema pg_catalog;create extension pg_net;');
  query('source', `create schema auth;create schema extensions;create schema supabase_migrations;
    create table supabase_migrations.schema_migrations(version text primary key,name text not null);
    insert into supabase_migrations.schema_migrations values ${history.map(row => `(${literal(row.version)},${literal(row.name)})`).join(',')};
    create table auth.users(id uuid primary key,email text,created_at timestamptz,email_confirmed_at timestamptz,
      is_anonymous boolean,deleted_at timestamptz,banned_until timestamptz);
    create table auth.mfa_factors(id uuid primary key,user_id uuid references auth.users(id),factor_type text,status text);
    create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),factor_id uuid,aal text,not_after timestamptz);
    create table auth.mfa_amr_claims(session_id uuid,authentication_method text,updated_at timestamptz);
    create function auth.jwt() returns jsonb language sql stable as $$select '{}'::jsonb$$;
    create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;
    create function public.set_updated_at() returns trigger language plpgsql as $$begin new.updated_at=now();return new;end$$;
    insert into auth.users(id,email,created_at,email_confirmed_at,is_anonymous) values
      ('00000000-0000-4000-8000-000000000001','synthetic-one@example.invalid','2000-01-01Z','2000-01-01Z',false),
      ('00000000-0000-4000-8000-000000000002','synthetic-two@example.invalid','2000-01-01Z','2000-01-01Z',false);
    set check_function_bodies=false;begin;${migrations.join('\n')}commit;
    insert into public.account_lifecycle_requests(id,user_id,request_type,status,requested_at,updated_at,resolved_at,operator_note) values
      ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','data_export','requested','2000-01-01Z','2000-01-01Z',null,null),
      ('10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','account_deletion','in_progress','2000-01-02Z','2000-01-02Z',null,'synthetic pending'),
      ('10000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002','data_export','fulfilled','2000-01-03Z','2000-01-04Z','2000-01-04Z',E'synthetic 雪\\nfulfilled'),
      ('10000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000002','account_deletion','declined','2000-01-04Z','2000-01-05Z','2000-01-05Z','synthetic declined'),
      ('10000000-0000-4000-8000-000000000005',null,'data_export','cancelled','2000-01-05Z','2000-01-06Z','2000-01-06Z','synthetic retained null owner');`, 'postgres');
  query('source', POST_EARLY_ACCESS_VAULT_NAMES.map((name, index) => `select vault.create_secret(${literal(values[index])},${literal(name)},${literal(`Synthetic description ${index}`)});`).join('\n')
    + jobNames.map((name, index) => `select cron.schedule(${literal(name)},'*/5 * * * *',${literal(commands[index])});`).join('\n'), 'postgres');
  query('source', `insert into net.http_request_queue(id,method,url,headers,body,timeout_milliseconds)
    values(71,'POST','https://fixture.invalid/no-delivery','{"synthetic":"private-header"}'::jsonb,decode('000aff','hex'),1000);
    insert into net._http_response(id,status_code,content_type,headers,content,timed_out,error_msg,created)
    values(70,200,'application/json',null,'synthetic old response',false,null,'2000-01-01T00:00:00Z');
    select setval('net.http_request_queue_id_seq',71,true);`);
  sourceCatalog = JSON.parse(query('source', catalogSql)); assertCatalog(sourceCatalog);
  sourceInventory = query('source', inventorySql);
  sourceVaultHash = query('source', vaultHashSql);
  sourceCiphertext = query('source', 'select jsonb_agg(to_jsonb(t) order by name collate "C") from vault.secrets t;');
  requirePostEarlyAccessVaultProof(query('source', postEarlyAccessVaultProofSql(secrets, sourceVaultHash), 'postgres'));
  sequence = currentBackupPgNetSequence(sourceInventory.split('\n').map(JSON.parse));
  captures = CURRENT_PGNET_TABLES.map(table => {
    const result = docker(['exec', owned('source'), 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', '/restore', '-U', 'postgres', '-d', 'postgres',
      '-c', 'SET SESSION ROLE postgres', '-c', currentBackupPgNetCaptureSql(table.name)], undefined, null);
    assert.equal(result.status, 0, 'Owned read-only pg_net capture failed.'); return { file: table.file, bytes: result.stdout };
  });
  supplement = currentBackupPgNetManifest(captures, sequence);
  const archive = docker(['exec', owned('source'), 'pg_dump', '--host=/restore', '--username=postgres', '--dbname=postgres',
    '--format=custom', '--compress=0', '--lock-wait-timeout=15000', '--role=postgres'], undefined, null);
  assert.equal(archive.status, 0, 'Owned full exact-67 archive capture failed.');
  assert.equal(query('source', inventorySql), sourceInventory);
  await start('restore');
  await restoreLocalArchiveWithRoleCompatibility({
    localSql: sql => query('restore', sql),
    restoreArchive: () => {
      const result = docker(['exec', '-i', owned('restore'), 'pg_restore', '--host=/restore', '--username=backup_restore_admin',
        '--dbname=postgres', '--single-transaction', '--exit-on-error'], archive.stdout);
      assert.equal(result.status, 0, `Owned full exact-67 archive restore failed: ${result.stderr}`);
    },
  });
  for (let index = 0; index < CURRENT_PGNET_TABLES.length; index++) {
    const result = docker(['exec', '-i', owned('restore'), 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', '/restore', '-U', 'backup_restore_admin',
      '-d', 'postgres', '-c', currentBackupPgNetLocalReplaySql(CURRENT_PGNET_TABLES[index].name)], captures[index].bytes);
    assert.equal(result.status, 0, 'Owned pg_net local replay failed.');
  }
  query('restore', currentBackupPgNetLocalSequenceSql(sequence));
});
after(() => {
  for (const kind of [...containers.keys()].reverse()) {
    assert.equal(docker(['rm', '--force', owned(kind)]).status, 0, 'Only an owned exact-67 fixture may be removed.');
    containers.delete(kind);
  }
});

test('native exact-67 archive preserves the fixed migration prefix and nonempty lifecycle ledger', () => {
  const restoredHistory = JSON.parse(query('restore', 'select jsonb_agg(to_jsonb(t) order by version collate "C") from supabase_migrations.schema_migrations t;'));
  assert.deepEqual(restoredHistory, history);
  assert.equal(query('restore', 'select count(*),count(distinct status),count(*) filter(where user_id is null) from public.account_lifecycle_requests;'), '5|5|1');
  assert.equal(query('restore', inventorySql), sourceInventory);
  assert.equal(query('source', inventorySql), sourceInventory);
});

test('native exact-67 restore preserves RPC/guard definitions, signatures, ownership, configuration and exact ACLs', () => {
  const restored = JSON.parse(query('restore', catalogSql));
  assertCatalog(restored); assert.deepEqual(restored.functions, sourceCatalog.functions);
  assert.equal(query('restore', "select rolsuper from pg_roles where rolname='postgres';"), 'f');
});

test('native exact-67 restore preserves all inbox indexes, FORCE RLS, member policies, column grants and constraints', () => {
  const restored = JSON.parse(query('restore', catalogSql));
  assertCatalog(restored); assert.deepEqual(restored, sourceCatalog);
});

test('native exact-67 restore preserves original Vault ciphertext and reconstructs five settings only with rollback', () => {
  const ciphertextSql = 'select jsonb_agg(to_jsonb(t) order by name collate "C") from vault.secrets t;';
  assert.equal(query('restore', ciphertextSql), sourceCiphertext);
  const cannotDecrypt = execute('restore', 'select count(decrypted_secret) from vault.decrypted_secrets;');
  assert.notEqual(cannotDecrypt.status, 0); assert.match(cannotDecrypt.stderr, /invalid ciphertext/);
  requirePostEarlyAccessLocalVaultRecovery(query('restore', postEarlyAccessLocalVaultRecoverySql(secrets)));
  assert.equal(query('restore', vaultHashSql), sourceVaultHash);
  assert.equal(query('restore', ciphertextSql), sourceCiphertext);
  assert.equal(query('restore', inventorySql), sourceInventory);
  assert.notEqual(execute('restore', 'select count(decrypted_secret) from vault.decrypted_secrets;').status, 0);
});

test('native exact-67 restore retains pg_net queue/response bytes and sequence without enabling workers or Cron', () => {
  const restoredCaptures = CURRENT_PGNET_TABLES.map(table => {
    const result = docker(['exec', owned('restore'), 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', '/restore', '-U', 'backup_restore_admin', '-d', 'postgres',
      '-c', 'SET SESSION ROLE postgres', '-c', currentBackupPgNetCaptureSql(table.name)], undefined, null);
    assert.equal(result.status, 0, `Owned restored pg_net read-only capture failed: ${result.stderr}`); return { file: table.file, bytes: result.stdout };
  });
  for (let index = 0; index < captures.length; index++) assert.deepEqual(restoredCaptures[index], captures[index]);
  const restoredSequence = currentBackupPgNetSequence(query('restore', inventorySql).split('\n').map(JSON.parse));
  assert.deepEqual(restoredSequence, sequence);
  assert.deepEqual(currentBackupPgNetManifest(restoredCaptures, restoredSequence), supplement);
  for (const kind of ['source', 'restore']) {
    assert.equal(query(kind, "select current_setting('max_worker_processes'),current_setting('cron.launch_active_jobs'),current_setting('pg_net.batch_size'),current_setting('pg_net.database_name'),(select count(*) from pg_stat_activity where backend_type ilike '%pg_net%' or backend_type ilike '%cron%');"), '0|off|0|dominion_backup_disabled|0');
    assert.equal(query(kind, inventorySql), sourceInventory);
  }
});
