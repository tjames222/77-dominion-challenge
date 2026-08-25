set local session_replication_role = replica;

insert into storage.iceberg_namespaces (
  id,
  bucket_name,
  name,
  catalog_id
)
values (
  '10000000-0000-4000-8000-000000000001',
  'journal-progress',
  'reconciliation_nonempty_inventory',
  '10000000-0000-4000-8000-000000000002'
);
