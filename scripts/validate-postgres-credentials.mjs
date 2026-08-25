#!/usr/bin/env node

import assert from "node:assert/strict";
import { lstat, readFile } from "node:fs/promises";

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
    ["database-passfile", "database-url-file", "project-ref"],
    "expected exactly --database-passfile, --database-url-file, and --project-ref",
  );
  return options;
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
if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) {
  fail("database URL must use postgres or postgresql");
}
if (databaseUrl.password) {
  fail("database URL must not contain a password; use the separate passfile");
}
if (databaseUrl.hash) fail("database URL cannot contain a fragment");
const queryEntries = [...databaseUrl.searchParams.entries()];
if (
  queryEntries.length !== 1
  || queryEntries[0][0] !== "sslmode"
  || queryEntries[0][1] !== "require"
) {
  fail("database URL must contain only the exact query parameter sslmode=require");
}

const username = decodeUrlField(databaseUrl.username, "database username");
const databaseName = decodeUrlField(databaseUrl.pathname.slice(1), "database name");
if (databaseName !== "postgres" || databaseUrl.pathname.slice(1).includes("/")) {
  fail("database URL must select only the postgres database");
}
const direct = databaseUrl.hostname === `db.${projectRef}.supabase.co`
  && username === "postgres";
const pooled = databaseUrl.hostname.endsWith(".pooler.supabase.com")
  && username === `postgres.${projectRef}`;
if (!direct && !pooled) {
  fail("database URL does not identify the exact project ref");
}
const port = databaseUrl.port || "5432";
if (port !== "5432") fail("database URL must use the TLS session/direct port 5432");

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
process.stdout.write(`${databaseUrl.toString()}\n`);
