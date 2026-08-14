create role reconciliation_default_reader nologin;
alter default privileges for role postgres in schema public
  grant select on tables to reconciliation_default_reader;
