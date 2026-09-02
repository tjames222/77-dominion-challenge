import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  cp,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
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

function gitIn(repositoryPath, argumentsList) {
  const result = spawnSync("git", argumentsList, {
    cwd: repositoryPath,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function makeCommittedBoundaryRepository() {
  const fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), "fou762-history-committed-boundary-"),
  );
  const repoRoot = path.join(fixtureRoot, "repo");
  const boundaryFiles = [
    "scripts/baseline-data-fingerprint.sql",
    "scripts/capture-database-manifest.sh",
    "scripts/check-migration-compatibility.mjs",
    "scripts/compare-database-manifests.mjs",
    "scripts/database-manifest.sql",
    "scripts/prepare-reconciliation-stage.mjs",
    "scripts/rehearse-history-reconciliation.sh",
    "scripts/verify-reconciliation-history.mjs",
    "supabase/.temp/postgres-version",
    "supabase/config.toml",
    "supabase/tests/reconciliation/legacy-migration-2-overlay.sql",
    "supabase/tests/reconciliation/legacy-migration-2.source.manifest.jsonl",
    "supabase/tests/reconciliation/migration-3.target.manifest.jsonl",
  ];
  await mkdir(repoRoot, { recursive: true });
  for (const relativePath of boundaryFiles) {
    const sourcePath = path.join(repositoryRoot, relativePath);
    const destinationPath = path.join(repoRoot, relativePath);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await cp(sourcePath, destinationPath, { recursive: true });
  }
  gitIn(repoRoot, ["init"]);
  gitIn(repoRoot, ["config", "user.name", "Codex Fixture"]);
  gitIn(repoRoot, ["config", "user.email", "codex-fixture@example.invalid"]);
  gitIn(repoRoot, ["add", "."]);
  gitIn(repoRoot, ["commit", "-m", "fixture boundary"]);
  return {
    fixtureRoot,
    repoRoot,
    releaseCommit: gitIn(repoRoot, ["rev-parse", "HEAD"]),
    rehearsalPath: path.join(
      repoRoot,
      "scripts",
      "rehearse-history-reconciliation.sh",
    ),
  };
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

async function waitForLog(logPath, pattern, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const contents = await readLog(logPath);
    if (pattern.test(contents)) return contents;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${pattern}`);
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
  const ciWorkflow = await readFile(
    path.join(repositoryRoot, ".github", "workflows", "ci.yml"),
    "utf8",
  );
  assert.equal(
    packageJson.scripts["test:reconciliation-stage"],
    "node --test scripts/prepare-reconciliation-stage.test.mjs scripts/verify-reconciliation-history.test.mjs scripts/rehearse-history-reconciliation.test.mjs",
  );
  assert.equal(
    packageJson.scripts["rehearse:history-reconciliation"],
    "bash scripts/rehearse-history-reconciliation.sh",
  );
  assert.match(
    packageJson.scripts["check:database"],
    /pnpm run test:reconciliation-stage/u,
  );
  assert.match(
    ciWorkflow,
    /Test immutable reconciliation staging and history\n\s+run: pnpm run test:reconciliation-stage/u,
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
  assert.match(
    source,
    /assert_head_file_matches "\$\{frozen_file#"\$repository_root\/"\}"/u,
  );
  assert.match(source, /current committed integration head/u);
  assert.match(source, /check-migration-compatibility\.mjs/u);
  assert.match(
    source,
    /"\$node_cli" "\$compatibility_gate" "\$stage_root\/supabase\/migrations"/u,
  );
  assert.match(source, /prepare-reconciliation-stage\.mjs/u);
  assert.match(source, /verify-reconciliation-history\.mjs/u);
  assert.match(source, /--through-version "\$migration_version"/u);
  assert.match(source, /assert_history_prefix \$\(\(stage_number - 1\)\)/u);
  assert.match(source, /assert_history_prefix "\$stage_number"/u);
  assert.match(
    source,
    /from supabase_migrations\.schema_migrations order by version/u,
  );
  assert.match(
    source,
    /history_output="\$\(history_versions "\$database_name"\)" \\\n+    \|\| fail "could not read the authoritative migration-history inventory\."/u,
  );
  assert.doesNotMatch(source, /git -C "\$repository_root"/u);
  assert.match(source, /git --no-replace-objects -C "\$repository_root"/u);
  assert.match(source, /migration up[\s\S]*--db-url "\$local_database_url"/u);
  assert.match(
    source,
    /migration list[\s\S]*--phase before[\s\S]*migration up[\s\S]*--phase after/u,
  );
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
  const createPending = source.indexOf(
    'write_owned_database_recovery "$database_name" "$ownership_token" create-pending',
  );
  const createDatabase = source.indexOf(
    'createdb --username postgres --template template0 "$database_name"',
  );
  const markerPending = source.indexOf(
    'write_owned_database_recovery "$database_name" "$ownership_token" marker-pending',
  );
  const installMarker = source.indexOf(
    'create table fou762_history_rehearsal.ownership',
  );
  const owned = source.indexOf(
    'write_owned_database_recovery "$database_name" "$ownership_token" owned',
  );
  assert.ok(
    createPending >= 0
      && createPending < createDatabase
      && createDatabase < markerPending
      && markerPending < installMarker
      && installMarker < owned,
    "durable recovery state must cover create, unmarked, and owned states",
  );
  assert.doesNotMatch(source, /--linked/u);
  assert.doesNotMatch(source, /\bdb[ ]+reset\b/u);
  assert.doesNotMatch(source, /\bmigration[ ]+repair\b/u);
  assert.doesNotMatch(source, /\bdb[ ]+push\b/u);
  assert.doesNotMatch(source, /\bsupabase[ ]+link\b/u);
  assert.doesNotMatch(source, /api\.supabase\.com/u);
  assert.doesNotMatch(source, /mimolwojppbtsbvtqwpo/u);
});

test("an authoritative history query failure cannot pass the zero-row checkpoint", async () => {
  const source = await readFile(rehearsalPath, "utf8");
  const functionBlock = /history_versions\(\) \{(?<body>[\s\S]*?)\n\}\n\nassert_history_prefix\(\) \{(?<assertBody>[\s\S]*?)\n\}\n\ncapture_manifest\(\)/u.exec(
    source,
  );
  assert.ok(functionBlock?.groups?.body);
  assert.ok(functionBlock?.groups?.assertBody);
  const fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), "fou762-history-query-failure-"),
  );
  try {
    const fakeDocker = path.join(fixtureRoot, "docker");
    const harness = path.join(fixtureRoot, "harness.sh");
    await writeFile(fakeDocker, "#!/bin/sh\nexit 42\n");
    await chmod(fakeDocker, 0o700);
    await writeFile(
      harness,
      `#!/bin/bash
set -euo pipefail
fail() { printf '%s\\n' "$1" >&2; exit 97; }
docker_cli=${JSON.stringify(fakeDocker)}
expected_database_container=local-only
database_name=fixture
migration_versions=(20260707170000)
history_versions() {${functionBlock.groups.body}
}
assert_history_prefix() {${functionBlock.groups.assertBody}
}
assert_history_prefix 0
printf 'migration-up-boundary-reached\\n'
`,
    );
    await chmod(harness, 0o700);
    const result = spawnSync("/bin/bash", [harness], { encoding: "utf8" });
    assert.equal(result.status, 97, result.stderr);
    assert.match(result.stderr, /could not read the authoritative migration-history inventory/u);
    assert.doesNotMatch(result.stdout, /migration-up-boundary-reached/u);
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("cleanup survives first and second process-group signals while dropping an owned database", async (t) => {
  const source = await readFile(rehearsalPath, "utf8");
  const firstSignalTraps = [
    "trap cleanup EXIT",
    "trap 'exit 129' HUP",
    "trap 'exit 130' INT",
    "trap 'exit 131' QUIT",
    "trap 'exit 143' TERM",
  ].join("\n");
  assert.ok(
    source.includes(firstSignalTraps),
    "the production rehearsal must route every first signal through cleanup",
  );
  const cleanupStart = source.indexOf("owned_database_recovery_file() {");
  const cleanupEnd = source.indexOf("\ntrap cleanup EXIT", cleanupStart);
  assert.ok(cleanupStart >= 0 && cleanupEnd > cleanupStart);
  const cleanupContract = source.slice(cleanupStart, cleanupEnd);
  const fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), "fou762-history-cleanup-signal-"),
  );
  t.after(() => rm(fixtureRoot, { force: true, recursive: true }));
  const fakeDocker = path.join(fixtureRoot, "docker");
  const harness = path.join(fixtureRoot, "harness.sh");
  const logPath = path.join(fixtureRoot, "calls.log");
  const databaseState = path.join(fixtureRoot, "database-present");
  const rehearsalRoot = path.join(
    fixtureRoot,
    "fou762-history-reconciliation.fixture",
  );
  await mkdir(rehearsalRoot);
  await writeFile(databaseState, "present\n");
  await writeFile(
    fakeDocker,
    `#!/bin/sh
set -eu
printf '%s\n' "$*" >>"${logPath}"
case "$*" in
  *"select count(*) from fou762_history_rehearsal.ownership"*)
    printf '%s\n' '1'
    ;;
  *"select count(*) from pg_database where datname = 'fou762_history_1_2_3'"*)
    if [ -e "${databaseState}" ]; then
      printf '%s\n' '1'
    else
      printf '%s\n' '0'
    fi
    ;;
  *"dropdb --username postgres"*)
    printf '%s\n' 'drop-cleanup-window' >>"${logPath}"
    /bin/sleep 0.5
    /bin/rm -f -- "${databaseState}"
    ;;
