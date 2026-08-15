create role reconciliation_storage_column_reader nologin;
grant select (id)
  on storage.buckets
  to reconciliation_storage_column_reader;
