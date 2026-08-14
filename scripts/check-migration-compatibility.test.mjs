import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkMigrationCompatibility,
  migrationCompatibilityViolations,
} from "./check-migration-compatibility.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");

function reasons(sql) {
  return migrationCompatibilityViolations(sql).map(({ reason }) => reason);
}

test("rejects top-level transaction controls that can separate SQL from history", () => {
  const violations = migrationCompatibilityViolations(`
BEGIN;
commit;
ROLLBACK TO SAVEPOINT before_change;
start /* caller should not own this */ transaction;
ABORT;
END;
PREPARE TRANSACTION 'migration-gid';
`);

  assert.equal(violations.length, 7);
  assert.deepEqual(
    violations.map(({ line }) => line),
    [2, 3, 4, 5, 6, 7, 8],
  );
  for (const found of violations) {
    assert.match(found.reason, /top-level transaction control/i);
  }
});

test("rejects statements that cannot run in the CLI-owned transaction", () => {
  const found = reasons(`
create unique index concurrently users_email_idx on public.users (email);
reindex table concurrently public.users;
vacuum (analyze) public.users;
alter system set statement_timeout = '5min';
cluster public.users using users_pkey;
`);

  assert.equal(found.length, 5);
  assert.match(found[0], /CREATE INDEX CONCURRENTLY/);
  assert.match(found[1], /REINDEX CONCURRENTLY/);
  assert.match(found[2], /VACUUM/);
  assert.match(found[3], /ALTER SYSTEM/);
  assert.match(found[4], /CLUSTER/);
});

test("ignores keywords in comments, strings, identifiers, and procedural bodies", () => {
  const found = migrationCompatibilityViolations(`
-- BEGIN; VACUUM public.users;
/* outer comment /* COMMIT; */ ALTER SYSTEM RESET ALL; */
select 'ROLLBACK; CREATE INDEX CONCURRENTLY ignored_idx ON ignored_table(id)';
select E'escaped quote\\' then CLUSTER ignored_table;';
select "COMMIT" from public.audit_events;
do $migration$
begin
  perform 'VACUUM public.users';
  -- rollback;
end;
$migration$;
create function public.example() returns void language plpgsql as $$
begin
  return;
end;
$$;
`);

  assert.deepEqual(found, []);
});

test("allows ordinary transactional DDL and SET LOCAL", () => {
  assert.deepEqual(
    migrationCompatibilityViolations(`
set local lock_timeout = '5s';
create index if not exists profiles_name_idx on public.profiles (display_name);
alter table public.profiles add column if not exists launched_at timestamptz;
do $$ begin perform 1; end $$;
`),
    [],
  );
});

test("fails closed when lexical delimiters are unterminated", () => {
  const cases = [
    ["select 'unfinished", /unterminated string/],
    ['select "unfinished', /unterminated quoted identifier/],
    ["do $body$ begin perform 1;", /unterminated \$body\$ body/],
    ["select 1; /* unfinished", /unterminated block comment/],
  ];

  for (const [sql, expected] of cases) {
    const found = reasons(sql);
    assert.equal(found.length, 1);
    assert.match(found[0], expected);
  }
});

