import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { POST75_CATALOGS, POST75_CATALOG_PROJECT_REF, POST75_CATALOG_TIMEOUT_MS,
  POST75_CATALOG_MAX_BYTES, assertPost75CatalogsReady, verifyProductionPost75Catalogs } from './verify-production-post75-catalogs.mjs';

const options = { projectRef: POST75_CATALOG_PROJECT_REF, accessToken: 'synthetic-test-token' };
const fixedError = /^Production exact75 catalog verification failed\.$/u;
const hash = value => createHash('sha256').update(value).digest('hex');
const good = contract => Object.fromEntries(contract.fields.map(key => [key, true]));
const response = (value, init = {}) => new Response(JSON.stringify(value), {
  status: 201, headers: { 'content-type': 'application/json; charset=utf-8' }, ...init,
});
const errorIsFixed = error => fixedError.test(error.message);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const definitions = [
  ['account-request-inbox', '3de8c86bbd3d1eb40ddfc37d99ab7e70ce36bb475fbf9d96a90e2bf25182bd12', 'db8bc84fb5f4987e49ae30b72278bd8a35482e133839398f144aa40a28c9e8ca'],
  ['original77', '217fd5b6782d2133ea65bd42679bd93f1398acc6f624a6c3891207794a7968c4', 'bf10a8e92dbc6f041d58d5e39a15caf546d41e5ab0799c13184583360545538e'],
  ['repeatable-challenge', '2a7e8c0f52c31f5b1a1d9798360d988c5da376f6cdb2b56cfd5b85edc6ea8af6', 'e5d9233463fc8cbdfc01984bf22104ae9dd0c8f645d3584186758434faad534d'],
  ['admin-cleanup-health', '17214b193bc968d629dc4c705c2cc793c1d47f789506fd53e64a1544f74057fc', '34331dc0d666f1a2e2de0a21c22b5f0f044f307621d04ea1a0d186e46bc887fb'],
];

test('all historical SQL/runners remain frozen; new exact75 copies preserve every non-history predicate except the reviewed full trigger pin', async () => {
  // The final formatting repair removed exactly one terminal blank line from
  // each reviewed query. Readding that one LF must recover its reviewed bytes;
  // no trim/whitespace normalization or predicate changes are accepted.
  const beforeEofRepair = [
    'a171ad86803b1a556fbb705596d4c7e8ae6e74361fd35bdc2e10687063e597c3',
    '3a83be754d822519e270578523f56044accf2e3cd5de9509a57c4221a0faa1fa',
    '1f6a92d7f88fdd91f1a0007b73482669323dddd337f70a5527e7f1e680221d8e',
    '65d92405f63ceb3cb420ad8c3d6d390b77ac26a06771dab62402c56a49b2e742',
    '482b173fb0c419d661f26265420c3c62cd1c617b20a604fb37167d5ec5a82d71',
  ];
  for (const [index, contract] of POST75_CATALOGS.entries()) {
    assert.equal(contract.query.match(/\n*$/u)[0], '\n');
    assert.equal(hash(contract.query + '\n'), beforeEofRepair[index]);
  }
  for (const [index, [name, sqlHash, runnerHash]] of definitions.entries()) {
    const old = await readFile(new URL('./verify-production-' + name + '.sql', import.meta.url), 'utf8');
    assert.equal(hash(old), sqlHash, 'Historical SQL changed: ' + name);
    assert.equal(hash(await readFile(new URL('./verify-production-' + name + '.mjs', import.meta.url))), runnerHash,
      'Historical runner changed: ' + name);
    const query = POST75_CATALOGS[index].query;
    assert.equal(hash(query), POST75_CATALOGS[index].sha256);
    const withoutHistory = value => {
      const start = value.lastIndexOf('\nSELECT\n');
      const end = value.indexOf(' AS exact_migration_history_ok,', start);
      assert.ok(start > 0 && end > start);
      return value.slice(0, start) + value.slice(end);
    };
    let expected = withoutHistory(old)
      .replace('-- Exact history accepts the frozen71, reviewed73, or reviewed74 checkpoint only.\n', '')
      .replace('-- Source-fixed, read-only exact74 catalog attestation.', '-- Source-fixed, read-only exact75 catalog attestation.');
    if (name === 'repeatable-challenge') expected = expected.replace(
      "('triggers','43de2ac1520532e3b590e93f565e2a1280ba7f61339625f78b5087fca00668b0')",
      "('triggers','f2a4b11b57b2b996ad310c0debf32fd1f8881932602317a567218ccc4363ede9')");
    assert.equal(withoutHistory(query).split('\n').slice(2).join('\n'), expected);
    const history = query.slice(query.lastIndexOf('\nSELECT\n'), query.indexOf(' AS exact_migration_history_ok,'));
    assert.match(history, /count\(\*\)=75 AND pg_catalog\.count\(DISTINCT version\)=75/u);
    assert.match(history, /max\(version::text\)='20261013091749'/u);
    assert.match(history, /4c20c2eb77256efa26cb99050bf851d4c62a6c9deadcc4c92230ded0f0ecff9b/u);
    assert.match(history, /9a5547d2f161a38101223139a9e96e213c380844da2a9765af2171f3ad90fb63/u);
    assert.doesNotMatch(history, /\bOR\b/u);
  }
  assert.equal(assertPost75CatalogsReady(), true);
  assert.equal(POST75_CATALOGS.reduce((total, contract) => total + contract.fields.length, 0), 53);
  assert.deepEqual(POST75_CATALOGS.map(contract => contract.name),
    ['account_request_inbox', 'original77', 'repeatable_challenge', 'admin_cleanup_health', 'admin_profile_name']);
  assert.ok(Object.isFrozen(POST75_CATALOGS));
  assert.ok(POST75_CATALOGS.every(Object.isFrozen));
});

