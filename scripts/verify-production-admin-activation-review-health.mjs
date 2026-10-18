import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const ACTIVATION_REVIEW_PROJECT_REF = 'mimolwojppbtsbvtqwpo';
export const ACTIVATION_REVIEW_CATALOG_QUERY = readFileSync(new URL('./verify-production-admin-activation-review-health.sql', import.meta.url), 'utf8');
export const ACTIVATION_REVIEW_CATALOG_TIMEOUT_MS = 15_000;
export const ACTIVATION_REVIEW_CATALOG_MAX_BYTES = 4_096;
export const ACTIVATION_REVIEW_CATALOG_FIELDS = Object.freeze([
  "exact_migration_history_ok",
  "read_only_pinned_server_ok",
  "review_table_shape_ok",
  "review_table_privileges_ok",
  "review_constraints_ok",
  "review_indexes_ok",
  "activation_review_rpc_catalog_ok",
  "existing_admin_guards_ok"
]);
export const ACTIVATION_REVIEW_CATALOG_SHA256 = '6945a15e3f2f71222f330ee0386c957c5f53b17043097257df3ede7af0e7a5ca';
export function assertActivationReviewCatalogReady() {
  if (createHash('sha256').update(ACTIVATION_REVIEW_CATALOG_QUERY).digest('hex') !== ACTIVATION_REVIEW_CATALOG_SHA256) throw fail();
  return true;
}
const endpoint = 'https://api.supabase.com/v1/projects/' + ACTIVATION_REVIEW_PROJECT_REF + '/database/query/read-only';
const fail = () => new Error('Production Admin activation-review catalog verification failed.');

export function parseActivationReviewCatalogResult(value) {
  try {
    if (!Array.isArray(value) || value.length !== 1) throw fail();
    const row = value[0];
    if (!row || typeof row !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(row))
      || Reflect.ownKeys(row).length !== ACTIVATION_REVIEW_CATALOG_FIELDS.length) throw fail();
    for (const key of ACTIVATION_REVIEW_CATALOG_FIELDS) {
      const descriptor = Object.getOwnPropertyDescriptor(row, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.value !== true) throw fail();
    }
    // Return only our fixed safe shape, never remote data or diagnostic text.
    return Object.freeze(Object.fromEntries(ACTIVATION_REVIEW_CATALOG_FIELDS.map(key => [key, true])));
  } catch { throw fail(); }
}

/** One fixed catalog query; no caller SQL, temporary login, account or database-secret reads. */
export async function verifyProductionAdminActivationReviewHealth({
  projectRef = process.env.SUPABASE_PROJECT_REF,
  accessToken = process.env.SUPABASE_ACCESS_TOKEN,
  fetchImplementation = globalThis.fetch,
  requestTimeoutMs = ACTIVATION_REVIEW_CATALOG_TIMEOUT_MS,
} = {}) {
  assertActivationReviewCatalogReady();
  if (projectRef !== ACTIVATION_REVIEW_PROJECT_REF || typeof accessToken !== 'string'
    || accessToken.length < 1 || accessToken.length > 4096 || /[^\x21-\x7e]/u.test(accessToken)
    || typeof fetchImplementation !== 'function' || !Number.isInteger(requestTimeoutMs)
    || requestTimeoutMs < 1 || requestTimeoutMs > ACTIVATION_REVIEW_CATALOG_TIMEOUT_MS) throw fail();
  const controller = new AbortController();
  let timer; let reader;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(fail()); }, requestTimeoutMs);
  });
  const request = async () => {
    const response = await fetchImplementation(endpoint, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: ACTIVATION_REVIEW_CATALOG_QUERY, parameters: [] }),
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
      if (!(value instanceof Uint8Array)) throw fail();
      size += value.byteLength;
      if (size > ACTIVATION_REVIEW_CATALOG_MAX_BYTES) throw fail();
      chunks.push(value);
    }
    if (controller.signal.aborted) throw fail();
    const json = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
    return parseActivationReviewCatalogResult(JSON.parse(json));
  };
  try { return await Promise.race([request(), deadline]); }
  catch { throw fail(); }
  finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) {
      // Do not let a stalled/untrusted body hold cleanup past the deadline.
      void reader.cancel().catch(() => {});
      try { reader.releaseLock(); } catch {}
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 2) throw fail();
    console.log(JSON.stringify(await verifyProductionAdminActivationReviewHealth()));
  } catch {
    console.error(fail().message);
    process.exitCode = 1;
  }
}
