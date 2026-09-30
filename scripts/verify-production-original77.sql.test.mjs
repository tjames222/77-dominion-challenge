import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { createOriginal77FullchainFixture } from './fixtures/original77-fullchain-fixture.mjs';

// Every real application migration is replayed unchanged. Provider dependency
// shapes in the isolated fixture are not a simulation of managed Auth/Storage
// services. These tests prove source catalog/ACL contracts and fail-closed drift
// detection, not login or end-to-end authorization behavior.
let fixture;
let checkpoint;
let inboxCheckpoint;
const allTrue = Array(8).fill('t').join('|');

function readOnly(query = checkpoint, searchPath = 'public') {
  assert(['public', 'private', 'pg_catalog'].includes(searchPath));
  return fixture.query(`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
    SET LOCAL search_path=${searchPath}; SET LOCAL TimeZone='America/Los_Angeles';
    SET LOCAL DateStyle='SQL, DMY'; ${query} ROLLBACK;`);
}

function driftProbe(mutation, rejectedFields) {
  const result = fixture.queryAsBootstrap(`BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE;
    SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='15s';
    ${mutation}
    ${checkpoint}
    ROLLBACK;`).split('|');
  assert.equal(result.length, 8, 'The catalog query must emit only eight booleans.');
  assert(result.every(value => value === 't' || value === 'f'));
  assert.equal(result[1], 'f', 'Synthetic local DDL requires a read-write transaction.');
  for (const index of rejectedFields) assert.equal(result[index], 'f', `Catalog drift must reject field ${index}.`);
  assert.equal(readOnly(), allTrue, 'All synthetic changes must roll back.');
}

before(async () => {
  checkpoint = await readFile(new URL('./verify-production-original77.sql', import.meta.url), 'utf8');
  inboxCheckpoint = await readFile(new URL('./verify-production-account-request-inbox.sql', import.meta.url), 'utf8');
  assert(!checkpoint.includes('0000000000000000000000000000000000000000000000000000000000000000'),
    'Canonical hashes must come from a successful frozen actual70 local replay before these tests run.');
  fixture = await createOriginal77FullchainFixture();
  assert.equal(fixture.appliedFiles.length, 70);
  assert.equal(fixture.history.length, 70);
  assert.equal(readOnly(inboxCheckpoint), Array(11).fill('t').join('|'),
    'The fullchain fixture must retain the independent eleven-field inbox contract.');
  assert.equal(readOnly(), allTrue);
});

after(() => { fixture?.close(); });

test('actual70 replay passes source-fixed catalog proof in each caller deparse context', () => {
  for (const path of ['public', 'private', 'pg_catalog']) assert.equal(readOnly(checkpoint, path), allTrue);
});

test('a read-only catalog role can evaluate the contract without application execution', () => {
  assert.equal(fixture.queryAsBootstrap(`BEGIN READ ONLY; SET LOCAL ROLE supabase_read_only_user;
    ${checkpoint} ROLLBACK;`), allTrue);
});

for (const count of [67, 68, 69]) test(`incomplete ${count}-migration history is refused`, () => {
  const versions = fixture.history.slice(count).map(row => `'${row.version}'`).join(',');
  driftProbe(`DELETE FROM supabase_migrations.schema_migrations WHERE version IN (${versions});`, [0]);
});

test('a future history increment and a renamed original77 migration are refused', () => {
  driftProbe("INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES('99999999999999','synthetic_future',ARRAY[]::text[]);", [0]);
  driftProbe("UPDATE supabase_migrations.schema_migrations SET name='synthetic_wrong_name' WHERE version='20260930160740';", [0]);
});

for (const [label, mutation] of [
  ['definition', "CREATE OR REPLACE FUNCTION private.original_77_progress_for_user(target_user_id uuid,target_challenge_start_date date) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$SELECT '{}'::jsonb$$;"],
  ['security mode', 'ALTER FUNCTION private.original_77_progress_for_user(uuid,date) SECURITY INVOKER;'],
  ['search path', 'ALTER FUNCTION private.original_77_progress_for_user(uuid,date) SET search_path=public;'],
  ['volatility', 'ALTER FUNCTION private.original_77_progress_for_user(uuid,date) VOLATILE;'],
  ['anonymous execute', 'GRANT EXECUTE ON FUNCTION private.original_77_progress_for_user(uuid,date) TO anon;'],
  ['service execute', 'GRANT EXECUTE ON FUNCTION private.original_77_progress_for_user(uuid,date) TO service_role;'],
  ['additional overload', "CREATE FUNCTION private.original_77_submission_evidence() RETURNS jsonb LANGUAGE sql AS $$SELECT '{}'::jsonb$$;"],
]) test(`runtime function ${label} drift is refused`, () => driftProbe(mutation, [2]));

