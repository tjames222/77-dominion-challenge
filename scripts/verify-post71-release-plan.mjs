import { createHash } from 'node:crypto';
import { selectPostRepeatableMigrationVersions } from './production-backup-public-contract.mjs';

export const POST71_REVIEWED_MIGRATIONS = Object.freeze([
  Object.freeze({ filename: '20261007055555_site_admin_account_request_queue_health.sql',
    sha256: 'cd955b3941f520d3a87d8a0260a626a2c275c72160fb6f602bb4bcf513e806a3' }),
  Object.freeze({ filename: '20261007060519_profile_photo_cleanup_monitor_health.sql',
    sha256: 'cc684efa206756e6c518c0a041d487a0c5fc9615700b4df705420262a256d5fc' }),
]);
export const FROZEN71_SOURCE_PAIRS_SHA256 = '0f4d61df647dd040afb6276904f9972874c315d20ee615cec167199a6bfdd7bd';
const fail = message => { throw new Error(`Post71 release plan is invalid: ${message}`); };
const same = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
const hash = value => createHash('sha256').update(value).digest('hex');

/** No environment/caller-provided reviewed pins and no arbitrary future suffix. */
export function verifyPost71ReleaseSources({ migrationFilenames, migrationSourceHashes } = {}) {
  if (!Array.isArray(migrationFilenames) || !migrationSourceHashes || typeof migrationSourceHashes !== 'object') fail('source inventory is missing');
  let exact71;
  try { exact71 = selectPostRepeatableMigrationVersions(migrationFilenames); }
  catch { fail('the frozen exact71 prefix changed'); }
  const names = migrationFilenames.filter(name => typeof name === 'string' && name.endsWith('.sql')).sort();
  if (names.length !== 73 || !same(names.slice(71), POST71_REVIEWED_MIGRATIONS.map(row => row.filename))) {
    fail('local inventory must contain exactly71 plus the two reviewed additive migrations');
  }
  if (hash(JSON.stringify(names.slice(0,71).map(name => [name, migrationSourceHashes[name]]))) !== FROZEN71_SOURCE_PAIRS_SHA256) {
    fail('frozen71 migration source bytes changed');
  }
  for (const row of POST71_REVIEWED_MIGRATIONS) {
    if (migrationSourceHashes[row.filename] !== row.sha256) fail('reviewed additive migration source bytes changed');
  }
  return Object.freeze({ exact71, exact73: [...exact71, ...POST71_REVIEWED_MIGRATIONS.map(row => row.filename.slice(0,14))] });
}

export function verifyPost71ReleasePlan({ releaseScope, remote, migrationFilenames, migrationSourceHashes } = {}) {
  const { exact71, exact73 } = verifyPost71ReleaseSources({ migrationFilenames, migrationSourceHashes });
  if (!['full', 'frontend-only'].includes(releaseScope)) fail('old cutover scopes cannot be replayed after71');
  if (!Array.isArray(remote)) fail('authoritative remote inventory is missing');
  if (same(remote, exact71)) {
    if (releaseScope !== 'full') fail('frontend-only requires all73 reviewed migrations already applied');
    return Object.freeze({ mode: 'post71-additive-release', requiresExact70Backup: false, requiresExact71Backup: true,
      migrationVersion: exact73.at(-1) });
  }
  if (same(remote, exact73)) return Object.freeze({ mode: 'post73-reviewed-release', requiresExact70Backup: false,
    requiresExact71Backup: false, migrationVersion: exact73.at(-1) });
  // A partially applied72 needs coordinated review/forward-fix, never automatic
  // replay of the old cutover or an inferred allowlist extension.
  fail('remote history must be exactly71 or completed73; partial72 requires coordinated review and forward-fix');
}
