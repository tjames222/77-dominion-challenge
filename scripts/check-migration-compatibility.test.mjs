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
      "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >>\"$FAKE_DOCKER_LOG\"\nif [[ \"${1:-}\" == \"container\" && \"${2:-}\" == \"inspect\" && \"${3:-}\" == \"supabase_db_77-dominion-challenge\" ]]; then\n  if [[ \"$*\" == *--format* ]]; then echo ghcr.io/supabase/postgres:17.6.1.140; fi\n  exit 0\nfi\nif [[ \"${1:-}\" == \"volume\" && \"${2:-}\" == \"inspect\" ]]; then exit 0; fi\nexit 91\n",
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

test("local start distinguishes a preserved volume from a missing container", async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "migration-start-volume-"));
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
      "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >>\"$FAKE_DOCKER_LOG\"\nif [[ \"${1:-}\" == \"container\" && \"${2:-}\" == \"inspect\" ]]; then exit 1; fi\nif [[ \"${1:-}\" == \"volume\" && \"${2:-}\" == \"inspect\" && \"${3:-}\" == \"supabase_db_77-dominion-challenge\" ]]; then exit 0; fi\nexit 91\n",
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
        },
      },
    );

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /found preserved database volume supabase_db_77-dominion-challenge without a container/,
    );
    assert.doesNotMatch(result.stderr, /Config\.Image|existing stack uses/);
    assert.equal((await readFile(cliLog, "utf8")).trim(), "--version");
    const dockerCalls = await readFile(dockerLog, "utf8");
    assert.match(dockerCalls, /^container inspect supabase_db_77-dominion-challenge$/m);
    assert.match(dockerCalls, /^volume inspect supabase_db_77-dominion-challenge$/m);
    assert.doesNotMatch(dockerCalls, /(^|\s)rm(\s|$)|(^|\s)exec(\s|$)/m);
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
  const canonicalSchema = await readFile(
    path.join(repositoryRoot, "supabase", "schema.sql"),
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
    /^pnpm run check:migrations && pnpm run test:migration-compatibility && pnpm run test:reconciliation-stage && pnpm run test:production-backup-restore && pnpm run test:production-reconciliation && pnpm run test:database-manifest && pnpm run supabase:reset && pnpm run test:migration-atomicity/,
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
  for (const helper of [startHelper, resetHelper]) {
    assert.match(
      helper,
      /run_supabase_credential_safe\(\) \{[\s\S]*if "\$@" >\/dev\/null 2>&1; then[\s\S]*exit_status=\$\?[\s\S]*output was suppressed because it may contain local credentials/,
    );
  }
  assert.match(
    startHelper,
    /run_supabase_credential_safe "platform database bootstrap"[\s\S]*db start --workdir "\$staging_root"/,
  );
  assert.match(
    startHelper,
    /run_supabase_credential_safe "full local stack start"[\s\S]*start "\$\{start_arguments\[@\]\}"/,
  );
  assert.match(
    resetHelper,
    /run_supabase_credential_safe "platform database reset"[\s\S]*db reset --local --no-seed --workdir "\$staging_root"/,
  );
  assert.match(
    resetHelper,
    /run_supabase_credential_safe "full local stack restart"[\s\S]*start "\$\{start_arguments\[@\]\}"/,
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
  assert.match(
    startHelper,
    /CI:-.*true[\s\S]*--exclude inbucket[\s\S]*start "\$\{start_arguments\[@\]\}"/,
  );
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
  assert.match(startHelper, /docker_cli" container inspect "\$database_container"/);
  assert.doesNotMatch(startHelper, /docker_cli" inspect "\$database_container"/);
  assert.match(startHelper, /verify-local-supabase-runtime\.sh/);
  assert.match(startHelper, /exit_status != 0.*owns_database/s);
  assert.match(startHelper, /volume inspect "\$database_volume"/);
  assert.doesNotMatch(startHelper, /ln -s|keep_staging/);
  assert.match(
    schemaDriftHelper,
    /--single-transaction\s*\\\s*\n\s*--file=supabase\/schema\.sql/,
  );
  assert.deepEqual(migrationCompatibilityViolations(canonicalSchema), []);

  const repositoryStart = startHelper.indexOf(
    '"$supabase_cli" start "${start_arguments[@]}"',
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
    'db push --db-url="$database_url" --dry-run',
  );
  const deploySecretTopology = deployWorkflow.indexOf(
    "name: Validate Edge Function secret topology",
  );
  const deployCredentialPreparation = deployWorkflow.indexOf(
    "--credential-only",
    deploySecretTopology,
  );
  const deployApply = deployWorkflow.indexOf(
    'migration up --db-url="$database_url"',
  );
  const deploySecretSync = deployWorkflow.indexOf(
    "name: Synchronize Edge Function secrets",
  );
  const deployCompletedHistory = deployWorkflow.indexOf(
    "name: Require exact completed migration history",
    deployApply,
  );
  const deployCutoverPlan = deployWorkflow.indexOf(
    "node scripts/verify-production-raw-migration-history.mjs",
    deployGate,
  );
  const deployCutoverAttestation = deployWorkflow.indexOf(
    'attestation_name="production-compatibility-cutover-${GITHUB_SHA}"',
  );
  const deployAttestationDownload = deployWorkflow.indexOf(
    "name: Download the exact keyed compatibility attestation",
  );
  const deployAttestationPreverify = deployWorkflow.indexOf(
    "name: Verify exact canary continuity before migration",
  );
  const deployAttestationPostverify = deployWorkflow.indexOf(
    "name: Reverify exact canary continuity after migration",
  );
  assert.doesNotMatch(deployWorkflow, /\bsupabase\s+link\b|--linked\b/u);
  assert.doesNotMatch(deployWorkflow, /\bset\s+-x(?:\s|$)/mu);
  assert.doesNotMatch(
    deployWorkflow,
    /\b(?:db\s+reset|migration\s+repair)\b/u,
  );
  assert.doesNotMatch(deployWorkflow, /SUPABASE_DB_PASSWORD|--password/u);
  assert.equal(
    deployWorkflow.match(
      /SUPABASE_ACCESS_TOKEN="\$SUPABASE_ACCESS_TOKEN"/gu,
    )?.length,
    15,
  );
  assert.equal(deployWorkflow.split("--credential-only").length - 1, 6);
  assert.equal(deployWorkflow.split("--revoke-credentials").length - 1, 9);
  assert.equal(
    deployWorkflow.split(
      'if [[ "$(<"${credential_directory}/credential-ready")" != "$SUPABASE_PROJECT_REF" ]]; then',
    ).length - 1,
    6,
  );
  assert.equal(
    deployWorkflow.split(
      "for credential_file in database-url database-passfile credential-ready; do",
    ).length - 1,
    6,
  );
  assert.equal(
    deployWorkflow.split(
      'database_url="$(<"${credential_directory}/database-url")"',
    ).length - 1,
    6,
  );
  assert.equal(
    deployWorkflow.split(
      'PGPASSFILE="${credential_directory}/database-passfile"',
    ).length - 1,
    6,
  );
  assert.equal(
    deployWorkflow.split('--db-url="$database_url"').length - 1,
    6,
  );
  assert.equal(
    deployWorkflow.match(/migration list --db-url="\$database_url"/gu)?.length,
    4,
  );
  assert.equal(
    deployWorkflow.match(/db push --db-url="\$database_url" --dry-run/gu)?.length,
    1,
  );
  assert.equal(
    deployWorkflow.match(/migration up --db-url="\$database_url"/gu)?.length,
    1,
  );

  const cleanCredentialPreparations = deployWorkflow.match(
    /\/usr\/bin\/env -i \\\n\s+HOME="\$supabase_home" \\\n\s+LANG=C\.UTF-8 \\\n\s+PATH="\$PATH" \\\n\s+SUPABASE_ACCESS_TOKEN="\$SUPABASE_ACCESS_TOKEN" \\\n\s+SUPABASE_PROJECT_REF="\$SUPABASE_PROJECT_REF" \\\n\s+SUPABASE_TELEMETRY_DISABLED=1 \\\n\s+TMPDIR="\$supabase_home" \\\n\s+node scripts\/prepare-existing-supabase-cli-state\.mjs \\\n\s+--credential-only \\\n\s+--probe-workdir "\$probe_workdir" \\\n\s+--credential-directory "\$credential_directory" \\\n\s+--supabase-home "\$supabase_home"/gu,
  ) ?? [];
  assert.equal(cleanCredentialPreparations.length, 6);

  const cleanCredentialRevocations = deployWorkflow.match(
    /\/usr\/bin\/env -i \\\n\s+HOME="\$supabase_home" \\\n\s+LANG=C\.UTF-8 \\\n\s+PATH="\$PATH" \\\n\s+SUPABASE_ACCESS_TOKEN="\$SUPABASE_ACCESS_TOKEN" \\\n\s+SUPABASE_PROJECT_REF="\$SUPABASE_PROJECT_REF" \\\n\s+SUPABASE_TELEMETRY_DISABLED=1 \\\n\s+TMPDIR="\$supabase_home" \\\n\s+node scripts\/prepare-existing-supabase-cli-state\.mjs \\\n\s+--revoke-credentials \|\| cleanup_status=\$\?/gu,
  ) ?? [];
  assert.equal(cleanCredentialRevocations.length, 6);

  const finalRemoteRevocations = deployWorkflow.match(
    /- name: Revoke any remaining (?:compatibility|frontend-history|backend) database login roles\n\s+if: always\(\)\n\s+shell: bash\n\s+run: \|\n\s+\/usr\/bin\/env -i \\\n\s+LANG=C\.UTF-8 \\\n\s+PATH="\$PATH" \\\n\s+SUPABASE_ACCESS_TOKEN="\$SUPABASE_ACCESS_TOKEN" \\\n\s+SUPABASE_PROJECT_REF="\$SUPABASE_PROJECT_REF" \\\n\s+SUPABASE_TELEMETRY_DISABLED=1 \\\n\s+node scripts\/prepare-existing-supabase-cli-state\.mjs \\\n\s+--revoke-credentials/gu,
  ) ?? [];
  assert.equal(finalRemoteRevocations.length, 3);

  const privateDatabaseCliLaunches = deployWorkflow.match(
    /\/usr\/bin\/env -i \\\n\s+CI=1 \\\n\s+HOME="\$supabase_home" \\\n\s+LANG=C\.UTF-8 \\\n\s+PATH="\$PATH" \\\n\s+PGPASSFILE="\$\{credential_directory\}\/database-passfile" \\\n\s+SUPABASE_HOME="\$supabase_home" \\\n\s+SUPABASE_NO_KEYRING=1 \\\n\s+SUPABASE_PROFILE=supabase \\\n\s+SUPABASE_TELEMETRY_DISABLED=1 \\\n\s+TMPDIR="\$supabase_home" \\\n\s+supabase --profile=supabase --workdir="\$GITHUB_WORKSPACE" \\\n\s+[^\n]*--db-url="\$database_url"/gu,
  ) ?? [];
  assert.equal(privateDatabaseCliLaunches.length, 6);

  const databaseUrlVariableLines = deployWorkflow.split("\n").filter((line) =>
    line.includes("database_url")
  );
  assert.equal(databaseUrlVariableLines.length, 18);
  for (const line of databaseUrlVariableLines) {
    assert.match(
      line,
      /^\s+(?:unset database_url|database_url="\$\(<"\$\{credential_directory\}\/database-url"\)"|[^\n]*--db-url="\$database_url"[^\n]*)$/u,
    );
  }
  const databaseUrlFileLines = deployWorkflow.split("\n").filter((line) =>
    line.includes("database-url")
  );
  assert.equal(databaseUrlFileLines.length, 12);
  for (const line of databaseUrlFileLines) {
    assert.match(
      line,
      /^\s+(?:for credential_file in database-url database-passfile credential-ready; do|database_url="\$\(<"\$\{credential_directory\}\/database-url"\)")$/u,
    );
  }
  assert.doesNotMatch(deployWorkflow, /\bGITHUB_ENV\b/u);
  for (const line of deployWorkflow.split("\n").filter((entry) =>
    entry.includes("GITHUB_OUTPUT")
  )) {
    assert.doesNotMatch(
      line,
      /database_url|database-url|database-passfile|credential_directory|PGPASSFILE/u,
    );
  }
  for (const line of deployWorkflow.split("\n").filter((entry) =>
    /\b(?:echo|printf|cat|tee)\b/u.test(entry)
  )) {
    assert.doesNotMatch(
      line,
      /database_url|database-url|database-passfile|credential_directory|PGPASSFILE/u,
    );
  }
  assert.match(
    deployWorkflow,
    /verify-production-raw-migration-history\.mjs --cli-history "\$history_file" --mode-only/u,
  );
  assert.ok(
    deployNode !== -1
      && deployGate !== -1
      && deployNode < deployGate
      && deployGate < deployDryRun
      && deploySecretTopology > deployGate
      && deploySecretTopology < deployCredentialPreparation
      && deployCredentialPreparation < deployDryRun
      && deployCutoverPlan !== -1
      && deployCutoverPlan < deployDryRun
      && deployCutoverAttestation > deployCutoverPlan
      && deployCutoverAttestation < deployAttestationDownload
      && deployAttestationDownload < deployAttestationPreverify
      && deployAttestationPreverify < deployDryRun
      && deployDryRun < deployApply
      && deployApply < deployCompletedHistory
      && deployCompletedHistory < deployAttestationPostverify
      && deployAttestationPostverify < deploySecretSync,
  );
  assert.match(
    deployWorkflow,
    /supabase --profile=supabase --workdir="\$GITHUB_WORKSPACE" \\\n\s+--agent=no --yes db push --db-url="\$database_url" --dry-run/u,
  );
  assert.match(
    deployWorkflow,
    /post_migration_history[\s\S]*verify-production-raw-migration-history\.mjs[\s\S]*--require-no-pending/u,
  );
  assert.match(
    deployWorkflow,
    /\.total_count == 1 and \(\[\.artifacts\[\][\s\S]*\.id > 0 and \.workflow_run\.id > 0[\s\S]*length == 1/u,
  );
  assert.match(
    deployWorkflow,
    /\.path == "\.github\/workflows\/deploy\.yml"[\s\S]*\.event == "workflow_dispatch"[\s\S]*\.head_branch == "main"[\s\S]*\.head_sha == \$expected_sha[\s\S]*\.status == "completed"[\s\S]*\.conclusion == "success"/u,
  );
  assert.match(deployWorkflow, /attestation_age > 604800/u);
  assert.match(deployWorkflow, /attestation_retention < 604500/u);
  assert.match(deployWorkflow, /attestation_retention > 605100/u);
  assert.match(
    deployWorkflow,
    /attestation_artifact_id" =~ \^\[1-9\]\[0-9\]\*\$[\s\S]*attestation_run_id" =~ \^\[1-9\]\[0-9\]\*\$/u,
  );
  assert.match(
    deployWorkflow,
    /artifact-ids: \$\{\{ steps\.cutover-plan\.outputs\.attestation_artifact_id \}\}[\s\S]*merge-multiple: true[\s\S]*github-token: \$\{\{ github\.token \}\}[\s\S]*repository: \$\{\{ github\.repository \}\}[\s\S]*run-id: \$\{\{ steps\.cutover-plan\.outputs\.attestation_run_id \}\}/u,
  );
  assert.match(
    deployWorkflow,
    /! -f "\$attestation_file" \|\| -L "\$attestation_file"[\s\S]*attestation_entries[\s\S]*attestation_size > 1024/u,
  );
  assert.equal(
    deployWorkflow.match(/--attestation-input/g)?.length,
    2,
  );

  const compatibilityJobStart = deployWorkflow.indexOf("  compatibility-guards:");
  const frontendRollbackHistoryStart = deployWorkflow.indexOf(
    "  frontend-rollback-history:",
  );
  const backendJobStart = deployWorkflow.indexOf("  backend:");
  const compatibilityFinalRevocation = deployWorkflow.indexOf(
    "name: Revoke any remaining compatibility database login roles",
  );
  const frontendFinalRevocation = deployWorkflow.indexOf(
    "name: Revoke any remaining frontend-history database login roles",
  );
  const backendFinalRevocation = deployWorkflow.indexOf(
    "name: Revoke any remaining backend database login roles",
  );
  assert.ok(
    compatibilityJobStart !== -1
      && frontendRollbackHistoryStart !== -1
      && backendJobStart !== -1
      && compatibilityFinalRevocation !== -1
      && frontendFinalRevocation !== -1
      && backendFinalRevocation !== -1
      && compatibilityJobStart < frontendRollbackHistoryStart
      && compatibilityFinalRevocation < frontendRollbackHistoryStart
      && frontendRollbackHistoryStart < frontendFinalRevocation
      && frontendFinalRevocation < backendJobStart
      && backendJobStart < backendFinalRevocation,
  );
  const compatibilityJob = deployWorkflow.slice(
    compatibilityJobStart,
    frontendRollbackHistoryStart,
  );
  assert.match(
    compatibilityJob,
    /if: inputs\.release_scope == 'compatibility-cutover'/u,
  );
  assert.match(compatibilityJob, /BILLING_ENABLED: "false"/u);
  const disabledSecret = compatibilityJob.indexOf(
    '"BILLING_ENABLED=${BILLING_ENABLED}"',
  );
  const compatibilityCredentials = compatibilityJob.indexOf("--credential-only");
  const compatibilityRawHistory = compatibilityJob.indexOf(
    "verify-production-raw-migration-history.mjs",
  );
  const compatibilityCanaryGate = compatibilityJob.indexOf(
    "verify-production-canary-cutover-gate.mjs",
  );
  const webhookDeploy = compatibilityJob.indexOf(
    'supabase functions deploy stripe-webhook --project-ref "$SUPABASE_PROJECT_REF" --no-verify-jwt',
  );
  const webhook503 = compatibilityJob.indexOf(
    'if [[ "$webhook_status" != "503" ]]',
  );
  const authenticatedDeploy = compatibilityJob.indexOf(
    'supabase functions deploy cancel-membership --project-ref "$SUPABASE_PROJECT_REF"',
  );
  const authenticated401 = compatibilityJob.indexOf(
    'if [[ "$billing_status" != "401" ]]',
  );
  const compatibilityCleanup = compatibilityJob.indexOf(
    "name: Revoke any remaining compatibility database login roles",
  );
  assert.ok(
    compatibilityCredentials !== -1
      && compatibilityRawHistory !== -1
      && compatibilityCanaryGate !== -1
      && disabledSecret !== -1
      && webhookDeploy !== -1
      && webhook503 !== -1
      && authenticatedDeploy !== -1
      && authenticated401 !== -1
      && compatibilityCleanup !== -1
      && compatibilityCredentials < compatibilityRawHistory
      && compatibilityRawHistory < compatibilityCanaryGate
      && compatibilityCanaryGate < disabledSecret
      && disabledSecret < webhookDeploy
      && webhookDeploy < webhook503
      && webhook503 < authenticatedDeploy
      && authenticatedDeploy < authenticated401
      && authenticated401 < compatibilityCleanup,
  );
  assert.equal(
    compatibilityJob.match(/migration list --db-url="\$database_url"/gu)?.length,
    1,
  );
  assert.equal(
    compatibilityJob.match(/--db-url="\$database_url"/gu)?.length,
    1,
  );
  assert.doesNotMatch(
    compatibilityJob,
    /\b(?:migration\s+up|db\s+push|db\s+reset|migration\s+repair)\b/u,
  );
  assert.match(
    deployWorkflow,
    /inputs\.release_scope == 'frontend-only'[\s\S]*needs\.backend\.result == 'skipped'[\s\S]*needs\.compatibility-guards\.result == 'skipped'/u,
  );
  const frontendRollbackHistoryJob = deployWorkflow.slice(
    frontendRollbackHistoryStart,
    backendJobStart,
  );
  assert.match(
    frontendRollbackHistoryJob,
    /if: inputs\.release_scope == 'frontend-only'/u,
  );
  assert.match(frontendRollbackHistoryJob, /verify-production-raw-migration-history\.mjs/u);
  assert.match(frontendRollbackHistoryJob, /--require-no-pending/u);
  assert.match(frontendRollbackHistoryJob, /"post-cutover"/u);
  assert.ok(
    frontendRollbackHistoryJob.indexOf("verify-production-raw-migration-history.mjs")
      < frontendRollbackHistoryJob.indexOf(
        "name: Revoke any remaining frontend-history database login roles",
      ),
  );
  assert.equal(
    frontendRollbackHistoryJob.match(
      /migration list --db-url="\$database_url"/gu,
    )?.length,
    1,
  );
  assert.equal(
    frontendRollbackHistoryJob.match(/--db-url="\$database_url"/gu)?.length,
    1,
  );
  assert.doesNotMatch(
    frontendRollbackHistoryJob,
    /supabase (?:migration up|db push|secrets set|functions deploy)/u,
  );
  assert.doesNotMatch(
    frontendRollbackHistoryJob,
    /\b(?:migration\s+up|db\s+push|db\s+reset|migration\s+repair)\b/u,
  );
  assert.match(
    deployWorkflow,
    /inputs\.release_scope == 'frontend-only'[\s\S]*needs\.frontend-rollback-history\.result == 'success'/u,
  );

  const frontendJobStart = deployWorkflow.indexOf("  frontend:");
  const backendJob = deployWorkflow.slice(backendJobStart, frontendJobStart);
  assert.ok(
    deploySecretSync < backendFinalRevocation
      && backendFinalRevocation < frontendJobStart,
  );
  assert.equal(
    backendJob.match(/migration list --db-url="\$database_url"/gu)?.length,
    2,
  );
  assert.equal(
    backendJob.match(/db push --db-url="\$database_url" --dry-run/gu)?.length,
    1,
  );
  assert.equal(
    backendJob.match(/migration up --db-url="\$database_url"/gu)?.length,
    1,
  );
  assert.equal(
    backendJob.match(/--db-url="\$database_url"/gu)?.length,
    4,
  );
  assert.doesNotMatch(backendJob, /\b(?:db\s+reset|migration\s+repair)\b/u);

  const topologyStep = deployWorkflow.slice(
    deploySecretTopology,
    deployCredentialPreparation,
  );
  assert.match(topologyStep, /PROFILE_PHOTO_WORKER_SECRET must contain at least 32/u);
  assert.match(topologyStep, /INTEGRATION_WORKER_SECRET requires INTEGRATION_CREDENTIAL_KEYS/u);
  assert.match(topologyStep, /must be configured together/u);
  assert.match(topologyStep, /must be configured as a complete set/u);
  const synchronizationStep = deployWorkflow.slice(deploySecretSync);
  assert.doesNotMatch(
    synchronizationStep,
    /PROFILE_PHOTO_WORKER_SECRET must contain|requires INTEGRATION_CREDENTIAL_KEYS|must be configured together|must be configured as a complete set/u,
  );
  const cloudflareDeploy = deployWorkflow.indexOf("pages deploy dist");
  const compatibilityAttestationCreate = deployWorkflow.indexOf(
    "name: Create keyed one-time compatibility attestation",
  );
  const compatibilityAttestationUpload = deployWorkflow.indexOf(
    "name: Publish keyed one-time compatibility attestation",
  );
  assert.ok(
    cloudflareDeploy !== -1
      && compatibilityAttestationCreate > cloudflareDeploy
      && compatibilityAttestationUpload > compatibilityAttestationCreate,
  );
  assert.match(
    deployWorkflow,
    /name: Create keyed one-time compatibility attestation[\s\S]*--attestation-output "\$\{attestation_directory\}\/production-canary-attestation\.json"[\s\S]*name: Publish keyed one-time compatibility attestation[\s\S]*name: production-compatibility-cutover-\$\{\{ github\.sha \}\}[\s\S]*path: \$\{\{ runner\.temp \}\}\/production-canary-attestation\/production-canary-attestation\.json[\s\S]*if-no-files-found: error[\s\S]*retention-days: 7/u,
  );
  const compatibilityAttestationSection = deployWorkflow.slice(
    compatibilityAttestationCreate,
  );
  assert.doesNotMatch(
    compatibilityAttestationSection,
    /dist\/index\.html|canary_grant_fingerprint|\buser_id\b|\bsource_id\b|\bcat\b/u,
  );
});

test("local Supabase lifecycle wrappers suppress credentials and preserve status", async () => {
  const helpers = await Promise.all([
    readFile(
      path.join(repositoryRoot, "scripts", "start-local-database.sh"),
      "utf8",
    ),
    readFile(
      path.join(repositoryRoot, "scripts", "reset-local-database.sh"),
      "utf8",
    ),
  ]);

  for (const helper of helpers) {
    const functionSource = helper.match(
      /run_supabase_credential_safe\(\) \{[\s\S]*?^\}/m,
    )?.[0];
    assert.ok(functionSource);

    const failure = spawnSync(
      "bash",
      [
        "-c",
        `${functionSource}\nemit_secret() { printf '%s\\n' LOCAL_SECRET_SENTINEL; printf '%s\\n' LOCAL_SECRET_ERROR >&2; return 73; }\nrun_supabase_credential_safe 'test lifecycle' emit_secret`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(failure.status, 73);
    assert.equal(failure.stdout, "");
    assert.doesNotMatch(failure.stderr, /LOCAL_SECRET/);
    assert.match(failure.stderr, /output was suppressed/);

    const success = spawnSync(
      "bash",
      [
        "-c",
        `${functionSource}\nemit_secret() { printf '%s\\n' LOCAL_SECRET_SENTINEL; printf '%s\\n' LOCAL_SECRET_ERROR >&2; return 0; }\nrun_supabase_credential_safe 'test lifecycle' emit_secret`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(success.status, 0);
    assert.equal(success.stdout, "");
    assert.equal(success.stderr, "");
  }
});

test("local runtime verification avoids empty arrays under Bash 3.2 nounset", async () => {
  const resetHelper = await readFile(
    path.join(repositoryRoot, "scripts", "reset-local-database.sh"),
    "utf8",
  );
  const functionSource = resetHelper.match(
    /verify_local_supabase_runtime\(\) \{[\s\S]*?^\}/m,
  )?.[0];
  assert.ok(functionSource);
  assert.doesNotMatch(functionSource, /\[@\]/);

  const result = spawnSync(
    "/bin/bash",
    [
      "-u",
      "-c",
      `${functionSource}\nrepository_root=/verified/repository\nbash() { printf '<%s>\\n' "$*"; }\nverify_local_supabase_runtime false\nverify_local_supabase_runtime true`,
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), [
    "</verified/repository/scripts/verify-local-supabase-runtime.sh>",
    "</verified/repository/scripts/verify-local-supabase-runtime.sh --database-only>",
  ]);
});

test("the production baseline fails closed and normalizes legacy privileges", async () => {
  const baseline = await readFile(
    path.join(
      repositoryRoot,
      "supabase",
      "migrations",
      "20260707170000_baseline.sql",
    ),
    "utf8",
  );
  const gamification = await readFile(
    path.join(
      repositoryRoot,
      "supabase",
      "migrations",
      "20260708154000_gamification.sql",
    ),
    "utf8",
  );
  const searchPathFix = await readFile(
    path.join(
      repositoryRoot,
      "supabase",
      "migrations",
      "20260708155500_fix_gamification_function_search_path.sql",
    ),
    "utf8",
  );
  const rehearsal = await readFile(
    path.join(repositoryRoot, "scripts", "rehearse-baseline-reconciliation.sh"),
    "utf8",
  );

  for (const migration of [baseline, gamification, searchPathFix]) {
    assert.match(migration, /set local lock_timeout = '5s';/);
    assert.match(migration, /set local statement_timeout = '5min';/);
    assert.match(
      migration,
      /set local idle_in_transaction_session_timeout = '5min';/,
    );
  }

  assert.match(
    baseline,
    /set local transaction isolation level read committed;/,
  );
  assert.doesNotMatch(baseline, /transaction isolation level serializable/);

  for (const migration of [baseline, gamification]) {
    assert.match(migration, /lock table %s in share row exclusive mode/);
    assert.doesNotMatch(migration, /lock table %s in access exclusive mode/);
  }
  assert.match(
    baseline,
    /lock table %s in access share mode/,
  );
  assert.match(
    baseline,
    /relation_owner is distinct from 'supabase_storage_admin'/,
  );
  assert.match(
    baseline,
    /namespace\.nspname = 'storage'\s+and relation\.relname in \('buckets_vectors', 'vector_indexes'\)/,
  );
  const vectorGuardStart = baseline.indexOf("if is_vector_inventory then");
  const vectorGuardEnd = baseline.indexOf("raise exception using", vectorGuardStart);
  assert.ok(vectorGuardStart !== -1 && vectorGuardEnd > vectorGuardStart);
  const vectorGuard = baseline
    .slice(vectorGuardStart, vectorGuardEnd)
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")");
  const platformGuardStart = rehearsal.indexOf(
    "if relation_record.owner_name is distinct from 'supabase_storage_admin'",
  );
  const platformGuardEnd = rehearsal.indexOf(
    "raise exception 'unexpected platform vector lock contract",
    platformGuardStart,
  );
  assert.ok(platformGuardStart !== -1 && platformGuardEnd > platformGuardStart);
  const platformGuard = rehearsal
    .slice(platformGuardStart, platformGuardEnd)
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")");

  assert.match(
    vectorGuard,
    /relation_owner is distinct from 'supabase_storage_admin' or not pg_catalog\.has_table_privilege\(current_user, relation_oid, 'SELECT'\)/,
  );
  assert.match(
    platformGuard,
    /relation_record\.owner_name is distinct from 'supabase_storage_admin' or not pg_catalog\.has_table_privilege\(current_user, relation_record\.oid, 'SELECT'\)/,
  );
  for (const [guard, relationOid] of [
    [vectorGuard, "relation_oid"],
    [platformGuard, "relation_record\\.oid"],
  ]) {
    assert.match(
      guard,
      new RegExp(
        `or pg_catalog\\.has_table_privilege\\(current_user, ${relationOid}, 'SELECT WITH GRANT OPTION'\\)`,
      ),
    );
    for (const privilege of [
      "INSERT",
      "UPDATE",
      "DELETE",
      "TRUNCATE",
      "REFERENCES",
      "TRIGGER",
      "MAINTAIN",
    ]) {
      assert.match(
        guard,
        new RegExp(
          `or pg_catalog\\.has_table_privilege\\(current_user, ${relationOid}, '${privilege}'\\)`,
        ),
      );
    }
    assert.match(
      guard,
      new RegExp(
        `or pg_catalog\\.has_any_column_privilege\\(current_user, ${relationOid}, 'SELECT WITH GRANT OPTION'\\)`,
      ),
    );
    for (const privilege of ["INSERT", "UPDATE", "REFERENCES"]) {
      assert.match(
        guard,
        new RegExp(
          `or pg_catalog\\.has_any_column_privilege\\(current_user, ${relationOid}, '${privilege}'\\)`,
        ),
      );
    }
  }
  assert.match(baseline, /locked_vector_relation_count <> 2/);
  assert.match(
    baseline,
    /order by namespace\.nspname collate "C", relation\.relname collate "C"[\s\S]*if is_vector_inventory then[\s\S]*access share mode[\s\S]*else[\s\S]*share row exclusive mode/,
  );
  assert.ok(
    baseline.indexOf('$baseline_locks$;')
      < baseline.indexOf('do $baseline_data_preflight$'),
  );
  assert.ok(
    baseline.indexOf('$baseline_data_preflight$;')
      < baseline.indexOf('alter default privileges for role postgres'),
  );
  assert.match(baseline, /select exists \(select 1 from public\.purchases\)/);
  assert.match(
    baseline,
    /entitlement_key is distinct from 'membership_active'/,
  );
  assert.doesNotMatch(baseline, /delete from public\.entitlements/i);
  assert.match(baseline, /drop table if exists public\.purchases restrict;/);
  assert.match(baseline, /drop view if exists public\.community_feed restrict;/);
  assert.doesNotMatch(baseline, /drop (?:table|view)[^;]+cascade;/i);

  for (const migration of [baseline, gamification]) {
    assert.match(
      migration,
      /alter default privileges for role postgres in schema public[\s\S]*revoke all privileges on tables from public, anon, authenticated, service_role;/,
    );
    assert.match(
      migration,
      /revoke all privileges \(%s\) on table %s from public, anon, authenticated, service_role/,
    );
  }

  assert.match(
    baseline,
    /grant select on public\.profiles to service_role;/,
  );
  for (const table of ["billing_customers", "subscriptions", "entitlements"]) {
    assert.match(
      baseline,
      new RegExp(
        `grant select, insert, update on public\\.${table} to service_role;`,
      ),
    );
  }
  assert.doesNotMatch(
    gamification,
    /grant[^;]+(?:badge_definitions|user_badges|user_game_stats|game_point_events)[^;]+service_role/i,
  );
  assert.match(
    searchPathFix,
    /revoke execute on function public\.workout_difficulty_points\(text\)[\s\S]*from public, anon, authenticated, service_role;/,
  );
  assert.match(
    searchPathFix,
    /revoke execute on function public\.full_streak_bonus_points\(integer\)[\s\S]*from public, anon, authenticated, service_role;/,
  );
});
