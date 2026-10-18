import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const runnerPath = path.join(scriptDirectory, "test-database.sh");
const databaseTestsDirectory = path.join(
  repositoryRoot,
  "supabase",
  "tests",
  "database",
);
const activationMigrationPath = path.join(
  repositoryRoot,
  "supabase",
  "migrations",
  "20260804200019_challenge_activation_lifecycle.sql",
);
const supabaseConfigPath = path.join(
  repositoryRoot,
  "supabase",
  "config.toml",
);
// Update alongside each reviewed pgTAP addition; these exact inventory checks
// must not silently accept missing files or fewer planned assertions.
const expectedFileCount = 48;
const expectedAssertionCount = 1991;

const fakeCliSource = `#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 3 || "$1" != "test" || "$2" != "db" ]]; then
  echo "unexpected arguments: $*" >&2
  exit 64
fi

staging_directory="$3"
printf '%s\n' "$@" > "$FAKE_ARGUMENT_LOG"

files=()
while IFS= read -r file; do
  files+=("$file")
done < <(
  find "$staging_directory" -type f \\
    \\( -name '*.sql' -o -name '*.pg' \\) -print \\
    | LC_ALL=C sort
)

emit_files() {
  local file
  for file in "\${files[@]}"; do
    if [[ "\${FAKE_PGTAP_MODE:-pass}" == "omit-profile-limit" \
      && "$file" == */095_profile_photo_registration_limits.sql ]]; then
      continue
    fi
    echo "$file ................................ ok"
  done
}

case "\${FAKE_PGTAP_MODE:-pass}" in
  pass)
    emit_files
    echo "Files=\${#files[@]}, Tests=${expectedAssertionCount}, 1 wallclock secs"
    echo "Result: PASS"
    ;;
  notests)
    echo "Files=0, Tests=0, 0 wallclock secs"
    echo "Result: NOTESTS"
    ;;
  zero-assertions)
    emit_files
    echo "Files=\${#files[@]}, Tests=0, 0 wallclock secs"
    echo "Result: NOTESTS"
    ;;
  count-mismatch)
    emit_files
    echo "Files=$((\${#files[@]} - 1)), Tests=1037, 1 wallclock secs"
    echo "Result: PASS"
    ;;
  omit-profile-limit)
    emit_files
    echo "Files=\${#files[@]}, Tests=${expectedAssertionCount}, 1 wallclock secs"
    echo "Result: PASS"
    ;;
  malformed-summary)
    emit_files
    echo "Result: PASS"
    ;;
  nonzero)
    emit_files
    echo "Files=\${#files[@]}, Tests=${expectedAssertionCount}, 1 wallclock secs"
    echo "Result: FAIL"
    exit 2
    ;;
  *)
    echo "unknown fake mode" >&2
    exit 65
    ;;
esac
`;

async function currentDatabaseInventory() {
  return (await readdir(databaseTestsDirectory))
    .filter((name) => name.endsWith(".sql") || name.endsWith(".pg"))
    .sort();
}

async function runFixture(mode) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "fou829-runner-"));
  const unrelatedDirectory = path.join(fixtureRoot, "unrelated-cwd");
  const stagingParent = path.join(fixtureRoot, "staging");
  const fakeCli = path.join(fixtureRoot, "supabase-fake");
  const argumentLog = path.join(fixtureRoot, "arguments.log");

  await mkdir(unrelatedDirectory);
  await mkdir(stagingParent);
  await writeFile(fakeCli, fakeCliSource);
  await chmod(fakeCli, 0o755);

  const result = spawnSync("bash", [runnerPath], {
    cwd: unrelatedDirectory,
    encoding: "utf8",
    env: {
      ...process.env,
      FAKE_ARGUMENT_LOG: argumentLog,
      FAKE_PGTAP_MODE: mode,
      PGTAP_STAGING_PARENT: stagingParent,
      SUPABASE_CLI_BIN: fakeCli,
    },
  });

  const args = await readFile(argumentLog, "utf8").catch(() => "");
  await rm(fixtureRoot, { force: true, recursive: true });

  return {
    args: args.trim().split("\n").filter(Boolean),
    stderr: result.stderr,
    stdout: result.stdout,
    status: result.status,
  };
}