test('five fixed queries run sequentially through the sole read-only endpoint with one shared signal and safe Boolean-only receipt', async () => {
  const calls = [];
  const result = await verifyProductionPost75Catalogs({ ...options, query: 'forbidden caller SQL', fetchImplementation: async (url, init) => {
    const contract = POST75_CATALOGS[calls.length]; calls.push({ url, init });
    assert.equal(url, 'https://api.supabase.com/v1/projects/mimolwojppbtsbvtqwpo/database/query/read-only');
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), { query: contract.query, parameters: [] });
    assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
    assert.equal(init.headers.Authorization, 'Bearer synthetic-test-token');
    return response([good(contract)]);
  } });
  assert.equal(calls.length, 5);
  assert.ok(calls.every(call => call.init.signal === calls[0].init.signal));
  assert.equal(calls[0].init.signal.aborted, true);
  assert.deepEqual(result, Object.fromEntries(POST75_CATALOGS.map(contract => [contract.name, good(contract)])));
  assert.ok(Object.isFrozen(result)); assert.ok(Object.values(result).every(Object.isFrozen));
});

test('invalid project, credential, transport, or expanded timeout fails before any request', async () => {
  for (const change of [{ projectRef: 'other-project' }, { projectRef: undefined }, { accessToken: '' },
    { accessToken: 'a\nb' }, { accessToken: 'a b' }, { accessToken: 'x'.repeat(4097) }, { accessToken: {} },
    { fetchImplementation: null }, { requestTimeoutMs: 0 }, { requestTimeoutMs: 15_001 },
    { requestTimeoutMs: 0.5 }, { requestTimeoutMs: NaN }]) {
    let calls = 0;
    await assert.rejects(verifyProductionPost75Catalogs({ ...options,
      fetchImplementation: async () => { calls++; throw Error('not allowed'); }, ...change }), errorIsFixed);
    assert.equal(calls, 0);
  }
  assert.equal(POST75_CATALOG_TIMEOUT_MS, 15_000); assert.equal(POST75_CATALOG_MAX_BYTES, 4096);
});

