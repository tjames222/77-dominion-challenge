import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { HISTORICAL_RECONCILIATION_VERSIONS } from "./prepare-reconciliation-stage.mjs";

function fail(message) {
  throw new Error(`Reconciliation history: ${message}`);
}

function normalizeVersionCell(value) {
  return value.trim().replace(/^`|`$/gu, "");
}

export function parseMigrationList(output) {
  const local = [];
  const remote = [];
  for (const rawLine of output.split(/\r?\n/u)) {
    if (!rawLine.includes("|")) continue;
    const cells = rawLine.split("|");
    if (cells.length < 2) continue;
    const localValue = normalizeVersionCell(cells[0]);
    const remoteValue = normalizeVersionCell(cells[1]);
    const localIsVersion = /^\d{14}$/u.test(localValue);
    const remoteIsVersion = /^\d{14}$/u.test(remoteValue);
    if (!localIsVersion && !remoteIsVersion) continue;
    if (localValue && !localIsVersion) {
      fail(`invalid local version cell: ${localValue}.`);
    }
    if (remoteValue && !remoteIsVersion) {
      fail(`invalid remote version cell: ${remoteValue}.`);
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
