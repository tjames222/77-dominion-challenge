import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

// Local test helper only: no CLI, caller target/image, remote endpoint, pull,
// existing stack, credential, bind mount, persistent volume or account seed.
// All application migrations run unchanged as NOSUPERUSER postgres. Provider
// shapes are structural dependencies, not a substitute for native Auth tests.
const image = 'public.ecr.aws/supabase/postgres:17.6.1.141';
const migrationsDirectory = new URL('../../supabase/migrations/', import.meta.url);
const checkpoints = Object.freeze({
  67: Object.freeze({ last: '20260929000950_site_admin_account_requests_inbox.sql',
    versionsSha256: 'fea508a9d28234417a250bfd23825eb418265957c8c1e11b7365750acafb1358',
    filenamesSha256: 'b1be6d6864c52dd2fa95472e21c026b937f336917eae29ad699ddeaa3c73973f' }),
  70: Object.freeze({ last: '20260930161218_share_submitted_progress_v2.sql',
    versionsSha256: '73f5e3b0395829ec93acf1454cd212a653c5edfa19d4be641c8de792f0777f46',
    filenamesSha256: '501007d47257382a9bd72aadb81c2513551ec53042c9e3ce1ed41ab9d59a12d3' }),
});
const sha256 = value => createHash('sha256').update(value).digest('hex');
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
const docker = (args, input) => spawnSync('docker', args, {
  input, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
});

