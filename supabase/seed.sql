-- Stable local fixtures used by pgTAP and integration tests. These UUIDs are
-- reserved for local development; production data is never read or mutated.

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    '10000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'alice@example.test',
    '$2b$10$K7L1OJ45/4Y2nIvhRVpCe.FSmR/cQF.iUFamQdki4.8/pK1gRgg7S',
    '2026-07-01 12:00:00+00',
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"name":"Alice Example"}'::jsonb,
    '2026-07-01 12:00:00+00',
    '2026-07-01 12:00:00+00'
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '20000000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'bob@example.test',
    '$2b$10$K7L1OJ45/4Y2nIvhRVpCe.FSmR/cQF.iUFamQdki4.8/pK1gRgg7S',
    '2026-07-01 12:00:00+00',
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"name":"Bob Example"}'::jsonb,
    '2026-07-01 12:00:00+00',
    '2026-07-01 12:00:00+00'
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '30000000-0000-4000-8000-000000000003',
    'authenticated',
    'authenticated',
    'carol@example.test',
    '$2b$10$K7L1OJ45/4Y2nIvhRVpCe.FSmR/cQF.iUFamQdki4.8/pK1gRgg7S',
    '2026-07-01 12:00:00+00',
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"name":"Carol Example"}'::jsonb,
    '2026-07-01 12:00:00+00',
    '2026-07-01 12:00:00+00'
  )
on conflict (id) do update set
  email = excluded.email,
  encrypted_password = excluded.encrypted_password,
  email_confirmed_at = excluded.email_confirmed_at,
  raw_app_meta_data = excluded.raw_app_meta_data,
  raw_user_meta_data = excluded.raw_user_meta_data,
  updated_at = excluded.updated_at;

insert into auth.identities (
  id,
  user_id,
  provider_id,
  identity_data,
  provider,
  last_sign_in_at,
  created_at,
  updated_at
)
values
  (
    '11000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'alice@example.test',
    '{"sub":"10000000-0000-4000-8000-000000000001","email":"alice@example.test","email_verified":true}'::jsonb,
    'email',
    '2026-07-01 12:00:00+00',
    '2026-07-01 12:00:00+00',
    '2026-07-01 12:00:00+00'
  ),
  (
    '22000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000002',
    'bob@example.test',
    '{"sub":"20000000-0000-4000-8000-000000000002","email":"bob@example.test","email_verified":true}'::jsonb,
    'email',
    '2026-07-01 12:00:00+00',
    '2026-07-01 12:00:00+00',
    '2026-07-01 12:00:00+00'
  ),
  (
    '33000000-0000-4000-8000-000000000003',
    '30000000-0000-4000-8000-000000000003',
    'carol@example.test',
    '{"sub":"30000000-0000-4000-8000-000000000003","email":"carol@example.test","email_verified":true}'::jsonb,
    'email',
    '2026-07-01 12:00:00+00',
    '2026-07-01 12:00:00+00',
    '2026-07-01 12:00:00+00'
  )
on conflict (provider_id, provider) do update set
  user_id = excluded.user_id,
  identity_data = excluded.identity_data,
  last_sign_in_at = excluded.last_sign_in_at,
  updated_at = excluded.updated_at;

insert into public.profiles (
  user_id,
  name,
  email,
  challenge_start_date,
  time_zone,
  created_at,
  updated_at
)
values
  ('10000000-0000-4000-8000-000000000001', 'Alice Example', 'alice@example.test', '2026-07-01', 'UTC', '2026-07-01 12:00:00+00', '2026-07-01 12:00:00+00'),
  ('20000000-0000-4000-8000-000000000002', 'Bob Example', 'bob@example.test', '2026-07-01', 'UTC', '2026-07-01 12:00:00+00', '2026-07-01 12:00:00+00'),
  ('30000000-0000-4000-8000-000000000003', 'Carol Example', 'carol@example.test', '2026-07-01', 'UTC', '2026-07-01 12:00:00+00', '2026-07-01 12:00:00+00')
on conflict (user_id) do update set
  name = excluded.name,
  email = excluded.email,
  challenge_start_date = excluded.challenge_start_date,
  time_zone = excluded.time_zone,
  updated_at = excluded.updated_at;

