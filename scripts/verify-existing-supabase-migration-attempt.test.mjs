import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { HISTORICAL_RECONCILIATION_VERSIONS } from "./prepare-reconciliation-stage.mjs";
import {
  EXISTING_SUPABASE_PROJECT_REF,
  parseMigrationHistoryTablePresence,
  verifyAuthoritativeMigrationHistory,
  verifyCliMigrationHistory,
  verifyDryRunPlan,
  verifyHistoricalMigrationInventory,
} from "./verify-existing-supabase-migration-attempt.mjs";

const migrationsPath = fileURLToPath(
  new URL("../supabase/migrations/", import.meta.url),
);
const workflowPath = fileURLToPath(
  new URL("../.github/workflows/apply-existing-supabase-migrations.yml", import.meta.url),
);

const historicalFilenames = readdirSync(migrationsPath)
  .filter((filename) => /^\d{14}_.+\.sql$/u.test(filename))
  .sort()
  .slice(0, HISTORICAL_RECONCILIATION_VERSIONS.length);

function migrationList(localVersions, remoteVersions) {
  const count = Math.max(localVersions.length, remoteVersions.length);
  const headers = ["Local", "Remote", "Time (UTC)"];
  const values = [];
  for (let index = 0; index < count; index += 1) {
    const local = localVersions[index] ? `\`${localVersions[index]}\`` : "` `";
    const remote = remoteVersions[index] ? `\`${remoteVersions[index]}\`` : "` `";
    const version = localVersions[index] || remoteVersions[index];
    const timestamp = `${version.slice(0, 4)}-${version.slice(4, 6)}-${version.slice(6, 8)} `
      + `${version.slice(8, 10)}:${version.slice(10, 12)}:${version.slice(12, 14)}`;
    values.push([local, remote, `\`${timestamp}\``]);
  }
  const widths = headers.map((header, cellIndex) =>
    Math.max(header.length, ...values.map((row) => row[cellIndex].length))
  );
  const rows = [
    `   ${headers.map((header, index) => header.padEnd(widths[index])).join(" | ")} `,
    `  ${widths.map((width) => "-".repeat(width + 2)).join("|")}`,
    ...values.map((row) =>
      `   ${row.map((cell, index) => cell.padEnd(widths[index])).join(" | ")} `
    ),
  ];
  return `\n${rows.join("\n")}\n`;
}

function dryRun(filenames = historicalFilenames) {
  return [
    "DRY RUN: migrations will *not* be pushed to the database.",
    "Would push these migrations:",
    "",
    ...filenames.map((filename) => ` • ${filename}`),
    "",
  ].join("\n");
}

test("the staged inventory must be the exact reviewed migrations 1-13", () => {
  const inventory = {
    filenames: historicalFilenames,
    versions: historicalFilenames.map((filename) => filename.slice(0, 14)),
  };
  assert.deepEqual(verifyHistoricalMigrationInventory(inventory), inventory);
  assert.throws(
    () => verifyHistoricalMigrationInventory({
      filenames: inventory.filenames.slice(0, -1),
      versions: inventory.versions.slice(0, -1),
    }),
    /staged historical migration versions/u,
  );
});

test("the CLI history must move only from empty to the exact 1-13 prefix", () => {
  assert.deepEqual(
    verifyCliMigrationHistory({
      cliOutput: migrationList(HISTORICAL_RECONCILIATION_VERSIONS, []),
      expectedVersions: HISTORICAL_RECONCILIATION_VERSIONS,
      phase: "before",
    }).remote,
    [],
  );
  assert.deepEqual(
    verifyCliMigrationHistory({
      cliOutput: migrationList(
        HISTORICAL_RECONCILIATION_VERSIONS,
        HISTORICAL_RECONCILIATION_VERSIONS,
      ),
      expectedVersions: HISTORICAL_RECONCILIATION_VERSIONS,
      phase: "after",
    }).remote,
    HISTORICAL_RECONCILIATION_VERSIONS,
  );
  assert.throws(
    () => verifyCliMigrationHistory({
      cliOutput: migrationList(
        HISTORICAL_RECONCILIATION_VERSIONS,
        HISTORICAL_RECONCILIATION_VERSIONS.slice(0, 1),
      ),
      expectedVersions: HISTORICAL_RECONCILIATION_VERSIONS,
      phase: "before",
    }),
    /remote CLI migration history/u,
  );

  const partialPrefix = HISTORICAL_RECONCILIATION_VERSIONS.slice(0, 5);
  assert.deepEqual(
    verifyCliMigrationHistory({
      cliOutput: migrationList(
        HISTORICAL_RECONCILIATION_VERSIONS,
        partialPrefix,
      ),
      expectedVersions: HISTORICAL_RECONCILIATION_VERSIONS,
      phase: "observe",
    }).remote,
    partialPrefix,
  );
  assert.throws(
    () => verifyCliMigrationHistory({
      cliOutput: migrationList(
        HISTORICAL_RECONCILIATION_VERSIONS,
        [
          HISTORICAL_RECONCILIATION_VERSIONS[0],
          HISTORICAL_RECONCILIATION_VERSIONS[2],
        ],
      ),
      expectedVersions: HISTORICAL_RECONCILIATION_VERSIONS,
      phase: "observe",
    }),
    /exact leading prefix/u,
  );
});

