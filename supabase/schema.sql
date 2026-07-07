create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
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

drop view if exists public.community_feed;

create table if not exists public.community_feed_items (
  id uuid primary key default gen_random_uuid(),
  check_in_id uuid not null unique references public.check_ins(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null default 'Member',
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

create index if not exists community_feed_items_created_at_idx
  on public.community_feed_items (created_at desc);

create index if not exists community_feed_items_user_created_at_idx
  on public.community_feed_items (user_id, created_at desc);

drop trigger if exists set_profiles_updated_at on public.profiles;
create trigger set_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists set_challenge_entries_updated_at on public.challenge_entries;
create trigger set_challenge_entries_updated_at
  before update on public.challenge_entries
  for each row execute function public.set_updated_at();

create or replace function public.create_community_feed_item()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  feed_name text;
begin
  select coalesce(nullif(name, ''), 'Member')
    into feed_name
    from public.profiles
    where user_id = new.user_id;

  insert into public.community_feed_items (
    check_in_id,
    user_id,
    display_name,
    challenge_day,
    status,
    completed_count,
    created_at
  ) values (
    new.id,
    new.user_id,
    coalesce(feed_name, 'Member'),
    new.challenge_day,
    new.status,
    new.completed_count,
    new.created_at
  )
  on conflict (check_in_id) do nothing;

  return new;
end;
$$;

drop trigger if exists create_community_feed_item_on_check_in on public.check_ins;
create trigger create_community_feed_item_on_check_in
  after insert on public.check_ins
  for each row execute function public.create_community_feed_item();

revoke execute on function public.set_updated_at() from public;
revoke execute on function public.set_updated_at() from anon;
revoke execute on function public.set_updated_at() from authenticated;
revoke execute on function public.create_community_feed_item() from public;
revoke execute on function public.create_community_feed_item() from anon;
revoke execute on function public.create_community_feed_item() from authenticated;

do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke execute on function public.rls_auto_enable() from public';
    execute 'revoke execute on function public.rls_auto_enable() from anon';
    execute 'revoke execute on function public.rls_auto_enable() from authenticated';
  end if;
end;
$$;

insert into public.community_feed_items (
  check_in_id,
  user_id,
  display_name,
  challenge_day,
  status,
  completed_count,
  created_at
)
select
  c.id,
  c.user_id,
  coalesce(nullif(p.name, ''), 'Member') as display_name,
  c.challenge_day,
  c.status,
  c.completed_count,
  c.created_at
from public.check_ins c
left join public.profiles p on p.user_id = c.user_id
on conflict (check_in_id) do nothing;

alter table public.profiles enable row level security;
alter table public.challenge_entries enable row level security;
alter table public.check_ins enable row level security;
alter table public.community_feed_items enable row level security;

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

drop policy if exists "Authenticated users can read community feed" on public.community_feed_items;
create policy "Authenticated users can read community feed"
  on public.community_feed_items
  for select
  to authenticated
  using (true);

drop policy if exists "Users can insert own community feed items" on public.community_feed_items;
create policy "Users can insert own community feed items"
  on public.community_feed_items
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

revoke all on public.profiles from anon;
revoke all on public.challenge_entries from anon;
revoke all on public.check_ins from anon;
revoke all on public.community_feed_items from anon;
revoke all on public.community_feed_items from authenticated;

grant select, insert, update on public.profiles to authenticated;
grant select, insert, update on public.challenge_entries to authenticated;
grant insert on public.check_ins to authenticated;
grant insert on public.community_feed_items to authenticated;
grant select (id, display_name, challenge_day, status, completed_count, created_at)
  on public.community_feed_items to authenticated;