insert into public.entitlements (
  user_id,
  entitlement_key,
  status,
  source_type,
  source_id,
  starts_at,
  ends_at,
  metadata,
  created_at,
  updated_at
)
values
  ('10000000-0000-4000-8000-000000000001', 'membership_active', 'active', 'seed', 'seed-alice', '2026-07-01 12:00:00+00', '2099-01-01 00:00:00+00', '{"fixture":true}', '2026-07-01 12:00:00+00', '2026-07-01 12:00:00+00'),
  ('20000000-0000-4000-8000-000000000002', 'membership_active', 'active', 'seed', 'seed-bob', '2026-07-01 12:00:00+00', '2099-01-01 00:00:00+00', '{"fixture":true}', '2026-07-01 12:00:00+00', '2026-07-01 12:00:00+00'),
  ('30000000-0000-4000-8000-000000000003', 'membership_active', 'active', 'seed', 'seed-carol', '2026-07-01 12:00:00+00', '2099-01-01 00:00:00+00', '{"fixture":true}', '2026-07-01 12:00:00+00', '2026-07-01 12:00:00+00')
on conflict (user_id, entitlement_key) do update set
  status = excluded.status,
  source_type = excluded.source_type,
  source_id = excluded.source_id,
  starts_at = excluded.starts_at,
  ends_at = excluded.ends_at,
  metadata = excluded.metadata,
  updated_at = excluded.updated_at;

insert into public.crews (
  id,
  name,
  description,
  challenge_start_date,
  created_by,
  created_at,
  updated_at
)
values
  ('a0000000-0000-4000-8000-000000000001', 'Alpha Crew', 'Alice and Carol test crew', '2026-07-01', '10000000-0000-4000-8000-000000000001', '2026-07-01 12:00:00+00', '2026-07-01 12:00:00+00'),
  ('b0000000-0000-4000-8000-000000000002', 'Bravo Crew', 'Bob test crew', '2026-07-01', '20000000-0000-4000-8000-000000000002', '2026-07-01 12:00:00+00', '2026-07-01 12:00:00+00')
on conflict (id) do update set
  name = excluded.name,
  description = excluded.description,
  challenge_start_date = excluded.challenge_start_date,
  created_by = excluded.created_by,
  updated_at = excluded.updated_at;

