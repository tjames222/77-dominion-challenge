-- Source-fixed exact73 preflight; no data-row reads, ANALYZE, locks or repair.
-- The estimate is not a row-count proof. Physical size is the conservative gate.
-- This observation races later writes; it is NOT a lock guarantee. Repeat just
-- before backup/final-history/apply. The migration still enforces lock/statement
-- deadlines and performs all three ordinary builds in one rollbackable transaction.
WITH canonical_deparse_context AS MATERIALIZED (
  SELECT pg_catalog.set_config('search_path','pg_catalog',true) AS pinned_search_path,
    pg_catalog.set_config('TimeZone','UTC',true) AS pinned_timezone,
    pg_catalog.set_config('DateStyle','ISO, YMD',true) AS pinned_datestyle,
    pg_catalog.set_config('statement_timeout','15000',true) AS pinned_timeout,
    pg_catalog.set_config('lock_timeout','5000',true) AS pinned_lock_timeout
), registry AS (
  SELECT * FROM pg_catalog.pg_class WHERE oid=pg_catalog.to_regclass('private.profile_photo_objects')
)
SELECT
  coalesce((SELECT pg_catalog.count(*)=73 AND pg_catalog.count(DISTINCT version)=73
    AND pg_catalog.max(version::text)='20261007060519'
    AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.string_agg(version::text,',' ORDER BY version::text COLLATE "C"),'UTF8')),'hex')='d9e099e1d3c7646aab3c72d0b0263030343557c4280923048e268f0c95bb963b'
    AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.string_agg(version::text||'_'||name::text,',' ORDER BY version::text COLLATE "C"),'UTF8')),'hex')='47d4ffe88918a58cd63fca6b7a3175dd3acaf66feb70ca00cb95deea8f346985'
    FROM supabase_migrations.schema_migrations),false) AS exact_pre_migration_history_ok,
  CASE WHEN canonical_deparse_context.pinned_search_path='pg_catalog' AND canonical_deparse_context.pinned_timezone='UTC' AND canonical_deparse_context.pinned_datestyle='ISO, YMD'
    AND canonical_deparse_context.pinned_timeout='15s' AND canonical_deparse_context.pinned_lock_timeout='5s'
    THEN pg_catalog.current_setting('transaction_read_only')='on' AND pg_catalog.current_setting('server_version_num')='170006'
    ELSE false END AS read_only_pinned_server_ok,
  coalesce((SELECT relrowsecurity AND NOT relforcerowsecurity AND relkind='r' AND relpersistence='p'
    AND pg_catalog.pg_get_userbyid(relowner)='postgres' FROM registry),false)
    AND (SELECT pg_catalog.count(*)=24 FROM pg_catalog.pg_attribute WHERE attrelid=pg_catalog.to_regclass('private.profile_photo_objects') AND attnum>0 AND NOT attisdropped)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=pg_catalog.to_regclass('private.profile_photo_objects')) AS registry_shape_ok,
  coalesce((SELECT pg_catalog.pg_relation_size(oid)<=33554432 AND pg_catalog.pg_total_relation_size(oid)<=134217728 FROM registry),false) AS registry_size_within_bound_ok,
  coalesce((SELECT (reltuples>=0 AND reltuples<=100000) OR (reltuples=-1 AND pg_catalog.pg_relation_size(oid)=0) FROM registry),false) AS registry_estimate_within_bound_ok,
  coalesce((SELECT pg_catalog.count(*)=9 AND pg_catalog.bool_and(indisvalid AND indisready AND indislive)
    FROM pg_catalog.pg_index WHERE indrelid=pg_catalog.to_regclass('private.profile_photo_objects')),false) AS registry_indexes_valid_ok,
  pg_catalog.to_regprocedure('public.site_admin_get_cleanup_health(uuid)') IS NULL
    AND pg_catalog.to_regclass('private.profile_photo_objects_cleanup_eligible_idx') IS NULL
    AND pg_catalog.to_regclass('private.profile_photo_objects_cleanup_service_lease_idx') IS NULL
    AND pg_catalog.to_regclass('private.profile_photo_objects_cleanup_failure_idx') IS NULL AS new_objects_absent_ok,
  NOT EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE relation=pg_catalog.to_regclass('private.profile_photo_objects')
    AND pid IS DISTINCT FROM pg_catalog.pg_backend_pid() AND mode NOT IN ('AccessShareLock','RowShareLock')) AS no_conflicting_registry_locks_ok
FROM canonical_deparse_context;
