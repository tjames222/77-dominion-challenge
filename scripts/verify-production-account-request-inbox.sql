-- Fixed read-only production release checkpoint; never accepts caller SQL.
-- Inbox catalog source: A 93610a9d28dd36073407fb052199f8973d954c97, PostgreSQL 17.6.
-- Exact history accepts the frozen71 checkpoint or the reviewed two-migration73 suffix.
-- Catalog metadata only: no RPC invocation, Auth/session rows, ledger rows,
-- key/decrypted-value reads, canary grant, stored helper, or mutation.
WITH canonical_deparse_context AS MATERIALIZED (
  SELECT pg_catalog.set_config('search_path','pg_catalog',true) AS pinned_search_path,
    pg_catalog.set_config('TimeZone','UTC',true) AS pinned_timezone,
    pg_catalog.set_config('DateStyle','ISO, YMD',true) AS pinned_datestyle,
    pg_catalog.set_config('statement_timeout','15000',true) AS pinned_timeout,
    pg_catalog.set_config('lock_timeout','5000',true) AS pinned_lock_timeout
), expected_functions(signature,definition_hash,language_name,volatility,argument_text,result_text,expected_acl) AS (VALUES
  ('public.site_admin_list_account_requests(uuid,integer,text,text,text,jsonb)',
   'b13ed2cf6c57c9e8bdebff7cc94841d3f101c860c991ca07acfeb36554370b4f','plpgsql','s',
   'target_expected_actor_id uuid, target_limit integer DEFAULT 25, target_request_type text DEFAULT ''all''::text, target_status text DEFAULT ''active''::text, target_sort text DEFAULT ''oldest''::text, target_cursor jsonb DEFAULT NULL::jsonb','jsonb',
   '[["authenticated","postgres","EXECUTE",false],["postgres","postgres","EXECUTE",false]]'::jsonb),
  ('private.require_site_admin(text,uuid,boolean)',
   '4e98707e44e76b72a7a3b6448cf50c31e7bf85fc70735eb893b75e44d630113f','plpgsql','v',
   'permission_key text, expected_actor_id uuid, require_recent boolean DEFAULT false','uuid',
   '[["postgres","postgres","EXECUTE",false]]'::jsonb),
  ('private.site_admin_request_identity(uuid)',
   'ed181f29c93e7b2cb347b8e834bf247996523101a7b6ecca5603ab47b441858b','plpgsql','v',
   'expected_actor_id uuid','uuid','[["postgres","postgres","EXECUTE",false]]'::jsonb),
  ('private.site_admin_mfa_ready(uuid,uuid,boolean)',
   '4c51dab04fa4de7f6c8db5c80fd50cb47528ab0e173d83d1b8e99d3e50c4bfa0','sql','s',
   'target_user_id uuid, target_session_id uuid, require_recent boolean DEFAULT false','boolean',
   '[["postgres","postgres","EXECUTE",false]]'::jsonb)
), function_checks AS (
  SELECT e.signature,CASE WHEN canonical_deparse_context.pinned_search_path='pg_catalog' AND canonical_deparse_context.pinned_timezone='UTC' AND canonical_deparse_context.pinned_datestyle='ISO, YMD' THEN coalesce(
    p.oid::regprocedure::text=e.signature
    AND (SELECT pg_catalog.count(*)=1 FROM pg_catalog.pg_proc other WHERE other.pronamespace=p.pronamespace AND other.proname=p.proname)
    AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8')),'hex')=e.definition_hash
    AND pg_catalog.pg_get_function_arguments(p.oid)=e.argument_text
    AND pg_catalog.pg_get_function_result(p.oid)=e.result_text
    AND pg_catalog.pg_get_userbyid(p.proowner)='postgres'
    AND l.lanname=e.language_name AND p.provolatile::text=e.volatility
    AND p.prokind='f' AND p.prosecdef AND NOT p.proretset AND NOT p.proisstrict
    AND NOT p.proleakproof AND p.proparallel='u' AND p.procost=100 AND p.prorows=0
    AND p.proconfig=ARRAY['search_path=""']::text[]
    AND (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
      CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
      pg_catalog.pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable)
      ORDER BY (CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END) COLLATE "C",
        pg_catalog.pg_get_userbyid(a.grantor) COLLATE "C",a.privilege_type COLLATE "C",a.is_grantable)
      FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)=e.expected_acl
    AND NOT pg_catalog.has_function_privilege('anon',p.oid,'EXECUTE')
    AND NOT pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE')
    AND pg_catalog.has_function_privilege('authenticated',p.oid,'EXECUTE')=(e.signature LIKE 'public.%')
  ,false) ELSE false END AS ok
  FROM expected_functions e LEFT JOIN pg_catalog.pg_proc p ON p.oid=pg_catalog.to_regprocedure(e.signature)
  LEFT JOIN pg_catalog.pg_language l ON l.oid=p.prolang
  CROSS JOIN canonical_deparse_context
), expected_indexes(name,definition_hash) AS (VALUES
  ('account_lifecycle_requests_admin_bucket_idx','2b258237151472288395bf3a9e45ffd1932037ed1597c7decbcf751e1fc9a303'),
  ('account_lifecycle_requests_one_active_kind_idx','4d54296c560de36a2122e6a856bb7a163a0b3b2989746b3d6193705bb78c85b1'),
  ('account_lifecycle_requests_pkey','8ca195b51fbb66694506e5c176eecad56cb5e61b3d5ddd653c8299b32cd0906d'),
  ('account_lifecycle_requests_user_requested_idx','b44090c53edc7871e5f153f77bceedf1393119de8670b60246304707f48c5706')
), index_checks AS (
  SELECT e.name,CASE WHEN canonical_deparse_context.pinned_search_path='pg_catalog' AND canonical_deparse_context.pinned_timezone='UTC' AND canonical_deparse_context.pinned_datestyle='ISO, YMD' THEN coalesce(i.indrelid=pg_catalog.to_regclass('public.account_lifecycle_requests')
    AND pg_catalog.pg_get_userbyid(c.relowner)='postgres' AND c.relkind='i' AND am.amname='btree'
    AND i.indisvalid AND i.indisready AND i.indislive
    AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.pg_get_indexdef(i.indexrelid),'UTF8')),'hex')=e.definition_hash
    AND (e.name<>'account_lifecycle_requests_admin_bucket_idx' OR (
      i.indnatts=4 AND i.indnkeyatts=4 AND NOT i.indisunique AND NOT i.indisprimary
      AND i.indexprs IS NULL AND i.indpred IS NULL AND i.indkey::text='3 4 5 1'
      AND i.indoption::text='0 0 0 0')),false) ELSE false END AS ok
  FROM expected_indexes e LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass('public.'||e.name)
  LEFT JOIN pg_catalog.pg_index i ON i.indexrelid=c.oid LEFT JOIN pg_catalog.pg_am am ON am.oid=c.relam
  CROSS JOIN canonical_deparse_context
), ledger AS (
  SELECT * FROM pg_catalog.pg_class WHERE oid=pg_catalog.to_regclass('public.account_lifecycle_requests')
), expected_table_acl AS (
  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(r.grantee,'postgres',v.privilege,false)
    ORDER BY r.grantee COLLATE "C",v.privilege COLLATE "C") AS acl
  FROM (VALUES ('authenticated',ARRAY['SELECT']),
    ('postgres',ARRAY['DELETE','INSERT','MAINTAIN','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE']),
    ('service_role',ARRAY['DELETE','INSERT','MAINTAIN','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE'])) r(grantee,privileges)
  CROSS JOIN LATERAL pg_catalog.unnest(r.privileges) v(privilege)
), expected_columns(number,name,type_name,required,acl) AS (VALUES
  (1,'id','uuid',true,'[]'::jsonb),
  (2,'user_id','uuid',false,'[["authenticated","postgres","INSERT",false]]'::jsonb),
  (3,'request_type','text',true,'[["authenticated","postgres","INSERT",false]]'::jsonb),
  (4,'status','text',true,'[]'::jsonb),
  (5,'requested_at','timestamp with time zone',true,'[]'::jsonb),
  (6,'updated_at','timestamp with time zone',true,'[]'::jsonb),
  (7,'resolved_at','timestamp with time zone',false,'[]'::jsonb),
  (8,'operator_note','text',false,'[]'::jsonb)
), column_checks AS (
  SELECT CASE WHEN canonical_deparse_context.pinned_search_path='pg_catalog' AND canonical_deparse_context.pinned_timezone='UTC' AND canonical_deparse_context.pinned_datestyle='ISO, YMD' THEN coalesce(a.attnum=e.number AND a.attname=e.name AND NOT a.attisdropped
    AND pg_catalog.format_type(a.atttypid,a.atttypmod)=e.type_name AND a.attnotnull=e.required
    AND coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
      CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END,
      pg_catalog.pg_get_userbyid(x.grantor),x.privilege_type,x.is_grantable)
      ORDER BY (CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END) COLLATE "C",
        pg_catalog.pg_get_userbyid(x.grantor) COLLATE "C",x.privilege_type COLLATE "C",x.is_grantable)
      FROM pg_catalog.aclexplode(a.attacl) x),'[]'::jsonb)=e.acl,false) ELSE false END AS ok
  FROM expected_columns e LEFT JOIN pg_catalog.pg_attribute a
    ON a.attrelid=pg_catalog.to_regclass('public.account_lifecycle_requests') AND a.attnum=e.number
  CROSS JOIN canonical_deparse_context
), expected_policies(name,command,using_text,check_text) AS (VALUES
  ('Members can create own account requests','a',NULL,
   '((( SELECT auth.uid() AS uid) = user_id) AND (status = ''requested''::text) AND (resolved_at IS NULL) AND (operator_note IS NULL))'),
  ('Members can read own account requests','r','(( SELECT auth.uid() AS uid) = user_id)',NULL)
), policy_checks AS (
  SELECT CASE WHEN canonical_deparse_context.pinned_search_path='pg_catalog' AND canonical_deparse_context.pinned_timezone='UTC' AND canonical_deparse_context.pinned_datestyle='ISO, YMD' THEN coalesce(p.polcmd::text=e.command AND p.polpermissive
    AND (SELECT pg_catalog.array_agg(pg_catalog.pg_get_userbyid(r) ORDER BY pg_catalog.pg_get_userbyid(r) COLLATE "C") FROM pg_catalog.unnest(p.polroles) r)=ARRAY['authenticated']::name[]
    AND pg_catalog.pg_get_expr(p.polqual,p.polrelid) IS NOT DISTINCT FROM e.using_text
    AND pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid) IS NOT DISTINCT FROM e.check_text,false) ELSE false END AS ok
  FROM expected_policies e LEFT JOIN pg_catalog.pg_policy p
    ON p.polrelid=pg_catalog.to_regclass('public.account_lifecycle_requests') AND p.polname=e.name
  CROSS JOIN canonical_deparse_context
)
SELECT
  (coalesce((SELECT pg_catalog.count(*)=71 AND pg_catalog.count(DISTINCT version)=71
    AND pg_catalog.max(version::text)='20261001001245'
    AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.string_agg(version::text,',' ORDER BY version::text COLLATE "C"),'UTF8')),'hex')
      ='e6090c27e44dd678cab1b8178058f780bec2d0b4dcd99dee0d96407d24a5bb26'
    FROM supabase_migrations.schema_migrations),false)
    OR (coalesce((SELECT pg_catalog.count(*)=73 AND pg_catalog.count(DISTINCT version)=73
      AND pg_catalog.max(version::text)='20261007060519'
      AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        pg_catalog.string_agg(version::text,',' ORDER BY version::text COLLATE "C"),'UTF8')),'hex')
          ='d9e099e1d3c7646aab3c72d0b0263030343557c4280923048e268f0c95bb963b'
      FROM supabase_migrations.schema_migrations),false)
      AND (SELECT pg_catalog.count(*)=2 FROM supabase_migrations.schema_migrations WHERE (version,name) IN (
        ('20261007055555','site_admin_account_request_queue_health'),
        ('20261007060519','profile_photo_cleanup_monitor_health')))))
    AND EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations
      WHERE version='20260929000950' AND name='site_admin_account_requests_inbox')
    AND (SELECT pg_catalog.count(*)=4 FROM supabase_migrations.schema_migrations
      WHERE (version,name) IN (
        ('20260930152825','add_original_77_completion_evidence_foundation'),
        ('20260930160740','wire_original_77_live_completion'),
        ('20260930161218','share_submitted_progress_v2'),
        ('20261001001245','repeatable_challenge_instances_v2'))) AS exact_migration_history_ok,
  CASE WHEN canonical_deparse_context.pinned_search_path='pg_catalog' AND canonical_deparse_context.pinned_timezone='UTC' AND canonical_deparse_context.pinned_datestyle='ISO, YMD'
    AND canonical_deparse_context.pinned_timeout='15s' AND canonical_deparse_context.pinned_lock_timeout='5s'
    THEN pg_catalog.current_setting('transaction_read_only')='on' AND pg_catalog.current_setting('server_version_num')='170006'
    ELSE false END AS read_only_pinned_server_ok,
  coalesce((SELECT pg_catalog.bool_and(ok) FROM function_checks WHERE signature LIKE 'public.%'),false) AS inbox_rpc_catalog_ok,
  coalesce((SELECT pg_catalog.count(*)=3 AND pg_catalog.bool_and(ok) FROM function_checks WHERE signature LIKE 'private.%'),false) AS existing_admin_guards_ok,
  coalesce((SELECT pg_catalog.bool_and(ok) FROM index_checks WHERE name='account_lifecycle_requests_admin_bucket_idx'),false) AS inbox_index_ok,
  coalesce((SELECT pg_catalog.count(*)=4 AND pg_catalog.bool_and(ok) FROM index_checks),false) AS existing_indexes_preserved_ok,
  coalesce((SELECT relrowsecurity AND relforcerowsecurity AND relkind='r' AND relpersistence='p'
    AND pg_catalog.pg_get_userbyid(relowner)='postgres' FROM ledger),false) AS ledger_rls_owner_ok,
  coalesce((SELECT (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
      CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END,
      pg_catalog.pg_get_userbyid(x.grantor),x.privilege_type,x.is_grantable)
      ORDER BY (CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END) COLLATE "C",
        pg_catalog.pg_get_userbyid(x.grantor) COLLATE "C",x.privilege_type COLLATE "C",x.is_grantable)
      FROM pg_catalog.aclexplode(coalesce(ledger.relacl,pg_catalog.acldefault('r',ledger.relowner))) x)
      =(SELECT acl FROM expected_table_acl) FROM ledger),false) AS ledger_exact_acl_ok,
  coalesce((SELECT pg_catalog.count(*)=8 AND pg_catalog.bool_and(ok) FROM column_checks),false)
    AND (SELECT pg_catalog.count(*)=8 FROM pg_catalog.pg_attribute WHERE attrelid=pg_catalog.to_regclass('public.account_lifecycle_requests') AND attnum>0 AND NOT attisdropped) AS ledger_columns_grants_ok,
  coalesce((SELECT pg_catalog.count(*)=2 AND pg_catalog.bool_and(ok) FROM policy_checks),false)
    AND (SELECT pg_catalog.count(*)=2 FROM pg_catalog.pg_policy WHERE polrelid=pg_catalog.to_regclass('public.account_lifecycle_requests')) AS ledger_member_policies_ok,
  coalesce((SELECT NOT pg_catalog.has_table_privilege('anon',oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
    AND pg_catalog.has_table_privilege('authenticated',oid,'SELECT')
    AND NOT pg_catalog.has_table_privilege('authenticated',oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
    AND (SELECT pg_catalog.array_agg(attname ORDER BY attnum) FROM pg_catalog.pg_attribute WHERE attrelid=ledger.oid AND attnum>0 AND NOT attisdropped
      AND pg_catalog.has_column_privilege('authenticated',ledger.oid,attnum,'INSERT'))=ARRAY['user_id','request_type']::name[]
    FROM ledger),false) AS member_effective_privileges_ok
FROM canonical_deparse_context;
