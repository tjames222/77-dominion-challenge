\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on
\pset pager off

create temporary table database_manifest_records (
  key text primary key,
  record jsonb not null
);

begin transaction read only;
set local statement_timeout = '60s';
set local lock_timeout = '5s';
set local idle_in_transaction_session_timeout = '70s';

insert into database_manifest_records (key, record)
select
  format('schema/%I', namespace.nspname),
  jsonb_build_object(
    'kind', 'schema',
    'identity', namespace.nspname,
    'definition', jsonb_build_object(
      'owner', pg_get_userbyid(namespace.nspowner)
    )
  )
from pg_namespace namespace
where namespace.nspname in ('public', 'private')
   or namespace.nspname like 'reconciliation\_%' escape '\';

insert into database_manifest_records (key, record)
select
  format(
    '%s/%I',
    case when extension.extname = 'pgcrypto' then 'extension' else 'platform-extension' end,
    extension.extname
  ),
  jsonb_build_object(
    'kind', case when extension.extname = 'pgcrypto' then 'extension' else 'platform-extension' end,
    'identity', extension.extname,
    'definition', jsonb_build_object(
      'schema', namespace.nspname,
      'version', extension.extversion,
      'relocatable', extension.extrelocatable
    )
  )
from pg_extension extension
join pg_namespace namespace on namespace.oid = extension.extnamespace;

with scoped_relations as (
  select relation.*, namespace.nspname as schema_name
  from pg_class relation
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  where (
      namespace.nspname in ('public', 'private')
      or namespace.nspname like 'reconciliation\_%' escape '\'
    )
    and relation.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
), platform_relations as (
  select relation.*, namespace.nspname as schema_name
  from pg_class relation
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = 'storage'
    and relation.relname in (
      'buckets',
      'buckets_analytics',
      'buckets_vectors',
      'iceberg_namespaces',
      'iceberg_tables',
      'objects',
      's3_multipart_uploads',
      's3_multipart_uploads_parts',
      'vector_indexes'
    )
    and relation.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
)
insert into database_manifest_records (key, record)
select
  format('%s/%I.%I', prefix, relation.schema_name, relation.relname),
  jsonb_build_object(
    'kind', kind,
    'identity', format('%I.%I', relation.schema_name, relation.relname),
    'definition', jsonb_build_object(
      'owner', pg_get_userbyid(relation.relowner),
      'relationKind', relation.relkind,
      'persistence', relation.relpersistence,
      'rowSecurity', relation.relrowsecurity,
      'forceRowSecurity', relation.relforcerowsecurity,
      'replicaIdentity', relation.relreplident,
      'options', coalesce(to_jsonb(relation.reloptions), '[]'::jsonb),
      'columns', case
        when kind <> 'platform-relation' then '[]'::jsonb
        else coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'name', column_value.attname,
              'position', column_value.attnum,
              'type', format_type(column_value.atttypid, column_value.atttypmod),
              'notNull', column_value.attnotnull,
              'identity', column_value.attidentity,
              'generated', column_value.attgenerated,
              'storage', column_value.attstorage,
              'compression', column_value.attcompression,
              'default', case
                when default_value.adbin is null then null
                else pg_get_expr(default_value.adbin, default_value.adrelid, false)
              end
            )
            order by column_value.attnum
          )
          from pg_attribute column_value
          left join pg_attrdef default_value
            on default_value.adrelid = column_value.attrelid
           and default_value.adnum = column_value.attnum
          where column_value.attrelid = relation.oid
            and column_value.attnum > 0
            and not column_value.attisdropped
        ), '[]'::jsonb)
      end,
      'constraints', case
        when kind <> 'platform-relation' then '[]'::jsonb
        else coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'name', constraint_value.conname,
              'type', constraint_value.contype,
              'definition', pg_get_constraintdef(constraint_value.oid, false),
              'deferrable', constraint_value.condeferrable,
              'deferred', constraint_value.condeferred,
              'validated', constraint_value.convalidated,
              'noInherit', constraint_value.connoinherit
            )
            order by constraint_value.conname collate "C"
          )
          from pg_constraint constraint_value
          where constraint_value.conrelid = relation.oid
        ), '[]'::jsonb)
      end,
      'indexes', case
        when kind <> 'platform-relation' then '[]'::jsonb
        else coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'name', index_relation.relname,
              'definition', pg_get_indexdef(index_relation.oid, 0, false),
              'unique', index_value.indisunique,
              'primary', index_value.indisprimary,
              'valid', index_value.indisvalid,
              'ready', index_value.indisready
            )
            order by index_relation.relname collate "C"
          )
          from pg_index index_value
          join pg_class index_relation on index_relation.oid = index_value.indexrelid
          where index_value.indrelid = relation.oid
        ), '[]'::jsonb)
      end
    )
  )
