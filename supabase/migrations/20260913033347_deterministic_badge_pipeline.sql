-- FOU-1499: canonical, typed badge rules and event-aligned awards.
-- Draft used for local iteration. No account, entitlement, score or completion rule changes.
set local lock_timeout = '5s';

alter table public.badge_definitions
  add column requirement text not null default '',
  add column criteria_version integer not null default 1 check (criteria_version = 1),
  add column source_event text not null default 'none'
    check (source_event in ('none','check_in','app_visit','share','challenge_completion')),
  add column metric text not null default 'retired'
    check (metric in ('retired','check_in_count','partial_count','perfect_count','instance_check_in_count','perfect_streak','workout','app_streak','verified_share','original_77_completion')),
  add column threshold integer,
  add column predicate text,
  add column scope text not null default 'lifetime' check (scope in ('lifetime','challenge_instance')),
  add column visibility text not null default 'public' check (visibility in ('public','hidden')),
  add column show_progress boolean not null default false,
  add column celebration text not null default 'none' check (celebration in ('none','queue')),
  add column retired boolean not null default true,
  add column blocked boolean not null default false,
  add column tier_rank integer not null default 1 check (tier_rank between 1 and 3);

alter table public.user_badges
  add column id uuid not null default gen_random_uuid(),
  add column scope_key text not null default 'lifetime',
  add column celebration_seen_at timestamptz,
  add column celebration_claim_token uuid,
  add column celebration_claim_until timestamptz;
-- Preserve all original awards and their original presentation before rationalizing definitions.
update public.user_badges award
set metadata = award.metadata || jsonb_build_object(
    'legacy', true, 'awardDefinition', jsonb_build_object(
      'name', definition.name, 'description', definition.description,
      'requirement', definition.description, 'tier', definition.tier,
      'icon', definition.icon, 'category', definition.category,
      'displayOrder', definition.sort_order)),
    celebration_seen_at = award.earned_at
from public.badge_definitions definition where definition.badge_key = award.badge_key;

drop index if exists public.user_badges_user_entry_date_unique;
alter table public.user_badges drop constraint if exists user_badges_user_id_badge_key_key;
alter table public.user_badges drop constraint user_badges_pkey;
alter table public.user_badges add constraint user_badges_pkey primary key(id);
create unique index user_badges_scoped_unique on public.user_badges(user_id,badge_key,scope_key);
create index user_badges_unseen_idx on public.user_badges(user_id,earned_at,id)
  where celebration_seen_at is null;
-- Browser roles still have SELECT-only access governed by the existing owner RLS.
revoke insert, update, delete on public.user_badges from public, anon, authenticated;

-- BEGIN CANONICAL CATALOG V1 (validated byte-for-byte against checked-in JSON)
insert into public.badge_definitions(
  badge_key,name,description,requirement,category,tier,tier_rank,icon,sort_order,
  criteria_version,source_event,metric,threshold,predicate,scope,visibility,show_progress,celebration,retired,blocked)
select rule->>'key',rule->>'name',rule->>'description',rule->>'requirement',rule->>'series',
  rule->>'tier',(rule->>'tierRank')::integer,rule->>'icon',(rule->>'displayOrder')::integer,
  1,rule->>'source',rule->>'metric',(rule->>'threshold')::integer,rule->>'predicate',rule->>'scope',
  rule->>'visibility',(rule->>'showProgress')::boolean,rule->>'celebration',
  rule->>'status' = 'retired',rule->>'status' = 'blocked'
