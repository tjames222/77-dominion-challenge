import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  EXPECTED_RELEASE_MIGRATION_COUNT,
  HISTORICAL_RECONCILIATION_VERSIONS,
  buildReconciliationStagePlan,
  prepareReconciliationStage,
  verifyReconciliationStage,
} from "./prepare-reconciliation-stage.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(scriptDirectory, "prepare-reconciliation-stage.mjs");
const repositoryRoot = path.resolve(scriptDirectory, "..");

const historicalNames = [
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

function git(root, argumentsList, environment = {}) {
  const result = spawnSync("git", argumentsList, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function makeReleaseFixture() {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "fou762-stage-test-"));
  const repository = path.join(fixtureRoot, "repository");
  await mkdir(path.join(repository, "supabase", "migrations"), {
    recursive: true,
  });
  await mkdir(path.join(repository, "supabase", ".temp"), { recursive: true });
  await writeFile(
    path.join(repository, "supabase", "config.toml"),
    'project_id = "77-dominion-challenge"\n',
  );
  await writeFile(
    path.join(repository, "supabase", ".temp", "postgres-version"),
    "17.6.1.141\n",
  );
  for (const [index, filename] of historicalNames.entries()) {
    await writeFile(
      path.join(repository, "supabase", "migrations", filename),
      `select ${index + 1};\n`,
    );
  }
  const remaining = EXPECTED_RELEASE_MIGRATION_COUNT - historicalNames.length;
  for (let index = 0; index < remaining; index += 1) {
    const version = (20990101000000n + BigInt(index)).toString();
    await writeFile(
      path.join(
        repository,
        "supabase",
        "migrations",
        `${version}_future_${String(index + 1).padStart(2, "0")}.sql`,
      ),
      `select ${historicalNames.length + index + 1};\n`,
    );
  }
  git(repository, ["init", "-q"]);
  git(repository, ["add", "supabase"]);
  git(
    repository,
    ["commit", "-q", "-m", "fixture release"],
    {
      GIT_AUTHOR_NAME: "Reconciliation Test",
      GIT_AUTHOR_EMAIL: "reconciliation@example.invalid",
      GIT_COMMITTER_NAME: "Reconciliation Test",
      GIT_COMMITTER_EMAIL: "reconciliation@example.invalid",
    },
  );
  const commit = git(repository, ["rev-parse", "HEAD"]);
  return { commit, fixtureRoot, repository };
}

async function withReleaseFixture(callback) {
  const fixture = await makeReleaseFixture();
  try {
    return await callback(fixture);
  } finally {
    await rm(fixture.fixtureRoot, { force: true, recursive: true });
  }
}

test("builds only the approved cumulative historical prefix from an exact commit", async () => {
  await withReleaseFixture(async ({ commit, repository }) => {
    const target = HISTORICAL_RECONCILIATION_VERSIONS[12];
    const plan = buildReconciliationStagePlan({
      releaseCommit: commit,
      throughVersion: target,
      root: repository,
    });
    assert.equal(plan.manifest.releaseCommit, commit);
    assert.equal(plan.manifest.throughVersion, target);
    assert.equal(plan.manifest.historicalStageNumber, 13);
    assert.deepEqual(
      plan.manifest.includedVersions,
      HISTORICAL_RECONCILIATION_VERSIONS,
    );
    assert.equal(
      plan.manifest.files.filter(({ path: filePath }) =>
        filePath.startsWith("supabase/migrations/")
      ).length,
      13,
    );
    assert.equal(plan.manifest.totalReleaseMigrationCount, 53);
  });
});

test("materializes committed blobs instead of dirty working-tree contents", async () => {
  await withReleaseFixture(async ({ commit, fixtureRoot, repository }) => {
    const firstMigration = path.join(
      repository,
      "supabase",
      "migrations",
      historicalNames[0],
    );
    await writeFile(firstMigration, "select 'uncommitted and unsafe';\n");
    const output = path.join(fixtureRoot, "stage-one");
    await prepareReconciliationStage({
      output,
      releaseCommit: commit,
      throughVersion: HISTORICAL_RECONCILIATION_VERSIONS[0],
      root: repository,
    });
    assert.equal(
      await readFile(path.join(output, "supabase", "migrations", historicalNames[0]), "utf8"),
      "select 1;\n",
    );
    const manifest = await verifyReconciliationStage({
      stage: output,
      releaseCommit: commit,
      throughVersion: HISTORICAL_RECONCILIATION_VERSIONS[0],
      root: repository,
    });
    assert.equal(manifest.historicalStageNumber, 1);
    assert.equal((await lstat(output)).mode & 0o777, 0o700);
  });
});

test("ignores local Git replacement refs when materializing an exact commit", async () => {
  await withReleaseFixture(async ({ commit, repository }) => {
    const firstMigration = path.join(
      repository,
      "supabase",
      "migrations",
      historicalNames[0],
    );
    await writeFile(firstMigration, "select 'replacement tree';\n");
    git(repository, ["add", "supabase"]);
    git(
      repository,
      ["commit", "-q", "-m", "replacement fixture"],
      {
        GIT_AUTHOR_NAME: "Reconciliation Test",
        GIT_AUTHOR_EMAIL: "reconciliation@example.invalid",
        GIT_COMMITTER_NAME: "Reconciliation Test",
        GIT_COMMITTER_EMAIL: "reconciliation@example.invalid",
      },
    );
    const replacementCommit = git(repository, ["rev-parse", "HEAD"]);
    git(repository, ["replace", commit, replacementCommit]);

    const plan = buildReconciliationStagePlan({
      releaseCommit: commit,
      throughVersion: HISTORICAL_RECONCILIATION_VERSIONS[0],
      root: repository,
    });
    const stagedMigration = plan.sourceEntries.find(({ path: filePath }) =>
      filePath.endsWith(historicalNames[0])
    );
    assert.equal(stagedMigration?.contents.toString("utf8"), "select 1;\n");
  });
});

test("rejects nested or non-SQL migration inventory", async () => {
  await withReleaseFixture(async ({ repository }) => {
    const migrationDirectory = path.join(repository, "supabase", "migrations");
    const directName = "20990101000000_future_01.sql";
    const directPath = path.join(migrationDirectory, directName);
    const contents = await readFile(directPath);
    await rm(directPath);
    await mkdir(path.join(migrationDirectory, "nested"));
    await writeFile(path.join(migrationDirectory, "nested", directName), contents);
    git(repository, ["add", "supabase"]);
    git(
      repository,
      ["commit", "-q", "-m", "nested migration fixture"],
      {
        GIT_AUTHOR_NAME: "Reconciliation Test",
        GIT_AUTHOR_EMAIL: "reconciliation@example.invalid",
        GIT_COMMITTER_NAME: "Reconciliation Test",
        GIT_COMMITTER_EMAIL: "reconciliation@example.invalid",
      },
    );
    const nestedCommit = git(repository, ["rev-parse", "HEAD"]);
    assert.throws(
      () => buildReconciliationStagePlan({
        releaseCommit: nestedCommit,
        throughVersion: HISTORICAL_RECONCILIATION_VERSIONS[0],
        root: repository,
      }),
      /direct SQL files/u,
    );
  });
});

test("rejects a direct non-SQL entry in the migration directory", async () => {
  await withReleaseFixture(async ({ repository }) => {
    await writeFile(
      path.join(repository, "supabase", "migrations", "README.md"),
      "not a migration\n",
    );
    git(repository, ["add", "supabase"]);
    git(
      repository,
      ["commit", "-q", "-m", "non-SQL migration fixture"],
      {
        GIT_AUTHOR_NAME: "Reconciliation Test",
        GIT_AUTHOR_EMAIL: "reconciliation@example.invalid",
        GIT_COMMITTER_NAME: "Reconciliation Test",
        GIT_COMMITTER_EMAIL: "reconciliation@example.invalid",
      },
    );
    const nonSqlCommit = git(repository, ["rev-parse", "HEAD"]);
    assert.throws(
      () => buildReconciliationStagePlan({
        releaseCommit: nonSqlCommit,
        throughVersion: HISTORICAL_RECONCILIATION_VERSIONS[0],
        root: repository,
      }),
      /direct SQL files/u,
    );
  });
});

test("rejects a short ref, unsupported version, in-repository output, and reuse", async () => {
  await withReleaseFixture(async ({ commit, fixtureRoot, repository }) => {
    assert.throws(
      () => buildReconciliationStagePlan({
        releaseCommit: commit.slice(0, 12),
        throughVersion: HISTORICAL_RECONCILIATION_VERSIONS[0],
        root: repository,
      }),
      /exact lowercase 40-character Git SHA/u,
    );
    assert.throws(
      () => buildReconciliationStagePlan({
        releaseCommit: commit,
        throughVersion: "20991231235959",
        root: repository,
      }),
      /one of the 13 historical reconciliation versions/u,
    );
    await assert.rejects(
      prepareReconciliationStage({
        output: path.join(repository, "unsafe-stage"),
        releaseCommit: commit,
        throughVersion: HISTORICAL_RECONCILIATION_VERSIONS[0],
        root: repository,
      }),
      /must be outside the repository/u,
    );
    const output = path.join(fixtureRoot, "one-use-stage");
    await prepareReconciliationStage({
      output,
      releaseCommit: commit,
      throughVersion: HISTORICAL_RECONCILIATION_VERSIONS[0],
      root: repository,
    });
    await assert.rejects(
      prepareReconciliationStage({
        output,
        releaseCommit: commit,
        throughVersion: HISTORICAL_RECONCILIATION_VERSIONS[0],
        root: repository,
      }),
      /already exists/u,
    );
  });
});

test("verification rejects tampering, unexpected files, and symbolic links", async () => {
  await withReleaseFixture(async ({ commit, fixtureRoot, repository }) => {
    const target = HISTORICAL_RECONCILIATION_VERSIONS[1];
    const output = path.join(fixtureRoot, "tamper-stage");
    await prepareReconciliationStage({
      output,
      releaseCommit: commit,
      throughVersion: target,
      root: repository,
    });
    const migrationPath = path.join(
      output,
      "supabase",
      "migrations",
      historicalNames[1],
    );
    await writeFile(migrationPath, "select 'tampered';\n");
    await assert.rejects(
      verifyReconciliationStage({
        stage: output,
        releaseCommit: commit,
        throughVersion: target,
        root: repository,
      }),
      /does not match the immutable Git blob/u,
    );

    await rm(output, { force: true, recursive: true });
    await prepareReconciliationStage({
      output,
      releaseCommit: commit,
      throughVersion: target,
      root: repository,
    });
    await writeFile(path.join(output, "unexpected.txt"), "no\n");
    await assert.rejects(
      verifyReconciliationStage({
        stage: output,
        releaseCommit: commit,
        throughVersion: target,
        root: repository,
      }),
      /missing or unexpected files/u,
    );

    await rm(output, { force: true, recursive: true });
    await prepareReconciliationStage({
      output,
      releaseCommit: commit,
      throughVersion: target,
      root: repository,
    });
    await rm(migrationPath);
    await symlink("../config.toml", migrationPath);
    await assert.rejects(
      verifyReconciliationStage({
        stage: output,
        releaseCommit: commit,
        throughVersion: target,
        root: repository,
      }),
      /symbolic links/u,
    );
  });
});

test("CLI prepares and independently verifies an immutable stage", async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "fou762-stage-cli-"));
  try {
    const commit = git(repositoryRoot, ["rev-parse", "HEAD"]);
    const output = path.join(fixtureRoot, "cli-stage");
    const prepare = spawnSync(
      process.execPath,
      [
        scriptPath,
        "--release-commit",
        commit,
        "--through-version",
        HISTORICAL_RECONCILIATION_VERSIONS[2],
        "--output",
        output,
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
      },
    );
    assert.equal(prepare.status, 0, prepare.stderr);
    assert.match(prepare.stdout, /stage 3\/13/u);
    const verify = spawnSync(
      process.execPath,
      [
        scriptPath,
        "--release-commit",
        commit,
        "--through-version",
        HISTORICAL_RECONCILIATION_VERSIONS[2],
        "--verify-stage",
        output,
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
      },
    );
    assert.equal(verify.status, 0, verify.stderr);
    assert.match(verify.stdout, /Verified immutable reconciliation stage 3\/13/u);
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});
