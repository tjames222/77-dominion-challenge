#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository_root"

database_url="${SUPABASE_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"

case "$database_url" in
  postgresql://*@127.0.0.1:54322/*|postgres://*@127.0.0.1:54322/*|postgresql://*@localhost:54322/*|postgres://*@localhost:54322/*)
    ;;
  *)
    echo "Refusing to run the schema-drift check against a non-local database." >&2
    exit 2
    ;;
esac

for command_name in psql createdb dropdb; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "$command_name is required for the schema-drift check." >&2
    exit 2
  fi
done

if [[ -x "$repository_root/node_modules/.bin/supabase" ]]; then
  supabase_cli="$repository_root/node_modules/.bin/supabase"
elif command -v supabase >/dev/null 2>&1; then
  supabase_cli="$(command -v supabase)"
else
  echo "Supabase CLI is required for the schema-drift check." >&2
  exit 2
fi

work_directory="$(mktemp -d)"
temp_database="schema_drift_${RANDOM}_$$"
database_url_without_query="${database_url%%\?*}"
temp_database_url="${database_url_without_query%/*}/$temp_database"
temp_database_created=0

cleanup() {
  exit_status=$?
  if (( temp_database_created == 1 )); then
    dropdb --if-exists --maintenance-db="$database_url" "$temp_database" >/dev/null 2>&1 || {
      echo "Warning: failed to remove local temporary database $temp_database." >&2
    }
  fi
  rm -rf "$work_directory"
  exit "$exit_status"
}
trap cleanup EXIT

# Reset first so the source snapshot is always the result of a clean migration
# replay, not a developer's manually modified local database.
"$supabase_cli" db reset --local

createdb --maintenance-db="$database_url" --template=template0 "$temp_database"
temp_database_created=1

# Canonical schema.sql references Supabase-owned auth and storage objects. The
# isolated database only needs these minimal dependency shapes because the
# comparison below is restricted to public/private application objects.
psql "$temp_database_url" --set=ON_ERROR_STOP=1 --quiet <<'SQL'
create schema extensions;
create extension pgcrypto with schema extensions;

create schema auth;
create table auth.users (
  id uuid primary key,
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);
create function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
create function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
$$;

create schema storage;
create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text,
  name text not null,
  owner uuid
);
alter table storage.objects enable row level security;
create function storage.foldername(name text)
returns text[]
language sql
immutable
as $$
  select string_to_array(name, '/');
$$;
SQL

PGOPTIONS="-c search_path=public,extensions" \
  psql "$temp_database_url" --set=ON_ERROR_STOP=1 --quiet --file=supabase/schema.sql >/dev/null

