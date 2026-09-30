import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';

// Isolated transport/privacy fixture, not a substitute for the real progress
// authority and full migration-chain tests. No hosted endpoint or credentials.
const container = `77dc-share-progress-v2-${randomUUID()}`;
const actor = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const image = 'public.ecr.aws/supabase/postgres:17.6.1.141';
let created = false;
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
function docker(args, input) {
  return spawnSync('docker', args, { input, encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
}
function query(sql) {
  const result = docker(['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
    '-h', '/tmp', '-U', 'postgres', '-d', 'postgres'], sql);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
const progress = (submittedCount = 0, completionState = 'in_progress') => ({
  schemaVersion: 1, userId: actor, instanceId: 'original77:2026-01-01', targetCount: 77,
  submittedCount, completionState, canonicalEvent: null,
});
function setProgress(value) {
  query(`update private.synthetic_progress set value=${literal(JSON.stringify(value))}::jsonb where user_id='${actor}';`);
}
function asActor(sql, userId = actor) {
  return query(`begin; set local role authenticated;
    set local "request.jwt.claim.sub"=${literal(userId)}; ${sql} commit;`);
}
function refuses(sql, state = 'P0001', userId = actor) {
  query(`begin; set local role authenticated;
    set local "request.jwt.claim.sub"=${literal(userId)};
    do $test$ begin begin ${sql}; exception when sqlstate '${state}' then return; end;
      raise exception 'expected refusal'; end $test$; rollback;`);
}

before(async () => {
  const legacy = await readFile(new URL('../supabase/migrations/20260720230000_public_share_snapshots.sql', import.meta.url), 'utf8');
  const candidate = await readFile(new URL('../supabase/migrations/20260930161218_share_submitted_progress_v2.sql', import.meta.url), 'utf8');
  const started = docker(['run', '--pull', 'never', '--detach', '--name', container,
    '--network', 'none', '--user', 'postgres', '--tmpfs', '/tmp:rw', '--entrypoint', '/bin/sh', image, '-c',
    'initdb -D /tmp/share-progress-pgdata -A trust && exec postgres -D /tmp/share-progress-pgdata -k /tmp -h ""']);
  assert.equal(started.status, 0, started.stderr || started.error?.message);
  created = true;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (docker(['exec', container, 'pg_isready', '-h', '/tmp', '-U', 'postgres']).status === 0) { ready = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'isolated PostgreSQL did not become ready');
  query(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema private; create schema extensions;
    create extension pgcrypto with schema extensions;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to authenticated;
    create table public.profiles(user_id uuid primary key references auth.users(id), challenge_start_date date);
    create table public.user_game_stats(user_id uuid primary key, current_app_streak integer, current_full_day_streak integer);
    create table public.check_ins(user_id uuid, challenge_day integer);
    create table private.synthetic_progress(user_id uuid primary key, value jsonb);
    create function private.original_77_progress_for_user(target_user_id uuid, target_start date)
      returns jsonb language sql stable security invoker set search_path='' as
      $$ select value from private.synthetic_progress where user_id=target_user_id $$;
    revoke all on function private.original_77_progress_for_user(uuid,date) from public,anon,authenticated,service_role;
    begin; ${legacy} ${candidate} commit;`);
});
beforeEach(() => {
  query(`truncate public.public_share_snapshots,public.profiles,public.user_game_stats,public.check_ins,private.synthetic_progress,auth.users cascade;
    insert into auth.users values ('${actor}'),('${other}');
    insert into public.profiles values ('${actor}','2026-01-01'),('${other}','2026-01-01');
    insert into public.user_game_stats values ('${actor}',12,5),('${other}',0,0);
    insert into private.synthetic_progress values
      ('${actor}',${literal(JSON.stringify(progress()))}::jsonb),
      ('${other}',${literal(JSON.stringify({ ...progress(), userId: other }))}::jsonb);`);
});
after(() => {
  if (created) { const removed = docker(['rm', '--force', container]); assert.equal(removed.status, 0, removed.stderr); }
});

test('new progress snapshots disclose only submitted counts, not calendar or owner evidence', () => {
  for (const [count, state] of [[0, 'in_progress'], [76, 'in_progress'], [77, 'historical_provenance_pending'], [77, 'live_completed']]) {
    setProgress({ ...progress(count, state), canonicalEvent: state === 'live_completed'
      ? { id: randomUUID(), sourceId: randomUUID(), privateMarker: 'never-public' } : null });
    const result = asActor("select public.preview_share_snapshot('progress');")[0];
    assert.equal(result.schemaVersion, 2);
    assert.deepEqual(result.payload, { schemaVersion: 2, kind: 'progress', submittedCheckIns: count, targetCheckIns: 77 });
    assert.doesNotMatch(JSON.stringify(result), /userId|instanceId|canonicalEvent|sourceId|privateMarker|currentChallengeDay|percentComplete/);
  }
});

test('invalid progress fails closed before storing a share or returning a coerced count', () => {
  for (const value of [null, {}, progress(null, 'invalid_evidence'), progress(77), progress(78),
    progress(-1), progress(1.2), progress('7'), progress(76, 'live_completed'),
    { ...progress(), userId: other }, { ...progress(), instanceId: 'original77:2026-01-02' },
    { ...progress(), targetCount: 78 }, { ...progress(), schemaVersion: 2 },
    { ...progress(), targetCount: '77' }, { ...progress(), schemaVersion: '1' }]) {
    setProgress(value);
    refuses("perform public.preview_share_snapshot('progress')");
    refuses("perform public.create_share_snapshot('progress')");
  }
  assert.equal(query('select to_jsonb(count(*)) from public.public_share_snapshots;')[0], 0);
  setProgress(progress());
  query(`update public.profiles set challenge_start_date=null where user_id='${actor}';`);
  refuses("perform public.preview_share_snapshot('progress')");
});

test('V2 creation and public reads retain immutable counts and the existing token boundary', () => {
  setProgress(progress(76));
  const created = asActor("select public.create_share_snapshot('progress');")[0];
  assert.equal(created.schemaVersion, 2);
  assert.match(created.token, /^[0-9a-f]{64}$/);
  setProgress(progress(77, 'historical_provenance_pending'));
  const publicView = query(`set role anon; select public.get_public_share_snapshot(${literal(created.token)}); reset role;`)[0];
  assert.equal(publicView.schemaVersion, 2);
  assert.equal(publicView.payload.submittedCheckIns, 76);
  assert.deepEqual(Object.keys(publicView).sort(), ['expiresAt', 'kind', 'payload', 'schemaVersion']);
  const stored = query(`select jsonb_build_object('version',snapshot_version,'rawTokenStored',
    encode(public_token_digest,'hex')=${literal(created.token)}) from public.public_share_snapshots;`)[0];
  assert.deepEqual(stored, { version: 2, rawTokenStored: false });
  assert.equal(asActor(`select to_jsonb(public.revoke_share_snapshot(${literal(created.snapshotId)}::uuid));`, other)[0], false);
  assert.equal(asActor(`select to_jsonb(public.revoke_share_snapshot(${literal(created.snapshotId)}::uuid));`)[0], true);
  assert.equal(query(`select coalesce(public.get_public_share_snapshot(${literal(created.token)}),'null'::jsonb);`)[0], null);
});

test('stored V1 progress and new streak/general snapshots keep their existing interpretation', () => {
  const token = 'a'.repeat(64);
  const payload = { schemaVersion: 1, kind: 'progress', currentChallengeDay: 77, challengeLength: 77, percentComplete: 100 };
  query(`insert into public.public_share_snapshots(user_id,public_token_digest,snapshot_version,share_kind,snapshot_payload,expires_at)
    values ('${actor}',extensions.digest(${literal(token)},'sha256'),1,'progress',${literal(JSON.stringify(payload))}::jsonb,now()+interval '30 days');`);
  const result = query(`select public.get_public_share_snapshot(${literal(token)});`)[0];
  assert.equal(result.schemaVersion, 1); assert.deepEqual(result.payload, payload);
  assert.deepEqual(asActor("select public.preview_share_snapshot('streak');")[0].payload,
    { schemaVersion: 1, kind: 'streak', appStreak: 12, fullStandardStreak: 5 });
  assert.deepEqual(asActor("select public.create_share_snapshot('general');")[0].payload,
    { schemaVersion: 1, kind: 'general', challengeLength: 77, dailyStandards: 7 });
});

test('browser roles cannot call the builder or enumerate snapshots, and identities stay isolated', () => {
  refuses(`perform public.build_share_snapshot_payload('${other}','progress')`, '42501');
  refuses('perform * from public.public_share_snapshots', '42501');
  refuses("perform public.preview_share_snapshot('progress')", '42501', '');
  setProgress(progress(76));
  assert.equal(asActor("select public.preview_share_snapshot('progress');", other)[0].payload.submittedCheckIns, 0);
});

test('expiration bounds and per-owner creation limits are retained', () => {
  refuses("perform public.create_share_snapshot('progress',now()+interval '91 days')");
  refuses("perform public.create_share_snapshot('progress',now()+interval '1 minute')");
  asActor("do $$ begin for i in 1..10 loop perform public.create_share_snapshot('progress'); end loop; end $$;");
  refuses("perform public.create_share_snapshot('progress')");
  assert.equal(query(`select to_jsonb(count(*)) from public.public_share_snapshots where user_id='${actor}';`)[0], 10);
});
