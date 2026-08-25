import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { HISTORICAL_RECONCILIATION_VERSIONS } from "./prepare-reconciliation-stage.mjs";
import {
  parseMigrationList,
  verifyReconciliationHistory,
} from "./verify-reconciliation-history.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(scriptDirectory, "verify-reconciliation-history.mjs");

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

const PINNED_CLI_2_109_TABLE = [
  "",
  "  ",
  "   Local            | Remote           | Time (UTC)             ",
  "  ------------------|------------------|-----------------------",
  "   `20260707170000` | `20260707170000` | `2026-07-07 17:00:00` ",
  "   `20260708154000` | ` `              | `2026-07-08 15:40:00` ",
  "",
].join("\n");

test("parses the pinned CLI table with blank local or remote cells", () => {
  assert.deepEqual(parseMigrationList(PINNED_CLI_2_109_TABLE), {
    local: HISTORICAL_RECONCILIATION_VERSIONS.slice(0, 2),
    remote: HISTORICAL_RECONCILIATION_VERSIONS.slice(0, 1),
  });
  const output = migrationList(
    HISTORICAL_RECONCILIATION_VERSIONS.slice(0, 2),
    HISTORICAL_RECONCILIATION_VERSIONS.slice(0, 1),
  );
  assert.deepEqual(parseMigrationList(output), {
    local: HISTORICAL_RECONCILIATION_VERSIONS.slice(0, 2),
    remote: HISTORICAL_RECONCILIATION_VERSIONS.slice(0, 1),
  });
  const remoteOnly = migrationList(
    [],
    HISTORICAL_RECONCILIATION_VERSIONS.slice(0, 1),
  );
  assert.deepEqual(parseMigrationList(remoteOnly), {
    local: [],
    remote: HISTORICAL_RECONCILIATION_VERSIONS.slice(0, 1),
  });
});

test("rejects malformed, legacy, and versionless data rows", () => {
  for (const row of [
    "   `123`              | ` `                | `2026-07-07 17:00:00`",
    "   `legacy`           | ` `                | `2026-07-07 17:00:00`",
    "   ` `                | ` `                | `2026-07-07 17:00:00`",
    "   `20260707170000     | ` `                | `2026-07-07 17:00:00`",
    "   `20260707170000`    | ` `",
  ]) {
    assert.throws(
      () => parseMigrationList(
        `   Local            | Remote           | Time (UTC)\n`
        + `  ------------------|------------------|-----------------------\n`
        + `${row}\n`,
      ),
      /invalid|without a local or remote version|malformed/u,
    );
  }
});

test("requires the exact pinned CLI table grammar", () => {
  const validRow = "   `20260707170000` | ` `    | `2026-07-07 17:00:00`";
  for (const invalidOutput of [
    `${validRow}\n`,
    `  ------------------|------------------|-----------------------\n`
      + `   Local            | Remote           | Time (UTC)\n${validRow}\n`,
    `   Local            | Remote           | Time (UTC)\n`
      + `   Local            | Remote           | Time (UTC)\n`
      + `  ------------------|------------------|-----------------------\n${validRow}\n`,
    `unexpected\n   Local            | Remote           | Time (UTC)\n`
      + `  ------------------|------------------|-----------------------\n${validRow}\n`,
    `   Local            | Remote           | Time (UTC)\n`
      + `  ------------------|------------------|-----------------------\n`
      + "   20260707170000     | ` `                  | `2026-07-07 17:00:00`\n",
    `   Local            | Remote           | Time (UTC)\n`
      + `  ------------------|------------------|-----------------------\n`
      + "   `20260707170000`   | ` `                  | `bad-time`\n",
    `   Local            | Remote           | Time (UTC)\n`
      + `  ------------------|------------------|-----------------------\n${validRow}\n\n${validRow}\n`,
  ]) {
    assert.throws(
      () => parseMigrationList(invalidOutput),
      /header|separator|quoted|timestamp|trailing whitespace/u,
    );
  }
});

test("accepts dynamic pinned widths for stage-one and remote-only tables", () => {
  const firstVersion = HISTORICAL_RECONCILIATION_VERSIONS[0];
  assert.deepEqual(parseMigrationList(migrationList([firstVersion], [])), {
    local: [firstVersion],
    remote: [],
  });
  assert.deepEqual(parseMigrationList(migrationList([], [firstVersion])), {
    local: [],
    remote: [firstVersion],
  });
  assert.throws(
    () => parseMigrationList(
      migrationList([firstVersion], []).replace(
        "------------------|--------|-----------------------",
        "------------------|------------------|-----------------------",
      ),
    ),
    /separator widths/u,
  );
});

