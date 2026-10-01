import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { createOriginal77FullchainFixture } from './fixtures/original77-fullchain-fixture.mjs';

const A = '10000000-0000-4000-8000-000000000001';
const B = '10000000-0000-4000-8000-000000000002';
const C = '10000000-0000-4000-8000-000000000003';
const D = '10000000-0000-4000-8000-000000000004';
const E = '10000000-0000-4000-8000-000000000005';
const F = '10000000-0000-4000-8000-000000000006';
const G = '10000000-0000-4000-8000-000000000007';
let fixture;

const literal = value => value === null ? 'null' : `'${String(value).replaceAll("'", "''")}'`;

function actorSql(actor, sql) {
  const claims = JSON.stringify({ sub: actor, email: `${actor}@example.test`, role: 'authenticated' });
  return `begin;
    set local role authenticated;
    set local request.jwt.claim.sub=${literal(actor)};
    set local request.jwt.claims=${literal(claims)};
    ${sql}
    commit;`;
}

function call(actor, zone = 'UTC', date = null) {
  return `public.get_daily_action_bootstrap(${literal(actor)}::uuid,${literal(zone)},${date === null ? 'null' : `${literal(date)}::date`})`;
}

function read(actor, zone = 'UTC', date = null) {
  return JSON.parse(fixture.queryAsBootstrap(actorSql(actor, `select ${call(actor, zone, date)};`)));
}

function expectActorState(actor, state, statement) {
  fixture.queryAsBootstrap(actorSql(actor, `do $assert$
    begin
      begin
        ${statement};
      exception when sqlstate '${state}' then return;
      end;
      raise exception 'Expected SQLSTATE ${state}';
    end $assert$;`));
}

function setupActor(actor, { entitlement = true, profile = true } = {}) {
  const email = `${actor}@example.test`;
  fixture.queryAsBootstrap(`
    insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data,created_at,updated_at)
    values(${literal(actor)}::uuid,${literal(email)},pg_catalog.now(),'{}'::jsonb,pg_catalog.now(),pg_catalog.now());
    insert into public.profiles(user_id,name,email,time_zone)
    values(${literal(actor)}::uuid,'Daily member',${literal(email)},null)
    on conflict(user_id) do update set name=excluded.name,email=excluded.email,time_zone=null;
    ${entitlement ? `insert into public.entitlements(
      user_id,entitlement_key,status,source_type,source_id,starts_at,ends_at
    ) values(
      ${literal(actor)}::uuid,'membership_active','active','test','daily-bootstrap-fullchain',
      pg_catalog.now()-interval '1 day',pg_catalog.now()+interval '1 day'
    ) on conflict(user_id,entitlement_key) do update set
      status='active',starts_at=excluded.starts_at,ends_at=excluded.ends_at;` : ''}
    ${profile ? '' : `delete from public.profiles where user_id=${literal(actor)}::uuid;`}
  `);
}

function setActivation(actor, {
  status = 'active',
  startDateExpression = 'current_date',
  zone = 'UTC',
  revision = 0,
} = {}) {
  fixture.queryAsBootstrap(`update public.profiles set
    challenge_activation_status=${literal(status)},
    challenge_participation_mode='solo',
    challenge_start_date=${startDateExpression},
    challenge_activation_time_zone=${literal(zone)},
    challenge_group_attribution_crew_id=null,
    challenge_activated_at=case when ${literal(status)}='active' then pg_catalog.now() else null end,
    challenge_confirmed_at=pg_catalog.now(),
    challenge_activated_by=case when ${literal(status)}='active' then ${literal(actor)}::uuid else null end,
    challenge_confirmed_by=${literal(actor)}::uuid,
    challenge_activation_schema_version=1,
    challenge_activation_revision=${revision},
    challenge_activation_review_required=false,
    challenge_activation_updated_at=pg_catalog.now()
  where user_id=${literal(actor)}::uuid;`);
}

