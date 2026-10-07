import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { CI_FIXTURE_IMAGES } from './prepare-ci-fixture-images.mjs';

const containerName = 'supabase_db_77-dominion-challenge';
const imagePin = CI_FIXTURE_IMAGES.find(image => image.name === 'postgres');
const marker = '77-dominion CI-only empty Cron lint fixture';
const runtimeGuard = `do $guard$
begin
  if current_database() <> 'postgres' or current_setting('server_version_num') <> '170006'
    or current_setting('cron.database_name', true) is distinct from 'postgres' then
    raise exception 'Expected the pinned local native PostgreSQL runtime';
  end if;
end $guard$;`;
const emptyCatalogGuard = `do $guard$
begin
  if not exists (select 1 from pg_catalog.pg_extension e
    join pg_catalog.pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'pg_cron' and n.nspname = 'pg_catalog'
      and pg_catalog.obj_description(e.oid, 'pg_extension') = '${marker}')
    or exists (select 1 from cron.job)
    or exists (select 1 from cron.job_run_details) then
    raise exception 'Expected only the owned empty Cron lint fixture';
  end if;
end $guard$;`;

// No schedules, grants, application objects or migration history are changed.
// CREATE (without IF NOT EXISTS) refuses to adopt an existing extension.
export const PREPARE_CI_CRON_LINT_SQL = `begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
${runtimeGuard}
create extension pg_cron with schema pg_catalog;
comment on extension pg_cron is '${marker}';
${emptyCatalogGuard}
commit;`;

// Remove only this step's marked, still-empty extension, without CASCADE,
// before later reconciliation fixtures copy provider extension definitions.
export const CLEANUP_CI_CRON_LINT_SQL = `begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
${runtimeGuard}
${emptyCatalogGuard}
drop extension pg_cron;
commit;`;

const failure = () => new Error('CI-only Cron lint fixture failed; no hosted database was targeted.');
const docker = (args, input) => spawnSync('docker', ['--host', 'unix:///var/run/docker.sock', ...args], {
  input, encoding: 'utf8', timeout: 45000, maxBuffer: 65536,
});

export function prepareCiCronLint({ mode, env = process.env, platform = process.platform,
  arch = process.arch, run = docker } = {}) {
  if (!['--prepare', '--cleanup'].includes(mode) || env.CI !== 'true'
    || env.GITHUB_ACTIONS !== 'true' || platform !== 'linux' || arch !== 'x64'
    || env.SUPABASE_DB_URL !== 'postgresql://postgres:postgres@127.0.0.1:54322/postgres') throw failure();
  // Inspect no container environment or credentials. Execute by immutable ID,
  // never by a caller-supplied host, URL, container name or registry override.
  const inspected = run(['inspect', containerName, '--format',
    '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Image}},"imageRef":{{json .Config.Image}},"running":{{json .State.Running}}}']);
  let record;
  try { record = JSON.parse(inspected.stdout); } catch { throw failure(); }
  if (inspected.status !== 0 || !/^[a-f0-9]{64}$/.test(record?.id || '')
    || record.name !== `/${containerName}` || record.running !== true || record.image !== imagePin.config
    || !['public.ecr.aws', 'ghcr.io'].some(registry => record.imageRef === `${registry}/supabase/postgres:${imagePin.version}`)) throw failure();
  const applied = run(['exec', '-i', record.id, 'psql', '--no-psqlrc', '--quiet',
    '--set', 'ON_ERROR_STOP=1', '--host', '/var/run/postgresql', '--port', '5432',
    '--username', 'postgres', '--dbname', 'postgres'],
  mode === '--prepare' ? PREPARE_CI_CRON_LINT_SQL : CLEANUP_CI_CRON_LINT_SQL);
  if (applied.status !== 0) throw failure();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw failure();
    prepareCiCronLint({ mode: process.argv[2] });
    console.log('CI-only empty Cron lint fixture operation completed.');
  } catch {
    console.error(failure().message);
    process.exitCode = 1;
  }
}
