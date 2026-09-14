-- Structural dependencies for check-schema-drift.sh's disposable database only.
-- Auth field types/nullability/defaults and enum values were checked against the
-- current provider catalog on 2026-09-13. Include the fields used by intake,
-- Admin live-session/MFA checks, directory sync, and focused Daily Action SQL;
-- never copy account rows, credentials, sessions, or MFA secrets into this DB.
--
-- This remains an owner-neutral structure fixture, NOT an authorization model:
-- real Auth objects belong to supabase_auth_admin (schema: supabase_admin).
-- The migration replay and dedicated SQL tests check provider ownership/ACLs.
-- Do not change cluster roles or grant runtime roles access to Auth here.
create schema extensions;
create extension pgcrypto with schema extensions;

create schema auth;
create table auth.users (
  id uuid primary key,
  email varchar(255),
  email_confirmed_at timestamptz,
  last_sign_in_at timestamptz,
  raw_user_meta_data jsonb,
  created_at timestamptz,
  updated_at timestamptz,
  banned_until timestamptz,
  deleted_at timestamptz,
  is_anonymous boolean not null default false
);

create type auth.aal_level as enum ('aal1', 'aal2', 'aal3');
create type auth.factor_type as enum ('totp', 'webauthn', 'phone');
create type auth.factor_status as enum ('unverified', 'verified');
create table auth.sessions (
  id uuid primary key,
  user_id uuid not null,
  created_at timestamptz,
  updated_at timestamptz,
  factor_id uuid,
  aal auth.aal_level,
  not_after timestamptz
);
create table auth.mfa_factors (
  id uuid primary key,
  user_id uuid not null,
  factor_type auth.factor_type not null,
  status auth.factor_status not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create table auth.mfa_amr_claims (
  id uuid primary key,
  session_id uuid not null,
  authentication_method text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
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