from (
  select 'relation'::text as prefix, 'relation'::text as kind, scoped_relations.*
  from scoped_relations
  union all
  select 'platform-relation', 'platform-relation', platform_relations.*
  from platform_relations
) relation;

with scoped_columns as (
  select
    namespace.nspname as schema_name,
    relation.relname as relation_name,
    relation.relkind,
    column_value.*,
    default_value.adbin,
    default_value.adrelid,
    collation_value.collname as collation_name,
    collation_namespace.nspname as collation_schema
  from pg_attribute column_value
  join pg_class relation on relation.oid = column_value.attrelid
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  left join pg_attrdef default_value
    on default_value.adrelid = column_value.attrelid
   and default_value.adnum = column_value.attnum
  left join pg_collation collation_value on collation_value.oid = column_value.attcollation
  left join pg_namespace collation_namespace on collation_namespace.oid = collation_value.collnamespace
  where (
      namespace.nspname in ('public', 'private')
      or namespace.nspname like 'reconciliation\_%' escape '\'
    )
    and relation.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
    and column_value.attnum > 0
    and not column_value.attisdropped
)
insert into database_manifest_records (key, record)
select
  format('column/%I.%I/%I', column_value.schema_name, column_value.relation_name, column_value.attname),
  jsonb_build_object(
    'kind', 'column',
    'identity', format('%I.%I.%I', column_value.schema_name, column_value.relation_name, column_value.attname),
    'definition', jsonb_build_object(
      'position', column_value.attnum,
      'type', format_type(column_value.atttypid, column_value.atttypmod),
      'notNull', column_value.attnotnull,
      'identity', column_value.attidentity,
      'generated', column_value.attgenerated,
      'storage', column_value.attstorage,
      'compression', column_value.attcompression,
      'statisticsTarget', column_value.attstattarget,
      'collation', case
        when column_value.collation_name is null then null
        else format('%I.%I', column_value.collation_schema, column_value.collation_name)
      end,
      'default', case
        when column_value.adbin is null then null
        else pg_get_expr(column_value.adbin, column_value.adrelid, false)
      end
    )
  )
from scoped_columns column_value;

insert into database_manifest_records (key, record)
select
  format('constraint/%I.%I/%I', namespace.nspname, relation.relname, constraint_value.conname),
  jsonb_build_object(
    'kind', 'constraint',
    'identity', format('%I.%I.%I', namespace.nspname, relation.relname, constraint_value.conname),
    'definition', jsonb_build_object(
      'type', constraint_value.contype,
      'definition', pg_get_constraintdef(constraint_value.oid, false),
      'deferrable', constraint_value.condeferrable,
      'deferred', constraint_value.condeferred,
      'validated', constraint_value.convalidated,
      'noInherit', constraint_value.connoinherit
    )
  )
from pg_constraint constraint_value
join pg_class relation on relation.oid = constraint_value.conrelid
join pg_namespace namespace on namespace.oid = relation.relnamespace
where namespace.nspname in ('public', 'private')
   or namespace.nspname like 'reconciliation\_%' escape '\';

insert into database_manifest_records (key, record)
select
  format('index/%I.%I', namespace.nspname, index_relation.relname),
  jsonb_build_object(
    'kind', 'index',
    'identity', format('%I.%I', namespace.nspname, index_relation.relname),
    'definition', jsonb_build_object(
      'table', format('%I.%I', namespace.nspname, table_relation.relname),
      'owner', pg_get_userbyid(index_relation.relowner),
      'definition', pg_get_indexdef(index_relation.oid, 0, false),
      'unique', index_value.indisunique,
      'primary', index_value.indisprimary,
      'exclusion', index_value.indisexclusion,
      'immediate', index_value.indimmediate,
      'clustered', index_value.indisclustered,
      'valid', index_value.indisvalid,
      'ready', index_value.indisready,
      'live', index_value.indislive,
      'replicaIdentity', index_value.indisreplident
    )
  )
from pg_index index_value
join pg_class index_relation on index_relation.oid = index_value.indexrelid
join pg_class table_relation on table_relation.oid = index_value.indrelid
join pg_namespace namespace on namespace.oid = table_relation.relnamespace
where namespace.nspname in ('public', 'private')
   or namespace.nspname like 'reconciliation\_%' escape '\';

