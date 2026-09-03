-- This query is intentionally a single read-only SELECT. The expected
-- migration-13 contract is supplied as $1 JSONB by the verifier. Production
-- rows are compared inside Postgres and only aggregate mismatch counts leave
-- the database.
with
canonical_deparse_context as materialized (
  select pg_catalog.set_config(
    'search_path',
    'public, extensions',
    true
  ) as pinned_search_path
),
expected_source as materialized (
  select contract_record.value as record
  from pg_catalog.jsonb_array_elements($1::jsonb) contract_record(value)
),
expected_records as materialized (
  select
    expected_source.record ->> 'key' as key,
    expected_source.record
  from expected_source
),
schema_records as (
  select
    pg_catalog.format('schema/%I', namespace.nspname) as key,
    'schema'::text as kind,
    namespace.nspname as identity,
    pg_catalog.jsonb_build_object(
      'owner', pg_catalog.pg_get_userbyid(namespace.nspowner)
    ) as definition
  from pg_catalog.pg_namespace namespace
  where namespace.nspname = 'public'
),
extension_records as (
  select
    pg_catalog.format('extension/%I', extension_value.extname) as key,
    'extension'::text as kind,
    extension_value.extname as identity,
    pg_catalog.jsonb_build_object(
      'schema', namespace.nspname,
      'version', extension_value.extversion,
      'relocatable', extension_value.extrelocatable
    ) as definition
  from pg_catalog.pg_extension extension_value
  join pg_catalog.pg_namespace namespace
    on namespace.oid = extension_value.extnamespace
  where extension_value.extname = 'pgcrypto'
),
scoped_relations as materialized (
  select relation.*, namespace.nspname as schema_name
  from pg_catalog.pg_class relation
  join pg_catalog.pg_namespace namespace
    on namespace.oid = relation.relnamespace
  where namespace.nspname = 'public'
    and relation.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
),
relation_records as (
  select
    pg_catalog.format('relation/%I.%I', relation.schema_name, relation.relname) as key,
    'relation'::text as kind,
    pg_catalog.format('%I.%I', relation.schema_name, relation.relname) as identity,
    pg_catalog.jsonb_build_object(
      'owner', pg_catalog.pg_get_userbyid(relation.relowner),
      'relationKind', relation.relkind,
      'persistence', relation.relpersistence,
      'rowSecurity', relation.relrowsecurity,
      'forceRowSecurity', relation.relforcerowsecurity,
      'replicaIdentity', relation.relreplident,
      'options', coalesce(pg_catalog.to_jsonb(relation.reloptions), '[]'::jsonb),
      'columns', '[]'::jsonb,
      'constraints', '[]'::jsonb,
      'indexes', '[]'::jsonb
    ) as definition
  from scoped_relations relation
),
scoped_columns as materialized (
  select
    namespace.nspname as schema_name,
    relation.relname as relation_name,
    relation.relkind,
    column_value.*,
    default_value.adbin,
    default_value.adrelid,
    collation_value.collname as collation_name,
    collation_namespace.nspname as collation_schema,
    canonical_deparse_context.pinned_search_path
  from pg_catalog.pg_attribute column_value
  join pg_catalog.pg_class relation on relation.oid = column_value.attrelid
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  left join pg_catalog.pg_attrdef default_value
    on default_value.adrelid = column_value.attrelid
   and default_value.adnum = column_value.attnum
  left join pg_catalog.pg_collation collation_value
    on collation_value.oid = column_value.attcollation
  left join pg_catalog.pg_namespace collation_namespace
    on collation_namespace.oid = collation_value.collnamespace
  cross join canonical_deparse_context
  where namespace.nspname = 'public'
    and relation.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
    and column_value.attnum > 0
    and not column_value.attisdropped
),
column_records as (
  select
    pg_catalog.format(
      'column/%I.%I/%I',
      column_value.schema_name,
      column_value.relation_name,
      column_value.attname
    ) as key,
    'column'::text as kind,
    pg_catalog.format(
      '%I.%I.%I',
      column_value.schema_name,
      column_value.relation_name,
      column_value.attname
    ) as identity,
    pg_catalog.jsonb_build_object(
      'position', column_value.attnum,
      'type', case
        when column_value.pinned_search_path = 'public, extensions'
          then pg_catalog.format_type(column_value.atttypid, column_value.atttypmod)
        else null
      end,
      'notNull', column_value.attnotnull,
      'identity', column_value.attidentity,
      'generated', column_value.attgenerated,
      'storage', column_value.attstorage,
      'compression', column_value.attcompression,
      'statisticsTarget', column_value.attstattarget,
      'collation', case
        when column_value.collation_name is null then null
        else pg_catalog.format(
          '%I.%I',
          column_value.collation_schema,
          column_value.collation_name
        )
      end,
      'default', case
        when column_value.adbin is null then null
        when column_value.pinned_search_path = 'public, extensions' then
          pg_catalog.pg_get_expr(
            column_value.adbin,
            column_value.adrelid,
            false
          )
        else null
      end
    ) as definition
  from scoped_columns column_value
),
constraint_records as (
  select
    pg_catalog.format(
      'constraint/%I.%I/%I',
      namespace.nspname,
      relation.relname,
      constraint_value.conname
    ) as key,
    'constraint'::text as kind,
    pg_catalog.format(
      '%I.%I.%I',
      namespace.nspname,
      relation.relname,
      constraint_value.conname
    ) as identity,
    pg_catalog.jsonb_build_object(
      'type', constraint_value.contype,
      'definition', case
        when canonical_deparse_context.pinned_search_path = 'public, extensions'
          then pg_catalog.pg_get_constraintdef(constraint_value.oid, false)
        else null
      end,
      'deferrable', constraint_value.condeferrable,
      'deferred', constraint_value.condeferred,
      'validated', constraint_value.convalidated,
      'noInherit', constraint_value.connoinherit
    ) as definition
  from pg_catalog.pg_constraint constraint_value
  join pg_catalog.pg_class relation on relation.oid = constraint_value.conrelid
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  cross join canonical_deparse_context
  where namespace.nspname = 'public'
),
index_records as (
  select
    pg_catalog.format('index/%I.%I', namespace.nspname, index_relation.relname) as key,
    'index'::text as kind,
    pg_catalog.format('%I.%I', namespace.nspname, index_relation.relname) as identity,
    pg_catalog.jsonb_build_object(
      'table', pg_catalog.format('%I.%I', namespace.nspname, table_relation.relname),
      'owner', pg_catalog.pg_get_userbyid(index_relation.relowner),
      'definition', case
        when canonical_deparse_context.pinned_search_path = 'public, extensions'
          then pg_catalog.pg_get_indexdef(index_relation.oid, 0, false)
        else null
      end,
      'unique', index_value.indisunique,
      'primary', index_value.indisprimary,
      'exclusion', index_value.indisexclusion,
      'immediate', index_value.indimmediate,
      'clustered', index_value.indisclustered,
      'valid', index_value.indisvalid,
      'ready', index_value.indisready,
      'live', index_value.indislive,
      'replicaIdentity', index_value.indisreplident
    ) as definition
  from pg_catalog.pg_index index_value
  join pg_catalog.pg_class index_relation on index_relation.oid = index_value.indexrelid
  join pg_catalog.pg_class table_relation on table_relation.oid = index_value.indrelid
  join pg_catalog.pg_namespace namespace on namespace.oid = table_relation.relnamespace
  cross join canonical_deparse_context
  where namespace.nspname = 'public'
),
scoped_functions as materialized (
  select
    procedure_value.*,
    namespace.nspname as schema_name,
    language.lanname as language_name,
    canonical_deparse_context.pinned_search_path
  from pg_catalog.pg_proc procedure_value
  join pg_catalog.pg_namespace namespace
    on namespace.oid = procedure_value.pronamespace
  join pg_catalog.pg_language language
    on language.oid = procedure_value.prolang
  cross join canonical_deparse_context
  where namespace.nspname = 'public'
    and not (
      procedure_value.proname = 'rls_auto_enable'
      and case
        when canonical_deparse_context.pinned_search_path = 'public, extensions'
          then pg_catalog.pg_get_function_identity_arguments(procedure_value.oid)
        else null
      end = ''
    )
),
function_records as (
  select
    pg_catalog.format(
      'function/%I.%I(%s)',
      function_value.schema_name,
      function_value.proname,
      case
        when function_value.pinned_search_path = 'public, extensions'
          then pg_catalog.pg_get_function_identity_arguments(function_value.oid)
        else null
      end
    ) as key,
    'function'::text as kind,
    pg_catalog.format(
      '%I.%I(%s)',
      function_value.schema_name,
      function_value.proname,
      case
        when function_value.pinned_search_path = 'public, extensions'
          then pg_catalog.pg_get_function_identity_arguments(function_value.oid)
        else null
      end
    ) as identity,
    pg_catalog.jsonb_build_object(
      'owner', pg_catalog.pg_get_userbyid(function_value.proowner),
      'arguments', case
        when function_value.pinned_search_path = 'public, extensions'
          then pg_catalog.pg_get_function_arguments(function_value.oid)
        else null
      end,
      'result', case
        when function_value.pinned_search_path = 'public, extensions'
          then pg_catalog.pg_get_function_result(function_value.oid)
        else null
      end,
      'language', function_value.language_name,
      'kind', function_value.prokind,
      'volatility', function_value.provolatile,
      'parallel', function_value.proparallel,
      'securityDefiner', function_value.prosecdef,
      'strict', function_value.proisstrict,
      'leakproof', function_value.proleakproof,
      'returnsSet', function_value.proretset,
      'configuration', coalesce(
        pg_catalog.to_jsonb(function_value.proconfig),
        '[]'::jsonb
      ),
      'binary', coalesce(function_value.probin, ''),
      'bodyBase64', pg_catalog.encode(
        pg_catalog.convert_to(function_value.prosrc, 'UTF8'),
        'base64'
      )
    ) as definition
  from scoped_functions function_value
),
trigger_records as (
  select
    pg_catalog.format(
      'trigger/%I.%I/%I',
      namespace.nspname,
      relation.relname,
      trigger_value.tgname
    ) as key,
    'trigger'::text as kind,
    pg_catalog.format(
      '%I.%I.%I',
      namespace.nspname,
      relation.relname,
      trigger_value.tgname
    ) as identity,
    pg_catalog.jsonb_build_object(
      'enabled', trigger_value.tgenabled,
      'definition', case
        when canonical_deparse_context.pinned_search_path = 'public, extensions'
          then pg_catalog.pg_get_triggerdef(trigger_value.oid, false)
        else null
      end,
      'function', pg_catalog.format(
        '%I.%I(%s)',
        function_namespace.nspname,
        function_value.proname,
        case
          when canonical_deparse_context.pinned_search_path = 'public, extensions'
            then pg_catalog.pg_get_function_identity_arguments(function_value.oid)
          else null
        end
      )
    ) as definition
  from pg_catalog.pg_trigger trigger_value
  join pg_catalog.pg_class relation on relation.oid = trigger_value.tgrelid
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  join pg_catalog.pg_proc function_value on function_value.oid = trigger_value.tgfoid
  join pg_catalog.pg_namespace function_namespace
    on function_namespace.oid = function_value.pronamespace
  cross join canonical_deparse_context
  where not trigger_value.tgisinternal
    and namespace.nspname = 'public'
),
policy_records as (
  select
    pg_catalog.format(
      'policy/%I.%I/%I',
      namespace.nspname,
      relation.relname,
      policy_value.polname
    ) as key,
    'policy'::text as kind,
    pg_catalog.format(
      '%I.%I.%I',
      namespace.nspname,
      relation.relname,
      policy_value.polname
    ) as identity,
    pg_catalog.jsonb_build_object(
      'permissive', policy_value.polpermissive,
      'command', policy_value.polcmd,
      'roles', (
        select pg_catalog.jsonb_agg(
          case
            when role_oid = 0 then 'PUBLIC'
            else pg_catalog.pg_get_userbyid(role_oid)
          end
          order by case
            when role_oid = 0 then 'PUBLIC'
            else pg_catalog.pg_get_userbyid(role_oid)
          end
        )
        from pg_catalog.unnest(policy_value.polroles) role_oid
      ),
      'using', case
        when policy_value.polqual is null then null
        when canonical_deparse_context.pinned_search_path = 'public, extensions'
          then pg_catalog.pg_get_expr(
            policy_value.polqual,
            policy_value.polrelid,
            false
          )
        else null
      end,
      'withCheck', case
        when policy_value.polwithcheck is null then null
        when canonical_deparse_context.pinned_search_path = 'public, extensions' then
          pg_catalog.pg_get_expr(
            policy_value.polwithcheck,
            policy_value.polrelid,
            false
          )
        else null
      end
    ) as definition
  from pg_catalog.pg_policy policy_value
  join pg_catalog.pg_class relation on relation.oid = policy_value.polrelid
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  cross join canonical_deparse_context
  where namespace.nspname = 'public'
     or (namespace.nspname = 'storage' and relation.relname = 'objects')
),
object_acl_sources as materialized (
  select
    'schema-acl'::text as object_kind,
    pg_catalog.format('%I', namespace.nspname) as identity,
    namespace.nspacl as acl
  from pg_catalog.pg_namespace namespace
  where namespace.nspname = 'public'

  union all

  select
    'relation-acl'::text,
    pg_catalog.format('%I.%I', namespace.nspname, relation.relname),
    relation.relacl
  from pg_catalog.pg_class relation
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = 'public'
    and relation.relkind in ('r', 'p', 'v', 'm', 'S', 'f')

  union all

  select
    'function-acl'::text,
    pg_catalog.format(
      '%I.%I(%s)',
      namespace.nspname,
      procedure_value.proname,
      case
        when canonical_deparse_context.pinned_search_path = 'public, extensions'
          then pg_catalog.pg_get_function_identity_arguments(procedure_value.oid)
        else null
      end
    ),
    procedure_value.proacl
  from pg_catalog.pg_proc procedure_value
  join pg_catalog.pg_namespace namespace
    on namespace.oid = procedure_value.pronamespace
  cross join canonical_deparse_context
  where namespace.nspname = 'public'
    and not (
      procedure_value.proname = 'rls_auto_enable'
      and case
        when canonical_deparse_context.pinned_search_path = 'public, extensions'
          then pg_catalog.pg_get_function_identity_arguments(procedure_value.oid)
        else null
      end = ''
    )
),
direct_object_acl_records as (
  select
    pg_catalog.format(
      'direct-acl/%s/%s/%s/%s/%s',
      object_acl.object_kind,
      object_acl.identity,
      case
        when acl_value.grantor = 0 then 'PUBLIC'
        else pg_catalog.pg_get_userbyid(acl_value.grantor)
      end,
      case
        when acl_value.grantee = 0 then 'PUBLIC'
        else pg_catalog.pg_get_userbyid(acl_value.grantee)
      end,
      acl_value.privilege_type
    ) as key,
    'direct-acl'::text as kind,
    object_acl.identity,
    pg_catalog.jsonb_build_object(
      'objectKind', object_acl.object_kind,
      'grantor', case
        when acl_value.grantor = 0 then 'PUBLIC'
        else pg_catalog.pg_get_userbyid(acl_value.grantor)
      end,
      'grantee', case
        when acl_value.grantee = 0 then 'PUBLIC'
        else pg_catalog.pg_get_userbyid(acl_value.grantee)
      end,
      'privilege', acl_value.privilege_type,
      'grantable', acl_value.is_grantable
    ) as definition
  from object_acl_sources object_acl
  cross join lateral pg_catalog.aclexplode(object_acl.acl) acl_value
),
direct_column_acl_records as (
  select
    pg_catalog.format(
      'direct-acl/column-acl/%I.%I.%I/%s/%s/%s',
      namespace.nspname,
      relation.relname,
      column_value.attname,
      case
        when acl_value.grantor = 0 then 'PUBLIC'
        else pg_catalog.pg_get_userbyid(acl_value.grantor)
      end,
      case
        when acl_value.grantee = 0 then 'PUBLIC'
        else pg_catalog.pg_get_userbyid(acl_value.grantee)
      end,
      acl_value.privilege_type
    ) as key,
    'direct-acl'::text as kind,
    pg_catalog.format(
      '%I.%I.%I',
      namespace.nspname,
      relation.relname,
      column_value.attname
    ) as identity,
    pg_catalog.jsonb_build_object(
      'objectKind', 'column-acl',
      'grantor', case
        when acl_value.grantor = 0 then 'PUBLIC'
        else pg_catalog.pg_get_userbyid(acl_value.grantor)
      end,
      'grantee', case
        when acl_value.grantee = 0 then 'PUBLIC'
        else pg_catalog.pg_get_userbyid(acl_value.grantee)
      end,
      'privilege', acl_value.privilege_type,
      'grantable', acl_value.is_grantable
    ) as definition
  from pg_catalog.pg_attribute column_value
  join pg_catalog.pg_class relation on relation.oid = column_value.attrelid
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  cross join lateral pg_catalog.aclexplode(column_value.attacl) acl_value
  where namespace.nspname = 'public'
    and relation.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
    and column_value.attnum > 0
    and not column_value.attisdropped
),
api_roles as materialized (
  select role_value.rolname as role_name
  from pg_catalog.pg_roles role_value
  where role_value.rolname in ('anon', 'authenticated', 'service_role')
),
relation_privilege_candidates(object_kind, privilege) as (
  values
    ('relation'::text, 'SELECT'::text),
    ('relation', 'INSERT'),
    ('relation', 'UPDATE'),
    ('relation', 'DELETE'),
    ('relation', 'TRUNCATE'),
    ('relation', 'REFERENCES'),
    ('relation', 'TRIGGER'),
    ('relation', 'MAINTAIN'),
    ('sequence', 'USAGE'),
    ('sequence', 'SELECT'),
    ('sequence', 'UPDATE')
),
effective_relation_acl_records as (
  select
    pg_catalog.format(
      'effective-acl/%s/%s/%s',
      case when relation.relkind = 'S' then 'sequence' else 'relation' end,
      pg_catalog.format('%I.%I', relation.schema_name, relation.relname),
      api_role.role_name
    ) as key,
    'effective-acl'::text as kind,
    pg_catalog.format('%I.%I', relation.schema_name, relation.relname) as identity,
    pg_catalog.jsonb_build_object(
      'objectKind', case when relation.relkind = 'S' then 'sequence' else 'relation' end,
      'role', api_role.role_name,
      'privileges', coalesce(
        pg_catalog.jsonb_agg(
          privilege_candidate.privilege
          order by privilege_candidate.privilege
        ) filter (
          where case
            when relation.relkind = 'S'
              then pg_catalog.has_sequence_privilege(
                api_role.role_name,
                relation.oid,
                privilege_candidate.privilege
              )
            else pg_catalog.has_table_privilege(
              api_role.role_name,
              relation.oid,
              privilege_candidate.privilege
            )
          end
        ),
        '[]'::jsonb
      )
    ) as definition
  from scoped_relations relation
  cross join api_roles api_role
  join relation_privilege_candidates privilege_candidate
    on privilege_candidate.object_kind = case
      when relation.relkind = 'S' then 'sequence'
      else 'relation'
    end
  group by
    relation.oid,
    relation.schema_name,
    relation.relname,
    relation.relkind,
    api_role.role_name
),
effective_schema_acl_records as (
  select
    pg_catalog.format('effective-acl/schema/public/%s', api_role.role_name) as key,
    'effective-acl'::text as kind,
    'public'::text as identity,
    pg_catalog.jsonb_build_object(
      'objectKind', 'schema',
      'role', api_role.role_name,
      'privileges', coalesce(
        pg_catalog.jsonb_agg(privilege.privilege order by privilege.privilege)
          filter (
            where pg_catalog.has_schema_privilege(
              api_role.role_name,
              namespace.oid,
              privilege.privilege
            )
          ),
        '[]'::jsonb
      )
    ) as definition
  from pg_catalog.pg_namespace namespace
  cross join api_roles api_role
  cross join (values ('USAGE'::text), ('CREATE'::text)) privilege(privilege)
  where namespace.nspname = 'public'
  group by namespace.oid, api_role.role_name
),
effective_function_acl_records as (
  select
    pg_catalog.format(
      'effective-acl/function/%s/%s',
      pg_catalog.format(
        '%I.%I(%s)',
        function_value.schema_name,
        function_value.proname,
        case
          when function_value.pinned_search_path = 'public, extensions'
            then pg_catalog.pg_get_function_identity_arguments(function_value.oid)
          else null
        end
      ),
      api_role.role_name
    ) as key,
    'effective-acl'::text as kind,
    pg_catalog.format(
      '%I.%I(%s)',
      function_value.schema_name,
      function_value.proname,
      case
        when function_value.pinned_search_path = 'public, extensions'
          then pg_catalog.pg_get_function_identity_arguments(function_value.oid)
        else null
      end
    ) as identity,
    pg_catalog.jsonb_build_object(
      'objectKind', 'function',
      'role', api_role.role_name,
      'privileges', case
        when pg_catalog.has_function_privilege(
          api_role.role_name,
          function_value.oid,
          'EXECUTE'
        ) then pg_catalog.jsonb_build_array('EXECUTE')
        else '[]'::jsonb
      end
    ) as definition
  from scoped_functions function_value
  cross join api_roles api_role
),
column_privilege_candidates(privilege) as (
  values
    ('SELECT'::text),
    ('INSERT'::text),
    ('UPDATE'::text),
    ('REFERENCES'::text)
),
effective_column_acl_records as (
  select
    pg_catalog.format(
      'effective-acl/column/%I.%I.%I/%s',
      column_value.schema_name,
      column_value.relation_name,
      column_value.attname,
      api_role.role_name
    ) as key,
    'effective-acl'::text as kind,
    pg_catalog.format(
      '%I.%I.%I',
      column_value.schema_name,
      column_value.relation_name,
      column_value.attname
    ) as identity,
    pg_catalog.jsonb_build_object(
      'objectKind', 'column',
      'role', api_role.role_name,
      'privileges', coalesce(
        pg_catalog.jsonb_agg(
          privilege_candidate.privilege
          order by privilege_candidate.privilege
        ) filter (
          where pg_catalog.has_column_privilege(
            api_role.role_name,
            column_value.attrelid,
            column_value.attname,
            privilege_candidate.privilege
          )
        ),
        '[]'::jsonb
      )
    ) as definition
  from scoped_columns column_value
  cross join api_roles api_role
  cross join column_privilege_candidates privilege_candidate
  group by
    column_value.schema_name,
    column_value.relation_name,
    column_value.attname,
    column_value.attrelid,
    api_role.role_name
),
storage_bucket_records as (
  select
    pg_catalog.format('storage-bucket/%s', bucket.id) as key,
    'storage-bucket'::text as kind,
    bucket.id::text as identity,
    pg_catalog.jsonb_build_object(
      'name', bucket.name,
      'owner', bucket.owner,
      'ownerId', bucket.owner_id,
      'public', bucket.public,
      'avifAutodetection', bucket.avif_autodetection,
      'fileSizeLimit', bucket.file_size_limit,
      'allowedMimeTypes', coalesce(
        pg_catalog.to_jsonb(bucket.allowed_mime_types),
        '[]'::jsonb
      ),
      'type', bucket.type
    ) as definition
  from storage.buckets bucket
),
badge_records as (
  select
    pg_catalog.format('badge/%s', badge.badge_key) as key,
    'badge'::text as kind,
    badge.badge_key as identity,
    pg_catalog.jsonb_build_object(
      'name', badge.name,
      'description', badge.description,
      'category', badge.category,
      'tier', badge.tier,
      'icon', badge.icon,
      'sortOrder', badge.sort_order
    ) as definition
  from public.badge_definitions badge
),
workout_config_records as (
  select
    pg_catalog.format('workout-config/%s', config.difficulty) as key,
    'workout-config'::text as kind,
    config.difficulty as identity,
    pg_catalog.jsonb_build_object('points', config.points) as definition
  from public.workout_difficulty_point_values config
),
challenge_definition_records as (
  select
    pg_catalog.format('challenge-definition/%s', definition.challenge_key) as key,
    'challenge-definition'::text as kind,
    definition.challenge_key as identity,
    pg_catalog.jsonb_build_object(
      'title', definition.title,
      'teaser', definition.teaser,
      'challengeType', definition.challenge_type,
      'pointsRequired', definition.points_required,
      'durationDays', definition.duration_days,
      'entitlementKey', definition.entitlement_key,
      'icon', definition.icon,
      'sortOrder', definition.sort_order,
      'isActive', definition.is_active,
      'metadata', definition.metadata
    ) as definition
  from public.challenge_definitions definition
),
entitlement_summary_records as (
  select
    'entitlement-summary/membership_active'::text as key,
    'entitlement-summary'::text as kind,
    'membership_active'::text as identity,
    pg_catalog.jsonb_build_object(
      'rowCount', pg_catalog.count(*),
      'membershipActiveCount', pg_catalog.count(*) filter (
        where entitlement.entitlement_key = 'membership_active'
          and entitlement.status = 'active'
      ),
      'currentlyEffectiveCount', pg_catalog.count(*) filter (
        where entitlement.entitlement_key = 'membership_active'
          and entitlement.status = 'active'
          and (
            entitlement.starts_at is null
            or entitlement.starts_at <= pg_catalog.now()
          )
          and (
            entitlement.ends_at is null
            or entitlement.ends_at > pg_catalog.now()
          )
      ),
      'unexpectedEntitlementKeyCount', pg_catalog.count(*) filter (
        where entitlement.entitlement_key is distinct from 'membership_active'
      )
    ) as definition
  from public.entitlements entitlement
),
operational_row_counts(identity, row_count) as materialized (
  select 'auth.users'::text, pg_catalog.count(*) from auth.users
  union all select 'public.billing_customers', pg_catalog.count(*) from public.billing_customers
  union all select 'public.challenge_entries', pg_catalog.count(*) from public.challenge_entries
  union all select 'public.check_ins', pg_catalog.count(*) from public.check_ins
  union all select 'public.community_feed_items', pg_catalog.count(*) from public.community_feed_items
  union all select 'public.community_posts', pg_catalog.count(*) from public.community_posts
  union all select 'public.crew_invites', pg_catalog.count(*) from public.crew_invites
  union all select 'public.crew_members', pg_catalog.count(*) from public.crew_members
  union all select 'public.crews', pg_catalog.count(*) from public.crews
  union all select 'public.entitlements', pg_catalog.count(*) from public.entitlements
  union all select 'public.game_point_events', pg_catalog.count(*) from public.game_point_events
  union all select 'public.journal_entries', pg_catalog.count(*) from public.journal_entries
  union all select 'public.journal_photos', pg_catalog.count(*) from public.journal_photos
  union all select 'public.post_comments', pg_catalog.count(*) from public.post_comments
  union all select 'public.post_likes', pg_catalog.count(*) from public.post_likes
  union all select 'public.profiles', pg_catalog.count(*) from public.profiles
  union all select 'public.subscriptions', pg_catalog.count(*) from public.subscriptions
  union all select 'public.user_badges', pg_catalog.count(*) from public.user_badges
  union all select 'public.user_challenge_states', pg_catalog.count(*) from public.user_challenge_states
  union all select 'public.user_game_stats', pg_catalog.count(*) from public.user_game_stats
  union all select 'storage.buckets_analytics', pg_catalog.count(*) from storage.buckets_analytics
  union all select 'storage.buckets_vectors', pg_catalog.count(*) from storage.buckets_vectors
  union all select 'storage.objects', pg_catalog.count(*) from storage.objects
  union all select 'storage.s3_multipart_uploads', pg_catalog.count(*) from storage.s3_multipart_uploads
  union all select 'storage.s3_multipart_uploads_parts', pg_catalog.count(*) from storage.s3_multipart_uploads_parts
  union all select 'storage.vector_indexes', pg_catalog.count(*) from storage.vector_indexes
),
operational_row_count_records as (
  select
    pg_catalog.format('row-count/%s', operational_row_count.identity) as key,
    'row-count'::text as kind,
    operational_row_count.identity,
    pg_catalog.jsonb_build_object(
      'rowCount', operational_row_count.row_count
    ) as definition
  from operational_row_counts operational_row_count
),
actual_components as materialized (
  select * from schema_records
  union all select * from extension_records
  union all select * from relation_records
  union all select * from column_records
  union all select * from constraint_records
  union all select * from index_records
  union all select * from function_records
  union all select * from trigger_records
  union all select * from policy_records
  union all select * from direct_object_acl_records
  union all select * from direct_column_acl_records
  union all select * from effective_relation_acl_records
  union all select * from effective_schema_acl_records
  union all select * from effective_function_acl_records
  union all select * from effective_column_acl_records
  union all select * from storage_bucket_records
  union all select * from badge_records
  union all select * from workout_config_records
  union all select * from challenge_definition_records
  union all select * from entitlement_summary_records
  union all select * from operational_row_count_records
),
actual_records as materialized (
  select
    actual_component.key,
    pg_catalog.jsonb_build_object(
      'key', actual_component.key,
      'kind', actual_component.kind,
      'identity', actual_component.identity,
      'definition', actual_component.definition
    ) as record
  from actual_components actual_component
),
expected_duplicate_keys as (
  select expected_record.key
  from expected_records expected_record
  group by expected_record.key
  having pg_catalog.count(*) <> 1
),
actual_duplicate_keys as (
  select actual_record.key
  from actual_records actual_record
  group by actual_record.key
  having pg_catalog.count(*) <> 1
),
differences as materialized (
  select
    expected_record.key as expected_key,
    actual_record.key as actual_key,
    expected_record.record as expected_record,
    actual_record.record as actual_record
  from expected_records expected_record
  full outer join actual_records actual_record
    on actual_record.key = expected_record.key
  where expected_record.record is distinct from actual_record.record
)
select
  (select pg_catalog.count(*)::integer from expected_records) as expected_count,
  (select pg_catalog.count(*)::integer from actual_records) as actual_count,
  (select pg_catalog.count(*)::integer from expected_duplicate_keys)
    as expected_duplicate_key_count,
  (select pg_catalog.count(*)::integer from actual_duplicate_keys)
    as actual_duplicate_key_count,
  (select pg_catalog.count(*)::integer
   from differences
   where differences.expected_key is not null
     and differences.actual_key is null) as missing_count,
  (select pg_catalog.count(*)::integer
   from differences
   where differences.expected_key is null
     and differences.actual_key is not null) as unexpected_count,
  (select pg_catalog.count(*)::integer
   from differences
   where differences.expected_key is not null
     and differences.actual_key is not null) as changed_count,
  not exists (select 1 from differences)
    and not exists (select 1 from expected_duplicate_keys)
    and not exists (select 1 from actual_duplicate_keys) as contract_matches;
