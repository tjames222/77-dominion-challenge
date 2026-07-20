-- Member-controlled privacy preferences for updates sent from Dominion to a
-- crew's external Slack or Discord destination. A missing preference row is
-- deliberately treated as no consent so existing and future members fail
-- closed until they make an explicit choice.

create table public.outbound_update_preferences (
  id uuid primary key default gen_random_uuid(),
  crew_id uuid not null,
  user_id uuid not null,
  outbound_updates_enabled boolean not null default false,
  presentation_mode text not null default 'anonymous'
    check (presentation_mode in ('named', 'anonymous')),
  share_check_ins boolean not null default false,
  share_streak_milestones boolean not null default false,
  share_badges_rewards boolean not null default false,
  share_membership_events boolean not null default false,
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (crew_id, user_id),
  foreign key (crew_id, user_id)
    references public.crew_members (crew_id, user_id)
    on delete cascade
);

comment on table public.outbound_update_preferences is
  'Current per-member approval for sending selected crew events to external destinations. Absence means no consent.';

create table public.outbound_update_preference_audit (
  id uuid primary key default gen_random_uuid(),
  preference_id uuid not null,
  crew_id uuid not null,
  user_id uuid not null,
  revision bigint not null check (revision > 0),
  change_type text not null check (change_type in ('created', 'updated', 'revoked')),
  change_source text not null check (change_source in ('member', 'membership_or_account_removed')),
  outbound_updates_enabled boolean not null,
  presentation_mode text not null check (presentation_mode in ('named', 'anonymous')),
  share_check_ins boolean not null,
  share_streak_milestones boolean not null,
  share_badges_rewards boolean not null,
  share_membership_events boolean not null,
  changed_by uuid,
  changed_at timestamptz not null default now(),
  unique (preference_id, revision)
);

comment on table public.outbound_update_preference_audit is
  'Immutable consent-setting history only. Event payloads and outbound message content must never be stored here.';

create index outbound_update_preference_audit_user_changed_idx
  on public.outbound_update_preference_audit (user_id, changed_at desc);

create or replace function public.prepare_outbound_update_preference()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.id := gen_random_uuid();
    new.revision := 1;
    new.created_at := now();
    new.updated_at := new.created_at;
    return new;
  end if;

  if new.id is distinct from old.id
    or new.crew_id is distinct from old.crew_id
    or new.user_id is distinct from old.user_id then
    raise exception 'Consent preference identity cannot be changed.';
  end if;

  if row(
    new.outbound_updates_enabled,
    new.presentation_mode,
    new.share_check_ins,
    new.share_streak_milestones,
    new.share_badges_rewards,
    new.share_membership_events
  ) is not distinct from row(
    old.outbound_updates_enabled,
    old.presentation_mode,
    old.share_check_ins,
    old.share_streak_milestones,
    old.share_badges_rewards,
    old.share_membership_events
  ) then
    -- Treat an identical client or worker retry as a no-op. This avoids a
    -- misleading new audit revision without weakening current-consent checks.
    return null;
  end if;

  new.id := old.id;
  new.crew_id := old.crew_id;
  new.user_id := old.user_id;
  new.revision := old.revision + 1;
  new.created_at := old.created_at;
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.audit_outbound_update_preference()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    insert into public.outbound_update_preference_audit (
      preference_id,
      crew_id,
      user_id,
      revision,
      change_type,
      change_source,
      outbound_updates_enabled,
      presentation_mode,
      share_check_ins,
      share_streak_milestones,
      share_badges_rewards,
      share_membership_events,
      changed_by
    ) values (
      old.id,
      old.crew_id,
      old.user_id,
      old.revision + 1,
      'revoked',
      'membership_or_account_removed',
      false,
      'anonymous',
      false,
      false,
      false,
      false,
      null
    );
    return old;
  end if;

  insert into public.outbound_update_preference_audit (
    preference_id,
    crew_id,
    user_id,
    revision,
    change_type,
    change_source,
    outbound_updates_enabled,
    presentation_mode,
    share_check_ins,
    share_streak_milestones,
    share_badges_rewards,
    share_membership_events,
    changed_by
  ) values (
    new.id,
    new.crew_id,
    new.user_id,
    new.revision,
    case when tg_op = 'INSERT' then 'created' else 'updated' end,
    'member',
    new.outbound_updates_enabled,
    new.presentation_mode,
    new.share_check_ins,
    new.share_streak_milestones,
    new.share_badges_rewards,
    new.share_membership_events,
    auth.uid()
  );
  return new;
end;
$$;

create or replace function public.reject_outbound_update_preference_audit_mutation()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  raise exception 'Consent audit history is immutable.';
end;
$$;

