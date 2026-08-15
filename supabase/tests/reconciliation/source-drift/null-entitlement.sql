alter table public.entitlements
  drop constraint entitlements_entitlement_key_check;
alter table public.entitlements
  drop constraint entitlements_pkey;
alter table public.entitlements
  alter column entitlement_key drop not null;

insert into public.entitlements (
  user_id,
  entitlement_key,
  status,
  source_type,
  source_id,
  created_at,
  updated_at
) values (
  '90000000-0000-4000-8000-000000000009',
  null,
  'active',
  'rehearsal',
  'legacy-null-entitlement',
  '2026-08-13 12:00:00+00',
  '2026-08-13 12:00:00+00'
);
