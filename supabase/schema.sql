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

create table if not exists public.billing_customers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text not null unique,
  email text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_key text not null check (product_key in ('challenge_77')),
  status text not null check (status in ('pending', 'paid', 'refunded', 'failed', 'expired')),
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text,
  stripe_customer_id text,
  stripe_price_id text,
  amount_total integer,
  currency text not null default 'usd',
  purchased_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_key text not null check (product_key in ('dominion_membership')),
  status text not null,
  stripe_customer_id text,
  stripe_subscription_id text not null unique,
  stripe_price_id text,
  cancel_at_period_end boolean not null default false,
  current_period_start timestamptz,
  current_period_end timestamptz,
  canceled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.entitlements (
  user_id uuid not null references auth.users(id) on delete cascade,
  entitlement_key text not null check (entitlement_key in ('challenge_77_access', 'membership_active')),
  status text not null check (status in ('active', 'inactive', 'revoked', 'expired')) default 'inactive',
  source_type text not null,
  source_id text,
  starts_at timestamptz,
  ends_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, entitlement_key)
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

create table if not exists public.crews (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 80),
  description text not null default '',
  challenge_start_date date,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.crew_members (
  crew_id uuid not null references public.crews(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null default 'Member',
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  joined_at timestamptz not null default now(),
  primary key (crew_id, user_id)
);

create table if not exists public.crew_invites (
  id uuid primary key default gen_random_uuid(),
  crew_id uuid not null references public.crews(id) on delete cascade,
  token text not null unique default encode(gen_random_bytes(24), 'hex'),
  created_by uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null default (now() + interval '30 days'),
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.community_posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null default 'Member',
  crew_id uuid references public.crews(id) on delete cascade,
  scope text not null check (scope in ('crew', 'global')),
  body text not null check (char_length(trim(body)) between 1 and 2000),
  post_type text not null default 'message' check (post_type in ('message', 'prayer', 'encouragement', 'check_in')),
  challenge_day integer,
  status text check (status is null or status in ('complete', 'partial', 'scheduled')),
  completed_count integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (scope = 'crew' and crew_id is not null)
    or (scope = 'global' and crew_id is null)
  )
);

create table if not exists public.post_likes (
  post_id uuid not null references public.community_posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table if not exists public.post_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.community_posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null default 'Member',
  body text not null check (char_length(trim(body)) between 1 and 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.journal_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entry_date date not null,
  challenge_day integer,
  note text not null default '',
  win text not null default '',
  prayer text not null default '',
  mood text not null default '',
  energy text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, entry_date)
);

create table if not exists public.journal_photos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  journal_entry_id uuid references public.journal_entries(id) on delete cascade,
  storage_path text not null,
  caption text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists challenge_entries_user_date_idx
  on public.challenge_entries (user_id, entry_date desc);

create index if not exists check_ins_created_at_idx
  on public.check_ins (created_at desc);

create index if not exists check_ins_user_date_idx
  on public.check_ins (user_id, entry_date desc);

create index if not exists purchases_user_created_at_idx
  on public.purchases (user_id, created_at desc);

create index if not exists subscriptions_user_created_at_idx
  on public.subscriptions (user_id, created_at desc);

create index if not exists entitlements_user_status_idx
  on public.entitlements (user_id, status);

create index if not exists community_feed_items_created_at_idx
  on public.community_feed_items (created_at desc);

create index if not exists community_feed_items_user_created_at_idx
  on public.community_feed_items (user_id, created_at desc);

create index if not exists crews_created_by_idx
  on public.crews (created_by, created_at desc);

create index if not exists crew_members_user_idx
  on public.crew_members (user_id, joined_at desc);

create index if not exists crew_invites_crew_idx
  on public.crew_invites (crew_id, created_at desc);

create index if not exists community_posts_scope_created_at_idx
  on public.community_posts (scope, created_at desc);

create index if not exists community_posts_crew_created_at_idx
  on public.community_posts (crew_id, created_at desc);

create index if not exists post_comments_post_created_at_idx
  on public.post_comments (post_id, created_at asc);

create index if not exists journal_entries_user_date_idx
  on public.journal_entries (user_id, entry_date desc);

create index if not exists journal_photos_user_created_at_idx
  on public.journal_photos (user_id, created_at desc);

drop trigger if exists set_profiles_updated_at on public.profiles;
create trigger set_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists set_challenge_entries_updated_at on public.challenge_entries;
create trigger set_challenge_entries_updated_at
  before update on public.challenge_entries
  for each row execute function public.set_updated_at();

