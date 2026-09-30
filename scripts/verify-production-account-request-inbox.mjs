import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const INBOX_PROJECT_REF = 'mimolwojppbtsbvtqwpo';
export const INBOX_CATALOG_QUERY = readFileSync(new URL('./verify-production-account-request-inbox.sql', import.meta.url), 'utf8');
export const INBOX_CATALOG_TIMEOUT_MS = 15_000;
export const INBOX_CATALOG_MAX_BYTES = 4_096;
export const INBOX_CATALOG_FIELDS = Object.freeze([
  'exact_migration_history_ok', 'read_only_pinned_server_ok', 'inbox_rpc_catalog_ok',
  'existing_admin_guards_ok', 'inbox_index_ok', 'existing_indexes_preserved_ok',
  'ledger_rls_owner_ok', 'ledger_exact_acl_ok', 'ledger_columns_grants_ok',
  'ledger_member_policies_ok', 'member_effective_privileges_ok',
]);
const endpoint = 'https://api.supabase.com/v1/projects/' + INBOX_PROJECT_REF + '/database/query/read-only';
const fail = () => new Error('Production account-request inbox catalog verification failed.');

export function parseInboxCatalogResult(value) {
  try {
    if (!Array.isArray(value) || value.length !== 1) throw fail();
    const row = value[0];
    if (!row || typeof row !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(row))
      || Reflect.ownKeys(row).length !== INBOX_CATALOG_FIELDS.length) throw fail();
    for (const key of INBOX_CATALOG_FIELDS) {
      const descriptor = Object.getOwnPropertyDescriptor(row, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.value !== true) throw fail();
    }
    // Return only our fixed safe shape, never remote data or diagnostic text.
    return Object.freeze(Object.fromEntries(INBOX_CATALOG_FIELDS.map(key => [key, true])));
  } catch { throw fail(); }
}

/** One fixed catalog query; no caller SQL, temporary login, account or database-secret reads. */
export async function verifyProductionAccountRequestInbox({
  projectRef = process.env.SUPABASE_PROJECT_REF,
  accessToken = process.env.SUPABASE_ACCESS_TOKEN,
  fetchImplementation = globalThis.fetch,
  requestTimeoutMs = INBOX_CATALOG_TIMEOUT_MS,
} = {}) {
  if (projectRef !== INBOX_PROJECT_REF || typeof accessToken !== 'string'
    || accessToken.length < 1 || accessToken.length > 4096 || /[^\x21-\x7e]/u.test(accessToken)
    || typeof fetchImplementation !== 'function' || !Number.isInteger(requestTimeoutMs)
    || requestTimeoutMs < 1 || requestTimeoutMs > INBOX_CATALOG_TIMEOUT_MS) throw fail();
  const controller = new AbortController();
  let timer; let reader;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(fail()); }, requestTimeoutMs);
  });
  const request = async () => {
    const response = await fetchImplementation(endpoint, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: INBOX_CATALOG_QUERY, parameters: [] }),
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
      if (size > INBOX_CATALOG_MAX_BYTES) throw fail();
      chunks.push(value);
    }
    if (controller.signal.aborted) throw fail();
    const json = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
    return parseInboxCatalogResult(JSON.parse(json));
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
    console.log(JSON.stringify(await verifyProductionAccountRequestInbox()));
  } catch {
    console.error(fail().message);
    process.exitCode = 1;
  }
}
