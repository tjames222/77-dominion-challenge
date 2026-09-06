#!/usr/bin/env node
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXISTING_SUPABASE_PROJECT_REF as PROJECT_REF, buildTemporaryLoginProbeEnvironment, requireCleanNodeRuntimeEnvironment } from './prepare-existing-supabase-cli-state.mjs';
import { MINIMUM_READY_BUDGET_SECONDS, remainingCredentialMilliseconds, runDeadlineProcess } from './production-database-credential-lifetime.mjs';

const FILES = ['credential-deadline', 'credential-ready', 'database-passfile', 'database-url'];
const OPERATIONS = ['history', 'dry-run', 'migrate'];

export function parseOperationArguments(args) {
  const names = { '--operation': 'operation', '--credential-directory': 'credentialDirectory', '--supabase-home': 'supabaseHome', '--workdir': 'workdir' };
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    assert(Object.hasOwn(names, args[index]), 'Invalid fixed database operation option');
    const name = names[args[index]];
    assert(name && !Object.hasOwn(result, name) && typeof args[index + 1] === 'string' && !args[index + 1].startsWith('--'), 'Invalid fixed database operation arguments');
    result[name] = args[index + 1];
  }
  assert.equal(Object.keys(result).length, 4);
  assert(OPERATIONS.includes(result.operation), 'Unsupported production database operation');
  return result;
}

export function requireProductionDatabaseUrl(value) {
  const url = new URL(value);
  const suffix = `.${PROJECT_REF}`;
  const role = url.username.slice(0, -suffix.length);
  assert(url.username.endsWith(suffix) && /^cli_login_[a-z0-9_]*$/u.test(role) && role.length <= 63);
  assert.equal(url.protocol, 'postgresql:');
  assert.equal(url.password, '');
  assert.equal(url.hostname, 'aws-1-us-west-2.pooler.supabase.com');
  assert.equal(url.port, '5432');
  assert.equal(url.pathname, '/postgres');
  assert.equal(url.search, '?sslmode=require&connect_timeout=10');
  assert.equal(url.hash, '');
  assert.equal(value, url.href, 'Database URL must be canonical');
  return value;
}

export function buildProductionOperationArguments({ operation, databaseUrl, workdir }) {
  assert(OPERATIONS.includes(operation));
  requireProductionDatabaseUrl(databaseUrl);
  assert(path.isAbsolute(workdir));
  const base = ['--profile=supabase', `--workdir=${workdir}`, '--output-format=text', '--agent=no'];
  if (operation === 'history') return [...base, 'migration', 'list', `--db-url=${databaseUrl}`];
  if (operation === 'dry-run') return [...base, '--yes', 'db', 'push', `--db-url=${databaseUrl}`, '--dry-run'];
  return [...base, '--yes', 'migration', 'up', `--db-url=${databaseUrl}`];
}

export function buildProductionOperationEnvironment({ passfilePath, runtimePath, supabaseHome }) {
  return { CI: 'true', ...buildTemporaryLoginProbeEnvironment({ passfilePath, runtimePath, supabaseHome }) };
}

async function requireDirectory(directory, privateDirectory) {
  assert(typeof directory === 'string' && path.isAbsolute(directory));
  assert.equal(directory, path.normalize(directory));
  assert.equal(await realpath(directory), directory);
  const stat = await lstat(directory);
  assert(stat.isDirectory() && !stat.isSymbolicLink());
  assert.equal(stat.uid, process.getuid());
  if (privateDirectory) assert.equal(stat.mode & 0o777, 0o700);
  else assert.equal(stat.mode & 0o022, 0);
}

async function privateFile(filePath) {
  const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    assert(stat.isFile() && stat.size <= 16_384);
    assert.equal(stat.nlink, 1);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(stat.uid, process.getuid());
    return await file.readFile('utf8');
  } finally { await file.close(); }
}

function requirePassfile(value, databaseUrl) {
  const url = new URL(databaseUrl);
  const prefix = `${url.hostname}:5432:postgres:${url.username}:`;
  assert(value.startsWith(prefix) && value.endsWith('\n'));
  const escapedPassword = value.slice(prefix.length, -1);
  assert(!/[\r\n\0]/u.test(escapedPassword));
  let password = '';
  for (let i = 0; i < escapedPassword.length; i += 1) {
    if (escapedPassword[i] === '\\') {
      i += 1;
      assert(['\\', ':'].includes(escapedPassword[i]));
    } else assert.notEqual(escapedPassword[i], ':');
    password += escapedPassword[i];
  }
  assert(password.length >= 16 && password.length <= 1024);
  assert(!/[\u0000-\u001f\u007f]/u.test(password) && password === password.trimEnd());
}

export async function runProductionDatabaseOperation({
  operation, credentialDirectory, supabaseHome, workdir,
  environment = process.env, monotonicNow = () => process.hrtime.bigint(), processRunner = runDeadlineProcess,
}) {
  requireCleanNodeRuntimeEnvironment(environment);
  assert(OPERATIONS.includes(operation));
  await requireDirectory(credentialDirectory, true);
  await requireDirectory(supabaseHome, true);
  await requireDirectory(workdir, false);
  assert.deepEqual((await readdir(credentialDirectory)).sort(), FILES);
  assert.equal(await privateFile(path.join(credentialDirectory, 'credential-ready')), PROJECT_REF);
  const lifetime = JSON.parse(await privateFile(path.join(credentialDirectory, 'credential-deadline')));
  remainingCredentialMilliseconds(lifetime, PROJECT_REF, monotonicNow());
  const databaseUrl = requireProductionDatabaseUrl(await privateFile(path.join(credentialDirectory, 'database-url')));
  const passfilePath = path.join(credentialDirectory, 'database-passfile');
  requirePassfile(await privateFile(passfilePath), databaseUrl);
  const args = buildProductionOperationArguments({ operation, databaseUrl, workdir });
  const env = buildProductionOperationEnvironment({ passfilePath, runtimePath: environment.PATH, supabaseHome });
  // Reading private files and preparing the invocation consumes the same budget.
  remainingCredentialMilliseconds(lifetime, PROJECT_REF, monotonicNow(), MINIMUM_READY_BUDGET_SECONDS);
  const status = await processRunner('supabase', args, {
    cwd: workdir, env, deadlineNs: lifetime.deadlineNs, monotonicNow,
  });
  assert.equal(status, 0, 'Fixed production database operation failed');
  remainingCredentialMilliseconds(lifetime, PROJECT_REF, monotonicNow());
}

if (import.meta.url === (process.argv[1] ? pathToFileURL(process.argv[1]).href : '')) {
  Promise.resolve().then(() => runProductionDatabaseOperation(parseOperationArguments(process.argv.slice(2)))).catch((error) => {
    const allowed = new Set(['credential-lifetime-contract', 'credential-lifetime-expired', 'credential-lifetime-budget', 'credential-operation-timeout', 'credential-operation-interrupted', 'executable-unavailable']);
    console.error(`Production database operation failed (${allowed.has(error?.diagnosticCode) ? error.diagnosticCode : 'fixed-operation-contract-or-exit'}); private details suppressed.`);
    process.exitCode = 1;
  });
}
