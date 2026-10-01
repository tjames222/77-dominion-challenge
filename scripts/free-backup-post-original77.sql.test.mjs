import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { POSTGRES_IMAGE, restoreLocalArchiveWithRoleCompatibility } from './free-production-backup.mjs';
import { createOriginal77FullchainFixture } from './fixtures/original77-fullchain-fixture.mjs';

// Exact-70 application archive rehearsal. Five-setting Vault and pg_net binary
// recovery remain covered by the unchanged exact-67 archive fixture; this
// fixture adds a full unchanged 70-migration replay and canonical 77-row
// completion snapshot without a hosted endpoint, persistent volume, or network access.
const owner = `77dc-original77-archive-${randomUUID()}`;
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
const catalogSql = `begin read only;
set local search_path=pg_catalog;set local timezone='UTC';set local datestyle='ISO,YMD';
select jsonb_build_object(
  'history',(select jsonb_agg(jsonb_build_array(version,name) order by version collate "C")
    from supabase_migrations.schema_migrations),
  'functions',(select jsonb_agg(jsonb_build_object(
      'signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),
      'owner',pg_get_userbyid(p.proowner),'language',l.lanname,'kind',p.prokind,
      'securityDefiner',p.prosecdef,'volatility',p.provolatile,'strict',p.proisstrict,
      'config',p.proconfig,'arguments',pg_get_function_arguments(p.oid),'result',pg_get_function_result(p.oid),
      'anonExecute',has_function_privilege('anon',p.oid,'EXECUTE'),
      'memberExecute',has_function_privilege('authenticated',p.oid,'EXECUTE'),
      'serviceExecute',has_function_privilege('service_role',p.oid,'EXECUTE'))
    order by p.oid::regprocedure::text collate "C")
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang
    where (n.nspname,p.proname) in (
      ('private','original_77_submission_evidence'),('private','original_77_progress_for_user'),
      ('private','outbound_event_payload_is_safe'),('private','persist_badge_event'),
      ('private','record_live_original_77_completion'),('private','reject_original_77_completion_event_update'),
      ('private','check_in_badge_facts'),('private','award_check_in_badges'),('private','badge_rule_matches'),
      ('public','challenge_activation_allows_date'),('public','challenge_activation_payload_for_user'),
      ('public','reward_catalog_item_for_user'),('public','start_challenge'),
      ('public','daily_standard_draft_payload'),('public','mutate_daily_standard_draft_pre_activation'),
      ('public','set_daily_standard_workout_difficulty_pre_activation'),('public','submit_daily_check_in_pre_activation'),
      ('public','submit_daily_check_in'),('public','process_check_in_game_rewards'),
      ('public','build_share_snapshot_payload'),('public','preview_share_snapshot'),('public','create_share_snapshot'))),
  'relations',(select jsonb_agg(jsonb_build_object(
      'identity',c.oid::regclass::text,'owner',pg_get_userbyid(c.relowner),'kind',c.relkind,
      'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,
      'anonAny',has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'),
      'memberSelect',has_table_privilege('authenticated',c.oid,'SELECT'),
      'memberWrite',has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'),
      'serviceAny',has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'),
      'columns',(select jsonb_agg(jsonb_build_array(a.attnum,a.attname,format_type(a.atttypid,a.atttypmod),
        a.attnotnull,a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid)) order by a.attnum)
        from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
        where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
      'constraints',(select jsonb_agg(jsonb_build_array(x.conname,x.contype,pg_get_constraintdef(x.oid),x.convalidated)
        order by x.conname collate "C") from pg_constraint x where x.conrelid=c.oid),
      'indexes',(select jsonb_agg(jsonb_build_array(r.relname,pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisunique,i.indisprimary)
        order by r.relname collate "C") from pg_index i join pg_class r on r.oid=i.indexrelid where i.indrelid=c.oid),
      'policies',(select jsonb_agg(jsonb_build_array(polname,polcmd,polpermissive,pg_get_expr(polqual,polrelid),pg_get_expr(polwithcheck,polrelid))
        order by polname collate "C") from pg_policy where polrelid=c.oid))
    order by c.oid::regclass::text collate "C") from pg_class c where c.oid in (
      'public.check_ins'::regclass,'private.original_77_completion_events'::regclass,'public.public_share_snapshots'::regclass)),
  'triggers',(select jsonb_agg(jsonb_build_array(t.tgrelid::regclass::text,t.tgname,pg_get_triggerdef(t.oid),
      t.tgfoid::regprocedure::text,t.tgenabled) order by t.tgrelid::regclass::text collate "C",t.tgname collate "C")
    from pg_trigger t where not t.tgisinternal and t.tgrelid in (
      'public.check_ins'::regclass,'private.original_77_completion_events'::regclass)),
  'finisher',(select jsonb_agg(jsonb_build_object('badgeKey',badge_key,'name',name,'description',description,
      'requirement',requirement,'criteriaVersion',criteria_version,'sourceEvent',source_event,'metric',metric,
      'threshold',threshold,'predicate',predicate,'scope',scope,'visibility',visibility,'celebration',celebration,
      'retired',retired,'blocked',blocked) order by badge_key collate "C")
    from public.badge_definitions where badge_key='original_77_completed')
)::text;
rollback;`;

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
  assert.equal(result.status, 0, `Owned exact-70 restore SQL failed: ${result.stderr || result.error?.message || 'output unavailable'}`);
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
  assert.equal(launched.status, 0, 'Could not create the owned exact-70 restore fixture.');
  restoreId = launched.stdout.trim(); assert.match(restoreId, /^[a-f0-9]{64}$/u);
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (docker(['exec', ownedRestore(), 'pg_isready', '-h', '/restore', '-U', 'backup_restore_admin']).status === 0) {
      ready = true; break;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, 'Owned exact-70 restore fixture did not become ready.');
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
  archive = source.captureCustomArchive();
  sourceCatalog = source.query(catalogSql);
  assert.equal(sha256(sourceCatalog), 'becb1e331c3993d5ec510d0a513d6f5e74553049b272532f171e7c1142c6e4fd');
  const inspected = docker(['image', 'inspect', POSTGRES_IMAGE, '--format', '{{.Id}}']);
  assert.equal(inspected.status, 0, 'Exact PostgreSQL image must already be cached; this fixture never downloads it.');
  imageId = inspected.stdout.trim(); assert.match(imageId, /^sha256:[a-f0-9]{64}$/u);
  await startRestore();
  await restoreLocalArchiveWithRoleCompatibility({
    localSql: sql => queryRestore(sql),
    restoreArchive: () => {
      const result = docker(['exec', '-i', ownedRestore(), 'pg_restore', '--host=/restore',
        '--username=backup_restore_admin', '--dbname=postgres', '--single-transaction', '--exit-on-error'], archive);
      assert.equal(result.status, 0, `Owned exact-70 archive restore failed: ${result.stderr}`);
    },
  });
});

