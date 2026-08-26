import { DEVELOP_LIVE_CONNECTION_VARIABLES } from './validate-frontend-env.mjs';

const truthy = (value) => ['1', 'true', 'yes'].includes(
  String(value || '').trim().toLowerCase(),
);

const MOCK_ONLY_FLAGS = Object.freeze({
  VITE_ENABLE_MOCKS: 'true',
  VITE_ENABLE_SUPABASE_AUTH_IN_MOCKS: 'false',
  VITE_ENABLE_PRODUCTION_CONNECTIONS: 'false',
  VITE_ENABLE_GROUP_INTEGRATIONS: 'false',
  VITE_ENABLE_BILLING: 'false',
  VITE_ENABLE_PUBLIC_SIGNUP: 'false',
});

export function isCloudflarePreviewEnvironment(environment = {}) {
  return truthy(environment.CF_PAGES)
    && String(environment.CF_PAGES_BRANCH || '').trim() !== 'main';
}

/**
 * Return the environment used by the frontend build without mutating the
 * caller's object. Cloudflare previews are browser-local fixtures regardless
 * of project-level variables inherited from the production branch.
 *
 * Main remains untouched so the existing validator can fail closed when its
 * real Supabase wiring is absent or inconsistent.
 */
export function normalizeCloudflareFrontendEnvironment(environment = {}) {
  const normalized = { ...environment };

  if (!isCloudflarePreviewEnvironment(normalized)) return normalized;

  Object.assign(normalized, MOCK_ONLY_FLAGS);
  delete normalized.VITE_ENABLE_E2E_FIXTURES;

  for (const name of DEVELOP_LIVE_CONNECTION_VARIABLES) {
    delete normalized[name];
  }

  return normalized;
}
