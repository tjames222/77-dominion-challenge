import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { normalizeCloudflareFrontendEnvironment } from './normalize-cloudflare-frontend-env.mjs';

const validatorPath = fileURLToPath(new URL('./validate-frontend-env.mjs', import.meta.url));
const verifierPath = fileURLToPath(new URL('./verify-build-assets.mjs', import.meta.url));

export const FRONTEND_BUILD_STEPS = Object.freeze([
  Object.freeze({ command: process.execPath, args: Object.freeze([validatorPath]) }),
  Object.freeze({ command: process.platform === 'win32' ? 'vite.cmd' : 'vite', args: Object.freeze(['build']) }),
  Object.freeze({ command: process.execPath, args: Object.freeze([verifierPath]) }),
]);

export function runFrontendBuild(environment = process.env, spawn = spawnSync) {
  const normalizedEnvironment = normalizeCloudflareFrontendEnvironment(environment);

  for (const { command, args } of FRONTEND_BUILD_STEPS) {
    const result = spawn(command, args, {
      env: normalizedEnvironment,
      stdio: 'inherit',
    });

    if (result.error) throw result.error;
    if (result.status !== 0) return result.status ?? 1;
  }

  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  try {
    process.exitCode = runFrontendBuild();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
