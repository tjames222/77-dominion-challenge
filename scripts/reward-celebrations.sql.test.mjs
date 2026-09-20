import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { DEFAULT_OWNERSHIP_REWARD_DEFINITIONS } from '../src/static/reward-catalog.mjs';
import { DEFAULT_CHALLENGE_DEFINITIONS } from '../src/static/challenge-progression.mjs';

// Deliberately cannot accept a database URL, port, or existing container name.
const container = `77dc-reward-celebrations-sql-${randomUUID()}`;
const image = 'public.ecr.aws/supabase/postgres:17.6.1.141';
const command = ['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', '/tmp', '-U', 'postgres', '-d', 'postgres'];
const docker = (args, input) => spawnSync('docker', args, { input, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
const parse = (text) => text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
const query = (sql) => { const result = docker(command, sql); assert.equal(result.status, 0, result.stderr || result.error?.message); return parse(result.stdout); };
const asyncQuery = (sql) => new Promise((resolve, reject) => {
  const child = spawn('docker', command); let output = ''; let errors = '';
  child.stdout.on('data', (data) => { output += data; }); child.stderr.on('data', (data) => { errors += data; });
  child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve(parse(output)) : reject(new Error(errors)));
  child.stdin.end(sql);
});
const migration = (name) => readFile(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8');
const extract = (source, name, type = 'function') => {
  const escaped = name.replaceAll('.', '\\.');
  const pattern = type === 'table' ? `create table if not exists ${escaped} \\([\\s\\S]*?\\n\\);`
    : `create (?:or replace )?function ${escaped}\\([\\s\\S]*?\\n\\$\\$;`;
  const result = source.match(new RegExp(pattern))?.[0]; assert.ok(result, `Missing ${type} ${name}`); return result;
};
const tokenA = '10000000-0000-4000-8000-000000000001';
const tokenB = '10000000-0000-4000-8000-000000000002';
const oldUser = '20000000-0000-4000-8000-000000000001';
const actor = (n) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const account = (id, points = 0) => `insert into auth.users(id) values('${id}'); insert into public.user_game_stats(user_id,total_points) values('${id}',${points});`;
const asActor = (id, sql) => `begin; set local role authenticated; set local request.jwt.claim.sub='${id}'; ${sql} commit;`;
const claim = (id, token = tokenA) => asActor(id, `select public.claim_reward_celebrations('${id}','${token}');`);
const ack = (id, keys, token = tokenA) => asActor(id, `select public.acknowledge_reward_celebrations('${id}','${token}',array[${keys.map((key) => `'${key}'`).join(',')}]::text[]);`);
const rejectSql = (sql, code) => `do $test$ begin begin ${sql} exception when sqlstate '${code}' then return; end; raise exception 'Expected ${code}'; end $test$;`;
let created = false;

before(async () => {
  const started = docker(['run', '--detach', '--name', container, '--network', 'none', '--user', 'postgres', '--tmpfs', '/tmp:rw', '--entrypoint', '/bin/sh', image, '-c',
    'initdb -D /tmp/reward-celebrations-pgdata -A trust && exec postgres -D /tmp/reward-celebrations-pgdata -k /tmp -h ""']);
  assert.equal(started.status, 0, started.stderr || started.error?.message); created = true;
  let ready = false;
  for (let i = 0; i < 100; i += 1) { if (docker(['exec', container, 'pg_isready', '-h', '/tmp', '-U', 'postgres']).status === 0) { ready = true; break; } await new Promise((resolve) => setTimeout(resolve, 100)); }
  assert.ok(ready);
  const [baseline, gaming, challenges, typed, launch, current] = await Promise.all([
    migration('20260707170000_baseline'), migration('20260708154000_gamification'), migration('20260715190000_challenge_unlock_progression'),
    migration('20260720210000_typed_reward_catalog'), migration('20260813192939_launch_reward_catalog_and_fulfillment'), migration('20260913035046_durable_reward_celebrations'),
  ]);
  const tables = [[baseline, 'public.entitlements'], [gaming, 'public.user_game_stats'], [gaming, 'public.game_point_events'],
    [challenges, 'public.challenge_definitions'], [challenges, 'public.user_challenge_states'], [typed, 'public.reward_catalog_meta'],
    [typed, 'public.reward_definitions'], [typed, 'public.user_reward_entitlements']].map(([source, name]) => extract(source, name, 'table')).join('\n');
  const functions = [[gaming, 'public.ensure_user_game_stats'], [launch, 'private.reward_eligible_points'],
    [launch, 'public.grant_reward_entitlement'], [launch, 'public.reconcile_user_reward_entitlements'], [launch, 'public.reward_catalog_item_for_user'],
    [typed, 'public.reward_catalog_for_user']].map(([source, name]) => extract(source, name)).join('\n');
  query(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create schema private;
    create table auth.users(id uuid primary key); create table public.crews(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to authenticated; ${tables} ${functions}
    insert into public.reward_catalog_meta(catalog_key) values('primary');`);
  const quote = (value) => value == null ? 'null' : `'${String(value).replaceAll("'", "''")}'`;
  const definitions = [...DEFAULT_OWNERSHIP_REWARD_DEFINITIONS, ...DEFAULT_CHALLENGE_DEFINITIONS.map((item) => ({
    ...item, rewardType: 'challenge', stateModel: 'challenge_lifecycle', fulfillmentKey: item.key,
    metadata: { durationDays: item.durationDays },
  }))];
  for (const item of definitions) {
    if (item.stateModel === 'challenge_lifecycle') query(`insert into public.challenge_definitions(challenge_key,title,points_required,duration_days) values(${quote(item.key)},${quote(item.title)},${item.pointsRequired},${item.metadata.durationDays});`);
    query(`insert into public.reward_definitions(reward_key,reward_type,state_model,title,points_required,fulfillment_key,challenge_key,required_entitlement_key,sort_order)
      values(${[item.key,item.rewardType,item.stateModel,item.title,item.pointsRequired,item.fulfillmentKey,item.stateModel === 'challenge_lifecycle' ? item.key : null,item.requiredEntitlementKey,item.sortOrder].map(quote).join(',')});`);
  }
  query(`${account(oldUser, 100)}
    insert into public.user_reward_entitlements(user_id,reward_key,owned_at,celebration_seen_at,metadata) values
      ('${oldUser}','dominion_night_theme','2026-08-01Z','2026-08-02Z','{"keep":true}'),
      ('${oldUser}','nehemiah_leadership_handbook','2026-08-01Z',null,'{"keep":true}');
    revoke all on function public.ensure_user_game_stats(uuid),public.reconcile_user_reward_entitlements(uuid,boolean),public.grant_reward_entitlement(uuid,text,text,text,boolean) from public,anon,authenticated;
    begin; ${current} commit;`);
});
after(() => { if (created) { const result = docker(['rm', '--force', container]); assert.equal(result.status, 0, result.stderr); } });

test('migration preserves owned timestamps, historical metadata and prior seen state', () => {
  const rows = query(`select row_to_json(e) from public.user_reward_entitlements e where user_id='${oldUser}' order by reward_key;`);
  assert.equal(rows[0].owned_at, '2026-08-01T00:00:00+00:00'); assert.ok(rows[0].celebration_seen_at); assert.deepEqual(rows[0].metadata, { keep: true });
  const [result] = query(claim(oldUser)); assert.deepEqual(result.claimedUnlocks.map((r) => r.key), ['nehemiah_leadership_handbook']);
  assert.equal(result.claimedUnlocks[0].celebrationMilestonePoints, null);
});
test('threshold minus one / exact produces authoritative ownership and original milestone', () => {
  const id = actor(1); query(account(id,55)); assert.deepEqual(query(claim(id))[0].claimedUnlocks, []);
  query(`update public.user_game_stats set total_points=56 where user_id='${id}';`);
  const [result] = query(claim(id)); assert.deepEqual(result.claimedUnlocks.map((r) => r.key), ['dominion_night_theme']);
  assert.equal(result.claimedUnlocks[0].celebrationMilestonePoints, 56);
  assert.equal(query(`select jsonb_build_object('seen',celebration_seen_at) from public.user_reward_entitlements where user_id='${id}';`)[0].seen, null);
});
test('same-token recovery, duplicate response, different-device exclusion and idempotent ack', () => {
  const id = actor(2); query(account(id,56)); const first = query(claim(id))[0];
  assert.deepEqual(query(claim(id))[0], first); assert.deepEqual(query(claim(id,tokenB))[0].claimedUnlocks, []);
  assert.deepEqual(query(ack(id,['dominion_night_theme'],tokenB))[0].acknowledgedKeys, []);
  assert.deepEqual(query(ack(id,['dominion_night_theme']))[0].acknowledgedKeys, ['dominion_night_theme']);
  assert.deepEqual(query(ack(id,['dominion_night_theme']))[0].acknowledgedKeys, ['dominion_night_theme']);
  assert.deepEqual(query(claim(id))[0].claimedUnlocks, []);
});
test('non-point ownership sources never invent a point milestone', () => {
  const id = actor(8); query(account(id,0));
  query(`insert into public.user_reward_entitlements(user_id,reward_key,source_type) values('${id}','dominion_night_theme','manual');`);
  assert.equal(query(claim(id))[0].claimedUnlocks[0].celebrationMilestonePoints, null);
});
test('expired interrupted delivery can transfer; old token cannot consume the new lease', () => {
  const id = actor(3); query(account(id,56)); query(claim(id));
  query(`update private.reward_celebration_claims set claimed_at=now()-interval '1 hour',lease_until=now()-interval '1 minute' where user_id='${id}';`);
  assert.equal(query(claim(id,tokenB))[0].claimedUnlocks.length, 1);
  assert.deepEqual(query(ack(id,['dominion_night_theme']))[0].acknowledgedKeys, []);
  assert.deepEqual(query(ack(id,['dominion_night_theme'],tokenB))[0].acknowledgedKeys, ['dominion_night_theme']);
});
test('legacy inline claimant cannot consume leased deliveries', () => {
  const id = actor(4); query(account(id,56)); query(claim(id));
  assert.deepEqual(query(asActor(id,`select public.claim_reward_entitlement_unlocks('${id}');`))[0].claimedKeys, []);
});
test('concurrent devices lease each reward to one token only', async () => {
  const id = actor(5); query(account(id,300));
  const results = await Promise.all([asyncQuery(claim(id,tokenA)), asyncQuery(claim(id,tokenB))]);
  const keys = results.flatMap((r) => r[0].claimedUnlocks.map((item) => item.key));
  assert.equal(keys.length, 4); assert.equal(new Set(keys).size, keys.length);
});
test('gym requires trusted Daily Standards events; challenge lifecycle never enters claim', () => {
  const id = actor(6); query(account(id,10000));
  assert.equal(query(claim(id))[0].claimedUnlocks.length, 4);
  query(`insert into public.game_point_events(user_id,event_type,points,idempotency_key) select '${id}','check_in',7,'check-'||n from generate_series(1,3)n;`);
  const rewards = query(claim(id))[0].claimedUnlocks;
  assert.equal(rewards.length, 5); assert.ok(rewards.every((r) => r.stateModel === 'ownership'));
  assert.equal(rewards.find((r) => r.key === 'gym_training_discount').celebrationMilestonePoints, 21);
});
test('actor guards, private table RLS/ACL, anonymous and service roles fail closed', () => {
  const id = actor(7); query(account(id));
  query(asActor(id,rejectSql(`perform public.claim_reward_celebrations('${oldUser}','${tokenA}');`,'42501')));
  query(asActor(id,rejectSql(`perform public.acknowledge_reward_celebrations('${oldUser}','${tokenA}',array['dominion_night_theme']);`,'42501')));
  query(asActor(id,rejectSql('perform * from private.reward_celebration_claims;','42501')));
  for (const role of ['anon','service_role']) query(`begin;set local role ${role};${rejectSql(`perform public.claim_reward_celebrations('${id}','${tokenA}');`,'42501')}commit;`);
  assert.equal(query("select to_json(relrowsecurity) from pg_class where oid='private.reward_celebration_claims'::regclass;")[0], true);
});
test('registered pgTAP delivery contract passes on the isolated migrated schema', async () => {
  query("create schema extensions; create schema supabase_migrations; create table supabase_migrations.schema_migrations(version text); insert into supabase_migrations.schema_migrations values('20260913035046');");
  const sql = await readFile(new URL('../supabase/tests/database/230_durable_reward_celebrations.sql', import.meta.url), 'utf8');
  const result = docker(command, sql);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /not ok|Looks like you failed|Bad plan/);
  assert.match(result.stdout, /1\.\.12/);
});
