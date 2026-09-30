import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ORIGINAL77_PROJECT_REF, ORIGINAL77_CATALOG_QUERY, ORIGINAL77_CATALOG_FIELDS, ORIGINAL77_CATALOG_TIMEOUT_MS,
  ORIGINAL77_CATALOG_MAX_BYTES, parseOriginal77CatalogResult, verifyProductionOriginal77 } from './verify-production-original77.mjs';

const token = 'SYNTHETIC_PRIVATE_ACCESS_TOKEN';
const failure = { message: 'Production original77 completion catalog verification failed.' };
const passing = () => Object.fromEntries(ORIGINAL77_CATALOG_FIELDS.map(key => [key, true]));
const response = (value = [passing()], options = {}) => new Response(JSON.stringify(value), {
  status: 201, headers: { 'content-type': 'application/json' }, ...options,
});
const invoke = (fetchImplementation, options = {}) => verifyProductionOriginal77({
  projectRef: ORIGINAL77_PROJECT_REF, accessToken: token, fetchImplementation, ...options,
});

test('one fixed read-only endpoint receives only static SQL and the existing credential', async () => {
  let calls = 0; let signal;
  const result = await invoke(async (url, options) => {
    calls++; signal = options.signal;
    assert.equal(url, 'https://api.supabase.com/v1/projects/mimolwojppbtsbvtqwpo/database/query/read-only');
    assert.equal(options.method, 'POST');
    assert.deepEqual(options.headers, { Authorization: 'Bearer ' + token, Accept: 'application/json', 'Content-Type': 'application/json' });
    assert.deepEqual(JSON.parse(options.body), { query: ORIGINAL77_CATALOG_QUERY, parameters: [] });
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store');
    assert(options.signal instanceof AbortSignal); assert.equal(options.signal.aborted, false);
    return response();
  }, { query: 'FORBIDDEN CALLER SQL', parameters: [token], endpoint: 'https://fixture.invalid/forbidden' });
  assert.equal(calls, 1); assert.deepEqual(result, passing()); assert(Object.isFrozen(result));
  assert(signal.aborted); assert(!JSON.stringify(result).includes(token));
});

test('wrong project, malformed credential and unbounded timeout fail before any request', async () => {
  for (const options of [
    ...[null, '', 123, 'aaaaaaaaaaaaaaaaaaaa', ORIGINAL77_PROJECT_REF + '/'].map(projectRef => ({ projectRef })),
    ...[null, '', 123, {}, 'x'.repeat(4097), token + '\n', token + '\r', token + ' ', token + '\t', token + '\0', token + '\x7f', token + '雪'].map(accessToken => ({ accessToken })),
    ...[0, -1, 15001, Infinity, NaN, 1.5, '15000', null].map(requestTimeoutMs => ({ requestTimeoutMs })),
    { fetchImplementation: null },
  ]) await assert.rejects(invoke(() => assert.fail('No request allowed'), options), failure);
  for (const accessToken of ['x', 'x'.repeat(4096)]) {
    assert.deepEqual(await invoke(async () => response(), { accessToken }), passing());
  }
  assert.equal(ORIGINAL77_CATALOG_TIMEOUT_MS, 15000); assert.equal(ORIGINAL77_CATALOG_MAX_BYTES, 4096);
});

