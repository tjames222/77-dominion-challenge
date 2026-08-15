create policy reconciliation_changed_bucket_visibility
  on storage.buckets
  for select
  to authenticated
  using (true);
