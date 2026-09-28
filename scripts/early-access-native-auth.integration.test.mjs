import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { createClient } from '@supabase/supabase-js';
import { bootstrapNewEarlyAccessAccount } from '../supabase/functions/_shared/early_access_auth_bootstrap.ts';
import { createEarlyAccessInvitation, openEarlyAccessInvitation } from '../supabase/functions/_shared/early_access_invitation.ts';
import { createEarlyAccessRecoveryMail, openEarlyAccessRecoveryMail, EARLY_ACCESS_AUTH_REDIRECT } from '../supabase/functions/_shared/early_access_recovery_mail.ts';
import { createPasswordRecoveryController } from '../src/static/account-recovery-session.mjs';
import { createPasswordRecoveryOwnerBridge } from '../src/static/password-recovery-owner.mjs';
import { authSessionIdentity } from '../src/static/mfa-auth.mjs';
import { createInvitationAcceptanceClient } from '../src/static/early-access-invitation-client.mjs';
import { createInvitationAcceptanceIntent } from '../src/static/early-access-invitation-contract.mjs';
import { createInvitationRpcTransport } from '../src/static/member-authority-transport.mjs';
import { assertOwnedNativeResource, createNativeFixtureFetch, fixtureName, nativeCurlConfig, nativeCurlResponse, NATIVE_FIXTURE_AUTH_ORIGIN, NATIVE_FIXTURE_IMAGES } from './early-access-native-fixture.mjs';

