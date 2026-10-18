import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { POSTGRES_IMAGE, restoreLocalArchiveWithRoleCompatibility } from './free-production-backup.mjs';
import { POST75_CATALOGS, assertPost75CatalogsReady } from './verify-production-post75-catalogs.mjs';
import { verifyPost75ReleaseSources } from './verify-post75-release-plan.mjs';
import { createOriginal77FullchainFixture } from './fixtures/original77-fullchain-fixture.mjs';

const REPEATABLE_CHALLENGE_CATALOG_QUERY = POST75_CATALOGS.find(item => item.name === 'repeatable_challenge').query;
const ORIGINAL77_CATALOG_QUERY = POST75_CATALOGS.find(item => item.name === 'original77').query;
const INBOX_CATALOG_QUERY = POST75_CATALOGS.find(item => item.name === 'account_request_inbox').query;
const CLEANUP_CATALOG_QUERY = POST75_CATALOGS.find(item => item.name === 'admin_cleanup_health').query;
const PROFILE_NAME_CATALOG_QUERY = POST75_CATALOGS.find(item => item.name === 'admin_profile_name').query;
// Exact-75 application archive rehearsal. Five-setting Vault and pg_net binary
// recovery remain covered by the unchanged exact-67 archive fixture; this
// fixture adds the full unchanged 75-migration replay and canonical 77-row
// completion snapshot, profile-name sidecar/audit/trigger and legacy reviews. The
// source verifier checks the reviewed 76-file candidate before any resource is
// created; this backup fixture applies/restores ONLY its frozen 75-file prefix.
// No hosted endpoint, persistent volume, registry pull or network access.
const owner = `77dc-post75-archive-${randomUUID()}`;
const restoreName = `${owner}-restore`;
const docker = (args, input, encoding = 'utf8') => spawnSync('docker', args, {
  input, encoding, timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
});
let source;
let restoreId;
let imageId;
let archive;
let sourceCatalog;
let contentSql;
let sourceContents;
let versionBeforeNameChange;
let frozenSources;
const migrationDirectory = new URL('../supabase/migrations/', import.meta.url);
const FROZEN75_SOURCE_PAIRS_SHA256 = '5263339fef7b555f0dee2f95c8b25ac06bb25618475803ecc3e6c626daee2016';
async function readFrozenSources() {
  const allNames = (await readdir(migrationDirectory)).filter(name => name.endsWith('.sql')).sort();
  const allEntries = await Promise.all(allNames.map(async name => [name, await readFile(new URL(name, migrationDirectory), 'utf8')]));
  assertPost75CatalogsReady();
  verifyPost75ReleaseSources({ migrationFilenames: allNames,
    migrationSourceHashes: Object.fromEntries(allEntries.map(([name, text]) => [name, sha256(text)])) });
  const names = allNames.slice(0, 75);
  assert.equal(names.length, 75);
  assert.equal(names.at(-1), '20261013091749_site_admin_profile_name_correction.sql');
  const entries = allEntries.slice(0, 75);
  assert.equal(sha256(JSON.stringify(entries.map(([name, text]) => [name, sha256(text)]))), FROZEN75_SOURCE_PAIRS_SHA256,
    'All frozen75 migration names and source bytes must match before a fixture is created.');
  return entries;
}
const sha256 = value => createHash('sha256').update(value).digest('hex');
const checkpoint = sql => sql.trim().replace(/;$/u, '');
const catalogSql = `begin read only;
set local search_path=pg_catalog;set local timezone='UTC';set local datestyle='ISO,YMD';
select jsonb_build_object(
 'history',(select jsonb_agg(jsonb_build_array(version,name) order by version collate "C") from supabase_migrations.schema_migrations),
 'inbox',(select row_to_json(c) from (${checkpoint(INBOX_CATALOG_QUERY)}) c),
 'cleanup',(select row_to_json(c) from (${checkpoint(CLEANUP_CATALOG_QUERY)}) c),
 'profileName',(select row_to_json(c) from (${checkpoint(PROFILE_NAME_CATALOG_QUERY)}) c),
 'activationHealthAbsent',to_regprocedure('public.site_admin_get_activation_review_health(uuid)')is null,
 'activationIndexAbsent',to_regclass('private.challenge_activation_reviews_unresolved_created_idx')is null,
 'repeatable',(select row_to_json(c) from (${checkpoint(REPEATABLE_CHALLENGE_CATALOG_QUERY)}) c),
 'original77',(select row_to_json(c) from (${checkpoint(ORIGINAL77_CATALOG_QUERY)}) c),
 'additions',(select jsonb_agg(jsonb_build_object(
   'signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),
   'owner',pg_get_userbyid(p.proowner),'language',l.lanname,'kind',p.prokind,
   'securityDefiner',p.prosecdef,'volatility',p.provolatile,'config',p.proconfig,
   'acl',p.proacl::text,'arguments',pg_get_function_arguments(p.oid),'result',pg_get_function_result(p.oid),
   'anonExecute',has_function_privilege('anon',p.oid,'EXECUTE'),
   'memberExecute',has_function_privilege('authenticated',p.oid,'EXECUTE'),
   'serviceExecute',has_function_privilege('service_role',p.oid,'EXECUTE'))
   order by p.proname collate "C")
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang
   where n.nspname='public' and p.proname in
    ('site_admin_get_account_request_queue_health','profile_photo_cleanup_monitor_health','site_admin_get_cleanup_health'))
)::text;rollback;`;

