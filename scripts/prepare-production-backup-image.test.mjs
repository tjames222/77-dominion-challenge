import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { BACKUP_IMAGE_INSPECT_TIMEOUT_MS, BACKUP_IMAGE_OUTPUT_LIMIT,
  BACKUP_IMAGE_PULL_TIMEOUT_MS, prepareProductionBackupImage, PRODUCTION_BACKUP_IMAGE as pin } from './prepare-production-backup-image.mjs';
import { classifyBackupFailure } from './free-production-backup.mjs';
import { POSTGRES_IMAGE } from './production-backup-public-contract.mjs';
import { CI_FIXTURE_IMAGES } from './prepare-ci-fixture-images.mjs';

const sentinel = 'SYNTHETIC_PRIVATE_DOCKER_DIAGNOSTIC';
const message = 'The exact production backup image could not be verified.';
const record = patch => ({ Id: pin.config, Os: 'linux', Architecture: 'amd64', RepoDigests: [pin.reference], ...patch });
const answer = (stdout = '', status = 0, stderr = '') => ({ status, stdout, stderr });
const missing = () => answer('', 1, `Error response from daemon: No such image: ${pin.reference}\n`);
const environment = () => ({ GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main',
  GITHUB_REPOSITORY: 'tjames222/77-dominion-challenge', PATH: '/usr/bin:/bin', HOME: '/home/runner' });
function fixture({ cached = false, intercept } = {}) {
  const calls = []; let image = cached ? record() : null;
  const run = (args, options) => {
    calls.push({ args: [...args], options });
    const replacement = intercept?.(args, { set: value => { image = value; }, calls });
    if (replacement !== undefined) return replacement;
    if (args[0] === 'context' && args[1] === 'show') return answer('default\n');
    if (args[0] === 'context' && args[1] === 'inspect') return answer('unix:///var/run/docker.sock\n');
    if (args[0] === 'info') return answer('linux/x86_64\n');
    if (args[0] === 'image' && args[1] === 'inspect') return image ? answer(JSON.stringify(image)) : missing();
    if (args[0] === 'pull') { image = record(); return answer(pin.config + '\n'); }
    assert.fail('Unexpected Docker operation');
  };
  return { calls, options: { env: environment(), platform: 'linux', arch: 'x64', run } };
}
function reject(options, code) {
  assert.throws(() => prepareProductionBackupImage(options), error => {
    assert.equal(error.message, message);
    assert.equal(error.cause, undefined);
    assert.equal(error.diagnosticCode, code);
    assert.equal(classifyBackupFailure(error), code);
    assert.equal(JSON.stringify(error).includes(sentinel), false);
    return true;
  });
}
const pulls = f => f.calls.filter(call => call.args[0] === 'pull');
const inspectCalls = f => f.calls.filter(call => call.args[0] === 'image');

test('one official immutable PostgreSQL manifest/config matches existing reviewed pins without changing public contract', () => {
  assert.ok(Object.isFrozen(pin));
  assert.deepEqual(pin, {
    reference: 'ghcr.io/supabase/postgres@sha256:ca61fd22821732cdf5c687051d39b801e3d89dc0dcfc96ca202239eb26e4b732',
    config: 'sha256:b808f667e8d3a79f96befd972899ea5ca91179495a89e708863a8bfbec4a762c', platform: 'linux/amd64',
  });
  assert.equal(pin.reference, `ghcr.io/supabase/postgres@${CI_FIXTURE_IMAGES[0].manifest}`);
  assert.equal(pin.config, CI_FIXTURE_IMAGES[0].config);
  assert.equal(POSTGRES_IMAGE, 'public.ecr.aws/supabase/postgres:17.6.1.141');
});

test('correct immutable cached image returns only verified ID without pull, retag, containers or deletion', () => {
  const f = fixture({ cached: true });
  assert.equal(prepareProductionBackupImage(f.options), pin.config);
  assert.deepEqual(f.calls.map(call => call.args), [
    ['context', 'show'], ['context', 'inspect', 'default', '--format', '{{.Endpoints.docker.Host}}'],
    ['info', '--format', '{{.OSType}}/{{.Architecture}}'],
    ['image', 'inspect', pin.reference, '--format', '{{json .}}'],
  ]);
});

