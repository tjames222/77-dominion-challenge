import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { build } from 'vite';

const apiPath = fileURLToPath(new URL('./api.js', import.meta.url));
const corePath = fileURLToPath(new URL('./auth-runtime-core.mjs', import.meta.url));
const environment = {
  PROD: true, DEV: false, VITE_ENABLE_MOCKS: 'false',
  VITE_ENABLE_PRODUCTION_CONNECTIONS: 'true', VITE_ENABLE_SUPABASE_AUTH_IN_MOCKS: 'false',
  VITE_SUPABASE_URL: 'https://runtime-fixture.invalid',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic_runtime_fixture',
};

// Compile the actual facade and core together. Only the provider constructor is
// replaced; the MFA guard, adapter, in-flight state, and all observers are real.
// The fixture never calls a provider, and no source functions are regex-extracted.
let artifactPromise;
async function artifact() {
  artifactPromise ||= build({
    configFile: false, logLevel: 'silent',
    define: Object.fromEntries(Object.entries(environment).map(([key, value]) => [`import.meta.env.${key}`, JSON.stringify(value)])),
    plugins: [{
      name: 'auth-runtime-identity-fixture',
      enforce: 'pre',
      resolveId(id) {
        if (id === 'runtime-fixture' || id.endsWith('/runtime-fixture')) return '\0runtime-fixture';
        if (id === '@supabase/supabase-js') return '\0runtime-provider';
      },
      load(id) {
        if (id === '\0runtime-provider') return 'export const createClient = (...args) => globalThis.__runtimeFixture.createClient(...args);';
        if (id === '\0runtime-fixture') return `
          import * as api from ${JSON.stringify(apiPath)};
          import * as core from ${JSON.stringify(corePath)};
          export const same = ['supabase', 'cancelMfaOperations', 'getMfaAuthAdapter', 'isLocalDemoMode']
            .every(name => api[name] === core[name]);
          export const client = api.supabase;
          export const adapter = api.getMfaAuthAdapter();
          export const scope = core.inflightActorReads;
          export const epoch = () => core.previewBadgeEpoch;
          export const invalidateOwner = core.invalidatePreviewBadgeOwner;
          export const mutate = core.invalidateReadsAroundMutation;
          export const subscribe = api.subscribeToAuthStateChanges;
          export const cancel = api.cancelMfaOperations;
        `;
      },
    }],
    build: { write: false, minify: false,
      lib: { entry: 'runtime-fixture', name: 'RuntimeFixture', formats: ['iife'] },
    },
  });
  const output = await artifactPromise;
  const outputs = Array.isArray(output) ? output : [output];
  const chunks = outputs.flatMap(item => item.output).filter(item => item.type === 'chunk');
  assert.equal(chunks.length, 1, 'The local module-identity fixture must be self-contained.');
  return chunks[0].code;
}