after(() => {
  let cleanupError;
  if (restoreId) {
    try {
      assert.equal(docker(['rm', '--force', ownedRestore()]).status, 0, 'Only the owned exact-70 restore fixture may be removed.');
      restoreId = undefined;
    } catch (error) { cleanupError = error; }
  }
  try { source?.close(); } catch (error) { cleanupError ??= error; }
  if (cleanupError) throw cleanupError;
});

test('native exact-70 archive restores the frozen migration prefix and canonical live completion provenance', () => {
  const restoredHistory = JSON.parse(queryRestore(`select jsonb_agg(jsonb_build_object('version',version,'name',name)
    order by version collate "C") from supabase_migrations.schema_migrations;`, 'postgres'));
  assert.deepEqual(restoredHistory, source.history);
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

test('native exact-70 restore retains source-fixed original77 catalog contracts and downgrades postgres', () => {
  assert.equal(queryRestore(catalogSql, 'postgres'), sourceCatalog);
  assert.equal(queryRestore("select rolsuper from pg_roles where rolname='postgres';"), 'f');
});

test('native exact-70 restore preserves immutable completion events', () => {
  const changed = executeRestore(`update private.original_77_completion_events
    set recorded_at=timestamptz '2026-10-01 00:00:00+00'
    where id='77000000-0000-4000-8000-000000000070';`, 'postgres');
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /original_77_completion_event_immutable/u);
  assert.equal(queryRestore('select count(*) from private.original_77_completion_events;', 'postgres'), '1');
});
