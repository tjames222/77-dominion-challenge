create or replace function storage.foldername(name text)
returns text[]
language sql
immutable
as $$
  select array['manifest-drift']::text[];
$$;
