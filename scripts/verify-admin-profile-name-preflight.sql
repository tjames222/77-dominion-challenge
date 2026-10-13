-- Source-fixed exact74 preflight. Catalog metadata only: no account, profile,
-- audit or request rows, ANALYZE, application RPC, lock acquisition or repair.
-- Physical size is the primary bound. Statistics can be unknown or stale.
-- This observation is NOT a lock guarantee: repeat immediately before apply.
-- The migration separately takes bounded locks and checks capped exact row
-- counts under those locks before backfill and audit-constraint validation.
-- Retained erasure tables are only size-observed at release time. The existing
-- eligibility predicate can scan them; this is not a permanent runtime bound.
WITH canonical_deparse_context AS MATERIALIZED (
  SELECT pg_catalog.set_config('search_path','pg_catalog',true) AS pinned_search_path,
    pg_catalog.set_config('TimeZone','UTC',true) AS pinned_timezone,
    pg_catalog.set_config('DateStyle','ISO, YMD',true) AS pinned_datestyle,
    pg_catalog.set_config('statement_timeout','15000',true) AS pinned_timeout,
    pg_catalog.set_config('lock_timeout','5000',true) AS pinned_lock_timeout
), expected_tables(schema_name,table_name,column_count,index_count) AS (VALUES
  ('public','profiles',21,3), ('private','site_admin_audit',17,5)
), existing_tables AS (
  SELECT e.*,c.oid,c.relkind,c.relpersistence,c.relowner,c.relrowsecurity,
    c.relforcerowsecurity,c.reltuples
  FROM expected_tables e LEFT JOIN pg_catalog.pg_class c
    ON c.oid=pg_catalog.to_regclass(e.schema_name||'.'||e.table_name)
), retained_erasure_tables AS (
  SELECT c.oid,c.relkind,c.relpersistence
  FROM (VALUES ('private.retired_community_deletion_batches'),
    ('private.retired_community_deletion_ledger')) e(relation_name)
  LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass(e.relation_name)
)
SELECT
  coalesce((SELECT pg_catalog.count(*)=74 AND pg_catalog.count(DISTINCT version)=74
    AND pg_catalog.max(version::text)='20261013055744'
    AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.string_agg(version::text,',' ORDER BY version::text COLLATE "C"),'UTF8')),'hex')='cb786c2a891bfbfd739aef4a6a2fa1c01bafad29fc8f2739e2f41342fc7de765'
    AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.string_agg(version::text||'_'||name::text,',' ORDER BY version::text COLLATE "C"),'UTF8')),'hex')='1db17cdef50ab485d4fc7352e6ebd239fa14a55956d556b4c9e19d323b7c1d7c'
    FROM supabase_migrations.schema_migrations),false) AS exact_pre_migration_history_ok,
  CASE WHEN canonical_deparse_context.pinned_search_path='pg_catalog' AND canonical_deparse_context.pinned_timezone='UTC' AND canonical_deparse_context.pinned_datestyle='ISO, YMD'
    AND canonical_deparse_context.pinned_timeout='15s' AND canonical_deparse_context.pinned_lock_timeout='5s'
    THEN pg_catalog.current_setting('transaction_read_only')='on' AND pg_catalog.current_setting('server_version_num')='170006'
    ELSE false END AS read_only_pinned_server_ok,
  (SELECT pg_catalog.count(*)=2 AND pg_catalog.bool_and(coalesce(
    oid IS NOT NULL AND relrowsecurity AND NOT relforcerowsecurity AND relkind='r' AND relpersistence='p'
    AND pg_catalog.pg_get_userbyid(relowner)='postgres'
    AND (SELECT pg_catalog.count(*)=t.column_count FROM pg_catalog.pg_attribute a WHERE a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped)
    AND (t.schema_name<>'private' OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=t.oid)),false))
    FROM existing_tables t) AS existing_tables_shape_ok,
  (SELECT pg_catalog.count(*)=2 AND pg_catalog.bool_and(coalesce(
    pg_catalog.pg_relation_size(oid)<=33554432 AND pg_catalog.pg_total_relation_size(oid)<=134217728,false))
    FROM existing_tables) AS existing_tables_size_within_bound_ok,
  (SELECT pg_catalog.count(*)=2 AND pg_catalog.bool_and(coalesce(
    reltuples=-1 OR (reltuples>=0 AND reltuples<=100000),false))
    FROM existing_tables) AS existing_tables_estimate_within_bound_ok,
  (SELECT pg_catalog.count(*)=2 AND pg_catalog.bool_and(coalesce(
    (SELECT pg_catalog.count(*)=t.index_count AND pg_catalog.bool_and(i.indisvalid AND i.indisready AND i.indislive)
      FROM pg_catalog.pg_index i WHERE i.indrelid=t.oid),false))
    FROM existing_tables t) AS existing_indexes_valid_ok,
  pg_catalog.to_regclass('private.site_admin_profile_name_versions') IS NULL
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname IN ('private','public') AND p.proname LIKE '%profile_name%')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid=pg_catalog.to_regclass('public.profiles')
      AND NOT t.tgisinternal AND t.tgname LIKE '%profile_name%')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=pg_catalog.to_regclass('private.site_admin_audit')
      AND NOT a.attisdropped AND a.attname IN ('before_profile_name_version','after_profile_name_version','profile_name_changed')) AS new_objects_absent_ok,
  NOT EXISTS(SELECT 1 FROM pg_catalog.pg_locks l JOIN existing_tables t ON t.oid=l.relation
    WHERE l.pid IS DISTINCT FROM pg_catalog.pg_backend_pid()
      AND (t.table_name='site_admin_audit' OR l.mode<>'AccessShareLock')) AS no_conflicting_table_locks_ok,
  (SELECT pg_catalog.count(*)=2 AND pg_catalog.bool_and(coalesce(
    oid IS NOT NULL AND relkind='r' AND relpersistence='p'
    AND pg_catalog.pg_relation_size(oid)<=33554432
    AND pg_catalog.pg_total_relation_size(oid)<=134217728,false))
    FROM retained_erasure_tables) AS retained_erasure_size_within_bound_ok
FROM canonical_deparse_context;