test("the dry-run plan must list exactly migrations 1-13 in order", () => {
  assert.deepEqual(
    verifyDryRunPlan({ output: dryRun(), expectedFilenames: historicalFilenames }),
    historicalFilenames,
  );
  assert.throws(
    () => verifyDryRunPlan({
      output: dryRun(historicalFilenames.slice(0, -1)),
      expectedFilenames: historicalFilenames,
    }),
    /dry-run migration plan/u,
  );
  assert.throws(
    () => verifyDryRunPlan({
      output: `${dryRun()}Would seed these files:\n • seed.sql\n`,
      expectedFilenames: historicalFilenames,
    }),
    /roles or seed/u,
  );
});

test("authoritative history allows an absent table only before the attempt", async () => {
  const before = await verifyAuthoritativeMigrationHistory({
    accessToken: "test-token-never-printed",
    expectedRemoteVersions: [],
    fetchImplementation: async () => ({
      status: 201,
      json: async () => [{ history_table_present: false }],
    }),
    phase: "before",
    projectRef: EXISTING_SUPABASE_PROJECT_REF,
  });
  assert.deepEqual(before, { historyTablePresent: false, versions: [] });
  const observedEmpty = await verifyAuthoritativeMigrationHistory({
    accessToken: "test-token-never-printed",
    expectedRemoteVersions: [],
    fetchImplementation: async () => ({
      status: 201,
      json: async () => [{ history_table_present: false }],
    }),
    phase: "observe",
    projectRef: EXISTING_SUPABASE_PROJECT_REF,
  });
  assert.deepEqual(observedEmpty, { historyTablePresent: false, versions: [] });
  await assert.rejects(
    () => verifyAuthoritativeMigrationHistory({
      accessToken: "test-token-never-printed",
      expectedRemoteVersions: HISTORICAL_RECONCILIATION_VERSIONS,
      fetchImplementation: async () => ({
        status: 201,
        json: async () => [{ history_table_present: false }],
      }),
      phase: "after",
      projectRef: EXISTING_SUPABASE_PROJECT_REF,
    }),
    /history table is absent after/u,
  );
});

test("authoritative post-history must exactly match the CLI prefix", async () => {
  let call = 0;
  const result = await verifyAuthoritativeMigrationHistory({
    accessToken: "test-token-never-printed",
    expectedRemoteVersions: HISTORICAL_RECONCILIATION_VERSIONS,
    fetchImplementation: async () => {
      call += 1;
      return {
        status: 201,
        json: async () => call === 1
          ? [{ history_table_present: true }]
          : HISTORICAL_RECONCILIATION_VERSIONS.map((version) => ({ version })),
      };
    },
    phase: "after",
    projectRef: EXISTING_SUPABASE_PROJECT_REF,
  });
  assert.equal(call, 2);
  assert.deepEqual(result.versions, HISTORICAL_RECONCILIATION_VERSIONS);
  assert.equal(parseMigrationHistoryTablePresence([
    { history_table_present: true },
  ]), true);
});

