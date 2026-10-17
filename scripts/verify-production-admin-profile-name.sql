-- Source-fixed exact75 catalog attestation. Exactly thirteen boolean fields.
-- No application/Auth/audit rows, RPC invocation, names, credentials or repair.
-- Definition hashes are from the isolated PG17.6 canonical metadata fixture.
WITH canonical_deparse_context AS MATERIALIZED (
  SELECT pg_catalog.set_config('search_path','pg_catalog',true) AS pinned_search_path,
    pg_catalog.set_config('TimeZone','UTC',true) AS pinned_timezone,
    pg_catalog.set_config('DateStyle','ISO, YMD',true) AS pinned_datestyle,
    pg_catalog.set_config('statement_timeout','15000',true) AS pinned_timeout,
    pg_catalog.set_config('lock_timeout','5000',true) AS pinned_lock_timeout
), expected_functions(signature,definition_hash,language_name,volatility,security_definer,returns_set,expected_acl,expected_config) AS (VALUES
  ('private.require_member_current_session(uuid,uuid)','0600e5662aaad65302daea4497ac65461d1d7f8b9a817dc258e792836dd86757','plpgsql','v',true,false,'[["postgres","postgres","EXECUTE",false]]'::jsonb,ARRAY['search_path=""']),
  ('private.require_site_admin(text,uuid,boolean)','4e98707e44e76b72a7a3b6448cf50c31e7bf85fc70735eb893b75e44d630113f','plpgsql','v',true,false,'[["postgres","postgres","EXECUTE",false]]'::jsonb,ARRAY['search_path=""']),
  ('private.site_admin_audit_payload(bigint)','91609a5bbef66fcf7747f36ad5c57b17289e7e8a4094370939c6b92576b2eba1','sql','s',false,false,'[["postgres","postgres","EXECUTE",false]]'::jsonb,ARRAY['search_path=""']),
  ('private.site_admin_immutable()','632f87e1dae67dd8548b38834ebee51c1b2a5828fa5ffc37f4d60466a5eb4b35','plpgsql','v',false,false,'[["postgres","postgres","EXECUTE",false]]'::jsonb,ARRAY['search_path=""']),
  ('private.site_admin_mfa_ready(uuid,uuid,boolean)','4c51dab04fa4de7f6c8db5c80fd50cb47528ab0e173d83d1b8e99d3e50c4bfa0','sql','s',true,false,'[["postgres","postgres","EXECUTE",false]]'::jsonb,ARRAY['search_path=""']),
  ('private.site_admin_profile_name_snapshot(uuid,uuid,uuid,boolean)','7c24f44b57f36295f0a6fa5b5618c4cb951d665b05d0633ee3f2dedc33575ccf','sql','v',true,true,'[["postgres","postgres","EXECUTE",false]]'::jsonb,ARRAY['search_path=""']),
  ('private.site_admin_profile_name_valid(text)','b680bef26609207fcf99bb2d56b08aed19476a7d0e5c6ce68a3046ce45585970','sql','i',false,false,'[["postgres","postgres","EXECUTE",false]]'::jsonb,ARRAY['search_path=""']),
  ('private.site_admin_request_identity(uuid)','ed181f29c93e7b2cb347b8e834bf247996523101a7b6ecca5603ab47b441858b','plpgsql','v',true,false,'[["postgres","postgres","EXECUTE",false]]'::jsonb,ARRAY['search_path=""']),
  ('private.sync_site_admin_profile_name_version()','cc6a352b6a8bf4513a29fda8b77e82b3f80c5bc592d0d14f0cec9472dfbf47ce','plpgsql','v',true,false,'[["postgres","postgres","EXECUTE",false]]'::jsonb,ARRAY['search_path=""']),
  ('public.site_admin_correct_profile_name(uuid,uuid,uuid,text,uuid,uuid)','e4d378b1b931a23f0f069613225fc5baa101c1641953bcb9b4039c9159a6ddbd','plpgsql','v',true,false,'[["authenticated","postgres","EXECUTE",false],["postgres","postgres","EXECUTE",false]]'::jsonb,ARRAY['search_path=""','lock_timeout=5s']),
  ('public.site_admin_get_profile_name(uuid,uuid)','b20dbeea98d1a032477fd55d21cfaa2401bce0e91d985e713b271e16c78675d2','plpgsql','v',true,false,'[["authenticated","postgres","EXECUTE",false],["postgres","postgres","EXECUTE",false]]'::jsonb,ARRAY['search_path=""']),
  ('public.site_admin_list_audit(uuid,integer,uuid,text,text,jsonb)','0581a3d4d70c1352dba56c5b096284553eaf23c18c346656628e85895c3f26dc','plpgsql','s',true,false,'[["authenticated","postgres","EXECUTE",false],["postgres","postgres","EXECUTE",false]]'::jsonb,ARRAY['search_path=""'])
), function_checks AS (
  SELECT coalesce(CASE WHEN d.pinned_search_path='pg_catalog' AND d.pinned_timezone='UTC' AND d.pinned_datestyle='ISO, YMD' THEN
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8')),'hex')=e.definition_hash
    AND p.oid::regprocedure::text=e.signature
    AND (SELECT pg_catalog.count(*)=1 FROM pg_catalog.pg_proc other WHERE other.pronamespace=p.pronamespace AND other.proname=p.proname)
    AND pg_catalog.pg_get_userbyid(p.proowner)='postgres' AND l.lanname=e.language_name AND p.provolatile::text=e.volatility
    AND p.prokind='f' AND p.prosecdef=e.security_definer AND p.proretset=e.returns_set AND NOT p.proisstrict
    AND NOT p.proleakproof AND p.proparallel='u' AND p.procost=100 AND p.prorows=CASE WHEN e.returns_set THEN 1000 ELSE 0 END
    AND p.proconfig=e.expected_config
    AND (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
      CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
      pg_catalog.pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable)
      ORDER BY (CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END) COLLATE "C",
        pg_catalog.pg_get_userbyid(a.grantor) COLLATE "C",a.privilege_type COLLATE "C",a.is_grantable)
      FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)=e.expected_acl
    AND NOT pg_catalog.has_function_privilege('anon',p.oid,'EXECUTE')
    AND pg_catalog.has_function_privilege('authenticated',p.oid,'EXECUTE')=(e.signature LIKE 'public.%')
    AND NOT pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE')
    ELSE false END,false) AS ok
  FROM expected_functions e LEFT JOIN pg_catalog.pg_proc p ON p.oid=pg_catalog.to_regprocedure(e.signature)
  LEFT JOIN pg_catalog.pg_language l ON l.oid=p.prolang CROSS JOIN canonical_deparse_context d
), expected_tables(kind,relation_name,expected_columns,constraint_count,index_count) AS (VALUES
  ('sidecar','private.site_admin_profile_name_versions','[[1,"user_id","uuid",true,null,"",""],[2,"version","uuid",true,"gen_random_uuid()","",""]]'::jsonb,2,1),
  ('audit','private.site_admin_audit','[[1,"sequence_id","bigint",true,null,"a",""],[2,"actor_id","uuid",false,null,"",""],[3,"target_user_id","uuid",false,null,"",""],[4,"action","text",true,null,"",""],[5,"permission","text",true,null,"",""],[6,"reason_code","text",true,null,"",""],[7,"before_role","text",false,null,"",""],[8,"after_role","text",false,null,"",""],[9,"request_id","uuid",true,null,"",""],[10,"correlation_id","uuid",true,null,"",""],[11,"environment","text",true,null,"",""],[12,"occurred_at","timestamp with time zone",true,"clock_timestamp()","",""],[13,"outcome","text",true,null,"",""],[14,"error_code","text",false,null,"",""],[15,"early_access_request_id","uuid",false,null,"",""],[16,"before_request_status","text",false,null,"",""],[17,"after_request_status","text",false,null,"",""],[18,"before_profile_name_version","uuid",false,null,"",""],[19,"after_profile_name_version","uuid",false,null,"",""],[20,"profile_name_changed","boolean",false,null,"",""]]'::jsonb,7,5)
), tables AS (
  SELECT e.*,c.oid,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity,c.relkind,c.relpersistence
  FROM expected_tables e LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass(e.relation_name)
), expected_table_acl AS (
  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array('postgres','postgres',privilege,false) ORDER BY privilege COLLATE "C") AS acl
  FROM pg_catalog.unnest(ARRAY['DELETE','INSERT','MAINTAIN','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE']) privilege
), table_checks AS (
  SELECT t.kind,coalesce(CASE WHEN d.pinned_search_path='pg_catalog' AND d.pinned_timezone='UTC' AND d.pinned_datestyle='ISO, YMD' THEN
    t.relkind='r' AND t.relpersistence='p' AND t.relrowsecurity AND NOT t.relforcerowsecurity
    AND pg_catalog.pg_get_userbyid(t.relowner)='postgres'
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=t.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=t.oid OR inhparent=t.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=t.oid AND attnum>0 AND attisdropped)
    AND (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(a.attnum,a.attname,
      pg_catalog.format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_catalog.pg_get_expr(v.adbin,v.adrelid),a.attidentity,a.attgenerated)
      ORDER BY a.attnum)
      FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef v ON v.adrelid=a.attrelid AND v.adnum=a.attnum
      WHERE a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped)=t.expected_columns
    ELSE false END,false) AS structure_ok,
    coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
      CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
      pg_catalog.pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable)
      ORDER BY (CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END) COLLATE "C",
        pg_catalog.pg_get_userbyid(a.grantor) COLLATE "C",a.privilege_type COLLATE "C",a.is_grantable)
      FROM pg_catalog.aclexplode(coalesce(t.relacl,pg_catalog.acldefault('r',t.relowner))) a)=(SELECT acl FROM expected_table_acl)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=t.oid AND a.attnum>0
      AND a.attacl IS NOT NULL AND pg_catalog.cardinality(a.attacl)>0)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.unnest(ARRAY['anon','authenticated','service_role']) role_name
      WHERE pg_catalog.has_table_privilege(role_name,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
        OR pg_catalog.has_any_column_privilege(role_name,t.oid,'SELECT,INSERT,UPDATE,REFERENCES')),false) AS privileges_ok
  FROM tables t CROSS JOIN canonical_deparse_context d
), expected_constraints(kind,name,constraint_type,definition_hash) AS (VALUES
  ('sidecar','site_admin_profile_name_versions_pkey','p','44756d887704fc88d8d0adc5c0c431103c555b4f8e6a4ddef6f7a7f6b4110606'),
  ('sidecar','site_admin_profile_name_versions_user_id_fkey','f','3be7e72fa97076ca3201f85e15756ed4711fe052768d533566c2284f1df3d8b8'),
  ('audit','site_admin_audit_actor_id_request_id_key','u','9390074cc17d6ff31ab1bd166935e98c2fc0faf8c9c52059ddc90e4952f50a1d'),
  ('audit','site_admin_audit_after_role_fkey','f','2417bac6da36b0a0073d021b14fae92dea956c648316fff1ca163e04af5659ba'),
  ('audit','site_admin_audit_before_role_fkey','f','3e63a57453102b22354516ee1167d83a8712bcd335983000acc32fccfe52d0a5'),
  ('audit','site_admin_audit_environment_check','c','a646bfd798f0ad718ace7ef031d2de7b9fc9d26ba2ab8c7befe9ff09bc156ff9'),
  ('audit','site_admin_audit_outcome_check','c','5b70ab831df296abfb438a9722cb73512a8ba6f9212e30337ebfd302057d3fbc'),
  ('audit','site_admin_audit_pkey','p','ff6588edc934741706f7cef29ad737f1200daf86e590f622ac6efbb8e66dea2a'),
  ('audit','site_admin_audit_typed_action_check','c','d2ab4045d34f37444a3b4e0f1ec6bb3d6487b6bb8d889df463766d7007229230')
), constraint_checks AS (
  SELECT e.kind,coalesce(CASE WHEN d.pinned_search_path='pg_catalog' AND d.pinned_timezone='UTC' AND d.pinned_datestyle='ISO, YMD' THEN
    c.contype::text=e.constraint_type AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred
    AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.pg_get_constraintdef(c.oid),'UTF8')),'hex')=e.definition_hash
    ELSE false END,false) AS ok
  FROM expected_constraints e JOIN tables t ON t.kind=e.kind
  LEFT JOIN pg_catalog.pg_constraint c ON c.conrelid=t.oid AND c.conname=e.name CROSS JOIN canonical_deparse_context d
), expected_indexes(kind,name,definition_hash,is_unique,is_primary) AS (VALUES
  ('sidecar','private.site_admin_profile_name_versions_pkey','131a7412b98d75812c5085d0bf6c61c8294b5a367c6482c634cb0514d89db0dc',true,true),
  ('audit','private.site_admin_audit_actor_id_request_id_key','3d914d3fc3803d5827c1f543b95ae46b817018301f6fad1da4a98e082fc0dfda',true,false),
  ('audit','private.site_admin_audit_actor_time_idx','0a83bb6d6c129f6b9dafa602f49602ff9dd70ef2e8b7f2eaea0dd405cd7afdac',false,false),
  ('audit','private.site_admin_audit_early_access_sequence_idx','c7e4f3d61198be248abaec9e6de86fb9f264550f1afe654ba6ca998d99096d3a',false,false),
  ('audit','private.site_admin_audit_pkey','4154d5e8e722127d69ec4c51b0c06960c6f738e32cf264739e4f62d01eb12446',true,true),
  ('audit','private.site_admin_audit_target_sequence_idx','c73e7be789098438a8f1e6a3f285d680248c4f1fb8f93755e27ba1ee485576c7',false,false)
), index_checks AS (
  SELECT e.kind,coalesce(CASE WHEN d.pinned_search_path='pg_catalog' AND d.pinned_timezone='UTC' AND d.pinned_datestyle='ISO, YMD' THEN
    i.indrelid=t.oid AND c.relkind='i' AND am.amname='btree' AND pg_catalog.pg_get_userbyid(c.relowner)='postgres'
    AND i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate AND NOT i.indisexclusion
    AND i.indisunique=e.is_unique AND i.indisprimary=e.is_primary
    AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.pg_get_indexdef(i.indexrelid),'UTF8')),'hex')=e.definition_hash
    ELSE false END,false) AS ok
  FROM expected_indexes e JOIN tables t ON t.kind=e.kind
  LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass(e.name)
  LEFT JOIN pg_catalog.pg_index i ON i.indexrelid=c.oid LEFT JOIN pg_catalog.pg_am am ON am.oid=c.relam CROSS JOIN canonical_deparse_context d
), expected_triggers(kind,relation_name,name,function_signature,definition_hash) AS (VALUES
  ('audit','private.site_admin_audit','site_admin_audit_immutable','private.site_admin_immutable()','a039f7f568e018f644a612da4c8d7dc308e12c8e341a3c4a9c2fd89456779d83'),
  ('profile','public.profiles','sync_site_admin_profile_name_version','private.sync_site_admin_profile_name_version()','80822a4d9e5aa036f59f53024bdeef1f9d6e95c9f2b102690ec4bf7d331251a9')
), trigger_checks AS (
  SELECT e.kind,coalesce(CASE WHEN d.pinned_search_path='pg_catalog' AND d.pinned_timezone='UTC' AND d.pinned_datestyle='ISO, YMD' THEN
    NOT t.tgisinternal AND t.tgenabled='O' AND t.tgfoid=pg_catalog.to_regprocedure(e.function_signature)
    AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.pg_get_triggerdef(t.oid),'UTF8')),'hex')=e.definition_hash
    ELSE false END,false) AS ok
  FROM expected_triggers e LEFT JOIN pg_catalog.pg_trigger t ON t.tgrelid=pg_catalog.to_regclass(e.relation_name) AND t.tgname=e.name
  CROSS JOIN canonical_deparse_context d
)
SELECT
  coalesce((SELECT pg_catalog.count(*)=75 AND pg_catalog.count(DISTINCT version)=75
    AND pg_catalog.max(version::text)='20261013091749'
    AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.string_agg(version::text,',' ORDER BY version::text COLLATE "C"),'UTF8')),'hex')='4c20c2eb77256efa26cb99050bf851d4c62a6c9deadcc4c92230ded0f0ecff9b'
    AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.string_agg(version::text||'_'||name::text,',' ORDER BY version::text COLLATE "C"),'UTF8')),'hex')='9a5547d2f161a38101223139a9e96e213c380844da2a9765af2171f3ad90fb63'
    FROM supabase_migrations.schema_migrations),false) AS exact_migration_history_ok,
  CASE WHEN d.pinned_search_path='pg_catalog' AND d.pinned_timezone='UTC' AND d.pinned_datestyle='ISO, YMD'
    AND d.pinned_timeout='15s' AND d.pinned_lock_timeout='5s'
    THEN pg_catalog.current_setting('transaction_read_only')='on' AND pg_catalog.current_setting('server_version_num')='170006'
    ELSE false END AS read_only_pinned_server_ok,
  coalesce((SELECT pg_catalog.count(*)=12 AND pg_catalog.bool_and(ok) FROM function_checks),false)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname IN ('private','public') AND p.proname LIKE '%profile_name%'
        AND NOT EXISTS(SELECT 1 FROM expected_functions e WHERE pg_catalog.to_regprocedure(e.signature)=p.oid)) AS functions_catalog_ok,
  coalesce((SELECT structure_ok FROM table_checks WHERE kind='sidecar'),false) AS sidecar_structure_ok,
  coalesce((SELECT privileges_ok FROM table_checks WHERE kind='sidecar'),false) AS sidecar_privileges_ok,
  coalesce((SELECT pg_catalog.count(*)=2 AND pg_catalog.bool_and(ok) FROM constraint_checks WHERE kind='sidecar'),false)
    AND (SELECT pg_catalog.count(*)=2 FROM pg_catalog.pg_constraint WHERE conrelid=pg_catalog.to_regclass('private.site_admin_profile_name_versions')) AS sidecar_constraints_ok,
  coalesce((SELECT pg_catalog.count(*)=1 AND pg_catalog.bool_and(ok) FROM index_checks WHERE kind='sidecar'),false)
    AND (SELECT pg_catalog.count(*)=1 FROM pg_catalog.pg_index WHERE indrelid=pg_catalog.to_regclass('private.site_admin_profile_name_versions')) AS sidecar_indexes_ok,
  coalesce((SELECT ok FROM trigger_checks WHERE kind='profile'),false)
    AND (SELECT pg_catalog.count(*)=1 FROM pg_catalog.pg_trigger WHERE tgfoid=pg_catalog.to_regprocedure('private.sync_site_admin_profile_name_version()'))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid=pg_catalog.to_regclass('private.site_admin_profile_name_versions') AND NOT tgisinternal) AS profile_version_trigger_ok,
  coalesce((SELECT structure_ok FROM table_checks WHERE kind='audit'),false) AS audit_structure_ok,
  coalesce((SELECT privileges_ok FROM table_checks WHERE kind='audit'),false) AS audit_privileges_ok,
  coalesce((SELECT pg_catalog.count(*)=7 AND pg_catalog.bool_and(ok) FROM constraint_checks WHERE kind='audit'),false)
    AND (SELECT pg_catalog.count(*)=7 FROM pg_catalog.pg_constraint WHERE conrelid=pg_catalog.to_regclass('private.site_admin_audit')) AS audit_constraints_ok,
  coalesce((SELECT pg_catalog.count(*)=5 AND pg_catalog.bool_and(ok) FROM index_checks WHERE kind='audit'),false)
    AND (SELECT pg_catalog.count(*)=5 FROM pg_catalog.pg_index WHERE indrelid=pg_catalog.to_regclass('private.site_admin_audit')) AS audit_indexes_ok,
  coalesce((SELECT ok FROM trigger_checks WHERE kind='audit'),false)
    AND (SELECT pg_catalog.count(*)=1 FROM pg_catalog.pg_trigger WHERE tgrelid=pg_catalog.to_regclass('private.site_admin_audit') AND NOT tgisinternal) AS audit_immutable_trigger_ok
FROM canonical_deparse_context d;
