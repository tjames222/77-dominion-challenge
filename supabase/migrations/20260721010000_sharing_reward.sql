-- Grant the lifetime Sharing reward from bounded, auditable completion evidence.

create table if not exists public.sharing_reward_intents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  share_kind text not null check (share_kind in ('native_share', 'copy_link')),
  completion_token_hash bytea not null unique check (octet_length(completion_token_hash) = 32),
  expires_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at),
  check (completed_at is null or completed_at >= created_at)
);

create table if not exists public.sharing_reward_evidence (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  evidence_kind text not null check (
    evidence_kind in ('native_share', 'copy_link', 'confirmed_group_invite')
  ),
  intent_id uuid references public.sharing_reward_intents(id) on delete cascade,
  source_reference_hash bytea not null check (octet_length(source_reference_hash) = 32),
  recorded_at timestamptz not null default now(),
  unique (evidence_kind, source_reference_hash),
  check (
    (evidence_kind in ('native_share', 'copy_link') and intent_id is not null)
    or (evidence_kind = 'confirmed_group_invite' and intent_id is null)
  )
);

create table if not exists public.sharing_reward_grants (
  user_id uuid primary key references auth.users(id) on delete cascade,
  evidence_id uuid not null unique references public.sharing_reward_evidence(id) on delete cascade,
  point_event_id uuid not null unique references public.game_point_events(id) on delete cascade,
  badge_key text not null default 'sharing' references public.badge_definitions(badge_key) on delete restrict,
  points integer not null default 14 check (points = 14),
  granted_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object')
);

create index if not exists sharing_reward_intents_user_created_idx
  on public.sharing_reward_intents (user_id, created_at desc);

create index if not exists sharing_reward_intents_active_idx
  on public.sharing_reward_intents (user_id, expires_at)
  where completed_at is null;

create unique index if not exists sharing_reward_evidence_intent_unique
  on public.sharing_reward_evidence (intent_id)
  where intent_id is not null;

create index if not exists sharing_reward_evidence_user_recorded_idx
  on public.sharing_reward_evidence (user_id, recorded_at desc);

insert into public.badge_definitions (
  badge_key,
  name,
  description,
  category,
  tier,
  icon,
  sort_order
)
values (
  'sharing',
  'Share the Challenge',
  'Shared the challenge or brought another person into a private group.',
  'community',
  'bronze',
  'share',
  35
)
on conflict (badge_key) do update set
  name = excluded.name,
  description = excluded.description,
  category = excluded.category,
  tier = excluded.tier,
  icon = excluded.icon,
  sort_order = excluded.sort_order;

