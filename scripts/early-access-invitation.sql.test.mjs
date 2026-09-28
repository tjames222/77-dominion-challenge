import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';

// No existing local stack or hosted connection is used. Only this newly created
// labelled, network-none, no-port/no-volume tmpfs fixture may be reset/removed.
const image = 'public.ecr.aws/supabase/postgres:17.6.1.141';
const fixture = `77dc-invitation-${randomUUID()}`;
const owner = 'fixture_migration';
const actor = '10000000-0000-4000-8000-000000000001';
const member = '10000000-0000-4000-8000-000000000002';
const other = '10000000-0000-4000-8000-000000000003';
const sid = '20000000-0000-4000-8000-000000000001';
const memberSid = '20000000-0000-4000-8000-000000000002';
const otherSid = '20000000-0000-4000-8000-000000000003';
const factor = '30000000-0000-4000-8000-000000000001';
const requestId = '40000000-0000-4000-8000-000000000001';
const email = 'member@example.invalid';
let containerId; let migrations; let legacyPredicate;
const literal = value => value === null ? 'null' : `'${String(value).replaceAll("'", "''")}'`;
const json = value => value === null ? 'null' : `${literal(JSON.stringify(value))}::jsonb`;
function docker(args, input) { return spawnSync('docker', args, { input, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }); }
const command = () => ['exec', '-i', containerId, 'psql', '-X', '-qAt', '-P', 'null=null', '-v', 'ON_ERROR_STOP=1', '-h', '/tmp', '-U', 'postgres', '-d', 'postgres'];
function query(sql) {
  assert.match(containerId || '', /^[0-9a-f]{64}$/);
  const result = docker(command(), sql); assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
}
function parallel(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', command()); let output = ''; let error = '';
    const timer = setTimeout(() => child.kill(), 10_000);
    child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { error += value; });
    child.on('error', reject); child.on('close', code => { clearTimeout(timer); resolve({ code, output, error }); }); child.stdin.end(sql);
  });
}
async function barrier(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (query(`select to_jsonb(${predicate});`)[0]) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Owned fixture failed to reach the concurrency barrier.');
}
function asActor(sql, { id = actor, session = sid, aal = 'aal2', origin = 'https://77dominion.com', age = 0, claims = {} } = {}) {
  return `set request.jwt.claims=${json({ sub: id, session_id: session, role: 'authenticated', aal,
    amr: [{ method: 'totp', timestamp: Math.floor(Date.now() / 1000) - age }], ...claims }).replace(/::jsonb$/, '')};
    set request.headers=${literal(JSON.stringify({ origin }))};set role authenticated;${sql}`;
}
const asMember = (sql, options = {}) => asActor(sql, { id: member, session: memberSid, aal: 'aal1', ...options });
const asService = sql => `set request.jwt.claims='{"role":"service_role"}';set role service_role;${sql}`;
const denied = (sql, code = '42501', message) => `do $t$ begin begin ${sql.replace(/^select /, 'perform ')}
  exception when sqlstate '${code}' then ${message ? `if sqlerrm<>${literal(message)} then raise;end if;` : ''} return;end;raise exception 'Expected denial';end $t$;`;
function material(overrides = {}) {
  const raw = randomBytes(32); const issued = new Date(); const deliveryId = randomUUID();
  return { token: raw.toString('base64url'), digest: createHash('sha256').update(raw).digest('hex'), fingerprint: 'a'.repeat(64),
    binding: { requestId, generationId: randomUUID(), deliveryId, recipient: email, issuedAt: issued.toISOString(),
      expiresAt: new Date(issued.getTime() + 7 * 86400_000).toISOString(), from: 'Dominion <noreply@mail.77dominion.com>' },
    idempotencyKey: `dominion-early-access/${deliveryId}`,
    envelope: { version: 1, keyVersion: 1, nonce: randomBytes(12).toString('base64url'), ciphertext: randomBytes(100).toString('base64url') }, ...overrides };
}
function write(value = material(), { action = 'approve', expected = actor, id = requestId, revision = 0, operation = randomUUID(), correlation = randomUUID() } = {}) {
  return `select public.site_admin_write_early_access_invitation(${literal(expected)}::uuid,${literal(action)},${literal(id)}::uuid,${literal(revision)}::bigint,
    ${literal(operation)}::uuid,${literal(correlation)}::uuid,${json(value?.binding ?? null)},${literal(value?.digest ?? null)},
    ${literal(value?.fingerprint ?? null)},${literal(value?.idempotencyKey ?? null)},${json(value?.envelope ?? null)});`;
}
const accept = (value, { id = member, generation = value.binding.generationId, token = value.token, operation = randomUUID(), correlation = randomUUID() } = {}) =>
  `select public.accept_early_access_invitation('${id}',${literal(generation)}::uuid,${literal(token)},'${operation}','${correlation}');`;
const claim = (worker = randomUUID()) => ({ worker, jobs: query(asService(`select public.claim_early_access_invitation_deliveries('${worker}');`))[0] });
const dispatch = (value, worker, fingerprint = value.fingerprint, digest = value.digest) => query(asService(
  `select public.mark_early_access_invitation_dispatched('${value.binding.deliveryId}','${worker}',${literal(fingerprint)},${literal(digest)});`))[0];
const settle = (value, worker, outcome, code = null, receipt = null) => query(asService(
  `select to_jsonb(public.settle_early_access_invitation_delivery('${value.binding.deliveryId}','${worker}',${literal(outcome)},${literal(code)},${literal(receipt)}::uuid));`))[0];
function approved(value = material()) { assert.deepEqual(query(asActor(write(value)))[0], { ok: true, requestId, status: 'approved', revision: '1' }); return value; }
function dispatched(value = approved()) { const { worker, jobs } = claim(); assert.equal(jobs.length, 1); assert.ok(dispatch(value, worker)); return { value, worker }; }
async function changedDuringGrant(value, change, options = {}) {
  query("create function private.fixture_wait_grant() returns trigger language plpgsql as $$begin perform pg_sleep(0.8);return new;end$$;create trigger fixture_wait_grant before insert on private.early_access_grants for each row execute function private.fixture_wait_grant();");
  const pending = parallel(`set application_name='invitation-grant-wait';${asMember(accept(value), options)}`);
  await barrier("exists(select 1 from pg_stat_activity where application_name='invitation-grant-wait' and wait_event='PgSleep')");
  query(change); // Commits independently before the paused grant resumes.
  const result = await pending;
  assert.notEqual(result.code, 0); assert.doesNotMatch(result.error, /deadlock/);
  assert.deepEqual(query(`select to_jsonb(status) from private.early_access_requests where id='${requestId}';select to_jsonb(count(*)) from private.early_access_grants;select to_jsonb(count(*)) from private.early_access_price_qualifications;select to_jsonb(count(*)) from private.early_access_acceptance_operations;`), ['approved', 0, 0, 0]);
  return result;
}
function newAccount(value = material()) { query(`delete from auth.users where id='${member}';`);approved(value);return value; }
const bootstrapClaim = (worker = randomUUID()) => ({ worker, jobs: query(asService(`select public.claim_early_access_account_bootstraps('${worker}');`))[0] });
const bootstrapStart = (job, worker) => query(asService(`select to_jsonb(public.start_early_access_account_bootstrap('${job.generationId}','${worker}'));`))[0];
const bootstrapSettle = (job, worker, code = 'bootstrap_unavailable') => query(asService(`select to_jsonb(public.settle_early_access_account_bootstrap('${job.generationId}','${worker}',${literal(code)}));`))[0];
function setupMaterial(job, duration = 3500_000) {
  const issued = new Date();return { binding: { requestId: job.requestId, generationId: job.generationId, deliveryId: job.deliveryId,
    reservedUserId: job.reservedUserId, recipient: job.recipient, issuedAt: issued.toISOString(),
    expiresAt: new Date(issued.getTime() + duration).toISOString(), from: 'Dominion <noreply@mail.77dominion.com>' },
    envelope: { version: 1, keyVersion: 1, nonce: randomBytes(12).toString('base64url'), ciphertext: randomBytes(100).toString('base64url') },
    fingerprint: 'b'.repeat(64), idempotencyKey: `dominion-early-access-setup/${job.deliveryId}` };
}
const persistSetupSql = (job, worker, payload) => `select to_jsonb(public.persist_early_access_account_setup('${job.generationId}','${worker}',${json(payload.binding)},${json(payload.envelope)},${literal(payload.fingerprint)},${literal(payload.idempotencyKey)}));`;
const persistSetup = (job, worker, payload) => query(asService(persistSetupSql(job, worker, payload)))[0];
function preparedSetup(duration) {
  const value = newAccount();const { worker, jobs: [job] } = bootstrapClaim();assert.ok(job);assert.equal(bootstrapStart(job, worker), true);
  // Synthetic native-create response; no real Auth admin API or account is used.
  query(`insert into auth.users(id,email,email_confirmed_at) values('${job.reservedUserId}','${email}',null);`);
  const payload = setupMaterial(job, duration);assert.equal(persistSetup(job, worker, payload), true);
  return { value, job, worker, payload };
}
const setupClaim = (worker = randomUUID()) => ({ worker, jobs: query(asService(`select public.claim_early_access_account_setup_deliveries('${worker}');`))[0] });
const setupDispatchSql = (job, worker, fingerprint = 'b'.repeat(64)) => `select public.mark_early_access_account_setup_dispatched('${job.deliveryId}','${worker}',${literal(fingerprint)});`;
const setupDispatch = (job, worker, fingerprint) => query(asService(setupDispatchSql(job, worker, fingerprint)))[0];
const setupSettle = (job, worker, outcome, code = null, receipt = null) => query(asService(`select to_jsonb(public.settle_early_access_account_setup_delivery('${job.deliveryId}','${worker}',${literal(outcome)},${literal(code)},${literal(receipt)}::uuid));`))[0];