test("the database inventory and latest lifecycle foundations stay complete", async () => {
  const supabaseConfig = await readFile(supabaseConfigPath, "utf8");
  assert.match(
    supabaseConfig,
    /\[db\][\s\S]*?major_version\s*=\s*17(?:\s|$)/,
    "the local database major version must match the production Postgres 17 project",
  );

  const inventory = await currentDatabaseInventory();
  assert.equal(inventory.length, expectedFileCount);
  assert.ok(inventory.includes("095_profile_photo_registration_limits.sql"));
  assert.ok(inventory.includes("100_single_crew_lifecycle.sql"));
  assert.ok(inventory.includes("110_crew_training.sql"));
  assert.ok(inventory.includes("120_challenge_activation.sql"));
  assert.ok(inventory.includes("130_group_challenge_start.sql"));
  assert.ok(inventory.includes("130_site_training.sql"));
  assert.ok(inventory.includes("140_solo_training_catalog.sql"));
  assert.ok(inventory.includes("150_crew_member_progress_profile.sql"));
  assert.ok(inventory.includes("160_crew_invite_codes.sql"));
  assert.ok(inventory.includes("170_multiple_daily_journal_entries.sql"));
  assert.ok(inventory.includes("180_account_lifecycle_requests.sql"));
  assert.ok(inventory.includes("190_launch_reward_catalog.sql"));
  assert.ok(inventory.includes("195_trusted_profile_photo_upload.sql"));
  assert.ok(inventory.includes("200_journal_date_enforcement.sql"));
  assert.ok(inventory.includes("210_early_access_requests.sql"));
  assert.ok(inventory.includes("220_deterministic_badges.sql"));
  assert.ok(inventory.includes("230_durable_reward_celebrations.sql"));
  assert.ok(inventory.includes("240_site_admin_foundation.sql"));
  assert.ok(inventory.includes("250_site_admin_reads.sql"));
  assert.ok(inventory.includes("260_scoped_member_badge_pagination.sql"));
  assert.ok(inventory.includes("270_early_access_admin.sql"));
  assert.ok(inventory.includes("280_daily_action_bootstrap.sql"));
  assert.ok(inventory.includes("290_early_access_feedback.sql"));
  assert.ok(inventory.includes("300_early_access_invitations.sql"));
  assert.ok(inventory.includes("310_early_access_account_bootstrap.sql"));
  assert.ok(inventory.includes("330_site_admin_account_requests.sql"));
  assert.ok(inventory.includes("340_original_77_live_completion.sql"));
  assert.ok(inventory.includes("340_site_admin_cleanup_health.sql"));
  assert.ok(inventory.includes("350_site_admin_profile_name.sql"));

  const canonicalSchema = await readFile(
    path.join(repositoryRoot, "supabase", "schema.sql"),
    "utf8",
  );
  const schemaMigrations = [...canonicalSchema.matchAll(/^\\ir migrations\/(.+\.sql)$/gm)]
    .map((match) => match[1]);
  const sourceMigrations = (await readdir(path.join(repositoryRoot, "supabase", "migrations")))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();
  assert.equal(
    schemaMigrations.at(-1),
    sourceMigrations.at(-1),
    "the canonical schema must reach the newest migration in the source inventory",
  );
  const queueHealthMigration = "20261007055555_site_admin_account_request_queue_health.sql";
  assert.equal(
    schemaMigrations.filter((filename) => filename === queueHealthMigration).length,
    1,
    "the canonical schema must include the account-request queue-health migration exactly once",
  );
  assert.ok(
    schemaMigrations.indexOf(queueHealthMigration)
      > schemaMigrations.indexOf("20261001001245_repeatable_challenge_instances_v2.sql"),
    "the queue-health migration must follow the existing lifecycle foundations",
  );
  const cleanupHealthMigration = "20261013055744_site_admin_cleanup_health.sql";
  assert.equal(
    schemaMigrations.filter((filename) => filename === cleanupHealthMigration).length,
    1,
    "the canonical schema must include the Admin cleanup-health migration exactly once",
  );
  assert.deepEqual(
    schemaMigrations.slice(-4, -2),
    ["20261007060519_profile_photo_cleanup_monitor_health.sql", cleanupHealthMigration],
    "the Admin cleanup-health migration must append to the existing service monitor foundation",
  );
  assert.equal(schemaMigrations.at(-2), "20261013091749_site_admin_profile_name_correction.sql");
  assert.equal(schemaMigrations.filter(filename => filename === "20261013091749_site_admin_profile_name_correction.sql").length, 1);
  const activationReviewHealthMigration = "20261018013111_site_admin_activation_review_health.sql";
  assert.equal(schemaMigrations.at(-1), activationReviewHealthMigration);
  assert.equal(
    schemaMigrations.filter(filename => filename === activationReviewHealthMigration).length,
    1,
    "the canonical schema must include the Admin activation-review-health migration exactly once",
  );

  let plannedAssertions = 0;
  for (const filename of inventory) {
    const sql = await readFile(path.join(databaseTestsDirectory, filename), "utf8");
    const plan = /select\s+plan\(\s*([1-9][0-9]*)\s*\)/i.exec(sql);
    assert.ok(plan, `${filename} must declare a positive pgTAP plan`);
    if (filename === "340_site_admin_cleanup_health.sql") {
      assert.equal(Number.parseInt(plan[1], 10), 20, "the cleanup-health suite contributes exactly 20 reviewed assertions");
    }
    if (filename === "350_site_admin_profile_name.sql") {
      assert.equal(Number.parseInt(plan[1], 10), 36, "the profile-name suite contributes exactly 36 reviewed assertions");
    }
    plannedAssertions += Number.parseInt(plan[1], 10);
  }

  assert.equal(plannedAssertions, expectedAssertionCount);

  const activationMigration = await readFile(activationMigrationPath, "utf8");
  assert.match(
    activationMigration,
    /lock table\s+public\.challenge_entries,\s+public\.check_ins,\s+public\.crews,\s+private\.retired_community_dr_quarantined_crews,\s+public\.crew_members,\s+public\.crew_invite_attributions,\s+private\.crew_lifecycle_requests,\s+public\.user_game_stats,\s+public\.game_point_events,\s+public\.user_reward_entitlements,\s+public\.user_badges\s+in exclusive mode;/i,
  );
  assert.ok(
    activationMigration.indexOf("in exclusive mode;")
      < activationMigration.indexOf("create temporary table challenge_activation_migration_clock"),
    "the evidence locks must precede the authoritative migration clock",
  );
  assert.match(
    activationMigration,
    /A lock_timeout aborts and rolls back the whole migration; retry only after/i,
  );
});

