-- FOU-761: provide one authenticated, auditable intake for data-export and
-- account-deletion requests. Members can create and read only their own rows;
-- fulfillment remains an operator-only workflow.

create table public.account_lifecycle_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  request_type text not null
    check (request_type in ('data_export', 'account_deletion')),
  status text not null default 'requested'
    check (status in ('requested', 'in_progress', 'fulfilled', 'cancelled', 'declined')),
  requested_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  operator_note text,
  constraint account_lifecycle_requests_resolution_check check (
    (status in ('requested', 'in_progress') and resolved_at is null)
    or (status in ('fulfilled', 'cancelled', 'declined') and resolved_at is not null)
  )
);

comment on table public.account_lifecycle_requests is
  'Member-visible intake and status ledger for account data exports and account deletion requests.';
comment on column public.account_lifecycle_requests.user_id is
  'Authenticated requester. Set to null when auth deletion completes so the status row is retained without a live account identifier.';
comment on column public.account_lifecycle_requests.operator_note is
  'Short member-safe fulfillment note. Never store exported data, credentials, object paths, or private operational evidence here.';

create unique index account_lifecycle_requests_one_active_kind_idx
  on public.account_lifecycle_requests (user_id, request_type)
  where user_id is not null and status in ('requested', 'in_progress');

create index account_lifecycle_requests_user_requested_idx
  on public.account_lifecycle_requests (user_id, requested_at desc, id desc)
  where user_id is not null;

create trigger set_account_lifecycle_requests_updated_at
  before update on public.account_lifecycle_requests
  for each row execute function public.set_updated_at();

alter table public.account_lifecycle_requests enable row level security;
alter table public.account_lifecycle_requests force row level security;

create policy "Members can read own account requests"
  on public.account_lifecycle_requests
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Members can create own account requests"
  on public.account_lifecycle_requests
  for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and status = 'requested'
    and resolved_at is null
    and operator_note is null
  );

revoke all on table public.account_lifecycle_requests from public, anon, authenticated;
grant select on table public.account_lifecycle_requests to authenticated;
grant insert (user_id, request_type) on table public.account_lifecycle_requests to authenticated;
grant all on table public.account_lifecycle_requests to service_role;
