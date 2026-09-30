import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';

const name = `77dc-account-requests-${randomUUID()}`;
const image = 'public.ecr.aws/supabase/postgres:17.6.1.141';
const migrationName = '20260929000950_site_admin_account_requests_inbox.sql';
const actor = '10000000-0000-4000-8000-000000000001';
const member = '10000000-0000-4000-8000-000000000002';
const reserveAdmin = '10000000-0000-4000-8000-000000000003';
const session = '30000000-0000-4000-8000-000000000001';
const memberSession = '30000000-0000-4000-8000-000000000002';
const factor = '20000000-0000-4000-8000-000000000001';
const signature = 'public.site_admin_list_account_requests(uuid,integer,text,text,text,jsonb)';
const sentinel = 'DO_NOT_EXPOSE_NOTE_EMAIL_CREDENTIAL';
const types = ['all', 'data_export', 'account_deletion'];
const statuses = ['active', 'all', 'requested', 'in_progress', 'fulfilled', 'cancelled', 'declined'];
const concreteStatuses = statuses.slice(2);
let container; let migration; let originalBoundary; let baselinePlans; let indexedPlans;
const literal = value => value === null ? 'null' : `'${String(value).replaceAll("'", "''")}'`;
const json = value => value === null ? 'null' : `${literal(JSON.stringify(value))}::jsonb`;
const docker = (args, input) => spawnSync('docker', args, { input, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
function owned() {
  assert.match(container || '', /^[a-f0-9]{64}$/);
  const result = docker(['inspect', container, '--format', '{{index .Config.Labels "77dc.fixture"}}|{{.HostConfig.NetworkMode}}|{{.HostConfig.ReadonlyRootfs}}']);
  assert.equal(result.status, 0, 'Owned fixture inspection failed.');
  assert.equal(result.stdout.trim(), `${name}|none|true`);
  return container;
}
function execute(input) {
  return docker(['exec', '-i', owned(), 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', '/tmp', '-U', 'postgres', '-d', 'postgres'], input);
}
function raw(input) { const result = execute(input); assert.equal(result.status, 0, result.stderr || 'Owned fixture SQL failed.'); return result.stdout.trim(); }
function sql(input) { return raw(input).split('\n').filter(Boolean).map(JSON.parse); }
function asActor(input, { id = actor, sid = session, aal = 'aal2', origin = 'https://77dominion.com', claims = {} } = {}) {
  return `set request.jwt.claims=${json({ sub: id, session_id: sid, role: 'authenticated', aal, ...claims }).replace(/::jsonb$/, '')};
    set request.headers=${literal(JSON.stringify({ origin }))};set role authenticated;${input}`;
}
function denied(input, state = 'PT403', message = null) {
  return `do $denied$ begin begin ${input.replace(/^select /, 'perform ')} exception when sqlstate '${state}' then
    ${message ? `if sqlerrm<>${literal(message)} then raise;end if;` : ''} return;end;raise exception 'Expected denial';end $denied$;`;
}
function inbox({ expected = actor, limit = 25, type = 'all', status = 'active', sort = 'oldest', cursor = null } = {}) {
  return `select public.site_admin_list_account_requests(${literal(expected)},${limit === null ? 'null' : limit},${literal(type)},${literal(status)},${literal(sort)},${json(cursor)});`;
}
function boundary() {
  return sql(`select jsonb_build_object('owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force',c.relforcerowsecurity,'acl',c.relacl::text,
    'policies',(select jsonb_agg(to_jsonb(p) order by p.policyname) from pg_policies p where p.schemaname='public' and p.tablename='account_lifecycle_requests'),
    'auth',(select jsonb_agg(jsonb_build_array(relname,relowner,relacl::text) order by relname) from pg_class where oid in ('auth.users'::regclass,'auth.sessions'::regclass,'auth.mfa_factors'::regclass,'auth.mfa_amr_claims'::regclass)))
    from pg_class c where c.oid='public.account_lifecycle_requests'::regclass;`)[0];
}
const fixtureRows = () => `insert into public.account_lifecycle_requests(id,user_id,request_type,status,requested_at,updated_at,resolved_at,operator_note)
  select ('40000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
    case when n=1 then '${actor}'::uuid when n=2 then '${member}'::uuid else null end,
    case when n%2=0 then 'data_export' else 'account_deletion' end,
    (array['requested','in_progress','fulfilled','cancelled','declined'])[1+((n-1)%5)],
    '2026-01-01T00:00:00Z'::timestamptz + ((n-1)/4)*interval '1 day',
    '2026-02-01T00:00:00Z'::timestamptz,
    case when ((n-1)%5)<2 then null else '2026-02-01T00:00:00Z'::timestamptz end,'${sentinel}' from generate_series(1,30)n;`;
function nodes(plan) { return [plan, ...(plan.Plans || []).flatMap(nodes)]; }
function plans() {
  // Extract the exact bounded query from the migration, not a stand-in.
  const template = migration.match(/execute format\(\$query\$([\s\S]*?)\$query\$,direction,comparator\)/)?.[1];
  assert.ok(template);
  const statements = [];
  for (const type of types) for (const status of statuses) for (const sort of ['oldest', 'newest']) for (const cursor of [false, true]) {
    const selectedTypes = type === 'all' ? types.slice(1) : [type];
    const selectedStatuses = status === 'all' ? concreteStatuses : status === 'active' ? concreteStatuses.slice(0, 2) : [status];
    const query = template.replaceAll('%1$s', sort === 'oldest' ? 'asc' : 'desc').replaceAll('%2$s', sort === 'oldest' ? '>' : '<');
    statements.push(`prepare measured(text[],text[],timestamptz,uuid,integer) as ${query};
      explain(analyze,buffers,format json) execute measured(array[${selectedTypes.map(literal)}],array[${selectedStatuses.map(literal)}],
      ${cursor ? "'2026-01-01T04:10:00Z'" : 'null'},${cursor ? "'40000000-0000-4000-8000-000000025000'" : 'null'},51);deallocate measured;`);
  }
  // EXPLAIN JSON is multiline. A psql unaligned output stream is exactly an
  // adjacent series of JSON arrays; parse only the owned fixture's output.
  const output = raw(`set role fixture_reader;${statements.join('\n')}`);
  return JSON.parse(`[${output.replaceAll(']\n[', '],[')}]`).map(result => result[0]);
}

before(async () => {
  migration = await readFile(new URL(`../supabase/migrations/${migrationName}`, import.meta.url), 'utf8');
  const inspected = docker(['image', 'inspect', image, '--format', '{{.Id}}']);
  assert.equal(inspected.status, 0, 'Pinned PostgreSQL image must already be cached.');
  const id = inspected.stdout.trim(); assert.match(id, /^sha256:[a-f0-9]{64}$/);
  const started = docker(['run', '--detach', '--pull', 'never', '--name', name, '--label', `77dc.fixture=${name}`,
    '--network', 'none', '--read-only', '--user', '100:101', '--memory', '512m', '--cpus', '1', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--log-driver', 'none',
    '--tmpfs', '/tmp:rw,nosuid,nodev,uid=100,gid=101,mode=0700,size=384m', '--entrypoint', 'bash', id, '-c',
    'initdb -D /tmp/requests-pg -A trust --no-locale --encoding=UTF8 >/dev/null && exec postgres -D /tmp/requests-pg -k /tmp -h "" -c max_worker_processes=0']);
  assert.equal(started.status, 0, 'Owned fixture startup failed.'); container = started.stdout.trim();
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (docker(['exec', owned(), 'pg_isready', '-h', '/tmp', '-U', 'postgres']).status === 0) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'Owned fixture did not start.');
  raw(`create role anon;create role authenticated;create role service_role bypassrls;
    create role supabase_auth_admin nologin nosuperuser nobypassrls;
    create role fixture_migration nologin nosuperuser nobypassrls;
    -- Models existing managed postgres-owned read functions, NOT a production
    -- role change. Only this isolated NOLOGIN function owner bypasses FORCE.
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
    insert into auth.users(id,email) values('${actor}','${sentinel}@example.invalid'),('${member}','member@example.invalid'),('${reserveAdmin}','reserve@example.invalid');
    alter table auth.users owner to supabase_auth_admin;alter table auth.sessions owner to supabase_auth_admin;
    alter table auth.mfa_factors owner to supabase_auth_admin;alter table auth.mfa_amr_claims owner to supabase_auth_admin;
    grant select,insert,update,delete,truncate,references,trigger,maintain on auth.users,auth.sessions,auth.mfa_factors,auth.mfa_amr_claims to fixture_migration;
    set role fixture_migration;
    create function public.set_updated_at() returns trigger language plpgsql as $$begin new.updated_at=now();return new;end$$;
    begin;${await readFile(new URL('../supabase/migrations/20260813163428_add_account_lifecycle_requests.sql', import.meta.url), 'utf8')}
    ${await readFile(new URL('../supabase/migrations/20260913062841_site_admin_foundation.sql', import.meta.url), 'utf8')}commit;reset role;
    grant usage on schema private to fixture_reader;
    grant execute on function private.require_site_admin(text,uuid,boolean) to fixture_reader;
    grant select on public.account_lifecycle_requests to fixture_reader;
    insert into auth.mfa_factors(id,user_id,factor_type,status) values('${factor}','${actor}','totp','verified'),
      ('20000000-0000-4000-8000-000000000002','${member}','totp','verified'),('20000000-0000-4000-8000-000000000003','${reserveAdmin}','totp','verified');
    select private.bootstrap_site_admin('${actor}','50000000-0000-4000-8000-000000000001','production');
    update private.site_user_roles set role_key='site_admin' where user_id='${reserveAdmin}';
    insert into auth.sessions values('${session}','${actor}','${factor}','aal2',null),
      ('${memberSession}','${member}','20000000-0000-4000-8000-000000000002','aal2',null);
    insert into public.account_lifecycle_requests(id,user_id,request_type,status,requested_at,updated_at,resolved_at,operator_note)
      select ('40000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,null,
        case when n%2=0 then 'data_export' else 'account_deletion' end,
        (array['requested','in_progress','fulfilled','cancelled','declined'])[1+((n-1)%5)],
        '2026-01-01'::timestamptz+n*interval '1 second',now(),case when ((n-1)%5)<2 then null else now() end,'${sentinel}'
      from generate_series(1,50000)n;analyze public.account_lifecycle_requests;`);
  originalBoundary = boundary();
  baselinePlans = plans();
  raw(`set role fixture_migration;begin;${migration}commit;reset role;
    alter function ${signature} owner to fixture_reader;analyze public.account_lifecycle_requests;`);
  indexedPlans = plans();
  raw(`truncate public.account_lifecycle_requests;${fixtureRows()}`);
});
after(() => { if (container) assert.equal(docker(['rm', '--force', owned()]).status, 0, 'Only owned fixture removed.'); });

test('actual FORCE RLS, member policies, existing grants and provider Auth ownership are unchanged', () => {
  assert.deepEqual(boundary(), originalBoundary);
  assert.equal(originalBoundary.owner, 'fixture_migration'); assert.equal(originalBoundary.force, true);
  assert.deepEqual(sql("select jsonb_build_array(rolsuper,rolbypassrls) from pg_roles where rolname='fixture_migration';"), [[false, false]]);
  assert.deepEqual(sql("select jsonb_build_array(rolsuper,rolbypassrls,rolcanlogin) from pg_roles where rolname='fixture_reader';"), [[false, true, false]]);
  for (const role of ['anon', 'authenticated', 'service_role', 'fixture_migration']) {
    // SET SESSION AUTHORIZATION removes the local superuser's ability to SET ROLE.
    raw(`set session authorization ${role};${denied('set role fixture_reader;', '42501')}`);
  }
  assert.doesNotMatch(migration, /create\s+role|alter\s+(role|table)|create\s+policy|grant\s+[^;]*\bon\s+(table\s+)?public\.account_lifecycle_requests|auth\./i);
});

test('one measured index replaces whole-ledger scans for all84 filter/order/cursor plans', t => {
  assert.equal(baselinePlans.length, 84); assert.equal(indexedPlans.length, 84);
  for (const plan of baselinePlans) assert.ok(nodes(plan.Plan).some(n => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'account_lifecycle_requests'));
  for (const plan of indexedPlans) {
    const all = nodes(plan.Plan);
    assert.ok(all.some(n => n['Index Name'] === 'account_lifecycle_requests_admin_bucket_idx'));
    assert.ok(!all.some(n => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'account_lifecycle_requests'));
    for (const n of all.filter(n => n['Index Name'] === 'account_lifecycle_requests_admin_bucket_idx')) {
      assert.ok(n['Actual Rows'] <= 51); assert.ok(n['Actual Loops'] <= 10);
      assert.equal(n['Rows Removed by Filter'] || 0, 0);
    }
    for (const n of all.filter(n => n['Node Type'] === 'Sort')) assert.ok(n.Plans[0]['Actual Rows'] <= 510);
  }
  const range = values => [Math.min(...values), Math.max(...values)].map(n => Number(n.toFixed(3)));
  t.diagnostic(JSON.stringify({ seededRows: 50000, plans: 84,
    baselineExecutionMs: range(baselinePlans.map(p => p['Execution Time'])), indexedExecutionMs: range(indexedPlans.map(p => p['Execution Time'])),
    baselineSharedBlocks: range(baselinePlans.map(p => p.Plan['Shared Hit Blocks'] + p.Plan['Shared Read Blocks'])),
    indexedSharedBlocks: range(indexedPlans.map(p => p.Plan['Shared Hit Blocks'] + p.Plan['Shared Read Blocks'])) }));
});

test('authenticated ordinary members and service keys cannot use the guarded inbox', () => {
  raw(asActor(denied(inbox({ expected: member }), 'PT403'), { id: member, sid: memberSession }));
  for (const role of ['anon', 'service_role']) raw(`set role ${role};${denied(inbox(), '42501')}`);
  raw(asActor(denied(inbox({ expected: member }), 'PT401')));
  raw(asActor(denied(inbox(), 'PT401'), { claims: { role: 'service_role' } }));
  raw(asActor(denied(inbox(), 'PT401'), { sid: randomUUID() }));
  raw(asActor(denied(inbox(), 'PT403'), { origin: 'https://attacker.invalid' }));
  raw(asActor(denied(inbox(), 'PT403'), { aal: 'aal1' }));
});

test('direct member reads stay own-only, including when the member is a site admin', () => {
  assert.deepEqual(sql(asActor('select jsonb_agg(user_id) from public.account_lifecycle_requests;')), [[actor]]);
  assert.deepEqual(sql(asActor('select jsonb_agg(user_id) from public.account_lifecycle_requests;', { id: member })), [[member]]);
  assert.deepEqual(sql('set role fixture_migration;select to_jsonb(count(*)) from public.account_lifecycle_requests;'), [0]);
  raw(asActor(denied(`update public.account_lifecycle_requests set status='declined';`, '42501')));
  raw(asActor(denied('delete from public.account_lifecycle_requests;', '42501')));
  raw(asActor(denied(`insert into public.account_lifecycle_requests(user_id,request_type) values('${member}','account_deletion');`, '42501')));
});

test('operations.read alone suffices and no users.read metadata, notes or Auth fields leak', () => {
  const result = sql(`begin;delete from private.site_role_permissions where role_key='site_admin' and permission_key<>'operations.read';
    ${asActor(inbox({ status: 'all', limit: 50 }))}rollback;`)[0];
  assert.equal(result.items.length, 30); assert.equal(result.nextCursor, null);
  assert.deepEqual(Object.keys(result).sort(), ['actorId', 'items', 'nextCursor', 'observedAt', 'schemaVersion']);
  for (const item of result.items) assert.deepEqual(Object.keys(item).sort(), ['id', 'requestType', 'requestedAt', 'resolvedAt', 'status', 'updatedAt', 'userId']);
  assert.ok(result.items.some(item => item.userId === null));
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_EXPOSE|operator_note|email|password|token|secret|profile|name/i);
});

test('all42 type/status/sort combinations match actual ordered metadata in a read-only transaction', () => {
  for (const type of types) for (const status of statuses) for (const sort of ['oldest', 'newest']) {
    const direction = sort === 'oldest' ? 'asc' : 'desc';
    const expected = sql(`select coalesce(jsonb_agg(id order by requested_at ${direction},id ${direction}),'[]') from public.account_lifecycle_requests
      where ${type === 'all' ? 'true' : `request_type=${literal(type)}`} and ${status === 'all' ? 'true' : status === 'active' ? "status in ('requested','in_progress')" : `status=${literal(status)}`};`)[0];
    const result = sql(`begin read only;${asActor(inbox({ type, status, sort, limit: 50 }))}rollback;`)[0];
    assert.deepEqual(result.items.map(item => item.id), expected); assert.equal(result.nextCursor, null);
  }
});

test('keyset pagination covers timestamp ties without duplicates and supports changed page size', () => {
  for (const sort of ['oldest', 'newest']) {
    const ids = []; let cursor = null; let page = 0;
    do {
      const result = sql(asActor(inbox({ status: 'all', sort, limit: page === 0 ? 1 : 7, cursor })))[0];
      ids.push(...result.items.map(item => item.id)); cursor = result.nextCursor; page++;
      if (cursor) { assert.deepEqual(Object.keys(cursor).sort(), ['actorId', 'id', 'query', 'stamp', 'v']); assert.match(cursor.query, /^[a-f0-9]{64}$/); }
      assert.ok(page <= 6);
    } while (cursor);
    assert.equal(ids.length, 30); assert.equal(new Set(ids).size, 30);
    assert.deepEqual(ids, sql(asActor(inbox({ status: 'all', sort, limit: 50 })))[0].items.map(item => item.id));
  }
});

test('input and cursor rejection is strict, bounded, actor/filter/sort-bound and token-safe', () => {
  for (const options of [{ limit: null }, { limit: 0 }, { limit: 51 }, { type: null }, { type: 'ALL' }, { type: 'x' }, { status: null }, { status: 'failed' }, { sort: null }, { sort: 'id' }]) {
    raw(asActor(denied(inbox(options), '22023', 'admin_invalid_input')));
  }
  const cursor = sql(asActor(inbox({ limit: 1 })))[0].nextCursor;
  for (const bad of [false, [], 'secret', {}, { ...cursor, extra: sentinel }, { ...cursor, v: 2 }, { ...cursor, actorId: member },
    { ...cursor, query: '0'.repeat(64) }, { ...cursor, id: sentinel }, { ...cursor, id: null }, { ...cursor, stamp: 'infinity' },
    { ...cursor, stamp: '-infinity' }, { ...cursor, stamp: 'now' }, { ...cursor, stamp: '2026-01-01' },
    { ...cursor, id: cursor.id.replaceAll('-', '') }, { ...cursor, stamp: null }, { ...cursor, stamp: sentinel.repeat(100) }]) {
    raw(asActor(denied(inbox({ cursor: bad }), '22023', 'admin_invalid_cursor')));
  }
  for (const changed of [{ type: 'data_export' }, { status: 'all' }, { sort: 'newest' }]) raw(asActor(denied(inbox({ ...changed, cursor }), '22023', 'admin_invalid_cursor')));
});

test('every fresh page rechecks native session, factor, account health, role and permission', () => {
  const cursor = sql(asActor(inbox({ limit: 1 })))[0].nextCursor;
  const changes = [
    [`delete from auth.sessions where id='${session}';`, 'PT401'],
    [`update auth.sessions set not_after=now()-interval '1 second' where id='${session}';`, 'PT401'],
    [`update auth.sessions set aal='aal1' where id='${session}';`, 'PT403'],
    [`update auth.sessions set factor_id=null where id='${session}';`, 'PT403'],
    [`update auth.mfa_factors set status='unverified' where id='${factor}';`, 'PT403'],
    [`update auth.users set banned_until=now()+interval '1 hour' where id='${actor}';`, 'PT401'],
    [`update auth.users set is_anonymous=true where id='${actor}';`, 'PT401'],
    [`update auth.users set email_confirmed_at=null where id='${actor}';`, 'PT401'],
    [`update private.site_user_roles set role_key='member' where user_id='${actor}';`, 'PT403'],
    ["delete from private.site_role_permissions where permission_key='operations.read';", 'PT403'],
    [`insert into private.site_admin_session_blocks(session_id,user_id,request_id) values('${session}','${actor}',gen_random_uuid());`, 'PT403'],
  ];
  for (const [change, state] of changes) raw(`begin;${change}${asActor(denied(inbox({ cursor }), state))}rollback;`);
});

test('empty pages, orphaned requesters and mutable status between pages remain honest', () => {
  assert.deepEqual(sql(`begin;truncate public.account_lifecycle_requests;${asActor(inbox())}rollback;`)[0].items, []);
  const first = sql(asActor(inbox({ limit: 1 })))[0];
  const nextId = sql(asActor(inbox({ cursor: first.nextCursor, limit: 1 })))[0].items[0].id;
  const next = sql(`begin;update public.account_lifecycle_requests set status='fulfilled',resolved_at=now() where id='${nextId}';
    ${asActor(inbox({ cursor: first.nextCursor, limit: 50 }))}rollback;`)[0];
  assert.ok(!next.items.some(item => item.id === nextId));
  const orphan = sql(`begin;delete from auth.users where id='${member}';${asActor(inbox({ status: 'all', limit: 50 }))}rollback;`)[0];
  assert.equal(orphan.items.find(item => item.id.endsWith('000000000002')).userId, null);
});

test('reads preserve all requests and cache-control is private no-store', () => {
  const before = sql('select jsonb_agg(to_jsonb(r) order by id) from public.account_lifecycle_requests r;')[0];
  const result = sql(`begin;${asActor(inbox({ status: 'all', limit: 50 }))}select current_setting('response.headers')::jsonb;rollback;`);
  assert.deepEqual(result[1], [{ 'Cache-Control': 'private, no-store' }, { Pragma: 'no-cache' }]);
  assert.deepEqual(sql('select jsonb_agg(to_jsonb(r) order by id) from public.account_lifecycle_requests r;')[0], before);
});

test('pgTAP ACL/schema checks run against the actual migrated FORCE-RLS fixture', async () => {
  const output = raw(await readFile(new URL('../supabase/tests/database/330_site_admin_account_requests.sql', import.meta.url), 'utf8'));
  assert.doesNotMatch(output, /^not ok/m); assert.match(output, /1\.\.16/);
  assert.equal((output.match(/^ok \d+/gm) || []).length, 16);
});

test('CI runs this native fixture only after the exact fixture-image cache step', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const cache = workflow.indexOf('run: node scripts/prepare-ci-fixture-images.mjs');
  const fixture = workflow.indexOf('run: node --test scripts/site-admin-account-requests.sql.test.mjs');
  assert.ok(cache > 0 && fixture > cache);
  assert.match(workflow, /name: Verify isolated account-request inbox authority\n        timeout-minutes: 5\n        run: node --test scripts\/site-admin-account-requests\.sql\.test\.mjs/);
  assert.equal((workflow.match(/run: node --test scripts\/site-admin-account-requests\.sql\.test\.mjs/g) || []).length, 1);
});
