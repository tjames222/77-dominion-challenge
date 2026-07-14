begin;

create table if not exists public.workout_difficulty_point_values (
  difficulty text primary key check (difficulty in ('easy', 'medium', 'hard', 'extreme')),
  points integer not null check (points >= 0),
  updated_at timestamptz not null default now()
);

insert into public.workout_difficulty_point_values (difficulty, points)
values
  ('easy', 2),
  ('medium', 5),
  ('hard', 10),
  ('extreme', 15)
on conflict (difficulty) do nothing;

drop trigger if exists set_workout_difficulty_point_values_updated_at on public.workout_difficulty_point_values;
create trigger set_workout_difficulty_point_values_updated_at
  before update on public.workout_difficulty_point_values
  for each row execute function public.set_updated_at();

create or replace function public.workout_difficulty_points(target_difficulty text)
returns integer
language sql
stable
set search_path = public
as $$
  select coalesce(
    (
      select config.points
      from public.workout_difficulty_point_values config
      where config.difficulty = lower(btrim(coalesce(target_difficulty, 'medium')))
    ),
    (
      select config.points
      from public.workout_difficulty_point_values config
      where config.difficulty = 'medium'
    ),
    0
  );
$$;

alter table public.workout_difficulty_point_values enable row level security;

drop policy if exists "Authenticated users can read workout difficulty point values"
  on public.workout_difficulty_point_values;
create policy "Authenticated users can read workout difficulty point values"
  on public.workout_difficulty_point_values
  for select
  to authenticated
  using (true);

drop policy if exists "Service role can update workout difficulty point values"
  on public.workout_difficulty_point_values;
create policy "Service role can update workout difficulty point values"
  on public.workout_difficulty_point_values
  for update
  to service_role
  using (true)
  with check (true);

revoke all on public.workout_difficulty_point_values from public;
revoke all on public.workout_difficulty_point_values from anon;
revoke all on public.workout_difficulty_point_values from authenticated;
revoke all on public.workout_difficulty_point_values from service_role;
grant select on public.workout_difficulty_point_values to authenticated;
grant select on public.workout_difficulty_point_values to service_role;
grant update (points) on public.workout_difficulty_point_values to service_role;

revoke execute on function public.workout_difficulty_points(text) from public;
revoke execute on function public.workout_difficulty_points(text) from anon;
revoke execute on function public.workout_difficulty_points(text) from authenticated;

commit;
