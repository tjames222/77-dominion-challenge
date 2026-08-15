set local session_replication_role = replica;

insert into storage.s3_multipart_uploads_parts (
  id,
  upload_id,
  size,
  part_number,
  bucket_id,
  key,
  etag,
  owner_id,
  version
)
values (
  'f7500000-0000-4000-8000-000000000001',
  'reconciliation-orphan-upload',
  1,
  1,
  'journal-progress',
  'reconciliation/orphan-part',
  'reconciliation-etag',
  null,
  'reconciliation-version'
);

set local session_replication_role = origin;
