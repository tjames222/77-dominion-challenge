import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';

const container = `77dc-original-77-evidence-${randomUUID()}`;
const image = 'public.ecr.aws/supabase/postgres:17.6.1.141';
const migrationUrl = new URL(
  '../supabase/migrations/20260930152825_add_original_77_completion_evidence_foundation.sql',
  import.meta.url,
);
const command = [
  'exec', '-i', container,
  'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
  '-h', '/tmp', '-U', 'postgres', '-d', 'postgres',
];
const actor = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const actions = [
  'bible',
  'morningPrayer',
  'worshipOnly',
  'eveningPrayer',
  'workoutOne',
  'walk',
  'workoutTwo',
];
let created = false;
let migration = '';
let executableMigration = '';

function docker(args, input) {
  return spawnSync('docker', args, {
    input,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function query(sql) {
  const result = docker(command, sql);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function literal(value) {
  return value === null ? 'null' : `'${String(value).replaceAll("'", "''")}'`;
}

function dayDate(day, start = '2026-01-01') {
  const result = new Date(`${start}T00:00:00Z`);
  result.setUTCDate(result.getUTCDate() + day - 1);
  return result.toISOString().slice(0, 10);
}

function checkIn(day, {
  id = randomUUID(),
  userId = actor,
  start = '2026-01-01',
  entryDate = dayDate(day, start),
  challengeDay = day,
  status = 'partial',
  completed = ['walk'],
  createdAt = `${entryDate}T12:00:00.123456Z`,
} = {}) {
  return {
    id,
    sql: `insert into public.check_ins
      (id,user_id,entry_date,challenge_day,status,completed,created_at)
      values (
        ${literal(id)},
        ${literal(userId)},
        ${literal(entryDate)}::date,
        ${challengeDay},
        ${literal(status)},
        array[${completed.map(literal).join(',')}]::text[],
        ${literal(createdAt)}::timestamptz
      );`,
  };
}

function rows(count, options = {}) {
  return Array.from({ length: count }, (_, index) => checkIn(index + 1, options));
}

function evidence(userId = actor, start = '2026-01-01') {
  return query(`select private.original_77_submission_evidence(
    ${literal(userId)}::uuid,
    ${literal(start)}::date
  );`)[0];
}

function expectSqlState(sql, code, setup = '') {
  query(`begin;
  ${setup}
  do $test$
  begin
    begin
      ${sql}
    exception when sqlstate '${code}' then
      return;
    end;
    raise exception 'Expected SQLSTATE ${code}';
  end
  $test$;
  rollback;`);
}

before(async () => {
  migration = await readFile(migrationUrl, 'utf8');
  executableMigration = migration
    .replace(/--.*$/gm, '')
    .replace(/comment\s+on[\s\S]*?;\s*/gi, '');
  const started = docker([
    'run', '--pull', 'never', '--detach', '--name', container,
    '--network', 'none', '--user', 'postgres', '--tmpfs', '/tmp:rw',
    '--entrypoint', '/bin/sh', image, '-c',
    'initdb -D /tmp/original-77-evidence-pgdata -A trust && exec postgres -D /tmp/original-77-evidence-pgdata -k /tmp -h ""',
  ]);
  assert.equal(started.status, 0, started.stderr || started.error?.message);
  created = true;

  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (docker(['exec', container, 'pg_isready', '-h', '/tmp', '-U', 'postgres']).status === 0) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'isolated PostgreSQL fixture did not become ready');

  query(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create schema private;
    create table auth.users (id uuid primary key);
    create function auth.uid()
    returns uuid language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create table public.profiles (
      user_id uuid primary key references auth.users(id) on delete cascade,
      challenge_start_date date,
      challenge_activation_review_required boolean not null default false
    );
    create table public.check_ins (
      id uuid primary key,
      user_id uuid not null references auth.users(id) on delete cascade,
      entry_date date not null,
      challenge_day integer not null,
      status text not null,
      completed text[] not null,
      created_at timestamptz not null
    );
    -- Production has stricter CHECK/unique constraints. This adversarial
    -- fixture intentionally omits them so the assessor itself must fail
    -- closed, while retaining the actor-leading access path used in release.
    create index check_ins_user_entry_date_fixture_idx
      on public.check_ins (user_id,entry_date desc);
    grant usage on schema auth to authenticated;
    ${migration}
  `);
});

beforeEach(() => {
  query(`
    truncate table auth.users cascade;
    insert into auth.users (id) values ('${actor}'), ('${other}');
    insert into public.profiles (user_id,challenge_start_date)
    values ('${actor}','2026-01-01'), ('${other}','2026-01-01');
  `);
});

after(() => {
  if (!created) return;
  const removed = docker(['rm', '--force', container]);
  assert.equal(removed.status, 0, removed.stderr || removed.error?.message);
});

test('migration is an additive private foundation without a live writer or replay', () => {
  assert.doesNotMatch(executableMigration, /create\s+trigger[\s\S]*?on\s+public\.check_ins/i);
  assert.doesNotMatch(executableMigration, /insert\s+into\s+private\.original_77_completion_events/i);
  assert.doesNotMatch(executableMigration, /user_badges|outbound|successor|challenge_definitions/i);
  assert.deepEqual(query(`select jsonb_build_object(
    'events',(select count(*) from private.original_77_completion_events),
    'checkInTriggers',(select count(*) from pg_trigger where tgrelid='public.check_ins'::regclass and not tgisinternal)
  );`)[0], { events: 0, checkInTriggers: 0 });
});

test('private ACL, owner-only RLS, FORCE RLS and function denial are exact', () => {
  const [shape] = query(`select jsonb_build_object(
    'rls',c.relrowsecurity,
    'forceRls',c.relforcerowsecurity,
    'policies',(select count(*) from pg_policy where polrelid=c.oid),
    'authenticatedSelect',has_table_privilege('authenticated',c.oid,'select'),
    'authenticatedInsert',has_table_privilege('authenticated',c.oid,'insert'),
    'anonSelect',has_table_privilege('anon',c.oid,'select'),
    'serviceSelect',has_table_privilege('service_role',c.oid,'select'),
    'authenticatedExecute',has_function_privilege(
      'authenticated',
      'private.original_77_submission_evidence(uuid,date)',
      'execute'
    )
  ) from pg_class c where c.oid='private.original_77_completion_events'::regclass;`);
  assert.deepEqual(shape, {
    rls: true,
    forceRls: true,
    policies: 1,
    authenticatedSelect: false,
    authenticatedInsert: false,
    anonSelect: false,
    serviceSelect: false,
    authenticatedExecute: false,
  });

  expectSqlState(
    'perform * from private.original_77_completion_events;',
    '42501',
    'set local role authenticated;',
  );
  assert.match(
    query("select to_jsonb(pg_get_functiondef('private.original_77_submission_evidence(uuid,date)'::regprocedure));")[0],
    /order by check_in\.entry_date\s+limit 78/i,
  );
  expectSqlState(
    `perform private.original_77_submission_evidence('${actor}','2026-01-01');`,
    '42501',
    'set local role authenticated;',
  );
});

test('76 submissions remain active and a sparse day-78 submission only proves historical qualification', () => {
  query(rows(76).map((item) => item.sql).join('\n'));
  assert.deepEqual(evidence(), {
    schemaVersion: 1,
    context: 'database_snapshot',
    valid: true,
    reason: null,
    userId: actor,
    instanceId: 'original77:2026-01-01',
    submittedCount: 76,
    meetsSubmissionRule: false,
    completionState: 'in_progress',
    canonicalEvent: null,
    historicalProvenancePending: false,
    awardAuthorized: false,
    replayAuthorized: false,
  });

  query(checkIn(78).sql);
  const qualified = evidence();
  assert.equal(qualified.submittedCount, 77);
  assert.equal(qualified.meetsSubmissionRule, true);
  assert.equal(qualified.completionState, 'historical_provenance_pending');
  assert.equal(qualified.historicalProvenancePending, true);
  assert.equal(qualified.canonicalEvent, null);
  assert.equal(qualified.awardAuthorized, false);
  assert.equal(qualified.replayAuthorized, false);
  assert.deepEqual(query('select to_jsonb(count(*)) from private.original_77_completion_events;'), [0]);
});

test('complete and partial rows with one through seven unique allowed actions count', () => {
  for (const status of ['complete', 'partial']) {
    for (let count = 1; count <= actions.length; count += 1) {
      query('truncate table public.check_ins cascade;');
      query(checkIn(1, { status, completed: actions.slice(0, count) }).sql);
      const result = evidence();
      assert.equal(result.valid, true);
      assert.equal(result.submittedCount, 1);
      assert.equal(result.completionState, 'in_progress');
    }
  }
});

test('malformed status, actions, scope, day and duplicate evidence fail closed', () => {
  const rawCheckIn = ({
    id = randomUUID(),
    entryDate = '2026-01-01',
    challengeDay = 1,
    completed = "array['walk']::text[]",
    createdAt = '2026-01-01T12:00:00Z',
  } = {}) => `insert into public.check_ins
    (id,user_id,entry_date,challenge_day,status,completed,created_at)
    values ('${id}','${actor}',${literal(entryDate)}::date,${challengeDay},'partial',
      ${completed},${literal(createdAt)}::timestamptz);`;
  const cases = [
    [checkIn(1, { status: 'scheduled' }).sql, 'status'],
    [checkIn(1, { completed: [] }).sql, 'empty actions'],
    [checkIn(1, { completed: ['walk', 'walk'] }).sql, 'duplicate actions'],
    [checkIn(1, { completed: ['unknown'] }).sql, 'unknown action'],
    [checkIn(1, { challengeDay: 2 }).sql, 'wrong ordinal'],
    [checkIn(1, {
      entryDate: 'infinity',
      createdAt: '2026-01-01T12:00:00Z',
    }).sql, 'infinite date'],
    [checkIn(1, { entryDate: '2026-02-30' }).sql, 'invalid date'],
    [checkIn(1, { createdAt: 'infinity' }).sql, 'non-finite timestamp'],
    [checkIn(1, { createdAt: '10000-01-01T00:00:00Z' }).sql, 'timestamp after year 9999'],
    [checkIn(1, { createdAt: '0001-01-01T00:00:00+00:01' }).sql, 'timestamp before year 1'],
    [rawCheckIn({ completed: "'{{walk},{bible}}'::text[]" }), 'multidimensional actions'],
    [rawCheckIn({ completed: "'[0:0]={walk}'::text[]" }), 'noncanonical array bound'],
    [rawCheckIn({ completed: 'array[null]::text[]' }), 'null action'],
    [
      checkIn(1).sql + checkIn(2, { entryDate: dayDate(1) }).sql,
      'duplicate local date',
    ],
    [
      checkIn(1).sql + checkIn(2, { challengeDay: 1 }).sql,
      'duplicate calendar ordinal',
    ],
  ];

  for (const [sql, label] of cases) {
    query('truncate table public.check_ins cascade;');
    if (label === 'invalid date') {
      expectSqlState(sql, '22008');
      continue;
    }
    query(sql);
    const result = evidence();
    assert.equal(result.valid, false, label);
    assert.equal(result.reason, 'invalid_check_in', label);
    assert.equal(result.submittedCount, null, label);
    assert.equal(result.completionState, 'invalid_evidence', label);
  }

  query('truncate table public.check_ins cascade;');
  query(rows(77).map((item) => item.sql).join('\n') + checkIn(78).sql);
  assert.equal(evidence().reason, 'invalid_check_in');
});

test('activation review, start and owner scopes never borrow another account evidence', () => {
  query(checkIn(1).sql + checkIn(1, { userId: other }).sql);
  assert.equal(evidence(actor).submittedCount, 1);
  assert.equal(evidence(other).submittedCount, 1);
  assert.equal(evidence(actor, '2026-01-02').reason, 'invalid_activation');
  query(`update public.profiles set challenge_activation_review_required=true where user_id='${actor}';`);
  assert.equal(evidence().reason, 'activation_review_required');
  assert.equal(evidence(null).reason, 'invalid_activation');
});

test('a privileged fixture can persist one immutable source identity without granting award authority', () => {
  const canonicalRows = rows(77);
  query(canonicalRows.map((item) => item.sql).join('\n'));
  const source = canonicalRows.at(-1);
  expectSqlState(`insert into private.original_77_completion_events
    (user_id,challenge_start_date,source_check_in_id,recorded_at)
    values ('${actor}','2026-01-01','${source.id}','10000-01-01T00:00:00Z');`, '23514');
  query(`insert into private.original_77_completion_events
    (user_id,challenge_start_date,source_check_in_id,recorded_at)
    values ('${actor}','2026-01-01','${source.id}','2026-04-01T00:00:00Z');`);

  const result = evidence();
  assert.equal(result.completionState, 'live_completed');
  assert.equal(result.historicalProvenancePending, false);
  assert.equal(result.canonicalEvent.sourceId, source.id);
  assert.equal(result.canonicalEvent.localDate, '2026-03-18');
  assert.equal(result.canonicalEvent.recordedAt, '2026-03-18T12:00:00.123456+00:00');
  assert.equal(result.canonicalEvent.persistedAt, '2026-04-01T00:00:00+00:00');
  assert.equal(result.awardAuthorized, false);
  assert.equal(result.replayAuthorized, false);

  expectSqlState(`update private.original_77_completion_events
    set recorded_at='2026-04-02T00:00:00Z';`, '42501');
  expectSqlState(`insert into private.original_77_completion_events
    (user_id,challenge_start_date,source_check_in_id)
    values ('${actor}','2026-01-01','${canonicalRows.at(-2).id}');`, '23505');

  query(`delete from auth.users where id='${actor}';`);
  assert.deepEqual(query('select to_jsonb(count(*)) from private.original_77_completion_events;'), [0]);
});

test('mismatched privileged event evidence is visible as invalid, never normalized', () => {
  const actorRows = rows(77);
  const foreignSource = checkIn(1, { userId: other });
  query(actorRows.map((item) => item.sql).join('\n') + foreignSource.sql);
  query(`insert into private.original_77_completion_events
    (user_id,challenge_start_date,source_check_in_id)
    values ('${actor}','2026-01-01','${foreignSource.id}');`);
  const result = evidence();
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'invalid_completion_event');
  assert.equal(result.canonicalEvent, null);
  assert.equal(result.awardAuthorized, false);
  assert.equal(result.replayAuthorized, false);
});
