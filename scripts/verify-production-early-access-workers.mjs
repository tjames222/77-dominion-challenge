import { pathToFileURL } from 'node:url';
import { PRODUCTION_SUPABASE_PROJECT_REF } from './production-auth-canary-policy.mjs';
export async function verifyProductionEarlyAccessWorkers({ fetchImpl = globalThis.fetch } = {}) {
  for (const worker of ['process-early-access-feedback', 'process-early-access-invitations']) {
    for (const method of ['GET', 'POST']) {
      let response;
      try {
        response = await fetchImpl(`https://${PRODUCTION_SUPABASE_PROJECT_REF}.supabase.co/functions/v1/${worker}`, {
          method, headers: { 'Content-Type': 'application/json', 'x-dominion-worker-key': 'intentionally-invalid-smoke-key' },
          ...(method === 'POST' ? { body: '{}' } : {}), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000),
        });
        if (response.status !== (method === 'POST' ? 401 : 405) || response.redirected
          || response.headers.get('cache-control') !== 'private, no-store'
          || response.headers.get('access-control-allow-origin') !== null
          || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) throw new Error();
      } catch { throw new Error('The non-mutating Early Access worker protection smoke failed.'); }
      finally { await response?.body?.cancel().catch(() => {}); }
    }
  }
  return Object.freeze({ verified: true, jobsClaimed: false });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await verifyProductionEarlyAccessWorkers(); console.log('Verified Early Access worker method/auth guards without claiming jobs or sending messages.'); }
  catch { console.error('The non-mutating Early Access worker protection smoke failed.'); process.exitCode = 1; }
}
