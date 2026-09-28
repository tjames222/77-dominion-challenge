import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Reviewed official Supabase linux/amd64 manifests and their image-config
// digests, read from GHCR on 2026-09-28. PostgreSQL's ECR and GHCR manifests
// were byte-identical. The other exact-version GHCR artifacts are explicitly
// pinned here, not inferred equivalent merely because registry tags match.
// This cache preparation is CI-only on the dedicated sequential job daemon;
// Docker inspect/tag is not an atomic no-clobber operation. No other process
// may mutate these fixture tags concurrently. Execution remains --pull never.
export const CI_FIXTURE_IMAGES = Object.freeze([
  Object.freeze({ name: 'postgres', version: '17.6.1.141',
    manifest: 'sha256:ca61fd22821732cdf5c687051d39b801e3d89dc0dcfc96ca202239eb26e4b732',
    config: 'sha256:b808f667e8d3a79f96befd972899ea5ca91179495a89e708863a8bfbec4a762c' }),
  Object.freeze({ name: 'gotrue', version: 'v2.196.0',
    manifest: 'sha256:7e813221b93fbf54b515036438550e483bfaf057b9db52fe9bc1ce91c47e817e',
    config: 'sha256:688edbb786f6d736edaa478438f23c7044a22a6a5f19502a7138d38caca6c2f6' }),
  Object.freeze({ name: 'postgrest', version: 'v16.1',
    manifest: 'sha256:73e76c305027cb1119bc7c6ab82449d9e1a50a9e8697f4ebac5443dc63590c90',
    config: 'sha256:eb4951a2f9ac02288100937995af3cb7fb64c296b1228405de5d77ca4dd3410d' }),
]);
const fail = () => new Error('Exact CI fixture images could not be prepared. No tests were skipped.');
const docker = args => spawnSync('docker', args, { encoding: 'utf8', timeout: 300000, maxBuffer: 2 * 1024 * 1024 });

export function prepareCiFixtureImages({ env = process.env, platform = process.platform, arch = process.arch, run = docker } = {}) {
  if (env.CI !== 'true' || platform !== 'linux' || arch !== 'x64' || typeof run !== 'function') throw fail();
  const host = run(['info', '--format', '{{.OSType}}/{{.Architecture}}']);
  if (host.status !== 0 || !['linux/x86_64', 'linux/amd64'].includes(host.stdout?.trim())) throw fail();
  const inspect = ref => {
    const result = run(['image', 'inspect', ref, '--format', '{{json .}}']);
    if (result.status === 1 && /\bno such image\b/i.test(result.stderr || '') && !result.stdout?.trim()) return null;
    if (result.status !== 0 || typeof result.stdout !== 'string' || result.stdout.length > 524288) throw fail();
    try {
      const value = JSON.parse(result.stdout);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail();
      return value;
    } catch { throw fail(); }
  };
  const verify = (record, pin) => {
    if (!record || record.Id !== pin.config || record.Os !== 'linux' || record.Architecture !== 'amd64') throw fail();
    return record;
  };
  const expected = CI_FIXTURE_IMAGES.map(pin => ({ pin, target: `public.ecr.aws/supabase/${pin.name}:${pin.version}` }));
  // Fail on any pre-existing foreign target before pulling/tagging anything.
  const existing = expected.map(({ pin, target }) => {
    const record = inspect(target); return record ? verify(record, pin) : null;
  });
  for (const [index, { pin, target }] of expected.entries()) {
    if (existing[index]) continue;
    const source = `ghcr.io/supabase/${pin.name}@${pin.manifest}`;
    let cached = inspect(source);
    if (!cached) {
      const pulled = run(['pull', '--platform', 'linux/amd64', source]);
      if (pulled.status !== 0) throw fail();
      cached = inspect(source);
    }
    verify(cached, pin);
    // Refuse any observed unrelated tag, including one created during a pull.
    const current = inspect(target);
    if (current) { verify(current, pin); continue; }
    if (run(['image', 'tag', pin.config, target]).status !== 0) throw fail();
    verify(inspect(target), pin);
  }
  return Object.freeze({ verified: true, images: CI_FIXTURE_IMAGES.length, platform: 'linux/amd64' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { prepareCiFixtureImages(); console.log('Three exact linux/amd64 fixture images are cached and verified.'); }
  catch { console.error('Exact CI fixture images could not be prepared. No tests were skipped.'); process.exitCode = 1; }
}
