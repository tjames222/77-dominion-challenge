import { pathToFileURL } from 'node:url';
import { PRODUCTION_SUPABASE_PROJECT_REF, PRODUCTION_RECOVERY_TTL_SECONDS } from './production-auth-canary-policy.mjs';

const FAILURE_MESSAGE = 'Early Access production runtime configuration is incomplete or unsafe.';
const NEW_SECRETS = Object.freeze(['FEEDBACK_WORKER_SECRET', 'EARLY_ACCESS_INVITATION_WORKER_SECRET', 'EARLY_ACCESS_INVITATION_KEY']);
const PROTECTED_SECRETS = Object.freeze([...NEW_SECRETS, 'RESEND_API_KEY', 'LINEAR_FEEDBACK_API_KEY', 'SUPABASE_ACCESS_TOKEN',
  'PROFILE_PHOTO_WORKER_SECRET', 'INTEGRATION_WORKER_SECRET', 'RETIRED_COMMUNITY_WORKER_SECRET',
  'RETIRED_COMMUNITY_DR_HMAC_SECRET', 'INTEGRATION_OAUTH_STATE_SECRET']);
const SETTINGS = Object.freeze(['SUPABASE_PROJECT_REF', 'BILLING_ENABLED', 'TRANSACTIONAL_EMAIL_FROM',
  'EARLY_ACCESS_NATIVE_BOOTSTRAP_ENABLED', 'EARLY_ACCESS_AUTH_RECOVERY_TTL_SECONDS',
  'EARLY_ACCESS_INVITATION_KEY_VERSION', ...PROTECTED_SECRETS]);
export const EARLY_ACCESS_RUNTIME_DIAGNOSTIC_LABELS = Object.freeze([
  'ENVIRONMENT_INPUT', 'SUPABASE_PROJECT_REF_EXACT', 'BILLING_ENABLED_EXACT', 'TRANSACTIONAL_EMAIL_FROM_EXACT',
  'EARLY_ACCESS_NATIVE_BOOTSTRAP_ENABLED_EXACT', 'EARLY_ACCESS_AUTH_RECOVERY_TTL_SECONDS_EXACT',
  'RESEND_API_KEY_FORMAT', 'LINEAR_FEEDBACK_API_KEY_FORMAT', 'EARLY_ACCESS_INVITATION_KEY_FORMAT',
  'EARLY_ACCESS_INVITATION_KEY_CANONICAL', 'EARLY_ACCESS_INVITATION_KEY_VERSION_FORMAT',
  'EARLY_ACCESS_INVITATION_KEY_VERSION_RANGE', 'FEEDBACK_WORKER_SECRET_FORMAT',
  'EARLY_ACCESS_INVITATION_WORKER_SECRET_FORMAT', 'FEEDBACK_WORKER_SECRET_DISTINCT',
  'EARLY_ACCESS_INVITATION_WORKER_SECRET_DISTINCT', 'EARLY_ACCESS_INVITATION_KEY_DISTINCT',
]);

function snapshotSettings(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const result = Object.create(null);
    for (const name of SETTINGS) {
      const descriptor = Object.getOwnPropertyDescriptor(input, name);
      // Never invoke an input getter or coerce an object carrying a secret.
      if (descriptor && !Object.hasOwn(descriptor, 'value')) return null;
      result[name] = descriptor?.value;
    }
    return result;
  } catch { return null; }
}