test("the runner succeeds from an unrelated directory and reports every file", async () => {
  const result = await runFixture("pass");

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.args.slice(0, 2), ["test", "db"]);
  assert.equal(result.args.length, 3);
  assert.match(result.args[2], /\/pgtap-tests\.[^/]+$/);
  assert.match(
    result.stdout,
    new RegExp(`Database pgTAP summary: source_files=${expectedFileCount} files=${expectedFileCount} assertions=${expectedAssertionCount}`),
  );
  assert.match(result.stdout, new RegExp(`all ${expectedFileCount} files and ${expectedAssertionCount} assertions executed`));
});

test("an exit-zero NOTESTS result fails closed", async () => {
  const result = await runFixture("notests");

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /reported zero executed test files/);
});

test("an exit-zero zero-assertion result fails closed", async () => {
  const result = await runFixture("zero-assertions");

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /reported zero executed assertions/);
});

test("a source and executed-file count mismatch fails closed", async () => {
  const result = await runFixture("count-mismatch");

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`source inventory has ${expectedFileCount} file\\(s\\), but Supabase executed ${expectedFileCount - 1}`));
});

test("omitting the FOU-800 pgTAP file fails even when counts look valid", async () => {
  const result = await runFixture("omit-profile-limit");

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /095_profile_photo_registration_limits\.sql/);
});

