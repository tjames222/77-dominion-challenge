# Retired Community social-data retention policy

- Status: approved product and engineering baseline for FOU-559
- Decision date: 2026-07-19
- Product owner: Tim James
- Engineering owner: Foundation Technology
- Destructive-run approver: product owner plus the engineer executing the production runbook

## Decision

Dominion is permanently retiring in-app Community conversations. The product may hide those surfaces before any rows or objects are deleted, but hiding a feature is not permission to destroy its data.

At the conversation cutover (`T0`):

1. All application and database read/write paths for retired posts, comments, reactions, and attachments are disabled.
2. Users have 30 calendar days to request an export of content they authored.
3. The retained copy is rollback-only from day 31 through day 90. It must not be exposed through the product or reused for analytics, training, advertising, or a future Community launch.
4. A verified purge starts no earlier than day 91. Primary-database rows and matching objects must be removed in bounded, restartable batches.
5. Provider backups may retain already-deleted bytes for at most 30 additional days under the normal backup lifecycle. They are not searched or restored to answer product requests. A disaster recovery restore must reapply the deletion ledger before traffic resumes.

This 90-day primary retention period is the default maximum, not a reason to delay an account-deletion request or a confirmed security response.

## Retention matrix

| Data class | Current location | Product access after T0 | Primary retention | Final handling |
| --- | --- | --- | --- | --- |
| Post body, alt text, author snapshot, challenge/status metadata | `public.community_posts` | None | Through T0 + 90 days | Hard-delete in batches; child likes/comments cascade |
| Comments and commenter snapshots | `public.post_comments` | None | Through T0 + 90 days | Deleted with parent post or directly for an account request |
| Likes/reactions | `public.post_likes` | None | Through T0 + 90 days | Deleted with parent post or directly for an account request |
| Post images | Private `community-post-images` bucket | No signed URLs after T0 | Through parent purge, no later than 24 hours after its row | Delete the exact `image_path`; verify object absence |
| Orphan post images | `community-post-images` objects with no matching `image_path` | None | Seven-day quarantine from first detection | Delete after a second scan confirms the orphan |
| Export artifacts | Temporary encrypted export storage | Requesting user only | Seven days after delivery, 30 days if never downloaded | Delete object and download credential |
| Purge manifests and aggregate counts | Operations/audit store | Operators only | 180 days | Retain counts and opaque batch IDs; never retain message text, object bytes, names, or email |
| Slack/Discord delivery attempts introduced by later tickets | Integration delivery store | Group admins where needed | 30 days | Delete payload; retain only redacted aggregate reliability metrics |
| OAuth/admin security events introduced by later tickets | Integration audit store | Operators only | 180 days | Retain actor ID, action, provider, and result; exclude tokens and conversation content |
| OAuth credentials | Encrypted secrets store | Runtime only | Until disconnect, group deletion, account deletion, or revocation | Revoke provider grant and delete encrypted secret within 24 hours |

`community_feed_items` is not retired conversation data. It is a server-derived check-in/progress projection still used by the Dashboard and prospective outbound group updates. Its lifecycle remains tied to the underlying check-in policy. Private journal rows and `journal-progress` objects are also outside this decision.

## User, account, and group expectations

### User export

- A user may export posts, comments, reactions, and attachments they authored during the first 30 days after T0.
- The export must not include another member's private profile fields or authored body text merely because it appeared in the same group. Minimal post IDs and timestamps may be included where needed to give the user's comment context.
- Identity and authorization are rechecked when the export is requested and when its short-lived download is issued.
- Group owners and admins do not gain a bulk export right over other members' conversation content.

### Account deletion

- Account deletion overrides the 90-day retirement schedule.
- Database rows already reference `auth.users` with `on delete cascade`, but object storage does not. The deletion workflow must first inventory the user's `community-post-images` paths, delete the account/rows, remove the objects, and verify both systems within 24 hours.
- Any redacted audit record must replace the user ID with a one-way deletion correlation ID. Backups age out within 30 days and must not be restored for ordinary product support.

### Group deletion

- Do not expose destructive group deletion while it would invoke the current immediate `on delete cascade` behavior without a recovery record.
- A future group-deletion request gets a 30-day cancellation window. At expiry, the job inventories paths, deletes the group and cascading social rows in a transaction, removes objects, and records only redacted counts.
- Leaving a group never deletes content authored by other members. The departing user's own account/export rights remain unchanged.

## Current implementation inventory

### Database

- `public.community_posts`: global or private-group post body, author/profile snapshots, optional `image_path`, and activity metadata. Author and crew foreign keys currently cascade on deletion.
- `public.post_comments`: comment body and commenter snapshot; cascades from posts and users.
- `public.post_likes`: reaction join rows; cascades from posts and users.
- `public.can_read_community_post(uuid)`: visibility gate used by engagement policies.
- `public.get_community_post_engagement(uuid[])`: assembles reactions and comments for visible posts.
- RLS policies currently govern post, like, and comment read/write access. FOU-527 removes global access; FOU-543 removes the remaining conversation access.

### Object storage

- Private bucket `community-post-images`, 10 MiB per object, image MIME types only.
- Object paths are `<crew_id>/<author_id>/<generated filename>` and the path is stored on the post row.
- Current policies allow group-member reads/uploads and author or group-admin deletion.
- There is no database-to-storage cascade, orphan detector, quarantine marker, or scheduled cleanup job.

### Client and jobs

- `src/static/api.js` and `src/static/community.js` currently contain post pagination, signed-URL, upload, edit, delete, reaction, and comment paths.
- Post deletion attempts to remove the referenced object, but database and object deletion are not one transaction.
- No export workflow, soft-delete/tombstone column, deletion ledger, scheduled purge, `pg_cron` job, or retention Edge Function exists today.
- No Slack/Discord delivery table or OAuth secret table exists yet; later integration work must adopt the retention rows above.

## Safe rollout and destructive-run requirements

FOU-543 may remove the UI and revoke access without waiting for deletion. The purge implementation is a separate change and must meet all of these gates:

1. Record T0 and immutable pre-purge counts by scope, table, and object bucket.
2. Take and verify a restorable pre-purge backup; record its automatic expiry date.
3. Ship export support and the deletion ledger before the 30-day export window opens.
4. Dry-run every batch and report candidate row/object counts without returning message content.
5. Require explicit production approval naming the batch ceiling and backup identifier.
6. Delete child-safe database batches and exact object paths idempotently; retry partial failures.
7. Reconcile database image paths against bucket objects twice, seven days apart, before deleting confirmed orphans.
8. Verify zero product/API access immediately after T0 and verify final primary counts after day 90.
9. Publish a customer notice before T0 describing feature retirement, export deadline, and permanent deletion date.

Rollback is allowed only by restoring access controls during the first 30 days or by whole-system disaster recovery before the primary purge. Once a user's explicit deletion or the day-91 purge is verified, Dominion does not restore that conversation data into the product.
