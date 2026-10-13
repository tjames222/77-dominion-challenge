import { spawnSync } from 'node:child_process';

// The previously reviewed official Supabase PostgreSQL 17.6.1.141
// linux/amd64 manifest is byte-identical in ECR and GHCR. Acquisition uses
// only this immutable GHCR reference; the public backup manifest continues
// to identify the existing canonical ECR version. No tag is created/changed.
export const PRODUCTION_BACKUP_IMAGE = Object.freeze({
  reference: 'ghcr.io/supabase/postgres@sha256:ca61fd22821732cdf5c687051d39b801e3d89dc0dcfc96ca202239eb26e4b732',
  config: 'sha256:b808f667e8d3a79f96befd972899ea5ca91179495a89e708863a8bfbec4a762c',
  platform: 'linux/amd64',
});
export const BACKUP_IMAGE_OUTPUT_LIMIT = 512 * 1024;
export const BACKUP_IMAGE_INSPECT_TIMEOUT_MS = 15_000;
export const BACKUP_IMAGE_PULL_TIMEOUT_MS = 300_000;
const docker = (args, options) => spawnSync('docker', args, options);
const failure = diagnosticCode => Object.assign(
  new Error('The exact production backup image could not be verified.'), { diagnosticCode },
);

// Only the dedicated, sequential GitHub-hosted backup job may call this
// helper. Its Docker context must remain unchanged through later capture
// and restore. Execution uses the returned content-addressed ID, never a tag.
export function prepareProductionBackupImage(options = {}) {
  let diagnosticCode = 'backup-image-context';
  try {
    const { env = process.env, platform = process.platform, arch = process.arch, run = docker } = options;
    if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REF !== 'refs/heads/main'
      || env.GITHUB_REPOSITORY !== 'tjames222/77-dominion-challenge'
      || platform !== 'linux' || arch !== 'x64' || typeof run !== 'function'
      || typeof env.PATH !== 'string' || env.PATH.length === 0 || env.PATH.length > 16384 || env.PATH.includes('\0')
      || typeof env.HOME !== 'string' || !env.HOME.startsWith('/') || env.HOME.length > 4096 || env.HOME.includes('\0')) throw failure(diagnosticCode);
    // Never forward credentials, Docker overrides, loader options or proxies.
    const childEnv = Object.freeze({ PATH: env.PATH, HOME: env.HOME, LANG: 'C.UTF-8' });
    const invoke = (args, code, timeout = BACKUP_IMAGE_INSPECT_TIMEOUT_MS) => {
      diagnosticCode = code;
      const result = run(args, { env: childEnv, encoding: 'utf8', timeout,
        killSignal: 'SIGKILL', maxBuffer: BACKUP_IMAGE_OUTPUT_LIMIT,
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      if (!result || typeof result !== 'object' || Array.isArray(result)
        || !Number.isInteger(result.status) || result.error || result.signal
        || typeof result.stdout !== 'string' || typeof result.stderr !== 'string'
        || Buffer.byteLength(result.stdout, 'utf8') > BACKUP_IMAGE_OUTPUT_LIMIT
        || Buffer.byteLength(result.stderr, 'utf8') > BACKUP_IMAGE_OUTPUT_LIMIT) throw failure(code);
      return result;
    };
    const exactOutput = (args, expected, code) => {
      const result = invoke(args, code);
      if (result.status !== 0 || result.stdout.trim() !== expected || result.stderr.trim() !== '') throw failure(code);
    };
    exactOutput(['context', 'show'], 'default', 'backup-image-context');
    exactOutput(['context', 'inspect', 'default', '--format', '{{.Endpoints.docker.Host}}'],
      'unix:///var/run/docker.sock', 'backup-image-context');
    const daemon = invoke(['info', '--format', '{{.OSType}}/{{.Architecture}}'], 'backup-image-daemon');
    if (daemon.status !== 0 || !['linux/x86_64', 'linux/amd64'].includes(daemon.stdout.trim())
      || daemon.stderr.trim() !== '') throw failure(diagnosticCode);
    const inspect = () => {
      const result = invoke(['image', 'inspect', PRODUCTION_BACKUP_IMAGE.reference, '--format', '{{json .}}'], 'backup-image-inspect');
      if (result.status === 1 && result.stdout.trim() === ''
        && result.stderr.trim() === `Error response from daemon: No such image: ${PRODUCTION_BACKUP_IMAGE.reference}`) return null;
      if (result.status !== 0 || result.stderr.trim() !== '') throw failure(diagnosticCode);
      let image;
      try { image = JSON.parse(result.stdout); } catch { throw failure(diagnosticCode); }
      diagnosticCode = 'backup-image-identity';
      if (!image || typeof image !== 'object' || Array.isArray(image)
        || image.Id !== PRODUCTION_BACKUP_IMAGE.config || image.Os !== 'linux' || image.Architecture !== 'amd64'
        || !Array.isArray(image.RepoDigests) || image.RepoDigests.length < 1 || image.RepoDigests.length > 16
        || !image.RepoDigests.every(value => typeof value === 'string' && value.length <= 256)
        || !image.RepoDigests.includes(PRODUCTION_BACKUP_IMAGE.reference)) throw failure(diagnosticCode);
      return image.Id;
    };
    const cached = inspect();
    if (cached) return cached;
    const pulled = invoke(['pull', '--platform', PRODUCTION_BACKUP_IMAGE.platform, '--quiet', PRODUCTION_BACKUP_IMAGE.reference],
      'backup-image-pull', BACKUP_IMAGE_PULL_TIMEOUT_MS);
    if (pulled.status !== 0) throw failure(diagnosticCode);
    // Pull exit zero alone is not proof. Re-inspect digest/config/platform;
    // even a vanished or replaced cache entry fails without another pull.
    const acquired = inspect();
    if (!acquired) throw failure('backup-image-inspect');
    return acquired;
  } catch {
    // Docker/plugin diagnostics are never reflected, attached as causes,
    // logged, or written into the backup artifact.
    throw failure(diagnosticCode);
  }
}
