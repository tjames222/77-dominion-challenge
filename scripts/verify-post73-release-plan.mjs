import { createHash } from 'node:crypto';
import { selectPost73MigrationVersions } from './production-backup-public-contract.mjs';
import { verifyPost71ReleaseSources } from './verify-post71-release-plan.mjs';

export const FROZEN73_SOURCE_PAIRS_SHA256 = '3398d3c025ba93a26649fe681805eff3f6fad4ea92301e07acc453e13fb24698';
export const POST73_REVIEWED_MIGRATION = Object.freeze({
  filename: '20261013055744_site_admin_cleanup_health.sql',
  sha256: 'fc88954b5d41a60d96f02dff032f7f4ace445ed873312597896f0a4a009864bc',
});
const fail = message => { throw new Error(`Post73 release plan is invalid: ${message}`); };
const same = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
const hash = value => createHash('sha256').update(value).digest('hex');

/** Frozen73 plus exactly one reviewed addition; no caller-supplied pins. */
export function verifyPost73ReleaseSources({ migrationFilenames, migrationSourceHashes } = {}) {
  if (!Array.isArray(migrationFilenames) || !migrationSourceHashes
    || typeof migrationSourceHashes !== 'object') fail('source inventory is missing');
  let exact73;
  try { exact73 = selectPost73MigrationVersions(migrationFilenames); }
  catch { fail('the frozen exact73 prefix changed'); }
  const names = migrationFilenames.filter(name => typeof name === 'string' && name.endsWith('.sql')).sort();
  if (names.length !== 74 || names[73] !== POST73_REVIEWED_MIGRATION.filename) {
    fail('local inventory must contain exactly73 plus the reviewed cleanup health migration');
  }
  verifyPost71ReleaseSources({ migrationFilenames: names.slice(0, 73), migrationSourceHashes });
  if (hash(JSON.stringify(names.slice(0, 73).map(name => [name, migrationSourceHashes[name]])))
    !== FROZEN73_SOURCE_PAIRS_SHA256) fail('frozen73 migration source bytes changed');
  if (migrationSourceHashes[names[73]] !== POST73_REVIEWED_MIGRATION.sha256) {
    fail('reviewed cleanup health migration source bytes changed');
  }
  return Object.freeze({ exact73, exact74: [...exact73, names[73].slice(0, 14)] });
}

export function verifyPost73ReleasePlan({ releaseScope, remote, migrationFilenames, migrationSourceHashes } = {}) {
  const { exact73, exact74 } = verifyPost73ReleaseSources({ migrationFilenames, migrationSourceHashes });
  if (!['full', 'frontend-only'].includes(releaseScope)) fail('old cutover scopes cannot be replayed after73');
  if (!Array.isArray(remote)) fail('authoritative remote inventory is missing');
  if (same(remote, exact73)) {
    if (releaseScope !== 'full') fail('frontend-only requires all74 reviewed migrations already applied');
    return Object.freeze({ mode: 'post73-additive-release', requiresExact70Backup: false,
      requiresExact71Backup: false, requiresExact73Backup: true, migrationVersion: exact74.at(-1) });
  }
  if (same(remote, exact74)) return Object.freeze({ mode: 'post74-reviewed-release', requiresExact70Backup: false,
    requiresExact71Backup: false, requiresExact73Backup: false, migrationVersion: exact74.at(-1) });
  fail('remote history must be exactly73 or completed74; any other boundary requires coordinated review');
}
