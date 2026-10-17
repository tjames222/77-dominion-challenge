import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const PROFILE_NAME_PROJECT_REF = 'mimolwojppbtsbvtqwpo';
export const PROFILE_NAME_CATALOG_QUERY = readFileSync(new URL('./verify-production-admin-profile-name.sql', import.meta.url), 'utf8');
export const PROFILE_NAME_CATALOG_TIMEOUT_MS = 15_000;
export const PROFILE_NAME_CATALOG_MAX_BYTES = 4_096;
export const PROFILE_NAME_CATALOG_FIELDS = Object.freeze([
  "exact_migration_history_ok",
  "read_only_pinned_server_ok",
  "functions_catalog_ok",
  "sidecar_structure_ok",
  "sidecar_privileges_ok",
  "sidecar_constraints_ok",
  "sidecar_indexes_ok",
  "profile_version_trigger_ok",
  "audit_structure_ok",
  "audit_privileges_ok",
  "audit_constraints_ok",
  "audit_indexes_ok",
  "audit_immutable_trigger_ok"
]);
const endpoint = 'https://api.supabase.com/v1/projects/' + PROFILE_NAME_PROJECT_REF + '/database/query/read-only';
const fail = () => new Error('Production Admin profile-name catalog verification failed.');

export function parseProfileNameCatalogResult(value) {
  try {
    if (!Array.isArray(value) || value.length !== 1) throw fail();
    const row = value[0];
    if (!row || typeof row !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(row))
      || Reflect.ownKeys(row).length !== PROFILE_NAME_CATALOG_FIELDS.length) throw fail();
    for (const key of PROFILE_NAME_CATALOG_FIELDS) {
      const descriptor = Object.getOwnPropertyDescriptor(row, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.value !== true) throw fail();
    }
    // Return only our fixed safe shape, never remote data or diagnostic text.
    return Object.freeze(Object.fromEntries(PROFILE_NAME_CATALOG_FIELDS.map(key => [key, true])));
  } catch { throw fail(); }
}

/** One fixed catalog query; no caller SQL, temporary login, account or database-secret reads. */
export async function verifyProductionAdminProfileName({
  projectRef = process.env.SUPABASE_PROJECT_REF,
  accessToken = process.env.SUPABASE_ACCESS_TOKEN,
  fetchImplementation = globalThis.fetch,
  requestTimeoutMs = PROFILE_NAME_CATALOG_TIMEOUT_MS,
} = {}) {
  if (projectRef !== PROFILE_NAME_PROJECT_REF || typeof accessToken !== 'string'
    || accessToken.length < 1 || accessToken.length > 4096 || /[^\x21-\x7e]/u.test(accessToken)
    || typeof fetchImplementation !== 'function' || !Number.isInteger(requestTimeoutMs)
    || requestTimeoutMs < 1 || requestTimeoutMs > PROFILE_NAME_CATALOG_TIMEOUT_MS) throw fail();
  const controller = new AbortController();
  let timer; let reader;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(fail()); }, requestTimeoutMs);
  });
  const request = async () => {
    const response = await fetchImplementation(endpoint, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: PROFILE_NAME_CATALOG_QUERY, parameters: [] }),
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
      if (size > PROFILE_NAME_CATALOG_MAX_BYTES) throw fail();
      chunks.push(value);
    }
    if (controller.signal.aborted) throw fail();
    const json = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
    return parseProfileNameCatalogResult(JSON.parse(json));
  };
  try { return await Promise.race([request(), deadline]); }
  catch { throw fail(); }
  finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) {
      // Do not let a stalled/untrusted body hold cleanup past the deadline.
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 2) throw fail();
    console.log(JSON.stringify(await verifyProductionAdminProfileName()));
  } catch {
    console.error(fail().message);
    process.exitCode = 1;
  }
}
