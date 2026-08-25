# FOU-759 production Storage inventory

- Project: `77-dominion-challenge` (`mimolwojppbtsbvtqwpo`)
- Region/database: `us-west-2`, Postgres `17.6.1.141`
- Project status: `ACTIVE_HEALTHY`
- Read-only inventory window: 2026-07-22 15:30–15:54 UTC
- Operator: Codex on behalf of Tim James
- Scope: aggregate counts and schema presence only; no journal text, caption, path, or user identifier was read

## Result

| Check | Production value |
| --- | ---: |
| `public.journal_photos` exists | yes |
| Journal-photo metadata rows | 0 |
| `journal-progress` bucket rows | 1 |
| `journal-progress` objects | 0 |
| Active `journal-progress` multipart uploads | 0 |
| Journal-specific Storage policies | 4 |
| `private.retired_community_storage_work` exists | no |
| `profile-photos` bucket rows | 0 |
| `profile-photos` objects | 0 |
| `public.profiles.avatar_url` exists | no |

The deployed database predates the integrated FOU-564 and profile-avatar migrations. There is no journal-photo user data to export or delete and no profile-photo object to backfill. The empty journal bucket and its four policies can therefore be retired after the text-only frontend cutover. The full release will create FOU-564's retention tables before the final FOU-753 migration; that migration locks and rechecks nonterminal `journal-progress` work in the same transaction before dropping anything.

## Read-only queries

```sql
select jsonb_build_object(
  'journal_photos_table_exists', to_regclass('public.journal_photos') is not null,
  'retention_work_table_exists', to_regclass('private.retired_community_storage_work') is not null,
  'journal_photo_rows', (select count(*) from public.journal_photos),
  'journal_bucket_rows', (select count(*) from storage.buckets where id = 'journal-progress'),
  'journal_object_rows', (select count(*) from storage.objects where bucket_id = 'journal-progress'),
  'journal_storage_policies', (
    select count(*) from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and (coalesce(qual, '') like '%journal-progress%'
        or coalesce(with_check, '') like '%journal-progress%')
  )
);

select count(*)
from storage.s3_multipart_uploads
where bucket_id = 'journal-progress';

select jsonb_build_object(
  'profile_bucket_rows', (select count(*) from storage.buckets where id = 'profile-photos'),
  'profile_object_rows', (select count(*) from storage.objects where bucket_id = 'profile-photos'),
  'profiles_avatar_url_column_exists', exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'avatar_url'
  )
);
```

## Release gate

This record authorizes no production write. Immediately before the full backend release, rerun the journal row, object, multipart, and nonterminal-retention-work counts. Every active-data count must still be zero. Any nonzero result stops the release and requires export or an explicit retention/deletion decision; Storage objects must be removed through the Storage API, never with SQL.