test("directory checks scan only direct SQL migration files in sorted order", async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "migration-gate-"));
  const nestedDirectory = path.join(fixtureRoot, "nested");
  await mkdir(nestedDirectory);

  try {
    await writeFile(path.join(fixtureRoot, "20260102000000_safe.sql"), "select 1;\n");
    await writeFile(path.join(fixtureRoot, "20260101000000_bad.sql"), "BEGIN;\n");
    await writeFile(path.join(fixtureRoot, "notes.txt"), "COMMIT;\n");
    await writeFile(path.join(nestedDirectory, "ignored.sql"), "ROLLBACK;\n");

    const result = await checkMigrationCompatibility([fixtureRoot]);
    assert.deepEqual(
      result.files.map((file) => path.basename(file)),
      ["20260101000000_bad.sql", "20260102000000_safe.sql"],
    );
    assert.equal(result.violations.length, 1);
    assert.match(result.violations[0].source, /20260101000000_bad\.sql$/);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("the repository migration chain passes the compatibility gate", async () => {
  const result = await checkMigrationCompatibility();
  assert.ok(result.files.length > 0);
  assert.deepEqual(result.violations, []);
});

test("local database helpers fail closed on a Supabase CLI version change", async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "migration-cli-version-"));
  const fakeCli = path.join(fixtureRoot, "supabase");

  try {
    await writeFile(
      fakeCli,
      "#!/usr/bin/env bash\nif [[ \"${SUPABASE_TELEMETRY_DISABLED:-}\" != \"1\" ]]; then echo telemetry-not-disabled >&2; exit 98; fi\nif [[ \"${1:-}\" == \"--version\" ]]; then echo 2.114.0; exit 0; fi\necho unexpected-command >&2\nexit 99\n",
    );
    await chmod(fakeCli, 0o755);

    for (const helper of [
      "start-local-database.sh",
      "reset-local-database.sh",
    ]) {
      const result = spawnSync(
        "bash",
        [path.join(repositoryRoot, "scripts", helper)],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
          env: { ...process.env, SUPABASE_CLI_BIN: fakeCli },
        },
      );

      assert.notEqual(result.status, 0, helper);
      assert.match(
        result.stderr,
        /expected pinned Supabase CLI 2\.109\.0, found 2\.114\.0/,
      );
      assert.doesNotMatch(result.stderr, /unexpected-command/);
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("local start does not mutate a pre-existing wrong-version stack", async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "migration-start-owner-"));
  const fakeCli = path.join(fixtureRoot, "supabase");
  const fakeDocker = path.join(fixtureRoot, "docker");
  const cliLog = path.join(fixtureRoot, "cli.log");
  const dockerLog = path.join(fixtureRoot, "docker.log");

  try {
    await writeFile(
      fakeCli,
      "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >>\"$FAKE_CLI_LOG\"\nif [[ \"${1:-}\" == \"--version\" ]]; then echo 2.109.0; exit 0; fi\nexit 90\n",
    );
    await writeFile(
      fakeDocker,
      "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >>\"$FAKE_DOCKER_LOG\"\nif [[ \"${1:-}\" == \"inspect\" && \"${2:-}\" == \"supabase_db_77-dominion-challenge\" ]]; then\n  if [[ \"$*\" == *--format* ]]; then echo ghcr.io/supabase/postgres:17.6.1.140; fi\n  exit 0\nfi\nif [[ \"${1:-}\" == \"volume\" && \"${2:-}\" == \"inspect\" ]]; then exit 0; fi\nexit 91\n",
    );
    await chmod(fakeCli, 0o755);
    await chmod(fakeDocker, 0o755);

    const result = spawnSync(
      "bash",
      [path.join(repositoryRoot, "scripts", "start-local-database.sh")],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          SUPABASE_CLI_BIN: fakeCli,
          DOCKER_BIN: fakeDocker,
          FAKE_CLI_LOG: cliLog,
          FAKE_DOCKER_LOG: dockerLog,
          SUPABASE_INTERNAL_IMAGE_REGISTRY: "ghcr.io/",
        },
      },
    );

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /existing stack uses ghcr\.io\/supabase\/postgres:17\.6\.1\.140; expected ghcr\.io\/supabase\/postgres:17\.6\.1\.141/,
    );
    assert.match(result.stderr, /It was not changed/);
    assert.equal((await readFile(cliLog, "utf8")).trim(), "--version");
    assert.doesNotMatch(await readFile(dockerLog, "utf8"), /\bexec\b|\brm\b/);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("package, CI, and production deploy run the gate before migrations", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  const ciWorkflow = await readFile(
    path.join(repositoryRoot, ".github", "workflows", "ci.yml"),
    "utf8",
  );
  const deployWorkflow = await readFile(
    path.join(repositoryRoot, ".github", "workflows", "deploy.yml"),
    "utf8",
  );
  const resetHelper = await readFile(
    path.join(repositoryRoot, "scripts", "reset-local-database.sh"),
    "utf8",
  );
  const startHelper = await readFile(
    path.join(repositoryRoot, "scripts", "start-local-database.sh"),
    "utf8",
  );
  const runtimeVerifier = await readFile(
    path.join(repositoryRoot, "scripts", "verify-local-supabase-runtime.sh"),
    "utf8",
  );
  const schemaDriftHelper = await readFile(
    path.join(repositoryRoot, "scripts", "check-schema-drift.sh"),
    "utf8",
  );
  const postgresVersion = await readFile(
    path.join(repositoryRoot, "supabase", ".temp", "postgres-version"),
    "utf8",
  );

  assert.equal(
    packageJson.scripts["check:migrations"],
    "node scripts/check-migration-compatibility.mjs",
  );
  assert.match(
    packageJson.scripts["check:database"],
    /^pnpm run check:migrations && pnpm run test:migration-compatibility && pnpm run supabase:reset && pnpm run test:migration-atomicity/,
  );
  assert.equal(postgresVersion.trim(), "17.6.1.141");
  assert.equal(
    packageJson.scripts["supabase:reset"],
    "bash scripts/reset-local-database.sh",
  );
  assert.equal(
    packageJson.scripts["supabase:start"],
    "bash scripts/start-local-database.sh",
  );
  assert.equal(
    packageJson.scripts["test:migration-atomicity"],
    "bash scripts/test-migration-atomicity.sh",
  );
  assert.match(
    resetHelper,
    /db reset --local --no-seed --workdir[\s\S]*migration up --local --workdir/,
  );
  assert.match(resetHelper, /cli_version=.*--version/);
  assert.match(resetHelper, /cli_version" == "2\.109\.0"/);
  assert.match(
    resetHelper,
    /cp "\$postgres_version_file" "\$staging_root\/supabase\/\.temp\/postgres-version"[\s\S]*db reset --local/,
  );
  assert.match(resetHelper, /verify-local-supabase-runtime\.sh/);
  assert.match(
    resetHelper,
    /run-local-sql\.sh"\s*\\\s*\n\s*"[^"\n]*supabase\/seed\.sql"/,
  );
  assert.match(startHelper, /cli_version=.*--version/);
  assert.match(startHelper, /cli_version" == "2\.109\.0"/);
  assert.match(startHelper, /section == "migrations"[\s\S]*enabled = false/);
  assert.match(startHelper, /section == "seed"[\s\S]*enabled = false/);
  assert.match(startHelper, /db start --workdir "\$staging_root"/);
  assert.match(
    startHelper,
    /cp "\$postgres_version_file" "\$staging_root\/supabase\/\.temp\/postgres-version"[\s\S]*db start --workdir/,
  );
  assert.match(startHelper, /start --workdir "\$repository_root"/);
  assert.match(startHelper, /migration up --local --workdir "\$repository_root"/);
  assert.match(startHelper, /run-local-sql\.sh/);
  assert.match(startHelper, /17\.6\.1\.141/);
  for (const helper of [startHelper, resetHelper, runtimeVerifier]) {
    assert.match(
      helper,
      /SUPABASE_INTERNAL_IMAGE_REGISTRY:-public\.ecr\.aws/,
    );
    assert.match(helper, /postgres_image_registry%\//);
    assert.match(
      helper,
      /\$postgres_image_registry\/supabase\/postgres:\$[a-z_]+/,
    );
  }
  assert.match(startHelper, /docker_cli inspect "\$database_container"/);
  assert.match(startHelper, /verify-local-supabase-runtime\.sh/);
  assert.match(startHelper, /exit_status != 0.*owns_database/s);
  assert.match(startHelper, /volume inspect "\$database_volume"/);
  assert.doesNotMatch(startHelper, /ln -s|keep_staging/);
  assert.match(
    schemaDriftHelper,
    /--single-transaction\s*\\\s*\n\s*--file=supabase\/schema\.sql/,
  );

  const repositoryStart = startHelper.indexOf(
    '"$supabase_cli" start --workdir "$repository_root"',
  );
  const freshHistoryProof = startHelper.indexOf("fresh_history_count=0");
  const localApply = startHelper.indexOf(
    '"$supabase_cli" migration up --local --workdir "$repository_root"',
  );
  assert.ok(
    repositoryStart !== -1
      && freshHistoryProof !== -1
      && localApply !== -1
      && repositoryStart < freshHistoryProof
      && freshHistoryProof < localApply,
  );
  assert.match(
    startHelper,
    /if \[\[ "\$owns_database" == "true" \]\]; then[\s\S]*fresh_history_count/,
  );

  const ciStart = ciWorkflow.indexOf("run: pnpm run supabase:start");
  const ciGate = ciWorkflow.indexOf("run: pnpm run check:migrations");
  const ciReset = ciWorkflow.indexOf("run: pnpm run supabase:reset");
  const ciAtomicity = ciWorkflow.indexOf("run: pnpm run test:migration-atomicity");
  assert.ok(
    ciGate !== -1
      && ciStart !== -1
      && ciGate < ciStart
      && ciStart < ciReset
      && ciGate < ciReset
      && ciReset < ciAtomicity,
  );

  const deployGate = deployWorkflow.indexOf(
    "run: node scripts/check-migration-compatibility.mjs",
  );
  const deployNode = deployWorkflow.indexOf("node-version: 22");
  const deployDryRun = deployWorkflow.indexOf(
    "run: supabase db push --linked --dry-run",
  );
  const deployApply = deployWorkflow.indexOf(
    "run: supabase migration up --linked",
  );
  assert.ok(
    deployNode !== -1
      && deployGate !== -1
      && deployNode < deployGate
      && deployGate < deployDryRun
      && deployDryRun < deployApply,
  );
  assert.doesNotMatch(
    deployWorkflow,
    /run: supabase db push --linked --password/,
  );
});
