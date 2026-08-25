import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { HISTORICAL_RECONCILIATION_VERSIONS } from "./prepare-reconciliation-stage.mjs";

function fail(message) {
  throw new Error(`Reconciliation history: ${message}`);
}

function parseQuotedCell(value, label) {
  const trimmed = value.trim();
  if (
    trimmed.length < 2
    || !trimmed.startsWith("`")
    || !trimmed.endsWith("`")
    || trimmed.slice(1, -1).includes("`")
  ) {
    fail(`invalid quoted ${label} cell: ${trimmed}.`);
  }
  return trimmed.slice(1, -1).trim();
}

function expectedTimestamp(version) {
  return `${version.slice(0, 4)}-${version.slice(4, 6)}-${version.slice(6, 8)} `
    + `${version.slice(8, 10)}:${version.slice(10, 12)}:${version.slice(12, 14)}`;
}

export function parseMigrationList(output) {
  const local = [];
  const remote = [];
  const lines = output.split(/\r?\n/u);
  let lineIndex = 0;
  while (lineIndex < lines.length && lines[lineIndex].trim() === "") {
    lineIndex += 1;
  }

  const headerCells = (lines[lineIndex] || "").split("|").map((cell) =>
    cell.trim()
  );
  if (
    headerCells.length !== 3
    || headerCells[0] !== "Local"
    || headerCells[1] !== "Remote"
    || headerCells[2] !== "Time (UTC)"
  ) {
    fail("migration list is missing the exact pinned CLI header.");
  }
  lineIndex += 1;

  const separatorCells = (lines[lineIndex] || "").split("|").map((cell) =>
    cell.trim()
  );
  if (
    separatorCells.length !== 3
    || separatorCells[0] !== "------------------"
    || separatorCells[1] !== "------------------"
    || separatorCells[2] !== "-----------------------"
  ) {
    fail("migration list is missing the exact pinned CLI separator.");
  }
  lineIndex += 1;

  let sawTrailingWhitespace = false;
  for (; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex];
    if (rawLine.trim() === "") {
      sawTrailingWhitespace = true;
      continue;
    }
    if (sawTrailingWhitespace) {
      fail("migration list contains content after trailing whitespace.");
    }
    const cells = rawLine.split("|");
    if (cells.length !== 3) fail("migration list contains a malformed table row.");
    const localValue = parseQuotedCell(cells[0], "local version");
    const remoteValue = parseQuotedCell(cells[1], "remote version");
    const timestampValue = parseQuotedCell(cells[2], "timestamp");
    const localIsVersion = /^\d{14}$/u.test(localValue);
    const remoteIsVersion = /^\d{14}$/u.test(remoteValue);
    if (!localIsVersion && !remoteIsVersion && !localValue && !remoteValue) {
      fail("migration list contains a row without a local or remote version.");
    }
    if (localValue && !localIsVersion) {
      fail(`invalid local version cell: ${localValue}.`);
    }
    if (remoteValue && !remoteIsVersion) {
      fail(`invalid remote version cell: ${remoteValue}.`);
    }
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(timestampValue)) {
      fail(`invalid migration timestamp cell: ${timestampValue}.`);
    }
    const displayedVersions = [localValue, remoteValue].filter(Boolean);
    if (!displayedVersions.some((version) =>
      expectedTimestamp(version) === timestampValue
    )) {
      fail("migration timestamp does not match the displayed version.");
    }
    if (localIsVersion) local.push(localValue);
    if (remoteIsVersion) remote.push(remoteValue);
  }
  if (new Set(local).size !== local.length) {
    fail("local migration list contains duplicate versions.");
  }
  if (new Set(remote).size !== remote.length) {
    fail("remote migration list contains duplicate versions.");
  }
  return { local, remote };
}

function expectedPrefix(count) {
  return HISTORICAL_RECONCILIATION_VERSIONS.slice(0, count);
}

function sameVersions(actual, expected) {
  return actual.length === expected.length
    && actual.every((version, index) => version === expected[index]);
}

export function verifyReconciliationHistory({
  output,
  phase,
  throughVersion,
} = {}) {
  const stageIndex = HISTORICAL_RECONCILIATION_VERSIONS.indexOf(throughVersion);
  if (stageIndex < 0) fail("through version is not in the approved 1–13 prefix.");
  if (phase !== "before" && phase !== "after") {
    fail("phase must be before or after.");
  }
  const parsed = parseMigrationList(output || "");
  const expectedLocal = expectedPrefix(stageIndex + 1);
  const expectedRemote = expectedPrefix(
    phase === "before" ? stageIndex : stageIndex + 1,
  );
  if (!sameVersions(parsed.local, expectedLocal)) {
    fail(
      `local stage must contain exactly versions 1–${stageIndex + 1} in order.`,
    );
  }
  if (!sameVersions(parsed.remote, expectedRemote)) {
    fail(
      phase === "before"
        ? `remote history must contain exactly the first ${stageIndex} approved version(s) before the apply.`
        : `remote history must contain exactly the first ${stageIndex + 1} approved version(s) after the apply.`,
    );
  }
  return {
    local: parsed.local,
    remote: parsed.remote,
    pendingVersion: phase === "before" ? throughVersion : null,
  };
}

function parseArguments(argumentsList) {
  const options = {};
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (
      argument === "--input"
      || argument === "--phase"
      || argument === "--through-version"
    ) {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith("--")) fail(`${argument} requires a value.`);
      const key = argument.slice(2).replaceAll("-", "_");
      if (options[key]) fail(`${argument} may be supplied only once.`);
      options[key] = value;
      index += 1;
      continue;
    }
    fail(`unsupported argument: ${argument}`);
  }
  for (const required of ["input", "phase", "through_version"]) {
    if (!options[required]) fail(`--${required.replaceAll("_", "-")} is required.`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const output = await readFile(options.input, "utf8");
  const result = verifyReconciliationHistory({
    output,
    phase: options.phase,
    throughVersion: options.through_version,
  });
  console.log(
    options.phase === "before"
      ? `Verified exactly one pending historical migration: ${result.pendingVersion}.`
      : `Verified exact remote history through ${options.through_version}.`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
