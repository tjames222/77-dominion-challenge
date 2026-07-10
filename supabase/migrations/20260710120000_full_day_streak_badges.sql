begin;

insert into public.badge_definitions (badge_key, name, description, category, tier, icon, sort_order)
values
  ('seven_sealed', 'Seven Sealed', 'Held a seven-day full-standard streak.', 'streak', 'gold', 'repeat', 70),
  ('full_streak_14', '14-Day Full Streak', 'Held a fourteen-day full-standard streak.', 'streak', 'silver', 'shield', 101),
  ('full_streak_21', '21-Day Full Streak', 'Held a twenty-one-day full-standard streak.', 'streak', 'silver', 'target', 102),
  ('full_streak_28', '28-Day Full Streak', 'Held a twenty-eight-day full-standard streak.', 'streak', 'silver', 'dumbbell', 103),
  ('full_streak_35', '35-Day Full Streak', 'Held a thirty-five-day full-standard streak.', 'streak', 'gold', 'flame', 104),
  ('full_streak_42', '42-Day Full Streak', 'Held a forty-two-day full-standard streak.', 'streak', 'gold', 'eye', 105),
  ('full_streak_49', '49-Day Full Streak', 'Held a forty-nine-day full-standard streak.', 'streak', 'gold', 'repeat', 106),
  ('full_streak_56', '56-Day Full Streak', 'Held a fifty-six-day full-standard streak.', 'streak', 'gold', 'mountain', 107),
  ('full_streak_63', '63-Day Full Streak', 'Held a sixty-three-day full-standard streak.', 'streak', 'gold', 'star', 108),
  ('full_streak_70', '70-Day Full Streak', 'Held a seventy-day full-standard streak.', 'streak', 'gold', 'flag', 109)
on conflict (badge_key) do update set
  name = excluded.name,
  description = excluded.description,
  category = excluded.category,
  tier = excluded.tier,
  icon = excluded.icon,
  sort_order = excluded.sort_order;

create or replace function public.process_check_in_game_rewards()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  action_points integer := 0;
  bonus_points integer := 0;
  workout_points integer := 0;
  total_points integer := 0;
  difficulty_one text := coalesce(new.workout_difficulty ->> 'one', 'medium');
  difficulty_two text := coalesce(new.workout_difficulty ->> 'two', 'medium');
  points_inserted boolean := false;
  stats_row public.user_game_stats%rowtype;
  next_full_streak integer := 0;
  streak_bonus integer := 0;
  selected_badge_key text := null;
  selected_badge_metadata jsonb := '{}'::jsonb;
