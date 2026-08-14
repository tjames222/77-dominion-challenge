set local session_replication_role = replica;

insert into storage.vector_indexes (
  id,
  name,
  bucket_id,
  data_type,
  dimension,
  distance_metric
)
values (
  'reconciliation-vector-index',
  'reconciliation-index',
  'reconciliation-orphan-vector-bucket',
  'float32',
  3,
  'cosine'
);

set local session_replication_role = origin;
