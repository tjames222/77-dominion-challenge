import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { INBOX_PROJECT_REF, INBOX_CATALOG_QUERY, INBOX_CATALOG_FIELDS, INBOX_CATALOG_TIMEOUT_MS,
  INBOX_CATALOG_MAX_BYTES, parseInboxCatalogResult, verifyProductionAccountRequestInbox } from './verify-production-account-request-inbox.mjs';

const token = 'SYNTHETIC_PRIVATE_ACCESS_TOKEN';
const failure = { message: 'Production account-request inbox catalog verification failed.' };
const passing = () => Object.fromEntries(INBOX_CATALOG_FIELDS.map(key => [key, true]));
const response = (value = [passing()], options = {}) => new Response(JSON.stringify(value), {
  status: 201, headers: { 'content-type': 'application/json' }, ...options,
});
const invoke = (fetchImplementation, options = {}) => verifyProductionAccountRequestInbox({
  projectRef: INBOX_PROJECT_REF, accessToken: token, fetchImplementation, ...options,
});

test('one fixed read-only endpoint receives only static SQL and existing credentials', async () => {
  let calls = 0;
  const result = await invoke(async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.supabase.com/v1/projects/mimolwojppbtsbvtqwpo/database/query/read-only');
    assert.equal(options.method, 'POST');
    assert.deepEqual(options.headers, { Authorization: 'Bearer ' + token, Accept: 'application/json', 'Content-Type': 'application/json' });
    assert.deepEqual(JSON.parse(options.body), { query: INBOX_CATALOG_QUERY, parameters: [] });
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store');
    assert(options.signal instanceof AbortSignal);
    return response();
  }, { query: 'FORBIDDEN CALLER SQL', parameters: [token] });
  assert.equal(calls, 1); assert.deepEqual(result, passing()); assert(Object.isFrozen(result));
  assert(!JSON.stringify(result).includes(token));
});

test('wrong project, malformed credential and unbounded timeout fail before any request', async () => {
  for (const options of [
    { projectRef: 'aaaaaaaaaaaaaaaaaaaa' }, { projectRef: INBOX_PROJECT_REF + '/' },
    ...[null, '', 123, 'x'.repeat(4097), token + '\n', token + ' '].map(accessToken => ({ accessToken })),
    ...[0, -1, 15001, Infinity, '15000'].map(requestTimeoutMs => ({ requestTimeoutMs })),
    { fetchImplementation: null },
  ]) await assert.rejects(invoke(() => assert.fail('No request allowed'), options), failure);
  assert.equal(INBOX_CATALOG_TIMEOUT_MS, 15000); assert.equal(INBOX_CATALOG_MAX_BYTES, 4096);
});

test('exact one-row eleven-boolean contract refuses all partial, false and extra output', () => {
  assert.deepEqual(parseInboxCatalogResult([passing()]), passing());
  for (const value of [undefined, null, {}, [], [passing(), passing()], [null], [['true']], [true],
    [{ ...passing(), extra: 'PRIVATE_PAYLOAD' }]]) assert.throws(() => parseInboxCatalogResult(value), failure);
  for (const key of INBOX_CATALOG_FIELDS) {
    for (const value of [false, null, undefined, 1, 'true', {}]) {
      assert.throws(() => parseInboxCatalogResult([{ ...passing(), [key]: value }]), failure);
    }
    const missing = passing(); delete missing[key]; assert.throws(() => parseInboxCatalogResult([missing]), failure);
    const getter = passing(); Object.defineProperty(getter, key, { get() { assert.fail('Getter must not run'); } });
    assert.throws(() => parseInboxCatalogResult([getter]), failure);
  }
  const symbol = passing(); symbol[Symbol('private')] = true;
  assert.throws(() => parseInboxCatalogResult([symbol]), failure);
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
    async () => response([{ ...passing(), inbox_rpc_catalog_ok: false }]),
  ]) await assert.rejects(invoke(fetchImplementation), failure);
});