function ownedRestore() {
  assert.match(restoreId || '', /^[a-f0-9]{64}$/u, 'Restore fixture is not running.');
  const result = docker(['inspect', restoreId, '--format', '{{json .}}']);
  assert.equal(result.status, 0, 'Could not inspect the owned restore fixture.');
  const record = JSON.parse(result.stdout);
  assert.equal(record.Id, restoreId);
  assert.equal(record.Name, `/${restoreName}`);
  assert.equal(record.Config?.Labels?.['77dc.fixture'], owner);
  assert.equal(record.Config?.Image, imageId);
  assert.equal(record.HostConfig?.NetworkMode, 'none');
  assert.equal(record.HostConfig?.ReadonlyRootfs, true);
  assert.equal(record.HostConfig?.Privileged, false);
  assert.equal(Object.keys(record.HostConfig?.PortBindings || {}).length, 0);
  assert.equal((record.HostConfig?.CapAdd || []).length, 0);
  assert(record.HostConfig?.CapDrop?.includes('ALL'));
  assert(record.HostConfig?.SecurityOpt?.includes('no-new-privileges'));
  assert((record.Mounts || []).every(mount => mount.Type === 'tmpfs'));
  return restoreId;
}

function executeRestore(sql, role = 'backup_restore_admin') {
  return docker(['exec', '-i', ownedRestore(), 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
    '-h', '/restore', '-U', role, '-d', 'postgres'], sql);
}

function queryRestore(sql, role) {
  const result = executeRestore(sql, role);
  assert.equal(result.status, 0, `Owned exact-75 restore SQL failed: ${result.stderr || result.error?.message || 'output unavailable'}`);
  return result.stdout.trim();
}

async function startRestore() {
  const startup = await readFile(new URL('./free-backup-local-postgres.sh', import.meta.url), 'utf8');
  const launched = docker(['run', '--detach', '--pull', 'never', '--name', restoreName,
    '--label', `77dc.fixture=${owner}`, '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--log-driver', 'none', '--user', '100:101',
    '--memory', '768m', '--cpus', '1',
    '--tmpfs', '/restore:rw,exec,nosuid,nodev,uid=100,gid=101,mode=0700,size=512m',
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,uid=100,gid=101,mode=0700,size=64m',
    '-e', 'DOMINION_BACKUP_CURRENT_PG_NET=1',
    '--entrypoint', 'bash', imageId, '-c', startup]);
  assert.equal(launched.status, 0, 'Could not create the owned exact-75 restore fixture.');
  restoreId = launched.stdout.trim(); assert.match(restoreId, /^[a-f0-9]{64}$/u);
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (docker(['exec', ownedRestore(), 'pg_isready', '-h', '/restore', '-U', 'backup_restore_admin']).status === 0) {
      ready = true; break;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, 'Owned exact-75 restore fixture did not become ready.');
  assert.equal(queryRestore('show max_worker_processes;show cron.launch_active_jobs;show pg_net.batch_size;show pg_net.database_name;'),
    '0\noff\n0\ndominion_backup_disabled');
  queryRestore(`create role postgres login nosuperuser nocreaterole nocreatedb bypassrls;
    create role anon;create role authenticated;create role service_role bypassrls;
    create role supabase_storage_admin nologin nosuperuser;
    create role supabase_read_only_user nologin nosuperuser bypassrls;
    grant pg_read_all_data to supabase_read_only_user;`);
}

