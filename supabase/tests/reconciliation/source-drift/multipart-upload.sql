insert into storage.s3_multipart_uploads (
  id,
  upload_signature,
  bucket_id,
  key,
  version
)
values (
  'reconciliation-upload',
  'reconciliation-signature',
  'journal-progress',
  'reconciliation-fixture.txt',
  '1'
);