before(async () => {
  const file = name => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
  const readApis = await file('20260913065057_site_admin_read_apis.sql');
  migrations = await Promise.all(['20260913023402_early_access_request_intake.sql', '20260913062841_site_admin_foundation.sql',
    '20260913082358_early_access_admin_review.sql', '20260922000204_early_access_member_authority.sql',
    '20260922000815_early_access_feedback_outbox.sql', '20260927225600_early_access_invitation_lifecycle.sql',
    '20260927233055_early_access_account_bootstrap.sql'].map(file));
  migrations.splice(2, 0, readApis.slice(0, readApis.indexOf('create index site_admin_profiles_name_prefix_idx')));
  const baseline = await file('20260707170000_baseline.sql');
  legacyPredicate = baseline.match(/create or replace function public\.has_active_entitlement\([\s\S]*?\n\$\$;/)?.[0]; assert.ok(legacyPredicate);
  const cached = docker(['image', 'inspect', image, '--format', '{{.Id}}']); assert.equal(cached.status, 0, 'Pinned image must already be cached; no pull is permitted.');
  const imageId = cached.stdout.trim(); assert.match(imageId, /^sha256:[0-9a-f]{64}$/);
  const created = docker(['run', '--detach', '--pull', 'never', '--name', fixture, '--label', `77dc.fixture=${fixture}`,
    '--network', 'none', '--cpus', '1', '--memory', '512m', '--user', 'postgres', '--tmpfs', '/tmp:rw,size=384m',
    // The image's bundled pgsodium helper generates a fresh root key only in
    // this disposable tmpfs; no host key, volume, or existing stack is mounted.
    '--tmpfs', '/etc/postgresql-custom:rw,size=1m,mode=1777', '--entrypoint', '/bin/sh', imageId, '-c',
    // Cron is globally disabled even when its owned-fixture rows say active;
    // combined with network=none, this fixture cannot dispatch worker HTTP.
    'initdb -D /tmp/invitation-pgdata -A trust && exec postgres -D /tmp/invitation-pgdata -k /tmp -h "" -c shared_preload_libraries=pg_cron,pg_net,supabase_vault -c cron.database_name=postgres -c cron.launch_active_jobs=off']);
  assert.equal(created.status, 0, created.stderr); containerId = created.stdout.trim(); assert.match(containerId, /^[0-9a-f]{64}$/);
  let ready = false;
  for (let n = 0; n < 100; n++) { if (docker(['exec', containerId, 'pg_isready', '-h', '/tmp', '-U', 'postgres']).status === 0) { ready = true; break; } await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.ok(ready);
  query(`create role anon;create role authenticated;create role service_role bypassrls;create role supabase_auth_admin nologin;
    create role ${owner} nologin nosuperuser nobypassrls;grant create on database postgres to ${owner};`);
});
beforeEach(() => {
  query(`drop schema if exists private cascade;drop schema if exists auth cascade;drop schema public cascade;create schema auth;create schema public;
    grant usage on schema auth,public to anon,authenticated,service_role,${owner};grant usage on schema auth to supabase_auth_admin;grant create on schema public to ${owner};
    create table auth.users(id uuid primary key,email text,created_at timestamptz default now(),email_confirmed_at timestamptz default now(),
      is_anonymous boolean default false,deleted_at timestamptz,banned_until timestamptz,encrypted_password text default 'PRIVATE_AUTH_SENTINEL',raw_user_meta_data jsonb default '{}');
    create table auth.sessions(id uuid primary key,user_id uuid references auth.users on delete cascade,factor_id uuid,aal text,not_after timestamptz);
    create table auth.mfa_factors(id uuid primary key,user_id uuid references auth.users on delete cascade,factor_type text,status text);
    create table auth.mfa_amr_claims(session_id uuid references auth.sessions on delete cascade,authentication_method text,updated_at timestamptz,
      unique(session_id,authentication_method));
    create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
    alter table auth.users owner to supabase_auth_admin;alter table auth.sessions owner to supabase_auth_admin;
    alter table auth.mfa_factors owner to supabase_auth_admin;alter table auth.mfa_amr_claims owner to supabase_auth_admin;
    grant select,insert,update,delete,truncate,references,trigger on auth.users,auth.sessions,auth.mfa_factors,auth.mfa_amr_claims to ${owner};
    set role ${owner};create schema private;grant usage on schema private to service_role;
    create table public.entitlements(user_id uuid references auth.users on delete cascade,entitlement_key text,status text,source_type text,source_id text,starts_at timestamptz,ends_at timestamptz);
    begin;${legacyPredicate}${migrations.join('\n')}commit;reset role;
    insert into auth.users(id,email) values('${actor}','admin@example.invalid'),('${member}','${email}'),('${other}','other@example.invalid');
    insert into auth.mfa_factors values('${factor}','${actor}','totp','verified');
    select private.bootstrap_site_admin('${actor}','50000000-0000-4000-8000-000000000001','production');
    insert into auth.sessions values('${sid}','${actor}','${factor}','aal2',null),('${memberSid}','${member}',null,'aal1',null),('${otherSid}','${other}',null,'aal1',null);
    insert into auth.mfa_amr_claims values('${sid}','totp',clock_timestamp());
    insert into private.early_access_requests(id,name,email,user_id,answers) values('${requestId}','Synthetic Member','${email}','${member}','{"private":"PRIVATE_ANSWER_SENTINEL"}');`);
});
after(() => {
  if (!containerId) return;
  const inspected = docker(['inspect', containerId, '--format', '{{index .Config.Labels "77dc.fixture"}}']); assert.equal(inspected.status, 0); assert.equal(inspected.stdout.trim(), fixture);
  const removed = docker(['rm', '--force', containerId]); assert.equal(removed.status, 0, removed.stderr);
});

test('migration creates no invitations, accounts, grants or qualifications', () => {
  assert.deepEqual(query(`select to_jsonb(count(*)) from private.early_access_invitations;select to_jsonb(count(*)) from private.early_access_grants;
    select to_jsonb(count(*)) from private.early_access_price_qualifications;select to_jsonb(count(*)) from auth.users;`), [0, 0, 0, 3]);
});
test('registered pgTAP checks exact ACLs, RLS, wrappers and unchanged native Auth trigger scope', async () => {
  query('create schema if not exists extensions;');
  const sql = await readFile(new URL('../supabase/tests/database/300_early_access_invitations.sql', import.meta.url), 'utf8');
  const result = docker(command(), sql); assert.equal(result.status, 0, result.stderr); assert.doesNotMatch(result.stdout, /not ok|Looks like|planned .* but ran/);
  assert.match(result.stdout, /1\.\.45/); assert.equal(result.stdout.split('\n').filter(line => /^ok \d+/.test(line)).length, 45);
});
test('registered bootstrap pgTAP checks exact worker/internal ACLs and no seeded work', async () => {
  query('create schema if not exists extensions;');
  const sql = await readFile(new URL('../supabase/tests/database/310_early_access_account_bootstrap.sql', import.meta.url), 'utf8');
  const result = docker(command(), sql);assert.equal(result.status, 0, result.stderr);assert.doesNotMatch(result.stdout, /not ok|Looks like|planned .* but ran/);
  assert.match(result.stdout, /1\.\.47/);assert.equal(result.stdout.split('\n').filter(line => /^ok \d+/.test(line)).length, 47);
});
test('authenticated admin approval freezes hash/ciphertext and truthful unsent state atomically', () => {
  const value = approved();
  const [invitation, delivery] = query('select to_jsonb(i) from private.early_access_invitations i;select to_jsonb(d) from private.early_access_invitation_deliveries d;');
  assert.equal(invitation.token_digest, value.digest); assert.equal(invitation.account_id, member);
  assert.equal(new Date(invitation.expires_at) - new Date(invitation.issued_at), 7 * 86400_000);
  assert.deepEqual(delivery.envelope, value.envelope); assert.deepEqual(delivery.binding, value.binding); assert.equal(delivery.status, 'queued');
  const detail = query(asActor(`select public.site_admin_get_early_access_request('${actor}','${requestId}');`))[0];
  assert.equal(detail.item.invitationSentAt, null); assert.ok(detail.item.invitationExpiresAt);
  const history = query(asActor(`select public.site_admin_list_early_access_history('${actor}','${requestId}');`))[0];
  assert.equal(history.items[0].action, 'early_access.approve');
  for (const secret of [value.token, value.digest, value.envelope.ciphertext, 'PRIVATE_ANSWER_SENTINEL', 'PRIVATE_AUTH_SENTINEL']) assert.ok(!JSON.stringify({ detail, history }).includes(secret));
});
test('writer rejects anon/service identities, member metadata, wrong actor/origin and stale MFA', () => {
  const sql = write();
  query(`set role anon;${denied(sql)}`); query(asService(denied(sql)));
  query(asMember(denied(sql, 'PT401')));
  query(asMember(denied(write(material(), { expected: member }), 'PT403'), { claims: { user_metadata: { site_admin: true } } }));
  query(asActor(denied(sql, 'PT403'), { origin: 'https://attacker.invalid' }));
  query(asActor(denied(sql, 'PT403'), { aal: 'aal1' })); query(asActor(denied(sql, 'PT403'), { age: 601 }));
  assert.equal(query('select to_jsonb(count(*)) from private.early_access_invitations;')[0], 0);
});
test('current authorization is required even for exact retries; retries never replace material', () => {
  const value = material(); const operation = randomUUID(); const correlation = randomUUID(); const options = { operation, correlation };
  const first = query(asActor(write(value, options)))[0];
  assert.deepEqual(query(asActor(write(material(), options)))[0], first);
  assert.deepEqual(query(asActor(write(null, options)))[0], first);
  assert.equal(query('select to_jsonb(token_digest) from private.early_access_invitations;')[0], value.digest);
  query(asActor(denied(write(value, { ...options, action: 'resend' }), '22023', 'admin_idempotency_conflict')));
  query("delete from private.site_role_permissions where permission_key='operations.manage';");
  query(asActor(denied(write(value, options), 'PT403')));
});
test('same-operation concurrent issuers converge; different operations cannot use one revision', async () => {
  const options = { operation: randomUUID(), correlation: randomUUID() };
  const replies = await Promise.all([parallel(asActor(write(material(), options))), parallel(asActor(write(material(), options)))]);
  for (const reply of replies) assert.equal(reply.code, 0, reply.error);
  assert.deepEqual(JSON.parse(replies[0].output), JSON.parse(replies[1].output));
  assert.equal(query('select to_jsonb(count(*)) from private.early_access_invitations;')[0], 1);
  assert.deepEqual(query(asActor(write()))[0], { ok: false, errorCode: 'revision_conflict' });
});
test('wrong mailbox, malformed envelope and non-seven-day timestamps are safe audited failures', () => {
  const changes = [v => { v.binding.recipient = 'other@example.invalid'; }, v => { v.binding.extra = 'no'; },
    v => { v.binding.expiresAt = new Date(Date.now() + 86400_000).toISOString(); },
    v => { v.binding.issuedAt = new Date(Date.now() - 31_000).toISOString(); v.binding.expiresAt = new Date(Date.now() - 31_000 + 7 * 86400_000).toISOString(); },
    v => { v.envelope.nonce += '='; }, v => { v.envelope.keyVersion = 0; }, v => { v.envelope.ciphertext += '='; },
    v => { v.digest = 'x'.repeat(64); }, v => { v.idempotencyKey = 'unbound'; }, v => { v.binding.from = 'other@attacker.invalid'; }];
  for (const change of changes) { const value = material(); change(value); assert.deepEqual(query(asActor(write(value)))[0], { ok: false, errorCode: 'invalid_input' }); }
  assert.equal(query('select to_jsonb(count(*)) from private.early_access_invitations;')[0], 0);
});
test('existing unconfirmed accounts never receive a new invitation or access', () => {
  query(`update auth.users set email_confirmed_at=null where id='${member}';`);
  assert.deepEqual(query(asActor(write()))[0], { ok: false, errorCode: 'account_recovery_required' });
  assert.equal(query('select to_jsonb(count(*)) from private.early_access_invitation_deliveries;')[0], 0);
});
test('approval and audit failure roll back the job, hash and operation receipt together', () => {
  query("create function private.fixture_reject_audit() returns trigger language plpgsql as $$begin raise exception 'fixture audit unavailable';end$$;create trigger fixture_reject_audit before insert on private.site_admin_audit for each row execute function private.fixture_reject_audit();");
  const sql = asActor(write()); const failure = docker(command(), sql); assert.notEqual(failure.status, 0); assert.match(failure.stderr, /fixture audit unavailable/);
  assert.deepEqual(query('select to_jsonb(count(*)) from private.early_access_invitations;select to_jsonb(count(*)) from private.early_access_invitation_deliveries;select to_jsonb(count(*)) from private.site_admin_role_requests;'), [0, 0, 0]);
  query('drop trigger fixture_reject_audit on private.site_admin_audit;'); assert.equal(query(sql)[0].ok, true);
});
test('resend supersedes every old capability and purges unsent encrypted payload', () => {
  const first = approved(); const second = material();
  assert.equal(query(asActor(write(second, { action: 'resend', revision: 1 })))[0].revision, '2');
  assert.deepEqual(query(`select jsonb_build_array(state,(select envelope is null from private.early_access_invitation_deliveries where invitation_id=i.id)) from private.early_access_invitations i where id='${first.binding.generationId}';`), [['superseded', true]]);
  assert.deepEqual(query(asMember(accept(first)))[0], { ok: false, errorCode: 'invitation_unavailable' });
  assert.equal(claim().jobs[0].deliveryId, second.binding.deliveryId);
});
test('pre-acceptance revoke cannot be undone by stale worker dispatch or settlement', () => {
  const { value, worker } = dispatched();
  assert.equal(query(asActor(write(null, { action: 'revoke', revision: 1 })))[0].status, 'revoked');
  assert.equal(dispatch(value, worker), null); assert.equal(settle(value, worker, 'accepted', null, randomUUID()), false);
  assert.deepEqual(query(asMember(accept(value)))[0], { ok: false, errorCode: 'invitation_unavailable' });
});
test('ciphertext alone never authorizes acceptance; wrong fingerprint or hash cannot dispatch', () => {
  const value = approved();
  assert.deepEqual(query(asMember(accept(value)))[0], { ok: false, errorCode: 'delivery_not_ready' });
  const { worker } = claim(); assert.equal(dispatch(value, worker, 'b'.repeat(64)), null); assert.equal(dispatch(value, worker, value.fingerprint, 'b'.repeat(64)), null);
  assert.equal(query('select to_jsonb(count(*)) from private.transactional_email_reservations;')[0], 0);
});
test('worker retry preserves exact payload, dispatch timestamp and one shared email reservation', () => {
  const { value, worker } = dispatched(); const first = dispatch(value, worker);
  assert.equal(settle(value, worker, 'uncertain', 'provider_unavailable'), true);
  query('update private.early_access_invitation_deliveries set next_attempt_at=clock_timestamp();');
  const again = claim(); assert.deepEqual(again.jobs[0].envelope, value.envelope); assert.equal(again.jobs[0].firstDispatchedAt, first.firstDispatchedAt);
  assert.deepEqual(dispatch(value, again.worker), first); assert.equal(query('select to_jsonb(count(*)) from private.transactional_email_reservations;')[0], 1);
  assert.equal(settle(value, again.worker, 'accepted', null, randomUUID()), true);
  const [state] = query(`select jsonb_build_array(status,invitation_sent_at is not null,revision) from private.early_access_requests where id='${requestId}';`);
  assert.deepEqual(state, ['invited', true, 2]); assert.equal(query('select to_jsonb(envelope is null) from private.early_access_invitation_deliveries;')[0], true);
});
test('acceptance atomically creates only EA grant and immutable lifetime price qualification', () => {
  const { value } = dispatched(); const options = { operation: randomUUID(), correlation: randomUUID() }; const sql = asMember(accept(value, options));
  const receipt = { ok: true, status: 'accepted', actorId: member, program: 'early_access_v1' };
  assert.deepEqual(query(sql)[0], receipt); assert.deepEqual(query(sql)[0], receipt);
  assert.deepEqual(query(`select jsonb_build_array(user_id,program_key) from private.early_access_grants;
    select jsonb_build_array(user_id,currency,unit_amount,recurring_interval) from private.early_access_price_qualifications;
    select to_jsonb(count(*)) from public.entitlements;select to_jsonb(role_key) from private.site_user_roles where user_id='${member}';`),
  [[member, 'early_access_v1'], [member, 'usd', 350, 'month'], 0, 'member']);
  assert.deepEqual(query(asMember(accept(value)))[0], { ok: false, errorCode: 'invitation_unavailable' });
  assert.deepEqual(query(asActor(write(null, { action: 'revoke', revision: 2 })))[0], { ok: false, errorCode: 'invalid_state' });
});
test('wrong account and canonical token aliases cannot accept; no email is returned', () => {
  const { value } = dispatched();
  const wrong = query(asMember(accept(value, { id: other }), { id: other, session: otherSid }))[0]; assert.deepEqual(wrong, { ok: false, errorCode: 'account_unavailable' });
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const alias = value.token.slice(0, -1) + alphabet[alphabet.indexOf(value.token.at(-1)) + 1];
  query(asMember(denied(accept(value, { token: alias }), '22023', 'invitation_invalid_input')));
  query(asMember(denied(accept(value, { token: value.digest }), '22023', 'invitation_invalid_input')));
});
test('new-account issuance stays setup-required after later account creation without provenance binding', () => {
  query(`delete from auth.users where id='${member}';`); const value = approved(); assert.deepEqual(claim().jobs, []);
  query(`insert into auth.users(id,email) values('${member}','${email}');insert into auth.sessions values('${memberSid}','${member}',null,'aal1',null);`);
  assert.deepEqual(query(asMember(accept(value)))[0], { ok: false, errorCode: 'account_setup_required' });
  assert.equal(query('select to_jsonb(count(*)) from private.early_access_grants;')[0], 0);
});
test('worker expires only current generations and records truthful token-free history', () => {
  const value = approved(); query(`update private.early_access_invitations set issued_at=statement_timestamp()-interval '8 days',expires_at=statement_timestamp()-interval '1 day' where id='${value.binding.generationId}';`);
  assert.deepEqual(claim().jobs, []); assert.deepEqual(claim().jobs, []);
  assert.deepEqual(query("select jsonb_build_array(state,closed_at is not null) from private.early_access_invitations;select to_jsonb(count(*)) from private.site_admin_audit where action='early_access.expire';"), [['expired', true], 1]);
});
test('service workers cannot issue or accept, and all private table privileges stay closed', () => {
  for (const role of ['anon', 'authenticated', 'service_role']) {
    for (const table of ['early_access_invitations', 'early_access_invitation_deliveries', 'early_access_acceptance_operations']) query(`set role ${role};${denied(`select * from private.${table};`)}`);
  }
  const value = material(); query(asService(denied(accept(value))));
  query(asMember(denied('select public.claim_early_access_invitation_deliveries(gen_random_uuid());')));
  const [closed] = query(`select to_jsonb(bool_and(c.relrowsecurity)) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname in ('early_access_invitations','early_access_invitation_deliveries','early_access_acceptance_operations');`); assert.equal(closed, true);
});

test('email change committed before the acceptance request lock is released denies the old mailbox', async () => {
  const { value } = dispatched();
  const change = parallel(`set application_name='invitation-email-change';begin;select 1 from private.early_access_requests where id='${requestId}' for update;update auth.users set email='changed@example.invalid' where id='${member}';select pg_sleep(0.6);commit;`);
  await barrier("exists(select 1 from pg_stat_activity where application_name='invitation-email-change' and wait_event='PgSleep')");
  const accepted = await parallel(asMember(accept(value))); const changed = await change;
  assert.equal(changed.code, 0, changed.error); assert.equal(accepted.code, 0, accepted.error);
  assert.deepEqual(JSON.parse(accepted.output), { ok: false, errorCode: 'account_unavailable' });
  assert.equal(query('select to_jsonb(count(*)) from private.early_access_grants;')[0], 0);
});
test('native session revocation committed during grant wait rolls back acceptance', async () => {
  const { value } = dispatched();
  const accepted = await changedDuringGrant(value, `delete from auth.sessions where id='${memberSid}';`);
  assert.match(accepted.error, /member_authentication_required/);
});
test('new verified MFA enrollment committed during grant wait denies stale AAL1 acceptance', async () => {
  const { value } = dispatched();
  const accepted = await changedDuringGrant(value, `insert into auth.mfa_factors values('${randomUUID()}','${member}','totp','verified');`);
  assert.match(accepted.error, /member_mfa_required/);
});
test('native user deletion cannot deadlock acceptance FKs or transfer its pinned UUID', async () => {
  const { value } = dispatched();
  const deletion = parallel(`set application_name='invitation-user-delete';begin;delete from auth.users where id='${member}';select pg_sleep(0.6);commit;`);
  await barrier("exists(select 1 from pg_stat_activity where application_name='invitation-user-delete' and wait_event='PgSleep')");
  const accepted = await parallel(asMember(accept(value))); assert.equal((await deletion).code, 0);
  assert.notEqual(accepted.code, 0); assert.match(accepted.error, /member_authentication_required/); assert.doesNotMatch(accepted.error, /deadlock/);
  assert.equal(query('select to_jsonb(account_id) from private.early_access_invitations;')[0], member);
  assert.equal(query('select to_jsonb(count(*)) from private.early_access_grants;')[0], 0);
});
test('canonical email change committed during grant wait rolls back all acceptance effects', async () => {
  const { value } = dispatched();
  const accepted = await changedDuringGrant(value, `update auth.users set email='changed@example.invalid' where id='${member}';`);
  assert.match(accepted.error, /member_authentication_required/);
});
test('same-session expiry during grant trigger wait rolls back request, grant and qualification', async () => {
  const { value } = dispatched();
  query(`update auth.sessions set not_after=clock_timestamp()+interval '400 milliseconds' where id='${memberSid}';
    create function private.fixture_wait_grant() returns trigger language plpgsql as $$begin perform pg_sleep(0.6);return new;end$$;
    create trigger fixture_wait_grant before insert on private.early_access_grants for each row execute function private.fixture_wait_grant();`);
  const result = await parallel(asMember(accept(value))); assert.notEqual(result.code, 0); assert.match(result.error, /member_authentication_required/);
  assert.deepEqual(query(`select to_jsonb(status) from private.early_access_requests where id='${requestId}';select to_jsonb(count(*)) from private.early_access_grants;select to_jsonb(count(*)) from private.early_access_price_qualifications;`), ['approved', 0, 0]);
});
test('native factor insertion racing parent deletion uses only native FK ordering', async () => {
  query("create function private.fixture_pause_auth_delete() returns trigger language plpgsql as $$begin perform pg_sleep(0.6);return old;end$$;create trigger a_fixture_pause_auth_delete before delete on auth.users for each row execute function private.fixture_pause_auth_delete();");
  const deletion = parallel(`set application_name='invitation-factor-parent-delete';delete from auth.users where id='${member}';`);
  await barrier("exists(select 1 from pg_stat_activity where application_name='invitation-factor-parent-delete' and wait_event='PgSleep')");
  const insertion = await parallel(`insert into auth.mfa_factors values('${randomUUID()}','${member}','totp','verified');`);
  const deleted = await deletion; assert.equal(deleted.code, 0, deleted.error);
  assert.notEqual(insertion.code, 0); assert.match(insertion.error, /foreign key/); assert.doesNotMatch(insertion.error, /deadlock/);
});
test('native AMR insertion racing session deletion uses its real parent FK', async () => {
  query("create function private.fixture_pause_session_delete() returns trigger language plpgsql as $$begin perform pg_sleep(0.6);return old;end$$;create trigger a_fixture_pause_session_delete before delete on auth.sessions for each row execute function private.fixture_pause_session_delete();");
  const deletion = parallel(`set application_name='invitation-amr-parent-delete';delete from auth.sessions where id='${memberSid}';`);
  await barrier("exists(select 1 from pg_stat_activity where application_name='invitation-amr-parent-delete' and wait_event='PgSleep')");
  const insertion = await parallel(`insert into auth.mfa_amr_claims values('${memberSid}','totp',clock_timestamp());`);
  const deleted = await deletion; assert.equal(deleted.code, 0, deleted.error);
  assert.notEqual(insertion.code, 0); assert.match(insertion.error, /foreign key/); assert.doesNotMatch(insertion.error, /deadlock/);
});
test('verified intake association, native deletion and admin issuance have no three-way FK cycle', async () => {
  query(`update private.early_access_requests set user_id=null where id='${requestId}';
    create function private.fixture_pause_intake_association() returns trigger language plpgsql as $$begin perform pg_sleep(0.8);return new;end$$;
    create trigger fixture_pause_intake_association before update of user_id on private.early_access_requests for each row execute function private.fixture_pause_intake_association();`);
  const intake = parallel(`set application_name='invitation-intake-association';${asService(`select public.submit_early_access_request_service('Synthetic Member','${email}','${member}');`)}`);
  await barrier("exists(select 1 from pg_stat_activity where application_name='invitation-intake-association' and wait_event='PgSleep')");
  const issuance = parallel(`set application_name='invitation-intake-issuer';${asActor(write())}`);
  await barrier("exists(select 1 from pg_stat_activity where application_name='invitation-intake-issuer' and wait_event_type='Lock')");
  const deletion = parallel(`set application_name='invitation-intake-user-delete';delete from auth.users where id='${member}';`);
  const results = await Promise.all([intake, issuance, deletion]);
  assert.doesNotMatch(results.map(result => result.error).join('\n'), /deadlock/);
  for (const result of results) {
    assert.doesNotMatch(result.error, /deadlock/, result.error);
    assert.equal(result.code, 0, result.error);
  }
});
test('admin role revocation during lifecycle wait prevents issuance', async () => {
  const change = parallel("set application_name='invitation-admin-revoke';begin;select pg_advisory_xact_lock(hashtextextended('site-admin-lifecycle',1502));delete from private.site_role_permissions where permission_key='operations.manage';select pg_sleep(0.6);commit;");
  await barrier("exists(select 1 from pg_stat_activity where application_name='invitation-admin-revoke' and wait_event='PgSleep')");
  const result = await parallel(asActor(write())); assert.equal((await change).code, 0); assert.notEqual(result.code, 0); assert.match(result.error, /admin_permission_or_step_up_required/);
  assert.equal(query('select to_jsonb(count(*)) from private.early_access_invitations;')[0], 0);
});
test('concurrent acceptance and resend serialize one winner with no duplicate grant', async () => {
  const { value } = dispatched();
  const results = await Promise.all([parallel(asMember(accept(value))), parallel(asActor(write(material(), { action: 'resend', revision: 1 })))]);
  for (const result of results) assert.equal(result.code, 0, result.error);
  const receipts = results.map(result => JSON.parse(result.output));
  assert.equal(receipts.filter(result => result.ok).length, 1);
  const [count] = query('select to_jsonb(count(*)) from private.early_access_grants;'); assert.ok(count === 0 || count === 1);
});
test('free-plan daily cap and exhausted attempts never send', () => {
  const value = approved(); const { worker } = claim();
  query("insert into private.transactional_email_reservations(delivery_id) select gen_random_uuid() from generate_series(1,90);");
  assert.equal(dispatch(value, worker), null);
  assert.equal(query('select to_jsonb(first_dispatched_at is null) from private.early_access_invitation_deliveries;')[0], true);
  query("update private.early_access_invitation_deliveries set attempts=12,lease_until=clock_timestamp()-interval '1 second';");
  assert.deepEqual(claim().jobs, []); assert.equal(query('select to_jsonb(status) from private.early_access_invitation_deliveries;')[0], 'needs_review');
});
test('provider uncertainty beyond23hours never rotates a key or resets first dispatch', () => {
  const { value, worker } = dispatched(); assert.equal(settle(value, worker, 'uncertain', 'provider_unavailable'), true);
  query("update private.early_access_invitation_deliveries set first_dispatched_at=statement_timestamp()-interval '24 hours',validated_at=statement_timestamp()-interval '24 hours',next_attempt_at=clock_timestamp();");
  assert.deepEqual(claim().jobs, []);
  const [job] = query('select to_jsonb(d) from private.early_access_invitation_deliveries d;');
  assert.equal(job.status, 'needs_review'); assert.equal(job.idempotency_key, value.idempotencyKey); assert.deepEqual(job.envelope, value.envelope);
  assert.ok(new Date(job.first_dispatched_at).getTime() < Date.now() - 23 * 3600_000);
});
test('rolling monthly free budget includes reservations older than one day', () => {
  const value = approved(); const { worker } = claim();
  query("insert into private.transactional_email_reservations(delivery_id,reserved_at) select gen_random_uuid(),clock_timestamp()-interval '2 days' from generate_series(1,2900);");
  assert.equal(dispatch(value, worker), null); assert.equal(query('select to_jsonb(count(*)) from private.transactional_email_reservations;')[0], 2900);
});
test('quota wait crossing the lease deadline rolls back only the new reservation', async () => {
  const value = approved(); const { worker } = claim();
  query("update private.early_access_invitation_deliveries set lease_until=clock_timestamp()+interval '400 milliseconds';");
  const hold = parallel("set application_name='invitation-quota-hold';begin;select pg_advisory_xact_lock(hashtextextended('transactional-email-free-quota',1803));select pg_sleep(0.7);commit;");
  await barrier("exists(select 1 from pg_stat_activity where application_name='invitation-quota-hold' and wait_event='PgSleep')");
  const sending = await parallel(asService(`select public.mark_early_access_invitation_dispatched('${value.binding.deliveryId}','${worker}','${value.fingerprint}','${value.digest}');`));
  assert.equal((await hold).code, 0); assert.equal(sending.code, 0, sending.error); assert.equal(JSON.parse(sending.output), null);
  assert.deepEqual(query('select to_jsonb(count(*)) from private.transactional_email_reservations;select to_jsonb(first_dispatched_at is null) from private.early_access_invitation_deliveries;'), [0, true]);
});
test('disabled program and an already-started beta prevent dispatch without spending quota', () => {
  const value = approved(); const { worker } = claim();
  query("update private.early_access_programs set configured=false where program_key='early_access_v1';");
  assert.equal(dispatch(value, worker), null);
  query("update private.early_access_programs set configured=true,beta_starts_at=clock_timestamp()-interval '1 second' where program_key='early_access_v1';");
  assert.equal(dispatch(value, worker), null);
  assert.deepEqual(query('select to_jsonb(count(*)) from private.transactional_email_reservations;select to_jsonb(first_dispatched_at is null) from private.early_access_invitation_deliveries;'), [0, true]);
});
test('beta starting during quota wait rolls back the new reservation and dispatch validation', async () => {
  const value = approved(); const { worker } = claim();
  query("update private.early_access_programs set beta_starts_at=clock_timestamp()+interval '400 milliseconds' where program_key='early_access_v1';");
  const hold = parallel("set application_name='invitation-beta-quota-hold';begin;select pg_advisory_xact_lock(hashtextextended('transactional-email-free-quota',1803));select pg_sleep(0.7);commit;");
  await barrier("exists(select 1 from pg_stat_activity where application_name='invitation-beta-quota-hold' and wait_event='PgSleep')");
  const sending = await parallel(asService(`select public.mark_early_access_invitation_dispatched('${value.binding.deliveryId}','${worker}','${value.fingerprint}','${value.digest}');`));
  assert.equal((await hold).code, 0); assert.equal(sending.code, 0, sending.error); assert.equal(JSON.parse(sending.output), null);
  assert.deepEqual(query('select to_jsonb(count(*)) from private.transactional_email_reservations;select to_jsonb(validated_at is null) from private.early_access_invitation_deliveries;'), [0, true]);
});
test('MFA session downgrade committed during grant wait prevents stale AAL2 acceptance', async () => {
  const { value } = dispatched(); const memberFactor = randomUUID();
  query(`insert into auth.mfa_factors values('${memberFactor}','${member}','totp','verified');update auth.sessions set factor_id='${memberFactor}',aal='aal2' where id='${memberSid}';`);
  const accepted = await changedDuringGrant(value, `update auth.sessions set aal='aal1' where id='${memberSid}';`, { aal: 'aal2' });
  assert.match(accepted.error, /member_mfa_required/);
});
test('acceptance failure operation IDs conflict with the unchanged denial and role writers', () => {
  const value = material(); const operation = randomUUID(); const correlation = randomUUID();
  assert.deepEqual(query(asActor(accept(value, { id: actor, operation, correlation })))[0], { ok: false, errorCode: 'invitation_unavailable' });
  query(asActor(denied(`select public.site_admin_deny_early_access_request('${actor}','${requestId}',0,'${operation}','${correlation}');`, '22023', 'admin_idempotency_conflict')));
  query(asActor(denied(`select public.site_admin_assign_role('${actor}','${member}','site_admin',0,'${operation}','${correlation}','approved_role_change');`, '22023', 'admin_idempotency_conflict')));
});
test('acceptance and price-fact failure roll back together and the original operation can retry', () => {
  const { value } = dispatched(); const options = { operation: randomUUID(), correlation: randomUUID() }; const sql = asMember(accept(value, options));
  query("create function private.fixture_reject_price() returns trigger language plpgsql as $$begin raise exception 'fixture price unavailable';end$$;create trigger fixture_reject_price before insert on private.early_access_price_qualifications for each row execute function private.fixture_reject_price();");
  const failed = docker(command(), sql); assert.notEqual(failed.status, 0); assert.match(failed.stderr, /fixture price unavailable/);
  assert.deepEqual(query(`select to_jsonb(status) from private.early_access_requests where id='${requestId}';select to_jsonb(count(*)) from private.early_access_grants;select to_jsonb(count(*)) from private.early_access_acceptance_operations;`), ['approved', 0, 0]);
  query('drop trigger fixture_reject_price on private.early_access_price_qualifications;'); assert.equal(query(sql)[0].status, 'accepted');
});

test('new-account approval reserves private UUIDs atomically, never creates Auth or sends app mail', () => {
  const value = newAccount();const { worker, jobs: [job] } = bootstrapClaim();assert.ok(job);
  assert.deepEqual(Object.keys(job).sort(), ['deliveryId', 'generationId', 'invitationExpiresAt', 'recipient', 'requestId', 'reservedUserId'].sort());
  assert.equal(job.generationId, value.binding.generationId);assert.equal(job.recipient, email);
  assert.notEqual(job.deliveryId, value.binding.deliveryId);assert.notEqual(job.reservedUserId, member);
  assert.deepEqual(claim().jobs, []);assert.deepEqual(bootstrapClaim().jobs, []);
  assert.equal(query(`select to_jsonb(count(*)) from auth.users where id='${job.reservedUserId}';`)[0], 0);
  assert.equal(bootstrapStart(job, worker), true);assert.equal(bootstrapStart(job, worker), false, 'a native call cannot be launched twice');
});
test('confirmed existing accounts have no bootstrap job', () => {
  approved();assert.deepEqual(bootstrapClaim().jobs, []);
  assert.equal(query('select to_jsonb(count(*)) from private.early_access_account_bootstraps;')[0], 0);
});
test('pre-start lease reclaim preserves reserved UUID and fences the old worker', () => {
  newAccount();const first = bootstrapClaim();const job = first.jobs[0];
  query("update private.early_access_account_bootstraps set lease_until=clock_timestamp()-interval '1 second';");
  const next = bootstrapClaim();assert.deepEqual(next.jobs[0], job);assert.equal(bootstrapStart(job, first.worker), false);assert.equal(bootstrapStart(job, next.worker), true);
});
test('concurrent bootstrap claimants get one reserved native operation', async () => {
  newAccount();const workers = [randomUUID(), randomUUID()];
  const results = await Promise.all(workers.map(worker => parallel(asService(`select public.claim_early_access_account_bootstraps('${worker}');`))));
  for (const result of results) assert.equal(result.code, 0, result.error);
  assert.equal(results.map(result => JSON.parse(result.output).length).reduce((a, b) => a + b), 1);
  assert.equal(query('select to_jsonb(attempts) from private.early_access_account_bootstraps;')[0], 1);
});
test('unknown native result is terminal review, never an automatic token regeneration', () => {
  newAccount();const { worker, jobs: [job] } = bootstrapClaim();assert.equal(bootstrapStart(job, worker), true);
  query("update private.early_access_account_bootstraps set lease_until=clock_timestamp()-interval '1 second';");
  assert.deepEqual(bootstrapClaim().jobs, []);assert.deepEqual(bootstrapClaim().jobs, []);
  assert.equal(query('select to_jsonb(status) from private.early_access_account_bootstraps;')[0], 'needs_review');
  assert.equal(bootstrapStart(job, worker), false);assert.equal(persistSetup(job, worker, setupMaterial(job)), false);
});
test('explicit native failure is terminal and cannot clear its provenance fence', () => {
  newAccount();const { worker, jobs: [job] } = bootstrapClaim();assert.equal(bootstrapStart(job, worker), true);
  assert.equal(bootstrapSettle(job, worker), true);assert.equal(bootstrapSettle(job, worker), false);assert.deepEqual(bootstrapClaim().jobs, []);
  assert.equal(query('select to_jsonb(native_started_at is not null) from private.early_access_account_bootstraps;')[0], true);
});
test('a mailbox created by someone else before start is never adopted', () => {
  newAccount();const { worker, jobs: [job] } = bootstrapClaim();
  query(`insert into auth.users(id,email,email_confirmed_at) values('${member}','${email}',null);`);
  assert.equal(bootstrapStart(job, worker), false);assert.equal(persistSetup(job, worker, setupMaterial(job)), false);
  assert.equal(query('select to_jsonb(account_id) from private.early_access_invitations;')[0], null);
});
test('persist binds only the privately reserved UUID and rejects ambiguous or confirmed accounts', () => {
  newAccount();const { worker, jobs: [job] } = bootstrapClaim();assert.equal(bootstrapStart(job, worker), true);const payload = setupMaterial(job);
  query(`insert into auth.users(id,email,email_confirmed_at) values('${member}','${email}',null);`);
  assert.equal(persistSetup(job, worker, payload), false);
  query(`insert into auth.users(id,email,email_confirmed_at) values('${job.reservedUserId}','${email}',null);`);
  assert.equal(persistSetup(job, worker, payload), false);
  query(`delete from auth.users where id='${member}';update auth.users set email_confirmed_at=clock_timestamp() where id='${job.reservedUserId}';`);
  assert.equal(persistSetup(job, worker, payload), false);
  query(`update auth.users set email_confirmed_at=null where id='${job.reservedUserId}';`);
  assert.equal(persistSetup(job, worker, payload), true);
});
test('setup material is separately bound, short-lived, bounded and immutable on exact persistence retry', () => {
  newAccount();const { worker, jobs: [job] } = bootstrapClaim();bootstrapStart(job, worker);
  query(`insert into auth.users(id,email,email_confirmed_at) values('${job.reservedUserId}','${email}',null);`);
  const value = setupMaterial(job);const invalid = [
    v => { v.binding.reservedUserId = member; }, v => { v.binding.recipient = 'other@example.invalid'; },
    v => { v.binding.extra = 'not-allowed'; }, v => { v.binding.expiresAt = new Date(Date.parse(v.binding.issuedAt) + 3600_001).toISOString(); },
    v => { v.binding.expiresAt = new Date(Date.parse(v.binding.issuedAt) + 3590_000).toISOString(); },
    v => { v.binding.expiresAt = v.binding.issuedAt; }, v => { v.idempotencyKey = `dominion-early-access/${job.deliveryId}`; },
    v => { v.envelope.ciphertext = randomBytes(16401).toString('base64url'); }, v => { v.envelope.nonce = 'bad'; },
  ];
  for (const mutate of invalid) { const candidate = structuredClone(value);mutate(candidate);assert.equal(persistSetup(job, worker, candidate), false); }
  value.envelope.ciphertext = randomBytes(16400).toString('base64url');assert.equal(persistSetup(job, worker, value), true);
  assert.equal(persistSetup(job, worker, value), true);assert.equal(persistSetup(job, randomUUID(), value), false);
  const changed = structuredClone(value);changed.envelope.nonce = randomBytes(12).toString('base64url');assert.equal(persistSetup(job, worker, changed), false);
  assert.deepEqual(query('select to_jsonb(envelope) from private.early_access_account_setup_deliveries;')[0], value.envelope);
});
test('setup persistence and native UUID pin roll back atomically on outbox failure', () => {
  newAccount();const { worker, jobs: [job] } = bootstrapClaim();bootstrapStart(job, worker);
  query(`insert into auth.users(id,email,email_confirmed_at) values('${job.reservedUserId}','${email}',null);
    create function private.fixture_reject_setup() returns trigger language plpgsql as $$begin raise exception 'fixture setup unavailable';end$$;
    create trigger fixture_reject_setup before insert on private.early_access_account_setup_deliveries for each row execute function private.fixture_reject_setup();`);
  const payload = setupMaterial(job);const result = docker(command(), asService(persistSetupSql(job, worker, payload)));assert.notEqual(result.status, 0);
  assert.deepEqual(query('select to_jsonb(account_id) from private.early_access_invitations;select to_jsonb(status) from private.early_access_account_bootstraps;select to_jsonb(count(*)) from private.early_access_account_setup_deliveries;'), [null, 'native_started', 0]);
  query('drop trigger fixture_reject_setup on private.early_access_account_setup_deliveries;');assert.equal(persistSetup(job, worker, payload), true);
});
test('canonical mailbox change committed during setup outbox wait prevents the UUID pin', async () => {
  newAccount();const { worker, jobs: [job] } = bootstrapClaim();bootstrapStart(job, worker);
  query(`insert into auth.users(id,email,email_confirmed_at) values('${job.reservedUserId}','${email}',null);
    create function private.fixture_wait_setup() returns trigger language plpgsql as $$begin perform pg_sleep(0.8);return new;end$$;
    create trigger fixture_wait_setup before insert on private.early_access_account_setup_deliveries for each row execute function private.fixture_wait_setup();`);
  const pending = parallel(`set application_name='setup-persist-wait';${asService(persistSetupSql(job, worker, setupMaterial(job)))}`);
  await barrier("exists(select 1 from pg_stat_activity where application_name='setup-persist-wait' and wait_event='PgSleep')");
  query(`update auth.users set email='changed@example.invalid' where id='${job.reservedUserId}';`);
  const result = await pending;assert.notEqual(result.code, 0);assert.match(result.error, /invitation_bootstrap_authority_changed/);
  assert.deepEqual(query('select to_jsonb(account_id) from private.early_access_invitations;select to_jsonb(status) from private.early_access_account_bootstraps;select to_jsonb(count(*)) from private.early_access_account_setup_deliveries;'), [null, 'native_started', 0]);
});
test('setup delivery uses immutable retries and one free quota reservation', () => {
  const { job, payload } = preparedSetup();const first = setupClaim();assert.equal(first.jobs.length, 1);
  assert.equal(setupDispatch(job, first.worker, 'c'.repeat(64)), null);const receipt = setupDispatch(job, first.worker);assert.ok(receipt);
  assert.equal(setupSettle(job, first.worker, 'uncertain', 'delivery_unconfirmed'), true);
  query('update private.early_access_account_setup_deliveries set next_attempt_at=clock_timestamp();');
  const second = setupClaim();assert.deepEqual(second.jobs[0].envelope, payload.envelope);assert.equal(second.jobs[0].idempotencyKey, payload.idempotencyKey);
  assert.deepEqual(setupDispatch(job, second.worker), receipt);assert.equal(query('select to_jsonb(count(*)) from private.transactional_email_reservations;')[0], 1);
  assert.equal(setupSettle(job, first.worker, 'accepted', null, randomUUID()), false);
  assert.equal(setupSettle(job, second.worker, 'accepted', null, randomUUID()), true);
  assert.deepEqual(query('select jsonb_build_array(status,envelope) from private.early_access_account_setup_deliveries;')[0], ['delivered', null]);
});
test('app mail waits for native confirmation after setup is durable; setup alone grants no access', () => {
  const { value, job } = preparedSetup();assert.deepEqual(claim().jobs, []);assert.equal(query('select to_jsonb(count(*)) from private.early_access_grants;')[0], 0);
  query(`update auth.users set email_confirmed_at=clock_timestamp() where id='${job.reservedUserId}';
    insert into auth.sessions values('${memberSid}','${job.reservedUserId}',null,'aal1',null);`);
  assert.deepEqual(setupClaim().jobs, []);const app = claim();assert.equal(app.jobs.length, 1);assert.ok(dispatch(value, app.worker));
  const result = query(asMember(accept(value, { id: job.reservedUserId }), { id: job.reservedUserId }))[0];assert.equal(result.status, 'accepted');
  assert.equal(query('select to_jsonb(user_id) from private.early_access_grants;')[0], job.reservedUserId);
});
test('pre-acceptance revoke retires bootstrap provenance and encrypted setup mail', () => {
  const { job } = preparedSetup();const { worker } = setupClaim();assert.equal(query(asActor(write(null, { action: 'revoke', revision: 1 })))[0].ok, true);
  assert.equal(setupDispatch(job, worker), null);assert.equal(setupSettle(job, worker, 'accepted', null, randomUUID()), false);
  assert.deepEqual(query('select to_jsonb(status) from private.early_access_account_bootstraps;select jsonb_build_array(status,envelope) from private.early_access_account_setup_deliveries;'), ['cancelled', ['cancelled', null]]);
});
test('superseded generation cannot finish an already-started native operation', () => {
  const value = newAccount();const { worker, jobs: [job] } = bootstrapClaim();bootstrapStart(job, worker);
  assert.equal(query(asActor(write(material(), { action: 'resend', revision: 1 })))[0].ok, true);
  query(`insert into auth.users(id,email,email_confirmed_at) values('${job.reservedUserId}','${email}',null);`);
  assert.equal(persistSetup(job, worker, setupMaterial(job)), false);
  assert.equal(query(`select to_jsonb(account_id) from private.early_access_invitations where id='${value.binding.generationId}';`)[0], null);
  assert.deepEqual(bootstrapClaim().jobs, [], 'new generation cannot adopt the old orphaned unconfirmed mailbox');
});
test('admin resend exposes recovery-required instead of regenerating uncertain native mail', () => {
  preparedSetup();assert.deepEqual(query(asActor(write(material(), { action: 'resend', revision: 1 })))[0], { ok: false, errorCode: 'account_recovery_required' });
  assert.equal(query('select to_jsonb(count(*)) from private.early_access_account_setup_deliveries;')[0], 1);
});
test('expired native recovery mail stops for review and is never regenerated', () => {
  const { job } = preparedSetup();const { worker } = setupClaim();assert.ok(setupDispatch(job, worker));
  query("update private.early_access_account_setup_deliveries set expires_at=clock_timestamp()-interval '1 second';");
  assert.equal(setupSettle(job, worker, 'uncertain', 'delivery_unconfirmed'), true);assert.deepEqual(setupClaim().jobs, []);assert.deepEqual(bootstrapClaim().jobs, []);
  assert.equal(query('select to_jsonb(status) from private.early_access_account_setup_deliveries;')[0], 'needs_review');
});
test('setup free quota is shared with app/feedback mail and blocks dispatch', () => {
  const { job } = preparedSetup();const { worker } = setupClaim();query('insert into private.transactional_email_reservations(delivery_id) select gen_random_uuid() from generate_series(1,90);');
  assert.equal(setupDispatch(job, worker), null);assert.equal(query('select to_jsonb(first_dispatched_at is null) from private.early_access_account_setup_deliveries;')[0], true);
});
test('setup dispatch rechecks current account, canonical mailbox and program before spending quota', () => {
  const { job } = preparedSetup();const { worker } = setupClaim();
  query(`update auth.users set email='changed@example.invalid' where id='${job.reservedUserId}';`);assert.equal(setupDispatch(job, worker), null);
  query(`update auth.users set email='${email}',email_confirmed_at=clock_timestamp() where id='${job.reservedUserId}';`);assert.equal(setupDispatch(job, worker), null);
  query(`update auth.users set email_confirmed_at=null where id='${job.reservedUserId}';update private.early_access_programs set configured=false;`);assert.equal(setupDispatch(job, worker), null);
  assert.equal(query('select to_jsonb(count(*)) from private.transactional_email_reservations;')[0], 0);
});
test('setup native expiry crossed during quota wait rolls back the new reservation', async () => {
  const { job } = preparedSetup();const { worker } = setupClaim();query("update private.early_access_account_setup_deliveries set expires_at=clock_timestamp()+interval '400 milliseconds';");
  const hold = parallel("set application_name='setup-native-quota-hold';begin;select pg_advisory_xact_lock(hashtextextended('transactional-email-free-quota',1803));select pg_sleep(0.7);commit;");
  await barrier("exists(select 1 from pg_stat_activity where application_name='setup-native-quota-hold' and wait_event='PgSleep')");
  const sent = await parallel(asService(setupDispatchSql(job, worker)));assert.equal((await hold).code, 0);assert.equal(sent.code, 0, sent.error);assert.equal(JSON.parse(sent.output), null);
  assert.deepEqual(query('select to_jsonb(count(*)) from private.transactional_email_reservations;select to_jsonb(first_dispatched_at is null) from private.early_access_account_setup_deliveries;'), [0, true]);
});
test('setup provider receipt after native expiry is truthful but cannot confirm Auth or grant access', () => {
  const { job } = preparedSetup();const { worker } = setupClaim();assert.ok(setupDispatch(job, worker));
  query("update private.early_access_account_setup_deliveries set expires_at=clock_timestamp()-interval '1 second';");
  assert.equal(setupSettle(job, worker, 'accepted', null, randomUUID()), true);assert.deepEqual(claim().jobs, []);
  assert.equal(query('select to_jsonb(count(*)) from private.early_access_grants;')[0], 0);
});
test('real Vault and disabled Cron verify exact worker authority, parameterized schedules and safe readback', async () => {
  const schedule = await import('./configure-production-early-access-workers.mjs');
  const condition = schedule.EARLY_ACCESS_WORKER_EXTENSION_QUERY.match(/if not coalesce\(([\s\S]+?),false\) then/)?.[1];assert.ok(condition);
  assert.equal(query(`select to_jsonb(${condition});`)[0], true, 'all exact source/ACL/RLS preflight predicates match real catalogs');
  query('create schema if not exists extensions;create schema if not exists vault;create extension supabase_vault with schema vault;');
  query(schedule.EARLY_ACCESS_WORKER_EXTENSION_QUERY);
  assert.equal(query("select to_jsonb(current_setting('cron.launch_active_jobs')); ")[0], 'off');
  const args = ["https://mimolwojppbtsbvtqwpo.supabase.co", 'f'.repeat(43), 'i'.repeat(43)].map(literal).join(',');
  const configured = `prepare fixture_schedule(text,text,text) as select row_to_json(result) from (${schedule.CONFIGURE_EARLY_ACCESS_WORKERS_QUERY.replace(/;\s*$/, '')}) result;execute fixture_schedule(${args});`;
  const verified = `prepare fixture_verify(text,text,text) as select row_to_json(result) from (${schedule.VERIFY_EARLY_ACCESS_WORKERS_QUERY.replace(/;\s*$/, '')}) result;execute fixture_verify(${args});`;
  assert.deepEqual(query(configured), [{ configured: true }]);assert.equal(schedule.parseEarlyAccessWorkerVerification(query(verified)), true);
  const identities = query("select jsonb_build_object('secretIds',(select jsonb_agg(id order by name) from vault.secrets),'jobIds',(select jsonb_agg(jobid order by jobname) from cron.job));")[0];
  assert.deepEqual(query(configured), [{ configured: true }]);assert.equal(schedule.parseEarlyAccessWorkerVerification(query(verified)), true);
  assert.deepEqual(query("select jsonb_build_object('secretIds',(select jsonb_agg(id order by name) from vault.secrets),'jobIds',(select jsonb_agg(jobid order by jobname) from cron.job));")[0], identities);
  assert.deepEqual(query('select to_jsonb(count(*)) from net.http_request_queue;select to_jsonb(count(*)) from private.transactional_email_reservations;'), [0, 0]);
  query('grant select on private.early_access_account_setup_deliveries to authenticated;');
  assert.equal(query(`select to_jsonb(${condition});`)[0], false, 'unsafe queue privilege cannot pass Cron preflight');
  query('revoke select on private.early_access_account_setup_deliveries from authenticated;');
  query("create or replace function private.reserve_transactional_email(target_delivery_id uuid) returns boolean language plpgsql security definer set search_path='' as $$begin return false;end;$$;");
  assert.equal(query(`select to_jsonb(${condition});`)[0], false, 'a changed quota body cannot pass the reviewed fingerprint');
});
