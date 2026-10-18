import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ACTIVATION_REVIEW_PREFLIGHT_PROJECT_REF, ACTIVATION_REVIEW_PREFLIGHT_CATALOG_QUERY, ACTIVATION_REVIEW_PREFLIGHT_CATALOG_FIELDS, ACTIVATION_REVIEW_PREFLIGHT_CATALOG_TIMEOUT_MS,
  ACTIVATION_REVIEW_PREFLIGHT_CATALOG_MAX_BYTES, ACTIVATION_REVIEW_PREFLIGHT_CATALOG_SHA256, assertActivationReviewPreflightReady,
  parseActivationReviewPreflightResult, verifyAdminActivationReviewIndexPreflight } from './verify-admin-activation-review-index-preflight.mjs';

const token = 'SYNTHETIC_PRIVATE_ACCESS_TOKEN';
const failure = { message: 'Admin activation-review index preflight failed.' };
const passing = () => Object.fromEntries(ACTIVATION_REVIEW_PREFLIGHT_CATALOG_FIELDS.map(key => [key, true]));
const response = (value = [passing()], options = {}) => new Response(JSON.stringify(value), {
  status: 201, headers: { 'content-type': 'application/json' }, ...options,
});
const invoke = (fetchImplementation, options = {}) => verifyAdminActivationReviewIndexPreflight({
  projectRef: ACTIVATION_REVIEW_PREFLIGHT_PROJECT_REF, accessToken: token, fetchImplementation, ...options,
});

test('reviewed SQL bytes and the exact ten-field output stay source-pinned before transport', async () => {
  const expectedSha256 = '399ad856fd61c3e6afa0182e62435052a0acb5f53ef3b87c30114b959ad93505';
  const source = await readFile(new URL('./verify-admin-activation-review-index-preflight.sql', import.meta.url), 'utf8');
  assert.equal(ACTIVATION_REVIEW_PREFLIGHT_CATALOG_SHA256, expectedSha256);
  assert.equal(ACTIVATION_REVIEW_PREFLIGHT_CATALOG_QUERY, source);
  assert.equal(createHash('sha256').update(source).digest('hex'), expectedSha256);
  assert.equal(assertActivationReviewPreflightReady(), true);
  assert.equal(ACTIVATION_REVIEW_PREFLIGHT_PROJECT_REF, 'mimolwojppbtsbvtqwpo');
  assert(Object.isFrozen(ACTIVATION_REVIEW_PREFLIGHT_CATALOG_FIELDS));
  assert.deepEqual(ACTIVATION_REVIEW_PREFLIGHT_CATALOG_FIELDS, [
    'exact_pre_migration_history_ok', 'read_only_pinned_server_ok', 'review_table_shape_ok',
    'review_table_privileges_ok', 'review_constraints_ok', 'existing_pkey_ok',
    'review_size_within_bound_ok', 'review_estimate_within_bound_ok', 'new_objects_absent_ok',
    'no_conflicting_review_locks_ok',
  ]);
  const finalSelect = source.slice(source.lastIndexOf('\nSELECT\n'));
  assert.deepEqual([...finalSelect.matchAll(/\bAS ([a-z][a-z0-9_]*_ok)\b/g)].map(match => match[1]),
    ACTIVATION_REVIEW_PREFLIGHT_CATALOG_FIELDS);
  const helper = await readFile(new URL('./verify-admin-activation-review-index-preflight.mjs', import.meta.url), 'utf8');
  const verifier = helper.slice(helper.indexOf('export async function verifyAdminActivationReviewIndexPreflight'));
  const guardOffset = verifier.indexOf('assertActivationReviewPreflightReady();');
  const requestOffset = verifier.indexOf('fetchImplementation(endpoint');
  assert(guardOffset >= 0 && requestOffset > guardOffset, 'Source assertion must run before transport');
});

