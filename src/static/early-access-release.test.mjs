import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { verifyProductionEarlyAccess } from '../../scripts/verify-production-early-access.mjs';
import { PRODUCTION_SITE_ORIGINS } from '../../scripts/production-auth-canary-policy.mjs';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const response = (origin, overrides = {}) => new Response('{}', {
  status: PRODUCTION_SITE_ORIGINS.includes(origin) ? 400 : 403,
  headers: { 'cache-control': 'private, no-store', 'content-type': 'application/json',
    ...(PRODUCTION_SITE_ORIGINS.includes(origin) ? { 'access-control-allow-origin': origin } : {}),
  }, ...overrides,
});
test('production intake smoke uses only fixed invalid input and no credentials', async () => {
  const calls = [];
  assert.deepEqual(await verifyProductionEarlyAccess({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return response(options.headers.Origin);
  } }), { verified: true });
  assert.equal(calls.length, 4);
  for (const { url, options } of calls) {
    assert.equal(url, 'https://mimolwojppbtsbvtqwpo.supabase.co/functions/v1/request-early-access');
    assert.equal(options.body, '{}');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    assert.deepEqual(Object.keys(options.headers).sort(), ['Content-Type', 'Origin']);
    assert.ok(options.signal instanceof AbortSignal);
  }
});
test('production intake smoke fails closed without exposing response bodies', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('private transport detail'); },
    async () => new Response('secret response', { status: 200 }),
    async () => new Response('secret response', { status: 400 }),
    async (_, options) => response(options.headers.Origin, { headers: { 'cache-control': 'public', 'content-type': 'application/json' } }),
  ]) {
    await assert.rejects(verifyProductionEarlyAccess({ fetchImpl }), /^Error: The non-mutating early-access protection smoke failed\.$/);
  }
});
test('early-access release deploys only its public intake and registers tests without altering existing access gates', () => {
  const workflow = read('.github/workflows/deploy.yml');
  assert.match(workflow, /supabase functions deploy request-early-access --project-ref "\$SUPABASE_PROJECT_REF" --no-verify-jwt/);
  assert.match(workflow, /node scripts\/verify-production-early-access\.mjs/);
  assert.match(read('supabase/config.toml'), /\[functions\.request-early-access\]\nverify_jwt = false/);
  assert.match(read('supabase/deno.json'), /functions\/request-early-access\/index_test\.ts/);
  assert.match(read('.github/workflows/ci.yml'), /pnpm run test:early-access-sql/);
  assert.match(workflow, /VITE_ENABLE_BILLING: "false"/);
  assert.match(workflow, /VITE_ENABLE_PUBLIC_SIGNUP: "false"/);
  const intake = read('supabase/functions/request-early-access/index.ts');
  assert.doesNotMatch(intake, /\.auth\.admin\.|inviteUser|createUser|generateLink|console\./);
});
