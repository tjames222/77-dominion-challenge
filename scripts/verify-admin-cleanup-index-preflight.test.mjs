import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { CLEANUP_PREFLIGHT_PROJECT_REF, CLEANUP_PREFLIGHT_CATALOG_QUERY, CLEANUP_PREFLIGHT_CATALOG_FIELDS, CLEANUP_PREFLIGHT_CATALOG_TIMEOUT_MS,
  CLEANUP_PREFLIGHT_CATALOG_MAX_BYTES, parseCleanupPreflightResult, verifyAdminCleanupIndexPreflight } from './verify-admin-cleanup-index-preflight.mjs';

const token = 'SYNTHETIC_PRIVATE_ACCESS_TOKEN';
const failure = { message: 'Admin cleanup-index preflight failed.' };
const passing = () => Object.fromEntries(CLEANUP_PREFLIGHT_CATALOG_FIELDS.map(key => [key, true]));
const response = (value = [passing()], options = {}) => new Response(JSON.stringify(value), {
  status: 201, headers: { 'content-type': 'application/json' }, ...options,
});
const invoke = (fetchImplementation, options = {}) => verifyAdminCleanupIndexPreflight({
  projectRef: CLEANUP_PREFLIGHT_PROJECT_REF, accessToken: token, fetchImplementation, ...options,
});

test('one fixed read-only endpoint receives only static SQL and existing credentials', async () => {
  let calls = 0;
  const result = await invoke(async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.supabase.com/v1/projects/mimolwojppbtsbvtqwpo/database/query/read-only');
    assert.equal(options.method, 'POST');
    assert.deepEqual(options.headers, { Authorization: 'Bearer ' + token, Accept: 'application/json', 'Content-Type': 'application/json' });
    assert.deepEqual(JSON.parse(options.body), { query: CLEANUP_PREFLIGHT_CATALOG_QUERY, parameters: [] });
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store');
    assert(options.signal instanceof AbortSignal);
    return response();
  }, { query: 'FORBIDDEN CALLER SQL', parameters: [token] });
  assert.equal(calls, 1); assert.deepEqual(result, passing()); assert(Object.isFrozen(result));
  assert(!JSON.stringify(result).includes(token));
});

test('wrong project, malformed credential and unbounded timeout fail before any request', async () => {
  for (const options of [
    { projectRef: 'aaaaaaaaaaaaaaaaaaaa' }, { projectRef: CLEANUP_PREFLIGHT_PROJECT_REF + '/' },
    ...[null, '', 123, 'x'.repeat(4097), token + '\n', token + ' '].map(accessToken => ({ accessToken })),
    ...[0, -1, 15001, Infinity, '15000'].map(requestTimeoutMs => ({ requestTimeoutMs })),
    { fetchImplementation: null },
  ]) await assert.rejects(invoke(() => assert.fail('No request allowed'), options), failure);
  assert.equal(CLEANUP_PREFLIGHT_CATALOG_TIMEOUT_MS, 15000); assert.equal(CLEANUP_PREFLIGHT_CATALOG_MAX_BYTES, 4096);
});

test('exact one-row eight-boolean contract refuses all partial, false and extra output', () => {
  assert.deepEqual(parseCleanupPreflightResult([passing()]), passing());
  for (const value of [undefined, null, {}, [], [passing(), passing()], [null], [['true']], [true],
    [{ ...passing(), extra: 'PRIVATE_PAYLOAD' }]]) assert.throws(() => parseCleanupPreflightResult(value), failure);
  for (const key of CLEANUP_PREFLIGHT_CATALOG_FIELDS) {
    for (const value of [false, null, undefined, 1, 'true', {}]) {
      assert.throws(() => parseCleanupPreflightResult([{ ...passing(), [key]: value }]), failure);
    }
    const missing = passing(); delete missing[key]; assert.throws(() => parseCleanupPreflightResult([missing]), failure);
    const getter = passing(); Object.defineProperty(getter, key, { get() { assert.fail('Getter must not run'); } });
    assert.throws(() => parseCleanupPreflightResult([getter]), failure);
  }
  const symbol = passing(); symbol[Symbol('private')] = true;
  assert.throws(() => parseCleanupPreflightResult([symbol]), failure);
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
    async () => response([{ ...passing(), registry_shape_ok: false }]),
  ]) await assert.rejects(invoke(fetchImplementation), failure);
});

test('oversized and stalled bodies cannot bypass byte and wall-clock bounds', async () => {
  let cancelled = false;
  await assert.rejects(invoke(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(CLEANUP_PREFLIGHT_CATALOG_MAX_BYTES + 1)); },
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
  const executable = CLEANUP_PREFLIGHT_CATALOG_QUERY.replace(/^--.*$/gm, '');
  assert.equal(executable.split(';').filter(part => part.trim()).length, 1);
  assert.match(executable, /WITH canonical_deparse_context AS MATERIALIZED/);
  assert.match(executable, /pg_catalog.current_setting\('transaction_read_only'\)='on'/);
  assert.doesNotMatch(executable, /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|GRANT|REVOKE|COPY|CALL|DO|BEGIN|COMMIT|ROLLBACK)\s+(?:INTO|FROM|TABLE|FUNCTION|ROLE|ON|TO|READ|WORK)\b/i);
  assert.doesNotMatch(executable, /\b(?:FROM|JOIN)\s+(?:auth\.|vault\.|private\.|public\.|cron\.)/i);
  assert.doesNotMatch(executable, /\b(?:SELECT|PERFORM|CALL)\s+(?:private\.require_site_admin|public\.site_admin_get_cleanup_health|public\.profile_photo_cleanup_monitor_health)\s*\(/i);
  for (const key of CLEANUP_PREFLIGHT_CATALOG_FIELDS) assert(executable.includes(' AS ' + key));
  const helper = await readFile(new URL('./verify-admin-cleanup-index-preflight.mjs', import.meta.url), 'utf8');
  assert.deepEqual([...helper.matchAll(/process\.env\.([A-Z_]+)/g)].map(match => match[1]).sort(),
    ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_PROJECT_REF']);
  assert.doesNotMatch(helper, /--credential|prepareProduction|SERVICE_ROLE|PUBLIC_SITE_URL|VITE_|console\.error\(error/);
});
