set local session_replication_role = replica;

insert into storage.iceberg_namespaces (
  id,
  bucket_name,
  name,
  catalog_id
)
values (
  'f7500000-0000-4000-8000-000000000002',
  'reconciliation-orphan-analytics-bucket',
  'reconciliation-namespace',
  'f7500000-0000-4000-8000-000000000003'
);

set local session_replication_role = origin;
