#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const EXISTING_SUPABASE_PROJECT_REF = "mimolwojppbtsbvtqwpo";
export const EXPECTED_POSTGRES_VERSION = "17.6.1.141";
const EXPECTED_DATABASE_ENGINE = "17";
const EXPECTED_DATABASE_HOST =
  `db.${EXISTING_SUPABASE_PROJECT_REF}.supabase.co`;
const EXPECTED_POOLER_HOST = "aws-1-us-west-2.pooler.supabase.com";
const EXPECTED_PROJECT_REGION = "us-west-2";
const EXPECTED_RELEASE_CHANNEL = "ga";
const FORBIDDEN_NODE_ENVIRONMENT = Object.freeze([
  "NODE_EXTRA_CA_CERTS",
  "NODE_OPTIONS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
]);

function fail(message) {
  throw new Error(`Existing-project CLI state is invalid: ${message}`);
}

export function requireCleanNodeRuntimeEnvironment(environment) {
  for (const name of FORBIDDEN_NODE_ENVIRONMENT) {
    if (typeof environment?.[name] === "string" && environment[name].length > 0) {
      fail(`${name} must be unset`);
    }
  }
}

function requireAccessToken(accessToken) {
  if (
    typeof accessToken !== "string"
    || accessToken.length === 0
    || /[\u0000-\u001f\u007f]/u.test(accessToken)
  ) {
    fail("SUPABASE_ACCESS_TOKEN is missing or malformed");
  }
  return accessToken;
}

function requireProjectRef(projectRef) {
  if (projectRef !== EXISTING_SUPABASE_PROJECT_REF) {
    fail(`the project ref must be exactly ${EXISTING_SUPABASE_PROJECT_REF}`);
  }
  return projectRef;
}

async function discardResponseBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // The status-only error below is authoritative. Never inspect an error body.
  }
}

