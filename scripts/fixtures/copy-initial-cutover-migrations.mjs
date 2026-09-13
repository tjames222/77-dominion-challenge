import assert from 'node:assert/strict';
import { cp, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  initialCutoverVersions,
  reconciledHistoryVersions,
} from '../verify-production-migration-cutover-plan.mjs';

// These offline recovery tests model the original 53-migration release, not
// today's post-cutover release. Never broaden the production recovery contract
// just because an ordinary new migration has been added to the repository.
export async function copyInitialCutoverMigrations(source, destination) {
  const versions = [...reconciledHistoryVersions, ...initialCutoverVersions];
  assert.equal(versions.length, 53);
  const entries = await readdir(source, { withFileTypes: true });
  await mkdir(destination, { recursive: true });
  for (const version of versions) {
    const matches = entries.filter((entry) =>
      entry.isFile() && entry.name.startsWith(`${version}_`) && entry.name.endsWith('.sql'));
    assert.equal(matches.length, 1, `Expected one original migration for ${version}`);
    await cp(path.join(source, matches[0].name), path.join(destination, matches[0].name));
  }
  const copied = (await readdir(destination)).sort();
  assert.deepEqual(copied.map((name) => name.split('_')[0]), versions);
}
