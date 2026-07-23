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
    echo "Files=\${#files[@]}, Tests=873, 1 wallclock secs"
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
    echo "Files=$((\${#files[@]} - 1)), Tests=872, 1 wallclock secs"
    echo "Result: PASS"
    ;;
  omit-profile-limit)
    emit_files
    echo "Files=\${#files[@]}, Tests=873, 1 wallclock secs"
    echo "Result: PASS"
    ;;
  malformed-summary)
    emit_files
    echo "Result: PASS"
    ;;
  nonzero)
    emit_files
    echo "Files=\${#files[@]}, Tests=873, 1 wallclock secs"
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

test("the current database inventory contains all 19 files and 873 planned assertions", async () => {
  const inventory = await currentDatabaseInventory();
  assert.equal(inventory.length, 19);
  assert.ok(inventory.includes("095_profile_photo_registration_limits.sql"));

  let plannedAssertions = 0;
  for (const filename of inventory) {
    const sql = await readFile(path.join(databaseTestsDirectory, filename), "utf8");
    const plan = /select\s+plan\(\s*([1-9][0-9]*)\s*\)/i.exec(sql);
    assert.ok(plan, `${filename} must declare a positive pgTAP plan`);
    plannedAssertions += Number.parseInt(plan[1], 10);
  }

  assert.equal(plannedAssertions, 873);
});

test("the runner succeeds from an unrelated directory and reports every file", async () => {
  const result = await runFixture("pass");

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.args.slice(0, 2), ["test", "db"]);
  assert.equal(result.args.length, 3);
  assert.match(result.args[2], /\/pgtap-tests\.[^/]+$/);
  assert.match(
    result.stdout,
    /Database pgTAP summary: source_files=19 files=19 assertions=873/,
  );
  assert.match(result.stdout, /all 19 files and 873 assertions executed/);
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
  assert.match(result.stderr, /source inventory has 19 file\(s\), but Supabase executed 18/);
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
  assert.match(workflow, /run: pnpm run test:database/);
});
