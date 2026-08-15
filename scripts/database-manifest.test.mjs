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
  assert.equal(isPlatformDifferenceKey('platform-event-trigger/pgrst_ddl_watch'), true);
  assert.equal(isPlatformDifferenceKey('platform-trigger/storage.buckets/enforce_bucket_name_length_trigger'), true);
  assert.equal(isPlatformDifferenceKey('platform-extension/pg_graphql'), true);
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
});