from jsonb_array_elements($badge_catalog$[{"key":"faithful_start","name":"Faithful Start","description":"Post your first check-in.","requirement":"Post your first check-in.","series":"foundation","tier":"bronze","tierRank":1,"icon":"shield","displayOrder":10,"status":"active","criteriaVersion":1,"source":"check_in","metric":"check_in_count","threshold":1,"predicate":null,"scope":"lifetime","visibility":"public","showProgress":true,"celebration":"queue","tierRationale":"Introductory action.","migrationTreatment":"Retain stable key; preserve all existing awards as legacy unless original event evidence verifies this rule."},{"key":"honest_partial","name":"Honest Check-In","description":"Post your first partial check-in.","requirement":"Post your first partial check-in.","series":"foundation","tier":"bronze","tierRank":1,"icon":"check","displayOrder":20,"status":"active","criteriaVersion":1,"source":"check_in","metric":"partial_count","threshold":1,"predicate":null,"scope":"lifetime","visibility":"public","showProgress":true,"celebration":"queue","tierRationale":"Introductory action.","migrationTreatment":"Retain stable key; preserve all existing awards as legacy unless original event evidence verifies this rule."},{"key":"iron_standard","name":"Seven for Seven","description":"Post your first check-in containing all seven Daily Actions.","requirement":"Post your first check-in containing all seven Daily Actions.","series":"foundation","tier":"bronze","tierRank":1,"icon":"dumbbell","displayOrder":30,"status":"active","criteriaVersion":1,"source":"check_in","metric":"perfect_count","threshold":1,"predicate":null,"scope":"lifetime","visibility":"public","showProgress":true,"celebration":"queue","tierRationale":"Introductory action.","migrationTreatment":"Retain stable key; preserve all existing awards as legacy unless original event evidence verifies this rule."},{"key":"first_sweat","name":"Easy Workout","description":"Post a check-in containing a completed workout explicitly set to Easy.","requirement":"Post a check-in containing a completed workout explicitly set to Easy.","series":"workout","tier":"bronze","tierRank":1,"icon":"spark","displayOrder":40,"status":"active","criteriaVersion":1,"source":"check_in","metric":"workout","threshold":1,"predicate":"easy","scope":"lifetime","visibility":"public","showProgress":false,"celebration":"queue","tierRationale":"Introductory action.","migrationTreatment":"Retain stable key; preserve all existing awards as legacy unless original event evidence verifies this rule."},{"key":"steady_grind","name":"Medium Workout","description":"Post a check-in containing a completed workout explicitly set to Medium.","requirement":"Post a check-in containing a completed workout explicitly set to Medium.","series":"workout","tier":"bronze","tierRank":1,"icon":"flame","displayOrder":50,"status":"active","criteriaVersion":1,"source":"check_in","metric":"workout","threshold":1,"predicate":"medium","scope":"lifetime","visibility":"public","showProgress":false,"celebration":"queue","tierRationale":"Introductory action.","migrationTreatment":"Retain stable key; preserve all existing awards as legacy unless original event evidence verifies this rule."},{"key":"hard_path","name":"Hard Workout","description":"Post a check-in containing a completed workout explicitly set to Hard.","requirement":"Post a check-in containing a completed workout explicitly set to Hard.","series":"workout","tier":"silver","tierRank":2,"icon":"run","displayOrder":60,"status":"active","criteriaVersion":1,"source":"check_in","metric":"workout","threshold":1,"predicate":"hard","scope":"lifetime","visibility":"public","showProgress":false,"celebration":"queue","tierRationale":"Sustained or intentional action.","migrationTreatment":"Retain stable key; preserve all existing awards as legacy unless original event evidence verifies this rule."},{"key":"extreme_fire","name":"Extreme Workout","description":"Post a check-in containing a completed workout explicitly set to Extreme.","requirement":"Post a check-in containing a completed workout explicitly set to Extreme.","series":"workout","tier":"gold","tierRank":3,"icon":"flame","displayOrder":70,"status":"active","criteriaVersion":1,"source":"check_in","metric":"workout","threshold":1,"predicate":"extreme","scope":"lifetime","visibility":"public","showProgress":false,"celebration":"queue","tierRationale":"Difficult or late challenge milestone.","migrationTreatment":"Retain stable key; preserve all existing awards as legacy unless original event evidence verifies this rule."},{"key":"streak_flame","name":"3-Day Perfect Streak","description":"Post all seven Daily Actions on 3 consecutive local calendar days in one original 77-day challenge.","requirement":"Post all seven Daily Actions on 3 consecutive local calendar days in one original 77-day challenge.","series":"perfect_streak","tier":"bronze","tierRank":1,"icon":"flame","displayOrder":80,"status":"active","criteriaVersion":1,"source":"check_in","metric":"perfect_streak","threshold":3,"predicate":null,"scope":"challenge_instance","visibility":"public","showProgress":true,"celebration":"queue","tierRationale":"Introductory action.","migrationTreatment":"Retain stable key; preserve all existing awards as legacy unless original event evidence verifies this rule."},{"key":"seven_sealed","name":"7-Day Perfect Streak","description":"Post all seven Daily Actions on 7 consecutive local calendar days in one original 77-day challenge.","requirement":"Post all seven Daily Actions on 7 consecutive local calendar days in one original 77-day challenge.","series":"perfect_streak","tier":"silver","tierRank":2,"icon":"repeat","displayOrder":90,"status":"active","criteriaVersion":1,"source":"check_in","metric":"perfect_streak","threshold":7,"predicate":null,"scope":"challenge_instance","visibility":"public","showProgress":true,"celebration":"queue","tierRationale":"Sustained or intentional action.","migrationTreatment":"Retain stable key; preserve all existing awards as legacy unless original event evidence verifies this rule."},{"key":"full_streak_14","name":"14-Day Perfect Streak","description":"Post all seven Daily Actions on 14 consecutive local calendar days in one original 77-day challenge.","requirement":"Post all seven Daily Actions on 14 consecutive local calendar days in one original 77-day challenge.","series":"perfect_streak","tier":"silver","tierRank":2,"icon":"shield","displayOrder":100,"status":"active","criteriaVersion":1,"source":"check_in","metric":"perfect_streak","threshold":14,"predicate":null,"scope":"challenge_instance","visibility":"public","showProgress":true,"celebration":"queue","tierRationale":"Sustained or intentional action.","migrationTreatment":"Retain stable key; preserve all existing awards as legacy unless original event evidence verifies this rule."},{"key":"full_streak_28","name":"28-Day Perfect Streak","description":"Post all seven Daily Actions on 28 consecutive local calendar days in one original 77-day challenge.","requirement":"Post all seven Daily Actions on 28 consecutive local calendar days in one original 77-day challenge.","series":"perfect_streak","tier":"silver","tierRank":2,"icon":"dumbbell","displayOrder":110,"status":"active","criteriaVersion":1,"source":"check_in","metric":"perfect_streak","threshold":28,"predicate":null,"scope":"challenge_instance","visibility":"public","showProgress":true,"celebration":"queue","tierRationale":"Sustained or intentional action.","migrationTreatment":"Retain stable key; preserve all existing awards as legacy unless original event evidence verifies this rule."},{"key":"full_streak_56","name":"56-Day Perfect Streak","description":"Post all seven Daily Actions on 56 consecutive local calendar days in one original 77-day challenge.","requirement":"Post all seven Daily Actions on 56 consecutive local calendar days in one original 77-day challenge.","series":"perfect_streak","tier":"gold","tierRank":3,"icon":"mountain","displayOrder":120,"status":"active","criteriaVersion":1,"source":"check_in","metric":"perfect_streak","threshold":56,"predicate":null,"scope":"challenge_instance","visibility":"public","showProgress":true,"celebration":"queue","tierRationale":"Difficult or late challenge milestone.","migrationTreatment":"Retain stable key; preserve all existing awards as legacy unless original event evidence verifies this rule."},{"key":"full_streak_70","name":"70-Day Perfect Streak","description":"Post all seven Daily Actions on 70 consecutive local calendar days in one original 77-day challenge.","requirement":"Post all seven Daily Actions on 70 consecutive local calendar days in one original 77-day challenge.","series":"perfect_streak","tier":"gold","tierRank":3,"icon":"flag","displayOrder":130,"status":"active","criteriaVersion":1,"source":"check_in","metric":"perfect_streak","threshold":70,"predicate":null,"scope":"challenge_instance","visibility":"public","showProgress":true,"celebration":"queue","tierRationale":"Difficult or late challenge milestone.","migrationTreatment":"Retain stable key; preserve all existing awards as legacy unless original event evidence verifies this rule."},{"key":"check_ins_7","name":"7 Check-Ins","description":"Post exactly 7 check-ins in one original 77-day challenge; partial check-ins count.","requirement":"Post exactly 7 check-ins in one original 77-day challenge; partial check-ins count.","series":"participation","tier":"bronze","tierRank":1,"icon":"calendar","displayOrder":140,"status":"active","criteriaVersion":1,"source":"check_in","metric":"instance_check_in_count","threshold":7,"predicate":null,"scope":"challenge_instance","visibility":"public","showProgress":true,"celebration":"queue","tierRationale":"Introductory action.","migrationTreatment":"New key: submitted participation is not elapsed calendar position."},{"key":"check_ins_14","name":"14 Check-Ins","description":"Post exactly 14 check-ins in one original 77-day challenge; partial check-ins count.","requirement":"Post exactly 14 check-ins in one original 77-day challenge; partial check-ins count.","series":"participation","tier":"silver","tierRank":2,"icon":"shield","displayOrder":150,"status":"active","criteriaVersion":1,"source":"check_in","metric":"instance_check_in_count","threshold":14,"predicate":null,"scope":"challenge_instance","visibility":"public","showProgress":true,"celebration":"queue","tierRationale":"Sustained or intentional action.","migrationTreatment":"New key: submitted participation is not elapsed calendar position."},{"key":"check_ins_21","name":"21 Check-Ins","description":"Post exactly 21 check-ins in one original 77-day challenge; partial check-ins count.","requirement":"Post exactly 21 check-ins in one original 77-day challenge; partial check-ins count.","series":"participation","tier":"silver","tierRank":2,"icon":"target","displayOrder":160,"status":"active","criteriaVersion":1,"source":"check_in","metric":"instance_check_in_count","threshold":21,"predicate":null,"scope":"challenge_instance","visibility":"public","showProgress":true,"celebration":"queue","tierRationale":"Sustained or intentional action.","migrationTreatment":"New key: submitted participation is not elapsed calendar position."},{"key":"check_ins_26","name":"26 Check-Ins","description":"Post exactly 26 check-ins in one original 77-day challenge; partial check-ins count.","requirement":"Post exactly 26 check-ins in one original 77-day challenge; partial check-ins count.","series":"participation","tier":"silver","tierRank":2,"icon":"flag","displayOrder":170,"status":"active","criteriaVersion":1,"source":"check_in","metric":"instance_check_in_count","threshold":26,"predicate":null,"scope":"challenge_instance","visibility":"public","showProgress":true,"celebration":"queue","tierRationale":"Sustained or intentional action.","migrationTreatment":"New key: submitted participation is not elapsed calendar position."},{"key":"check_ins_39","name":"39 Check-Ins","description":"Post exactly 39 check-ins in one original 77-day challenge; partial check-ins count.","requirement":"Post exactly 39 check-ins in one original 77-day challenge; partial check-ins count.","series":"participation","tier":"silver","tierRank":2,"icon":"spark","displayOrder":180,"status":"active","criteriaVersion":1,"source":"check_in","metric":"instance_check_in_count","threshold":39,"predicate":null,"scope":"challenge_instance","visibility":"public","showProgress":true,"celebration":"queue","tierRationale":"Sustained or intentional action.","migrationTreatment":"New key: submitted participation is not elapsed calendar position."},{"key":"check_ins_50","name":"50 Check-Ins","description":"Post exactly 50 check-ins in one original 77-day challenge; partial check-ins count.","requirement":"Post exactly 50 check-ins in one original 77-day challenge; partial check-ins count.","series":"participation","tier":"gold","tierRank":3,"icon":"star","displayOrder":190,"status":"active","criteriaVersion":1,"source":"check_in","metric":"instance_check_in_count","threshold":50,"predicate":null,"scope":"challenge_instance","visibility":"public","showProgress":true,"celebration":"queue","tierRationale":"Difficult or late challenge milestone.","migrationTreatment":"New key: submitted participation is not elapsed calendar position."},{"key":"check_ins_60","name":"60 Check-Ins","description":"Post exactly 60 check-ins in one original 77-day challenge; partial check-ins count.","requirement":"Post exactly 60 check-ins in one original 77-day challenge; partial check-ins count.","series":"participation","tier":"gold","tierRank":3,"icon":"dumbbell","displayOrder":200,"status":"active","criteriaVersion":1,"source":"check_in","metric":"instance_check_in_count","threshold":60,"predicate":null,"scope":"challenge_instance","visibility":"public","showProgress":true,"celebration":"queue","tierRationale":"Difficult or late challenge milestone.","migrationTreatment":"New key: submitted participation is not elapsed calendar position."},{"key":"check_ins_70","name":"70 Check-Ins","description":"Post exactly 70 check-ins in one original 77-day challenge; partial check-ins count.","requirement":"Post exactly 70 check-ins in one original 77-day challenge; partial check-ins count.","series":"participation","tier":"gold","tierRank":3,"icon":"eye","displayOrder":210,"status":"active","criteriaVersion":1,"source":"check_in","metric":"instance_check_in_count","threshold":70,"predicate":null,"scope":"challenge_instance","visibility":"public","showProgress":true,"celebration":"queue","tierRationale":"Difficult or late challenge milestone.","migrationTreatment":"New key: submitted participation is not elapsed calendar position."},{"key":"morning_watch","name":"3-Day App Streak","description":"Visit the app on 3 consecutive local calendar days.","requirement":"Visit the app on 3 consecutive local calendar days.","series":"app_streak","tier":"bronze","tierRank":1,"icon":"eye","displayOrder":220,"status":"active","criteriaVersion":1,"source":"app_visit","metric":"app_streak","threshold":3,"predicate":null,"scope":"lifetime","visibility":"public","showProgress":true,"celebration":"queue","tierRationale":"Introductory action.","migrationTreatment":"Retain stable key; preserve all existing awards as legacy unless original event evidence verifies this rule."},{"key":"watchman_week","name":"7-Day App Streak","description":"Visit the app on 7 consecutive local calendar days.","requirement":"Visit the app on 7 consecutive local calendar days.","series":"app_streak","tier":"silver","tierRank":2,"icon":"eye","displayOrder":230,"status":"active","criteriaVersion":1,"source":"app_visit","metric":"app_streak","threshold":7,"predicate":null,"scope":"lifetime","visibility":"public","showProgress":true,"celebration":"queue","tierRationale":"Sustained or intentional action.","migrationTreatment":"Retain stable key; preserve all existing awards as legacy unless original event evidence verifies this rule."},{"key":"sharing","name":"Sharing","description":"Complete a verified qualifying share.","requirement":"Complete a verified qualifying share.","series":"community","tier":"bronze","tierRank":1,"icon":"share","displayOrder":240,"status":"active","criteriaVersion":1,"source":"share","metric":"verified_share","threshold":1,"predicate":null,"scope":"lifetime","visibility":"public","showProgress":true,"celebration":"queue","tierRationale":"Introductory action.","migrationTreatment":"Retain stable key; preserve all existing awards as legacy unless original event evidence verifies this rule."},{"key":"seven_day_start","name":"Seven Days Complete","description":"Retired legacy badge; original earned record remains readable.","requirement":"Original legacy requirement is preserved with the earned record.","series":"legacy_progress","tier":"gold","tierRank":3,"icon":"shield","displayOrder":1024,"status":"retired","criteriaVersion":1,"source":"none","metric":"retired","threshold":null,"predicate":null,"scope":"lifetime","visibility":"public","showProgress":false,"celebration":"none","tierRationale":"Original earned tier is preserved in its snapshot.","migrationTreatment":"Retired calendar-position rule; new check-in-count key does not reinterpret this earned badge."},{"key":"two_week_guard","name":"Two Weeks Complete","description":"Retired legacy badge; original earned record remains readable.","requirement":"Original legacy requirement is preserved with the earned record.","series":"legacy_progress","tier":"gold","tierRank":3,"icon":"shield","displayOrder":1025,"status":"retired","criteriaVersion":1,"source":"none","metric":"retired","threshold":null,"predicate":null,"scope":"lifetime","visibility":"public","showProgress":false,"celebration":"none","tierRationale":"Original earned tier is preserved in its snapshot.","migrationTreatment":"Retired calendar-position rule; new check-in-count key does not reinterpret this earned badge."},{"key":"three_week_wall","name":"Three Weeks Complete","description":"Retired legacy badge; original earned record remains readable.","requirement":"Original legacy requirement is preserved with the earned record.","series":"legacy_progress","tier":"gold","tierRank":3,"icon":"shield","displayOrder":1026,"status":"retired","criteriaVersion":1,"source":"none","metric":"retired","threshold":null,"predicate":null,"scope":"lifetime","visibility":"public","showProgress":false,"celebration":"none","tierRationale":"Original earned tier is preserved in its snapshot.","migrationTreatment":"Retired calendar-position rule; new check-in-count key does not reinterpret this earned badge."},{"key":"third_way","name":"One-Third Complete","description":"Retired legacy badge; original earned record remains readable.","requirement":"Original legacy requirement is preserved with the earned record.","series":"legacy_progress","tier":"gold","tierRank":3,"icon":"shield","displayOrder":1027,"status":"retired","criteriaVersion":1,"source":"none","metric":"retired","threshold":null,"predicate":null,"scope":"lifetime","visibility":"public","showProgress":false,"celebration":"none","tierRationale":"Original earned tier is preserved in its snapshot.","migrationTreatment":"Retired calendar-position rule; new check-in-count key does not reinterpret this earned badge."},{"key":"deep_roots","name":"Day 33","description":"Retired legacy badge; original earned record remains readable.","requirement":"Original legacy requirement is preserved with the earned record.","series":"legacy_progress","tier":"gold","tierRank":3,"icon":"shield","displayOrder":1028,"status":"retired","criteriaVersion":1,"source":"none","metric":"retired","threshold":null,"predicate":null,"scope":"lifetime","visibility":"public","showProgress":false,"celebration":"none","tierRationale":"Original earned tier is preserved in its snapshot.","migrationTreatment":"Retired redundant calendar milestone."},{"key":"halfway_fire","name":"Halfway","description":"Retired legacy badge; original earned record remains readable.","requirement":"Original legacy requirement is preserved with the earned record.","series":"legacy_progress","tier":"gold","tierRank":3,"icon":"shield","displayOrder":1029,"status":"retired","criteriaVersion":1,"source":"none","metric":"retired","threshold":null,"predicate":null,"scope":"lifetime","visibility":"public","showProgress":false,"celebration":"none","tierRationale":"Original earned tier is preserved in its snapshot.","migrationTreatment":"Retired calendar-position rule; new check-in-count key does not reinterpret this earned badge."},{"key":"fifty_faithful","name":"Day 50","description":"Retired legacy badge; original earned record remains readable.","requirement":"Original legacy requirement is preserved with the earned record.","series":"legacy_progress","tier":"gold","tierRank":3,"icon":"shield","displayOrder":1030,"status":"retired","criteriaVersion":1,"source":"none","metric":"retired","threshold":null,"predicate":null,"scope":"lifetime","visibility":"public","showProgress":false,"celebration":"none","tierRationale":"Original earned tier is preserved in its snapshot.","migrationTreatment":"Retired calendar-position rule; new check-in-count key does not reinterpret this earned badge."},{"key":"sixty_strong","name":"Day 60","description":"Retired legacy badge; original earned record remains readable.","requirement":"Original legacy requirement is preserved with the earned record.","series":"legacy_progress","tier":"gold","tierRank":3,"icon":"shield","displayOrder":1031,"status":"retired","criteriaVersion":1,"source":"none","metric":"retired","threshold":null,"predicate":null,"scope":"lifetime","visibility":"public","showProgress":false,"celebration":"none","tierRationale":"Original earned tier is preserved in its snapshot.","migrationTreatment":"Retired calendar-position rule; new check-in-count key does not reinterpret this earned badge."},{"key":"final_watch","name":"Final Week","description":"Retired legacy badge; original earned record remains readable.","requirement":"Original legacy requirement is preserved with the earned record.","series":"legacy_progress","tier":"gold","tierRank":3,"icon":"shield","displayOrder":1032,"status":"retired","criteriaVersion":1,"source":"none","metric":"retired","threshold":null,"predicate":null,"scope":"lifetime","visibility":"public","showProgress":false,"celebration":"none","tierRationale":"Original earned tier is preserved in its snapshot.","migrationTreatment":"Retired calendar-position rule; new check-in-count key does not reinterpret this earned badge."},{"key":"full_streak_21","name":"21-Day Perfect Streak","description":"Retired legacy badge; original earned record remains readable.","requirement":"Original legacy requirement is preserved with the earned record.","series":"legacy_streak","tier":"gold","tierRank":3,"icon":"shield","displayOrder":1033,"status":"retired","criteriaVersion":1,"source":"none","metric":"retired","threshold":null,"predicate":null,"scope":"lifetime","visibility":"public","showProgress":false,"celebration":"none","tierRationale":"Original earned tier is preserved in its snapshot.","migrationTreatment":"Retired dense weekly streak cadence; existing awards retained."},{"key":"full_streak_35","name":"35-Day Perfect Streak","description":"Retired legacy badge; original earned record remains readable.","requirement":"Original legacy requirement is preserved with the earned record.","series":"legacy_streak","tier":"gold","tierRank":3,"icon":"shield","displayOrder":1034,"status":"retired","criteriaVersion":1,"source":"none","metric":"retired","threshold":null,"predicate":null,"scope":"lifetime","visibility":"public","showProgress":false,"celebration":"none","tierRationale":"Original earned tier is preserved in its snapshot.","migrationTreatment":"Retired dense weekly streak cadence; existing awards retained."},{"key":"full_streak_42","name":"42-Day Perfect Streak","description":"Retired legacy badge; original earned record remains readable.","requirement":"Original legacy requirement is preserved with the earned record.","series":"legacy_streak","tier":"gold","tierRank":3,"icon":"shield","displayOrder":1035,"status":"retired","criteriaVersion":1,"source":"none","metric":"retired","threshold":null,"predicate":null,"scope":"lifetime","visibility":"public","showProgress":false,"celebration":"none","tierRationale":"Original earned tier is preserved in its snapshot.","migrationTreatment":"Retired dense weekly streak cadence; existing awards retained."},{"key":"full_streak_49","name":"49-Day Perfect Streak","description":"Retired legacy badge; original earned record remains readable.","requirement":"Original legacy requirement is preserved with the earned record.","series":"legacy_streak","tier":"gold","tierRank":3,"icon":"shield","displayOrder":1036,"status":"retired","criteriaVersion":1,"source":"none","metric":"retired","threshold":null,"predicate":null,"scope":"lifetime","visibility":"public","showProgress":false,"celebration":"none","tierRationale":"Original earned tier is preserved in its snapshot.","migrationTreatment":"Retired dense weekly streak cadence; existing awards retained."},{"key":"full_streak_63","name":"63-Day Perfect Streak","description":"Retired legacy badge; original earned record remains readable.","requirement":"Original legacy requirement is preserved with the earned record.","series":"legacy_streak","tier":"gold","tierRank":3,"icon":"shield","displayOrder":1037,"status":"retired","criteriaVersion":1,"source":"none","metric":"retired","threshold":null,"predicate":null,"scope":"lifetime","visibility":"public","showProgress":false,"celebration":"none","tierRationale":"Original earned tier is preserved in its snapshot.","migrationTreatment":"Retired dense weekly streak cadence; existing awards retained."},{"key":"day_77_finisher","name":"77 Days Complete","description":"Retired legacy badge; original earned record remains readable.","requirement":"Original legacy requirement is preserved with the earned record.","series":"legacy_progress","tier":"gold","tierRank":3,"icon":"shield","displayOrder":1038,"status":"retired","criteriaVersion":1,"source":"none","metric":"retired","threshold":null,"predicate":null,"scope":"lifetime","visibility":"public","showProgress":false,"celebration":"none","tierRationale":"Original earned tier is preserved in its snapshot.","migrationTreatment":"Retired elapsed-day rule; no new finisher until an approved canonical completion event exists."},{"key":"original_77_completed","name":"77-Day Finisher","description":"Complete the original 77-day challenge under its authoritative completion rules.","requirement":"Complete the original 77-day challenge under its authoritative completion rules.","series":"completion","tier":"gold","tierRank":3,"icon":"crown","displayOrder":900,"status":"blocked","criteriaVersion":1,"source":"challenge_completion","metric":"original_77_completion","threshold":1,"predicate":null,"scope":"challenge_instance","visibility":"public","showProgress":false,"celebration":"queue","tierRationale":"Reserved for authoritative challenge completion.","migrationTreatment":"New key; completion predicate is awaiting product decision. No evaluator accepts client completion flags or elapsed day77 as evidence."}]$badge_catalog$::jsonb) rule
on conflict(badge_key) do update set
  name = case when excluded.retired then public.badge_definitions.name else excluded.name end,
  description = case when excluded.retired then public.badge_definitions.description else excluded.description end,
  requirement = case when excluded.retired then public.badge_definitions.description else excluded.requirement end,
  category = case when excluded.retired then public.badge_definitions.category else excluded.category end,
  tier = case when excluded.retired then public.badge_definitions.tier else excluded.tier end,
  tier_rank = excluded.tier_rank,
  icon = case when excluded.retired then public.badge_definitions.icon else excluded.icon end,
  sort_order=excluded.sort_order,criteria_version=excluded.criteria_version,source_event=excluded.source_event,
  metric=excluded.metric,threshold=excluded.threshold,predicate=excluded.predicate,scope=excluded.scope,
  visibility=excluded.visibility,show_progress=excluded.show_progress,celebration=excluded.celebration,
  retired=excluded.retired,blocked=excluded.blocked;