/** Fixed predicate labels only: never values, lengths, hashes, fragments, or errors. */
export function diagnoseEarlyAccessRuntimeConfig(input = process.env) {
  const env = snapshotSettings(input);
  if (!env) return Object.freeze(['ENVIRONMENT_INPUT']);
  const failed = new Set();
  const check = (valid, label) => { if (!valid) failed.add(label); };
  const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
  check(env.SUPABASE_PROJECT_REF === PRODUCTION_SUPABASE_PROJECT_REF, 'SUPABASE_PROJECT_REF_EXACT');
  check(env.BILLING_ENABLED === 'false', 'BILLING_ENABLED_EXACT');
  check(env.TRANSACTIONAL_EMAIL_FROM === 'Dominion <noreply@mail.77dominion.com>', 'TRANSACTIONAL_EMAIL_FROM_EXACT');
  check(env.EARLY_ACCESS_NATIVE_BOOTSTRAP_ENABLED === 'true', 'EARLY_ACCESS_NATIVE_BOOTSTRAP_ENABLED_EXACT');
  check(env.EARLY_ACCESS_AUTH_RECOVERY_TTL_SECONDS === String(PRODUCTION_RECOVERY_TTL_SECONDS), 'EARLY_ACCESS_AUTH_RECOVERY_TTL_SECONDS_EXACT');
  check(matches(env.RESEND_API_KEY, /^re_[A-Za-z0-9_-]{1,250}$/), 'RESEND_API_KEY_FORMAT');
  check(typeof env.LINEAR_FEEDBACK_API_KEY === 'string' && env.LINEAR_FEEDBACK_API_KEY.length >= 32
    && env.LINEAR_FEEDBACK_API_KEY.length <= 512 && !/[^\x21-\x7e]/.test(env.LINEAR_FEEDBACK_API_KEY), 'LINEAR_FEEDBACK_API_KEY_FORMAT');
  const keyFormat = matches(env.EARLY_ACCESS_INVITATION_KEY, /^[A-Za-z0-9_-]{43}$/);
  check(keyFormat, 'EARLY_ACCESS_INVITATION_KEY_FORMAT');
  if (keyFormat) {
    const bytes = Buffer.from(env.EARLY_ACCESS_INVITATION_KEY, 'base64url');
    check(bytes.length === 32 && bytes.toString('base64url') === env.EARLY_ACCESS_INVITATION_KEY, 'EARLY_ACCESS_INVITATION_KEY_CANONICAL');
  }
  const versionFormat = matches(env.EARLY_ACCESS_INVITATION_KEY_VERSION, /^[1-9][0-9]{0,9}$/);
  check(versionFormat, 'EARLY_ACCESS_INVITATION_KEY_VERSION_FORMAT');
  if (versionFormat) check(Number(env.EARLY_ACCESS_INVITATION_KEY_VERSION) <= 2147483647, 'EARLY_ACCESS_INVITATION_KEY_VERSION_RANGE');
  check(matches(env.FEEDBACK_WORKER_SECRET, /^[A-Za-z0-9_-]{43,128}$/), 'FEEDBACK_WORKER_SECRET_FORMAT');
  check(matches(env.EARLY_ACCESS_INVITATION_WORKER_SECRET, /^[A-Za-z0-9_-]{43,128}$/), 'EARLY_ACCESS_INVITATION_WORKER_SECRET_FORMAT');
  for (const name of NEW_SECRETS) {
    for (const other of PROTECTED_SECRETS) {
      if (other !== name && env[other] && env[name] === env[other]) failed.add(`${name}_DISTINCT`);
    }
  }
  // Filtering the fixed allowlist also fixes output order and bounds its size.
  return Object.freeze(EARLY_ACCESS_RUNTIME_DIAGNOSTIC_LABELS.filter(label => failed.has(label)));
}

export function verifyEarlyAccessRuntimeConfig(env = process.env) {
  if (diagnoseEarlyAccessRuntimeConfig(env).length) throw new Error(FAILURE_MESSAGE);
  // Only a safe receipt; credentials never become command output or artifacts.
  return true;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const failed = diagnoseEarlyAccessRuntimeConfig();
    if (failed.length) {
      console.error(FAILURE_MESSAGE);
      console.error(`Failed checks: ${failed.join(', ')}`);
      process.exitCode = 1;
    } else console.log('Early Access production runtime configuration verified.');
  } catch { console.error(FAILURE_MESSAGE); process.exitCode = 1; }
}
