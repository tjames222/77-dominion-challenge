drop trigger if exists reject_atomicity_probe_history
  on supabase_migrations.schema_migrations;
drop function if exists supabase_migrations.__reject_atomicity_probe_history();
drop table if exists public.__migration_atomicity_probe;
delete from supabase_migrations.schema_migrations
where version = '99999999999999';