test("a missing summary fails closed", async () => {
  const result = await runFixture("malformed-summary");

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing or malformed Files\/Tests summary/);
});

test("a nonzero Supabase exit cannot be masked by tee", async () => {
  const result = await runFixture("nonzero");

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Supabase CLI exited with status 2/);
});

test("package and CI wiring use the guarded database runner", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  const workflow = await readFile(
    path.join(repositoryRoot, ".github", "workflows", "ci.yml"),
    "utf8",
  );

  assert.equal(
    packageJson.scripts["test:database"],
    "pnpm run test:database-runner && bash scripts/test-database.sh",
  );
  assert.match(
    packageJson.scripts["test:rpc"],
    /bash supabase\/tests\/integration\/crew-invite-code-concurrency\.sh/,
  );
  assert.match(
    packageJson.scripts["test:rpc"],
    /bash supabase\/tests\/integration\/site-training-concurrency\.sh/,
  );
  assert.match(
    packageJson.scripts["test:rpc"],
    /bash supabase\/tests\/integration\/group-challenge-start-concurrency\.sh/,
  );
  assert.match(
    packageJson.scripts["test:rpc"],
    /bash supabase\/tests\/integration\/solo-training-catalog-concurrency\.sh/,
  );
  assert.match(
    packageJson.scripts["test:rpc"],
    /bash supabase\/tests\/integration\/member-progress-profile-concurrency\.sh$/,
  );
  assert.match(workflow, /run: pnpm run test:database/);
});

const offlineContractSteps = [
  "      - name: Test production backup and restore evidence boundaries\n        run: pnpm run test:production-backup-restore\n",
  "      - name: Test production one-version reconciliation boundaries\n        run: pnpm run test:production-reconciliation\n",
];
const prerequisiteStep = "      - name: Require successful offline contracts and frontend checks\n"
  + "        env:\n          FRONTEND_RESULT: ${{ needs.frontend.result }}\n"
  + '        run: test "$FRONTEND_RESULT" = success\n';

function verifyOfflineContractOrdering(workflow) {
  const jobs = workflow.slice(workflow.indexOf("\njobs:\n") + 1);
  const entries = [...jobs.matchAll(/^  ([a-z][a-z0-9-]*):\n/gm)];
  assert.deepEqual(entries.map((entry) => entry[1]), ["frontend", "database", "functions"]);
  const blocks = Object.fromEntries(entries.map((entry, index) => [entry[1],
    jobs.slice(entry.index, entries[index + 1]?.index)]));
  const header = (block) => block.slice(0, block.indexOf("    steps:\n"));
  assert.equal(header(blocks.frontend), "  frontend:\n    name: Frontend\n"
    + "    runs-on: ubuntu-latest\n    timeout-minutes: 15\n");
  assert.equal(header(blocks.database), "  database:\n    name: Database\n"
    + "    needs: frontend\n    if: always()\n    runs-on: ubuntu-latest\n"
    + '    timeout-minutes: 40\n    env:\n      SUPABASE_TELEMETRY_DISABLED: "1"\n'
    + "      SUPABASE_DB_URL: postgresql://postgres:postgres@127.0.0.1:54322/postgres\n");
  assert.equal(header(blocks.functions), "  functions:\n    name: Edge Functions\n"
    + "    runs-on: ubuntu-latest\n    timeout-minutes: 15\n    env:\n      DENO_DIR: /tmp/deno\n");
  assert.deepEqual([...jobs.matchAll(/^    timeout-minutes: (\d+)$/gm)]
    .map((match) => Number(match[1])), [15, 40, 15]);
  assert.doesNotMatch(jobs, /continue-on-error:/);
  assert.doesNotMatch(blocks.frontend, /^\s+if:/m);
  for (const exactStep of offlineContractSteps) {
    assert.equal(workflow.split(exactStep).length, 2);
    const command = exactStep.split("run: ")[1].trim();
    assert.equal(workflow.split(command).length, 2);
    const name = exactStep.split("\n")[0];
    const start = blocks.frontend.indexOf(name);
    assert.ok(start >= 0);
    const end = blocks.frontend.indexOf("      - name:", start + 1);
    assert.equal(blocks.frontend.slice(start, end < 0 ? undefined : end).trimEnd(), exactStep.trimEnd());
    assert.doesNotMatch(blocks.database, new RegExp(command));
  }
  assert.ok(blocks.database.includes("    steps:\n" + prerequisiteStep + "      - name: Checkout\n"));
  assert.equal(workflow.split(prerequisiteStep).length, 2);
  assert.equal(blocks.database.match(/^\s+if:/gm)?.length, 2,
    "only the job prerequisite guard and existing always-cleanup may be conditional");
  const compatibility = blocks.database.indexOf("run: pnpm run check:migrations");
  const start = blocks.database.indexOf("run: pnpm run supabase:start");
  assert.ok(compatibility >= 0 && start > compatibility);
  return blocks;
}

