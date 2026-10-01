import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { REPEATABLE_CHALLENGE_MIGRATION_SHA256 } from './verify-repeatable-challenge-cutover-plan.mjs';
import { assertRepeatableChallengeCatalogReady, parseRepeatableChallengeCatalogResult,
  REPEATABLE_CHALLENGE_CATALOG_FIELDS, REPEATABLE_CHALLENGE_CATALOG_MAX_BYTES,
  REPEATABLE_CHALLENGE_CATALOG_QUERY, REPEATABLE_CHALLENGE_CATALOG_TIMEOUT_MS,
  REPEATABLE_CHALLENGE_PROJECT_REF, verifyProductionRepeatableChallenge,
} from './verify-production-repeatable-challenge.mjs';

const failure = { message: 'Production repeatable challenge catalog verification failed.' };
const passing = () => Object.fromEntries(REPEATABLE_CHALLENGE_CATALOG_FIELDS.map(key => [key, true]));
const token = 'SYNTHETIC_PRIVATE_ACCESS_TOKEN';
const response = (value = [passing()], options = {}) => new Response(JSON.stringify(value), {
  status: 201, headers: { 'content-type': 'application/json' }, ...options,
});
const invoke = (fetchImplementation, options = {}) => verifyProductionRepeatableChallenge({
  projectRef: REPEATABLE_CHALLENGE_PROJECT_REF, accessToken: token, fetchImplementation, ...options,
});

test('catalog result is an exact immutable eleven-boolean boundary', () => {
  assert.deepEqual(REPEATABLE_CHALLENGE_CATALOG_FIELDS, [
    'exact_migration_history_ok',
    'read_only_pinned_server_ok',
    'repeatable_instance_tables_ok',
    'repeatable_association_contracts_ok',
    'repeatable_catalog_tables_ok',
    'repeatable_function_contracts_ok',
    'repeatable_trigger_contracts_ok',
    'repeatable_initializer_binding_ok',
    'repeatable_reward_catalog_ok',
    'repeatable_security_boundaries_ok',
    'repeatable_share_contracts_ok',
  ]);
  assert(Object.isFrozen(REPEATABLE_CHALLENGE_CATALOG_FIELDS));
  assert.deepEqual(parseRepeatableChallengeCatalogResult([passing()]), passing());
  assert.deepEqual(parseRepeatableChallengeCatalogResult([Object.assign(Object.create(null), passing())]), passing());
  assert(Object.isFrozen(parseRepeatableChallengeCatalogResult([passing()])));
  for (const value of [undefined, null, {}, [], [passing(), passing()], [null], [['true']], [true],
    [{ ...passing(), extra: true }], [Object.assign(Object.create({ inherited: true }), passing())]]) {
    assert.throws(() => parseRepeatableChallengeCatalogResult(value), failure);
  }
  for (const key of REPEATABLE_CHALLENGE_CATALOG_FIELDS) {
    for (const value of [false, null, undefined, 1, 'true', {}, []]) {
      assert.throws(() => parseRepeatableChallengeCatalogResult([{ ...passing(), [key]: value }]), failure);
    }
    const missing = passing(); delete missing[key];
    assert.throws(() => parseRepeatableChallengeCatalogResult([missing]), failure);
    const getter = passing();
    Object.defineProperty(getter, key, { get() { assert.fail('Getter must not run'); } });
    assert.throws(() => parseRepeatableChallengeCatalogResult([getter]), failure);
  }
  const symbol = passing(); symbol[Symbol('private')] = true;
  assert.throws(() => parseRepeatableChallengeCatalogResult([symbol]), failure);
});

test('frozen source, history and catalog pins are complete and tied to the executable query', () => {
  assert.equal(REPEATABLE_CHALLENGE_MIGRATION_SHA256,
    '0250b78791964615abcbe8066245df73ed98d78dbdb5a4e418d3bfbc7bec652b');
  assert.match(REPEATABLE_CHALLENGE_CATALOG_QUERY,
    new RegExp(`^-- 20261001001245 ${REPEATABLE_CHALLENGE_MIGRATION_SHA256}$`, 'mu'));
  assert.match(REPEATABLE_CHALLENGE_CATALOG_QUERY,
    /^-- Exact 71-version history SHA-256: e6090c27e44dd678cab1b8178058f780bec2d0b4dcd99dee0d96407d24a5bb26$/mu);
  const pins = [...REPEATABLE_CHALLENGE_CATALOG_QUERY.matchAll(/\('[a-z_]+','([0-9a-f]{64})'\)/gu)];
  assert.equal(pins.length, 8);
  assert(pins.every(match => !/^0+$/u.test(match[1])));
  assert.doesNotThrow(() => assertRepeatableChallengeCatalogReady());
  assert.equal(REPEATABLE_CHALLENGE_CATALOG_TIMEOUT_MS, 15_000);
  assert.equal(REPEATABLE_CHALLENGE_CATALOG_MAX_BYTES, 4_096);
});