async function fetchResponse({
  accessToken,
  fetchImplementation,
  label,
  method = "GET",
  url,
}) {
  let response;
  try {
    response = await fetchImplementation(url, {
      method,
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    fail(`${label} request failed`);
  }

  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    await discardResponseBody(response);
    fail(`${label} returned a redirect`);
  }
  return response;
}

async function fetchJson(options) {
  const response = await fetchResponse(options);
  if (response.status !== 200) {
    await discardResponseBody(response);
    fail(`${options.label} returned HTTP ${response.status}`);
  }

  try {
    return await response.json();
  } catch {
    fail(`${options.label} did not return JSON`);
  }
}

async function requireNetworkBanReadDenied(options) {
  const response = await fetchResponse({ ...options, method: "POST" });
  await discardResponseBody(response);
  if (response.status !== 403) {
    fail(
      "SUPABASE_ACCESS_TOKEN must return HTTP 403 for Network Bans read access",
    );
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNullableNonnegativeInteger(value) {
  return value === null || (Number.isInteger(value) && value >= 0);
}

export function verifyProjectResponse(value, projectRef) {
  if (
    !isPlainObject(value)
    || value.id !== projectRef
    || value.ref !== projectRef
    || value.region !== EXPECTED_PROJECT_REGION
    || value.status !== "ACTIVE_HEALTHY"
    || !isPlainObject(value.database)
    || value.database.host !== EXPECTED_DATABASE_HOST
    || value.database.version !== EXPECTED_POSTGRES_VERSION
    || value.database.postgres_engine !== EXPECTED_DATABASE_ENGINE
    || value.database.release_channel !== EXPECTED_RELEASE_CHANNEL
  ) {
    fail(
      "the Management API project identity, region, health, or PostgreSQL contract does not match",
    );
  }
  return value;
}

function requireSafePoolerUrl(connectionString, projectRef) {
  if (
    typeof connectionString !== "string"
    || connectionString.length === 0
    || /[\u0000-\u001f\u007f]/u.test(connectionString)
  ) {
    fail("the primary pooler connection string is missing or malformed");
  }

  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    fail("the primary pooler connection string is not a URL");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    fail("the primary pooler URL must use PostgreSQL");
  }
  if (parsed.username !== `postgres.${projectRef}`) {
    fail("the primary pooler username is not bound to the exact project");
  }
  if (
    parsed.hostname !== EXPECTED_POOLER_HOST
    || !["5432", "6543"].includes(parsed.port)
    || parsed.pathname !== "/postgres"
    || !["", "?sslmode=require"].includes(parsed.search)
    || parsed.hash !== ""
  ) {
    fail("the primary pooler URL is outside the expected Supabase boundary");
  }
  return parsed;
}

export function normalizePrimaryPoolerConfig(value, projectRef) {
  if (!Array.isArray(value)) {
    fail("the pooler Management API response must be an array");
  }
  const primaryConfigs = value.filter((entry) =>
    isPlainObject(entry) && entry.database_type === "PRIMARY"
  );
  if (primaryConfigs.length !== 1) {
    fail("the pooler response must contain exactly one PRIMARY database");
  }
  const primary = primaryConfigs[0];
  if (
    primary.identifier !== projectRef
    || primary.db_user !== `postgres.${projectRef}`
    || primary.db_name !== "postgres"
    || primary.is_using_scram_auth !== true
    || primary.connectionString !== primary.connection_string
    || !isNullableNonnegativeInteger(primary.default_pool_size)
    || !isNullableNonnegativeInteger(primary.max_client_conn)
    || !Number.isInteger(primary.db_port)
    || ![5432, 6543].includes(primary.db_port)
    || !["session", "transaction"].includes(primary.pool_mode)
    || (primary.pool_mode === "transaction" && primary.db_port !== 6543)
    || (primary.pool_mode === "session" && primary.db_port !== 5432)
  ) {
    fail("the primary pooler metadata is not canonical");
  }

  const parsed = requireSafePoolerUrl(primary.connection_string, projectRef);
  if (
    parsed.hostname !== primary.db_host
    || Number(parsed.port) !== primary.db_port
  ) {
    fail("the primary pooler URL does not match its metadata");
  }

  // The Management API can return either the documented placeholder or a real
  // database password. Never serialize its userinfo. Reconstruct the only CLI
  // URL we permit from independently validated, non-secret components.
  const normalized =
    `postgresql://postgres.${projectRef}@${parsed.hostname}:5432/postgres?sslmode=require`;
  const verified = requireSafePoolerUrl(normalized, projectRef);
  if (
    verified.password !== ""
    || verified.port !== "5432"
    || verified.search !== "?sslmode=require"
  ) {
    fail("the normalized pooler URL is not credential-free session mode");
  }
  return normalized;
}

async function requireDirectory(directoryPath, expectedMode, label) {
  let metadata;
  try {
    metadata = await lstat(directoryPath);
  } catch {
    fail(`${label} is missing`);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail(`${label} must be a real directory`);
  }
  if ((metadata.mode & 0o777) !== expectedMode) {
    fail(`${label} must have mode ${expectedMode.toString(8)}`);
  }
  if (
    typeof process.getuid === "function"
    && metadata.uid !== process.getuid()
  ) {
    fail(`${label} must be owned by the current user`);
  }
}

async function readExactFile(filePath, expectedMode, label) {
  let file;
  try {
    file = await open(
      filePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const metadata = await file.stat();
    if (!metadata.isFile() || (metadata.mode & 0o777) !== expectedMode) {
      fail(`${label} must be a regular mode-${expectedMode.toString(8)} file`);
    }
    if (
      typeof process.getuid === "function"
      && metadata.uid !== process.getuid()
    ) {
      fail(`${label} must be owned by the current user`);
    }
    return await file.readFile("utf8");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Existing-project CLI state")) {
      throw error;
    }
    fail(`${label} is missing or unreadable`);
  } finally {
    await file?.close();
  }
}

async function writeExclusiveFile(filePath, contents) {
  let file;
  try {
    file = await open(
      filePath,
      fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await file.writeFile(contents, "utf8");
    await file.sync();
  } catch {
    fail(`refused to overwrite ${path.basename(filePath)}`);
  } finally {
    await file?.close();
  }
}

async function requireStage(stageDirectory) {
  if (typeof stageDirectory !== "string" || !path.isAbsolute(stageDirectory)) {
    fail("--stage-directory must be an absolute path");
  }
  const normalizedStage = path.normalize(stageDirectory);
  let canonicalStage;
  try {
    canonicalStage = await realpath(normalizedStage);
  } catch {
    fail("--stage-directory does not exist");
  }
  if (canonicalStage !== normalizedStage) {
    fail("--stage-directory must already be canonical");
  }
  await requireDirectory(canonicalStage, 0o500, "the execution stage");
  const supabaseDirectory = path.join(canonicalStage, "supabase");
  const tempDirectory = path.join(supabaseDirectory, ".temp");
  await requireDirectory(supabaseDirectory, 0o500, "the staged Supabase directory");
  await requireDirectory(tempDirectory, 0o700, "the staged Supabase .temp directory");
  const postgresVersionPath = path.join(tempDirectory, "postgres-version");
  const postgresVersion = await readExactFile(
    postgresVersionPath,
    0o400,
    "the staged PostgreSQL version",
  );
  if (postgresVersion.trim() !== EXPECTED_POSTGRES_VERSION) {
    fail(`the staged PostgreSQL version must be ${EXPECTED_POSTGRES_VERSION}`);
  }
  return {
    poolerUrlPath: path.join(tempDirectory, "pooler-url"),
    projectRefPath: path.join(tempDirectory, "project-ref"),
  };
}

async function fetchExpectedState({ accessToken, fetchImplementation, projectRef }) {
  const baseUrl = `https://api.supabase.com/v1/projects/${projectRef}`;
  const project = await fetchJson({
    accessToken,
    fetchImplementation,
    label: "the exact project lookup",
    url: baseUrl,
  });
  verifyProjectResponse(project, projectRef);
  const pooler = await fetchJson({
    accessToken,
    fetchImplementation,
    label: "the exact project pooler lookup",
    url: `${baseUrl}/config/database/pooler`,
  });
  await requireNetworkBanReadDenied({
    accessToken,
    fetchImplementation,
    label: "the Network Bans permission denial probe",
    url: `${baseUrl}/network-bans/retrieve`,
  });
  return {
    poolerUrl: normalizePrimaryPoolerConfig(pooler, projectRef),
    projectRef,
  };
}

export async function prepareExistingSupabaseCliState({
  accessToken,
  fetchImplementation = globalThis.fetch,
  projectRef,
  stageDirectory,
  verifyOnly = false,
} = {}) {
  requireCleanNodeRuntimeEnvironment(process.env);
  const exactRef = requireProjectRef(projectRef);
  const token = requireAccessToken(accessToken);
  if (typeof fetchImplementation !== "function") fail("a fetch implementation is required");
  const paths = await requireStage(stageDirectory);
  const expected = await fetchExpectedState({
    accessToken: token,
    fetchImplementation,
    projectRef: exactRef,
  });

  if (verifyOnly) {
    const savedRef = await readExactFile(paths.projectRefPath, 0o600, "the saved project ref");
    const savedPooler = await readExactFile(paths.poolerUrlPath, 0o600, "the saved pooler URL");
    if (savedRef !== exactRef || savedPooler !== expected.poolerUrl) {
      fail("the saved CLI target state changed or no longer matches the exact project");
    }
    return { projectRef: exactRef, verified: true };
  }

  // The project ref is the link commit marker. Write it last so an interrupted
  // preparation cannot leave a targetable linked project behind.
  await writeExclusiveFile(paths.poolerUrlPath, expected.poolerUrl);
  await writeExclusiveFile(paths.projectRefPath, exactRef);
  return { projectRef: exactRef, verified: true };
}

function parseArguments(argumentsList) {
  let stageDirectory = "";
  let verifyOnly = false;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--stage-directory") {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith("--") || stageDirectory) {
        fail("--stage-directory requires exactly one path");
      }
      stageDirectory = value;
      index += 1;
      continue;
    }
    if (argument === "--verify-only" && !verifyOnly) {
      verifyOnly = true;
      continue;
    }
    fail(`unsupported or duplicate argument: ${argument}`);
  }
  if (!stageDirectory) fail("--stage-directory is required");
  return { stageDirectory, verifyOnly };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  const options = parseArguments(process.argv.slice(2));
  prepareExistingSupabaseCliState({
    accessToken: process.env.SUPABASE_ACCESS_TOKEN,
    projectRef: process.env.SUPABASE_PROJECT_REF,
    ...options,
  }).then(
    () => console.log(
      options.verifyOnly
        ? "Verified exact credential-free Supabase CLI target state."
        : "Prepared exact credential-free Supabase CLI target state.",
    ),
    (error) => {
      console.error(
        error instanceof Error
          ? error.message
          : "Existing-project CLI state preparation failed.",
      );
      process.exitCode = 1;
    },
  );
}
