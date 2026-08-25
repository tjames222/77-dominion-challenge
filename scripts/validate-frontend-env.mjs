import { pathToFileURL } from 'node:url';

const truthy = (value) => ['1', 'true', 'yes'].includes(
  String(value || '').trim().toLowerCase(),
);
const explicitlyEnabled = (value) => String(value || '').trim().toLowerCase() === 'true';

export const DEVELOP_LIVE_CONNECTION_VARIABLES = Object.freeze([
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_PUBLISHABLE_KEY',
  'VITE_SUPABASE_ANON_KEY',
  'VITE_YOUVERSION_VERSE_URL',
  'VITE_YOUVERSION_APP_URL',
  'VITE_YOUVERSION_PRAYER_URL',
  'VITE_APPLE_FITNESS_URL',
  'VITE_WALK_ALARM_URL',
  'SUPABASE_ACCESS_TOKEN',
  'SUPABASE_DB_PASSWORD',
  'SUPABASE_DB_URL',
  'SUPABASE_PROJECT_REF',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_MEMBERSHIP_PRICE_ID',
  'INTEGRATION_WORKER_SECRET',
  'INTEGRATION_CREDENTIAL_KEYS',
  'INTEGRATION_OAUTH_STATE_SECRET',
  'RETIRED_COMMUNITY_WORKER_SECRET',
  'RETIRED_COMMUNITY_DR_HMAC_SECRET',
  'PROFILE_PHOTO_WORKER_SECRET',
  'SLACK_CLIENT_ID',
  'SLACK_CLIENT_SECRET',
  'SLACK_SIGNING_SECRET',
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'DISCORD_PUBLIC_KEY',
  'DISCORD_BOT_TOKEN',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'PUBLIC_SITE_URL',
  'PUBLIC_SHARE_URL',
  'PUBLIC_ALLOWED_SITE_URLS',
  'ALLOWED_SITE_ORIGINS',
]);

export function frontendEnvironmentErrors(environment = {}) {
  const isCloudflareBuild = truthy(environment.CF_PAGES);
  const usesMockProductData = explicitlyEnabled(environment.VITE_ENABLE_MOCKS);
  const enablesHybridAuth = explicitlyEnabled(environment.VITE_ENABLE_SUPABASE_AUTH_IN_MOCKS);
  const enablesProductionConnections = explicitlyEnabled(
    environment.VITE_ENABLE_PRODUCTION_CONNECTIONS,
  );
  const enablesE2eFixtures = explicitlyEnabled(environment.VITE_ENABLE_E2E_FIXTURES);
  const branch = String(environment.CF_PAGES_BRANCH || '').trim();

  if (!isCloudflareBuild) return [];

  const errors = [];
  if (enablesE2eFixtures) {
    errors.push('VITE_ENABLE_E2E_FIXTURES must be unset for Cloudflare builds');
  }
  if (branch === 'main' && usesMockProductData) {
    errors.push('VITE_ENABLE_MOCKS must be false on main');
  }
  if (branch === 'main' && enablesHybridAuth) {
    errors.push('VITE_ENABLE_SUPABASE_AUTH_IN_MOCKS must be false on main');
  }
  if (branch === 'main' && !enablesProductionConnections) {
    errors.push('VITE_ENABLE_PRODUCTION_CONNECTIONS must be true on main');
  }
  if (branch === 'develop' && !usesMockProductData) {
    errors.push('VITE_ENABLE_MOCKS must be true on develop');
  }
  if (branch === 'develop' && enablesHybridAuth) {
    errors.push('VITE_ENABLE_SUPABASE_AUTH_IN_MOCKS must be false on develop');
  }
  if (branch === 'develop' && enablesProductionConnections) {
    errors.push('VITE_ENABLE_PRODUCTION_CONNECTIONS must be false on develop');
  }
  if (branch === 'develop' && explicitlyEnabled(environment.VITE_ENABLE_GROUP_INTEGRATIONS)) {
    errors.push('VITE_ENABLE_GROUP_INTEGRATIONS must be false on develop');
  }

  // Develop is a pure browser-local preview. It must not depend on the one
  // hosted Supabase project or any other production connection.
  if (branch === 'develop') {
    for (const name of DEVELOP_LIVE_CONNECTION_VARIABLES) {
      if (String(environment[name] || '').trim()) {
        errors.push(`${name} must be unset on develop`);
      }
    }
    return errors;
  }

  const canonicalBranch = branch === 'main' || branch === 'develop';
  if (usesMockProductData && !canonicalBranch) return errors;

  const supabaseUrl = String(environment.VITE_SUPABASE_URL || '').trim();
  const publishableKey = String(
    environment.VITE_SUPABASE_PUBLISHABLE_KEY
      || environment.VITE_SUPABASE_ANON_KEY
      || '',
  ).trim();

  if (!supabaseUrl || supabaseUrl.includes('YOUR_')) errors.push('VITE_SUPABASE_URL');
  if (!publishableKey || publishableKey.includes('YOUR_')) {
    errors.push('VITE_SUPABASE_PUBLISHABLE_KEY');
  }

  if (supabaseUrl && !supabaseUrl.includes('YOUR_')) {
    try {
      const parsed = new URL(supabaseUrl);
      if (parsed.protocol !== 'https:') errors.push('VITE_SUPABASE_URL must use HTTPS');
      const projectRef = String(environment.SUPABASE_PROJECT_REF || '').trim();
      if (branch === 'main' && !projectRef) {
        errors.push('SUPABASE_PROJECT_REF');
      } else if (
        branch === 'main'
        && parsed.origin !== `https://${projectRef}.supabase.co`
      ) {
        errors.push('VITE_SUPABASE_URL must match SUPABASE_PROJECT_REF');
      }
    } catch {
      errors.push('VITE_SUPABASE_URL must be a valid URL');
    }
  }

  return errors;
}

export function validateFrontendEnvironment(environment = process.env) {
  const errors = frontendEnvironmentErrors(environment);
  if (!errors.length) return;

  throw new Error(
    `Cloudflare frontend configuration is invalid: ${errors.join(', ')}`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  try {
    validateFrontendEnvironment();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
