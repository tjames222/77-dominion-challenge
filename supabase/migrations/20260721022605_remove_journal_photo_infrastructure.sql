begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- A multipart upload starts in s3_multipart_uploads before it can write an
-- object, so lock and inventory that table first when the deployed Storage
-- version provides it. This prevents an in-flight upload from appearing after
-- the empty-bucket check.
do $$
declare
  journal_multipart_count bigint;
begin
  if to_regclass('storage.s3_multipart_uploads') is not null then
    execute 'lock table storage.s3_multipart_uploads in share mode';
    execute $query$
      select count(*)
      from storage.s3_multipart_uploads
      where bucket_id = 'journal-progress'
    $query$ into journal_multipart_count;

    if journal_multipart_count > 0 then
      raise exception
        'journal-progress still has % active multipart upload(s); let them finish or abort them through the Storage API before retrying',
        journal_multipart_count;
    end if;
  end if;
end
$$;

-- Do not silently delete retained media. Lock the former ordinary upload path
-- (Storage object first, journal metadata second), then fail closed if anything
-- appeared after the pre-deployment inventory.
lock table storage.objects in share mode;

do $$
declare
  journal_object_count bigint;
  journal_photo_row_count bigint;
begin
  select count(*)
    into journal_object_count
  from storage.objects
  where bucket_id = 'journal-progress';

  if journal_object_count > 0 then
    raise exception
      'journal-progress still contains % object(s); export or explicitly delete them through the Storage API before retrying',
      journal_object_count;
  end if;

  if to_regclass('public.journal_photos') is not null then
    lock table public.journal_photos in share mode;
    execute 'select count(*) from public.journal_photos'
      into journal_photo_row_count;

    if journal_photo_row_count > 0 then
      raise exception
        'public.journal_photos still contains % row(s); export or obtain an explicit retention decision before retrying',
        journal_photo_row_count;
    end if;
  end if;
end
$$;

drop policy if exists "Users can read own journal photo objects" on storage.objects;
drop policy if exists "Users can upload own journal photo objects" on storage.objects;
drop policy if exists "Users can update own journal photo objects" on storage.objects;
drop policy if exists "Users can delete own journal photo objects" on storage.objects;

-- Supabase blocks direct Storage metadata DELETE statements by default. The
-- bucket is safe to remove here only because the locked inventory above proved
-- it contains no objects; scope the Storage API escape hatch to this transaction.
set local storage.allow_delete_query = 'true';
delete from storage.buckets
where id = 'journal-progress';
set local storage.allow_delete_query = 'false';

drop table if exists public.journal_photos;

commit;
