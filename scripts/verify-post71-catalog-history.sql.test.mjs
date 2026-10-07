import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createOriginal77FullchainFixture } from './fixtures/original77-fullchain-fixture.mjs';
import { POST71_REVIEWED_MIGRATIONS } from './verify-post71-release-plan.mjs';
import { ORIGINAL77_CATALOG_QUERY, ORIGINAL77_CATALOG_FIELDS } from './verify-production-original77.mjs';
import { REPEATABLE_CHALLENGE_CATALOG_QUERY, REPEATABLE_CHALLENGE_CATALOG_FIELDS } from './verify-production-repeatable-challenge.mjs';
import { REPEATABLE_CHALLENGE_MIGRATION_FILENAME, REPEATABLE_CHALLENGE_MIGRATION_SHA256 } from './verify-repeatable-challenge-cutover-plan.mjs';
const q = value => `'${value.replaceAll("'", "''")}'`;
const hash = value => createHash('sha256').update(value).digest('hex');
const contracts = [[ORIGINAL77_CATALOG_QUERY,ORIGINAL77_CATALOG_FIELDS],[REPEATABLE_CHALLENGE_CATALOG_QUERY,REPEATABLE_CHALLENGE_CATALOG_FIELDS]];
function check(fixture, expectedHistory, mutation='') {
  for (const [sql,fields] of contracts) {
    const row = JSON.parse(fixture.query(`begin${mutation?'':' read only'};${mutation}
      select row_to_json(c) from (${sql.trim().replace(/;$/u,'')}) c;rollback;`).split('\n').at(-1));
    assert.deepEqual(row,Object.fromEntries(fields.map(name=>[name,name==='exact_migration_history_ok'?expectedHistory:
      name==='read_only_pinned_server_ok'?!mutation:true])));
  }
}

test('exact71 and source-pinned73 preserve every existing catalog Boolean; partial72/74/name drift fail history only', async () => {
  const fixture=await createOriginal77FullchainFixture({through:70});
  try {
    const migrations=[{filename:REPEATABLE_CHALLENGE_MIGRATION_FILENAME,sha256:REPEATABLE_CHALLENGE_MIGRATION_SHA256},...POST71_REVIEWED_MIGRATIONS];
    for (const [index,row] of migrations.entries()) {
      const body=await readFile(new URL(`../supabase/migrations/${row.filename}`,import.meta.url),'utf8');
      assert.equal(hash(body),row.sha256);
      fixture.query(`begin;set local check_function_bodies=on;set local search_path=public,extensions;${body}
        insert into supabase_migrations.schema_migrations(version,name,statements) values(
        ${q(row.filename.slice(0,14))},${q(row.filename.slice(15,-4))},array[${q(body)}]::text[]);commit;`);
      check(fixture,index!==1);
    }
    check(fixture,false,"insert into supabase_migrations.schema_migrations(version,name,statements) values('20261008000000','unreviewed',array[]::text[]);");
    check(fixture,false,"update supabase_migrations.schema_migrations set name='unreviewed' where version='20261007060519';");
    check(fixture,true);
  } finally {fixture.close();}
});
