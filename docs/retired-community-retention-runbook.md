# Retired Community retention runbook

FOU-564 provides an operator-only, export-first lifecycle for the private-group posts, comments, reactions, and `community-post-images` objects retired by FOU-543. It does not schedule or perform a production purge. The migration ships with `purge_approved = false` and a not-before timestamp of October 20, 2026.

The public application, authenticated users, and anonymous users cannot call these RPCs. Invoke them only from a secured server or administrative database session using the Supabase service role. Never place the service-role key in browser code, shell history, tickets, logs, or exported bundles.

## Safety contract

- `preview_retired_community_retention` is read-only and is the default planning step.
- A preview or export contains at most 250 posts, further limited by the configured policy.
- Only retired `scope = 'crew'` posts older than the FOU-543 cutover are eligible. Journal tables and the `journal-progress` bucket are never queried or changed.
- `create_retired_community_export_run` pins the exact post IDs, cutoff, and post/comment/like/image counts without deleting anything.
- The full relational export is returned only by `export_retired_community_run`; save it in approved encrypted storage. Download and preserve every referenced image object before proving the export.
- `prove_retired_community_export` requires the external bundle's lowercase 64-character SHA-256 and the four recorded counts.
- Execution also requires a separately audited policy approval, an open not-before window, the same operator and digest, and the exact phrase `DELETE EXPORTED RETIRED COMMUNITY DATA`.
- If a referenced object still exists in `community-post-images`, execution returns `storage_cleanup_required` plus at most 250 paths and deletes zero database rows. Remove those exact objects through the Supabase Storage API, verify the removal, and retry.
- Once no referenced objects remain, deleting each pinned post cascades its comments and likes in one transaction. Any source or count drift aborts the transaction.
- Audit rows contain operational metadata and counts, never post bodies, comment bodies, image paths, or export bundles. A trigger rejects audit updates and deletes.

## Procedure

1. Record the approved change, operator, retention cutoff, storage destination, and rollback owner in the release ticket.
2. Run a read-only preview and review its cutoff and counts:

   ```sql
   select public.preview_retired_community_retention(
     target_cutoff_at => '2026-07-20 12:00:00+00',
     target_batch_size => 250
   );
   ```

3. Create one bounded export run. Keep its `runId`:

   ```sql
   select public.create_retired_community_export_run(
     target_requested_by => 'operator-id',
     target_cutoff_at => '2026-07-20 12:00:00+00',
     target_batch_size => 250
   );
   ```

4. Call `export_retired_community_run(runId)`, write the JSON to approved encrypted storage, and download all referenced `community-post-images` objects. Build one manifest for the JSON and blobs; compute its SHA-256 outside the database. Verify that the bundle can be read before continuing.
5. Prove the export with its digest and the exact four counts returned when the run was created:

   ```sql
   select public.prove_retired_community_export(
     target_run_id => '<run-id>',
     target_requested_by => 'operator-id',
     target_export_sha256 => '<64-lowercase-hex>',
     target_post_count => 1,
     target_comment_count => 2,
     target_like_count => 3,
     target_image_count => 1
   );
   ```

6. Only after approval, open the not-before window with `configure_retired_community_retention`. Use the ticket or change-control identifier as `target_approval_reference`. A second operator should verify the policy result before execution.
7. Invoke `execute_retired_community_retention` with the exact confirmation phrase. A `storage_cleanup_required` result is expected when image objects remain. Remove only the returned paths via the Storage API; never delete the bucket.
8. Retry the same execution call. Confirm `status = completed`, reconcile deleted counts against the export, and review the metadata audit. Disable purge approval immediately after the approved batch.

## Failure and recovery

- A preview can be rerun because it creates no state.
- An export run remains stable and can be exported or proven again. Do not create a replacement run for the same records.
- A digest, count, operator, ownership, source-drift, policy, not-before, or confirmation failure deletes nothing.
- A Storage blocker deletes nothing from Postgres. If Storage removal is partial, retry removal for the returned paths, then retry the same run.
- Relational deletion is transactional. A count mismatch rolls back the entire batch.
- To stop all execution, call `configure_retired_community_retention` with `target_purge_approved => false`; record the incident or change reference outside the database.

Production execution requires a separate approved operational change. Deploying FOU-564 alone is not approval to delete retained data.
