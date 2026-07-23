begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $$
declare
  multipart_count bigint := 0;
  journal_object_count bigint := 0;
  journal_photo_row_count bigint := 0;
  nonterminal_work_count bigint := 0;
begin
  if to_regclass('storage.s3_multipart_uploads') is not null then
    execute 'lock table storage.s3_multipart_uploads in share mode';
    execute $query$
      select count(*)
      from storage.s3_multipart_uploads
      where bucket_id = 'journal-progress'
    $query$ into multipart_count;
  end if;

  lock table storage.objects in share mode;

  if to_regclass('private.retired_community_deletion_batches') is not null then
    lock table private.retired_community_deletion_batches in share mode;
  end if;
  if to_regclass('private.retired_community_storage_work') is not null then
    lock table private.retired_community_storage_work in share mode;
    select count(*) into nonterminal_work_count
    from private.retired_community_storage_work work
    where work.bucket_id = 'journal-progress'
      and work.status <> 'confirmed'
      and not exists (
        select 1
        from private.retired_community_deletion_ledger terminal
        where terminal.batch_id = work.batch_id
          and terminal.event_type in ('cancelled', 'executed')
      );
  end if;

  if to_regclass('public.journal_photos') is not null then
    lock table public.journal_photos in share mode;
    select count(*) into journal_photo_row_count from public.journal_photos;
  end if;

  select count(*) into journal_object_count
  from storage.objects
  where bucket_id = 'journal-progress';

  if multipart_count > 0 then
    raise exception
      'FOU-753 blocked: journal-progress has % active multipart upload(s). Finish or abort them through the Storage API before retrying.',
      multipart_count
      using errcode = '55000';
  end if;
  if journal_object_count > 0 then
    raise exception
      'FOU-753 blocked: journal-progress has % object(s). Export them or record an explicit retention/deletion decision, then remove them through the Storage API.',
      journal_object_count
      using errcode = '55000';
  end if;
  if journal_photo_row_count > 0 then
    raise exception
      'FOU-753 blocked: journal_photos has % metadata row(s), including possible captions. Export or explicitly disposition them before retrying.',
      journal_photo_row_count
      using errcode = '55000';
  end if;
  if nonterminal_work_count > 0 then
    raise exception
      'FOU-753 blocked: % nonterminal retired-community journal cleanup job(s) must be drained or terminally cancelled before bucket retirement.',
      nonterminal_work_count
      using errcode = '55000';
  end if;

  if to_regclass('public.journal_photos') is not null then
    execute 'drop policy if exists "Users can read own journal photos" on public.journal_photos';
    execute 'drop policy if exists "Users can insert own journal photos" on public.journal_photos';
    execute 'drop policy if exists "Users can update own journal photos" on public.journal_photos';
    execute 'drop policy if exists "Users can delete own journal photos" on public.journal_photos';
  end if;
end;
$$;

drop policy if exists "Users can read own journal photo objects" on storage.objects;
drop policy if exists "Users can upload own journal photo objects" on storage.objects;
drop policy if exists "Users can update own journal photo objects" on storage.objects;
drop policy if exists "Users can delete own journal photo objects" on storage.objects;

set storage.allow_delete_query = 'true';
delete from storage.buckets where id = 'journal-progress';
reset storage.allow_delete_query;
drop table if exists public.journal_photos;

comment on table public.journal_entries is
  'Private text-only journal entries. FOU-753 retired journal photo metadata and Storage infrastructure.';

commit;
