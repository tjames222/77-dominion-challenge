-- Repeatable, actor/instance-bound challenge execution. Historical event,
-- reward, badge and share identities are retained; this does not change billing.
set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- Fence lifecycle writers before taking any child-table DDL lock. Auth-parent
-- deletion takes the same parent -> profile -> child order. Reads and FK
-- key-share checks remain available; each busy lifecycle lock times out at 5s.
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('retired-community-deletion',0));
lock table auth.users in share mode;
lock table public.profiles in exclusive mode;
-- Direct child-table writers need not follow the lifecycle RPC lock order.
-- Acquire the eventual DDL modes now, without waiting behind such a writer;
-- any contention aborts this whole transaction before source capture or DDL.
lock table public.check_ins,public.challenge_entries,public.reward_definitions,
  public.challenge_definitions,public.user_challenge_states,public.reward_catalog_meta,
  public.public_share_snapshots in access exclusive mode nowait;
lock table public.user_reward_entitlements,private.original_77_completion_events in exclusive mode nowait;

create table private.challenge_instances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  challenge_key text not null references public.challenge_definitions(challenge_key)
    check (challenge_key ~ '^[a-z][a-z0-9_]{0,79}$'),
  title text not null check (length(btrim(title)) between 1 and 180),
  scope_key text not null,
  sequence_no bigint not null check (sequence_no >= 0),
  status text not null check (status in ('scheduled','active','completed')),
  start_date date not null check (isfinite(start_date) and start_date between date '0001-01-01' and date '9999-12-31'),
  time_zone text not null check (length(time_zone) between 1 and 100),
  participation_mode text not null check (participation_mode in ('solo','group')),
  crew_id uuid,
  target_count integer not null check (target_count between 1 and 365),
  provenance text not null check (provenance in ('live','legacy_bound','legacy_completed')),
  review_required boolean not null default false,
  completed_at timestamptz check (completed_at is null or (isfinite(completed_at)
    and completed_at>=timestamptz '0001-01-01 00:00:00+00' and completed_at<timestamptz '10000-01-01 00:00:00+00')),
  completion_event_id uuid,
  created_at timestamptz not null default clock_timestamp() check (isfinite(created_at)
    and created_at>=timestamptz '0001-01-01 00:00:00+00' and created_at<timestamptz '10000-01-01 00:00:00+00'),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata)='object'),
  unique(user_id,sequence_no), unique(user_id,scope_key), unique(id,user_id),
  check ((participation_mode='solo' and crew_id is null) or (participation_mode='group' and crew_id is not null)),
  check ((challenge_key='original_77' and target_count=77) or challenge_key<>'original_77'),
  check (scope_key='instance:'||id::text or (challenge_key='original_77' and sequence_no=0 and scope_key='original77:'||start_date::text)),
  check ((status<>'completed' and completed_at is null and completion_event_id is null)
    or (status='completed' and (provenance='legacy_completed' or (completed_at is not null and completion_event_id is not null)))),
  check (provenance<>'legacy_completed' or (status='completed' and completion_event_id is null))
);
create unique index challenge_instances_one_open on private.challenge_instances(user_id)
  where status in ('scheduled','active');
create index challenge_instances_completed_definition on private.challenge_instances(user_id,challenge_key)
  where status='completed' and not review_required;
create index challenge_instances_definition on private.challenge_instances(challenge_key);

create table private.challenge_runtime (
  user_id uuid primary key references auth.users(id) on delete cascade,
  current_instance_id uuid,
  revision bigint not null default 0 check (revision>=0),
  review_required boolean not null default false,
  review_reason text,
  check ((not review_required and review_reason is null)
    or (review_required and review_reason is not null and length(btrim(review_reason)) between 1 and 120)),
  foreign key(current_instance_id,user_id) references private.challenge_instances(id,user_id)
    on delete no action deferrable initially deferred
);
create index challenge_runtime_instance_owner on private.challenge_runtime(current_instance_id,user_id)
  where current_instance_id is not null;

-- Deleting a run alone must not delete its source history. Deferred NO ACTION
-- links permit the existing Auth-user cascade to erase all owned rows together.
alter table public.check_ins add column challenge_instance_id uuid;
alter table public.check_ins add foreign key(challenge_instance_id,user_id)
  references private.challenge_instances(id,user_id) on delete no action deferrable initially deferred;
alter table public.check_ins add constraint check_ins_instance_source_identity unique(id,challenge_instance_id,user_id);
alter table public.challenge_entries add column challenge_instance_id uuid;
alter table public.challenge_entries add foreign key(challenge_instance_id,user_id)
  references private.challenge_instances(id,user_id) on delete no action deferrable initially deferred;
create index challenge_entries_instance_owner on public.challenge_entries(challenge_instance_id,user_id)
  where challenge_instance_id is not null;

create table private.challenge_instance_completions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  instance_id uuid not null unique,
  source_check_in_id uuid not null unique,
  local_date date not null check(isfinite(local_date) and local_date between date '0001-01-01' and date '9999-12-31'),
  completed_at timestamptz not null check(isfinite(completed_at)
    and completed_at>=timestamptz '0001-01-01 00:00:00+00' and completed_at<timestamptz '10000-01-01 00:00:00+00'),
  persisted_at timestamptz not null default clock_timestamp() check(isfinite(persisted_at)
    and persisted_at>=timestamptz '0001-01-01 00:00:00+00' and persisted_at<timestamptz '10000-01-01 00:00:00+00'),
  target_count integer not null check(target_count between 1 and 365),
  criteria_version integer not null default 1 check(criteria_version=1),
  unique(id,instance_id,user_id),
  foreign key(instance_id,user_id) references private.challenge_instances(id,user_id)
    on delete no action deferrable initially deferred,
  foreign key(source_check_in_id,instance_id,user_id) references public.check_ins(id,challenge_instance_id,user_id)
    on delete no action deferrable initially deferred
);
alter table private.challenge_instances add foreign key(completion_event_id,id,user_id)
  references private.challenge_instance_completions(id,instance_id,user_id) deferrable initially deferred;
create index challenge_instance_completions_owner on private.challenge_instance_completions(user_id);
create index challenge_instances_completion_event on private.challenge_instances(completion_event_id) where completion_event_id is not null;

create table private.challenge_instance_requests (
  request_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null check(action in ('start','set_start')),
  request_hash bytea not null check(octet_length(request_hash)=32),
  result jsonb not null check(jsonb_typeof(result)='object'),
  created_at timestamptz not null default clock_timestamp() check(isfinite(created_at)
    and created_at>=timestamptz '0001-01-01 00:00:00+00' and created_at<timestamptz '10000-01-01 00:00:00+00')
);
create index challenge_instance_requests_owner on private.challenge_instance_requests(user_id);
create table private.reward_grant_preservation (
  user_id uuid not null references auth.users(id) on delete cascade,
  reward_key text not null references public.reward_definitions(reward_key),
  catalog_version bigint not null check(catalog_version>0),
  reason text not null check(reason='catalog_v1_preserved'),
  prior_state jsonb not null check(jsonb_typeof(prior_state)='object'),
  recorded_at timestamptz not null default clock_timestamp() check(isfinite(recorded_at)
    and recorded_at>=timestamptz '0001-01-01 00:00:00+00' and recorded_at<timestamptz '10000-01-01 00:00:00+00'),
  primary key(user_id,reward_key)
);

alter table private.challenge_instances enable row level security;
alter table private.challenge_instances force row level security;
alter table private.challenge_runtime enable row level security;
alter table private.challenge_runtime force row level security;
alter table private.challenge_instance_completions enable row level security;
alter table private.challenge_instance_completions force row level security;
alter table private.challenge_instance_requests enable row level security;
alter table private.challenge_instance_requests force row level security;
alter table private.reward_grant_preservation enable row level security;
alter table private.reward_grant_preservation force row level security;
revoke all on private.challenge_instances,private.challenge_runtime,
  private.challenge_instance_completions,private.challenge_instance_requests,
  private.reward_grant_preservation from public,anon,authenticated,service_role;

-- Preserve the global per-user local-date barrier. Only calendar ordinals are
-- scoped to a run, so round-two day 1 cannot collide with round-one day 1.
drop index public.check_ins_user_challenge_day_unique_idx;
create unique index check_ins_instance_challenge_day_unique_idx
  on public.check_ins(challenge_instance_id,challenge_day)
  where challenge_instance_id is not null;
create index check_ins_instance_date_idx on public.check_ins(challenge_instance_id,entry_date);

insert into private.reward_grant_preservation(user_id,reward_key,catalog_version,reason,prior_state)
select e.user_id,e.reward_key,m.catalog_version,'catalog_v1_preserved',to_jsonb(e)
from public.user_reward_entitlements e cross join public.reward_catalog_meta m where m.catalog_key='primary'
union all
select s.user_id,d.reward_key,m.catalog_version,'catalog_v1_preserved',to_jsonb(s)
from public.user_challenge_states s join public.reward_definitions d on d.challenge_key=s.challenge_key
cross join public.reward_catalog_meta m where m.catalog_key='primary';

alter table public.reward_definitions alter column points_required drop not null;
alter table public.reward_definitions
  add column unlock_rule_type text not null default 'lifetime_points',
  add column prerequisite_challenge_key text references public.challenge_definitions(challenge_key),
  add column phase text not null default 'core' check(phase in ('core','post_core')),
  add column released boolean not null default true;
alter table public.challenge_definitions alter column points_required drop not null;
alter table public.user_challenge_states alter column unlock_points drop not null;
alter table public.reward_catalog_meta add column effective_at timestamptz not null default clock_timestamp();

-- Stop the old point-only fan-out before changing any definitions. The generic
-- rule-aware reconciliation installed below replaces it in this transaction.
drop trigger sync_challenge_definition_unlocks on public.challenge_definitions;
drop trigger if exists sync_challenge_reward_definition on public.challenge_definitions;
drop trigger sync_reward_definition_entitlements on public.reward_definitions;

create or replace function private.audit_reward_definition_change()
returns trigger language plpgsql security definer set search_path='' as $$
declare audit_metadata jsonb;
begin
  audit_metadata:=jsonb_build_object('rewardType',new.reward_type,'stateModel',new.state_model,
    'title',new.title,'description',new.description,'pointsRequired',new.points_required,
    'fulfillmentKey',new.fulfillment_key,'requiredEntitlementKey',new.required_entitlement_key,
    'icon',new.icon,'sortOrder',new.sort_order,'active',new.is_active,'displayMetadata',new.display_metadata,
    'unlockRuleType',new.unlock_rule_type,'prerequisiteChallengeKey',new.prerequisite_challenge_key,
    'phase',new.phase,'released',new.released);
  insert into private.reward_audit_events(event_key,event_type,reward_key,metadata)
    values('definition:'||new.reward_key||':'||md5(audit_metadata::text),
      'reward_definition_configured',new.reward_key,audit_metadata) on conflict(event_key) do nothing;
  return new;
end;
$$;
revoke all on function private.audit_reward_definition_change() from public,anon,authenticated,service_role;
drop trigger audit_reward_definition_change on public.reward_definitions;
create trigger audit_reward_definition_change
  after insert or update of reward_type,state_model,title,description,points_required,fulfillment_key,
    required_entitlement_key,icon,sort_order,is_active,display_metadata,
    unlock_rule_type,prerequisite_challenge_key,phase,released on public.reward_definitions
  for each row execute function private.audit_reward_definition_change();

update public.reward_definitions d set
  points_required=v.points,sort_order=v.position,unlock_rule_type=v.rule,
  prerequisite_challenge_key=v.predecessor,phase=v.phase
from (values
  ('gym_training_discount',42,10,'trusted_points',null,'core'),
  ('dominion_night_theme',112,20,'lifetime_points',null,'core'),
  ('nehemiah_leadership_handbook',210,30,'lifetime_points',null,'core'),
  ('dominion_platinum',308,40,'lifetime_points',null,'core'),
  ('seven_day_reset',420,50,'lifetime_points',null,'core'),
  ('big_god_energy_tshirt_discount',532,60,'lifetime_points',null,'core'),
  ('twenty_one_day_prayer',null,70,'challenge_completion','seven_day_reset','post_core'),
  ('thirty_day_strength',null,80,'challenge_completion','twenty_one_day_prayer','post_core'),
  ('forty_day_fast',null,90,'challenge_completion','thirty_day_strength','post_core'),
  ('bible_in_a_year',null,100,'challenge_completion','forty_day_fast','post_core')
) v(key,points,position,rule,predecessor,phase) where d.reward_key=v.key;
alter table public.reward_definitions add constraint reward_definition_unlock_rule_v2 check (
  (unlock_rule_type in ('trusted_points','lifetime_points') and points_required is not null and points_required>=21
    and prerequisite_challenge_key is null and phase='core')
  or (unlock_rule_type='challenge_completion' and points_required is null
    and prerequisite_challenge_key is not null and challenge_key is not null and state_model='challenge_lifecycle'
    and phase='post_core' and prerequisite_challenge_key<>challenge_key)
);
update public.challenge_definitions c set points_required=d.points_required,sort_order=d.sort_order
from public.reward_definitions d where d.challenge_key=c.challenge_key;

-- The original definition is execution data, not an eleventh point reward.
insert into public.challenge_definitions(challenge_key,title,teaser,challenge_type,
  points_required,duration_days,entitlement_key,sort_order,is_active)
