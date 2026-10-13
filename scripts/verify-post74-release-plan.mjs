import { createHash } from 'node:crypto';
import { selectPost74MigrationVersions } from './production-backup-public-contract.mjs';
import { verifyPost73ReleaseSources } from './verify-post73-release-plan.mjs';

export const FROZEN74_SOURCE_PAIRS_SHA256 = '9af0051b2c2f47a9733ed02675166cab2197aa8aec67020592346e15a2d3ceb7';
export const POST74_REVIEWED_MIGRATION = Object.freeze({
  filename: '20261013091749_site_admin_profile_name_correction.sql',
  sha256: 'd57754f5d0d072a8ada239e6a6d34483c3dd226fa131b208c5a17336bad7af7f',
});
const fail = message => { throw new Error(`Post74 release plan is invalid: ${message}`); };
const same = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
const hash = value => createHash('sha256').update(value).digest('hex');

/** Frozen74 plus exactly one reviewed addition; no caller-supplied pins. */
export function verifyPost74ReleaseSources({ migrationFilenames, migrationSourceHashes } = {}) {
  if (!Array.isArray(migrationFilenames) || !migrationSourceHashes
    || typeof migrationSourceHashes !== 'object') fail('source inventory is missing');
  let exact74;
  try { exact74 = selectPost74MigrationVersions(migrationFilenames); }
  catch { fail('the frozen exact74 prefix changed'); }
  const names = migrationFilenames.filter(name => typeof name === 'string' && name.endsWith('.sql')).sort();
  if (names.length !== 75 || names[74] !== POST74_REVIEWED_MIGRATION.filename) {
    fail('local inventory must contain exactly74 plus the reviewed profile name correction migration');
  }
  verifyPost73ReleaseSources({ migrationFilenames: names.slice(0, 74), migrationSourceHashes });
  if (hash(JSON.stringify(names.slice(0, 74).map(name => [name, migrationSourceHashes[name]])))
    !== FROZEN74_SOURCE_PAIRS_SHA256) fail('frozen74 migration source bytes changed');
  if (migrationSourceHashes[names[74]] !== POST74_REVIEWED_MIGRATION.sha256) {
    fail('reviewed profile name correction migration source bytes changed');
  }
  return Object.freeze({ exact74, exact75: [...exact74, names[74].slice(0, 14)] });
}

export function verifyPost74ReleasePlan({ releaseScope, remote, migrationFilenames, migrationSourceHashes } = {}) {
  const { exact74, exact75 } = verifyPost74ReleaseSources({ migrationFilenames, migrationSourceHashes });
  if (!['full', 'frontend-only'].includes(releaseScope)) fail('old cutover scopes cannot be replayed after74');
  if (!Array.isArray(remote)) fail('authoritative remote inventory is missing');
  if (same(remote, exact74)) {
    if (releaseScope !== 'full') fail('frontend-only requires all75 reviewed migrations already applied');
    return Object.freeze({ mode: 'post74-additive-release', requiresExact70Backup: false,
      requiresExact71Backup: false, requiresExact73Backup: false, requiresExact74Backup: true,
      migrationVersion: exact75.at(-1) });
  }
  if (same(remote, exact75)) return Object.freeze({ mode: 'post75-reviewed-release', requiresExact70Backup: false,
    requiresExact71Backup: false, requiresExact73Backup: false, requiresExact74Backup: false,
    migrationVersion: exact75.at(-1) });
  fail('remote history must be exactly74 or completed75; any other boundary requires coordinated review');
}