drop trigger if exists set_billing_customers_updated_at on public.billing_customers;
create trigger set_billing_customers_updated_at
  before update on public.billing_customers
  for each row execute function public.set_updated_at();

drop trigger if exists set_purchases_updated_at on public.purchases;
create trigger set_purchases_updated_at
  before update on public.purchases
  for each row execute function public.set_updated_at();

drop trigger if exists set_subscriptions_updated_at on public.subscriptions;
create trigger set_subscriptions_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

drop trigger if exists set_entitlements_updated_at on public.entitlements;
create trigger set_entitlements_updated_at
  before update on public.entitlements
  for each row execute function public.set_updated_at();

drop trigger if exists set_crews_updated_at on public.crews;
create trigger set_crews_updated_at
  before update on public.crews
  for each row execute function public.set_updated_at();

drop trigger if exists set_community_posts_updated_at on public.community_posts;
create trigger set_community_posts_updated_at
  before update on public.community_posts
  for each row execute function public.set_updated_at();

drop trigger if exists set_post_comments_updated_at on public.post_comments;
create trigger set_post_comments_updated_at
  before update on public.post_comments
  for each row execute function public.set_updated_at();

drop trigger if exists set_journal_entries_updated_at on public.journal_entries;
create trigger set_journal_entries_updated_at
  before update on public.journal_entries
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

create or replace function public.join_crew_by_invite(invite_token text)
returns table (
  crew_id uuid,
  name text,
  description text,
  challenge_start_date date
)
language plpgsql
security definer
set search_path = public
as $$
declare
  target_crew_id uuid;
  member_name text;
begin
  if auth.uid() is null then
    raise exception 'You need to log in to join this crew.';
  end if;

  if not public.has_active_entitlement('challenge_77_access') then
    raise exception 'Challenge access is required to join a crew.';
  end if;

  select ci.crew_id
    into target_crew_id
    from public.crew_invites ci
    where ci.token = invite_token
      and ci.revoked_at is null
      and ci.expires_at > now()
    limit 1;

  if target_crew_id is null then
    raise exception 'This invite link is invalid or expired.';
  end if;

  select coalesce(nullif(name, ''), 'Member')
    into member_name
    from public.profiles
    where user_id = auth.uid();

  insert into public.crew_members (crew_id, user_id, display_name, role)
  values (target_crew_id, auth.uid(), coalesce(member_name, 'Member'), 'member')
  on conflict (crew_id, user_id) do nothing;

  return query
    select c.id, c.name, c.description, c.challenge_start_date
    from public.crews c
    where c.id = target_crew_id;
end;
$$;

create or replace function public.is_crew_member(target_crew_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.crew_members cm
    where cm.crew_id = target_crew_id
      and cm.user_id = auth.uid()
  );
$$;

create or replace function public.can_manage_crew(target_crew_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.crew_members cm
    where cm.crew_id = target_crew_id
      and cm.user_id = auth.uid()
      and cm.role in ('owner', 'admin')
  );
$$;

create or replace function public.has_active_entitlement(target_entitlement_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.entitlements e
    where e.user_id = auth.uid()
      and e.entitlement_key = target_entitlement_key
      and e.status = 'active'
      and (e.ends_at is null or e.ends_at > now())
  );
$$;

create or replace function public.can_read_community_post(target_post_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.community_posts cp
    where cp.id = target_post_id
      and (
        (cp.scope = 'global' and public.has_active_entitlement('challenge_77_access'))
        or public.is_crew_member(cp.crew_id)
      )
  );
$$;

