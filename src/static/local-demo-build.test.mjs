import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'vite';

const corePath = fileURLToPath(new URL('./auth-runtime-core.mjs', import.meta.url));
const apiPath = fileURLToPath(new URL('./api.js', import.meta.url));

// Compile the real core rather than duplicating its flag parser in the test.
// No provider request is possible; only the existing constructor is simulated.
async function compiledCore({ dev, flag, hybrid }) {
  const environment = {
    DEV: dev, PROD: !dev, VITE_ENABLE_MOCKS: flag,
    VITE_ENABLE_PRODUCTION_CONNECTIONS: 'true',
    VITE_ENABLE_SUPABASE_AUTH_IN_MOCKS: String(hybrid),
    VITE_SUPABASE_URL: 'https://local-demo-fixture.invalid',
    VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic_fixture',
    VITE_SUPABASE_ANON_KEY: '',
  };
  const output = await build({ configFile: false, logLevel: 'silent',
    define: Object.fromEntries(Object.entries(environment).map(([key, value]) =>
      [`import.meta.env.${key}`, JSON.stringify(value) ?? 'undefined'])),
    plugins: [{ name: 'local-demo-flag-fixture', enforce: 'pre',
      resolveId(id) {
        if (id === 'local-demo-fixture' || id.endsWith('/local-demo-fixture')) return '\0local-demo-fixture';
        if (id === '@supabase/supabase-js') return '\0local-demo-provider';
      },
      load(id) {
        if (id === '\0local-demo-provider') return 'export const createClient = () => globalThis.__provider();';
        if (id === '\0local-demo-fixture') return `
          import { BUILD_SUPPORTS_LOCAL_DEMO, ENABLE_MOCKS, isLocalDemoMode,
            usesSupabaseAuthentication, isHybridAuthPreview } from ${JSON.stringify(corePath)};
          export function snapshot() { return {
            buildSupports: BUILD_SUPPORTS_LOCAL_DEMO, mocks: ENABLE_MOCKS,
            original: isLocalDemoMode(), guarded: BUILD_SUPPORTS_LOCAL_DEMO && isLocalDemoMode(),
            authentication: usesSupabaseAuthentication(), hybrid: isHybridAuthPreview(),
          }; }
        `;
      },
    }],
    build: { write: false, minify: false,
      lib: { entry: 'local-demo-fixture', name: 'LocalDemoFixture', formats: ['iife'] } },
  });
  const chunks = [output].flat().flatMap(bundle => bundle.output).filter(asset => asset.type === 'chunk');
  assert.equal(chunks.length, 1);
  return chunks[0].code;
}

function execute(code, hostname) {
  let clients = 0;
  const context = {
    URL, URLSearchParams, TextEncoder, AbortController, structuredClone,
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    fetch() { assert.fail('Flag-matrix tests cannot make provider requests.'); },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    document: { hidden: false, addEventListener() {} },
    __provider() {
      clients += 1;
      return { auth: { mfa: {}, onAuthStateChange() {
        return { data: { subscription: { unsubscribe() {} } } };
      } } };
    },
  };
  if (hostname !== null) context.window = { location: { hostname }, addEventListener() {}, removeEventListener() {} };
  runInNewContext(code, context);
  return { snapshot: context.LocalDemoFixture.snapshot(), clients };
}

test('static preview pruning preserves DEV, hybrid, flag-parser and non-browser semantics', async () => {
  const flags = ['false', 'true', undefined, '', ' FALSE ', ' TRUE ', 'True', false, true];
  const hosts = ['localhost', '127.0.0.1', '::1', 'dominion-fixture.invalid', null];
  for (const dev of [false, true]) for (const flag of flags) for (const hybrid of [false, true]) {
    const code = await compiledCore({ dev, flag, hybrid });
    const enabled = String(flag || '').trim().toLowerCase() === 'true';
    for (const hostname of hosts) {
      const label = JSON.stringify({ dev, flag, hybrid, hostname });
      const { snapshot, clients } = execute(code, hostname);
      const expectedLocal = hostname !== null && (enabled || (dev && hosts.slice(0, 3).includes(hostname)));
      const expectedClient = dev ? enabled && hybrid : !enabled;
      const expectedAuthentication = expectedClient && (!expectedLocal || (enabled && dev && hybrid));
      assert.equal(snapshot.original, expectedLocal, label);
      assert.equal(snapshot.guarded, snapshot.original, label);
      assert.equal(snapshot.mocks, enabled, label);
      assert.equal(snapshot.buildSupports, dev || flag !== 'false', label);
      assert.equal(snapshot.authentication, expectedAuthentication, label);
      assert.equal(snapshot.hybrid, expectedLocal && expectedAuthentication, label);
      assert.equal(clients, Number(expectedClient), label);
    }
  }
});

test('every facade demo decision uses the conservative build guard', () => {
  const api = readFileSync(apiPath, 'utf8');
  const calls = [...api.matchAll(/isLocalDemoMode\(\)/g)];
  assert.ok(calls.length >= 80, 'The whole existing facade is covered, not just a measured route.');
  for (const { index } of calls) {
    assert.ok(api.slice(0, index).endsWith('BUILD_SUPPORTS_LOCAL_DEMO && '), `unguarded facade call at ${index}`);
  }
});
