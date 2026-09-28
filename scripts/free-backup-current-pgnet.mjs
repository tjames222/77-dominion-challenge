import { createHash } from 'node:crypto';

// Only these pg_net 0.20.3 extension members are omitted by ordinary pg_dump.
// Neither extension membership nor the unchanged all-table inventory is edited.
export const CURRENT_PGNET_TABLES = Object.freeze([
  Object.freeze({ name: '_http_response', file: 'pg-net-http-response.copy',
    columns: 'id,status_code,content_type,headers,content,timed_out,error_msg,created' }),
  Object.freeze({ name: 'http_request_queue', file: 'pg-net-http-request-queue.copy',
    columns: 'id,method,url,headers,body,timeout_milliseconds' }),
]);
export const CURRENT_PGNET_WORKER_DATABASE = 'dominion_backup_disabled';
const fail = () => { throw Object.assign(new Error('Current backup pg_net contract failed.'), { diagnosticCode: 'current-pgnet-contract' }); };
const sequenceName = 'http_request_queue_id_seq';
const expectedColumns = [
  ['_http_response', 1, 'id', 'bigint', false], ['_http_response', 2, 'status_code', 'integer', false],
  ['_http_response', 3, 'content_type', 'text', false], ['_http_response', 4, 'headers', 'jsonb', false],
  ['_http_response', 5, 'content', 'text', false], ['_http_response', 6, 'timed_out', 'boolean', false],
  ['_http_response', 7, 'error_msg', 'text', false], ['_http_response', 8, 'created', 'timestamp with time zone', true],
  ['http_request_queue', 1, 'id', 'bigint', true], ['http_request_queue', 2, 'method', 'net.http_method', true],
  ['http_request_queue', 3, 'url', 'text', true], ['http_request_queue', 4, 'headers', 'jsonb', false],
  ['http_request_queue', 5, 'body', 'bytea', false], ['http_request_queue', 6, 'timeout_milliseconds', 'integer', true],
];
const relationContract = `(select count(*)=1 and bool_and(extversion='0.20.3') from pg_extension where extname='pg_net')
  and (select jsonb_agg(n.nspname||'.'||c.relname order by n.nspname collate "C",c.relname collate "C")
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    join pg_depend d on d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e' and d.refclassid='pg_extension'::regclass
    join pg_extension e on e.oid=d.refobjid
    where c.relkind in ('r','p','m','S') and n.nspname !~ '^pg_' and n.nspname<>'information_schema'
      and not c.oid=any(coalesce(e.extconfig,array[]::oid[])))
    ='["net._http_response","net.http_request_queue","net.http_request_queue_id_seq"]'::jsonb
  and (select count(*)=2 and bool_and(c.relkind='r' and c.relpersistence='u' and not c.relrowsecurity and not c.relforcerowsecurity and e.extname='pg_net')
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    join pg_depend d on d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e' and d.refclassid='pg_extension'::regclass
    join pg_extension e on e.oid=d.refobjid where n.nspname='net' and c.relname in ('_http_response','http_request_queue'))
  and (select jsonb_agg(jsonb_build_array(c.relname,a.attnum,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull)
    order by c.relname collate "C",a.attnum) from pg_attribute a join pg_class c on c.oid=a.attrelid
    join pg_namespace n on n.oid=c.relnamespace where n.nspname='net' and c.relname in ('_http_response','http_request_queue') and a.attnum>0)
    ='${JSON.stringify(expectedColumns)}'::jsonb
  and not exists(select 1 from pg_attribute a where a.attrelid in ('net._http_response'::regclass,'net.http_request_queue'::regclass)
    and a.attnum>0 and (a.attisdropped or a.attgenerated<>'' or a.attidentity<>''))
  and not exists(select 1 from pg_trigger where tgrelid in ('net._http_response'::regclass,'net.http_request_queue'::regclass) and not tgisinternal)
  and (select count(*)=1 and bool_and(e.extname='pg_net' and c.relpersistence='u' and s.seqtypid='bigint'::regtype and s.seqstart=1 and s.seqincrement=1
    and s.seqmin=1 and s.seqmax=9223372036854775807 and s.seqcache=1 and not s.seqcycle)
    from pg_sequence s join pg_class c on c.oid=s.seqrelid join pg_namespace n on n.oid=c.relnamespace
    join pg_depend d on d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e' and d.refclassid='pg_extension'::regclass
    join pg_extension e on e.oid=d.refobjid where n.nspname='net' and c.relname='${sequenceName}')`;
