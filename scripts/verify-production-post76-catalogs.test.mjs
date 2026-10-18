import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { POST76_CATALOGS, POST76_CATALOG_PROJECT_REF, POST76_CATALOG_TIMEOUT_MS,
  POST76_CATALOG_MAX_BYTES, assertPost76CatalogsReady, verifyProductionPost76Catalogs } from './verify-production-post76-catalogs.mjs';

const options = { projectRef: POST76_CATALOG_PROJECT_REF, accessToken: 'synthetic-test-token' };
const fixedError = /^Production exact76 catalog verification failed\.$/u;
const hash = value => createHash('sha256').update(value).digest('hex');
const good = contract => Object.fromEntries(contract.fields.map(key => [key, true]));
const response = (value, init = {}) => new Response(JSON.stringify(value), {
  status: 201, headers: { 'content-type': 'application/json; charset=utf-8' }, ...init,
});
const errorIsFixed = error => fixedError.test(error.message);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
import { POST75_CATALOGS } from './verify-production-post75-catalogs.mjs';
import { readdir } from 'node:fs/promises';

test('five new exact76 copies change only exact history and preserve every historical53 Boolean', async () => {
  assert.equal(hash(await readFile(new URL('./verify-production-post75-catalogs.mjs', import.meta.url))), '3a7673cdee382934119f0978243e3ed0784c008f5c3a8a3ae5e4a1415da16c22');
  assert.equal(POST76_CATALOGS.length,6);
  for (let i=0;i<5;i++) {
    const before=POST75_CATALOGS[i], after=POST76_CATALOGS[i];
    assert.equal(hash(before.query),before.sha256); assert.equal(hash(after.query),after.sha256);
    assert.equal(after.name,before.name); assert.deepEqual(after.fields,before.fields);
    const expected=before.query.replaceAll('count(*)=75 AND pg_catalog.count(DISTINCT version)=75','count(*)=76 AND pg_catalog.count(DISTINCT version)=76')
      .replace("max(version::text)='20261013091749'","max(version::text)='20261018013111'")
      .replace('4c20c2eb77256efa26cb99050bf851d4c62a6c9deadcc4c92230ded0f0ecff9b','4886aaa187456df418ffdd8376da7ed2b02dbde390e9aac08b1617b1822a20bd')
      .replace('9a5547d2f161a38101223139a9e96e213c380844da2a9765af2171f3ad90fb63','76a94228e673e739000caae1927358a30130a14213d03073d57dc6d02775791b');
    assert.equal(after.query,expected);
  }
  const names=(await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort().slice(0,76);
  assert.equal(names.length,76);assert.equal(names.at(-1),'20261018013111_site_admin_activation_review_health.sql');
  assert.equal(hash(names.map(n=>n.slice(0,14)).join(',')),'4886aaa187456df418ffdd8376da7ed2b02dbde390e9aac08b1617b1822a20bd');
  assert.equal(hash(names.map(n=>n.slice(0,-4)).join(',')),'76a94228e673e739000caae1927358a30130a14213d03073d57dc6d02775791b');
  assert.equal(POST76_CATALOGS.slice(0,5).reduce((n,c)=>n+c.fields.length,0),53);
  assert.equal(POST76_CATALOGS.reduce((n,c)=>n+c.fields.length,0),61);
  assert.equal(assertPost76CatalogsReady(),true);assert(Object.isFrozen(POST76_CATALOGS));assert(POST76_CATALOGS.every(Object.isFrozen));
});

test('new activation attestation is fixed catalog-only and retains exact source boundary and guards', async () => {
  const contract=POST76_CATALOGS.at(-1); const sql=contract.query.replace(/^--.*$/gm,'');
  assert.equal(contract.name,'admin_activation_review_health');assert.equal(hash(contract.query),contract.sha256);
  assert.equal(sql.split(';').filter(part=>part.trim()).length,1);
  assert.doesNotMatch(sql,/\b(?:FROM|JOIN)\s+(?:private|public|auth|vault|cron)\./i);
  assert.doesNotMatch(sql,/\b(?:SELECT|PERFORM|CALL)\s+(?:private\.require_site_admin|public\.site_admin_get_activation_review_health)\s*\(/i);
  assert.match(sql,/count\(\*\)=76 AND pg_catalog\.count\(DISTINCT version\)=76/);
  for(const field of contract.fields)assert(sql.includes(' AS '+field));
  for(const pin of ['754f9428f88fc955d4de05fb728bb348c1636c1cf4462b0563778882b5dee651','d3f43f051963e2537cc63329f30867b6ecfbbbe9c17f7492d586c8d0c86e03f7'])assert(sql.includes(pin));
});

test('six fixed queries run sequentially through the sole read-only endpoint with one shared signal and safe Boolean-only receipt', async () => {
  const calls = [];
  const result = await verifyProductionPost76Catalogs({ ...options, query: 'forbidden caller SQL', fetchImplementation: async (url, init) => {
    const contract = POST76_CATALOGS[calls.length]; calls.push({ url, init });
    assert.equal(url, 'https://api.supabase.com/v1/projects/mimolwojppbtsbvtqwpo/database/query/read-only');
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), { query: contract.query, parameters: [] });
    assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
    assert.equal(init.headers.Authorization, 'Bearer synthetic-test-token');
    return response([good(contract)]);
  } });
  assert.equal(calls.length, 6);
  assert.ok(calls.every(call => call.init.signal === calls[0].init.signal));
  assert.equal(calls[0].init.signal.aborted, true);
  assert.deepEqual(result, Object.fromEntries(POST76_CATALOGS.map(contract => [contract.name, good(contract)])));
  assert.ok(Object.isFrozen(result)); assert.ok(Object.values(result).every(Object.isFrozen));
});