with referenced_event_trigger_functions as (
  select event_trigger.evtfoid as function_oid
  from pg_event_trigger event_trigger
), referenced_storage_trigger_functions as (
  select distinct trigger_value.tgfoid as function_oid
  from pg_trigger trigger_value
  join pg_class relation on relation.oid = trigger_value.tgrelid
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  where not trigger_value.tgisinternal
    and namespace.nspname = 'storage'
    and relation.relname in (
      'buckets',
      'buckets_analytics',
      'buckets_vectors',
      'iceberg_namespaces',
      'iceberg_tables',
      'objects',
      's3_multipart_uploads',
      's3_multipart_uploads_parts',
      'vector_indexes'
    )
), scoped_function_oids as (
  select procedure_value.oid
  from pg_proc procedure_value
  join pg_namespace namespace on namespace.oid = procedure_value.pronamespace
  where (
      namespace.nspname in ('public', 'private')
      or namespace.nspname like 'reconciliation\_%' escape '\'
    )
    and not (
      namespace.nspname = 'public'
      and procedure_value.proname = 'rls_auto_enable'
      and pg_get_function_identity_arguments(procedure_value.oid) = ''
    )

  union

  select procedure_value.oid
  from pg_proc procedure_value
  join pg_namespace namespace on namespace.oid = procedure_value.pronamespace
  where namespace.nspname = 'storage'
    and procedure_value.proname = 'filename'

  union

  select procedure_value.oid
  from pg_proc procedure_value
  join pg_namespace namespace on namespace.oid = procedure_value.pronamespace
  where namespace.nspname = 'public'
    and procedure_value.proname = 'rls_auto_enable'
    and pg_get_function_identity_arguments(procedure_value.oid) = ''

  union

  select function_oid from referenced_event_trigger_functions

  union

  select function_oid from referenced_storage_trigger_functions
), scoped_functions as (
  select
    procedure_value.*,
    namespace.nspname as schema_name,
    language.lanname as language_name,
    case
      when (
        namespace.nspname = 'storage'
        and (
          procedure_value.proname = 'filename'
          or procedure_value.oid in (
            select function_oid from referenced_storage_trigger_functions
          )
        )
      )
        or (
          namespace.nspname = 'extensions'
          and procedure_value.oid in (
            select function_oid from referenced_event_trigger_functions
          )
        )
        or (
          namespace.nspname = 'public'
          and procedure_value.proname = 'rls_auto_enable'
          and pg_get_function_identity_arguments(procedure_value.oid) = ''
        )
        then 'platform-function'
      else 'function'
    end as manifest_kind,
    case
      when (
        namespace.nspname = 'storage'
        and (
          procedure_value.proname = 'filename'
          or procedure_value.oid in (
            select function_oid from referenced_storage_trigger_functions
          )
        )
      )
        or (
          namespace.nspname = 'extensions'
          and procedure_value.oid in (
            select function_oid from referenced_event_trigger_functions
          )
        )
        or (
          namespace.nspname = 'public'
          and procedure_value.proname = 'rls_auto_enable'
          and pg_get_function_identity_arguments(procedure_value.oid) = ''
        )
        then 'platform-function'
      else 'function'
    end as key_prefix
  from pg_proc procedure_value
  join pg_namespace namespace on namespace.oid = procedure_value.pronamespace
  join pg_language language on language.oid = procedure_value.prolang
  join scoped_function_oids function_scope on function_scope.oid = procedure_value.oid
)
insert into database_manifest_records (key, record)
select
  format(
    '%s/%I.%I(%s)',
    function_value.key_prefix,
    function_value.schema_name,
    function_value.proname,
    pg_get_function_identity_arguments(function_value.oid)
  ),
  jsonb_build_object(
    'kind', function_value.manifest_kind,
    'identity', format(
      '%I.%I(%s)',
      function_value.schema_name,
      function_value.proname,
      pg_get_function_identity_arguments(function_value.oid)
    ),
    'definition', jsonb_build_object(
      'owner', pg_get_userbyid(function_value.proowner),
      'arguments', pg_get_function_arguments(function_value.oid),
      'result', pg_get_function_result(function_value.oid),
      'language', function_value.language_name,
      'kind', function_value.prokind,
      'volatility', function_value.provolatile,
      'parallel', function_value.proparallel,
      'securityDefiner', function_value.prosecdef,
      'strict', function_value.proisstrict,
      'leakproof', function_value.proleakproof,
      'returnsSet', function_value.proretset,
      'configuration', coalesce(to_jsonb(function_value.proconfig), '[]'::jsonb),
      'binary', coalesce(function_value.probin, ''),
      'bodyBase64', encode(convert_to(function_value.prosrc, 'UTF8'), 'base64')
    )
  )
from scoped_functions function_value;

