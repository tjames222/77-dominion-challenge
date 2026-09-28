import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { CURRENT_PGNET_TABLES, currentBackupPgNetCaptureSql, currentBackupPgNetLocalReplaySql,
  currentBackupPgNetSequence, currentBackupPgNetLocalSequenceSql, currentBackupPgNetManifest } from './free-backup-current-pgnet.mjs';

const fixture=`77dc-pgnet-backup-${randomUUID()}`, containers=new Map();
const docker=(args,input,encoding='utf8')=>spawnSync('docker',args,{input,encoding,timeout:30000,maxBuffer:8*1024*1024});
function owned(kind) {
  const id=containers.get(kind); assert.match(id||'',/^[a-f0-9]{64}$/);
  const result=docker(['inspect',id,'--format','{{index .Config.Labels "77dc.fixture"}}|{{.Name}}|{{.HostConfig.NetworkMode}}']);
  assert.equal(result.status,0); assert.equal(result.stdout.trim(),`${fixture}|/${fixture}-${kind}|none`); return id;
}
function sql(kind,query,role='backup_restore_admin') {
  const result=docker(['exec','-i',owned(kind),'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h','/restore','-U',role,'-d','postgres'],query);
  assert.equal(result.status,0,'Owned synthetic pg_net SQL failed; private output withheld.'); return result.stdout.trim();
}
// Exactly the production transport: psql -c guarded SQL, binary data on
// stdout for capture / stdin for replay, not a different client COPY API.
function capture(name,role='postgres') {
  return docker(['exec',owned('source'),'psql','-X','-q','-v','ON_ERROR_STOP=1','-h','/restore','-U',role,'-d','postgres',
    '-c','SET SESSION ROLE '+role,'-c',currentBackupPgNetCaptureSql(name)],undefined,null);
}
function replay(name,bytes,{role='backup_restore_admin',prepare}={}) {
  return docker(['exec','-i',owned('restore'),'psql','-X','-q','-v','ON_ERROR_STOP=1','-h','/restore','-U',role,'-d','postgres',
    ...(prepare?['-c',prepare]:[]),'-c',currentBackupPgNetLocalReplaySql(name)],bytes);
}
let inventorySql, originalInventory, archive, captures, originalSequence;
const inventory=kind=>sql(kind,inventorySql);
function clearTarget() { sql('restore',"truncate net._http_response,net.http_request_queue;select setval('net.http_request_queue_id_seq',1,false);"); }
function seedAndCapture() {
  originalInventory=inventory('source');
  originalSequence=currentBackupPgNetSequence(originalInventory.split('\n').map(JSON.parse));
  captures=CURRENT_PGNET_TABLES.map(table=>{const result=capture(table.name);assert.equal(result.status,0,'Read-only pg_net binary capture failed.');return {file:table.file,bytes:result.stdout};});
  assert.equal(inventory('source'),originalInventory);
}
before(async()=>{
  inventorySql=await readFile(new URL('./free-backup-inventory.sql',import.meta.url),'utf8');
  const startup=await readFile(new URL('./free-backup-local-postgres.sh',import.meta.url),'utf8');
  const inspected=docker(['image','inspect','public.ecr.aws/supabase/postgres:17.6.1.141','--format','{{.Id}}']);
  assert.equal(inspected.status,0,'Exact fixture image must already be cached.');const imageId=inspected.stdout.trim();assert.match(imageId,/^sha256:[a-f0-9]{64}$/);
  for(const kind of ['source','restore']){
    const started=docker(['run','--detach','--pull','never','--name',`${fixture}-${kind}`,'--label',`77dc.fixture=${fixture}`,
      '--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--log-driver','none','--user','100:101',
      '--memory','512m','--cpus','1','--tmpfs','/restore:rw,exec,nosuid,nodev,uid=100,gid=101,mode=0700,size=512m',
      '--tmpfs','/tmp:rw,nosuid,nodev,noexec,uid=100,gid=101,mode=0700,size=64m','-e','DOMINION_BACKUP_CURRENT_PG_NET=1',
      '--entrypoint','bash',imageId,'-c',startup]);
    assert.equal(started.status,0,'Owned pg_net fixture creation failed.');const id=started.stdout.trim();assert.match(id,/^[a-f0-9]{64}$/);containers.set(kind,id);
    let ready=false;for(let count=0;count<100;count++){if(docker(['exec',id,'pg_isready','-h','/restore','-U','backup_restore_admin']).status===0){ready=true;break;}await new Promise(resolve=>setTimeout(resolve,100));}
    assert(ready,'Owned pg_net fixture failed to start.');sql(kind,'create role postgres login superuser;');
  }
  sql('source',"create extension pg_net;create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key);insert into supabase_migrations.schema_migrations values('20260913082358');",'postgres');
  // Old responses would be expired if a worker were allowed to run. Include
  // nullable fields, Unicode/newlines, JSON and every possible byte value.
  sql('source',`insert into net._http_response(id,status_code,content_type,headers,content,timed_out,error_msg,created)
    select n,case when n%2=0 then null else 200 end,'application/json',jsonb_build_object('synthetic',E'line\\n雪'),
      E'synthetic\\nresponse é',false,null,'2000-01-01T00:00:00Z'::timestamptz from generate_series(1,72)n;
    insert into net.http_request_queue(id,method,url,headers,body,timeout_milliseconds) values
      (100,'POST','https://fixture.invalid/no-request',jsonb_build_object('synthetic',E'line\\n雪'),decode((select string_agg(lpad(to_hex(n),2,'0'),'') from generate_series(0,255)n),'hex'),1000),
      (101,'GET','https://fixture.invalid/no-request',null,null,1000);
    select setval('net.http_request_queue_id_seq',314159,true);`);
  const dumped=docker(['exec',owned('source'),'pg_dump','--host=/restore','--username=postgres','--dbname=postgres','--format=custom','--compress=0','--lock-wait-timeout=15000','--role=postgres'],undefined,null);
  assert.equal(dumped.status,0,'Synthetic native pg_dump failed.');archive=dumped.stdout;
  const restored=docker(['exec','-i',owned('restore'),'pg_restore','--host=/restore','--username=backup_restore_admin','--dbname=postgres','--single-transaction','--exit-on-error'],archive);
  assert.equal(restored.status,0,'Native pg_net extension restore failed.');seedAndCapture();
});
after(()=>{for(const kind of ['restore','source']){if(!containers.has(kind))continue;assert.equal(docker(['rm','--force',owned(kind)]).status,0,'Owned pg_net fixture cleanup failed.');}});