test('invalid project, credential, transport, or expanded timeout fails before any request', async () => {
  for (const change of [{ projectRef: 'other-project' }, { projectRef: undefined }, { accessToken: '' },
    { accessToken: 'a\nb' }, { accessToken: 'a b' }, { accessToken: 'x'.repeat(4097) }, { accessToken: {} },
    { fetchImplementation: null }, { requestTimeoutMs: 0 }, { requestTimeoutMs: 15_001 },
    { requestTimeoutMs: 0.5 }, { requestTimeoutMs: NaN }]) {
    let calls = 0;
    await assert.rejects(verifyProductionPost76Catalogs({ ...options,
      fetchImplementation: async () => { calls++; throw Error('not allowed'); }, ...change }), errorIsFixed);
    assert.equal(calls, 0);
  }
  assert.equal(POST76_CATALOG_TIMEOUT_MS, 15_000); assert.equal(POST76_CATALOG_MAX_BYTES, 4096);
});

for (const [index, contract] of POST76_CATALOGS.entries()) test(contract.name + ': every false/missing/extra/non-Boolean field fails closed and stops subsequent queries', async () => {
  for (const field of contract.fields) for (const value of [false, null, 'true', 1]) {
    let calls = 0;
    await assert.rejects(verifyProductionPost76Catalogs({ ...options, fetchImplementation: async () => {
      const current = POST76_CATALOGS[calls++];
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
  const row = [good(POST76_CATALOGS[0])];
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
    await assert.rejects(verifyProductionPost76Catalogs({ ...options, fetchImplementation: async () => { calls++; return make(); } }), errorIsFixed);
    assert.equal(calls, 1);
  }
  await assert.rejects(verifyProductionPost76Catalogs({ ...options, fetchImplementation: async () => { throw Error('private provider body'); } }), errorIsFixed);
});

test('total deadline spans all queries and prevents later dispatch even when an earlier fetch ignores abort', async () => {
  let calls = 0; let release; let signal;
  const pending = verifyProductionPost76Catalogs({ ...options, requestTimeoutMs: 25, fetchImplementation: async (_url, init) => {
    signal = init.signal; const current = POST76_CATALOGS[calls++];
    if (calls === 1) return response([good(current)]);
    return await new Promise(resolve => { release = () => resolve(response([good(current)])); });
  } });
  await assert.rejects(pending, errorIsFixed);
  assert.equal(calls, 2); assert.equal(signal.aborted, true);
  release(); await sleep(0); assert.equal(calls, 2);
});

test('one deadline is not reset after successful queries, and stalled body cleanup is bounded', async () => {
  let calls = 0; let cancelled = false;
  await assert.rejects(verifyProductionPost76Catalogs({ ...options, requestTimeoutMs: 50, fetchImplementation: async () => {
    const current = POST76_CATALOGS[calls++];
    if (calls === 1) { await sleep(35); return response([good(current)]); }
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 201, headers: { 'content-type': 'application/json' } });
  } }), errorIsFixed);
  assert.equal(calls, 2); assert.equal(cancelled, true);
});

test('CLI accepts no operator SQL or other arguments and exposes only its fixed failure message', () => {
  const result = spawnSync(process.execPath, [new URL('./verify-production-post76-catalogs.mjs', import.meta.url).pathname, '--query', 'private-value'],
    { encoding: 'utf8', timeout: 5000, env: {} });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'Production exact76 catalog verification failed.');
});