test('only exact absence permits one bounded immutable pull followed by complete identity verification', () => {
  const f = fixture();
  assert.equal(prepareProductionBackupImage(f.options), pin.config);
  assert.deepEqual(pulls(f).map(call => call.args), [['pull', '--platform', 'linux/amd64', '--quiet', pin.reference]]);
  assert.equal(inspectCalls(f).length, 2);
  assert.equal(f.calls.length, 6);
  assert.ok(f.calls.every(call => !call.args.includes('tag') && !call.args.includes('run') && !call.args.includes('rm')));
});

test('production Actions/main/repository and native platform are required before any Docker access', () => {
  for (const patch of [{ env: {} }, { env: { ...environment(), GITHUB_ACTIONS: 'false' } },
    { env: { ...environment(), GITHUB_REF: 'refs/heads/develop' } },
    { env: { ...environment(), GITHUB_REPOSITORY: 'other/repository' } },
    { platform: 'darwin' }, { platform: 'win32' }, { arch: 'arm64' }, { run: null },
    { env: { ...environment(), PATH: '' } }, { env: { ...environment(), PATH: 'x'.repeat(16385) } },
    { env: { ...environment(), PATH: '/bin\0bad' } }, { env: { ...environment(), HOME: 'relative' } },
    { env: { ...environment(), HOME: '/' + 'x'.repeat(4096) } }, { env: { ...environment(), HOME: '/bad\0path' } }]) {
    const f = fixture(); reject({ ...f.options, ...patch }, 'backup-image-context'); assert.equal(f.calls.length, 0);
  }
  reject(null, 'backup-image-context');
  reject({ get env() { throw new Error(sentinel); } }, 'backup-image-context');
});

test('only the default local Unix Docker context is accepted, with no context switch or endpoint override', () => {
  for (const [part, value] of [['show', 'remote'], ['show', 'default\nremote'], ['inspect', 'tcp://example.test:2375'],
    ['inspect', 'unix:///other/docker.sock'], ['inspect', 'ssh://host'], ['inspect', '']]) {
    const f = fixture({ intercept: args => args[0] === 'context' && args[1] === part ? answer(value) : undefined });
    reject(f.options, 'backup-image-context'); assert.equal(pulls(f).length, 0); assert.equal(inspectCalls(f).length, 0);
  }
});

test('daemon must report native Linux amd64 before image inspection or download', () => {
  for (const value of ['linux/aarch64', 'windows/amd64', 'linux/arm64', '', 'linux/amd64\nother']) {
    const f = fixture({ intercept: args => args[0] === 'info' ? answer(value) : undefined });
    reject(f.options, 'backup-image-daemon'); assert.equal(inspectCalls(f).length, 0); assert.equal(pulls(f).length, 0);
  }
  const f = fixture({ cached: true, intercept: args => args[0] === 'info' ? answer('linux/amd64') : undefined });
  assert.equal(prepareProductionBackupImage(f.options), pin.config);
});

test('every Docker subprocess uses fixed byte/time limits, no stdin and a credential-free environment', () => {
  const f = fixture();
  Object.assign(f.options.env, { SUPABASE_ACCESS_TOKEN: sentinel, DOCKER_HOST: 'tcp://bad:2375', DOCKER_CONTEXT: 'foreign',
    DOCKER_CONFIG: '/private', NODE_OPTIONS: '--require=bad', HTTP_PROXY: sentinel, GH_TOKEN: sentinel, LANG: sentinel });
  assert.equal(prepareProductionBackupImage(f.options), pin.config);
  assert.equal(BACKUP_IMAGE_OUTPUT_LIMIT, 524288);
  assert.equal(BACKUP_IMAGE_INSPECT_TIMEOUT_MS, 15000);
  assert.equal(BACKUP_IMAGE_PULL_TIMEOUT_MS, 300000);
  for (const { args, options } of f.calls) {
    assert.deepEqual(options.env, { PATH: '/usr/bin:/bin', HOME: '/home/runner', LANG: 'C.UTF-8' });
    assert.ok(Object.isFrozen(options.env));
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(options.encoding, 'utf8'); assert.equal(options.killSignal, 'SIGKILL');
    assert.equal(options.maxBuffer, 524288); assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, args[0] === 'pull' ? 300000 : 15000);
  }
});

test('runtime options cannot select a registry, image, platform, timeout, fallback or extra service', () => {
  const f = fixture();
  assert.equal(prepareProductionBackupImage({ ...f.options, reference: 'evil:latest', image: 'evil',
    dockerHost: 'tcp://evil', timeout: 0, maxBuffer: Infinity, fallback: true, images: ['gotrue'] }), pin.config);
  assert.equal(pulls(f).length, 1);
  assert.deepEqual(pulls(f)[0].args, ['pull', '--platform', 'linux/amd64', '--quiet', pin.reference]);
});

