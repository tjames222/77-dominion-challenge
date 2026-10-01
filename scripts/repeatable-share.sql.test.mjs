import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createOriginal77FullchainFixture } from './fixtures/original77-fullchain-fixture.mjs';

const sourceUrl = new URL('../supabase/migrations/20261001001245_repeatable_challenge_instances_v2.sql', import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');
const q = value => `'${String(value).replaceAll("'", "''")}'`;
const publicFields = ['challengeKey', 'kind', 'schemaVersion', 'submittedCheckIns', 'targetCheckIns', 'title'];
const definitions = [
  ['original_77', '77-Day Dominion Challenge', 77], ['seven_day_reset', '7-Day Reset', 7],
  ['twenty_one_day_prayer', '21-Day Prayer Track', 21], ['thirty_day_strength', '30-Day Strength Intensive', 30],
  ['forty_day_fast', '40-Day Fasting & Prayer Track', 40], ['bible_in_a_year', 'Bible in a Year', 365],
];
let fixture, sourceHash;
const legacyActor = randomUUID();
const oldTokens = ['1'.repeat(64), '2'.repeat(64)];
const oldPayloads = [
  { schemaVersion: 1, kind: 'progress', currentChallengeDay: 12, challengeLength: 77, percentComplete: 15.6 },
  { schemaVersion: 2, kind: 'progress', submittedCheckIns: 12, targetCheckIns: 77 },
];
before(async () => {
  const source = await readFile(sourceUrl, 'utf8'); sourceHash = hash(source);
  fixture = await createOriginal77FullchainFixture({ through: 70 });
  fixture.queryAsBootstrap(`begin;set local session_replication_role=replica;
    insert into auth.users(id,email) values(${q(legacyActor)},'legacy-share@example.test');
    insert into public.profiles(user_id,name,email) values(${q(legacyActor)},'Synthetic','legacy-share@example.test');
    ${oldPayloads.map((payload, i) => `insert into public.public_share_snapshots(user_id,public_token_digest,snapshot_version,share_kind,snapshot_payload,expires_at)
      values(${q(legacyActor)},extensions.digest(${q(oldTokens[i])},'sha256'),${i + 1},'progress',${q(JSON.stringify(payload))},now()+interval '30 days');`).join('\n')}
    commit;`);
  fixture.query(`begin;set local check_function_bodies=on;set local search_path=public,extensions;${source}commit;`);
});
after(async () => {
  try { assert.equal(hash(await readFile(sourceUrl, 'utf8')), sourceHash, 'Migration changed during share verification.'); }
  finally { fixture?.close(); }
});
function actorSql(actor, statement) {
  return `begin;set local role authenticated;set local statement_timeout='8s';set local lock_timeout='5s';
    set local request.jwt.claim.sub=${q(actor)};set local request.jwt.claims=${q(JSON.stringify({ sub: actor, role: 'authenticated' }))};
    ${statement};commit;`;
}
const call = (actor, statement) => JSON.parse(fixture.queryAsBootstrap(actorSql(actor, statement)).split('\n').at(-1));
const publicRead = token => JSON.parse(fixture.queryAsBootstrap(`begin;set local role anon;
  select coalesce(public.get_public_share_snapshot(${q(token)}),'null'::jsonb);commit;`).split('\n').at(-1));
const preview = (actor, instance = null, kind = 'progress') => call(actor,
  `select public.preview_share_snapshot_v2(${q(kind)},${q(actor)},${instance ? q(instance) : 'null'})`);
const create = (actor, instance = null, kind = 'progress', expiry = 'null') => call(actor,
  `select public.create_share_snapshot_v2(${q(kind)},${expiry},${q(actor)},${instance ? q(instance) : 'null'})`);
function seed({ definition = definitions[0], submitted = 2, completed = false, review = false } = {}) {
  const [key, title, target] = definition;
  const actor = randomUUID(), instance = randomUUID();
  fixture.queryAsBootstrap(`begin;set local session_replication_role=replica;
    insert into auth.users(id,email) values(${q(actor)},${q(`${actor}@example.test`)});
    insert into public.profiles(user_id,name,email) values(${q(actor)},'Synthetic',${q(`${actor}@example.test`)});
    insert into private.challenge_instances(id,user_id,challenge_key,title,scope_key,sequence_no,status,start_date,time_zone,
      participation_mode,target_count,provenance,review_required)
      values(${q(instance)},${q(actor)},${q(key)},${q(title)},${q(`instance:${instance}`)},1,${q(completed ? 'completed' : 'active')},
        current_date-${target + 5},'UTC','solo',${target},${q(completed ? 'legacy_completed' : 'live')},${review});
    insert into private.challenge_runtime(user_id,current_instance_id) values(${q(actor)},${q(instance)});
    insert into public.check_ins(user_id,entry_date,challenge_day,status,completed_count,completed,points_awarded,challenge_instance_id)
      select ${q(actor)},current_date-${target + 5}+n,n+1,'partial',1,array['walk'],1,${q(instance)} from generate_series(0,${submitted - 1}) n;
    commit;`);
  return { actor, instance, key, title, target };
}

for (const definition of definitions) test(`${definition[0]} public progress includes exactly six fields and no private context`, () => {
  const { actor, instance, key, title, target } = seed({ definition });
  const expected = { schemaVersion: 3, kind: 'progress', challengeKey: key, title, submittedCheckIns: 2, targetCheckIns: target };
  const viewed = preview(actor);
  assert.deepEqual(viewed.payload, expected);
  assert.deepEqual(viewed.context, { schemaVersion: 2, actorId: actor, instanceId: instance });
  const created = create(actor, viewed.context.instanceId);
  assert.deepEqual(created.payload, viewed.payload);
  assert.match(created.token, /^[a-f0-9]{64}$/);
  const published = publicRead(created.token);
  assert.deepEqual(published.payload, expected);
  assert.deepEqual(Object.keys(published.payload).sort(), publicFields);
  assert.deepEqual(Object.keys(published).sort(), ['expiresAt', 'kind', 'payload', 'schemaVersion']);
  assert(!JSON.stringify(published).includes(actor)); assert(!JSON.stringify(published).includes(instance));
  assert.equal(fixture.query(`select encode(public_token_digest,'hex') from public.public_share_snapshots where id=${q(created.snapshotId)}`), hash(created.token));
  assert.equal(fixture.query(`select snapshot_payload ?| array['actorId','instanceId','email','journal','startDate'] from public.public_share_snapshots where id=${q(created.snapshotId)}`), 'f');
});

test('existing V1 and V2 public links retain their payload and meaning across migration', () => {
  for (let i = 0; i < oldTokens.length; i += 1) {
    const found = publicRead(oldTokens[i]);
    assert.equal(found.schemaVersion, i + 1); assert.deepEqual(found.payload, oldPayloads[i]);
  }
});

test('preview is non-publishing and requires exact owner; create requires captured current run', () => {
  const a = seed(), b = seed();
  preview(a.actor);
  assert.equal(fixture.query(`select count(*) from public.public_share_snapshots where user_id=${q(a.actor)}`), '0');
  assert.throws(() => call(a.actor, `select public.preview_share_snapshot_v2('progress',${q(b.actor)},null)`), /account changed/i);
  assert.throws(() => preview(a.actor, b.instance), /challenge changed/i);
  assert.throws(() => create(a.actor), /Reopen the share preview/i);
  assert.throws(() => create(a.actor, b.instance), /challenge changed/i);
  fixture.query(`update private.challenge_runtime set review_required=true,review_reason='synthetic_conflict' where user_id=${q(a.actor)}`);
  assert.throws(() => preview(a.actor), /challenge changed/i);
  assert.throws(() => create(a.actor, a.instance), /challenge changed/i);
  assert.equal(fixture.query(`select count(*) from public.public_share_snapshots where user_id=${q(a.actor)}`), '0');
});

test('retired creators fail closed and old/new private helpers are not browser executable', () => {
  const { actor } = seed();
  assert.throws(() => call(actor, "select public.preview_share_snapshot('progress')"), /Refresh to use/i);
  assert.throws(() => call(actor, "select public.create_share_snapshot('progress',null)"), /Refresh to use/i);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.equal(fixture.query(`select has_function_privilege(${q(role)},'private.instance_share_payload(uuid,text,uuid)','EXECUTE')`), 'f');
  }
  for (const fn of ['preview_share_snapshot_v2(text,uuid,uuid)', 'create_share_snapshot_v2(text,timestamptz,uuid,uuid)']) {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal(fixture.query(`select has_function_privilege(${q(role)},${q(`public.${fn}`)},'EXECUTE')`), role === 'authenticated' ? 't' : 'f');
    }
    assert.equal(fixture.query(`select proconfig@>array['search_path=""'] from pg_proc where oid=${q(`public.${fn}`)}::regprocedure`), 't');
  }
});