create or replace function public.grant_sharing_reward_for_evidence(
  target_user_id uuid,
  target_evidence_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  evidence_row public.sharing_reward_evidence%rowtype;
  existing_grant public.sharing_reward_grants%rowtype;
  points_inserted boolean := false;
  point_event_id uuid;
begin
  if target_user_id is null or target_evidence_id is null then
    raise exception 'Verified sharing evidence is required.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(target_user_id::text, 0));

  select * into evidence_row
  from public.sharing_reward_evidence
  where id = target_evidence_id
    and user_id = target_user_id;

  if evidence_row.id is null then
    raise exception 'Verified sharing evidence is required.';
  end if;

  select * into existing_grant
  from public.sharing_reward_grants
  where user_id = target_user_id;

  if existing_grant.user_id is not null then
    return jsonb_build_object(
      'granted', false,
      'alreadyGranted', true,
      'points', existing_grant.points,
      'badgeKey', existing_grant.badge_key,
      'grantedAt', existing_grant.granted_at
    );
  end if;

  points_inserted := public.add_game_points(
    target_user_id,
    'sharing_bonus',
    14,
    null,
    null,
    null,
    jsonb_build_object(
      'reward', 'sharing',
      'evidenceKind', evidence_row.evidence_kind,
      'dailyCap', false
    ),
    'sharing_bonus:' || target_user_id::text
  );

  if not points_inserted then
    raise exception 'The Sharing reward ledger could not be written.';
  end if;

  select id into point_event_id
  from public.game_point_events
  where idempotency_key = 'sharing_bonus:' || target_user_id::text
    and user_id = target_user_id
    and event_type = 'sharing_bonus'
    and points = 14;

  if point_event_id is null then
    raise exception 'The Sharing reward ledger could not be verified.';
  end if;

  perform public.award_badge(
    target_user_id,
    'sharing',
    null,
    jsonb_build_object('source', evidence_row.evidence_kind)
  );

  if not exists (
    select 1
    from public.user_badges
    where user_id = target_user_id
      and badge_key = 'sharing'
  ) then
    raise exception 'The Sharing badge could not be awarded.';
  end if;

  insert into public.sharing_reward_grants (
    user_id,
    evidence_id,
    point_event_id,
    badge_key,
    points,
    metadata
  ) values (
    target_user_id,
    target_evidence_id,
    point_event_id,
    'sharing',
    14,
    jsonb_build_object('evidenceKind', evidence_row.evidence_kind)
  )
  returning * into existing_grant;

  return jsonb_build_object(
    'granted', true,
    'alreadyGranted', false,
    'points', existing_grant.points,
    'badgeKey', existing_grant.badge_key,
    'grantedAt', existing_grant.granted_at
  );
end;
$$;

create or replace function public.create_sharing_reward_intent(target_share_kind text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  normalized_kind text := lower(btrim(coalesce(target_share_kind, '')));
  completion_token text;
  inserted_intent public.sharing_reward_intents%rowtype;
begin
  if current_user_id is null then
    raise exception 'You need to log in to share the challenge.';
  end if;

  if normalized_kind not in ('native_share', 'copy_link') then
    raise exception 'This share method cannot earn the Sharing reward.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('sharing-intent:' || current_user_id::text, 0));

  if exists (
    select 1
    from public.sharing_reward_grants
    where user_id = current_user_id
  ) then
    return jsonb_build_object(
      'eligible', false,
      'alreadyGranted', true,
      'shareKind', normalized_kind
    );
  end if;

  if (
    select count(*)
    from public.sharing_reward_intents
    where user_id = current_user_id
      and created_at > now() - interval '1 hour'
  ) >= 10 then
    raise exception 'Too many share attempts. Please try again later.';
  end if;

  if (
    select count(*)
    from public.sharing_reward_intents
    where user_id = current_user_id
      and completed_at is null
      and expires_at > now()
  ) >= 5 then
    raise exception 'Finish or wait for an earlier share attempt before starting another.';
  end if;

  completion_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.sharing_reward_intents (
    user_id,
    share_kind,
    completion_token_hash,
    expires_at
  ) values (
    current_user_id,
    normalized_kind,
    extensions.digest(completion_token, 'sha256'),
    now() + interval '15 minutes'
  )
  returning * into inserted_intent;

  return jsonb_build_object(
    'eligible', true,
    'alreadyGranted', false,
    'intentId', inserted_intent.id,
    'shareKind', inserted_intent.share_kind,
    'completionToken', completion_token,
    'expiresAt', inserted_intent.expires_at
  );
end;
$$;

create or replace function public.complete_sharing_reward(target_completion_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  intent_row public.sharing_reward_intents%rowtype;
  evidence_id uuid;
begin
  if current_user_id is null then
    raise exception 'You need to log in to complete a share.';
  end if;

  if coalesce(target_completion_token, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'This share confirmation is invalid or expired.';
  end if;

  select * into intent_row
  from public.sharing_reward_intents
  where user_id = current_user_id
    and completion_token_hash = extensions.digest(target_completion_token, 'sha256')
  for update;

  if intent_row.id is null then
    raise exception 'This share confirmation is invalid or expired.';
  end if;

  if intent_row.completed_at is null and intent_row.expires_at <= now() then
    raise exception 'This share confirmation is invalid or expired.';
  end if;

  if intent_row.completed_at is null then
    update public.sharing_reward_intents
    set completed_at = now()
    where id = intent_row.id;
  end if;

  insert into public.sharing_reward_evidence (
    user_id,
    evidence_kind,
    intent_id,
    source_reference_hash
  ) values (
    current_user_id,
    intent_row.share_kind,
    intent_row.id,
    extensions.digest('sharing_intent:' || intent_row.id::text, 'sha256')
  )
  on conflict (intent_id) where intent_id is not null do nothing
  returning id into evidence_id;

  if evidence_id is null then
    select id into evidence_id
    from public.sharing_reward_evidence
    where intent_id = intent_row.id
      and user_id = current_user_id;
  end if;

  if evidence_id is null then
    raise exception 'This share confirmation could not be verified.';
  end if;

  return public.grant_sharing_reward_for_evidence(current_user_id, evidence_id);
end;
$$;

create or replace function public.record_confirmed_group_invite_share(
  target_inviter_user_id uuid,
  target_redemption_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  evidence_id uuid;
  existing_user_id uuid;
  authoritative_inviter_user_id uuid;
  source_hash bytea;
begin
  if target_inviter_user_id is null or target_redemption_id is null then
    raise exception 'Confirmed invite attribution is required.';
  end if;

  if not exists (select 1 from auth.users where id = target_inviter_user_id) then
    raise exception 'Confirmed invite attribution is invalid.';
  end if;

  select attribution.inviter_user_id
    into authoritative_inviter_user_id
    from public.crew_invite_attributions attribution
    where attribution.id = target_redemption_id;

  if authoritative_inviter_user_id is null then
    raise exception 'Confirmed invite attribution is invalid.';
  end if;

  if authoritative_inviter_user_id <> target_inviter_user_id then
    raise exception 'Confirmed invite attribution does not match its original inviter.';
  end if;

  source_hash := extensions.digest('confirmed_group_invite:' || target_redemption_id::text, 'sha256');

  select user_id into existing_user_id
  from public.sharing_reward_evidence
  where evidence_kind = 'confirmed_group_invite'
    and source_reference_hash = source_hash;

  if existing_user_id is not null and existing_user_id <> target_inviter_user_id then
    raise exception 'Confirmed invite attribution does not match its original inviter.';
  end if;

  insert into public.sharing_reward_evidence (
    user_id,
    evidence_kind,
    source_reference_hash
  ) values (
    target_inviter_user_id,
    'confirmed_group_invite',
    source_hash
  )
  on conflict (evidence_kind, source_reference_hash) do nothing
  returning id into evidence_id;

  if evidence_id is null then
    select id, user_id into evidence_id, existing_user_id
    from public.sharing_reward_evidence
    where evidence_kind = 'confirmed_group_invite'
      and source_reference_hash = source_hash;

    if existing_user_id is distinct from target_inviter_user_id then
      raise exception 'Confirmed invite attribution does not match its original inviter.';
    end if;
  end if;

  if evidence_id is null then
    raise exception 'Confirmed invite attribution could not be recorded.';
  end if;

  return public.grant_sharing_reward_for_evidence(target_inviter_user_id, evidence_id);
end;
$$;

create or replace function public.record_confirmed_group_invite_share(
  target_redemption_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  inviter_user_id uuid;
begin
  select attribution.inviter_user_id
    into inviter_user_id
    from public.crew_invite_attributions attribution
    where attribution.id = target_redemption_id;

  if inviter_user_id is null then
    raise exception 'Confirmed invite attribution is invalid.';
  end if;

  return public.record_confirmed_group_invite_share(inviter_user_id, target_redemption_id);
end;
$$;

create or replace function public.grant_sharing_reward_after_invite_redemption()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.record_confirmed_group_invite_share(new.inviter_user_id, new.id);
  return new;
end;
$$;

drop trigger if exists grant_sharing_reward_after_invite_redemption
  on public.crew_invite_attributions;
create trigger grant_sharing_reward_after_invite_redemption
  after insert on public.crew_invite_attributions
  for each row execute function public.grant_sharing_reward_after_invite_redemption();

alter table public.sharing_reward_intents enable row level security;
alter table public.sharing_reward_evidence enable row level security;
alter table public.sharing_reward_grants enable row level security;

create policy "Users can read own sharing reward grant"
  on public.sharing_reward_grants
  for select
  to authenticated
  using (user_id = auth.uid());

revoke all on public.sharing_reward_intents from public, anon, authenticated;
revoke all on public.sharing_reward_evidence from public, anon, authenticated;
revoke all on public.sharing_reward_grants from public, anon, authenticated;
grant select on public.sharing_reward_grants to authenticated;
grant select, insert, update, delete on public.sharing_reward_intents to service_role;
grant select, insert, update, delete on public.sharing_reward_evidence to service_role;
grant select, insert, update, delete on public.sharing_reward_grants to service_role;

revoke execute on function public.grant_sharing_reward_for_evidence(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.create_sharing_reward_intent(text) from public, anon;
grant execute on function public.create_sharing_reward_intent(text) to authenticated;
revoke execute on function public.complete_sharing_reward(text) from public, anon;
grant execute on function public.complete_sharing_reward(text) to authenticated;
revoke execute on function public.record_confirmed_group_invite_share(uuid, uuid) from public, anon, authenticated;
grant execute on function public.record_confirmed_group_invite_share(uuid, uuid) to service_role;
revoke execute on function public.record_confirmed_group_invite_share(uuid) from public, anon, authenticated;
grant execute on function public.record_confirmed_group_invite_share(uuid) to service_role;
revoke execute on function public.grant_sharing_reward_after_invite_redemption() from public, anon, authenticated, service_role;