-- END CANONICAL CATALOG V1

create table private.badge_app_visits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  local_date date not null,
  occurred_at timestamptz not null default clock_timestamp(),
  time_zone text not null,
  unique(user_id,local_date)
);
alter table private.badge_app_visits enable row level security;
revoke all on private.badge_app_visits from public,anon,authenticated,service_role;

create function private.badge_rule_matches(
  rule_metric text, rule_threshold integer, rule_predicate text, facts jsonb
) returns boolean language sql immutable security invoker set search_path = ''
as $$
  select case
    when rule_metric = 'workout' then facts->'workouts'->>rule_predicate in ('one','two')
    when rule_metric in ('check_in_count','partial_count','perfect_count','instance_check_in_count','perfect_streak','app_streak','verified_share')
      then (facts->>rule_metric)::integer = rule_threshold
    else false end;
$$;
revoke all on function private.badge_rule_matches(text,integer,text,jsonb) from public,anon,authenticated,service_role;

create function private.persist_badge_event(
  actor uuid, event_source text, source_id uuid, instance_id text,
  local_date date, occurred_at timestamptz, facts jsonb, reconciled boolean default false
) returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare
  rule public.badge_definitions%rowtype;
  scope_identity text;
  evidence jsonb;
  award_id uuid;
  result jsonb := '[]'::jsonb;