esac
`,
  );
  await chmod(fakeDocker, 0o700);
  await writeFile(
    harness,
    `#!/bin/bash
set -euo pipefail
docker_cli=${JSON.stringify(fakeDocker)}
expected_database_container=local-only
expected_project_id=77-dominion-challenge
rehearsal_parent=${JSON.stringify(fixtureRoot)}
rehearsal_root=${JSON.stringify(rehearsalRoot)}
created_databases=(fou762_history_1_2_3)
database_tokens=(fou762_1_2_3)
${cleanupContract}
write_owned_database_recovery fou762_history_1_2_3 fou762_1_2_3 owned
${firstSignalTraps}
printf '%s\\n' 'rehearsal-ready' >>${JSON.stringify(logPath)}
while :; do
  /bin/sleep 60
done
`,
  );
  await chmod(harness, 0o700);
  const child = spawn("/bin/bash", [harness], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal }));
  });
  let finished = false;
  try {
    await waitForLog(logPath, /rehearsal-ready/u);
    process.kill(-child.pid, "SIGQUIT");
    await waitForLog(logPath, /drop-cleanup-window/u);
    process.kill(-child.pid, "SIGTERM");
    const result = await completion;
    finished = true;
    assert.equal(result.signal, null, stderr);
    assert.equal(result.status, 131, stderr);
    await assert.rejects(stat(databaseState));
    await assert.rejects(stat(rehearsalRoot));
  } finally {
    if (!finished) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  }
});

test("create-window, marker, drop, and absence-proof failures preserve durable database authority", async (t) => {
  const source = await readFile(rehearsalPath, "utf8");
  const cleanupStart = source.indexOf("owned_database_recovery_file() {");
  const cleanupEnd = source.indexOf("\ntrap cleanup EXIT", cleanupStart);
  assert.ok(cleanupStart >= 0 && cleanupEnd > cleanupStart);
  const cleanupContract = source.slice(cleanupStart, cleanupEnd);
  for (const scenario of [
    {
      initialStatus: "create-pending",
      markerCount: "0",
      label: "create-window",
      dropStatus: 75,
      postDropCount: "1",
    },
    {
      initialStatus: "marker-pending",
      markerCount: "0",
      label: "marker-failure",
      dropStatus: 75,
      postDropCount: "1",
    },
    {
      initialStatus: "owned",
      markerCount: "1",
      label: "drop-failure",
      dropStatus: 75,
      postDropCount: "1",
    },
    {
      initialStatus: "owned",
      markerCount: "1",
      label: "drop-false-success",
      dropStatus: 0,
      postDropCount: "1",
    },
    {
      initialStatus: "owned",
      markerCount: "1",
      label: "absence-query-failure",
      dropStatus: 0,
      postDropQueryFails: true,
    },
  ]) {
    await t.test(scenario.label, async (nested) => {
      const fixtureRoot = await mkdtemp(
        path.join(os.tmpdir(), `fou762-history-${scenario.label}-`),
      );
      nested.after(() => rm(fixtureRoot, { force: true, recursive: true }));
      const fakeDocker = path.join(fixtureRoot, "docker");
      const harness = path.join(fixtureRoot, "harness.sh");
      const logPath = path.join(fixtureRoot, "calls.log");
      const rehearsalRoot = path.join(
        fixtureRoot,
        "fou762-history-reconciliation.fixture",
      );
      await mkdir(rehearsalRoot);
      await writeFile(
        fakeDocker,
        `#!/bin/sh