insert into database_manifest_records (key, record)
select
  format(
    '%s/%I',
    case
      when function_namespace.nspname = 'extensions'
        or (function_namespace.nspname = 'public' and function_value.proname = 'rls_auto_enable')
        then 'platform-event-trigger'
      else 'event-trigger'
    end,
    event_trigger.evtname
  ),
  jsonb_build_object(
    'kind', case
      when function_namespace.nspname = 'extensions'
        or (function_namespace.nspname = 'public' and function_value.proname = 'rls_auto_enable')
        then 'platform-event-trigger'
      else 'event-trigger'
    end,
    'identity', event_trigger.evtname,
    'definition', jsonb_build_object(
      'owner', pg_get_userbyid(event_trigger.evtowner),
      'event', event_trigger.evtevent,
      'enabled', event_trigger.evtenabled,
      'tags', coalesce(to_jsonb(event_trigger.evttags), '[]'::jsonb),
      'function', format(
        '%I.%I(%s)',
        function_namespace.nspname,
        function_value.proname,
        pg_get_function_identity_arguments(function_value.oid)
      )
    )
  )
from pg_event_trigger event_trigger
join pg_proc function_value on function_value.oid = event_trigger.evtfoid
join pg_namespace function_namespace on function_namespace.oid = function_value.pronamespace;

insert into database_manifest_records (key, record)
select
  format(
    '%s/%I.%I/%I',
    case
      when namespace.nspname = 'storage' and function_namespace.nspname = 'storage'
        then 'platform-trigger'
      else 'trigger'
    end,
    namespace.nspname,
    relation.relname,
    trigger_value.tgname
  ),
  jsonb_build_object(
    'kind', case
      when namespace.nspname = 'storage' and function_namespace.nspname = 'storage'
        then 'platform-trigger'
      else 'trigger'
    end,
    'identity', format('%I.%I.%I', namespace.nspname, relation.relname, trigger_value.tgname),
    'definition', jsonb_build_object(
      'enabled', trigger_value.tgenabled,
      'definition', pg_get_triggerdef(trigger_value.oid, false),
      'function', format(
        '%I.%I(%s)',
        function_namespace.nspname,
        function_value.proname,
        pg_get_function_identity_arguments(function_value.oid)
      )
    )
  )
from pg_trigger trigger_value
join pg_class relation on relation.oid = trigger_value.tgrelid
join pg_namespace namespace on namespace.oid = relation.relnamespace
join pg_proc function_value on function_value.oid = trigger_value.tgfoid
join pg_namespace function_namespace on function_namespace.oid = function_value.pronamespace
where not trigger_value.tgisinternal
  and (
    namespace.nspname in ('public', 'private')
    or namespace.nspname like 'reconciliation\_%' escape '\'
    or (
      namespace.nspname = 'storage'
      and relation.relname in (
        'buckets',
        'buckets_analytics',
        'buckets_vectors',
        'iceberg_namespaces',
        'iceberg_tables',
        'objects',
        's3_multipart_uploads',
        's3_multipart_uploads_parts',
        'vector_indexes'
      )
    )
  );

insert into database_manifest_records (key, record)
select
  format('policy/%I.%I/%I', namespace.nspname, relation.relname, policy_value.polname),
  jsonb_build_object(
    'kind', 'policy',
    'identity', format('%I.%I.%I', namespace.nspname, relation.relname, policy_value.polname),
    'definition', jsonb_build_object(
      'permissive', policy_value.polpermissive,
      'command', policy_value.polcmd,
      'roles', (
        select jsonb_agg(
          case when role_oid = 0 then 'PUBLIC' else pg_get_userbyid(role_oid) end
          order by case when role_oid = 0 then 'PUBLIC' else pg_get_userbyid(role_oid) end
        )
        from unnest(policy_value.polroles) role_oid
      ),
      'using', case
        when policy_value.polqual is null then null
        else pg_get_expr(policy_value.polqual, policy_value.polrelid, false)
      end,
      'withCheck', case
        when policy_value.polwithcheck is null then null
        else pg_get_expr(policy_value.polwithcheck, policy_value.polrelid, false)
      end
    )
  )
from pg_policy policy_value
join pg_class relation on relation.oid = policy_value.polrelid
join pg_namespace namespace on namespace.oid = relation.relnamespace
where namespace.nspname in ('public', 'private')
   or namespace.nspname like 'reconciliation\_%' escape '\'
   or (
     namespace.nspname = 'storage'
     and relation.relname in (
       'buckets',
       'buckets_analytics',
       'buckets_vectors',
       'iceberg_namespaces',
       'iceberg_tables',
       'objects',
       's3_multipart_uploads',
       's3_multipart_uploads_parts',
       'vector_indexes'
     )
   );

