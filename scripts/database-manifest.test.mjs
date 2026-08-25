import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  applyAllowlist,
  compareManifests,
  parseManifestText,
  recordSha256,
  stableStringify,
  validateAllowlist,
  platformPresenceSuppressionRule,
} from './compare-database-manifests.mjs';
import {
  buildPlatformAllowlist,
  isPlatformDifferenceKey,
} from './build-platform-diff-allowlist.mjs';

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

function manifestMap(...records) {
  return new Map(records.map((record) => [record.key, record]));
}

function platformPresenceRecord(identity, present, required = false) {
  return {
    key: `platform-relation-presence/${identity}`,
    kind: 'platform-relation-presence',
    identity,
    definition: { present, required },
  };
}

function exactAllowlistEntry(difference) {
  return {
    key: difference.key,
    expectedSha256: difference.expectedSha256,
    actualSha256: difference.actualSha256,
    reason: 'Exact reviewed optional platform relation presence difference.',
  };
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

test('an exact optional-presence allowlist suppresses only records that cannot exist on the absent side', () => {
  const identity = 'storage.iceberg_namespaces';
  const expected = manifestMap(
    platformPresenceRecord(identity, true),
    {
      key: `platform-relation/${identity}`,
      kind: 'platform-relation',
      identity,
      definition: { owner: 'postgres' },
    },
    {
      key: `direct-acl/platform-relation-acl/${identity}/postgres/anon/SELECT`,
      kind: 'direct-acl',
      identity,
      definition: { objectKind: 'platform-relation-acl', grantor: 'postgres' },
    },
    {
      key: `direct-acl/platform-column-acl/${identity}.id/postgres/anon/SELECT`,
      kind: 'direct-acl',
      identity: `${identity}.id`,
      definition: { objectKind: 'platform-column-acl', grantor: 'postgres' },
    },
    {
      key: `effective-acl/relation/${identity}/anon`,
      kind: 'effective-acl',
      identity,
      definition: { objectKind: 'relation', role: 'anon' },
    },
    {
      key: `effective-acl/column/${identity}.id/anon`,
      kind: 'effective-acl',
      identity: `${identity}.id`,
      definition: { objectKind: 'column', role: 'anon' },
    },
    {
      key: `platform-trigger/${identity}/platform_refresh`,
      kind: 'platform-trigger',
      identity: `${identity}.platform_refresh`,
      definition: { enabled: 'O' },
    },
    {
      key: 'storage-row-inventory/iceberg_namespaces',
      kind: 'storage-row-inventory',
      identity: `${identity}/all-rows`,
      definition: { rowCount: 0, rowsSha256: 'empty' },
    },
  );
  const actual = manifestMap(
    platformPresenceRecord(identity, false),
    {
      key: 'storage-row-inventory/iceberg_namespaces',
      kind: 'storage-row-inventory',
      identity: `${identity}/all-rows`,
      definition: { rowCount: 0, rowsSha256: 'empty' },
    },
  );
  const differences = compareManifests(expected, actual);
  const presenceDifference = differences.find(({ key }) => (
    key === `platform-relation-presence/${identity}`
  ));
  assert.deepEqual(platformPresenceSuppressionRule(presenceDifference), {
    identity,
    absentSide: 'actual',
  });
  const entries = validateAllowlist({
    schemaVersion: 1,
    postgresImage: '17.6.1.141',
    differences: [exactAllowlistEntry(presenceDifference)],
  }, '17.6.1.141');
  assert.deepEqual(applyAllowlist(differences, entries), []);
});

test('presence suppression cannot hide row data, policies, unrelated objects, or present-side drift', () => {
  const identity = 'storage.iceberg_tables';
  const expected = manifestMap(
    platformPresenceRecord(identity, true),
    {
      key: `platform-relation/${identity}`,
      kind: 'platform-relation',
      identity,
      definition: { owner: 'postgres', shape: 'expected' },
    },
    {
      key: 'platform-relation/storage.objects',
      kind: 'platform-relation',
      identity: 'storage.objects',
      definition: { owner: 'postgres' },
    },
    {
      key: 'policy/storage.iceberg_tables/application_policy',
      kind: 'policy',
      identity: 'storage.iceberg_tables.application_policy',
      definition: { command: 'r' },
    },
    {
      key: 'storage-row-inventory/iceberg_tables',
      kind: 'storage-row-inventory',
      identity: `${identity}/all-rows`,
      definition: { rowCount: 1, rowsSha256: 'nonempty' },
    },
  );
  const actual = manifestMap(
    platformPresenceRecord(identity, false),
    {
      key: `platform-relation/${identity}`,
      kind: 'platform-relation',
      identity,
      definition: { owner: 'postgres', shape: 'unexpected-record-on-absent-side' },
    },
    {
      key: 'storage-row-inventory/iceberg_tables',
      kind: 'storage-row-inventory',
      identity: `${identity}/all-rows`,
      definition: { rowCount: 0, rowsSha256: 'empty' },
    },
  );
  const differences = compareManifests(expected, actual);
  const presenceDifference = differences.find(({ key }) => (
    key === `platform-relation-presence/${identity}`
  ));
  const entries = validateAllowlist({
    schemaVersion: 1,
    postgresImage: '17.6.1.141',
    differences: [exactAllowlistEntry(presenceDifference)],
  }, '17.6.1.141');
  assert.deepEqual(
    applyAllowlist(differences, entries).map(({ key }) => key),
    [
      'platform-relation/storage.iceberg_tables',
      'platform-relation/storage.objects',
      'policy/storage.iceberg_tables/application_policy',
      'storage-row-inventory/iceberg_tables',
    ],
  );
});

test('allowlist validation categorically rejects Storage manifest and fingerprint rows', () => {
  const baseEntry = {
    expectedSha256: '0'.repeat(64),
    actualSha256: '1'.repeat(64),
    reason: 'Attempted exact Storage inventory exception must be rejected.',
  };
  for (const key of [
    'storage-row-inventory/iceberg_tables',
    'data/storage.iceberg_tables/all-rows',
  ]) {
    assert.throws(() => validateAllowlist({
      schemaVersion: 1,
      postgresImage: '17.6.1.141',
      differences: [{ ...baseEntry, key }],
    }, '17.6.1.141'), /Storage row inventory and cannot be allowlisted/u);
  }
});

test('candidate builder emits only optional presence while preserving empty inventories', () => {
  const identity = 'storage.iceberg_tables';
  const inventory = {
    key: 'storage-row-inventory/iceberg_tables',
    kind: 'storage-row-inventory',
    identity: `${identity}/all-rows`,
    definition: { rowCount: 0, rowsSha256: 'empty' },
  };
  const expected = manifestMap(
    platformPresenceRecord(identity, true),
    {
      key: `platform-relation/${identity}`,
      kind: 'platform-relation',
      identity,
      definition: { owner: 'postgres' },
    },
    inventory,
  );
  const actual = manifestMap(platformPresenceRecord(identity, false), inventory);
  const allowlist = buildPlatformAllowlist(expected, actual, '17.6.1.141');
  assert.deepEqual(
    allowlist.differences.map(({ key }) => key),
    [`platform-relation-presence/${identity}`],
  );

  const changedInventory = {
    ...inventory,
    definition: { rowCount: 1, rowsSha256: 'nonempty' },
  };
  assert.throws(
    () => buildPlatformAllowlist(expected, manifestMap(
      platformPresenceRecord(identity, false),
      changedInventory,
    ), '17.6.1.141'),
    /storage-row-inventory\/iceberg_tables/u,
  );
});

test('candidate builder refuses an absent mandatory vector relation', () => {
  const identity = 'storage.vector_indexes';
  const differences = compareManifests(
    manifestMap(platformPresenceRecord(identity, true, true)),
    manifestMap(platformPresenceRecord(identity, false, true)),
  );
  assert.throws(
    () => buildPlatformAllowlist(
      manifestMap(platformPresenceRecord(identity, true, true)),
      manifestMap(platformPresenceRecord(identity, false, true)),
      '17.6.1.141',
    ),
    /platform-relation-presence\/storage\.vector_indexes/u,
  );
  assert.throws(() => validateAllowlist({
    schemaVersion: 1,
    postgresImage: '17.6.1.141',
    differences: [exactAllowlistEntry(differences[0])],
  }, '17.6.1.141'), /not an optional platform relation presence record/u);
});

test('a malformed optional presence record cannot be directly allowlisted', () => {
  const identity = 'storage.iceberg_tables';
  const differences = compareManifests(
    manifestMap(platformPresenceRecord(identity, true)),
    manifestMap(platformPresenceRecord(identity, false, true)),
  );
  const entries = validateAllowlist({
    schemaVersion: 1,
    postgresImage: '17.6.1.141',
    differences: [exactAllowlistEntry(differences[0])],
  }, '17.6.1.141');
  assert.throws(
    () => applyAllowlist(differences, entries),
    /not an exact optional absent\/present transition/u,
  );
});

test('optional platform relation structure must match exactly when both sides are present', () => {
  const identity = 'storage.iceberg_namespaces';
  const expected = manifestMap(
    platformPresenceRecord(identity, true),
    {
      key: `platform-relation/${identity}`,
      kind: 'platform-relation',
      identity,
      definition: { owner: 'postgres', shape: 'expected' },
    },
  );
  const actual = manifestMap(
    platformPresenceRecord(identity, true),
    {
      key: `platform-relation/${identity}`,
      kind: 'platform-relation',
      identity,
      definition: { owner: 'postgres', shape: 'drifted' },
    },
  );
  assert.throws(
    () => buildPlatformAllowlist(expected, actual, '17.6.1.141'),
    /platform-relation\/storage\.iceberg_namespaces/u,
  );
  const [difference] = compareManifests(expected, actual);
  assert.throws(() => validateAllowlist({
    schemaVersion: 1,
    postgresImage: '17.6.1.141',
    differences: [exactAllowlistEntry(difference)],
  }, '17.6.1.141'), /only its exact presence transition can be allowlisted/u);
});

test('allowlist candidate builder recognizes only named platform object classes', () => {
  assert.equal(isPlatformDifferenceKey('platform-function/storage.filename(text)'), true);
  assert.equal(isPlatformDifferenceKey('platform-event-trigger/pgrst_ddl_watch'), true);
  assert.equal(isPlatformDifferenceKey('platform-trigger/storage.buckets/enforce_bucket_name_length_trigger'), true);
  assert.equal(isPlatformDifferenceKey('platform-extension/pg_graphql'), true);
  assert.equal(
    isPlatformDifferenceKey('platform-relation-presence/storage.iceberg_tables'),
    false,
  );
  assert.equal(
    isPlatformDifferenceKey('direct-acl/platform-relation-acl/storage.objects/postgres/anon/SELECT'),
    true,
  );
  assert.equal(
    isPlatformDifferenceKey('direct-acl/platform-column-acl/storage.objects.owner/postgres/anon/SELECT'),
    true,
  );
  assert.equal(
    isPlatformDifferenceKey('direct-acl/platform-function-acl/extensions.pgrst_ddl_watch()/postgres/anon/EXECUTE'),
    true,
  );
  assert.equal(isPlatformDifferenceKey('effective-acl/relation/storage.objects/authenticated'), true);
  assert.equal(isPlatformDifferenceKey('effective-acl/column/storage.objects.owner/authenticated'), true);
  assert.equal(isPlatformDifferenceKey('effective-acl/function/extensions.pgrst_ddl_watch()/anon'), true);
  assert.equal(isPlatformDifferenceKey('effective-acl/function/public.rls_auto_enable()/anon'), true);
  assert.equal(isPlatformDifferenceKey('function/public.has_active_entitlement(text)'), false);
  assert.equal(
    isPlatformDifferenceKey('direct-acl/column-acl/public.profiles.email/postgres/anon/SELECT'),
    false,
  );
  assert.equal(isPlatformDifferenceKey('event-trigger/application_ddl_hook'), false);
  assert.equal(isPlatformDifferenceKey('trigger/storage.objects/application_guard'), false);
  assert.equal(isPlatformDifferenceKey('policy/storage.objects/Users can read own journal photo objects'), false);
});

test('rehearsal cleanup is safe when Bash 3.2 sees no created databases', () => {
  const rehearsal = readFileSync(
    new URL('./rehearse-baseline-reconciliation.sh', import.meta.url),
    'utf8',
  );
  assert.match(rehearsal, /"\$\{created_databases\[@\]-\}"/u);
  assert.match(rehearsal, /\[\[ -n "\$database_name" \]\] \|\| continue/u);
  assert.match(rehearsal, /if \[\[ -n "\$migration_pid" \]\]; then/u);
  assert.match(rehearsal, /if \[\[ "\$writer_fd_open" == "true" \]\]; then/u);
  assert.ok(
    rehearsal.indexOf('if [[ -n "$migration_pid" ]]')
      < rehearsal.indexOf('if [[ "$writer_fd_open" == "true" ]]'),
    'cleanup must stop the migration before closing the writer controller',
  );
});

test('rehearsal accepts only this repository local Supabase container', () => {
  const rehearsal = readFileSync(
    new URL('./rehearse-baseline-reconciliation.sh', import.meta.url),
    'utf8',
  );
  assert.match(rehearsal, /expected_database_container="supabase_db_\$\{project_id\}"/u);
  assert.match(rehearsal, /SUPABASE_DB_CONTAINER must equal \$expected_database_container/u);
  assert.match(rehearsal, /com\.supabase\.cli\.project/u);
  assert.match(rehearsal, /com\.docker\.compose\.project/u);
  assert.match(rehearsal, /identity_verified=false/u);
  assert.match(
    rehearsal,
    /if \[\[ "\$identity_verified" == "true" \]\]; then[\s\S]*cleanup_helper_roles/u,
  );
  assert.ok(
    rehearsal.indexOf('identity_verified=true')
      > rehearsal.indexOf("expected PostgreSQL server version 17.6"),
    'cleanup mutation must remain disabled until every identity check passes',
  );
});

test('frozen checkpoints contain the exact legacy Storage policy and inventory surface', () => {
  const storageRelations = [
    'buckets',
    'buckets_analytics',
    'buckets_vectors',
    'iceberg_namespaces',
    'iceberg_tables',
    'objects',
    's3_multipart_uploads',
    's3_multipart_uploads_parts',
    'vector_indexes',
  ];
  const firstColumns = new Map([
    ['buckets', 'id'],
    ['buckets_analytics', 'name'],
    ['buckets_vectors', 'id'],
    ['iceberg_namespaces', 'id'],
    ['iceberg_tables', 'id'],
    ['objects', 'id'],
    ['s3_multipart_uploads', 'id'],
    ['s3_multipart_uploads_parts', 'id'],
    ['vector_indexes', 'id'],
  ]);
  const expectedPolicyKeys = [
    'policy/storage.objects/"Users can delete own journal photo objects"',
    'policy/storage.objects/"Users can read own journal photo objects"',
    'policy/storage.objects/"Users can update own journal photo objects"',
    'policy/storage.objects/"Users can upload own journal photo objects"',
  ];
  const expectedTriggerKeys = [
    'platform-trigger/storage.buckets/enforce_bucket_name_length_trigger',
    'platform-trigger/storage.buckets/protect_buckets_delete',
    'platform-trigger/storage.objects/protect_objects_delete',
    'platform-trigger/storage.objects/update_objects_updated_at',
  ];
  const emptySha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  for (const manifestName of [
    'legacy-migration-2.source.manifest.jsonl',
    'migration-3.target.manifest.jsonl',
  ]) {
    const manifestUrl = new URL(
      `../supabase/tests/reconciliation/${manifestName}`,
      import.meta.url,
    );
    const records = parseManifestText(
      readFileSync(manifestUrl, 'utf8'),
      manifestUrl.pathname,
    );
    const actualPolicyKeys = [...records.keys()]
      .filter((key) => key.startsWith('policy/storage.'));
    assert.deepEqual(actualPolicyKeys, expectedPolicyKeys, manifestName);
    const actualTriggerKeys = [...records.keys()]
      .filter((key) => /^(?:platform-)?trigger\/storage\./u.test(key));
    assert.deepEqual(actualTriggerKeys, expectedTriggerKeys, manifestName);

    for (const helperName of ['filename', 'foldername']) {
      const helperIdentity = `storage.${helperName}(name text)`;
      const helper = records.get(`platform-function/${helperIdentity}`);
      assert.ok(helper, `${manifestName} is missing ${helperIdentity}`);
      assert.ok(helper.definition.bodyBase64, `${manifestName} is missing ${helperIdentity} body`);
      for (const roleName of ['anon', 'authenticated', 'service_role']) {
        assert.ok(
          records.has(`effective-acl/function/${helperIdentity}/${roleName}`),
          `${manifestName} is missing ${helperIdentity}/${roleName} function ACL`,
        );
      }
    }

    for (const relationName of storageRelations) {
      const presence = records.get(`platform-relation-presence/storage.${relationName}`);
      assert.deepEqual(
        presence?.definition,
        {
          present: true,
          required: !['iceberg_namespaces', 'iceberg_tables'].includes(relationName),
        },
        `${manifestName} is missing the ${relationName} presence contract`,
      );
      const relation = records.get(`platform-relation/storage.${relationName}`);
      assert.ok(relation, `${manifestName} is missing the ${relationName} definition`);
      for (const roleName of ['anon', 'authenticated', 'service_role']) {
        assert.ok(
          records.has(`effective-acl/relation/storage.${relationName}/${roleName}`),
          `${manifestName} is missing the ${relationName}/${roleName} relation ACL`,
        );
        assert.ok(
          records.has(
            `effective-acl/column/storage.${relationName}.${firstColumns.get(relationName)}/${roleName}`,
          ),
          `${manifestName} is missing the ${relationName}/${roleName} column ACL`,
        );
      }
    }

    for (const relationName of ['buckets_vectors', 'vector_indexes']) {
      const relation = records.get(`platform-relation/storage.${relationName}`);
      assert.equal(
        relation?.definition.owner,
        'supabase_storage_admin',
        `${manifestName}:${relationName} owner`,
      );
      for (const roleName of ['anon', 'authenticated', 'service_role']) {
        assert.deepEqual(
          records.get(
            `effective-acl/relation/storage.${relationName}/${roleName}`,
          )?.definition.privileges,
          ['SELECT'],
          `${manifestName}:${relationName}/${roleName} privileges`,
        );
        const directSelect = records.get(
          `direct-acl/platform-relation-acl/storage.${relationName}/supabase_storage_admin/${roleName}/SELECT`,
        );
        assert.equal(
          directSelect?.definition.grantable,
          false,
          `${manifestName}:${relationName}/${roleName} direct SELECT grantability`,
        );
      }
      const vectorDirectAcls = [...records.values()].filter((record) =>
        record.kind === 'direct-acl'
        && (
          record.identity === `storage.${relationName}`
          || record.identity.startsWith(`storage.${relationName}.`)
        ));
      for (const directAcl of vectorDirectAcls) {
        assert.notEqual(
          directAcl.definition.grantee,
          'postgres',
          `${manifestName}:${directAcl.identity} must not grant directly to postgres`,
        );
      }
    }

    const standardBucket = records.get('storage-bucket/journal-progress');
    assert.equal(standardBucket?.definition.type, 'STANDARD', manifestName);
    for (const relationName of storageRelations.filter((name) => name !== 'buckets')) {
      const inventory = records.get(`storage-row-inventory/${relationName}`);
      assert.equal(inventory?.definition.rowCount, 0, `${manifestName}:${relationName}`);
      assert.equal(
        inventory?.definition.rowsSha256,
        emptySha256,
        `${manifestName}:${relationName}`,
      );
    }
  }
});

test('rehearsal and migration gate every pinned Storage inventory relation', () => {
  const manifestSql = readFileSync(new URL('./database-manifest.sql', import.meta.url), 'utf8');
  const fingerprintSql = readFileSync(
    new URL('./baseline-data-fingerprint.sql', import.meta.url),
    'utf8',
  );
  const rehearsal = readFileSync(
    new URL('./rehearse-baseline-reconciliation.sh', import.meta.url),
    'utf8',
  );
  const baseline = readFileSync(
    new URL('../supabase/migrations/20260707170000_baseline.sql', import.meta.url),
    'utf8',
  );
  const relationCases = new Map([
    ['buckets', 'unknown-storage-bucket'],
    ['buckets_analytics', 'analytics-bucket'],
    ['buckets_vectors', 'vector-bucket'],
    ['iceberg_namespaces', 'iceberg-namespace'],
    ['iceberg_tables', 'iceberg-table'],
    ['objects', 'storage-object'],
    ['s3_multipart_uploads', 'multipart-upload'],
    ['s3_multipart_uploads_parts', 'multipart-upload-part'],
    ['vector_indexes', 'vector-index'],
  ]);

  for (const [relationName, fixtureName] of relationCases) {
    for (const source of [manifestSql, fingerprintSql, baseline]) {
      assert.match(source, new RegExp(`['\"]${relationName}['\"]`, 'u'));
    }
    assert.match(rehearsal, new RegExp(`source-drift/${fixtureName}\\.sql`, 'u'));
  }
  assert.match(rehearsal, /array_agg\([\s\S]*four legacy journal Storage policies/u);
  assert.doesNotMatch(rehearsal, /Users can read own profile photo objects/u);
  assert.match(manifestSql, /procedure_value\.proname in \('filename', 'foldername'\)/u);
  assert.match(rehearsal, /changed-storage-policy-helper-function \\/u);
  const vectorPrivilegeFixtures = [
    {
      caseName: 'vector_lock_privilege',
      fileName: 'changed-vector-lock-privilege',
      relationName: 'buckets_vectors',
      statement: 'grant insert on storage.buckets_vectors to postgres;',
    },
    {
      caseName: 'vector_column_lock_privilege',
      fileName: 'changed-vector-column-lock-privilege',
      relationName: 'vector_indexes',
      statement: 'grant insert (id) on storage.vector_indexes to postgres;',
    },
    {
      caseName: 'vector_table_select_grant_option',
      fileName: 'changed-vector-table-select-grant-option',
      relationName: 'vector_indexes',
      statement: 'grant select on table storage.vector_indexes to postgres with grant option;',
    },
    {
      caseName: 'vector_column_select_grant_option',
      fileName: 'changed-vector-column-select-grant-option',
      relationName: 'buckets_vectors',
      statement: 'grant select (id) on table storage.buckets_vectors to postgres with grant option;',
    },
  ];
  const driftList = rehearsal.slice(
    rehearsal.indexOf('for drift_case in'),
    rehearsal.indexOf('; do', rehearsal.indexOf('for drift_case in')),
  );
  for (const fixture of vectorPrivilegeFixtures) {
    const directInvocation = [
      `expect_failure_without_change ${fixture.caseName} \\`,
      `  "$fixture_directory/source-drift/${fixture.fileName}.sql"`,
    ].join('\n');
    assert.ok(
      rehearsal.includes(directInvocation),
      `missing direct failure fixture ${fixture.fileName}`,
    );
    assert.ok(
      driftList.includes(fixture.fileName),
      `missing manifest drift fixture ${fixture.fileName}`,
    );
    const fixtureSql = readFileSync(
      new URL(
        `../supabase/tests/reconciliation/source-drift/${fixture.fileName}.sql`,
        import.meta.url,
      ),
      'utf8',
    ).replace(/\s+/gu, ' ').trim();
    assert.equal(fixtureSql, fixture.statement);
    assert.match(fixtureSql, new RegExp(`storage\\.${fixture.relationName}`, 'u'));
  }
  assert.match(
    rehearsal,
    /draining_migration_backend_pid[\s\S]*activity\.backend_type = 'client backend'[\s\S]*not lock\.granted[\s\S]*lock\.mode = 'ShareRowExclusiveLock'/u,
  );
  assert.match(rehearsal, /mkfifo "\$draining_writer_fifo"/u);
  assert.match(rehearsal, /activity\.state = 'idle in transaction'/u);
  assert.match(rehearsal, /activity\.pid <> \$\{draining_writer_backend_pid\}/u);
  assert.ok(
    rehearsal.indexOf('[[ "$draining_migration_backend_pid" =~ ^[0-9]+$ ]]')
      < rehearsal.indexOf("  'commit;' "),
    'the controller must not release the writer before observing migration lock wait',
  );
  assert.doesNotMatch(rehearsal, /pg_sleep\(2\)/u);
  assert.match(rehearsal, /--agent no/u);
  assert.match(rehearsal, /At statement: 5/u);
  assert.match(rehearsal, /--set VERBOSITY=verbose/u);
  assert.match(rehearsal, /P0001: Baseline refused:/u);
  assert.match(
    rehearsal,
    /purchase_rows_fingerprint[\s\S]*draining_actual_purchase_fingerprint[\s\S]*draining_expected_purchase_fingerprint/u,
  );
  assert.match(
    rehearsal,
    /draining\.before\.fingerprint\.jsonl[\s\S]*draining\.actual\.fingerprint\.jsonl/u,
  );
  assert.match(
    rehearsal,
    /changed-storage-policy-helper-function-acl \\/u,
  );
  assert.match(rehearsal, /source-drift\/absent-iceberg-relations\.sql/u);
  assert.match(rehearsal, /source-drift\/absent-vector-relation\.sql/u);
  assert.match(rehearsal, /source-drift\/nonempty-iceberg-namespace\.sql/u);
  assert.match(rehearsal, /optional-iceberg\.allowlist\.json/u);
  assert.match(rehearsal, /exactly two presence entries/u);
  assert.match(rehearsal, /storage-row-inventory\/iceberg_namespaces/u);
});

test('manifest and fingerprint resolve optional Iceberg without querying an absent relation', () => {
  const manifestSql = readFileSync(new URL('./database-manifest.sql', import.meta.url), 'utf8');
  const fingerprintSql = readFileSync(
    new URL('./baseline-data-fingerprint.sql', import.meta.url),
    'utf8',
  );
  for (const sql of [manifestSql, fingerprintSql]) {
    assert.match(sql, /pg_catalog\.to_regclass\(pg_catalog\.format\(/u);
    assert.match(sql, /\('storage', 'buckets_vectors', true\)/u);
    assert.match(sql, /\('storage', 'vector_indexes', true\)/u);
    assert.match(sql, /\('storage', 'iceberg_namespaces', false\)/u);
    assert.match(sql, /\('storage', 'iceberg_tables', false\)/u);
    assert.match(sql, /if relation_oid is null then[\s\S]*row_count := 0;[\s\S]*digest\(convert_to\('', 'UTF8'\), 'sha256'\)/u);
    assert.match(sql, /from %s source_row/u);
    assert.doesNotMatch(sql, /from storage\.%I source_row/u);
  }
  assert.match(manifestSql, /platform-relation-presence\/%I\.%I/u);
  assert.match(manifestSql, /'present', inventory\.relation_oid is not null/u);
  assert.match(manifestSql, /'required', inventory\.required/u);
  assert.match(manifestSql, /Database manifest refused: required platform relation\(s\) are absent/u);
  assert.match(fingerprintSql, /Baseline fingerprint refused: required platform relation\(s\) are absent/u);
});

test('db-url capture falls back to the pinned Docker psql client', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'database-manifest-docker-psql.'));
  try {
    const fakeDocker = join(fixtureRoot, 'docker');
    const dockerLog = join(fixtureRoot, 'docker.log');
    const output = join(fixtureRoot, 'manifest.jsonl');
    writeFileSync(fakeDocker, [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'printf \'%s\\n\' "$*" >"$FAKE_DOCKER_LOG"',
      'printf \'%s\\n\' \'{"key":"fixture/docker","kind":"fixture","identity":"docker","definition":{}}\'',
    ].join('\n'));
    chmodSync(fakeDocker, 0o755);

    execFileSync('bash', [
      new URL('./capture-database-manifest.sh', import.meta.url).pathname,
      '--db-url',
      'postgresql://readonly:fixture@database.invalid:5432/postgres',
      '--docker-psql',
      '--output',
      output,
    ], {
      env: {
        ...process.env,
        DOCKER_BIN: fakeDocker,
        FAKE_DOCKER_LOG: dockerLog,
        SUPABASE_INTERNAL_IMAGE_REGISTRY: 'public.ecr.aws',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    assert.match(
      readFileSync(dockerLog, 'utf8'),
      /run --rm --interactive --env PGAPPNAME=77dc-baseline-manifest-read-only --entrypoint psql public\.ecr\.aws\/supabase\/postgres:17\.6\.1\.141 postgresql:\/\/readonly:fixture@database\.invalid:5432\/postgres --no-psqlrc --quiet --set ON_ERROR_STOP=1 --file -/u,
    );
    assert.deepEqual(
      [...parseManifestText(readFileSync(output, 'utf8')).keys()],
      ['fixture/docker'],
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
