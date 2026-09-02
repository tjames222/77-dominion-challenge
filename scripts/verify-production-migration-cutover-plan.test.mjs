import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  initialCutoverVersions,
  parseMigrationList,
  reconciledHistoryVersions,
  verifyProductionMigrationCutoverPlan,
} from "./verify-production-migration-cutover-plan.mjs";

const scriptPath = fileURLToPath(
  new URL("./verify-production-migration-cutover-plan.mjs", import.meta.url),
);
const migrationsPath = fileURLToPath(
  new URL("../supabase/migrations/", import.meta.url),
);
const backendReleaseRunbookPath = fileURLToPath(
  new URL("../docs/backend-release-runbook.md", import.meta.url),
);
const canaryRunbookPath = fileURLToPath(
  new URL("../docs/production-canary-operator-runbook.md", import.meta.url),
);
const baselinePath = fileURLToPath(
  new URL("../supabase/migrations/20260707170000_baseline.sql", import.meta.url),
);
const completeInitialHistory = [
  ...reconciledHistoryVersions,
  ...initialCutoverVersions,
];

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
  return `\n  \n${rows.join("\n")}\n`;
}

test("the initial release requires exactly migrations 1-13 remote and 14-53 pending", () => {
  assert.equal(reconciledHistoryVersions.length, 13);
  assert.equal(initialCutoverVersions.length, 40);

  const result = verifyProductionMigrationCutoverPlan(
    { local: completeInitialHistory, remote: reconciledHistoryVersions },
  );
  assert.deepEqual(result, {
    mode: "initial-cutover",
    pending: initialCutoverVersions,
  });
});

test("the cutover contract is the exact 53-version prefix in the repository", () => {
  const repositoryVersions = readdirSync(migrationsPath)
    .filter((filename) => /^\d{14}_.+\.sql$/u.test(filename))
    .map((filename) => filename.slice(0, 14))
    .sort();
  assert.deepEqual(
    repositoryVersions.slice(0, completeInitialHistory.length),
    completeInitialHistory,
  );
});

test("the FOU-759 runbook orders one bounded entitlement between migration 13 and compatibility/full", () => {
  const backendRunbook = readFileSync(backendReleaseRunbookPath, "utf8");
  const section = backendRunbook.slice(
    backendRunbook.indexOf("### FOU-759 two-stage avatar and journal cutover"),
  );
  const migration13 = section.indexOf("through migration 13");
  const grant = section.indexOf("authorize exactly one");
  const compatibility = section.indexOf("release_scope=compatibility-cutover");
  const full = section.indexOf("release_scope=full");
  const revoke = section.indexOf("revoke that same UUID/grant-bound");
  assert.ok(
    migration13 !== -1
      && grant > migration13
      && compatibility > grant
      && full > compatibility
      && revoke > full,
  );
  assert.match(section, /no more than two hours/u);
  assert.match(section, /There is no\s+direct-full exception/u);
  assert.match(section, /Reuse the existing exact\s+canary grant/u);
  assert.match(section, /final acceptance is blocked/u);
});

test("the migration-13 schema and canary SQL support the exact bounded grant", () => {
  const baseline = readFileSync(baselinePath, "utf8");
  const entitlementTable = baseline.match(
    /create table if not exists public\.entitlements \([\s\S]*?\n\);/u,
  )?.[0];
  assert.ok(entitlementTable);
  assert.match(entitlementTable, /user_id uuid not null/u);
  assert.match(entitlementTable, /source_type text not null/u);
  assert.match(entitlementTable, /source_id text/u);
  assert.match(entitlementTable, /ends_at timestamptz/u);
  assert.match(entitlementTable, /metadata jsonb not null/u);
  assert.doesNotMatch(entitlementTable, /source_type[^\n]*check/u);

  const canaryRunbook = readFileSync(canaryRunbookPath, "utf8");
  assert.match(canaryRunbook, /'production_canary'/u);
  assert.match(canaryRunbook, /grant_start \+ interval '2 hours'/u);
  assert.match(canaryRunbook, /jsonb_build_object\('release_sha', target_release\)/u);
  assert.match(canaryRunbook, /exact same row—not a replacement/u);
  assert.match(canaryRunbook, /This is not a direct-full\s+exception/u);
  assert.match(canaryRunbook, /final acceptance is\s+blocked/u);
});