for (const [index, contract] of POST75_CATALOGS.entries()) test(contract.name + ': every false/missing/extra/non-Boolean field fails closed and stops subsequent queries', async () => {
  for (const field of contract.fields) for (const value of [false, null, 'true', 1]) {
    let calls = 0;
    await assert.rejects(verifyProductionPost75Catalogs({ ...options, fetchImplementation: async () => {
      const current = POST75_CATALOGS[calls++];
      return response([{ ...good(current), ...(current === contract ? { [field]: value } : {}) }]);
    } }), errorIsFixed);
    assert.equal(calls, index + 1);
  }
  const row = good(contract); delete row[contract.fields[0]];
  for (const invalid of [[], {}, null, [row], [good(contract), good(contract)], [{ ...good(contract), secret: 'must-not-escape' }]]) {
    assert.throws(() => contract.parse(invalid));
  }
  const getter = good(contract); let accessed = false;
  Object.defineProperty(getter, contract.fields[0], { get() { accessed = true; return true; } });
  assert.throws(() => contract.parse([getter])); assert.equal(accessed, false);
});

test('status, redirect, MIME, invalid JSON/UTF8, and overlong streamed bodies are redacted without fallback', async () => {
  const row = [good(POST75_CATALOGS[0])];
  const invalid = [
    () => response(row, { status: 200 }), () => response(row, { status: 403 }),
    () => ({ ...response(row), status: 201, redirected: true, body: new ReadableStream(), headers: new Headers({ 'content-type': 'application/json' }) }),
    () => response(row, { headers: { 'content-type': 'text/plain' } }),
    () => new Response('private remote failure', { status: 201, headers: { 'content-type': 'application/json' } }),
    () => new Response(new Uint8Array([0xff]), { status: 201, headers: { 'content-type': 'application/json' } }),
    () => new Response(' '.repeat(4097), { status: 201, headers: { 'content-type': 'application/json', 'content-length': '1' } }),
  ];
  for (const make of invalid) {
    let calls = 0;
    await assert.rejects(verifyProductionPost75Catalogs({ ...options, fetchImplementation: async () => { calls++; return make(); } }), errorIsFixed);
    assert.equal(calls, 1);
  }
  await assert.rejects(verifyProductionPost75Catalogs({ ...options, fetchImplementation: async () => { throw Error('private provider body'); } }), errorIsFixed);
});

test('total deadline spans all queries and prevents later dispatch even when an earlier fetch ignores abort', async () => {
  let calls = 0; let release; let signal;
  const pending = verifyProductionPost75Catalogs({ ...options, requestTimeoutMs: 25, fetchImplementation: async (_url, init) => {
    signal = init.signal; const current = POST75_CATALOGS[calls++];
    if (calls === 1) return response([good(current)]);
    return await new Promise(resolve => { release = () => resolve(response([good(current)])); });
  } });
  await assert.rejects(pending, errorIsFixed);
  assert.equal(calls, 2); assert.equal(signal.aborted, true);
  release(); await sleep(0); assert.equal(calls, 2);
});

test('one deadline is not reset after successful queries, and stalled body cleanup is bounded', async () => {
  let calls = 0; let cancelled = false;
  await assert.rejects(verifyProductionPost75Catalogs({ ...options, requestTimeoutMs: 50, fetchImplementation: async () => {
    const current = POST75_CATALOGS[calls++];
    if (calls === 1) { await sleep(35); return response([good(current)]); }
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 201, headers: { 'content-type': 'application/json' } });
  } }), errorIsFixed);
  assert.equal(calls, 2); assert.equal(cancelled, true);
});

test('CLI accepts no operator SQL or other arguments and exposes only its fixed failure message', () => {
  const result = spawnSync(process.execPath, [new URL('./verify-production-post75-catalogs.mjs', import.meta.url).pathname, '--query', 'private-value'],
    { encoding: 'utf8', timeout: 5000, env: {} });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'Production exact75 catalog verification failed.');
});
