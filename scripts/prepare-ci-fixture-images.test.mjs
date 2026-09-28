import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CI_FIXTURE_IMAGES, prepareCiFixtureImages } from './prepare-ci-fixture-images.mjs';
const record = pin => ({ Id: pin.config, Os: 'linux', Architecture: 'amd64' });
const target = pin => `public.ecr.aws/supabase/${pin.name}:${pin.version}`;
const source = pin => `ghcr.io/supabase/${pin.name}@${pin.manifest}`;
function fixture({ cached = false, mirror = false, intercept } = {}) {
  const calls = []; const cache = new Map();
  for (const pin of CI_FIXTURE_IMAGES) {
    if (cached) cache.set(target(pin), record(pin));
    if (mirror) cache.set(source(pin), record(pin));
  }
  const run = args => {
    calls.push(args);
    const replacement = intercept?.(args, cache); if (replacement) return replacement;
    if (args[0] === 'info') return { status: 0, stdout: 'linux/x86_64\n' };
    if (args[0] === 'image' && args[1] === 'inspect') return cache.has(args[2])
      ? { status: 0, stdout: JSON.stringify(cache.get(args[2])) }
      : { status: 1, stdout: '', stderr: `Error response from daemon: No such image: ${args[2]}` };
    if (args[0] === 'pull') { const pin = CI_FIXTURE_IMAGES.find(pin => source(pin) === args[3]); assert.ok(pin); cache.set(args[3], record(pin)); return { status: 0 }; }
    if (args[0] === 'image' && args[1] === 'tag') { const pin = CI_FIXTURE_IMAGES.find(pin => pin.config === args[2]); assert.ok(pin); assert.equal(args[3], target(pin)); cache.set(args[3], record(pin)); return { status: 0 }; }
    assert.fail('Unexpected Docker operation');
  };
  return { calls, cache, run, options: { env: { CI: 'true' }, platform: 'linux', arch: 'x64', run } };
}
test('all three source-fixed manifests/configs are immutable exact fixture versions', () => {
  assert.equal(CI_FIXTURE_IMAGES.length, 3); assert.ok(Object.isFrozen(CI_FIXTURE_IMAGES));
  for (const pin of CI_FIXTURE_IMAGES) { assert.ok(Object.isFrozen(pin)); assert.match(pin.manifest, /^sha256:[a-f0-9]{64}$/); assert.match(pin.config, /^sha256:[a-f0-9]{64}$/); }
  assert.deepEqual(CI_FIXTURE_IMAGES.map(pin => `${pin.name}:${pin.version}`), ['postgres:17.6.1.141', 'gotrue:v2.196.0', 'postgrest:v16.1']);
});
test('requires explicit CI, Linux x64 and matching Docker server before cache mutations', () => {
  for (const patch of [{ env: {} }, { env: { CI: 'false' } }, { platform: 'darwin' }, { arch: 'arm64' }]) {
    const f = fixture(); assert.throws(() => prepareCiFixtureImages({ ...f.options, ...patch })); assert.equal(f.calls.length, 0);
  }
  const f = fixture({ intercept: args => args[0] === 'info' ? { status: 0, stdout: 'linux/aarch64' } : undefined });
  assert.throws(() => prepareCiFixtureImages(f.options)); assert.equal(f.calls.length, 1);
});
test('correct cached fixture images require no pull, tag, container, volume or deletion', () => {
  const f = fixture({ cached: true }); assert.deepEqual(prepareCiFixtureImages(f.options), { verified: true, images: 3, platform: 'linux/amd64' });
  assert.ok(f.calls.every(args => args[0] === 'info' || args[1] === 'inspect'));
});
test('missing images pull each exact manifest once, verify config and tag only its verified config ID', () => {
  const f = fixture(); prepareCiFixtureImages(f.options);
  assert.deepEqual(f.calls.filter(args => args[0] === 'pull'), CI_FIXTURE_IMAGES.map(pin => ['pull', '--platform', 'linux/amd64', source(pin)]));
  assert.deepEqual(f.calls.filter(args => args[1] === 'tag'), CI_FIXTURE_IMAGES.map(pin => ['image', 'tag', pin.config, target(pin)]));
  assert.ok(f.calls.every(args => ['info', 'image', 'pull'].includes(args[0])));
});
test('verified cached mirror digests are reused without pulling', () => {
  const f = fixture({ mirror: true }); prepareCiFixtureImages(f.options); assert.equal(f.calls.filter(args => args[0] === 'pull').length, 0);
});
test('any foreign existing destination fails before all cache writes', () => {
  for (const change of [{ Id: `sha256:${'0'.repeat(64)}` }, { Os: 'windows' }, { Architecture: 'arm64' }]) {
    const f = fixture(); f.cache.set(target(CI_FIXTURE_IMAGES[2]), { ...record(CI_FIXTURE_IMAGES[2]), ...change });
    assert.throws(() => prepareCiFixtureImages(f.options)); assert.ok(f.calls.every(args => args[0] === 'info' || args[1] === 'inspect'));
  }
});
test('foreign source config and a concurrently introduced target are never tagged over', () => {
  for (const changedTarget of [false, true]) {
    const f = fixture({ intercept: (args, cache) => {
      if (args[0] === 'pull') {
        cache.set(args[3], record(CI_FIXTURE_IMAGES[0]));
        cache.set(changedTarget ? target(CI_FIXTURE_IMAGES[0]) : args[3], { ...record(CI_FIXTURE_IMAGES[0]), Id: `sha256:${'0'.repeat(64)}` });
        return { status: 0 };
      }
    } });
    assert.throws(() => prepareCiFixtureImages(f.options)); assert.equal(f.calls.filter(args => args[1] === 'tag').length, 0);
  }
});
test('pull failure is terminal; no mutable-tag fallback, retry, retag or test skip', () => {
  const f = fixture({ intercept: args => args[0] === 'pull' ? { status: 1, stderr: 'registry unavailable' } : undefined });
  assert.throws(() => prepareCiFixtureImages(f.options)); assert.equal(f.calls.filter(args => args[0] === 'pull').length, 1);
  assert.equal(f.calls.filter(args => args[1] === 'tag').length, 0);
});
test('daemon failure, malformed inspect data and failed tagging do not look like missing images', () => {
  for (const replacement of [{ status: 1, stderr: 'Cannot connect to daemon' }, { status: 0, stdout: 'not-json' }, { status: 0, stdout: 'null' }]) {
    const f = fixture({ intercept: args => args[1] === 'inspect' ? replacement : undefined });
    assert.throws(() => prepareCiFixtureImages(f.options)); assert.equal(f.calls.filter(args => args[0] === 'pull').length, 0);
  }
  const f = fixture({ intercept: args => args[1] === 'tag' ? { status: 1 } : undefined }); assert.throws(() => prepareCiFixtureImages(f.options));
});
test('CI prepares the cache before any real isolated fixture and retains strict native controls', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(ci, /node --test scripts\/prepare-ci-fixture-images\.test\.mjs/);
  assert.ok(ci.indexOf('node scripts/prepare-ci-fixture-images.mjs') < ci.indexOf('pnpm run test:production-canary-entitlement-sql'));
  assert.match(readFileSync(new URL('./manage-production-canary-entitlement.sql.test.mjs', import.meta.url), 'utf8'), /"--pull", "never"/);
  assert.match(readFileSync(new URL('./early-access-native-auth.integration.test.mjs', import.meta.url), 'utf8'), /'--pull', 'never'/);
});
