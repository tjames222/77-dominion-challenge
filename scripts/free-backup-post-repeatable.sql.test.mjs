import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { POSTGRES_IMAGE, restoreLocalArchiveWithRoleCompatibility } from './free-production-backup.mjs';
import { REPEATABLE_CHALLENGE_CATALOG_QUERY } from './verify-production-repeatable-challenge.mjs';
import { ORIGINAL77_CATALOG_QUERY } from './verify-production-original77.mjs';
import { REPEATABLE_CHALLENGE_MIGRATION_SHA256 } from './verify-repeatable-challenge-cutover-plan.mjs';
import { createOriginal77FullchainFixture } from './fixtures/original77-fullchain-fixture.mjs';

// Exact-71 application archive rehearsal. Five-setting Vault and pg_net binary
// recovery remain covered by the unchanged exact-67 archive fixture; this
// fixture adds a full unchanged 71-migration replay and canonical 77-row
// completion snapshot without a hosted endpoint, persistent volume, or network access.
const owner = `77dc-repeatable71-archive-${randomUUID()}`;
const restoreName = `${owner}-restore`;
const docker = (args, input, encoding = 'utf8') => spawnSync('docker', args, {
  input, encoding, timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
});
let source;
let restoreId;
let imageId;
let archive;
let sourceCatalog;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const checkpoint = sql => sql.trim().replace(/;$/u, '');
const catalogSql = `begin read only;
select jsonb_build_object(
 'history',(select jsonb_agg(jsonb_build_array(version,name) order by version collate "C") from supabase_migrations.schema_migrations),
 'repeatable',(select row_to_json(c) from (${checkpoint(REPEATABLE_CHALLENGE_CATALOG_QUERY)}) c),
 'original77',(select row_to_json(c) from (${checkpoint(ORIGINAL77_CATALOG_QUERY)}) c)
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
  assert.equal(result.status, 0, `Owned exact-71 restore SQL failed: ${result.stderr || result.error?.message || 'output unavailable'}`);
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
    '--entrypoint', 'bash', imageId, '-c', startup]);
  assert.equal(launched.status, 0, 'Could not create the owned exact-71 restore fixture.');
  restoreId = launched.stdout.trim(); assert.match(restoreId, /^[a-f0-9]{64}$/u);
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (docker(['exec', ownedRestore(), 'pg_isready', '-h', '/restore', '-U', 'backup_restore_admin']).status === 0) {
      ready = true; break;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, 'Owned exact-71 restore fixture did not become ready.');
  queryRestore(`create role postgres login nosuperuser nocreaterole nocreatedb bypassrls;
    create role anon;create role authenticated;create role service_role bypassrls;
    create role supabase_storage_admin nologin nosuperuser;
    create role supabase_read_only_user nologin nosuperuser bypassrls;
    grant pg_read_all_data to supabase_read_only_user;`);
}

before(async () => {
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
  const migration = await readFile(new URL('../supabase/migrations/20261001001245_repeatable_challenge_instances_v2.sql', import.meta.url), 'utf8');
  assert.equal(sha256(migration), REPEATABLE_CHALLENGE_MIGRATION_SHA256);
  source.query(`begin;set local check_function_bodies=on;set local search_path=public,extensions;
    ${migration}
    insert into supabase_migrations.schema_migrations(version,name,statements)
      values('20261001001245','repeatable_challenge_instances_v2',array['${migration.replaceAll("'", "''")}']::text[]);
    commit;`);
  archive = source.captureCustomArchive();
  sourceCatalog = source.query(catalogSql);
  const contract = JSON.parse(sourceCatalog);
  assert.equal(contract.history.length, 71);
  for (const fields of [contract.repeatable, contract.original77]) assert(Object.values(fields).every(value => value === true));
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
      assert.equal(result.status, 0, `Owned exact-71 archive restore failed: ${result.stderr}`);
    },
  });
});

after(() => {
  let cleanupError;
  if (restoreId) {
    try {
      assert.equal(docker(['rm', '--force', ownedRestore()]).status, 0, 'Only the owned exact-71 restore fixture may be removed.');
      restoreId = undefined;
    } catch (error) { cleanupError = error; }
  }
  try { source?.close(); } catch (error) { cleanupError ??= error; }
  if (cleanupError) throw cleanupError;
});

test('native exact-71 archive restores the frozen migration prefix and canonical live completion provenance', () => {
  const restoredHistory = JSON.parse(queryRestore(`select jsonb_agg(jsonb_build_object('version',version,'name',name)
    order by version collate "C") from supabase_migrations.schema_migrations;`, 'postgres'));
  const expectedHistory = JSON.parse(source.query(`select jsonb_agg(jsonb_build_object('version',version,'name',name)
    order by version collate "C") from supabase_migrations.schema_migrations;`));
  assert.equal(expectedHistory.length, 71);
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

test('native exact-71 restore retains source-fixed original77 catalog contracts and downgrades postgres', () => {
  assert.equal(queryRestore(catalogSql, 'postgres'), sourceCatalog);
  assert.equal(queryRestore("select rolsuper from pg_roles where rolname='postgres';"), 'f');
});

test('native exact-71 restore preserves immutable completion events', () => {
  const changed = executeRestore(`update private.original_77_completion_events
    set recorded_at=timestamptz '2026-10-01 00:00:00+00'
    where id='77000000-0000-4000-8000-000000000070';`, 'postgres');
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /original_77_completion_event_immutable/u);
  assert.equal(queryRestore('select count(*) from private.original_77_completion_events;', 'postgres'), '1');
});