test("offline contracts precede native SQL without adding jobs or raising runner limits", async () => {
  const workflow = await readFile(path.join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
  verifyOfflineContractOrdering(workflow);
});

test("CI ordering rejects omitted, duplicated, skipped, bypassed or expanded gates", async () => {
  const workflow = await readFile(path.join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
  const mutations = [
    (text) => text.replace(offlineContractSteps[0], ""),
    (text) => text.replace(offlineContractSteps[1], ""),
    (text) => text.replace(offlineContractSteps[0], offlineContractSteps[0].repeat(2)),
    (text) => text.replace(offlineContractSteps[0], offlineContractSteps[0]
      + "      - name: Duplicate under another name\n        run: pnpm run test:production-backup-restore\n"),
    (text) => text.replace("    name: Frontend\n", "    name: Frontend\n    if: false\n"),
    (text) => text.replace("    name: Frontend\n", "    name: Frontend\n    continue-on-error: true\n"),
    (text) => text.replace("        run: pnpm run test:production-backup-restore", "        if: false\n        run: pnpm run test:production-backup-restore"),
    (text) => text.replace("    needs: frontend\n", ""),
    (text) => text.replace("    needs: frontend\n", "    needs: functions\n"),
    (text) => text.replace("    if: always()\n", ""),
    (text) => text.replace(prerequisiteStep, ""),
    (text) => text.replace(prerequisiteStep,
      "      - name: Unchecked work before the prerequisite\n        run: true\n" + prerequisiteStep),
    (text) => text.replace("FRONTEND_RESULT: ${{ needs.frontend.result }}", "FRONTEND_RESULT: success"),
    (text) => text.replace('test "$FRONTEND_RESULT" = success', 'test "$FRONTEND_RESULT" != failure'),
    (text) => text.replace("    timeout-minutes: 15", "    timeout-minutes: 16"),
    (text) => text.replace("    timeout-minutes: 40", "    timeout-minutes: 41"),
    (text) => text.replace("    name: Edge Functions", "    name: Other check"),
    (text) => text.replace("      - name: Checkout", "      - name: Checkout\n        continue-on-error: true"),
    (text) => text + "\n  extra:\n    runs-on: ubuntu-latest\n    steps: []\n",
  ];
  for (const [index, mutate] of mutations.entries()) {
    const changed = mutate(workflow);
    assert.notEqual(changed, workflow, `mutation ${index} must alter the source`);
    assert.throws(() => verifyOfflineContractOrdering(changed), `mutation ${index} must fail closed`);
  }
});

test("the exact Database prerequisite command accepts only successful Frontend results", async () => {
  const workflow = await readFile(path.join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
  verifyOfflineContractOrdering(workflow);
  const command = prerequisiteStep.match(/^        run: (.+)$/m)[1];
  for (const result of ["success", "failure", "cancelled", "skipped", "", "unknown"]) {
    const child = spawnSync("bash", ["-e", "-c", command], {
      encoding: "utf8", env: { FRONTEND_RESULT: result }, timeout: 1000,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, result === "success" ? 0 : 1, result);
    assert.equal(child.stdout, "");
    assert.equal(child.stderr, "");
  }
});
