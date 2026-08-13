create or replace function supabase_migrations.__reject_atomicity_probe_history()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.version = '99999999999999' then
    raise exception 'forced_atomicity_probe_history_failure'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists reject_atomicity_probe_history
  on supabase_migrations.schema_migrations;

create trigger reject_atomicity_probe_history
before insert on supabase_migrations.schema_migrations
for each row
execute function supabase_migrations.__reject_atomicity_probe_history();

do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgrelid = 'supabase_migrations.schema_migrations'::regclass
      and tgname = 'reject_atomicity_probe_history'
      and not tgisinternal
  ) then
    raise exception 'The migration-history rejection trigger was not installed.';
  end if;
end;
$$;
