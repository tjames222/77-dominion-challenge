-- Source-fixed, read-only exact74 catalog attestation. Boolean output only.
-- No RPC execution, registry/Auth/Cron rows, secrets, body output or repair.
WITH canonical_deparse_context AS MATERIALIZED (
  SELECT pg_catalog.set_config('search_path','pg_catalog',true) AS pinned_search_path,
    pg_catalog.set_config('TimeZone','UTC',true) AS pinned_timezone,
    pg_catalog.set_config('DateStyle','ISO, YMD',true) AS pinned_datestyle,
    pg_catalog.set_config('statement_timeout','15000',true) AS pinned_timeout,
    pg_catalog.set_config('lock_timeout','5000',true) AS pinned_lock_timeout
), expected_functions(signature,definition_hash,category,language_name,volatility,expected_acl,expected_config) AS (VALUES
  ('public.profile_photo_cleanup_health()','5ab95e9aa1600f4cfeeb5751d76a7babb278f4854b3bbbfc667ec76633214ba9','service','sql','s','[["postgres","postgres","EXECUTE",false],["service_role","postgres","EXECUTE",false]]'::jsonb,ARRAY['search_path=""']),
  ('private.site_admin_request_identity(uuid)','ed181f29c93e7b2cb347b8e834bf247996523101a7b6ecca5603ab47b441858b','guard','plpgsql','v','[["postgres","postgres","EXECUTE",false]]'::jsonb,ARRAY['search_path=""']),
  ('public.site_admin_get_cleanup_health(uuid)','f66a31e8247560a03695b2b2cce650917fd07881736b6a585fd34f6619f6c1ef','cleanup','plpgsql','s','[["authenticated","postgres","EXECUTE",false],["postgres","postgres","EXECUTE",false]]'::jsonb,ARRAY['search_path=""','lock_timeout=1s']),
  ('private.require_site_admin(text,uuid,boolean)','4e98707e44e76b72a7a3b6448cf50c31e7bf85fc70735eb893b75e44d630113f','guard','plpgsql','v','[["postgres","postgres","EXECUTE",false]]'::jsonb,ARRAY['search_path=""']),
  ('public.profile_photo_cleanup_monitor_health()','cec865841e14b0fae94f01343e3bb13e3391c755fea9f853e469e5982209e442','service','plpgsql','s','[["postgres","postgres","EXECUTE",false],["service_role","postgres","EXECUTE",false]]'::jsonb,ARRAY['search_path=""']),
  ('private.site_admin_mfa_ready(uuid,uuid,boolean)','4c51dab04fa4de7f6c8db5c80fd50cb47528ab0e173d83d1b8e99d3e50c4bfa0','guard','sql','s','[["postgres","postgres","EXECUTE",false]]'::jsonb,ARRAY['search_path=""'])
), function_checks AS (
  SELECT e.category,coalesce(CASE WHEN canonical_deparse_context.pinned_search_path='pg_catalog' AND canonical_deparse_context.pinned_timezone='UTC' AND canonical_deparse_context.pinned_datestyle='ISO, YMD' THEN
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8')),'hex')=e.definition_hash
    AND p.oid::regprocedure::text=e.signature
    AND (SELECT pg_catalog.count(*)=1 FROM pg_catalog.pg_proc other WHERE other.pronamespace=p.pronamespace AND other.proname=p.proname)
    AND pg_catalog.pg_get_userbyid(p.proowner)='postgres' AND l.lanname=e.language_name AND p.provolatile::text=e.volatility
    AND p.prokind='f' AND p.prosecdef AND NOT p.proretset AND NOT p.proisstrict
    AND NOT p.proleakproof AND p.proparallel='u' AND p.procost=100 AND p.prorows=0
    AND p.proconfig=e.expected_config
    AND (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
      CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
      pg_catalog.pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable)
      ORDER BY (CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END) COLLATE "C",
        pg_catalog.pg_get_userbyid(a.grantor) COLLATE "C",a.privilege_type COLLATE "C",a.is_grantable)
      FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)=e.expected_acl
    AND NOT pg_catalog.has_function_privilege('anon',p.oid,'EXECUTE')
    AND pg_catalog.has_function_privilege('authenticated',p.oid,'EXECUTE')=(e.category='cleanup')
    AND pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE')=(e.category='service')
    ELSE false END,false) AS ok
  FROM expected_functions e LEFT JOIN pg_catalog.pg_proc p ON p.oid=pg_catalog.to_regprocedure(e.signature)
  LEFT JOIN pg_catalog.pg_language l ON l.oid=p.prolang CROSS JOIN canonical_deparse_context
), expected_indexes(name,definition_hash,is_unique) AS (VALUES
  ('profile_photo_objects_pkey','25b497c7ce31bd783483d58aa2128bd2c889f0b79a5a11c4dede7e4916253b03',true),
  ('profile_photo_objects_claim_idx','aab61b2045b0d8c62c1d05be307473c916d741a6d23d1a5d88105e58cd6813b9',false),
  ('profile_photo_objects_expiry_idx','c83ff38a326499961ed8e2336acbec01222f5ef1554828b5d111c918202e3ad2',false),
  ('profile_photo_objects_storage_path_key','00e7cf47b518c13a24585c25f925cd9b26510741c61fac7e5f444866c4218a28',true),
  ('profile_photo_objects_one_canonical_idx','3600fe49cfa591015f8f80ad346464cafee4434a4202ad055b266e9ee412fc0e',true),
  ('profile_photo_objects_storage_object_idx','b5ad52d01ccc2882b56e0f975a2bc7c542fcc7f1bfcc8e38b54c06d7a4d7f4ee',true),
  ('profile_photo_objects_upload_request_idx','8cfa60c3dfed520f5020a9114118a434fb87c4679a804aaf8db5acc00a4da30e',true),
  ('profile_photo_objects_cleanup_failure_idx','fbc7de781ba7dfb03c65eebe2c7fb473363b3a1f19e4136c669e59580c064f35',false),
  ('profile_photo_objects_service_cleanup_idx','e59c4a367d96f428b09b553a66df9de14e5b6c727737d0e8e8b0d9a1e1f8cebe',false),
  ('profile_photo_objects_user_created_at_idx','c74dfa115d9899c21ce0d4ab8a7db0c3558d9a821ab453741677a4aa02242ffc',false),
  ('profile_photo_objects_cleanup_eligible_idx','34baedbbecc596dac25310d8ea311ee69abf0033ecaa3673d9ae8d2a1f10231f',false),
  ('profile_photo_objects_cleanup_service_lease_idx','5aff02162dd3ea1ad3f4bc0547087f72f39e3ea5efe90167c128cc84a3c430cd',false)
), index_checks AS (
  SELECT coalesce(CASE WHEN canonical_deparse_context.pinned_search_path='pg_catalog' AND canonical_deparse_context.pinned_timezone='UTC' AND canonical_deparse_context.pinned_datestyle='ISO, YMD' THEN
    i.indrelid=pg_catalog.to_regclass('private.profile_photo_objects') AND c.relkind='i' AND am.amname='btree'
    AND pg_catalog.pg_get_userbyid(c.relowner)='postgres' AND i.indisvalid AND i.indisready AND i.indislive
    AND i.indisunique=e.is_unique
    AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.pg_get_indexdef(i.indexrelid),'UTF8')),'hex')=e.definition_hash
    ELSE false END,false) AS ok
  FROM expected_indexes e LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass('private.'||e.name)
  LEFT JOIN pg_catalog.pg_index i ON i.indexrelid=c.oid LEFT JOIN pg_catalog.pg_am am ON am.oid=c.relam CROSS JOIN canonical_deparse_context
), registry AS (
  SELECT * FROM pg_catalog.pg_class WHERE oid=pg_catalog.to_regclass('private.profile_photo_objects')
), expected_registry_acl AS (
  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array('postgres','postgres',privilege,false) ORDER BY privilege COLLATE "C") AS acl
  FROM pg_catalog.unnest(ARRAY['DELETE','INSERT','MAINTAIN','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE']) privilege
)
SELECT
  coalesce((SELECT pg_catalog.count(*)=74 AND pg_catalog.count(DISTINCT version)=74
    AND pg_catalog.max(version::text)='20261013055744'
    AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.string_agg(version::text,',' ORDER BY version::text COLLATE "C"),'UTF8')),'hex')='cb786c2a891bfbfd739aef4a6a2fa1c01bafad29fc8f2739e2f41342fc7de765'
    AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.string_agg(version::text||'_'||name::text,',' ORDER BY version::text COLLATE "C"),'UTF8')),'hex')='1db17cdef50ab485d4fc7352e6ebd239fa14a55956d556b4c9e19d323b7c1d7c'
    FROM supabase_migrations.schema_migrations),false) AS exact_migration_history_ok,
  CASE WHEN canonical_deparse_context.pinned_search_path='pg_catalog' AND canonical_deparse_context.pinned_timezone='UTC' AND canonical_deparse_context.pinned_datestyle='ISO, YMD'
    AND canonical_deparse_context.pinned_timeout='15s' AND canonical_deparse_context.pinned_lock_timeout='5s'
    THEN pg_catalog.current_setting('transaction_read_only')='on' AND pg_catalog.current_setting('server_version_num')='170006'
    ELSE false END AS read_only_pinned_server_ok,
  coalesce((SELECT pg_catalog.count(*)=1 AND pg_catalog.bool_and(ok) FROM function_checks WHERE category='cleanup'),false) AS cleanup_rpc_catalog_ok,
  coalesce((SELECT pg_catalog.count(*)=3 AND pg_catalog.bool_and(ok) FROM function_checks WHERE category='guard'),false) AS existing_admin_guards_ok,
  coalesce((SELECT pg_catalog.count(*)=2 AND pg_catalog.bool_and(ok) FROM function_checks WHERE category='service'),false) AS service_health_preserved_ok,
  coalesce((SELECT pg_catalog.count(*)=12 AND pg_catalog.bool_and(ok) FROM index_checks),false)
    AND (SELECT pg_catalog.count(*)=12 FROM pg_catalog.pg_index WHERE indrelid=pg_catalog.to_regclass('private.profile_photo_objects')) AS cleanup_indexes_ok,
  coalesce((SELECT relrowsecurity AND NOT relforcerowsecurity AND relkind='r' AND relpersistence='p'
    AND pg_catalog.pg_get_userbyid(relowner)='postgres' FROM registry),false)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=pg_catalog.to_regclass('private.profile_photo_objects')) AS registry_rls_owner_ok,
  coalesce((SELECT (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
      CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END,pg_catalog.pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable)
      ORDER BY (CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END) COLLATE "C",
        pg_catalog.pg_get_userbyid(a.grantor) COLLATE "C",a.privilege_type COLLATE "C",a.is_grantable)
      FROM pg_catalog.aclexplode(coalesce(registry.relacl,pg_catalog.acldefault('r',registry.relowner))) a)
      =(SELECT acl FROM expected_registry_acl) FROM registry),false) AS registry_exact_acl_ok,
  CASE WHEN canonical_deparse_context.pinned_search_path='pg_catalog' AND canonical_deparse_context.pinned_timezone='UTC' AND canonical_deparse_context.pinned_datestyle='ISO, YMD' THEN
    coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(attnum,attname,pg_catalog.format_type(atttypid,atttypmod),attnotnull) ORDER BY attnum)
      ='[[1,"id","uuid",true],[2,"user_id","uuid",true],[3,"storage_path","text",true],[4,"storage_object_id","uuid",false],[5,"state","text",true],[6,"upload_expires_at","timestamp with time zone",false],[7,"claim_token","uuid",false],[8,"claim_expires_at","timestamp with time zone",false],[9,"attempts","integer",true],[10,"retired_at","timestamp with time zone",false],[11,"created_at","timestamp with time zone",true],[12,"updated_at","timestamp with time zone",true],[13,"claim_actor","text",false],[14,"delete_authorized_at","timestamp with time zone",false],[15,"next_attempt_at","timestamp with time zone",true],[16,"last_error_code","text",false],[17,"last_failed_at","timestamp with time zone",false],[18,"upload_request_id","uuid",false],[19,"source_sha256","text",false],[20,"verified_output_sha256","text",false],[21,"verified_size_bytes","integer",false],[22,"verified_width","integer",false],[23,"verified_height","integer",false],[24,"verified_at","timestamp with time zone",false]]'::jsonb AND pg_catalog.bool_and(attacl IS NULL OR pg_catalog.cardinality(attacl)=0)
      FROM pg_catalog.pg_attribute WHERE attrelid=pg_catalog.to_regclass('private.profile_photo_objects') AND attnum>0 AND NOT attisdropped),false)
    ELSE false END AS registry_columns_grants_ok,
  coalesce((SELECT NOT EXISTS(SELECT 1 FROM pg_catalog.unnest(ARRAY['anon','authenticated','service_role']) role_name
    WHERE pg_catalog.has_table_privilege(role_name,registry.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
      OR pg_catalog.has_any_column_privilege(role_name,registry.oid,'SELECT,INSERT,UPDATE,REFERENCES')) FROM registry),false) AS registry_effective_privileges_ok
FROM canonical_deparse_context;
