import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { INBOX_CATALOG_FIELDS, parseInboxCatalogResult } from './verify-production-account-request-inbox.mjs';
import { ORIGINAL77_CATALOG_FIELDS, parseOriginal77CatalogResult } from './verify-production-original77.mjs';
import { REPEATABLE_CHALLENGE_CATALOG_FIELDS, parseRepeatableChallengeCatalogResult } from './verify-production-repeatable-challenge.mjs';
import { CLEANUP_CATALOG_FIELDS, parseCleanupCatalogResult } from './verify-production-admin-cleanup-health.mjs';
import { PROFILE_NAME_CATALOG_FIELDS, parseProfileNameCatalogResult } from './verify-production-admin-profile-name.mjs';

import { ACTIVATION_REVIEW_CATALOG_QUERY, ACTIVATION_REVIEW_CATALOG_FIELDS, parseActivationReviewCatalogResult } from './verify-production-admin-activation-review-health.mjs';

export const POST76_CATALOG_PROJECT_REF = 'mimolwojppbtsbvtqwpo';
export const POST76_CATALOG_TIMEOUT_MS = 15_000;
export const POST76_CATALOG_MAX_BYTES = 4_096;
const readQuery = name => readFileSync(new URL('./verify-production-' + name + '-post76.sql', import.meta.url), 'utf8');
const freeze = (name, query, sha256, fields, parse) => Object.freeze({ name, query, sha256, fields, parse });

// Five source-fixed copies preserve all53 historical Boolean checks, changing
// only exact history75 to76. The sixth source-fixed query additionally attests
// the read-only legacy review RPC, existing guards, table boundary and indexes.
// No caller SQL or mutation exists.
export const POST76_CATALOGS = Object.freeze([
  freeze('account_request_inbox', readQuery('account-request-inbox'),
    'ce6478eb0cebe40af516e3ca5f37742025b6f8d7afebe48920bb137c6d1cae59', INBOX_CATALOG_FIELDS, parseInboxCatalogResult),
  freeze('original77', readQuery('original77'),
    '124f166dc727346f401171b5d55a6bdde736be95487076aa379ee5c6504c2017', ORIGINAL77_CATALOG_FIELDS, parseOriginal77CatalogResult),
  freeze('repeatable_challenge', readQuery('repeatable-challenge'),
    '295269b6808a44635ebf1b5e37c8c6d2763e5401f1c242eccad73b0db66c6ddd', REPEATABLE_CHALLENGE_CATALOG_FIELDS, parseRepeatableChallengeCatalogResult),
  freeze('admin_cleanup_health', readQuery('admin-cleanup-health'),
    'f3b7f2bbaf8dbb0af8df2449884a19be0f15bd15fe0e5dc237abbdb2211ea9da', CLEANUP_CATALOG_FIELDS, parseCleanupCatalogResult),
  freeze('admin_profile_name', readQuery('admin-profile-name'),
    '7534957a7dac21ab56dc95305254c35b7c84fa3078d63be28a089ab36d2b13f8', PROFILE_NAME_CATALOG_FIELDS, parseProfileNameCatalogResult),
  freeze('admin_activation_review_health', ACTIVATION_REVIEW_CATALOG_QUERY,
    '6945a15e3f2f71222f330ee0386c957c5f53b17043097257df3ede7af0e7a5ca', ACTIVATION_REVIEW_CATALOG_FIELDS, parseActivationReviewCatalogResult),
]);
const endpoint = 'https://api.supabase.com/v1/projects/' + POST76_CATALOG_PROJECT_REF + '/database/query/read-only';
const fail = () => new Error('Production exact76 catalog verification failed.');
const digest = value => createHash('sha256').update(value).digest('hex');
const cancel = body => { try { void body?.cancel().catch(() => {}); } catch {} };

/** Every new SQL byte is reviewed locally before any network request. */
export function assertPost76CatalogsReady() {
  if (POST76_CATALOGS.length !== 6 || POST76_CATALOGS.some(({ query, sha256 }) =>
    !/^[a-f0-9]{64}$/u.test(sha256) || digest(query) !== sha256)) throw fail();
  return true;
}

/** Six fixed read-only queries, one total deadline; no fallback or mutation. */
export async function verifyProductionPost76Catalogs({
  projectRef = process.env.SUPABASE_PROJECT_REF,
  accessToken = process.env.SUPABASE_ACCESS_TOKEN,
  fetchImplementation = globalThis.fetch,
  requestTimeoutMs = POST76_CATALOG_TIMEOUT_MS,
} = {}) {
  assertPost76CatalogsReady();
  if (projectRef !== POST76_CATALOG_PROJECT_REF || typeof accessToken !== 'string'
    || accessToken.length < 1 || accessToken.length > 4096 || /[^\x21-\x7e]/u.test(accessToken)
    || typeof fetchImplementation !== 'function' || !Number.isInteger(requestTimeoutMs)
    || requestTimeoutMs < 1 || requestTimeoutMs > POST76_CATALOG_TIMEOUT_MS) throw fail();
  const controller = new AbortController();
  let timer; let reader;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(fail()); }, requestTimeoutMs);
  });
  const request = async () => {
    const result = [];
    for (const contract of POST76_CATALOGS) {
      if (controller.signal.aborted) throw fail();
      const response = await fetchImplementation(endpoint, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: contract.query, parameters: [] }),
        credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
      });
      if (controller.signal.aborted || response?.status !== 201 || response.redirected
        || !/^application\/json(?:\s*;|$)/iu.test(response.headers?.get('content-type') || '') || !response.body) {
        cancel(response?.body);
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
        if (size > POST76_CATALOG_MAX_BYTES) throw fail();
        chunks.push(value);
      }
      if (controller.signal.aborted) throw fail();
      const json = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
      result.push([contract.name, contract.parse(JSON.parse(json))]);
      reader.releaseLock(); reader = undefined;
    }
    return Object.freeze(Object.fromEntries(result));
  };
  try { return await Promise.race([request(), deadline]); }
  catch { throw fail(); }
  finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) {
      cancel(reader);
      try { reader.releaseLock(); } catch {}
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 2) throw fail();
    console.log(JSON.stringify(await verifyProductionPost76Catalogs()));
  } catch {
    console.error(fail().message);
    process.exitCode = 1;
  }
}
