\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on
\pset pager off
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path = pg_catalog;
SET LOCAL statement_timeout = '120s';
SET LOCAL timezone = 'UTC';
SET LOCAL datestyle = 'ISO, YMD';
SELECT json_build_object('kind','boundary','serverVersion',current_setting('server_version_num'),
  'encoding',getdatabaseencoding(),
  'bootstrapRole',(SELECT rolname FROM pg_roles WHERE oid=10),
  'foreignTables',(SELECT count(*) FROM pg_foreign_table),
  'reservedRoleExists',EXISTS(SELECT 1 FROM pg_roles WHERE rolname='backup_restore_admin'))::text;
SELECT format(
  'SELECT json_build_object(''kind'',''table'',''schema'',%L,''name'',%L,''count'',count(*),''sha256'',encode(sha256(convert_to(coalesce(string_agg(encode(sha256(convert_to(to_jsonb(t)::text,''UTF8'')),''hex''),'''' ORDER BY to_jsonb(t)::text COLLATE "C"),''''),''UTF8'')),''hex''))::text FROM %I.%I t;',
  n.nspname, c.relname, n.nspname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE c.relkind IN ('r','p','m') AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C"
\gexec
SELECT format(
  'SELECT json_build_object(''kind'',''sequence'',''schema'',%L,''name'',%L,''lastValue'',last_value::text,''isCalled'',is_called)::text FROM %I.%I;',
  n.nspname, c.relname, n.nspname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE c.relkind='S' AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C"
\gexec
SELECT json_build_object('kind','history','versions',json_agg(version ORDER BY version))::text
FROM supabase_migrations.schema_migrations;
SELECT json_build_object('kind','largeObjects','count',count(*),
  'sha256',encode(sha256(convert_to(coalesce(string_agg(oid::text || ':' || encode(sha256(lo_get(oid)),'hex'),',' ORDER BY oid),''),'UTF8')),'hex'))::text
FROM pg_largeobject_metadata;
COMMIT;