begin
  if actor is null or source_id is null or local_date is null or occurred_at is null then
    raise exception 'Canonical badge event required.' using errcode='22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(actor::text,1499));
  for rule in select * from public.badge_definitions
    where not retired and not blocked and criteria_version=1 and source_event=event_source
    order by sort_order,badge_key
  loop
    if rule.scope='challenge_instance' and coalesce(instance_id,'')='' then continue; end if;
    if not coalesce(private.badge_rule_matches(rule.metric,rule.threshold,rule.predicate,facts),false) then continue; end if;
    scope_identity := case when rule.scope='lifetime' then 'lifetime' else instance_id end;
    evidence := case
      when rule.metric='workout' then jsonb_build_object('schemaVersion',1,'kind','workout',
        'workout',facts->'workouts'->>rule.predicate,'difficulty',rule.predicate)
      when rule.metric in ('partial_count','perfect_count') then jsonb_build_object('schemaVersion',1,'kind','daily_standards','completedCount',facts->'completedCount')
      else jsonb_build_object('schemaVersion',1,'kind',
        case rule.metric when 'perfect_streak' then 'perfect_streak' when 'app_streak' then 'app_streak'
          when 'verified_share' then 'share' else 'check_in' end,'qualifyingValue',facts->rule.metric)
      end;
    insert into public.user_badges(user_id,badge_key,scope_key,entry_date,earned_at,metadata,celebration_seen_at)
    values(actor,rule.badge_key,scope_identity,local_date,occurred_at,
      jsonb_build_object('legacy',false,'reconciled',reconciled,'criteriaVersion',1,'sourceType',event_source,'sourceRecordId',source_id,
        'challengeInstanceId',nullif(instance_id,''),'qualifyingValue',
        case when rule.metric='workout' then '1'::jsonb else facts->rule.metric end,
        'earningEvidence',evidence,'awardDefinition',jsonb_build_object(
          'name',rule.name,'description',rule.description,'requirement',rule.requirement,
          'tier',rule.tier,'icon',rule.icon,'category',rule.category,'displayOrder',rule.sort_order)),
      case when reconciled or rule.celebration='none' then occurred_at else null end)
    on conflict(user_id,badge_key,scope_key) do nothing returning id into award_id;
    if award_id is not null then result := result || jsonb_build_array(award_id); end if;
  end loop;
  return result;
