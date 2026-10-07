import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CI_FIXTURE_IMAGES } from './prepare-ci-fixture-images.mjs';
import { prepareCiCronLint, PREPARE_CI_CRON_LINT_SQL, CLEANUP_CI_CRON_LINT_SQL } from './prepare-ci-cron-lint.mjs';

function fixture({ record = {}, status = 0 } = {}) {
  const calls = [];
  const run = (args, input) => {
    calls.push({ args, input });
    if (args[0] === 'inspect') return { status: 0, stdout: JSON.stringify({
      id: 'a'.repeat(64), name: '/supabase_db_77-dominion-challenge', running: true,
      image: CI_FIXTURE_IMAGES[0].config, imageRef: 'ghcr.io/supabase/postgres:17.6.1.141', ...record,
    }) };
    return { status };
  };
  return { calls, options: { mode: '--prepare', env: { CI: 'true', GITHUB_ACTIONS: 'true',
    SUPABASE_DB_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' }, platform: 'linux', arch: 'x64', run } };
}

test('rejects non-CI, non-native, hosted and unknown operation inputs before Docker access', () => {
  for (const patch of [{ mode: 'anything' }, { platform: 'darwin' }, { arch: 'arm64' },
    { env: {} }, { env: { CI: 'true', GITHUB_ACTIONS: 'true', SUPABASE_DB_URL: 'postgresql://hosted/postgres' } }]) {
    const f = fixture(); assert.throws(() => prepareCiCronLint({ ...f.options, ...patch })); assert.equal(f.calls.length, 0);
  }
});
test('rejects foreign container, image, version and stopped runtime without executing SQL', () => {
  for (const record of [{ id: 'invalid' }, { name: '/other' }, { running: false },
    { image: `sha256:${'0'.repeat(64)}` }, { imageRef: 'ghcr.io/supabase/postgres:17.6.1.143' }]) {
    const f = fixture({ record }); assert.throws(() => prepareCiCronLint(f.options)); assert.equal(f.calls.length, 1);
  }
});
test('setup and cleanup execute only fixed SQL in the inspected container through its local socket', () => {
  for (const [mode, sql] of [['--prepare', PREPARE_CI_CRON_LINT_SQL], ['--cleanup', CLEANUP_CI_CRON_LINT_SQL]]) {
    const f = fixture(); prepareCiCronLint({ ...f.options, mode });
    assert.equal(f.calls.length, 2); assert.equal(f.calls[1].input, sql);
    assert.deepEqual(f.calls[1].args, ['exec', '-i', 'a'.repeat(64), 'psql', '--no-psqlrc', '--quiet',
      '--set', 'ON_ERROR_STOP=1', '--host', '/var/run/postgresql', '--port', '5432', '--username', 'postgres', '--dbname', 'postgres']);
    assert.match(sql, /current_setting\('server_version_num'\) <> '170006'/);
    assert.match(sql, /exists \(select 1 from cron\.job\)/);
    assert.match(sql, /exists \(select 1 from cron\.job_run_details\)/);
    assert.doesNotMatch(sql, /cron\.schedule|\bcascade\b|\bdelete\b|\btruncate\b|\bgrant\b/i);
  }
  assert.match(PREPARE_CI_CRON_LINT_SQL, /create extension pg_cron with schema pg_catalog;/);
  assert.match(CLEANUP_CI_CRON_LINT_SQL, /obj_description.*pg_extension/);
  assert.match(CLEANUP_CI_CRON_LINT_SQL, /drop extension pg_cron;/);
});
test('failed SQL remains a hard error without retry or altered lint settings', () => {
  const f = fixture({ status: 1 }); assert.throws(() => prepareCiCronLint(f.options)); assert.equal(f.calls.length, 2);
});
test('CI scopes the owned extension around the unchanged full strict lint and makes cleanup failure fatal', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(ci, /node --test scripts\/prepare-ci-cron-lint\.test\.mjs/);
  assert.match(ci, /node scripts\/prepare-ci-cron-lint\.mjs --prepare\n[\s\S]*lint_status=\$\?\n[\s\S]*trap - EXIT\n[\s\S]*if ! node scripts\/prepare-ci-cron-lint\.mjs --cleanup; then\n\s+exit 1\n[\s\S]*exit "\$lint_status"\n[\s\S]*trap cleanup_cron_lint EXIT\n\s+supabase db lint --local --schema public,private --level warning --fail-on error\n/);
  assert.equal((ci.match(/supabase db lint --local --schema public,private --level warning --fail-on error/g) || []).length, 1);
  const source = readFileSync(new URL('./prepare-ci-cron-lint.mjs', import.meta.url), 'utf8');
  assert.match(source, /'--host', 'unix:\/\/\/var\/run\/docker\.sock'/);
  assert.doesNotMatch(source, /process\.env\.(?:DOCKER|PG|SUPABASE_ACCESS_TOKEN)/);
});
test('actual CI Bash body preserves lint failure, requires cleanup success and never cleans after failed setup', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const matched = ci.match(/      - name: Lint canonical application SQL\n        run: \|\n((?:          .*\n)+)/);
  assert.ok(matched);
  const body = matched[1].replace(/^          /gm, '');
  for (const [prepare, lint, cleanup, status, output] of [
    [0, 0, 0, 0, 'prepare\nlint\ncleanup\n'],
    [0, 17, 0, 17, 'prepare\nlint\ncleanup\n'],
    [0, 0, 23, 1, 'prepare\nlint\ncleanup\n'],
    [0, 17, 23, 1, 'prepare\nlint\ncleanup\n'],
    [31, 0, 0, 31, 'prepare\n'],
  ]) {
    const result = spawnSync('bash', ['-e', '-c', `
node() {
  if [ "$2" = "--prepare" ]; then printf 'prepare\\n'; return ${prepare}; fi
  if [ "$2" = "--cleanup" ]; then printf 'cleanup\\n'; return ${cleanup}; fi
  return 99
}
supabase() { printf 'lint\\n'; return ${lint}; }
${body}`], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, status, result.stderr);
    assert.equal(result.stdout, output);
  }
});