-- Direct ACLs are not expanded from acldefault(): a missing ACL and an explicit
-- ACL are intentionally different. Object ownership is recorded separately.
with schema_acls as (
  select
    'schema-acl'::text as kind,
    format('%I', namespace.nspname) as identity,
    namespace.nspacl as acl
  from pg_namespace namespace
  where namespace.nspname in ('public', 'private')
     or namespace.nspname like 'reconciliation\_%' escape '\'
), relation_acls as (
  select
    case when namespace.nspname = 'storage' then 'platform-relation-acl' else 'relation-acl' end as kind,
    format('%I.%I', namespace.nspname, relation.relname) as identity,
    relation.relacl as acl
  from pg_class relation
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  where (
      namespace.nspname in ('public', 'private')
      or namespace.nspname like 'reconciliation\_%' escape '\'
      or (
        namespace.nspname = 'storage'
        and relation.relname in (
          'buckets',
          'buckets_analytics',
          'buckets_vectors',
          'iceberg_namespaces',
          'iceberg_tables',
          'objects',
          's3_multipart_uploads',
          's3_multipart_uploads_parts',
          'vector_indexes'
        )
      )
    )
    and relation.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
), function_acls as (
  select
    case
      when namespace.nspname = 'storage'
        or namespace.nspname = 'extensions'
        or (
          namespace.nspname = 'public'
          and procedure_value.proname = 'rls_auto_enable'
          and pg_get_function_identity_arguments(procedure_value.oid) = ''
        )
        then 'platform-function-acl'
      else 'function-acl'
    end as kind,
    format('%I.%I(%s)', namespace.nspname, procedure_value.proname, pg_get_function_identity_arguments(procedure_value.oid)) as identity,
    procedure_value.proacl as acl
  from pg_proc procedure_value
  join pg_namespace namespace on namespace.oid = procedure_value.pronamespace
  where namespace.nspname in ('public', 'private')
     or namespace.nspname like 'reconciliation\_%' escape '\'
     or (namespace.nspname = 'storage' and procedure_value.proname = 'filename')
     or (
       namespace.nspname = 'public'
       and procedure_value.proname = 'rls_auto_enable'
       and pg_get_function_identity_arguments(procedure_value.oid) = ''
     )
     or exists (
       select 1
       from pg_event_trigger event_trigger
       where event_trigger.evtfoid = procedure_value.oid
     )
     or exists (
       select 1
       from pg_trigger trigger_value
       join pg_class relation on relation.oid = trigger_value.tgrelid
       join pg_namespace relation_namespace on relation_namespace.oid = relation.relnamespace
       where trigger_value.tgfoid = procedure_value.oid
         and not trigger_value.tgisinternal
         and relation_namespace.nspname = 'storage'
         and relation.relname in (
           'buckets',
           'buckets_analytics',
           'buckets_vectors',
           'iceberg_namespaces',
           'iceberg_tables',
           'objects',
           's3_multipart_uploads',
           's3_multipart_uploads_parts',
           'vector_indexes'
         )
     )
), object_acls as (
  select * from schema_acls
  union all
  select * from relation_acls
  union all
  select * from function_acls
)
insert into database_manifest_records (key, record)
select
  format(
    'direct-acl/%s/%s/%s/%s/%s',
    object_acl.kind,
    object_acl.identity,
    case when acl_value.grantor = 0 then 'PUBLIC' else pg_get_userbyid(acl_value.grantor) end,
    case when acl_value.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl_value.grantee) end,
    acl_value.privilege_type
  ),
  jsonb_build_object(
    'kind', 'direct-acl',
    'identity', object_acl.identity,
    'definition', jsonb_build_object(
      'objectKind', object_acl.kind,
      'grantor', case when acl_value.grantor = 0 then 'PUBLIC' else pg_get_userbyid(acl_value.grantor) end,
      'grantee', case when acl_value.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl_value.grantee) end,
      'privilege', acl_value.privilege_type,
      'grantable', acl_value.is_grantable
    )
  )
from object_acls object_acl
cross join lateral aclexplode(object_acl.acl) acl_value;

insert into database_manifest_records (key, record)
select
  format(
    'direct-acl/%s/%I.%I.%I/%s/%s/%s',
    case when namespace.nspname = 'storage' then 'platform-column-acl' else 'column-acl' end,
    namespace.nspname,
    relation.relname,
    column_value.attname,
    case when acl_value.grantor = 0 then 'PUBLIC' else pg_get_userbyid(acl_value.grantor) end,
    case when acl_value.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl_value.grantee) end,
    acl_value.privilege_type
  ),
  jsonb_build_object(
    'kind', 'direct-acl',
    'identity', format('%I.%I.%I', namespace.nspname, relation.relname, column_value.attname),
    'definition', jsonb_build_object(
      'objectKind', case
        when namespace.nspname = 'storage' then 'platform-column-acl'
        else 'column-acl'
      end,
      'grantor', case when acl_value.grantor = 0 then 'PUBLIC' else pg_get_userbyid(acl_value.grantor) end,
      'grantee', case when acl_value.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl_value.grantee) end,
      'privilege', acl_value.privilege_type,
      'grantable', acl_value.is_grantable
    )
  )
