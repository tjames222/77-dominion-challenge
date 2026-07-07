create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  name text not null default 'Member',
  email text not null default '',
  challenge_start_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.challenge_entries (
  user_id uuid not null references auth.users(id) on delete cascade,
  entry_date date not null,
  completed text[] not null default '{}',
  scheduled_miss boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, entry_date)
);

create table if not exists public.check_ins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entry_date date not null,
  challenge_day integer not null,
  status text not null check (status in ('complete', 'partial', 'scheduled')),
  completed_count integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists challenge_entries_user_date_idx
  on public.challenge_entries (user_id, entry_date desc);

create index if not exists check_ins_created_at_idx
  on public.check_ins (created_at desc);

create index if not exists check_ins_user_date_idx
  on public.check_ins (user_id, entry_date desc);

drop trigger if exists set_profiles_updated_at on public.profiles;
create trigger set_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists set_challenge_entries_updated_at on public.challenge_entries;
create trigger set_challenge_entries_updated_at
  before update on public.challenge_entries
  for each row execute function public.set_updated_at();

drop view if exists public.community_feed;
create view public.community_feed as
select
  c.id,
  coalesce(nullif(p.name, ''), 'Member') as name,
  c.challenge_day as day,
  c.status,
  c.completed_count,
  c.created_at
from public.check_ins c
left join public.profiles p on p.user_id = c.user_id
order by c.created_at desc;

alter table public.profiles enable row level security;
alter table public.challenge_entries enable row level security;
alter table public.check_ins enable row level security;

drop policy if exists "Users can read own profile" on public.profiles;
create policy "Users can read own profile"
  on public.profiles
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert own profile" on public.profiles;
create policy "Users can insert own profile"
  on public.profiles
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile"
  on public.profiles
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can read own challenge entries" on public.challenge_entries;
create policy "Users can read own challenge entries"
  on public.challenge_entries
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert own challenge entries" on public.challenge_entries;
create policy "Users can insert own challenge entries"
  on public.challenge_entries
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update own challenge entries" on public.challenge_entries;
create policy "Users can update own challenge entries"
  on public.challenge_entries
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can insert own check ins" on public.check_ins;
create policy "Users can insert own check ins"
  on public.check_ins
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

revoke all on public.profiles from anon;
revoke all on public.challenge_entries from anon;
revoke all on public.check_ins from anon;
revoke all on public.community_feed from anon;

grant select, insert, update on public.profiles to authenticated;
grant select, insert, update on public.challenge_entries to authenticated;
grant insert on public.check_ins to authenticated;
grant select on public.community_feed to authenticated;
