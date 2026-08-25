-- A journal date is a grouping key, not the identity of an entry. Members can
-- write more than once on the same day, and individual entries remain
-- addressable through their immutable primary keys.
alter table public.journal_entries
  drop constraint if exists journal_entries_user_id_entry_date_key;

drop index if exists public.journal_entries_user_date_idx;

create index journal_entries_user_date_created_id_idx
  on public.journal_entries (
    user_id,
    entry_date desc,
    created_at desc,
    id desc
  );

comment on table public.journal_entries is
  'Private text journal entries. A member may create multiple independently editable entries per date.';
