begin;

-- Recover any legacy point-qualified unlock that was not persisted before the
-- threshold change. Mark only these compatibility rows as already seen so the
-- migration cannot manufacture an unlock celebration for existing progress.
insert into public.user_challenge_states (
  user_id,
  challenge_key,
  status,
  unlock_points,
  unlocked_at,
  celebration_seen_at
)
select
  stats.user_id,
  definition.challenge_key,
  'available',
  definition.points_required,
  now(),
  now()
from public.user_game_stats stats
join public.challenge_definitions definition
  on definition.is_active
 and definition.challenge_key in (
   'seven_day_reset',
   'twenty_one_day_prayer',
   'thirty_day_strength',
   'forty_day_fast',
   'bible_in_a_year'
 )
 and definition.points_required <= greatest(stats.total_points, 0)
 and (
   definition.entitlement_key is null
   or exists (
     select 1
     from public.entitlements entitlement
     where entitlement.user_id = stats.user_id
       and entitlement.entitlement_key = definition.entitlement_key
       and entitlement.status = 'active'
       and (entitlement.starts_at is null or entitlement.starts_at <= now())
       and (entitlement.ends_at is null or entitlement.ends_at > now())
   )
 )
on conflict (user_id, challenge_key) do nothing;

-- Persisted user_challenge_states are intentionally left untouched. Their
-- primary key keeps prior unlocks permanent, and their celebration timestamps
-- prevent a threshold change from replaying an already-claimed celebration.
update public.challenge_definitions as definition
set points_required = threshold.points_required
from (
  values
    ('seven_day_reset', 1000),
    ('twenty_one_day_prayer', 3000),
    ('thirty_day_strength', 4500),
    ('forty_day_fast', 6000),
    ('bible_in_a_year', 10000)
) as threshold(challenge_key, points_required)
where definition.challenge_key = threshold.challenge_key
  and definition.points_required is distinct from threshold.points_required;

commit;
