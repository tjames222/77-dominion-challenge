import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { verifyProductionEarlyAccessWorkers } from './verify-production-early-access-workers.mjs';
const denied = operation => assert.rejects(operation, error => error.message === 'The non-mutating Early Access worker protection smoke failed.');
const answer = method => new Response('{}', { status: method === 'POST' ? 401 : 405, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
test('worker smoke targets only fixed existing-project endpoints with unusable credentials', async () => {
  const calls = [];
  assert.deepEqual(await verifyProductionEarlyAccessWorkers({ fetchImpl: async (url, init) => { calls.push({ url, init }); return answer(init.method); } }), { verified: true, jobsClaimed: false });
  assert.equal(calls.length, 4);
  for (const { url, init } of calls) {
    assert.match(url, /^https:\/\/mimolwojppbtsbvtqwpo\.supabase\.co\/functions\/v1\/process-early-access-(feedback|invitations)$/);
    assert.equal(init.headers['x-dominion-worker-key'].length < 32, true);
    assert.equal(init.headers.Authorization, undefined); assert.equal(init.body, init.method === 'POST' ? '{}' : undefined);
    assert.equal(init.cache, 'no-store'); assert.equal(init.redirect, 'error'); assert(init.signal instanceof AbortSignal);
  }
});
test('worker smoke rejects wrong status, CORS, caching, content-type and redirect without leaking response', async () => {
  for (const kind of ['status', 'cors', 'cache', 'type', 'redirect', 'network']) {
    await denied(() => verifyProductionEarlyAccessWorkers({ fetchImpl: async (_url, init) => {
      if (kind === 'network') throw new Error('private_response');
      const response = kind === 'status' ? new Response('private_response') : answer(init.method);
      if (kind === 'cors') response.headers.set('Access-Control-Allow-Origin', '*');
      if (kind === 'cache') response.headers.delete('Cache-Control');
      if (kind === 'type') response.headers.set('Content-Type', 'text/html');
      if (kind === 'redirect') Object.defineProperty(response, 'redirected', { value: true });
      return response;
    } }));
  }
});
test('full production release deploys both workers and checks non-mutating guards afterward', async () => {
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const backend = workflow.split(/\n  backend:\n/)[1].split(/\n  [a-z][a-z0-9_-]*:\n/)[0];
  assert(backend.includes("if: inputs.release_scope == 'full'"));
  assert(backend.includes('environment: production'));
  for (const worker of ['process-early-access-feedback', 'process-early-access-invitations']) assert(backend.includes(`supabase functions deploy ${worker} --project-ref "$SUPABASE_PROJECT_REF" --no-verify-jwt`));
  assert(backend.indexOf('node scripts/verify-production-early-access-workers.mjs') > backend.indexOf('supabase functions deploy process-early-access-invitations'));
  assert(backend.indexOf('node scripts/verify-early-access-runtime-config.mjs') < backend.indexOf('supabase secrets set'));
});