test('general and streak remain V1 payloads with no run identity and no point award on create', () => {
  const { actor, instance } = seed();
  for (const kind of ['general', 'streak']) {
    assert.throws(() => preview(actor, instance, kind), /Reopen the share preview/i);
    const value = create(actor, null, kind);
    assert.equal(value.schemaVersion, 1);
    assert.deepEqual(value.context, { schemaVersion: 2, actorId: actor, instanceId: null });
    assert(!JSON.stringify(publicRead(value.token)).includes(actor));
  }
  assert.equal(fixture.query(`select count(*) from public.game_point_events where user_id=${q(actor)}`), '0');
  assert.equal(fixture.query(`select count(*) from public.user_badges where user_id=${q(actor)}`), '0');
});

test('unknown historical completion counts and reviewed runs cannot publish invented progress', () => {
  const unknown = seed({ completed: true, submitted: 0 });
  assert.throws(() => preview(unknown.actor), /progress is unavailable/i);
  const reviewed = seed({ review: true });
  assert.throws(() => preview(reviewed.actor), /challenge changed/i);
  const complete = seed({ completed: true, submitted: 77 });
  assert.equal(preview(complete.actor).payload.submittedCheckIns, 77);
});

test('expiration bounds, per-hour cap, revocation and malformed public tokens stay enforced', () => {
  const { actor, instance } = seed();
  for (const expiry of ["'infinity'::timestamptz", "now()+interval '30 minutes'", "now()+interval '91 days'"]) {
    assert.throws(() => create(actor, instance, 'progress', expiry), /expiration must be/i);
  }
  let created;
  for (let i = 0; i < 10; i += 1) created = create(actor, instance);
  assert.throws(() => create(actor, instance), /rate limit/i);
  assert.equal(call(actor, `select to_jsonb(public.revoke_share_snapshot(${q(created.snapshotId)}))`), true);
  assert.equal(publicRead(created.token), null);
  for (const token of ['', 'g'.repeat(64), 'a'.repeat(63)]) assert.equal(publicRead(token), null);
});

test('V3 storage rejects extra private fields, malformed counts and mismatched version', () => {
  const { actor, instance } = seed(); const created = create(actor, instance);
  for (const payload of [
    { ...created.payload, actorId: actor }, { ...created.payload, title: null },
    { ...created.payload, submittedCheckIns: -1 }, { ...created.payload, submittedCheckIns: 78 },
    { ...created.payload, submittedCheckIns: '2' }, { ...created.payload, targetCheckIns: 0 },
    { ...created.payload, schemaVersion: 2 }, { ...created.payload, kind: 'general' },
    ...Object.keys(created.payload).map(key => ({ ...created.payload, [key]: null })),
    ...Object.keys(created.payload).map(key => {
      const missing = { ...created.payload }; delete missing[key]; return missing;
    }),
  ]) assert.throws(() => fixture.query(`begin;update public.public_share_snapshots set snapshot_payload=${q(JSON.stringify(payload))}
    where id=${q(created.snapshotId)};commit;`), /check constraint/i);
});
