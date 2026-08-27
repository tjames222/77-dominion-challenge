import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseMigrationList } from "./verify-reconciliation-history.mjs";
import { verifyProductionMigrationCutoverPlan } from "./verify-production-migration-cutover-plan.mjs";

export const authoritativeMigrationHistoryQuery = `select version::text as version
from supabase_migrations.schema_migrations
order by version::text collate "C";`;

function fail(message) {
  throw new Error(`Authoritative production migration history is invalid: ${message}`);
}

function sameVersions(actual, expected) {
  return actual.length === expected.length
    && actual.every((version, index) => version === expected[index]);
}

async function discardResponseBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // The status-only failure below is authoritative; never inspect/log a body.
  }
}

export function parseRawMigrationHistoryResponse(value) {
  if (!Array.isArray(value)) {
    fail("the Management API response must be an array");
  }

  const versions = value.map((row, index) => {
    if (
      !row
      || typeof row !== "object"
      || Array.isArray(row)
      || Object.keys(row).length !== 1
      || Object.keys(row)[0] !== "version"
      || typeof row.version !== "string"
    ) {
      fail(`row ${index + 1} must contain exactly one string version field`);
    }
    if (!/^\d{14}$/u.test(row.version)) {
      fail(`row ${index + 1} contains a noncanonical migration version`);
    }
    return row.version;
  });

  if (new Set(versions).size !== versions.length) {
    fail("the raw migration table contains duplicate versions");
  }
  const sorted = [...versions].sort();
  if (!sameVersions(versions, sorted)) {
    fail("the raw migration table is not in canonical version order");
  }
  return versions;
}

export function verifyRawMigrationHistory({ rawResponse, cliRemote } = {}) {
  if (!Array.isArray(cliRemote)) {
    fail("the strict CLI remote history is missing");
  }
  const rawVersions = parseRawMigrationHistoryResponse(rawResponse);
  if (!sameVersions(rawVersions, cliRemote)) {
    fail(
      "the raw schema_migrations inventory does not exactly match the strict CLI remote history",
    );
  }
  return rawVersions;
}

export async function runReadOnlyManagementQuery({
  projectRef,
  accessToken,
  query,
  parameters = [],
  fetchImplementation = globalThis.fetch,
} = {}) {
  if (typeof projectRef !== "string" || !/^[a-z0-9]{20}$/u.test(projectRef)) {
    fail("SUPABASE_PROJECT_REF must be exactly 20 lowercase letters or digits");
  }
  if (
    typeof accessToken !== "string"
    || !accessToken
    || /[\u0000-\u001f\u007f]/u.test(accessToken)
  ) {
    fail("SUPABASE_ACCESS_TOKEN is missing or malformed");
  }
  if (typeof fetchImplementation !== "function") {
    fail("a fetch implementation is required");
  }
  if (typeof query !== "string" || !query.trim()) {
    fail("a read-only SQL query is required");
  }
  if (!Array.isArray(parameters)) {
    fail("read-only SQL parameters must be an array");
  }

  let response;
  try {
    response = await fetchImplementation(
      `https://api.supabase.com/v1/projects/${projectRef}/database/query/read-only`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          parameters,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch {
    fail("the read-only Management API request failed");
  }

  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    await discardResponseBody(response);
    fail("the read-only Management API query returned a redirect");
  }

  if (response.status !== 201) {
    await discardResponseBody(response);
    fail(`the read-only Management API query returned HTTP ${response.status}`);
  }

  let value;
  try {
    value = await response.json();
  } catch {
    fail("the read-only Management API query did not return JSON");
  }
  return value;
}

export async function fetchRawMigrationHistory(options = {}) {
  return await runReadOnlyManagementQuery({
    ...options,
    query: authoritativeMigrationHistoryQuery,
  });
}

function parseArguments(argumentsList) {
  let cliHistory = "";
  let modeOnly = false;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--cli-history") {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith("--") || cliHistory) {
        fail("--cli-history requires exactly one file path");
      }
      cliHistory = value;
      index += 1;
      continue;
    }
    if (argument === "--mode-only" && !modeOnly) {
      modeOnly = true;
      continue;
    }
    fail(`unsupported or duplicate argument: ${argument}`);
  }
  if (!cliHistory) fail("--cli-history is required");
  return { cliHistory, modeOnly };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const cliOutput = await readFile(options.cliHistory, "utf8");
  const parsedCli = parseMigrationList(cliOutput);
  const plan = verifyProductionMigrationCutoverPlan(parsedCli);
  const rawResponse = await fetchRawMigrationHistory({
    projectRef: process.env.SUPABASE_PROJECT_REF,
    accessToken: process.env.SUPABASE_ACCESS_TOKEN,
  });
  const rawVersions = verifyRawMigrationHistory({
    rawResponse,
    cliRemote: parsedCli.remote,
  });

  if (options.modeOnly) {
    console.log(plan.mode);
  } else {
    console.log(
      `Verified ${rawVersions.length} exact raw production migration record(s); cutover mode is ${plan.mode}.`,
    );
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(
      error instanceof Error
        ? error.message
        : "Authoritative production migration history verification failed.",
    );
    process.exitCode = 1;
  });
}