async function waitForSql(predicate) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (JSON.parse(fixture.queryAsBootstrap(`select pg_catalog.to_jsonb(${predicate});`))) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('The owned full-chain fixture did not acquire its expected lock.');
}

before(async () => {
  // Byte-identical protected-release 27201cd3f244cc35c93f561143c5de99003b23c4
  // 280_daily_action_bootstrap.sql. Current V2/71 coverage remains in the
  // unchanged latest-schema-pgtap.sql.test.mjs runner, not this V1/70 proof.
  const pgTap = await readFile(new URL('./fixtures/original77-daily-bootstrap-exact70.pgtap.sql', import.meta.url), 'utf8');
  assert.equal(createHash('sha256').update(pgTap).digest('hex'),
    '9ca6d4fa4c344111eedaf71193d1138b25a1d2a487da1720069c6f6851409e0b',
    'The protected-release exact70 Daily Action fixture changed.');
  fixture = await createOriginal77FullchainFixture({ through: 70 });
  assert.equal(fixture.history.length, 70);
  assert.equal(fixture.history.at(-1).version, '20260930161218');
  assert.equal(fixture.query("select to_regclass('private.challenge_instances') is null;"), 't',
    'The historical Daily Action proof must not import migration71 instance state.');
  fixture.queryAsBootstrap(`create extension if not exists pgtap with schema extensions;
    grant usage on schema extensions to anon,authenticated;
    -- The structural provider fixture stores the subject in a dedicated GUC,
    -- while pgTAP intentionally supplies the real gateway claims document.
    -- Adapt only that provider primitive; application functions stay final70.
    create or replace function auth.uid() returns uuid
      language sql stable security invoker set search_path=''
      as $$select coalesce(
        nullif(pg_catalog.current_setting('request.jwt.claim.sub',true),''),
        nullif(pg_catalog.current_setting('request.jwt.claims',true),'')::jsonb->>'sub'
      )::uuid$$;`);
  const output = fixture.queryAsBootstrap(pgTap);
  assert.doesNotMatch(output, /^not ok\b|^Bail out!|^# Looks like/m, output);
  assert.match(output, /^1\.\.24$/m, 'The complete Daily Action pgTAP plan must run against all 70 migrations.');
  assert.equal(output.split('\n').filter(line => /^ok \d+\b/.test(line)).length, 24, output);
});

after(() => fixture?.close());

test('final-chain SQL preserves actor, access, privacy, parameter and deleted-user boundaries', () => {
  setupActor(A, { entitlement: false });
  setupActor(B, { entitlement: false });
  expectActorState(A, '40001', `perform ${call(B)}`);
  expectActorState(A, '40001', 'perform public.get_daily_action_bootstrap(null,\'UTC\',null)');

  const value = read(A);
  assert.equal(value.appAccess, false);
  assert.equal(value.draft, null);
  assert.equal(value.activation, null);
  assert.equal(fixture.query(`select coalesce(pg_catalog.to_jsonb(time_zone),'null'::jsonb)
    from public.profiles where user_id=${literal(A)}::uuid;`), 'null');

  expectActorState(A, '22023', `perform ${call(A, 'Bogus/Zone')}`);
  expectActorState(A, '22023', `perform ${call(A, 'UTC', 'infinity')}`);
  fixture.queryAsBootstrap(`delete from auth.users where id=${literal(A)}::uuid;`);
  expectActorState(A, '28000', `perform ${call(A)}`);
  fixture.queryAsBootstrap(`begin;set local role anon;
    do $assert$ begin
      begin perform public.get_daily_action_bootstrap(${literal(B)}::uuid,'UTC',null);
      exception when sqlstate '42501' then return; end;
      raise exception 'Expected SQLSTATE 42501';
    end $assert$;rollback;`);
});

test('existing timezone wins; missing profile/timezone initialize without starting a challenge', () => {
  setupActor(C, { profile: false });
  const value = read(C, 'Pacific/Kiritimati');
  assert.equal(value.appAccess, true);
  assert.equal(value.activation.status, 'not_started');
  assert.equal(value.activation.originalProgress, null);
  assert.equal(value.draft.locked, true);
  assert.equal(value.timeZone, 'Pacific/Kiritimati');
  assert.equal(read(C, 'America/Los_Angeles').timeZone, 'Pacific/Kiritimati');
});

test('same server instant gives canonical dates in the activation zone, never the browser zone', () => {
  setupActor(D);
  const westDate = fixture.query("select (pg_catalog.statement_timestamp() at time zone 'America/Los_Angeles')::date;");
  setActivation(D, { startDateExpression: literal(westDate), zone: 'America/Los_Angeles' });
  const west = read(D, 'Pacific/Kiritimati');
  assert.equal(west.entryDate, westDate);
  assert.equal(west.timeZone, 'America/Los_Angeles');
  assert.equal(west.activation.originalProgress.submittedCount, 0);
  assert.equal(west.activation.originalProgress.completionState, 'in_progress');

  const eastDate = fixture.query("select (pg_catalog.statement_timestamp() at time zone 'Pacific/Kiritimati')::date;");
  setActivation(D, { startDateExpression: literal(eastDate), zone: 'Pacific/Kiritimati' });
  assert.equal(read(D, 'America/Los_Angeles').entryDate, eastDate);
});

test('IANA zones, including a DST zone, keep the canonical server-selected daily boundary', () => {
  for (const [actor, zone] of [[E, 'America/Los_Angeles'], [F, 'Pacific/Kiritimati']]) {
    setupActor(actor);
    const expected = fixture.query(`select (pg_catalog.statement_timestamp() at time zone ${literal(zone)})::date;`);
    setActivation(actor, { startDateExpression: literal(expected), zone });
    const value = read(actor, 'UTC');
    assert.equal(value.entryDate, expected);
    assert.equal(value.activation.timeZone, zone);
    assert.equal(value.activation.originalProgress.instanceId, `original77:${expected}`);
  }
});

test('future schedule remains locked; due promotion persists only once across concurrent reads', async () => {
  setupActor(G);
  setActivation(G, { status: 'scheduled', startDateExpression: 'current_date+1', zone: 'UTC' });
  assert.equal(read(G).activation.status, 'scheduled');
  assert.equal(read(G).draft.lock_reason, 'challenge_not_active');
  fixture.queryAsBootstrap(`update public.profiles set challenge_start_date=current_date
    where user_id=${literal(G)}::uuid;`);
  const statements = Array.from({ length: 4 }, () => fixture.queryAsBootstrapAsync(actorSql(G, `select ${call(G)};`)));
  const results = await Promise.all(statements);
  for (const result of results) {
    const value = JSON.parse(result);
    assert.equal(value.activation.storedStatus, 'active');
    assert.equal(value.activation.revision, 1);
    assert.equal(value.activation.originalProgress.submittedCount, 0);
    assert.equal(value.draft.locked, false);
  }
  assert.equal(fixture.query(`select challenge_activation_revision from public.profiles
    where user_id=${literal(G)}::uuid;`), '1');
});

test('only the requested actor/date draft is returned, including submitted and 77-submission completion locks', () => {
  const owner = '10000000-0000-4000-8000-000000000008';
  const other = '10000000-0000-4000-8000-000000000009';
  setupActor(owner); setupActor(other);
  setActivation(owner); setActivation(other);
  fixture.queryAsBootstrap(`insert into public.challenge_entries(user_id,entry_date,completed,version)
    values(${literal(owner)}::uuid,current_date,array['bible'],7),
      (${literal(other)}::uuid,current_date,array['PRIVATE_SENTINEL'],99);`);
  let value = read(owner);
  assert.deepEqual(value.draft.completed, ['bible']);
  assert.equal(value.draft.version, 7);
  assert.equal(value.draft.activation_status, 'active');
  assert.equal(value.draft.lock_reason, null);
  assert.equal(value.activation.originalProgress.submittedCount, 0);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_SENTINEL|stats|badges|history|feed/);

  fixture.queryAsBootstrap(`set session_replication_role=replica;
    insert into public.check_ins(id,user_id,entry_date,challenge_day,status,completed_count,completed,workout_difficulty,points_awarded,created_at)
    values(extensions.gen_random_uuid(),${literal(owner)}::uuid,current_date,1,'partial',1,array['bible'],'{}'::jsonb,1,pg_catalog.now());
    set session_replication_role=origin;`);
  assert.equal(read(owner).draft.lock_reason, 'submitted');
  assert.equal(read(owner, 'UTC', fixture.query('select current_date-1;')).draft.lock_reason, 'date_locked');

  fixture.queryAsBootstrap(`set session_replication_role=replica;
    delete from public.check_ins where user_id=${literal(owner)}::uuid;
    update public.profiles set challenge_start_date=current_date-77
      where user_id=${literal(owner)}::uuid;
    insert into public.check_ins(id,user_id,entry_date,challenge_day,status,completed_count,completed,workout_difficulty,points_awarded,created_at)
    select extensions.gen_random_uuid(),${literal(owner)}::uuid,current_date-77+(ordinal-1),ordinal,
      'partial',1,array['walk']::text[],'{}'::jsonb,1,
      (current_date-77+(ordinal-1))::timestamp at time zone 'UTC'+interval '12 hours'
    from pg_catalog.generate_series(1,77) ordinal;
    set session_replication_role=origin;`);
  value = read(owner);
  assert.equal(value.draft.lock_reason, 'challenge_complete');
  assert.equal(value.activation.originalProgress.submittedCount, 77);
  assert.equal(value.activation.originalProgress.completionState, 'historical_provenance_pending');
  assert.equal(value.activation.originalProgress.canonicalEvent, null);
});

