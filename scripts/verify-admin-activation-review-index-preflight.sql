-- Source-fixed exact75 preflight; catalog metadata only, no application rows,
-- RPC execution, ANALYZE, lock acquisition, repair or credential reads.
-- Size/statistics/lock observations race later writes and are NOT a guarantee.
-- Repeat immediately before apply; the migration retains its bounded locks.
WITH canonical_deparse_context AS MATERIALIZED (
  SELECT pg_catalog.set_config('search_path','pg_catalog',true) AS pinned_search_path,
    pg_catalog.set_config('TimeZone','UTC',true) AS pinned_timezone,
    pg_catalog.set_config('DateStyle','ISO, YMD',true) AS pinned_datestyle,
    pg_catalog.set_config('statement_timeout','15000',true) AS pinned_timeout,
    pg_catalog.set_config('lock_timeout','5000',true) AS pinned_lock_timeout
), registry AS (
  SELECT * FROM pg_catalog.pg_class WHERE oid=pg_catalog.to_regclass('private.challenge_activation_migration_reviews')
), expected_acl AS (
  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(role_name,'postgres',privilege,false)
    ORDER BY role_name COLLATE "C",privilege COLLATE "C") AS acl
  FROM (SELECT 'postgres' AS role_name,pg_catalog.unnest(ARRAY['DELETE','INSERT','MAINTAIN','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE']) AS privilege
    UNION ALL SELECT 'service_role',pg_catalog.unnest(ARRAY['SELECT','UPDATE'])) grants
), registry_checks AS (
  SELECT coalesce(CASE WHEN d.pinned_search_path='pg_catalog' AND d.pinned_timezone='UTC' AND d.pinned_datestyle='ISO, YMD' THEN
    r.relkind='r' AND r.relpersistence='p' AND r.relrowsecurity AND NOT r.relforcerowsecurity
    AND pg_catalog.pg_get_userbyid(r.relowner)='postgres'
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=r.oid OR inhparent=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=r.oid AND attnum>0 AND attisdropped)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid=r.oid AND NOT tgisinternal)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=r.oid)
    AND (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(a.attnum,a.attname,
      pg_catalog.format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_catalog.pg_get_expr(v.adbin,v.adrelid),a.attidentity,a.attgenerated) ORDER BY a.attnum)
      FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef v ON v.adrelid=a.attrelid AND v.adnum=a.attnum
      WHERE a.attrelid=r.oid AND a.attnum>0 AND NOT a.attisdropped)
      ='[[1,"user_id","uuid",true,null,"",""],[2,"reasons","text[]",true,null,"",""],[3,"evidence","jsonb",true,null,"",""],[4,"created_at","timestamp with time zone",true,"statement_timestamp()","",""],[5,"resolved_at","timestamp with time zone",false,null,"",""],[6,"resolved_by","uuid",false,null,"",""],[7,"resolution_note","text",false,null,"",""]]'::jsonb
    ELSE false END,false) AS shape_ok,
    coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
      CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END,pg_catalog.pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable)
      ORDER BY (CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END) COLLATE "C",
        pg_catalog.pg_get_userbyid(a.grantor) COLLATE "C",a.privilege_type COLLATE "C",a.is_grantable)
      FROM pg_catalog.aclexplode(coalesce(r.relacl,pg_catalog.acldefault('r',r.relowner))) a)=(SELECT acl FROM expected_acl)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=r.oid AND a.attnum>0 AND a.attacl IS NOT NULL AND pg_catalog.cardinality(a.attacl)>0)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.unnest(ARRAY['anon','authenticated']) role_name
      WHERE pg_catalog.has_table_privilege(role_name,r.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
        OR pg_catalog.has_any_column_privilege(role_name,r.oid,'SELECT,INSERT,UPDATE,REFERENCES'))
    AND pg_catalog.has_table_privilege('service_role',r.oid,'SELECT')
    AND pg_catalog.has_table_privilege('service_role',r.oid,'UPDATE')
    AND NOT pg_catalog.has_table_privilege('service_role',r.oid,'INSERT,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
    AND NOT pg_catalog.has_any_column_privilege('service_role',r.oid,'INSERT,REFERENCES'),false) AS privileges_ok
  FROM registry r CROSS JOIN canonical_deparse_context d
), expected_constraints(name,kind,definition_hash) AS (VALUES
  ('challenge_activation_migration_reviews_check','c','7bfa7114088fd49147bca8b31788da74e0d616b38dba758b7e24829d2bef4c1e'),
  ('challenge_activation_migration_reviews_evidence_check','c','0ca8f01e9642f7fc676e95713f3777cd70a986ec92c12ead58f4d4a7d29617c5'),
  ('challenge_activation_migration_reviews_pkey','p','44756d887704fc88d8d0adc5c0c431103c555b4f8e6a4ddef6f7a7f6b4110606'),
  ('challenge_activation_migration_reviews_reasons_check','c','926e27ccce08d8c40026953c149009d900e777aad9ca754ce56dc9c77c637a6d'),
  ('challenge_activation_migration_reviews_user_id_fkey','f','7dffc1fe5c72443147ef9227e966626cdc6e5997f36e90bcc553577512766d2a')
), constraint_checks AS (
  SELECT coalesce(CASE WHEN d.pinned_search_path='pg_catalog' AND d.pinned_timezone='UTC' AND d.pinned_datestyle='ISO, YMD' THEN
    c.contype::text=e.kind AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred
    AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.pg_get_constraintdef(c.oid),'UTF8')),'hex')=e.definition_hash
    ELSE false END,false) AS ok
  FROM expected_constraints e LEFT JOIN pg_catalog.pg_constraint c
    ON c.conrelid=pg_catalog.to_regclass('private.challenge_activation_migration_reviews') AND c.conname=e.name
  CROSS JOIN canonical_deparse_context d
), expected_indexes(name,definition_hash,is_unique,is_primary) AS (VALUES
  ('challenge_activation_migration_reviews_pkey','fa2e22799511468d1e9914214176c0e245626e939facdcca91c2aa1d4785739a',true,true)
), index_checks AS (
  SELECT coalesce(CASE WHEN d.pinned_search_path='pg_catalog' AND d.pinned_timezone='UTC' AND d.pinned_datestyle='ISO, YMD' THEN
    i.indrelid=pg_catalog.to_regclass('private.challenge_activation_migration_reviews') AND c.relkind='i' AND am.amname='btree'
    AND pg_catalog.pg_get_userbyid(c.relowner)='postgres' AND i.indisvalid AND i.indisready AND i.indislive
    AND i.indimmediate AND NOT i.indisexclusion AND i.indisunique=e.is_unique AND i.indisprimary=e.is_primary
    AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.pg_get_indexdef(i.indexrelid),'UTF8')),'hex')=e.definition_hash
    ELSE false END,false) AS ok
  FROM expected_indexes e LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass('private.'||e.name)
  LEFT JOIN pg_catalog.pg_index i ON i.indexrelid=c.oid LEFT JOIN pg_catalog.pg_am am ON am.oid=c.relam CROSS JOIN canonical_deparse_context d
)
SELECT
  coalesce((SELECT pg_catalog.count(*)=75 AND pg_catalog.count(DISTINCT version)=75
    AND pg_catalog.max(version::text)='20261013091749'
    AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.string_agg(version::text,',' ORDER BY version::text COLLATE "C"),'UTF8')),'hex')='4c20c2eb77256efa26cb99050bf851d4c62a6c9deadcc4c92230ded0f0ecff9b'
    AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.string_agg(version::text||'_'||name::text,',' ORDER BY version::text COLLATE "C"),'UTF8')),'hex')='9a5547d2f161a38101223139a9e96e213c380844da2a9765af2171f3ad90fb63'
    FROM supabase_migrations.schema_migrations),false) AS exact_pre_migration_history_ok,
  CASE WHEN d.pinned_search_path='pg_catalog' AND d.pinned_timezone='UTC' AND d.pinned_datestyle='ISO, YMD'
    AND d.pinned_timeout='15s' AND d.pinned_lock_timeout='5s'
    THEN pg_catalog.current_setting('transaction_read_only')='on' AND pg_catalog.current_setting('server_version_num')='170006'
    ELSE false END AS read_only_pinned_server_ok,
  coalesce((SELECT shape_ok FROM registry_checks),false) AS review_table_shape_ok,
  coalesce((SELECT privileges_ok FROM registry_checks),false) AS review_table_privileges_ok,
  coalesce((SELECT pg_catalog.count(*)=5 AND pg_catalog.bool_and(ok) FROM constraint_checks),false)
    AND (SELECT pg_catalog.count(*)=5 FROM pg_catalog.pg_constraint WHERE conrelid=pg_catalog.to_regclass('private.challenge_activation_migration_reviews')) AS review_constraints_ok,
  coalesce((SELECT pg_catalog.count(*)=1 AND pg_catalog.bool_and(ok) FROM index_checks),false)
    AND (SELECT pg_catalog.count(*)=1 FROM pg_catalog.pg_index WHERE indrelid=pg_catalog.to_regclass('private.challenge_activation_migration_reviews')) AS existing_pkey_ok,
  coalesce((SELECT pg_catalog.pg_relation_size(oid)<=33554432 AND pg_catalog.pg_total_relation_size(oid)<=134217728 FROM registry),false) AS review_size_within_bound_ok,
  coalesce((SELECT (reltuples>=0 AND reltuples<=100000) OR (reltuples=-1 AND pg_catalog.pg_relation_size(oid)=0) FROM registry),false) AS review_estimate_within_bound_ok,
  pg_catalog.to_regclass('private.challenge_activation_reviews_unresolved_created_idx') IS NULL
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname IN ('private','public') AND p.proname='site_admin_get_activation_review_health') AS new_objects_absent_ok,
  NOT EXISTS(SELECT 1 FROM pg_catalog.pg_locks l WHERE l.relation=pg_catalog.to_regclass('private.challenge_activation_migration_reviews')
    AND l.database=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database())
    AND l.pid IS DISTINCT FROM pg_catalog.pg_backend_pid()
    AND (NOT l.granted OR l.mode NOT IN ('AccessShareLock','RowShareLock','ShareLock'))) AS no_conflicting_review_locks_ok
FROM canonical_deparse_context d;
