import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Public, non-secret backup identities shared by the producer and evidence
// verifier. This module intentionally has no process, filesystem, database,
// decryption, credential, or child-process capability.
export const PROJECT_REF = 'mimolwojppbtsbvtqwpo';
export const POSTGRES_IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.141';
export const MAX_ENCRYPTED_BYTES = 49 * 1024 * 1024;
export const POST_ORIGINAL77_BACKUP_MODE = 'post-original77-70';
export const POST_ORIGINAL77_VERSIONS_SHA256 = '73f5e3b0395829ec93acf1454cd212a653c5edfa19d4be641c8de792f0777f46';
export const POST_REPEATABLE_BACKUP_MODE = 'post-repeatable-challenge-71';
export const POST_REPEATABLE_VERSIONS_SHA256 = 'b8318e559a4d78b3f0c3d498c4970e4151fe1651ccbde3c8dc1153897b0c096f';
export const POST_ORIGINAL77_VAULT_RECOVERY = Object.freeze({
  selfContained: false,
  source: 'protected-github-production-settings',
  requiredSettings: Object.freeze(['VITE_SUPABASE_URL', 'PROFILE_PHOTO_WORKER_SECRET',
    'FEEDBACK_WORKER_SECRET', 'EARLY_ACCESS_INVITATION_WORKER_SECRET']),
  secretNames: Object.freeze(['profile_photo_project_url', 'profile_photo_worker_secret', 'early_access_project_url',
    'early_access_feedback_worker_secret', 'early_access_invitation_worker_secret']),
  originalCiphertextPreserved: true,
  freshKeyReconstructionVerified: true,
  recoveryRequiresProtectedSettings: true,
});
export const POST_ORIGINAL77_APPLICATION_ENVELOPE_RECOVERY = Object.freeze({
  encryptedInvitationPayloadsPreserved: true,
  decryptionVerified: false,
  requiredExternalSettings: Object.freeze(['EARLY_ACCESS_INVITATION_KEY', 'EARLY_ACCESS_INVITATION_KEY_VERSION']),
  requiresSeparateRecoveryReview: true,
});

const sha256 = value => createHash('sha256').update(value).digest('hex');
export function requirePostOriginal77MigrationVersions(versions) {
  assert(Array.isArray(versions));
  assert.equal(versions.length, 70, 'Incomplete post-original77 migration checkpoint');
  assert(versions.every(version => typeof version === 'string' && /^[0-9]{14}$/u.test(version)));
  assert.equal(new Set(versions).size, versions.length, 'Duplicate migration version');
  assert.equal(versions.at(-1), '20260930161218', 'Unexpected post-original77 migration checkpoint');
  assert.equal(sha256(JSON.stringify(versions)), POST_ORIGINAL77_VERSIONS_SHA256,
    'Post-original77 migration checkpoint changed');
  return versions;
}
export function selectPostOriginal77MigrationVersions(filenames) {
  assert(Array.isArray(filenames));
  const names = filenames.filter(name => typeof name === 'string' && name.endsWith('.sql')).sort();
  assert(names.every(name => /^[0-9]{14}_[a-z0-9_]+\.sql$/u.test(name)), 'Invalid migration filename');
  const versions = names.map(name => name.slice(0, 14));
  assert.equal(new Set(versions).size, versions.length, 'Duplicate migration version');
  return requirePostOriginal77MigrationVersions(versions.slice(0, 70));
}

export function requirePostRepeatableMigrationVersions(versions) {
  assert(Array.isArray(versions));
  assert.equal(versions.length, 71, 'Incomplete post-repeatable migration checkpoint');
  requirePostOriginal77MigrationVersions(versions.slice(0, 70));
  assert.equal(versions.at(-1), '20261001001245', 'Unexpected post-repeatable migration checkpoint');
  assert.equal(sha256(JSON.stringify(versions)), POST_REPEATABLE_VERSIONS_SHA256,
    'Post-repeatable migration checkpoint changed');
  return versions;
}

export function selectPostRepeatableMigrationVersions(filenames) {
  // Retain every filename/uniqueness guard of the prior public contract.
  selectPostOriginal77MigrationVersions(filenames);
  const names = filenames.filter(name => typeof name === 'string' && name.endsWith('.sql')).sort();
  assert.equal(names[70], '20261001001245_repeatable_challenge_instances_v2.sql');
  return requirePostRepeatableMigrationVersions(names.slice(0, 71).map(name => name.slice(0, 14)));
}
