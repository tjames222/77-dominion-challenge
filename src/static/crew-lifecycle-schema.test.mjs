import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migrationUrl = new URL('../../supabase/migrations/20260723071255_streamline_single_crew_lifecycle.sql', import.meta.url);
const schemaUrl = new URL('../../supabase/schema.sql', import.meta.url);
const migration = readFileSync(migrationUrl, 'utf8');
const schema = readFileSync(schemaUrl, 'utf8');

function functionBody(name) {
  const start = migration.indexOf(`create or replace function public.${name}`);
  assert.ok(start >= 0, `missing ${name} function`);
  const next = migration.indexOf('\ncreate or replace function public.', start + 1);
  return migration.slice(start, next >= 0 ? next : migration.length);
}

test('migration audits legacy multi-membership before enforcing one crew per user', () => {
  const audit = migration.indexOf('having count(*) > 1');
  const constraint = migration.indexOf('crew_members_one_crew_per_user_idx');
  assert.ok(audit >= 0 && constraint > audit);
  assert.match(migration, /No membership was deleted automatically/i);
  assert.match(migration, /unique index[\s\S]*crew_members \(user_id\)/i);
});

test('create and join serialize by user and reject a second crew server-side', () => {
  const createBody = functionBody('create_crew');
  const joinBody = functionBody('join_crew_by_invite');
  for (const body of [createBody, joinBody]) {
    assert.match(body, /pg_advisory_xact_lock/);
    assert.match(body, /crew_members/);
  }
  assert.match(createBody, /request ID was already used/i);
  assert.match(createBody, /Leave or delete your current crew before creating another/i);
  assert.match(joinBody, /Leave or delete your current crew before joining another/i);
  assert.match(migration, /revoke insert, delete on public\.crews from authenticated/);
  assert.match(migration, /revoke insert, update, delete on public\.crew_members from authenticated/);
});

test('crew deletion is retained, revokes access, and never hard-deletes the crew', () => {
  const body = functionBody('delete_crew');
  assert.match(body, /insert into public\.crew_lifecycle_events/);
  assert.match(body, /update public\.crew_invites[\s\S]*revoked_at/);
  assert.match(body, /update public\.crews[\s\S]*deleted_at/);
  assert.match(body, /delete from public\.crew_members/);
  assert.doesNotMatch(body, /delete\s+from\s+public\.crews/i);
  assert.doesNotMatch(body, /delete\s+from\s+public\.community_posts/i);
  assert.match(body, /to_regclass\('private\.integration_destinations'\)/);
  assert.match(body, /to_regclass\('private\.outbound_deliveries'\)/);
  assert.match(body, /status = 'cancelled'/);
});

test('deleted crews are excluded by membership helpers and crew RLS', () => {
  assert.match(functionBody('is_crew_member'), /c\.deleted_at is null/);
  assert.match(functionBody('can_manage_crew'), /c\.deleted_at is null/);
  assert.match(migration, /create policy "Crew members can read crews"[\s\S]*deleted_at is null/);
  assert.match(migration, /create policy "Crew admins can update crews"[\s\S]*deleted_at is null/);
});

test('delete and leave revalidate roles but remain available after entitlement lapse', () => {
  for (const name of ['delete_crew', 'leave_crew']) {
    const body = functionBody(name);
    assert.match(body, /for update/);
    assert.match(body, /membership_role/);
    assert.doesNotMatch(body, /has_active_entitlement/);
  }
  assert.match(migration, /lapsed subscriber must[\s\S]*remove their crew access/i);
});

test('training is versioned, creator-only, and RPC-only', () => {
  assert.match(migration, /create table if not exists public\.crew_training_progress/);
  assert.match(migration, /primary key \(crew_id, user_id, content_version\)/);
  assert.match(functionBody('get_crew_training_progress'), /c\.created_by = current_user_id/);
  assert.match(functionBody('save_crew_training_progress'), /c\.created_by = current_user_id/);
  assert.match(migration, /revoke all on public\.crew_training_progress from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.save_crew_training_progress[^;]+to authenticated/);
});

test('security-definer lifecycle functions use empty search paths and canonical schema mirrors migration', () => {
  for (const name of [
    'create_crew',
    'preview_crew_invite',
    'join_crew_by_invite',
    'delete_crew',
    'leave_crew',
    'get_crew_training_progress',
    'save_crew_training_progress',
  ]) {
    assert.match(functionBody(name), /security definer\s+set search_path = ''/i, `${name} must pin an empty search path`);
    const signaturePattern = new RegExp(`grant execute on function public\\.${name}\\([^;]+to authenticated`);
    assert.match(migration, signaturePattern, `${name} must be executable only through the authenticated RPC grant`);
  }
  assert.ok(schema.includes(migration.trim()), 'canonical schema must contain the deployable lifecycle migration');
});
