import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { PROFILE_NAME_PROJECT_REF, PROFILE_NAME_CATALOG_QUERY, PROFILE_NAME_CATALOG_FIELDS, PROFILE_NAME_CATALOG_TIMEOUT_MS,
  PROFILE_NAME_CATALOG_MAX_BYTES, parseProfileNameCatalogResult, verifyProductionAdminProfileName } from './verify-production-admin-profile-name.mjs';

const token = 'SYNTHETIC_PRIVATE_ACCESS_TOKEN';
const failure = { message: 'Production Admin profile-name catalog verification failed.' };
const passing = () => Object.fromEntries(PROFILE_NAME_CATALOG_FIELDS.map(key => [key, true]));
const response = (value = [passing()], options = {}) => new Response(JSON.stringify(value), {
  status: 201, headers: { 'content-type': 'application/json' }, ...options,
});
const invoke = (fetchImplementation, options = {}) => verifyProductionAdminProfileName({
  projectRef: PROFILE_NAME_PROJECT_REF, accessToken: token, fetchImplementation, ...options,
});

test('one fixed read-only endpoint receives only static SQL and existing credentials', async () => {
  let calls = 0;
  const result = await invoke(async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.supabase.com/v1/projects/mimolwojppbtsbvtqwpo/database/query/read-only');
    assert.equal(options.method, 'POST');
    assert.deepEqual(options.headers, { Authorization: 'Bearer ' + token, Accept: 'application/json', 'Content-Type': 'application/json' });
    assert.deepEqual(JSON.parse(options.body), { query: PROFILE_NAME_CATALOG_QUERY, parameters: [] });
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store');
    assert(options.signal instanceof AbortSignal);
    return response();
  }, { query: 'FORBIDDEN CALLER SQL', parameters: [token] });
  assert.equal(calls, 1); assert.deepEqual(result, passing()); assert(Object.isFrozen(result));
  assert(!JSON.stringify(result).includes(token));
});

test('wrong project, malformed credential and unbounded timeout fail before any request', async () => {
  for (const options of [
    { projectRef: 'aaaaaaaaaaaaaaaaaaaa' }, { projectRef: PROFILE_NAME_PROJECT_REF + '/' },
    ...[null, '', 123, 'x'.repeat(4097), token + '\n', token + ' '].map(accessToken => ({ accessToken })),
    ...[0, -1, 15001, Infinity, '15000'].map(requestTimeoutMs => ({ requestTimeoutMs })),
    { fetchImplementation: null },
  ]) await assert.rejects(invoke(() => assert.fail('No request allowed'), options), failure);
  assert.equal(PROFILE_NAME_CATALOG_TIMEOUT_MS, 15000); assert.equal(PROFILE_NAME_CATALOG_MAX_BYTES, 4096);
});

test('exact one-row thirteen-boolean contract refuses all partial, false and extra output', () => {
  assert.deepEqual(parseProfileNameCatalogResult([passing()]), passing());
  for (const value of [undefined, null, {}, [], [passing(), passing()], [null], [['true']], [true],
    [{ ...passing(), extra: 'PRIVATE_PAYLOAD' }]]) assert.throws(() => parseProfileNameCatalogResult(value), failure);
  for (const key of PROFILE_NAME_CATALOG_FIELDS) {
    for (const value of [false, null, undefined, 1, 'true', {}]) {
      assert.throws(() => parseProfileNameCatalogResult([{ ...passing(), [key]: value }]), failure);
    }
    const missing = passing(); delete missing[key]; assert.throws(() => parseProfileNameCatalogResult([missing]), failure);
    const getter = passing(); Object.defineProperty(getter, key, { get() { assert.fail('Getter must not run'); } });
    assert.throws(() => parseProfileNameCatalogResult([getter]), failure);
  }
  const symbol = passing(); symbol[Symbol('private')] = true;
  assert.throws(() => parseProfileNameCatalogResult([symbol]), failure);
});

