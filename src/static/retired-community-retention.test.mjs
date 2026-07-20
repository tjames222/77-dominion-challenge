import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const migrationsDirectory = new URL('../../supabase/migrations/', import.meta.url);
const migrationSql = readdirSync(migrationsDirectory)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => readFileSync(new URL(name, migrationsDirectory), 'utf8'))
  .join('\n');
const canonicalSchema = readFileSync(
  new URL('../../supabase/schema.sql', import.meta.url),
  'utf8',
);
const p4Migration = readFileSync(
  new URL('../../supabase/migrations/20260720140000_retired_community_p4.sql', import.meta.url),
  'utf8',
);
const worker = readFileSync(
  new URL('../../supabase/functions/process-retired-community-deletions/index.ts', import.meta.url),
  'utf8',
);
const authoredExport = readFileSync(
  new URL('../../supabase/functions/retired-community-export/index.ts', import.meta.url),
  'utf8',
);

describe('retired Community retention safety', () => {
  test('statically forbids deleting Storage catalog rows from SQL', () => {
    assert.doesNotMatch(migrationSql, /delete\s+from\s+storage\.objects/i);
    assert.doesNotMatch(canonicalSchema, /delete\s+from\s+storage\.objects/i);
    assert.match(worker, /\.from\(claim\.bucket_id\)\.remove\(\[/);
    assert.match(p4Migration, /verify_retired_community_storage_work/);
    assert.match(worker, /offset \+= files\.length/);
    assert.match(worker, /const scanBucketId = "community-post-images"/);
    assert.match(worker, /"profile-photos"/);
    assert.match(worker, /"journal-progress"/);
  });

  test('preserves the four stable claim and confirmation interfaces', () => {
    for (const signature of [
      /claim_retired_community_storage_work\(\s*target_batch_id uuid,\s*target_worker_token uuid,\s*target_limit integer default 100/s,
      /confirm_retired_community_storage_work\(\s*target_batch_id uuid,\s*target_work_id uuid,\s*target_worker_token uuid,\s*target_actor text/s,
      /claim_retired_community_credential_work\(\s*target_batch_id uuid,\s*target_worker_token uuid,\s*target_limit integer default 20/s,
      /confirm_retired_community_credential_work\(\s*target_batch_id uuid,\s*target_work_id uuid,\s*target_worker_token uuid,\s*target_actor text,\s*target_provider_revocation_reference text/s,
    ]) {
      assert.match(canonicalSchema, signature);
    }
  });

  test('keeps purge manifests redacted and count/digest-only', () => {
    const manifestTable = p4Migration.match(
      /create table private\.retired_community_purge_manifests \(([\s\S]*?)\n\);/,
    )?.[1] || '';
    assert.match(manifestTable, /manifest_sha256 text/);
    assert.match(manifestTable, /object_count bigint/);
    assert.doesNotMatch(manifestTable, /\b(?:body|content|email|object_name|attachment_path|object_bytes)\b/i);
    assert.match(manifestTable, /expires_at = executed_at \+ interval '180 days'/);
  });

  test('requires two exact bucket scans and a seven-day separation', () => {
    assert.match(p4Migration, /complete exact bucket scan/);
    assert.match(p4Migration, /interval '7 days'/);
    assert.match(p4Migration, /referenced_post_count = 0/);
    assert.match(p4Migration, /A scan bound to a deletion batch cannot be replaced/);
    assert.match(p4Migration, /lock table storage\.objects in share mode/);
    assert.match(p4Migration, /retired-community-orphan-scan/);
  });

  test('normalizes three independent operators and keeps terminal approval closed', () => {
    assert.match(p4Migration, /The backup verifier must be independent from the requester/);
    assert.match(p4Migration, /The approver must be independent from the requester and backup verifier/);
    assert.match(p4Migration, /A terminal deletion batch cannot be approved/);
    assert.match(p4Migration, /normalize_retired_community_operator/);
    assert.match(p4Migration, /where id = target_batch_id and sealed for update/);
  });

  test('allows authenticated restrictive policies to evaluate DR quarantine', () => {
    assert.match(
      p4Migration,
      /grant execute on function public\.retired_community_crew_is_quarantined\(uuid\)\s+to authenticated/,
    );
    assert.match(p4Migration, /DR quarantine hides restored crews/);
    assert.match(p4Migration, /DR quarantine hides restored crew members/);
    assert.match(p4Migration, /DR quarantine hides restored account memberships/);
    assert.match(p4Migration, /banned_until = 'infinity'/);
  });

  test('records retry exhaustion and account-erasure deadline signals', () => {
    assert.match(worker, /fail_retired_community_work/);
    assert.match(p4Migration, /storage_retry_exhausted/);
    assert.match(p4Migration, /credential_retry_exhausted/);
    assert.match(p4Migration, /accountErasuresDueSoon/);
    assert.match(p4Migration, /accountErasuresOverdue/);
    assert.match(
      p4Migration,
      /grant execute on function public\.fail_retired_community_work\(text,uuid,uuid,uuid,text\)\s+to service_role/,
    );
  });

  test('serializes deletion scope changes and freezes post-seal mutations', () => {
    assert.match(p4Migration, /a_lock_retired_community_mutation_scope_when_creating/);
    assert.match(p4Migration, /lock table storage\.objects in share mode/);
    assert.match(p4Migration, /lock table private\.outbound_deliveries in share mode/);
    assert.match(p4Migration, /lock table private\.integration_destinations in share mode/);
    assert.match(p4Migration, /Storage assets are frozen while account erasure is pending/);
    assert.match(p4Migration, /Integration credentials are frozen while group deletion is pending/);
    assert.match(p4Migration, /Outbound delivery is blocked while account erasure is pending/);
    assert.match(
      p4Migration,
      /\(to_jsonb\(new\) ->> 'actor'\) = 'redacted-after-retention'/,
    );
    assert.doesNotMatch(p4Migration, /\band new\.actor = 'redacted-after-retention'/);
  });

  test('handles credentialless destinations and DR evidence expiry without wedging', () => {
    assert.match(p4Migration, /provider_revocation_reference = 'already-credentialless'/);
    assert.match(p4Migration, /destination\.credential_ciphertext is null/);
    assert.match(
      p4Migration,
      /reapplication\.source_batch_id = manifest\.batch_id\s+and reapplication\.reapplied_at is null/,
    );
    assert.match(p4Migration, /assert_retired_community_batch_evidence_complete/);
    assert.match(
      p4Migration,
      /perform private\.assert_retired_community_batch_evidence_complete\(batch_row\.id\)/,
    );
  });

  test('seals all account-owned Storage assets before deleting auth identity', () => {
    assert.match(p4Migration, /'profile-photos', 'journal-progress'/);
    assert.match(p4Migration, /subject-owned unreferenced Community uploads|referenced_post\.image_path = object_row\.name/);
    assert.match(
      p4Migration,
      /if batch_row\.reason = 'account_erasure'[\s\S]*delete from auth\.users where id = batch_row\.subject_user_id/,
    );
    assert.match(p4Migration, /cancel_retired_community_account_deliveries_when_sealing/);
  });

  test('purges direct T0 identities only after exact aged evidence expires', () => {
    const purgeRecord = p4Migration.match(
      /create table private\.retired_community_t0_purge_records \(([\s\S]*?)\n\);/,
    )?.[1] || '';
    assert.match(purgeRecord, /t0_source_sha256 text/);
    assert.match(purgeRecord, /record_sha256 text/);
    assert.doesNotMatch(
      purgeRecord,
      /\b(?:author_id|user_id|owner_id|crew_id|object_name|post_id|comment_id|referenced_post_ids)\b/,
    );
    assert.match(p4Migration, /delete from private\.retired_community_t0_post_inventory/);
    assert.match(p4Migration, /T0 identity retention cannot close without the exact executed aged batch/);
    const batchRedaction = p4Migration.match(
      /create table private\.retired_community_batch_identity_redactions \(([\s\S]*?)\n\);/,
    )?.[1] || '';
    assert.doesNotMatch(
      batchRedaction,
      /\b(?:requested_by|subject_user_id|crew_id|actor|verified_by|approved_by)\b/,
    );
    assert.match(p4Migration, /requested_by = 'redacted-after-retention'/);
    assert.match(p4Migration, /set actor = 'redacted-after-retention'/);
    assert.match(p4Migration, /cancellation\.event_at \+ interval '180 days'/);
  });

  test('prevents orphan work overlap and late image references', () => {
    assert.match(p4Migration, /block_pending_retired_community_image_reference/);
    assert.match(p4Migration, /Orphan deletion object acquired a current post reference/);
    assert.match(p4Migration, /active_work\.object_name = second_item\.object_name/);
    assert.match(p4Migration, /active_batch\.id <> new_batch_id/);
  });

  test('authored attachment signing accepts no path or user parameters', () => {
    assert.match(authoredExport, /export_own_retired_community_content/);
    assert.match(authoredExport, /This export does not accept request parameters/);
    assert.match(authoredExport, /parts\[1\] !== userId/);
    assert.match(authoredExport, /createSignedUrl\(path, signedUrlLifetimeSeconds/);
    assert.doesNotMatch(authoredExport, /body\.(?:path|userId)|target_user_id|target_path/);
  });
});
