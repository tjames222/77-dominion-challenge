import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  applyAllowlist,
  compareManifests,
  parseManifestText,
  recordSha256,
  stableStringify,
  validateAllowlist,
} from './compare-database-manifests.mjs';
import { isPlatformDifferenceKey } from './build-platform-diff-allowlist.mjs';

function manifestRecord(key, value = key) {
  return {
    key,
    kind: 'fixture',
    identity: key,
    definition: { value },
  };
}

function manifestText(...records) {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

test('stableStringify and whole-record hashes ignore object property insertion order', () => {
  const left = { b: 2, a: { d: 4, c: 3 } };
  const right = { a: { c: 3, d: 4 }, b: 2 };
  assert.equal(stableStringify(left), stableStringify(right));
  assert.equal(recordSha256(left), recordSha256(right));
});

test('manifest parser requires canonical sorted unique records', () => {
  const parsed = parseManifestText(manifestText(manifestRecord('a'), manifestRecord('b')));
  assert.equal(parsed.size, 2);
  assert.throws(
    () => parseManifestText(manifestText(manifestRecord('b'), manifestRecord('a'))),
    /not strictly byte-sorted/u,
  );
  assert.throws(
    () => parseManifestText(manifestText(manifestRecord('a'), manifestRecord('a'))),
    /duplicate record key/u,
  );
  assert.throws(() => parseManifestText('\n'), /manifest is empty/u);
});

test('manifest parser rejects partial, extra, and malformed records', () => {
  assert.throws(
    () => parseManifestText(`${JSON.stringify({ key: 'a', kind: 'x' })}\n`),
    /exactly definition/u,
  );
  assert.throws(
    () => parseManifestText(`${JSON.stringify({ ...manifestRecord('a'), extra: true })}\n`),
    /exactly definition/u,
  );
  assert.throws(() => parseManifestText('{oops}\n'), /invalid JSON/u);
});

test('comparison reports added, removed, and changed whole objects', () => {
  const expected = parseManifestText(manifestText(
    manifestRecord('changed', 'before'),
    manifestRecord('removed'),
  ));
  const actual = parseManifestText(manifestText(
    manifestRecord('added'),
    manifestRecord('changed', 'after'),
  ));
  assert.deepEqual(
    compareManifests(expected, actual).map(({ key }) => key),
    ['added', 'changed', 'removed'],
  );
});

test('allowlist accepts only an exact, version-pinned, fully used difference', () => {
  const expectedRecord = manifestRecord('platform-function/storage.filename(text)', 'old');
  const actualRecord = manifestRecord('platform-function/storage.filename(text)', 'new');
  const differences = compareManifests(
    parseManifestText(manifestText(expectedRecord)),
    parseManifestText(manifestText(actualRecord)),
  );
  const allowlist = {
    schemaVersion: 1,
    postgresImage: '17.6.1.141',
    differences: [{
      key: differences[0].key,
      expectedSha256: differences[0].expectedSha256,
      actualSha256: differences[0].actualSha256,
      reason: 'Exact reviewed Supabase platform function delta.',
    }],
  };
  const entries = validateAllowlist(allowlist, '17.6.1.141');
  assert.deepEqual(applyAllowlist(differences, entries), []);
  assert.throws(() => validateAllowlist(allowlist, '17.6.1.142'), /expected Postgres image/u);
});

test('allowlist fails closed on wildcards, mismatched hashes, and unused entries', () => {
  const expectedRecord = manifestRecord('a', 'before');
  const actualRecord = manifestRecord('a', 'after');
  const differences = compareManifests(
    parseManifestText(manifestText(expectedRecord)),
    parseManifestText(manifestText(actualRecord)),
  );
  const baseEntry = {
    key: 'a',
    expectedSha256: differences[0].expectedSha256,
    actualSha256: differences[0].actualSha256,
    reason: 'Exact reviewed platform difference for the fixture.',
  };
  assert.throws(
    () => validateAllowlist({
      schemaVersion: 1,
      postgresImage: '17.6.1.141',
      differences: [{ ...baseEntry, key: 'platform/*' }],
    }, '17.6.1.141'),
    /no wildcard/u,
  );

  const mismatched = validateAllowlist({
    schemaVersion: 1,
    postgresImage: '17.6.1.141',
    differences: [{ ...baseEntry, actualSha256: '0'.repeat(64) }],
  }, '17.6.1.141');
  assert.throws(() => applyAllowlist(differences, mismatched), /unused entries/u);

  const unused = validateAllowlist({
    schemaVersion: 1,
    postgresImage: '17.6.1.141',
    differences: [{ ...baseEntry, key: 'unused' }],
  }, '17.6.1.141');
  assert.throws(() => applyAllowlist(differences, unused), /unused entries/u);
});

test('allowlist candidate builder recognizes only named platform object classes', () => {
  assert.equal(isPlatformDifferenceKey('platform-function/storage.filename(text)'), true);
  assert.equal(isPlatformDifferenceKey('platform-extension/pg_graphql'), true);
  assert.equal(
    isPlatformDifferenceKey('direct-acl/platform-relation-acl/storage.objects/postgres/anon/SELECT'),
    true,
  );
  assert.equal(isPlatformDifferenceKey('effective-acl/relation/storage.objects/authenticated'), true);
  assert.equal(isPlatformDifferenceKey('effective-acl/function/public.rls_auto_enable()/anon'), true);
  assert.equal(isPlatformDifferenceKey('function/public.has_active_entitlement(text)'), false);
  assert.equal(isPlatformDifferenceKey('policy/storage.objects/Users can read own journal photo objects'), false);
});

test('rehearsal cleanup is safe when Bash 3.2 sees no created databases', () => {
  const rehearsal = readFileSync(
    new URL('./rehearse-baseline-reconciliation.sh', import.meta.url),
    'utf8',
  );
  assert.match(rehearsal, /"\$\{created_databases\[@\]-\}"/u);
  assert.match(rehearsal, /\[\[ -n "\$database_name" \]\] \|\| continue/u);
});
