import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createOriginal77FullchainFixture } from './fixtures/original77-fullchain-fixture.mjs';
import { parseRepeatableChallengeCatalogResult, REPEATABLE_CHALLENGE_CATALOG_FIELDS,
  REPEATABLE_CHALLENGE_CATALOG_QUERY } from './verify-production-repeatable-challenge.mjs';

const migrationUrl = new URL('../supabase/migrations/20261001001245_repeatable_challenge_instances_v2.sql', import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');
const q = value => `'${String(value).replaceAll("'", "''")}'`;
const finalSelectMarker = '\nSELECT\n  coalesce((SELECT pg_catalog.count(*)=71';

function derivationQuery(source) {
  const marker = source.indexOf(finalSelectMarker);
  assert(marker > 0, 'Catalog checkpoint final SELECT changed; derivation must be reviewed.');
  return `${source.slice(0, marker)}
SELECT pg_catalog.jsonb_build_object(
  'historySha256',(SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.string_agg(version::text,',' ORDER BY version::text COLLATE "C"),'UTF8')),'hex')
    FROM supabase_migrations.schema_migrations),
  'contracts',(SELECT pg_catalog.jsonb_object_agg(contract_name,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(document::text,'UTF8')),'hex')
    ORDER BY contract_name COLLATE "C") FROM contract_documents)
) FROM canonical_deparse_context;`;
}

async function replayAndDerive({ migrationSource, checkpoint, derivedQuery }) {
  const fixture = await createOriginal77FullchainFixture({ through: 70 });
  try {
    fixture.query(`begin;set local check_function_bodies=on;set local search_path=public,extensions;
      ${migrationSource}
      insert into supabase_migrations.schema_migrations(version,name,statements)
        values('20261001001245','repeatable_challenge_instances_v2',array[${q(migrationSource)}]::text[]);
      commit;`);
    const catalog = JSON.parse(fixture.query(`begin read only;${derivedQuery}commit;`).split('\n').at(-1));
    const history = JSON.parse(fixture.query(`select jsonb_agg(jsonb_build_object('version',version,'name',name)
      order by version collate "C") from supabase_migrations.schema_migrations;`));
    assert.equal(history.length, 71);
    assert.deepEqual(history.at(-1), { version: '20261001001245', name: 'repeatable_challenge_instances_v2' });
    assert.match(catalog.historySha256, /^[0-9a-f]{64}$/u);
    assert.deepEqual(Object.keys(catalog.contracts).sort(), [
      'associations', 'catalog', 'catalog_tables', 'functions', 'instance_tables', 'security', 'share', 'triggers',
    ]);
    for (const digest of Object.values(catalog.contracts)) assert.match(digest, /^[0-9a-f]{64}$/u);
    if (!REPEATABLE_CHALLENGE_CATALOG_QUERY.includes('UNREADY')) {
      const fixedSelect = checkpoint.trim().replace(/;$/u, '');
      const verified = JSON.parse(fixture.query(`begin read only;
        select pg_catalog.row_to_json(checkpoint) from (${fixedSelect}) checkpoint;
        commit;`).split('\n').at(-1));
      assert.deepEqual(parseRepeatableChallengeCatalogResult([verified]),
        Object.fromEntries(REPEATABLE_CHALLENGE_CATALOG_FIELDS.map(key => [key, true])));
    }
    return catalog;
  } finally { fixture.close(); }
}

test('two independent exact70-to71 replays derive identical source-fixed catalog contracts', async () => {
  const migrationSource = await readFile(migrationUrl, 'utf8');
  const sourceHash = hash(migrationSource);
  const derivedQuery = derivationQuery(REPEATABLE_CHALLENGE_CATALOG_QUERY);
  const first = await replayAndDerive({ migrationSource, checkpoint: REPEATABLE_CHALLENGE_CATALOG_QUERY, derivedQuery });
  assert.equal(hash(await readFile(migrationUrl, 'utf8')), sourceHash, 'Migration changed during first derivation.');
  const second = await replayAndDerive({ migrationSource, checkpoint: REPEATABLE_CHALLENGE_CATALOG_QUERY, derivedQuery });
  assert.equal(hash(await readFile(migrationUrl, 'utf8')), sourceHash, 'Migration changed during second derivation.');
  assert.deepEqual(second, first, 'Catalog digests must not depend on replay timestamps or generated identifiers.');
  if (process.env.DOMINION_PRINT_REPEATABLE_CATALOG_DIGESTS === '1') {
    console.log(JSON.stringify(first));
  }
});
