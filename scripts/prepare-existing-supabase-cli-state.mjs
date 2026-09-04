#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
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
const LOGIN_READINESS_DELAYS_MS = Object.freeze([
  0,
  1_000,
  2_000,
  4_000,
  8_000,
  16_000,
  30_000,
]);
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
  body,
  fetchImplementation,
  label,
  method = "GET",
  url,
}) {
  const headers = { Authorization: `Bearer ${accessToken}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetchImplementation(url, {
      body: body === undefined ? undefined : JSON.stringify(body),
      method,
      headers,
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

function requireTemporaryLoginResponse(value) {
  if (
    !isPlainObject(value)
    || typeof value.role !== "string"
    || !/^cli_login_[a-z0-9_]*$/u.test(value.role)
    || Buffer.byteLength(value.role, "utf8") > 63
    || typeof value.password !== "string"
    || value.password.length < 16
    || value.password.length > 1024
    || /[\u0000-\u001f\u007f]/u.test(value.password)
    || value.password !== value.password.trimEnd()
    || !Number.isInteger(value.ttl_seconds)
    || value.ttl_seconds < 300
    || value.ttl_seconds > 7200
  ) {
    fail("the temporary login-role response is malformed or too short-lived");
  }
  return value;
}

function escapePgpassField(value) {
  return value.replaceAll("\\", "\\\\").replaceAll(":", "\\:");
}

export function buildTemporaryDatabaseCredentials({
  login,
  poolerUrl,
  projectRef,
}) {
  const exactRef = requireProjectRef(projectRef);
  const temporaryLogin = requireTemporaryLoginResponse(login);
  const pooler = requireSafePoolerUrl(poolerUrl, exactRef);
  if (pooler.password !== "" || pooler.port !== "5432") {
    fail("the temporary login must use the credential-free session pooler");
  }

  const username = `${temporaryLogin.role}.${exactRef}`;
  const databaseUrl =
    `postgresql://${encodeURIComponent(username)}@${pooler.hostname}:5432/postgres?sslmode=require&connect_timeout=10`;
  const verified = new URL(databaseUrl);
  if (
    verified.username !== username
    || verified.password !== ""
    || verified.hostname !== EXPECTED_POOLER_HOST
    || verified.port !== "5432"
    || verified.pathname !== "/postgres"
    || verified.search !== "?sslmode=require&connect_timeout=10"
    || verified.hash !== ""
  ) {
    fail("the temporary database URL is outside the exact project boundary");
  }

  const passfile = [
    pooler.hostname,
    "5432",
    "postgres",
    username,
    temporaryLogin.password,
  ].map(escapePgpassField).join(":") + "\n";
  return { databaseUrl, passfile };
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

async function requireCredentialDirectory(credentialDirectory) {
  if (
    typeof credentialDirectory !== "string"
    || !path.isAbsolute(credentialDirectory)
  ) {
    fail("--credential-directory must be an absolute path");
  }
  const normalized = path.normalize(credentialDirectory);
  let canonical;
  try {
    canonical = await realpath(normalized);
  } catch {
    fail("--credential-directory does not exist");
  }
  if (canonical !== normalized) {
    fail("--credential-directory must already be canonical");
  }
  await requireDirectory(canonical, 0o700, "the credential directory");
  let entries;
  try {
    entries = await readdir(canonical);
  } catch {
    fail("the credential directory cannot be inventoried");
  }
  if (entries.length !== 0) {
    fail("the credential directory must be empty");
  }
  return {
    databaseUrlPath: path.join(canonical, "database-url"),
    passfilePath: path.join(canonical, "database-passfile"),
    readyPath: path.join(canonical, "credential-ready"),
  };
}

async function requireSupabaseHome(supabaseHome) {
  if (typeof supabaseHome !== "string" || !path.isAbsolute(supabaseHome)) {
    fail("--supabase-home must be an absolute path");
  }
  const normalized = path.normalize(supabaseHome);
  let canonical;
  try {
    canonical = await realpath(normalized);
  } catch {
    fail("--supabase-home does not exist");
  }
  if (canonical !== normalized) {
    fail("--supabase-home must already be canonical");
  }
  await requireDirectory(canonical, 0o700, "the isolated Supabase home");
  return canonical;
}

async function requireProbeWorkdir(probeWorkdir) {
  if (typeof probeWorkdir !== "string" || !path.isAbsolute(probeWorkdir)) {
    fail("--probe-workdir must be an absolute path");
  }
  const normalized = path.normalize(probeWorkdir);
  let metadata;
  let canonical;
  try {
    metadata = await lstat(normalized);
    canonical = await realpath(normalized);
  } catch {
    fail("--probe-workdir does not exist");
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail("--probe-workdir must be a real directory");
  }
  if (canonical !== normalized) {
    fail("--probe-workdir must already be canonical");
  }
  if (
    (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    || (metadata.mode & 0o022) !== 0
  ) {
    fail("--probe-workdir must be current-user-owned and not group/world writable");
  }
  return canonical;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function buildTemporaryLoginProbeEnvironment({
  passfilePath,
  runtimePath,
  supabaseHome,
}) {
  if (
    typeof runtimePath !== "string"
    || runtimePath.length === 0
    || /[\u0000\r\n]/u.test(runtimePath)
  ) {
    fail("PATH is missing or malformed for the temporary-login probe");
  }
  return {
    HOME: supabaseHome,
    LANG: "C.UTF-8",
    PATH: runtimePath,
    PGPASSFILE: passfilePath,
    SUPABASE_HOME: supabaseHome,
    SUPABASE_NO_KEYRING: "1",
    SUPABASE_PROFILE: "supabase",
    SUPABASE_TELEMETRY_DISABLED: "1",
    TMPDIR: supabaseHome,
  };
}

export function buildTemporaryLoginProbeArguments({
  databaseUrl,
  stageDirectory,
}) {
  return [
    "--profile=supabase",
    `--workdir=${stageDirectory}`,
    "--output-format=text",
    "--agent=no",
    "db",
    "query",
    `--db-url=${databaseUrl}`,
    "select 1",
  ];
}

function runTemporaryLoginProbe({
  databaseUrl,
  passfilePath,
  stageDirectory,
  supabaseHome,
}) {
  return new Promise((resolve) => {
    let probeEnvironment;
    try {
      probeEnvironment = buildTemporaryLoginProbeEnvironment({
        passfilePath,
        runtimePath: process.env.PATH,
        supabaseHome,
      });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      child = spawn(
        "supabase",
        buildTemporaryLoginProbeArguments({ databaseUrl, stageDirectory }),
        {
          cwd: stageDirectory,
          env: probeEnvironment,
          killSignal: "SIGKILL",
          stdio: "ignore",
          timeout: 15_000,
        },
      );
    } catch {
      finish(false);
      return;
    }
    child.once("error", () => finish(false));
    child.once("exit", (code, signal) => finish(code === 0 && signal === null));
  });
}

export async function waitForTemporaryDatabaseLogin({
  databaseUrl,
  delayImplementation = delay,
  passfilePath,
  probeAttempt = runTemporaryLoginProbe,
  stageDirectory,
  supabaseHome,
}) {
  if (typeof probeAttempt !== "function") {
    fail("a temporary-login readiness probe is required");
  }
  if (typeof delayImplementation !== "function") {
    fail("a temporary-login retry delay is required");
  }
  for (const delayMilliseconds of LOGIN_READINESS_DELAYS_MS) {
    if (delayMilliseconds > 0) {
      await delayImplementation(delayMilliseconds);
    }
    let ready = false;
    try {
      ready = await probeAttempt({
        databaseUrl,
        passfilePath,
        stageDirectory,
        supabaseHome,
      });
    } catch {
      ready = false;
    }
    if (ready === true) return true;
  }
  fail("the temporary database login did not become ready");
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
  return {
    poolerUrl: normalizePrimaryPoolerConfig(pooler, projectRef),
    projectRef,
  };
}

async function createTemporaryLogin({
  accessToken,
  fetchImplementation,
  projectRef,
}) {
  const response = await fetchResponse({
    accessToken,
    body: { read_only: false },
    fetchImplementation,
    label: "the temporary database login request",
    method: "POST",
    url: `https://api.supabase.com/v1/projects/${projectRef}/cli/login-role`,
  });
  if (response.status !== 201) {
    await discardResponseBody(response);
    fail(`the temporary database login request returned HTTP ${response.status}`);
  }
  let value;
  try {
    value = await response.json();
  } catch {
    fail("the temporary database login request did not return JSON");
  }
  return requireTemporaryLoginResponse(value);
}

async function materializeTemporaryDatabaseCredentials({
  accessToken,
  credentialPaths,
  fetchImplementation,
  poolerUrl,
  probeWorkdir,
  projectRef,
  readinessProbe,
  supabaseHome,
}) {
  const login = await createTemporaryLogin({
    accessToken,
    fetchImplementation,
    projectRef,
  });
  const credentials = buildTemporaryDatabaseCredentials({
    login,
    poolerUrl,
    projectRef,
  });
  // The marker is written last. A partial write can never be consumed as a
  // complete credential set, and no secret is printed or returned.
  await writeExclusiveFile(
    credentialPaths.databaseUrlPath,
    credentials.databaseUrl,
  );
  await writeExclusiveFile(
    credentialPaths.passfilePath,
    credentials.passfile,
  );
  try {
    const ready = await readinessProbe({
      databaseUrl: credentials.databaseUrl,
      passfilePath: credentialPaths.passfilePath,
      stageDirectory: probeWorkdir,
      supabaseHome,
    });
    if (ready !== true) {
      fail("the temporary database login did not become ready");
    }
  } catch {
    fail("the temporary database login did not become ready");
  }
  await writeExclusiveFile(credentialPaths.readyPath, projectRef);
  return {
    credentialsPrepared: true,
    projectRef,
    verified: true,
  };
}

export async function prepareProductionSupabaseDatabaseCredentials({
  accessToken,
  credentialDirectory,
  fetchImplementation = globalThis.fetch,
  probeWorkdir,
  projectRef,
  readinessProbe = waitForTemporaryDatabaseLogin,
  supabaseHome,
} = {}) {
  requireCleanNodeRuntimeEnvironment(process.env);
  const exactRef = requireProjectRef(projectRef);
  const token = requireAccessToken(accessToken);
  if (typeof fetchImplementation !== "function") fail("a fetch implementation is required");
  const credentialPaths = await requireCredentialDirectory(
    credentialDirectory,
  );
  const isolatedSupabaseHome = await requireSupabaseHome(supabaseHome);
  const canonicalProbeWorkdir = await requireProbeWorkdir(probeWorkdir);
  const expected = await fetchExpectedState({
    accessToken: token,
    fetchImplementation,
    projectRef: exactRef,
  });
  return await materializeTemporaryDatabaseCredentials({
    accessToken: token,
    credentialPaths,
    fetchImplementation,
    poolerUrl: expected.poolerUrl,
    probeWorkdir: canonicalProbeWorkdir,
    projectRef: exactRef,
    readinessProbe,
    supabaseHome: isolatedSupabaseHome,
  });
}

export async function prepareExistingSupabaseCliState({
  accessToken,
  credentialDirectory,
  fetchImplementation = globalThis.fetch,
  projectRef,
  readinessProbe = waitForTemporaryDatabaseLogin,
  stageDirectory,
  supabaseHome,
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
    if (credentialDirectory) {
      const credentialPaths = await requireCredentialDirectory(
        credentialDirectory,
      );
      const isolatedSupabaseHome = await requireSupabaseHome(supabaseHome);
      return await materializeTemporaryDatabaseCredentials({
        accessToken: token,
        credentialPaths,
        fetchImplementation,
        poolerUrl: expected.poolerUrl,
        probeWorkdir: stageDirectory,
        projectRef: exactRef,
        readinessProbe,
        supabaseHome: isolatedSupabaseHome,
      });
    }
    return { credentialsPrepared: false, projectRef: exactRef, verified: true };
  }

  if (credentialDirectory) {
    fail("--credential-directory requires --verify-only");
  }
  if (supabaseHome) {
    fail("--supabase-home requires --credential-directory");
  }

  // The project ref is the target-state commit marker. Write it last so an
  // interrupted preparation cannot leave a consumable project target behind.
  await writeExclusiveFile(paths.poolerUrlPath, expected.poolerUrl);
  await writeExclusiveFile(paths.projectRefPath, exactRef);
  return { projectRef: exactRef, verified: true };
}

export function parseArguments(argumentsList) {
  let credentialOnly = false;
  let credentialDirectory = "";
  let probeWorkdir = "";
  let stageDirectory = "";
  let supabaseHome = "";
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
    if (argument === "--probe-workdir") {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith("--") || probeWorkdir) {
        fail("--probe-workdir requires exactly one path");
      }
      probeWorkdir = value;
      index += 1;
      continue;
    }
    if (argument === "--credential-directory") {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith("--") || credentialDirectory) {
        fail("--credential-directory requires exactly one path");
      }
      credentialDirectory = value;
      index += 1;
      continue;
    }
    if (argument === "--supabase-home") {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith("--") || supabaseHome) {
        fail("--supabase-home requires exactly one path");
      }
      supabaseHome = value;
      index += 1;
      continue;
    }
    if (argument === "--verify-only" && !verifyOnly) {
      verifyOnly = true;
      continue;
    }
    if (argument === "--credential-only" && !credentialOnly) {
      credentialOnly = true;
      continue;
    }
    fail(`unsupported or duplicate argument: ${argument}`);
  }
  if (credentialOnly) {
    if (stageDirectory || verifyOnly) {
      fail("--credential-only cannot be combined with staged-state options");
    }
    if (!probeWorkdir) fail("--probe-workdir is required with --credential-only");
    if (!credentialDirectory) {
      fail("--credential-directory is required with --credential-only");
    }
    if (!supabaseHome) {
      fail("--supabase-home is required with --credential-only");
    }
    return {
      credentialDirectory,
      credentialOnly,
      probeWorkdir,
      stageDirectory,
      supabaseHome,
      verifyOnly,
    };
  }
  if (probeWorkdir) fail("--probe-workdir requires --credential-only");
  if (!stageDirectory) fail("--stage-directory is required");
  if (credentialDirectory && !verifyOnly) {
    fail("--credential-directory requires --verify-only");
  }
  if (credentialDirectory && !supabaseHome) {
    fail("--supabase-home is required with --credential-directory");
  }
  if (supabaseHome && !credentialDirectory) {
    fail("--supabase-home requires --credential-directory");
  }
  return {
    credentialDirectory,
    credentialOnly,
    probeWorkdir,
    stageDirectory,
    supabaseHome,
    verifyOnly,
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  const options = parseArguments(process.argv.slice(2));
  const operation = options.credentialOnly
    ? prepareProductionSupabaseDatabaseCredentials({
      accessToken: process.env.SUPABASE_ACCESS_TOKEN,
      credentialDirectory: options.credentialDirectory,
      probeWorkdir: options.probeWorkdir,
      projectRef: process.env.SUPABASE_PROJECT_REF,
      supabaseHome: options.supabaseHome,
    })
    : prepareExistingSupabaseCliState({
      accessToken: process.env.SUPABASE_ACCESS_TOKEN,
      credentialDirectory: options.credentialDirectory,
      projectRef: process.env.SUPABASE_PROJECT_REF,
      stageDirectory: options.stageDirectory,
      supabaseHome: options.supabaseHome,
      verifyOnly: options.verifyOnly,
    });
  operation.then(
    () => console.log(
      options.credentialOnly
        ? "Prepared an exact temporary production database credential set."
        : options.verifyOnly
        ? options.credentialDirectory
          ? "Prepared an exact temporary database credential set."
          : "Verified exact credential-free Supabase CLI target state."
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
