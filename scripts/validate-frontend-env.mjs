import { pathToFileURL } from 'node:url';

const truthy = (value) => ['1', 'true', 'yes'].includes(
  String(value || '').trim().toLowerCase(),
);

export function frontendEnvironmentErrors(environment = {}) {
  const isCloudflareBuild = truthy(environment.CF_PAGES);
  const usesMockProductData = truthy(environment.VITE_ENABLE_MOCKS);
  const enablesHybridAuth = truthy(environment.VITE_ENABLE_SUPABASE_AUTH_IN_MOCKS);
  const branch = String(environment.CF_PAGES_BRANCH || '').trim();

  if (!isCloudflareBuild) return [];

  const errors = [];
  if (branch === 'main' && usesMockProductData) {
    errors.push('VITE_ENABLE_MOCKS must be false on main');
  }
  if (branch === 'develop' && !usesMockProductData) {
    errors.push('VITE_ENABLE_MOCKS must be true on develop');
  }
  if (branch === 'develop' && enablesHybridAuth) {
    errors.push('VITE_ENABLE_SUPABASE_AUTH_IN_MOCKS must be false on develop');
  }

  // Develop is a pure browser-local preview. It must not depend on the one
  // hosted Supabase project or any other production connection.
  if (branch === 'develop') {
    if (String(environment.VITE_SUPABASE_URL || '').trim()) {
      errors.push('VITE_SUPABASE_URL must be unset on develop');
    }
    if (String(
      environment.VITE_SUPABASE_PUBLISHABLE_KEY
        || environment.VITE_SUPABASE_ANON_KEY
        || '',
    ).trim()) {
      errors.push('VITE_SUPABASE_PUBLISHABLE_KEY must be unset on develop');
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