async function fixture() {
  const events = []; const authObservers = []; const windowListeners = new Map();
  const documentListeners = new Map(); const storage = new Map();
  const listen = (target, collection) => (event, callback) => {
    events.push(`${target}:${event}`);
    const listeners = collection.get(event) || [];
    listeners.push(callback); collection.set(event, listeners);
  };
  const auth = {
    mfa: {},
    getUser() { assert.fail('No canonical Auth request may run during initialization or an observer.'); },
    onAuthStateChange(callback) {
      events.push(`auth:${authObservers.length}`); authObservers.push(callback);
      return { data: { subscription: { unsubscribe() {} } } };
    },
  };
  const providerClient = { auth };
  const context = {
    URL, URLSearchParams, TextEncoder, AbortController, structuredClone,
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    fetch() { assert.fail('The module identity fixture must never issue a network request.'); },
    localStorage: { getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    window: { location: { hostname: 'runtime-fixture.invalid' },
      addEventListener: listen('window', windowListeners), removeEventListener() {} },
    document: { hidden: false, addEventListener: listen('document', documentListeners) },
    __runtimeFixture: { createClient(url, key, options) {
      events.push('createClient');
      assert.equal(url, environment.VITE_SUPABASE_URL);
      assert.equal(key, environment.VITE_SUPABASE_PUBLISHABLE_KEY);
      assert.equal(options.auth.storageKey, 'sb-runtime-fixture-auth-token');
      assert.equal(options.auth.persistSession, true);
      assert.equal(options.auth.autoRefreshToken, true);
      assert.equal(options.auth.detectSessionInUrl, true);
      assert.equal(options.auth.userStorage, undefined);
      assert.notEqual(options.auth.storage, context.localStorage, 'The guarded storage remains mandatory.');
      assert.notEqual(options.global.fetch, context.fetch, 'The guarded fetch remains mandatory.');
      return providerClient;
    } },
  };
  runInNewContext(await artifact(), context);
  return { runtime: context.RuntimeFixture, events, authObservers, windowListeners, documentListeners, providerClient };
}

const session = (sessionId = '11111111-1111-4111-8111-111111111111') => {
  const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const payload = Buffer.from(JSON.stringify({ sub: actorId, session_id: sessionId })).toString('base64url');
  return { user: { id: actorId }, access_token: `header.${payload}.synthetic` };
};

test('facade and direct core imports share exactly one guarded client, adapter and observer set', async () => {
  const f = await fixture();
  assert.equal(f.runtime.same, true);
  assert.equal(f.runtime.client, f.providerClient);
  assert.equal(typeof f.runtime.adapter.getState, 'function');
  assert.deepEqual(f.events, [
    'window:storage', 'window:pagehide', 'createClient',
    'auth:0', 'auth:1', 'auth:2',
    'window:storage', 'window:online', 'window:offline',
    'window:dominion:challenge-activation-updated', 'window:dominion:challenge-start-date-updated',
    'document:visibilitychange',
    'window:pagehide', 'window:storage', 'window:pagehide', 'window:storage',
  ]);
  assert.equal(f.authObservers.length, 3, 'Guard, adapter, then the synchronous in-flight/preview observer.');
  f.runtime.cancel();
  assert.equal(f.events.filter(value => value === 'createClient').length, 1);
});

test('the shared identity fence runs synchronously before UI observers without canonical Auth calls', async () => {
  const f = await fixture();
  const initial = session();
  for (const observe of f.authObservers) observe('INITIAL_SESSION', initial);
  const captured = f.runtime.epoch();
  const order = [];
  const observeAuth = f.runtime.scope.observeAuth;
  f.runtime.scope.observeAuth = (...args) => { order.push('fence'); return observeAuth(...args); };
  const stop = f.runtime.subscribe(({ event, sessionIdentity }) => {
    order.push('ui');
    assert.equal(event, 'TOKEN_REFRESHED');
    assert.match(sessionIdentity, /11111111-1111-4111-8111-111111111111$/);
    assert.equal(f.runtime.epoch(), captured + 1);
  });
  let release;
  const pending = f.runtime.scope.run({ actorId: initial.user.id, query: 'synthetic', version: 1 },
    () => new Promise(resolve => { release = resolve; }));
  const rejected = assert.rejects(pending, { code: 'STALE_ACTOR_READ' });
  await Promise.resolve();
  for (const observe of f.authObservers) observe('TOKEN_REFRESHED', initial);
  assert.deepEqual(order, ['fence', 'ui']);
  release({ privateValue: 'old epoch' });
  await rejected;
  stop();
});

test('direct core mutation and storage invalidation share live ownership state with facade listeners', async () => {
  const f = await fixture();
  const before = f.runtime.epoch();
  f.runtime.invalidateOwner();
  assert.equal(f.runtime.epoch(), before + 1);
  for (const callback of f.windowListeners.get('storage')) callback({ key: 'dominion:previewUserState' });
  assert.equal(f.runtime.epoch(), before + 1, 'Ordinary preview writes do not change identity.');
  for (const callback of f.windowListeners.get('storage')) callback({ key: 'dominion:user' });
  assert.equal(f.runtime.epoch(), before + 2, 'One identity event advances the shared epoch exactly once.');
  const calls = [];
  const invalidate = f.runtime.scope.invalidate;
  f.runtime.scope.invalidate = query => { calls.push(query); return invalidate(query); };
  await assert.rejects(f.runtime.mutate(async () => { calls.push('mutation'); throw new Error('synthetic failure'); }, 'target'), /synthetic failure/);
  assert.deepEqual(calls, ['target', 'mutation', 'target']);
});

test('the runtime core has no feature/facade dependency and the facade constructs no replacement runtime', () => {
  const core = readFileSync(corePath, 'utf8'); const api = readFileSync(apiPath, 'utf8');
  const dependencies = [...core.matchAll(/from '([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(dependencies, ['@supabase/supabase-js', './mfa-auth.mjs', './mfa-session-guard.mjs', './inflight-actor-reads.mjs', './preview-auth-runtime.mjs']);
  assert.doesNotMatch(api, /\b(?:createClient|createSupabaseMfaAdapter|createMfaSessionGuard|createInflightActorReads)\(/);
  assert.equal((core.match(/\bcreateClient\(/g) || []).length, 1);
  assert.equal((core.match(/supabase\?\.auth\.onAuthStateChange\(/g) || []).length, 1);
  assert.match(api, /export \{ supabase, cancelMfaOperations, getMfaAuthAdapter, isLocalDemoMode \}/);
});