test('one fixed read-only endpoint receives only static SQL and existing credentials', async () => {
  let calls = 0;
  const result = await invoke(async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.supabase.com/v1/projects/mimolwojppbtsbvtqwpo/database/query/read-only');
    assert.equal(options.method, 'POST');
    assert.deepEqual(options.headers, { Authorization: 'Bearer ' + token, Accept: 'application/json', 'Content-Type': 'application/json' });
    assert.deepEqual(JSON.parse(options.body), { query: ACTIVATION_REVIEW_PREFLIGHT_CATALOG_QUERY, parameters: [] });
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store');
    assert(options.signal instanceof AbortSignal);
    return response();
  }, { query: 'FORBIDDEN CALLER SQL', parameters: [token] });
  assert.equal(calls, 1); assert.deepEqual(result, passing()); assert(Object.isFrozen(result));
  assert(!JSON.stringify(result).includes(token));
});

test('wrong project, malformed credential and unbounded timeout fail before any request', async () => {
  for (const options of [
    { projectRef: 'aaaaaaaaaaaaaaaaaaaa' }, { projectRef: ACTIVATION_REVIEW_PREFLIGHT_PROJECT_REF + '/' },
    ...[null, '', 123, 'x'.repeat(4097), token + '\n', token + ' '].map(accessToken => ({ accessToken })),
    ...[0, -1, 15001, Infinity, '15000'].map(requestTimeoutMs => ({ requestTimeoutMs })),
    { fetchImplementation: null },
  ]) await assert.rejects(invoke(() => assert.fail('No request allowed'), options), failure);
  assert.equal(ACTIVATION_REVIEW_PREFLIGHT_CATALOG_TIMEOUT_MS, 15000); assert.equal(ACTIVATION_REVIEW_PREFLIGHT_CATALOG_MAX_BYTES, 4096);
});

test('exact one-row ten-boolean contract refuses all partial, false and extra output', () => {
  assert.deepEqual(parseActivationReviewPreflightResult([passing()]), passing());
  const nullPrototype = Object.assign(Object.create(null), passing());
  assert.deepEqual(parseActivationReviewPreflightResult([nullPrototype]), passing());
  for (const value of [undefined, null, {}, [], [passing(), passing()], [null], [['true']], [true],
    [Object.assign(Object.create({ private: token }), passing())],
    [{ ...passing(), extra: 'PRIVATE_PAYLOAD' }]]) assert.throws(() => parseActivationReviewPreflightResult(value), failure);
  for (const key of ACTIVATION_REVIEW_PREFLIGHT_CATALOG_FIELDS) {
    for (const value of [false, null, undefined, 1, 'true', {}]) {
      assert.throws(() => parseActivationReviewPreflightResult([{ ...passing(), [key]: value }]), failure);
    }
    const missing = passing(); delete missing[key]; assert.throws(() => parseActivationReviewPreflightResult([missing]), failure);
    const getter = passing(); Object.defineProperty(getter, key, { get() { assert.fail('Getter must not run'); } });
    assert.throws(() => parseActivationReviewPreflightResult([getter]), failure);
  }
  const symbol = passing(); symbol[Symbol('private')] = true;
  assert.throws(() => parseActivationReviewPreflightResult([symbol]), failure);
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
    async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(token)); } }),
      { status: 201, headers: { 'content-type': 'application/json' } }),
    async () => response([{ ...passing(), review_table_shape_ok: false }]),
  ]) await assert.rejects(invoke(fetchImplementation), failure);
});

