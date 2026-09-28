import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyEarlyAccessRuntimeConfig } from './verify-early-access-runtime-config.mjs';
const config = () => ({
  SUPABASE_PROJECT_REF: 'mimolwojppbtsbvtqwpo', BILLING_ENABLED: 'false',
  TRANSACTIONAL_EMAIL_FROM: 'Dominion <noreply@mail.77dominion.com>',
  EARLY_ACCESS_NATIVE_BOOTSTRAP_ENABLED: 'true', EARLY_ACCESS_AUTH_RECOVERY_TTL_SECONDS: '3600',
  RESEND_API_KEY: 're_fixture', LINEAR_FEEDBACK_API_KEY: 'lin_api_' + 'l'.repeat(40),
  EARLY_ACCESS_INVITATION_KEY: Buffer.alloc(32, 3).toString('base64url'), EARLY_ACCESS_INVITATION_KEY_VERSION: '1',
  FEEDBACK_WORKER_SECRET: 'f'.repeat(43), EARLY_ACCESS_INVITATION_WORKER_SECRET: 'i'.repeat(43),
});
const rejected = value => assert.throws(() => verifyEarlyAccessRuntimeConfig(value), error => error.message === 'Early Access production runtime configuration is incomplete or unsafe.');
test('runtime settings validate fixed project/free mode and only return safe receipt', () => { assert.equal(verifyEarlyAccessRuntimeConfig(config()), true); });
test('runtime settings require every field and exact closed production topology', () => {
  for (const key of Object.keys(config())) { const value = config(); delete value[key]; rejected(value); }
  for (const patch of [
    { SUPABASE_PROJECT_REF: 'another' }, { BILLING_ENABLED: 'true' }, { TRANSACTIONAL_EMAIL_FROM: 'Other <noreply@mail.77dominion.com>' },
    { EARLY_ACCESS_NATIVE_BOOTSTRAP_ENABLED: 'yes' }, { EARLY_ACCESS_AUTH_RECOVERY_TTL_SECONDS: '60' },
    { RESEND_API_KEY: 'invalid' }, { LINEAR_FEEDBACK_API_KEY: 'short' }, { LINEAR_FEEDBACK_API_KEY: 'private\n' + 'a'.repeat(50) },
    { EARLY_ACCESS_INVITATION_KEY: 'a'.repeat(43) }, { EARLY_ACCESS_INVITATION_KEY_VERSION: '0' }, { EARLY_ACCESS_INVITATION_KEY_VERSION: '2147483648' },
    { FEEDBACK_WORKER_SECRET: 'short' }, { EARLY_ACCESS_INVITATION_WORKER_SECRET: 'i'.repeat(42) + '\n' },
  ]) rejected({ ...config(), ...patch });
});
test('new workers and AES key cannot reuse one another or existing authority', () => {
  for (const name of ['FEEDBACK_WORKER_SECRET', 'EARLY_ACCESS_INVITATION_WORKER_SECRET', 'EARLY_ACCESS_INVITATION_KEY']) {
    for (const other of ['FEEDBACK_WORKER_SECRET', 'EARLY_ACCESS_INVITATION_WORKER_SECRET', 'EARLY_ACCESS_INVITATION_KEY', 'PROFILE_PHOTO_WORKER_SECRET', 'INTEGRATION_WORKER_SECRET', 'RETIRED_COMMUNITY_WORKER_SECRET', 'SUPABASE_ACCESS_TOKEN']) {
      if (name === other) continue;
      const value = config(); value[other] = value[name]; rejected(value);
    }
  }
});
