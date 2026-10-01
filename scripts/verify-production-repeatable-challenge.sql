-- Source-fixed repeatable-challenge release checkpoint. Catalog and public
-- configuration only: never calls an application RPC and never reads users,
-- sessions, check-ins, drafts, awards, instances, requests, preserved grants,
-- completion rows, Vault values, or credentials.
--
-- The source and catalog pins were derived from two identical fresh replays
-- from the reviewed exact-70 checkpoint on PostgreSQL 17.6. The JavaScript
-- wrapper refuses every network request if any pin is later missing or stale.
-- Frozen migration source SHA-256:
-- 20261001001245 0250b78791964615abcbe8066245df73ed98d78dbdb5a4e418d3bfbc7bec652b
-- Exact 71-version history SHA-256: e6090c27e44dd678cab1b8178058f780bec2d0b4dcd99dee0d96407d24a5bb26
WITH canonical_deparse_context AS MATERIALIZED (
  SELECT pg_catalog.set_config('search_path','pg_catalog',true) AS pinned_search_path,
    pg_catalog.set_config('TimeZone','UTC',true) AS pinned_timezone,
    pg_catalog.set_config('DateStyle','ISO, YMD',true) AS pinned_datestyle,
    pg_catalog.set_config('statement_timeout','15000',true) AS pinned_timeout,
    pg_catalog.set_config('lock_timeout','5000',true) AS pinned_lock_timeout
), selected_tables(contract_name,schema_name,table_name) AS (VALUES
  ('instance_tables','private','challenge_instances'),
  ('instance_tables','private','challenge_runtime'),
  ('instance_tables','private','challenge_instance_completions'),
  ('instance_tables','private','challenge_instance_requests'),
  ('instance_tables','private','reward_grant_preservation'),
  ('associations','public','check_ins'),
  ('associations','public','challenge_entries'),
  ('associations','public','user_challenge_states'),
  ('catalog_tables','public','reward_definitions'),
  ('catalog_tables','public','reward_catalog_meta'),
  ('catalog_tables','public','challenge_definitions'),
  ('share_table','public','public_share_snapshots')
), selected_table_oids AS MATERIALIZED (
  SELECT s.contract_name,s.schema_name,s.table_name,t.oid,c.pinned_search_path
  FROM selected_tables s
  LEFT JOIN pg_catalog.pg_namespace n ON n.nspname=s.schema_name
  LEFT JOIN pg_catalog.pg_class t ON t.relnamespace=n.oid AND t.relname=s.table_name
  CROSS JOIN canonical_deparse_context c
), table_documents AS MATERIALIZED (
  SELECT s.contract_name,pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'schema',s.schema_name,'name',s.table_name,'exists',s.oid IS NOT NULL,
    'owner',pg_catalog.pg_get_userbyid(t.relowner),'kind',t.relkind,
    'persistence',t.relpersistence,'rowSecurity',t.relrowsecurity,'forceRowSecurity',t.relforcerowsecurity,
    'acl',coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
      CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
      pg_catalog.pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable)
      ORDER BY (CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END) COLLATE "C",
        pg_catalog.pg_get_userbyid(a.grantor) COLLATE "C",a.privilege_type COLLATE "C",a.is_grantable)
      FROM pg_catalog.aclexplode(coalesce(t.relacl,pg_catalog.acldefault('r',t.relowner))) a),'[]'::jsonb),
    'effectiveTablePrivileges',coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
      r.role_name,v.privilege,pg_catalog.has_table_privilege(r.role_name,t.oid,v.privilege))
      ORDER BY r.role_name COLLATE "C",v.privilege COLLATE "C")
      FROM (VALUES ('anon'),('authenticated'),('service_role')) r(role_name)
      CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER'),('MAINTAIN')) v(privilege)
      WHERE t.oid IS NOT NULL),'[]'::jsonb),
    'columns',coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'number',a.attnum,'name',a.attname,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),
      'required',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,
      'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid),
      'acl',coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
        CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END,
        pg_catalog.pg_get_userbyid(x.grantor),x.privilege_type,x.is_grantable)
        ORDER BY (CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END) COLLATE "C",
          pg_catalog.pg_get_userbyid(x.grantor) COLLATE "C",x.privilege_type COLLATE "C",x.is_grantable)
        FROM pg_catalog.aclexplode(a.attacl) x),'[]'::jsonb),
      'effectiveColumnPrivileges',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
        r.role_name,v.privilege,pg_catalog.has_column_privilege(r.role_name,t.oid,a.attnum,v.privilege))
        ORDER BY r.role_name COLLATE "C",v.privilege COLLATE "C")
        FROM (VALUES ('anon'),('authenticated'),('service_role')) r(role_name)
        CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) v(privilege)))
      ORDER BY a.attnum) FROM pg_catalog.pg_attribute a
      LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped),'[]'::jsonb),
    'constraints',coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
      x.conname,x.contype,pg_catalog.pg_get_constraintdef(x.oid),x.convalidated,x.condeferrable,x.condeferred)
      ORDER BY x.conname COLLATE "C") FROM pg_catalog.pg_constraint x WHERE x.conrelid=t.oid),'[]'::jsonb),
    'indexes',coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
      r.relname,pg_catalog.pg_get_indexdef(i.indexrelid),pg_catalog.pg_get_userbyid(r.relowner),
      i.indisvalid,i.indisready,i.indislive,i.indisunique,i.indisprimary)
      ORDER BY r.relname COLLATE "C") FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class r ON r.oid=i.indexrelid WHERE i.indrelid=t.oid),'[]'::jsonb),
    'policies',coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
      p.polname,p.polcmd,p.polpermissive,
      (SELECT pg_catalog.jsonb_agg(CASE WHEN role_oid=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(role_oid) END
        ORDER BY (CASE WHEN role_oid=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(role_oid) END) COLLATE "C")
        FROM pg_catalog.unnest(p.polroles) role_oid),
      pg_catalog.pg_get_expr(p.polqual,p.polrelid),pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid))
      ORDER BY p.polname COLLATE "C") FROM pg_catalog.pg_policy p WHERE p.polrelid=t.oid),'[]'::jsonb)
  ) ORDER BY s.schema_name COLLATE "C",s.table_name COLLATE "C") AS document
  FROM selected_table_oids s LEFT JOIN pg_catalog.pg_class t ON t.oid=s.oid
  GROUP BY s.contract_name
), selected_function_oids AS MATERIALIZED (
  SELECT CASE WHEN p.proname IN ('build_share_snapshot_payload','get_public_share_snapshot',
      'preview_share_snapshot','create_share_snapshot','preview_share_snapshot_v2','create_share_snapshot_v2')
      OR (n.nspname='private' AND p.proname='instance_share_payload') THEN 'share_functions' ELSE 'functions' END AS contract_name,
    n.nspname AS schema_name,p.proname AS function_name,p.oid,c.pinned_search_path
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
  CROSS JOIN canonical_deparse_context c
  WHERE n.nspname IN ('private','public') AND p.prokind='f' AND (
    p.proname LIKE '%\_v2' ESCAPE '\'
    OR CASE WHEN p.prokind='f' THEN pg_catalog.pg_get_functiondef(p.oid) LIKE '%challenge_instances%' ELSE false END
    OR CASE WHEN p.prokind='f' THEN pg_catalog.pg_get_functiondef(p.oid) LIKE '%challenge_runtime%' ELSE false END
    OR p.proname IN (
      'audit_reward_definition_change','reject_instance_completion_update','assert_instance_actor',
      'bind_original_challenge_instance','bind_initial_instance_after_activation',
      'reward_eligible_points','challenge_definition_completed','reward_requirement_met',
      'lock_challenge_instance_actor','require_instance_membership','require_current_instance',
      'require_instance_daily_date','grant_reward_entitlement','reconcile_user_reward_entitlements',
      'reconcile_user_challenge_unlocks','sync_reward_definition_entitlements',
      'backfill_reward_entitlements','get_badge_collection',
      'apply_authoritative_daily_standard_draft','process_check_in_game_rewards','badge_rule_matches',
      'record_live_original_77_completion','check_in_badge_facts','daily_standard_user_date',
      'mutate_daily_standard_draft','set_daily_standard_workout_difficulty','submit_daily_check_in',
      'set_challenge_start_date','start_challenge','build_share_snapshot_payload','get_public_share_snapshot',
      'preview_share_snapshot','create_share_snapshot'))
), function_documents AS MATERIALIZED (
  SELECT s.contract_name,pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'schema',s.schema_name,'name',s.function_name,'signature',s.oid::regprocedure::text,
    'definition',pg_catalog.pg_get_functiondef(s.oid),'owner',pg_catalog.pg_get_userbyid(p.proowner),
    'language',l.lanname,'kind',p.prokind,'securityDefiner',p.prosecdef,'volatility',p.provolatile,
    'returnsSet',p.proretset,'strict',p.proisstrict,'leakproof',p.proleakproof,'parallel',p.proparallel,
    'cost',p.procost,'rows',p.prorows,'config',p.proconfig,
    'arguments',pg_catalog.pg_get_function_arguments(s.oid),'result',pg_catalog.pg_get_function_result(s.oid),
    'acl',coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
      CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
      pg_catalog.pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable)
      ORDER BY (CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END) COLLATE "C",
        pg_catalog.pg_get_userbyid(a.grantor) COLLATE "C",a.privilege_type COLLATE "C",a.is_grantable)
      FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a),'[]'::jsonb),
    'effectiveExecute',pg_catalog.jsonb_build_array(
      pg_catalog.has_function_privilege('anon',s.oid,'EXECUTE'),
      pg_catalog.has_function_privilege('authenticated',s.oid,'EXECUTE'),
      pg_catalog.has_function_privilege('service_role',s.oid,'EXECUTE'))
  ) ORDER BY s.schema_name COLLATE "C",s.function_name COLLATE "C",s.oid::regprocedure::text COLLATE "C") AS document
  FROM selected_function_oids s JOIN pg_catalog.pg_proc p ON p.oid=s.oid
  JOIN pg_catalog.pg_language l ON l.oid=p.prolang GROUP BY s.contract_name
), trigger_document AS MATERIALIZED (
  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'table',t.tgrelid::regclass::text,'name',t.tgname,'definition',pg_catalog.pg_get_triggerdef(t.oid),
    'function',t.tgfoid::regprocedure::text,'enabled',t.tgenabled,'type',t.tgtype,
    'deferrable',t.tgdeferrable,'initiallyDeferred',t.tginitdeferred)
    ORDER BY t.tgrelid::regclass::text COLLATE "C",t.tgname COLLATE "C") AS document
  FROM pg_catalog.pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid IN (
    SELECT oid FROM selected_table_oids WHERE oid IS NOT NULL
    UNION ALL SELECT pg_catalog.to_regclass('public.profiles'))
), catalog_document AS MATERIALIZED (
  SELECT pg_catalog.jsonb_build_object(
    'rewardDefinitions',coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'rewardKey',d.reward_key,'rewardType',d.reward_type,'stateModel',d.state_model,
      'title',d.title,'description',d.description,'pointsRequired',d.points_required,
      'fulfillmentKey',d.fulfillment_key,'challengeKey',d.challenge_key,
      'requiredEntitlementKey',d.required_entitlement_key,'icon',d.icon,'sortOrder',d.sort_order,
      'active',d.is_active,'displayMetadata',d.display_metadata,'unlockRuleType',d.unlock_rule_type,
      'prerequisiteChallengeKey',d.prerequisite_challenge_key,'phase',d.phase,'released',d.released)
      ORDER BY d.sort_order,d.reward_key COLLATE "C")
      FROM public.reward_definitions d),'[]'::jsonb),
    'challengeDefinitions',coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'challengeKey',d.challenge_key,'title',d.title,'teaser',d.teaser,'challengeType',d.challenge_type,
      'pointsRequired',d.points_required,'durationDays',d.duration_days,'entitlementKey',d.entitlement_key,
      'icon',d.icon,'sortOrder',d.sort_order,'active',d.is_active,'metadata',d.metadata)
      ORDER BY d.sort_order,d.challenge_key COLLATE "C")
      FROM public.challenge_definitions d),'[]'::jsonb),
    'rewardCatalogMeta',coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'catalogKey',m.catalog_key,'catalogVersion',m.catalog_version,
      'effectiveAtFinite',pg_catalog.isfinite(m.effective_at)) ORDER BY m.catalog_key COLLATE "C")
      FROM public.reward_catalog_meta m),'[]'::jsonb),
    'finisherDefinition',coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'badgeKey',b.badge_key,'name',b.name,'description',b.description,'requirement',b.requirement,
      'category',b.category,'tier',b.tier,'tierRank',b.tier_rank,'icon',b.icon,'sortOrder',b.sort_order,
      'criteriaVersion',b.criteria_version,'sourceEvent',b.source_event,'metric',b.metric,
      'threshold',b.threshold,'predicate',b.predicate,'scope',b.scope,'visibility',b.visibility,
      'showProgress',b.show_progress,'celebration',b.celebration,'retired',b.retired,'blocked',b.blocked)
      ORDER BY b.badge_key COLLATE "C")
      FROM public.badge_definitions b WHERE b.badge_key='original_77_completed'),'[]'::jsonb),
    'instanceBadgeDefinitions',coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'badgeKey',b.badge_key,'name',b.name,'description',b.description,'requirement',b.requirement,
      'category',b.category,'tier',b.tier,'tierRank',b.tier_rank,'icon',b.icon,'sortOrder',b.sort_order,
      'criteriaVersion',b.criteria_version,'sourceEvent',b.source_event,'metric',b.metric,
      'threshold',b.threshold,'predicate',b.predicate,'scope',b.scope,'visibility',b.visibility,
      'showProgress',b.show_progress,'celebration',b.celebration,'retired',b.retired,'blocked',b.blocked)
      ORDER BY b.badge_key COLLATE "C")
      FROM public.badge_definitions b WHERE b.badge_key IN (
        'streak_flame','seven_sealed','full_streak_14','full_streak_28','full_streak_56','full_streak_70',
        'check_ins_7','check_ins_14','check_ins_21','check_ins_26','check_ins_39','check_ins_50','check_ins_60','check_ins_70')),'[]'::jsonb)
  ) AS document FROM canonical_deparse_context
), security_document AS MATERIALIZED (
  SELECT pg_catalog.jsonb_build_object(
    'privateTables',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'name',s.table_name,'rowSecurity',t.relrowsecurity,'forceRowSecurity',t.relforcerowsecurity,
      'effectiveTablePrivileges',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
        r.role_name,v.privilege,pg_catalog.has_table_privilege(r.role_name,t.oid,v.privilege))
        ORDER BY r.role_name COLLATE "C",v.privilege COLLATE "C")
        FROM (VALUES ('anon'),('authenticated'),('service_role')) r(role_name)
        CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER'),('MAINTAIN')) v(privilege)))
      ORDER BY s.table_name COLLATE "C") FROM selected_table_oids s JOIN pg_catalog.pg_class t ON t.oid=s.oid
      WHERE s.schema_name='private'),
    'functions',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'signature',s.oid::regprocedure::text,
      'anon',pg_catalog.has_function_privilege('anon',s.oid,'EXECUTE'),
      'authenticated',pg_catalog.has_function_privilege('authenticated',s.oid,'EXECUTE'),
      'serviceRole',pg_catalog.has_function_privilege('service_role',s.oid,'EXECUTE'))
      ORDER BY s.oid::regprocedure::text COLLATE "C") FROM selected_function_oids s)
  ) AS document
), contract_documents AS MATERIALIZED (
  SELECT contract_name,document FROM table_documents WHERE contract_name IN ('instance_tables','associations','catalog_tables')
  UNION ALL SELECT 'functions',document FROM function_documents WHERE contract_name='functions'
  UNION ALL SELECT 'triggers',document FROM trigger_document
  UNION ALL SELECT 'catalog',document FROM catalog_document
  UNION ALL SELECT 'security',document FROM security_document
  UNION ALL SELECT 'share',pg_catalog.jsonb_build_object(
    'table',(SELECT document FROM table_documents WHERE contract_name='share_table'),
    'functions',(SELECT document FROM function_documents WHERE contract_name='share_functions'))
), expected_contracts(contract_name,definition_hash) AS (VALUES
  ('instance_tables','26b0b1e21c8afcb199b5371ac777400c1d4f3a179c8c5370df2358282aec7ad2'),
  ('associations','74de3994cd32bedc16739fcda79e1352391f7e525674b573b184caa273413b29'),
  ('catalog_tables','f0ec8a89808406703d38d65bf484d578b07e8f5d7ce1e7362a9daa60ebf7105e'),
  ('functions','2ec976c9180de305690d254f3e8801ad7b3a825376f5db8d245b2ccfbf90957a'),
  ('triggers','43de2ac1520532e3b590e93f565e2a1280ba7f61339625f78b5087fca00668b0'),
  ('catalog','fa75d7f6e94ba1f8cc98657c814fd89dc8b76b31256e5f0962e516e84bc39bbd'),
  ('security','2c07b9113bb3e3e0462ef381a29f8d0778fa0236bf1c4fea028a72f9aa19bc2e'),
  ('share','ca6ed6796c7630d644c5d25db94d53e652b281fafb7d6366011f9e991253a401')
), expected_history(definition_hash) AS (VALUES
  ('e6090c27e44dd678cab1b8178058f780bec2d0b4dcd99dee0d96407d24a5bb26')
), contract_checks AS (
  SELECT e.contract_name,coalesce(d.document IS NOT NULL AND
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(d.document::text,'UTF8')),'hex')=e.definition_hash,false) AS ok
  FROM expected_contracts e LEFT JOIN contract_documents d USING(contract_name)
)
SELECT
  coalesce((SELECT pg_catalog.count(*)=71 AND pg_catalog.count(DISTINCT version)=71
    AND pg_catalog.max(version::text)='20261001001245'
    AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.string_agg(version::text,',' ORDER BY version::text COLLATE "C"),'UTF8')),'hex')
        =(SELECT definition_hash FROM expected_history)
    FROM supabase_migrations.schema_migrations),false)
    AND (SELECT pg_catalog.count(*)=1 FROM supabase_migrations.schema_migrations
      WHERE version='20261001001245' AND name='repeatable_challenge_instances_v2') AS exact_migration_history_ok,
  CASE WHEN c.pinned_search_path='pg_catalog' AND c.pinned_timezone='UTC' AND c.pinned_datestyle='ISO, YMD'
    AND c.pinned_timeout='15s' AND c.pinned_lock_timeout='5s'
    THEN pg_catalog.current_setting('transaction_read_only')='on'
      AND pg_catalog.current_setting('server_version_num')='170006' ELSE false END AS read_only_pinned_server_ok,
  coalesce((SELECT ok FROM contract_checks WHERE contract_name='instance_tables'),false) AS repeatable_instance_tables_ok,
  coalesce((SELECT ok FROM contract_checks WHERE contract_name='associations'),false) AS repeatable_association_contracts_ok,
  coalesce((SELECT ok FROM contract_checks WHERE contract_name='catalog_tables'),false) AS repeatable_catalog_tables_ok,
  coalesce((SELECT ok FROM contract_checks WHERE contract_name='functions'),false) AS repeatable_function_contracts_ok,
  coalesce((SELECT ok FROM contract_checks WHERE contract_name='triggers'),false) AS repeatable_trigger_contracts_ok,
  coalesce(pg_catalog.to_regprocedure('private.bind_original_challenge_instance(uuid,boolean)') IS NOT NULL
    AND pg_catalog.to_regprocedure('private.bind_initial_instance_after_activation()') IS NOT NULL
    AND (SELECT pg_catalog.count(*)=1 FROM pg_catalog.pg_trigger t
      WHERE NOT t.tgisinternal AND t.tgname='z_bind_initial_instance_after_activation'
        AND t.tgrelid=pg_catalog.to_regclass('public.profiles')
        AND t.tgfoid=pg_catalog.to_regprocedure('private.bind_initial_instance_after_activation()')
        AND t.tgenabled='O'),false) AS repeatable_initializer_binding_ok,
  coalesce((SELECT ok FROM contract_checks WHERE contract_name='catalog'),false) AS repeatable_reward_catalog_ok,
  coalesce((SELECT ok FROM contract_checks WHERE contract_name='security'),false) AS repeatable_security_boundaries_ok,
  coalesce((SELECT ok FROM contract_checks WHERE contract_name='share'),false) AS repeatable_share_contracts_ok
FROM canonical_deparse_context c;
