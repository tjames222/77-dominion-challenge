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
  const rows = [
    "   Local            | Remote           | Time (UTC)",
    "  ------------------|------------------|-----------------------",
  ];
  for (let index = 0; index < count; index += 1) {
    const local = localVersions[index] ? `\`${localVersions[index]}\`` : "";
    const remote = remoteVersions[index] ? `\`${remoteVersions[index]}\`` : "";
    rows.push(`   ${local.padEnd(18)} | ${remote.padEnd(18)} | ignored`);
  }
  return `${rows.join("\n")}\n`;
}

test("parses the pinned CLI table with blank local or remote cells", () => {
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
