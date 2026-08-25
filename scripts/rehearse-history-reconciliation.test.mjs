import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  HISTORICAL_RECONCILIATION_VERSIONS,
} from "./prepare-reconciliation-stage.mjs";
import {
  parseManifestText,
} from "./compare-database-manifests.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const rehearsalPath = path.join(
  scriptDirectory,
  "rehearse-history-reconciliation.sh",
);
const packagePath = path.join(repositoryRoot, "package.json");
const fixtureDirectory = path.join(
  repositoryRoot,
  "supabase",
  "tests",
  "reconciliation",
);

const expectedMigrationNames = [
  "20260707170000_baseline.sql",
  "20260708154000_gamification.sql",
  "20260708155500_fix_gamification_function_search_path.sql",
  "20260708160000_align_gamification_schema.sql",
  "20260709163000_single_daily_badges_and_completion.sql",
  "20260710120000_full_day_streak_badges.sql",
  "20260710123000_profile_avatar.sql",
  "20260713120000_configurable_workout_difficulty_points.sql",
  "20260714120000_private_group_community.sql",
  "20260715190000_challenge_unlock_progression.sql",
  "20260716061500_double_challenge_unlock_thresholds.sql",
  "20260716153000_community_profile_images.sql",
  "20260716163000_prevent_duplicate_daily_check_ins.sql",
];

const rejectedEnvironment = [
  "SUPABASE_ACCESS_TOKEN",
  "SUPABASE_DB_PASSWORD",
  "SUPABASE_DB_URL",
  "SUPABASE_PROJECT_REF",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "DATABASE_URL",
  "POSTGRES_URL",
  "PGHOST",
  "PGPORT",
  "PGDATABASE",
  "PGUSER",
  "PGPASSWORD",
  "PGPASSFILE",
  "PGSERVICE",
  "PGSERVICEFILE",
];

function git(argumentsList) {
  const result = spawnSync("git", argumentsList, {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function cleanEnvironment(overrides = {}) {
  const environment = { ...process.env };
  for (const variableName of rejectedEnvironment) delete environment[variableName];
  return { ...environment, ...overrides };
}

async function makeFakeBoundary({ cliVersion = "2.109.0", projectLabel } = {}) {
  const fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), "fou762-history-boundary-"),
  );
  const logPath = path.join(fixtureRoot, "calls.log");
  const fakeSupabase = path.join(fixtureRoot, "supabase");
  const fakeDocker = path.join(fixtureRoot, "docker");
  await writeFile(
    fakeSupabase,
    `#!/bin/sh
printf 'supabase:%s\\n' "$*" >>"$FAKE_RECONCILIATION_LOG"
if [ "$1" = "--version" ]; then
  printf '%s\\n' '${cliVersion}'
  exit 0
fi
exit 97
`,
  );
  await writeFile(
    fakeDocker,
    `#!/bin/sh
printf 'docker:%s\\n' "$*" >>"$FAKE_RECONCILIATION_LOG"
if [ "$1" = "container" ] && [ "$2" = "inspect" ]; then
  case "$5" in
    '{{.Config.Image}}')
      printf '%s\\n' 'public.ecr.aws/supabase/postgres:17.6.1.141'
      ;;
    *com.supabase.cli.project*)
      printf '%s\\n' '${projectLabel ?? "wrong-project"}'
      ;;
    *com.docker.compose.project*)
      printf '%s\\n' '77-dominion-challenge'
      ;;
    *)
      exit 96
      ;;
  esac
  exit 0
fi
exit 95
`,
  );
  await chmod(fakeSupabase, 0o700);
  await chmod(fakeDocker, 0o700);
  return { fakeDocker, fakeSupabase, fixtureRoot, logPath };
}