insert into public.crew_members (
  crew_id,
  user_id,
  display_name,
  role,
  joined_at
)
values
  ('a0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Alice Example', 'owner', '2026-07-01 12:00:00+00'),
  ('a0000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000003', 'Carol Example', 'member', '2026-07-01 12:01:00+00'),
  ('b0000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 'Bob Example', 'owner', '2026-07-01 12:00:00+00')
on conflict (crew_id, user_id) do update set
  display_name = excluded.display_name,
  role = excluded.role,
  joined_at = excluded.joined_at;

insert into public.crew_invites (
  id,
  crew_id,
  token_hash,
  token_hint,
  created_by,
  expires_at,
  created_at
)
values
  ('a1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', encode(extensions.digest('seed-alpha-invite', 'sha256'), 'hex'), 'invite', '10000000-0000-4000-8000-000000000001', '2099-01-01 00:00:00+00', '2026-07-01 12:00:00+00'),
  ('b1000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002', encode(extensions.digest('seed-bravo-invite', 'sha256'), 'hex'), 'invite', '20000000-0000-4000-8000-000000000002', '2099-01-01 00:00:00+00', '2026-07-01 12:00:00+00')
on conflict (id) do update set
  crew_id = excluded.crew_id,
  token_hash = excluded.token_hash,
  token_hint = excluded.token_hint,
  created_by = excluded.created_by,
  expires_at = excluded.expires_at,
  revoked_at = null,
  redeemed_by = null,
  redeemed_at = null;

insert into public.community_posts (
  id,
  author_id,
  display_name,
  crew_id,
  scope,
  body,
  post_type,
  created_at,
  updated_at
)
values
  ('a2000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Alice Example', 'a0000000-0000-4000-8000-000000000001', 'crew', 'Alpha fixture post', 'message', '2026-07-01 12:00:00+00', '2026-07-01 12:00:00+00'),
  ('b2000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 'Bob Example', 'b0000000-0000-4000-8000-000000000002', 'crew', 'Bravo fixture post', 'message', '2026-07-01 12:00:00+00', '2026-07-01 12:00:00+00')
on conflict (id) do update set
  author_id = excluded.author_id,
  display_name = excluded.display_name,
  crew_id = excluded.crew_id,
  scope = excluded.scope,
  body = excluded.body,
  post_type = excluded.post_type,
  updated_at = excluded.updated_at;

insert into public.challenge_entries (
  user_id,
  entry_date,
  completed,
  scheduled_miss,
  created_at,
  updated_at
)
values
  ('10000000-0000-4000-8000-000000000001', '2026-07-01', array['bible'], false, '2026-07-01 12:00:00+00', '2026-07-01 12:00:00+00'),
  ('20000000-0000-4000-8000-000000000002', '2026-07-01', array['morningPrayer'], false, '2026-07-01 12:00:00+00', '2026-07-01 12:00:00+00')
on conflict (user_id, entry_date) do update set
  completed = excluded.completed,
  scheduled_miss = excluded.scheduled_miss,
  updated_at = excluded.updated_at;

insert into public.user_game_stats (
  user_id,
  total_points,
  challenge_points,
  updated_at
)
values
  ('10000000-0000-4000-8000-000000000001', 1200, 1200, '2026-07-01 12:00:00+00'),
  ('20000000-0000-4000-8000-000000000002', 400, 400, '2026-07-01 12:00:00+00'),
  ('30000000-0000-4000-8000-000000000003', 0, 0, '2026-07-01 12:00:00+00')
on conflict (user_id) do update set
  total_points = excluded.total_points,
  challenge_points = excluded.challenge_points,
  current_app_streak = 0,
  best_app_streak = 0,
  current_full_day_streak = 0,
  best_full_day_streak = 0,
  last_seen_date = null,
  last_full_day_date = null,
  updated_at = excluded.updated_at;

insert into public.game_point_events (
  id,
  user_id,
  event_type,
  points,
  entry_date,
  challenge_day,
  metadata,
  idempotency_key,
  created_at
)
values
  ('a3000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'seed', 1200, '2026-07-01', 1, '{"fixture":true}', 'seed:alice:points', '2026-07-01 12:00:00+00'),
  ('b3000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 'seed', 400, '2026-07-01', 1, '{"fixture":true}', 'seed:bob:points', '2026-07-01 12:00:00+00')
on conflict (idempotency_key) do update set
  user_id = excluded.user_id,
  event_type = excluded.event_type,
  points = excluded.points,
  entry_date = excluded.entry_date,
  challenge_day = excluded.challenge_day,
  metadata = excluded.metadata,
  created_at = excluded.created_at;

insert into public.user_badges (
  user_id,
  badge_key,
  earned_at,
  entry_date,
  metadata
)
values
  ('10000000-0000-4000-8000-000000000001', 'faithful_start', '2026-07-01 12:00:00+00', '2026-07-01', '{"fixture":true}'),
  ('20000000-0000-4000-8000-000000000002', 'honest_partial', '2026-07-02 12:00:00+00', '2026-07-02', '{"fixture":true}')
on conflict (user_id, badge_key) do update set
  earned_at = excluded.earned_at,
  entry_date = excluded.entry_date,
  metadata = excluded.metadata;

insert into public.user_challenge_states (
  user_id,
  challenge_key,
  status,
  unlock_points,
  unlocked_at,
  metadata,
  created_at,
  updated_at
)
values (
  '10000000-0000-4000-8000-000000000001',
  'seven_day_reset',
  'available',
  1000,
  '2026-07-01 12:00:00+00',
  '{"fixture":true}',
  '2026-07-01 12:00:00+00',
  '2026-07-01 12:00:00+00'
)
on conflict (user_id, challenge_key) do update set
  status = excluded.status,
  unlock_points = excluded.unlock_points,
  unlocked_at = excluded.unlocked_at,
  started_at = null,
  completed_at = null,
  celebration_seen_at = null,
  metadata = excluded.metadata,
  updated_at = excluded.updated_at;