test('foreign config, OS, architecture or missing/foreign RepoDigests fail before any cache mutation', () => {
  for (const patch of [{ Id: `sha256:${'0'.repeat(64)}` }, { Id: null }, { Os: 'windows' }, { Architecture: 'arm64' },
    { RepoDigests: undefined }, { RepoDigests: null }, { RepoDigests: [] }, { RepoDigests: [pin.config] },
    { RepoDigests: [pin.reference.replace('ghcr.io', 'evil.test')] }, { RepoDigests: [pin.reference + 'x'] },
    { RepoDigests: [pin.reference, 1] }, { RepoDigests: [pin.reference, 'x'.repeat(257)] },
    { RepoDigests: Array(17).fill(pin.reference) }]) {
    const f = fixture({ intercept: args => args[1] === 'inspect' && args[0] === 'image' ? answer(JSON.stringify(record(patch))) : undefined });
    reject(f.options, 'backup-image-identity'); assert.equal(pulls(f).length, 0);
  }
});

test('a same-ID alternate digest alone is not trusted; known exact digest alongside other bounded repo associations is valid', () => {
  const f = fixture({ cached: true, intercept: args => args[0] === 'image' ? answer(JSON.stringify(record({
    RepoDigests: [pin.reference, `public.ecr.aws/supabase/postgres@${pin.reference.split('@')[1]}`],
  }))) : undefined });
  assert.equal(prepareProductionBackupImage(f.options), pin.config); assert.equal(pulls(f).length, 0);
});

test('malformed inspection JSON cannot be mistaken for a missing image', () => {
  for (const value of ['', '{', 'not-json', '{} trailing', 'null', '[]', '1', 'true', '"image"', '{}']) {
    const f = fixture({ intercept: args => args[0] === 'image' ? answer(value) : undefined });
    reject(f.options, ['', '{', 'not-json', '{} trailing'].includes(value) ? 'backup-image-inspect' : 'backup-image-identity');
    assert.equal(pulls(f).length, 0);
  }
});

test('only exact missing-image stderr, status one and blank stdout allow a pull', () => {
  for (const value of [answer('', 1, sentinel), answer('', 1, 'Cannot connect to Docker daemon'),
    answer('[]', 1, missing().stderr), answer('', 2, missing().stderr), answer('', 0, missing().stderr),
    answer('', 1, missing().stderr + sentinel), answer('', 1, missing().stderr.replace(pin.reference, 'other')),
    answer('', 1, 'no such image'), answer('', 1, `Error: No such image: ${pin.reference}`)]) {
    const f = fixture({ intercept: args => args[0] === 'image' ? value : undefined });
    reject(f.options, 'backup-image-inspect'); assert.equal(pulls(f).length, 0);
  }
});

test('nonzero pull, throw, timeout, signal or spawn error is terminal without fallback/retry/inspection', () => {
  for (const value of [answer(sentinel, 1, sentinel), { ...answer(), status: null, signal: 'SIGKILL' },
    { ...answer(), error: Object.assign(new Error(sentinel), { code: 'ETIMEDOUT' }) },
    { ...answer(), error: Object.assign(new Error(sentinel), { code: 'ENOENT' }) },
    { ...answer(), status: -1 }, null, undefined]) {
    const f = fixture({ intercept: args => {
      if (args[0] !== 'pull') return undefined;
      if (value === undefined) throw new Error(sentinel);
      return value;
    } });
    reject(f.options, 'backup-image-pull'); assert.equal(pulls(f).length, 1); assert.equal(inspectCalls(f).length, 1);
  }
});

test('post-pull absence, parse failure or substituted identity fails without a second pull', () => {
  for (const replacement of [missing(), answer('broken'), answer(JSON.stringify(record({ Id: `sha256:${'0'.repeat(64)}` }))),
    answer(JSON.stringify(record({ RepoDigests: [] })))]) {
    let count = 0;
    const f = fixture({ intercept: args => args[0] === 'image' && ++count === 2 ? replacement : undefined });
    reject(f.options, replacement.status === 1 || replacement.stdout === 'broken' ? 'backup-image-inspect' : 'backup-image-identity');
    assert.equal(pulls(f).length, 1); assert.equal(inspectCalls(f).length, 2);
  }
});

