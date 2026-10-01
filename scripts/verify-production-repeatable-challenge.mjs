import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { REPEATABLE_CHALLENGE_MIGRATION_SHA256 } from './verify-repeatable-challenge-cutover-plan.mjs';

export const REPEATABLE_CHALLENGE_PROJECT_REF = 'mimolwojppbtsbvtqwpo';
export const REPEATABLE_CHALLENGE_CATALOG_QUERY = readFileSync(
  new URL('./verify-production-repeatable-challenge.sql', import.meta.url),
  'utf8',
);
export const REPEATABLE_CHALLENGE_CATALOG_TIMEOUT_MS = 15_000;
export const REPEATABLE_CHALLENGE_CATALOG_MAX_BYTES = 4_096;
export const REPEATABLE_CHALLENGE_CATALOG_FIELDS = Object.freeze([
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
const endpoint = `https://api.supabase.com/v1/projects/${REPEATABLE_CHALLENGE_PROJECT_REF}/database/query/read-only`;
const fail = () => new Error('Production repeatable challenge catalog verification failed.');
const isSha256 = value => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);

function reviewedPins(query = REPEATABLE_CHALLENGE_CATALOG_QUERY) {
  const source = query.match(/^-- 20261001001245 (\S+)$/mu)?.[1];
  const historyComment = query.match(/^-- Exact 71-version history SHA-256: (\S+)$/mu)?.[1];
  const history = query.match(/expected_history\(definition_hash\) AS \(VALUES\s*\('([^']+)'\)\s*\)/u)?.[1];
  const start = query.indexOf('expected_contracts(contract_name,definition_hash) AS (VALUES');
  const end = query.indexOf('), contract_checks AS (', start);
  if (start < 0 || end <= start) throw fail();
  const contracts = [...query.slice(start, end).matchAll(/\('([a-z_]+)','([^']+)'\)/gu)];
  if (contracts.length !== 8 || new Set(contracts.map(match => match[1])).size !== contracts.length) throw fail();
  if (historyComment !== history) throw fail();
  return Object.freeze({ source, history,
    contracts: Object.freeze(Object.fromEntries(contracts.map(match => [match[1], match[2]]))) });
}

/** Fail before any Management API request until every locally derived review pin is frozen. */
export function assertRepeatableChallengeCatalogReady() {
  const pins = reviewedPins();
  if (!isSha256(REPEATABLE_CHALLENGE_MIGRATION_SHA256)
    || pins.source !== REPEATABLE_CHALLENGE_MIGRATION_SHA256
    || !isSha256(pins.history)
    || !Object.values(pins.contracts).every(isSha256)) throw fail();
  return pins;
}

export function parseRepeatableChallengeCatalogResult(value) {
  try {
    if (!Array.isArray(value) || value.length !== 1) throw fail();
    const row = value[0];
    if (!row || typeof row !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(row))
      || Reflect.ownKeys(row).length !== REPEATABLE_CHALLENGE_CATALOG_FIELDS.length) throw fail();
    for (const key of REPEATABLE_CHALLENGE_CATALOG_FIELDS) {
      const descriptor = Object.getOwnPropertyDescriptor(row, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.value !== true) throw fail();
    }
    return Object.freeze(Object.fromEntries(REPEATABLE_CHALLENGE_CATALOG_FIELDS.map(key => [key, true])));
  } catch { throw fail(); }
}

/** One fixed catalog query; no caller SQL, temporary login, account or database-secret reads. */
export async function verifyProductionRepeatableChallenge({
  projectRef = process.env.SUPABASE_PROJECT_REF,
  accessToken = process.env.SUPABASE_ACCESS_TOKEN,
  fetchImplementation = globalThis.fetch,
  requestTimeoutMs = REPEATABLE_CHALLENGE_CATALOG_TIMEOUT_MS,
} = {}) {
  assertRepeatableChallengeCatalogReady();
  if (projectRef !== REPEATABLE_CHALLENGE_PROJECT_REF || typeof accessToken !== 'string'
    || accessToken.length < 1 || accessToken.length > 4096 || /[^\x21-\x7e]/u.test(accessToken)
    || typeof fetchImplementation !== 'function' || !Number.isInteger(requestTimeoutMs)
    || requestTimeoutMs < 1 || requestTimeoutMs > REPEATABLE_CHALLENGE_CATALOG_TIMEOUT_MS) throw fail();
  const controller = new AbortController();
  let timer; let reader;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(fail()); }, requestTimeoutMs);
  });
  const request = async () => {
    const response = await fetchImplementation(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: REPEATABLE_CHALLENGE_CATALOG_QUERY, parameters: [] }),
      credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
    });
    if (controller.signal.aborted || response?.status !== 201 || response.redirected
      || !/^application\/json(?:\s*;|$)/iu.test(response.headers?.get('content-type') || '') || !response.body) {
      void response?.body?.cancel().catch(() => {});
      throw fail();
    }
    reader = response.body.getReader();
    const chunks = []; let size = 0;
    while (true) {
      if (controller.signal.aborted) throw fail();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > REPEATABLE_CHALLENGE_CATALOG_MAX_BYTES) throw fail();
      chunks.push(value);
    }
    if (controller.signal.aborted) throw fail();
    const json = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
    return parseRepeatableChallengeCatalogResult(JSON.parse(json));
  };
  try { return await Promise.race([request(), deadline]); }
  catch { throw fail(); }
  finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 2) throw fail();
    console.log(JSON.stringify(await verifyProductionRepeatableChallenge()));
  } catch {
    console.error(fail().message);
    process.exitCode = 1;
  }
}