values('original_77','77-Day Dominion Challenge','Submit 77 check-ins; partial check-ins count.',
  'original',null,77,'membership_active',0,true);

-- Current participation/streak rules apply to every UUID-bound challenge run.
-- Correct only their display copy; immutable earned award snapshots and every
-- rule identity, threshold, scope and criteria version remain untouched.
do $instance_badge_copy$
declare changed integer;
begin
  update public.badge_definitions d set
    description=replace(d.description,'one original 77-day challenge','one challenge run'),
    requirement=replace(d.requirement,'one original 77-day challenge','one challenge run')
  from (values
    ('streak_flame','perfect_streak',3),('seven_sealed','perfect_streak',7),
    ('full_streak_14','perfect_streak',14),('full_streak_28','perfect_streak',28),
    ('full_streak_56','perfect_streak',56),('full_streak_70','perfect_streak',70),
    ('check_ins_7','instance_check_in_count',7),('check_ins_14','instance_check_in_count',14),
    ('check_ins_21','instance_check_in_count',21),('check_ins_26','instance_check_in_count',26),
    ('check_ins_39','instance_check_in_count',39),('check_ins_50','instance_check_in_count',50),
    ('check_ins_60','instance_check_in_count',60),('check_ins_70','instance_check_in_count',70)
  ) expected(key,metric,threshold)
  where d.badge_key=expected.key and d.metric=expected.metric and d.threshold=expected.threshold
    and d.scope='challenge_instance' and d.source_event='check_in' and d.criteria_version=1
    and not d.retired and not d.blocked and d.predicate is null
    and d.requirement=d.description
    and d.description=case expected.metric when 'perfect_streak' then
      format('Post all seven Daily Actions on %s consecutive local calendar days in one original 77-day challenge.',expected.threshold)
      else format('Post exactly %s check-ins in one original 77-day challenge; partial check-ins count.',expected.threshold) end;
  get diagnostics changed=row_count;
  if changed<>14 then
    raise exception 'Expected exactly 14 canonical per-instance badge definitions.' using errcode='23514';
  end if;
end;
$instance_badge_copy$;

create function private.reject_instance_completion_update()
returns trigger language plpgsql security invoker set search_path='' as $$
begin raise exception 'challenge_instance_completion_immutable' using errcode='42501'; end;
$$;
revoke all on function private.reject_instance_completion_update() from public,anon,authenticated,service_role;
create trigger reject_instance_completion_update before update on private.challenge_instance_completions
  for each row execute function private.reject_instance_completion_update();

-- Pure projections: these definitions never initialize or import user history.
create function private.challenge_instance_payload(target_instance_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'id',i.id,'challengeKey',i.challenge_key,'title',i.title,'scopeKey',i.scope_key,
    'status',case when i.status='scheduled' and d.local_date>=i.start_date then 'active' else i.status end,
    'startDate',i.start_date,'timeZone',i.time_zone,'mode',i.participation_mode,'crewId',i.crew_id,
    'targetCount',i.target_count,'submittedCount',(select count(*) from public.check_ins c where c.challenge_instance_id=i.id),
    'calendarDay',case when d.local_date<i.start_date then null else d.local_date-i.start_date+1 end,
    'completedAt',i.completed_at,'completionEventId',i.completion_event_id,
    'provenance',i.provenance,'reviewRequired',i.review_required)
  from private.challenge_instances i
  cross join lateral (select (statement_timestamp() at time zone i.time_zone)::date local_date) d
  where i.id=target_instance_id;
$$;
revoke all on function private.challenge_instance_payload(uuid) from public,anon,authenticated,service_role;