// Only new fixture-owned resources are ever changed. No shared local Supabase
// project, Docker volume, hosted identity, SMTP server or mail provider is used.
const fixture = fixtureName(randomUUID());
const secret = randomBytes(48).toString('base64url');
const resources = new Map(); const imageIds = new Map(); const clients = [];
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
const origin = 'https://77dominion.com';
let authUrl; let restUrl; let request; let service; let anonKey; let serviceKey;
function docker(args, input) {
  return spawnSync('docker', args, { input, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
}
function successful(result, operation) {
  assert.equal(result.status, 0, `Native fixture ${operation} failed (provider output withheld).`);
  return result.stdout.trim();
}
function inspect(kind) {
  const id = resources.get(kind); assert.match(id || '', /^[a-f0-9]{64}$/);
  return JSON.parse(successful(docker(kind === 'network' ? ['network', 'inspect', id] : ['inspect', id]), 'inspect'))[0];
}
function query(sql) {
  const id = resources.get('postgres'); assertOwnedNativeResource(inspect('postgres'), { id, fixture, kind: 'postgres', imageId: imageIds.get('postgres') });
  const result = docker(['exec', '-i', id, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', '/tmp', '-U', 'postgres', '-d', 'postgres'], sql);
  const diagnostic = result.stderr?.match(/^ERROR:.*$/m)?.[0]?.replace(/'[^']*'/g, '[value]').replace(/[A-Za-z0-9+/_=-]{40,}/g, '[redacted]');
  assert.equal(result.status, 0, `Native fixture SQL failed: ${diagnostic || 'provider output withheld'}`);
  return result.stdout.trim()
    .split('\n').filter(Boolean).map(value => JSON.parse(value));
}
async function internalFetch(input, options = {}) {
  options.signal?.throwIfAborted();
  const id = resources.get('postgres'); assertOwnedNativeResource(inspect('postgres'), { id, fixture, kind: 'postgres', imageId: imageIds.get('postgres') });
  const result = spawnSync('docker', ['exec', '-i', id, 'curl', '-q', '--config', '-'], {
    input: nativeCurlConfig(input, options), encoding: 'utf8', timeout: 12000, maxBuffer: 1064960,
  });
  options.signal?.throwIfAborted();
  successful(result, 'bounded internal HTTP');
  return nativeCurlResponse(result.stdout);
}
function token(role) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const parts = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ role, iss: 'supabase', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 7200 })}`;
  return `${parts}.${createHmac('sha256', secret).update(parts).digest('base64url')}`;
}
function launch(kind, env = {}, extra = []) {
  const args = ['run', '--detach', '--pull', 'never', '--name', `${fixture}-${kind}`, '--label', `77dc.fixture=${fixture}`, '--label', `77dc.kind=${kind}`,
    '--network', `${fixture}-network`, '--network-alias', kind, '--security-opt', 'no-new-privileges', '--cpus', '1', '--memory', kind === 'postgres' ? '512m' : '256m',
    ...Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]), ...extra];
  if (kind !== 'postgres') args.push(imageIds.get(kind));
  const id = successful(docker(args), `start ${kind}`); assert.match(id, /^[a-f0-9]{64}$/); resources.set(kind, id);
  assertOwnedNativeResource(inspect(kind), { id, fixture, kind, imageId: imageIds.get(kind) });
}
async function ready(check, label) {
  let lastError;
  for (let n = 0; n < 100; n++) { try { if (await check()) return; } catch (error) { lastError = error; } await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Native fixture ${label} did not become ready.`, { cause: lastError });
}
function client(key = anonKey) {
  const value = createClient(NATIVE_FIXTURE_AUTH_ORIGIN, key, { auth: { storageKey: `native-${randomUUID()}`, autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }, global: { fetch: request } });
  clients.push(value); return value;
}
async function consumeMailedRecovery(actionLink) {
  const response = await request(actionLink);
  assert.equal(response.status, 303, 'The native mailed link must redirect without being followed.');
  const location = new URL(response.headers.get('location'));
  assert.ok(`${location.origin}${location.pathname}${location.search}` === EARLY_ACCESS_AUTH_REDIRECT, 'The callback must match the exact pinned reset URL.');
  const fragment = new URLSearchParams(location.hash.slice(1));
  assert.equal(fragment.get('type'), 'recovery'); assert.ok(fragment.get('access_token')); assert.ok(fragment.get('refresh_token'));
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'); const priorDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location, addEventListener() {}, removeEventListener() {} } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { visibilityState: 'visible' } });
  try {
    const member = createClient(NATIVE_FIXTURE_AUTH_ORIGIN, anonKey, { auth: { storageKey: `native-${randomUUID()}`, autoRefreshToken: false, persistSession: false, detectSessionInUrl: true }, global: { fetch: request } });
    clients.push(member);
    const bridge = createPasswordRecoveryOwnerBridge({ auth: member.auth, sessionIdentity: authSessionIdentity });
    let recoveryEvents = 0; member.auth.onAuthStateChange(event => { if (event === 'PASSWORD_RECOVERY') recoveryEvents++; });
    assert.equal(Boolean((await member.auth.initialize()).error), false, 'The installed SDK must consume the actual callback.');
    await ready(() => recoveryEvents === 1, 'native PASSWORD_RECOVERY callback');
    assert.equal(location.hash, '', 'The installed SDK must clear the native credentials fragment.');
    return { member, bridge, verified: data(await member.auth.getSession(), 'callback session').session };
  } finally {
    if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow); else delete globalThis.window;
    if (priorDocument) Object.defineProperty(globalThis, 'document', priorDocument); else delete globalThis.document;
  }
}
function data(result, label) {
  const code = /^[a-z0-9_]+$/.test(result?.error?.code || '') ? result.error.code : 'unavailable';
  let diagnostic = '';
  if (result?.error?.status >= 500) {
    const logs = docker(['logs', '--tail', '10', resources.get('auth')]);
    diagnostic = `${logs.stdout}${logs.stderr}`.split('\n').flatMap(line => { try { const entry = JSON.parse(line); return [entry.error || entry.msg || '']; } catch { return []; } }).join(' ')
      .replaceAll(secret, '[redacted]').replace(/https?:\/\/\S+/g, '[url]').replace(/'[^']*'/g, '[value]').replace(/\S+@\S+/g, '[email]').replace(/[A-Za-z0-9+/_=.-]{40,}/g, '[redacted]').slice(-2000);
  }
  assert.equal(Boolean(result?.error), false, `${label} returned native error ${code} (HTTP ${Number(result?.error?.status) || 0}). ${diagnostic}`); return result.data;
}
async function rpc(name, args, bearer = serviceKey) {
  const response = await request(`${NATIVE_FIXTURE_AUTH_ORIGIN}/rest/v1/rpc/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, apikey: anonKey, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
  const value = await response.json();
  const diagnostic = [value?.code, value?.message].filter(part => typeof part === 'string' && /^[a-z0-9_ .:-]{1,200}$/i.test(part)).join(': ');
  assert.equal(response.ok, true, `${name} failed with HTTP ${response.status}: ${diagnostic}`); return value;
}
function totp(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '';
  for (const char of value.toUpperCase().replace(/=+$/, '')) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const key = Buffer.from((bits.match(/.{8}/g) || []).map(byte => parseInt(byte, 2)));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac('sha1', key).update(counter).digest(); const offset = digest.at(-1) & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}
async function adminBearer() {
  const email = `admin-${randomUUID()}@example.invalid`; const password = randomBytes(24).toString('base64url');
  const user = data(await service.auth.admin.createUser({ email, password, email_confirm: true }), 'create fixture admin').user;
  const actor = client(); data(await actor.auth.signInWithPassword({ email, password }), 'admin sign-in');
  const factor = data(await actor.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Disposable fixture' }), 'MFA enroll');
  data(await actor.auth.mfa.challengeAndVerify({ factorId: factor.id, code: totp(factor.totp.secret) }), 'MFA verify');
  query(`select private.bootstrap_site_admin('${user.id}','${randomUUID()}','production');`);
  data(await actor.auth.signOut(), 'admin sign-out');
  data(await actor.auth.signInWithPassword({ email, password }), 'fresh admin sign-in');
  data(await actor.auth.mfa.challengeAndVerify({ factorId: factor.id, code: totp(factor.totp.secret) }), 'fresh MFA verify');
  const bearer = data(await actor.auth.getSession(), 'admin session').session.access_token;
  const claims = JSON.parse(Buffer.from(bearer.split('.')[1], 'base64url'));
  assert.equal(claims.role, 'authenticated'); assert.equal(claims.sub, user.id); assert.equal(claims.aal, 'aal2');
  assert.equal(query(`select to_jsonb(count(*)) from auth.sessions where id='${claims.session_id}' and user_id='${user.id}' and (not_after is null or not_after>now());`)[0], 1, 'Native admin SID must remain live.');
  assert.equal(query(`set role fixture_migration;select to_jsonb(count(*)) from auth.sessions where id='${claims.session_id}';reset role;`)[0], 1, 'Migration definer must have managed-Auth row visibility.');
  assert.equal(query(`begin;do $$begin perform set_config('request.jwt.claims',${literal(JSON.stringify(claims))},true);end$$;select to_jsonb(auth.uid()='${user.id}'::uuid);rollback;`)[0], true, 'Native auth.uid must read PostgREST claims.');
  return { id: user.id, token: bearer };
}

before(async () => {
  for (const [kind, image] of Object.entries(NATIVE_FIXTURE_IMAGES)) {
    const id = successful(docker(['image', 'inspect', image, '--format', '{{.Id}}']), `cached ${kind} image check`);
    assert.match(id, /^sha256:[a-f0-9]{64}$/); imageIds.set(kind, id);
  }
  const network = successful(docker(['network', 'create', '--internal', '--label', `77dc.fixture=${fixture}`, '--label', '77dc.kind=network', `${fixture}-network`]), 'network create');
  assert.match(network, /^[a-f0-9]{64}$/); resources.set('network', network);
  assertOwnedNativeResource(inspect('network'), { id: network, fixture, kind: 'network' });
  launch('postgres', {}, ['--user', 'postgres', '--tmpfs', '/tmp:rw,size=384m', '--entrypoint', '/bin/sh', imageIds.get('postgres'), '-c',
    'initdb -D /tmp/native-invitation-pg -A trust >/dev/null && exec postgres -D /tmp/native-invitation-pg -k /tmp -h 0.0.0.0']);
  await ready(() => docker(['exec', resources.get('postgres'), 'pg_isready', '-h', '/tmp', '-U', 'postgres']).status === 0, 'PostgreSQL');
  query(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
    create role authenticator login noinherit;grant anon,authenticated,service_role to authenticator;
    create role supabase_auth_admin login noinherit;create schema auth authorization supabase_auth_admin;
    alter role supabase_auth_admin set search_path=auth,public;
    grant all on schema public to supabase_auth_admin;grant create on database postgres to supabase_auth_admin;
    create role fixture_migration nologin nosuperuser nobypassrls;grant create on database postgres to fixture_migration;`);
  assertOwnedNativeResource(inspect('postgres'), { id: resources.get('postgres'), fixture, kind: 'postgres', imageId: imageIds.get('postgres') });
  // Docker cp cannot address a tmpfs mount; stream this fixed, secret-free asset
  // into the already ownership-checked container without a host mount or volume.
  const hbaArchive = spawnSync('tar', ['-cf', '-', '-C', new URL('./fixtures/native-invitation/', import.meta.url).pathname, 'pg_hba.conf']);
  assert.equal(hbaArchive.status, 0);
  const hbaCopy = docker(['exec', '-i', resources.get('postgres'), 'tar', '-xf', '-', '-C', '/tmp/native-invitation-pg'], hbaArchive.stdout);
  assert.equal(hbaCopy.status, 0, `Fixture-only HBA copy failed: ${hbaCopy.stderr}`);
  assert.equal(query('select to_jsonb(pg_reload_conf());')[0], true);
  launch('auth', {
    GOTRUE_API_HOST: '0.0.0.0', PORT: '9999', API_EXTERNAL_URL: NATIVE_FIXTURE_AUTH_ORIGIN,
    GOTRUE_DB_DRIVER: 'postgres', GOTRUE_DB_DATABASE_URL: 'postgres://supabase_auth_admin@postgres:5432/postgres?sslmode=disable',
    GOTRUE_DB_NAMESPACE: 'auth', GOTRUE_SITE_URL: origin, GOTRUE_URI_ALLOW_LIST: EARLY_ACCESS_AUTH_REDIRECT,
    GOTRUE_JWT_SECRET: secret, GOTRUE_JWT_EXP: '3600', GOTRUE_JWT_AUD: 'authenticated', GOTRUE_JWT_ADMIN_ROLES: 'service_role', GOTRUE_JWT_DEFAULT_GROUP_NAME: 'authenticated',
    GOTRUE_DISABLE_SIGNUP: 'true', GOTRUE_EXTERNAL_EMAIL_ENABLED: 'true', GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED: 'false',
    GOTRUE_MAILER_AUTOCONFIRM: 'false', GOTRUE_SECURITY_ALLOW_UNVERIFIED_EMAIL_SIGN_INS: 'false', GOTRUE_MAILER_OTP_EXP: '3600',
    GOTRUE_MAILER_URLPATHS_RECOVERY: '/auth/v1/verify', GOTRUE_MFA_TOTP_ENROLL_ENABLED: 'true', GOTRUE_MFA_TOTP_VERIFY_ENABLED: 'true',
    GOTRUE_DB_MAX_POOL_SIZE: '5', GOTRUE_LOG_LEVEL: 'error',
  });
  await ready(() => {
    const state = inspect('auth');
    if (state.State?.Status === 'exited') {
      const logs = docker(['logs', resources.get('auth')]);
      throw new Error(`Native Auth startup failed: ${`${logs.stdout}${logs.stderr}`.replaceAll(secret, '[redacted]').slice(-4000)}`);
    }
    return state.State?.Status === 'running';
  }, 'GoTrue process');
  authUrl = 'http://auth:9999';
  await ready(async () => (await internalFetch(`${authUrl}/health`)).ok, 'GoTrue');
  const readMigration = name => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
  const reads = await readMigration('20260913065057_site_admin_read_apis.sql');
  const files = ['20260913023402_early_access_request_intake.sql', '20260913062841_site_admin_foundation.sql',
    '20260913082358_early_access_admin_review.sql', '20260922000204_early_access_member_authority.sql',
    '20260922000815_early_access_feedback_outbox.sql', '20260927225600_early_access_invitation_lifecycle.sql', '20260927233055_early_access_account_bootstrap.sql'];
  const migrations = await Promise.all(files.map(readMigration)); migrations.splice(2, 0, reads.slice(0, reads.indexOf('create index site_admin_profiles_name_prefix_idx')));
  const baseline = await readMigration('20260707170000_baseline.sql');
  const predicate = baseline.match(/create or replace function public\.has_active_entitlement\([\s\S]*?\n\$\$;/)?.[0]; assert.ok(predicate);
  query(`grant usage on schema auth,public to anon,authenticated,service_role,fixture_migration;grant create on schema public to fixture_migration;
    grant select,insert,update,delete,truncate,references,trigger on auth.users,auth.sessions,auth.mfa_factors,auth.mfa_amr_claims to fixture_migration;
    -- Real GoTrue enables RLS on its managed tables. Model the production
    -- migration owner's Auth visibility without giving this fixture's owner
    -- superuser/BYPASSRLS authority over private application data.
    create policy fixture_migration_read on auth.users for select to fixture_migration using(true);
    create policy fixture_migration_read on auth.sessions for select to fixture_migration using(true);
    create policy fixture_migration_read on auth.mfa_factors for select to fixture_migration using(true);
    create policy fixture_migration_read on auth.mfa_amr_claims for select to fixture_migration using(true);
    set role fixture_migration;create schema private;grant usage on schema private to service_role;
    create table public.entitlements(user_id uuid references auth.users on delete cascade,entitlement_key text,status text,source_type text,source_id text,starts_at timestamptz,ends_at timestamptz);
    alter table public.entitlements enable row level security;revoke all on public.entitlements from public,anon,authenticated,service_role;
    begin;${predicate}${migrations.join('\n')}commit;reset role;`);
  launch('rest', { PGRST_DB_URI: 'postgres://authenticator@postgres:5432/postgres?sslmode=disable', PGRST_DB_SCHEMAS: 'public', PGRST_DB_ANON_ROLE: 'anon', PGRST_JWT_SECRET: secret,
    PGRST_SERVER_PORT: '3000', PGRST_DB_POOL: '5', PGRST_LOG_LEVEL: 'error' });
  restUrl = 'http://rest:3000';
  await ready(async () => (await internalFetch(`${restUrl}/`)).ok, 'PostgREST');
  request = createNativeFixtureFetch({ authUrl, restUrl, fetcher: internalFetch }); anonKey = token('anon'); serviceKey = token('service_role'); service = client(serviceKey);
}, { timeout: 60000 });

