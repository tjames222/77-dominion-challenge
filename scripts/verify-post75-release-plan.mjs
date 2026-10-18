import { createHash } from 'node:crypto';
import { selectPost75MigrationVersions } from './production-backup-public-contract.mjs';
import { verifyPost74ReleaseSources } from './verify-post74-release-plan.mjs';

export const FROZEN75_SOURCE_PAIRS_SHA256 = '5263339fef7b555f0dee2f95c8b25ac06bb25618475803ecc3e6c626daee2016';
export const POST75_REVIEWED_MIGRATION = Object.freeze({
  filename: '20261018013111_site_admin_activation_review_health.sql',
  sha256: '3f7f90d3943aa4121f5e6867b003b40546fbb4d3f297c87261ae3810ba7ee1db',
});
const fail = message => { throw new Error(`Post75 release plan is invalid: ${message}`); };
const same = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
const hash = value => createHash('sha256').update(value).digest('hex');

/** Frozen75 plus exactly one reviewed addition; no caller-supplied pins. */
export function verifyPost75ReleaseSources({ migrationFilenames, migrationSourceHashes } = {}) {
  if (!Array.isArray(migrationFilenames) || !migrationSourceHashes
    || typeof migrationSourceHashes !== 'object') fail('source inventory is missing');
  let exact75;
  try { exact75 = selectPost75MigrationVersions(migrationFilenames); }
  catch { fail('the frozen exact75 prefix changed'); }
  const names = migrationFilenames.filter(name => typeof name === 'string' && name.endsWith('.sql')).sort();
  if (names.length !== 76 || names[75] !== POST75_REVIEWED_MIGRATION.filename) {
    fail('local inventory must contain exactly75 plus the reviewed activation review health migration');
  }
  verifyPost74ReleaseSources({ migrationFilenames: names.slice(0, 75), migrationSourceHashes });
  if (hash(JSON.stringify(names.slice(0, 75).map(name => [name, migrationSourceHashes[name]])))
    !== FROZEN75_SOURCE_PAIRS_SHA256) fail('frozen75 migration source bytes changed');
  if (migrationSourceHashes[names[75]] !== POST75_REVIEWED_MIGRATION.sha256) {
    fail('reviewed activation review health migration source bytes changed');
  }
  return Object.freeze({ exact75, exact76: [...exact75, names[75].slice(0, 14)] });
}

export function verifyPost75ReleasePlan({ releaseScope, remote, migrationFilenames, migrationSourceHashes } = {}) {
  const { exact75, exact76 } = verifyPost75ReleaseSources({ migrationFilenames, migrationSourceHashes });
  if (!['full', 'frontend-only'].includes(releaseScope)) fail('old cutover scopes cannot be replayed after75');
  if (!Array.isArray(remote)) fail('authoritative remote inventory is missing');
  if (same(remote, exact75)) {
    if (releaseScope !== 'full') fail('frontend-only requires all76 reviewed migrations already applied');
    return Object.freeze({ mode: 'post75-additive-release', requiresExact70Backup: false,
      requiresExact71Backup: false, requiresExact73Backup: false, requiresExact74Backup: false,
      requiresExact75Backup: true, migrationVersion: exact76.at(-1) });
  }
  if (same(remote, exact76)) return Object.freeze({ mode: 'post76-reviewed-release', requiresExact70Backup: false,
    requiresExact71Backup: false, requiresExact73Backup: false, requiresExact74Backup: false,
    requiresExact75Backup: false, migrationVersion: exact76.at(-1) });
  fail('remote history must be exactly75 or completed76; any other boundary requires coordinated review');
}