revoke execute on function public.set_updated_at() from public;
revoke execute on function public.set_updated_at() from anon;
revoke execute on function public.set_updated_at() from authenticated;
revoke execute on function public.create_community_feed_item() from public;
revoke execute on function public.create_community_feed_item() from anon;
revoke execute on function public.create_community_feed_item() from authenticated;
revoke execute on function public.join_crew_by_invite(text) from public;
revoke execute on function public.join_crew_by_invite(text) from anon;
grant execute on function public.join_crew_by_invite(text) to authenticated;
revoke execute on function public.is_crew_member(uuid) from public;
revoke execute on function public.is_crew_member(uuid) from anon;
grant execute on function public.is_crew_member(uuid) to authenticated;
revoke execute on function public.can_manage_crew(uuid) from public;
revoke execute on function public.can_manage_crew(uuid) from anon;
grant execute on function public.can_manage_crew(uuid) to authenticated;
revoke execute on function public.has_active_entitlement(text) from public;
revoke execute on function public.has_active_entitlement(text) from anon;
grant execute on function public.has_active_entitlement(text) to authenticated;
revoke execute on function public.can_read_community_post(uuid) from public;
revoke execute on function public.can_read_community_post(uuid) from anon;
grant execute on function public.can_read_community_post(uuid) to authenticated;

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
alter table public.billing_customers enable row level security;
alter table public.purchases enable row level security;
alter table public.subscriptions enable row level security;
alter table public.entitlements enable row level security;
alter table public.community_feed_items enable row level security;
alter table public.crews enable row level security;
alter table public.crew_members enable row level security;
alter table public.crew_invites enable row level security;
alter table public.community_posts enable row level security;
alter table public.post_likes enable row level security;
alter table public.post_comments enable row level security;
alter table public.journal_entries enable row level security;
alter table public.journal_photos enable row level security;

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

drop policy if exists "Users can read own purchases" on public.purchases;
create policy "Users can read own purchases"
  on public.purchases
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can read own subscriptions" on public.subscriptions;
create policy "Users can read own subscriptions"
  on public.subscriptions
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can read own entitlements" on public.entitlements;
create policy "Users can read own entitlements"
  on public.entitlements
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

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

drop policy if exists "Crew members can read crews" on public.crews;
create policy "Crew members can read crews"
  on public.crews
  for select
  to authenticated
  using (public.is_crew_member(id) or created_by = (select auth.uid()));

drop policy if exists "Users can create own crews" on public.crews;
create policy "Users can create own crews"
  on public.crews
  for insert
  to authenticated
  with check (
    created_by = (select auth.uid())
    and public.has_active_entitlement('challenge_77_access')
  );

drop policy if exists "Crew admins can update crews" on public.crews;
create policy "Crew admins can update crews"
  on public.crews
  for update
  to authenticated
  using (public.can_manage_crew(id) or created_by = (select auth.uid()))
  with check (public.can_manage_crew(id) or created_by = (select auth.uid()));

drop policy if exists "Crew members can read members" on public.crew_members;
create policy "Crew members can read members"
  on public.crew_members
  for select
  to authenticated
  using (public.is_crew_member(crew_id));

drop policy if exists "Crew owners can add themselves" on public.crew_members;
create policy "Crew owners can add themselves"
  on public.crew_members
  for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and role = 'owner'
    and exists (
      select 1
      from public.crews c
      where c.id = crew_id
        and c.created_by = (select auth.uid())
    )
  );

drop policy if exists "Crew admins can read invites" on public.crew_invites;
create policy "Crew admins can read invites"
  on public.crew_invites
  for select
  to authenticated
  using (public.can_manage_crew(crew_id));

drop policy if exists "Crew admins can create invites" on public.crew_invites;
create policy "Crew admins can create invites"
  on public.crew_invites
  for insert
  to authenticated
  with check (
    created_by = (select auth.uid())
    and public.can_manage_crew(crew_id)
  );

drop policy if exists "Crew admins can update invites" on public.crew_invites;
create policy "Crew admins can update invites"
  on public.crew_invites
  for update
  to authenticated
  using (public.can_manage_crew(crew_id))
  with check (public.can_manage_crew(crew_id));

drop policy if exists "Authenticated users can read visible posts" on public.community_posts;
create policy "Authenticated users can read visible posts"
  on public.community_posts
  for select
  to authenticated
  using (
    (scope = 'global' and public.has_active_entitlement('challenge_77_access'))
    or public.is_crew_member(crew_id)
  );

drop policy if exists "Users can create visible posts" on public.community_posts;
create policy "Users can create visible posts"
  on public.community_posts
  for insert
  to authenticated
  with check (
    author_id = (select auth.uid())
    and (
      (
        scope = 'global'
        and crew_id is null
        and public.has_active_entitlement('challenge_77_access')
      )
      or (scope = 'crew' and public.is_crew_member(crew_id))
    )
  );

drop policy if exists "Authors can update own posts" on public.community_posts;
create policy "Authors can update own posts"
  on public.community_posts
  for update
  to authenticated
  using (author_id = (select auth.uid()))
  with check (author_id = (select auth.uid()));

drop policy if exists "Users can read likes on visible posts" on public.post_likes;
create policy "Users can read likes on visible posts"
  on public.post_likes
  for select
  to authenticated
  using (public.can_read_community_post(post_id));