test('the exact eight-field boolean result rejects every false, missing, typed and extra value', () => {
  assert.deepEqual(ORIGINAL77_CATALOG_FIELDS, [
    'exact_migration_history_ok', 'read_only_pinned_server_ok', 'original77_function_contracts_ok',
    'original77_trigger_contracts_ok', 'original77_check_in_constraints_ok', 'original77_completion_ledger_ok',
    'original77_finisher_catalog_ok', 'original77_share_contracts_ok',
  ]);
  assert(Object.isFrozen(ORIGINAL77_CATALOG_FIELDS));
  assert.deepEqual(parseOriginal77CatalogResult([passing()]), passing());
  assert.deepEqual(parseOriginal77CatalogResult([Object.assign(Object.create(null), passing())]), passing());
  for (const value of [undefined, null, {}, [], [passing(), passing()], [null], [['true']], [true],
    [{ ...passing(), extra: token }], [Object.assign(Object.create({ unexpected: true }), passing())]]) {
    assert.throws(() => parseOriginal77CatalogResult(value), failure);
  }
  for (const key of ORIGINAL77_CATALOG_FIELDS) {
    for (const value of [false, null, undefined, 1, 'true', {}, []]) {
      assert.throws(() => parseOriginal77CatalogResult([{ ...passing(), [key]: value }]), failure);
    }
    const missing = passing(); delete missing[key]; assert.throws(() => parseOriginal77CatalogResult([missing]), failure);
    const getter = passing(); Object.defineProperty(getter, key, { get() { assert.fail('Getter must not run'); } });
    assert.throws(() => parseOriginal77CatalogResult([getter]), failure);
  }
  const symbol = passing(); symbol[Symbol('private')] = true;
  assert.throws(() => parseOriginal77CatalogResult([symbol]), failure);
});

test('transport errors, redirects, non-201 status, bad content type and JSON are redacted without retry', async () => {
  for (const implementation of [
    async () => { throw new Error(token); },
    ...[200, 202, 204, 301, 401, 403, 429, 500].map(status => async () => new Response(status === 204 ? null : token,
      { status, headers: { 'content-type': 'application/json' } })),
    async () => ({ status: 201, redirected: true, body: new ReadableStream() }),
    ...['text/html', 'application/jsonp', ''].map(type => async () => response([passing()], { headers: { 'content-type': type } })),
    async () => new Response(token, { status: 201, headers: { 'content-type': 'application/json' } }),
    async () => new Response(new Uint8Array([255]), { status: 201, headers: { 'content-type': 'application/json' } }),
    async () => new Response(null, { status: 201, headers: { 'content-type': 'application/json' } }),
    async () => response([{ ...passing(), original77_function_contracts_ok: false }]),
    async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(token)); } }),
      { status: 201, headers: { 'content-type': 'application/json' } }),
  ]) {
    let calls = 0;
    await assert.rejects(invoke((...args) => { calls++; return implementation(...args); }), failure);
    assert.equal(calls, 1);
  }
  assert.deepEqual(await invoke(async () => response([passing()], { headers: { 'content-type': 'application/json; charset=utf-8' } })), passing());
});

test('streaming permits exactly4KiB and counts cumulative bytes without trusting Content-Length', async () => {
  const body = JSON.stringify([passing()]).padEnd(ORIGINAL77_CATALOG_MAX_BYTES, ' ');
  assert.equal(Buffer.byteLength(body), ORIGINAL77_CATALOG_MAX_BYTES);
  const stream = (text, onCancel = () => {}) => new ReadableStream({
    start(controller) {
      const bytes = new TextEncoder().encode(text);
      for (let index = 0; index < bytes.length; index += 137) controller.enqueue(bytes.slice(index, index + 137));
      controller.close();
    }, cancel: onCancel,
  });
  assert.deepEqual(await invoke(async () => new Response(stream(body), { status: 201,
    headers: { 'content-type': 'application/json', 'content-length': '1' } })), passing());
  await assert.rejects(invoke(async () => new Response(stream(body + ' '), { status: 201,
    headers: { 'content-type': 'application/json', 'content-length': '1' } })), failure);
  let cancelled = false;
  await assert.rejects(invoke(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(ORIGINAL77_CATALOG_MAX_BYTES + 1)); },
    cancel() { cancelled = true; },
  }), { status: 201, headers: { 'content-type': 'application/json' } })), failure);
  assert(cancelled);
});

