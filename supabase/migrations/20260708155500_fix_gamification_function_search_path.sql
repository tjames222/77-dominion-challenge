begin;

create or replace function public.workout_difficulty_points(target_difficulty text)
returns integer
language sql
immutable
set search_path = public
as $$
  select case lower(coalesce(target_difficulty, 'medium'))
    when 'easy' then 2
    when 'medium' then 5
    when 'hard' then 10
    when 'extreme' then 15
    else 5
  end;
$$;

create or replace function public.full_streak_bonus_points(target_streak integer)
returns integer
language sql
immutable
set search_path = public
as $$
  select case target_streak
    when 3 then 25
    when 7 then 75
    when 14 then 150
    when 30 then 300
    when 77 then 777
    else 0
  end;
$$;

commit;