end;
$$;
revoke all on function private.persist_badge_event(uuid,text,uuid,text,date,timestamptz,jsonb,boolean)
  from public,anon,authenticated,service_role;

create function private.check_in_badge_facts(event_id uuid)
returns jsonb language plpgsql stable security invoker set search_path = ''
as $$
declare
  event public.check_ins%rowtype;
  start_date date;
  actions text[] := array['bible','morningPrayer','worshipOnly','eveningPrayer','workoutOne','walk','workoutTwo'];
  all_count integer; instance_count integer; partial_count integer; perfect_count integer;
  completed_count integer; streak integer := 0; check_date date; workouts jsonb := '{}'::jsonb;
begin
  select * into event from public.check_ins where id=event_id;
  if event.id is null or event.challenge_day not between 1 and 77 then return null; end if;
  start_date := event.entry_date - (event.challenge_day-1);
  if not exists(select 1 from public.profiles p where p.user_id=event.user_id
    and p.challenge_start_date=start_date and not p.challenge_activation_review_required) then return null; end if;
  select count(distinct action)::integer into completed_count from unnest(event.completed) action where action=any(actions);
  if completed_count < 1 or completed_count <> cardinality(event.completed)
    or event.status not in ('complete','partial') then return null; end if;
  select count(*)::integer,
    count(*) filter(where c.entry_date-(c.challenge_day-1)=start_date)::integer,
    count(*) filter(where cardinality(c.completed)<7)::integer,
    count(*) filter(where cardinality(c.completed)=7 and c.completed @> actions)::integer
    into all_count,instance_count,partial_count,perfect_count
  from public.check_ins c where c.user_id=event.user_id and c.entry_date<=event.entry_date
    and c.status in ('complete','partial') and cardinality(c.completed) between 1 and 7
    and c.completed <@ actions and cardinality(c.completed)=(select count(distinct a) from unnest(c.completed) a);
  check_date := event.entry_date;
  while exists(select 1 from public.check_ins c where c.user_id=event.user_id and c.entry_date=check_date
    and c.entry_date-(c.challenge_day-1)=start_date and c.status in ('complete','partial')
    and cardinality(c.completed)=7 and c.completed @> actions)
  loop streak := streak+1; check_date := check_date-1; end loop;
  if 'workoutOne'=any(event.completed) and event.workout_difficulty->>'one' in ('easy','medium','hard','extreme') then
    workouts := workouts || jsonb_build_object(event.workout_difficulty->>'one','one');
  end if;
  if 'workoutTwo'=any(event.completed) and event.workout_difficulty->>'two' in ('easy','medium','hard','extreme')
    and not(workouts ? (event.workout_difficulty->>'two')) then
    workouts := workouts || jsonb_build_object(event.workout_difficulty->>'two','two');
  end if;
  return jsonb_build_object('instanceId','original77:'||start_date::text,
    'check_in_count',all_count,'instance_check_in_count',instance_count,
    'partial_count',case when completed_count<7 then partial_count else 0 end,
    'perfect_count',case when completed_count=7 then perfect_count else 0 end,
    'perfect_streak',streak,'completedCount',completed_count,'workouts',workouts);