from pg_attribute column_value
join pg_class relation on relation.oid = column_value.attrelid
join pg_namespace namespace on namespace.oid = relation.relnamespace
cross join lateral aclexplode(column_value.attacl) acl_value
where (
    namespace.nspname in ('public', 'private')
    or namespace.nspname like 'reconciliation\_%' escape '\'
    or (
      namespace.nspname = 'storage'
      and relation.relname in (
        'buckets',
        'buckets_analytics',
        'buckets_vectors',
        'iceberg_namespaces',
        'iceberg_tables',
        'objects',
        's3_multipart_uploads',
        's3_multipart_uploads_parts',
        'vector_indexes'
      )
    )
  )
  and column_value.attnum > 0
  and not column_value.attisdropped;

with api_roles(role_name) as (
  select role_value.rolname
  from pg_roles role_value
  where role_value.rolname in ('anon', 'authenticated', 'service_role')
     or role_value.rolname like 'reconciliation\_%' escape '\'
), relation_objects as (
  select
    case when relation.relkind = 'S' then 'sequence' else 'relation' end as object_kind,
    format('%I.%I', namespace.nspname, relation.relname) as identity,
    relation.oid,
    relation.relkind
  from pg_class relation
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  where (
      namespace.nspname in ('public', 'private')
      or namespace.nspname like 'reconciliation\_%' escape '\'
      or (
        namespace.nspname = 'storage'
        and relation.relname in (
          'buckets',
          'buckets_analytics',
          'buckets_vectors',
          'iceberg_namespaces',
          'iceberg_tables',
          'objects',
          's3_multipart_uploads',
          's3_multipart_uploads_parts',
          'vector_indexes'
        )
      )
    )
    and relation.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
), privilege_candidates(object_kind, privilege) as (
  values
    ('relation', 'SELECT'),
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
)
insert into database_manifest_records (key, record)
select
  format('effective-acl/%s/%s/%s', relation_object.object_kind, relation_object.identity, api_role.role_name),
  jsonb_build_object(
    'kind', 'effective-acl',
    'identity', relation_object.identity,
    'definition', jsonb_build_object(
      'objectKind', relation_object.object_kind,
      'role', api_role.role_name,
      'privileges', coalesce(
        jsonb_agg(privilege_candidate.privilege order by privilege_candidate.privilege)
          filter (
            where case
              when relation_object.object_kind = 'sequence'
                then has_sequence_privilege(api_role.role_name, relation_object.oid, privilege_candidate.privilege)
              else has_table_privilege(api_role.role_name, relation_object.oid, privilege_candidate.privilege)
            end
          ),
        '[]'::jsonb
      )
    )
  )
from relation_objects relation_object
cross join api_roles api_role
join privilege_candidates privilege_candidate
  on privilege_candidate.object_kind = relation_object.object_kind
group by relation_object.object_kind, relation_object.identity, api_role.role_name;

with api_roles(role_name) as (
  select role_value.rolname
  from pg_roles role_value
  where role_value.rolname in ('anon', 'authenticated', 'service_role')
     or role_value.rolname like 'reconciliation\_%' escape '\'
), schemas as (
  select namespace.oid, namespace.nspname
  from pg_namespace namespace
  where namespace.nspname in ('public', 'private')
     or namespace.nspname like 'reconciliation\_%' escape '\'
), privileges(privilege) as (
  values ('USAGE'::text), ('CREATE'::text)
)
insert into database_manifest_records (key, record)
select
  format('effective-acl/schema/%I/%s', schema_value.nspname, api_role.role_name),
  jsonb_build_object(
    'kind', 'effective-acl',
    'identity', schema_value.nspname,
    'definition', jsonb_build_object(
      'objectKind', 'schema',
      'role', api_role.role_name,
      'privileges', coalesce(
        jsonb_agg(privilege.privilege order by privilege.privilege)
          filter (where has_schema_privilege(api_role.role_name, schema_value.oid, privilege.privilege)),
        '[]'::jsonb
      )
    )
  )
from schemas schema_value
cross join api_roles api_role
cross join privileges privilege
group by schema_value.nspname, api_role.role_name;