test('oversized and stalled bodies cannot bypass byte and wall-clock bounds', async () => {
  let cancelled = false;
  await assert.rejects(invoke(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(INBOX_CATALOG_MAX_BYTES + 1)); },
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

test('query is source-fixed single SELECT with ordered canonical deparsing and exact70 history', async () => {
  const versions = (await readdir(new URL('../supabase/migrations/', import.meta.url)))
    .filter(name => name.endsWith('.sql')).sort().map(name => name.split('_')[0]);
  assert.equal(versions.length, 70); assert.equal(new Set(versions).size, 70);
  assert.equal(versions.at(-1), '20260930161218');
  const hash = createHash('sha256').update(versions.join(',')).digest('hex');
  assert.equal(hash, '09d7293ce15add9360f88a89337ea54822e64f015b1e6ef63eaba1543f36c872');
  assert(INBOX_CATALOG_QUERY.includes(hash));
  assert.match(INBOX_CATALOG_QUERY, /version='20260929000950' AND name='site_admin_account_requests_inbox'/);
  for (const [version, name] of [
    ['20260930152825', 'add_original_77_completion_evidence_foundation'],
    ['20260930160740', 'wire_original_77_live_completion'],
    ['20260930161218', 'share_submitted_progress_v2'],
  ]) assert(INBOX_CATALOG_QUERY.includes(`('${version}','${name}')`));
  const executable = INBOX_CATALOG_QUERY.replace(/^--.*$/gm, '');
  assert.equal(executable.split(';').filter(part => part.trim()).length, 1);
  assert.match(executable, /WITH canonical_deparse_context AS MATERIALIZED/);
  assert.equal((executable.match(/CROSS JOIN canonical_deparse_context/g) || []).length, 4);
  assert.equal((executable.match(/CASE WHEN canonical_deparse_context.pinned_search_path='pg_catalog'/g) || []).length, 5);
  assert.match(executable, /pg_catalog.current_setting\('transaction_read_only'\)='on'/);
  assert.doesNotMatch(executable, /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|GRANT|REVOKE|COPY|CALL|DO|BEGIN|COMMIT|ROLLBACK)\s+(?:INTO|FROM|TABLE|FUNCTION|ROLE|ON|TO|READ|WORK)\b/i);
  assert.doesNotMatch(executable, /\b(?:FROM|JOIN)\s+(?:auth\.|vault\.|private\.|public\.account_lifecycle_requests\b)/i);
  assert.doesNotMatch(executable, /\b(?:SELECT|PERFORM|CALL)\s+private\.require_site_admin\s*\(/i);
  for (const key of INBOX_CATALOG_FIELDS) assert(executable.includes(' AS ' + key));
});

test('full release blocks after exact history and before remaining Edge/frontend, with no new secret bindings', async () => {
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const step = workflow.slice(workflow.indexOf('      - name: Verify source-fixed account-request inbox catalog'),
    workflow.indexOf('      - name: Reverify exact canary continuity after migration'));
  assert.match(step, /timeout-minutes: 1/); assert.match(step, /\/usr\/bin\/env -i/);
  assert.match(step, /SUPABASE_ACCESS_TOKEN="\$SUPABASE_ACCESS_TOKEN"/);
  assert.match(step, /SUPABASE_PROJECT_REF="\$SUPABASE_PROJECT_REF"/);
  assert.match(step, /node scripts\/verify-production-account-request-inbox.mjs/);
  assert.doesNotMatch(step, /secrets\.|continue-on-error|if:|supabase secrets|WORKER_SECRET|RESEND|LINEAR/);
  assert(workflow.indexOf('      - name: Require exact completed migration history') < workflow.indexOf(step));
  assert(workflow.indexOf(step) < workflow.indexOf('      - name: Synchronize Edge Function secrets'));
  assert(workflow.includes("needs.backend.result == 'success'"));
  const helper = await readFile(new URL('./verify-production-account-request-inbox.mjs', import.meta.url), 'utf8');
  assert.deepEqual([...helper.matchAll(/process\.env\.([A-Z_]+)/g)].map(match => match[1]).sort(), ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_PROJECT_REF']);
  assert.doesNotMatch(helper, /--credential|prepareProduction|SERVICE_ROLE|PUBLIC_SITE_URL|VITE_|console\.error\(error/);
});

test('compatible readers deploy after validated dry-run and before new database payload producers', async () => {
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const backend = workflow.slice(workflow.indexOf('  backend:'), workflow.indexOf('  frontend:'));
  const preview = backend.indexOf('      - name: Verify migration history and preview the migration plan');
  const readers = backend.indexOf('      - name: Deploy compatible public share renderer before migrations');
  const apply = backend.indexOf('      - name: Apply database migrations');
  assert(preview >= 0 && readers > preview && apply > readers);
  const section = backend.slice(readers, apply);
  assert.equal((section.match(/supabase functions deploy /g) || []).length, 2);
  for (const name of ['share-snapshot', 'process-integration-outbox']) {
    assert.equal((backend.match(new RegExp(`supabase functions deploy ${name} `, 'g')) || []).length, 1);
    assert(section.includes(`supabase functions deploy ${name} --project-ref "$SUPABASE_PROJECT_REF" --no-verify-jwt`));
  }
  assert.match(section, /Deploy compatible integration reader before migrations\n        if: steps.function-secrets.outputs.integration_runtime_enabled == 'true'/);
  assert.doesNotMatch(section, /continue-on-error|always\(\)|\$\{\{\s*secrets\.|supabase secrets|configure-|curl|--body|--data/);
  assert(backend.indexOf('      - name: Validate Edge Function secret topology') < readers);
  assert(backend.indexOf('      - name: Require exact authoritative migration history') < readers);
  assert(backend.indexOf('      - name: Verify source-fixed account-request inbox catalog') > apply);
  assert(backend.indexOf('      - name: Synchronize Edge Function secrets') > apply);
  assert.match(backend, /environment: production/);
  assert.match(backend, /if: inputs.release_scope == 'full'/);
  assert.match(backend, /Revoke any remaining backend database login roles\n        if: always\(\)/);
});