after(async () => {
  for (const value of clients) { value.auth.stopAutoRefresh(); await value.removeAllChannels(); }
  for (const kind of ['rest', 'auth', 'postgres', 'network']) {
    const id = resources.get(kind); if (!id) continue;
    assertOwnedNativeResource(inspect(kind), { id, fixture, kind, imageId: imageIds.get(kind) });
    successful(docker(kind === 'network' ? ['network', 'rm', id] : ['rm', '--force', id]), `remove owned ${kind}`);
  }
});

test('closed native Auth bootstraps a reserved account, confirms mailbox, resets only its owner, then grants via real PostgREST', { timeout: 60000 }, async () => {
  const settings = await (await internalFetch(`${authUrl}/settings`)).json();
  assert.equal(settings.disable_signup, true); assert.equal(settings.mailer_autoconfirm ?? settings.autoconfirm, false);
  const signup = await client().auth.signUp({ email: `blocked-${randomUUID()}@example.invalid`, password: randomBytes(24).toString('base64url') });
  assert.ok(signup.error, 'Public signup must be refused by real GoTrue.');
  const admin = await adminBearer(); const recipient = `new-${randomUUID()}@example.invalid`; const requestId = randomUUID();
  query(`insert into private.early_access_requests(id,name,email) values('${requestId}','Disposable Native Member',${literal(recipient)});`);
  const issuedAt = new Date(); const binding = { requestId, generationId: randomUUID(), deliveryId: randomUUID(), recipient,
    issuedAt: issuedAt.toISOString(), expiresAt: new Date(+issuedAt + 7 * 86400000).toISOString(), from: 'Dominion <noreply@mail.77dominion.com>' };
  const key = { keyVersion: 1, key: new Uint8Array(randomBytes(32)) }; const sealed = await createEarlyAccessInvitation(binding, key);
  const approval = await rpc('site_admin_write_early_access_invitation', { target_expected_actor_id: admin.id, target_action: 'approve', target_request_id: requestId,
    target_expected_revision: '0', target_operation_id: randomUUID(), target_correlation_id: randomUUID(), target_binding: binding,
    target_token_digest: sealed.tokenDigest, target_content_fingerprint: sealed.contentFingerprint, target_idempotency_key: sealed.idempotencyKey, target_envelope: sealed.envelope }, admin.token);
  assert.equal(approval.status, 'approved');
  const worker = randomUUID(); const [job] = await rpc('claim_early_access_account_bootstraps', { target_worker_token: worker, target_batch_size: 1 }); assert.ok(job);
  assert.equal(await rpc('start_early_access_account_bootstrap', { target_generation_id: job.generationId, target_worker_token: worker }), true);
  const mail = await bootstrapNewEarlyAccessAccount({ reservedUserId: job.reservedUserId, canonicalEmail: recipient, redirectTo: EARLY_ACCESS_AUTH_REDIRECT,
    allowedRedirects: [EARLY_ACCESS_AUTH_REDIRECT], authOrigin: NATIVE_FIXTURE_AUTH_ORIGIN, nowMs: Date.now() }, {
    createUser: args => service.auth.admin.createUser(args), getUserById: id => service.auth.admin.getUserById(id), generateLink: args => service.auth.admin.generateLink(args),
  });
  assert.equal(mail.userId, job.reservedUserId);
  const unconfirmed = data(await service.auth.admin.getUserById(job.reservedUserId), 'read reserved user').user;
  assert.equal(Boolean(unconfirmed.email_confirmed_at), false); assert.equal(Boolean(unconfirmed.last_sign_in_at), false);
  assert.equal(query(`select to_jsonb(encrypted_password<>'') from auth.users where id='${job.reservedUserId}';`)[0], true);
  const setupIssued = new Date(); const setupBinding = { requestId, generationId: job.generationId, deliveryId: job.deliveryId, reservedUserId: job.reservedUserId, recipient,
    issuedAt: setupIssued.toISOString(), expiresAt: new Date(+setupIssued + 3500000).toISOString(), from: binding.from };
  const setup = await createEarlyAccessRecoveryMail(setupBinding, mail.recoveryActionLink, key);
  assert.equal(await rpc('persist_early_access_account_setup', { target_generation_id: job.generationId, target_worker_token: worker, target_binding: setupBinding,
    target_envelope: setup.envelope, target_content_fingerprint: setup.contentFingerprint, target_idempotency_key: setup.idempotencyKey }), true);
  const setupWorker = randomUUID(); const [setupJob] = await rpc('claim_early_access_account_setup_deliveries', { target_worker_token: setupWorker }); assert.ok(setupJob);
  const setupContent = await openEarlyAccessRecoveryMail(setup.envelope, setupBinding, key, { contentFingerprint: setup.contentFingerprint, idempotencyKey: setup.idempotencyKey });
  assert.ok(setupContent.message.text.includes(mail.recoveryActionLink));
  assert.ok(await rpc('mark_early_access_account_setup_dispatched', { target_delivery_id: job.deliveryId, target_worker_token: setupWorker, target_content_fingerprint: setup.contentFingerprint }));
  assert.equal(await rpc('settle_early_access_account_setup_delivery', { target_delivery_id: job.deliveryId, target_worker_token: setupWorker, target_outcome: 'accepted', target_receipt_id: randomUUID() }), true);
  assert.deepEqual(await rpc('claim_early_access_invitation_deliveries', { target_worker_token: randomUUID() }), []);
  const nativeLink = new URL(mail.recoveryActionLink);
  const { member, bridge, verified } = await consumeMailedRecovery(mail.recoveryActionLink);
  assert.equal(verified.user.id, job.reservedUserId); assert.ok(verified.user.email_confirmed_at);
  const oldSessionId = JSON.parse(Buffer.from(verified.access_token.split('.')[1], 'base64url')).session_id;
  assert.equal(query(`select to_jsonb(count(*)) from auth.sessions where id='${oldSessionId}' and user_id='${job.reservedUserId}';`)[0], 1);
  const recovery = createPasswordRecoveryController({ auth: { onAuthStateChange: listener => bridge.connect(listener), getSession: () => member.auth.getSession(), getUser: jwt => member.auth.getUser(jwt), mfa: { getAuthenticatorAssuranceLevel: jwt => member.auth.mfa.getAuthenticatorAssuranceLevel(jwt) } },
    sessionIdentity: authSessionIdentity, supabaseUrl: NATIVE_FIXTURE_AUTH_ORIGIN, apiKey: anonKey, request });
  const state = await recovery.verify(); const password = randomBytes(24).toString('base64url');
  const completed = await recovery.complete(state.owner, password); assert.equal(completed.completed, true); assert.equal(completed.sessionsRevoked, 'global');
  assert.equal(query(`select to_jsonb(count(*)) from auth.sessions where id='${oldSessionId}';`)[0], 0);
  assert.ok((await client().auth.verifyOtp({ token_hash: nativeLink.searchParams.get('token'), type: 'recovery' })).error, 'Native recovery must be single-use.');
  const signedIn = data(await member.auth.signInWithPassword({ email: recipient, password }), 'new password sign-in'); assert.equal(signedIn.user.id, job.reservedUserId);
  recovery.destroy(); bridge.destroy();
  const deliveryWorker = randomUUID(); const [delivery] = await rpc('claim_early_access_invitation_deliveries', { target_worker_token: deliveryWorker }); assert.ok(delivery);
  const content = await openEarlyAccessInvitation(sealed.envelope, binding, key, { tokenDigest: sealed.tokenDigest, contentFingerprint: sealed.contentFingerprint, idempotencyKey: sealed.idempotencyKey });
  const appLink = content.message.text.match(/https:\/\/77dominion\.com\/early-access-invite\.html#[^\s]+/)?.[0]; assert.ok(appLink);
  const appToken = new URLSearchParams(new URL(appLink).hash.slice(1)).get('token'); assert.ok(appToken);
  assert.ok(await rpc('mark_early_access_invitation_dispatched', { target_delivery_id: binding.deliveryId, target_worker_token: deliveryWorker, target_content_fingerprint: sealed.contentFingerprint, target_token_digest: sealed.tokenDigest }));
  assert.equal(await rpc('settle_early_access_invitation_delivery', { target_delivery_id: binding.deliveryId, target_worker_token: deliveryWorker, target_outcome: 'accepted', target_receipt_id: randomUUID() }), true);
  const transport = createInvitationRpcTransport({ baseUrl: NATIVE_FIXTURE_AUTH_ORIGIN, apiKey: anonKey, error: () => new Error('Native acceptance transport failed.'),
    fetcher: (url, options) => request(url, { ...options, headers: { ...options.headers, Origin: origin } }) });
  const acceptance = createInvitationAcceptanceClient({ getSession: async () => data(await member.auth.getSession(), 'member session').session,
    getUser: async jwt => data(await member.auth.getUser(jwt), 'member verification').user, sessionIdentity: authSessionIdentity,
    subscribe: listener => { const { data: { subscription } } = member.auth.onAuthStateChange((event, session) => listener({ event, sessionIdentity: authSessionIdentity(session) })); return () => subscription.unsubscribe(); }, request: transport });
  const reviewed = await acceptance.review(); assert.equal(reviewed.context.appAccess, false);
  const intent = createInvitationAcceptanceIntent({ generationId: binding.generationId, token: appToken });
  assert.equal((await acceptance.accept(reviewed.owner, intent)).status, 'accepted');
  assert.equal((await acceptance.accept(reviewed.owner, intent)).status, 'accepted', 'Exact retry retrieves only the same decision.');
  const replay = await acceptance.accept(reviewed.owner, createInvitationAcceptanceIntent({ generationId: binding.generationId, token: appToken }));
  assert.equal(replay.ok, false); assert.equal(replay.errorCode, 'invitation_unavailable');
  assert.deepEqual(query(`select to_jsonb(count(*)) from private.early_access_grants where user_id='${job.reservedUserId}';select to_jsonb(count(*)) from private.early_access_price_qualifications where user_id='${job.reservedUserId}';`), [1, 1]);
  assert.equal((await acceptance.review()).context.appAccess, true); acceptance.destroy();
});

test('an existing unconfirmed mailbox with a precreated password is never adopted or sent recovery', async () => {
  const email = `foreign-${randomUUID()}@example.invalid`; const originalId = randomUUID(); const reservedUserId = randomUUID();
  const password = randomBytes(24).toString('base64url');
  data(await service.auth.admin.createUser({ id: originalId, email, password, email_confirm: false }), 'create collision fixture');
  assert.ok((await client().auth.signInWithPassword({ email, password })).error, 'Unconfirmed password sign-in must be rejected.');
  const before = query(`select to_jsonb(u) from auth.users u where id='${originalId}';`)[0]; let generated = 0;
  await assert.rejects(bootstrapNewEarlyAccessAccount({ reservedUserId, canonicalEmail: email, redirectTo: EARLY_ACCESS_AUTH_REDIRECT,
    allowedRedirects: [EARLY_ACCESS_AUTH_REDIRECT], authOrigin: NATIVE_FIXTURE_AUTH_ORIGIN, nowMs: Date.now() }, {
    createUser: args => service.auth.admin.createUser(args), getUserById: id => service.auth.admin.getUserById(id),
    generateLink: args => { generated++; return service.auth.admin.generateLink(args); },
  }));
  assert.equal(generated, 0); const after = query(`select to_jsonb(u) from auth.users u where id='${originalId}';`)[0];
  assert.ok(JSON.stringify(before) === JSON.stringify(after), 'Foreign native account must remain byte-for-byte unchanged.');
  assert.equal(query(`select to_jsonb(count(*)) from auth.users where id='${reservedUserId}';`)[0], 0);
});

test('native MFA recovery upgrades the same session without adopting its rotated token into the SDK', { timeout: 60000 }, async () => {
  const email = `mfa-recovery-${randomUUID()}@example.invalid`;
  const initialPassword = randomBytes(24).toString('base64url');
  const newPassword = randomBytes(24).toString('base64url');
  const user = data(await service.auth.admin.createUser({ email, password: initialPassword, email_confirm: true }), 'create MFA recovery fixture').user;
  const enrollment = client();
  data(await enrollment.auth.signInWithPassword({ email, password: initialPassword }), 'fixture enrollment sign-in');
  const factor = data(await enrollment.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Recovery fixture authenticator' }), 'fixture recovery factor');
  data(await enrollment.auth.mfa.challengeAndVerify({ factorId: factor.id, code: totp(factor.totp.secret) }), 'fixture initial MFA');
  data(await enrollment.auth.signOut(), 'fixture enrollment sign-out');
  const link = data(await service.auth.admin.generateLink({ type: 'recovery', email, options: { redirectTo: EARLY_ACCESS_AUTH_REDIRECT } }), 'fixture recovery link');
  const { member, bridge, verified: anchor } = await consumeMailedRecovery(link.properties.action_link);
  try {
    const claims = tokenValue => JSON.parse(Buffer.from(tokenValue.split('.')[1], 'base64url'));
    const before = claims(anchor.access_token);
    assert.equal(before.sub, user.id); assert.equal(before.aal, 'aal1');
    const send = async (path, bearer, body, method = 'POST') => {
      const response = await request(`${NATIVE_FIXTURE_AUTH_ORIGIN}/auth/v1/${path}`, { method,
        headers: { apikey: anonKey, Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), credentials: 'omit', cache: 'no-store', redirect: 'error' });
      assert.equal(response.ok, true, `Fixture native ${method} returned HTTP ${response.status} (body withheld).`);
      return response.status === 204 ? null : response.json();
    };
    const challenge = await send(`factors/${factor.id}/challenge`, anchor.access_token, { factorId: factor.id });
    assert.equal(challenge.type, 'totp');
    assert.match(challenge.id, /^[a-f0-9-]{36}$/); assert.ok(challenge.expires_at > Date.now() / 1000);
    const elevated = await send(`factors/${factor.id}/verify`, anchor.access_token, { challenge_id: challenge.id, code: totp(factor.totp.secret) });
    assert.ok(typeof elevated.access_token === 'string');
    const after = claims(elevated.access_token);
    assert.equal(after.sub, before.sub); assert.equal(after.session_id, before.session_id); assert.equal(after.aal, 'aal2');
    assert.equal(data(await member.auth.getUser(elevated.access_token), 'derived owner verification').user.id, user.id);
    assert.equal(data(await member.auth.mfa.getAuthenticatorAssuranceLevel(elevated.access_token), 'derived native assurance').currentLevel, 'aal2');
    const unchanged = data(await member.auth.getSession(), 'unchanged recovery SDK session').session;
    assert.ok(unchanged.access_token === anchor.access_token && unchanged.refresh_token === anchor.refresh_token,
      'The native verification must not overwrite the recovery SDK session.');
    assert.equal(query(`select to_jsonb(count(*)) from auth.sessions where id='${before.session_id}' and user_id='${user.id}' and aal='aal2';`)[0], 1);
    assert.equal((await send('user', elevated.access_token, { password: newPassword }, 'PUT')).id, user.id);
    await send('logout?scope=global', elevated.access_token, undefined);
    assert.equal(query(`select to_jsonb(count(*)) from auth.sessions where id='${before.session_id}';`)[0], 0);
    const fresh = client();
    assert.equal(data(await fresh.auth.signInWithPassword({ email, password: newPassword }), 'new MFA recovery password sign-in').user.id, user.id);
    assert.equal(data(await fresh.auth.mfa.getAuthenticatorAssuranceLevel(), 'fresh MFA recovery sign-in assurance').nextLevel, 'aal2');
    data(await fresh.auth.mfa.challengeAndVerify({ factorId: factor.id, code: totp(factor.totp.secret) }), 'fresh existing authenticator verification');
    assert.equal(data(await fresh.auth.mfa.getAuthenticatorAssuranceLevel(), 'fresh elevated sign-in assurance').currentLevel, 'aal2');
    assert.ok((await client().auth.verifyOtp({ type: 'recovery', token_hash: new URL(link.properties.action_link).searchParams.get('token') })).error,
      'The original native recovery link cannot be replayed after password completion.');
  } finally { bridge.destroy(); }
});

test('recovery controller uses real native MFA, retries only a rejected code, and changes only the captured password', { timeout: 60000 }, async () => {
  const email = `controller-mfa-${randomUUID()}@example.invalid`;
  const password = randomBytes(24).toString('base64url');
  const newPassword = randomBytes(24).toString('base64url');
  const user = data(await service.auth.admin.createUser({ email, password, email_confirm: true }), 'create controller MFA fixture').user;
  const enrollment = client();
  data(await enrollment.auth.signInWithPassword({ email, password }), 'controller fixture enrollment sign-in');
  const factor = data(await enrollment.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Existing authenticator' }), 'controller fixture factor');
  data(await enrollment.auth.mfa.challengeAndVerify({ factorId: factor.id, code: totp(factor.totp.secret) }), 'controller initial MFA');
  data(await enrollment.auth.signOut(), 'controller fixture enrollment sign-out');
  const link = data(await service.auth.admin.generateLink({ type: 'recovery', email, options: { redirectTo: EARLY_ACCESS_AUTH_REDIRECT } }), 'controller fixture recovery link');
  const { member, bridge, verified: anchor } = await consumeMailedRecovery(link.properties.action_link);
  const events = [];
  const controller = createPasswordRecoveryController({
    auth: { onAuthStateChange: listener => bridge.connect(listener),
      getSession: () => member.auth.getSession(), getUser: jwt => member.auth.getUser(jwt),
      mfa: { getAuthenticatorAssuranceLevel: jwt => member.auth.mfa.getAuthenticatorAssuranceLevel(jwt) } },
    sessionIdentity: authSessionIdentity, supabaseUrl: NATIVE_FIXTURE_AUTH_ORIGIN, apiKey: anonKey,
    request: async (url, options) => {
      const result = await request(url, options);
      events.push({ path: new URL(url).pathname, method: options.method, status: result.status,
        anchor: options.headers.Authorization === `Bearer ${anchor.access_token}` });
      return result;
    },
  });
  try {
    const state = await controller.verify();
    assert.equal(state.phase, 'mfa-required');
    assert.deepEqual(state.factors, [{ id: factor.id, friendlyName: 'Existing authenticator' }]);
    await controller.challengeMfa(state.owner, factor.id);
    const correct = totp(factor.totp.secret);
    await controller.verifyMfa(state.owner, correct === '000000' ? '000001' : '000000');
    assert.equal(controller.getState().phase, 'mfa-required');
    assert.equal(controller.getState().code, 'RECOVERY_MFA_REJECTED');
    assert.equal(events.filter(event => event.path.endsWith('/verify') && event.status === 422).length, 1);
    await controller.challengeMfa(state.owner, factor.id);
    await controller.verifyMfa(state.owner, totp(factor.totp.secret));
    assert.equal(controller.getState().phase, 'ready');
    const unchanged = data(await member.auth.getSession(), 'controller unchanged SDK anchor').session;
    assert.ok(unchanged.access_token === anchor.access_token && unchanged.refresh_token === anchor.refresh_token,
      'Controller verification must leave SDK credentials unchanged.');
    const result = await controller.complete(state.owner, newPassword);
    assert.equal(result.completed, true); assert.equal(result.sessionsRevoked, 'global');
    assert.equal(events.filter(event => event.path.endsWith('/challenge')).length, 2);
    assert.equal(events.filter(event => event.path.endsWith('/verify')).length, 2);
    assert.ok(events.filter(event => event.path.includes('/factors/')).every(event => event.anchor));
    assert.equal(events.filter(event => event.method === 'PUT' && !event.anchor).length, 1);
    assert.ok(events.filter(event => event.path.endsWith('/logout')).every(event => !event.anchor));
    const sid = JSON.parse(Buffer.from(anchor.access_token.split('.')[1], 'base64url')).session_id;
    assert.equal(query(`select to_jsonb(count(*)) from auth.sessions where id='${sid}';`)[0], 0);
    const fresh = client();
    assert.equal(data(await fresh.auth.signInWithPassword({ email, password: newPassword }), 'controller new password sign-in').user.id, user.id);
    data(await fresh.auth.mfa.challengeAndVerify({ factorId: factor.id, code: totp(factor.totp.secret) }), 'controller existing factor sign-in');
    assert.equal(data(await fresh.auth.mfa.getAuthenticatorAssuranceLevel(), 'controller sign-in assurance').currentLevel, 'aal2');
    assert.ok((await client().auth.verifyOtp({ type: 'recovery', token_hash: new URL(link.properties.action_link).searchParams.get('token') })).error);
  } finally { controller.destroy(); bridge.destroy(); }
});