async function readLog(logPath) {
  try {
    return await readFile(logPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

test("pins the exact cumulative 1-13 migration inventory", async () => {
  const migrationDirectory = path.join(repositoryRoot, "supabase", "migrations");
  const rehearsalSource = await readFile(rehearsalPath, "utf8");
  const versionBlock = /migration_versions=\(\n(?<versions>[\s\S]*?)\n\)/u.exec(
    rehearsalSource,
  );
  assert.ok(versionBlock?.groups?.versions);
  const rehearsalVersions = versionBlock.groups.versions
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const actualNames = expectedMigrationNames.map((name) =>
    git(["ls-tree", "--name-only", "HEAD", `supabase/migrations/${name}`])
      .replace("supabase/migrations/", "")
  );
  assert.deepEqual(actualNames, expectedMigrationNames);
  assert.deepEqual(
    expectedMigrationNames.map((name) => name.slice(0, 14)),
    HISTORICAL_RECONCILIATION_VERSIONS,
  );
  assert.deepEqual(rehearsalVersions, HISTORICAL_RECONCILIATION_VERSIONS);
  assert.equal(migrationDirectory.endsWith("supabase/migrations"), true);
});

test("package checks run both staging tests and include them in database validation", async () => {
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  assert.equal(
    packageJson.scripts["test:reconciliation-stage"],
    "node --test scripts/prepare-reconciliation-stage.test.mjs scripts/rehearse-history-reconciliation.test.mjs",
  );
  assert.equal(
    packageJson.scripts["rehearse:history-reconciliation"],
    "bash scripts/rehearse-history-reconciliation.sh",
  );
  assert.match(
    packageJson.scripts["check:database"],
    /pnpm run test:reconciliation-stage/u,
  );
});

test("static contract is local-only, one-version-at-a-time, and checkpointed", async () => {
  const source = await readFile(rehearsalPath, "utf8");
  assert.match(source, /\^\[0-9a-f\]\{40\}\$/u);
  assert.match(source, /public\.ecr\.aws\/supabase\/postgres:\$\{expected_postgres_version\}/u);
  assert.match(source, /com\.supabase\.cli\.project/u);
  assert.match(source, /com\.docker\.compose\.project/u);
  assert.match(source, /expected_server_version_num="170006"/u);
  assert.match(source, /legacy-migration-2-overlay\.sql/u);
  assert.match(source, /90000000-0000-4000-8000-000000000009/u);
  assert.match(source, /assert_release_file_matches/u);
  assert.match(source, /assert_head_file_matches/u);
  assert.match(source, /current committed integration head/u);
  assert.match(source, /prepare-reconciliation-stage\.mjs/u);
  assert.match(source, /--through-version "\$migration_version"/u);
  assert.match(source, /assert_history_prefix \$\(\(stage_number - 1\)\)/u);
  assert.match(source, /assert_history_prefix "\$stage_number"/u);
  assert.match(source, /migration up[\s\S]*--db-url "\$local_database_url"/u);
  assert.match(
    source,
    /postgresql:\/\/postgres:postgres@127\.0\.0\.1:54322\/\$\{database_name\}/u,
  );
  assert.match(source, /stage_number" == "3" \|\| "\$stage_number" == "13"/u);
  assert.match(source, /migration-3\.target\.fingerprint\.jsonl/u);
  assert.match(source, /migration-13\.target\.manifest\.jsonl/u);
  assert.match(source, /migration-13\.target\.fingerprint\.jsonl/u);
  assert.match(source, /REGENERATE_AFTER_HISTORY_RECONCILIATION_REHEARSAL/u);
  assert.match(source, /verify_owned_database/u);
  assert.match(source, /fou762_history_rehearsal\.ownership/u);
  assert.match(source, /drop_owned_database/u);
  assert.doesNotMatch(source, /--linked/u);
  assert.doesNotMatch(source, /\bdb[ ]+reset\b/u);
  assert.doesNotMatch(source, /\bmigration[ ]+repair\b/u);
  assert.doesNotMatch(source, /\bdb[ ]+push\b/u);
  assert.doesNotMatch(source, /\bsupabase[ ]+link\b/u);
  assert.doesNotMatch(source, /api\.supabase\.com/u);
  assert.doesNotMatch(source, /mimolwojppbtsbvtqwpo/u);
});

test("frozen checkpoint artifacts are canonical JSONL once generated", async () => {
  for (const fileName of [
    "migration-3.target.fingerprint.jsonl",
    "migration-13.target.manifest.jsonl",
    "migration-13.target.fingerprint.jsonl",
  ]) {
    const contents = await readFile(path.join(fixtureDirectory, fileName), "utf8");
    assert.doesNotMatch(
      contents,
      /^REGENERATE_AFTER_HISTORY_RECONCILIATION_REHEARSAL$/mu,
    );
    assert.ok(parseManifestText(contents, fileName).size > 0);
  }
});

test("hosted configuration is rejected before any fake boundary call", async () => {
  const boundary = await makeFakeBoundary();
  try {
    const result = spawnSync(
      "bash",
      [rehearsalPath, "--release-commit", git(["rev-parse", "HEAD"])],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: cleanEnvironment({
          DOCKER_BIN: boundary.fakeDocker,
          FAKE_RECONCILIATION_LOG: boundary.logPath,
          SUPABASE_CLI_BIN: boundary.fakeSupabase,
          SUPABASE_DB_URL: "postgresql://hosted.invalid/postgres",
        }),
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SUPABASE_DB_URL must be unset/u);
    assert.equal(await readLog(boundary.logPath), "");
  } finally {
    await rm(boundary.fixtureRoot, { force: true, recursive: true });
  }
});

test("CLI and container identity failures stop before database creation", async () => {
  const wrongCli = await makeFakeBoundary({ cliVersion: "9.9.9" });
  try {
    const result = spawnSync(
      "bash",
      [rehearsalPath, "--release-commit", git(["rev-parse", "HEAD"])],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: cleanEnvironment({
          DOCKER_BIN: wrongCli.fakeDocker,
          FAKE_RECONCILIATION_LOG: wrongCli.logPath,
          SUPABASE_CLI_BIN: wrongCli.fakeSupabase,
        }),
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /expected pinned Supabase CLI 2\.109\.0/u);
    assert.doesNotMatch(await readLog(wrongCli.logPath), /^docker:/mu);
  } finally {
    await rm(wrongCli.fixtureRoot, { force: true, recursive: true });
  }

  const wrongProject = await makeFakeBoundary({
    cliVersion: "2.109.0",
    projectLabel: "not-the-local-project",
  });
  try {
    const result = spawnSync(
      "bash",
      [rehearsalPath, "--release-commit", git(["rev-parse", "HEAD"])],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: cleanEnvironment({
          DOCKER_BIN: wrongProject.fakeDocker,
          FAKE_RECONCILIATION_LOG: wrongProject.logPath,
          SUPABASE_CLI_BIN: wrongProject.fakeSupabase,
        }),
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not owned by local Supabase project/u);
    const calls = await readLog(wrongProject.logPath);
    assert.doesNotMatch(calls, /createdb|dropdb| exec /u);
  } finally {
    await rm(wrongProject.fixtureRoot, { force: true, recursive: true });
  }
});
