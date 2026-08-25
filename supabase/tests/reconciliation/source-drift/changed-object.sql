create or replace function public.workout_difficulty_points(target_difficulty text)
returns integer
language sql
immutable
set search_path = public
as $$
  select 999;
$$;