begin
  if new.challenge_day < 1 or new.challenge_day > 77 then
    raise exception 'The 77-day challenge is complete.';
  end if;

  if cardinality(new.completed) > 0 then
    new.completed_count := cardinality(new.completed);
  end if;

  action_points := greatest(new.completed_count, 0) * 10;
  if new.status = 'complete' then
    bonus_points := 30;
  elsif new.status = 'partial' then
    bonus_points := 10;
  elsif new.status = 'scheduled' then
    bonus_points := 15;
  end if;

  if 'workoutOne' = any(new.completed) then
    workout_points := workout_points + public.workout_difficulty_points(difficulty_one);
  end if;

  if 'workoutTwo' = any(new.completed) then
    workout_points := workout_points + public.workout_difficulty_points(difficulty_two);
  end if;

  total_points := action_points + bonus_points + workout_points;
  points_inserted := public.add_game_points(
    new.user_id,
    'check_in',
    total_points,
    new.entry_date,
    new.challenge_day,
    null,
    jsonb_build_object(
      'status', new.status,
      'completedCount', new.completed_count,
      'completed', new.completed,
      'workoutDifficulty', new.workout_difficulty,
      'actionPoints', action_points,
      'bonusPoints', bonus_points,
      'workoutPoints', workout_points
    ),
    'checkin:' || new.user_id::text || ':' || new.entry_date::text
  );

  new.points_awarded := case when points_inserted then total_points else 0 end;

  if not points_inserted then
    return new;
  end if;

  if new.status = 'complete' then
    select * into stats_row
    from public.user_game_stats
    where user_id = new.user_id
    for update;

    if stats_row.last_full_day_date = new.entry_date then
      next_full_streak := stats_row.current_full_day_streak;
    elsif stats_row.last_full_day_date = new.entry_date - 1 then
      next_full_streak := stats_row.current_full_day_streak + 1;
    else
      next_full_streak := 1;
    end if;

    update public.user_game_stats
    set
      current_full_day_streak = next_full_streak,
      best_full_day_streak = greatest(best_full_day_streak, next_full_streak),
      last_full_day_date = new.entry_date,
      updated_at = now()
    where user_id = new.user_id;

    streak_bonus := public.full_streak_bonus_points(next_full_streak);
    if streak_bonus > 0 then
      perform public.add_game_points(
        new.user_id,
        'full_day_streak_bonus',
        streak_bonus,
        new.entry_date,
        new.challenge_day,
        null,
        jsonb_build_object('streak', next_full_streak),
        'fullstreak:' || new.user_id::text || ':' || next_full_streak::text
      );
    end if;
  end if;

  select * into stats_row
  from public.user_game_stats
  where user_id = new.user_id;

  if not exists (
    select 1
    from public.user_badges
    where user_id = new.user_id
      and entry_date = new.entry_date
  ) then
    if new.status = 'complete' then
      if new.challenge_day >= 77 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'day_77_finisher') then
        selected_badge_key := 'day_77_finisher';
        selected_badge_metadata := jsonb_build_object('challengeDay', new.challenge_day);
      elsif new.challenge_day >= 70 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'final_watch') then
        selected_badge_key := 'final_watch';
        selected_badge_metadata := jsonb_build_object('challengeDay', new.challenge_day);
      elsif new.challenge_day >= 60 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'sixty_strong') then
        selected_badge_key := 'sixty_strong';
        selected_badge_metadata := jsonb_build_object('challengeDay', new.challenge_day);
      elsif new.challenge_day >= 50 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'fifty_faithful') then
        selected_badge_key := 'fifty_faithful';
        selected_badge_metadata := jsonb_build_object('challengeDay', new.challenge_day);
      elsif new.challenge_day >= 39 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'halfway_fire') then
        selected_badge_key := 'halfway_fire';
        selected_badge_metadata := jsonb_build_object('challengeDay', new.challenge_day);
      elsif new.challenge_day >= 33 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'deep_roots') then
        selected_badge_key := 'deep_roots';
        selected_badge_metadata := jsonb_build_object('challengeDay', new.challenge_day);
      elsif new.challenge_day >= 26 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'third_way') then
        selected_badge_key := 'third_way';
        selected_badge_metadata := jsonb_build_object('challengeDay', new.challenge_day);
      elsif new.challenge_day >= 21 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'three_week_wall') then
        selected_badge_key := 'three_week_wall';
        selected_badge_metadata := jsonb_build_object('challengeDay', new.challenge_day);
      elsif new.challenge_day >= 14 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'two_week_guard') then
        selected_badge_key := 'two_week_guard';
        selected_badge_metadata := jsonb_build_object('challengeDay', new.challenge_day);
      elsif new.challenge_day >= 7 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'seven_day_start') then
        selected_badge_key := 'seven_day_start';
        selected_badge_metadata := jsonb_build_object('challengeDay', new.challenge_day);
      elsif next_full_streak >= 70 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'full_streak_70') then
        selected_badge_key := 'full_streak_70';
        selected_badge_metadata := jsonb_build_object('streak', next_full_streak);
      elsif next_full_streak >= 63 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'full_streak_63') then
        selected_badge_key := 'full_streak_63';
        selected_badge_metadata := jsonb_build_object('streak', next_full_streak);
      elsif next_full_streak >= 56 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'full_streak_56') then
        selected_badge_key := 'full_streak_56';
        selected_badge_metadata := jsonb_build_object('streak', next_full_streak);
      elsif next_full_streak >= 49 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'full_streak_49') then
        selected_badge_key := 'full_streak_49';
        selected_badge_metadata := jsonb_build_object('streak', next_full_streak);
      elsif next_full_streak >= 42 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'full_streak_42') then
        selected_badge_key := 'full_streak_42';
        selected_badge_metadata := jsonb_build_object('streak', next_full_streak);
      elsif next_full_streak >= 35 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'full_streak_35') then
        selected_badge_key := 'full_streak_35';
        selected_badge_metadata := jsonb_build_object('streak', next_full_streak);
      elsif next_full_streak >= 28 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'full_streak_28') then
        selected_badge_key := 'full_streak_28';
        selected_badge_metadata := jsonb_build_object('streak', next_full_streak);
      elsif next_full_streak >= 21 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'full_streak_21') then
        selected_badge_key := 'full_streak_21';
        selected_badge_metadata := jsonb_build_object('streak', next_full_streak);
      elsif next_full_streak >= 14 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'full_streak_14') then
        selected_badge_key := 'full_streak_14';
        selected_badge_metadata := jsonb_build_object('streak', next_full_streak);
      elsif next_full_streak >= 7 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'seven_sealed') then
        selected_badge_key := 'seven_sealed';
        selected_badge_metadata := jsonb_build_object('streak', next_full_streak);
      elsif next_full_streak >= 3 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'streak_flame') then
        selected_badge_key := 'streak_flame';
        selected_badge_metadata := jsonb_build_object('streak', next_full_streak);
      elsif coalesce(stats_row.current_app_streak, 0) >= 7 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'watchman_week') then
        selected_badge_key := 'watchman_week';
        selected_badge_metadata := jsonb_build_object('appStreak', stats_row.current_app_streak);
      elsif coalesce(stats_row.current_app_streak, 0) >= 3 and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'morning_watch') then
        selected_badge_key := 'morning_watch';
        selected_badge_metadata := jsonb_build_object('appStreak', stats_row.current_app_streak);
      elsif (('workoutOne' = any(new.completed) and difficulty_one = 'extreme')
        or ('workoutTwo' = any(new.completed) and difficulty_two = 'extreme'))
        and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'extreme_fire') then
        selected_badge_key := 'extreme_fire';
        selected_badge_metadata := new.workout_difficulty;
      elsif (('workoutOne' = any(new.completed) and difficulty_one = 'hard')
        or ('workoutTwo' = any(new.completed) and difficulty_two = 'hard'))
        and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'hard_path') then
        selected_badge_key := 'hard_path';
        selected_badge_metadata := new.workout_difficulty;
      elsif (('workoutOne' = any(new.completed) and difficulty_one = 'medium')
        or ('workoutTwo' = any(new.completed) and difficulty_two = 'medium'))
        and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'steady_grind') then
        selected_badge_key := 'steady_grind';
        selected_badge_metadata := new.workout_difficulty;
      elsif (('workoutOne' = any(new.completed) and difficulty_one = 'easy')
        or ('workoutTwo' = any(new.completed) and difficulty_two = 'easy'))
        and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'first_sweat') then
        selected_badge_key := 'first_sweat';
        selected_badge_metadata := new.workout_difficulty;
      elsif not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'iron_standard') then
        selected_badge_key := 'iron_standard';
        selected_badge_metadata := jsonb_build_object('challengeDay', new.challenge_day);
      end if;
    elsif new.status = 'partial' then
      if not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'honest_partial') then
        selected_badge_key := 'honest_partial';
        selected_badge_metadata := jsonb_build_object('completedCount', new.completed_count);
      end if;
    end if;

    if selected_badge_key is null and not exists (select 1 from public.user_badges where user_id = new.user_id and badge_key = 'faithful_start') then
      selected_badge_key := 'faithful_start';
      selected_badge_metadata := jsonb_build_object('challengeDay', new.challenge_day);
    end if;

    if selected_badge_key is not null then
      perform public.award_badge(new.user_id, selected_badge_key, new.entry_date, selected_badge_metadata);
    end if;
  end if;

  return new;
end;
$$;

commit;
