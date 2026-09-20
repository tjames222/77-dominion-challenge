import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// An owned, network-isolated Postgres fixture. Never attaches to a Supabase
// project, resets a shared database, or touches another container.
test('actual scoped schema and RPC migration pass tied-cursor/privacy pgTAP regressions', async () => {
  const container = `77dc-member-badges-${randomUUID()}`;
  const docker = (args, input) => spawnSync('docker', args, {
    input, encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
  });
  const command = ['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', '/tmp', '-U', 'postgres', '-d', 'postgres'];
  const sql = (input) => {
    const result = docker(command, input);
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout;
  };
  const migration = (name) => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
  const started = docker(['run', '--detach', '--name', container, '--network', 'none', '--user', 'postgres',
    '--tmpfs', '/tmp:rw', '--entrypoint', '/bin/sh', 'public.ecr.aws/supabase/postgres:17.6.1.141', '-c',
    'initdb -D /tmp/member-badges-pg -A trust && exec postgres -D /tmp/member-badges-pg -k /tmp -h ""']);
  assert.equal(started.status, 0, started.stderr);
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (docker(['exec', container, 'pg_isready', '-h', '/tmp', '-U', 'postgres']).status === 0) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    sql(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create schema private; create schema extensions;
      grant usage on schema auth, extensions to public;
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create table auth.users(id uuid primary key,instance_id uuid,aud text,role text,email text,encrypted_password text,email_confirmed_at timestamptz,raw_app_meta_data jsonb,raw_user_meta_data jsonb,created_at timestamptz,updated_at timestamptz);
      create table public.profiles(user_id uuid primary key,name text,email text,time_zone text,avatar_url text);
      create table public.entitlements(user_id uuid,entitlement_key text,status text,source_type text,source_id text,starts_at timestamptz,ends_at timestamptz);
      create table public.crews(id uuid primary key,name text,created_by uuid,deleted_at timestamptz,deleted_by uuid);
      create table public.crew_members(crew_id uuid,user_id uuid,display_name text,role text,primary key(crew_id,user_id));
      create table public.user_game_stats(user_id uuid primary key,total_points integer,current_app_streak integer);
      create table public.game_point_events(user_id uuid,points integer,created_at timestamptz);
      create table public.check_ins(user_id uuid,challenge_day integer);
      create table private.retired_community_dr_quarantined_crews(crew_id uuid);
      create table public.badge_definitions(badge_key text primary key,name text,description text,category text,tier text,icon text,sort_order integer);
      create table public.user_badges(user_id uuid references auth.users,badge_key text references public.badge_definitions,earned_at timestamptz not null default now(),entry_date date,metadata jsonb not null default '{}',primary key(user_id,badge_key));
      alter table public.user_badges enable row level security;
      create policy own on public.user_badges for select to authenticated using(auth.uid()=user_id);
      grant select on public.user_badges to authenticated;
      insert into auth.users(id) values('90000000-0000-4000-8000-000000000001');
      insert into public.badge_definitions values('seven_sealed','Seven Sealed','Originally earned','challenge','gold','crown',90);
      insert into public.user_badges(user_id,badge_key,earned_at) values('90000000-0000-4000-8000-000000000001','seven_sealed','2026-01-07T12:00:00Z');`);
    const identityMigration = await migration('20260913033347_deterministic_badge_pipeline.sql');
    const identity = identityMigration.slice(identityMigration.indexOf('alter table public.user_badges'), identityMigration.indexOf('-- Browser roles'));
    assert.match(identity, /user_badges_scoped_unique/);
    sql(`begin; ${identity} commit;`);
    // The exact existing migration, not a fabricated legacy flag, captured gold.
    sql(`update public.badge_definitions set name='7-Day Perfect Streak',tier='silver',icon='repeat' where badge_key='seven_sealed';
      insert into public.profiles(user_id,name) values('90000000-0000-4000-8000-000000000001','Grandfathered member');
      insert into public.entitlements(user_id,entitlement_key,status) values('90000000-0000-4000-8000-000000000001','membership_active','active');
      insert into public.crews(id) values('90000000-0000-4000-8000-000000000002');
      insert into public.crew_members values('90000000-0000-4000-8000-000000000002','90000000-0000-4000-8000-000000000001','Member','owner');`);
    sql(await migration('20260805055359_crew_member_progress_profile.sql'));
    const baseline = await migration('20260707170000_baseline.sql');
    const membership = await migration('20260723211554_streamline_single_crew_lifecycle.sql');
    const leaderboard = await migration('20260716153000_community_profile_images.sql');
    sql(baseline.match(/create or replace function public\.has_active_entitlement\([\s\S]*?\n\$\$;/)[0]);
    sql(membership.match(/create or replace function public\.is_crew_member\([\s\S]*?\n\$\$;/)[0]);
    sql(leaderboard.match(/create function public\.get_crew_leaderboard\([\s\S]*?\n\$\$;/)[0]);
    sql('revoke all on function public.get_crew_leaderboard(uuid,text) from public,anon; grant execute on function public.get_crew_leaderboard(uuid,text) to authenticated;');
    const oldLeaderboardAcl = sql("select to_jsonb(proacl) from pg_proc where oid='public.get_crew_leaderboard(uuid,text)'::regprocedure;");
    // Reproduce the old reader against the real scoped identity before fixing it.
    sql(`insert into auth.users(id) values('10000000-0000-4000-8000-000000000001');
      insert into public.profiles(user_id,name) values('10000000-0000-4000-8000-000000000001','Member');
      insert into public.entitlements(user_id,entitlement_key,status) values('10000000-0000-4000-8000-000000000001','membership_active','active');
      insert into public.crews(id) values('20000000-0000-4000-8000-000000000001');
      insert into public.crew_members values('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Member','owner');
      insert into public.badge_definitions values('probe','Probe','Public','challenge','silver','shield',1);
      insert into public.user_badges(user_id,badge_key,scope_key,earned_at) values
        ('10000000-0000-4000-8000-000000000001','probe','lifetime','2026-01-07T12:00:00.123456Z'),
        ('10000000-0000-4000-8000-000000000001','probe','original77:2026-01-01','2026-01-07T12:00:00.123456Z');`);
    const readProbe = (args = '') => JSON.parse(sql(`set role authenticated;
      set request.jwt.claim.sub='10000000-0000-4000-8000-000000000001';
      select public.get_crew_member_progress_profile('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001'${args});`));
    const oldFirst = readProbe(',null,null,1');
    const oldNext = readProbe(`,'${oldFirst.nextCursor.earnedAt}','${oldFirst.nextCursor.badgeKey}',1`);
    assert.equal(oldFirst.badgeCount, 2);
    assert.equal(oldFirst.hasMore, true);
    assert.deepEqual(oldNext.badges, [], 'Old reader demonstrably loses the tied scoped row');
    const snapshot = sql('select to_jsonb(a) from public.user_badges a order by id;');
    sql(`begin; ${await migration('20260913072708_scoped_member_badge_pagination.sql')} commit;`);
    assert.equal(sql("select to_jsonb(proacl) from pg_proc where oid='public.get_crew_leaderboard(uuid,text)'::regprocedure;"), oldLeaderboardAcl, 'Leaderboard function replacement preserves its existing grants');
    assert.equal(sql('select to_jsonb(a) from public.user_badges a order by id;'), snapshot, 'Migration preserves existing award IDs and state');
    const first = readProbe(',null,null,1');
    const next = readProbe(`,'${first.nextCursor.earnedAt}','${first.nextCursor.badgeKey}',1,'${first.nextCursor.awardId}'`);
    assert.equal(next.badges.length, 1);
    assert.notEqual(next.badges[0].awardId, first.badges[0].awardId);
    const grandfathered = JSON.parse(sql(`set role authenticated; set request.jwt.claim.sub='90000000-0000-4000-8000-000000000001';
      select public.get_crew_member_progress_profile('90000000-0000-4000-8000-000000000002','90000000-0000-4000-8000-000000000001');`));
    assert.equal(grandfathered.badges[0].name, 'Seven Sealed');
    assert.equal(grandfathered.badges[0].tier, 'gold');
    const tap = sql(await readFile(new URL('../supabase/tests/database/260_scoped_member_badge_pagination.sql', import.meta.url), 'utf8'));
    assert.doesNotMatch(tap, /^not ok/m, tap);
    assert.match(tap, /1\.\.40/);
    assert.equal((tap.match(/^ok \d+/gm) || []).length, 40, tap);
  } finally {
    const stopped = docker(['rm', '--force', container]);
    assert.equal(stopped.status, 0, stopped.stderr);
  }
});