test('stalled response headers, body and cancellation cannot exceed the request deadline', async () => {
  let signal;
  await assert.rejects(invoke(async (_url, options) => { signal = options.signal; return new Promise(() => {}); }, { requestTimeoutMs: 10 }), failure);
  assert(signal.aborted);
  let bodySignal;
  await assert.rejects(invoke(async (_url, options) => {
    bodySignal = options.signal;
    return new Response(new ReadableStream({
      pull() { return new Promise(() => {}); }, cancel() { return new Promise(() => {}); },
    }), { status: 201, headers: { 'content-type': 'application/json' } });
  }, { requestTimeoutMs: 10 }), failure);
  assert(bodySignal.aborted);
});

test('standalone verifier rejects every CLI argument and missing configuration without network access', () => {
  const file = fileURLToPath(new URL('./verify-production-original77.mjs', import.meta.url));
  for (const args of [[], ['--query', 'FORBIDDEN CALLER SQL'], ['--project-ref', ORIGINAL77_PROJECT_REF], ['--help']]) {
    const result = spawnSync(process.execPath, [file, ...args], { env: {}, encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
    assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr, failure.message + '\n');
  }
});

test('request, parsing and cleanup guards remain identical to the reviewed inbox transport', async () => {
  const inbox = await readFile(new URL('./verify-production-account-request-inbox.mjs', import.meta.url), 'utf8');
  const original = await readFile(new URL('./verify-production-original77.mjs', import.meta.url), 'utf8');
  const normalized = original.replaceAll('ORIGINAL77_', 'INBOX_')
    .replaceAll('./verify-production-original77.sql', './verify-production-account-request-inbox.sql')
    .replaceAll('parseOriginal77CatalogResult', 'parseInboxCatalogResult')
    .replaceAll('verifyProductionOriginal77', 'verifyProductionAccountRequestInbox')
    .replaceAll('Production original77 completion catalog verification failed.', 'Production account-request inbox catalog verification failed.');
  const withoutFields = source => source.replace(/export const INBOX_CATALOG_FIELDS = Object\.freeze\(\[[\s\S]*?\]\);/, 'FIXED_BOOLEAN_FIELDS');
  assert.equal(withoutFields(normalized), withoutFields(inbox));
});

test('query is source-fixed single SELECT with canonical deparsing, exact70 history and no account/RPC reads', async () => {
  const files = (await readdir(new URL('../supabase/migrations/', import.meta.url))).filter(name => name.endsWith('.sql')).sort();
  const versions = files.map(name => name.split('_')[0]);
  assert.equal(versions.length, 70); assert.equal(new Set(versions).size, 70); assert.equal(versions.at(-1), '20260930161218');
  const hash = createHash('sha256').update(versions.join(',')).digest('hex');
  assert.equal(hash, '09d7293ce15add9360f88a89337ea54822e64f015b1e6ef63eaba1543f36c872');
  assert(ORIGINAL77_CATALOG_QUERY.includes(hash));
  for (const [version, name] of [
    ['20260930152825', 'add_original_77_completion_evidence_foundation'],
    ['20260930160740', 'wire_original_77_live_completion'],
    ['20260930161218', 'share_submitted_progress_v2'],
  ]) assert(ORIGINAL77_CATALOG_QUERY.includes(`('${version}','${name}')`));
  const executable = ORIGINAL77_CATALOG_QUERY.replace(/^--.*$/gm, '');
  assert.equal(executable.split(';').filter(part => part.trim()).length, 1);
  assert.match(executable, /WITH canonical_deparse_context AS MATERIALIZED/);
  assert.match(executable, /CASE WHEN c\.pinned_search_path='pg_catalog'/);
  assert.match(executable, /CROSS JOIN canonical_deparse_context c/);
  assert.match(executable, /pg_catalog\.current_setting\('transaction_read_only'\)='on'/);
  assert.match(executable, /pg_catalog\.current_setting\('server_version_num'\)='170006'/);
  const expectedStart = executable.indexOf('expected_contracts(contract_name,definition_hash) AS (VALUES');
  const expectedEnd = executable.indexOf('), contract_checks AS (', expectedStart);
  assert(expectedStart >= 0 && expectedEnd > expectedStart);
  const contracts = [...executable.slice(expectedStart, expectedEnd).matchAll(/\('([a-z_]+)','([0-9a-f]{64})'\)/g)];
  assert.deepEqual(contracts.map(match => match[1]), ['functions', 'triggers', 'check_ins', 'ledger', 'finisher', 'share']);
  assert(contracts.every(match => !/^0+$/.test(match[2])));
  const sourcePins = [...ORIGINAL77_CATALOG_QUERY.matchAll(/^-- (\d{14}) ([a-f0-9]{64})$/gm)];
  assert.deepEqual(sourcePins.map(match => match[1]), ['20260930152825', '20260930160740', '20260930161218']);
  for (const [, version, expectedHash] of sourcePins) {
    const name = files.find(file => file.startsWith(version + '_'));
    assert(name);
    const source = await readFile(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8');
    assert.equal(createHash('sha256').update(source).digest('hex'), expectedHash,
      'A changed migration requires deliberate fullchain contract derivation: ' + name);
  }
  assert.match(executable, /FROM public\.badge_definitions b WHERE b\.badge_key='original_77_completed'/);
  assert.doesNotMatch(executable, /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|GRANT|REVOKE|COPY|CALL|DO|BEGIN|COMMIT|ROLLBACK)\s+(?:INTO|FROM|TABLE|FUNCTION|ROLE|ON|TO|READ|WORK)\b/i);
  assert.doesNotMatch(executable, /\b(?:FROM|JOIN)\s+(?:auth\.|vault\.|private\.|public\.(?:profiles|check_ins|challenge_entries|user_badges|game_point_events|user_game_stats|public_share_snapshots)\b)/i);
  assert.doesNotMatch(executable, /\b(?:SELECT|PERFORM|CALL|FROM|JOIN)\s+(?:public|private)\.[a-z0-9_]+\s*\(/i);
  for (const key of ORIGINAL77_CATALOG_FIELDS) assert(executable.includes(' AS ' + key));
});

test('full release requires original77 catalog verification after inbox and before canary/Edge/frontend', async () => {
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const backend = workflow.slice(workflow.indexOf('  backend:'), workflow.indexOf('  frontend:'));
  const name = '      - name: Verify source-fixed original77 completion catalog';
  const start = backend.indexOf(name); assert(start >= 0);
  const end = backend.indexOf('\n      - name:', start + name.length); assert(end > start);
  const step = backend.slice(start, end);
  assert.match(step, /timeout-minutes: 1/); assert.match(step, /\/usr\/bin\/env -i/);
  assert.match(step, /SUPABASE_ACCESS_TOKEN="\$SUPABASE_ACCESS_TOKEN"/);
  assert.match(step, /SUPABASE_PROJECT_REF="\$SUPABASE_PROJECT_REF"/);
  assert.match(step, /node scripts\/verify-production-original77.mjs\s*$/);
  assert.doesNotMatch(step, /secrets\.|continue-on-error|if:|supabase secrets|WORKER_SECRET|RESEND|LINEAR/);
  for (const predecessor of ['Apply database migrations', 'Require exact completed migration history', 'Verify source-fixed account-request inbox catalog']) {
    const index = backend.indexOf('      - name: ' + predecessor); assert(index >= 0 && index < start);
  }
  for (const successor of ['Reverify exact canary continuity after migration', 'Synchronize Edge Function secrets']) {
    assert(backend.indexOf('      - name: ' + successor) > start);
  }
  assert.match(backend, /environment: production/); assert.match(backend, /if: inputs.release_scope == 'full'/);
  assert(workflow.includes("needs.backend.result == 'success'"));
  const helper = await readFile(new URL('./verify-production-original77.mjs', import.meta.url), 'utf8');
  assert.deepEqual([...helper.matchAll(/process\.env\.([A-Z_]+)/g)].map(match => match[1]).sort(), ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_PROJECT_REF']);
  assert.match(helper, /process\.argv\.length !== 2/);
  assert.doesNotMatch(helper, /--credential|prepareProduction|SERVICE_ROLE|PUBLIC_SITE_URL|VITE_|console\.error\(error/);
});
