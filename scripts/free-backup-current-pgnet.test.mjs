import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { CURRENT_PGNET_TABLES, currentBackupPgNetCaptureSql, currentBackupPgNetLocalReplaySql,
  currentBackupPgNetSequence, currentBackupPgNetLocalSequenceSql, currentBackupPgNetManifest } from './free-backup-current-pgnet.mjs';
const sequence = { kind: 'sequence', schema: 'net', name: 'http_request_queue_id_seq', lastValue: '314159', isCalled: true };
const emptyCopy = Buffer.from('5047434f50590aff0d0a000000000000000000ffff','hex');
const files = () => CURRENT_PGNET_TABLES.map(({ file }) => ({ file, bytes: emptyCopy }));

test('current pg_net policy has exactly two immutable fixed binary members', () => {
  assert(Object.isFrozen(CURRENT_PGNET_TABLES)); assert(CURRENT_PGNET_TABLES.every(Object.isFrozen));
  assert.deepEqual(CURRENT_PGNET_TABLES.map(v=>v.file), ['pg-net-http-response.copy','pg-net-http-request-queue.copy']);
  for (const name of ['', 'public.users', '_http_response; delete from public.users', null]) {
    assert.throws(()=>currentBackupPgNetCaptureSql(name)); assert.throws(()=>currentBackupPgNetLocalReplaySql(name));
  }
});
test('hosted capture is read-only and exact-version/catalog constrained with no DML or setval', () => {
  for (const { name, columns } of CURRENT_PGNET_TABLES) {
    const sql = currentBackupPgNetCaptureSql(name);
    assert.match(sql, /BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/);
    assert.match(sql, /current_user='postgres'/); assert.match(sql, /extversion='0.20.3'/);
    assert.match(sql, /not c.oid=any\(coalesce\(e.extconfig/);
    assert(sql.includes(`COPY net.${name}(${columns}) TO STDOUT (FORMAT binary)`));
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|setval|ALTER|FROM STDIN)\b/i);
    assert.match(sql, /ROLLBACK;$/);
  }
});
test('local replay requires all runtime fences, pinned metadata and empty destination before COPY', () => {
  for (const { name } of CURRENT_PGNET_TABLES) {
    const sql = currentBackupPgNetLocalReplaySql(name);
    for (const required of ["current_user='backup_restore_admin'", "current_database()='postgres'", 'inet_server_addr() is null',
      "current_setting('unix_socket_directories')='/restore'", "current_setting('listen_addresses')=''",
      "current_setting('cron.launch_active_jobs')='off'", "current_setting('max_worker_processes')='0'",
      "current_setting('pg_net.batch_size')='0'", "current_setting('pg_net.database_name')='dominion_backup_disabled'",
      "not exists(select 1 from pg_database where datname='dominion_backup_disabled')", `not exists(select 1 from net.${name})`]) assert(sql.includes(required));
    assert(sql.indexOf('pgnet_guard') < sql.indexOf('COPY net.')); assert.match(sql, /FROM STDIN \(FORMAT binary\); COMMIT;$/);
  }
});
test('sequence state uses a lossless bounded decimal string and exact boolean', () => {
  assert.deepEqual(currentBackupPgNetSequence([sequence]), {lastValue:'314159',isCalled:true});
  for (const lastValue of ['0','-1','01','1.0','1;SELECT 1','9223372036854775808',1,null]) assert.throws(()=>currentBackupPgNetSequence([{...sequence,lastValue}]));
  for (const isCalled of ['false',0,null]) assert.throws(()=>currentBackupPgNetSequence([{...sequence,isCalled}]));
  for (const data of [[],[sequence,sequence],null,[{...sequence,name:'other'}]]) assert.throws(()=>currentBackupPgNetSequence(data));
  const sql=currentBackupPgNetLocalSequenceSql({lastValue:'9223372036854775807',isCalled:false});
  assert.match(sql,/setval\('net.http_request_queue_id_seq'::regclass,\$1::bigint,\$2::boolean\)/);
  assert.match(sql,/\\bind '9223372036854775807' 'false'/); assert.match(sql,/max_worker_processes/);
});
test('manifest binds both binary files with lengths and SHA256 plus exact sequence, never payload bytes', () => {
  const manifest=currentBackupPgNetManifest(files(),{lastValue:'1',isCalled:false});
  assert.equal(manifest.contract,'dominion-pg-net-binary-supplement/v1'); assert.equal(manifest.extensionVersion,'0.20.3');
  assert.equal(manifest.replayRequiresIsolatedWorkerDisabledRuntime,true);
  for(const file of manifest.files){assert.equal(file.bytes,21);assert.match(file.sha256,/^[a-f0-9]{64}$/);}
  assert(!JSON.stringify(manifest).includes('PGCOPY'));
  for(const changed of [[],files().reverse(),[{...files()[0],file:'../escape'},files()[1]],
    [{...files()[0],bytes:Buffer.from('malformed')},files()[1]],
    [{...files()[0],bytes:Buffer.concat([emptyCopy.subarray(0,-2),Buffer.from([0,0])])},files()[1]]]) assert.throws(()=>currentBackupPgNetManifest(changed,{lastValue:'1',isCalled:false}));
});
test('integration preserves all inventory equality, current-only startup/replay and encrypted archive membership', async () => {
  const source=await readFile(new URL('./free-production-backup.mjs',import.meta.url),'utf8');
  const capture=source.slice(source.indexOf("stage('current-pgnet-capture')"),source.indexOf("stage('inventory-after')"));
  assert.match(capture,/await remote\(/); assert.match(capture,/currentBackupPgNetCaptureSql/); assert.match(capture,/currentBackupPgNetManifest/);
  const replay=source.slice(source.indexOf("stage('local-pgnet-replay')"),source.indexOf("stage('content-verify')"));
  assert.match(replay,/assert.deepEqual\(currentBackupPgNetManifest/); assert.match(replay,/await local\(/); assert.doesNotMatch(replay,/remote\(/);
  assert.match(source,/assert.equal\(await readFile\(after, 'utf8'\), beforeText/);
  assert.match(source,/assert.equal\(comparableInventory\(restoredText\), comparableInventory\(beforeText\)/);
  assert.match(source,/backupMode === CURRENT_BACKUP_MODE \? \['-e', 'DOMINION_BACKUP_CURRENT_PG_NET=1'\] : \[\]/);
  assert.match(source,/backupMode === CURRENT_BACKUP_MODE \? CURRENT_PGNET_TABLES.map\(table => table.file\) : \[\]/);
  assert(source.indexOf("stage('content-verify')") < source.indexOf("stage('encryption')"));
  const startup=await readFile(new URL('./free-backup-local-postgres.sh',import.meta.url),'utf8');
  assert.match(startup,/backup_postgres_options=\(-c shared_preload_libraries=pgsodium,pg_cron,supabase_vault\)/);
  assert.match(startup,/case "\$\{DOMINION_BACKUP_CURRENT_PG_NET:-\}" in/); assert.match(startup,/\*\) exit 1/);
  assert.match(startup,/max_worker_processes=0/); assert.match(startup,/pg_net.batch_size=0/);
});