test('bootstrap follows activation advisory locks and serializes safely with account erasure', async () => {
  const actor = '10000000-0000-4000-8000-000000000010';
  setupActor(actor); setActivation(actor);
  const lockName = `daily-bootstrap-advisory-${actor}`;
  const blocker = fixture.queryAsync(`begin;set local application_name=${literal(lockName)};
    select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${literal(`single-crew:${actor}`)},821));
    select pg_catalog.pg_sleep(1);commit;`);
  await waitForSql(`exists(select 1 from pg_catalog.pg_stat_activity
    where application_name=${literal(lockName)} and wait_event='PgSleep')`);
  const blocked = await fixture.queryAsBootstrapAsync(actorSql(actor, `set local lock_timeout='100ms';select ${call(actor)};`))
    .then(() => null, error => error);
  assert(blocked instanceof Error);
  assert.match(blocked.message, /lock timeout/);
  await blocker;

  const deleteName = `daily-bootstrap-delete-${actor}`;
  const deletion = fixture.queryAsBootstrapAsync(`begin;set local application_name=${literal(deleteName)};
    select id from auth.users where id=${literal(actor)}::uuid for update;
    select pg_catalog.pg_sleep(1);
    delete from auth.users where id=${literal(actor)}::uuid;commit;`);
  await waitForSql(`exists(select 1 from pg_catalog.pg_stat_activity
    where application_name=${literal(deleteName)} and wait_event='PgSleep')`);
  const deletedRead = await fixture.queryAsBootstrapAsync(actorSql(actor, `set local lock_timeout='2s';select ${call(actor)};`))
    .then(() => null, error => error);
  await deletion;
  assert(deletedRead instanceof Error);
  assert.match(deletedRead.message, /no longer exists/);
  assert.doesNotMatch(deletedRead.message, /deadlock/);
});