end;
$$;
revoke all on function private.check_in_badge_facts(uuid) from public,anon,authenticated,service_role;

-- Existing before-insert scoring is retained, without any badge priority list.
create or replace function public.process_check_in_game_rewards()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare points_inserted boolean; action_points integer;
begin
  if (select auth.uid()) is distinct from new.user_id then
    raise exception 'Check-in actor mismatch.' using errcode='42501';
  end if;
  if new.status='scheduled' then
    raise exception 'Scheduled miss Check-Ins are no longer supported.' using errcode='22023';
  end if;
  if new.challenge_day not between 1 and 77 or new.status not in ('complete','partial') then
    raise exception 'Invalid check-in.' using errcode='22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.user_id::text,0));
  new.completed_count := cardinality(new.completed);
  action_points := least(greatest(new.completed_count,0),7);
  points_inserted := public.add_game_points(new.user_id,'check_in',action_points,new.entry_date,
    new.challenge_day,null,jsonb_build_object('status',new.status,'completedCount',new.completed_count,
    'completed',new.completed,'workoutDifficulty',new.workout_difficulty,'actionPoints',action_points),
    'checkin:'||new.user_id::text||':'||new.entry_date::text);
  new.points_awarded := case when points_inserted then action_points else 0 end;
  return new;
end;
$$;
revoke all on function public.process_check_in_game_rewards() from public,anon,authenticated,service_role;