test('transport, redirects, status, content type, invalid JSON and response failures are redacted', async () => {
  for (const fetchImplementation of [
    async () => { throw new Error(token); },
    ...[200, 301, 401, 403, 429, 500].map(status => async () => response({ private: token }, { status })),
    async () => ({ status: 201, redirected: true, body: new ReadableStream() }),
    async () => response([passing()], { headers: { 'content-type': 'text/html' } }),
    async () => new Response(token, { status: 201, headers: { 'content-type': 'application/json' } }),
    async () => new Response(new Uint8Array([255]), { status: 201, headers: { 'content-type': 'application/json' } }),
    async () => new Response(null, { status: 201, headers: { 'content-type': 'application/json' } }),
    async () => response([{ ...passing(), functions_catalog_ok: false }]),
  ]) await assert.rejects(invoke(fetchImplementation), failure);
});

test('oversized and stalled bodies cannot bypass byte and wall-clock bounds', async () => {
  let cancelled = false;
  await assert.rejects(invoke(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(PROFILE_NAME_CATALOG_MAX_BYTES + 1)); },
    cancel() { cancelled = true; },
  }), { status: 201, headers: { 'content-type': 'application/json' } })), failure);
  assert(cancelled);
  let signal;
  await assert.rejects(invoke(async (_url, options) => { signal = options.signal; return new Promise(() => {}); }, { requestTimeoutMs: 10 }), failure);
  assert(signal.aborted);
  await assert.rejects(invoke(async () => new Response(new ReadableStream({
    pull() { return new Promise(() => {}); },
    cancel() { return new Promise(() => {}); },
  }), { status: 201, headers: { 'content-type': 'application/json' } }), { requestTimeoutMs: 10 }), failure);
});

test('an exactly4096-byte valid body is accepted without expanding the response cap', async () => {
  const raw = JSON.stringify([passing()]);
  const padded = raw + ' '.repeat(4096 - Buffer.byteLength(raw));
  assert.equal(Buffer.byteLength(padded), 4096);
  assert.deepEqual(await invoke(async () => new Response(padded, {
    status: 201, headers: { 'content-type': 'application/json' },
  })), passing());
});