with api_roles(role_name) as (
  select role_value.rolname
  from pg_roles role_value
  where role_value.rolname in ('anon', 'authenticated', 'service_role')
     or role_value.rolname like 'reconciliation\_%' escape '\'
), functions as (
  select
    procedure_value.oid,
    format('%I.%I(%s)', namespace.nspname, procedure_value.proname, pg_get_function_identity_arguments(procedure_value.oid)) as identity
  from pg_proc procedure_value
  join pg_namespace namespace on namespace.oid = procedure_value.pronamespace
  where namespace.nspname in ('public', 'private')
     or namespace.nspname like 'reconciliation\_%' escape '\'
     or (namespace.nspname = 'storage' and procedure_value.proname = 'filename')
     or (
       namespace.nspname = 'public'
       and procedure_value.proname = 'rls_auto_enable'
       and pg_get_function_identity_arguments(procedure_value.oid) = ''
     )
     or exists (
       select 1
       from pg_event_trigger event_trigger
       where event_trigger.evtfoid = procedure_value.oid
     )
     or exists (
       select 1
       from pg_trigger trigger_value
       join pg_class relation on relation.oid = trigger_value.tgrelid
       join pg_namespace relation_namespace on relation_namespace.oid = relation.relnamespace
       where trigger_value.tgfoid = procedure_value.oid
         and not trigger_value.tgisinternal
         and relation_namespace.nspname = 'storage'
         and relation.relname in (
           'buckets',
           'buckets_analytics',
           'buckets_vectors',
           'iceberg_namespaces',
           'iceberg_tables',
           'objects',
           's3_multipart_uploads',
           's3_multipart_uploads_parts',
           'vector_indexes'
         )
     )
)
insert into database_manifest_records (key, record)
select
  format('effective-acl/function/%s/%s', function_value.identity, api_role.role_name),
  jsonb_build_object(
    'kind', 'effective-acl',
    'identity', function_value.identity,
    'definition', jsonb_build_object(
      'objectKind', 'function',
      'role', api_role.role_name,
      'privileges', case
        when has_function_privilege(api_role.role_name, function_value.oid, 'EXECUTE')
          then jsonb_build_array('EXECUTE')
        else '[]'::jsonb
      end
    )
  )
from functions function_value
cross join api_roles api_role;

with api_roles(role_name) as (
  select role_value.rolname
  from pg_roles role_value
  where role_value.rolname in ('anon', 'authenticated', 'service_role')
     or role_value.rolname like 'reconciliation\_%' escape '\'
), columns as (
  select
    relation.oid as relation_oid,
    namespace.nspname as schema_name,
    relation.relname as relation_name,
    column_value.attname as column_name
  from pg_attribute column_value
  join pg_class relation on relation.oid = column_value.attrelid
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  where (
      namespace.nspname in ('public', 'private')
      or namespace.nspname like 'reconciliation\_%' escape '\'
      or (
        namespace.nspname = 'storage'
        and relation.relname in (
          'buckets',
          'buckets_analytics',
          'buckets_vectors',
          'iceberg_namespaces',
          'iceberg_tables',
          'objects',
          's3_multipart_uploads',
          's3_multipart_uploads_parts',
          'vector_indexes'
        )
      )
    )
    and relation.relkind in ('r', 'p', 'v', 'm', 'f')
    and column_value.attnum > 0
    and not column_value.attisdropped
), privileges(privilege) as (
  values ('SELECT'::text), ('INSERT'::text), ('UPDATE'::text), ('REFERENCES'::text)
)
insert into database_manifest_records (key, record)
select
  format(
    'effective-acl/column/%I.%I.%I/%s',
    column_value.schema_name,
    column_value.relation_name,
    column_value.column_name,
    api_role.role_name
  ),
  jsonb_build_object(
    'kind', 'effective-acl',
    'identity', format('%I.%I.%I', column_value.schema_name, column_value.relation_name, column_value.column_name),
    'definition', jsonb_build_object(
      'objectKind', 'column',
      'role', api_role.role_name,
      'privileges', coalesce(
        jsonb_agg(privilege.privilege order by privilege.privilege)
          filter (
            where has_column_privilege(
              api_role.role_name,
              column_value.relation_oid,
              column_value.column_name,
              privilege.privilege
            )
          ),
        '[]'::jsonb
      )
    )
  )
from columns column_value
cross join api_roles api_role
cross join privileges privilege
group by
  column_value.schema_name,
  column_value.relation_name,
  column_value.column_name,
  column_value.relation_oid,
  api_role.role_name;

insert into database_manifest_records (key, record)
select
  format(
    'default-acl/%s/%I/%s/%s/%s/%s',
    pg_get_userbyid(default_acl.defaclrole),
    coalesce(namespace.nspname, '<global>'),
    default_acl.defaclobjtype,
    case when acl_value.grantor = 0 then 'PUBLIC' else pg_get_userbyid(acl_value.grantor) end,
    case when acl_value.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl_value.grantee) end,
    acl_value.privilege_type
  ),
  jsonb_build_object(
    'kind', 'default-acl',
    'identity', format(
      '%s/%s/%s',
      pg_get_userbyid(default_acl.defaclrole),
      coalesce(namespace.nspname, '<global>'),
      default_acl.defaclobjtype
    ),
    'definition', jsonb_build_object(
      'owner', pg_get_userbyid(default_acl.defaclrole),
      'schema', namespace.nspname,
      'objectType', default_acl.defaclobjtype,
      'grantor', case when acl_value.grantor = 0 then 'PUBLIC' else pg_get_userbyid(acl_value.grantor) end,
      'grantee', case when acl_value.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl_value.grantee) end,
      'privilege', acl_value.privilege_type,
      'grantable', acl_value.is_grantable
    )
  )
