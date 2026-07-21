-- Retire future scheduled misses without rewriting finalized historical Check-Ins.

update public.challenge_entries draft
set
  scheduled_miss = false,
  updated_at = now()
where draft.scheduled_miss
  and not exists (
    select 1
    from public.check_ins finalized
    where finalized.user_id = draft.user_id
      and finalized.entry_date = draft.entry_date
      and finalized.status = 'scheduled'
  );

create or replace function public.reject_scheduled_miss_draft()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.scheduled_miss then
    raise exception 'Scheduled miss days are no longer supported.' using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists reject_scheduled_miss_draft_write on public.challenge_entries;
create trigger reject_scheduled_miss_draft_write
  before insert or update of scheduled_miss on public.challenge_entries
  for each row execute function public.reject_scheduled_miss_draft();

revoke insert, update on public.challenge_entries from authenticated;
grant select on public.challenge_entries to authenticated;
grant insert (user_id, entry_date, completed) on public.challenge_entries to authenticated;
grant update (user_id, entry_date, completed) on public.challenge_entries to authenticated;

create or replace function public.reject_scheduled_check_in()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'scheduled' then
    raise exception 'Scheduled miss Check-Ins are no longer supported.' using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists block_scheduled_check_in_write on public.check_ins;
create trigger block_scheduled_check_in_write
  before insert or update of status on public.check_ins
  for each row execute function public.reject_scheduled_check_in();
