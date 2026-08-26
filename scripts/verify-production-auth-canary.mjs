import { pathToFileURL } from 'node:url';

const AUTH_CONFIG_BASE_URL = 'https://api.supabase.com/v1/projects';

export function productionAuthCanaryErrors(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return ['Supabase returned an invalid Auth configuration response'];
  }

  const errors = [];
  if (config.disable_signup !== true) {
    errors.push('Supabase Auth disable_signup must be true');
  }
  if (config.external_anonymous_users_enabled !== false) {
    errors.push('Supabase Auth external_anonymous_users_enabled must be false');
  }
  return errors;
}

export async function verifyProductionAuthCanary({
  accessToken = process.env.SUPABASE_ACCESS_TOKEN,
  projectRef = process.env.SUPABASE_PROJECT_REF,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!String(accessToken || '').trim()) {
    throw new Error('SUPABASE_ACCESS_TOKEN is required for the Auth canary gate.');
  }
  if (!String(projectRef || '').trim()) {
    throw new Error('SUPABASE_PROJECT_REF is required for the Auth canary gate.');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('A Fetch-compatible runtime is required for the Auth canary gate.');
  }

  const url = `${AUTH_CONFIG_BASE_URL}/${encodeURIComponent(projectRef)}/config/auth`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      cache: 'no-store',
      redirect: 'error',
    });
  } catch {
    throw new Error('Unable to read the Supabase Auth configuration.');
  }

  if (!response?.ok) {
    const status = Number.isInteger(response?.status) ? ` (HTTP ${response.status})` : '';
    throw new Error(`Unable to read the Supabase Auth configuration${status}.`);
  }

  let config;
  try {
    config = await response.json();
  } catch {
    throw new Error('Supabase returned an invalid Auth configuration response.');
  }

  const errors = productionAuthCanaryErrors(config);
  if (errors.length) {
    throw new Error(`Production canary is not closed: ${errors.join('; ')}.`);
  }

  return true;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  try {
    await verifyProductionAuthCanary();
    console.log('Supabase Auth public signup and anonymous sign-in are closed.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Supabase Auth canary gate failed.');
    process.exitCode = 1;
  }
}
