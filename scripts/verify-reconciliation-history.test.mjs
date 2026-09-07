import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
const pinnedCliFixtures = JSON.parse(readFileSync(
  new URL("./fixtures/migration-list-cli-2.109.0.json", import.meta.url), "utf8",
));

function migrationList(localVersions, remoteVersions, timestampCells = {}) {
  const count = Math.max(localVersions.length, remoteVersions.length);
  const headers = ["Local", "Remote", "Time (UTC)"];
  const values = [];
  for (let index = 0; index < count; index += 1) {
    const local = localVersions[index] ? `\`${localVersions[index]}\`` : "` `";
    const remote = remoteVersions[index] ? `\`${remoteVersions[index]}\`` : "` `";
    const version = localVersions[index] || remoteVersions[index];
    const timestamp = timestampCells[version]
      ?? `${version.slice(0, 4)}-${version.slice(4, 6)}-${version.slice(6, 8)} `
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

test("preserves canonical IDs while matching calendar and raw CLI timestamp displays", () => {
  // Literal Go time.Parse outcomes, independent of the parser implementation.
  const displays = [
    ["00000101000000", "0000-01-01 00:00:00"],
    ["19000229120000", "19000229120000"],
    ["20000229120000", "2000-02-29 12:00:00"],
    ["20240229123456", "2024-02-29 12:34:56"],
    ["20250229120000", "20250229120000"],
    ["20260431000000", "20260431000000"],
    ["20260720240000", "20260720240000"],
    ["20260720236000", "20260720236000"],
    ["20260720235960", "20260720235960"],
    ["20261301000000", "20261301000000"],
    ["20260001000000", "20260001000000"],
    ["20260100000000", "20260100000000"],
  ];
  for (const [version, timestamp] of displays) {
    for (const [local, remote] of [[[version], []], [[], [version]], [[version], [version]]]) {
      assert.deepEqual(
        parseMigrationList(migrationList(local, remote, { [version]: timestamp })),
        { local, remote },
      );
    }
  }
});

test("parses literal tables rendered by the unmodified pinned CLI modules", () => {
  assert.equal(pinnedCliFixtures.cliVersion, "2.109.0");
  assert.equal(pinnedCliFixtures.sourceCommit, "49db0064c4b3bd197c1305ccb9b1cf7ba8c4b443");
  const mixedVersions = [
    "20240229123456", "20250229010203", "20260101000000",
    "20260720235960", "20260720236000", "20260720240000",
  ];
  for (const fixture of pinnedCliFixtures.fixtures) {
    assert.equal(Buffer.byteLength(fixture.output), fixture.bytes);
    assert.equal(createHash("sha256").update(fixture.output).digest("hex"), fixture.sha256);
    const local = fixture.name === "mixed-calendar.txt"
      ? mixedVersions
      : pinnedCliFixtures.repositoryMigrationVersions;
    assert.deepEqual(parseMigrationList(fixture.output), {
      local,
      remote: local.slice(0, fixture.remoteCount),
    });
  }
});

test("rejects raw calendar IDs, normalized invalid dates, and mismatched raw timestamps", () => {
  for (const [version, timestamp] of [
    ["20260720235959", "20260720235959"],
    ["20000229120000", "20000229120000"],
    ["20260720240000", "2026-07-20 24:00:00"],
    ["20260720240000", "2026-07-21 00:00:00"],
    ["20250229120000", "2025-03-01 12:00:00"],
    ["20250229120000", "2025-02-29 12:00:00"],
    ["19000229120000", "1900-02-29 12:00:00"],
    ["20260720236000", "2026-07-20 23:60:00"],
    ["20260720235960", "2026-07-20 23:59:60"],
    ["20260720240000", "20260720250000"],
    ["20260720240000", "2026072024000"],
    ["20260720240000", "202607202400000"],
    ["20260720240000", "2026072024000x"],
  ]) {
    assert.throws(
      () => parseMigrationList(migrationList([version], [], { [version]: timestamp })),
      /migration timestamp/u,
    );
  }
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