test("the protected workflow can only stage and apply the existing-project 1-13 prefix", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  assert.match(workflow, /^on:\n  workflow_dispatch:/mu);
  assert.match(workflow, /environment: production/u);
  assert.match(workflow, /GITHUB_REF[^\n]*refs\/heads\/main/u);
  assert.match(workflow, /GITHUB_REPOSITORY[^\n]*tjames222\/77-dominion-challenge/u);
  assert.match(workflow, /EXPECTED_SUPABASE_PROJECT_REF: mimolwojppbtsbvtqwpo/u);
  assert.match(workflow, /APPLY MIGRATIONS 1-13 TO \$\{EXPECTED_SUPABASE_PROJECT_REF\}/u);
  assert.match(workflow, /version: 2\.109\.0/u);
  assert.match(workflow, /THROUGH_VERSION: "20260716163000"/u);
  assert.match(workflow, /--through-version "\$THROUGH_VERSION"/u);
  assert.match(workflow, /migration_count[^\n]*!= "13"/u);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.doesNotMatch(
    workflow.slice(0, workflow.indexOf("\n    steps:")),
    /SUPABASE_ACCESS_TOKEN/u,
  );

  const dryRunIndex = workflow.indexOf("db push --linked --dry-run");
  const preVerifyIndex = workflow.indexOf("--phase before");
  const attestIndex = workflow.indexOf(
    "Re-attest the immutable SQL stage immediately before apply",
  );
  const applyIndex = workflow.indexOf("migration up --linked");
  const postVerifyIndex = workflow.indexOf("--phase observe");
  const postEffectIndex = workflow.indexOf(
    "node scripts/verify-existing-supabase-post13-effect.mjs",
  );
  assert.ok(
    dryRunIndex !== -1
      && preVerifyIndex > dryRunIndex
      && attestIndex > preVerifyIndex
      && applyIndex > attestIndex
      && postVerifyIndex > applyIndex
      && postEffectIndex > postVerifyIndex,
  );

  assert.match(
    workflow,
    /diff --no-dereference --recursive --brief[\s\S]*sealed_migrations[\s\S]*execution_migrations/u,
  );
  assert.match(
    workflow,
    /chmod 0500 \\\n[\s\S]*"\$execution_stage"[\s\S]*"\$execution_stage\/supabase"/u,
  );
  assert.match(workflow, /chmod 0700 "\$execution_stage\/supabase\/\.temp"/u);
  assert.match(workflow, /find "\$execution_migrations" -type f ! -perm 0400/u);
  assert.match(workflow, /supabase\/\.temp\/postgres-version/u);
  assert.equal(
    workflow.split("supabase/.temp/project-ref").length - 1,
    1,
  );
  assert.match(
    workflow,
    /prepare-existing-supabase-cli-state\.mjs[\s\S]*--stage-directory/u,
  );
  assert.match(workflow, /prepare-existing-supabase-cli-state\.mjs[\s\S]*--verify-only/u);
  assert.doesNotMatch(workflow, /supabase link|\/api-keys/u);
  assert.match(workflow, /SUPABASE_PROFILE: supabase/u);
  assert.match(workflow, /NODE_EXTRA_CA_CERTS: ""/u);
  assert.match(workflow, /NODE_OPTIONS: ""/u);
  assert.match(workflow, /NODE_TLS_REJECT_UNAUTHORIZED: ""/u);
  assert.match(workflow, /SUPABASE_GO_BINARY: ""/u);
  assert.equal(
    workflow.split("SUPABASE_PROFILE=supabase SUPABASE_PROJECT_ID=").length - 1,
    4,
  );
  assert.equal(
    workflow.split(
      "SUPABASE_DB_PASSWORD= SUPABASE_GO_BINARY= SUPABASE_NO_KEYRING=1",
    ).length - 1,
    4,
  );
  assert.equal(workflow.split("PGPASSFILE=/dev/null").length - 1, 4);
  assert.equal(workflow.split("--profile=supabase").length - 1, 4);
  assert.ok(
    workflow.split("-u NODE_TLS_REJECT_UNAUTHORIZED").length - 1 >= 3,
  );
  assert.match(
    workflow,
    /mkdir -m 0700 "\$execution_stage" "\$supabase_home"/u,
  );
  assert.match(workflow, /SUPABASE_HOME="\$\{RUNNER_TEMP\}\/existing-production-supabase-home"/u);
  assert.match(
    workflow,
    /supabase --profile=supabase[\s\S]*--workdir="\$\{RUNNER_TEMP\}\/existing-production-execution-stage"[\s\S]*--agent=no --yes migration up --linked[\s\S]*>"\$apply_stdout" 2>"\$apply_stderr"/u,
  );
  assert.match(workflow, /--observed-count-output/u);
  assert.match(workflow, /OBSERVED_COUNT[^\n]*steps\.post-history\.outputs\.observed-count/u);
  assert.match(workflow, /POST_EFFECT_OUTCOME[^\n]*steps\.post-effect\.outcome/u);
  assert.match(workflow, /if \[\[ "\$\{OBSERVED_COUNT\}" != "13" \]\]/u);
  assert.match(workflow, /if \[\[ "\$\{POST_EFFECT_OUTCOME\}" != "success" \]\]/u);
  assert.doesNotMatch(workflow, /--include-all/u);

  assert.doesNotMatch(workflow, /supabase\s+db\s+reset/u);
  assert.doesNotMatch(workflow, /supabase\s+migration\s+repair/u);
  assert.doesNotMatch(workflow, /supabase\s+projects?\s+create/u);
  assert.doesNotMatch(workflow, /\b(?:drop\s+(?:database|schema)|truncate)\b/iu);
  assert.doesNotMatch(workflow, /--include-(?:roles|seed)/u);
});
