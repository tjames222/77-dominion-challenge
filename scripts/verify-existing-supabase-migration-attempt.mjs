import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HISTORICAL_RECONCILIATION_VERSIONS } from "./prepare-reconciliation-stage.mjs";
import { parseMigrationList } from "./verify-reconciliation-history.mjs";
import {
  fetchRawMigrationHistory,
  runReadOnlyManagementQuery,
  verifyRawMigrationHistory,
} from "./verify-production-raw-migration-history.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
export const defaultMigrationsDirectory = path.join(
  repositoryRoot,
  "supabase",
  "migrations",
);

export const EXISTING_SUPABASE_PROJECT_REF = "mimolwojppbtsbvtqwpo";
export const migrationHistoryTablePresenceQuery = `select
  (pg_catalog.to_regclass('supabase_migrations.schema_migrations') is not null)
    as history_table_present;`;

function fail(message) {
  throw new Error(`Existing-project migration attempt is invalid: ${message}`);
}

function sameValues(actual, expected) {
  return actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function requireSameValues(actual, expected, label) {
  if (!sameValues(actual, expected)) {
    fail(
      `${label} must be exactly [${expected.join(", ")}], received [${actual.join(", ")}]`,
    );
  }
}

function requireLeadingPrefix(actual, expected, label) {
  if (
    actual.length > expected.length
    || !actual.every((value, index) => value === expected[index])
  ) {
    fail(`${label} must be an exact leading prefix of the staged history`);
  }
}

export async function readRepositoryMigrationInventory(
  migrationsDirectory = defaultMigrationsDirectory,
) {
  let entries;
  try {
    entries = await readdir(migrationsDirectory, { withFileTypes: true });
  } catch {
    fail("the repository migration directory cannot be read");
  }

  const migrationEntries = entries
    .filter((entry) => entry.name.endsWith(".sql"))
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  if (migrationEntries.length === 0) {
    fail("the repository contains no SQL migration files");
  }

  const versions = [];
  const filenames = [];
  for (const entry of migrationEntries) {
    if (!entry.isFile()) {
      fail(`migration ${entry.name} is not an ordinary file`);
    }
    const match = /^(\d{14})_[a-z0-9][a-z0-9_]*\.sql$/u.exec(entry.name);
    if (!match) {
      fail(`migration ${entry.name} does not have a canonical filename`);
    }
    versions.push(match[1]);
    filenames.push(entry.name);
  }

  if (new Set(versions).size !== versions.length) {
    fail("repository migration versions are not unique");
  }
  const sortedVersions = [...versions].sort();
  if (!sameValues(versions, sortedVersions)) {
    fail("repository migration versions are not in canonical order");
  }

  return { filenames, versions };
}

export function verifyHistoricalMigrationInventory(inventory) {
  if (
    !inventory
    || !Array.isArray(inventory.versions)
    || !Array.isArray(inventory.filenames)
    || inventory.versions.length !== inventory.filenames.length
  ) {
    fail("the staged migration inventory is malformed");
  }
  requireSameValues(
    inventory.versions,
    HISTORICAL_RECONCILIATION_VERSIONS,
    "staged historical migration versions",
  );
  return inventory;
}

export function verifyCliMigrationHistory({ cliOutput, expectedVersions, phase } = {}) {
  if (phase !== "before" && phase !== "after" && phase !== "observe") {
    fail("phase must be exactly before, after, or observe");
  }
  if (!Array.isArray(expectedVersions) || expectedVersions.length === 0) {
    fail("the expected repository migration inventory is empty");
  }

  const parsed = parseMigrationList(cliOutput || "");
  requireSameValues(parsed.local, expectedVersions, "local CLI migration history");
  if (phase === "observe") {
    requireLeadingPrefix(
      parsed.remote,
      expectedVersions,
      "observed remote CLI migration history",
    );
  } else {
    requireSameValues(
      parsed.remote,
      phase === "before" ? [] : expectedVersions,
      `remote CLI migration history ${phase} the attempt`,
    );
  }
  return parsed;
}

function stripAnsi(value) {
  return value.replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
}

export function verifyDryRunPlan({ output, expectedFilenames } = {}) {
  if (!Array.isArray(expectedFilenames) || expectedFilenames.length === 0) {
    fail("the expected dry-run migration inventory is empty");
  }
  if (typeof output !== "string") {
    fail("dry-run output is missing");
  }

  const lines = stripAnsi(output).split(/\r?\n/u);
  const dryRunHeaders = lines.filter((line) =>
    line.trim() === "DRY RUN: migrations will *not* be pushed to the database."
  );
  if (dryRunHeaders.length !== 1) {
    fail("the pinned CLI dry-run safety header is missing or duplicated");
  }
  if (lines.some((line) => line.trim() === "Remote database is up to date.")) {
    fail("the dry run unexpectedly reports no pending migrations");
  }
  if (lines.some((line) =>
    line.includes("Would create custom roles") || line.includes("Would seed these files")
  )) {
    fail("the dry run includes a roles or seed operation");
  }

  const planHeaders = lines
    .map((line, index) => ({ index, value: line.trim() }))
    .filter(({ value }) => value === "Would push these migrations:");
  if (planHeaders.length !== 1) {
    fail("the pinned CLI migration-plan header is missing or duplicated");
  }

  const plannedFilenames = [];
  for (let index = planHeaders[0].index + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const match = /^\s*•\s+([^\s/]+\.sql)\s*$/u.exec(line);
    if (match) {
      plannedFilenames.push(match[1]);
      continue;
    }
    if (line.trim() !== "") break;
  }
  requireSameValues(
    plannedFilenames,
    expectedFilenames,
    "dry-run migration plan",
  );
  return plannedFilenames;
}

export function parseMigrationHistoryTablePresence(value) {
  if (
    !Array.isArray(value)
    || value.length !== 1
    || !value[0]
    || typeof value[0] !== "object"
    || Array.isArray(value[0])
    || Object.keys(value[0]).length !== 1
    || typeof value[0].history_table_present !== "boolean"
  ) {
    fail("the migration-history table presence response is malformed");
  }
  return value[0].history_table_present;
}

export async function verifyAuthoritativeMigrationHistory({
  accessToken,
  expectedRemoteVersions,
  fetchImplementation = globalThis.fetch,
  phase,
  projectRef,
} = {}) {
  if (projectRef !== EXISTING_SUPABASE_PROJECT_REF) {
    fail(`project ref must be exactly ${EXISTING_SUPABASE_PROJECT_REF}`);
  }
  if (phase !== "before" && phase !== "after" && phase !== "observe") {
    fail("phase must be exactly before, after, or observe");
  }
  if (!Array.isArray(expectedRemoteVersions)) {
    fail("expected remote migration history is missing");
  }

  const presenceResponse = await runReadOnlyManagementQuery({
    projectRef,
    accessToken,
    query: migrationHistoryTablePresenceQuery,
    fetchImplementation,
  });
  const historyTablePresent = parseMigrationHistoryTablePresence(presenceResponse);

  if (!historyTablePresent) {
    if (phase === "after" || expectedRemoteVersions.length !== 0) {
      fail("the migration-history table is absent after the migration attempt");
    }
    return { historyTablePresent, versions: [] };
  }

  const rawResponse = await fetchRawMigrationHistory({
    projectRef,
    accessToken,
    fetchImplementation,
  });
  const versions = verifyRawMigrationHistory({
    rawResponse,
    cliRemote: expectedRemoteVersions,
  });
  return { historyTablePresent, versions };
}

function parseArguments(argumentsList) {
  const options = {};
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (
      argument === "--phase"
      || argument === "--cli-history"
      || argument === "--dry-run-output"
      || argument === "--migrations-directory"
      || argument === "--observed-count-output"
    ) {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith("--") || options[argument]) {
        fail(`${argument} requires one value and may be supplied only once`);
      }
      options[argument] = value;
      index += 1;
      continue;
    }
    fail(`unsupported argument: ${argument}`);
  }

  if (
    !options["--phase"]
    || !options["--cli-history"]
    || !options["--migrations-directory"]
  ) {
    fail("--phase, --cli-history, and --migrations-directory are required");
  }
  if (options["--phase"] === "before" && !options["--dry-run-output"]) {
    fail("the before phase requires --dry-run-output");
  }
  if (options["--phase"] !== "before" && options["--dry-run-output"]) {
    fail("only the before phase accepts --dry-run-output");
  }
  if (
    options["--phase"] === "observe"
    && !options["--observed-count-output"]
  ) {
    fail("the observe phase requires --observed-count-output");
  }
  if (
    options["--phase"] !== "observe"
    && options["--observed-count-output"]
  ) {
    fail("only the observe phase accepts --observed-count-output");
  }
  return {
    cliHistory: options["--cli-history"],
    dryRunOutput: options["--dry-run-output"],
    migrationsDirectory: options["--migrations-directory"],
    observedCountOutput: options["--observed-count-output"],
    phase: options["--phase"],
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!path.isAbsolute(options.migrationsDirectory)) {
    fail("--migrations-directory must be absolute");
  }
  if (
    options.observedCountOutput
    && !path.isAbsolute(options.observedCountOutput)
  ) {
    fail("--observed-count-output must be absolute");
  }
  const inventory = verifyHistoricalMigrationInventory(
    await readRepositoryMigrationInventory(options.migrationsDirectory),
  );
  const cliOutput = await readFile(options.cliHistory, "utf8");
  const cliHistory = verifyCliMigrationHistory({
    cliOutput,
    expectedVersions: inventory.versions,
    phase: options.phase,
  });

  if (options.phase === "before") {
    const dryRunOutput = await readFile(options.dryRunOutput, "utf8");
    verifyDryRunPlan({
      output: dryRunOutput,
      expectedFilenames: inventory.filenames,
    });
  }

  await verifyAuthoritativeMigrationHistory({
    projectRef: process.env.SUPABASE_PROJECT_REF,
    accessToken: process.env.SUPABASE_ACCESS_TOKEN,
    expectedRemoteVersions: cliHistory.remote,
    phase: options.phase,
  });

  if (options.phase === "observe") {
    await writeFile(
      options.observedCountOutput,
      `${cliHistory.remote.length}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  }

  console.log(
    options.phase === "before"
      ? `Verified an empty exact remote history and a dry-run of ${inventory.versions.length} staged migrations.`
      : options.phase === "observe"
      ? `Observed an exact remote migration prefix of ${cliHistory.remote.length}/${inventory.versions.length}; this observation does not declare the attempt successful.`
      : `Verified ${inventory.versions.length} staged migrations in the exact CLI and raw remote histories.`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(
      error instanceof Error
        ? error.message
        : "Existing-project migration-attempt verification failed.",
    );
    process.exitCode = 1;
  });
}