test('one fixed read-only endpoint receives only static SQL and the existing credential', async () => {
  let calls = 0; let signal;
  const result = await invoke(async (url, options) => {
    calls++; signal = options.signal;
    assert.equal(url, 'https://api.supabase.com/v1/projects/mimolwojppbtsbvtqwpo/database/query/read-only');
    assert.equal(options.method, 'POST');
    assert.deepEqual(options.headers,
      { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' });
    assert.deepEqual(JSON.parse(options.body), { query: REPEATABLE_CHALLENGE_CATALOG_QUERY, parameters: [] });
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store');
    assert(options.signal instanceof AbortSignal); assert.equal(options.signal.aborted, false);
    return response();
  }, { query: 'FORBIDDEN CALLER SQL', parameters: [token], endpoint: 'https://fixture.invalid/forbidden' });
  assert.equal(calls, 1); assert.deepEqual(result, passing()); assert(Object.isFrozen(result));
  assert(signal.aborted); assert(!JSON.stringify(result).includes(token));
});

test('invalid inputs and untrusted responses fail closed without retry or diagnostics', async () => {
  for (const options of [
    ...[null, '', 123, 'wrong', `${REPEATABLE_CHALLENGE_PROJECT_REF}/`].map(projectRef => ({ projectRef })),
    ...[null, '', 123, {}, 'x'.repeat(4097), `${token}\n`, `${token} `, `${token}\0`, '雪'].map(accessToken => ({ accessToken })),
    ...[0, -1, 15001, Infinity, NaN, 1.5, '15000', null].map(requestTimeoutMs => ({ requestTimeoutMs })),
    { fetchImplementation: null },
  ]) await assert.rejects(invoke(() => assert.fail('No request allowed'), options), failure);
  for (const implementation of [
    async () => { throw new Error(token); },
    ...[200, 202, 204, 301, 401, 403, 429, 500].map(status => async () => new Response(status === 204 ? null : token,
      { status, headers: { 'content-type': 'application/json' } })),
    async () => ({ status: 201, redirected: true, body: new ReadableStream() }),
    async () => new Response(token, { status: 201, headers: { 'content-type': 'text/html' } }),
    async () => response([{ ...passing(), repeatable_security_boundaries_ok: false }]),
    async () => new Response('x'.repeat(REPEATABLE_CHALLENGE_CATALOG_MAX_BYTES + 1),
      { status: 201, headers: { 'content-type': 'application/json' } }),
  ]) {
    let calls = 0;
    await assert.rejects(invoke((...args) => { calls++; return implementation(...args); }), failure);
    assert.equal(calls, 1);
  }
});

test('stalled response headers and bodies cannot exceed the request deadline', async () => {
  let signal;
  await assert.rejects(invoke(async (_url, options) => {
    signal = options.signal; return new Promise(() => {});
  }, { requestTimeoutMs: 10 }), failure);
  assert(signal.aborted);
  let bodySignal;
  await assert.rejects(invoke(async (_url, options) => {
    bodySignal = options.signal;
    return new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { return new Promise(() => {}); } }),
      { status: 201, headers: { 'content-type': 'application/json' } });
  }, { requestTimeoutMs: 10 }), failure);
  assert(bodySignal.aborted);
});