test('oversized and stalled bodies cannot bypass byte and wall-clock bounds', async () => {
  let cancelled = false;
  await assert.rejects(invoke(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(ACTIVATION_REVIEW_PREFLIGHT_CATALOG_MAX_BYTES + 1)); },
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
  const executable = ACTIVATION_REVIEW_PREFLIGHT_CATALOG_QUERY.replace(/^--.*$/gm, '');
  const statements = executable.replace(/'(?:''|[^'])*'/g, "''");
  assert.equal(executable.split(';').filter(part => part.trim()).length, 1);
  assert.match(executable, /WITH canonical_deparse_context AS MATERIALIZED/);
  assert.match(executable, /pg_catalog.current_setting\('transaction_read_only'\)='on'/);
  assert.match(executable, /pg_catalog.current_setting\('server_version_num'\)='170006'/);
  assert.match(executable, /pg_catalog.set_config\('statement_timeout','15000',true\)/);
  assert.match(executable, /pg_catalog.set_config\('lock_timeout','5000',true\)/);
  assert.doesNotMatch(executable, /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|GRANT|REVOKE|COPY|CALL|DO|BEGIN|COMMIT|ROLLBACK)\s+(?:INTO|FROM|TABLE|FUNCTION|ROLE|ON|TO|READ|WORK)\b/i);
  assert.doesNotMatch(executable, /\b(?:FROM|JOIN)\s+(?:auth\.|vault\.|private\.|public\.|cron\.)/i);
  assert.doesNotMatch(statements, /\b(?:ANALYZE|VACUUM|EXPLAIN|LOCK|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|COPY|CALL|DO|BEGIN|COMMIT|ROLLBACK)\b/i);
  assert.doesNotMatch(statements, /\b(?:auth|vault|private|public|cron|net)\.[a-z_][a-z0-9_]*\s*\(/i);
  for (const key of ACTIVATION_REVIEW_PREFLIGHT_CATALOG_FIELDS) assert(executable.includes(' AS ' + key));
  const helper = await readFile(new URL('./verify-admin-activation-review-index-preflight.mjs', import.meta.url), 'utf8');
  assert.deepEqual([...helper.matchAll(/process\.env\.([A-Z_]+)/g)].map(match => match[1]).sort(),
    ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_PROJECT_REF']);
  assert.doesNotMatch(helper, /--credential|prepareProduction|SERVICE_ROLE|PUBLIC_SITE_URL|VITE_|console\.error\(error/);
});

test('preflight requires the frozen exact75 history and all proposed objects absent', () => {
  const sql = ACTIVATION_REVIEW_PREFLIGHT_CATALOG_QUERY;
  assert.match(sql, /pg_catalog.count\(\*\)=75 AND pg_catalog.count\(DISTINCT version\)=75/);
  assert.match(sql, /pg_catalog.max\(version::text\)='20261013091749'/);
  assert(sql.includes("'4c20c2eb77256efa26cb99050bf851d4c62a6c9deadcc4c92230ded0f0ecff9b'"));
  assert(sql.includes("'9a5547d2f161a38101223139a9e96e213c380844da2a9765af2171f3ad90fb63'"));
  assert.match(sql, /FROM supabase_migrations.schema_migrations\),false\) AS exact_pre_migration_history_ok/);
  assert.match(sql, /pg_catalog.to_regclass\('private.challenge_activation_reviews_unresolved_created_idx'\) IS NULL/);
  assert.match(sql, /NOT EXISTS\(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace\s+WHERE n.nspname IN \('private','public'\) AND p.proname='site_admin_get_activation_review_health'\) AS new_objects_absent_ok/);
});

test('physical bounds remain fixed and unknown row estimates pass only for an empty heap', () => {
  const sql = ACTIVATION_REVIEW_PREFLIGHT_CATALOG_QUERY;
  assert(sql.includes('coalesce((SELECT pg_catalog.pg_relation_size(oid)<=33554432 AND pg_catalog.pg_total_relation_size(oid)<=134217728 FROM registry),false) AS review_size_within_bound_ok'));
  assert(sql.includes('coalesce((SELECT (reltuples>=0 AND reltuples<=100000) OR (reltuples=-1 AND pg_catalog.pg_relation_size(oid)=0) FROM registry),false) AS review_estimate_within_bound_ok'));
  assert.doesNotMatch(sql.replace(/^--.*$/gm, ''), /\b(?:ANALYZE|VACUUM)\b/i);
});

test('every queued source lock fails closed with only three granted lock modes permitted', () => {
  const expected = `NOT EXISTS(SELECT 1 FROM pg_catalog.pg_locks l WHERE l.relation=pg_catalog.to_regclass('private.challenge_activation_migration_reviews')
    AND l.database=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database())
    AND l.pid IS DISTINCT FROM pg_catalog.pg_backend_pid()
    AND (NOT l.granted OR l.mode NOT IN ('AccessShareLock','RowShareLock','ShareLock'))) AS no_conflicting_review_locks_ok`;
  assert(ACTIVATION_REVIEW_PREFLIGHT_CATALOG_QUERY.includes(expected));
  assert.match(ACTIVATION_REVIEW_PREFLIGHT_CATALOG_QUERY, /observations race later writes and are NOT a guarantee/);
  assert.match(ACTIVATION_REVIEW_PREFLIGHT_CATALOG_QUERY, /Repeat immediately before apply; the migration retains its bounded locks/);
});
