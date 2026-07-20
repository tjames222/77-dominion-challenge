create table if not exists public.user_theme_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  theme_key text not null check (theme_key in ('dark', 'light', 'dominion-night')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_theme_preferences enable row level security;

create or replace function public.get_theme_preference()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  current_user_id uuid := auth.uid();
  preference public.user_theme_preferences%rowtype;
begin
  if current_user_id is null then
    raise exception 'A signed-in user is required.' using errcode = '42501';
  end if;

  select saved.*
    into preference
  from public.user_theme_preferences saved
  where saved.user_id = current_user_id;

  return jsonb_build_object(
    'themeKey', preference.theme_key,
    'updatedAt', preference.updated_at
  );
end;
$$;

create or replace function public.set_theme_preference(target_theme_key text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  current_user_id uuid := auth.uid();
  normalized_theme_key text := lower(trim(coalesce(target_theme_key, '')));
  preference public.user_theme_preferences%rowtype;
begin
  if current_user_id is null then
    raise exception 'A signed-in user is required.' using errcode = '42501';
  end if;

  if normalized_theme_key not in ('dark', 'light', 'dominion-night') then
    raise exception 'The requested theme is unavailable.' using errcode = '22023';
  end if;

  if normalized_theme_key = 'dominion-night' and not exists (
    select 1
    from public.user_reward_entitlements entitlement
    where entitlement.user_id = current_user_id
      and entitlement.reward_key = 'dominion_night_theme'
  ) then
    raise exception 'Dominion Night has not been unlocked.' using errcode = '42501';
  end if;

  insert into public.user_theme_preferences (user_id, theme_key)
  values (current_user_id, normalized_theme_key)
  on conflict (user_id) do update set
    theme_key = excluded.theme_key,
    updated_at = now()
  returning * into preference;

  return jsonb_build_object(
    'themeKey', preference.theme_key,
    'updatedAt', preference.updated_at
  );
end;
$$;

revoke all on public.user_theme_preferences from public, anon, authenticated;
grant select, insert, update, delete on public.user_theme_preferences to service_role;

revoke all on function public.get_theme_preference() from public, anon;
revoke all on function public.set_theme_preference(text) from public, anon;
grant execute on function public.get_theme_preference() to authenticated;
grant execute on function public.set_theme_preference(text) to authenticated;
