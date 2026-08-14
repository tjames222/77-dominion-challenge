\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on
\pset pager off

create temporary table baseline_data_fingerprints (
  key text primary key,
  record jsonb not null
);

begin transaction read only;
set local statement_timeout = '60s';
set local lock_timeout = '5s';

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

insert into baseline_data_fingerprints (key, record)
select
  'data/storage.objects/application-buckets',
  jsonb_build_object(
    'kind', 'data-fingerprint',
    'identity', 'storage.objects/application-buckets',
    'definition', jsonb_build_object(
      'rowCount', count(*),
      'rowsSha256', encode(
        digest(
          convert_to(
            coalesce(
              string_agg(
                encode(digest(convert_to(to_jsonb(object_value)::text, 'UTF8'), 'sha256'), 'hex'),
                '' order by to_jsonb(object_value)::text collate "C"
              ),
              ''
            ),
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      )
    )
  )
from storage.objects object_value
where object_value.bucket_id in (
  'journal-progress',
  'profile-photos',
  'community-post-images',
  'reward-downloads'
);

select jsonb_build_object(
  'key', fingerprint.key,
  'kind', fingerprint.record ->> 'kind',
  'identity', fingerprint.record ->> 'identity',
  'definition', fingerprint.record -> 'definition'
)::text
from baseline_data_fingerprints fingerprint
order by fingerprint.key collate "C";

commit;
