-- Source-fixed original77 release checkpoint. Catalogs/configuration only;
-- never calls an application RPC or reads users, sessions, check-ins, awards,
-- completion-event rows, Vault values, or any credential.
-- Contract digests are derived from the frozen actual 71-migration local replay
-- on PostgreSQL 17.6, never learned from the hosted database.
-- Frozen migration source SHA-256:
-- 20260930152825 a186bca6cfdecea14b696cc377c40fc3d2a83b13faeda7620369cd1949c81d02
-- 20260930160740 76e1f82f852592c8f88fe65476880bec9059e034bd80e52f83669ce0e54508e0
-- 20260930161218 01ff6fa1218766a5de3b246ab7abc0b030f5191c46cf150f23b322c71ec0db16
-- 20261001001245 7e295a3708a3c241b60917fb16db00f27a39aa327f19c557595a5cbab2396bfc
WITH canonical_deparse_context AS MATERIALIZED (
  SELECT pg_catalog.set_config('search_path','pg_catalog',true) AS pinned_search_path,
    pg_catalog.set_config('TimeZone','UTC',true) AS pinned_timezone,
    pg_catalog.set_config('DateStyle','ISO, YMD',true) AS pinned_datestyle,
    pg_catalog.set_config('statement_timeout','15000',true) AS pinned_timeout,
    pg_catalog.set_config('lock_timeout','5000',true) AS pinned_lock_timeout
), selected_functions(contract_name,schema_name,function_name) AS (VALUES
  ('functions','private','original_77_submission_evidence'),
  ('functions','private','original_77_progress_for_user'),
  ('functions','private','outbound_event_payload_is_safe'),
  ('functions','private','badge_rule_matches'),
  ('functions','private','persist_badge_event'),
  ('functions','private','record_live_original_77_completion'),
  ('functions','private','reject_original_77_completion_event_update'),
  ('functions','private','check_in_badge_facts'),
  ('functions','private','award_check_in_badges'),
  ('functions','public','challenge_activation_allows_date'),
  ('functions','public','challenge_activation_payload_for_user'),
  ('functions','public','reward_catalog_item_for_user'),
  ('functions','public','start_challenge'),
  ('functions','public','daily_standard_draft_payload'),
  ('functions','public','mutate_daily_standard_draft_pre_activation'),
  ('functions','public','set_daily_standard_workout_difficulty_pre_activation'),
  ('functions','public','submit_daily_check_in_pre_activation'),
  ('functions','public','submit_daily_check_in'),
  ('functions','public','process_check_in_game_rewards'),
  ('share','public','build_share_snapshot_payload'),
  ('share','public','preview_share_snapshot'),
  ('share','public','create_share_snapshot')
), function_documents AS MATERIALIZED (
  SELECT s.contract_name,CASE WHEN c.pinned_search_path='pg_catalog' AND c.pinned_timezone='UTC'
    AND c.pinned_datestyle='ISO, YMD' THEN pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'schema',s.schema_name,'name',s.function_name,'signature',p.oid::regprocedure::text,
    'definition',pg_catalog.pg_get_functiondef(p.oid),'owner',pg_catalog.pg_get_userbyid(p.proowner),
    'language',l.lanname,'kind',p.prokind,'securityDefiner',p.prosecdef,
    'volatility',p.provolatile,'returnsSet',p.proretset,'strict',p.proisstrict,
    'leakproof',p.proleakproof,'parallel',p.proparallel,'cost',p.procost,'rows',p.prorows,
    'config',p.proconfig,'arguments',pg_catalog.pg_get_function_arguments(p.oid),
    'result',pg_catalog.pg_get_function_result(p.oid),
    'acl',coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
      CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
      pg_catalog.pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable)
      ORDER BY (CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END) COLLATE "C",
      pg_catalog.pg_get_userbyid(a.grantor) COLLATE "C",a.privilege_type COLLATE "C",a.is_grantable)
      FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a),'[]'::jsonb),
    'effectiveExecute',pg_catalog.jsonb_build_array(
      pg_catalog.has_function_privilege('anon',p.oid,'EXECUTE'),
      pg_catalog.has_function_privilege('authenticated',p.oid,'EXECUTE'),
      pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE')))
    ORDER BY s.schema_name COLLATE "C",s.function_name COLLATE "C",p.oid::regprocedure::text COLLATE "C")
    ELSE NULL END AS document
  FROM selected_functions s LEFT JOIN pg_catalog.pg_namespace n ON n.nspname=s.schema_name
  LEFT JOIN pg_catalog.pg_proc p ON p.pronamespace=n.oid AND p.proname=s.function_name
  LEFT JOIN pg_catalog.pg_language l ON l.oid=p.prolang CROSS JOIN canonical_deparse_context c
  GROUP BY s.contract_name,c.pinned_search_path,c.pinned_timezone,c.pinned_datestyle
), ledger AS (
  SELECT * FROM pg_catalog.pg_class WHERE oid=pg_catalog.to_regclass('private.original_77_completion_events')
), contract_documents AS MATERIALIZED (
  SELECT 'functions' AS contract_name,document FROM function_documents WHERE contract_name='functions'
  UNION ALL SELECT 'triggers',CASE WHEN c.pinned_search_path='pg_catalog' AND c.pinned_timezone='UTC'
    AND c.pinned_datestyle='ISO, YMD' THEN (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'table',t.tgrelid::regclass::text,'name',t.tgname,'definition',pg_catalog.pg_get_triggerdef(t.oid),
      'function',t.tgfoid::regprocedure::text,'enabled',t.tgenabled,'type',t.tgtype,
      'deferrable',t.tgdeferrable,'initiallyDeferred',t.tginitdeferred)
      ORDER BY t.tgrelid::regclass::text COLLATE "C",t.tgname COLLATE "C")
      FROM pg_catalog.pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid IN (
        pg_catalog.to_regclass('public.check_ins'),pg_catalog.to_regclass('private.original_77_completion_events')))
    ELSE NULL END FROM canonical_deparse_context c
  UNION ALL SELECT 'check_ins',CASE WHEN c.pinned_search_path='pg_catalog' AND c.pinned_timezone='UTC'
    AND c.pinned_datestyle='ISO, YMD' THEN pg_catalog.jsonb_build_object(
      'constraints',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
        x.conname,x.contype,pg_catalog.pg_get_constraintdef(x.oid),x.convalidated,x.condeferrable,x.condeferred)
        ORDER BY x.conname COLLATE "C") FROM pg_catalog.pg_constraint x
        WHERE x.conrelid=pg_catalog.to_regclass('public.check_ins')),
      'indexes',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
        r.relname,pg_catalog.pg_get_indexdef(i.indexrelid),pg_catalog.pg_get_userbyid(r.relowner),
        i.indisvalid,i.indisready,i.indislive,i.indisunique,i.indisprimary)
        ORDER BY r.relname COLLATE "C") FROM pg_catalog.pg_index i
        JOIN pg_catalog.pg_class r ON r.oid=i.indexrelid WHERE i.indrelid=pg_catalog.to_regclass('public.check_ins')))
    ELSE NULL END FROM canonical_deparse_context c
  UNION ALL SELECT 'ledger',CASE WHEN c.pinned_search_path='pg_catalog' AND c.pinned_timezone='UTC'
    AND c.pinned_datestyle='ISO, YMD' THEN (SELECT pg_catalog.jsonb_build_object(
      'owner',pg_catalog.pg_get_userbyid(t.relowner),'kind',t.relkind,'persistence',t.relpersistence,
      'rls',t.relrowsecurity,'forceRls',t.relforcerowsecurity,
      'acl',coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
        CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
        pg_catalog.pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable)
        ORDER BY (CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END) COLLATE "C",
          pg_catalog.pg_get_userbyid(a.grantor) COLLATE "C",a.privilege_type COLLATE "C",a.is_grantable)
        FROM pg_catalog.aclexplode(coalesce(t.relacl,pg_catalog.acldefault('r',t.relowner))) a),'[]'::jsonb),
      'effectiveTablePrivileges',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(r.role_name,v.privilege,
        pg_catalog.has_table_privilege(r.role_name,t.oid,v.privilege)) ORDER BY r.role_name COLLATE "C",v.privilege COLLATE "C")
        FROM (VALUES ('anon'),('authenticated'),('service_role')) r(role_name)
        CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER'),('MAINTAIN')) v(privilege)),
      'columns',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'number',a.attnum,'name',a.attname,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),
        'required',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,
        'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid),
        'acl',coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
          CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END,
          pg_catalog.pg_get_userbyid(x.grantor),x.privilege_type,x.is_grantable)
          ORDER BY (CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END) COLLATE "C",
          pg_catalog.pg_get_userbyid(x.grantor) COLLATE "C",x.privilege_type COLLATE "C",x.is_grantable)
          FROM pg_catalog.aclexplode(a.attacl) x),'[]'::jsonb),
        'effectiveColumnPrivileges',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(r.role_name,v.privilege,
          pg_catalog.has_column_privilege(r.role_name,t.oid,a.attnum,v.privilege))
          ORDER BY r.role_name COLLATE "C",v.privilege COLLATE "C")
          FROM (VALUES ('anon'),('authenticated'),('service_role')) r(role_name)
          CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) v(privilege)))
        ORDER BY a.attnum) FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d
        ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped),
      'constraints',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
        x.conname,x.contype,pg_catalog.pg_get_constraintdef(x.oid),x.convalidated,x.condeferrable,x.condeferred)
        ORDER BY x.conname COLLATE "C") FROM pg_catalog.pg_constraint x WHERE x.conrelid=t.oid),
      'indexes',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
        r.relname,pg_catalog.pg_get_indexdef(i.indexrelid),pg_catalog.pg_get_userbyid(r.relowner),
        i.indisvalid,i.indisready,i.indislive,i.indisunique,i.indisprimary)
        ORDER BY r.relname COLLATE "C") FROM pg_catalog.pg_index i
        JOIN pg_catalog.pg_class r ON r.oid=i.indexrelid WHERE i.indrelid=t.oid),
      'policies',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(p.polname,p.polcmd,p.polpermissive,
        (SELECT pg_catalog.jsonb_agg(CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(r) END
          ORDER BY (CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(r) END) COLLATE "C") FROM pg_catalog.unnest(p.polroles) r),
        pg_catalog.pg_get_expr(p.polqual,p.polrelid),pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid))
        ORDER BY p.polname COLLATE "C") FROM pg_catalog.pg_policy p WHERE p.polrelid=t.oid)) FROM ledger t)
    ELSE NULL END FROM canonical_deparse_context c
  UNION ALL SELECT 'finisher', (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'badge_key',b.badge_key,'name',b.name,'description',b.description,'requirement',b.requirement,
    'category',b.category,'tier',b.tier,'tier_rank',b.tier_rank,'icon',b.icon,'sort_order',b.sort_order,
    'criteria_version',b.criteria_version,'source_event',b.source_event,'metric',b.metric,
    'threshold',b.threshold,'predicate',b.predicate,'scope',b.scope,'visibility',b.visibility,
    'show_progress',b.show_progress,'celebration',b.celebration,'retired',b.retired,'blocked',b.blocked)
    ORDER BY b.badge_key COLLATE "C") FROM public.badge_definitions b WHERE b.badge_key='original_77_completed')
  UNION ALL SELECT 'share',CASE WHEN c.pinned_search_path='pg_catalog' AND c.pinned_timezone='UTC'
    AND c.pinned_datestyle='ISO, YMD' THEN pg_catalog.jsonb_build_object(
      'functions',(SELECT document FROM function_documents WHERE contract_name='share'),
      'constraints',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
        x.conname,x.contype,pg_catalog.pg_get_constraintdef(x.oid),x.convalidated,x.condeferrable,x.condeferred)
        ORDER BY x.conname COLLATE "C") FROM pg_catalog.pg_constraint x
        WHERE x.conrelid=pg_catalog.to_regclass('public.public_share_snapshots')))
    ELSE NULL END FROM canonical_deparse_context c
), expected_contracts(contract_name,definition_hash) AS (VALUES
  ('functions','d2666694f6514ce2fe6393e5a7dc260e04e34c264b26f9de8fe853433d5d4846'),
  ('triggers','6fb77c60423d6774420446045e693fd82df788953ff15ea31451d0d08e3b64f6'),
  ('check_ins','cdad4cc8397b543c5c6512de7da7cf05c078155517cf82ebf581cfe65a7d1172'),
  ('ledger','4933283e722a83b96e6b739a837cb737098429cdadf5cb72192471532b094fdc'),
  ('finisher','b5d8655ecb6a8c87481e6312ecb6185cc0c50b8248e55d3a95380ee9a4b28e5a'),
  ('share','06d56fc169b6657a46f4538e18868413a1839144fc20c17dd131232f04143ce7')
), contract_checks AS (
  SELECT e.contract_name,coalesce(d.document IS NOT NULL AND
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(d.document::text,'UTF8')),'hex')=e.definition_hash,false) AS ok
  FROM expected_contracts e LEFT JOIN contract_documents d USING(contract_name)
)
SELECT
  coalesce((SELECT pg_catalog.count(*)=71 AND pg_catalog.count(DISTINCT version)=71
    AND pg_catalog.max(version::text)='20261001001245'
    AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.string_agg(version::text,',' ORDER BY version::text COLLATE "C"),'UTF8')),'hex')
      ='e6090c27e44dd678cab1b8178058f780bec2d0b4dcd99dee0d96407d24a5bb26'
    FROM supabase_migrations.schema_migrations),false)
    AND (SELECT pg_catalog.count(*)=4 FROM supabase_migrations.schema_migrations WHERE (version,name) IN (
      ('20260930152825','add_original_77_completion_evidence_foundation'),
      ('20260930160740','wire_original_77_live_completion'),
      ('20260930161218','share_submitted_progress_v2'),
      ('20261001001245','repeatable_challenge_instances_v2'))) AS exact_migration_history_ok,
  CASE WHEN c.pinned_search_path='pg_catalog' AND c.pinned_timezone='UTC' AND c.pinned_datestyle='ISO, YMD'
    AND c.pinned_timeout='15s' AND c.pinned_lock_timeout='5s'
    THEN pg_catalog.current_setting('transaction_read_only')='on' AND pg_catalog.current_setting('server_version_num')='170006'
    ELSE false END AS read_only_pinned_server_ok,
  coalesce((SELECT ok FROM contract_checks WHERE contract_name='functions'),false) AS original77_function_contracts_ok,
  coalesce((SELECT ok FROM contract_checks WHERE contract_name='triggers'),false) AS original77_trigger_contracts_ok,
  coalesce((SELECT ok FROM contract_checks WHERE contract_name='check_ins'),false) AS original77_check_in_constraints_ok,
  coalesce((SELECT ok FROM contract_checks WHERE contract_name='ledger'),false) AS original77_completion_ledger_ok,
  coalesce((SELECT ok FROM contract_checks WHERE contract_name='finisher'),false) AS original77_finisher_catalog_ok,
  coalesce((SELECT ok FROM contract_checks WHERE contract_name='share'),false) AS original77_share_contracts_ok
FROM canonical_deparse_context c;
