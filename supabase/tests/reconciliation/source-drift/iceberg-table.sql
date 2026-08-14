set local session_replication_role = replica;

insert into storage.iceberg_tables (
  id,
  namespace_id,
  bucket_name,
  name,
  location,
  catalog_id
)
values (
  'f7500000-0000-4000-8000-000000000004',
  'f7500000-0000-4000-8000-000000000005',
  'reconciliation-orphan-analytics-bucket',
  'reconciliation-table',
  's3://reconciliation/orphan-table',
  'f7500000-0000-4000-8000-000000000006'
);

set local session_replication_role = origin;
