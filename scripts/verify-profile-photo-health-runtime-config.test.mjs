import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { diagnoseProfilePhotoHealthRuntimeConfig as diagnose, verifyProfilePhotoHealthRuntimeConfig as verify,
  PROFILE_PHOTO_HEALTH_DIAGNOSTIC_LABELS } from './verify-profile-photo-health-runtime-config.mjs';

const secret = Buffer.alloc(32, 251).toString('base64url');
const valid = { PROFILE_PHOTO_HEALTH_SECRET: secret, PROFILE_PHOTO_WORKER_SECRET: 'distinct-synthetic-worker' };

test('health secret is exactly 32 canonical base64url bytes and yields only a safe receipt', () => {
  assert.equal(verify(valid), true);
  assert.deepEqual(diagnose(valid), []);
  for (const value of [undefined, '', 'a'.repeat(42), 'a'.repeat(44), `${secret}=`, ` ${secret}`, secret.replace(/.$/u, '9')]) {
    assert.throws(() => verify({ PROFILE_PHOTO_HEALTH_SECRET: value }), /incomplete or unsafe/u);
  }
});

test('health secret must be distinct from every already-bound backend secret and credential map bytes', () => {
  for (const name of ['SUPABASE_ACCESS_TOKEN', 'INTEGRATION_WORKER_SECRET', 'INTEGRATION_CREDENTIAL_KEYS',
    'INTEGRATION_OAUTH_STATE_SECRET', 'RETIRED_COMMUNITY_WORKER_SECRET', 'RETIRED_COMMUNITY_DR_HMAC_SECRET',
    'PROFILE_PHOTO_WORKER_SECRET', 'FEEDBACK_WORKER_SECRET', 'EARLY_ACCESS_INVITATION_WORKER_SECRET',
    'EARLY_ACCESS_INVITATION_KEY', 'SLACK_CLIENT_SECRET', 'SLACK_SIGNING_SECRET', 'DISCORD_CLIENT_SECRET', 'DISCORD_BOT_TOKEN']) {
    assert.deepEqual(diagnose({ ...valid, [name]: secret }), ['PROFILE_PHOTO_HEALTH_SECRET_DISTINCT']);
  }
  assert.deepEqual(diagnose({ ...valid, INTEGRATION_CREDENTIAL_KEYS: JSON.stringify({ 1: Buffer.alloc(32, 251).toString('base64') }) }),
    ['PROFILE_PHOTO_HEALTH_SECRET_DISTINCT']);
});

test('diagnostics are fixed labels and never invoke accessors or disclose credential material', () => {
  let read = false;
  const getter = Object.defineProperty({}, 'PROFILE_PHOTO_HEALTH_SECRET', { get() { read = true; throw Error(secret); } });
  for (const input of [null, [], getter, { PROFILE_PHOTO_HEALTH_SECRET: { toString() { throw Error(secret); } } }]) {
    const result = diagnose(input);
    assert(result.every(label => PROFILE_PHOTO_HEALTH_DIAGNOSTIC_LABELS.includes(label)));
    assert(!JSON.stringify(result).includes(secret));
  }
  assert.equal(read, false);
});

test('health validation cannot fetch secrets, inspect backup keys or emit secret values', async () => {
  const source = await readFile(new URL('./verify-profile-photo-health-runtime-config.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /readFile|fetch\(|spawn|execSync|PRIVATE_KEY|PRODUCTION_BACKUP_|privateDecrypt/u);
  assert.doesNotMatch(source, /console\.(?:log|error)\([^)]*(?:secret|env\[|input)/u);
});