create function private.award_check_in_badges()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare facts jsonb;
begin
  if (select auth.uid()) is distinct from new.user_id then
    raise exception 'Check-in actor mismatch.' using errcode='42501';
  end if;
  facts := private.check_in_badge_facts(new.id);
  if facts is null then raise exception 'Canonical challenge instance is required.' using errcode='22023'; end if;
  perform private.persist_badge_event(new.user_id,'check_in',new.id,facts->>'instanceId',new.entry_date,new.created_at,facts);
  update public.user_game_stats set current_full_day_streak=(facts->>'perfect_streak')::integer,
    best_full_day_streak=greatest(best_full_day_streak,(facts->>'perfect_streak')::integer),
    last_full_day_date=case when (facts->>'perfect_streak')::integer>0 then new.entry_date else last_full_day_date end
    where user_id=new.user_id;
  return new;
end;
$$;
revoke all on function private.award_check_in_badges() from public,anon,authenticated,service_role;
create trigger award_check_in_badges_after_insert after insert on public.check_ins
  for each row execute function private.award_check_in_badges();

create or replace function public.record_app_visit_pre_activation()
returns table(total_points integer,current_app_streak integer,best_app_streak integer,new_badges jsonb)
language plpgsql security definer set search_path = ''
as $$
declare actor uuid := (select auth.uid()); visit private.badge_app_visits%rowtype;
  visit_date date; zone text; streak integer:=0; check_date date; ids jsonb := '[]'::jsonb;
  prior_stats public.user_game_stats%rowtype; display_streak integer;
begin
  if actor is null or not public.has_active_entitlement('membership_active') then
    raise exception 'Active membership is required.' using errcode='42501';
  end if;
  visit_date := public.daily_standard_user_date(actor);
  select coalesce(nullif(p.challenge_activation_time_zone,''),nullif(p.time_zone,''),'UTC') into zone
    from public.profiles p where p.user_id=actor;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(actor::text,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(actor::text,1499));
  insert into private.badge_app_visits(user_id,local_date,time_zone) values(actor,visit_date,coalesce(zone,'UTC'))
    on conflict(user_id,local_date) do nothing returning * into visit;
  if visit.id is not null then
    check_date := visit_date;
    while exists(select 1 from private.badge_app_visits v where v.user_id=actor and v.local_date=check_date)
      loop streak:=streak+1; check_date:=check_date-1; end loop;
    perform public.ensure_user_game_stats(actor);
    select * into prior_stats from public.user_game_stats where user_id=actor for update;
    -- Preserve an ongoing trusted display streak across cutover. This aggregate
    -- is never fed to award rules: only the immutable visit rows above qualify.
    display_streak := case when prior_stats.last_seen_date=visit_date then greatest(prior_stats.current_app_streak,1)
      when prior_stats.last_seen_date=visit_date-1 then greatest(prior_stats.current_app_streak,0)+1 else 1 end;
    update public.user_game_stats s set current_app_streak=display_streak,
      best_app_streak=greatest(s.best_app_streak,display_streak),last_seen_date=visit_date where s.user_id=actor;
    ids := private.persist_badge_event(actor,'app_visit',visit.id,'',visit_date,visit.occurred_at,
      jsonb_build_object('app_streak',streak));
  end if;
  return query select s.total_points,s.current_app_streak,s.best_app_streak,ids
    from public.user_game_stats s where s.user_id=actor;
end;
$$;
revoke all on function public.record_app_visit_pre_activation() from public,anon,authenticated,service_role;

-- The old generic primitive is no longer a way to award arbitrary keys. Sharing
-- remains on its existing verified evidence and 14-point ledger transaction.
create or replace function public.award_badge(target_user_id uuid,target_badge_key text,
  target_earned_date date default null,target_metadata jsonb default '{}'::jsonb)
returns boolean language plpgsql security invoker set search_path = ''
as $$
declare evidence public.sharing_reward_evidence%rowtype; ids jsonb;
begin
  if target_badge_key<>'sharing' then raise exception 'Use a canonical badge event.' using errcode='42501'; end if;
  select * into evidence from public.sharing_reward_evidence where user_id=target_user_id order by recorded_at,id limit 1;
  if evidence.id is null or not exists(select 1 from public.game_point_events where user_id=target_user_id
    and event_type='sharing_bonus' and points=14 and idempotency_key='sharing_bonus:'||target_user_id::text) then
    raise exception 'Verified sharing evidence is required.' using errcode='42501';
  end if;
  ids := private.persist_badge_event(target_user_id,'share',evidence.id,'',
    (evidence.recorded_at at time zone 'UTC')::date,evidence.recorded_at,jsonb_build_object('verified_share',1));
  return jsonb_array_length(ids)>0;
end;
$$;
revoke all on function public.award_badge(uuid,text,date,jsonb) from public,anon,authenticated,service_role;

create function public.claim_badge_celebrations(target_expected_actor_id uuid,target_claim_token uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare actor uuid := (select auth.uid()); result jsonb;
begin
  if actor is null or actor is distinct from target_expected_actor_id or target_claim_token is null
    or not public.has_active_entitlement('membership_active') then raise exception 'Badge actor mismatch.' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(actor::text,1499));
  with candidates as (
    select a.id from public.user_badges a join public.badge_definitions d on d.badge_key=a.badge_key
    where a.user_id=actor and a.celebration_seen_at is null
      and (a.celebration_claim_token=target_claim_token or a.celebration_claim_until is null or a.celebration_claim_until<=clock_timestamp())
    order by d.sort_order,a.earned_at,a.id limit 8 for update of a
  ), leased as (update public.user_badges a set celebration_claim_token=target_claim_token,
      celebration_claim_until=clock_timestamp()+interval '2 minutes'
    from candidates where a.id=candidates.id returning a.*)
  select coalesce(jsonb_agg(to_jsonb(a) order by d.sort_order,a.earned_at,a.id),'[]'::jsonb) into result
    from leased a join public.badge_definitions d on d.badge_key=a.badge_key;
  return result;