snapshot_query=$(cat <<'SQL'
with structural_records as (
  select format(
    'relation|%I.%I|kind=%s|rls=%s|forcerls=%s|acl=%s',
    schema_row.nspname,
    relation_row.relname,
    relation_row.relkind,
    relation_row.relrowsecurity,
    relation_row.relforcerowsecurity,
    coalesce(relation_row.relacl::text, '')
  ) as record
  from pg_class relation_row
  join pg_namespace schema_row on schema_row.oid = relation_row.relnamespace
  where schema_row.nspname in ('public', 'private')
    and relation_row.relkind in ('r', 'p', 'v', 'm', 'S')

  union all

  select format(
    'column|%I.%I.%I|type=%s|notnull=%s|identity=%s|generated=%s|default=%s|acl=%s',
    schema_row.nspname,
    relation_row.relname,
    column_row.attname,
    format_type(column_row.atttypid, column_row.atttypmod),
    column_row.attnotnull,
    column_row.attidentity,
    column_row.attgenerated,
    coalesce(pg_get_expr(default_row.adbin, default_row.adrelid), ''),
    coalesce(column_row.attacl::text, '')
  )
  from pg_attribute column_row
  join pg_class relation_row on relation_row.oid = column_row.attrelid
  join pg_namespace schema_row on schema_row.oid = relation_row.relnamespace
  left join pg_attrdef default_row
    on default_row.adrelid = column_row.attrelid
   and default_row.adnum = column_row.attnum
  where schema_row.nspname in ('public', 'private')
    and relation_row.relkind in ('r', 'p', 'v', 'm', 'S')
    and column_row.attnum > 0
    and not column_row.attisdropped

  union all

  select format(
    'constraint|%I.%I|type=%s|definition=%s',
    schema_row.nspname,
    relation_row.relname,
    constraint_row.contype,
    replace(pg_get_constraintdef(constraint_row.oid, true), ' NOT VALID', '')
  )
  from pg_constraint constraint_row
  join pg_class relation_row on relation_row.oid = constraint_row.conrelid
  join pg_namespace schema_row on schema_row.oid = relation_row.relnamespace
  where schema_row.nspname in ('public', 'private')

  union all

  select format(
    'index|%I.%I|definition=%s',
    schema_row.nspname,
    index_row.relname,
    pg_get_indexdef(index_row.oid)
  )
  from pg_index index_metadata
  join pg_class index_row on index_row.oid = index_metadata.indexrelid
  join pg_class table_row on table_row.oid = index_metadata.indrelid
  join pg_namespace schema_row on schema_row.oid = table_row.relnamespace
  where schema_row.nspname in ('public', 'private')

  union all

  select format(
    'function|%I.%I(%s)|definition=%s|acl=%s',
    schema_row.nspname,
    procedure_row.proname,
    pg_get_function_identity_arguments(procedure_row.oid),
    encode(convert_to(pg_get_functiondef(procedure_row.oid), 'UTF8'), 'hex'),
    coalesce(procedure_row.proacl::text, '')
  )
  from pg_proc procedure_row
  join pg_namespace schema_row on schema_row.oid = procedure_row.pronamespace
  where schema_row.nspname in ('public', 'private')

  union all

  select format(
    'trigger|%I.%I.%I|definition=%s',
    schema_row.nspname,
    relation_row.relname,
    trigger_row.tgname,
    pg_get_triggerdef(trigger_row.oid, true)
  )
  from pg_trigger trigger_row
  join pg_class relation_row on relation_row.oid = trigger_row.tgrelid
  join pg_namespace schema_row on schema_row.oid = relation_row.relnamespace
  where schema_row.nspname in ('public', 'private')
    and not trigger_row.tgisinternal

  union all

  select format(
    'policy|%I.%I.%I|command=%s|roles=%s|qual=%s|check=%s',
    schema_row.nspname,
    relation_row.relname,
    policy_row.polname,
    policy_row.polcmd,
    policy_row.polroles::text,
    coalesce(pg_get_expr(policy_row.polqual, policy_row.polrelid), ''),
    coalesce(pg_get_expr(policy_row.polwithcheck, policy_row.polrelid), '')
  )
  from pg_policy policy_row
  join pg_class relation_row on relation_row.oid = policy_row.polrelid
  join pg_namespace schema_row on schema_row.oid = relation_row.relnamespace
  where schema_row.nspname in ('public', 'private')
     or (
       schema_row.nspname = 'storage'
       and policy_row.polname in (
         'Profile photos are publicly readable',
         'Users can upload own profile photo objects',
         'Users can update own profile photo objects',
         'Users can delete own profile photo objects',
         'Crew members can read community post images',
         'Crew members can upload own community post images',
         'Authors and crew leaders can delete community post images',
         'Users can read own journal photo objects',
         'Users can upload own journal photo objects',
         'Users can update own journal photo objects',
         'Users can delete own journal photo objects'
       )
     )

  union all

  select format(
    'storage-bucket|%s|name=%s|public=%s|file-size-limit=%s|allowed-mime-types=%s',
    bucket.id,
    bucket.name,
    bucket.public,
    coalesce(bucket.file_size_limit::text, ''),
    coalesce(bucket.allowed_mime_types::text, '')
  )
  from storage.buckets bucket
  where bucket.id in ('profile-photos', 'community-post-images', 'journal-progress')
)
select record
from structural_records
order by record;
SQL
)

psql "$database_url" --set=ON_ERROR_STOP=1 --tuples-only --no-align --command "$snapshot_query" \
  >"$work_directory/migrations.snapshot"
psql "$temp_database_url" --set=ON_ERROR_STOP=1 --tuples-only --no-align --command "$snapshot_query" \
  >"$work_directory/canonical.snapshot"

if ! diff -u "$work_directory/migrations.snapshot" "$work_directory/canonical.snapshot" \
  >"$work_directory/schema.diff"; then
  echo "Migration replay and supabase/schema.sql have structural drift:" >&2
  cat "$work_directory/schema.diff" >&2
  exit 1
fi

echo "Migration replay and supabase/schema.sql have matching application structures and Storage policies."