test('native pg_dump omits non-extconfig pg_net data even with explicit table selection',()=>{
  const listing=docker(['exec','-i',owned('source'),'pg_restore','--list'],archive);assert.equal(listing.status,0);
  assert.equal(listing.stdout.split('\n').filter(line=>/ (TABLE DATA|SEQUENCE SET) net /.test(line)).length,0);
  const explicit=docker(['exec',owned('source'),'pg_dump','-h','/restore','-U','postgres','-d','postgres','--data-only','--format=custom','--strict-names',
    '--table=net._http_response','--table=net.http_request_queue','--table=net.http_request_queue_id_seq'],undefined,null);assert.equal(explicit.status,0);
  const selected=docker(['exec','-i',owned('source'),'pg_restore','--list'],explicit.stdout);assert.equal(selected.status,0);
  assert.equal(selected.stdout.split('\n').filter(line=>/ (TABLE DATA|SEQUENCE SET) net /.test(line)).length,0);
  assert.equal(sql('restore','select count(*) from net._http_response'),'0');assert.equal(sql('restore','select last_value,is_called from net.http_request_queue_id_seq'),'1|f');
  assert.notEqual(inventory('restore'),originalInventory);
});
test('exact psql binary streams and bound sequence replay restore unchanged full inventory with no active workers',async()=>{
  const manifest=currentBackupPgNetManifest(captures,originalSequence);assert.equal(manifest.files.length,2);
  for(let index=0;index<CURRENT_PGNET_TABLES.length;index++)assert.equal(replay(CURRENT_PGNET_TABLES[index].name,captures[index].bytes).status,0,'Guarded native COPY failed.');
  sql('restore',currentBackupPgNetLocalSequenceSql(originalSequence));assert.equal(inventory('restore'),originalInventory);
  for(const kind of ['source','restore'])assert.equal(sql(kind,"select current_setting('max_worker_processes'),current_setting('cron.launch_active_jobs'),current_setting('pg_net.batch_size'),(select extversion from pg_extension where extname='pg_net'),(select count(*) from pg_stat_activity where backend_type ilike '%pg_net%' or backend_type ilike '%cron%')"),'0|off|0|0.20.3|0');
  await new Promise(resolve=>setTimeout(resolve,1200));assert.equal(inventory('restore'),originalInventory);assert.equal(inventory('source'),originalInventory);
});
test('nonempty target refuses duplicate replay before any insert',()=>{
  assert.notEqual(replay('_http_response',captures[0].bytes).status,0);assert.equal(inventory('restore'),originalInventory);
});
test('source role mismatch fails read-only capture without changing any table or sequence',()=>{
  assert.notEqual(capture('_http_response','backup_restore_admin').status,0);assert.equal(inventory('source'),originalInventory);
});
test('wrong local role or existing reserved worker database fails before binary replay',()=>{
  clearTarget();const before=inventory('restore');
  assert.notEqual(replay('_http_response',captures[0].bytes,{role:'postgres'}).status,0);assert.equal(inventory('restore'),before);
  sql('restore','create database dominion_backup_disabled;');
  try{assert.notEqual(replay('_http_response',captures[0].bytes).status,0);assert.equal(inventory('restore'),before);}
  finally{sql('restore','drop database dominion_backup_disabled;');}
});
test('version, column, trigger and unexpected extension-member drift fail closed and roll back their fixture transaction',()=>{
  const before=inventory('restore');
  for(const change of ["update pg_extension set extversion='0.0.invalid' where extname='pg_net'",
    "update pg_extension set extconfig=array['net._http_response'::regclass::oid],extcondition=array[''] where extname='pg_net'",
    'alter table net._http_response alter column content type varchar',
    "create function public.fixture_pgnet_trigger() returns trigger language plpgsql as $$begin return new;end$$; create trigger fixture_pgnet_trigger before insert on net._http_response for each row execute function public.fixture_pgnet_trigger()",
    'create table public.fixture_extension_data(value text);alter extension pg_net add table public.fixture_extension_data']){
    assert.notEqual(replay('_http_response',captures[0].bytes,{prepare:'BEGIN;'+change+';'}).status,0);assert.equal(inventory('restore'),before);
  }
});
test('truncated or corrupted COPY cannot commit even partial rows',()=>{
  const before=inventory('restore'),truncated=captures[0].bytes.subarray(0,-20),corrupted=Buffer.from(captures[0].bytes);corrupted[0]=0;
  for(const bytes of [truncated,corrupted]){assert.notEqual(replay('_http_response',bytes).status,0);assert.equal(inventory('restore'),before);}
});
test('uncalled sequence state is preserved exactly without advancing it during capture',()=>{
  sql('source',"select setval('net.http_request_queue_id_seq',777,false);");seedAndCapture();
  for(let index=0;index<CURRENT_PGNET_TABLES.length;index++)assert.equal(replay(CURRENT_PGNET_TABLES[index].name,captures[index].bytes).status,0);
  sql('restore',currentBackupPgNetLocalSequenceSql(originalSequence));assert.equal(sql('restore','select last_value,is_called from net.http_request_queue_id_seq'),'777|f');
  assert.equal(inventory('restore'),originalInventory);assert.equal(inventory('source'),originalInventory);
});