test("a partial initial cutover fails closed instead of resuming ad hoc", () => {
  const partialRemote = [
    ...reconciledHistoryVersions,
    ...initialCutoverVersions.slice(0, 1),
  ];
  assert.throws(
    () => verifyProductionMigrationCutoverPlan({ local: completeInitialHistory, remote: partialRemote }),
    /reconciled remote history must be exactly/u,
  );
});

test("a missing or additional initial pending migration fails closed", () => {
  assert.throws(
    () =>
      verifyProductionMigrationCutoverPlan(
        { local: completeInitialHistory.slice(0, -1), remote: reconciledHistoryVersions },
      ),
    /local migration history must be exactly/u,
  );
  assert.throws(
    () =>
      verifyProductionMigrationCutoverPlan(
        { local: [...completeInitialHistory, "20260825000000"], remote: reconciledHistoryVersions },
      ),
    /local migration history must be exactly/u,
  );
});

test("a completed cutover permits an exact-prefix rerun and later migrations", () => {
  assert.deepEqual(
    verifyProductionMigrationCutoverPlan(
      { local: completeInitialHistory, remote: completeInitialHistory },
    ),
    { mode: "post-cutover", pending: [] },
  );

  const futureVersion = "20260825000000";
  assert.deepEqual(
    verifyProductionMigrationCutoverPlan(
      { local: [...completeInitialHistory, futureVersion], remote: completeInitialHistory },
    ),
    { mode: "post-cutover", pending: [futureVersion] },
  );
});

test("a completed cutover rejects remote-only versions and history gaps", () => {
  const missingHistorical = completeInitialHistory.filter((_, index) => index !== 9);
  assert.throws(
    () =>
      verifyProductionMigrationCutoverPlan(
        { local: completeInitialHistory, remote: missingHistorical },
      ),
    /completed production cutover history must be exactly/u,
  );

  const futureVersion = "20260825000000";
  assert.throws(
    () =>
      verifyProductionMigrationCutoverPlan(
        { local: completeInitialHistory, remote: [...completeInitialHistory, futureVersion] },
      ),
    /remote migration history is longer than local/u,
  );
});

test("the cutover verifier reuses the strict pinned CLI table parser", () => {
  assert.deepEqual(
    parseMigrationList(migrationList(completeInitialHistory, reconciledHistoryVersions)),
    { local: completeInitialHistory, remote: reconciledHistoryVersions },
  );
});

test("the cutover parser rejects malformed rows and content after trailing whitespace", () => {
  const valid = migrationList(completeInitialHistory, reconciledHistoryVersions);
  for (const malformed of [
    valid.replace("`20260707170000`", "`001`           "),
    valid.replace("`20260707170000`", "20260707170000  "),
    valid.replace("`2026-07-07 17:00:00`", "`2000-01-01 00:00:01`"),
    `${valid}\n   unexpected`,
  ]) {
    assert.throws(
      () => parseMigrationList(malformed),
      /invalid|quoted|timestamp|trailing whitespace/u,
    );
  }
});

test("the command-line verifier reports success without printing migration SQL", () => {
  const result = spawnSync(process.execPath, [scriptPath], {
    input: migrationList(completeInitialHistory, reconciledHistoryVersions),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /exactly 40 migrations \(14-53\) are pending/u);
});

test("the command-line verifier exposes an exact mode for the workflow gate", () => {
  const result = spawnSync(process.execPath, [scriptPath, "--mode-only"], {
    input: migrationList(completeInitialHistory, reconciledHistoryVersions),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "initial-cutover\n");
});

test("the command-line verifier rejects an empty or malformed table", () => {
  const result = spawnSync(process.execPath, [scriptPath], {
    input: "Local | Remote | Time (UTC)\n",
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /header|separator/u);
});
