#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

function fail(message) {
  throw new Error(message);
}

function parseArguments(tokens) {
  const options = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      fail(`invalid argument near ${flag ?? "end of command"}`);
    }
    const name = flag.slice(2);
    if (Object.hasOwn(options, name)) fail(`duplicate option --${name}`);
    options[name] = value;
  }
  assert.deepEqual(
    Object.keys(options).sort(),
    [
      "database-passfile",
      "database-host",
      "database-url-file",
      "project-ref",
      "ssl-root-cert-file",
      "ssl-root-cert-file-sha256",
      "url-ssl-root-cert-file",
    ].sort(),
    "expected the exact passwordless URL, pgpass, project, and pinned TLS root certificate options",
  );
  return options;
}

async function validateRootCertificate(filename, expectedSha256) {
  if (!path.isAbsolute(filename)) fail("TLS root certificate path must be absolute");
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    fail("TLS root certificate SHA-256 must be 64 lowercase hexadecimal characters");
  }
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail("TLS root certificate must be a regular, non-symlink file");
  }
  if ((metadata.mode & 0o022) !== 0) {
    fail("TLS root certificate cannot be group- or other-writable");
  }
  if (typeof process.getuid === "function" && ![0, process.getuid()].includes(metadata.uid)) {
    fail("TLS root certificate must be owned by the current user or root");
  }
  const canonical = await realpath(filename);
  if (canonical !== filename) fail("TLS root certificate path must already be canonical");
  const contents = await readFile(filename);
  if (contents.length === 0) fail("TLS root certificate must not be empty");
  let certificate;
  try {
    certificate = new X509Certificate(contents);
  } catch {
    fail("TLS root certificate is not a strict PEM/X.509 certificate");
  }
  if (!certificate.ca) fail("TLS root certificate is not an X.509 CA certificate");
  const actualSha256 = createHash("sha256").update(contents).digest("hex");
  if (actualSha256 !== expectedSha256) fail("TLS root certificate SHA-256 does not match");
  return canonical;
}

async function readPrivateFile(filename, label) {
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`${label} must be a regular, non-symlink file`);
  }
  if ((metadata.mode & 0o077) !== 0 || ![0o400, 0o600].includes(metadata.mode & 0o777)) {
    fail(`${label} permissions must be exactly 0400 or 0600`);
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    fail(`${label} must be owned by the current user`);
  }
  const value = await readFile(filename, "utf8");
  if (value.length === 0) fail(`${label} must not be empty`);
  return value;
}

function oneTerminatedLine(raw, label) {
  const normalized = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (normalized.includes("\n") || normalized.includes("\r")) {
    fail(`${label} must contain exactly one line`);
  }
  return normalized;
}

function decodeUrlField(value, label) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    fail(`${label} is not valid percent encoding`);
  }
  if (!decoded || /[\u0000-\u001f\u007f]/u.test(decoded)) {
    fail(`${label} must be nonempty and contain no control characters`);
  }
  return decoded;
}

function parsePgpass(line) {
  const fields = [];
  let field = "";
  let escaped = false;
  for (const character of line) {
    if (escaped) {
      if (![":", "\\"].includes(character)) {
        fail("database passfile uses a noncanonical escape");
      }
      field += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === ":" && fields.length < 4) {
      fields.push(field);
      field = "";
    } else {
      field += character;
    }
  }
  if (escaped) fail("database passfile has a dangling escape");
  fields.push(field);
  if (fields.length !== 5) {
    fail("database passfile must contain exactly one five-field pgpass record");
  }
  if (fields.some((value) => value.length === 0 || value === "*")) {
    fail("database passfile fields must be exact, nonempty, and non-wildcard");
  }
  if (fields.some((value) => /[\u0000-\u001f\u007f]/u.test(value))) {
    fail("database passfile fields cannot contain control characters");
  }
  return fields;
}

const options = parseArguments(process.argv.slice(2));
const projectRef = options["project-ref"];
if (!/^[a-z0-9]{20}$/u.test(projectRef)) fail("invalid project ref");
const databaseHost = options["database-host"];
if (!/^[a-z0-9-]+\.pooler\.supabase\.com$/u.test(databaseHost)) {
  fail("database host must be the exact dashboard-provided Supavisor hostname");
}
const sslRootCertFile = await validateRootCertificate(
  options["ssl-root-cert-file"],
  options["ssl-root-cert-file-sha256"],
);
const urlSslRootCertFile = options["url-ssl-root-cert-file"];
if (
  !path.isAbsolute(urlSslRootCertFile)
  || path.normalize(urlSslRootCertFile) !== urlSslRootCertFile
) fail("database URL TLS root certificate path must be canonical and absolute");

const rawUrl = oneTerminatedLine(
  await readPrivateFile(options["database-url-file"], "database URL file"),
  "database URL file",
);
let databaseUrl;
try {
  databaseUrl = new URL(rawUrl);
} catch {
  fail("database URL file is invalid");
}
if (databaseUrl.protocol !== "postgresql:") {
  fail("database URL must use the exact postgresql scheme");
}
if (databaseUrl.password) {
  fail("database URL must not contain a password; use the separate passfile");
}
if (databaseUrl.hash) fail("database URL cannot contain a fragment");
const queryEntries = [...databaseUrl.searchParams.entries()];
const expectedSearch = `?sslmode=verify-full&sslrootcert=${encodeURIComponent(urlSslRootCertFile)}`
  + "&options=-c%20jit%3Don";
if (
  databaseUrl.search !== expectedSearch
  || queryEntries.length !== 3
  || queryEntries[0][0] !== "sslmode"
  || queryEntries[0][1] !== "verify-full"
  || queryEntries[1][0] !== "sslrootcert"
  || queryEntries[1][1] !== urlSslRootCertFile
  || queryEntries[2][0] !== "options"
  || queryEntries[2][1] !== "-c jit=on"
) {
  fail("database URL must contain only the exact verify-full, pinned CA, and JIT session options");
}

const username = decodeUrlField(databaseUrl.username, "database username");
const databaseName = decodeUrlField(databaseUrl.pathname.slice(1), "database name");
if (databaseName !== "postgres" || databaseUrl.pathname.slice(1).includes("/")) {
  fail("database URL must select only the postgres database");
}
if (databaseUrl.hostname !== databaseHost || username !== `postgres.${projectRef}`) {
  fail("database URL must use the exact approved Supavisor host and project-scoped user");
}
if (databaseUrl.port !== "5432") fail("database URL must explicitly use Supavisor session port 5432");
const port = databaseUrl.port;

const passfileLine = oneTerminatedLine(
  await readPrivateFile(options["database-passfile"], "database passfile"),
  "database passfile",
);
const [passHost, passPort, passDatabase, passUser] = parsePgpass(passfileLine);
if (
  passHost !== databaseUrl.hostname
  || passPort !== port
  || passDatabase !== databaseName
  || passUser !== username
) {
  fail("database passfile scope does not exactly match the passwordless database URL");
}

// The normalized URL is safe for process argv: validation above proves that it
// has no password and no alternate credential-loading query parameter.
process.stdout.write(
  `postgresql://${encodeURIComponent(username)}@${databaseHost}:5432/postgres`
    + `?sslmode=verify-full&sslrootcert=${encodeURIComponent(sslRootCertFile)}`
    + "&options=-c%20jit%3Don\n",
);