drop policy if exists "Users can like visible posts" on public.post_likes;
create policy "Users can like visible posts"
  on public.post_likes
  for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and public.can_read_community_post(post_id)
  );

drop policy if exists "Users can remove own likes" on public.post_likes;
create policy "Users can remove own likes"
  on public.post_likes
  for delete
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "Users can read comments on visible posts" on public.post_comments;
create policy "Users can read comments on visible posts"
  on public.post_comments
  for select
  to authenticated
  using (public.can_read_community_post(post_id));

drop policy if exists "Users can comment on visible posts" on public.post_comments;
create policy "Users can comment on visible posts"
  on public.post_comments
  for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and public.can_read_community_post(post_id)
  );

drop policy if exists "Users can update own comments" on public.post_comments;
create policy "Users can update own comments"
  on public.post_comments
  for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "Users can read own journal entries" on public.journal_entries;
create policy "Users can read own journal entries"
  on public.journal_entries
  for select
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "Users can insert own journal entries" on public.journal_entries;
create policy "Users can insert own journal entries"
  on public.journal_entries
  for insert
  to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "Users can update own journal entries" on public.journal_entries;
create policy "Users can update own journal entries"
  on public.journal_entries
  for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "Users can delete own journal entries" on public.journal_entries;
create policy "Users can delete own journal entries"
  on public.journal_entries
  for delete
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "Users can read own journal photos" on public.journal_photos;
create policy "Users can read own journal photos"
  on public.journal_photos
  for select
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "Users can insert own journal photos" on public.journal_photos;
create policy "Users can insert own journal photos"
  on public.journal_photos
  for insert
  to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "Users can update own journal photos" on public.journal_photos;
create policy "Users can update own journal photos"
  on public.journal_photos
  for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "Users can delete own journal photos" on public.journal_photos;
create policy "Users can delete own journal photos"
  on public.journal_photos
  for delete
  to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.profiles from anon;
revoke all on public.challenge_entries from anon;
revoke all on public.check_ins from anon;
revoke all on public.billing_customers from anon;
revoke all on public.billing_customers from authenticated;
revoke all on public.purchases from anon;
revoke all on public.purchases from authenticated;
revoke all on public.subscriptions from anon;
revoke all on public.subscriptions from authenticated;
revoke all on public.entitlements from anon;
revoke all on public.entitlements from authenticated;
revoke all on public.community_feed_items from anon;
revoke all on public.community_feed_items from authenticated;
revoke all on public.crews from anon;
revoke all on public.crews from authenticated;
revoke all on public.crew_members from anon;
revoke all on public.crew_members from authenticated;
revoke all on public.crew_invites from anon;
revoke all on public.crew_invites from authenticated;
revoke all on public.community_posts from anon;
revoke all on public.community_posts from authenticated;
revoke all on public.post_likes from anon;
revoke all on public.post_likes from authenticated;
revoke all on public.post_comments from anon;
revoke all on public.post_comments from authenticated;
revoke all on public.journal_entries from anon;
revoke all on public.journal_entries from authenticated;
revoke all on public.journal_photos from anon;
revoke all on public.journal_photos from authenticated;

grant select, insert, update on public.profiles to authenticated;
grant select, insert, update on public.challenge_entries to authenticated;
grant insert on public.check_ins to authenticated;
grant select on public.purchases to authenticated;
grant select on public.subscriptions to authenticated;
grant select on public.entitlements to authenticated;
grant insert on public.community_feed_items to authenticated;
grant select (id, display_name, challenge_day, status, completed_count, created_at)
  on public.community_feed_items to authenticated;
grant select, insert, update on public.crews to authenticated;
grant select, insert on public.crew_members to authenticated;
grant select, insert, update on public.crew_invites to authenticated;
grant select, insert, update on public.community_posts to authenticated;
grant select, insert, delete on public.post_likes to authenticated;
grant select, insert, update on public.post_comments to authenticated;
grant select, insert, update, delete on public.journal_entries to authenticated;
grant select, insert, update, delete on public.journal_photos to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'journal-progress',
  'journal-progress',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users can read own journal photo objects" on storage.objects;
create policy "Users can read own journal photo objects"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'journal-progress'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users can upload own journal photo objects" on storage.objects;
create policy "Users can upload own journal photo objects"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'journal-progress'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users can update own journal photo objects" on storage.objects;
create policy "Users can update own journal photo objects"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'journal-progress'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'journal-progress'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users can delete own journal photo objects" on storage.objects;
create policy "Users can delete own journal photo objects"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'journal-progress'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