create function private.challenge_activation_payload_v2(target_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  instance_payload jsonb;
  actor_revision bigint:=0;
  user_date date;
  active_membership boolean;
  group_active boolean:=false;
  review_required boolean:=false;
  original_completed boolean:=false;
  can_start_repeat boolean:=false;
begin
  select r.revision,private.challenge_instance_payload(r.current_instance_id),r.review_required
    into actor_revision,instance_payload,review_required from private.challenge_runtime r where r.user_id=target_user_id;
  user_date:=(statement_timestamp() at time zone coalesce(instance_payload->>'timeZone','UTC'))::date;
  select (exists(select 1 from public.entitlements e where e.user_id=target_user_id
    and e.entitlement_key='membership_active' and e.status='active'
    and (e.starts_at is null or e.starts_at<=statement_timestamp())
    and (e.ends_at is null or e.ends_at>statement_timestamp()))
    or private.early_access_active_for_user(target_user_id,statement_timestamp())) into active_membership;
  review_required:=coalesce(review_required,false) or coalesce((instance_payload->>'reviewRequired')::boolean,false);
  if instance_payload is not null then
    instance_payload:=jsonb_set(instance_payload,'{reviewRequired}',to_jsonb(review_required));
  end if;
  if instance_payload->>'mode'='group' then
    select exists(select 1 from public.crew_members m join public.crews c on c.id=m.crew_id
      where m.user_id=target_user_id and m.crew_id=(instance_payload->>'crewId')::uuid
      and c.deleted_at is null and not exists(select 1 from private.retired_community_dr_quarantined_crews q where q.crew_id=c.id))
      into group_active;
  end if;
  select exists(select 1 from private.challenge_instances i where i.user_id=target_user_id
    and i.challenge_key='original_77' and i.status='completed' and not i.review_required) into original_completed;
  can_start_repeat:=original_completed and instance_payload->>'status'='completed'
    and not review_required and active_membership;
  return jsonb_build_object('schemaVersion',2,'actorId',target_user_id,'revision',coalesce(actor_revision,0),
    'serverDate',user_date,'status',coalesce(instance_payload->>'status','not_started'),
    'mode',instance_payload->'mode','startDate',instance_payload->'startDate','timeZone',instance_payload->'timeZone',
    'crewId',instance_payload->'crewId','groupMembershipActive',group_active,'reviewRequired',review_required,
    'canActivateSolo',instance_payload is null and not review_required and active_membership,
    'canActivateGroup',instance_payload is null and not review_required and active_membership,
    'canParticipate',coalesce(instance_payload->>'status'='active' and not review_required and active_membership
      and (instance_payload->>'mode'<>'group' or group_active),false),
    'canMutateDailyStandards',coalesce(instance_payload->>'status'='active' and not review_required and active_membership
      and (instance_payload->>'mode'<>'group' or group_active),false),
    'canEditStartDate',coalesce(instance_payload->>'challengeKey'='original_77' and instance_payload->>'mode'='solo'
      and instance_payload->>'scopeKey' like 'original77:%' and (instance_payload->>'submittedCount')::integer=0
      and instance_payload->>'status'<>'completed' and not review_required and active_membership,false),
    'currentInstance',instance_payload,
    'originalRepeat',jsonb_build_object('challengeKey','original_77','targetCount',77,'available',original_completed,
      'canStart',coalesce(can_start_repeat,false),'reason',case when can_start_repeat then null
        when not original_completed then 'original_completion_required'
        when review_required then 'review_required'
        when instance_payload->>'status'<>'completed' then 'active_instance_exists'
        when not active_membership then 'entitlement_required' else 'review_required' end));
end;
$$;
revoke all on function private.challenge_activation_payload_v2(uuid) from public,anon,authenticated,service_role;

create function private.assert_instance_actor(target_expected_actor_id uuid)
returns uuid language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=(select auth.uid());
begin
  if actor is null then raise exception 'You need to log in.' using errcode='28000'; end if;
  if target_expected_actor_id is distinct from actor then
    raise exception 'The signed-in account changed. Refresh and try again.' using errcode='40001',detail='challenge_activation_actor_changed';
  end if;
  if not exists(select 1 from auth.users u where u.id=actor) then
    raise exception 'The signed-in account no longer exists. Refresh and try again.' using errcode='28000';
  end if;
  return actor;
end;
$$;
revoke all on function private.assert_instance_actor(uuid) from public,anon,authenticated,service_role;

-- Preserve the released original-evidence validator, scoping only its source
-- scan to the first original run. NULL is pre-cutover legacy evidence only.
create or replace function private.original_77_submission_evidence(
  target_user_id uuid,
  target_challenge_start_date date
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  profile_start_date date;
  profile_review_required boolean;
  total_rows integer := 0;
  canonical_rows integer := 0;
  distinct_ids integer := 0;
  distinct_dates integer := 0;
  distinct_days integer := 0;
  completion_event private.original_77_completion_events%rowtype;
  source_check_in public.check_ins%rowtype;
  invalid_reason text;
  allowed_actions constant text[] := array[
    'bible', 'morningPrayer', 'worshipOnly', 'eveningPrayer',
    'workoutOne', 'walk', 'workoutTwo'
  ]::text[];
begin
  if target_user_id is null
     or target_challenge_start_date is null
     or not pg_catalog.isfinite(target_challenge_start_date)
     or target_challenge_start_date not between date '0001-01-01' and date '9999-12-31' then
    invalid_reason := 'invalid_activation';
  else
    select profile.challenge_start_date, profile.challenge_activation_review_required
      into profile_start_date, profile_review_required
    from public.profiles profile
    where profile.user_id = target_user_id;

    if not found
       or profile_start_date is distinct from target_challenge_start_date
       or profile_start_date is null
       or not pg_catalog.isfinite(profile_start_date) then
      invalid_reason := 'invalid_activation';
    elsif profile_review_required is distinct from false then
      invalid_reason := 'activation_review_required';
    end if;
  end if;

  if invalid_reason is null then
    select
      count(*)::integer,
      count(*) filter (
        where case
          when pg_catalog.isfinite(check_in.entry_date)
            and check_in.entry_date between date '0001-01-01' and date '9999-12-31'
            and check_in.challenge_day > 0
          then check_in.challenge_day =
            check_in.entry_date - target_challenge_start_date + 1
          else false
        end
          and check_in.status in ('complete', 'partial')
          and pg_catalog.cardinality(check_in.completed) between 1 and 7
          and pg_catalog.array_ndims(check_in.completed) = 1
          and pg_catalog.array_lower(check_in.completed, 1) = 1
          and pg_catalog.array_position(check_in.completed, null) is null
          and check_in.completed <@ allowed_actions
          and pg_catalog.cardinality(check_in.completed) = (
            select count(distinct completed_action)::integer
            from pg_catalog.unnest(check_in.completed) completed_action
          )
          and pg_catalog.isfinite(check_in.created_at)
          and check_in.created_at >= timestamptz '0001-01-01 00:00:00+00'
          and check_in.created_at < timestamptz '10000-01-01 00:00:00+00'
      )::integer,
      count(distinct check_in.id)::integer,
      count(distinct check_in.entry_date)::integer,
      count(distinct check_in.challenge_day)::integer
    into total_rows, canonical_rows, distinct_ids, distinct_dates, distinct_days
    from (
      select check_in.*
      from public.check_ins check_in
      where check_in.user_id = target_user_id
        and (check_in.challenge_instance_id is null or check_in.challenge_instance_id = (
          select first_instance.id from private.challenge_instances first_instance
          where first_instance.user_id=target_user_id and first_instance.sequence_no=0
            and first_instance.challenge_key='original_77'))
      order by check_in.entry_date
      limit 78
    ) check_in;

    if total_rows > 77
       or canonical_rows <> total_rows
       or distinct_ids <> total_rows
       or distinct_dates <> total_rows
       or distinct_days <> total_rows then
      invalid_reason := 'invalid_check_in';
    end if;
  end if;

  if invalid_reason is null then
    select completion.* into completion_event
    from private.original_77_completion_events completion
    where completion.user_id = target_user_id
      and completion.challenge_start_date = target_challenge_start_date
      and completion.completion_kind = 'original_77_submissions';

    if completion_event.id is not null then
      select check_in.* into source_check_in
      from public.check_ins check_in
      where check_in.id = completion_event.source_check_in_id;

      if source_check_in.id is null
         or source_check_in.user_id is distinct from target_user_id
         or not (case
           when pg_catalog.isfinite(source_check_in.entry_date)
             and source_check_in.entry_date between date '0001-01-01' and date '9999-12-31'
             and source_check_in.challenge_day > 0
           then source_check_in.challenge_day =
             source_check_in.entry_date - target_challenge_start_date + 1
           else false
         end)
         or source_check_in.status not in ('complete', 'partial')
         or pg_catalog.cardinality(source_check_in.completed) not between 1 and 7
         or pg_catalog.array_ndims(source_check_in.completed) <> 1
         or pg_catalog.array_lower(source_check_in.completed, 1) <> 1
         or pg_catalog.array_position(source_check_in.completed, null) is not null
         or not (source_check_in.completed <@ allowed_actions)
         or pg_catalog.cardinality(source_check_in.completed) <> (
           select count(distinct completed_action)::integer
           from pg_catalog.unnest(source_check_in.completed) completed_action
         )
         or not pg_catalog.isfinite(source_check_in.created_at)
         or source_check_in.created_at < timestamptz '0001-01-01 00:00:00+00'
         or source_check_in.created_at >= timestamptz '10000-01-01 00:00:00+00'
         or completion_event.source_local_date is distinct from source_check_in.entry_date
         or completion_event.source_recorded_at is distinct from source_check_in.created_at
         or total_rows <> 77 then
        invalid_reason := 'invalid_completion_event';
      end if;
    end if;
  end if;

  if invalid_reason is not null then
    return pg_catalog.jsonb_build_object(
      'schemaVersion', 1, 'context', 'database_snapshot', 'valid', false,
      'reason', invalid_reason, 'userId', null, 'instanceId', null,
      'submittedCount', null, 'meetsSubmissionRule', false,
      'completionState', 'invalid_evidence', 'canonicalEvent', null,
      'historicalProvenancePending', false, 'awardAuthorized', false,
      'replayAuthorized', false
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'schemaVersion', 1,
    'context', 'database_snapshot',
    'valid', true,
    'reason', null,
    'userId', target_user_id,
    'instanceId', 'original77:' || pg_catalog.to_char(target_challenge_start_date, 'YYYY-MM-DD'),
    'submittedCount', total_rows,
    'meetsSubmissionRule', total_rows = 77,
    'completionState', case
      when completion_event.id is not null then 'live_completed'
      when total_rows = 77 then 'historical_provenance_pending'
      else 'in_progress'
    end,
    'canonicalEvent', case
      when completion_event.id is null then null
      else pg_catalog.jsonb_build_object(
        'id', completion_event.id,
        'sourceId', completion_event.source_check_in_id,
        'localDate', completion_event.source_local_date,
        'recordedAt', completion_event.source_recorded_at,
        'persistedAt', completion_event.recorded_at
      )
    end,
    'historicalProvenancePending', total_rows = 77 and completion_event.id is null,
    'awardAuthorized', false,
    'replayAuthorized', false
  );
end;
$$;

create function public.get_challenge_activation_v2(target_expected_actor_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.assert_instance_actor(target_expected_actor_id);
begin
  perform set_config('response.headers','[{"Cache-Control":"private, no-store"},{"Pragma":"no-cache"}]',true);
  return private.challenge_activation_payload_v2(actor);
end;
$$;
revoke all on function public.get_challenge_activation_v2(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_challenge_activation_v2(uuid) to authenticated;

create function public.get_challenge_check_ins_v2(target_expected_actor_id uuid,target_expected_instance_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.assert_instance_actor(target_expected_actor_id); current_id uuid;
begin
  perform set_config('response.headers','[{"Cache-Control":"private, no-store"},{"Pragma":"no-cache"}]',true);
  select r.current_instance_id into current_id from private.challenge_runtime r where r.user_id=actor;
  if target_expected_instance_id is null or current_id is distinct from target_expected_instance_id then
    raise exception 'The challenge instance changed. Refresh and try again.' using errcode='40001',detail='challenge_instance_changed';
  end if;
  return jsonb_build_object('schemaVersion',2,'actorId',actor,'instanceId',current_id,
    'checkIns',coalesce((select jsonb_agg(to_jsonb(c)-'user_id'-'challenge_instance_id'||jsonb_build_object('instanceId',current_id)
      order by c.entry_date,c.id) from public.check_ins c where c.user_id=actor and c.challenge_instance_id=current_id),'[]'::jsonb));
end;
$$;
revoke all on function public.get_challenge_check_ins_v2(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_challenge_check_ins_v2(uuid,uuid) to authenticated;

create or replace function private.reward_eligible_points(target_user_id uuid,target_reward_key text)
returns integer language plpgsql stable security definer set search_path='' as $$
declare eligible_points bigint:=0; rule_type text;
begin
  select d.unlock_rule_type into rule_type from public.reward_definitions d where d.reward_key=target_reward_key;
  if rule_type='challenge_completion' then return null; end if;
  if rule_type='trusted_points' then
    select coalesce(sum(least(greatest(case
      when coalesce(e.metadata->>'completedCount','')~'^[0-9]{1,3}$' then (e.metadata->>'completedCount')::integer
      when coalesce(e.metadata->>'actionPoints','')~'^[0-9]{1,3}$' then (e.metadata->>'actionPoints')::integer
      else e.points end,0),7)),0) into eligible_points
    from public.game_point_events e where e.user_id=target_user_id and e.event_type='check_in';
  elsif rule_type='lifetime_points' then
    select greatest(coalesce(s.total_points,0),0) into eligible_points from public.user_game_stats s where s.user_id=target_user_id;
  end if;
  return least(greatest(coalesce(eligible_points,0),0),2147483647)::integer;
end;
$$;

create function private.challenge_definition_completed(target_user_id uuid,target_challenge_key text)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from private.challenge_instances i where i.user_id=target_user_id
    and i.challenge_key=target_challenge_key and i.status='completed' and not i.review_required)
    or exists(select 1 from public.user_challenge_states s where s.user_id=target_user_id
      and s.challenge_key=target_challenge_key and s.status='completed');
$$;
revoke all on function private.challenge_definition_completed(uuid,text) from public,anon,authenticated,service_role;

create function private.reward_requirement_met(target_user_id uuid,target_reward_key text)
returns boolean language sql stable security definer set search_path='' as $$
  select coalesce((select case when d.unlock_rule_type='challenge_completion'
    then private.challenge_definition_completed(target_user_id,d.prerequisite_challenge_key)
    else private.reward_eligible_points(target_user_id,d.reward_key)>=d.points_required end
    from public.reward_definitions d where d.reward_key=target_reward_key and d.is_active and d.released),false);
$$;
revoke all on function private.reward_requirement_met(uuid,text) from public,anon,authenticated,service_role;

create function private.reward_catalog_item_v2(target_user_id uuid,target_reward_key text,target_activation jsonb)
returns jsonb language sql stable security definer set search_path='' as $$
  with item as (
    select d.*,private.reward_eligible_points(target_user_id,d.reward_key) eligible_points,
      private.reward_requirement_met(target_user_id,d.reward_key) requirement_met,
      s.unlock_points,s.unlocked_at,s.started_at,s.completed_at,s.celebration_seen_at challenge_seen_at,
      e.owned_at,e.celebration_seen_at ownership_seen_at,cd.duration_days target_submitted,
      case when preserved.user_id is not null then jsonb_build_object('type','legacy_preserved','catalogVersion',preserved.catalog_version)
        when s.user_id is not null or e.user_id is not null then jsonb_build_object('type','rule_earned',
          'catalogVersion',coalesce((s.metadata->>'catalogVersion')::bigint,(e.metadata->>'catalogVersion')::bigint,
            (select m.catalog_version from public.reward_catalog_meta m where m.catalog_key='primary'))) else null end grant_provenance,
      case when d.state_model='challenge_lifecycle' and s.user_id is not null and d.challenge_key=target_activation->'currentInstance'->>'challengeKey'
        then case when target_activation->'currentInstance'->>'status'='completed' then 'completed' else 'active' end
        when d.state_model='challenge_lifecycle' then coalesce(s.status,'locked')
        when e.reward_key is not null then 'owned' else 'locked' end current_status,
      (d.required_entitlement_key is null or exists(select 1 from public.entitlements a
        where a.user_id=target_user_id and a.entitlement_key=d.required_entitlement_key and a.status='active'
        and (a.starts_at is null or a.starts_at<=statement_timestamp())
        and (a.ends_at is null or a.ends_at>statement_timestamp()))
        or (d.required_entitlement_key='membership_active' and private.early_access_active_for_user(target_user_id,statement_timestamp()))) can_access
    from public.reward_definitions d
    left join public.user_challenge_states s on s.user_id=target_user_id and s.challenge_key=d.challenge_key
    left join public.user_reward_entitlements e on e.user_id=target_user_id and e.reward_key=d.reward_key
    left join public.challenge_definitions cd on cd.challenge_key=d.challenge_key
    left join private.reward_grant_preservation preserved on preserved.user_id=target_user_id and preserved.reward_key=d.reward_key
    where d.reward_key=target_reward_key
  ), measured as (
    select item.*,case when unlock_rule_type='challenge_completion' then null
      when current_status<>'locked' then 0 else greatest(points_required-eligible_points,0) end points_remaining,
      case when unlock_rule_type='challenge_completion' then null when current_status<>'locked' then 100
        else least(round(eligible_points::numeric/nullif(points_required,0)*100,2),100) end progress_percent
    from item
  ) select jsonb_build_object(
    'key',reward_key,'rewardType',reward_type,'stateModel',state_model,'status',current_status,
    'title',title,'description',description,'phase',phase,'released',released,
    'targetSubmittedCheckIns',target_submitted,'grantProvenance',grant_provenance,
    'blockedReason',case when state_model<>'challenge_lifecycle' or current_status='locked' then null
      when coalesce((target_activation->>'reviewRequired')::boolean,true) then 'review_required'
      when target_activation->'currentInstance'='null'::jsonb then 'original_completion_required'
      when target_activation->'currentInstance'->>'status'<>'completed' then 'active_instance_exists' else null end,
    'pointsRequired',points_required,'currentPoints',eligible_points,'pointsRemaining',points_remaining,'progressPercent',progress_percent,
    'requirement',case when unlock_rule_type='challenge_completion' then jsonb_build_object(
      'type',unlock_rule_type,'prerequisiteChallengeKey',prerequisite_challenge_key,'requiredState','completed','satisfied',requirement_met)
      else jsonb_build_object('type',unlock_rule_type,'pointsRequired',points_required,'currentPoints',eligible_points,
        'pointsRemaining',points_remaining,'progressPercent',progress_percent) end,
    'fulfillmentKey',fulfillment_key,'requiredEntitlementKey',required_entitlement_key,'icon',icon,
    'sortOrder',sort_order,'active',is_active,'metadata',display_metadata,'canAccess',can_access,
    'accessReason',case when not can_access then 'entitlement_required' when current_status='locked'
      then case when unlock_rule_type='challenge_completion' then 'challenge_completion_required' else 'points_required' end else null end,
    'allowedActions',case when state_model='challenge_lifecycle' and current_status<>'locked' and can_access and is_active and released
      and target_activation->'currentInstance'->>'status'='completed'
      and not coalesce((target_activation->>'reviewRequired')::boolean,true)
      then jsonb_build_array('start') else '[]'::jsonb end,
    'unlockPoints',unlock_points,'unlockedAt',unlocked_at,'startedAt',started_at,'completedAt',completed_at,
    'ownedAt',owned_at,'celebrationSeenAt',case when state_model='challenge_lifecycle' then challenge_seen_at else ownership_seen_at end)
    from measured;
$$;
revoke all on function private.reward_catalog_item_v2(uuid,text,jsonb) from public,anon,authenticated,service_role;

create function private.reward_catalog_v2(target_user_id uuid,target_page_size integer,
  target_after_sort_order integer,target_after_reward_key text,target_expected_revision bigint,target_expected_catalog_version bigint,
  target_expected_snapshot_version text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  activation jsonb:=private.challenge_activation_payload_v2(target_user_id);
  meta public.reward_catalog_meta%rowtype;
  total_points integer:=0;
  page_size integer:=least(greatest(coalesce(target_page_size,50),1),100);
  all_items jsonb; item_rows jsonb; next_unlock jsonb; last_item jsonb; next_cursor jsonb;
  total_items integer; has_more boolean; snapshot_version text;
begin
  if (target_after_sort_order is null)<>(target_after_reward_key is null)
    or (target_after_reward_key is not null and target_after_reward_key!~'^[a-z0-9][a-z0-9_.:-]*$') then
    raise exception 'The reward catalog cursor is invalid.' using errcode='22023';
  end if;
  select * into strict meta from public.reward_catalog_meta m where m.catalog_key='primary';
  if (target_after_sort_order is not null and (target_expected_revision is null or target_expected_catalog_version is null or target_expected_snapshot_version is null))
    or (target_expected_revision is not null and target_expected_revision<>(activation->>'revision')::bigint)
    or (target_expected_catalog_version is not null and target_expected_catalog_version<>meta.catalog_version) then
    raise exception 'The reward catalog changed. Refresh and try again.' using errcode='40001',detail='reward_catalog_changed';
  end if;
  select coalesce(s.total_points,0) into total_points from public.user_game_stats s where s.user_id=target_user_id;
  select coalesce(jsonb_agg(private.reward_catalog_item_v2(target_user_id,d.reward_key,activation)
    order by d.sort_order,d.reward_key),'[]'::jsonb) into all_items from public.reward_definitions d
    where d.is_active or exists(select 1 from public.user_reward_entitlements e where e.user_id=target_user_id and e.reward_key=d.reward_key)
      or exists(select 1 from public.user_challenge_states s where s.user_id=target_user_id and s.challenge_key=d.challenge_key);
  snapshot_version:=encode(extensions.digest(convert_to(jsonb_build_object('actorId',target_user_id,
    'catalogVersion',meta.catalog_version,'effectiveAt',meta.effective_at,'activation',activation,
    'totalPoints',coalesce(total_points,0),'items',all_items)::text,'UTF8'),'sha256'),'hex');
  if target_expected_snapshot_version is not null and target_expected_snapshot_version<>snapshot_version then
    raise exception 'The reward catalog changed. Refresh and try again.' using errcode='40001',detail='reward_catalog_changed'; end if;
  total_items:=jsonb_array_length(all_items);
  if activation->'currentInstance'->>'status'='completed' then
    select i into next_unlock from jsonb_array_elements(all_items) i where i->>'status'='available'
      and i->'allowedActions'?'start' and (i->>'active')::boolean and (i->>'released')::boolean and (i->>'canAccess')::boolean
      order by (i->'requirement'->>'prerequisiteChallengeKey'=activation->'currentInstance'->>'challengeKey') desc nulls last,
        (i->>'sortOrder')::integer,i->>'key' limit 1;
  end if;
  if next_unlock is null then
    select i into next_unlock from jsonb_array_elements(all_items) i where i->>'status'='locked' and i->>'phase'='core'
      and (i->>'active')::boolean and (i->>'released')::boolean and (i->>'canAccess')::boolean
      order by (i->>'sortOrder')::integer,i->>'key' limit 1;
  end if;
  with candidates as (select i from jsonb_array_elements(all_items) i
    where target_after_sort_order is null or ((i->>'sortOrder')::integer,i->>'key')>(target_after_sort_order,target_after_reward_key)
    order by (i->>'sortOrder')::integer,i->>'key' limit page_size+1), numbered as (
    select i,row_number() over(order by (i->>'sortOrder')::integer,i->>'key') n from candidates)
  select coalesce(jsonb_agg(i order by n) filter(where n<=page_size),'[]'::jsonb),coalesce(bool_or(n>page_size),false)
    into item_rows,has_more from numbered;
  if has_more then last_item:=item_rows->(jsonb_array_length(item_rows)-1);
    next_cursor:=jsonb_build_object('sortOrder',(last_item->>'sortOrder')::integer,'key',last_item->>'key'); end if;
  return jsonb_build_object('schemaVersion',2,'actorId',target_user_id,'catalogVersion',meta.catalog_version,'effectiveAt',meta.effective_at,
    'revision',(activation->>'revision')::bigint,'snapshotVersion',snapshot_version,'totalPoints',coalesce(total_points,0),'currentInstance',activation->'currentInstance',
    'originalRepeat',activation->'originalRepeat','items',item_rows,'nextUnlock',next_unlock,
    'page',jsonb_build_object('limit',page_size,'totalItems',total_items,'hasMore',has_more,'nextCursor',next_cursor));
end;
$$;
revoke all on function private.reward_catalog_v2(uuid,integer,integer,text,bigint,bigint,text) from public,anon,authenticated,service_role;

-- Runtime-only operations below are definitions, not migration-time execution.
-- The shared lock order extends the released activation/account-erasure order:
-- single crew -> activation -> Auth parent -> profile -> runtime -> instance.
create function private.lock_challenge_instance_actor(target_actor_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare current_id uuid; promoted integer;
begin
  perform public.get_challenge_activation(target_actor_id);
  insert into private.challenge_runtime(user_id) values(target_actor_id) on conflict(user_id) do nothing;
  select r.current_instance_id into current_id from private.challenge_runtime r where r.user_id=target_actor_id for update;
  if current_id is not null then
    perform 1 from private.challenge_instances i where i.id=current_id and i.user_id=target_actor_id for update;
    update private.challenge_instances i set status='active' where i.id=current_id and i.status='scheduled'
      and i.start_date<=(clock_timestamp() at time zone i.time_zone)::date;
    get diagnostics promoted=row_count;
    if promoted>0 then update private.challenge_runtime set revision=revision+1 where user_id=target_actor_id; end if;
  end if;
  return current_id;
end;
$$;
revoke all on function private.lock_challenge_instance_actor(uuid) from public,anon,authenticated,service_role;

create function private.require_instance_membership(target_actor_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare checked_at timestamptz;
begin
  perform 1 from public.entitlements e where e.user_id=target_actor_id and e.entitlement_key='membership_active' for share;
  perform private.lock_early_access_authority(array[target_actor_id]);
  checked_at:=clock_timestamp();
  if not (exists(select 1 from public.entitlements e where e.user_id=target_actor_id and e.entitlement_key='membership_active'
      and e.status='active' and (e.starts_at is null or e.starts_at<=checked_at) and (e.ends_at is null or e.ends_at>checked_at))
      or private.early_access_active_for_user(target_actor_id,checked_at)) then
    raise exception 'An active membership is required.' using errcode='42501',detail='membership_required';
  end if;
end;
$$;
revoke all on function private.require_instance_membership(uuid) from public,anon,authenticated,service_role;

create function private.require_current_instance(target_actor_id uuid,target_expected_instance_id uuid)
returns private.challenge_instances language plpgsql security definer set search_path='' as $$
declare current_id uuid; instance private.challenge_instances%rowtype;
begin
  current_id:=private.lock_challenge_instance_actor(target_actor_id);
  if target_expected_instance_id is null or current_id is distinct from target_expected_instance_id then
    raise exception 'The challenge instance changed. Refresh and try again.' using errcode='40001',detail='challenge_instance_changed';
  end if;
  if exists(select 1 from private.challenge_runtime r where r.user_id=target_actor_id and r.review_required) then
    raise exception 'Existing challenge history needs review.' using errcode='55000',detail='challenge_history_review_required';
  end if;
  select * into strict instance from private.challenge_instances i where i.id=current_id and i.user_id=target_actor_id;
  return instance;
end;
$$;
revoke all on function private.require_current_instance(uuid,uuid) from public,anon,authenticated,service_role;

create function private.require_instance_daily_date(target_instance_id uuid,target_entry_date date)
returns void language plpgsql security definer set search_path='' as $$
declare instance private.challenge_instances%rowtype; today date;
begin
  select * into strict instance from private.challenge_instances i where i.id=target_instance_id;
  today:=(clock_timestamp() at time zone instance.time_zone)::date;
  if target_entry_date is null or not isfinite(target_entry_date) or target_entry_date<>today
    or target_entry_date not between date '0001-01-01' and date '9999-12-31' then
    raise exception 'The check-in date changed. Refresh and try again.' using errcode='22023',detail='challenge_date_changed';
  end if;
  if instance.status<>'active' or instance.start_date>today or instance.review_required
    or (select count(*) from public.check_ins c where c.challenge_instance_id=instance.id)>=instance.target_count then
    raise exception 'An active challenge is required.' using errcode='55000',detail='challenge_activation_required';
  end if;
  if instance.participation_mode='group' and not exists(select 1 from public.crew_members m join public.crews c on c.id=m.crew_id
    where m.user_id=instance.user_id and m.crew_id=instance.crew_id and c.deleted_at is null
      and not exists(select 1 from private.retired_community_dr_quarantined_crews q where q.crew_id=c.id)) then
    raise exception 'Current crew membership is required.' using errcode='42501',detail='challenge_group_membership_required';
  end if;
  if exists(select 1 from public.check_ins c where c.user_id=instance.user_id and c.entry_date=today) then
    raise exception 'This Check-In is already submitted.' using errcode='55000',detail='daily_check_in_already_submitted';
  end if;
end;
$$;
revoke all on function private.require_instance_daily_date(uuid,date) from public,anon,authenticated,service_role;

create function private.daily_standard_draft_payload_v2(target_user_id uuid,target_instance_id uuid,target_entry_date date,
  stale_write_reconciled boolean default false)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare draft public.challenge_entries%rowtype; activation jsonb; submitted boolean; lock_reason text; zone text;
begin
  activation:=private.challenge_activation_payload_v2(target_user_id);
  zone:=coalesce(activation->>'timeZone','UTC');
  select * into draft from public.challenge_entries e where e.user_id=target_user_id and e.entry_date=target_entry_date
    and (e.challenge_instance_id=target_instance_id or (e.challenge_instance_id is null
      and activation->'currentInstance'->>'scopeKey' like 'original77:%'));
  select exists(select 1 from public.check_ins c where c.user_id=target_user_id and c.entry_date=target_entry_date) into submitted;
  lock_reason:=case when submitted then 'submitted'
    when target_entry_date<>(statement_timestamp() at time zone zone)::date then 'date_locked'
    when (activation->>'reviewRequired')::boolean then 'review_required'
    when activation->>'status'='completed' then 'challenge_complete'
    when activation->>'status'<>'active' then 'challenge_not_active'
    when not (activation->>'canMutateDailyStandards')::boolean then 'membership_required' else null end;
  return jsonb_build_object('schemaVersion',2,'actorId',target_user_id,'instanceId',target_instance_id,
    'entry_date',target_entry_date,'completed',coalesce(draft.completed,'{}'::text[]),
    'workout_difficulty',coalesce(draft.workout_difficulty,'{}'::jsonb),'version',coalesce(draft.version,0),'updated_at',draft.updated_at,
    'submitted',submitted,'locked',lock_reason is not null,'lock_reason',lock_reason,'activation_status',activation->>'status',
    'stale_write_reconciled',stale_write_reconciled,'activation',activation);
end;
$$;
revoke all on function private.daily_standard_draft_payload_v2(uuid,uuid,date,boolean) from public,anon,authenticated,service_role;

create function public.get_daily_standard_draft_v2(target_entry_date date,target_expected_actor_id uuid,target_expected_instance_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.assert_instance_actor(target_expected_actor_id); instance private.challenge_instances%rowtype;
begin
  perform set_config('response.headers','[{"Cache-Control":"private, no-store"},{"Pragma":"no-cache"}]',true);
  instance:=private.require_current_instance(actor,target_expected_instance_id);
  perform private.require_instance_membership(actor);
  if target_entry_date is null or not isfinite(target_entry_date) or target_entry_date not between date '0001-01-01' and date '9999-12-31' then
    raise exception 'Choose a valid Daily Action date.' using errcode='22023'; end if;
  return private.daily_standard_draft_payload_v2(actor,instance.id,target_entry_date);
end;
$$;
revoke all on function public.get_daily_standard_draft_v2(date,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_daily_standard_draft_v2(date,uuid,uuid) to authenticated;

create function public.mutate_daily_standard_draft_v2(target_entry_date date,target_action_id text,target_completed boolean,
  target_expected_version bigint,target_expected_actor_id uuid,target_expected_instance_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.assert_instance_actor(target_expected_actor_id); instance private.challenge_instances%rowtype;
  draft public.challenge_entries%rowtype; stale_write boolean;
begin
  instance:=private.require_current_instance(actor,target_expected_instance_id);
  perform private.require_instance_membership(actor);
  perform private.require_instance_daily_date(instance.id,target_entry_date);
  if target_action_id is null or target_action_id<>all(array['bible','morningPrayer','worshipOnly','eveningPrayer','workoutOne','walk','workoutTwo'])
    or target_completed is null then raise exception 'Choose a valid Daily Standard and state.' using errcode='22023'; end if;
  insert into public.challenge_entries(user_id,entry_date,completed,challenge_instance_id)
    values(actor,target_entry_date,'{}'::text[],instance.id) on conflict(user_id,entry_date) do nothing;
  select * into strict draft from public.challenge_entries e where e.user_id=actor and e.entry_date=target_entry_date for update;
  if draft.challenge_instance_id is distinct from instance.id and not (draft.challenge_instance_id is null and instance.scope_key like 'original77:%') then
    raise exception 'The challenge draft belongs to another instance.' using errcode='40001',detail='challenge_instance_changed'; end if;
  perform private.require_instance_daily_date(instance.id,target_entry_date);
  stale_write:=target_expected_version is not null and target_expected_version<>draft.version;
  if draft.challenge_instance_id is null or ((target_action_id=any(draft.completed)) is distinct from target_completed) then
    update public.challenge_entries set challenge_instance_id=instance.id,version=version+1,
      completed=case when target_completed and not (target_action_id=any(completed)) then array_append(completed,target_action_id)
        when not target_completed then array_remove(completed,target_action_id) else completed end
      where user_id=actor and entry_date=target_entry_date;
  end if;
  return private.daily_standard_draft_payload_v2(actor,instance.id,target_entry_date,stale_write);
end;
$$;
revoke all on function public.mutate_daily_standard_draft_v2(date,text,boolean,bigint,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.mutate_daily_standard_draft_v2(date,text,boolean,bigint,uuid,uuid) to authenticated;

create function public.set_daily_standard_workout_difficulty_v2(target_entry_date date,target_workout_id text,target_difficulty text,
  target_expected_version bigint,target_expected_actor_id uuid,target_expected_instance_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.assert_instance_actor(target_expected_actor_id); instance private.challenge_instances%rowtype;
  draft public.challenge_entries%rowtype; stale_write boolean;
begin
  instance:=private.require_current_instance(actor,target_expected_instance_id);
  perform private.require_instance_membership(actor);
  perform private.require_instance_daily_date(instance.id,target_entry_date);
  if target_workout_id is null or target_workout_id not in ('one','two') or target_difficulty is null or target_difficulty not in ('easy','medium','hard','extreme') then
    raise exception 'Choose a valid workout difficulty.' using errcode='22023'; end if;
  insert into public.challenge_entries(user_id,entry_date,completed,challenge_instance_id)
    values(actor,target_entry_date,'{}'::text[],instance.id) on conflict(user_id,entry_date) do nothing;
  select * into strict draft from public.challenge_entries e where e.user_id=actor and e.entry_date=target_entry_date for update;
  if draft.challenge_instance_id is distinct from instance.id and not (draft.challenge_instance_id is null and instance.scope_key like 'original77:%') then
    raise exception 'The challenge draft belongs to another instance.' using errcode='40001',detail='challenge_instance_changed'; end if;
  perform private.require_instance_daily_date(instance.id,target_entry_date);
  stale_write:=target_expected_version is not null and target_expected_version<>draft.version;
  if draft.challenge_instance_id is null or draft.workout_difficulty->>target_workout_id is distinct from target_difficulty then
    update public.challenge_entries set challenge_instance_id=instance.id,version=version+1,
      workout_difficulty=jsonb_set(workout_difficulty,array[target_workout_id],to_jsonb(target_difficulty),true)
      where user_id=actor and entry_date=target_entry_date;
  end if;
  return private.daily_standard_draft_payload_v2(actor,instance.id,target_entry_date,stale_write);
end;
$$;
revoke all on function public.set_daily_standard_workout_difficulty_v2(date,text,text,bigint,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.set_daily_standard_workout_difficulty_v2(date,text,text,bigint,uuid,uuid) to authenticated;

-- Every retained ownership grant path honors release configuration. These
-- replace function definitions only; they do not perform a reward backfill.
create or replace function public.grant_reward_entitlement(
  target_user_id uuid,
  target_reward_key text,
  target_source_type text default 'point_threshold',
  target_source_id text default null,
  target_celebration_seen boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted_user_id uuid;
begin
  if target_user_id is null
    or target_reward_key is null
    or target_source_type is null
    or target_source_type !~ '^[a-z][a-z0-9_]*$' then
    return false;
  end if;

  insert into public.user_reward_entitlements (
    user_id,
    reward_key,
    owned_at,
    source_type,
    source_id,
    celebration_seen_at
  )
  select
    target_user_id,
    definition.reward_key,
    pg_catalog.clock_timestamp(),
    target_source_type,
    coalesce(target_source_id, definition.reward_key),
    case
      when target_celebration_seen then pg_catalog.clock_timestamp()
      else null
    end
  from public.reward_definitions as definition
  where definition.reward_key = target_reward_key
    and definition.state_model = 'ownership'
    and definition.is_active and definition.released
    and private.reward_eligible_points(
      target_user_id,
      definition.reward_key
    ) >= definition.points_required
  on conflict (user_id, reward_key) do nothing
  returning user_id into inserted_user_id;

  return inserted_user_id is not null;
end;
$$;

create or replace function public.reconcile_user_reward_entitlements(
  target_user_id uuid,
  target_celebration_seen boolean default false
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted_count integer := 0;
begin
  if target_user_id is null then
    return 0;
  end if;

  insert into public.user_reward_entitlements (
    user_id,
    reward_key,
    owned_at,
    source_type,
    source_id,
    celebration_seen_at
  )
  select
    target_user_id,
    definition.reward_key,
    pg_catalog.clock_timestamp(),
    'point_threshold',
    definition.reward_key,
    case
      when target_celebration_seen then pg_catalog.clock_timestamp()
      else null
    end
  from public.reward_definitions as definition
  where definition.state_model = 'ownership'
    and definition.is_active and definition.released
    and private.reward_eligible_points(
      target_user_id,
      definition.reward_key
    ) >= definition.points_required
  on conflict (user_id, reward_key) do nothing;

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

create or replace function public.sync_reward_definition_entitlements()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not new.is_active or not new.released or new.state_model <> 'ownership' then
    return new;
  end if;

  insert into public.user_reward_entitlements (
    user_id,
    reward_key,
    owned_at,
    source_type,
    source_id
  )
  select
    game_stats.user_id,
    new.reward_key,
    pg_catalog.clock_timestamp(),
    'catalog_threshold',
    new.reward_key
  from public.user_game_stats as game_stats
  where private.reward_eligible_points(
      game_stats.user_id,
      new.reward_key
    ) >= new.points_required
  on conflict (user_id, reward_key) do nothing;

  return new;
end;
$$;

-- Reinstall the existing configuration-sync behavior only after the cutover
-- UPDATE and the released/rule-aware replacement above; never replay history
-- while changing the migration's reward definitions.
create trigger sync_reward_definition_entitlements
  after insert or update of points_required,is_active,state_model,required_entitlement_key,
    unlock_rule_type,prerequisite_challenge_key,phase,released on public.reward_definitions
  for each row execute function public.sync_reward_definition_entitlements();

create or replace function public.backfill_reward_entitlements(
  target_reward_key text,
  target_after_user_id uuid default null,
  target_batch_size integer default 500,
  target_celebration_seen boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_batch_size integer;
  processed_count integer := 0;
  inserted_count integer := 0;
  last_user_id uuid := null;
  has_more boolean := false;
begin
  if target_reward_key is null
    or target_reward_key !~ '^[a-z0-9][a-z0-9_.:-]*$' then
    raise exception 'A valid reward key is required for backfill.'
      using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.reward_definitions as definition
    where definition.reward_key = target_reward_key
      and definition.state_model = 'ownership'
      and definition.is_active and definition.released
  ) then
    raise exception 'An active ownership reward is required for backfill.'
      using errcode = '22023';
  end if;

  normalized_batch_size := least(
    greatest(coalesce(target_batch_size, 500), 1),
    5000
  );

  with eligible as materialized (
    select game_stats.user_id
    from public.user_game_stats as game_stats
    join public.reward_definitions as definition
      on definition.reward_key = target_reward_key
     and definition.state_model = 'ownership'
     and definition.is_active and definition.released
    where (
        target_after_user_id is null
        or game_stats.user_id > target_after_user_id
      )
      and private.reward_eligible_points(
        game_stats.user_id,
        definition.reward_key
      ) >= definition.points_required
    order by game_stats.user_id
    limit normalized_batch_size
  ), inserted as (
    insert into public.user_reward_entitlements (
      user_id,
      reward_key,
      owned_at,
      source_type,
      source_id,
      celebration_seen_at
    )
    select
      eligible.user_id,
      target_reward_key,
      pg_catalog.clock_timestamp(),
      'backfill',
      target_reward_key,
      case
        when target_celebration_seen then pg_catalog.clock_timestamp()
        else null
      end
    from eligible
    on conflict (user_id, reward_key) do nothing
    returning user_id
  )
  select
    (select count(*)::integer from eligible),
    (select count(*)::integer from inserted),
    (select eligible.user_id from eligible order by eligible.user_id desc limit 1)
  into processed_count, inserted_count, last_user_id;

  if last_user_id is not null then
    select exists (
      select 1
      from public.user_game_stats as game_stats
      join public.reward_definitions as definition
        on definition.reward_key = target_reward_key
       and definition.state_model = 'ownership'
       and definition.is_active and definition.released
      where game_stats.user_id > last_user_id
        and private.reward_eligible_points(
          game_stats.user_id,
          definition.reward_key
        ) >= definition.points_required
    ) into has_more;
  end if;

  return jsonb_build_object(
    'rewardKey', target_reward_key,
    'processedCount', processed_count,
    'insertedCount', inserted_count,
    'nextCursor', case when has_more then last_user_id else null end,
    'complete', not has_more
  );
end;
$$;

create function public.get_daily_action_bootstrap_v2(target_expected_actor_id uuid,target_time_zone text,
  target_entry_date date default null,target_expected_instance_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.assert_instance_actor(target_expected_actor_id); current_id uuid; activation jsonb;
  requested_zone text:=nullif(btrim(target_time_zone),''); zone text; entry_date date;
begin
  perform set_config('response.headers','[{"Cache-Control":"private, no-store"},{"Pragma":"no-cache"}]',true);
  if requested_zone is null or length(requested_zone)>100 or not exists(select 1 from pg_timezone_names z where z.name=requested_zone)
    or (target_entry_date is not null and (not isfinite(target_entry_date) or target_entry_date not between date '0001-01-01' and date '9999-12-31')) then
    raise exception 'Choose a valid Daily Action date and time zone.' using errcode='22023'; end if;
  if not public.has_active_entitlement('membership_active') then
    return jsonb_build_object('schemaVersion',2,'actorId',actor,'asOf',statement_timestamp(),'appAccess',false,
      'activation',null,'instanceId',null,'timeZone',null,'entryDate',null,'draft',null);
  end if;
  current_id:=private.lock_challenge_instance_actor(actor);
  perform private.require_instance_membership(actor);
  if target_expected_instance_id is not null and current_id is distinct from target_expected_instance_id then
    raise exception 'The challenge instance changed. Refresh and try again.' using errcode='40001',detail='challenge_instance_changed'; end if;
  activation:=private.challenge_activation_payload_v2(actor);
  zone:=coalesce(activation->>'timeZone',requested_zone);
  entry_date:=coalesce(target_entry_date,(clock_timestamp() at time zone zone)::date);
  return jsonb_build_object('schemaVersion',2,'actorId',actor,'asOf',statement_timestamp(),'appAccess',true,
    'activation',activation,'instanceId',current_id,'timeZone',zone,'entryDate',entry_date,
    'draft',case when current_id is null then null else private.daily_standard_draft_payload_v2(actor,current_id,entry_date) end);
end;
$$;
revoke all on function public.get_daily_action_bootstrap_v2(uuid,text,date,uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_daily_action_bootstrap_v2(uuid,text,date,uuid) to authenticated;

create function public.submit_daily_check_in_v2(target_status text,target_completed text[],target_workout_difficulty jsonb,
  target_time_zone text,target_expected_date date,target_expected_actor_id uuid,target_expected_instance_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.assert_instance_actor(target_expected_actor_id); instance private.challenge_instances%rowtype;
  draft public.challenge_entries%rowtype; inserted public.check_ins%rowtype; submit_date date; normalized text[];
begin
  instance:=private.require_current_instance(actor,target_expected_instance_id);
  perform private.require_instance_membership(actor);
  submit_date:=(clock_timestamp() at time zone instance.time_zone)::date;
  if target_expected_date is null or target_expected_date<>submit_date or target_time_zone is distinct from instance.time_zone then
    raise exception 'The check-in date or time zone changed. Refresh and try again.' using errcode='22023',detail='challenge_date_changed'; end if;
  if target_status is null or target_status not in ('complete','partial') then
    raise exception 'Choose a valid check-in status.' using errcode='22023'; end if;
  perform private.require_instance_daily_date(instance.id,submit_date);
  select * into draft from public.challenge_entries e where e.user_id=actor and e.entry_date=submit_date for update;
  if not found then raise exception 'Complete at least one action before posting.' using errcode='22023'; end if;
  if draft.challenge_instance_id is distinct from instance.id and not (draft.challenge_instance_id is null and instance.scope_key like 'original77:%') then
    raise exception 'The challenge draft belongs to another instance.' using errcode='40001',detail='challenge_instance_changed'; end if;
  normalized:=public.normalize_daily_standard_completed(draft.completed);
  if cardinality(normalized)=0 then raise exception 'Complete at least one action before posting.' using errcode='22023'; end if;
  perform private.require_instance_daily_date(instance.id,submit_date);
  insert into public.check_ins(user_id,entry_date,challenge_day,status,completed_count,completed,workout_difficulty,challenge_instance_id)
    values(actor,submit_date,submit_date-instance.start_date+1,case when cardinality(normalized)=7 then 'complete' else 'partial' end,
      cardinality(normalized),normalized,draft.workout_difficulty,instance.id) returning * into inserted;
  return jsonb_build_object('schemaVersion',2,'actorId',actor,'instanceId',instance.id,'id',inserted.id,
    'entry_date',inserted.entry_date,'challenge_day',inserted.challenge_day,'status',inserted.status,
    'completed_count',inserted.completed_count,'points_awarded',inserted.points_awarded,'created_at',inserted.created_at,
    'activation',private.challenge_activation_payload_v2(actor));
end;
$$;
revoke all on function public.submit_daily_check_in_v2(text,text[],jsonb,text,date,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.submit_daily_check_in_v2(text,text[],jsonb,text,date,uuid,uuid) to authenticated;

create or replace function public.reconcile_user_challenge_unlocks(target_user_id uuid)
returns integer language plpgsql security definer set search_path='' as $$
declare inserted_count integer;
begin
  if target_user_id is null then return 0; end if;
  insert into public.user_challenge_states(user_id,challenge_key,status,unlock_points,unlocked_at,metadata)
    select target_user_id,d.challenge_key,'available',d.points_required,clock_timestamp(),
      jsonb_build_object('unlockRuleType',d.unlock_rule_type,'prerequisiteChallengeKey',d.prerequisite_challenge_key,
        'catalogVersion',m.catalog_version)
    from public.reward_definitions d cross join public.reward_catalog_meta m
    where m.catalog_key='primary' and d.state_model='challenge_lifecycle' and d.is_active and d.released
      and private.reward_requirement_met(target_user_id,d.reward_key)
      and (d.required_entitlement_key is null or exists(select 1 from public.entitlements e
        where e.user_id=target_user_id and e.entitlement_key=d.required_entitlement_key and e.status='active'
          and (e.starts_at is null or e.starts_at<=statement_timestamp()) and (e.ends_at is null or e.ends_at>statement_timestamp()))
        or (d.required_entitlement_key='membership_active' and private.early_access_active_for_user(target_user_id,statement_timestamp())))
    on conflict(user_id,challenge_key) do nothing;
  get diagnostics inserted_count=row_count;
  return inserted_count;
end;
$$;

create function public.get_reward_catalog_v2(target_page_size integer default 50,target_after_sort_order integer default null,
  target_after_reward_key text default null,target_expected_actor_id uuid default null,target_expected_revision bigint default null,
  target_expected_catalog_version bigint default null,target_expected_snapshot_version text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.assert_instance_actor(target_expected_actor_id);
begin
  perform set_config('response.headers','[{"Cache-Control":"private, no-store"},{"Pragma":"no-cache"}]',true);
  perform private.lock_challenge_instance_actor(actor);
  perform public.ensure_user_game_stats(actor);
  perform public.reconcile_user_reward_entitlements(actor);
  perform public.reconcile_user_challenge_unlocks(actor);
  return private.reward_catalog_v2(actor,target_page_size,target_after_sort_order,target_after_reward_key,
    target_expected_revision,target_expected_catalog_version,target_expected_snapshot_version);
end;
$$;
revoke all on function public.get_reward_catalog_v2(integer,integer,text,uuid,bigint,bigint,text) from public,anon,authenticated,service_role;
grant execute on function public.get_reward_catalog_v2(integer,integer,text,uuid,bigint,bigint,text) to authenticated;

create function public.start_challenge_instance_v2(target_challenge_key text,target_start_date date,target_time_zone text,
  target_request_id uuid,target_expected_actor_id uuid,target_expected_instance_id uuid,target_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.assert_instance_actor(target_expected_actor_id); current_id uuid; prior private.challenge_instance_requests%rowtype;
  requested_zone text:=nullif(btrim(target_time_zone),''); fingerprint bytea; current_instance private.challenge_instances%rowtype;
  definition public.challenge_definitions%rowtype; actor_revision bigint; next_id uuid:=gen_random_uuid(); next_sequence bigint;
  result jsonb; today date; access_key text; access_checked_at timestamptz;
begin
  if target_request_id is null then raise exception 'A request ID is required.' using errcode='22023'; end if;
  fingerprint:=extensions.digest(convert_to(jsonb_build_array('start',actor,target_challenge_key,target_start_date,
    requested_zone,target_expected_instance_id,target_expected_revision)::text,'UTF8'),'sha256');
  current_id:=private.lock_challenge_instance_actor(actor);
  select * into prior from private.challenge_instance_requests r where r.request_id=target_request_id;
  if found then
    if prior.user_id<>actor or prior.action<>'start' or prior.request_hash<>fingerprint then
      raise exception 'This request ID was already used for another operation.' using errcode='23505'; end if;
    return prior.result||jsonb_build_object('replayed',true);
  end if;
  perform private.require_instance_membership(actor);
  select r.revision into actor_revision from private.challenge_runtime r where r.user_id=actor;
  if exists(select 1 from private.challenge_runtime r where r.user_id=actor and r.review_required) then
    raise exception 'Existing challenge history needs review.' using errcode='55000',detail='challenge_history_review_required'; end if;
  if current_id is distinct from target_expected_instance_id or target_expected_revision is null or target_expected_revision<>actor_revision then
    raise exception 'The challenge timeline changed. Refresh and try again.' using errcode='40001',detail='challenge_instance_changed'; end if;
  select * into current_instance from private.challenge_instances i where i.id=current_id;
  if current_id is null or current_instance.status<>'completed' or current_instance.review_required
    or exists(select 1 from private.challenge_instances i where i.user_id=actor and i.status in ('scheduled','active')) then
    raise exception 'Complete the current challenge before starting another.' using errcode='55000',detail='active_instance_exists'; end if;
  if requested_zone is null or length(requested_zone)>100 or not exists(select 1 from pg_timezone_names z where z.name=requested_zone) then
    raise exception 'Choose a valid time zone.' using errcode='22023'; end if;
  today:=(clock_timestamp() at time zone requested_zone)::date;
  if target_start_date is null or not isfinite(target_start_date) or target_start_date not between date '0001-01-01' and date '9999-12-31'
    or target_start_date<today then raise exception 'Choose today or a future start date.' using errcode='22023'; end if;
  select * into definition from public.challenge_definitions d where d.challenge_key=target_challenge_key and d.is_active;
  if not found or definition.duration_days not between 1 and 365 then
    raise exception 'This challenge is not available.' using errcode='22023'; end if;
  if target_challenge_key='original_77' then
    if not private.challenge_definition_completed(actor,'original_77') then
      raise exception 'Complete the original challenge before repeating it.' using errcode='55000'; end if;
  else
    perform public.reconcile_user_challenge_unlocks(actor);
    select d.required_entitlement_key into access_key from public.reward_definitions d
      where d.challenge_key=target_challenge_key and d.is_active and d.released for share;
    if not found then raise exception 'This challenge is not available.' using errcode='42501'; end if;
    if access_key is not null then
      perform 1 from public.entitlements e where e.user_id=actor and e.entitlement_key=access_key for share;
      access_checked_at:=clock_timestamp();
      if not (exists(select 1 from public.entitlements e where e.user_id=actor and e.entitlement_key=access_key and e.status='active'
        and (e.starts_at is null or e.starts_at<=access_checked_at) and (e.ends_at is null or e.ends_at>access_checked_at))
        or (access_key='membership_active' and private.early_access_active_for_user(actor,access_checked_at))) then
        raise exception 'The required challenge entitlement is inactive.' using errcode='42501',detail='entitlement_required'; end if;
    end if;
    if not exists(select 1 from public.user_challenge_states s join public.reward_definitions d on d.challenge_key=s.challenge_key
      where s.user_id=actor and s.challenge_key=target_challenge_key and d.is_active and d.released) then
      raise exception 'Unlock this challenge before starting it.' using errcode='42501',detail='challenge_locked'; end if;
  end if;
  select coalesce(max(i.sequence_no),-1)+1 into next_sequence from private.challenge_instances i where i.user_id=actor;
  insert into private.challenge_instances(id,user_id,challenge_key,title,scope_key,sequence_no,status,start_date,time_zone,
    participation_mode,target_count,provenance)
    values(next_id,actor,target_challenge_key,definition.title,'instance:'||next_id::text,next_sequence,
      case when target_start_date>today then 'scheduled' else 'active' end,target_start_date,requested_zone,'solo',definition.duration_days,'live');
  update private.challenge_runtime set current_instance_id=next_id,revision=revision+1 where user_id=actor;
  -- Durable ownership is never reset on a replay/repeat. Only an unused grant
  -- advances its first lifecycle timestamps; each run has its own event history.
  update public.user_challenge_states set status='active',started_at=clock_timestamp()
    where user_id=actor and challenge_key=target_challenge_key and status='available';
  result:=jsonb_build_object('schemaVersion',2,'actorId',actor,'instanceId',next_id,
    'activation',private.challenge_activation_payload_v2(actor),'replayed',false);
  insert into private.challenge_instance_requests(request_id,user_id,action,request_hash,result)
    values(target_request_id,actor,'start',fingerprint,result);
  return result;
end;
$$;
revoke all on function public.start_challenge_instance_v2(text,date,text,uuid,uuid,uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function public.start_challenge_instance_v2(text,date,text,uuid,uuid,uuid,bigint) to authenticated;

create or replace function public.get_badge_collection(target_expected_actor_id uuid)
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
  select i.scope_key into instance_id from private.challenge_runtime r
    join private.challenge_instances i on i.id=r.current_instance_id
    where r.user_id=actor and not i.review_required;
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

create or replace function public.apply_authoritative_daily_standard_draft()
returns trigger language plpgsql security definer set search_path='' as $$
declare draft public.challenge_entries%rowtype; instance private.challenge_instances%rowtype; normalized text[];
begin
  if new.status='scheduled' then
    raise exception 'Scheduled miss Check-Ins are no longer supported.' using errcode='22023';
  end if;
  if (select auth.uid()) is distinct from new.user_id then raise exception 'Check-in actor mismatch.' using errcode='42501'; end if;
  instance:=private.require_current_instance(new.user_id,new.challenge_instance_id);
  perform private.require_instance_membership(new.user_id);
  perform private.require_instance_daily_date(instance.id,new.entry_date);
  select * into draft from public.challenge_entries e where e.user_id=new.user_id and e.entry_date=new.entry_date for update;
  if not found then raise exception 'Complete at least one action before posting.' using errcode='22023'; end if;
  if draft.challenge_instance_id is distinct from instance.id and not (draft.challenge_instance_id is null and instance.scope_key like 'original77:%') then
    raise exception 'The challenge draft belongs to another instance.' using errcode='40001',detail='challenge_instance_changed'; end if;
  normalized:=public.normalize_daily_standard_completed(draft.completed);
  if cardinality(normalized)=0 then raise exception 'Complete at least one action before posting.' using errcode='22023'; end if;
  new.completed:=normalized; new.completed_count:=cardinality(normalized);
  new.status:=case when new.completed_count=7 then 'complete' else 'partial' end;
  new.workout_difficulty:=draft.workout_difficulty;
  return new;
end;
$$;

create or replace function public.process_check_in_game_rewards()
returns trigger language plpgsql security definer set search_path='' as $$
declare instance private.challenge_instances%rowtype; points_inserted boolean; action_points integer;
begin
  if (select auth.uid()) is distinct from new.user_id then raise exception 'Check-in actor mismatch.' using errcode='42501'; end if;
  instance:=private.require_current_instance(new.user_id,new.challenge_instance_id);
  perform private.require_instance_daily_date(instance.id,new.entry_date);
  if new.challenge_day not between 1 and 3652059 or new.challenge_day<>new.entry_date-instance.start_date+1
    or new.status not in ('complete','partial') or new.completed is distinct from public.normalize_daily_standard_completed(new.completed)
    or cardinality(new.completed) not between 1 and 7 or not isfinite(new.created_at)
    or new.created_at<timestamptz '0001-01-01 00:00:00+00' or new.created_at>=timestamptz '10000-01-01 00:00:00+00' then
    raise exception 'Invalid check-in.' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text,0));
  new.completed_count:=cardinality(new.completed); action_points:=least(greatest(new.completed_count,0),7);
  points_inserted:=public.add_game_points(new.user_id,'check_in',action_points,new.entry_date,new.challenge_day,null,
    jsonb_build_object('status',new.status,'completedCount',new.completed_count,'completed',new.completed,
      'workoutDifficulty',new.workout_difficulty,'actionPoints',action_points,'challengeInstanceId',instance.id,'challengeKey',instance.challenge_key),
    'checkin:'||new.user_id::text||':'||new.entry_date::text);
  new.points_awarded:=case when points_inserted then action_points else 0 end;
  return new;
end;
$$;

create or replace function private.badge_rule_matches(rule_metric text,rule_threshold integer,rule_predicate text,facts jsonb)
returns boolean language sql immutable security invoker set search_path='' as $$
  select case when rule_metric='workout' then facts->'workouts'->>rule_predicate in ('one','two')
    when rule_metric='original_77_completion' then rule_threshold=1 and facts->>'kind'='challenge_completion'
      and facts->>'completionKind'='original_77_submissions' and (facts->>'submittedCount')::integer=77
      and (facts->>'targetCount')::integer=77 and (facts->>'original_77_completion')::integer=1
      and facts->>'completionEventId'~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and facts->>'sourceCheckInId'~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and (facts->>'instanceId'~'^original77:[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        or (facts->>'challengeKey'='original_77' and facts->>'instanceId'~'^instance:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'))
    when rule_metric in ('check_in_count','partial_count','perfect_count','instance_check_in_count','perfect_streak','app_streak','verified_share')
      then (facts->>rule_metric)::integer=rule_threshold else false end;
$$;

-- Keep the existing trigger identity/order. Its body now records any live run,
-- and emits Finisher only for original_77; no history is replayed here.
create or replace function private.record_live_original_77_completion()
returns trigger language plpgsql security definer set search_path='' as $$
declare instance private.challenge_instances%rowtype; submitted integer; completion_id uuid:=gen_random_uuid(); facts jsonb; awards jsonb;
begin
  if (select auth.uid()) is distinct from new.user_id then raise exception 'Check-in actor mismatch.' using errcode='42501'; end if;
  select * into strict instance from private.challenge_instances i where i.id=new.challenge_instance_id and i.user_id=new.user_id for update;
  select count(*) into submitted from public.check_ins c where c.challenge_instance_id=instance.id;
  if instance.status<>'active' or instance.review_required or submitted>instance.target_count then
    raise exception 'Challenge completion evidence is invalid.' using errcode='23514'; end if;
  update private.challenge_runtime set revision=revision+1 where user_id=new.user_id;
  if submitted<instance.target_count then return new; end if;
  if instance.scope_key like 'original77:%' then
    insert into private.original_77_completion_events(id,user_id,challenge_start_date,completion_kind,criteria_version,
      source_check_in_id,source_local_date,source_recorded_at)
      values(completion_id,new.user_id,instance.start_date,'original_77_submissions',1,new.id,new.entry_date,new.created_at);
  end if;
  insert into private.challenge_instance_completions(id,user_id,instance_id,source_check_in_id,local_date,completed_at,target_count)
    values(completion_id,new.user_id,instance.id,new.id,new.entry_date,new.created_at,instance.target_count);
  update private.challenge_instances set status='completed',provenance='live',completed_at=new.created_at,completion_event_id=completion_id
    where id=instance.id;
  update public.user_challenge_states set status='completed',completed_at=new.created_at
    where user_id=new.user_id and challenge_key=instance.challenge_key and status='active';
  perform public.reconcile_user_challenge_unlocks(new.user_id);
  if instance.challenge_key='original_77' then
    facts:=jsonb_build_object('kind','challenge_completion','instanceId',instance.scope_key,'challengeKey',instance.challenge_key,
      'completionKind','original_77_submissions','completionEventId',completion_id,'sourceCheckInId',new.id,
      'submittedCount',77,'targetCount',77,'original_77_completion',1);
    awards:=private.persist_badge_event(new.user_id,'challenge_completion',completion_id,instance.scope_key,new.entry_date,new.created_at,facts,false);
    if jsonb_array_length(awards)<>1 and not exists(select 1 from public.user_badges b where b.user_id=new.user_id
      and b.badge_key='original_77_completed' and b.scope_key=instance.scope_key and b.metadata->>'sourceRecordId'=completion_id::text) then
      raise exception 'The canonical Finisher award was not persisted.' using errcode='23514'; end if;
  end if;
  return new;
end;
$$;

create or replace function private.check_in_badge_facts(event_id uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare event public.check_ins%rowtype; instance private.challenge_instances%rowtype;
  actions constant text[]:=array['bible','morningPrayer','worshipOnly','eveningPrayer','workoutOne','walk','workoutTwo'];
  all_count integer; instance_count integer; partial_count integer; perfect_count integer; completed_count integer;
  streak integer:=0; check_date date; workouts jsonb:='{}'::jsonb;
begin
  select * into event from public.check_ins c where c.id=event_id;
  select * into instance from private.challenge_instances i where i.id=event.challenge_instance_id and i.user_id=event.user_id;
  if event.id is null or instance.id is null or instance.review_required or event.challenge_day<>event.entry_date-instance.start_date+1
    or event.status not in ('complete','partial') or event.completed is distinct from public.normalize_daily_standard_completed(event.completed)
    or cardinality(event.completed) not between 1 and 7 then return null; end if;
  completed_count:=cardinality(event.completed);
  select count(*)::integer,count(*) filter(where c.challenge_instance_id=instance.id)::integer,
    count(*) filter(where cardinality(c.completed)<7)::integer,
    count(*) filter(where cardinality(c.completed)=7 and c.completed@>actions)::integer
    into all_count,instance_count,partial_count,perfect_count from public.check_ins c
    where c.user_id=event.user_id and c.entry_date<=event.entry_date and c.status in ('complete','partial')
      and cardinality(c.completed) between 1 and 7 and c.completed=public.normalize_daily_standard_completed(c.completed);
  check_date:=event.entry_date;
  while exists(select 1 from public.check_ins c where c.challenge_instance_id=instance.id and c.entry_date=check_date
    and c.status='complete' and cardinality(c.completed)=7 and c.completed@>actions)
    loop streak:=streak+1;check_date:=check_date-1;end loop;
  if 'workoutOne'=any(event.completed) and event.workout_difficulty->>'one' in ('easy','medium','hard','extreme') then
    workouts:=workouts||jsonb_build_object(event.workout_difficulty->>'one','one'); end if;
  if 'workoutTwo'=any(event.completed) and event.workout_difficulty->>'two' in ('easy','medium','hard','extreme')
    and not(workouts?(event.workout_difficulty->>'two')) then workouts:=workouts||jsonb_build_object(event.workout_difficulty->>'two','two'); end if;
  return jsonb_build_object('instanceId',instance.scope_key,'check_in_count',all_count,'instance_check_in_count',instance_count,
    'partial_count',case when completed_count<7 then partial_count else 0 end,
    'perfect_count',case when completed_count=7 then perfect_count else 0 end,
    'perfect_streak',streak,'completedCount',completed_count,'workouts',workouts);
end;
$$;

create function public.set_challenge_start_date_v2(target_start_date date,target_time_zone text,target_request_id uuid,
  target_expected_revision bigint,target_expected_actor_id uuid,target_expected_instance_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.assert_instance_actor(target_expected_actor_id); instance private.challenge_instances%rowtype;
  current_id uuid; revision bigint; prior private.challenge_instance_requests%rowtype; fingerprint bytea; result jsonb;
  zone text:=nullif(btrim(target_time_zone),''); today date; next_status text;
begin
  if target_request_id is null then raise exception 'A request ID is required.' using errcode='22023'; end if;
  fingerprint:=extensions.digest(convert_to(jsonb_build_array('set_start',actor,target_start_date,zone,
    target_expected_revision,target_expected_instance_id)::text,'UTF8'),'sha256');
  current_id:=private.lock_challenge_instance_actor(actor);
  select * into prior from private.challenge_instance_requests r where r.request_id=target_request_id;
  if found then
    if prior.user_id<>actor or prior.action<>'set_start' or prior.request_hash<>fingerprint then
      raise exception 'This request ID was already used for another operation.' using errcode='23505'; end if;
    return prior.result;
  end if;
  if current_id is null or current_id is distinct from target_expected_instance_id then
    raise exception 'The challenge instance changed. Refresh and try again.' using errcode='40001',detail='challenge_instance_changed'; end if;
  perform private.require_instance_membership(actor);
  if exists(select 1 from private.challenge_runtime r where r.user_id=actor and r.review_required) then
    raise exception 'Existing challenge history needs review.' using errcode='55000',detail='challenge_history_review_required'; end if;
  select * into strict instance from private.challenge_instances i where i.id=current_id;
  select r.revision into revision from private.challenge_runtime r where r.user_id=actor;
  if target_expected_revision is null or target_expected_revision<>revision then
    raise exception 'The challenge timeline changed. Refresh and try again.' using errcode='40001',detail='challenge_activation_stale_revision'; end if;
  if instance.challenge_key<>'original_77' or instance.sequence_no<>0 or instance.participation_mode<>'solo'
    or instance.status='completed' or instance.review_required or exists(select 1 from public.check_ins c where c.user_id=actor) then
    raise exception 'The challenge start date is locked.' using errcode='55000'; end if;
  if zone is null or length(zone)>100 or not exists(select 1 from pg_timezone_names z where z.name=zone) then
    raise exception 'Choose a valid time zone.' using errcode='22023'; end if;
  today:=(clock_timestamp() at time zone zone)::date;
  if target_start_date is null or not isfinite(target_start_date) or target_start_date not between date '0001-01-01' and date '9999-12-31'
    or target_start_date<today-76 then raise exception 'Choose a valid challenge start date.' using errcode='22023'; end if;
  if target_start_date<>instance.start_date or zone<>instance.time_zone then
    next_status:=case when target_start_date>today then 'scheduled' else 'active' end;
    update private.challenge_instances set start_date=target_start_date,time_zone=zone,status=next_status,
      scope_key='original77:'||target_start_date::text where id=instance.id;
    update public.profiles set challenge_start_date=target_start_date,challenge_activation_time_zone=zone,time_zone=zone,
      challenge_activation_status=next_status,challenge_activation_revision=challenge_activation_revision+1,
      challenge_activation_updated_at=clock_timestamp(),
      challenge_activated_at=case when next_status='active' then coalesce(challenge_activated_at,clock_timestamp()) else null end,
      challenge_activated_by=case when next_status='active' then coalesce(challenge_activated_by,actor) else null end
      where user_id=actor;
    update private.challenge_runtime r set revision=r.revision+1 where r.user_id=actor;
  end if;
  result:=private.challenge_activation_payload_v2(actor);
  insert into private.challenge_instance_requests(request_id,user_id,action,request_hash,result)
    values(target_request_id,actor,'set_start',fingerprint,result);
  return result;
end;
$$;
revoke all on function public.set_challenge_start_date_v2(date,text,uuid,bigint,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.set_challenge_start_date_v2(date,text,uuid,bigint,uuid,uuid) to authenticated;

-- Old mutation boundaries cannot silently move a stale same-actor client onto
-- a newer run. Retain callable, explicit upgrade errors for supported old RPCs.
create or replace function public.mutate_daily_standard_draft(target_entry_date date,target_action_id text,target_completed boolean,
  target_expected_version bigint,target_expected_actor_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin perform private.assert_instance_actor(target_expected_actor_id);
  raise exception 'Refresh to use instance-bound Daily Standards.' using errcode='55000',detail='challenge_instance_required'; end;
$$;
create or replace function public.set_daily_standard_workout_difficulty(target_entry_date date,target_workout_id text,target_difficulty text,
  target_expected_version bigint,target_expected_actor_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin perform private.assert_instance_actor(target_expected_actor_id);
  raise exception 'Refresh to use instance-bound Daily Standards.' using errcode='55000',detail='challenge_instance_required'; end;
$$;
create or replace function public.submit_daily_check_in(target_status text,target_completed text[],target_workout_difficulty jsonb,
  target_time_zone text,target_expected_date date,target_expected_actor_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin perform private.assert_instance_actor(target_expected_actor_id);
  raise exception 'Refresh to use instance-bound check-ins.' using errcode='55000',detail='challenge_instance_required'; end;
$$;
create or replace function public.set_challenge_start_date(target_start_date date,target_time_zone text,target_request_id uuid,
  target_expected_revision bigint,target_expected_actor_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin perform private.assert_instance_actor(target_expected_actor_id);
  raise exception 'Refresh to use instance-bound challenge dates.' using errcode='55000',detail='challenge_instance_required'; end;
$$;
create or replace function public.start_challenge(target_challenge_key text,target_expected_actor_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin perform private.assert_instance_actor(target_expected_actor_id);
  raise exception 'Refresh to use instance-bound challenge starts.' using errcode='55000',detail='challenge_instance_required'; end;
$$;
create or replace function public.start_challenge(target_challenge_key text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin perform private.assert_instance_actor((select auth.uid()));
  raise exception 'Refresh to use instance-bound challenge starts.' using errcode='55000',detail='challenge_instance_required'; end;
$$;

create or replace function public.daily_standard_user_date(target_user_id uuid)
returns date language plpgsql stable security definer set search_path='' as $$
declare zone text;
begin
  select i.time_zone into zone from private.challenge_runtime r join private.challenge_instances i on i.id=r.current_instance_id
    where r.user_id=target_user_id;
  if zone is null then select coalesce(nullif(p.challenge_activation_time_zone,''),nullif(p.time_zone,''))
    into zone from public.profiles p where p.user_id=target_user_id; end if;
  if zone is null or not exists(select 1 from pg_timezone_names z where z.name=zone) then zone:='UTC'; end if;
  return (statement_timestamp() at time zone zone)::date;
end;
$$;

-- History-preserving initialization: only the newly added check-in association
-- is filled. Original rows, drafts, points, rewards and completion dates remain.
create function private.bind_original_challenge_instance(target_user_id uuid,target_import boolean default false)
returns uuid language plpgsql security definer set search_path='' as $$
declare
  profile public.profiles%rowtype;
  first_id uuid;
  evidence jsonb;
  event private.original_77_completion_events%rowtype;
  next_status text;
  zone text;
  reason text;
begin
  select i.id into first_id from private.challenge_instances i
    where i.user_id=target_user_id and i.sequence_no=0 and i.challenge_key='original_77';
  if found then return first_id; end if;
  select * into profile from public.profiles p where p.user_id=target_user_id;
  if not found then return null; end if;
  if profile.challenge_activation_status='not_started' then
    if profile.challenge_activation_review_required then
      insert into private.challenge_runtime(user_id,revision,review_required,review_reason)
      values(target_user_id,greatest(profile.challenge_activation_revision,1),true,'activation_review_required')
      on conflict(user_id) do update set review_required=true,review_reason='activation_review_required';
    end if;
    return null;
  end if;
  zone:=profile.challenge_activation_time_zone;
  if profile.challenge_start_date is null or not isfinite(profile.challenge_start_date)
    or profile.challenge_start_date not between date '0001-01-01' and date '9999-12-31'
    or zone is null or not exists(select 1 from pg_timezone_names z where z.name=zone)
    or profile.challenge_participation_mode is null or profile.challenge_participation_mode not in ('solo','group')
    or (profile.challenge_participation_mode='group' and profile.challenge_group_attribution_crew_id is null)
  then reason:='invalid_legacy_activation';
  else
    evidence:=private.original_77_submission_evidence(target_user_id,profile.challenge_start_date);
    if not coalesce((evidence->>'valid')::boolean,false) then
      reason:=coalesce(evidence->>'reason','invalid_legacy_evidence');
    end if;
  end if;
  if reason is not null then
    insert into private.challenge_runtime(user_id,revision,review_required,review_reason)
    values(target_user_id,greatest(profile.challenge_activation_revision,1),true,reason)
    on conflict(user_id) do update set review_required=true,review_reason=excluded.review_reason;
    return null;
  end if;
  select * into event from private.original_77_completion_events e
    where e.user_id=target_user_id and e.challenge_start_date=profile.challenge_start_date
      and e.completion_kind='original_77_submissions';
  next_status:=case when (evidence->>'submittedCount')::integer=77 then 'completed'
    when profile.challenge_start_date>(statement_timestamp() at time zone zone)::date then 'scheduled' else 'active' end;
  first_id:=gen_random_uuid();
  insert into private.challenge_instances(id,user_id,challenge_key,title,scope_key,sequence_no,status,
    start_date,time_zone,participation_mode,crew_id,target_count,provenance,completed_at,completion_event_id,metadata)
  values(first_id,target_user_id,'original_77','77-Day Dominion Challenge','original77:'||profile.challenge_start_date::text,
    0,next_status,profile.challenge_start_date,zone,profile.challenge_participation_mode,
    case when profile.challenge_participation_mode='group' then profile.challenge_group_attribution_crew_id else null end,77,
    case when next_status='completed' and event.id is null then 'legacy_completed'
      when target_import then 'legacy_bound' else 'live' end,
    event.source_recorded_at,event.id,jsonb_build_object('source',
      case when target_import then 'original_activation_import' else 'initial_activation' end));
  -- Association only; normal FK/constraint checks stay enabled. No source data
  -- column, status, date, timestamp, action or point value is in this SET list.
  update public.check_ins c set challenge_instance_id=first_id
    where c.user_id=target_user_id and c.challenge_instance_id is null;
  if event.id is not null then
    insert into private.challenge_instance_completions(id,user_id,instance_id,source_check_in_id,
      local_date,completed_at,persisted_at,target_count)
    values(event.id,target_user_id,first_id,event.source_check_in_id,event.source_local_date,
      event.source_recorded_at,event.recorded_at,77);
  end if;
  insert into private.challenge_runtime(user_id,current_instance_id,revision)
  values(target_user_id,first_id,greatest(profile.challenge_activation_revision,1))
  on conflict(user_id) do update set current_instance_id=excluded.current_instance_id,
    revision=greatest(private.challenge_runtime.revision,excluded.revision);
  return first_id;
end;
$$;
revoke all on function private.bind_original_challenge_instance(uuid,boolean) from public,anon,authenticated,service_role;

do $preserve_existing_challenge_lifecycle$
declare
  actor record;
  legacy record;
  first_id uuid;
  imported_id uuid;
  current_id uuid;
  next_sequence bigint;
  zone text;
  imported_start date;
  needs_review boolean;
  active_count integer;
begin
  -- Abort on an unexpected UPDATE hook instead of disabling a source trigger.
  -- The known status-only guard does not fire for the association-only SET list.
  if exists(select 1 from pg_trigger t where t.tgrelid='public.check_ins'::regclass
    and not t.tgisinternal and t.tgenabled<>'D' and (t.tgtype::integer & 16)<>0
    and (cardinality(t.tgattr::smallint[])=0 or
      (select a.attnum from pg_attribute a where a.attrelid=t.tgrelid and a.attname='challenge_instance_id')
        =any(t.tgattr::smallint[]))) then
    raise exception 'Unexpected check-in UPDATE trigger; preservation review is required.' using errcode='55000';
  end if;
  for actor in select p.user_id from public.profiles p order by p.user_id loop
    first_id:=private.bind_original_challenge_instance(actor.user_id,true);
    if first_id is null then
      if exists(select 1 from public.check_ins c where c.user_id=actor.user_id)
        or exists(select 1 from public.user_challenge_states s
          where s.user_id=actor.user_id and s.status in ('active','completed')) then
        insert into private.challenge_runtime(user_id,review_required,review_reason)
        values(actor.user_id,true,'history_without_valid_original_activation')
        on conflict(user_id) do update set review_required=true,
          review_reason=coalesce(private.challenge_runtime.review_reason,excluded.review_reason);
      end if;
      continue;
    end if;
    select i.time_zone into zone from private.challenge_instances i where i.id=first_id;
    needs_review:=false;
    select count(*) into active_count from public.user_challenge_states s
      where s.user_id=actor.user_id and s.status='active';
    for legacy in select s.*,d.title,d.duration_days from public.user_challenge_states s
      join public.challenge_definitions d on d.challenge_key=s.challenge_key
      where s.user_id=actor.user_id and s.status in ('active','completed')
      order by (s.status='active'),s.started_at nulls first,s.challenge_key
    loop
      if legacy.challenge_key not in ('seven_day_reset','twenty_one_day_prayer','thirty_day_strength','forty_day_fast','bible_in_a_year')
        or legacy.duration_days is null or legacy.duration_days not between 1 and 365
        or legacy.started_at is null or not isfinite(legacy.started_at)
        or legacy.started_at<timestamptz '0001-01-01 00:00:00+00'
        or legacy.started_at>=timestamptz '10000-01-01 00:00:00+00' or legacy.started_at>statement_timestamp()
        or (legacy.status='completed' and (legacy.completed_at is null or not isfinite(legacy.completed_at)
          or legacy.completed_at<legacy.started_at or legacy.completed_at>statement_timestamp())) then
        needs_review:=true;
        continue;
      end if;
      imported_start:=(legacy.started_at at time zone zone)::date;
      if imported_start not between date '0001-01-01' and date '9999-12-31'
        or imported_start>(statement_timestamp() at time zone zone)::date
        or (legacy.status='active' and (active_count<>1 or exists(select 1 from private.challenge_instances i
          where i.user_id=actor.user_id and i.status in ('scheduled','active')))) then
        needs_review:=true;
        continue;
      end if;
      select coalesce(max(i.sequence_no),-1)+1 into next_sequence from private.challenge_instances i where i.user_id=actor.user_id;
      imported_id:=gen_random_uuid();
      insert into private.challenge_instances(id,user_id,challenge_key,title,scope_key,sequence_no,status,
        start_date,time_zone,participation_mode,target_count,provenance,completed_at,metadata)
      values(imported_id,actor.user_id,legacy.challenge_key,legacy.title,'instance:'||imported_id::text,
        next_sequence,legacy.status,imported_start,zone,'solo',legacy.duration_days,
        case when legacy.status='completed' then 'legacy_completed' else 'legacy_bound' end,legacy.completed_at,
        jsonb_build_object('source','explicit_legacy_lifecycle','legacyState',to_jsonb(legacy)-'title'-'duration_days'));
    end loop;
    select i.id into current_id from private.challenge_instances i where i.user_id=actor.user_id
      order by (i.status in ('scheduled','active')) desc,i.sequence_no desc limit 1;
    update private.challenge_runtime r set current_instance_id=current_id,review_required=needs_review,
      review_reason=case when needs_review then 'conflicting_legacy_lifecycle' else null end where r.user_id=actor.user_id;
    if needs_review then update private.challenge_instances set review_required=true where id=current_id; end if;
  end loop;
end;
$preserve_existing_challenge_lifecycle$;

-- Existing actor/request/group-validated activation and binding commit together.
create function private.bind_initial_instance_after_activation()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.challenge_activation_status<>'not_started' then
    if exists(select 1 from private.challenge_runtime r where r.user_id=new.user_id and r.review_required) then
      raise exception 'Existing challenge history needs review.' using errcode='55000',detail='challenge_history_review_required';
    end if;
    if private.bind_original_challenge_instance(new.user_id,false) is null then
      raise exception 'Challenge activation could not be bound safely.' using errcode='55000',detail='challenge_history_review_required';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.bind_initial_instance_after_activation() from public,anon,authenticated,service_role;
create trigger z_bind_initial_instance_after_activation after insert or update of
  challenge_activation_status,challenge_start_date,challenge_activation_time_zone,
  challenge_participation_mode,challenge_group_attribution_crew_id on public.profiles
  for each row execute function private.bind_initial_instance_after_activation();

-- Opt-in public progress links: only these six payload fields leave the
-- authenticated response. Existing V1/V2 snapshots and tokens are unchanged.
alter table public.public_share_snapshots
  drop constraint public_share_snapshots_snapshot_version_check;
alter table public.public_share_snapshots
  add constraint public_share_snapshots_snapshot_version_check check(snapshot_version in (1,2,3)),
  add constraint public_share_snapshots_v3_payload_check check(snapshot_version<>3 or (
    share_kind='progress' and snapshot_payload->'schemaVersion'='3'::jsonb
    and snapshot_payload->'kind'='"progress"'::jsonb
    and snapshot_payload ?& array['schemaVersion','kind','challengeKey','title','submittedCheckIns','targetCheckIns']
    and snapshot_payload-array['schemaVersion','kind','challengeKey','title','submittedCheckIns','targetCheckIns']='{}'::jsonb
    and jsonb_typeof(snapshot_payload->'challengeKey')='string'
    and snapshot_payload->>'challengeKey' ~ '^[a-z][a-z0-9_]{0,79}$'
    and jsonb_typeof(snapshot_payload->'title')='string'
    and length(btrim(snapshot_payload->>'title')) between 1 and 180
    and jsonb_typeof(snapshot_payload->'submittedCheckIns')='number'
    and jsonb_typeof(snapshot_payload->'targetCheckIns')='number'
    and snapshot_payload->>'submittedCheckIns' ~ '^(0|[1-9][0-9]{0,2})$'
    and snapshot_payload->>'targetCheckIns' ~ '^[1-9][0-9]{0,2}$'
    and (snapshot_payload->>'targetCheckIns')::integer between 1 and 365
    and (snapshot_payload->>'submittedCheckIns')::integer between 0 and (snapshot_payload->>'targetCheckIns')::integer
  ));

create function private.instance_share_payload(target_actor_id uuid,target_kind text,target_expected_instance_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare instance private.challenge_instances%rowtype; submitted integer;
begin
  if target_kind is null or target_kind not in ('streak','progress','general') then
    raise exception 'Unsupported share type.' using errcode='22023'; end if;
  if target_kind<>'progress' then
    if target_expected_instance_id is not null then
      raise exception 'Reopen the share preview.' using errcode='40001'; end if;
    return public.build_share_snapshot_payload(target_actor_id,target_kind);
  end if;
  select i.* into instance from private.challenge_runtime r
    join private.challenge_instances i on (i.id,i.user_id)=(r.current_instance_id,r.user_id)
    where r.user_id=target_actor_id and not r.review_required and not i.review_required;
  if not found or (target_expected_instance_id is not null and target_expected_instance_id<>instance.id) then
    raise exception 'The challenge changed. Reopen the share preview.' using errcode='40001'; end if;
  select count(*)::integer into submitted from public.check_ins c
    where c.user_id=target_actor_id and c.challenge_instance_id=instance.id;
  if submitted>instance.target_count or (instance.status='completed' and submitted<>instance.target_count)
    or (instance.status<>'completed' and submitted>=instance.target_count) then
    raise exception 'Challenge progress is unavailable.' using errcode='55000'; end if;
  return jsonb_build_object('schemaVersion',3,'kind','progress','challengeKey',instance.challenge_key,
    'title',instance.title,'submittedCheckIns',submitted,'targetCheckIns',instance.target_count);
end;
$$;
revoke all on function private.instance_share_payload(uuid,text,uuid) from public,anon,authenticated,service_role;

create function public.preview_share_snapshot_v2(target_kind text,target_expected_actor_id uuid,target_expected_instance_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.assert_instance_actor(target_expected_actor_id); current_id uuid; payload jsonb;
begin
  perform set_config('response.headers','[{"Cache-Control":"private, no-store"},{"Pragma":"no-cache"}]',true);
  current_id:=private.lock_challenge_instance_actor(actor);
  payload:=private.instance_share_payload(actor,target_kind,target_expected_instance_id);
  return jsonb_build_object('schemaVersion',(payload->>'schemaVersion')::integer,'kind',target_kind,'payload',payload,
    'defaultExpirationDays',30,'context',jsonb_build_object('schemaVersion',2,'actorId',actor,
      'instanceId',case when target_kind='progress' then current_id else null end),
    'privacy',jsonb_build_object('includesIdentity',false,'includesGroup',false,'includesActivityHistory',false));
end;
$$;
revoke all on function public.preview_share_snapshot_v2(text,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.preview_share_snapshot_v2(text,uuid,uuid) to authenticated;

create function public.create_share_snapshot_v2(target_kind text,target_expires_at timestamptz,
  target_expected_actor_id uuid,target_expected_instance_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.assert_instance_actor(target_expected_actor_id); current_id uuid; payload jsonb;
  raw_token text; snapshot_id uuid; expires timestamptz:=coalesce(target_expires_at,now()+interval '30 days');
begin
  perform set_config('response.headers','[{"Cache-Control":"private, no-store"},{"Pragma":"no-cache"}]',true);
  if not isfinite(expires) or expires<now()+interval '1 hour' or expires>now()+interval '90 days' then
    raise exception 'Share expiration must be between one hour and 90 days.' using errcode='22023'; end if;
  if target_kind='progress' and target_expected_instance_id is null then
    raise exception 'Reopen the share preview before creating a link.' using errcode='40001'; end if;
  current_id:=private.lock_challenge_instance_actor(actor);
  payload:=private.instance_share_payload(actor,target_kind,target_expected_instance_id);
  perform pg_advisory_xact_lock(hashtextextended('share-snapshot:'||actor::text,0));
  if (select count(*) from public.public_share_snapshots s where s.user_id=actor and s.created_at>now()-interval '1 hour')>=10 then
    raise exception 'Share link rate limit reached. Try again later.' using errcode='P0001'; end if;
  if (select count(*) from public.public_share_snapshots s where s.user_id=actor and s.revoked_at is null and s.expires_at>now())>=25 then
    raise exception 'Revoke an existing share link before creating another.' using errcode='P0001'; end if;
  raw_token:=encode(extensions.gen_random_bytes(32),'hex');
  insert into public.public_share_snapshots(user_id,public_token_digest,snapshot_version,share_kind,snapshot_payload,expires_at)
    values(actor,extensions.digest(raw_token,'sha256'),(payload->>'schemaVersion')::integer,target_kind,payload,expires)
    returning id into snapshot_id;
  -- Context is authenticated-only and never persisted in the public payload.
  return jsonb_build_object('schemaVersion',(payload->>'schemaVersion')::integer,'kind',target_kind,'payload',payload,
    'snapshotId',snapshot_id,'token',raw_token,'expiresAt',expires,
    'context',jsonb_build_object('schemaVersion',2,'actorId',actor,'instanceId',case when target_kind='progress' then current_id else null end));
end;
$$;
revoke all on function public.create_share_snapshot_v2(text,timestamptz,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.create_share_snapshot_v2(text,timestamptz,uuid,uuid) to authenticated;

-- Retire unfenced creators, not existing public links or their public reader.
create or replace function public.preview_share_snapshot(target_kind text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin raise exception 'Refresh to use the current challenge share preview.' using errcode='55000'; end;
$$;
create or replace function public.create_share_snapshot(target_kind text,target_expires_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path='' as $$
begin raise exception 'Refresh to use the current challenge share preview.' using errcode='55000'; end;
$$;