const localFence = `current_user='backup_restore_admin' and current_database()='postgres'
  and inet_server_addr() is null and current_setting('unix_socket_directories')='/restore'
  and current_setting('listen_addresses')='' and current_setting('cron.launch_active_jobs')='off'
  and current_setting('max_worker_processes')='0' and current_setting('pg_net.batch_size')='0'
  and current_setting('pg_net.database_name')='${CURRENT_PGNET_WORKER_DATABASE}'
  and not exists(select 1 from pg_database where datname='${CURRENT_PGNET_WORKER_DATABASE}')
  and not exists(select 1 from pg_stat_activity where backend_type ilike '%pg_net%' or backend_type ilike '%cron%')`;
const guard = condition => `DO $pgnet_guard$ BEGIN IF NOT coalesce((${condition}),false) THEN
  RAISE EXCEPTION 'Current backup pg_net boundary refused'; END IF; END $pgnet_guard$;`;
function table(name) { const result = CURRENT_PGNET_TABLES.find(value => value.name === name); if (!result) fail(); return result; }

export function currentBackupPgNetCaptureSql(name) {
  const selected = table(name);
  // Quiet psql sends only the binary COPY stream; DO/BEGIN/ROLLBACK have no
  // row results and no command tags in that mode. No hosted DML or setval.
  return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL search_path=pg_catalog; SET LOCAL statement_timeout='120s';
${guard(`current_user='postgres' and current_setting('transaction_read_only')='on' and ${relationContract}`)}
COPY net.${selected.name}(${selected.columns}) TO STDOUT (FORMAT binary); ROLLBACK;`;
}
export function currentBackupPgNetLocalReplaySql(name) {
  const selected = table(name);
  return `BEGIN; SET LOCAL search_path=pg_catalog; SET LOCAL statement_timeout='120s';
${guard(`${localFence} and ${relationContract} and not exists(select 1 from net.${selected.name})`)}
COPY net.${selected.name}(${selected.columns}) FROM STDIN (FORMAT binary); COMMIT;`;
}
export function currentBackupPgNetSequence(inventory) {
  if (!Array.isArray(inventory)) fail();
  const found = inventory.filter(value => value?.kind === 'sequence' && value.schema === 'net' && value.name === sequenceName);
  if (found.length !== 1) fail();
  const { lastValue, isCalled } = found[0];
  if (typeof lastValue !== 'string' || !/^[1-9][0-9]{0,18}$/.test(lastValue)
    || BigInt(lastValue) > 9223372036854775807n || typeof isCalled !== 'boolean') fail();
  return Object.freeze({ lastValue, isCalled });
}
export function currentBackupPgNetLocalSequenceSql(sequence) {
  const valid = currentBackupPgNetSequence([{ kind: 'sequence', schema: 'net', name: sequenceName, ...sequence }]);
  // psql17 extended-protocol binding: only validated digits/booleans enter the
  // meta-command. Identifiers and setval target are fixed, never caller SQL.
  return `\\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path=pg_catalog;
SET LOCAL statement_timeout='30s';
${guard(`${localFence} and ${relationContract}`)}
SELECT setval('net.${sequenceName}'::regclass,$1::bigint,$2::boolean)
\\bind '${valid.lastValue}' '${valid.isCalled}'
\\g
COMMIT;
`;
}
export function currentBackupPgNetManifest(files, sequence) {
  const valid = currentBackupPgNetSequence([{ kind: 'sequence', schema: 'net', name: sequenceName, ...sequence }]);
  if (!Array.isArray(files) || files.length !== CURRENT_PGNET_TABLES.length) fail();
  const entries = files.map(({ file, bytes }, index) => {
    if (file !== CURRENT_PGNET_TABLES[index].file || !Buffer.isBuffer(bytes) || bytes.length < 21 || bytes.length > 49 * 1024 * 1024
      || !bytes.subarray(0, 11).equals(Buffer.from('PGCOPY\n\xff\r\n\0', 'binary')) || bytes.readInt16BE(bytes.length - 2) !== -1) fail();
    return { file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  return { contract: 'dominion-pg-net-binary-supplement/v1', extensionVersion: '0.20.3', format: 'postgresql-binary-copy',
    files: entries, sequence: { schema: 'net', name: sequenceName, ...valid },
    replayRequiresIsolatedWorkerDisabledRuntime: true };
}