test('fixed SQL reads catalog metadata only, not application rows or privileged RPCs', async () => {
  const executable = PROFILE_NAME_CATALOG_QUERY.replace(/^--.*$/gm, '');
  assert.equal(executable.split(';').filter(part => part.trim()).length, 1);
  assert.match(executable, /WITH canonical_deparse_context AS MATERIALIZED/);
  assert.match(executable, /pg_catalog.current_setting\('transaction_read_only'\)='on'/);
  assert.doesNotMatch(executable, /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|GRANT|REVOKE|COPY|CALL|DO|BEGIN|COMMIT|ROLLBACK)\s+(?:INTO|FROM|TABLE|FUNCTION|ROLE|ON|TO|READ|WORK)\b/i);
  assert.doesNotMatch(executable, /\b(?:FROM|JOIN)\s+(?:auth\.|vault\.|private\.|public\.|cron\.)/i);
  assert.doesNotMatch(executable, /\b(?:SELECT|PERFORM|CALL)\s+(?:private\.require_site_admin|public\.site_admin_get_profile_name|public\.site_admin_correct_profile_name)\s*\(/i);
  for (const key of PROFILE_NAME_CATALOG_FIELDS) assert(executable.includes(' AS ' + key));
  const helper = await readFile(new URL('./verify-production-admin-profile-name.mjs', import.meta.url), 'utf8');
  assert.deepEqual([...helper.matchAll(/process\.env\.([A-Z_]+)/g)].map(match => match[1]).sort(),
    ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_PROJECT_REF']);
  assert.doesNotMatch(helper, /--credential|prepareProduction|SERVICE_ROLE|PUBLIC_SITE_URL|VITE_|console\.error\(error/);
});

test('exact75 history pins match the immutable migration filenames and names', async () => {
  const names = (await readdir(new URL('../supabase/migrations/', import.meta.url)))
    .filter(name => /^\d{14}_[a-z0-9_]+\.sql$/.test(name) && name.slice(0, 14) <= '20261013091749').sort();
  assert.equal(names.length, 75);
  assert.equal(names.at(-1), '20261013091749_site_admin_profile_name_correction.sql');
  const hash = value => createHash('sha256').update(value).digest('hex');
  for (const text of [names.map(name => name.slice(0, 14)).join(','), names.map(name => name.slice(0, -4)).join(',')]) {
    assert(PROFILE_NAME_CATALOG_QUERY.includes(hash(text)));
  }
});

test('function attestation includes all exact RPCs, private helpers and immutable evidence guard', () => {
  const signatures = [
    'private.require_member_current_session(uuid,uuid)', 'private.require_site_admin(text,uuid,boolean)',
    'private.site_admin_audit_payload(bigint)', 'private.site_admin_immutable()',
    'private.site_admin_mfa_ready(uuid,uuid,boolean)', 'private.site_admin_profile_name_snapshot(uuid,uuid,uuid,boolean)',
    'private.site_admin_profile_name_valid(text)', 'private.site_admin_request_identity(uuid)',
    'private.sync_site_admin_profile_name_version()', 'public.site_admin_correct_profile_name(uuid,uuid,uuid,text,uuid,uuid)',
    'public.site_admin_get_profile_name(uuid,uuid)', 'public.site_admin_list_audit(uuid,integer,uuid,text,text,jsonb)',
  ];
  const functions = PROFILE_NAME_CATALOG_QUERY.slice(PROFILE_NAME_CATALOG_QUERY.indexOf('expected_functions('), PROFILE_NAME_CATALOG_QUERY.indexOf('function_checks AS'));
  for (const signature of signatures) assert(functions.includes("'" + signature + "'"));
  assert.equal([...functions.matchAll(/'[a-f0-9]{64}'/g)].length, 12);
  for (const field of ['p.prosecdef=e.security_definer', 'p.proretset=e.returns_set', 'p.proconfig=e.expected_config',
    "pg_catalog.pg_get_userbyid(p.proowner)='postgres'", 'p.prokind=', 'p.proisstrict', 'p.proleakproof', 'p.proparallel',
    'p.procost=100', 'p.prorows=', 'pg_catalog.has_function_privilege', 'pg_catalog.aclexplode', 'a.grantor']) {
    assert(PROFILE_NAME_CATALOG_QUERY.includes(field), field);
  }
});

test('table and trigger checks pin exact columns, defaults, constraints, indexes and effective denials', () => {
  const sql = PROFILE_NAME_CATALOG_QUERY;
  for (const text of ['private.site_admin_profile_name_versions', 'site_admin_profile_name_versions_user_id_fkey',
    'site_admin_audit_typed_action_check', 'before_profile_name_version', 'after_profile_name_version', 'profile_name_changed',
    'sync_site_admin_profile_name_version', 'site_admin_audit_immutable', 'pg_catalog.pg_get_triggerdef',
    'pg_catalog.pg_get_constraintdef', 'pg_catalog.pg_get_indexdef', 'i.indisvalid', 'i.indisready', 'i.indislive',
    't.tgenabled=', 't.tgfoid=', 'c.convalidated', 'c.condeferrable', 'c.condeferred', 'a.attidentity', 'a.attgenerated',
    'pg_catalog.has_any_column_privilege', 'pg_catalog.has_table_privilege', 'pg_catalog.pg_policy']) {
    assert(sql.includes(text), text);
  }
  assert.equal(PROFILE_NAME_CATALOG_FIELDS.length, 13);
  assert.match(sql, /pg_catalog.count\(\*\)=12 AND pg_catalog.bool_and\(ok\)/);
});
