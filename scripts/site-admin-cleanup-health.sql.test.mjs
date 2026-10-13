import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, test } from 'node:test';

// Exact-version cached image, newly owned socket-only tmpfs database. No network,
// host mounts/ports, credentials, existing local cluster or Cron execution.
const name = `77dc-admin-cleanup-${randomUUID()}`;
const image = 'public.ecr.aws/supabase/postgres:17.6.1.141';
const migrationName = '20261013055744_site_admin_cleanup_health.sql';
const actor = '10000000-0000-4000-8000-000000000001';
const member = '10000000-0000-4000-8000-000000000002';
const reserve = '10000000-0000-4000-8000-000000000003';
const session = '30000000-0000-4000-8000-000000000001';
const memberSession = '30000000-0000-4000-8000-000000000002';
const factor = '20000000-0000-4000-8000-000000000001';
const signature = 'public.site_admin_get_cleanup_health(uuid)';
const sentinel = 'SYNTHETIC_PRIVATE_OBJECT_COMMAND_RESPONSE';
const counterKeys = ['expiredPending','ready','leased','staleLeases','backingOff','failuresLastHour'];
const eligible = "greatest(next_attempt_at, coalesce(claim_expires_at, '-infinity'::timestamptz))";
const literal = value => value === null ? 'null' : `'${String(value).replaceAll("'", "''")}'`;
const docker = (args, input) => spawnSync('docker', args, { input, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
let container; let imageId; let migration; let originalBoundary; let originalService; let cronBoundary; let jobId; let buildCost; let writeBefore; let writeAfter;
function checked(result) { assert.equal(result.status, 0, result.stderr || 'Owned fixture operation failed.'); return result.stdout.trim(); }
function owned() {
  assert.match(container || '', /^[a-f0-9]{64}$/);
  const value = JSON.parse(checked(docker(['inspect', container, '--format', '{{json .}}'])));
  assert.equal(value.Config.Labels['77dc.fixture'], name); assert.equal(value.Name, `/${name}`);
  assert.equal(value.Image, imageId); assert.equal(value.HostConfig.NetworkMode, 'none');
  assert.equal(value.HostConfig.ReadonlyRootfs, true); assert.deepEqual(value.HostConfig.PortBindings, {});
  assert.equal(value.Mounts.filter(m => m.Type !== 'tmpfs').length, 0);
  return container;
}
function raw(input) { return checked(docker(['exec','-i',owned(),'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h','/tmp','-U','postgres','-d','postgres'], `set statement_timeout='20s';${input}`)); }
const json = input => JSON.parse(raw(input));
const jsonCatalog = query => `select row_to_json(proof)from(${query.trim().replace(/;$/,'')})proof;`;
const source = file => readFile(new URL(`../supabase/${file}`, import.meta.url), 'utf8');
const health = (expected = actor) => `select public.site_admin_get_cleanup_health(${literal(expected)});`;
function asActor(input, { id = actor, sid = session, aal = 'aal2', origin = 'https://77dominion.com', claims = {} } = {}) {
  return `set request.jwt.claims=${literal(JSON.stringify({sub:id,session_id:sid,role:'authenticated',aal,...claims}))};
    set request.headers=${literal(JSON.stringify({origin}))};set role authenticated;${input}`;
}
function denied(input, state) {
  return `do $denied$ begin begin ${input.replace(/^select /,'perform ')} exception when sqlstate '${state}' then return;end;raise exception 'Expected denial';end $denied$;`;
}
function boundary() {
  return json(`select jsonb_build_object('tables',(select jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relowner,c.relrowsecurity,c.relforcerowsecurity,c.relacl::text) order by n.nspname,c.relname)
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname in ('auth','private')),
    'policies',(select coalesce(jsonb_agg(to_jsonb(p) order by p.schemaname,p.tablename,p.policyname),'[]') from pg_policies p));`);
}
function nodes(plan) { return [plan,...(plan.Plans || []).flatMap(nodes)]; }
function zeroCounts(result) { for (const key of counterKeys) assert.deepEqual(result.counters[key],{count:0,hasMore:false}); }
const writeProbe = `begin;explain(analyze,buffers,wal,format json)update private.profile_photo_objects set next_attempt_at=next_attempt_at+interval '1 minute',last_failed_at=statement_timestamp()
  where id in(select id from private.profile_photo_objects where state='cleanup' order by id limit 1000);rollback;`;
function insertRows(kind, amount, prefix = kind) {
  const pending = kind === 'expiredPending';
  const leased = kind === 'leased' || kind === 'staleLeases';
  const retired = kind === 'retired' || kind === 'failuresLastHour';
  return `insert into private.profile_photo_objects(id,user_id,storage_path,state,upload_expires_at,claim_token,claim_expires_at,claim_actor,next_attempt_at,last_failed_at,retired_at,created_at)
    select md5(${literal(prefix)}||n)::uuid,'${actor}','${actor}/avatar-'||${literal(prefix)}||'-'||n||'.jpg',
      '${pending ? 'pending_upload' : retired ? 'retired' : 'cleanup'}',${pending ? "statement_timestamp()-interval '1 hour'" : 'null'},
      ${leased ? "md5('claim-'||n)::uuid" : 'null'},${leased ? `statement_timestamp()${kind === 'leased' ? '+' : '-'}interval '10 minutes'` : 'null'},
      ${leased ? "'service'" : 'null'},statement_timestamp()${kind === 'backingOff' ? '+' : '-'}interval '2 hours',
      ${kind === 'failuresLastHour' ? "statement_timestamp()-interval '30 minutes'" : 'null'},${retired ? "statement_timestamp()-interval '1 day'" : 'null'},
      statement_timestamp()-interval '3 days' from generate_series(1,${amount})n;`;
}

before(async () => {
  migration = await source(`migrations/${migrationName}`);
  imageId = checked(docker(['image','inspect',image,'--format','{{.Id}}'])); assert.match(imageId,/^sha256:[a-f0-9]{64}$/);
  container = checked(docker(['run','--detach','--pull','never','--name',name,'--label',`77dc.fixture=${name}`,
    '--network','none','--read-only','--user','100:101','--memory','512m','--cpus','1','--cap-drop','ALL',
    '--security-opt','no-new-privileges','--log-driver','none','--tmpfs','/tmp:rw,nosuid,nodev,uid=100,gid=101,mode=0700,size=384m',
    '--entrypoint','bash',imageId,'-c','initdb -D /tmp/admin-cleanup-pg -A trust --no-locale --encoding=UTF8 >/dev/null && exec postgres -D /tmp/admin-cleanup-pg -k /tmp -h "" -c shared_preload_libraries=pg_cron -c cron.database_name=postgres -c cron.launch_active_jobs=off -c max_worker_processes=0 -c shared_buffers=32MB -c max_wal_size=64MB -c min_wal_size=32MB']));
  let ready = false;
  for (let attempt=0;attempt<100;attempt++) {
    if (docker(['exec',owned(),'pg_isready','-h','/tmp','-U','postgres']).status===0) { ready=true;break; }
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(ready);
  raw(`create role anon;create role authenticated;create role service_role bypassrls;
    create role supabase_auth_admin nologin nosuperuser nobypassrls;
    create role fixture_migration nologin nosuperuser nobypassrls;
    create role fixture_reader nologin nosuperuser bypassrls;
    create schema auth;create schema extensions;
    grant create on database postgres to fixture_migration;
    grant usage on schema auth,public to anon,authenticated,service_role,fixture_migration,fixture_reader,supabase_auth_admin;
    grant create on schema public to fixture_migration;
    create table auth.users(id uuid primary key,email text,created_at timestamptz,email_confirmed_at timestamptz default now(),is_anonymous boolean default false,deleted_at timestamptz,banned_until timestamptz,encrypted_password text default '${sentinel}');
    create table auth.mfa_factors(id uuid primary key,user_id uuid references auth.users on delete cascade,factor_type text,status text,secret text default '${sentinel}');
    create table auth.sessions(id uuid primary key,user_id uuid references auth.users on delete cascade,factor_id uuid references auth.mfa_factors,aal text,not_after timestamptz);
    create table auth.mfa_amr_claims(session_id uuid references auth.sessions on delete cascade,authentication_method text,updated_at timestamptz);
    create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
    insert into auth.users(id,email) values('${actor}','${sentinel}@example.invalid'),('${member}','member@example.invalid'),('${reserve}','reserve@example.invalid');
    alter table auth.users owner to supabase_auth_admin;alter table auth.sessions owner to supabase_auth_admin;alter table auth.mfa_factors owner to supabase_auth_admin;alter table auth.mfa_amr_claims owner to supabase_auth_admin;
    grant select,insert,update,delete,truncate,references,trigger,maintain on auth.users,auth.sessions,auth.mfa_factors,auth.mfa_amr_claims to fixture_migration;
    set role fixture_migration;begin;${await source('migrations/20260913062841_site_admin_foundation.sql')}commit;reset role;
    insert into auth.mfa_factors values('${factor}','${actor}','totp','verified','${sentinel}'),
      ('20000000-0000-4000-8000-000000000002','${member}','totp','verified','${sentinel}'),('20000000-0000-4000-8000-000000000003','${reserve}','totp','verified','${sentinel}');
    select private.bootstrap_site_admin('${actor}','50000000-0000-4000-8000-000000000001','production');
    update private.site_user_roles set role_key='site_admin' where user_id='${reserve}';
    insert into auth.sessions values('${session}','${actor}','${factor}','aal2',null),('${memberSession}','${member}','20000000-0000-4000-8000-000000000002','aal2',null);`);
  const base = await source('migrations/20260722152851_harden_profile_photo_thumbnails.sql');
  const operate = await source('migrations/20260813120000_operate_profile_photo_cleanup.sql');
  const table = base.slice(base.indexOf('create table private.profile_photo_objects ('),base.indexOf('create or replace function private.profile_photo_path_sha256'));
  const alter = operate.slice(operate.indexOf('alter table private.profile_photo_objects'),operate.indexOf('create or replace function private.normalize_profile_photo_cleanup_lease'));
  const trusted=await source('migrations/20260813193158_trusted_profile_photo_upload_pipeline.sql');
  const trustedColumns=trusted.slice(trusted.indexOf('alter table private.profile_photo_objects'),trusted.indexOf('create or replace function private.guard_profile_photo_object_transition'));
  const registration=await source('migrations/20260723162027_rate_limit_profile_photo_registrations.sql');
  const registrationIndex=registration.match(/create index profile_photo_objects_user_created_at_idx[\s\S]*?;/)?.[0];assert.ok(registrationIndex);
  assert.ok(table.length>1000 && alter.length>1000);
  raw(`set role fixture_migration;${table}${alter}${trustedColumns}${registrationIndex}reset role;`);
  const oldHealth = operate.match(/create or replace function public\.profile_photo_cleanup_health\(\)[\s\S]*?\n\$\$;/)?.[0]; assert.ok(oldHealth);
  raw(`${oldHealth}revoke all on function public.profile_photo_cleanup_health() from public,anon,authenticated,service_role;grant execute on function public.profile_photo_cleanup_health() to service_role;
    begin;${await source('migrations/20261007060519_profile_photo_cleanup_monitor_health.sql')}commit;
    grant usage on schema private to fixture_reader;grant select on private.profile_photo_objects to fixture_reader;
    grant execute on function private.require_site_admin(text,uuid,boolean) to fixture_reader;`);
  originalBoundary=boundary(); originalService=raw("select pg_get_functiondef('public.profile_photo_cleanup_monitor_health()'::regprocedure),pg_get_functiondef('public.profile_photo_cleanup_health()'::regprocedure);");
  raw(`${insertRows('retired',70000)}${counterKeys.map(key=>insertRows(key,5000)).join('\n')}vacuum(analyze)private.profile_photo_objects;`);
  raw('checkpoint;');writeBefore=json(writeProbe)[0];raw('vacuum(analyze)private.profile_photo_objects;');
  buildCost=json(`set role fixture_migration;begin;do $$begin perform set_config('fixture.build_started_at',clock_timestamp()::text,true);end$$;${migration}
    select jsonb_build_object('elapsedMs',extract(epoch from(clock_timestamp()-current_setting('fixture.build_started_at')::timestamptz))*1000,
      'relationBytes',pg_relation_size('private.profile_photo_objects'),'totalBytes',pg_total_relation_size('private.profile_photo_objects'),
      'indexBytes',(select jsonb_object_agg(indexrelname,pg_relation_size(indexrelid))from pg_stat_user_indexes where schemaname='private' and indexrelname like 'profile_photo_objects_cleanup_%'),
      'heldRegistryLocks',(select jsonb_agg(mode order by mode)from pg_locks where pid=pg_backend_pid() and relation='private.profile_photo_objects'::regclass and granted));commit;`);
  raw('checkpoint;');writeAfter=json(writeProbe)[0];
  raw(`alter function ${signature} owner to fixture_reader;truncate private.profile_photo_objects;`);
});
after(() => { if(container) checked(docker(['rm','--force',owned()])); });

test('migration changes only three indexes and the guarded read function, preserving all authority and service boundaries', () => {
  assert.deepEqual(boundary(),originalBoundary);
  assert.equal(raw("select pg_get_functiondef('public.profile_photo_cleanup_monitor_health()'::regprocedure),pg_get_functiondef('public.profile_photo_cleanup_health()'::regprocedure);"),originalService);
  assert.doesNotMatch(migration,/create\s+(table|role|policy)|alter\s+(table|role)|insert\s+into|delete\s+from|update\s+(public|private)|grant\s+[^;]*\bon\s+(table\s+)?(private|auth|cron)\./i);
  assert.equal((migration.match(/create index /g)||[]).length,3);
  for(const role of ['anon','authenticated','service_role','fixture_migration']) raw(`set session authorization ${role};${denied('set role fixture_reader;','42501')}`);
});

test('every call rechecks live native identity, origin, account, session, canonical role, MFA and permission', () => {
  for(const role of ['anon','service_role']) raw(`set role ${role};${denied(health(),'42501')}`);
  for(const expected of [null,member]) raw(asActor(denied(health(expected),'PT401')));
  raw(asActor(denied(health(member),'PT403'),{id:member,sid:memberSession,claims:{user_metadata:{role:'site_admin'},app_metadata:{role:'site_admin'}}}));
  for(const [options,state] of [[{aal:'aal1'},'PT403'],[{sid:randomUUID()},'PT401'],[{sid:memberSession},'PT401'],[{sid:null},'PT401'],[{origin:'https://attacker.invalid'},'PT403'],[{origin:null},'PT403'],[{claims:{role:'service_role'}},'PT401']]) raw(asActor(denied(health(),state),options));
  const changes=[
    [`delete from auth.sessions where id='${session}';`,'PT401'],
    [`update auth.sessions set not_after=now()-interval '1 second' where id='${session}';`,'PT401'],
    [`update auth.sessions set aal='aal1' where id='${session}';`,'PT403'],
    [`update auth.sessions set factor_id=null where id='${session}';`,'PT403'],
    [`update auth.mfa_factors set status='unverified' where id='${factor}';`,'PT403'],
    [`update auth.mfa_factors set factor_type='phone' where id='${factor}';`,'PT403'],
    [`update auth.users set deleted_at=now() where id='${actor}';`,'PT401'],
    [`update auth.users set banned_until=now()+interval '1 hour' where id='${actor}';`,'PT401'],
    [`update auth.users set is_anonymous=true where id='${actor}';`,'PT401'],
    [`update auth.users set email_confirmed_at=null where id='${actor}';`,'PT401'],
    [`update private.site_user_roles set role_key='member' where user_id='${actor}';`,'PT403'],
    ["delete from private.site_role_permissions where permission_key='operations.read';",'PT403'],
    [`insert into private.site_admin_session_blocks values('${session}','${actor}',now(),gen_random_uuid());`,'PT403'],
  ];
  for(const [change,state] of changes) raw(`begin;${change}${asActor(denied(health(),state))}rollback;`);
});

test('read-only response exposes exactly capped metadata and no private identifiers, notes or fields', () => {
  const result=json(`begin read only;${asActor(health())}rollback;`);
  assert.deepEqual(Object.keys(result).sort(),['actorId','counterLimit','counters','cron','observedAt','oldestEligibleAt','schemaVersion']);
  assert.equal(result.actorId,actor);assert.equal(result.counterLimit,1000);assert.equal(result.schemaVersion,1);zeroCounts(result);
  assert.equal(result.oldestEligibleAt,null);assert.equal(result.cron.jobState,'unavailable');assert.equal(result.cron.historyCoverage,'unavailable');assert.equal(result.cron.freshness,'unknown');
  assert.deepEqual(result.cron.lastRuns,[]);assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC_PRIVATE|storage|userId|command|error|token|secret|runId|jobId|healthy/);
  assert.deepEqual(json(`begin;${asActor(`do $$begin perform public.site_admin_get_cleanup_health('${actor}');end$$;select current_setting('response.headers')::jsonb;`)}rollback;`),[{'Cache-Control':'private, no-store'},{Pragma:'no-cache'}]);
});

test('operations.read alone suffices, with no queue or lifecycle mutation', () => {
  const before=raw('select coalesce(jsonb_agg(to_jsonb(r) order by id),\'[]\') from private.profile_photo_objects r;');
  const result=json(`begin;delete from private.site_role_permissions where role_key='site_admin' and permission_key<>'operations.read';${asActor(health())}rollback;`);
  assert.equal(result.schemaVersion,1);assert.equal(raw('select coalesce(jsonb_agg(to_jsonb(r) order by id),\'[]\') from private.profile_photo_objects r;'),before);
});

test('all six counters distinguish empty, exact1000 and1000+ without an uncapped count', () => {
  for(const amount of [0,1,999,1000,1001,5000]) {
    const result=json(`begin;truncate private.profile_photo_objects;${counterKeys.map(key=>insertRows(key,amount)).join('\n')}${asActor(health())}rollback;`);
    for(const key of counterKeys) {
      const expected=key==='ready'?amount*2:amount; // stale service leases overlap ready.
      assert.deepEqual(result.counters[key],{count:Math.min(expected,1000),hasMore:expected>1000});
    }
    assert.equal(result.oldestEligibleAt===null,amount===0);
  }
  for(const amount of [1000,1001]) {
    const result=json(`begin;${insertRows('ready',amount)}${asActor(health())}rollback;`);
    assert.deepEqual(result.counters.ready,{count:1000,hasMore:amount>1000});
  }
});

test('eligibility uses the later of backoff and lease expiry; counters intentionally overlap', () => {
  const result=json(`begin;${insertRows('ready',1)}${insertRows('staleLeases',1)}${insertRows('leased',1)}${insertRows('backingOff',1)}
    update private.profile_photo_objects set next_attempt_at=statement_timestamp()-interval '3 hours' where claim_actor='service';
    update private.profile_photo_objects set next_attempt_at='2026-01-01T00:00:00Z' where state='cleanup' and claim_actor is null and next_attempt_at<statement_timestamp();
    update private.profile_photo_objects set last_failed_at=statement_timestamp()-interval '30 minutes';
    ${asActor(health())}rollback;`);
  assert.equal(result.counters.ready.count,2);assert.equal(result.counters.leased.count,1);assert.equal(result.counters.staleLeases.count,1);assert.equal(result.counters.backingOff.count,1);assert.equal(result.counters.failuresLastHour.count,4);
  assert.equal(result.oldestEligibleAt,'2026-01-01T00:00:00+00:00');
  const leaseBound=json(`begin;${insertRows('staleLeases',1)}update private.profile_photo_objects set next_attempt_at='2026-01-01T00:00:00Z',claim_expires_at='2026-01-02T00:00:00Z';${asActor(health())}rollback;`);
  assert.equal(leaseBound.oldestEligibleAt,'2026-01-02T00:00:00+00:00');assert.equal(leaseBound.counters.ready.count,1);
});

test('failure window excludes future timestamps without letting future rows consume the real cap', () => {
  for(const amount of [0,1,1000,1001]) {
    const result=json(`begin;${insertRows('failuresLastHour',5000,'future')}
      update private.profile_photo_objects set last_failed_at=statement_timestamp()+interval '1 hour';
      ${insertRows('failuresLastHour',amount,'past')}${asActor(health())}rollback;`);
    assert.deepEqual(result.counters.failuresLastHour,{count:Math.min(amount,1000),hasMore:amount>1000});
  }
});

test('real native Cron stays worker-disabled and fixed-name missing/present/ambiguous states are sanitized', () => {
  raw('create extension pg_cron;create extension plpgsql_check with schema extensions;grant usage on schema cron to fixture_reader;grant select on cron.job,cron.job_run_details to fixture_reader;');
  cronBoundary=raw("select relname,relacl::text from pg_class where oid in ('cron.job'::regclass,'cron.job_run_details'::regclass) order by oid;");
  assert.deepEqual(json(`select coalesce(jsonb_agg(to_jsonb(r)),'[]') from extensions.plpgsql_check_function_tb('${signature}'::regprocedure)r where level='error';`),[]);
  assert.equal(json(asActor(health())).cron.jobState,'missing');
  jobId=raw(`select cron.schedule('process-profile-photo-cleanup','*/5 * * * *','select 1 /* ${sentinel} */');`);assert.match(jobId,/^\d+$/);
  let result=json(asActor(health()));assert.equal(result.cron.jobState,'present');assert.equal(result.cron.active,true);assert.equal(result.cron.scheduleMatches,true);assert.equal(result.cron.historyCoverage,'complete');assert.equal(result.cron.freshness,'stale');
  raw(`insert into cron.job(schedule,command,nodename,nodeport,database,username,active,jobname) select schedule,'${sentinel}',nodename,nodeport,database,'fixture_other',active,jobname from cron.job where jobid=${jobId};`);
  result=json(asActor(health()));assert.equal(result.cron.jobState,'ambiguous');assert.equal(result.cron.active,null);assert.equal(result.cron.scheduleMatches,null);assert.equal(result.cron.historyCoverage,'unavailable');assert.equal(result.cron.freshness,'unknown');assert.deepEqual(result.cron.lastRuns,[]);
  raw("delete from cron.job where username='fixture_other';");
  raw(`select cron.alter_job(${jobId},schedule:='* * * * *',active:=false);`);
  result=json(asActor(health()));assert.equal(result.cron.active,false);assert.equal(result.cron.scheduleMatches,false);
  assert.equal(raw('show cron.launch_active_jobs;show max_worker_processes;'),'off\n0');assert.equal(raw("select count(*) from pg_stat_activity where backend_type like '%cron%';"),'0');
});

test('Cron exact1000/1001 coverage uses global run-ID tail, never a filtered unbounded walk', () => {
  for(const amount of [0,1,999,1000,1001,100000]) {
    const result=json(`begin;truncate cron.job_run_details;insert into cron.job_run_details(jobid,runid,status,start_time,end_time,command,return_message)
      select case when n=1 or n=${amount} then ${jobId} else 99999 end,n,'succeeded',statement_timestamp()-n*interval '1 second',statement_timestamp(),'${sentinel}','${sentinel}' from generate_series(1,${amount})n;
      ${asActor(health())}rollback;`);
    assert.equal(result.cron.historyCoverage,amount>1000?'bounded':'complete');
    assert.equal(result.cron.lastRuns.length,amount===0?0:amount===1||amount>1000?1:2);
    assert.equal(result.cron.freshness,amount>1000?'unknown':amount===0||amount>900?'stale':'fresh');
    assert.equal(result.cron.lastRunsOrder,'run-id-desc');assert.equal(result.cron.historyLimit,1000);assert.equal(result.cron.transportEvidence,'enqueue-only');
    assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC_PRIVATE|runId|jobId|command|return_message|username/);
    for(const run of result.cron.lastRuns) assert.deepEqual(Object.keys(run).sort(),['endedAt','startedAt','status']);
  }
});

test('newest allocation start, not max wall clock, controls complete-history freshness; invalid metadata is unknown', () => {
  for(const [time,expected] of [["statement_timestamp()-interval '16 minutes'",'stale'],["statement_timestamp()-interval '1 minute'",'fresh'],["statement_timestamp()+interval '1 minute'",'unknown'],["'infinity'::timestamptz",'unknown'],['null','unknown']]) {
    const result=json(`begin;truncate cron.job_run_details;insert into cron.job_run_details(jobid,runid,status,start_time,end_time) values
      (${jobId},1,'running',statement_timestamp(),null),(${jobId},2,'${sentinel}',${time},'-infinity');${asActor(health())}rollback;`);
    assert.equal(result.cron.freshness,expected);assert.equal(result.cron.lastRuns[0].status,'unknown');assert.equal(result.cron.lastRuns[0].endedAt,null);
  }
});

test('exact probes preserve capped semantics under custom/generic and churn plans; physical stress work is reported separately', t => {
  const counters=migration.match(/-- BEGIN BOUNDED COUNTERS\n([\s\S]*?)\n  -- END BOUNDED COUNTERS/)?.[1].replace(' into counters','').replaceAll('observed_at','$1');
  const oldest=migration.match(/-- BEGIN OLDEST ELIGIBLE\n([\s\S]*?)\n  -- END OLDEST ELIGIBLE/)?.[1].replace(' into oldest_eligible_at','').replaceAll('observed_at','$1');
  assert.ok(counters&&oldest);
  const evidence=[];
  for(const scenario of ['sparse','dense','empty','churn','future-mixed','future-only']) {
    raw(`truncate private.profile_photo_objects;${insertRows('retired',scenario==='sparse'||scenario==='empty'?99400:70000)}${counterKeys.map(key=>insertRows(key,scenario==='empty'?0:scenario==='sparse'?100:5000)).join('\n')}
      ${scenario.startsWith('future-')?"update private.profile_photo_objects set last_failed_at=statement_timestamp()+interval '1 hour' where last_failed_at is not null;":''}
      ${scenario==='future-mixed'?insertRows('failuresLastHour',5000,'actual-past'):''}vacuum(analyze) private.profile_photo_objects;`);
    if(scenario==='churn')raw("update private.profile_photo_objects set updated_at=statement_timestamp() where id in (select id from private.profile_photo_objects order by id limit 10000);analyze private.profile_photo_objects;");
    const result=json(asActor(health()));
    for(const mode of ['force_custom_plan','force_generic_plan']) for(const [label,query] of [['counters',counters],['oldest',oldest]]) {
      const full=json(`set role fixture_reader;set plan_cache_mode=${mode};prepare measured(timestamptz) as ${query} explain(analyze,buffers,format json)execute measured(statement_timestamp());`)[0];
      const all=nodes(full.Plan);assert.ok(!all.some(n=>n['Node Type']==='Seq Scan'&&n['Relation Name']==='profile_photo_objects'),`${scenario}/${mode}/${label}`);
      const scans=all.filter(n=>n['Relation Name']==='profile_photo_objects');assert.equal(scans.length,label==='counters'?6:1);
      for(const scan of scans) {
        assert.ok(scan['Index Name']||nodes(scan).some(n=>n['Node Type']==='Bitmap Index Scan'),JSON.stringify({scenario,mode,label,scan}));
        assert.equal(scan['Rows Removed by Filter']||0,0,JSON.stringify({scenario,mode,label,scan}));
        assert.ok(scan['Actual Rows']<=(scenario==='churn'?10000:label==='counters'?1001:1));
      }
      if(scenario!=='churn')assert.ok(!all.some(n=>n['Node Type']==='Sort'));
      evidence.push({scenario,mode,label,ms:full['Execution Time'],buffers:full.Plan['Shared Hit Blocks']+full.Plan['Shared Read Blocks'],sorts:all.filter(n=>n['Node Type']==='Sort').map(n=>({inputRows:n.Plans[0]['Actual Rows'],method:n['Sort Method']})),scans:scans.map(n=>({type:n['Node Type'],index:n['Index Name'],rows:n['Actual Rows'],heapFetches:n['Heap Fetches']}))});
      const executed=json(`set role fixture_reader;set plan_cache_mode=${mode};prepare measured(timestamptz) as ${counters} execute measured(statement_timestamp());`);
      assert.deepEqual(executed,result.counters);
    }
    // The actual guarded PL/pgSQL RPC also executes with forced generic plans.
    assert.deepEqual(json(`set plan_cache_mode=force_generic_plan;${asActor(health())}`).counters,result.counters);
  }
  t.diagnostic(JSON.stringify({logicalOrderedPrefixLimit:1001,notAbsoluteScanOrHeapWorkBound:true,evidence}));
  raw('truncate private.profile_photo_objects;');
});

test('transactional index cost is measured, SHARE locks are explicit, and fixture canonical catalog pins are reported', t => {
  assert.ok(buildCost.heldRegistryLocks.includes('ShareLock'));assert.ok(buildCost.elapsedMs<30000);
  assert.equal(Object.keys(buildCost.indexBytes).length,3);
  const reduce = plan=>({executionMs:plan['Execution Time'],sharedBlocks:plan.Plan['Shared Hit Blocks']+plan.Plan['Shared Read Blocks'],walBytes:plan.Plan['WAL Bytes'],walRecords:plan.Plan['WAL Records'],walFullPageImages:plan.Plan['WAL FPI']});
  t.diagnostic(JSON.stringify({indexBuild100000Rows:buildCost,write1000RowsBefore:reduce(writeBefore),write1000RowsAfter:reduce(writeAfter),limitations:'Single synthetic warm-cache sample, not production latency; table columns/checks/indexes are actual sources, lifecycle triggers and Storage are omitted. Write probes rolled back but still generated WAL and dead versions. Three ordinary index builds retain SHARE lock to transaction end; 5s lock and30s statement timeouts, no universal total-duration guarantee.'}));
  const catalog=json(`set search_path=pg_catalog;set timezone='UTC';set datestyle='ISO,YMD';select jsonb_build_object(
    'functions',(select jsonb_object_agg(sig,encode(sha256(convert_to(pg_get_functiondef(to_regprocedure(sig)),'UTF8')),'hex'))from unnest(array['public.site_admin_get_cleanup_health(uuid)','private.require_site_admin(text,uuid,boolean)','private.site_admin_request_identity(uuid)','private.site_admin_mfa_ready(uuid,uuid,boolean)','public.profile_photo_cleanup_health()','public.profile_photo_cleanup_monitor_health()'])sig),
    'indexes',(select jsonb_object_agg(c.relname,jsonb_build_object('hash',encode(sha256(convert_to(pg_get_indexdef(c.oid),'UTF8')),'hex'),'definition',pg_get_indexdef(c.oid)))from pg_class c join pg_index i on i.indexrelid=c.oid where i.indrelid='private.profile_photo_objects'::regclass),
    'columns',(select jsonb_agg(jsonb_build_array(attnum,attname,format_type(atttypid,atttypmod),attnotnull)order by attnum)from pg_attribute where attrelid='private.profile_photo_objects'::regclass and attnum>0 and not attisdropped));`);
  t.diagnostic('CANONICAL_CLEANUP_CATALOG '+JSON.stringify(catalog));
});

test('native ACL pgTAP checks pass and private/service/Cron privileges and records remain unchanged', async () => {
  const output=raw(await source('tests/database/340_site_admin_cleanup_health.sql'));
  assert.doesNotMatch(output,/^not ok/m);assert.match(output,/1\.\.20/);assert.equal((output.match(/^ok \d+/gm)||[]).length,20);
  assert.equal(raw("select relname,relacl::text from pg_class where oid in ('cron.job'::regclass,'cron.job_run_details'::regclass) order by oid;"),cronBoundary);
  const before=raw('select to_jsonb(j) from cron.job j order by jobid;');json(`begin read only;${asActor(health())}rollback;`);assert.equal(raw('select to_jsonb(j) from cron.job j order by jobid;'),before);
});

test('exact74 production catalog accepts source metadata and independently rejects source, privilege, index, history and column drift', async () => {
  const query=jsonCatalog(await readFile(new URL('./verify-production-admin-cleanup-health.sql',import.meta.url),'utf8'));
  const history=(await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort();assert.equal(history.length,74);
  raw(`reassign owned by fixture_migration to postgres;alter function ${signature} owner to postgres;
    revoke all on private.profile_photo_objects from fixture_reader;revoke all on function private.require_site_admin(text,uuid,boolean)from fixture_reader;
    create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key,name text not null);
    insert into supabase_migrations.schema_migrations values ${history.map(n=>`(${literal(n.slice(0,14))},${literal(n.slice(15,-4))})`).join(',')};`);
  const passing=json(`begin read only;${query}rollback;`);assert.equal(Object.keys(passing).length,10);
  assert.ok(Object.values(passing).every(v=>v===true),JSON.stringify(passing));
  const cases=[
    ["update supabase_migrations.schema_migrations set name='other' where version='20261013055744';",['exact_migration_history_ok']],
    ["delete from supabase_migrations.schema_migrations where version='20261013055744';",['exact_migration_history_ok']],
    [`alter function ${signature} set lock_timeout='2s';`,['cleanup_rpc_catalog_ok']],
    [`alter function ${signature} security invoker;`,['cleanup_rpc_catalog_ok']],
    [`grant execute on function ${signature} to anon;`,['cleanup_rpc_catalog_ok']],
    [`grant execute on function ${signature} to service_role;`,['cleanup_rpc_catalog_ok']],
    [`revoke execute on function ${signature} from authenticated;`,['cleanup_rpc_catalog_ok']],
    ["alter function private.require_site_admin(text,uuid,boolean) set search_path=public;",['existing_admin_guards_ok']],
    ["grant execute on function private.site_admin_request_identity(uuid)to authenticated;",['existing_admin_guards_ok']],
    ["alter function public.profile_photo_cleanup_monitor_health() set search_path=public;",['service_health_preserved_ok']],
    ["grant execute on function public.profile_photo_cleanup_health()to authenticated;",['service_health_preserved_ok']],
    ["drop index private.profile_photo_objects_cleanup_eligible_idx;",['cleanup_indexes_ok']],
    ["update pg_index set indisvalid=false where indexrelid='private.profile_photo_objects_cleanup_failure_idx'::regclass;",['cleanup_indexes_ok']],
    ["update pg_index set indisready=false where indexrelid='private.profile_photo_objects_cleanup_service_lease_idx'::regclass;",['cleanup_indexes_ok']],
    ["alter table private.profile_photo_objects disable row level security;",['registry_rls_owner_ok']],
    ["grant select on private.profile_photo_objects to authenticated;",['registry_exact_acl_ok','registry_effective_privileges_ok']],
    ["grant select(storage_path)on private.profile_photo_objects to service_role;",['registry_columns_grants_ok','registry_effective_privileges_ok']],
    ["alter table private.profile_photo_objects add column unexpected text;",['registry_columns_grants_ok']],
  ];
  for(const [mutation,expected]of cases){
    const result=json(`begin;${mutation}${query}rollback;`);
    assert.deepEqual(Object.keys(result).filter(k=>!result[k]).sort(),[...expected,'read_only_pinned_server_ok'].sort(),mutation);
  }
});

test('exact73 preflight fails closed on unknown nonempty size estimates, oversized tables, locks, history and partial objects', async () => {
  const query=jsonCatalog(await readFile(new URL('./verify-admin-cleanup-index-preflight.sql',import.meta.url),'utf8'));
  raw(`drop function ${signature};drop index private.profile_photo_objects_cleanup_eligible_idx,private.profile_photo_objects_cleanup_service_lease_idx,private.profile_photo_objects_cleanup_failure_idx;
    delete from supabase_migrations.schema_migrations where version='20261013055744';truncate private.profile_photo_objects;`);
  const passing=json(`begin read only;${query}rollback;`);assert.equal(Object.keys(passing).length,8);assert.ok(Object.values(passing).every(v=>v===true),JSON.stringify(passing));
  const cases=[
    ["update supabase_migrations.schema_migrations set name='other' where version='20261007060519';",['exact_pre_migration_history_ok']],
    ["insert into supabase_migrations.schema_migrations values('20261013055744','site_admin_cleanup_health');",['exact_pre_migration_history_ok']],
    ["alter table private.profile_photo_objects disable row level security;",['registry_shape_ok']],
    ["update pg_class set reltuples=100001 where oid='private.profile_photo_objects'::regclass;",['registry_estimate_within_bound_ok']],
    ["update pg_index set indisready=false where indexrelid='private.profile_photo_objects_expiry_idx'::regclass;",['registry_indexes_valid_ok']],
    [`create function ${signature} returns jsonb language sql as $$select '{}'::jsonb$$;`,['new_objects_absent_ok']],
    ["create index profile_photo_objects_cleanup_eligible_idx on private.profile_photo_objects(id);",['new_objects_absent_ok','registry_indexes_valid_ok']],
  ];
  for(const [mutation,expected]of cases){
    const result=json(`begin;${mutation}${query}rollback;`);
    assert.deepEqual(Object.keys(result).filter(k=>!result[k]).sort(),[...expected,'read_only_pinned_server_ok'].sort(),mutation);
  }
  raw(`${insertRows('ready',1)}update pg_class set reltuples=-1 where oid='private.profile_photo_objects'::regclass;`);
  assert.equal(json(`begin read only;${query}rollback;`).registry_estimate_within_bound_ok,false);
  raw('truncate private.profile_photo_objects;');
  // Real physical-size rejection, not a relpages estimate or changed query cap.
  raw(`insert into private.profile_photo_objects(user_id,storage_path,state,retired_at)
    select '${actor}','${actor}/avatar-'||repeat('a',1100)||n||'.jpg','retired',now()from generate_series(1,30000)n;analyze private.profile_photo_objects;`);
  const oversized=json(`begin read only;${query}rollback;`);assert.equal(oversized.registry_size_within_bound_ok,false);
  raw('truncate private.profile_photo_objects;');
  const lockProcess=spawn('docker',['exec','-i',owned(),'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h','/tmp','-U','postgres','-d','postgres'],{stdio:['pipe','pipe','pipe']});
  const completion=new Promise((resolve,reject)=>{lockProcess.once('error',reject);lockProcess.once('exit',code=>code===0?resolve():reject(new Error('Owned lock fixture failed.')));});
  try {
    const acquired=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Owned lock fixture did not acquire.')),5000);
      lockProcess.stdout.on('data',chunk=>{if(String(chunk).includes('FIXTURE_LOCK_HELD')){clearTimeout(timer);resolve();}});
      lockProcess.once('error',error=>{clearTimeout(timer);reject(error);});
    });
    lockProcess.stdin.write("begin;lock table private.profile_photo_objects in row exclusive mode;select 'FIXTURE_LOCK_HELD';\n");
    await acquired;assert.equal(json(`begin read only;${query}rollback;`).no_conflicting_registry_locks_ok,false);
  } finally {lockProcess.stdin.end('rollback;\n');await completion;}
  assert.ok(Object.values(json(`begin read only;${query}rollback;`)).every(v=>v===true));
  // Reapply only to this freshly owned empty fixture and prove exact74 again.
  raw(`begin;${migration}insert into supabase_migrations.schema_migrations values('20261013055744','site_admin_cleanup_health');commit;`);
  const catalog=jsonCatalog(await readFile(new URL('./verify-production-admin-cleanup-health.sql',import.meta.url),'utf8'));
  assert.ok(Object.values(json(`begin read only;${catalog}rollback;`)).every(v=>v===true));
});