set -eu
printf '%s\n' "$*" >>"${logPath}"
case "$*" in
  *"select count(*) from fou762_history_rehearsal.ownership"*)
    printf '%s\n' '${scenario.markerCount}'
    ;;
  *"select count(*) from pg_database where datname = 'fou762_history_1_2_3'"*)
    if [ "${scenario.postDropQueryFails ? "1" : "0"}" = "1" ]; then
      exit 74
    fi
    printf '%s\n' '${scenario.postDropCount ?? "0"}'
    ;;
  *"dropdb --username postgres"*)
    exit ${scenario.dropStatus}
    ;;
esac
`,
      );
      await chmod(fakeDocker, 0o700);
      await writeFile(
        harness,
        `#!/bin/bash
set -euo pipefail
docker_cli=${JSON.stringify(fakeDocker)}
expected_database_container=local-only
expected_project_id=77-dominion-challenge
rehearsal_parent=${JSON.stringify(fixtureRoot)}
rehearsal_root=${JSON.stringify(rehearsalRoot)}
created_databases=(fou762_history_1_2_3)
database_tokens=(fou762_1_2_3)
${cleanupContract}
write_owned_database_recovery fou762_history_1_2_3 fou762_1_2_3 ${scenario.initialStatus}
trap cleanup EXIT
exit 9
`,
      );
      await chmod(harness, 0o700);
      const result = spawnSync("/bin/bash", [harness], { encoding: "utf8" });
      assert.equal(result.status, 9, result.stderr);
      assert.match(result.stderr, /preserved private disposable-database recovery state/u);
      const recovery = JSON.parse(await readFile(
        path.join(
          rehearsalRoot,
          "owned-database-fou762_history_1_2_3.json",
        ),
        "utf8",
      ));
      assert.equal(recovery.status, "cleanup-unresolved");
      assert.equal(recovery.databaseName, "fou762_history_1_2_3");
      assert.equal(recovery.ownershipToken, "fou762_1_2_3");
      const log = await readLog(logPath);
      if (scenario.markerCount === "0") {
        assert.doesNotMatch(log, /dropdb --username postgres/u);
      } else {
        assert.match(log, /dropdb --username postgres/u);
        if (scenario.dropStatus === 0) {
          assert.match(
            log,
            /select count\(\*\) from pg_database where datname = 'fou762_history_1_2_3'/u,
          );
        }
      }
    });
  }
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

test("accepts pnpm's one literal leading argument separator", async () => {
  const boundary = await makeFakeBoundary({ cliVersion: "9.9.9" });
  const isolatedRepository = await makeCommittedBoundaryRepository();
  try {
    const result = spawnSync(
      "bash",
      [
        isolatedRepository.rehearsalPath,
        "--",
        "--release-commit",
        isolatedRepository.releaseCommit,
      ],
      {
        cwd: isolatedRepository.repoRoot,
        encoding: "utf8",
        env: cleanEnvironment({
          DOCKER_BIN: boundary.fakeDocker,
          FAKE_RECONCILIATION_LOG: boundary.logPath,
          SUPABASE_CLI_BIN: boundary.fakeSupabase,
        }),
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /expected pinned Supabase CLI 2\.109\.0/u);
    assert.match(await readLog(boundary.logPath), /^supabase:--version$/mu);
  } finally {
    await rm(isolatedRepository.fixtureRoot, { force: true, recursive: true });
    await rm(boundary.fixtureRoot, { force: true, recursive: true });
  }
});

test("CLI and container identity failures stop before database creation", async () => {
  const isolatedRepository = await makeCommittedBoundaryRepository();
  const wrongCli = await makeFakeBoundary({ cliVersion: "9.9.9" });
  try {
    const result = spawnSync(
      "bash",
      [
        isolatedRepository.rehearsalPath,
        "--release-commit",
        isolatedRepository.releaseCommit,
      ],
      {
        cwd: isolatedRepository.repoRoot,
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
      [
        isolatedRepository.rehearsalPath,
        "--release-commit",
        isolatedRepository.releaseCommit,
      ],
      {
        cwd: isolatedRepository.repoRoot,
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
    await rm(isolatedRepository.fixtureRoot, { force: true, recursive: true });
    await rm(wrongProject.fixtureRoot, { force: true, recursive: true });
  }
});