test('final function bodies preserve exact midnight and DST boundaries under a fixture-only clock', () => {
  const west = '10000000-0000-4000-8000-000000000011';
  const east = '10000000-0000-4000-8000-000000000012';
  setupActor(west); setupActor(east);
  fixture.queryAsBootstrap(`
    create table private.daily_bootstrap_test_clock(value timestamptz not null);
    insert into private.daily_bootstrap_test_clock values('2026-09-13T00:30:00Z');
    create function private.daily_fixture_now() returns timestamptz
      language sql stable security invoker set search_path=''
      as $$select value from private.daily_bootstrap_test_clock$$;
    revoke all on private.daily_bootstrap_test_clock from public,anon,authenticated,service_role;
    revoke all on function private.daily_fixture_now() from public,anon,authenticated,service_role;
    grant select on private.daily_bootstrap_test_clock to postgres;
    grant execute on function private.daily_fixture_now() to postgres;
    do $replace$
    declare
      target regprocedure;
      definition text;
    begin
      foreach target in array array[
        'public.challenge_activation_user_date(uuid)'::regprocedure,
        'public.daily_standard_user_date(uuid)'::regprocedure,
        'public.get_challenge_activation(uuid)'::regprocedure,
        'public.challenge_activation_payload_for_user(uuid)'::regprocedure,
        'private.daily_action_bootstrap(uuid,text,date)'::regprocedure
      ] loop
        select pg_catalog.pg_get_functiondef(target) into definition;
        if pg_catalog.strpos(definition,'pg_catalog.statement_timestamp()')=0 then
          raise exception 'Final function % has no authoritative clock call.',target;
        end if;
        definition:=pg_catalog.replace(
          definition,'pg_catalog.statement_timestamp()','private.daily_fixture_now()'
        );
        execute definition;
      end loop;
    end $replace$;
    update public.entitlements set starts_at='2000-01-01',ends_at='2100-01-01'
      where user_id=any(array[${literal(west)}::uuid,${literal(east)}::uuid]);
  `);

  setActivation(west, { startDateExpression: "date '2026-09-12'", zone: 'America/Los_Angeles' });
  setActivation(east, { startDateExpression: "date '2026-09-13'", zone: 'Pacific/Kiritimati' });
  let westRead = read(west, 'Pacific/Kiritimati');
  let eastRead = read(east, 'America/Los_Angeles');
  assert.equal(westRead.asOf, '2026-09-13T00:30:00+00:00');
  assert.equal(eastRead.asOf, '2026-09-13T00:30:00+00:00');
  assert.equal(westRead.entryDate, '2026-09-12');
  assert.equal(eastRead.entryDate, '2026-09-13');
  assert.equal(westRead.activation.originalProgress.instanceId, 'original77:2026-09-12');
  assert.equal(eastRead.activation.originalProgress.instanceId, 'original77:2026-09-13');

  setActivation(west, { startDateExpression: "date '2026-03-08'", zone: 'America/Los_Angeles' });
  for (const instant of ['2026-03-08T09:59:59Z', '2026-03-08T10:00:00Z']) {
    fixture.queryAsBootstrap(`update private.daily_bootstrap_test_clock set value=${literal(instant)};`);
    westRead = read(west);
    assert.equal(westRead.entryDate, '2026-03-08');
    assert.equal(westRead.activation.challengeDay, 1);
    assert.equal(westRead.activation.originalProgress.submittedCount, 0);
  }

  setActivation(west, { startDateExpression: "date '2026-11-01'", zone: 'America/Los_Angeles' });
  for (const instant of ['2026-11-01T08:59:59Z', '2026-11-01T09:00:00Z']) {
    fixture.queryAsBootstrap(`update private.daily_bootstrap_test_clock set value=${literal(instant)};`);
    westRead = read(west);
    assert.equal(westRead.entryDate, '2026-11-01');
    assert.equal(westRead.activation.challengeDay, 1);
    assert.equal(westRead.activation.originalProgress.submittedCount, 0);
  }
});