from pg_default_acl default_acl
left join pg_namespace namespace on namespace.oid = default_acl.defaclnamespace
cross join lateral aclexplode(default_acl.defaclacl) acl_value
where namespace.nspname in ('public', 'private')
   or namespace.nspname like 'reconciliation\_%' escape '\'
   or default_acl.defaclnamespace = 0;

insert into database_manifest_records (key, record)
select
  format('storage-bucket/%s', bucket.id),
  jsonb_build_object(
    'kind', 'storage-bucket',
    'identity', bucket.id,
    'definition', jsonb_build_object(
      'name', bucket.name,
      'owner', bucket.owner,
      'ownerId', bucket.owner_id,
      'public', bucket.public,
      'avifAutodetection', bucket.avif_autodetection,
      'fileSizeLimit', bucket.file_size_limit,
      'allowedMimeTypes', coalesce(to_jsonb(bucket.allowed_mime_types), '[]'::jsonb),
      'type', bucket.type
    )
  )
from storage.buckets bucket;

-- Standard bucket rows are represented individually above without volatile
-- service-managed timestamps. Every remaining Storage metadata table is empty
-- at this checkpoint, so retain both its count and a canonical whole-row hash.
-- This covers multipart parts and the analytics/vector catalog independently of
-- their parent rows; an orphaned or partially written record cannot disappear
-- behind a parent-only inventory.
do $storage_row_inventories$
declare
  relation_name text;
  row_count bigint;
  row_hash text;
begin
  for relation_name in
    select inventory_relation.relation_name
    from (values
      ('buckets_analytics'),
      ('buckets_vectors'),
      ('iceberg_namespaces'),
      ('iceberg_tables'),
      ('objects'),
      ('s3_multipart_uploads'),
      ('s3_multipart_uploads_parts'),
      ('vector_indexes')
    ) inventory_relation(relation_name)
    order by inventory_relation.relation_name collate "C"
  loop
    execute format(
      $query$
        select
          count(*),
          encode(
            digest(
              convert_to(
                coalesce(
                  string_agg(
                    encode(digest(convert_to(to_jsonb(source_row)::text, 'UTF8'), 'sha256'), 'hex'),
                    '' order by to_jsonb(source_row)::text collate "C"
                  ),
                  ''
                ),
                'UTF8'
              ),
              'sha256'
            ),
            'hex'
          )
        from storage.%I source_row
      $query$,
      relation_name
    ) into row_count, row_hash;

    insert into database_manifest_records (key, record)
    values (
      format('storage-row-inventory/%s', relation_name),
      jsonb_build_object(
        'kind', 'storage-row-inventory',
        'identity', format('storage.%I/all-rows', relation_name),
        'definition', jsonb_build_object(
          'rowCount', row_count,
          'rowsSha256', row_hash
        )
      )
    );
  end loop;
end;
$storage_row_inventories$;

insert into database_manifest_records (key, record)
select
  format('badge/%s', badge.badge_key),
  jsonb_build_object(
    'kind', 'badge',
    'identity', badge.badge_key,
    'definition', jsonb_build_object(
      'name', badge.name,
      'description', badge.description,
      'category', badge.category,
      'tier', badge.tier,
      'icon', badge.icon,
      'sortOrder', badge.sort_order
    )
  )
from public.badge_definitions badge
where to_regclass('public.badge_definitions') is not null;

do $migration_history$
begin
  if to_regclass('supabase_migrations.schema_migrations') is not null then
    insert into database_manifest_records (key, record)
    select
      format('migration-history/%s', history.version),
      jsonb_build_object(
        'kind', 'migration-history',
        'identity', history.version,
        'definition', jsonb_build_object(
          'name', history.name,
          'statementCount', coalesce(cardinality(history.statements), 0),
          'statementsSha256', encode(
            digest(
              convert_to(coalesce(array_to_string(history.statements, E'\n-- statement boundary --\n'), ''), 'UTF8'),
              'sha256'
            ),
            'hex'
          )
        )
      )
    from supabase_migrations.schema_migrations history;
  end if;
end;
$migration_history$;

select jsonb_build_object(
  'key', manifest.key,
  'kind', manifest.record ->> 'kind',
  'identity', manifest.record ->> 'identity',
  'definition', manifest.record -> 'definition'
)::text
from database_manifest_records manifest
order by manifest.key collate "C";

commit;
