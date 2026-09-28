import { pathToFileURL } from 'node:url';
import { PRODUCTION_SUPABASE_PROJECT_REF, PRODUCTION_RECOVERY_TTL_SECONDS } from './production-auth-canary-policy.mjs';

export function verifyEarlyAccessRuntimeConfig(env = process.env) {
  const fail = () => { throw new Error('Early Access production runtime configuration is incomplete or unsafe.'); };
  if (env.SUPABASE_PROJECT_REF !== PRODUCTION_SUPABASE_PROJECT_REF
    || env.BILLING_ENABLED !== 'false'
    || env.TRANSACTIONAL_EMAIL_FROM !== 'Dominion <noreply@mail.77dominion.com>'
    || env.EARLY_ACCESS_NATIVE_BOOTSTRAP_ENABLED !== 'true'
    || env.EARLY_ACCESS_AUTH_RECOVERY_TTL_SECONDS !== String(PRODUCTION_RECOVERY_TTL_SECONDS)
    || !/^re_[A-Za-z0-9_-]{1,250}$/.test(env.RESEND_API_KEY || '')
    || typeof env.LINEAR_FEEDBACK_API_KEY !== 'string' || env.LINEAR_FEEDBACK_API_KEY.length < 32
    || env.LINEAR_FEEDBACK_API_KEY.length > 512 || /[^\x21-\x7e]/.test(env.LINEAR_FEEDBACK_API_KEY)
    || !/^[A-Za-z0-9_-]{43}$/.test(env.EARLY_ACCESS_INVITATION_KEY || '')
    || !/^[1-9][0-9]{0,9}$/.test(env.EARLY_ACCESS_INVITATION_KEY_VERSION || '')
    || Number(env.EARLY_ACCESS_INVITATION_KEY_VERSION) > 2147483647) fail();
  const bytes = Buffer.from(env.EARLY_ACCESS_INVITATION_KEY, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== env.EARLY_ACCESS_INVITATION_KEY) fail();
  const newSecrets = ['FEEDBACK_WORKER_SECRET', 'EARLY_ACCESS_INVITATION_WORKER_SECRET', 'EARLY_ACCESS_INVITATION_KEY'];
  for (const name of newSecrets.slice(0, 2)) if (!/^[A-Za-z0-9_-]{43,128}$/.test(env[name] || '')) fail();
  const protectedSecrets = [...newSecrets, 'RESEND_API_KEY', 'LINEAR_FEEDBACK_API_KEY', 'SUPABASE_ACCESS_TOKEN',
    'PROFILE_PHOTO_WORKER_SECRET', 'INTEGRATION_WORKER_SECRET', 'RETIRED_COMMUNITY_WORKER_SECRET',
    'RETIRED_COMMUNITY_DR_HMAC_SECRET', 'INTEGRATION_OAUTH_STATE_SECRET'];
  for (const name of newSecrets) {
    for (const other of protectedSecrets) if (other !== name && env[other] && env[name] === env[other]) fail();
  }
  // Only a safe receipt; credentials never become command output or artifacts.
  return true;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { verifyEarlyAccessRuntimeConfig(); console.log('Early Access production runtime configuration verified.'); }
  catch { console.error('Early Access production runtime configuration is incomplete or unsafe.'); process.exitCode = 1; }
}
