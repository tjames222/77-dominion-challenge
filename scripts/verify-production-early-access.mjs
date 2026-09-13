import { pathToFileURL } from 'node:url';
import { PRODUCTION_SITE_ORIGINS, PRODUCTION_SUPABASE_PROJECT_REF } from './production-auth-canary-policy.mjs';

const endpoint = `https://${PRODUCTION_SUPABASE_PROJECT_REF}.supabase.co/functions/v1/request-early-access`;

// Both probes stop before input validation can invoke SQL. Never submit a
// syntactically valid person, bearer token, account ID, or production API key.
export async function verifyProductionEarlyAccess({ fetchImpl = globalThis.fetch } = {}) {
  for (const origin of [...PRODUCTION_SITE_ORIGINS, 'https://early-access-smoke.invalid']) {
    const allowed = PRODUCTION_SITE_ORIGINS.includes(origin);
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: '{}', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15_000),
      });
      if (response.status !== (allowed ? 400 : 403) || response.redirected
        || response.headers.get('cache-control') !== 'private, no-store'
        || response.headers.get('access-control-allow-origin') !== (allowed ? origin : null)
        || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) {
        throw new Error();
      }
    } catch {
      throw new Error('The non-mutating early-access protection smoke failed.');
    } finally {
      await response?.body?.cancel().catch(() => {});
    }
  }
  return { verified: true };
}

if (import.meta.url === (process.argv[1] ? pathToFileURL(process.argv[1]).href : '')) {
  try {
    await verifyProductionEarlyAccess();
    console.log('Verified early-access invalid-input, origin, and no-store guards without creating a request.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
