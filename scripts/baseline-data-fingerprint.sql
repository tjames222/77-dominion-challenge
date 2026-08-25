\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on
\pset pager off

create temporary table baseline_data_fingerprints (
  key text primary key,
  record jsonb not null
);

create temporary table fingerprint_platform_relation_inventory (
  schema_name text not null,
  relation_name text not null,
  required boolean not null,
  relation_oid oid,
  primary key (schema_name, relation_name)
);

begin transaction read only;
set local statement_timeout = '60s';
set local lock_timeout = '5s';

insert into fingerprint_platform_relation_inventory (
  schema_name,
  relation_name,
  required,
  relation_oid
)
select
  relation_value.schema_name,
  relation_value.relation_name,
  relation_value.required,
  pg_catalog.to_regclass(pg_catalog.format(
    '%I.%I',
    relation_value.schema_name,
    relation_value.relation_name
  ))
from (values
  ('storage', 'buckets', true),
  ('storage', 'buckets_analytics', true),
  ('storage', 'buckets_vectors', true),
  ('storage', 'iceberg_namespaces', false),
  ('storage', 'iceberg_tables', false),
  ('storage', 'objects', true),
  ('storage', 's3_multipart_uploads', true),
  ('storage', 's3_multipart_uploads_parts', true),
  ('storage', 'vector_indexes', true)
) relation_value(schema_name, relation_name, required);

do $fingerprint_platform_relation_preflight$
declare
  missing_relations text;
begin
  select string_agg(
    pg_catalog.format('%I.%I', inventory.schema_name, inventory.relation_name),
    ', ' order by inventory.schema_name collate "C", inventory.relation_name collate "C"
  )
  into missing_relations
  from fingerprint_platform_relation_inventory inventory
  where inventory.required
    and inventory.relation_oid is null;

  if missing_relations is not null then
    raise exception using
      errcode = 'P0001',
      message = pg_catalog.format(
        'Baseline fingerprint refused: required platform relation(s) are absent: %s.',
        missing_relations
      );
  end if;
end;
$fingerprint_platform_relation_preflight$;

do $block$
declare
  table_value record;
  row_count bigint;
  row_hash text;
begin
  for table_value in
    select namespace.nspname as schema_name, relation.relname as relation_name
    from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relkind in ('r', 'p')
      and relation.relname <> 'badge_definitions'
      -- The baseline intentionally removes this table only after proving it is
      -- empty. Its row-count preflight is tested separately; no surviving data
      -- can be fingerprinted after the approved DROP RESTRICT.
      and not (namespace.nspname = 'public' and relation.relname = 'purchases')
    order by namespace.nspname, relation.relname
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
        from %I.%I source_row
      $query$,
      table_value.schema_name,
      table_value.relation_name
    ) into row_count, row_hash;

    insert into baseline_data_fingerprints (key, record)
    values (
      format('data/%I.%I', table_value.schema_name, table_value.relation_name),
      jsonb_build_object(
        'kind', 'data-fingerprint',
        'identity', format('%I.%I', table_value.schema_name, table_value.relation_name),
        'definition', jsonb_build_object('rowCount', row_count, 'rowsSha256', row_hash)
      )
    );
  end loop;
end;
$block$;

-- Fingerprint every data-bearing relation in the pinned local Storage metadata
-- model. Parent and child relations remain independent so an orphaned
-- multipart part, vector index, or Iceberg catalog row is still observable.
do $storage_data_fingerprints$
declare
  relation_name text;
  relation_oid oid;
  row_count bigint;
  row_hash text;
begin
  for relation_name, relation_oid in
    select inventory.relation_name, inventory.relation_oid
    from fingerprint_platform_relation_inventory inventory
    order by inventory.relation_name collate "C"
  loop
    if relation_oid is null then
      row_count := 0;
      row_hash := encode(digest(convert_to('', 'UTF8'), 'sha256'), 'hex');
    else
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
          from %s source_row
        $query$,
        relation_oid::regclass
      ) into row_count, row_hash;
    end if;

    insert into baseline_data_fingerprints (key, record)
    values (
      format('data/storage.%s/all-rows', relation_name),
      jsonb_build_object(
        'kind', 'data-fingerprint',
        'identity', format('storage.%I/all-rows', relation_name),
        'definition', jsonb_build_object(
          'rowCount', row_count,
          'rowsSha256', row_hash
        )
      )
    );
  end loop;
end;
$storage_data_fingerprints$;

select jsonb_build_object(
  'key', fingerprint.key,
  'kind', fingerprint.record ->> 'kind',
  'identity', fingerprint.record ->> 'identity',
  'definition', fingerprint.record -> 'definition'
)::text
from baseline_data_fingerprints fingerprint
order by fingerprint.key collate "C";

commit;
