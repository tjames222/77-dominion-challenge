import assert from 'node:assert/strict';
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCredentialLifetime } from './production-database-credential-lifetime.mjs';
import { buildProductionOperationArguments, buildProductionOperationEnvironment, parseOperationArguments, requireProductionDatabaseUrl, runProductionDatabaseOperation } from './run-production-database-operation.mjs';

const ref = 'mimolwojppbtsbvtqwpo';
const url = `postgresql://cli_login_fixture.${ref}@aws-1-us-west-2.pooler.supabase.com:5432/postgres?sslmode=require&connect_timeout=10`;
const second = 1_000_000_000n;

test('only the three fixed production operations and exact flags are accepted', () => {
  const common = ['--profile=supabase', '--workdir=/fixture', '--output-format=text', '--agent=no'];
  for (const [operation, tail] of [
    ['history', ['migration', 'list', `--db-url=${url}`]],
    ['dry-run', ['--yes', 'db', 'push', `--db-url=${url}`, '--dry-run']],
    ['migrate', ['--yes', 'migration', 'up', `--db-url=${url}`]],
  ]) assert.deepEqual(buildProductionOperationArguments({ operation, databaseUrl: url, workdir: '/fixture' }), [...common, ...tail]);
  const args = ['--operation', 'history', '--credential-directory', '/credentials', '--supabase-home', '/home', '--workdir', '/work'];
  assert.equal(parseOperationArguments(args).operation, 'history');
  for (const extra of [['--sql', 'select 1'], ['--operation', 'migrate'], ['--command', 'psql']]) assert.throws(() => parseOperationArguments([...args, ...extra]));
  assert.throws(() => buildProductionOperationArguments({ operation: 'reset', databaseUrl: url, workdir: '/fixture' }));
});

test('URL validation preserves exact host, project, passwordless session mode and no arbitrary query', () => {
  assert.equal(requireProductionDatabaseUrl(url), url);
  for (const value of [url.replace(':5432', ':6543'), url.replace(ref, 'otherproject'), url.replace('cli_login_fixture.', 'postgres.'), url.replace('@', ':secret@'), url + '&options=-crole=superuser', url + '\n', url.replace('aws-1-us-west-2', 'aws-0-us-east-1')]) assert.throws(() => requireProductionDatabaseUrl(value));
});

test('child environment is a fixed allowlist without management tokens, proxies or ambient PG options', () => {
  const env = buildProductionOperationEnvironment({ passfilePath: '/credentials/database-passfile', runtimePath: '/usr/bin', supabaseHome: '/home' });
  assert.deepEqual(env, {
    CI: 'true', HOME: '/home', LANG: 'C.UTF-8', PATH: '/usr/bin', PGPASSFILE: '/credentials/database-passfile',
    SUPABASE_HOME: '/home', SUPABASE_NO_KEYRING: '1', SUPABASE_PROFILE: 'supabase', SUPABASE_TELEMETRY_DISABLED: '1', TMPDIR: '/home',
  });
});

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'production-fixed-operation-test-')));
  const credentialDirectory = path.join(root, 'credentials');
  const supabaseHome = path.join(root, 'home');
  const workdir = path.join(root, 'work');
  for (const directory of [credentialDirectory, supabaseHome, workdir]) await mkdir(directory, { mode: 0o700 });
  const lifetime = createCredentialLifetime({ projectRef: ref, issuedAtNs: 1000n * second, ttlSeconds: 300 });
  const files = {
    'credential-ready': ref, 'credential-deadline': JSON.stringify(lifetime), 'database-url': url,
    'database-passfile': `aws-1-us-west-2.pooler.supabase.com:5432:postgres:cli_login_fixture.${ref}:fixture\\:password\\\\only\n`,
  };
  for (const [name, data] of Object.entries(files)) await writeFile(path.join(credentialDirectory, name), data, { mode: 0o600 });
  return { root, credentialDirectory, supabaseHome, workdir, lifetime };
}

test('four private files launch only the selected fixed operation with the immutable deadline', async () => {
  const f = await fixture();
  try {
    const calls = [];
    await runProductionDatabaseOperation({ ...f, operation: 'migrate', monotonicNow: () => 1010n * second,
      environment: { PATH: '/usr/bin', SUPABASE_ACCESS_TOKEN: 'fixture-never-forward', PGOPTIONS: 'unsafe', HTTPS_PROXY: 'unsafe' },
      processRunner: async (...args) => { calls.push(args); return 0; },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'supabase');
    assert.deepEqual(calls[0][1], buildProductionOperationArguments({ operation: 'migrate', databaseUrl: url, workdir: f.workdir }));
    assert.equal(calls[0][2].deadlineNs, f.lifetime.deadlineNs);
    assert.equal(calls[0][2].env.SUPABASE_ACCESS_TOKEN, undefined);
    assert.equal(calls[0][2].env.PGOPTIONS, undefined);
    assert.equal(calls[0][2].env.HTTPS_PROXY, undefined);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('expiry or less than 120 usable seconds after ready cannot start an operation', async () => {
  for (const now of [1151n, 1270n]) {
    const f = await fixture();
    try {
      let called = false;
      await assert.rejects(() => runProductionDatabaseOperation({ ...f, operation: 'history', monotonicNow: () => now * second,
        environment: { PATH: '/usr/bin' }, processRunner: async () => { called = true; return 0; },
      }), { diagnosticCode: now === 1270n ? 'credential-lifetime-expired' : 'credential-lifetime-budget' });
      assert.equal(called, false);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test('expiry during execution cannot be reported as successful and does not remint or retry', async () => {
  const f = await fixture();
  try {
    let now = 1010n * second;
    let calls = 0;
    await assert.rejects(() => runProductionDatabaseOperation({ ...f, operation: 'dry-run', monotonicNow: () => now,
      environment: { PATH: '/usr/bin' }, processRunner: async () => { calls++; now = 1270n * second; return 0; },
    }), { diagnosticCode: 'credential-lifetime-expired' });
    assert.equal(calls, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('unready, world-readable, hardlinked and extra credential files are rejected before spawning', async () => {
  for (const mutate of [
    async (f) => writeFile(path.join(f.credentialDirectory, 'credential-ready'), 'wrong-project'),
    async (f) => chmod(path.join(f.credentialDirectory, 'database-passfile'), 0o644),
    async (f) => link(path.join(f.credentialDirectory, 'database-passfile'), path.join(f.root, 'hardlink')),
    async (f) => writeFile(path.join(f.credentialDirectory, 'unexpected'), ''),
    async (f) => writeFile(path.join(f.credentialDirectory, 'database-passfile'), (await readFile(path.join(f.credentialDirectory, 'database-passfile'), 'utf8')) + '*:*:*:*:injected\n'),
  ]) {
    const f = await fixture();
    try {
      await mutate(f);
      let called = false;
      await assert.rejects(() => runProductionDatabaseOperation({ ...f, operation: 'history', monotonicNow: () => 1010n * second,
        environment: { PATH: '/usr/bin' }, processRunner: async () => { called = true; return 0; },
      }));
      assert.equal(called, false);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});
