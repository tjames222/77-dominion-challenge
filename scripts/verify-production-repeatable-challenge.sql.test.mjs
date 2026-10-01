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
const instanceBadgeKeys = ['streak_flame','seven_sealed','full_streak_14','full_streak_28','full_streak_56','full_streak_70',
  'check_ins_7','check_ins_14','check_ins_21','check_ins_26','check_ins_39','check_ins_50','check_ins_60','check_ins_70'];

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
    const preview = JSON.parse(await readFile(new URL('../src/static/badge-catalog.v1.json', import.meta.url), 'utf8'));
    const expectedCopy = preview.badges.filter(row => instanceBadgeKeys.includes(row.key))
      .map(row => ({ key: row.key, description: row.description, requirement: row.requirement })).sort((a,b) => a.key.localeCompare(b.key));
    assert.equal(expectedCopy.length, 14);
    const actualCopy = JSON.parse(fixture.query(`select jsonb_agg(jsonb_build_object('key',badge_key,
      'description',description,'requirement',requirement) order by badge_key collate "C")
      from public.badge_definitions where badge_key in (${instanceBadgeKeys.map(q).join(',')});`));
    assert.deepEqual(actualCopy, expectedCopy, 'Every current badge copy pair must match the browser catalog.');
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
      for (const key of instanceBadgeKeys) for (const field of ['description','requirement']) {
        const drift = JSON.parse(fixture.query(`begin;
          update public.badge_definitions set ${field}=${field}||' [synthetic drift]' where badge_key=${q(key)};
          select pg_catalog.row_to_json(checkpoint) from (${fixedSelect}) checkpoint;
          rollback;`).split('\n').at(-1));
        assert.equal(drift.repeatable_reward_catalog_ok, false, `${key}.${field} must fail the catalog digest.`);
        for (const name of REPEATABLE_CHALLENGE_CATALOG_FIELDS.filter(name => !['repeatable_reward_catalog_ok','read_only_pinned_server_ok'].includes(name))) {
          assert.equal(drift[name], true, `${key}.${field} must not weaken ${name}.`);
        }
      }
      const restored = JSON.parse(fixture.query(`begin read only;
        select pg_catalog.row_to_json(checkpoint) from (${fixedSelect}) checkpoint;commit;`).split('\n').at(-1));
      assert.deepEqual(parseRepeatableChallengeCatalogResult([restored]), verified, 'Synthetic copy drift must roll back.');
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