create trigger prepare_outbound_update_preference
  before insert or update on public.outbound_update_preferences
  for each row execute function public.prepare_outbound_update_preference();

create trigger audit_outbound_update_preference
  after insert or update or delete on public.outbound_update_preferences
  for each row execute function public.audit_outbound_update_preference();

create trigger reject_outbound_update_preference_audit_mutation
  before update or delete on public.outbound_update_preference_audit
  for each row execute function public.reject_outbound_update_preference_audit_mutation();

create or replace function public.get_current_outbound_consent(
  target_user_id uuid,
  target_crew_id uuid,
  target_event_type text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_user_id uuid := auth.uid();
  effective_user_id uuid := coalesce(target_user_id, auth.uid());
  caller_is_service_role boolean := coalesce(auth.jwt() ->> 'role', '') = 'service_role';
  preference public.outbound_update_preferences%rowtype;
  consent_recorded boolean := false;
  account_active boolean := false;
  membership_active boolean := false;
  event_recognized boolean := false;
  event_allowed boolean := false;
  eligible boolean := false;
  decision_reason text;
begin
  if not caller_is_service_role
    and (caller_user_id is null or effective_user_id is distinct from caller_user_id) then
    raise exception 'You can only read your own outbound update consent.';
  end if;

  select exists (
    select 1
    from auth.users account
    where account.id = effective_user_id
  ) into account_active;

  select exists (
    select 1
    from public.crew_members crew_member
    where crew_member.crew_id = target_crew_id
      and crew_member.user_id = effective_user_id
  ) into membership_active;

  select current_preference.*
    into preference
    from public.outbound_update_preferences current_preference
    where current_preference.crew_id = target_crew_id
      and current_preference.user_id = effective_user_id;
  consent_recorded := found;

  event_recognized := coalesce(
    target_event_type in ('check_in', 'streak_milestone', 'badge_reward', 'membership'),
    false
  );

  event_allowed := case target_event_type
    when 'check_in' then coalesce(preference.share_check_ins, false)
    when 'streak_milestone' then coalesce(preference.share_streak_milestones, false)
    when 'badge_reward' then coalesce(preference.share_badges_rewards, false)
    when 'membership' then coalesce(preference.share_membership_events, false)
    else false
  end;

  eligible := account_active
    and membership_active
    and consent_recorded
    and coalesce(preference.outbound_updates_enabled, false)
    and event_recognized
    and event_allowed;

  decision_reason := case
    when not account_active then 'account_missing'
    when not membership_active then 'membership_missing'
    when not consent_recorded then 'consent_missing'
    when not coalesce(preference.outbound_updates_enabled, false) then 'updates_disabled'
    when target_event_type is null then 'event_required'
    when not event_recognized then 'unsupported_event'
    when not event_allowed then 'event_not_approved'
    else 'approved'
  end;

  return jsonb_build_object(
    'schemaVersion', 1,
    'consentId', preference.id,
    'userId', effective_user_id,
    'crewId', target_crew_id,
    'eventType', target_event_type,
    'accountActive', account_active,
    'membershipActive', membership_active,
    'consentRecorded', consent_recorded,
    'outboundUpdatesEnabled', coalesce(preference.outbound_updates_enabled, false),
    'presentationMode', coalesce(preference.presentation_mode, 'anonymous'),
    'events', jsonb_build_object(
      'checkIns', coalesce(preference.share_check_ins, false),
      'streakMilestones', coalesce(preference.share_streak_milestones, false),
      'badgesRewards', coalesce(preference.share_badges_rewards, false),
      'membership', coalesce(preference.share_membership_events, false)
    ),
    'eventRecognized', event_recognized,
    'eventAllowed', event_allowed,
    'eligible', eligible,
    'reason', decision_reason,
    'revision', coalesce(preference.revision, 0),
    'changedAt', preference.updated_at,
    'evaluatedAt', clock_timestamp(),
    'destinationCheckRequired', true
  );
end;
$$;

comment on function public.get_current_outbound_consent(uuid, uuid, text) is
  'FOU-542 send-time contract. Call with a concrete event immediately before every initial delivery and retry, then independently verify the FOU-541 connection and FOU-553 runtime destination are active.';

create or replace function public.set_outbound_update_consent(
  target_crew_id uuid,
  target_outbound_updates_enabled boolean default false,
  target_presentation_mode text default 'anonymous',
  target_share_check_ins boolean default false,
  target_share_streak_milestones boolean default false,
  target_share_badges_rewards boolean default false,
  target_share_membership_events boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_user_id uuid := auth.uid();
  normalized_presentation_mode text := lower(trim(coalesce(target_presentation_mode, 'anonymous')));
begin
  if caller_user_id is null then
    raise exception 'You need to log in to change outbound update consent.';
  end if;

  if normalized_presentation_mode not in ('named', 'anonymous') then
    raise exception 'Presentation mode must be named or anonymous.';
  end if;

  if not exists (
    select 1
    from public.crew_members crew_member
    where crew_member.crew_id = target_crew_id
      and crew_member.user_id = caller_user_id
  ) then
    raise exception 'You can only change consent for a group you belong to.';
  end if;

  insert into public.outbound_update_preferences (
    crew_id,
    user_id,
    outbound_updates_enabled,
    presentation_mode,
    share_check_ins,
    share_streak_milestones,
    share_badges_rewards,
    share_membership_events
  ) values (
    target_crew_id,
    caller_user_id,
    coalesce(target_outbound_updates_enabled, false),
    normalized_presentation_mode,
    coalesce(target_share_check_ins, false),
    coalesce(target_share_streak_milestones, false),
    coalesce(target_share_badges_rewards, false),
    coalesce(target_share_membership_events, false)
  )
  on conflict (crew_id, user_id) do update set
    outbound_updates_enabled = excluded.outbound_updates_enabled,
    presentation_mode = excluded.presentation_mode,
    share_check_ins = excluded.share_check_ins,
    share_streak_milestones = excluded.share_streak_milestones,
    share_badges_rewards = excluded.share_badges_rewards,
    share_membership_events = excluded.share_membership_events;

  return public.get_current_outbound_consent(caller_user_id, target_crew_id, null);
end;
$$;

alter table public.outbound_update_preferences enable row level security;
alter table public.outbound_update_preference_audit enable row level security;

create policy "Members can read own outbound update preferences"
  on public.outbound_update_preferences
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Members can insert own outbound update preferences"
  on public.outbound_update_preferences
  for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and public.is_crew_member(crew_id)
  );

create policy "Members can update own outbound update preferences"
  on public.outbound_update_preferences
  for update
  to authenticated
  using (
    (select auth.uid()) = user_id
    and public.is_crew_member(crew_id)
  )
  with check (
    (select auth.uid()) = user_id
    and public.is_crew_member(crew_id)
  );

create policy "Members can read own outbound consent audit"
  on public.outbound_update_preference_audit
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.outbound_update_preferences from public;
revoke all on public.outbound_update_preferences from anon;
revoke all on public.outbound_update_preferences from authenticated;
revoke all on public.outbound_update_preferences from service_role;
grant select, insert on public.outbound_update_preferences to authenticated;
grant update (
  outbound_updates_enabled,
  presentation_mode,
  share_check_ins,
  share_streak_milestones,
  share_badges_rewards,
  share_membership_events
) on public.outbound_update_preferences to authenticated;

revoke all on public.outbound_update_preference_audit from public;
revoke all on public.outbound_update_preference_audit from anon;
revoke all on public.outbound_update_preference_audit from authenticated;
revoke all on public.outbound_update_preference_audit from service_role;
grant select on public.outbound_update_preference_audit to authenticated;

revoke execute on function public.prepare_outbound_update_preference() from public;
revoke execute on function public.prepare_outbound_update_preference() from anon;
revoke execute on function public.prepare_outbound_update_preference() from authenticated;
revoke execute on function public.prepare_outbound_update_preference() from service_role;
revoke execute on function public.audit_outbound_update_preference() from public;
revoke execute on function public.audit_outbound_update_preference() from anon;
revoke execute on function public.audit_outbound_update_preference() from authenticated;
revoke execute on function public.audit_outbound_update_preference() from service_role;
revoke execute on function public.reject_outbound_update_preference_audit_mutation() from public;
revoke execute on function public.reject_outbound_update_preference_audit_mutation() from anon;
revoke execute on function public.reject_outbound_update_preference_audit_mutation() from authenticated;
revoke execute on function public.reject_outbound_update_preference_audit_mutation() from service_role;

revoke execute on function public.get_current_outbound_consent(uuid, uuid, text) from public;
revoke execute on function public.get_current_outbound_consent(uuid, uuid, text) from anon;
grant execute on function public.get_current_outbound_consent(uuid, uuid, text) to authenticated;
grant execute on function public.get_current_outbound_consent(uuid, uuid, text) to service_role;

revoke execute on function public.set_outbound_update_consent(uuid, boolean, text, boolean, boolean, boolean, boolean) from public;
revoke execute on function public.set_outbound_update_consent(uuid, boolean, text, boolean, boolean, boolean, boolean) from anon;
revoke execute on function public.set_outbound_update_consent(uuid, boolean, text, boolean, boolean, boolean, boolean) from service_role;
grant execute on function public.set_outbound_update_consent(uuid, boolean, text, boolean, boolean, boolean, boolean) to authenticated;