test('invalid runner output, oversized bytes and late/error results fail at each fixed stage without revealing data', () => {
  const stages = [
    [args => args[0] === 'context' && args[1] === 'show', 'backup-image-context'],
    [args => args[0] === 'info', 'backup-image-daemon'],
    [args => args[0] === 'image', 'backup-image-inspect'],
    [args => args[0] === 'pull', 'backup-image-pull'],
  ];
  const invalid = [null, [], Promise.resolve(answer()), { ...answer(), status: '0' },
    { ...answer(), stdout: Buffer.from(sentinel) }, { ...answer(), stderr: null },
    { ...answer(), signal: 'SIGTERM' }, { ...answer(), error: new Error(sentinel) },
    answer('x'.repeat(BACKUP_IMAGE_OUTPUT_LIMIT + 1)), answer('', 0, 'x'.repeat(BACKUP_IMAGE_OUTPUT_LIMIT + 1)),
    answer('é'.repeat(BACKUP_IMAGE_OUTPUT_LIMIT / 2 + 1)),
    { get status() { throw new Error(sentinel); } }];
  for (const [matches, code] of stages) for (const value of invalid) {
    const f = fixture({ intercept: args => matches(args) ? value : undefined });
    reject(f.options, code); assert.ok(pulls(f).length <= 1);
  }
});

test('exact byte cap is accepted only when remaining valid JSON and identity checks pass', () => {
  const json = JSON.stringify(record());
  const padded = json + ' '.repeat(BACKUP_IMAGE_OUTPUT_LIMIT - Buffer.byteLength(json));
  const f = fixture({ cached: true, intercept: args => args[0] === 'image' ? answer(padded) : undefined });
  assert.equal(prepareProductionBackupImage(f.options), pin.config);
});

test('image verification precedes minting; both containers retain verified ID and pull-never, with unchanged public image contract', () => {
  const source = readFileSync(new URL('./free-production-backup.mjs', import.meta.url), 'utf8');
  const beginning = source.indexOf('export async function runBackup()');
  const preparation = source.indexOf('const imageId = prepareProductionBackupImage();', beginning);
  const mint = source.indexOf('await prepareProductionSupabaseDatabaseCredentials(', beginning);
  assert.ok(preparation > beginning && preparation < mint);
  assert.ok(source.indexOf("stage('backup-image');", beginning) < preparation);
  assert.ok(source.indexOf('verifyPost73ReleaseSources({', beginning) < preparation);
  assert.equal((source.match(/prepareProductionBackupImage\(\)/g) || []).length, 1);
  assert.equal((source.match(/'--pull', 'never'/g) || []).length, 2);
  assert.match(source, /'--entrypoint', 'sleep', imageId, '1800'/);
  assert.match(source, /'--entrypoint', 'bash', imageId, '\/startup\.sh'/);
  assert.match(source, /postgresImage: POSTGRES_IMAGE, postgresImageId: imageId/);
  assert.doesNotMatch(source, /command\('docker', \['pull'/);
});

test('helper has no provider/database/credential access, Docker login/tag/run/remove path, CLI auto-run or diagnostic logging', () => {
  const source = readFileSync(new URL('./prepare-production-backup-image.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /SUPABASE_ACCESS_TOKEN|WORKER_SECRET|PRIVATE_KEY|fetch\(|node:fs|console\.|process\.argv/);
  assert.doesNotMatch(source, /\['(?:login|logout|run|exec|rm|rmi)'|\['image', '(?:tag|rm|prune)'/);
  assert.equal((source.match(/spawnSync\('docker'/g) || []).length, 1);
  assert.equal((source.match(/invoke\(\['pull'/g) || []).length, 1);
});

test('protected backup and ordinary CI run the offline helper tests before any image or credential acquisition', () => {
  const workflow = readFileSync(new URL('../.github/workflows/production-backup.yml', import.meta.url), 'utf8');
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const tests = 'scripts/prepare-production-backup-image.test.mjs';
  assert.equal((workflow.match(/scripts\/prepare-production-backup-image\.test\.mjs/g) || []).length, 1);
  assert.ok(workflow.indexOf(tests) < workflow.indexOf('Capture and rehearse restore'));
  assert.ok(packageJson.scripts['test:free-production-backup'].includes(tests));
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /GITHUB_REPOSITORY="\$GITHUB_REPOSITORY"/);
  assert.doesNotMatch(workflow, /docker login|GHCR_TOKEN|GITHUB_TOKEN:|CI=true|prepare-ci-fixture-images\.mjs/);
});