export async function createOriginal77FullchainFixture({ through = 70 } = {}) {
  assert(Number.isInteger(through) && Object.hasOwn(checkpoints, through), 'Only reviewed 67/70 fixture boundaries are supported.');
  const checkpoint = checkpoints[through];
  const names = (await readdir(migrationsDirectory)).filter(name => name.endsWith('.sql')).sort();
  assert(names.every(name => /^[0-9]{14}_[a-z0-9_]+\.sql$/.test(name)), 'Unexpected migration filename.');
  assert.equal(new Set(names.map(name => name.slice(0, 14))).size, names.length, 'Duplicate migration version.');
  if (through === 70) assert.equal(names.length, 70, 'Full-chain fixture requires the exact reviewed 70-migration inventory.');
  const appliedFiles = names.slice(0, through);
  assert.equal(appliedFiles.length, through); assert.equal(appliedFiles.at(-1), checkpoint.last);
  assert.equal(sha256(JSON.stringify(appliedFiles)), checkpoint.filenamesSha256, 'Pinned migration filenames changed.');
  const history = appliedFiles.map(name => Object.freeze({ version: name.slice(0, 14), name: name.slice(15, -4) }));
  assert.equal(sha256(JSON.stringify(history.map(row => row.version))), checkpoint.versionsSha256, 'Pinned migration prefix changed.');
  // Read only the selected bodies: through67 never reads or executes the three
  // pending original77 migrations. Capture hashes before creating any resource.
  const sources = await Promise.all(appliedFiles.map(file => readFile(new URL(file, migrationsDirectory), 'utf8')));
  const sourceHashes = Object.freeze(Object.fromEntries(appliedFiles.map((file, index) => [file, sha256(sources[index])])));
  const provider = await readFile(new URL('./schema-drift-provider.sql', import.meta.url), 'utf8');
  const fixture = `77dc-original77-chain-${randomUUID()}`;
  const cached = docker(['image', 'inspect', image, '--format', '{{.Id}}']);
  assert.equal(cached.status, 0, 'Pinned PostgreSQL image must already be cached; no download is allowed.');
  const imageId = cached.stdout.trim(); assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
  let container;

  function owned() {
    assert.match(container || '', /^[a-f0-9]{64}$/, 'Fixture is not running.');
    const result = docker(['inspect', container, '--format', '{{json .}}']);
    assert.equal(result.status, 0, 'Could not inspect the owned full-chain fixture.');
    const record = JSON.parse(result.stdout);
    assert.equal(record.Id, container); assert.equal(record.Name, '/' + fixture);
    assert.equal(record.Config?.Labels?.['77dc.fixture'], fixture); assert.equal(record.Config?.Image, imageId);
    assert.equal(record.HostConfig?.NetworkMode, 'none'); assert.equal(record.HostConfig?.ReadonlyRootfs, true);
    assert.equal(record.HostConfig?.Privileged, false);
    assert.equal(Object.keys(record.HostConfig?.PortBindings || {}).length, 0);
    assert.equal((record.HostConfig?.CapAdd || []).length, 0);
    assert(record.HostConfig?.CapDrop?.includes('ALL'));
    assert(record.HostConfig?.SecurityOpt?.includes('no-new-privileges'));
    assert((record.Mounts || []).every(mount => mount.Type === 'tmpfs'));
    return container;
  }
  function close() {
    if (!container) return;
    const id = owned();
    const result = docker(['rm', '--force', id]);
    assert.equal(result.status, 0, 'Failed to remove the exact owned full-chain fixture.');
    container = undefined;
  }
  function sql(query, role) {
    assert.equal(typeof query, 'string'); assert(Buffer.byteLength(query) <= 2 * 1024 * 1024, 'Fixture SQL exceeds its byte cap.');
    const result = docker(['exec', '-i', owned(), 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
      '-h', '/fixture', '-U', role, '-d', 'postgres'], query);
    if (result.error || result.signal) {
      // A timed-out docker exec does not prove its backend stopped. Remove the
      // owned no-network cluster before reporting that bounded local failure.
      close();
      throw new Error('Owned full-chain fixture command exceeded its execution boundary.');
    }
    assert.equal(result.status, 0, `Owned full-chain fixture SQL failed: ${result.stderr}`);
    return result.stdout.trim();
  }
  const query = statement => sql(statement, 'postgres');
  const queryAsBootstrap = statement => sql(statement, 'supabase_admin');
  function sqlAsync(statement, role) {
    assert.equal(typeof statement, 'string'); assert(Buffer.byteLength(statement) <= 2 * 1024 * 1024, 'Fixture SQL exceeds its byte cap.');
    const args = ['exec', '-i', owned(), 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
      '-h', '/fixture', '-U', role, '-d', 'postgres'];
    return new Promise((resolve, reject) => {
      let inputError;
      try {
        const child = execFile('docker', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
          (error, stdout, stderr) => {
            try {
              if (inputError || (error && (typeof error.code !== 'number' || error.signal || error.killed))) {
                // Docker client termination or truncated I/O does not establish
                // backend completion. End only this verified owned fixture.
                close();
                throw new Error('Owned full-chain fixture command exceeded its execution boundary.');
              }
              assert.equal(error, null, `Owned full-chain fixture SQL failed: ${stderr}`);
              resolve(stdout.trim());
            } catch (failure) { reject(failure); }
          });
        child.stdin.once('error', error => { inputError = error; });
        child.stdin.end(statement);
      } catch (error) {
        try { close(); } catch (cleanupError) { reject(cleanupError); return; }
        reject(error);
      }
    });
  }
  const queryAsync = statement => sqlAsync(statement, 'postgres');
  const queryAsBootstrapAsync = statement => sqlAsync(statement, 'supabase_admin');

  try {
    const launched = docker(['run', '--detach', '--pull', 'never', '--name', fixture, '--label', `77dc.fixture=${fixture}`,
      '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--log-driver', 'none',
      '--user', '100:101', '--memory', '768m', '--cpus', '1',
      '--tmpfs', '/fixture:rw,exec,nosuid,nodev,uid=100,gid=101,mode=0700,size=512m',
      '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,uid=100,gid=101,mode=0700,size=64m',
      '--entrypoint', 'bash', imageId, '-c',
      'set -euo pipefail;umask 077;initdb --username=supabase_admin --auth=trust --no-locale --encoding=UTF8 -D /fixture/data >/dev/null;exec postgres -D /fixture/data -k /fixture -h "" -c max_worker_processes=0']);
    assert.equal(launched.status, 0, 'Could not create the owned full-chain fixture.');
    container = launched.stdout.trim(); assert.match(container, /^[a-f0-9]{64}$/);
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (docker(['exec', owned(), 'pg_isready', '-h', '/fixture', '-U', 'supabase_admin']).status === 0) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(ready, 'Owned full-chain fixture did not become ready.');
    queryAsBootstrap(`create role postgres login nosuperuser nocreaterole nocreatedb bypassrls;
      create role anon;create role authenticated;create role service_role bypassrls;
      create role supabase_storage_admin nologin nosuperuser;
      create role supabase_read_only_user nologin nosuperuser bypassrls;
      grant pg_read_all_data to supabase_read_only_user;
      grant create on database postgres to postgres;
      grant usage,create on schema public to postgres;`);
    query(provider);
    // The baseline's real SELECT-only vector lock guard is not stripped or
    // bypassed. These empty dependency tables have the required distinct owner;
    // postgres receives no membership, write privilege or grant option.
    queryAsBootstrap(`create table storage.buckets_vectors(id text primary key);
      create table storage.vector_indexes(id text primary key);
      alter table storage.buckets_vectors owner to supabase_storage_admin;
      alter table storage.vector_indexes owner to supabase_storage_admin;
      revoke all on storage.buckets_vectors,storage.vector_indexes from public,anon,authenticated,service_role,postgres;
      grant select on storage.buckets_vectors,storage.vector_indexes to postgres;`);
    query(`create schema supabase_migrations;
      create table supabase_migrations.schema_migrations(version text primary key,name text not null,statements text[] not null);
      set check_function_bodies=on;`);
    assert.equal(query("select current_user,current_setting('server_version_num'),current_setting('check_function_bodies'),rolsuper from pg_roles where rolname=current_user;"), 'postgres|170006|on|f');
    for (let index = 0; index < appliedFiles.length; index++) {
      const source = sources[index]; const row = history[index];
      try {
        // Same atomic boundary as the reviewed CLI migration-up path: unchanged
        // application SQL and its history row succeed or roll back together.
        query(`begin;set local check_function_bodies=on;set local search_path=public,extensions;
          ${source}
          insert into supabase_migrations.schema_migrations(version,name,statements)
            values(${literal(row.version)},${literal(row.name)},array[${literal(source)}]::text[]);
          commit;`);
      } catch (error) {
        throw new Error(`Actual migration fixture failed at ${appliedFiles[index]}.`, { cause: error });
      }
    }
    const stored = JSON.parse(query('select jsonb_agg(jsonb_build_object(\'version\',version,\'name\',name) order by version collate "C") from supabase_migrations.schema_migrations;'));
    assert.deepEqual(stored, history);
    assert.equal(query("select current_setting('server_version_num'),current_setting('check_function_bodies'),rolsuper from pg_roles where rolname='postgres';"), '170006|on|f');
    for (const file of appliedFiles) {
      assert.equal(sha256(await readFile(new URL(file, migrationsDirectory), 'utf8')), sourceHashes[file], `Migration changed during fixture replay: ${file}`);
    }
    return Object.freeze({ query, queryAsBootstrap, queryAsync, queryAsBootstrapAsync, close, history: Object.freeze(history),
      appliedFiles: Object.freeze(appliedFiles), sourceHashes });
  } catch (error) {
    close();
    throw error;
  }
}