test('a changed runtime function owner is refused', () => {
  driftProbe('ALTER FUNCTION private.original_77_progress_for_user(uuid,date) OWNER TO service_role;', [2]);
});

test('disabled or extra check-in completion triggers are refused', () => {
  driftProbe('ALTER TABLE public.check_ins DISABLE TRIGGER a_record_live_original_77_completion;', [3]);
  driftProbe(`CREATE TRIGGER zz_synthetic_extra_completion AFTER INSERT ON public.check_ins
    FOR EACH ROW EXECUTE FUNCTION private.record_live_original_77_completion();`, [3]);
});

test('the event immutability trigger cannot be disabled', () => {
  driftProbe('ALTER TABLE private.original_77_completion_events DISABLE TRIGGER reject_original_77_completion_event_update;', [3]);
});

test('old calendar77 constraint and an unvalidated constraint are refused', () => {
  driftProbe(`ALTER TABLE public.check_ins DROP CONSTRAINT check_ins_challenge_day_range;
    ALTER TABLE public.check_ins ADD CONSTRAINT check_ins_challenge_day_range CHECK(challenge_day BETWEEN 1 AND 77);`, [4]);
  driftProbe(`ALTER TABLE public.check_ins DROP CONSTRAINT check_ins_challenge_day_range;
    ALTER TABLE public.check_ins ADD CONSTRAINT check_ins_challenge_day_range CHECK(challenge_day BETWEEN 1 AND 3652059) NOT VALID;`, [4]);
});

for (const [label, mutation] of [
  ['disabled RLS', 'ALTER TABLE private.original_77_completion_events DISABLE ROW LEVEL SECURITY;'],
  ['unforced RLS', 'ALTER TABLE private.original_77_completion_events NO FORCE ROW LEVEL SECURITY;'],
  ['member SELECT', 'GRANT SELECT ON private.original_77_completion_events TO authenticated;'],
  ['column INSERT', 'GRANT INSERT(source_check_in_id) ON private.original_77_completion_events TO authenticated;'],
  ['owner policy', 'ALTER POLICY original_77_completion_events_owner_read ON private.original_77_completion_events USING(true);'],
  ['instance uniqueness', 'ALTER TABLE private.original_77_completion_events DROP CONSTRAINT original_77_completion_events_instance_unique;'],
  ['required source date', 'ALTER TABLE private.original_77_completion_events ALTER COLUMN source_local_date DROP NOT NULL;'],
  ['source timestamp type', 'ALTER TABLE private.original_77_completion_events ALTER COLUMN source_recorded_at TYPE timestamp without time zone;'],
  ['recorded index', 'DROP INDEX private.original_77_completion_events_user_recorded_idx;'],
]) test(`completion ledger ${label} drift is refused`, () => driftProbe(mutation, [5]));

for (const [label, assignment] of [
  ['inactive', 'blocked=true'], ['threshold', 'threshold=76'], ['scope', "scope='lifetime'"],
  ['criteria version', 'criteria_version=2'], ['award wording', "requirement='Synthetic wrong rule'"],
]) test(`Finisher ${label} drift is refused`, () => {
  const localPrerequisite = label === 'criteria version'
    ? 'ALTER TABLE public.badge_definitions DROP CONSTRAINT badge_definitions_criteria_version_check;' : '';
  driftProbe(`${localPrerequisite}
    UPDATE public.badge_definitions SET ${assignment} WHERE badge_key='original_77_completed';`, [6]);
});

test('share version and browser RPC privilege drift are refused', () => {
  driftProbe(`ALTER TABLE public.public_share_snapshots DROP CONSTRAINT public_share_snapshots_snapshot_version_check;
    ALTER TABLE public.public_share_snapshots ADD CONSTRAINT public_share_snapshots_snapshot_version_check CHECK(snapshot_version=1);`, [7]);
  driftProbe('GRANT EXECUTE ON FUNCTION public.preview_share_snapshot(text) TO anon;', [7]);
});

test('an extra share constraint cannot silently block version2 writes', () => {
  driftProbe(`ALTER TABLE public.public_share_snapshots
    ADD CONSTRAINT synthetic_blocks_version2 CHECK(snapshot_version=1);`, [7]);
});

test('read-write execution cannot masquerade as read-only verification', () => {
  const result = fixture.query(`BEGIN READ WRITE; ${checkpoint} ROLLBACK;`).split('|');
  assert.equal(result.length, 8); assert.equal(result[1], 'f');
  assert.equal(readOnly(), allTrue);
});
