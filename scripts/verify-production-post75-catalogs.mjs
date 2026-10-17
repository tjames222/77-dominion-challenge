import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { INBOX_CATALOG_FIELDS, parseInboxCatalogResult } from './verify-production-account-request-inbox.mjs';
import { ORIGINAL77_CATALOG_FIELDS, parseOriginal77CatalogResult } from './verify-production-original77.mjs';
import { REPEATABLE_CHALLENGE_CATALOG_FIELDS, parseRepeatableChallengeCatalogResult } from './verify-production-repeatable-challenge.mjs';
import { CLEANUP_CATALOG_FIELDS, parseCleanupCatalogResult } from './verify-production-admin-cleanup-health.mjs';
import { PROFILE_NAME_CATALOG_QUERY, PROFILE_NAME_CATALOG_FIELDS, parseProfileNameCatalogResult } from './verify-production-admin-profile-name.mjs';

export const POST75_CATALOG_PROJECT_REF = 'mimolwojppbtsbvtqwpo';
export const POST75_CATALOG_TIMEOUT_MS = 15_000;
export const POST75_CATALOG_MAX_BYTES = 4_096;
const readQuery = name => readFileSync(new URL('./verify-production-' + name + '-post75.sql', import.meta.url), 'utf8');
const freeze = (name, query, sha256, fields, parse) => Object.freeze({ name, query, sha256, fields, parse });

// Separate source-fixed exact75 SQL preserves every historical source. Only
// exact history changes, plus the full profiles-trigger aggregate in repeatable
// (which now includes the reviewed version trigger, without any exclusions).
// The new name contract additionally attests both changed audit helpers and the
// complete audit/sidecar/trigger privileges and structure. No caller SQL exists.
export const POST75_CATALOGS = Object.freeze([
  freeze('account_request_inbox', readQuery('account-request-inbox'),
    '09e3b1b48199c09b06329203d72d908010f39a4beed077b14f363b09448d4fb5', INBOX_CATALOG_FIELDS, parseInboxCatalogResult),
  freeze('original77', readQuery('original77'),
    'fc2dc596b3ef8ed5b003b0c8a4eec72c3b2e938933664bb941874cb920e0754a', ORIGINAL77_CATALOG_FIELDS, parseOriginal77CatalogResult),
  freeze('repeatable_challenge', readQuery('repeatable-challenge'),
    '408f2bed253134631d52faa1337cb72295d8ccd47d6df0cb4577015dbf268021', REPEATABLE_CHALLENGE_CATALOG_FIELDS, parseRepeatableChallengeCatalogResult),
  freeze('admin_cleanup_health', readQuery('admin-cleanup-health'),
    'a4d0f5d2d6084a946a528bc7c15e09fed04e9d527829858f9c38b4957ddb0f9a', CLEANUP_CATALOG_FIELDS, parseCleanupCatalogResult),
  freeze('admin_profile_name', PROFILE_NAME_CATALOG_QUERY,
    '9cf41ae70f224b34001a1a43146e83d642bb150fc848edad6be4c99286fd0c40', PROFILE_NAME_CATALOG_FIELDS, parseProfileNameCatalogResult),
]);
const endpoint = 'https://api.supabase.com/v1/projects/' + POST75_CATALOG_PROJECT_REF + '/database/query/read-only';
const fail = () => new Error('Production exact75 catalog verification failed.');
const digest = value => createHash('sha256').update(value).digest('hex');
const cancel = body => { try { void body?.cancel().catch(() => {}); } catch {} };

/** Every new SQL byte is reviewed locally before any network request. */
export function assertPost75CatalogsReady() {
  if (POST75_CATALOGS.length !== 5 || POST75_CATALOGS.some(({ query, sha256 }) =>
    !/^[a-f0-9]{64}$/u.test(sha256) || digest(query) !== sha256)) throw fail();
  return true;
}

/** Five fixed read-only queries, one total deadline; no fallback or mutation. */
export async function verifyProductionPost75Catalogs({
  projectRef = process.env.SUPABASE_PROJECT_REF,
  accessToken = process.env.SUPABASE_ACCESS_TOKEN,
  fetchImplementation = globalThis.fetch,
  requestTimeoutMs = POST75_CATALOG_TIMEOUT_MS,
} = {}) {
  assertPost75CatalogsReady();
  if (projectRef !== POST75_CATALOG_PROJECT_REF || typeof accessToken !== 'string'
    || accessToken.length < 1 || accessToken.length > 4096 || /[^\x21-\x7e]/u.test(accessToken)
    || typeof fetchImplementation !== 'function' || !Number.isInteger(requestTimeoutMs)
    || requestTimeoutMs < 1 || requestTimeoutMs > POST75_CATALOG_TIMEOUT_MS) throw fail();
  const controller = new AbortController();
  let timer; let reader;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(fail()); }, requestTimeoutMs);
  });
  const request = async () => {
    const result = [];
    for (const contract of POST75_CATALOGS) {
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
        if (size > POST75_CATALOG_MAX_BYTES) throw fail();
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
    console.log(JSON.stringify(await verifyProductionPost75Catalogs()));
  } catch {
    console.error(fail().message);
    process.exitCode = 1;
  }
}
