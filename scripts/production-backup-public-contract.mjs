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
export const POST73_BACKUP_MODE = 'post-cleanup-monitor-73';
export const POST73_VERSIONS_SHA256 = 'dedf8b2796a13e3fe6cd36551d555b0aacb710d7b3fad7bd6de4ea2350c17253';
export const POST74_BACKUP_MODE = 'post-admin-cleanup-health-74';
export const POST74_VERSIONS_SHA256 = '638d162275f5fe779660d2cf8e1cce25551f9e389cebe13e3c36f3a4ce9660ef';
export const POST75_BACKUP_MODE = 'post-admin-profile-name-75';
export const POST75_VERSIONS_SHA256 = 'd6cbbf803760a04b06aed3db2ba386bcbe16e43d59f208974b96367360618760';
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

export function requirePost73MigrationVersions(versions) {
  assert(Array.isArray(versions));
  assert.equal(versions.length, 73, 'Incomplete post73 migration checkpoint');
  requirePostRepeatableMigrationVersions(versions.slice(0, 71));
  assert.equal(sha256(JSON.stringify(versions)), POST73_VERSIONS_SHA256,
    'Post73 migration checkpoint changed');
  return versions;
}

export function selectPost73MigrationVersions(filenames) {
  selectPostRepeatableMigrationVersions(filenames);
  const names = filenames.filter(name => typeof name === 'string' && name.endsWith('.sql')).sort();
  assert.deepEqual(names.slice(71, 73), [
    '20261007055555_site_admin_account_request_queue_health.sql',
    '20261007060519_profile_photo_cleanup_monitor_health.sql',
  ]);
  return requirePost73MigrationVersions(names.slice(0, 73).map(name => name.slice(0, 14)));
}

export function requirePost74MigrationVersions(versions) {
  assert(Array.isArray(versions));
  assert.equal(versions.length, 74, 'Incomplete post74 migration checkpoint');
  requirePost73MigrationVersions(versions.slice(0, 73));
  assert.equal(sha256(JSON.stringify(versions)), POST74_VERSIONS_SHA256,
    'Post74 migration checkpoint changed');
  return versions;
}

export function selectPost74MigrationVersions(filenames) {
  selectPost73MigrationVersions(filenames);
  const names = filenames.filter(name => typeof name === 'string' && name.endsWith('.sql')).sort();
  assert.equal(names[73], '20261013055744_site_admin_cleanup_health.sql');
  return requirePost74MigrationVersions(names.slice(0, 74).map(name => name.slice(0, 14)));
}

export function requirePost75MigrationVersions(versions) {
  assert(Array.isArray(versions));
  assert.equal(versions.length, 75, 'Incomplete post75 migration checkpoint');
  requirePost74MigrationVersions(versions.slice(0, 74));
  assert.equal(versions.at(-1), '20261013091749', 'Unexpected post75 migration checkpoint');
  assert.equal(sha256(JSON.stringify(versions)), POST75_VERSIONS_SHA256,
    'Post75 migration checkpoint changed');
  return versions;
}

export function selectPost75MigrationVersions(filenames) {
  selectPost74MigrationVersions(filenames);
  const names = filenames.filter(name => typeof name === 'string' && name.endsWith('.sql')).sort();
  assert.equal(names[74], '20261013091749_site_admin_profile_name_correction.sql');
  return requirePost75MigrationVersions(names.slice(0, 75).map(name => name.slice(0, 14)));
}
