import { pathToFileURL } from "node:url";
import { parseMigrationList } from "./verify-reconciliation-history.mjs";

export { parseMigrationList };

export const reconciledHistoryVersions = Object.freeze(`
20260707170000
20260708154000
20260708155500
20260708160000
20260709163000
20260710120000
20260710123000
20260713120000
20260714120000
20260715190000
20260716061500
20260716153000
20260716163000
`.trim().split(/\s+/u));

export const initialCutoverVersions = Object.freeze(`
20260719100000
20260719110000
20260719120000
20260719130000
20260719170000
20260719180000
20260720100000
20260720110000
20260720120000
20260720130000
20260720140000
20260720210000
20260720220000
20260720230000
20260720240000
20260721000000
20260721010000
20260722152851
20260722152953
20260723162027
20260723211554
20260724070000
20260730074130
20260731193250
20260804200019
20260805003000
20260805010103
20260805015225
20260805021049
20260805055359
20260811012059
20260811130000
20260813120000
20260813162042
20260813163428
20260813164953
20260813171006
20260813192939
20260813193158
20260824204444
`.trim().split(/\s+/u));

const completeInitialHistory = Object.freeze([
  ...reconciledHistoryVersions,
  ...initialCutoverVersions,
]);
const initialCutoverFinalVersion = initialCutoverVersions.at(-1);

function fail(message) {
  throw new Error(`Production migration cutover plan is invalid: ${message}`);
}

function requireUniqueOrdered(versions, label) {
  if (new Set(versions).size !== versions.length) {
    fail(`${label} contains a duplicate version`);
  }
  const sorted = [...versions].sort();
  if (!sameVersions(versions, sorted)) {
    fail(`${label} is not in ascending version order`);
  }
}

function sameVersions(actual, expected) {
  return actual.length === expected.length &&
    actual.every((version, index) => version === expected[index]);
}

function formatVersions(versions) {
  return versions.length ? versions.join(", ") : "<empty>";
}

function requireExactVersions(actual, expected, label) {
  if (!sameVersions(actual, expected)) {
    fail(
      `${label} must be exactly [${formatVersions(expected)}], received [${formatVersions(actual)}]`,
    );
  }
}

export function verifyProductionMigrationCutoverPlan({ local, remote } = {}) {
  if (!Array.isArray(local) || !Array.isArray(remote) || !local.length) {
    fail("parsed migration history is empty");
  }

  requireUniqueOrdered(local, "local migration history");
  requireUniqueOrdered(remote, "remote migration history");

  if (!remote.includes(initialCutoverFinalVersion)) {
    requireExactVersions(
      local,
      completeInitialHistory,
      "the first production release's local migration history",
    );
    requireExactVersions(
      remote,
      reconciledHistoryVersions,
      "the first production release's reconciled remote history",
    );

    const pending = local.slice(remote.length);
    requireExactVersions(
      pending,
      initialCutoverVersions,
      "the first production release's pending migration suffix",
    );
    return { mode: "initial-cutover", pending };
  }

  if (remote.length > local.length) {
    fail("remote migration history is longer than local migration history");
  }
  requireExactVersions(
    remote.slice(0, completeInitialHistory.length),
    completeInitialHistory,
    "the completed production cutover history",
  );
  requireExactVersions(
    remote,
    local.slice(0, remote.length),
    "remote migration history",
  );

  return {
    mode: "post-cutover",
    pending: local.slice(remote.length),
  };
}

async function readStandardInput() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  try {
    const arguments_ = process.argv.slice(2);
    if (arguments_.some((argument) => argument !== "--mode-only") || arguments_.length > 1) {
      throw new Error("Usage: verify-production-migration-cutover-plan.mjs [--mode-only]");
    }
    const history = parseMigrationList(await readStandardInput());
    const result = verifyProductionMigrationCutoverPlan(history);
    if (arguments_[0] === "--mode-only") {
      console.log(result.mode);
    } else if (result.mode === "initial-cutover") {
      console.log(
        `Production migration cutover plan verified: migrations 1-13 are reconciled and exactly ${result.pending.length} migrations (14-53) are pending.`,
      );
    } else {
      console.log(
        `Production migration cutover history is complete and remains an exact local prefix; ${result.pending.length} later migration(s) are pending.`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Production migration cutover plan verification failed.");
    process.exitCode = 1;
  }
}
