import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';

// Exact cached image; newly owned tmpfs-only database, no ports/network,
// no mounts/credentials, Cron launcher and all background workers disabled.
const name = `77dc-cleanup-monitor-${randomUUID()}`;
const image = 'public.ecr.aws/supabase/postgres:17.6.1.141';
const docker = (args, input) => spawnSync('docker', args, {
  input, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024,
});
let container;
function owned() {
  assert.match(container || '', /^[a-f0-9]{64}$/);
  const result = docker(['inspect', container, '--format', '{{index .Config.Labels "77dc.fixture"}}|{{.HostConfig.NetworkMode}}|{{.HostConfig.ReadonlyRootfs}}']);
  assert.equal(result.status, 0, 'Owned fixture inspection failed.');
  assert.equal(result.stdout.trim(), `${name}|none|true`);
  return container;
}
function execute(input) {
  return docker(['exec', '-i', owned(), 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
    '-h', '/tmp', '-U', 'postgres', '-d', 'postgres'], input);
}
function sql(input) {
  const result = execute(input);
  assert.equal(result.status, 0, result.stderr || 'Owned SQL failed.');
  return result.stdout.trim();
}
const health = () => JSON.parse(sql('set role service_role; select public.profile_photo_cleanup_monitor_health();'));
const migrationName = '20261007060519_profile_photo_cleanup_monitor_health.sql';
let jobId;
let cronAcl;
before(async () => {
  const inspected = docker(['image', 'inspect', image, '--format', '{{.Id}}']);
  assert.equal(inspected.status, 0, 'Pinned PostgreSQL image must already be cached.');
  const id = inspected.stdout.trim(); assert.match(id, /^sha256:[a-f0-9]{64}$/);
  const started = docker(['run', '--detach', '--pull', 'never', '--name', name,
    '--label', `77dc.fixture=${name}`, '--network', 'none', '--read-only',
    '--user', '100:101', '--memory', '512m', '--cpus', '1', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--log-driver', 'none',
    '--tmpfs', '/tmp:rw,nosuid,nodev,uid=100,gid=101,mode=0700,size=384m',
    '--entrypoint', 'bash', id, '-c',
    'initdb -D /tmp/monitor-pg -A trust --no-locale --encoding=UTF8 >/dev/null && exec postgres -D /tmp/monitor-pg -k /tmp -h "" -c shared_preload_libraries=pg_cron -c cron.database_name=postgres -c cron.launch_active_jobs=off -c max_worker_processes=0']);
  assert.equal(started.status, 0, 'Owned fixture startup failed.'); container = started.stdout.trim();
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (docker(['exec', owned(), 'pg_isready', '-h', '/tmp', '-U', 'postgres']).status === 0) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'Owned fixture did not start.');
  sql(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema private; create schema extensions;
    grant usage on schema auth,extensions to public;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table private.profile_photo_objects(state text,upload_expires_at timestamptz,next_attempt_at timestamptz,claim_expires_at timestamptz,claim_actor text,last_failed_at timestamptz);
    alter table private.profile_photo_objects enable row level security;`);
  const old = await readFile(new URL('../supabase/migrations/20260813120000_operate_profile_photo_cleanup.sql', import.meta.url), 'utf8');
  const originalHealth = old.match(/create or replace function public\.profile_photo_cleanup_health\(\)[\s\S]*?\n\$\$;/)?.[0];
  assert.ok(originalHealth);
  sql(`${originalHealth} revoke all on function public.profile_photo_cleanup_health() from public,anon,authenticated,service_role; grant execute on function public.profile_photo_cleanup_health() to service_role;`);
  sql(`begin; ${await readFile(new URL(`../supabase/migrations/${migrationName}`, import.meta.url), 'utf8')} commit;`);
});
after(() => {
  if (!container) return;
  assert.equal(docker(['rm', '--force', owned()]).status, 0, 'Only owned fixture removed.');
});

test('missing native Cron extension is explicit unhealthy metadata, not a migration failure', () => {
  const result = health();
  assert.deepEqual(result.cron, { extensionAvailable: false, catalogAvailable: false,
    jobState: 'unavailable', active: null, scheduleMatches: null, historyAvailable: false,
    stale: true, staleAfterSeconds: 900, lastRuns: [], transportEvidence: 'enqueue-only' });
  assert.equal(result.cleanup.ready, 0);
});
test('real pg_cron extension remains worker-disabled and missing job is explicit', () => {
  sql('create extension pg_cron with schema pg_catalog;');
  assert.equal(sql('show max_worker_processes; show cron.launch_active_jobs;'), '0\noff');
  assert.equal(sql("select count(*) from pg_stat_activity where backend_type like '%cron%';"), '0');
  cronAcl = sql("select coalesce(relacl::text,'') from pg_class where oid in ('cron.job'::regclass,'cron.job_run_details'::regclass) order by oid;");
  assert.equal(health().cron.jobState, 'missing');
  assert.equal(health().cron.stale, true);
});
test('real native schedule is visible without leaking command or connection identity', () => {
  jobId = sql("select cron.schedule('process-profile-photo-cleanup','*/5 * * * *','select 987654321 /* SYNTHETIC_PRIVATE_COMMAND */');");
  assert.match(jobId, /^\d+$/);
  const result = health();
  assert.equal(result.cron.active, true); assert.equal(result.cron.scheduleMatches, true);
  assert.equal(result.cron.historyAvailable, false); assert.equal(result.cron.stale, true);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE|987654321|username|command|database|jobid|return_message/);
});
test('exact last two native runs use lossless distinct IDs and fixed status fields', () => {
  sql(`insert into cron.job_run_details(jobid,runid,status,start_time,end_time,command,return_message) values
    (${jobId},9007199254740991,'succeeded',now()-interval '10 minutes',now()-interval '9 minutes','SECRET_COMMAND','SECRET_RESPONSE'),
    (${jobId},9007199254740992,'failed',now()-interval '5 minutes',now()-interval '4 minutes','SECRET_COMMAND','SECRET_RESPONSE'),
    (${jobId},9007199254740993,'succeeded',now()-interval '1 minute',now(),'SECRET_COMMAND','SECRET_RESPONSE'),
    (99999,9007199254740994,'failed',now(),now(),'OTHER_JOB','OTHER_RESPONSE');`);
  const result = health();
  assert.deepEqual(result.cron.lastRuns.map(r => [r.runId,r.status]), [['9007199254740993','succeeded'],['9007199254740992','failed']]);
  assert.equal(result.cron.stale, false); assert.equal(result.cron.historyAvailable, true);
  assert.equal(result.cron.transportEvidence, 'enqueue-only');
  assert.doesNotMatch(JSON.stringify(result), /SECRET_|OTHER_|command|return_message/);
});
test('unknown native status is reduced to a fixed label and newest pending run is retained', () => {
  sql(`insert into cron.job_run_details(jobid,runid,status,start_time) values (${jobId},9007199254740995,'PRIVATE_STATUS_PATH',now()),(${jobId},9007199254740996,'running',now());`);
  const runs = health().cron.lastRuns;
  assert.deepEqual(runs.map(r => r.status), ['running','unknown']);
  assert.equal(runs[0].endedAt, null);
});
test('stale, future and missing start times cannot report a fresh schedule', () => {
  for (const start of ["now()-interval '16 minutes'", "now()+interval '1 minute'", 'null']) {
    sql(`update cron.job_run_details set start_time=${start} where jobid=${jobId};`);
    assert.equal(health().cron.stale, true);
  }
});
test('inactive or changed schedule is explicit and does not cause repairs', () => {
  sql(`select cron.alter_job(${jobId},schedule:='* * * * *',active:=false);`);
  const result = health(); assert.equal(result.cron.active, false); assert.equal(result.cron.scheduleMatches, false);
  assert.equal(sql(`select schedule||'|'||active from cron.job where jobid=${jobId};`), '* * * * *|false');
});
test('same-name jobs under another owner fail closed as ambiguous with no history leak', () => {
  sql(`insert into cron.job(schedule,command,nodename,nodeport,database,username,active,jobname)
    select schedule,'OTHER_COMMAND',nodename,nodeport,database,'fixture_other_owner',active,jobname from cron.job where jobid=${jobId};`);
  const result = health(); assert.equal(result.cron.jobState, 'ambiguous');
  assert.equal(result.cron.active, null); assert.equal(result.cron.scheduleMatches, null);
  assert.deepEqual(result.cron.lastRuns, []); assert.equal(result.cron.stale, true);
  sql("delete from cron.job where username='fixture_other_owner';");
});
test('cleanup aggregate is actual read-only old reader, preserving all row state', () => {
  sql(`insert into private.profile_photo_objects values
    ('cleanup',null,now()-interval '20 minutes',null,null,null),
    ('cleanup',null,now()-interval '2 minutes',now()-interval '1 minute','service',now()),
    ('cleanup',null,now()+interval '1 hour',null,null,null),
    ('pending_upload',now()-interval '1 minute',now(),null,null,null);`);
  const before = sql('select jsonb_agg(to_jsonb(t)) from private.profile_photo_objects t;');
  const result = health(); assert.equal(result.cleanup.ready, 2); assert.equal(result.cleanup.staleLeases, 1);
  assert.equal(result.cleanup.backingOff, 1); assert.equal(result.cleanup.expiredPending, 1); assert.equal(result.cleanup.failuresLastHour, 1);
  assert.equal(sql('select jsonb_agg(to_jsonb(t)) from private.profile_photo_objects t;'), before);
});
test('native role/identity/ACL pgTAP checks pass and no Cron table privilege changed', async () => {
  const output = sql(await readFile(new URL('../supabase/tests/database/320_profile_photo_cleanup_monitor_health.sql', import.meta.url), 'utf8'));
  assert.doesNotMatch(output, /^not ok/m); assert.match(output, /1\.\.12/);
  assert.equal((output.match(/^ok \d+/gm) || []).length, 12);
  assert.equal(sql("select coalesce(relacl::text,'') from pg_class where oid in ('cron.job'::regclass,'cron.job_run_details'::regclass) order by oid;"), cronAcl);
  assert.equal(sql("select count(*) from pg_stat_activity where backend_type like '%cron%';"), '0');
});
test('monitor RPC succeeds inside a genuinely read-only service transaction', () => {
  const result = JSON.parse(sql('begin read only; set local role service_role; select public.profile_photo_cleanup_monitor_health(); rollback;'));
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.cron.transportEvidence, 'enqueue-only');
});
test('CI runs the owned health fixture immediately after exact image cache preparation', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(workflow, /      - name: Cache verified exact-version fixture images without ECR downloads\n        timeout-minutes: 10\n        run: node scripts\/prepare-ci-fixture-images\.mjs\n      - name: Verify isolated read-only profile-photo monitor health\n        timeout-minutes: 5\n        run: node --test scripts\/profile-photo-cleanup-monitor\.sql\.test\.mjs\n/);
  assert.equal((workflow.match(/run: node --test scripts\/profile-photo-cleanup-monitor\.sql\.test\.mjs/g) || []).length, 1);
});