test("an extra short numeric row cannot be hidden by the table parser", () => {
  const throughVersion = HISTORICAL_RECONCILIATION_VERSIONS[1];
  const output = migrationList(
    HISTORICAL_RECONCILIATION_VERSIONS.slice(0, 2),
    HISTORICAL_RECONCILIATION_VERSIONS.slice(0, 1),
  ).replace(
    /\n$/u,
    "\n   `001`              | ` `                  | `2000-01-01 00:00:01`\n",
  );
  assert.throws(
    () => verifyReconciliationHistory({
      output,
      phase: "before",
      throughVersion,
    }),
    /invalid local version/u,
  );
});

test("requires exactly one newly pending version before the apply", () => {
  const throughVersion = HISTORICAL_RECONCILIATION_VERSIONS[4];
  const output = migrationList(
    HISTORICAL_RECONCILIATION_VERSIONS.slice(0, 5),
    HISTORICAL_RECONCILIATION_VERSIONS.slice(0, 4),
  );
  assert.deepEqual(
    verifyReconciliationHistory({ output, phase: "before", throughVersion }),
    {
      local: HISTORICAL_RECONCILIATION_VERSIONS.slice(0, 5),
      remote: HISTORICAL_RECONCILIATION_VERSIONS.slice(0, 4),
      pendingVersion: throughVersion,
    },
  );
});

test("requires the exact cumulative history after the apply", () => {
  const throughVersion = HISTORICAL_RECONCILIATION_VERSIONS[12];
  const output = migrationList(
    HISTORICAL_RECONCILIATION_VERSIONS,
    HISTORICAL_RECONCILIATION_VERSIONS,
  );
  assert.equal(
    verifyReconciliationHistory({ output, phase: "after", throughVersion })
      .remote.length,
    13,
  );
});

test("rejects skipped, duplicate, reordered, future, and unknown remote history", () => {
  const throughVersion = HISTORICAL_RECONCILIATION_VERSIONS[2];
  const local = HISTORICAL_RECONCILIATION_VERSIONS.slice(0, 3);
  const invalidRemoteLists = [
    [HISTORICAL_RECONCILIATION_VERSIONS[0]],
    [
      HISTORICAL_RECONCILIATION_VERSIONS[0],
      HISTORICAL_RECONCILIATION_VERSIONS[0],
    ],
    [
      HISTORICAL_RECONCILIATION_VERSIONS[1],
      HISTORICAL_RECONCILIATION_VERSIONS[0],
    ],
    HISTORICAL_RECONCILIATION_VERSIONS.slice(0, 3),
    [HISTORICAL_RECONCILIATION_VERSIONS[0], "20991231235959"],
  ];
  for (const remote of invalidRemoteLists) {
    assert.throws(
      () => verifyReconciliationHistory({
        output: migrationList(local, remote),
        phase: "before",
        throughVersion,
      }),
      /remote history|duplicate versions/u,
    );
  }
});

test("rejects a stage with too few or too many local migrations", () => {
  const throughVersion = HISTORICAL_RECONCILIATION_VERSIONS[2];
  for (const local of [
    HISTORICAL_RECONCILIATION_VERSIONS.slice(0, 2),
    HISTORICAL_RECONCILIATION_VERSIONS.slice(0, 4),
  ]) {
    assert.throws(
      () => verifyReconciliationHistory({
        output: migrationList(
          local,
          HISTORICAL_RECONCILIATION_VERSIONS.slice(0, 2),
        ),
        phase: "before",
        throughVersion,
      }),
      /local stage/u,
    );
  }
});

test("CLI reads history from a file without echoing the full table", async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "fou762-history-"));
  try {
    const historyPath = path.join(fixtureRoot, "migration-list.txt");
    const throughVersion = HISTORICAL_RECONCILIATION_VERSIONS[1];
    await writeFile(
      historyPath,
      migrationList(
        HISTORICAL_RECONCILIATION_VERSIONS.slice(0, 2),
        HISTORICAL_RECONCILIATION_VERSIONS.slice(0, 1),
      ),
    );
    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        "--input",
        historyPath,
        "--phase",
        "before",
        "--through-version",
        throughVersion,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      `Verified exactly one pending historical migration: ${throughVersion}.\n`,
    );
    assert.doesNotMatch(result.stdout, /Local\s+\|\s+Remote/u);
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});