end;
$$;
revoke all on function public.claim_badge_celebrations(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.claim_badge_celebrations(uuid,uuid) to authenticated;

create function public.acknowledge_badge_celebrations(target_expected_actor_id uuid,target_claim_token uuid,target_award_ids uuid[])
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare actor uuid := (select auth.uid());
begin
  if actor is null or actor is distinct from target_expected_actor_id or target_claim_token is null
    or coalesce(cardinality(target_award_ids),0)>8
    or not public.has_active_entitlement('membership_active') then raise exception 'Badge actor mismatch.' using errcode='42501'; end if;
  update public.user_badges set celebration_seen_at=clock_timestamp(),celebration_claim_until=null
    where user_id=actor and id=any(target_award_ids) and celebration_claim_token=target_claim_token
      and celebration_seen_at is null;
  return (select coalesce(jsonb_agg(id),'[]'::jsonb) from public.user_badges
    where user_id=actor and id=any(target_award_ids) and celebration_seen_at is not null);
end;
$$;
revoke all on function public.acknowledge_badge_celebrations(uuid,uuid,uuid[]) from public,anon,authenticated,service_role;
grant execute on function public.acknowledge_badge_celebrations(uuid,uuid,uuid[]) to authenticated;

-- Suppress historical replay notifications without changing outbound consent.
-- Scoped awards have distinct event identities; lifetime identities stay stable.
create or replace function private.emit_badge_outbound_event()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare reward_name text;
begin
  if new.metadata->>'reconciled'='true' then return new; end if;
  select coalesce(new.metadata->'awardDefinition'->>'name',d.name) into reward_name
    from public.badge_definitions d where d.badge_key=new.badge_key;
  if reward_name is not null and char_length(btrim(reward_name)) between 1 and 100 then
    perform private.enqueue_crew_outbound_event(new.user_id,'badge_reward',
      'badge:'||new.user_id::text||':'||new.badge_key||
        case when new.scope_key='lifetime' then '' else ':'||new.scope_key end,
      jsonb_build_object('rewardKind','badge','rewardName',reward_name));
  end if;
  return new;
end;
$$;
revoke all on function private.emit_badge_outbound_event() from public,anon,authenticated,service_role;

-- Reconcile only canonical posted check-in evidence. No aggregate, app-streak
-- counter or old finisher flag is promoted into provenance. All inserted rows
-- retain the original event timestamp and are already presented at cutover.
do $reconcile$
declare event public.check_ins%rowtype; facts jsonb;
begin
  for event in select * from public.check_ins order by user_id,entry_date,id loop
    facts := private.check_in_badge_facts(event.id);
    if facts is not null then
      perform private.persist_badge_event(event.user_id,'check_in',event.id,facts->>'instanceId',
        event.entry_date,event.created_at,facts,true);
    end if;
  end loop;
end;
$reconcile$;

create function public.get_badge_collection(target_expected_actor_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare actor uuid := (select auth.uid()); rule public.badge_definitions%rowtype;
  latest public.check_ins%rowtype; facts jsonb := '{}'::jsonb; instance_id text;
  today date; visit_date date; app_streak integer := 0; current_value integer;
  is_earned boolean; items jsonb := '[]'::jsonb;
begin
  if actor is null or actor is distinct from target_expected_actor_id
    or not public.has_active_entitlement('membership_active') then raise exception 'Badge actor mismatch.' using errcode='42501'; end if;
  today := public.daily_standard_user_date(actor);
  select 'original77:'||p.challenge_start_date::text into instance_id from public.profiles p
    where p.user_id=actor and not p.challenge_activation_review_required;
  select * into latest from public.check_ins c where c.user_id=actor order by entry_date desc,id limit 1;
  if latest.id is not null then facts := coalesce(private.check_in_badge_facts(latest.id),'{}'::jsonb); end if;
  if instance_id is null or facts->>'instanceId' is distinct from instance_id then
    facts := facts || jsonb_build_object('instance_check_in_count',0,'perfect_streak',0);
  end if;
  if latest.entry_date < today-1 then facts := facts || jsonb_build_object('perfect_streak',0); end if;
  select max(v.local_date) into visit_date from private.badge_app_visits v where v.user_id=actor;
  if visit_date>=today-1 then
    while exists(select 1 from private.badge_app_visits v where v.user_id=actor and v.local_date=visit_date)
      loop app_streak:=app_streak+1;visit_date:=visit_date-1;end loop;
  end if;
  facts := facts || jsonb_build_object('app_streak',app_streak);
  for rule in select * from public.badge_definitions d
    where (not d.retired and d.visibility='public') or exists(select 1 from public.user_badges a where a.user_id=actor and a.badge_key=d.badge_key)
    order by d.sort_order,d.badge_key limit 100
  loop
    select exists(select 1 from public.user_badges a where a.user_id=actor and a.badge_key=rule.badge_key
      and a.scope_key=case when rule.scope='lifetime' then 'lifetime' else instance_id end) into is_earned;
    current_value := case when is_earned then coalesce(rule.threshold,0)
      when rule.metric in ('check_in_count','partial_count','perfect_count','instance_check_in_count','perfect_streak','app_streak')
        then greatest(coalesce((facts->>rule.metric)::integer,0),0) else 0 end;
    items := items || jsonb_build_array(jsonb_build_object(
      'key',rule.badge_key,'name',rule.name,'description',rule.description,'requirement',rule.requirement,
      'series',rule.category,'tier',rule.tier,'tierRank',rule.tier_rank,'icon',rule.icon,'displayOrder',rule.sort_order,
      'status',case when rule.retired then 'retired' when rule.blocked then 'blocked' else 'active' end,
      'scope',rule.scope,'criteriaVersion',rule.criteria_version,'sourceEvent',rule.source_event,
      'visibility',rule.visibility,'showProgress',rule.show_progress,'earnedInCurrentScope',is_earned,
      'progress',jsonb_build_object('metric',rule.metric,'current',current_value,'target',rule.threshold)));
  end loop;
  return jsonb_build_object('catalogVersion',1,'scopeKey',instance_id,'items',items);
end;
$$;
revoke all on function public.get_badge_collection(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_badge_collection(uuid) to authenticated;
