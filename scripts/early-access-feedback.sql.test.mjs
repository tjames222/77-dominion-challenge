import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { before, beforeEach, after, test } from 'node:test';

const image = 'public.ecr.aws/supabase/postgres:17.6.1.141';
const fixture = `77dc-feedback-${randomUUID()}`;
const actor = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const sid = '20000000-0000-4000-8000-000000000001';
const requestId = '30000000-0000-4000-8000-000000000001';
let containerId; let migrations;
const literal = value => value === null ? 'null' : `'${String(value).replaceAll("'", "''")}'`;
const json = value => `${literal(JSON.stringify(value))}::jsonb`;
const docker = (args, input) => spawnSync('docker', args, { input, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
const command = () => ['exec','-i',containerId,'psql','-X','-qAt','-P','null=null','-v','ON_ERROR_STOP=1','-h','/tmp','-U','postgres','-d','postgres'];
function query(sql) {
  assert.match(containerId || '', /^[a-f0-9]{64}$/);
  const result = docker(command(), sql); assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
}
function parallel(sql) { return new Promise((resolve, reject) => {
  const child = spawn('docker', command()); let output = ''; let error = '';
  const deadline = setTimeout(() => child.kill(), 15000);
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { error += chunk; });
  child.on('error', reject); child.on('close', code => { clearTimeout(deadline); resolve({ code, output, error }); }); child.stdin.end(sql);
}); }
async function waitForSql(predicate) {
  for (let n=0;n<100;n++) {
    if (query(`select to_jsonb(${predicate});`)[0]) return;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.fail('Owned concurrency fixture did not reach its required barrier.');
}
const asActor = (sql, {id=actor, session=sid, origin='https://77dominion.com', aal='aal1', claims={}}={}) =>
  `set request.jwt.claims=${literal(JSON.stringify({sub:id,session_id:session,aal,role:'authenticated',...claims}))};set request.headers=${literal(JSON.stringify({origin}))};set role authenticated;${sql}`;
const asService = sql => `set request.jwt.claims='{"role":"service_role"}';set role service_role;${sql}`;
const denied = (sql, code) => `do $t$ begin begin ${sql} exception when sqlstate '${code}' then return;end;raise exception 'Expected denial';end $t$;`;
const input = {type:'bug',description:'Original\nfeedback 😀',expectedBehavior:'Better',impact:'minor',contactAllowed:false};
const context = {route:'private-journal.html',theme:'dark',viewport:{width:390,height:844},buildSha:'a'.repeat(40),browser:'safari',platform:'ios'};
const submit = (operation=randomUUID(), value=input, ctx=context, expected=actor) =>
  `public.submit_early_access_feedback('${expected}','${operation}',${json(value)},${json(ctx)})`;
const qualify = () => query(`update private.early_access_requests set status='accepted' where id='${requestId}';
  insert into private.early_access_grants(user_id,program_key,request_id,accepted_at,starts_at)
  values('${actor}','early_access_v1','${requestId}','2026-01-01','2026-01-01');`);
const claim = (provider, worker=randomUUID()) => ({ worker, jobs:query(asService(`select public.claim_early_access_feedback_deliveries('${worker}',${literal(provider)},5);`))[0] });
const hash = 'a'.repeat(64);
const bind = (job, worker, payload={body:'frozen'}) => query(asService(`select to_jsonb(public.bind_early_access_feedback_delivery('${job.deliveryId}','${worker}',${json(payload)},'${hash}'));`))[0];
const dispatch = (job, worker, fingerprint=hash) => query(asService(`select public.mark_early_access_feedback_dispatched('${job.deliveryId}','${worker}','${fingerprint}');`))[0];
const settle = (job, worker, outcome, {code=null, receipt=null, url=null}={}) => query(asService(`select to_jsonb(public.settle_early_access_feedback_delivery('${job.deliveryId}','${worker}',${literal(outcome)},${literal(code)},${literal(receipt)}::uuid,${literal(url)}));`))[0];

before(async () => {
  const file = name => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
  const baseline = await file('20260707170000_baseline.sql');
  const legacy = baseline.match(/create or replace function public\.has_active_entitlement\([\s\S]*?\n\$\$;/)?.[0]; assert.ok(legacy);
  migrations = (await Promise.all(['20260913023402_early_access_request_intake.sql','20260913062841_site_admin_foundation.sql',
    '20260922000204_early_access_member_authority.sql','20260922000815_early_access_feedback_outbox.sql'].map(file)));
  migrations.splice(2,0,legacy);
  const cached = docker(['image','inspect',image,'--format','{{.Id}}']); assert.equal(cached.status,0,'Pinned image must already be cached.');
  assert.match(cached.stdout.trim(),/^sha256:[a-f0-9]{64}$/);
  const result = docker(['run','--detach','--pull','never','--name',fixture,'--label',`77dc.fixture=${fixture}`,
    '--network','none','--cpus','1','--memory','512m','--user','postgres','--tmpfs','/tmp:rw,size=384m','--entrypoint','/bin/sh',cached.stdout.trim(),'-c',
    'initdb -D /tmp/feedback-pgdata -A trust && exec postgres -D /tmp/feedback-pgdata -k /tmp -h ""']);
  assert.equal(result.status,0,result.stderr); containerId=result.stdout.trim(); assert.match(containerId,/^[a-f0-9]{64}$/);
  let ready=false; for (let n=0;n<100;n++) { if (docker(['exec',containerId,'pg_isready','-h','/tmp','-U','postgres']).status===0) { ready=true;break; } await new Promise(resolve=>setTimeout(resolve,100)); }
  assert.ok(ready); query('create role anon;create role authenticated;create role service_role bypassrls;create role fixture_migration nologin nosuperuser nobypassrls;create role supabase_auth_admin nologin;grant create on database postgres to fixture_migration;');
});
beforeEach(() => {
  // Only this exact, owned, network-none, in-memory synthetic fixture is reset.
  query(`drop schema if exists private cascade;drop schema if exists auth cascade;drop schema public cascade;create schema public;create schema auth;
    grant usage on schema public,auth to anon,authenticated,service_role,fixture_migration;grant usage on schema auth to supabase_auth_admin;grant create on schema public to fixture_migration;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz default now(),is_anonymous boolean default false,deleted_at timestamptz,banned_until timestamptz,raw_user_meta_data jsonb default '{}');
    create table auth.sessions(id uuid primary key,user_id uuid references auth.users on delete cascade,factor_id uuid,aal text,not_after timestamptz);
    create table auth.mfa_factors(id uuid primary key,user_id uuid references auth.users on delete cascade,factor_type text,status text);
    create table auth.mfa_amr_claims(session_id uuid,authentication_method text,updated_at timestamptz);
    create function auth.jwt()returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    create function auth.uid()returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
    alter table auth.users owner to supabase_auth_admin;alter table auth.sessions owner to supabase_auth_admin;alter table auth.mfa_factors owner to supabase_auth_admin;alter table auth.mfa_amr_claims owner to supabase_auth_admin;
    grant select,insert,update,delete,truncate,references,trigger on auth.users,auth.sessions,auth.mfa_factors,auth.mfa_amr_claims to fixture_migration;
    set role fixture_migration;create schema private;create table public.entitlements(user_id uuid,entitlement_key text,status text,source_type text,source_id text,starts_at timestamptz,ends_at timestamptz);
    begin;${migrations.join('\n')}commit;reset role;
    insert into auth.users(id,email)values('${actor}','member@example.invalid'),('${other}','other@example.invalid');
    insert into auth.sessions values('${sid}','${actor}',null,'aal1',null);
    insert into private.early_access_requests(id,name,email,user_id)values('${requestId}','Synthetic Member','member@example.invalid','${actor}');`);
});
after(() => { if (!containerId) return; const check=docker(['inspect',containerId,'--format','{{index .Config.Labels "77dc.fixture"}}']);
  assert.equal(check.status,0);assert.equal(check.stdout.trim(),fixture);assert.equal(docker(['rm','--force',containerId]).status,0); });

test('the committed pgTAP security smoke executes all 63 assertions against actual new migrations', async () => {
  query('create schema if not exists extensions;');
  const sql = await readFile(new URL('../supabase/tests/database/290_early_access_feedback.sql', import.meta.url), 'utf8');
  const result = docker(command(), sql);
  const evidence = new URL('../test-results/early-access-feedback/', import.meta.url);
  await mkdir(evidence, { recursive: true });
  await writeFile(new URL('290_early_access_feedback.tap', evidence), result.stdout);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /^1\.\.63$/m);
  assert.doesNotMatch(result.stdout, /^not ok\b/m);
  assert.equal(result.stdout.split('\n').filter(line => /^ok [0-9]+\b/.test(line)).length, 63, result.stdout);
  assert.doesNotMatch(result.stdout, /Looks like you (?:planned|failed)/);
});

test('authorized submission commits original text and two private jobs before returning an exact receipt', () => {
  qualify(); const operation=randomUUID(); const [receipt]=query(asActor(`select ${submit(operation)};`));
  assert.deepEqual(receipt,{schemaVersion:1,operationId:operation,feedbackId:receipt.feedbackId,actorId:actor,status:'saved'});
  const [saved,jobs]=query('select to_jsonb(f) from private.early_access_feedback f;select jsonb_agg(provider order by provider) from private.early_access_feedback_deliveries;');
  assert.deepEqual(saved.input,input);assert.deepEqual(saved.context,context);assert.equal(saved.reporter_email,'member@example.invalid');assert.deepEqual(jobs,['email','linear']);
  assert.equal(JSON.stringify(receipt).includes('member@example'),false);
});
test('non-EA, wrong actor/origin, deleted session, and browser private-table access are denied', () => {
  query(asActor(denied(`perform ${submit()};`,'PT403')));qualify();
  query(asActor(denied(`perform ${submit(randomUUID(),input,context,other)};`,'PT401')));
  query(asActor(denied(`perform ${submit()};`,'PT403'),{origin:'https://attacker.invalid'}));
  query(asActor(denied('perform 1 from private.early_access_feedback;','42501')));
  query(`delete from auth.sessions;`);query(asActor(denied(`perform ${submit()};`,'PT401')));
  assert.deepEqual(query('select to_jsonb(count(*)) from private.early_access_feedback;'),[0]);
});
test('receipt retries are exact, one-time, and allowed after EA ends, but new feedback is denied', () => {
  qualify(); const operation=randomUUID();const [first]=query(asActor(`select ${submit(operation)};`));
  query("update private.early_access_programs set beta_starts_at=clock_timestamp();");
  assert.deepEqual(query(asActor(`select ${submit(operation)};`)),[first]);
  query(asActor(denied(`perform ${submit(operation,{...input,description:'different'})};`,'PT409')));
  query(asActor(denied(`perform ${submit()};`,'PT403')));
  assert.deepEqual(query('select to_jsonb(count(*)) from private.early_access_feedback_deliveries;'),[2]);
});
test('exact field allowlists, UTF-16 limits, integer viewport and no attachments or URLs', () => {
  qualify();
  for (const value of [{...input,attachment:'secret'},{...input,description:'\u00a0'},{...input,description:'😀'.repeat(5001)},
    {...input,contactAllowed:'false'},{...input,expectedBehavior:null},{...input,type:'unknown'}]) query(asActor(denied(`perform ${submit(randomUUID(),value)};`,'PT400')));
  for (const value of [{...context,url:'https://secret.invalid'},{...context,route:'private-journal.html?secret=1'},
    {...context,viewport:{width:1.5,height:5}},{...context,viewport:{width:0,height:5}},{...context,viewport:{width:100,height:5,secret:'x'}}]) query(asActor(denied(`perform ${submit(randomUUID(),input,value)};`,'PT400')));
  const [receipt]=query(asActor(`select ${submit(randomUUID(),{...input,description:'😀'.repeat(5000)})};`));assert.equal(receipt.status,'saved');
});
test('actor rate limit serializes new submissions; retries do not consume quota', () => {
  qualify(); const operation=randomUUID();for(let n=0;n<5;n++)query(asActor(`select ${submit(n?randomUUID():operation)};`));
  query(asActor(denied(`perform ${submit()};`,'PT429')));assert.equal(query(asActor(`select ${submit(operation)};`))[0].status,'saved');
});
test('concurrent exact submissions persist one feedback and one job per provider', async () => {
  qualify();const operation=randomUUID();const results=await Promise.all([parallel(asActor(`select ${submit(operation)};`)),parallel(asActor(`select ${submit(operation)};`))]);
  for(const result of results)assert.equal(result.code,0,result.error);assert.equal(results[0].output,results[1].output);
  assert.deepEqual(query('select to_jsonb(count(*)) from private.early_access_feedback;select to_jsonb(count(*)) from private.early_access_feedback_deliveries;'),[1,2]);
});
test('worker functions deny member callers, claim with exclusive lease, and bind immutable payloads', () => {
  qualify();query(asActor(`select ${submit()};`));query(asActor(denied(`perform public.claim_early_access_feedback_deliveries('${randomUUID()}','linear',5);`,'42501')));
  const {worker,jobs:[job]}=claim('linear');assert.equal(job.feedback.actorId,actor);assert.equal(job.feedback.schemaVersion,1);assert.equal(claim('linear').jobs.length,0);
  assert.equal(bind(job,randomUUID()),false);assert.equal(bind(job,worker),true);assert.equal(bind(job,worker),true);assert.equal(bind(job,worker,{body:'changed'}),false);
  assert.equal(dispatch(job,worker,'b'.repeat(64)),null);assert.equal(dispatch(job,randomUUID()),null);
});
test('linear dispatch fences once and later lease reclaims reconcile the original issue UUID', () => {
  qualify();query(asActor(`select ${submit()};`));const {worker,jobs:[job]}=claim('linear');bind(job,worker);const receipt=dispatch(job,worker);assert.equal(receipt.deliveryId,job.deliveryId);assert.equal(dispatch(job,worker),null);
  assert.equal(settle(job,worker,'uncertain',{code:'delivery_unconfirmed'}),true);
  query("update private.early_access_feedback_deliveries set next_attempt_at=clock_timestamp() where provider='linear';");
  const next=claim('linear');assert.equal(next.jobs[0].feedback.issueId,job.feedback.issueId);assert.equal(next.jobs[0].firstDispatchedAt,receipt.firstDispatchedAt);assert.equal(dispatch(next.jobs[0],next.worker),null);
  assert.equal(settle(next.jobs[0],next.worker,'delivered',{receipt:job.feedback.issueId,url:'https://linear.app/bbac/issue/FOU-99999/test'}),true);
  assert.equal(claim('linear').jobs.length,0);assert.deepEqual(claim('email').jobs[0].linear,
    {state:'delivered',issueId:job.feedback.issueId,issueUrl:'https://linear.app/bbac/issue/FOU-99999/test'});
});
test('email retries preserve first dispatch timestamp and reserve free quota only once', () => {
  qualify();query(asActor(`select ${submit()};`));const {worker,jobs:[job]}=claim('email');bind(job,worker);const first=dispatch(job,worker);assert.deepEqual(dispatch(job,worker),first);
  assert.deepEqual(query('select to_jsonb(count(*)) from private.transactional_email_reservations;'),[1]);
  assert.equal(settle(job,worker,'accepted',{receipt:randomUUID()}),true);assert.equal(claim('email').jobs.length,0);
});
test('free email budget and expired uncertain email windows never dispatch', () => {
  qualify();query(asActor(`select ${submit()};`));const {worker,jobs:[job]}=claim('email');bind(job,worker);
  query('insert into private.transactional_email_reservations(delivery_id)select gen_random_uuid() from generate_series(1,90);');assert.equal(dispatch(job,worker),null);
  query('delete from private.transactional_email_reservations;');assert.ok(dispatch(job,worker));
  query("update private.early_access_feedback_deliveries set first_dispatched_at=clock_timestamp()-interval '24 hours',lease_until=clock_timestamp()-interval '1 minute' where provider='email';");
  assert.equal(claim('email').jobs.length,0);assert.deepEqual(query("select to_jsonb(status) from private.early_access_feedback_deliveries where provider='email';"),['needs_review']);
});
test('stale leases cannot settle outcomes and deleting account removes private feedback/jobs', () => {
  qualify();query(asActor(`select ${submit()};`));const {worker,jobs:[job]}=claim('email');bind(job,worker);dispatch(job,worker);
  assert.equal(settle(job,randomUUID(),'accepted',{receipt:randomUUID()}),false);
  query(`delete from auth.users where id='${actor}';`);assert.deepEqual(query('select to_jsonb(count(*)) from private.early_access_feedback;select to_jsonb(count(*)) from private.early_access_feedback_deliveries;'),[0,0]);
});

test('Unicode expansion is never reached for already oversized character strings', () => {
  qualify();
  // This test-only tripwire proves admission ordering, not a substitute for the
  // real UTF-16 boundary cases above, which execute the unchanged helper.
  query("create or replace function private.feedback_utf16_length(value text) returns integer language plpgsql immutable strict set search_path='' as $$begin raise exception 'unexpected_unicode_expansion';end$$;");
  for (const value of [{...input,description:'x'.repeat(10001)}, {...input,expectedBehavior:'x'.repeat(5001)}]) {
    query(asActor(denied(`perform ${submit(randomUUID(),value)};`,'PT400')));
  }
  assert.deepEqual(query('select to_jsonb(count(*)) from private.early_access_feedback;'),[0]);
});

test('account suspension already holding an Auth row cannot deadlock the feedback reader', async () => {
  qualify();
  const updater=parallel(`set application_name='feedback-auth-updater';set role supabase_auth_admin;begin;
    select id from auth.users where id='${actor}' for update;select pg_sleep(1.5);
    update auth.users set banned_until='2200-01-01' where id='${actor}';commit;`);
  await waitForSql("exists(select 1 from pg_stat_activity where application_name='feedback-auth-updater' and wait_event='PgSleep')");
  const pending=parallel(asActor(`set application_name='feedback-auth-waiter';select ${submit()};`));
  await waitForSql("exists(select 1 from pg_stat_activity where application_name='feedback-auth-waiter' and wait_event_type='Lock')");
  const [changed,result]=await Promise.all([updater,pending]);
  assert.equal(changed.code,0,changed.error);assert.notEqual(result.code,0);
  assert.match(result.error,/member_authentication_required/);assert.doesNotMatch(result.error,/deadlock/);
  assert.deepEqual(query('select to_jsonb(count(*)) from private.early_access_feedback;'),[0]);
});

test('session revocation during the actor serialization wait prevents a saved receipt', async () => {
  qualify();
  const blocker=parallel(`set application_name='feedback-actor-blocker';begin;
    select pg_advisory_xact_lock(hashtextextended('early-access-feedback:${actor}',1803));select pg_sleep(1.5);commit;`);
  await waitForSql("exists(select 1 from pg_stat_activity where application_name='feedback-actor-blocker' and wait_event='PgSleep')");
  const pending=parallel(asActor(`set application_name='feedback-session-waiter';select ${submit()};`));
  await waitForSql("exists(select 1 from pg_stat_activity where application_name='feedback-session-waiter' and wait_event='advisory')");
  query(`delete from auth.sessions where id='${sid}';`);
  const [held,result]=await Promise.all([blocker,pending]);
  assert.equal(held.code,0,held.error);assert.notEqual(result.code,0);assert.match(result.error,/member_authentication_required/);
  assert.deepEqual(query('select to_jsonb(count(*)) from private.early_access_feedback;select to_jsonb(count(*)) from private.early_access_feedback_deliveries;'),[0,0]);
});

test('grant revocation while submission waits is visible before committing feedback', async () => {
  qualify();
  const blocker=parallel(`set application_name='feedback-grant-blocker';begin;
    update private.early_access_grants set revoked_at=clock_timestamp(),revision=1 where user_id='${actor}';
    select pg_sleep(1.5);commit;`);
  await waitForSql("exists(select 1 from pg_stat_activity where application_name='feedback-grant-blocker' and wait_event='PgSleep')");
  const pending=parallel(asActor(`set application_name='feedback-grant-waiter';select ${submit()};`));
  await waitForSql("exists(select 1 from pg_stat_activity where application_name='feedback-grant-waiter' and wait_event_type='Lock')");
  const [held,result]=await Promise.all([blocker,pending]);
  assert.equal(held.code,0,held.error);assert.notEqual(result.code,0);assert.match(result.error,/feedback_early_access_required/);
  assert.deepEqual(query('select to_jsonb(count(*)) from private.early_access_feedback;'),[0]);
});

test('expired lease after quota-lock waiting returns no fence and rolls back only the new reservation', async () => {
  qualify();query(asActor(`select ${submit()};`));const {worker,jobs:[job]}=claim('email');bind(job,worker);
  const blocker=parallel("set application_name='feedback-quota-blocker';begin;select pg_advisory_xact_lock(hashtextextended('transactional-email-free-quota',1803));select pg_sleep(3);commit;");
  await waitForSql("exists(select 1 from pg_stat_activity where application_name='feedback-quota-blocker' and wait_event='PgSleep')");
  query(`update private.early_access_feedback_deliveries set lease_until=clock_timestamp()+interval '2 seconds' where id='${job.deliveryId}';`);
  const pending=parallel(asService(`set application_name='feedback-quota-waiter';select public.mark_early_access_feedback_dispatched('${job.deliveryId}','${worker}','${hash}');`));
  await waitForSql("exists(select 1 from pg_stat_activity where application_name='feedback-quota-waiter' and wait_event='advisory')");
  const [held,result]=await Promise.all([blocker,pending]);assert.equal(held.code,0,held.error);assert.equal(result.code,0,result.error);assert.equal(result.output.trim(),'null');
  assert.deepEqual(query(`select to_jsonb(count(*)) from private.transactional_email_reservations;
    select to_jsonb(first_dispatched_at is null) from private.early_access_feedback_deliveries where id='${job.deliveryId}';`),[0,true]);
});

test('provider retry window expiring during quota wait does not erase an existing reservation', async () => {
  qualify();query(asActor(`select ${submit()};`));const {worker,jobs:[job]}=claim('email');bind(job,worker);assert.ok(dispatch(job,worker));
  const [reservation]=query('select to_jsonb(r) from private.transactional_email_reservations r;');
  const blocker=parallel("set application_name='feedback-window-blocker';begin;select pg_advisory_xact_lock(hashtextextended('transactional-email-free-quota',1803));select pg_sleep(3);commit;");
  await waitForSql("exists(select 1 from pg_stat_activity where application_name='feedback-window-blocker' and wait_event='PgSleep')");
  query(`update private.early_access_feedback_deliveries set first_dispatched_at=clock_timestamp()-interval '23 hours'+interval '2 seconds' where id='${job.deliveryId}';`);
  const pending=parallel(asService(`set application_name='feedback-window-waiter';select public.mark_early_access_feedback_dispatched('${job.deliveryId}','${worker}','${hash}');`));
  await waitForSql("exists(select 1 from pg_stat_activity where application_name='feedback-window-waiter' and wait_event='advisory')");
  const [held,result]=await Promise.all([blocker,pending]);assert.equal(held.code,0,held.error);assert.equal(result.code,0,result.error);assert.equal(result.output.trim(),'null');
  assert.deepEqual(query('select to_jsonb(r) from private.transactional_email_reservations r;'),[reservation]);
});

test('quota windows and reservation time are evaluated after the quota lock wait', async () => {
  qualify();query(asActor(`select ${submit()};`));const {worker,jobs:[job]}=claim('email');bind(job,worker);
  const blocker=parallel("set application_name='feedback-fresh-quota-blocker';begin;select pg_advisory_xact_lock(hashtextextended('transactional-email-free-quota',1803));select pg_sleep(3);commit;");
  await waitForSql("exists(select 1 from pg_stat_activity where application_name='feedback-fresh-quota-blocker' and wait_event='PgSleep')");
  query("insert into private.transactional_email_reservations(delivery_id,reserved_at)select gen_random_uuid(),clock_timestamp()-interval '24 hours'+interval '2 seconds' from generate_series(1,90);");
  const pending=parallel(asService(`set application_name='feedback-fresh-quota-waiter';select public.mark_early_access_feedback_dispatched('${job.deliveryId}','${worker}','${hash}');`));
  await waitForSql("exists(select 1 from pg_stat_activity where application_name='feedback-fresh-quota-waiter' and wait_event='advisory')");
  const [held,result]=await Promise.all([blocker,pending]);assert.equal(held.code,0,held.error);assert.equal(result.code,0,result.error);
  assert.equal(JSON.parse(result.output).deliveryId,job.deliveryId);
  assert.deepEqual(query("select to_jsonb(count(*)) from private.transactional_email_reservations where reserved_at>=clock_timestamp()-interval '24 hours';"),[1]);
});

test('rolling 31-day free quota is shared, capped and independent of the daily quota', () => {
  qualify();query(asActor(`select ${submit()};`));const {worker,jobs:[job]}=claim('email');bind(job,worker);
  query("insert into private.transactional_email_reservations(delivery_id,reserved_at)select gen_random_uuid(),clock_timestamp()-interval '2 days' from generate_series(1,2900);");
  assert.equal(dispatch(job,worker),null);
  assert.deepEqual(query(`select to_jsonb(count(*)) from private.transactional_email_reservations where delivery_id='${job.deliveryId}';`),[0]);
  query("update private.transactional_email_reservations set reserved_at=clock_timestamp()-interval '32 days' where delivery_id=(select delivery_id from private.transactional_email_reservations limit 1);");
  assert.ok(dispatch(job,worker));
  assert.deepEqual(query("select to_jsonb(count(*)) from private.transactional_email_reservations where reserved_at>=clock_timestamp()-interval '31 days';"),[2900]);
});

test('non-service roles and mixed member/service authority cannot invoke any worker mutation', () => {
  qualify();query(asActor(`select ${submit()};`));const {worker,jobs:[job]}=claim('email');
  const calls=[
    `perform public.claim_early_access_feedback_deliveries('${worker}','email',5);`,
    `perform public.bind_early_access_feedback_delivery('${job.deliveryId}','${worker}','{}','${hash}');`,
    `perform public.mark_early_access_feedback_dispatched('${job.deliveryId}','${worker}','${hash}');`,
    `perform public.settle_early_access_feedback_delivery('${job.deliveryId}','${worker}','retryable');`,
  ];
  for (const call of calls) {
    query(asActor(denied(call,'42501')));
    query(`set role anon;${denied(call,'42501')}`);
    query(`set request.jwt.claims=${literal(JSON.stringify({role:'service_role',sub:actor}))};set role service_role;${denied(call,'42501')}`);
  }
  query(asService(denied(`perform ${submit()};`,'42501')));
  assert.deepEqual(query(`select to_jsonb(payload is null and first_dispatched_at is null and status='leased') from private.early_access_feedback_deliveries where id='${job.deliveryId}';`),[true]);
  assert.deepEqual(query('select to_jsonb(count(*)) from private.transactional_email_reservations;'),[0]);
});

test('pending and failed Linear observations are exact state-only objects', () => {
  qualify();query(asActor(`select ${submit()};`));const {worker,jobs:[email]}=claim('email');assert.deepEqual(email.linear,{state:'pending'});
  assert.equal(settle(email,worker,'retryable'),true);
  query("update private.early_access_feedback_deliveries set status='needs_review' where provider='linear';update private.early_access_feedback_deliveries set next_attempt_at=clock_timestamp() where provider='email';");
  assert.deepEqual(claim('email').jobs[0].linear,{state:'failed'});
});

test('outbox failure rolls back submission, and the same operation may retry after recovery', () => {
  qualify();const operation=randomUUID();
  query("create function private.fixture_fail_email_job()returns trigger language plpgsql as $$begin if new.provider='email' then raise exception 'synthetic outbox failure';end if;return new;end$$;create trigger fixture_fail_email_job before insert on private.early_access_feedback_deliveries for each row execute function private.fixture_fail_email_job();");
  query(asActor(denied(`perform ${submit(operation)};`,'P0001')));
  assert.deepEqual(query('select to_jsonb(count(*)) from private.early_access_feedback;select to_jsonb(count(*)) from private.early_access_feedback_deliveries;'),[0,0]);
  query('drop trigger fixture_fail_email_job on private.early_access_feedback_deliveries;');
  const [receipt]=query(asActor(`select ${submit(operation)};`));assert.equal(receipt.status,'saved');
  assert.deepEqual(query(asActor(`select ${submit(operation)};`)),[receipt]);
});