test('standalone verifier rejects arguments and missing configuration without network access', () => {
  const file = fileURLToPath(new URL('./verify-production-repeatable-challenge.mjs', import.meta.url));
  for (const args of [[], ['--help'], ['--query', 'SELECT true'], ['--project-ref', REPEATABLE_CHALLENGE_PROJECT_REF]]) {
    const result = spawnSync(process.execPath, [file, ...args], {
      env: {}, encoding: 'utf8', timeout: 5000, maxBuffer: 4096,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `${failure.message}\n`);
  }
});

test('query is one fixed read-only catalog SELECT with no member-row or application-RPC access', () => {
  const executable = REPEATABLE_CHALLENGE_CATALOG_QUERY.replace(/^--.*$/gmu, '');
  assert.equal(executable.split(';').filter(part => part.trim()).length, 1);
  assert.match(executable, /WITH canonical_deparse_context AS MATERIALIZED/u);
  assert.match(executable, /pg_catalog\.current_setting\('transaction_read_only'\)='on'/u);
  assert.match(executable, /pg_catalog\.current_setting\('server_version_num'\)='170006'/u);
  assert.match(executable, /pg_catalog\.count\(\*\)=71/u);
  assert.match(executable, /pg_catalog\.max\(version::text\)='20261001001245'/u);
  assert.match(executable, /version='20261001001245' AND name='repeatable_challenge_instances_v2'/u);
  for (const table of ['challenge_instances', 'challenge_runtime', 'challenge_instance_completions',
    'challenge_instance_requests', 'reward_grant_preservation', 'check_ins', 'challenge_entries', 'user_challenge_states',
    'reward_definitions', 'reward_catalog_meta', 'challenge_definitions', 'public_share_snapshots', 'public.profiles']) {
    assert(REPEATABLE_CHALLENGE_CATALOG_QUERY.includes(`'${table}'`), `missing fixed table ${table}`);
  }
  const expectedStart = executable.indexOf('expected_contracts(contract_name,definition_hash) AS (VALUES');
  const expectedEnd = executable.indexOf('), contract_checks AS (', expectedStart);
  assert(expectedStart >= 0 && expectedEnd > expectedStart);
  assert.deepEqual([...executable.slice(expectedStart, expectedEnd).matchAll(/\('([a-z_]+)','([^']+)'\)/gu)]
    .map(match => match[1]), ['instance_tables', 'associations', 'catalog_tables', 'functions', 'triggers',
    'catalog', 'security', 'share']);
  for (const functionName of ['bind_original_challenge_instance', 'bind_initial_instance_after_activation',
    'reconcile_user_challenge_unlocks', 'build_share_snapshot_payload', 'get_public_share_snapshot']) {
    assert(executable.includes(`'${functionName}'`), `missing fixed function ${functionName}`);
  }
  assert.match(executable, /t\.tgname='z_bind_initial_instance_after_activation'/u);
  assert.match(executable, /expected_history\(definition_hash\) AS \(VALUES\s*\('e6090c27e44dd678cab1b8178058f780bec2d0b4dcd99dee0d96407d24a5bb26'\)\s*\)/u);
  assert.doesNotMatch(executable, /pg_catalog\.to_jsonb\((?:d|m|b)\)/u);
  const catalogStart = executable.indexOf('), catalog_document AS MATERIALIZED (');
  const catalogEnd = executable.indexOf('), security_document AS MATERIALIZED (', catalogStart);
  assert(catalogStart >= 0 && catalogEnd > catalogStart);
  const stableCatalog = executable.slice(catalogStart, catalogEnd);
  assert.doesNotMatch(stableCatalog, /\b(?:created_at|updated_at)\b/u);
  assert.doesNotMatch(stableCatalog, /'effectiveAt',\s*m\.effective_at/u);
  assert.doesNotMatch(executable,
    /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|GRANT|REVOKE|COPY|CALL|DO|BEGIN|COMMIT|ROLLBACK)\s+(?:INTO|FROM|TABLE|FUNCTION|ROLE|ON|TO|READ|WORK)\b/iu);
  assert.doesNotMatch(executable,
    /\b(?:FROM|JOIN)\s+(?:auth\.|vault\.|private\.|public\.(?:profiles|check_ins|challenge_entries|user_badges|game_point_events|user_game_stats|public_share_snapshots|challenge_state|reward_entitlements)\b)/iu);
  assert.doesNotMatch(executable, /\b(?:SELECT|PERFORM|CALL)\s+(?:public|private)\.[a-z0-9_]+\s*\(/iu);
  for (const safeConfigTable of ['public.reward_definitions', 'public.challenge_definitions',
    'public.reward_catalog_meta', 'public.badge_definitions']) {
    assert(executable.includes(`FROM ${safeConfigTable}`));
  }
  for (const key of REPEATABLE_CHALLENGE_CATALOG_FIELDS) assert(executable.includes(` AS ${key}`));
});

test('wrapper exposes only the fixed project and existing Management credential inputs', async () => {
  const source = await readFile(new URL('./verify-production-repeatable-challenge.mjs', import.meta.url), 'utf8');
  assert.match(source, /https:\/\/api\.supabase\.com\/v1\/projects\/\$\{REPEATABLE_CHALLENGE_PROJECT_REF\}\/database\/query\/read-only/u);
  assert.deepEqual([...source.matchAll(/process\.env\.([A-Z_]+)/gu)].map(match => match[1]).sort(),
    ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_PROJECT_REF']);
  assert.doesNotMatch(source, /SERVICE_ROLE|DATABASE_URL|PASSWORD|PRIVATE_KEY|callerQuery|parameters\s*=/u);
  assert.match(source, /body: JSON\.stringify\(\{ query: REPEATABLE_CHALLENGE_CATALOG_QUERY, parameters: \[\] \}\)/u);
  assert.match(source, /if \(historyComment !== history\) throw fail\(\);/u);
  assert(source.indexOf('assertRepeatableChallengeCatalogReady();')
    < source.indexOf('const controller = new AbortController();'));
});

test('backend verifies exact71 catalog after existing catalogs and before every later payload producer', async () => {
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const backend = workflow.slice(workflow.indexOf('  backend:'), workflow.indexOf('  frontend:'));
  const name = '      - name: Verify source-fixed repeatable challenge catalog';
  const start = backend.indexOf(name); assert(start >= 0);
  const end = backend.indexOf('\n      - name:', start + name.length); assert(end > start);
  const step = backend.slice(start, end);
  assert.match(step, /timeout-minutes: 1/u);
  assert.match(step, /\/usr\/bin\/env -i/u);
  assert.match(step, /SUPABASE_ACCESS_TOKEN="\$SUPABASE_ACCESS_TOKEN"/u);
  assert.match(step, /SUPABASE_PROJECT_REF="\$SUPABASE_PROJECT_REF"/u);
  assert.match(step, /node scripts\/verify-production-repeatable-challenge\.mjs\s*$/u);
  assert.doesNotMatch(step, /secrets\.|continue-on-error|if:|supabase secrets|WORKER_SECRET|RESEND|LINEAR/u);
  for (const predecessor of ['Apply database migrations', 'Require exact completed migration history',
    'Verify source-fixed account-request inbox catalog', 'Verify source-fixed original77 completion catalog']) {
    const index = backend.indexOf(`      - name: ${predecessor}`);
    assert(index >= 0 && index < start, `missing predecessor ${predecessor}`);
  }
  for (const successor of ['Reverify exact canary continuity after migration', 'Synchronize Edge Function secrets',
    'Deploy authenticated Edge Functions']) {
    assert(backend.indexOf(`      - name: ${successor}`) > start, `missing successor ${successor}`);
  }
  assert.match(backend, /environment: production/u);
  assert(workflow.includes("needs.backend.result == 'success'"));
});

test('database CI keeps every historical gate and adds bounded repeatable cutover, catalog, Share and latest-schema proofs', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  for (const [name, file] of [
    ['Verify deterministic repeatable challenge catalog after two exact replays', 'verify-production-repeatable-challenge.sql.test.mjs'],
    ['Verify repeatable challenge instance runtime boundaries', 'repeatable-challenge-runtime.sql.test.mjs'],
    ['Verify repeatable challenge cutover preservation and races', 'repeatable-challenge-cutover.sql.test.mjs'],
    ['Verify repeatable challenge Share V3 privacy', 'repeatable-share.sql.test.mjs'],
    ['Audit every latest-schema pgTAP and non-reset RPC contract', 'latest-schema-pgtap.sql.test.mjs'],
  ]) {
    const start = workflow.indexOf(`      - name: ${name}`); assert(start >= 0, `missing ${name}`);
    const end = workflow.indexOf('\n      - name:', start + name.length);
    const step = workflow.slice(start, end < 0 ? undefined : end);
    assert.match(step, /timeout-minutes: 5/u);
    assert(step.includes(`node --test scripts/${file}`));
    assert.doesNotMatch(step, /continue-on-error|if:|skip|hosted|SUPABASE_ACCESS_TOKEN/u);
  }
  for (const historical of ['pnpm run test:database', 'pnpm run test:rpc', 'pnpm run check:schema',
    'scripts/verify-production-account-request-inbox.sql.test.mjs',
    'scripts/verify-production-original77.sql.test.mjs']) assert(workflow.includes(historical));
});
