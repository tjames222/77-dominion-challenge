import { pathToFileURL } from 'node:url';

// Only secrets already available in the protected backend job are inspected.
// This module must never fetch credentials or read backup/envelope private keys.
const EXISTING_BACKEND_SECRETS = Object.freeze([
  'SUPABASE_ACCESS_TOKEN', 'INTEGRATION_WORKER_SECRET', 'INTEGRATION_CREDENTIAL_KEYS',
  'INTEGRATION_OAUTH_STATE_SECRET', 'RETIRED_COMMUNITY_WORKER_SECRET',
  'RETIRED_COMMUNITY_DR_HMAC_SECRET', 'PROFILE_PHOTO_WORKER_SECRET', 'FEEDBACK_WORKER_SECRET',
  'EARLY_ACCESS_INVITATION_WORKER_SECRET', 'EARLY_ACCESS_INVITATION_KEY',
  'SLACK_CLIENT_SECRET', 'SLACK_SIGNING_SECRET', 'DISCORD_CLIENT_SECRET', 'DISCORD_BOT_TOKEN',
]);
export const PROFILE_PHOTO_HEALTH_DIAGNOSTIC_LABELS = Object.freeze([
  'ENVIRONMENT_INPUT', 'PROFILE_PHOTO_HEALTH_SECRET_FORMAT',
  'PROFILE_PHOTO_HEALTH_SECRET_CANONICAL', 'PROFILE_PHOTO_HEALTH_SECRET_DISTINCT',
]);
const FAILURE = 'Profile photo health production runtime configuration is incomplete or unsafe.';

export function diagnoseProfilePhotoHealthRuntimeConfig(input = process.env) {
  const env = Object.create(null);
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return Object.freeze(['ENVIRONMENT_INPUT']);
    for (const name of ['PROFILE_PHOTO_HEALTH_SECRET', ...EXISTING_BACKEND_SECRETS]) {
      const descriptor = Object.getOwnPropertyDescriptor(input, name);
      if (descriptor && !Object.hasOwn(descriptor, 'value')) return Object.freeze(['ENVIRONMENT_INPUT']);
      if (descriptor?.value !== undefined && typeof descriptor.value !== 'string') return Object.freeze(['ENVIRONMENT_INPUT']);
      env[name] = descriptor?.value;
    }
  } catch { return Object.freeze(['ENVIRONMENT_INPUT']); }
  const failed = new Set();
  const secret = env.PROFILE_PHOTO_HEALTH_SECRET;
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(secret)) failed.add('PROFILE_PHOTO_HEALTH_SECRET_FORMAT');
  else if (Buffer.from(secret, 'base64url').length !== 32 || Buffer.from(secret, 'base64url').toString('base64url') !== secret) {
    failed.add('PROFILE_PHOTO_HEALTH_SECRET_CANONICAL');
  }
  for (const name of EXISTING_BACKEND_SECRETS) {
    if (secret && env[name] === secret) failed.add('PROFILE_PHOTO_HEALTH_SECRET_DISTINCT');
  }
  // Credential-key map values use base64, so compare canonical decoded bytes too.
  // Invalid existing maps remain the responsibility of their existing validator.
  try {
    const keys = JSON.parse(env.INTEGRATION_CREDENTIAL_KEYS || '{}');
    if (keys && typeof keys === 'object' && !Array.isArray(keys)) {
      for (const value of Object.values(keys)) {
        if (typeof value === 'string' && /^[A-Za-z0-9+/]+={0,2}$/u.test(value)
          && Buffer.from(value, 'base64').toString('base64url') === secret) failed.add('PROFILE_PHOTO_HEALTH_SECRET_DISTINCT');
      }
    }
  } catch { /* Existing integration validator checks this independent contract. */ }
  return Object.freeze(PROFILE_PHOTO_HEALTH_DIAGNOSTIC_LABELS.filter(label => failed.has(label)));
}

export function verifyProfilePhotoHealthRuntimeConfig(input = process.env) {
  if (diagnoseProfilePhotoHealthRuntimeConfig(input).length) throw new Error(FAILURE);
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const failed = diagnoseProfilePhotoHealthRuntimeConfig();
  if (failed.length) {
    console.error(FAILURE);
    console.error(`Failed checks: ${failed.join(', ')}`);
    process.exitCode = 1;
  } else console.log('Profile photo health production runtime configuration verified.');
}
