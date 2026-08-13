do $$
begin
  if to_regclass('public.__migration_atomicity_probe') is not null then
    raise exception 'The failed migration left its DDL behind.';
  end if;

  if exists (
    select 1
    from supabase_migrations.schema_migrations
    where version = '99999999999999'
  ) then
    raise exception 'The failed migration left its history row behind.';
  end if;
end;
$$;