before(async () => {
  frozenSources = await readFrozenSources();
  source = await createOriginal77FullchainFixture({ through: 70 });
  assert.equal(source.appliedFiles.length, 70);
  assert.equal(source.appliedFiles.at(-1), '20260930161218_share_submitted_progress_v2.sql');
  assert.equal(sha256(JSON.stringify(source.appliedFiles.map(file => [file, source.sourceHashes[file]]))),
    '754a7ed3df7486b06b4fdc1ab3daabfe6b140e172a720d37ac2ee7917f55b00f');
  source.queryAsBootstrap(`set session_replication_role=replica;
    insert into auth.users(id,is_anonymous) values('00000000-0000-4000-8000-000000000070',false);
    insert into public.profiles(user_id,challenge_start_date,challenge_activation_status,challenge_activation_review_required,
      challenge_participation_mode,challenge_activation_time_zone,challenge_confirmed_at,challenge_activated_at,
      challenge_confirmed_by,challenge_activated_by)
      values('00000000-0000-4000-8000-000000000070',date '2026-07-16','active',false,'solo','UTC',
        timestamptz '2026-07-16 00:00:00+00',timestamptz '2026-07-16 00:00:00+00',
        '00000000-0000-4000-8000-000000000070','00000000-0000-4000-8000-000000000070');
    insert into public.check_ins(id,user_id,entry_date,challenge_day,status,completed_count,completed,created_at)
      select ('70000000-0000-4000-8000-'||lpad(day::text,12,'0'))::uuid,
        '00000000-0000-4000-8000-000000000070'::uuid,date '2026-07-16'+(day-1),day,
        'partial',1,array['walk']::text[],timestamptz '2026-07-16 12:34:56.123456+00'+((day-1)*interval '1 day')
      from generate_series(1,77) day;
    insert into private.original_77_completion_events(id,user_id,challenge_start_date,completion_kind,
      criteria_version,source_check_in_id,recorded_at,source_local_date,source_recorded_at)
      values('77000000-0000-4000-8000-000000000070','00000000-0000-4000-8000-000000000070',
        date '2026-07-16','original_77_submissions',1,'70000000-0000-4000-8000-000000000077',
        timestamptz '2026-09-30 12:35:00+00',date '2026-09-30',timestamptz '2026-09-30 12:34:56.123456+00');
    reset session_replication_role;`);
  for (const [name, migration] of frozenSources.slice(70)) {
    const quote = value => "'" + value.replaceAll("'", "''") + "'";
    source.query(`begin;set local check_function_bodies=on;set local search_path=public,extensions;
      ${migration}
      insert into supabase_migrations.schema_migrations(version,name,statements)
        values(${quote(name.slice(0,14))},${quote(name.slice(15,-4))},array[${quote(migration)}]::text[]);
      commit;`);
  }
  // Synthetic application records only. This rehearsal does not grant an admin
  // role, enroll MFA, call hosted services or claim a real name correction.
  versionBeforeNameChange = source.query("select version from private.site_admin_profile_name_versions where user_id='00000000-0000-4000-8000-000000000070';");
  source.query(`update public.profiles set name='Synthetic archive profile' where user_id='00000000-0000-4000-8000-000000000070';
    insert into auth.users(id,is_anonymous) values
      ('00000000-0000-4000-8000-000000000071',false),('00000000-0000-4000-8000-000000000072',false);
    insert into private.challenge_activation_migration_reviews(user_id,reasons,evidence,created_at,resolved_at,resolved_by,resolution_note)values
      ('00000000-0000-4000-8000-000000000071',array['synthetic_pending'], '{"private":"synthetic archive pending evidence"}','-infinity',null,null,'synthetic pending note'),
      ('00000000-0000-4000-8000-000000000072',array['synthetic_resolved'], '{"private":"synthetic archive resolved evidence"}','2026-01-01+00','2026-10-01+00','00000000-0000-4000-8000-000000000070','synthetic resolved note');
    insert into private.site_admin_audit(actor_id,target_user_id,action,permission,reason_code,request_id,correlation_id,
      environment,outcome,before_profile_name_version,after_profile_name_version,profile_name_changed)
    select '00000000-0000-4000-8000-000000000071','00000000-0000-4000-8000-000000000070',
      'users.display_name.correct','users.manage','profile_name_correction',gen_random_uuid(),gen_random_uuid(),
      'local','success','${versionBeforeNameChange}',version,true
    from private.site_admin_profile_name_versions where user_id='00000000-0000-4000-8000-000000000070';`);
  const relations = JSON.parse(source.query(`select jsonb_agg(jsonb_build_array(format('%I.%I',n.nspname,c.relname),c.relkind)
    order by n.nspname,c.relname)from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where c.relkind in ('r','p','m','S')and n.nspname !~ '^pg_'and n.nspname<>'information_schema';`));
  const literal = value => "'" + value.replaceAll("'", "''") + "'";
  contentSql = `begin read only;set local search_path=pg_catalog;set local timezone='UTC';
    select jsonb_object_agg(name,value)from(${relations.map(([name,kind]) => kind === 'S'
      ? `select ${literal(name)} as name,jsonb_build_object('lastValue',last_value::text,'isCalled',is_called)as value from ${name}`
      : `select ${literal(name)} as name,jsonb_build_object('count',count(*),'sha256',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\\n'order by to_jsonb(t)::text collate "C"),''),'UTF8')),'hex'))as value from ${name} t`
    ).join(' union all ')})contents;rollback;`;
  sourceContents = source.query(contentSql);
  archive = source.captureCustomArchive();
  assert.equal(source.query(contentSql),sourceContents,'Fixture contents changed during archive capture.');
  sourceCatalog = source.query(catalogSql);
  const contract = JSON.parse(sourceCatalog);
  assert.equal(contract.history.length, 75);
  assert.equal(contract.activationHealthAbsent, true); assert.equal(contract.activationIndexAbsent, true);
  for (const fields of [contract.inbox, contract.cleanup, contract.repeatable, contract.original77, contract.profileName]) assert(Object.values(fields).every(value => value === true));
  assert.equal(source.query('select count(*) from private.challenge_instances;'), '1');
  const inspected = docker(['image', 'inspect', POSTGRES_IMAGE, '--format', '{{.Id}}']);
  assert.equal(inspected.status, 0, 'Exact PostgreSQL image must already be cached; this fixture never downloads it.');
  imageId = inspected.stdout.trim(); assert.match(imageId, /^sha256:[a-f0-9]{64}$/u);
  await startRestore();
  await restoreLocalArchiveWithRoleCompatibility({
    localSql: sql => queryRestore(sql),
    restoreArchive: () => {
      const result = docker(['exec', '-i', ownedRestore(), 'pg_restore', '--host=/restore',
        '--username=backup_restore_admin', '--dbname=postgres', '--single-transaction', '--exit-on-error'], archive);
      assert.equal(result.status, 0, `Owned exact-75 archive restore failed: ${result.stderr}`);
    },
  });
});

after(async () => {
  let cleanupError;
  if (restoreId) {
    try {
      assert.equal(docker(['rm', '--force', ownedRestore()]).status, 0, 'Only the owned exact-75 restore fixture may be removed.');
      restoreId = undefined;
    } catch (error) { cleanupError = error; }
  }
  try {
    if (frozenSources) assert.deepEqual(await readFrozenSources(), frozenSources, 'Frozen source changed during archive rehearsal.');
  } catch (error) { cleanupError ??= error; }
  try { source?.close(); } catch (error) { cleanupError ??= error; }
  if (cleanupError) throw cleanupError;
});

test('native exact-75 archive restores the frozen migration prefix and canonical live completion provenance', () => {
  const restoredHistory = JSON.parse(queryRestore(`select jsonb_agg(jsonb_build_object('version',version,'name',name)
    order by version collate "C") from supabase_migrations.schema_migrations;`, 'postgres'));
  const expectedHistory = JSON.parse(source.query(`select jsonb_agg(jsonb_build_object('version',version,'name',name)
    order by version collate "C") from supabase_migrations.schema_migrations;`));
  assert.equal(expectedHistory.length, 75);
  assert.deepEqual(restoredHistory, expectedHistory);
  for (const relation of ['challenge_instances','challenge_runtime','challenge_instance_completions','challenge_instance_requests','reward_grant_preservation']) {
    assert.equal(queryRestore(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) from private.${relation} t;`, 'postgres'),
      source.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) from private.${relation} t;`));
  }
  const evidence = `select jsonb_build_object('eventId',event.id,'userId',event.user_id,
    'sourceCheckInId',event.source_check_in_id,'localDate',event.source_local_date,
    'sourceRecordedAt',event.source_recorded_at,'persistedAt',event.recorded_at)
    from private.original_77_completion_events event;`;
  assert.equal(queryRestore(evidence, 'postgres'), source.query(evidence));
  const progress = `select private.original_77_progress_for_user(
    '00000000-0000-4000-8000-000000000070',date '2026-07-16');`;
  const expected = JSON.parse(source.query(progress));
  assert.equal(expected.submittedCount, 77); assert.equal(expected.completionState, 'live_completed');
  assert.equal(expected.canonicalEvent.sourceId, '70000000-0000-4000-8000-000000000077');
  assert.deepEqual(JSON.parse(queryRestore(progress, 'postgres')), expected);
});

test('native exact-75 restore retains source-fixed original77 catalog contracts and downgrades postgres', () => {
  assert.equal(queryRestore(catalogSql, 'postgres'), sourceCatalog);
  assert.equal(queryRestore("select rolsuper from pg_roles where rolname='postgres';"), 'f');
});

test('exact-75 restore reproduces every non-system table fingerprint and sequence state', () => {
  assert.equal(queryRestore(contentSql,'postgres'),sourceContents);
});

test('exact-75 archive preserves profiles, name versions, typed audit and legacy queue without activating76', () => {
  for (const table of ['public.profiles','private.site_admin_profile_name_versions','private.site_admin_audit','private.challenge_activation_migration_reviews']) {
    const rows = `select jsonb_agg(to_jsonb(t)order by to_jsonb(t)::text collate "C")from ${table} t;`;
    assert.equal(queryRestore(rows, 'postgres'), source.query(rows), table);
  }
  const version = queryRestore("select version from private.site_admin_profile_name_versions where user_id='00000000-0000-4000-8000-000000000070';", 'postgres');
  assert.match(version,/^[a-f0-9-]{36}$/); assert.notEqual(version,versionBeforeNameChange);
  const audit = 'select private.site_admin_audit_payload(sequence_id)from private.site_admin_audit order by sequence_id;';
  assert.equal(queryRestore(audit, 'postgres'),source.query(audit));
  const typed = JSON.parse(queryRestore(audit, 'postgres'));
  assert.equal(typed.profileNameChanged,true); assert.equal(typed.beforeProfileNameVersion,versionBeforeNameChange);
  assert.equal(typed.afterProfileNameVersion,version); assert.equal(typed.action,'users.display_name.correct');
  const restored = JSON.parse(queryRestore(catalogSql, 'postgres'));
  assert.equal(restored.activationHealthAbsent,true); assert.equal(restored.activationIndexAbsent,true);
  assert.ok(Object.values(restored.profileName).every(value=>value===true));
  assert.equal(queryRestore("select count(*)from supabase_migrations.schema_migrations where version='20261018013111';",'postgres'),'0');
  assert.equal(queryRestore("select count(*)from private.challenge_activation_migration_reviews where resolved_at is null;",'postgres'),'1');
});

test('restored profile-version trigger and immutable typed audit remain operational', () => {
  queryRestore(`begin;do $$declare prior uuid;next uuid;begin
    select version into prior from private.site_admin_profile_name_versions where user_id='00000000-0000-4000-8000-000000000070';
    update public.profiles set name='Synthetic second name'where user_id='00000000-0000-4000-8000-000000000070';
    select version into next from private.site_admin_profile_name_versions where user_id='00000000-0000-4000-8000-000000000070';
    if prior is null or next is null or prior=next then raise exception 'Restored version trigger failed';end if;
    end$$;rollback;`,'postgres');
  const denied = executeRestore('update private.site_admin_audit set profile_name_changed=false;','postgres');
  assert.notEqual(denied.status,0); assert.match(denied.stderr,/admin_immutable_record/);
});

test('native exact-75 restore preserves immutable completion events', () => {
  const changed = executeRestore(`update private.original_77_completion_events
    set recorded_at=timestamptz '2026-10-01 00:00:00+00'
    where id='77000000-0000-4000-8000-000000000070';`, 'postgres');
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /original_77_completion_event_immutable/u);
  assert.equal(queryRestore('select count(*) from private.original_77_completion_events;', 'postgres'), '1');
});

test('exact-75 archive retains all three additive function bodies, privileges and stable definer configuration', () => {
  const additions = JSON.parse(queryRestore(catalogSql, 'postgres')).additions;
  assert.equal(additions.length, 3);
  for (const item of additions) {
    assert.equal(item.owner, 'postgres');
    assert.equal(item.language, 'plpgsql');
    assert.equal(item.kind, 'f');
    assert.equal(item.securityDefiner, true);
    assert.equal(item.volatility, 's');
    assert.deepEqual(item.config, item.signature === 'public.site_admin_get_cleanup_health(uuid)'
      ? ['search_path=""', 'lock_timeout=1s'] : ['search_path=""']);
    assert.equal(item.result, 'jsonb');
    assert.equal(item.anonExecute, false);
    assert.equal(item.memberExecute, item.signature.startsWith('public.site_admin_'));
    assert.equal(item.serviceExecute, item.signature.startsWith('public.profile_photo_'));
    assert.equal(typeof item.acl, 'string');
  }
  assert.deepEqual(additions, JSON.parse(sourceCatalog).additions);
});

test('exact-75 restore preserves additive denial boundaries and the missing-Cron service snapshot', () => {
  for (const [role, call] of [
    ['anon', "public.site_admin_get_account_request_queue_health('00000000-0000-4000-8000-000000000070')"],
    ['service_role', "public.site_admin_get_account_request_queue_health('00000000-0000-4000-8000-000000000070')"],
    ['anon', "public.site_admin_get_cleanup_health('00000000-0000-4000-8000-000000000070')"],
    ['service_role', "public.site_admin_get_cleanup_health('00000000-0000-4000-8000-000000000070')"],
    ['anon', 'public.profile_photo_cleanup_monitor_health()'],
    ['authenticated', 'public.profile_photo_cleanup_monitor_health()'],
  ]) {
    const denied = executeRestore(`set role ${role};select ${call};`);
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /permission denied for function/u);
  }
  // The authenticated entrypoint is granted but must still reject a missing
  // native identity; no fixture admin is seeded and no guard is replaced.
  const noActor = executeRestore("set role authenticated;select public.site_admin_get_account_request_queue_health('00000000-0000-4000-8000-000000000070');");
  assert.notEqual(noActor.status, 0);
  assert.match(noActor.stderr, /admin_authentication_required/u);
  const noCleanupActor = executeRestore("set role authenticated;select public.site_admin_get_cleanup_health('00000000-0000-4000-8000-000000000070');");
  assert.notEqual(noCleanupActor.status, 0); assert.match(noCleanupActor.stderr, /admin_authentication_required/u);
  const snapshot = JSON.parse(queryRestore('set role service_role;select public.profile_photo_cleanup_monitor_health();'));
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.cron.catalogAvailable, false);
  assert.equal(snapshot.cron.jobState, 'unavailable');
  assert.equal(snapshot.cron.transportEvidence, 'enqueue-only');
  assert.deepEqual(snapshot.cron.lastRuns, []);
  assert.equal(snapshot.cleanup.ready, 0);
  assert.equal(queryRestore("select count(*) from pg_stat_activity where backend_type like '%cron%';"), '0');
});
